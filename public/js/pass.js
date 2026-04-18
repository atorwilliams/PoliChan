'use strict';

const CONTRACT_ADDRESS = '0x1B484d1814a42C1C72F65602b18c97cE2aE6573F';
const CHAIN_ID         = 11155111;  // Sepolia — swap to 8453 for Base mainnet
const CHAIN_NAME       = 'Sepolia';

const ABI = [
  'function getPrice(uint8 tier) view returns (uint256)',
  'function getTier(address wallet) view returns (uint8)',
  'function isValid(address wallet) view returns (bool)',
  'function getExpiry(address wallet) view returns (uint256)',
  'function upgradeQuote(address wallet, uint8 newTier) view returns (uint256)',
  'function purchase(uint8 tier) payable',
  'function upgrade(uint8 newTier) payable',
];

const TIER_NAMES = { 1: 'Constituent', 2: 'Member', 3: 'Minister' };

let provider  = null;
let contract  = null;
let wallet    = null;  // connected wallet address

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('walletBtn').addEventListener('click', connect);

// Auto-connect if MetaMask already has permission for this site
window.addEventListener('load', async () => {
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
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainId, 16) !== CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x' + CHAIN_ID.toString(16) }]
      });
    } catch (e) {
      alert(`Please switch MetaMask to ${CHAIN_NAME} (chain ID ${CHAIN_ID}).`);
      return;
    }
  }

  wallet   = address;
  provider = new ethers.BrowserProvider(window.ethereum);
  contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  document.getElementById('walletBtn').textContent =
    wallet.slice(0, 6) + '…' + wallet.slice(-4);
  document.getElementById('connect-prompt').style.display = 'none';
  document.getElementById('tier-cards').style.display     = 'grid';

  await refresh();
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh() {
  const [p1, p2, p3, tier, expiry] = await Promise.all([
    contract.getPrice(1),
    contract.getPrice(2),
    contract.getPrice(3),
    contract.getTier(wallet),
    contract.getExpiry(wallet),
  ]);

  const currentTier = Number(tier);
  const expiryTs    = Number(expiry);

  // Update live ETH prices
  document.getElementById('price-1').textContent = formatEth(p1) + ' ETH';
  document.getElementById('price-2').textContent = formatEth(p2) + ' ETH';
  document.getElementById('price-3').textContent = formatEth(p3) + ' ETH';

  // Update status bar
  const statusEl = document.getElementById('pass-status');
  if (currentTier > 0) {
    const expiryDate = new Date(expiryTs * 1000).toLocaleDateString('en-CA');
    const daysLeft   = Math.ceil((expiryTs * 1000 - Date.now()) / 86400000);
    statusEl.innerHTML = `
      <span class="wallet-addr">${wallet.slice(0, 10)}…${wallet.slice(-6)}</span>
      <span class="pass-badge">${TIER_NAMES[currentTier]}</span>
      <span class="pass-expiry">expires ${expiryDate} (${daysLeft} days)</span>
    `;
    statusEl.style.display = 'flex';
  } else {
    statusEl.style.display = 'none';
  }

  // Highlight current tier card
  for (let t = 1; t <= 3; t++) {
    document.getElementById('card-' + t).classList.toggle('current', t === currentTier);
  }

  // Render action buttons
  const prices = { 1: p1, 2: p2, 3: p3 };

  for (let t = 1; t <= 3; t++) {
    const actionEl = document.getElementById('action-' + t);

    if (t === currentTier) {
      actionEl.innerHTML = `<div class="current-label">Your current tier</div>`;

    } else if (currentTier > 0 && t < currentTier) {
      // Already on a higher tier
      const btn = document.createElement('button');
      btn.className = 'tier-action';
      btn.disabled  = true;
      btn.textContent = 'Already above this tier';
      actionEl.innerHTML = '';
      actionEl.appendChild(btn);

    } else if (currentTier > 0 && t > currentTier) {
      // Upgrade
      const quote = await contract.upgradeQuote(wallet, t);
      const btn = document.createElement('button');
      btn.className   = 'tier-action';
      btn.textContent = `Upgrade — ${formatEth(quote)} ETH`;
      btn.onclick     = () => doUpgrade(t, quote);
      actionEl.innerHTML = '';
      actionEl.appendChild(btn);

    } else {
      // Fresh mint
      const btn = document.createElement('button');
      btn.className   = 'tier-action';
      btn.textContent = `Mint — ${formatEth(prices[t])} ETH`;
      btn.onclick     = () => doPurchase(t, prices[t]);
      actionEl.innerHTML = '';
      actionEl.appendChild(btn);
    }
  }
}

// ── Transactions ──────────────────────────────────────────────────────────────

async function doPurchase(tier, basePrice) {
  try {
    const signer   = await provider.getSigner();
    const c        = contract.connect(signer);
    const value    = withBuffer(basePrice);

    setAllButtons(true);
    showTx('Confirm the transaction in MetaMask…');

    const tx = await c.purchase(tier, { value });
    showTx('Transaction sent — waiting for confirmation…');
    await tx.wait();

    showTx('');
    await refresh();
  } catch (e) {
    showTx('');
    setAllButtons(false);
    if (e.code !== 'ACTION_REJECTED') alert('Transaction failed: ' + (e.reason || e.message));
  }
}

async function doUpgrade(newTier, baseQuote) {
  try {
    const signer = await provider.getSigner();
    const c      = contract.connect(signer);
    const value  = withBuffer(baseQuote);

    setAllButtons(true);
    showTx('Confirm the transaction in MetaMask…');

    const tx = await c.upgrade(newTier, { value });
    showTx('Transaction sent — waiting for confirmation…');
    await tx.wait();

    showTx('');
    await refresh();
  } catch (e) {
    showTx('');
    setAllButtons(false);
    if (e.code !== 'ACTION_REJECTED') alert('Transaction failed: ' + (e.reason || e.message));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Add 0.5% buffer so minor price movement between quote and confirmation doesn't revert
function withBuffer(wei) {
  return BigInt(wei) * 1005n / 1000n;
}

function formatEth(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(5);
}

function setAllButtons(disabled) {
  document.querySelectorAll('.tier-action').forEach(b => { b.disabled = disabled; });
}

function showTx(msg) {
  let el = document.getElementById('tx-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tx-status';
    el.className = 'tx-pending';
    document.getElementById('tier-cards').after(el);
  }
  el.textContent = msg;
}
