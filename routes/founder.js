'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const router  = express.Router();
const { ethers } = require('ethers');
const config  = require('../config');

const ART_DIR  = path.join(__dirname, '..', 'public', 'images', 'founder');
const BASE_URL = 'https://polichan.org';

const ABI = ['function ownerOf(uint256 tokenId) view returns (address)'];

function findArtFile() {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const file = path.join(ART_DIR, 'founder' + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function getContract() {
  const { address, chainId } = config.founderToken;
  if (!address) return null;
  const rpcUrl = config.rpc[chainId];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(address, ABI, provider);
}

// ── Image ────────────────────────────────────────────────────────────────────

router.get('/image', (_req, res) => {
  const artFile = findArtFile();
  if (artFile) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(artFile);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3a1a00;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#0d0d0d;stop-opacity:1"/>
    </linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  <rect x="20" y="20" width="560" height="560" fill="none" stroke="#ff9d2f" stroke-width="2" opacity="0.7"/>
  <text x="300" y="110" font-family="monospace" font-size="13" fill="#ff9d2f"
        text-anchor="middle" letter-spacing="6" opacity="0.8">POLICHAN</text>
  <line x1="80" y1="130" x2="520" y2="130" stroke="#ff9d2f" stroke-width="0.5" opacity="0.4"/>
  <text x="300" y="300" font-family="Georgia, serif" font-size="56" fill="#ffd9a8"
        text-anchor="middle" font-weight="bold">FOUNDER</text>
  <text x="300" y="350" font-family="monospace" font-size="14" fill="#ff9d2f"
        text-anchor="middle" letter-spacing="4" opacity="0.8">WEEK ONE</text>
  <line x1="80" y1="460" x2="520" y2="460" stroke="#ff9d2f" stroke-width="0.5" opacity="0.4"/>
  <text x="300" y="530" font-family="monospace" font-size="10" fill="#ffd9a8"
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
    if (!contract) return res.status(503).json({ error: 'FounderToken not deployed yet' });

    try {
      await contract.ownerOf(tokenId);
    } catch {
      return res.status(404).json({ error: 'Token does not exist' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      name:        `PoliChan Founder #${tokenId}`,
      description: 'Claimed during the first week PoliChan was live. Permanent, soulbound, one per wallet.',
      image:       `${BASE_URL}/founder/image`,
      external_url: `${BASE_URL}/badges`,
      attributes: [
        { trait_type: 'Badge', value: 'Founder' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
