'use strict';

const express = require('express');
const router  = express.Router();
const { ethers } = require('ethers');
const config  = require('../config');

const ABI = [
  'function tokenTier(uint256 tokenId) view returns (uint8)',
  'function tokenExpiry(uint256 tokenId) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const TIER_META = {
  1: { name: 'Constituent', color: '#8B0000', accent: '#ff6b6b', text: '#ffffff' },
  2: { name: 'Member',      color: '#1a2a4a', accent: '#4a90d9', text: '#e8f0ff' },
  3: { name: 'Minister',    color: '#1a1200', accent: '#ffd700', text: '#ffd700' }
};

const BASE_URL = 'https://forum.poli-map.org';

async function getContract() {
  const chainId = config.polipass.chainId;
  const rpcUrl  = config.rpc[chainId];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(config.polipass.address, ABI, provider);
}

// ── SVG image per tier ──────────────────────────────────────────────────────

router.get('/image/:tier([1-3])', (req, res) => {
  const tier = parseInt(req.params.tier);
  const meta = TIER_META[tier];
  if (!meta) return res.status(404).send('Not found');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${meta.color};stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#0d0d0d;stop-opacity:1"/>
    </linearGradient>
    <linearGradient id="border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${meta.accent};stop-opacity:0.8"/>
      <stop offset="100%" style="stop-color:${meta.accent};stop-opacity:0.2"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="600" height="600" fill="url(#bg)"/>

  <!-- Border frame -->
  <rect x="20" y="20" width="560" height="560" fill="none" stroke="url(#border)" stroke-width="2"/>
  <rect x="28" y="28" width="544" height="544" fill="none" stroke="${meta.accent}" stroke-width="0.5" opacity="0.3"/>

  <!-- Corner accents -->
  <line x1="20" y1="20" x2="60" y2="20" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="20" y1="20" x2="20" y2="60" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="580" y1="20" x2="540" y2="20" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="580" y1="20" x2="580" y2="60" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="20" y1="580" x2="60" y2="580" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="20" y1="580" x2="20" y2="540" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="580" y1="580" x2="540" y2="580" stroke="${meta.accent}" stroke-width="3"/>
  <line x1="580" y1="580" x2="580" y2="540" stroke="${meta.accent}" stroke-width="3"/>

  <!-- Header label -->
  <text x="300" y="110" font-family="monospace" font-size="13" fill="${meta.accent}"
        text-anchor="middle" letter-spacing="6" opacity="0.7">POLICHAN</text>

  <!-- Divider -->
  <line x1="80" y1="130" x2="520" y2="130" stroke="${meta.accent}" stroke-width="0.5" opacity="0.4"/>

  <!-- Tier name -->
  <text x="300" y="310" font-family="Georgia, serif" font-size="62" fill="${meta.text}"
        text-anchor="middle" font-weight="bold" letter-spacing="2">${meta.name.toUpperCase()}</text>

  <!-- POLIPASS label -->
  <text x="300" y="370" font-family="monospace" font-size="16" fill="${meta.accent}"
        text-anchor="middle" letter-spacing="8" opacity="0.8">POLIPASS</text>

  <!-- Tier number -->
  <text x="300" y="200" font-family="Georgia, serif" font-size="90" fill="${meta.accent}"
        text-anchor="middle" opacity="0.12" font-weight="bold">${tier}</text>

  <!-- Bottom divider -->
  <line x1="80" y1="460" x2="520" y2="460" stroke="${meta.accent}" stroke-width="0.5" opacity="0.4"/>

  <!-- Footer -->
  <text x="300" y="500" font-family="monospace" font-size="11" fill="${meta.accent}"
        text-anchor="middle" letter-spacing="3" opacity="0.5">TIER ${tier} OF 3</text>
  <text x="300" y="530" font-family="monospace" font-size="10" fill="${meta.text}"
        text-anchor="middle" opacity="0.3">forum.poli-map.org</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ── EIP-721 metadata JSON ───────────────────────────────────────────────────

router.get('/metadata/:file', async (req, res) => {
  try {
    // Accept both "1" and "1.json"
    const raw     = req.params.file.replace(/\.json$/, '');
    const tokenId = parseInt(raw);
    if (!tokenId || isNaN(tokenId)) return res.status(400).json({ error: 'Invalid token ID' });

    const contract = await getContract();

    // Verify token exists (ownerOf reverts on non-existent tokens)
    try {
      await contract.ownerOf(tokenId);
    } catch {
      return res.status(404).json({ error: 'Token does not exist' });
    }

    const tier     = Number(await contract.tokenTier(tokenId));
    const expiry   = Number(await contract.tokenExpiry(tokenId));
    const meta     = TIER_META[tier];

    if (!meta) return res.status(404).json({ error: 'Unknown tier' });

    const expiryDate = new Date(expiry * 1000).toISOString().split('T')[0];

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      name:        `PoliPass #${tokenId} — ${meta.name}`,
      description: `A ${meta.name}-tier PoliPass for PoliChan (forum.poli-map.org). Valid through ${expiryDate}. Grants access to tier-gated features on the forum.`,
      image:       `${BASE_URL}/pass/image/${tier}`,
      external_url: `${BASE_URL}/pass`,
      attributes: [
        { trait_type: 'Tier',       value: meta.name },
        { trait_type: 'Tier Level', value: tier,       display_type: 'number' },
        { trait_type: 'Expires',    value: expiry,     display_type: 'date'   }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
