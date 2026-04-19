'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  session:          null,
  currentBoard:     null,
  currentThread:    null,
  boardThreads:     null,
  boardView:        localStorage.getItem('boardView') || 'catalog',
  turnstileSiteKey: null,
  _pendingQuote:    null
};

// ── Turnstile ─────────────────────────────────────────────────────────────────

let _turnstileReady = false;
const _turnstileQueue = [];

window.onTurnstileLoad = function () {
  _turnstileReady = true;
  _turnstileQueue.forEach(fn => fn());
  _turnstileQueue.length = 0;
};

function _whenCaptchaReady(fn) {
  if (_turnstileReady) fn(); else _turnstileQueue.push(fn);
}

function captchaWidget(id) {
  if (!state.turnstileSiteKey) return '';
  return `<div id="${id}" style="margin-top:6px"></div>`;
}

function captchaRowHtml(id) {
  if (!state.turnstileSiteKey || state.session?.authenticated) return '';
  return `<tr>
    <td class="lbl">Verification</td>
    <td>${captchaWidget(id)}</td>
  </tr>`;
}

function renderCaptchaIn(containerId) {
  if (!state.turnstileSiteKey || state.session?.authenticated) return;
  _whenCaptchaReady(() => {
    const el = document.getElementById(containerId);
    if (!el || el.dataset.renderId !== undefined) return;
    const wid = turnstile.render(el, {
      sitekey: state.turnstileSiteKey,
      theme:   'dark',
      size:    'normal'
    });
    el.dataset.renderId = wid;
  });
}

function getCaptchaToken(containerId) {
  if (!state.turnstileSiteKey) return null;
  const el = document.getElementById(containerId);
  if (!el || el.dataset.renderId === undefined) return null;
  return turnstile.getResponse(el.dataset.renderId) || null;
}

function resetCaptcha(containerId) {
  if (!state.turnstileSiteKey) return;
  const el = document.getElementById(containerId);
  if (el?.dataset.renderId !== undefined) turnstile.reset(el.dataset.renderId);
}

// ── API ───────────────────────────────────────────────────────────────────────

const api = {
  async get(path) {
    const res = await fetch('/api' + path);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  // JSON post — for endpoints that don't need file upload
  async post(path, body) {
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  // Multipart post — for thread/reply creation with optional file
  async upload(path, fields, fileInput) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) fd.append(k, String(v));
    }
    if (fileInput?.files?.[0]) fd.append('file', fileInput.files[0]);
    const res = await fetch('/api' + path, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  }
};

// ── Router ────────────────────────────────────────────────────────────────────

function route() {
  const path = location.pathname;
  const app  = document.getElementById('app');

  // /ca-ab/123 → thread view
  const threadMatch = path.match(/^\/([a-z0-9-]+)\/(\d+)\/?$/);
  if (threadMatch) return loadThread(threadMatch[1], parseInt(threadMatch[2]));

  // /ca-ab/ → board catalog
  const boardMatch = path.match(/^\/([a-z0-9-]+)\/?$/);
  if (boardMatch && boardMatch[1] !== 'admin') return loadBoard(boardMatch[1]);

  // / → index
  loadIndex();
}

function navigate(path) {
  history.pushState({}, '', path);
  route();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', route);

document.addEventListener('click', e => {
  // SPA nav links
  const a = e.target.closest('a[data-nav]');
  if (a) { e.preventDefault(); navigate(a.getAttribute('href')); return; }

  // Quotelink cross-thread resolution
  const ql = e.target.closest('.quotelink');
  if (ql) {
    e.preventDefault();
    const m = ql.getAttribute('href')?.match(/#p(\d+)$/);
    if (!m) return;
    const id = m[1];
    const target = document.getElementById('p' + id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.style.outline = '2px solid var(--quotelink)';
      setTimeout(() => { target.style.outline = ''; }, 1500);
    } else {
      api.get('/posts/find/' + id)
        .then(({ boardUri, threadId }) => navigate(`/${boardUri}/${threadId}#p${id}`))
        .catch(() => { /* post gone or not found */ });
    }
  }
});

// ── Nav ───────────────────────────────────────────────────────────────────────

function renderNav(activePath) {
  const nav = document.getElementById('nav');
  const session = state.session;

  const walletLabel = session?.authenticated
    ? session.tripcode ? `!${session.tripcode}` : 'Connected'
    : 'Connect Wallet';

  const TIER_NAMES = { 1: 'Constituent', 2: 'Member', 3: 'Minister' };
  const tier = session?.poliPassTier || 0;
  const tierBadge = tier > 0
    ? `<a href="/pass" class="polipass-badge polipass-tier-${tier}">${TIER_NAMES[tier]}</a>`
    : '';

  nav.innerHTML = `
    <a class="brand" href="/" data-nav>Poli<span>Chan</span></a>
    <div class="nav-links">
      <a href="/" data-nav ${activePath === '/' ? 'class="active"' : ''}>Boards</a>
      <a href="/pass" ${activePath === '/pass' ? 'class="active"' : ''}>PoliPass</a>
      <a href="/wall" ${activePath === '/wall' ? 'class="active"' : ''}>Wall</a>
      <a href="/constitution" ${activePath === '/constitution' ? 'class="active"' : ''}>Constitution</a>
    </div>
    <div class="nav-right">
      ${tierBadge}
      ${session?.isAdmin ? '<a href="/admin" style="color:#ffaaaa;font-size:0.82rem;text-decoration:none;font-weight:bold">Admin</a>' : ''}
      <button id="walletBtn" class="${session?.authenticated ? 'connected' : ''}">${walletLabel}</button>
    </div>
  `;

  document.getElementById('walletBtn').addEventListener('click', handleWalletClick);
}

// ── Wallet / Auth ─────────────────────────────────────────────────────────────

async function loadSession() {
  try {
    state.session = await api.get('/auth/me');
  } catch (e) {
    state.session = { authenticated: false };
  }
}

async function handleWalletClick() {
  if (state.session?.authenticated) {
    await api.post('/auth/logout', {});
    state.session = { authenticated: false };
    renderNav(location.pathname);
    return;
  }

  if (!window.ethereum) {
    alert('MetaMask is not installed.');
    return;
  }

  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address  = accounts[0];
    const { nonce } = await api.get('/auth/nonce');
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [nonce, address]
    });
    const result = await api.post('/auth/wallet', { address, signature, nonce });
    await loadSession();
    renderNav(location.pathname);
  } catch (e) {
    alert('Wallet connection failed: ' + e.message);
  }
}

// ── Index ─────────────────────────────────────────────────────────────────────

async function loadIndex() {
  renderNav('/');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Loading boards…</div>';

  try {
    const { boards } = await api.get('/boards');

    let html = '<div class="page-title">Boards</div>';

    for (const [key, list] of Object.entries(boards)) {
      if (!list.length) continue;

      // Use the root board's name as the section header if it's in the list
      const rootBoard = list.find(b => b.uri === key);
      const label = rootBoard ? esc(rootBoard.name) : key.toUpperCase();

      html += `<div class="board-list-section">
        <div class="board-list-group-header">${label}</div>`;

      // Root board first, then its direct children, then deeper children
      const root     = list.filter(b => b.uri === key);
      const children = list.filter(b => b.uri !== key);

      // Build a simple tree: group children by their parentUri
      const byParent = {};
      for (const b of children) {
        const p = b.parentUri || key;
        if (!byParent[p]) byParent[p] = [];
        byParent[p].push(b);
      }

      function renderRows(parentUri, depth) {
        const kids = byParent[parentUri] || [];
        return kids.map(b =>
          boardRow(b, depth > 0) + renderRows(b.uri, depth + 1)
        ).join('');
      }

      for (const b of root) html += boardRow(b, false);
      html += renderRows(key, 1);

      html += '</div>'; // .board-list-section
    }

    app.innerHTML = html;
    loadAnnouncements();
  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load boards: ${e.message}</div>`;
  }
}

function boardRow(board, isChild) {
  return `
    <div class="board-list-row ${isChild ? 'child' : ''}" onclick="navigate('/${board.uri}/')">
      <span class="board-list-uri">/${board.uri}/</span>
      <span class="board-list-name">${esc(board.name)}</span>
      <span class="board-list-stats">${board.threadCount || 0}T / ${board.postCount || 0}P</span>
    </div>`;
}

// ── Board Banners ─────────────────────────────────────────────────────────────

let _globalBanners  = [], _globalIdx  = 0, _globalTimer  = null;
let _boardBanners   = [], _boardIdx   = 0, _boardTimer   = null;

async function loadBanners(uri) {
  try {
    const { banners } = await api.get('/banners/' + uri);
    _globalBanners = (banners || []).filter(b => b.isGlobal);
    _boardBanners  = (banners || []).filter(b => !b.isGlobal);
  } catch (_) {
    _globalBanners = [];
    _boardBanners  = [];
  }

  _globalIdx = Math.floor(Math.random() * Math.max(_globalBanners.length, 1));
  _boardIdx  = Math.floor(Math.random() * Math.max(_boardBanners.length, 1));

  renderGlobalBanner();
  renderBoardBanner();

  if (_globalTimer) clearInterval(_globalTimer);
  if (_boardTimer)  clearInterval(_boardTimer);

  if (_globalBanners.length > 1) {
    _globalTimer = setInterval(() => {
      _globalIdx = (_globalIdx + 1) % _globalBanners.length;
      renderGlobalBanner();
    }, 30000);
  }
  if (_boardBanners.length > 1) {
    _boardTimer = setInterval(() => {
      _boardIdx = (_boardIdx + 1) % _boardBanners.length;
      renderBoardBanner();
    }, 30000);
  }
}

function renderGlobalBanner() {
  const el = document.getElementById('banner-global');
  if (!el) return;
  if (!_globalBanners.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.querySelector('img').src = _globalBanners[_globalIdx].url;
}

function renderBoardBanner() {
  const el = document.getElementById('banner-board');
  if (!el) return;
  if (!_boardBanners.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.querySelector('img').src = _boardBanners[_boardIdx].url;
}

// ── Ads ───────────────────────────────────────────────────────────────────────

async function loadAds(uri) {
  if ((state.session?.poliPassTier || 0) >= 2) {
    const msg = `<div style="font-size:0.78rem;color:var(--muted);font-style:italic;text-align:center">No ads :)<br>Thanks for supporting PoliChan</div>`;
    ['ad-left','ad-right'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.innerHTML = msg; el.style.display = 'flex'; }
    });
    const sidebar = document.getElementById('ad-sidebar');
    if (sidebar) sidebar.style.display = 'none';
    return;
  }

  const slots = [
    { type: 'header', elId: 'ad-left',   imgId: 'ad-left-img',   linkId: 'ad-left-link'  },
    { type: 'header', elId: 'ad-right',  imgId: 'ad-right-img',  linkId: 'ad-right-link' },
    { type: 'footer', elId: 'ad-footer', imgId: 'ad-footer-img', linkId: 'ad-footer-link'},
  ];

  for (const s of slots.filter(s => s.type === 'header')) {
    try {
      const { ad } = await fetch(`/api/ads/${uri}?type=header`).then(r => r.json());
      const slot = document.getElementById(s.elId);
      if (!slot) continue;
      if (!ad) { slot.style.display = 'none'; continue; }
      slot.style.display = 'flex';
      document.getElementById(s.imgId).src = ad.imageUrl;
      fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
      document.getElementById(s.linkId).onclick = (e) => {
        e.preventDefault();
        fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/click`, { method: 'POST' }).catch(() => {});
        window.open(ad.clickUrl, '_blank', 'noopener,noreferrer');
      };
    } catch (_) {}
  }

  try {
    const { ad } = await fetch(`/api/ads/${uri}?type=footer`).then(r => r.json());
    const slot = document.getElementById('ad-footer');
    if (slot) {
      if (!ad) { slot.style.display = 'none'; }
      else {
        slot.style.display = 'block';
        document.getElementById('ad-footer-img').src = ad.imageUrl;
        fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
        document.getElementById('ad-footer-link').onclick = (e) => {
          e.preventDefault();
          fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/click`, { method: 'POST' }).catch(() => {});
          window.open(ad.clickUrl, '_blank', 'noopener,noreferrer');
        };
      }
    }
  } catch (_) {}

  try {
    const { ad } = await fetch(`/api/ads/${uri}?type=sidebar`).then(r => r.json());
    const slot = document.getElementById('ad-sidebar');
    if (slot) {
      if (!ad) { slot.style.display = 'none'; }
      else {
        slot.style.display = 'flex';
        document.getElementById('ad-sidebar-img').src = ad.imageUrl;
        fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
        document.getElementById('ad-sidebar-link').onclick = (e) => {
          e.preventDefault();
          fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/click`, { method: 'POST' }).catch(() => {});
          window.open(ad.clickUrl, '_blank', 'noopener,noreferrer');
        };
      }
    }
  } catch (_) {}
}

// ── Board rules toggle ────────────────────────────────────────────────────────

function toggleBoardRules() {
  const el = document.getElementById('board-rules');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Announcements modal ───────────────────────────────────────────────────────

const _dismissed = new Set(JSON.parse(localStorage.getItem('dismissed_announcements') || '[]'));

async function loadAnnouncements() {
  try {
    const { announcements } = await api.get('/announcements');
    const visible = announcements.filter(a => !_dismissed.has(a._id));
    if (!visible.length) return;

    const modal = document.createElement('div');
    modal.id = 'announcement-modal';
    modal.innerHTML = `
      <div id="announcement-modal-box">
        <div id="announcement-modal-header">
          <span>Announcements</span>
          <button onclick="closeAnnouncementModal()" title="Close">✕</button>
        </div>
        <div id="announcement-modal-body">
          ${visible.map(a => `<div class="announcement-item" data-id="${a._id}">
            <p>${esc(a.text)}</p>
            <button class="ann-dismiss" onclick="dismissAnnouncement('${a._id}')">Dismiss</button>
          </div>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeAnnouncementModal(); });
  } catch (_) {}
}

function dismissAnnouncement(id) {
  _dismissed.add(id);
  localStorage.setItem('dismissed_announcements', JSON.stringify([..._dismissed]));
  const el = document.querySelector(`.announcement-item[data-id="${id}"]`);
  if (el) {
    el.remove();
    if (!document.querySelectorAll('.announcement-item').length) closeAnnouncementModal();
  }
}

function closeAnnouncementModal() {
  document.getElementById('announcement-modal')?.remove();
}

// ── Board ─────────────────────────────────────────────────────────────────────

async function loadBoard(uri) {
  renderNav('/' + uri + '/');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    // Always fetch with preview=4 so toggling views is instant (no second fetch)
    const { board, threads } = await api.get('/threads/' + uri + '?preview=4');
    state.currentBoard  = board;
    state.boardThreads  = threads;

    const v = state.boardView;

    app.innerHTML = `
      <div class="breadcrumb">
        <a href="/" data-nav>boards</a>
        <span class="sep">›</span>
        <span>/${esc(board.uri)}/</span>
      </div>

      <div class="board-header">
        <div class="board-header-top">
          <div id="ad-left" style="display:none;flex-direction:column;align-items:center;justify-content:center">
            <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
            <a id="ad-left-link" href="#" target="_blank" rel="noopener noreferrer">
              <img id="ad-left-img" src="" alt="ad" style="max-width:100%;height:90px;object-fit:contain">
            </a>
          </div>
          <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:center">
            <div id="banner-global" style="display:none">
              <img src="" alt="banner" style="width:300px;height:100px;object-fit:contain">
            </div>
            <div class="board-uri-label">/${esc(board.uri)}/</div>
            <h1>${esc(board.name)}</h1>
            ${board.description ? `<div class="board-desc">${esc(board.description)}</div>` : ''}
          </div>
          <div id="ad-right" style="display:none;flex-direction:column;align-items:center;justify-content:center">
            <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
            <a id="ad-right-link" href="#" target="_blank" rel="noopener noreferrer">
              <img id="ad-right-img" src="" alt="ad" style="max-width:100%;height:90px;object-fit:contain">
            </a>
          </div>
        </div>
        <div class="board-actions">
          ${board.rules ? `[<a href="#" onclick="toggleBoardRules();return false">Rules</a>]` : ''}
          [<a class="view-toggle-btn ${v === 'catalog' ? 'active' : ''}" href="#" onclick="switchBoardView('catalog','${esc(uri)}');return false" data-view="catalog">Catalog</a>]
          [<a class="view-toggle-btn ${v === 'index'   ? 'active' : ''}" href="#" onclick="switchBoardView('index','${esc(uri)}');return false"   data-view="index">Index</a>]
        </div>
      </div>

      ${board.rules ? `<div id="board-rules" style="display:none;background:var(--reply-bg);border:1px solid var(--border);padding:10px 16px;margin-bottom:10px;font-size:0.83rem;white-space:pre-wrap;line-height:1.7">${esc(board.rules)}</div>` : ''}

      <div class="post-form-section">
        <div id="nt-form-wrap">
          ${threadForm(uri)}
        </div>
        <div>
          <input type="submit" value="Start a New Thread" class="submit-btn" onclick="openNewThreadForm()">
        </div>
      </div>

      <div id="banner-board" style="display:none;margin:12px 0;text-align:center;width:100vw;margin-left:-24px">
        <img src="" alt="banner" style="width:468px;height:60px;object-fit:contain;max-width:100%">
      </div>

      <div id="board-content"></div>

      <div id="ad-sidebar" style="display:none;position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:10;flex-direction:column;align-items:center;gap:4px">
        <div style="font-size:0.68rem;color:var(--muted)">Sponsored</div>
        <a id="ad-sidebar-link" href="#" target="_blank" rel="noopener noreferrer">
          <img id="ad-sidebar-img" src="" alt="ad" style="width:160px;height:600px;object-fit:contain;display:block">
        </a>
      </div>

      <div id="ad-footer" style="display:none;margin:16px 0;text-align:center">
        <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
        <a id="ad-footer-link" href="#" target="_blank" rel="noopener noreferrer">
          <img id="ad-footer-img" src="" alt="ad" style="width:300px;height:250px;object-fit:contain;max-width:100%">
        </a>
      </div>`;

    renderBoardContent(threads, board, uri);
    loadBanners(uri);
    loadAds(uri);
  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load board: ${e.message}</div>`;
  }
}

function switchBoardView(view, uri) {
  state.boardView = view;
  localStorage.setItem('boardView', view);
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (state.boardThreads && state.currentBoard) {
    renderBoardContent(state.boardThreads, state.currentBoard, uri);
  }
}

function renderBoardContent(threads, board, uri) {
  const container = document.getElementById('board-content');
  if (!container) return;
  if (state.boardView === 'index') {
    container.innerHTML = threads.length
      ? renderIndexThreads(threads, uri)
      : '<div class="empty-state">No threads yet. Start one.</div>';
  } else {
    container.innerHTML = threads.length
      ? `<div class="catalog">${threads.map(t => catalogCard(t, uri)).join('')}</div>`
      : '<div class="empty-state">No threads yet. Start one.</div>';
  }
}

// ── Catalog view ──────────────────────────────────────────────────────────────

function catalogCard(t, boardUri) {
  const thumb = t.media?.thumbName
    ? `<img class="catalog-thumb" src="/uploads/${boardUri}/${t.media.thumbName}" loading="lazy">`
    : `<div class="catalog-thumb-placeholder">📄</div>`;

  const badges = [
    t.isPinned   ? '<span class="badge-pinned">📌 Pinned</span>'     : '',
    t.isLocked   ? '<span class="badge-locked">🔒 Locked</span>'    : '',
    t.bumpLimit  ? '<span class="badge-bump-limit">Bump limit</span>' : ''
  ].filter(Boolean).join(' ');

  // Strip HTML tags from bodyHtml for plain-text truncation so word filter
  // substitutions show up correctly without raw markup leaking into the catalog.
  const strippedBody = (t.bodyHtml || t.body)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim().slice(0, 120);

  return `
    <div class="catalog-card ${t.isPinned ? 'pinned' : ''}" onclick="navigate('/${boardUri}/${t.threadId}')">
      ${thumb}
      <div class="catalog-subject">${t.subject ? esc(t.subject) : esc(strippedBody)}</div>
      ${t.subject ? `<div class="catalog-excerpt">${esc(strippedBody)}</div>` : ''}
      <div class="catalog-meta">
        <span class="replies">${t.replyCount}R</span>
        <span>${formatDate(t.bumpedAt)}</span>
        ${badges}
      </div>
    </div>`;
}

// ── Index view ────────────────────────────────────────────────────────────────

function renderIndexThreads(threads, uri) {
  return threads.map(t => {
    const lastPosts  = t.lastPosts || [];
    const rightPosts = lastPosts.slice(0, 2);
    const belowPosts = lastPosts.slice(2);
    const omitted    = t.replyCount - lastPosts.length;

    // Float the thumbnail in its own div at the thread level.
    // .index-main is a BFC (overflow:hidden) — it snaps to the right of the float.
    // All content (OP info + replies) lives inside .index-main.
    const imgHtml = t.media?.thumbName
      ? `<div class="index-img-float">
          <div class="file-info">File: <a href="/uploads/${uri}/${t.media.storedName}" target="_blank">${esc(t.media.originalName || t.media.storedName)}</a> (${t.media.size ? Math.round(t.media.size/1024)+' KB' : ''})</div>
          <img src="/uploads/${uri}/${t.media.thumbName}" data-full="/uploads/${uri}/${t.media.storedName}" data-type="${esc(t.media.type || '')}" onclick="expandMedia(this)" loading="lazy">
        </div>`
      : '';

    const asideHtml = rightPosts.length
      ? `<div class="index-aside">${rightPosts.map(p => renderPost(p, uri, false)).join('')}</div>`
      : '';

    const omittedHtml = omitted > 0
      ? `<div class="index-omitted">${omitted} repl${omitted === 1 ? 'y' : 'ies'} omitted. <a href="/${uri}/${t.threadId}" data-nav>Click Reply to view.</a></div>`
      : '';

    const belowHtml = belowPosts.length
      ? `<div class="index-replies-below">${belowPosts.map(p => renderPost(p, uri, false)).join('')}</div>`
      : '';

    return `<div class="index-thread">
      ${imgHtml}
      <div class="index-main">
        ${renderIndexOP(t, uri)}
        ${asideHtml}
        ${omittedHtml}
      </div>
      ${belowHtml}
    </div>
    <hr class="index-divider">`;
  }).join('');
}

function renderIndexOP(t, uri) {
  const id           = t.threadId;
  // No media here — thumbnail is rendered separately in .index-img-float
  const tierLabels   = { 1: 'Primary', 2: 'Press', 3: 'Commentary', 4: 'Social' };
  const sourceHtml   = t.sourceTag
    ? `<span class="post-source-tag source-tier-${t.sourceTag.tier}">[${tierLabels[t.sourceTag.tier] || ''}]</span>`
    : '';
  const flairStyle   = t.flair ? `style="background:${esc(t.flairBgColor||'#555')};color:${esc(t.flairColor||'#fff')}"` : '';
  const flairHtml    = t.flair    ? `<span class="post-flair" ${flairStyle}>${esc(t.flair)}</span>` : '';
  const tripcodeHtml = t.tripcode ? `<span class="post-tripcode">!${esc(t.tripcode)}</span>` : '';
  const modHtml      = t.isModPost ? `<span class="post-mod-label"> ## Mod</span>` : '';
  const subjectHtml  = t.subject  ? `<span class="post-subject">${esc(t.subject)} </span>` : '';
  const badges = [
    t.isPinned  ? '<span class="badge-pinned">[Pinned]</span>'       : '',
    t.isLocked  ? '<span class="badge-locked">[Locked]</span>'       : '',
    t.bumpLimit ? '<span class="badge-bump-limit">[Bump Limit]</span>' : ''
  ].filter(Boolean).join(' ');

  // Use .index-op-header instead of .post.op to avoid the overflow:hidden battle —
  // .post.op has overflow:hidden (clearfix) which would contain the image float.
  // .index-op-header has no overflow set, so the image float bleeds into .index-thread.
  return `
    <div class="index-op-header ${t.isModPost ? 'mod-post' : ''}">
      <div class="postInfo">
        ${subjectHtml}<span class="post-name">${esc(t.name || 'Anonymous')}</span>${tripcodeHtml}${modHtml}${flairHtml}${sourceHtml}
        <span class="post-date">${formatDate(t.createdAt)}</span>
        <span class="post-no">No.<a class="post-id" href="/${uri}/${id}" data-nav>${id}</a></span>
        <span class="post-reply-wrap">[<a class="post-inline-link" href="/${uri}/${id}" data-nav>Reply</a>]</span>
        ${badges}
      </div>
      <blockquote class="postMessage">${t.bodyHtml || esc(t.body)}</blockquote>
      ${t.poll ? renderPoll(t.poll, uri, id) : ''}
      <div class="post-footer">
        ${(state.session?.isAdmin || state.session?.staffRole)
          ? `<span class="mod-controls">
              [<a class="post-action mod-del" onclick="modDeleteThread('${uri}', ${id})">Del Thread</a>]
              [<a class="post-action mod-pin" onclick="modPin('${uri}', ${id}, ${!t.isPinned})">${t.isPinned ? 'Unpin' : 'Pin'}</a>]
              [<a class="post-action mod-lock" onclick="modLock('${uri}', ${id}, ${!t.isLocked})">${t.isLocked ? 'Unlock' : 'Lock'}</a>]
              [<a class="post-action mod-ban" onclick="modBan('${uri}', ${id}, null)">Ban</a>]
            </span>`
          : ''}
      </div>
    </div>`;
}

function openNewThreadForm() {
  const wrap   = document.getElementById('nt-form-wrap');
  const toggle = wrap.style.display === 'block';
  wrap.style.display = toggle ? 'none' : 'block';
  if (!toggle) renderCaptchaIn('nt-captcha');
}

function threadForm(boardUri) {
  return `
    <div class="post-form-wrap">
      <table class="post-form" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <td class="lbl">Name</td>
            <td><input type="text" id="nt-name" placeholder="Anonymous"></td>
          </tr>
          <tr>
            <td class="lbl">Options</td>
            <td><input type="text" id="nt-options" placeholder="sage"></td>
          </tr>
          <tr>
            <td class="lbl">Subject</td>
            <td>
              <input type="text" id="nt-subject">
              <input type="submit" id="nt-submit" class="submit-btn" value="Post" onclick="submitThread('${boardUri}')">
              <input type="button" value="Cancel" onclick="openNewThreadForm()" class="submit-btn-cancel">
            </td>
          </tr>
          <tr>
            <td class="lbl">Comment</td>
            <td><textarea id="nt-body" rows="5"></textarea></td>
          </tr>
          <tr>
            <td class="lbl">File</td>
            <td><input type="file" id="nt-file" accept="image/jpeg,image/png,image/gif,image/webp,video/webm,video/mp4"></td>
          </tr>
          ${captchaRowHtml('nt-captcha')}
          ${state.session?.authenticated && state.session?.tripcode ? `<tr>
            <td class="lbl"></td>
            <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="nt-tripcode" style="width:auto">
              Post with wallet tripcode (!${state.session.tripcode})
            </label></td>
          </tr>` : ''}
        </tbody>
      </table>
      <div class="form-note" id="nt-error"></div>
    </div>`;
}

async function submitThread(boardUri) {
  const subject   = document.getElementById('nt-subject')?.value.trim();
  const body      = document.getElementById('nt-body')?.value.trim();
  const name      = document.getElementById('nt-name')?.value.trim();
  const options   = document.getElementById('nt-options')?.value.trim().toLowerCase();
  const fileInput = document.getElementById('nt-file');
  const errEl     = document.getElementById('nt-error');
  const btn       = document.getElementById('nt-submit');

  if (!body) { errEl.textContent = 'A comment is required.'; return; }
  if (!fileInput?.files?.[0]) { errEl.textContent = 'An image or file is required to start a thread.'; return; }

  const captchaToken = getCaptchaToken('nt-captcha');
  if (state.turnstileSiteKey && !state.session?.authenticated && !captchaToken) {
    errEl.textContent = 'Please complete the captcha.'; return;
  }
  errEl.textContent = '';

  const isVideo = fileInput.files[0]?.type.startsWith('video/');
  if (btn) { btn.disabled = true; btn.value = isVideo ? 'Processing…' : 'Posting…'; }

  try {
    const fields = { subject, body, name, sage: options === 'sage' };
    if (captchaToken) fields['cf-turnstile-response'] = captchaToken;
    if (document.getElementById('nt-tripcode')?.checked) fields.showTripcode = 'true';
    const { threadId } = await api.upload('/threads/' + boardUri, fields, fileInput);
    navigate(`/${boardUri}/${threadId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('nt-captcha');
    if (btn) { btn.disabled = false; btn.value = 'Post'; }
  }
}

// ── Thread view ───────────────────────────────────────────────────────────────

async function loadThread(boardUri, threadId) {
  renderNav('/' + boardUri + '/');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const [{ board }, { thread }, { posts }] = await Promise.all([
      api.get('/boards/' + boardUri),
      api.get('/threads/' + boardUri + '/' + threadId),
      api.get('/posts/' + boardUri + '/' + threadId)
    ]);

    state.currentBoard  = board;
    state.currentThread = thread;

    let html = `
      <div class="breadcrumb">
        <a href="/" data-nav>boards</a>
        <span class="sep">›</span>
        <a href="/${esc(board.uri)}/" data-nav>/${esc(board.uri)}/</a>
        <span class="sep">›</span>
        <span>#${thread.threadId}</span>
      </div>
      <div class="thread-view">
        ${renderPost(thread, boardUri, true)}
        ${posts.map(p => renderPost(p, boardUri, false)).join('')}
      </div>
      <div class="divider"></div>
      ${thread.isLocked
        ? '<div class="empty-state" style="padding:20px 0">Thread is locked.</div>'
        : replyFormHtml(boardUri, threadId)}
    `;

    app.innerHTML = html;
    setupQuickReply(boardUri, threadId);
    renderCaptchaIn('rp-captcha');
    loadFlairPicker();

    // Scroll to anchor if present (e.g. navigated via cross-board >>quote)
    if (location.hash) {
      const anchor = document.querySelector(location.hash);
      if (anchor) {
        setTimeout(() => {
          anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
          anchor.style.outline = '2px solid var(--quotelink)';
          setTimeout(() => { anchor.style.outline = ''; }, 1500);
        }, 50);
      }
    }

    // Socket.io — live replies
    if (window.io) {
      const socket = io();
      socket.emit('join-thread', { boardUri, threadId });
      socket.on('new-post', async (post) => {
        const tv = document.querySelector('.thread-view');
        if (tv) tv.insertAdjacentHTML('beforeend', renderPost(post, boardUri, false));
      });
    }

  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load thread: ${e.message}</div>`;
  }
}

function renderPost(post, boardUri, isOp) {
  const id = post.postId || post.threadId;
  const mediaHtml = post.media ? renderMedia(post.media, boardUri) : '';

  const tierLabels = { 1: 'Primary', 2: 'Press', 3: 'Commentary', 4: 'Social' };
  const sourceHtml = post.sourceTag
    ? `<span class="post-source-tag source-tier-${post.sourceTag.tier}">[${tierLabels[post.sourceTag.tier] || ''}]</span>`
    : '';

  const flairStyle   = post.flair
    ? `style="background:${esc(post.flairBgColor || '#555')};color:${esc(post.flairColor || '#fff')}"`
    : '';
  const flairHtml    = post.flair    ? `<span class="post-flair" ${flairStyle}>${esc(post.flair)}</span>` : '';
  const tripcodeHtml = post.tripcode ? `<span class="post-tripcode">!${esc(post.tripcode)}</span>` : '';
  const modHtml      = post.isModPost ? `<span class="post-mod-label"> ## Mod</span>` : '';
  const subjectHtml  = post.subject  ? `<span class="post-subject">${esc(post.subject)} </span>` : '';

  const badges = [
    isOp && post.isPinned   ? '<span class="badge-pinned">[Pinned]</span>'      : '',
    isOp && post.isLocked   ? '<span class="badge-locked">[Locked]</span>'      : '',
    isOp && post.bumpLimit  ? '<span class="badge-bump-limit">[Bump Limit]</span>' : ''
  ].filter(Boolean).join(' ');

  const postEl = `
    <div class="post ${isOp ? 'op' : 'reply'} ${post.isModPost ? 'mod-post' : ''}" id="p${id}">
      ${mediaHtml}
      <div class="postInfo">
        ${subjectHtml}<span class="post-name">${esc(post.name || 'Anonymous')}</span>${tripcodeHtml}${modHtml}${flairHtml}${sourceHtml}
        <span class="post-date">${formatDate(post.createdAt)}</span>
        <span class="post-no">No.<a class="post-id" href="#p${id}" onclick="quotePost(${id},'${boardUri}',${post.threadId});return false">${id}</a></span>
        ${isOp ? '<span class="post-reply-wrap">[<a class="post-inline-link" href="#rp-form" onclick="document.getElementById(\'rp-form-wrap\').style.display=\'block\';document.getElementById(\'rp-body\').focus();return false">Reply</a>]</span>' : ''}
        ${badges}
      </div>
      <blockquote class="postMessage">${post.bodyHtml || esc(post.body)}</blockquote>
      ${isOp && post.poll ? renderPoll(post.poll, boardUri, post.threadId) : ''}
      <div class="post-footer">
        [<a class="post-action" onclick="quotePost(${id},'${boardUri}',${post.threadId})">Reply</a>]
        [<a class="post-action" onclick="reportPost('${boardUri}', ${post.threadId}, ${isOp ? 'null' : id})">Report</a>]
        ${(state.session?.isAdmin || state.session?.staffRole)
          ? `<span class="mod-controls">
              ${isOp
                ? `[<a class="post-action mod-del" onclick="modDeleteThread('${boardUri}', ${post.threadId})">Del Thread</a>]
                   [<a class="post-action mod-pin" onclick="modPin('${boardUri}', ${post.threadId}, ${!post.isPinned})">${post.isPinned ? 'Unpin' : 'Pin'}</a>]
                   [<a class="post-action mod-lock" onclick="modLock('${boardUri}', ${post.threadId}, ${!post.isLocked})">${post.isLocked ? 'Unlock' : 'Lock'}</a>]`
                : `[<a class="post-action mod-del" onclick="modDeletePost('${boardUri}', ${id}, ${post.threadId})">Del</a>]`
              }
              [<a class="post-action mod-ban" onclick="modBan('${boardUri}', ${post.threadId}, ${isOp ? 'null' : id})">Ban</a>]
            </span>`
          : ''}
      </div>
    </div>`;

  return isOp ? postEl : `<div class="reply-container">${postEl}</div>`;
}

function renderMedia(media, boardUri) {
  const src   = `/uploads/${boardUri}/${media.storedName}`;
  const thumb = `/uploads/${boardUri}/${media.thumbName}`;
  const name  = esc(media.originalName || media.storedName);
  const kb    = media.size ? Math.round(media.size / 1024) + ' KB' : '';
  const dims  = (media.width && media.height) ? `, ${media.width}x${media.height}` : '';
  const info  = `File: <a href="${src}" target="_blank">${name}</a> (${kb}${dims})`;

  if (media.type === 'webm' || media.type === 'mp4') {
    const uid = Math.random().toString(36).slice(2, 8);
    return `<div class="post-file" id="pf-${uid}">
      <div class="file-info">${info}</div>
      <video id="v-${uid}" src="${src}" poster="${thumb}" controls loop preload="metadata"></video>
      <div class="video-controls">
        <button class="vid-btn" onclick="toggleVideoExpand('pf-${uid}')">&#x26F6; Expand</button>
        <button class="vid-btn" onclick="document.getElementById('v-${uid}').requestFullscreen()">&#x26F6; Fullscreen</button>
      </div>
    </div>`;
  }
  return `<div class="post-file">
    <div class="file-info">${info}</div>
    <img src="${thumb}" data-full="${src}" onclick="expandImage(this)" loading="lazy">
  </div>`;
}

function renderPoll(poll, boardUri, threadId) {
  const total = poll.options.reduce((s, o) => s + o.votes, 0) || 1;
  const opts  = poll.options.map((o, i) => {
    const pct = Math.round((o.votes / total) * 100);
    return `
      <div class="poll-option" onclick="votePoll('${boardUri}', ${threadId}, ${i})">
        <span class="poll-label">${esc(o.text)}</span>
        <div class="poll-bar-wrap"><div class="poll-bar" style="width:${pct}%"></div></div>
        <span class="poll-pct">${pct}%</span>
      </div>`;
  }).join('');

  return `<div class="poll">
    <div class="poll-question">${esc(poll.question)}</div>
    ${opts}
    <div style="font-size:0.72rem;color:var(--muted);margin-top:8px">${total} vote${total !== 1 ? 's' : ''}</div>
  </div>`;
}

async function votePoll(boardUri, threadId, optionIndex) {
  try {
    const { options } = await api.post(`/polls/${boardUri}/${threadId}/vote`, { optionIndex });
    // Re-render poll section
    const total = options.reduce((s, o) => s + o.votes, 0) || 1;
    document.querySelectorAll('.poll-option').forEach((el, i) => {
      const pct = Math.round((options[i].votes / total) * 100);
      el.querySelector('.poll-bar').style.width = pct + '%';
      el.querySelector('.poll-pct').textContent = pct + '%';
    });
  } catch (e) {
    alert(e.message);
  }
}

// ── Reply form ────────────────────────────────────────────────────────────────

function replyFormHtml(boardUri, threadId) {
  return `
    <div class="reply-form-wrap" id="rp-form">
      <div id="rp-form-wrap" style="display:none">
        <div class="form-section-title">Reply to Thread #${threadId}</div>
        <div class="post-form-wrap">
          <table class="post-form" cellpadding="0" cellspacing="0">
            <tbody>
              <tr>
                <td class="lbl">Name</td>
                <td><input type="text" id="rp-name" placeholder="Anonymous"></td>
              </tr>
              <tr>
                <td class="lbl">Options</td>
                <td><input type="text" id="rp-options" placeholder="sage"></td>
              </tr>
              <tr>
                <td class="lbl">Comment</td>
                <td><textarea id="rp-body" rows="5"></textarea></td>
              </tr>
              <tr>
                <td class="lbl">File</td>
                <td><input type="file" id="rp-file" accept="image/jpeg,image/png,image/gif,image/webp,video/webm,video/mp4"></td>
              </tr>
              <tr id="rp-flair-row" style="display:none">
                <td class="lbl">Flair</td>
                <td>
                  <select id="rp-flair" onchange="updateFlairPreview()">
                    <option value="none">No flair</option>
                  </select>
                  <span id="rp-flair-preview" class="post-flair" style="margin-left:8px;display:none"></span>
                </td>
              </tr>
              ${captchaRowHtml('rp-captcha')}
              ${state.session?.authenticated && state.session?.tripcode ? `<tr>
                <td class="lbl"></td>
                <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
                  <input type="checkbox" id="rp-tripcode" style="width:auto">
                  Post with wallet tripcode (!${state.session.tripcode})
                </label></td>
              </tr>` : ''}
            </tbody>
          </table>
          <div style="padding:5px 0">
            <input type="submit" id="rp-submit" class="submit-btn" value="Post Reply" onclick="submitReply('${boardUri}', ${threadId})">
            <input type="button" value="Cancel" onclick="document.getElementById('rp-form-wrap').style.display='none'" style="margin-left:6px">
            <span id="rp-error" style="color:red;font-size:0.8rem;margin-left:8px"></span>
          </div>
        </div>
      </div>
      <div style="margin-top:8px">
        <input type="button" value="Post a Reply" class="submit-btn" onclick="document.getElementById('rp-form-wrap').style.display='block';document.getElementById('rp-body').focus()">
      </div>
    </div>`;
}

function setupQuickReply(boardUri, threadId) {
  let qr = document.getElementById('qr');
  if (!qr) {
    qr = document.createElement('div');
    qr.id = 'qr';
    document.body.appendChild(qr);
  }
  qr.innerHTML = `
    <div id="qr-header">
      Quick Reply
      <button onclick="document.getElementById('qr').classList.remove('open')">✕</button>
    </div>
    <div class="post-form-wrap" style="width:100%">
      <table class="post-form" cellpadding="0" cellspacing="0" style="width:100%">
        <tbody>
          <tr>
            <td class="lbl">Name</td>
            <td><input type="text" id="qr-name" placeholder="Anonymous" style="width:100%"></td>
          </tr>
          <tr>
            <td class="lbl">Options</td>
            <td><input type="text" id="qr-options" placeholder="sage" style="width:100%"></td>
          </tr>
          <tr>
            <td class="lbl">Comment</td>
            <td><textarea id="qr-body" rows="4" style="width:100%;min-width:180px"></textarea></td>
          </tr>
          ${captchaRowHtml('qr-captcha')}
          ${state.session?.authenticated && state.session?.tripcode ? `<tr>
            <td class="lbl"></td>
            <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="qr-tripcode" style="width:auto">
              Post with wallet tripcode (!${state.session.tripcode})
            </label></td>
          </tr>` : ''}
        </tbody>
      </table>
      <div style="padding:5px 0">
        <input type="submit" class="submit-btn" value="Post Reply" onclick="submitQR('${boardUri}', ${threadId})">
        <span id="qr-error" style="color:red;font-size:0.78rem;margin-left:8px"></span>
      </div>
    </div>`;

  renderCaptchaIn('qr-captcha');

  // Apply any pending quote from board-index navigation
  if (state._pendingQuote) {
    const body = document.getElementById('qr-body');
    if (body) {
      body.value = `>>${state._pendingQuote}\n`;
      body.focus();
      qr.classList.add('open');
    }
    state._pendingQuote = null;
  }
}

function quotePost(postId, boardUri, threadId) {
  const qr = document.getElementById('qr');
  if (qr) {
    qr.classList.add('open');
    const body = document.getElementById('qr-body');
    if (body) { body.value += `>>${postId}\n`; body.focus(); }
  } else if (boardUri && threadId) {
    // Board index — navigate to thread and apply quote once QR is ready
    state._pendingQuote = postId;
    navigate(`/${boardUri}/${threadId}`);
  } else {
    // Fallback: inline reply form
    const rpWrap = document.getElementById('rp-form-wrap');
    if (rpWrap) rpWrap.style.display = 'block';
    const body = document.getElementById('rp-body');
    if (body) { body.value += `>>${postId}\n`; body.focus(); }
  }
}

async function loadFlairPicker() {
  const row    = document.getElementById('rp-flair-row');
  const select = document.getElementById('rp-flair');
  if (!row || !select) return;

  try {
    const [{ flairs: globalFlairs }, { variants }] = await Promise.all([
      api.get('/auth/global-flairs'),
      api.get('/auth/variants').catch(() => ({ variants: [] }))
    ]);

    // Global flairs — available to everyone
    if (globalFlairs.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'Flair';
      globalFlairs.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value           = `g:${i}`;
        opt.textContent     = v.label;
        opt.dataset.color   = v.color;
        opt.dataset.bgColor = v.bgColor;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }

    // PoliPass variants — tier holders only
    if (variants.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'PoliPass';
      variants.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value           = `v:${i}`;
        opt.textContent     = v.label;
        opt.dataset.color   = v.color;
        opt.dataset.bgColor = v.bgColor;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }

    row.style.display = '';
    updateFlairPreview();
  } catch { /* silently skip — flair row stays hidden */ }
}

function updateFlairPreview() {
  const select  = document.getElementById('rp-flair');
  const preview = document.getElementById('rp-flair-preview');
  if (!select || !preview) return;

  if (select.value === 'none') {
    preview.style.display = 'none';
    return;
  }

  const opt = select.options[select.selectedIndex];
  preview.textContent        = opt.textContent;
  preview.style.background   = opt.dataset.bgColor;
  preview.style.color        = opt.dataset.color;
  preview.style.display      = 'inline';
}

async function submitReply(boardUri, threadId) {
  const name      = document.getElementById('rp-name')?.value.trim();
  const options   = document.getElementById('rp-options')?.value.trim().toLowerCase();
  const body      = document.getElementById('rp-body')?.value.trim();
  const fileInput = document.getElementById('rp-file');
  const errEl     = document.getElementById('rp-error');
  const btn       = document.getElementById('rp-submit');

  if (!body) { errEl.textContent = 'A comment is required.'; return; }

  const captchaToken = getCaptchaToken('rp-captcha');
  if (state.turnstileSiteKey && !state.session?.authenticated && !captchaToken) {
    errEl.textContent = 'Please complete the captcha.'; return;
  }
  errEl.textContent = '';

  const isVideo = fileInput?.files?.[0]?.type.startsWith('video/');
  if (btn) { btn.disabled = true; btn.value = isVideo ? 'Processing…' : 'Posting…'; }

  try {
    const flairVariant = document.getElementById('rp-flair')?.value;
    const fields = { body, name, sage: options === 'sage' };
    if (flairVariant !== undefined) fields.flairVariant = flairVariant;
    if (captchaToken) fields['cf-turnstile-response'] = captchaToken;
    if (document.getElementById('rp-tripcode')?.checked) fields.showTripcode = 'true';
    const { postId } = await api.upload(`/posts/${boardUri}/${threadId}`, fields, fileInput);
    navigate(`/${boardUri}/${threadId}#p${postId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('rp-captcha');
    if (btn) { btn.disabled = false; btn.value = 'Post Reply'; }
  }
}

async function submitQR(boardUri, threadId) {
  const name    = document.getElementById('qr-name')?.value.trim();
  const options = document.getElementById('qr-options')?.value.trim().toLowerCase();
  const body    = document.getElementById('qr-body')?.value.trim();
  const errEl   = document.getElementById('qr-error');
  if (!body) { errEl.textContent = 'A comment is required.'; return; }
  const captchaToken = getCaptchaToken('qr-captcha');
  if (state.turnstileSiteKey && !state.session?.authenticated && !captchaToken) {
    errEl.textContent = 'Please complete the captcha.'; return;
  }
  errEl.textContent = '';
  try {
    const fields = { body, name, sage: options === 'sage' };
    if (captchaToken) fields['cf-turnstile-response'] = captchaToken;
    if (document.getElementById('qr-tripcode')?.checked) fields.showTripcode = 'true';
    const { postId } = await api.post(`/posts/${boardUri}/${threadId}`, fields);
    navigate(`/${boardUri}/${threadId}#p${postId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('qr-captcha');
  }
}

// ── Image expand ──────────────────────────────────────────────────────────────

function toggleVideoExpand(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const expanded = container.classList.toggle('expanded');
  const btn = container.querySelector('.vid-btn');
  if (btn) btn.innerHTML = expanded ? '&#x26F6; Collapse' : '&#x26F6; Expand';
}

function expandImage(img) {
  const container = img.closest('.post-file') || img.parentElement;
  if (img.classList.contains('expanded')) {
    img.src = img.dataset.thumb || img.src;
    img.classList.remove('expanded');
    container?.classList.remove('expanded');
  } else {
    img.dataset.thumb = img.src;
    img.src = img.dataset.full;
    img.classList.add('expanded');
    container?.classList.add('expanded');
  }
}

function expandMedia(img) {
  const type = img.dataset.type;
  if (type === 'mp4' || type === 'webm') {
    const float = img.closest('.index-img-float');
    float?.classList.add('expanded');

    const video = document.createElement('video');
    video.src = img.dataset.full;
    video.poster = img.src;
    video.controls = true;
    video.loop = true;
    video.autoplay = true;
    video.style.cssText = 'max-width:100%;display:block';

    const close = document.createElement('a');
    close.textContent = '[close]';
    close.href = '#';
    close.style.cssText = 'font-size:0.75rem;display:block;margin-bottom:4px;cursor:pointer';
    close.onclick = (e) => {
      e.preventDefault();
      video.pause();
      video.src = '';
      float?.classList.remove('expanded');
      wrapper.replaceWith(img);
    };

    const wrapper = document.createElement('div');
    wrapper.appendChild(close);
    wrapper.appendChild(video);
    img.replaceWith(wrapper);
  } else {
    expandImage(img);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

async function reportPost(boardUri, threadId, postId) {
  const reason = prompt('Report reason:\n1 = Spam\n2 = Illegal');
  const map = { '1': 'spam', '2': 'illegal' };
  if (!map[reason]) return;
  try {
    await api.post('/posts/' + boardUri + '/' + threadId + '/report', {
      postId, reason: map[reason]
    });
    alert('Report submitted.');
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Mod tools ─────────────────────────────────────────────────────────────────

async function modPin(boardUri, threadId, pinned) {
  try {
    await api.post('/mod/pin', { boardUri, threadId, pinned });
    // Reload the board or thread so the pinned state and sort order update
    if (state.currentThread) {
      loadThread(boardUri, threadId);
    } else {
      loadBoard(boardUri);
    }
  } catch (e) { alert('Pin failed: ' + e.message); }
}

async function modLock(boardUri, threadId, locked) {
  try {
    await api.post('/mod/lock', { boardUri, threadId, locked });
    if (state.currentThread) {
      loadThread(boardUri, threadId);
    } else {
      loadBoard(boardUri);
    }
  } catch (e) { alert('Lock failed: ' + e.message); }
}

async function modDeletePost(boardUri, postId, threadId) {
  if (!confirm(`Delete No.${postId}?`)) return;
  try {
    await api.post('/mod/delete/post', { boardUri, postId });
    // Remove from DOM immediately
    const el = document.getElementById('p' + postId);
    (el?.closest('.reply-container') || el)?.remove();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

async function modDeleteThread(boardUri, threadId) {
  if (!confirm(`Delete entire thread #${threadId} and all its replies?`)) return;
  try {
    await api.post('/mod/delete/thread', { boardUri, threadId });
    navigate('/' + boardUri + '/');
  } catch (e) { alert('Delete failed: ' + e.message); }
}

async function modBan(boardUri, threadId, postId) {
  const reasonRaw = prompt('Ban reason:\n1 = Spam\n2 = Illegal content');
  const reasons   = { '1': 'spam', '2': 'illegal' };
  const reason    = reasons[reasonRaw?.trim()];
  if (!reason) return;

  const hoursRaw = prompt('Duration in hours (leave blank for permanent):');
  const hours    = hoursRaw?.trim() ? parseInt(hoursRaw) : null;
  if (hoursRaw?.trim() && !hours) { alert('Invalid duration'); return; }

  try {
    await api.post('/mod/ban', {
      boardUri, threadId,
      postId:        postId || null,
      reason,
      durationHours: hours
    });
    alert('Banned' + (hours ? ` for ${hours}h` : ' permanently'));
  } catch (e) { alert('Ban failed: ' + e.message); }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  if (!document.getElementById('nav')) {
    const nav = document.createElement('div');
    nav.id = 'nav';
    document.body.insertBefore(nav, document.getElementById('app'));
  }

  // Load session and public config in parallel
  const [, cfg] = await Promise.all([
    loadSession(),
    api.get('/auth/config').catch(() => ({}))
  ]);
  state.turnstileSiteKey = cfg.turnstileSiteKey || null;

  route();
}

boot();
