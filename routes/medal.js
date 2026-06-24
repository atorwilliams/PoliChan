'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const router  = express.Router();
const { ethers } = require('ethers');
const config  = require('../config');

const ART_DIR  = path.join(__dirname, '..', 'public', 'images', 'medal');
const BASE_URL = 'https://polichan.org';

const ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenYear(uint256 tokenId) view returns (uint16)'
];

function findArtFile(year) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const yearFile = path.join(ART_DIR, `${year}${ext}`);
    if (fs.existsSync(yearFile)) return yearFile;
    const genericFile = path.join(ART_DIR, `medal${ext}`);
    if (fs.existsSync(genericFile)) return genericFile;
  }
  return null;
}

async function getContract() {
  const { address, chainId } = config.serviceMedal;
  if (!address) return null;
  const rpcUrl = config.rpc[chainId];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(address, ABI, provider);
}

// ── Image (per year) ─────────────────────────────────────────────────────────

router.get('/image/:year([0-9]{4})', (req, res) => {
  const year = req.params.year;

  const artFile = findArtFile(year);
  if (artFile) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(artFile);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a1f3a;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#0d0d0d;stop-opacity:1"/>
    </linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  <circle cx="300" cy="280" r="190" fill="none" stroke="#4a90d9" stroke-width="3" opacity="0.8"/>
  <circle cx="300" cy="280" r="170" fill="none" stroke="#4a90d9" stroke-width="1" opacity="0.4"/>
  <text x="300" y="120" font-family="monospace" font-size="13" fill="#4a90d9"
        text-anchor="middle" letter-spacing="6" opacity="0.8">POLICHAN</text>
  <text x="300" y="300" font-family="Georgia, serif" font-size="64" fill="#e8f0ff"
        text-anchor="middle" font-weight="bold">${year}</text>
  <text x="300" y="340" font-family="monospace" font-size="14" fill="#4a90d9"
        text-anchor="middle" letter-spacing="4" opacity="0.8">SERVICE MEDAL</text>
  <text x="300" y="530" font-family="monospace" font-size="10" fill="#e8f0ff"
        text-anchor="middle" opacity="0.5">polichan.org</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ── EIP-721 metadata JSON ───────────────────────────────────────────────────

router.get('/metadata/:file', async (req, res) => {
  try {
    const raw     = req.params.file.replace(/\.json$/, '');
    const tokenId = parseInt(raw);
    if (!tokenId || isNaN(tokenId)) return res.status(400).json({ error: 'Invalid token ID' });

    const contract = await getContract();
    if (!contract) return res.status(503).json({ error: 'ServiceMedal not deployed yet' });

    try {
      await contract.ownerOf(tokenId);
    } catch {
      return res.status(404).json({ error: 'Token does not exist' });
    }

    const year = Number(await contract.tokenYear(tokenId));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      name:        `PoliChan Service Medal #${tokenId} — ${year}`,
      description: `Claimed during ${year}. Soulbound, one per wallet per year.`,
      image:       `${BASE_URL}/medal/image/${year}`,
      external_url: `${BASE_URL}/badges`,
      attributes: [
        { trait_type: 'Badge', value: 'Service Medal' },
        { trait_type: 'Year',  value: year, display_type: 'number' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
