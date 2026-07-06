'use strict';

// Apply saved theme immediately to avoid flash. 'green' is the bare
// :root palette; every other theme is a html.theme-<name> class that
// overrides the CSS variables.
const THEMES = ['green', 'red', 'yotsuba', 'yotsuba-b', 'tomorrow'];
(function () {
  const t = localStorage.getItem('theme') || 'green';
  if (THEMES.includes(t) && t !== 'green') document.documentElement.classList.add('theme-' + t);
})();

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  session:          null,
  currentBoard:     null,
  currentThread:    null,
  boardThreads:     null,
  boardView:        localStorage.getItem('boardView') || 'index',
  turnstileSiteKey: null
};

let _socket     = null;
let _socketRoom = null;

// Live-update controls for the thread bottom bar. Auto-update is on by
// default (posts stream in over the socket); when off, incoming posts are
// buffered and the bar shows how many are waiting for a manual Update.
let _autoUpdate   = localStorage.getItem('autoUpdate') !== 'off';
let _pendingPosts = [];

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Turnstile ─────────────────────────────────────────────────────────────────

let _turnstileReady = false;
const _turnstileQueue = [];

window.onTurnstileLoad = function () {
  _turnstileReady = true;
  _turnstileQueue.forEach(fn => fn());
  _turnstileQueue.length = 0;
};

// index.html stubs window.onTurnstileLoad before the async Turnstile script tag,
// since that script can finish loading (and call it) before this file runs. If it
// already fired by the time we get here, run the real handler immediately.
if (window._turnstileApiReady) window.onTurnstileLoad();

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

function showAppShell(isIndex) {
  document.getElementById('board-index-root').style.display = isIndex ? 'block' : 'none';
  document.getElementById('app').style.display = isIndex ? 'none' : 'block';
}

function route() {
  const path = location.pathname;

  // /ca-ab/archive → archive view
  const archiveMatch = path.match(/^\/([a-z0-9-]+)\/archive\/?$/);
  if (archiveMatch) {
    showAppShell(false);
    const page = parseInt(new URLSearchParams(location.search).get('page')) || 1;
    return loadArchive(archiveMatch[1], page);
  }

  // /ca-ab/123 → thread view
  const threadMatch = path.match(/^\/([a-z0-9-]+)\/(\d+)\/?$/);
  if (threadMatch) { showAppShell(false); return loadThread(threadMatch[1], parseInt(threadMatch[2])); }

  // /ca-ab/ → board catalog
  const boardMatch = path.match(/^\/([a-z0-9-]+)\/?$/);
  if (boardMatch && boardMatch[1] !== 'admin') { showAppShell(false); return loadBoard(boardMatch[1]); }

  // / → index
  showAppShell(true);
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
  if (a) { e.preventDefault(); closeNavMenu(); navigate(a.getAttribute('href')); return; }

  // Quotelink cross-thread resolution. Post IDs are board-local, so lookups
  // need a board: >>>/board/N links carry theirs in data-board, plain >>N
  // means the board currently being viewed.
  const ql = e.target.closest('.quotelink');
  if (ql) {
    e.preventDefault();
    const m = ql.getAttribute('href')?.match(/#x?p(\d+)$/);
    if (!m) return;
    const id = m[1];
    const xBoard = ql.dataset.board || null;
    if (!xBoard) {
      const target = document.getElementById('p' + id);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid var(--quotelink)';
        setTimeout(() => { target.style.outline = ''; }, 1500);
        return;
      }
    }
    const board = xBoard || state.currentBoard?.uri || location.pathname.split('/')[1];
    if (!board) return;
    api.get('/posts/find/' + board + '/' + id)
      .then(({ boardUri, threadId }) => navigate(`/${boardUri}/${threadId}#p${id}`))
      .catch(() => { /* post gone or not found */ });
  }
});

// ── Nav ───────────────────────────────────────────────────────────────────────

function renderNav(activePath) {
  const nav = document.getElementById('nav');
  const session = state.session;

  const walletLabel = session?.authenticated
    ? session.tripcode ? `!${session.tripcode}` : 'Connected'
    : 'Connect Wallet';

  const TIER_NAMES = { 1: 'Citizen', 2: 'Bourgeois', 3: 'Gentry' };
  const tier = session?.poliPassTier || 0;
  const tierBadge = tier > 0
    ? `<a href="/pass" class="polipass-badge polipass-tier-${tier}">${TIER_NAMES[tier]}</a>`
    : '';

  const isIndex = activePath === '/';
  const watchedLink = `<a href="#" onclick="openWatchedPanel();closeNavMenu();return false" class="nav-watched-link">Watching<span id="watched-count" class="watched-count-badge"></span></a>`;
  const navLinks = isIndex ? watchedLink : `
      <a href="/" data-nav>Boards</a>
      <a href="/pass" ${activePath === '/pass' ? 'class="active"' : ''}>PoliPass</a>
      <a href="/badges" ${activePath === '/badges' ? 'class="active"' : ''}>Badges</a>
      <a href="/wall" ${activePath === '/wall' ? 'class="active"' : ''}>Wall</a>
      <a href="/press" ${activePath === '/press' ? 'class="active"' : ''}>Press</a>
      <a href="/constitution" ${activePath === '/constitution' ? 'class="active"' : ''}>Constitution</a>
      ${watchedLink}`;

  nav.innerHTML = `
    <a class="brand" href="/" data-nav><img src="/.static/images/logo.png" alt="PoliChan" class="brand-logo"></a>
    <div class="nav-links" id="nav-links">
      ${navLinks}
    </div>
    <div class="nav-right">
      ${tierBadge}
      ${session?.isAdmin ? '<a href="/admin" style="color:#ffaaaa;font-size:0.82rem;text-decoration:none;font-weight:bold">Admin</a>' : ''}
      ${!session?.isAdmin && session?.staffRole ? `<span class="nav-role-badge">${session.staffRole === 'janitor' ? 'Janitor' : 'Mod'}</span>` : ''}
      ${!session?.isAdmin && !session?.staffRole && session?.boardRoles?.length
        ? session.boardRoles.map(r => `<a class="nav-role-badge" href="/manage/${esc(r.boardUri)}" title="Open the /${esc(r.boardUri)}/ moderation panel">${r.role === 'janitor' ? 'Janitor' : 'Mod'} /${esc(r.boardUri)}/</a>`).join('')
        : ''}
      <button id="walletBtn" class="${session?.authenticated ? 'connected' : ''}">${walletLabel}</button>
      <select id="theme-select" title="Style" onchange="setTheme(this.value)">
        <option value="green">Green</option>
        <option value="red">Red</option>
        <option value="yotsuba">Yotsuba</option>
        <option value="yotsuba-b">Yotsuba B</option>
        <option value="tomorrow">Tomorrow</option>
      </select>
      <button id="nav-toggle" aria-label="Menu" onclick="toggleNavMenu()">☰</button>
    </div>
  `;

  document.getElementById('walletBtn').addEventListener('click', handleWalletClick);
  updateWatchedIndicator();
  applyTheme(getTheme());
}

function toggleNavMenu() {
  document.getElementById('nav-links')?.classList.toggle('open');
}

function closeNavMenu() {
  document.getElementById('nav-links')?.classList.remove('open');
}

// ── Theme picker ──────────────────────────────────────────────────────────────

function getTheme() {
  const t = localStorage.getItem('theme') || 'green';
  return THEMES.includes(t) ? t : 'green';
}

function applyTheme(theme) {
  for (const t of THEMES) {
    document.documentElement.classList.toggle('theme-' + t, t === theme && t !== 'green');
  }
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = theme;
}

function setTheme(theme) {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
}

// ── Wallet / Auth ─────────────────────────────────────────────────────────────

async function loadSession() {
  try {
    state.session = await api.get('/auth/me');
  } catch (e) {
    state.session = { authenticated: false };
  }
}

// Guards against spam-clicking Connect: each click would queue another
// MetaMask prompt and each completed flow re-issues the session cookie.
let _walletConnecting = false;

async function handleWalletClick() {
  if (state.session?.authenticated) {
    await api.post('/auth/logout', {});
    state.session = { authenticated: false };
    renderNav(location.pathname);
    return;
  }

  if (!window.ethereum) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      const deepLink = 'https://metamask.app.link/dapp/' + location.host + location.pathname;
      window.location.href = deepLink;
    } else {
      toast('MetaMask is not installed. Get it at metamask.io.', true);
    }
    return;
  }

  if (_walletConnecting) return;
  _walletConnecting = true;
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
    toast('Wallet connection failed: ' + e.message, true);
  } finally {
    _walletConnecting = false;
  }
}

// ── Index ─────────────────────────────────────────────────────────────────────

function setScrollBtns(visible) {
  document.getElementById('scroll-btns')?.classList.toggle('visible', visible);
}

function applyBoardCss(css) {
  let el = document.getElementById('board-custom-css');
  if (!css) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'board-custom-css'; document.head.appendChild(el); }
  // Strip </style closing tags to prevent injection breakout
  el.textContent = css.replace(/<\/style/gi, '');
}

async function loadIndex() {
  applyBoardCss('');
  setScrollBtns(false);
  renderNav('/');
  const app = document.getElementById('board-index-root');
  app.innerHTML = '<div class="empty-state">Loading boards…</div>';

  try {
    const { categories } = await api.get('/boards');

    let html = '';

    html += `
      <div id="banner-global" style="display:none;margin:0 0 12px;text-align:center">
        <img src="" alt="banner" style="width:300px;height:100px;object-fit:contain">
      </div>`;

    if (!localStorage.getItem('hide_polichan_intro')) {
      html += `
        <div class="index-box" id="index-intro">
          <div class="index-box-header"><span>What is PoliChan?</span><button onclick="dismissIntro()" title="Close">✕</button></div>
          <div class="index-box-body">
            <p>PoliChan is a simple image-based bulletin board for political discussion. There are boards dedicated to a variety of topics, from general politics to specific countries and current events. Anyone can post without creating an account.</p>
            <p>Pick a board below that catches your eye and dive in.</p>
            <p>Be sure to familiarize yourself with each board's rules before posting, and read the <a href="/faq">FAQ</a> if you wish to learn more about how to use the site.</p>
          </div>
        </div>`;
    }

    html += '<div class="index-box"><div class="index-box-header"><span>Boards</span></div><div class="index-box-body"><div class="board-list-columns">';

    function renderBoardTree(board, depth) {
      let out = boardRow(board, depth);
      for (const child of (board.children || [])) out += renderBoardTree(child, depth + 1);
      return out;
    }

    const generalCats = (categories || []).filter(c => c.type !== 'country');
    const countryCats = (categories || []).filter(c => c.type === 'country');

    if (generalCats.length) {
      html += '<div class="board-list-category-header">General</div>';
      for (const cat of generalCats) {
        html += `<div class="board-list-section"><div class="board-list-group-header">${esc(cat.name)}</div>`;
        for (const b of cat.boards) html += renderBoardTree(b, 0);
        html += '</div>';
      }
    }

    if (countryCats.length) {
      html += '<div class="board-list-category-header">By Country</div>';
      for (const cat of countryCats) {
        html += `<div class="board-list-section"><div class="board-list-group-header">${esc(cat.name)}</div>`;
        for (const b of cat.boards) html += renderBoardTree(b, 0);
        html += '</div>';
      }
    }

    html += '</div></div></div>';

    html += `
      <div class="index-box" id="index-announcements-box" style="display:none">
        <div class="index-box-header"><span>Announcements</span></div>
        <div class="index-box-body" id="index-announcements-body"></div>
      </div>`;

    html += `
      <div class="index-box" id="index-stats-box">
        <div class="index-box-header"><span>Stats</span></div>
        <div class="index-box-body" id="index-stats">Loading…</div>
      </div>`;

    html += `
      <div class="index-footer">
        <div class="index-footer-tabs">
          <a href="/" data-nav>Boards</a>
          <a href="/pass">PoliPass</a>
          <a href="/badges">Badges</a>
          <a href="/wall">Wall</a>
          <a href="/press">Press</a>
          <a href="/constitution">Constitution</a>
        </div>
        <div class="index-footer-links">
          <a href="/about">About</a> &bull; <a href="/faq">FAQ</a> &bull; <a href="/meta/" data-nav>Feedback</a> &bull; <a href="/legal">Legal</a> &bull; <a href="/contact">Contact</a>
        </div>
        <div class="index-footer-copyright">Copyright &copy; ${new Date().getFullYear()} PoliChan. All rights reserved.</div>
      </div>`;

    app.innerHTML = html;
    loadAnnouncementsInline();
    loadBanners('_index');
    loadIndexStats();
  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load boards: ${e.message}</div>`;
  }
}

function dismissIntro() {
  localStorage.setItem('hide_polichan_intro', '1');
  document.getElementById('index-intro')?.remove();
}

function boardRow(board, depth) {
  const indent = depth > 0 ? `padding-left:${depth * 18}px` : '';
  return `
    <div class="board-list-row ${depth > 0 ? 'child' : ''}" style="${indent}" onclick="navigate('/${board.uri}/')">
      <span class="board-list-uri">/${board.uri}/</span>
      <span class="board-list-name">${esc(board.name)}</span>
      <span class="board-list-stats">${board.threadCount || 0}T / ${board.postCount || 0}P</span>
    </div>`;
}

// ── Board Banners ─────────────────────────────────────────────────────────────

let _globalBanners  = [], _globalIdx  = 0, _globalTimer  = null;
let _boardBanners   = [], _boardIdx   = 0, _boardTimer   = null;

async function loadBanners(uri) {
  let rotateMs = 30000;
  try {
    const { banners, rotationSeconds } = await api.get('/banners/' + uri);
    _globalBanners = (banners || []).filter(b => b.isGlobal);
    _boardBanners  = (banners || []).filter(b => !b.isGlobal);
    if (rotationSeconds > 0) rotateMs = rotationSeconds * 1000;
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
    }, rotateMs);
  }
  if (_boardBanners.length > 1) {
    _boardTimer = setInterval(() => {
      _boardIdx = (_boardIdx + 1) % _boardBanners.length;
      renderBoardBanner();
    }, rotateMs);
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

function adSlotHtml(ad, imgStyle) {
  return `
    <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
    <a href="#" data-adv="${ad.advertiserId}" data-adid="${ad.adId}" data-url="${esc(ad.clickUrl)}" target="_blank" rel="noopener noreferrer" onclick="handleAdClick(event,this)">
      <img src="${esc(ad.imageUrl)}" alt="ad" style="${imgStyle}">
    </a>`;
}

function handleAdClick(e, a) {
  e.preventDefault();
  fetch(`/api/ads/${a.dataset.adv}/${a.dataset.adid}/click`, { method: 'POST' }).catch(() => {});
  window.open(a.dataset.url, '_blank', 'noopener,noreferrer');
}

async function loadAds(uri) {
  const isMember = (state.session?.poliPassTier || 0) >= 2;
  const noAdMsg = `<div style="font-size:0.78rem;color:var(--muted);font-style:italic;text-align:center">No ads :)<br>Thanks for supporting PoliChan</div>`;

  for (const elId of ['sp-left', 'sp-right']) {
    const slot = document.getElementById(elId);
    if (!slot) continue;
    if (isMember) { slot.innerHTML = noAdMsg; continue; }
    try {
      const { ad } = await fetch(`/api/ads/${uri}?type=header`).then(r => r.json());
      if (ad) {
        slot.innerHTML = adSlotHtml(ad, 'max-width:100%;max-height:90px;object-fit:contain;display:block');
        fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
      }
    } catch (_) {}
  }

  const footerSlot = document.getElementById('sp-foot');
  if (footerSlot) {
    if (!isMember) {
      try {
        const { ad } = await fetch(`/api/ads/${uri}?type=footer`).then(r => r.json());
        if (ad) {
          footerSlot.innerHTML = `
            <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
            <a href="#" data-adv="${ad.advertiserId}" data-adid="${ad.adId}" data-url="${esc(ad.clickUrl)}" onclick="handleAdClick(event,this)">
              <img src="${esc(ad.imageUrl)}" alt="ad" style="width:300px;height:250px;object-fit:contain">
            </a>`;
          footerSlot.style.display = 'block';
          fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
        }
      } catch (_) {}
    }
  }

  const sidebarSlot = document.getElementById('sp-side');
  if (sidebarSlot && !isMember) {
    try {
      const { ad } = await fetch(`/api/ads/${uri}?type=sidebar`).then(r => r.json());
      if (ad) {
        const link = document.getElementById('sp-side-link');
        document.getElementById('sp-side-img').src = ad.imageUrl;
        link.dataset.adv  = ad.advertiserId;
        link.dataset.adid = ad.adId;
        link.dataset.url  = ad.clickUrl;
        link.onclick      = (e) => handleAdClick(e, link);
        sidebarSlot.classList.add('has-ad');
        // Only count the impression if the sidebar is actually visible
        // (media query hides it below 1100px even with .has-ad set).
        // getComputedStyle, not offsetParent: the latter is null when fixed.
        if (getComputedStyle(sidebarSlot).display !== 'none') {
          fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
        }
      }
    } catch (_) {}
  }
}

async function loadThreadMidAd(uri) {
  const slot = document.getElementById('sp-thread-mid');
  if (!slot) return;
  const isMember = (state.session?.poliPassTier || 0) >= 2;
  if (isMember) { slot.remove(); return; }
  try {
    const { ad } = await fetch(`/api/ads/${uri}?type=sidebar`).then(r => r.json());
    if (ad) {
      slot.innerHTML = `
        <span class="thread-mid-ad-label">Sponsored</span>
        <a href="#" data-adv="${ad.advertiserId}" data-adid="${ad.adId}" data-url="${esc(ad.clickUrl)}" onclick="handleAdClick(event,this)">
          <img src="${esc(ad.imageUrl)}" alt="ad" style="max-width:300px;max-height:250px;object-fit:contain;display:block">
        </a>`;
      fetch(`/api/ads/${ad.advertiserId}/${ad.adId}/impression`, { method: 'POST' }).catch(() => {});
    } else {
      slot.remove();
    }
  } catch (_) { slot.remove(); }
}

// ── User state (localStorage) ─────────────────────────────────────────────────

// Keys are "boardUri:postId" — post numbers are only unique per board, so a
// bare number would light up (You) on unrelated posts across boards. Entries
// without a board prefix predate per-board numbering and are dropped.
const _yourPosts   = new Set(JSON.parse(localStorage.getItem('your_posts')   || '[]').filter(k => String(k).includes(':')));
const _hiddenPosts = new Set(JSON.parse(localStorage.getItem('hidden_posts') || '[]').filter(k => String(k).includes(':')));
let   _watched     = JSON.parse(localStorage.getItem('watched_threads') || '{}');

function _saveYours()   { localStorage.setItem('your_posts',      JSON.stringify([..._yourPosts])); }
function _saveHidden()  { localStorage.setItem('hidden_posts',    JSON.stringify([..._hiddenPosts])); }
function _saveWatched() { localStorage.setItem('watched_threads', JSON.stringify(_watched)); }

function addYourPost(boardUri, id) { _yourPosts.add(`${boardUri}:${id}`); _saveYours(); }

function watchThread(uri, threadId, title, replyCount) {
  _watched[`${uri}:${threadId}`] = { uri, threadId, title, seenCount: replyCount };
  _saveWatched();
  updateWatchedIndicator();
}
function unwatchThread(uri, threadId) {
  delete _watched[`${uri}:${threadId}`];
  _saveWatched();
  updateWatchedIndicator();
}
function markThreadSeen(uri, threadId, replyCount) {
  const w = _watched[`${uri}:${threadId}`];
  if (w) { w.seenCount = replyCount; _saveWatched(); }
}

function toggleWatch(uri, threadId, title, replyCount) {
  if (_watched[`${uri}:${threadId}`]) {
    unwatchThread(uri, threadId);
  } else {
    watchThread(uri, threadId, title, replyCount);
  }
  const link = document.getElementById('watch-link');
  if (link) link.textContent = _watched[`${uri}:${threadId}`] ? 'Unwatch' : 'Watch';
}

function updateWatchedIndicator() {
  const el = document.getElementById('watched-count');
  if (el) {
    const n = Object.keys(_watched).length;
    el.textContent = n > 0 ? `(${n})` : '';
  }
}

function togglePostHide(boardUri, id) {
  const wrap  = document.getElementById('ph-' + id);
  const post  = document.getElementById('p' + id);
  const media = document.getElementById('pm-' + id);  // OP media floats outside the post box
  if (!wrap || !post) return;
  const key = `${boardUri}:${id}`;
  if (_hiddenPosts.has(key)) {
    _hiddenPosts.delete(key);
    _saveHidden();
    wrap.style.display = 'none';
    post.style.display = '';
    if (media) media.style.display = '';
  } else {
    _hiddenPosts.add(key);
    _saveHidden();
    wrap.style.display = 'flex';
    post.style.display = 'none';
    if (media) media.style.display = 'none';
  }
}

function openWatchedPanel() {
  const existing = document.getElementById('watched-panel');
  if (existing) { existing.remove(); return; }

  const entries = Object.values(_watched);
  if (!entries.length) return;

  const panel = document.createElement('div');
  panel.id = 'watched-panel';
  panel.innerHTML = `
    <div id="watched-panel-header">
      <span>Watched Threads</span>
      <button onclick="document.getElementById('watched-panel').remove()">✕</button>
    </div>
    <div id="watched-panel-body">
      ${entries.map(w => `
        <div class="watched-item">
          <a href="/${w.uri}/${w.threadId}" data-nav class="watched-link">${esc(w.title || '#' + w.threadId)}</a>
          <span class="watched-board">/${w.uri}/</span>
          <a href="#" onclick="unwatchThread('${w.uri}',${w.threadId});this.closest('.watched-item').remove();return false" class="watched-remove">✕</a>
        </div>`).join('')}
    </div>`;
  document.body.appendChild(panel);
}

// ── Board rules toggle ────────────────────────────────────────────────────────

function toggleBoardRules() {
  const el = document.getElementById('board-rules');
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Announcements (inline, on board index) ────────────────────────────────────

const _dismissed = new Set(JSON.parse(localStorage.getItem('dismissed_announcements') || '[]'));

async function loadAnnouncementsInline() {
  const box  = document.getElementById('index-announcements-box');
  const body = document.getElementById('index-announcements-body');
  if (!box || !body) return;

  try {
    const { announcements } = await api.get('/announcements');
    const visible = announcements.filter(a => !_dismissed.has(a._id));
    if (!visible.length) return;

    body.innerHTML = visible.map(a => `<div class="announcement-item" data-id="${a._id}">
      <p>${esc(a.text)}</p>
      <button class="ann-dismiss" onclick="dismissAnnouncement('${a._id}')">Dismiss</button>
    </div>`).join('');
    box.style.display = 'block';
  } catch (_) {}
}

async function loadIndexStats() {
  const el = document.getElementById('index-stats');
  if (!el) return;

  try {
    const stats = await api.get('/stats');
    const parts = [];

    parts.push(`${stats.totalPosts.toLocaleString()} posts across ${stats.totalThreads.toLocaleString()} threads`);
    parts.push(`${stats.postsLast24h.toLocaleString()} in the last 24h`);

    if (stats.launchDate) {
      const launch = new Date(stats.launchDate).toLocaleDateString('en-CA');
      parts.push(`running since ${launch}`);
    }

    if (stats.busiestBoard) {
      parts.push(`busiest board: <a href="/${esc(stats.busiestBoard.uri)}/" data-nav>/${esc(stats.busiestBoard.uri)}/</a> (${stats.busiestBoard.postCount.toLocaleString()} posts)`);
    }

    el.innerHTML = `<p>${parts.join(' &bull; ')}</p>`;
  } catch (_) {
    el.textContent = 'Stats unavailable.';
  }
}

// Board pages: slim dismissable bar under the breadcrumb.
// The endpoint returns board-specific + global announcements.
async function loadBoardAnnouncements(uri) {
  const wrap = document.getElementById('board-announcements');
  if (!wrap) return;

  try {
    const { announcements } = await api.get('/announcements/' + uri);
    const visible = announcements.filter(a => !_dismissed.has(a._id));
    if (!visible.length) return;

    wrap.innerHTML = visible.map(a => `<div class="board-ann" data-id="${a._id}">
      <span class="board-ann-text">${esc(a.text)}</span>
      <button class="board-ann-x" title="Dismiss" onclick="dismissBoardAnn('${a._id}')">&times;</button>
    </div>`).join('');
  } catch (_) {}
}

function dismissBoardAnn(id) {
  _dismissed.add(id);
  localStorage.setItem('dismissed_announcements', JSON.stringify([..._dismissed]));
  document.querySelector(`.board-ann[data-id="${id}"]`)?.remove();
}

function dismissAnnouncement(id) {
  _dismissed.add(id);
  localStorage.setItem('dismissed_announcements', JSON.stringify([..._dismissed]));
  const el = document.querySelector(`.announcement-item[data-id="${id}"]`);
  el?.remove();
  if (!document.querySelectorAll('.announcement-item').length) {
    const box = document.getElementById('index-announcements-box');
    if (box) box.style.display = 'none';
  }
}

// ── Board ─────────────────────────────────────────────────────────────────────

async function loadBoard(uri) {
  setScrollBtns(true);
  renderNav('/' + uri + '/');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    // Always fetch with preview=4 so toggling views is instant (no second fetch)
    const { board, threads } = await api.get('/threads/' + uri + '?preview=4');
    state.currentBoard  = board;
    applyBoardCss(board.customCss || '');
    state.boardThreads  = threads;

    const v = state.boardView;

    app.innerHTML = `
      <div class="breadcrumb">
        <a href="/" data-nav>boards</a>
        <span class="sep">›</span>
        <span>/${esc(board.uri)}/</span>
      </div>

      <div id="board-announcements"></div>

      <div class="board-header">
        <div class="board-header-top">
          <div id="sp-left" style="display:flex;flex-direction:column;align-items:center;justify-content:center"></div>
          <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:center">
            <div id="banner-global" style="display:none">
              <img src="" alt="banner" style="width:300px;height:100px;object-fit:contain">
            </div>
            <div class="board-uri-label">/${esc(board.uri)}/</div>
            <h1>${esc(board.name)}</h1>
            ${board.description ? `<div class="board-desc">${esc(board.description)}</div>` : ''}
          </div>
          <div id="sp-right" style="display:flex;flex-direction:column;align-items:center;justify-content:center"></div>
        </div>
        <div class="board-actions">
          ${board.rules ? `[<a href="#" onclick="toggleBoardRules();return false">Rules</a>]` : ''}
          [<a class="view-toggle-btn ${v === 'catalog' ? 'active' : ''}" href="#" onclick="switchBoardView('catalog','${esc(uri)}');return false" data-view="catalog">Catalog</a>]
          [<a class="view-toggle-btn ${v === 'index'   ? 'active' : ''}" href="#" onclick="switchBoardView('index','${esc(uri)}');return false"   data-view="index">Index</a>]
          [<a href="/${esc(uri)}/archive" data-nav>Archive</a>]
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

      <div style="display:flex;gap:20px;align-items:flex-start;position:relative">
        <div id="board-content" style="flex:1;min-width:0"></div>
        <div id="sp-side">
          <div class="sp-side-label">Sponsored</div>
          <a id="sp-side-link" href="#" target="_blank" rel="noopener noreferrer">
            <img id="sp-side-img" src="" alt="ad">
          </a>
        </div>
      </div>

      <div id="sp-foot" style="display:none;margin:16px 0;width:100vw;margin-left:-24px;text-align:center">
        <div style="font-size:0.68rem;color:var(--muted);margin-bottom:2px">Sponsored</div>
        <a id="sp-foot-link" href="#" target="_blank" rel="noopener noreferrer">
          <img id="sp-foot-img" src="" alt="ad" style="width:300px;height:250px;object-fit:contain;max-width:100%">
        </a>
      </div>`;

    renderBoardContent(threads, board, uri);
    loadBoardAnnouncements(uri);
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

// ── Archive view ──────────────────────────────────────────────────────────────

async function loadArchive(uri, page = 1) {
  setScrollBtns(true);
  renderNav('/' + uri + '/');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty-state">Loading archive…</div>';

  try {
    const { board, threads, total, pages } = await api.get(
      `/threads/${uri}/archive?page=${page}`
    );
    state.currentBoard = board;
    applyBoardCss(board.customCss || '');

    const paginationHtml = pages > 1 ? `
      <div class="archive-pagination">
        ${page > 1 ? `[<a href="/${esc(uri)}/archive?page=${page - 1}" data-nav>Prev</a>] ` : ''}
        Page ${page} of ${pages}
        ${page < pages ? ` [<a href="/${esc(uri)}/archive?page=${page + 1}" data-nav>Next</a>]` : ''}
      </div>` : '';

    app.innerHTML = `
      <div class="breadcrumb">
        <a href="/" data-nav>boards</a>
        <span class="sep">›</span>
        <a href="/${esc(board.uri)}/" data-nav>/${esc(board.uri)}/</a>
        <span class="sep">›</span>
        <span>Archive</span>
      </div>

      <div class="board-header">
        <div class="board-header-top">
          <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:center">
            <div class="board-uri-label">/${esc(board.uri)}/</div>
            <h1>${esc(board.name)}</h1>
            <div class="board-desc">Archive: ${total} thread${total !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <div class="board-actions">
          [<a href="/${esc(uri)}/" data-nav>Back to Board</a>]
        </div>
      </div>

      ${threads.length
        ? `${paginationHtml}<div class="catalog">${threads.map(t => catalogCard(t, uri)).join('')}</div>${paginationHtml}`
        : '<div class="empty-state">No archived threads.</div>'}
    `;
  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load archive: ${e.message}</div>`;
  }
}

// ── Catalog view ──────────────────────────────────────────────────────────────

function catalogCard(t, boardUri) {
  const thumb = t.media?.thumbName
    ? `<img class="catalog-thumb" src="/uploads/${boardUri}/${t.media.thumbName}" loading="lazy">`
    : `<div class="catalog-thumb-placeholder">📄</div>`;

  const badges = [
    t.isPinned   ? '<span class="badge-pinned">📌 Pinned</span>'     : '',
    t.isLocked   ? '<span class="badge-locked" title="Locked">🔒</span>'    : '',
    t.bumpLimit  ? '<span class="badge-bump-limit">Bump limit</span>' : '',
    t.removedReason ? `<span class="badge-removed" title="${esc(t.removedReason)}">Removed by staff</span>` : ''
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
      <div class="catalog-excerpt">${t.subject ? esc(strippedBody) : ''}</div>
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
          <img src="/uploads/${uri}/${t.media.thumbName}" data-full="/uploads/${uri}/${t.media.storedName}" data-type="${esc(t.media.type || '')}" ${thumbSizeAttrs(t.media, 300)} onclick="expandMedia(this)" loading="lazy">
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
  const flairHtml    = flairHtmlFor(t.flair, t.flairColor, t.flairBgColor);
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
        ${subjectHtml}<span class="post-name">${esc(t.name || 'Anonymous')}</span>${posterIdChip(t)}${tripcodeHtml}${modHtml}${flairHtml}${sourceHtml}
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
              [<a class="post-action mod-move" onclick="modMoveThread('${uri}', ${id})">Move</a>]
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
            <td><textarea id="nt-body" rows="5" maxlength="5000"></textarea></td>
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
          ${(state.session?.isAdmin || state.session?.staffRole === 'mod') ? `<tr>
            <td class="lbl"></td>
            <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="nt-anon" style="width:auto">
              Post anonymously (hide Mod label)
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
    if (document.getElementById('nt-anon')?.checked) fields.postAnon = 'true';
    const { threadId } = await api.upload('/threads/' + boardUri, fields, fileInput);
    addYourPost(boardUri, threadId);
    watchThread(boardUri, threadId, subject || body.slice(0, 60), 0);
    navigate(`/${boardUri}/${threadId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('nt-captcha');
    if (btn) { btn.disabled = false; btn.value = 'Post'; }
  }
}

// ── Thread view ───────────────────────────────────────────────────────────────

async function loadThread(boardUri, threadId) {
  setScrollBtns(true);
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
    applyBoardCss(board.customCss || '');

    // Build backlinks map: postId → [posts that quote it]
    const backlinks = {};
    for (const p of posts) {
      for (const qid of (p.quotes || [])) {
        if (!backlinks[qid]) backlinks[qid] = [];
        backlinks[qid].push(p);
      }
    }

    let html = `
      <div class="breadcrumb">
        <a href="/" data-nav>boards</a>
        <span class="sep">›</span>
        <a href="/${esc(board.uri)}/" data-nav>/${esc(board.uri)}/</a>
        <span class="sep">›</span>
        <span>#${thread.threadId}</span>
        <span id="watch-btn" style="margin-left:auto;font-size:0.8rem">[<a href="#" onclick="toggleWatch('${boardUri}',${threadId},'${esc((thread.subject||'#'+thread.threadId).replace(/'/g,"\\'"))}',${posts.length});return false" id="watch-link">${_watched[`${boardUri}:${threadId}`] ? 'Unwatch' : 'Watch'}</a>]</span>
      </div>
      ${thread.removedReason ? `
        <div class="thread-removed-banner">
          This thread was removed to the archive by moderators.
          <span class="thread-removed-reason">Reason: ${esc(thread.removedReason)}</span>
        </div>` : ''}
      <div class="thread-view">
        ${renderPost(thread, boardUri, true, backlinks)}
        ${posts.map((p, i) => {
          const midpoint = Math.floor(posts.length * 0.4);
          const injectAd = posts.length >= 20 && i === midpoint;
          return renderPost(p, boardUri, false, backlinks)
            + (injectAd ? '<div id="sp-thread-mid" class="thread-mid-ad"></div>' : '');
        }).join('')}
      </div>
      <div class="thread-bottom-bar">
        [<a class="post-action" onclick="window.scrollTo({top:0,behavior:'smooth'})">Top</a>]
        [<a class="post-action" onclick="returnToCatalog('${boardUri}')">Return to Catalog</a>]
        [<a class="post-action" id="tb-update" onclick="updateThreadNow()">Update</a>]
        [<a class="post-action" id="tb-auto" onclick="toggleAutoUpdate()">Auto: ${_autoUpdate ? 'On' : 'Off'}</a>]
        <span id="tb-status"></span>
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
    markThreadSeen(boardUri, threadId, posts.length);
    updateWatchedIndicator();
    loadThreadMidAd(boardUri);

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

    // Socket.io — live replies (single persistent connection, switch rooms on navigate)
    if (window.io) {
      if (!_socket) {
        _socket = io();
        // Timed soft reset wipes all threads — refresh so the tab isn't stale
        _socket.on('soft-reset', () => location.reload());
      }
      if (_socketRoom) _socket.emit('leave-thread', _socketRoom);
      _socketRoom = { boardUri, threadId };
      _pendingPosts = [];
      _socket.emit('join-thread', { boardUri, threadId });
      _socket.off('new-post');
      _socket.on('new-post', (post) => {
        if (!_autoUpdate) {
          _pendingPosts.push(post);
          setThreadStatus(`${_pendingPosts.length} new post${_pendingPosts.length === 1 ? '' : 's'} waiting`);
          return;
        }
        appendLivePost(post, boardUri);
      });
    }

  } catch (e) {
    app.innerHTML = `<div class="empty-state">Failed to load thread: ${e.message}</div>`;
  }
}

// ── Per-thread poster IDs ─────────────────────────────────────────────────────

// Deterministic chip color from the ID string, 4chan-style
function idColor(pid) {
  let h = 0;
  for (let i = 0; i < pid.length; i++) h = (h * 31 + pid.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const lig = 32 + (h >> 17) % 28;
  return { bg: `hsl(${hue},55%,${lig}%)`, fg: lig > 50 ? '#000' : '#fff' };
}

function posterIdChip(post) {
  if (!post.posterId || post.isModPost) return '';
  const c = idColor(post.posterId);
  return ` <span class="poster-id" style="background:${c.bg};color:${c.fg}" onclick="toggleIdHighlight('${post.posterId}')" title="Highlight this ID's posts in the thread">ID: ${post.posterId}</span>`;
}

let _hlPosterId = null;
function toggleIdHighlight(pid) {
  const on = _hlPosterId !== pid;
  _hlPosterId = on ? pid : null;
  let count = 0;
  document.querySelectorAll('.post[data-poster-id]').forEach(el => {
    const match = el.dataset.posterId === pid;
    if (match) count++;
    el.classList.toggle('id-hl', on && match);
  });
  if (on) toast(`${count} post${count === 1 ? '' : 's'} by ID ${pid} in this thread`);
}

// ── Thread bottom bar: update / auto-update controls ─────────────────────────

// Append one post to the open thread and bump the backlink badges it quotes.
// Used by both the live socket stream and the manual Update button.
function appendLivePost(post, boardUri) {
  if (document.getElementById('p' + post.postId)) return;  // already rendered
  const tv = document.querySelector('.thread-view');
  if (!tv) return;
  tv.insertAdjacentHTML('beforeend', renderPost(post, boardUri, false));
  const pid = post.postId;
  for (const qid of (post.quotes || [])) {
    const blSpan = document.getElementById('bl-' + qid);
    if (!blSpan) continue;
    const existing = blSpan.dataset.pids ? blSpan.dataset.pids.split(',').filter(Boolean) : [];
    if (existing.includes(String(pid))) continue;
    existing.push(String(pid));
    blSpan.dataset.pids = existing.join(',');
    blSpan.textContent = existing.length === 1 ? '1 reply' : `${existing.length} replies`;
    blSpan.onmouseenter = (e) => schedulePostPreview(e, blSpan);
    blSpan.onmouseleave = () => cancelPostPreview();
    blSpan.onclick = (e) => clickBacklinks(e, blSpan);
  }
}

function setThreadStatus(msg) {
  const el = document.getElementById('tb-status');
  if (el) el.textContent = msg;
}

function toggleAutoUpdate() {
  _autoUpdate = !_autoUpdate;
  localStorage.setItem('autoUpdate', _autoUpdate ? 'on' : 'off');
  const btn = document.getElementById('tb-auto');
  if (btn) btn.textContent = 'Auto: ' + (_autoUpdate ? 'On' : 'Off');
  if (_autoUpdate && _pendingPosts.length && _socketRoom) {
    for (const p of _pendingPosts.splice(0)) appendLivePost(p, _socketRoom.boardUri);
    setThreadStatus('');
  }
}

// Manual update: refetch the thread from the API, so it also catches posts
// missed while the socket was disconnected.
async function updateThreadNow() {
  if (!_socketRoom) return;
  const { boardUri, threadId } = _socketRoom;
  const btn = document.getElementById('tb-update');
  if (btn) btn.textContent = 'Updating...';
  try {
    const { posts } = await api.get('/posts/' + boardUri + '/' + threadId);
    _pendingPosts = [];
    let added = 0;
    for (const p of posts) {
      if (!document.getElementById('p' + p.postId)) { appendLivePost(p, boardUri); added++; }
    }
    setThreadStatus(added ? `${added} new post${added === 1 ? '' : 's'}` : 'No new posts');
    setTimeout(() => setThreadStatus(''), 3000);
  } catch (e) {
    setThreadStatus('Update failed');
  }
  if (btn) btn.textContent = 'Update';
}

function returnToCatalog(uri) {
  state.boardView = 'catalog';
  localStorage.setItem('boardView', 'catalog');
  navigate('/' + uri + '/');
}

// Global staff moderate everywhere; board mods only on their own boards.
// Ban and Move stay global-only (they reach beyond a single board).
function isGlobalStaff() {
  return !!(state.session?.isAdmin || state.session?.staffRole);
}
function canModBoard(boardUri) {
  if (isGlobalStaff()) return true;
  return (state.session?.boardRoles || [])
    .some(r => r.boardUri === boardUri && ['mod', 'janitor'].includes(r.role));
}

function renderPost(post, boardUri, isOp, backlinks) {
  const id = post.postId || post.threadId;

  // Public stub for a staff-removed post (server strips the body for
  // non-staff). Keeps the post's slot and number so quotes still resolve.
  if (post.isRemoved && post.stubbed) {
    const stub = `
      <div class="post reply post-removed" id="p${id}">
        <div class="postInfo">
          <span class="post-name">Anonymous</span>
          <span class="post-date">${formatDate(post.createdAt)}</span>
          <span class="post-no">No.${id}</span>
        </div>
        <blockquote class="postMessage post-removed-msg">Post removed by staff${post.removedReason ? `. Reason: ${esc(post.removedReason)}` : ''}</blockquote>
      </div>`;
    return isOp ? stub : `<div class="reply-container" id="rc-${id}">${stub}</div>`;
  }

  const mediaHtml = post.media ? renderMedia(post.media, boardUri) : '';

  const tierLabels = { 1: 'Primary', 2: 'Press', 3: 'Commentary', 4: 'Social' };
  const sourceHtml = post.sourceTag
    ? `<span class="post-source-tag source-tier-${post.sourceTag.tier}">[${tierLabels[post.sourceTag.tier] || ''}]</span>`
    : '';

  const flairHtml    = flairHtmlFor(post.flair, post.flairColor, post.flairBgColor);
  const tripcodeHtml = post.tripcode ? `<span class="post-tripcode">!${esc(post.tripcode)}</span>` : '';
  const modHtml      = post.isModPost ? `<span class="post-mod-label"> ## Mod</span>` : '';
  const subjectHtml  = post.subject  ? `<span class="post-subject">${esc(post.subject)} </span>` : '';
  const idHtml       = posterIdChip(post);

  const badges = [
    isOp && post.isPinned   ? '<span class="badge-pinned">[Pinned]</span>'      : '',
    isOp && post.isLocked   ? '<span class="badge-locked">[Locked]</span>'      : '',
    isOp && post.bumpLimit  ? '<span class="badge-bump-limit">[Bump Limit]</span>' : '',
    // Staff still see removed content in full; badge marks it as handled
    post.isRemoved ? `<span class="badge-removed">[Removed${post.removedReason ? ': ' + esc(post.removedReason) : ''}]</span>` : ''
  ].filter(Boolean).join(' ');

  const myBacklinks = (backlinks || {})[post.postId || post.threadId] || [];
  const blId = post.postId || post.threadId;
  const backlinksHtml = myBacklinks.length
    ? (() => {
        const pids = myBacklinks.map(p => p.postId || p.threadId);
        const label = myBacklinks.length === 1 ? '1 reply' : `${myBacklinks.length} replies`;
        return `<span class="post-backlinks" id="bl-${blId}" data-pids="${pids.join(',')}" onmouseenter="schedulePostPreview(event,this)" onmouseleave="cancelPostPreview()" onclick="clickBacklinks(event,this)">${label}</span>`;
      })()
    : `<span class="post-backlinks" id="bl-${blId}"></span>`;

  const isYou    = _yourPosts.has(`${boardUri}:${id}`);
  const isHidden = _hiddenPosts.has(`${boardUri}:${id}`);

  // Inject (You) into bodyHtml quotelinks (same-board quotes only; cross-board
  // links use #xp anchors and never match)
  let bodyHtml = post.bodyHtml || esc(post.body);
  bodyHtml = bodyHtml.replace(/class="quotelink" href="[^"]*#p(\d+)"/g, (match, qid) =>
    _yourPosts.has(`${boardUri}:${qid}`) ? match.replace('class="quotelink"', 'class="quotelink you-quoted"') : match
  );
  bodyHtml = bodyHtml.replace(/(<a class="quotelink you-quoted"[^>]*>>(\d+)<\/a>)/g,
    '$1<span class="you-tag"> (You)</span>'
  );

  // In thread view the OP's file floats at thread level (outside the OP box),
  // like .index-img-float on the board index, so replies flow beside the
  // image and wrap underneath once past it. Reply media stays inside its post.
  const opMediaHtml = (isOp && mediaHtml)
    ? `<div class="op-media-wrap" id="pm-${id}" style="${isHidden ? 'display:none' : ''}">${mediaHtml}</div>`
    : '';

  const postEl = `
    <div id="ph-${id}" class="post-hidden-bar" style="display:${isHidden ? 'flex' : 'none'}">
      <span class="post-hidden-label">Post hidden</span>
      <a href="#" onclick="togglePostHide('${boardUri}',${id});return false" class="post-action">[Show]</a>
    </div>
    ${opMediaHtml}
    <div class="post ${isOp ? 'op' : 'reply'} ${post.isModPost ? 'mod-post' : ''}" id="p${id}" data-poster-id="${post.posterId || ''}" style="${isHidden ? 'display:none' : ''}">
      <div class="postInfo">
        ${subjectHtml}<span class="post-name">${esc(post.name || 'Anonymous')}</span>${idHtml}${tripcodeHtml}${modHtml}${flairHtml}${sourceHtml}
        <span class="post-date">${formatDate(post.createdAt)}</span>
        <span class="post-no">No.<a class="post-id" href="#p${id}" onclick="quotePost(${id},'${boardUri}',${post.threadId});return false">${id}</a>${isYou ? '<span class="you-tag"> (You)</span>' : ''}</span>
        ${isOp ? '<span class="post-reply-wrap">[<a class="post-inline-link" href="#rp-form" onclick="document.getElementById(\'rp-form-wrap\').style.display=\'block\';document.getElementById(\'rp-body\').focus();return false">Reply</a>]</span>' : ''}
        ${badges}
        ${backlinksHtml}
      </div>
      ${isOp ? '' : mediaHtml}
      <blockquote class="postMessage">${bodyHtml}</blockquote>
      ${isOp && post.poll ? renderPoll(post.poll, boardUri, post.threadId) : ''}
      <div class="post-footer">
        [<a class="post-action" onclick="quotePost(${id},'${boardUri}',${post.threadId})">Reply</a>]
        [<a class="post-action" onclick="togglePostHide('${boardUri}',${id})">Hide</a>]
        [<a class="post-action" onclick="reportPost('${boardUri}', ${post.threadId}, ${isOp ? 'null' : id})">Report</a>]
        ${canModBoard(boardUri)
          ? `<span class="mod-controls">
              ${isOp
                ? `[<a class="post-action mod-del" onclick="modDeleteThread('${boardUri}', ${post.threadId})">Del Thread</a>]
                   [<a class="post-action mod-pin" onclick="modPin('${boardUri}', ${post.threadId}, ${!post.isPinned})">${post.isPinned ? 'Unpin' : 'Pin'}</a>]
                   [<a class="post-action mod-lock" onclick="modLock('${boardUri}', ${post.threadId}, ${!post.isLocked})">${post.isLocked ? 'Unlock' : 'Lock'}</a>]
                   ${isGlobalStaff() ? `[<a class="post-action mod-move" onclick="modMoveThread('${boardUri}', ${post.threadId})">Move</a>]` : ''}`
                : `[<a class="post-action mod-del" onclick="modDeletePost('${boardUri}', ${id}, ${post.threadId})">Del</a>]`
              }
              ${isGlobalStaff() ? `[<a class="post-action mod-ban" onclick="modBan('${boardUri}', ${post.threadId}, ${isOp ? 'null' : id})">Ban</a>]` : ''}
            </span>`
          : ''}
      </div>
    </div>`;

  return isOp ? postEl : `<div class="reply-container" id="rc-${id}">${postEl}</div>`;
}

let _previewTimer = null;

function clickBacklinks(event, el) {
  event.stopPropagation();
  cancelPostPreview();
  const pids = (el.dataset.pids || '').split(',').filter(Boolean);
  if (!pids.length) return;

  if (pids.length === 1) {
    scrollToPost(parseInt(pids[0]));
    return;
  }

  let picker = document.getElementById('reply-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'reply-picker';
    document.body.appendChild(picker);
    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target)) picker.style.display = 'none';
    });
  }

  picker.innerHTML = pids.map(pid =>
    `<a href="#p${pid}" onclick="scrollToPost(${pid});document.getElementById('reply-picker').style.display='none';return false">&gt;&gt;${pid}</a>`
  ).join('');

  const rect = el.getBoundingClientRect();
  picker.style.left    = rect.left + 'px';
  picker.style.top     = (rect.bottom + 4) + 'px';
  picker.style.display = 'block';
}

function scrollToPost(postId) {
  const el = document.getElementById('p' + postId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '2px solid var(--quotelink)';
    setTimeout(() => { el.style.outline = ''; }, 1500);
  }
  return false;
}

function schedulePostPreview(event, triggerEl) {
  cancelPostPreview();
  const x = event.clientX;
  const y = event.clientY;
  _previewTimer = setTimeout(() => showPostPreview(x, y, triggerEl), 500);
}

function cancelPostPreview() {
  clearTimeout(_previewTimer);
  _previewTimer = null;
  const popup = document.getElementById('post-preview-popup');
  if (popup) {
    popup.style.opacity = '0';
    popup.style.display = 'none';
  }
}

function showPostPreview(x, y, triggerEl) {
  const pids = (triggerEl.dataset.pids || '').split(',').filter(Boolean);
  if (!pids.length) return;

  let popup = document.getElementById('post-preview-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'post-preview-popup';
    document.body.appendChild(popup);
  }

  popup.innerHTML = '';
  for (let i = 0; i < pids.length; i++) {
    const srcEl = document.getElementById('p' + pids[i]);
    if (!srcEl) continue;
    if (i > 0) {
      const divider = document.createElement('div');
      divider.style.cssText = 'border-top:1px solid var(--border);margin:6px 0';
      popup.appendChild(divider);
    }
    const clone = document.createElement('div');
    clone.innerHTML = srcEl.outerHTML;
    clone.querySelector('.post-footer')?.remove();
    clone.querySelector('.mod-controls')?.remove();
    clone.querySelector('.post-backlinks')?.remove();
    clone.querySelector('.post-hidden-bar')?.remove();
    popup.appendChild(clone);
  }

  const px = Math.min(x + 14, window.innerWidth - 500);
  const py = Math.min(y + 14, window.innerHeight - 240);
  popup.style.left    = px + 'px';
  popup.style.top     = py + 'px';
  popup.style.opacity = '0';
  popup.style.display = 'block';
  // Trigger fade-in on next frame
  requestAnimationFrame(() => { popup.style.opacity = '1'; });
}

function renderMedia(media, boardUri) {
  const src   = `/uploads/${boardUri}/${media.storedName}`;
  const thumb = `/uploads/${boardUri}/${media.thumbName}`;
  const name  = esc(media.originalName || media.storedName);
  const kb    = media.size ? Math.round(media.size / 1024) + ' KB' : '';
  const dims  = (media.width && media.height) ? `, ${media.width}x${media.height}` : '';
  const info  = `File: <a href="${src}" target="_blank">${name}</a> (${kb}${dims})`;
  // Explicit display dimensions so lazy-loaded thumbs reserve their real
  // space up front; without them the post lays out against a placeholder
  // and the late image load leaves the body text clipping into the float.
  const sizeAttrs = thumbSizeAttrs(media, 300);

  // 4chan layout: the File: line is its own full-width block; only the
  // thumbnail floats, so the body sits beside it
  if (media.type === 'webm' || media.type === 'mp4') {
    const uid = Math.random().toString(36).slice(2, 8);
    return `<div class="file-info">${info}</div>
    <div class="post-file" id="pf-${uid}">
      <video id="v-${uid}" src="${src}" poster="${thumb}" controls loop preload="metadata"></video>
      <div class="video-controls">
        <button class="vid-btn" onclick="toggleVideoExpand('pf-${uid}')">&#x26F6; Expand</button>
        <button class="vid-btn" onclick="document.getElementById('v-${uid}').requestFullscreen()">&#x26F6; Fullscreen</button>
      </div>
    </div>`;
  }
  return `<div class="file-info">${info}</div>
  <div class="post-file">
    <img src="${thumb}" data-full="${src}" ${sizeAttrs} onclick="expandImage(this)" loading="lazy">
  </div>`;
}

// width/height attributes for a thumbnail scaled to fit maxPx, from the
// full image's stored dimensions (thumbs preserve aspect ratio)
function thumbSizeAttrs(media, maxPx) {
  if (!media.width || !media.height) return '';
  const s = Math.min(maxPx / media.width, maxPx / media.height, 1);
  return `width="${Math.round(media.width * s)}" height="${Math.round(media.height * s)}"`;
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
    toast(e.message, true);
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
                <td><textarea id="rp-body" rows="5" maxlength="5000"></textarea></td>
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
              ${(state.session?.isAdmin || state.session?.staffRole === 'mod') ? `<tr>
                <td class="lbl"></td>
                <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
                  <input type="checkbox" id="rp-anon" style="width:auto">
                  Post anonymously (hide Mod label)
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

let _qrBoardUri = null, _qrThreadId = null;

function setupQuickReply(boardUri, threadId) {
  _qrBoardUri = boardUri;
  _qrThreadId = threadId;
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
            <td><textarea id="qr-body" rows="4" style="width:100%;min-width:180px" maxlength="5000"></textarea></td>
          </tr>
          <tr>
            <td class="lbl">File</td>
            <td><input type="file" id="qr-file" accept="image/jpeg,image/png,image/gif,image/webp,video/webm,video/mp4" style="width:100%;font-size:0.78rem"></td>
          </tr>
          ${captchaRowHtml('qr-captcha')}
          ${state.session?.authenticated && state.session?.tripcode ? `<tr>
            <td class="lbl"></td>
            <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="qr-tripcode" style="width:auto">
              Post with wallet tripcode (!${state.session.tripcode})
            </label></td>
          </tr>` : ''}
          ${(state.session?.isAdmin || state.session?.staffRole === 'mod') ? `<tr>
            <td class="lbl"></td>
            <td><label style="font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="qr-anon" style="width:auto">
              Post anonymously (hide Mod label)
            </label></td>
          </tr>` : ''}
        </tbody>
      </table>
      <div style="padding:5px 0">
        <input type="submit" class="submit-btn" id="qr-submit" value="Post Reply" onclick="submitQR('${boardUri}', ${threadId})">
        <span id="qr-error" style="color:red;font-size:0.78rem;margin-left:8px"></span>
      </div>
    </div>`;

  renderCaptchaIn('qr-captcha');
}

function quotePost(postId, boardUri, threadId) {
  // If quoting a post from a different board/thread than the one the quick
  // reply box is currently bound to (e.g. replying from a catalog preview),
  // rebind it first — otherwise the post would submit to the wrong thread.
  if (boardUri && threadId != null && (boardUri !== _qrBoardUri || threadId !== _qrThreadId)) {
    setupQuickReply(boardUri, threadId);
  }

  const qr = document.getElementById('qr');
  if (qr) {
    qr.classList.add('open');
    const body = document.getElementById('qr-body');
    if (body) { body.value += `>>${postId}\n`; body.focus(); }
  } else {
    // Fallback: inline reply form (no QR available on this page at all)
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

    // Your own resolved flair (tier flair, politician SBT, manual rule, etc.) —
    // shown first and selected by default, since that's what posting with no
    // flairVariant at all would already resolve to server-side.
    if (state.session?.flair) {
      const opt = document.createElement('option');
      opt.value           = 'default';
      opt.textContent     = state.session.flair;
      opt.dataset.color   = state.session.flairColor   || '';
      opt.dataset.bgColor = state.session.flairBgColor || '';
      select.insertBefore(opt, select.firstChild);
      select.value = 'default';
    }

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

  if (!body && !fileInput?.files?.[0]) { errEl.textContent = 'A comment or an image is required.'; return; }

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
    if (document.getElementById('rp-anon')?.checked) fields.postAnon = 'true';
    const { postId } = await api.upload(`/posts/${boardUri}/${threadId}`, fields, fileInput);
    addYourPost(boardUri, postId);
    if (!_watched[`${boardUri}:${threadId}`]) watchThread(boardUri, threadId, '', 0);
    navigate(`/${boardUri}/${threadId}#p${postId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('rp-captcha');
    if (btn) { btn.disabled = false; btn.value = 'Post Reply'; }
  }
}

async function submitQR(boardUri, threadId) {
  const name      = document.getElementById('qr-name')?.value.trim();
  const options   = document.getElementById('qr-options')?.value.trim().toLowerCase();
  const body      = document.getElementById('qr-body')?.value.trim();
  const fileInput = document.getElementById('qr-file');
  const errEl     = document.getElementById('qr-error');
  const btn       = document.getElementById('qr-submit');
  if (!body && !fileInput?.files?.[0]) { errEl.textContent = 'A comment or an image is required.'; return; }
  const captchaToken = getCaptchaToken('qr-captcha');
  if (state.turnstileSiteKey && !state.session?.authenticated && !captchaToken) {
    errEl.textContent = 'Please complete the captcha.'; return;
  }
  errEl.textContent = '';

  const isVideo = fileInput?.files?.[0]?.type.startsWith('video/');
  if (btn) { btn.disabled = true; btn.value = isVideo ? 'Processing…' : 'Posting…'; }

  try {
    const fields = { body, name, sage: options === 'sage' };
    if (captchaToken) fields['cf-turnstile-response'] = captchaToken;
    if (document.getElementById('qr-tripcode')?.checked) fields.showTripcode = 'true';
    if (document.getElementById('qr-anon')?.checked) fields.postAnon = 'true';
    const { postId } = await api.upload(`/posts/${boardUri}/${threadId}`, fields, fileInput);
    addYourPost(boardUri, postId);
    if (!_watched[`${boardUri}:${threadId}`]) watchThread(boardUri, threadId, '', 0);
    navigate(`/${boardUri}/${threadId}#p${postId}`);
  } catch (e) {
    errEl.textContent = e.message;
    resetCaptcha('qr-captcha');
  } finally {
    if (btn) { btn.disabled = false; btn.value = 'Post Reply'; }
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

const REPORT_REASONS = [
  { value: 'spam',     label: 'Spam',            desc: 'Advertising, flooding, or bot content' },
  { value: 'illegal',  label: 'Illegal content', desc: 'Content that violates the law' },
  { value: 'offtopic', label: 'Off-topic',       desc: 'Does not belong on this board' }
];

function reportPost(boardUri, threadId, postId) {
  document.getElementById('report-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'report-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-label="Report post">
      <div class="modal-title">Report ${postId ? 'post No.' + postId : 'thread'}</div>
      <div class="modal-body">
        ${REPORT_REASONS.map((r, i) => `
          <label class="report-option">
            <input type="radio" name="report-reason" value="${r.value}" ${i === 0 ? 'checked' : ''}>
            <span class="report-option-text">
              <span class="report-option-label">${r.label}</span>
              <span class="report-option-desc">${r.desc}</span>
            </span>
          </label>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-btn" id="report-cancel">Cancel</button>
        <button type="button" class="modal-btn modal-btn-primary" id="report-submit">Submit Report</button>
      </div>
    </div>`;

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#report-cancel').addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  overlay.querySelector('#report-submit').addEventListener('click', async () => {
    const reason = overlay.querySelector('input[name="report-reason"]:checked')?.value;
    if (!reason) return;
    const btn = overlay.querySelector('#report-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    try {
      await api.post('/posts/' + boardUri + '/' + threadId + '/report', { postId, reason });
      close();
      toast('Report submitted.');
    } catch (e) {
      close();
      toast('Failed: ' + e.message, true);
    }
  });

  document.body.appendChild(overlay);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flairHtmlFor(label, color, bgColor) {
  if (!label) return '';
  const style = `style="background:${esc(bgColor||'#555')};color:${esc(color||'#fff')}"`;
  const isCountryCode = /^[A-Z]{2}$/.test(label);
  if (isCountryCode) {
    const flag = `<img src="https://flagcdn.com/16x12/${label.toLowerCase()}.png" width="16" height="12" alt="" style="vertical-align:middle;margin-right:3px;border-radius:1px">`;
    return `<span class="post-flair" ${style}>${flag}${esc(label)}</span>`;
  }
  return `<span class="post-flair" ${style}>${esc(label)}</span>`;
}

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
  } catch (e) { toast('Pin failed: ' + e.message, true); }
}

async function modLock(boardUri, threadId, locked) {
  try {
    await api.post('/mod/lock', { boardUri, threadId, locked });
    if (state.currentThread) {
      loadThread(boardUri, threadId);
    } else {
      loadBoard(boardUri);
    }
  } catch (e) { toast('Lock failed: ' + e.message, true); }
}

async function modDeletePost(boardUri, postId, threadId) {
  if (!confirm(`Delete No.${postId}?`)) return;
  try {
    await api.post('/mod/delete/post', { boardUri, postId });
    // Remove from DOM immediately
    const el = document.getElementById('p' + postId);
    (el?.closest('.reply-container') || el)?.remove();
  } catch (e) { toast('Delete failed: ' + e.message, true); }
}

async function modDeleteThread(boardUri, threadId) {
  if (!confirm(`Delete entire thread #${threadId} and all its replies?`)) return;
  try {
    await api.post('/mod/delete/thread', { boardUri, threadId });
    navigate('/' + boardUri + '/');
  } catch (e) { toast('Delete failed: ' + e.message, true); }
}

async function modBan(boardUri, threadId, postId) {
  const reasonRaw = prompt('Ban reason:\n1 = Spam\n2 = Illegal content');
  const reasons   = { '1': 'spam', '2': 'illegal' };
  const reason    = reasons[reasonRaw?.trim()];
  if (!reason) return;

  const hoursRaw = prompt('Duration in hours (leave blank for permanent):');
  const hours    = hoursRaw?.trim() ? parseInt(hoursRaw) : null;
  if (hoursRaw?.trim() && !hours) { toast('Invalid duration', true); return; }

  try {
    await api.post('/mod/ban', {
      boardUri, threadId,
      postId:        postId || null,
      reason,
      durationHours: hours
    });
    toast('Banned' + (hours ? ` for ${hours}h` : ' permanently'));
  } catch (e) { toast('Ban failed: ' + e.message, true); }
}

async function modMoveThread(boardUri, threadId) {
  // Lazily build the move dialog the first time it's needed
  let dialog = document.getElementById('mod-move-dialog');
  if (!dialog) {
    dialog = document.createElement('div');
    dialog.id = 'mod-move-dialog';
    dialog.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center';
    dialog.innerHTML = `
      <div style="background:#fff;padding:24px;min-width:280px;max-width:380px;width:90%">
        <div style="font-size:0.9rem;font-weight:bold;margin-bottom:10px;color:#000">Move Thread</div>
        <div style="font-size:0.82rem;color:#555;margin-bottom:10px" id="mod-move-label"></div>
        <select id="mod-move-select" style="width:100%;margin-bottom:14px;background:#fff;color:#000;border:1px solid #ccc;padding:6px;font-size:0.85rem"></select>
        <div style="display:flex;gap:8px">
          <button id="mod-move-confirm" style="padding:6px 16px;background:#2d8a2d;color:#fff;border:none;cursor:pointer;font-size:0.85rem">Move</button>
          <button onclick="document.getElementById('mod-move-dialog').style.display='none'" style="padding:6px 16px;background:#fff;color:#333;border:1px solid #ccc;cursor:pointer;font-size:0.85rem">Cancel</button>
          <span id="mod-move-error" style="font-size:0.78rem;color:#c00;align-self:center"></span>
        </div>
      </div>`;
    document.body.appendChild(dialog);
  }

  // Populate board list
  const sel = document.getElementById('mod-move-select');
  sel.innerHTML = '<option value="">Loading…</option>';
  dialog.style.display = 'flex';
  document.getElementById('mod-move-label').textContent = `Thread #${threadId} on /${boardUri}/`;
  document.getElementById('mod-move-error').textContent = '';

  try {
    const { categories } = await api.get('/boards');
    sel.innerHTML = '';
    for (const cat of (categories || [])) {
      const grp = document.createElement('optgroup');
      grp.label = cat.name;
      grp.style.cssText = 'background:#fff;color:#555';
      function addOptions(boards) {
        for (const b of boards) {
          if (b.uri === boardUri) { addOptions(b.children || []); continue; }
          const opt = document.createElement('option');
          opt.value = b.uri;
          opt.textContent = `/${b.uri}/ — ${b.name}`;
          opt.style.cssText = 'background:#fff;color:#000';
          grp.appendChild(opt);
          addOptions(b.children || []);
        }
      }
      addOptions(cat.boards || []);
      if (grp.children.length) sel.appendChild(grp);
    }
    if (!sel.options.length) sel.innerHTML = '<option value="">No other boards available</option>';
  } catch (e) {
    sel.innerHTML = '<option value="">Failed to load boards</option>';
  }

  document.getElementById('mod-move-confirm').onclick = async () => {
    const targetBoardUri = sel.value;
    if (!targetBoardUri) return;
    const errEl = document.getElementById('mod-move-error');
    errEl.textContent = '';
    try {
      await api.post('/mod/move/thread', { boardUri, threadId, targetBoardUri });
      dialog.style.display = 'none';
      navigate(`/${targetBoardUri}/${threadId}`);
    } catch (e) {
      errEl.textContent = e.message;
    }
  };
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
