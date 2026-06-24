'use strict';

const FOUNDER_ABI = [
  'function hasClaimed(address) view returns (bool)',
  'function isWindowOpen() view returns (bool)',
  'function claim()',
];

const MEDAL_ABI = [
  'function currentYear() view returns (uint16)',
  'function hasClaimedYear(address, uint16) view returns (bool)',
  'function claim()',
];

let badgesConfig = null;
let provider     = null;
let wallet       = null;
let founderContract = null;
let medalContract   = null;

document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('walletBtn').addEventListener('click', connect);

window.addEventListener('load', async () => {
  badgesConfig = await fetch('/api/badges/config').then(r => r.json());

  if (!window.ethereum) return;
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  if (accounts.length) await init(accounts[0]);
});

async function connect() {
  if (!window.ethereum) {
    alert('MetaMask is not installed.');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    await init(accounts[0]);
  } catch (e) {
    alert('Connection failed: ' + e.message);
  }
}

async function init(address) {
  wallet   = address;
  provider = new ethers.BrowserProvider(window.ethereum);

  document.getElementById('walletBtn').textContent =
    wallet.slice(0, 6) + '…' + wallet.slice(-4);
  document.getElementById('connect-prompt').style.display = 'none';
  document.getElementById('badge-cards').style.display     = 'grid';

  await refreshFounder();
  await refreshMedal();
}

// ── Founder ───────────────────────────────────────────────────────────────────

async function refreshFounder() {
  const { address, chainId } = badgesConfig.founderToken;
  const statusEl = document.getElementById('status-founder');
  const actionEl = document.getElementById('action-founder');

  if (!address) {
    statusEl.textContent = 'Not live yet.';
    actionEl.innerHTML = '';
    return;
  }

  try {
    await ensureChain(chainId);
    founderContract = new ethers.Contract(address, FOUNDER_ABI, provider);

    const [claimed, windowOpen] = await Promise.all([
      founderContract.hasClaimed(wallet),
      founderContract.isWindowOpen(),
    ]);

    if (claimed) {
      statusEl.textContent = 'You hold this badge.';
      actionEl.innerHTML = '<div class="badge-claimed-label">Claimed</div>';
    } else if (!windowOpen) {
      statusEl.textContent = 'Claim window has closed.';
      actionEl.innerHTML = '<button class="badge-action" disabled>Window closed</button>';
    } else {
      statusEl.textContent = 'Available now. First week only.';
      const btn = document.createElement('button');
      btn.className   = 'badge-action';
      btn.textContent = 'Claim Founder Badge';
      btn.onclick     = () => doClaim(founderContract, btn, 'founder');
      actionEl.innerHTML = '';
      actionEl.appendChild(btn);
    }
  } catch (e) {
    statusEl.textContent = 'Could not load status.';
    actionEl.innerHTML = '';
  }
}

// ── Service medal ─────────────────────────────────────────────────────────────

async function refreshMedal() {
  const { address, chainId } = badgesConfig.serviceMedal;
  const statusEl = document.getElementById('status-medal');
  const actionEl = document.getElementById('action-medal');

  if (!address) {
    statusEl.textContent = 'Not live yet.';
    actionEl.innerHTML = '';
    return;
  }

  try {
    await ensureChain(chainId);
    medalContract = new ethers.Contract(address, MEDAL_ABI, provider);

    const year = Number(await medalContract.currentYear());
    document.getElementById('medal-name').textContent = `Service Medal ${year}`;
    document.getElementById('medal-year-label').textContent = year;
    document.getElementById('medal-art').src = `/medal/image/${year}`;

    const claimed = await medalContract.hasClaimedYear(wallet, year);

    if (claimed) {
      statusEl.textContent = `You hold the ${year} medal.`;
      actionEl.innerHTML = '<div class="badge-claimed-label">Claimed</div>';
    } else {
      statusEl.textContent = `Available for ${year}.`;
      const btn = document.createElement('button');
      btn.className   = 'badge-action';
      btn.textContent = `Claim ${year} Medal`;
      btn.onclick     = () => doClaim(medalContract, btn, 'medal');
      actionEl.innerHTML = '';
      actionEl.appendChild(btn);
    }
  } catch (e) {
    statusEl.textContent = 'Could not load status.';
    actionEl.innerHTML = '';
  }
}

// ── Shared ────────────────────────────────────────────────────────────────────

async function ensureChain(chainId) {
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(current, 16) === chainId) return;
  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x' + chainId.toString(16) }]
  });
}

async function doClaim(contract, btn, which) {
  try {
    const signer = await provider.getSigner();
    const c      = contract.connect(signer);

    btn.disabled = true;
    showTx('Confirm the transaction in MetaMask…');

    const tx = await c.claim();
    showTx('Transaction sent. Waiting for confirmation…');
    await tx.wait();

    showTx('');
    if (which === 'founder') await refreshFounder();
    else await refreshMedal();
  } catch (e) {
    showTx('');
    btn.disabled = false;
    if (e.code !== 'ACTION_REJECTED') alert('Transaction failed: ' + describeTxError(e));
  }
}

function describeTxError(e) {
  if (e.code === 'ACTION_REJECTED') return 'Cancelled in wallet.';
  if (e.code === 'INSUFFICIENT_FUNDS') return 'Insufficient ETH balance to cover gas.';
  if (e.reason) return e.reason;
  return e.message;
}

function showTx(msg) {
  let el = document.getElementById('tx-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tx-status';
    el.className = 'tx-pending';
    document.getElementById('badge-cards').after(el);
  }
  el.textContent = msg;
}
