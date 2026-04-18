'use strict';

const express    = require('express');
const router     = express.Router();
const { ethers } = require('ethers');
const WallPost   = require('../models/WallPost');
const config     = require('../config');

const POLIPASS_ABI = ['function getTier(address wallet) view returns (uint8)'];

async function getProvider() {
  const chainId = config.polipass.chainId;
  const rpcUrl  = config.rpc[chainId];
  return new ethers.JsonRpcProvider(rpcUrl);
}

function buildMessage(title, body) {
  return `PoliChan Wall of Supporters\n\nTitle: ${title}\n\n${body}`;
}

// GET /api/wall — all posts, newest first
router.get('/', async (req, res) => {
  try {
    const posts = await WallPost.find()
      .sort({ createdAt: -1 })
      .lean();

    res.json({ posts: posts.map(p => ({
      _id:         p._id,
      displayName: p.isAnon ? 'Anonymous Minister' : (p.displayName || 'Anonymous Minister'),
      wallet:      p.isAnon ? null : p.walletAddress,
      title:       p.title,
      body:        p.body,
      signature:   p.signature,
      createdAt:   p.createdAt
    })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wall — submit a wall post
router.post('/', async (req, res) => {
  try {
    const { address, signature, displayName, title, body, isAnon } = req.body;

    if (!address || !signature || !title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'address, signature, title, and body are required' });
    }
    if (title.trim().length > 120)  return res.status(400).json({ error: 'Title too long (max 120)' });
    if (body.trim().length > 10000) return res.status(400).json({ error: 'Body too long (max 10 000 chars)' });

    // 1. Verify signature
    const message   = buildMessage(title.trim(), body.trim());
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'Signature does not match address' });
    }

    // 2. Verify Minister tier
    const provider = await getProvider();
    const contract = new ethers.Contract(config.polipass.address, POLIPASS_ABI, provider);
    const tier     = await contract.getTier(address.toLowerCase());
    if (Number(tier) < 3) {
      return res.status(403).json({ error: 'A Minister-tier PoliPass is required' });
    }

    // 3. Prevent duplicate submissions (same wallet + same title + body)
    const existing = await WallPost.findOne({ walletAddress: address.toLowerCase(), title: title.trim() });
    if (existing) return res.status(409).json({ error: 'You already have a post with that title' });

    const post = await WallPost.create({
      walletAddress: address.toLowerCase(),
      displayName:   displayName?.trim().slice(0, 50) || '',
      isAnon:        !!isAnon,
      title:         title.trim(),
      body:          body.trim(),
      signature
    });

    res.status(201).json({ ok: true, id: post._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
