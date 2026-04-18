'use strict';

const CONTRACT_ADDRESS = '0x1B484d1814a42C1C72F65602b18c97cE2aE6573F';
const CHAIN_ID         = 11155111; // Sepolia

let _provider = null;
let _signer   = null;
let _address  = null;

// ── Wallet ──────────────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.ethereum) { alert('MetaMask not found.'); return false; }

  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x' + CHAIN_ID.toString(16) }]
      });
    } catch {
      alert('Please switch to the correct network in MetaMask.');
      return false;
    }
  }

  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts.length) return false;

  _provider = new ethers.BrowserProvider(window.ethereum);
  _signer   = await _provider.getSigner();
  _address  = accounts[0].toLowerCase();

  document.getElementById('walletBtn').textContent =
    _address.slice(0, 6) + '…' + _address.slice(-4);

  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildMessage(title, body) {
  return `PoliChan Wall of Supporters\n\nTitle: ${title}\n\n${body}`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderPosts(posts) {
  const container = document.getElementById('wall-posts');
  document.getElementById('wall-loading').style.display = 'none';

  if (!posts.length) {
    container.innerHTML = '<div id="wall-empty">No posts yet. Be the first.</div>';
    return;
  }

  container.innerHTML = posts.map(p => {
    const walletHtml = p.wallet
      ? `<div class="wall-post-wallet">${esc(p.wallet)}</div>`
      : '';

    const sigShort = p.signature.slice(0, 20) + '…';

    return `
      <div class="wall-post">
        <div class="wall-post-header">
          <div class="wall-post-title">${esc(p.title)}</div>
          <div class="wall-post-meta">
            <span class="wall-minister-badge">Minister</span>
            &nbsp;${esc(formatDate(p.createdAt))}
          </div>
        </div>
        <div class="wall-post-author">${esc(p.displayName)}</div>
        ${walletHtml}
        <div class="wall-post-body">${esc(p.body)}</div>
        <span class="wall-verify-link">
          Signature: <code title="${esc(p.signature)}">${esc(sigShort)}</code>
          — verifiable with any Ethereum signing tool
        </span>
      </div>`;
  }).join('');
}

// ── Load posts ───────────────────────────────────────────────────────────────

async function loadPosts() {
  try {
    const res  = await fetch('/api/wall');
    const data = await res.json();
    renderPosts(data.posts || []);
  } catch {
    document.getElementById('wall-loading').textContent = 'Failed to load posts.';
  }
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function submitPost() {
  const btn   = document.getElementById('compose-submit');
  const errEl = document.getElementById('compose-error');
  const title = document.getElementById('c-title').value.trim();
  const body  = document.getElementById('c-body').value.trim();
  const name  = document.getElementById('c-name').value.trim();
  const isAnon = document.getElementById('c-anon').checked;

  errEl.textContent = '';

  if (!title) { errEl.textContent = 'Title is required.'; return; }
  if (!body)  { errEl.textContent = 'Body is required.'; return; }

  if (!_signer) {
    const ok = await connectWallet();
    if (!ok) return;
  }

  btn.disabled  = true;
  btn.textContent = 'Signing…';

  try {
    const message   = buildMessage(title, body);
    const signature = await _signer.signMessage(message);

    const res = await fetch('/api/wall', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address: _address, signature, displayName: name, title, body, isAnon })
    });

    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Post failed.'; return; }

    // Success — hide form, reload posts
    document.getElementById('compose-wrap').style.display = 'none';
    document.getElementById('c-title').value = '';
    document.getElementById('c-body').value  = '';
    await loadPosts();
  } catch (e) {
    errEl.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Sign & Post';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.getElementById('walletBtn').addEventListener('click', connectWallet);

document.getElementById('postBtn').addEventListener('click', async () => {
  const wrap = document.getElementById('compose-wrap');
  if (wrap.style.display === 'none') {
    if (!_signer) {
      const ok = await connectWallet();
      if (!ok) return;
    }
    wrap.style.display = '';
    document.getElementById('c-title').focus();
  } else {
    wrap.style.display = 'none';
  }
});

document.getElementById('compose-submit').addEventListener('click', submitPost);

// Auto-connect if already permitted
window.ethereum?.request({ method: 'eth_accounts' }).then(accounts => {
  if (accounts.length) connectWallet();
}).catch(() => {});

loadPosts();
