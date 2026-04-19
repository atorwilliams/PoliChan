'use strict';

const express  = require('express');
const router   = express.Router();
const { ethers } = require('ethers');
const Account  = require('../models/Account');
const tripcode = require('../services/tripcode');
const { issueToken } = require('../middleware/auth');
const config   = require('../config');
const flair    = require('../services/flair');

// POST /api/auth/wallet — MetaMask wallet login
// Body: { address, signature, nonce }
router.post('/wallet', async (req, res) => {
  try {
    const { address, signature, nonce } = req.body;
    if (!address || !signature || !nonce) {
      return res.status(400).json({ error: 'address, signature, and nonce required' });
    }

    // Verify the signature
    const recovered = ethers.verifyMessage(nonce, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const normalizedAddress = address.toLowerCase();
    const isAdmin = config.admin.wallets.includes(normalizedAddress);

    // Upsert account
    let account = await Account.findOne({ walletAddress: normalizedAddress });
    if (!account) {
      const tc = tripcode.generate(normalizedAddress);
      account = await Account.create({ walletAddress: normalizedAddress, tripcode: tc });
    }

    // Resolve flair from on-chain rules (non-blocking — defaults to null on error)
    console.log('[auth] calling getFlairForWallet for', normalizedAddress);
    const flairData = await flair.getFlairForWallet(normalizedAddress).catch((e) => { console.error('[auth] flair error:', e.message); return null; });

    const payload = {
      accountId:    account._id,
      isAdmin,
      staffRole:    isAdmin ? 'admin' : (account.staffRole || null),
      boardRoles:   account.boardRoles || [],
      tripcode:     account.tripcode,
      showTripcode: account.showTripcode,
      flair:        flairData?.label       || null,
      flairColor:   flairData?.color       || null,
      flairBgColor: flairData?.bgColor     || null,
      poliPassTier: flairData?.poliPassTier || 0
    };

    issueToken(res, payload);
    res.json({ ok: true, isAdmin, tripcode: account.tripcode, flair: flairData?.label || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/nonce — get a challenge nonce for wallet signing
router.get('/nonce', (req, res) => {
  const nonce = `PoliChan login: ${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.json({ nonce });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me — current session info (no sensitive data)
router.get('/me', (req, res) => {
  if (!req.session) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    isAdmin:       req.session.isAdmin,
    staffRole:     req.session.staffRole,
    showTripcode:  req.session.showTripcode,
    tripcode:      req.session.showTripcode ? req.session.tripcode : null,
    flair:         req.session.flair,
    flairColor:    req.session.flairColor    || null,
    flairBgColor:  req.session.flairBgColor  || null,
    poliPassTier:  req.session.poliPassTier  || 0
  });
});

// GET /api/auth/variants — flair variants available for the current user's PoliPass tier
router.get('/variants', (req, res) => {
  const tier = req.session?.poliPassTier || 0;
  if (!tier) return res.json({ variants: [] });
  const all = require('../config/variants.json');
  res.json({ variants: all[String(tier)] || [] });
});

// GET /api/auth/global-flairs — site-wide flairs available to everyone
router.get('/global-flairs', (_req, res) => {
  res.json({ flairs: require('../config/globalFlairs.json') });
});

// GET /api/auth/config — public client config
router.get('/config', (req, res) => {
  res.json({
    turnstileSiteKey: config.turnstile.enabled ? config.turnstile.siteKey : null
  });
});

module.exports = router;
