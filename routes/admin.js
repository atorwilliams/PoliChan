'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const Board    = require('../models/Board');
const Thread   = require('../models/Thread');
const Post     = require('../models/Post');
const Ban      = require('../models/Ban');
const Report   = require('../models/Report');
const Account  = require('../models/Account');
const FlairRule  = require('../models/FlairRule');
const WordFilter = require('../models/WordFilter');
const SiteConfig    = require('../models/SiteConfig');
const Banner        = require('../models/Banner');
const Announcement  = require('../models/Announcement');
const Advertiser    = require('../models/Advertiser');
const multer     = require('multer');
const markup     = require('../services/markup');
const { requireAdmin, issueToken } = require('../middleware/auth');
const config   = require('../config');

const path = require('path');
const fs   = require('fs');

// ── Admin login page (no auth required) ───────────────────────────────────────

// Nonce store for challenge-response (in-memory, short TTL)
const challenges = new Map();

// Separate store for wipe challenges (10-min TTL)
const wipeChallenges = new Map();

router.get('/login', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin');
  res.sendFile(require('path').join(__dirname, '../views/admin/login.html'));
});

// GET /admin/challenge — get a challenge nonce for private key login
router.get('/challenge', (req, res) => {
  const challenge = crypto.randomBytes(32).toString('hex');
  challenges.set(challenge, Date.now());
  // Clean up old challenges
  for (const [k, t] of challenges) {
    if (Date.now() - t > 5 * 60 * 1000) challenges.delete(k);
  }
  res.json({ challenge });
});

// POST /admin/login — hash or private key login
router.post('/login', async (req, res) => {
  try {
    const { challenge, signature } = req.body;

    if (!challenge || !signature) {
      return res.status(400).json({ error: 'challenge and signature required' });
    }

    if (!challenges.has(challenge)) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    challenges.delete(challenge);

    // Verify ED25519 signature against stored public key
    if (!config.admin.publicKey) {
      return res.status(500).json({ error: 'Admin public key not configured' });
    }

    const isValid = crypto.verify(
      null,
      Buffer.from(challenge),
      { key: config.admin.publicKey, format: 'pem', type: 'spki', dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64')
    );

    if (!isValid) return res.status(401).json({ error: 'Invalid signature' });

    issueToken(res, { isAdmin: true, staffRole: 'admin', authMethod: 'privatekey' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── All routes below require admin ────────────────────────────────────────────

router.use(requireAdmin);

const view = (name) => (req, res) =>
  res.sendFile(require('path').join(__dirname, `../views/admin/${name}.html`));

router.get('/',          view('index'));
router.get('/boards',    view('boards'));
router.get('/reports',   view('reports'));
router.get('/bans',      view('bans'));
router.get('/accounts',  view('accounts'));
router.get('/flairs',      view('flairs'));
router.get('/polls',       view('polls'));
router.get('/wordfilter',  view('wordfilter'));
router.get('/verified',    view('verified'));
router.get('/danger',          view('danger'));
router.get('/constitution',    view('constitution'));
router.get('/banners',         view('banners'));
router.get('/announcements',   view('announcements'));
router.get('/ads',             view('ads'));

// ── Boards ────────────────────────────────────────────────────────────────────

router.get('/api/boards', async (req, res) => {
  const boards = await Board.find().sort({ uri: 1 }).lean();
  res.json({ boards });
});

router.post('/api/boards', async (req, res) => {
  try {
    const { uri, name, description, parentUri, maxThreads, archiveThreshold } = req.body;
    if (!uri || !name) return res.status(400).json({ error: 'uri and name required' });
    if (!/^[a-z0-9-]+$/.test(uri)) return res.status(400).json({ error: 'Invalid URI — use lowercase letters, numbers, hyphens only' });

    const board = await Board.create({
      uri, name,
      description:  req.body.description || '',
      parentUri:    req.body.parentUri || null,
      rules:        req.body.rules || '',
      settings: {
        maxThreads:       req.body.maxThreads || 150,
        archiveThreshold: req.body.archiveThreshold || 10
      }
    });
    res.status(201).json({ board });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Board URI already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/boards/:uri', async (req, res) => {
  try {
    const { name, description, rules, isListed, minTier, maxThreads, archiveThreshold, parentUri, allowedCountries } = req.body;
    const update = {};
    if (name !== undefined)        update.name = name;
    if (description !== undefined) update.description = description;
    if (rules !== undefined)       update.rules = rules;
    if (isListed !== undefined)    update.isListed = isListed;
    if (minTier !== undefined)     update.minTier = minTier;
    if (parentUri !== undefined)   update.parentUri = parentUri || null;
    if (maxThreads !== undefined)  update['settings.maxThreads'] = maxThreads;
    if (archiveThreshold !== undefined) update['settings.archiveThreshold'] = archiveThreshold;
    if (allowedCountries !== undefined) {
      // Normalise to uppercase, filter blanks
      update.allowedCountries = (allowedCountries || []).map(c => c.trim().toUpperCase()).filter(Boolean);
    }

    // Re-derive country/region from current URI (updateOne bypasses pre-save hooks)
    const parts = req.params.uri.split('-');
    update.country = parts[0] || '';
    update.region  = parts[1] || '';

    await Board.updateOne({ uri: req.params.uri }, update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/boards/:uri', async (req, res) => {
  try {
    await Board.deleteOne({ uri: req.params.uri });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────

router.get('/api/reports', async (req, res) => {
  const reports = await Report.find({ resolved: false }).sort({ createdAt: -1 }).lean();
  res.json({ reports });
});

router.post('/api/reports/:id/resolve', async (req, res) => {
  try {
    await Report.updateOne({ _id: req.params.id }, { resolved: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Content deletion ──────────────────────────────────────────────────────────

router.delete('/api/posts/:boardUri/:postId', async (req, res) => {
  try {
    const result = await Post.deleteOne({
      boardUri: req.params.boardUri,
      postId:   parseInt(req.params.postId)
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/threads/:boardUri/:threadId', async (req, res) => {
  try {
    const boardUri  = req.params.boardUri;
    const threadId  = parseInt(req.params.threadId);
    const t = await Thread.deleteOne({ boardUri, threadId });
    if (t.deletedCount === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    await Post.deleteMany({ boardUri, threadId });
    await Board.updateOne({ uri: boardUri }, { $inc: { threadCount: -1 } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bans ──────────────────────────────────────────────────────────────────────

router.get('/api/bans', async (req, res) => {
  const bans = await Ban.find().sort({ createdAt: -1 }).lean();
  res.json({ bans });
});

router.delete('/api/bans/:id', async (req, res) => {
  await Ban.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

// ── Staff accounts ────────────────────────────────────────────────────────────

router.get('/api/accounts', async (req, res) => {
  const accounts = await Account.find({ staffRole: { $ne: null } })
    .select('-walletAddress').lean();
  res.json({ accounts });
});

router.patch('/api/accounts/:id/role', async (req, res) => {
  try {
    const { staffRole } = req.body;
    if (!['mod', 'janitor', null].includes(staffRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await Account.updateOne({ _id: req.params.id }, { staffRole });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/assign', async (req, res) => {
  try {
    const { walletAddress, staffRole } = req.body;
    if (!['mod', 'janitor'].includes(staffRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const tripcode = require('../services/tripcode');
    const tc = tripcode.generate(walletAddress);
    await Account.findOneAndUpdate(
      { walletAddress },
      { walletAddress, staffRole, tripcode: tc },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Board-specific role assignments ───────────────────────────────────────────

// GET /admin/api/accounts/board-roles?boardUri=ca-ab
router.get('/api/accounts/board-roles', async (req, res) => {
  try {
    const { boardUri } = req.query;
    const query = boardUri
      ? { 'boardRoles.boardUri': boardUri }
      : { boardRoles: { $exists: true, $not: { $size: 0 } } };
    const accounts = await Account.find(query)
      .select('walletAddress tripcode boardRoles createdAt').lean();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/accounts/board-roles — assign board-specific role
router.post('/api/accounts/board-roles', async (req, res) => {
  try {
    const { walletAddress, boardUri, role } = req.body;
    if (!walletAddress || !boardUri) return res.status(400).json({ error: 'walletAddress and boardUri required' });
    if (!['mod', 'janitor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const addr = walletAddress.toLowerCase();
    const tripcode = require('../services/tripcode');
    const tc = tripcode.generate(addr);

    // Upsert account, then remove any existing role for this board and add the new one
    await Account.findOneAndUpdate(
      { walletAddress: addr },
      { walletAddress: addr, tripcode: tc },
      { upsert: true }
    );
    await Account.updateOne(
      { walletAddress: addr },
      { $pull: { boardRoles: { boardUri } } }
    );
    await Account.updateOne(
      { walletAddress: addr },
      { $push: { boardRoles: { boardUri, role } } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/api/accounts/board-roles — revoke board role
router.delete('/api/accounts/board-roles', async (req, res) => {
  try {
    const { walletAddress, boardUri } = req.body;
    if (!walletAddress || !boardUri) return res.status(400).json({ error: 'walletAddress and boardUri required' });
    await Account.updateOne(
      { walletAddress: walletAddress.toLowerCase() },
      { $pull: { boardRoles: { boardUri } } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Flair rules ───────────────────────────────────────────────────────────────

router.get('/api/flairs', async (req, res) => {
  const rules = await FlairRule.find().sort({ priority: -1 }).lean();
  res.json({ rules });
});

router.post('/api/flairs', async (req, res) => {
  try {
    const { name, label, color, bgColor, matchType, tokenAddress, tokenId, chainId, minBalance, wallets, priority, isActive } = req.body;
    if (!name || !label || !matchType) {
      return res.status(400).json({ error: 'name, label, and matchType required' });
    }
    const rule = await FlairRule.create({
      name, label,
      color:        color        || '#ffffff',
      bgColor:      bgColor      || '#555555',
      matchType,
      tokenAddress: tokenAddress || null,
      tokenId:      tokenId      || null,
      chainId:      chainId      || 1,
      minBalance:   minBalance   || '1',
      wallets:      (wallets || []).map(w => w.toLowerCase()),
      priority:     priority     ?? 0,
      isActive:     isActive     !== false
    });
    res.status(201).json({ rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/flairs/:id', async (req, res) => {
  try {
    const { name, label, color, bgColor, matchType, tokenAddress, tokenId, chainId, minBalance, wallets, priority, isActive } = req.body;
    const update = {};
    if (name         !== undefined) update.name         = name;
    if (label        !== undefined) update.label        = label;
    if (color        !== undefined) update.color        = color;
    if (bgColor      !== undefined) update.bgColor      = bgColor;
    if (matchType    !== undefined) update.matchType    = matchType;
    if (tokenAddress !== undefined) update.tokenAddress = tokenAddress || null;
    if (tokenId      !== undefined) update.tokenId      = tokenId      || null;
    if (chainId      !== undefined) update.chainId      = chainId;
    if (minBalance   !== undefined) update.minBalance   = minBalance;
    if (wallets      !== undefined) update.wallets      = wallets.map(w => w.toLowerCase());
    if (priority     !== undefined) update.priority     = priority;
    if (isActive     !== undefined) update.isActive     = isActive;
    await FlairRule.updateOne({ _id: req.params.id }, update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/flairs/:id', async (req, res) => {
  try {
    await FlairRule.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Word filter ───────────────────────────────────────────────────────────────

router.get('/api/wordfilter', async (req, res) => {
  const rules = await WordFilter.find().sort({ word: 1 }).lean();
  res.json({ rules });
});

router.post('/api/wordfilter', async (req, res) => {
  try {
    const { word, replacement, isActive } = req.body;
    if (!word?.trim() || replacement === undefined || replacement === null) {
      return res.status(400).json({ error: 'word and replacement required' });
    }
    const rule = await WordFilter.create({
      word:        word.trim(),
      replacement: replacement,
      isActive:    isActive !== false
    });
    await markup.reload();
    res.status(201).json({ rule });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Word already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/wordfilter/:id', async (req, res) => {
  try {
    const { word, replacement, isActive } = req.body;
    const update = {};
    if (word        !== undefined) update.word        = word.trim();
    if (replacement !== undefined) update.replacement = replacement;
    if (isActive    !== undefined) update.isActive    = isActive;
    await WordFilter.updateOne({ _id: req.params.id }, update);
    await markup.reload();
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Word already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/wordfilter/:id', async (req, res) => {
  try {
    await WordFilter.deleteOne({ _id: req.params.id });
    await markup.reload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Polls ─────────────────────────────────────────────────────────────────────

// GET /admin/api/polls — all threads that have polls
router.get('/api/polls', async (req, res) => {
  try {
    const threads = await Thread.find({ 'poll': { $ne: null } })
      .select('boardUri threadId subject poll createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ polls: threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/api/polls/export.json — machine-readable full export
router.get('/api/polls/export.json', async (req, res) => {
  try {
    const threads = await Thread.find({ 'poll': { $ne: null } })
      .select('boardUri threadId subject poll createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const payload = threads.map(t => ({
      boardUri:  t.boardUri,
      threadId:  t.threadId,
      subject:   t.subject || '',
      question:  t.poll.question,
      closesAt:  t.poll.closesAt || null,
      totalVotes: t.poll.options.reduce((s, o) => s + o.votes, 0),
      options:   t.poll.options.map(o => ({ text: o.text, votes: o.votes })),
      createdAt: t.createdAt
    }));

    res.setHeader('Content-Disposition', 'attachment; filename="polichan-polls.json"');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/api/polls/export.csv — CSV export (one row per option)
router.get('/api/polls/export.csv', async (req, res) => {
  try {
    const threads = await Thread.find({ 'poll': { $ne: null } })
      .select('boardUri threadId subject poll createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const rows = [
      ['boardUri', 'threadId', 'subject', 'question', 'option', 'votes', 'totalVotes', 'pct', 'closesAt', 'createdAt']
    ];

    for (const t of threads) {
      const total = t.poll.options.reduce((s, o) => s + o.votes, 0);
      for (const opt of t.poll.options) {
        const pct = total > 0 ? ((opt.votes / total) * 100).toFixed(1) : '0.0';
        rows.push([
          t.boardUri,
          t.threadId,
          t.subject || '',
          t.poll.question,
          opt.text,
          opt.votes,
          total,
          pct,
          t.poll.closesAt ? t.poll.closesAt.toISOString() : '',
          t.createdAt.toISOString()
        ]);
      }
    }

    const csv = rows.map(r =>
      r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="polichan-polls.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/polls/:boardUri/:threadId — attach or replace poll on a thread
router.post('/api/polls/:boardUri/:threadId', async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const threadId = parseInt(threadIdStr);
    const { question, options, closesAt } = req.body;

    if (!question?.trim()) return res.status(400).json({ error: 'question required' });
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
      return res.status(400).json({ error: '2–6 options required' });
    }

    const thread = await Thread.findOne({ boardUri, threadId });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    thread.poll = {
      question: question.trim(),
      options:  options.map(o => ({ text: String(o).trim(), votes: 0 })),
      voters:   [],
      closesAt: closesAt ? new Date(closesAt) : null
    };
    await thread.save();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/api/polls/:boardUri/:threadId — remove poll from thread
router.delete('/api/polls/:boardUri/:threadId', async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const threadId = parseInt(threadIdStr);

    const result = await Thread.updateOne({ boardUri, threadId }, { $unset: { poll: '' } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Thread not found' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seeder ────────────────────────────────────────────────────────────────────

router.post('/api/seeder/run', async (req, res) => {
  try {
    const seeder = require('../services/seeder');
    const result = await seeder.run();
    res.json({ ok: true, created: result.created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Nuclear wipe ──────────────────────────────────────────────────────────────

// GET /admin/api/wipe/challenge — issue a short-lived nonce for wipe authorization
router.get('/api/wipe/challenge', (req, res) => {
  if (!config.wipe.pubkey1 || !config.wipe.pubkey2) {
    return res.status(503).json({ error: 'Wipe keys not configured (WIPE_PUBKEY_1 / WIPE_PUBKEY_2)' });
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  wipeChallenges.set(challenge, { ts: Date.now(), verified: false, sig1: null, sig2: null });

  // Prune expired
  for (const [k, v] of wipeChallenges) {
    if (Date.now() - v.ts > 10 * 60 * 1000) wipeChallenges.delete(k);
  }

  res.json({ challenge });
});

// POST /admin/api/wipe/verify — check both signatures without wiping anything
router.post('/api/wipe/verify', (req, res) => {
  try {
    const { challenge, sig1, sig2 } = req.body;

    if (!challenge || !sig1 || !sig2) {
      return res.status(400).json({ error: 'challenge, sig1, and sig2 are required' });
    }

    const entry = wipeChallenges.get(challenge);
    if (!entry) return res.status(401).json({ error: 'Invalid or expired challenge. Request a new one.' });

    if (!config.wipe.pubkey1 || !config.wipe.pubkey2) {
      return res.status(503).json({ error: 'Wipe keys not configured' });
    }

    const msg  = Buffer.from(challenge);
    const opts = { format: 'pem', type: 'spki' };

    const sig1Buf = Buffer.from(sig1, 'base64');
    const sig2Buf = Buffer.from(sig2, 'base64');

    const ok1 = crypto.verify(null, msg, { key: config.wipe.pubkey1, ...opts }, sig1Buf);
    const ok2 = crypto.verify(null, msg, { key: config.wipe.pubkey2, ...opts }, sig2Buf);

    if (!ok1) return res.status(401).json({ error: 'Signature 1 is invalid.' });
    if (!ok2) return res.status(401).json({ error: 'Signature 2 is invalid.' });

    // Mark as verified and store sigs so the wipe endpoint doesn't need them again
    entry.verified = true;
    entry.sig1 = sig1;
    entry.sig2 = sig2;

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/wipe — execute wipe (challenge must already be verified)
router.post('/api/wipe', async (req, res) => {
  try {
    const { challenge } = req.body;

    if (!challenge) return res.status(400).json({ error: 'challenge is required' });

    const entry = wipeChallenges.get(challenge);
    if (!entry)           return res.status(401).json({ error: 'Invalid or expired challenge. Request a new one.' });
    if (!entry.verified)  return res.status(401).json({ error: 'Signatures not verified. Use the verify step first.' });

    // Consume challenge immediately
    wipeChallenges.delete(challenge);

    // Wipe all content
    await Promise.all([
      Thread.deleteMany({}),
      Post.deleteMany({}),
      Report.deleteMany({})
    ]);

    await Board.updateMany({}, { $set: { threadCount: 0, postCount: 0 } });

    // Delete uploaded files, recreate empty dir
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(uploadsDir, { recursive: true });

    console.warn(`[WIPE] Forum wiped by admin at ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Announcements ─────────────────────────────────────────────────────────────

router.get('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 }).lean();
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const { text, boardUri } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
    const a = await Announcement.create({ text: text.trim(), boardUri: boardUri || null });
    res.json({ announcement: a });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { isActive } = req.body;
    await Announcement.updateOne({ _id: req.params.id }, { isActive });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    await Announcement.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Banners ───────────────────────────────────────────────────────────────────

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Images only'), ok);
  }
}).single('file');

const BANNER_ROOT = path.join(__dirname, '../public/uploads/banners');

router.get('/api/banners', requireAdmin, async (req, res) => {
  try {
    const banners = await Banner.find().sort({ createdAt: -1 }).lean();
    res.json({ banners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/banners', requireAdmin, (req, res) => {
  bannerUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const isGlobal  = req.body.isGlobal === 'true';
    const boardUri  = isGlobal ? null : (req.body.boardUri || null);
    const ext       = req.file.mimetype.split('/')[1].replace('jpeg','jpg');
    const storedName = require('crypto').randomBytes(8).toString('hex') + '.' + ext;
    const dir       = isGlobal
      ? path.join(BANNER_ROOT, 'global')
      : path.join(BANNER_ROOT, boardUri);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, storedName), req.file.buffer);

    try {
      const banner = await Banner.create({
        boardUri, isGlobal, storedName,
        originalName: req.file.originalname
      });
      res.json({ banner });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.delete('/api/banners/:id', requireAdmin, async (req, res) => {
  try {
    const banner = await Banner.findByIdAndDelete(req.params.id).lean();
    if (!banner) return res.status(404).json({ error: 'Not found' });
    const dir = banner.isGlobal
      ? path.join(BANNER_ROOT, 'global')
      : path.join(BANNER_ROOT, banner.boardUri);
    try { fs.unlinkSync(path.join(dir, banner.storedName)); } catch (_) {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Constitution ──────────────────────────────────────────────────────────────

router.get('/api/constitution', requireAdmin, async (req, res) => {
  try {
    const doc = await SiteConfig.findOne({ key: 'constitution' }).lean();
    res.json({ text: doc?.value || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/constitution', requireAdmin, async (req, res) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    await SiteConfig.findOneAndUpdate(
      { key: 'constitution' },
      { value: text },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Advertisers / Ads ─────────────────────────────────────────────────────────

const AD_ROOT = path.join(__dirname, '../public/uploads/ads');

const adUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(AD_ROOT, { recursive: true });
      cb(null, AD_ROOT);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(png|jpeg|gif|webp)/.test(file.mimetype));
  }
});

router.get('/api/advertisers', requireAdmin, async (req, res) => {
  try {
    const advertisers = await Advertiser.find().sort({ company: 1 }).lean();
    res.json({ advertisers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/advertisers', requireAdmin, async (req, res) => {
  try {
    const { company, contact } = req.body;
    if (!company) return res.status(400).json({ error: 'Company name required' });
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const advertiser = await Advertiser.create({ slug, company, contact: contact || '' });
    res.json({ advertiser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/advertisers/:id', requireAdmin, async (req, res) => {
  try {
    const { company, contact } = req.body;
    const advertiser = await Advertiser.findByIdAndUpdate(
      req.params.id,
      { company, contact },
      { new: true }
    ).lean();
    if (!advertiser) return res.status(404).json({ error: 'Not found' });
    res.json({ advertiser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/advertisers/:id', requireAdmin, async (req, res) => {
  try {
    const advertiser = await Advertiser.findById(req.params.id).lean();
    if (!advertiser) return res.status(404).json({ error: 'Not found' });
    for (const ad of advertiser.ads) {
      const f = path.join(AD_ROOT, ad.imageFile);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    await Advertiser.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/advertisers/:id/ads', requireAdmin, adUpload.single('image'), async (req, res) => {
  try {
    const { type, boardUri, clickUrl, startDate, endDate } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Image required' });
    if (!['header', 'banner', 'footer', 'sidebar'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!clickUrl) return res.status(400).json({ error: 'Click URL required' });

    const ad = {
      type,
      boardUri: boardUri || null,
      imageFile: req.file.filename,
      clickUrl,
      isActive: true,
      startDate: startDate ? new Date(startDate) : null,
      endDate:   endDate   ? new Date(endDate)   : null,
      impressions: 0,
      clicks: 0
    };

    const advertiser = await Advertiser.findByIdAndUpdate(
      req.params.id,
      { $push: { ads: ad } },
      { new: true }
    ).lean();
    if (!advertiser) return res.status(404).json({ error: 'Not found' });
    res.json({ advertiser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/advertisers/:id/ads/:adId', requireAdmin, async (req, res) => {
  try {
    const { isActive, clickUrl, startDate, endDate } = req.body;
    const update = {};
    if (isActive !== undefined) update['ads.$.isActive'] = isActive;
    if (clickUrl !== undefined) update['ads.$.clickUrl'] = clickUrl;
    if (startDate !== undefined) update['ads.$.startDate'] = startDate ? new Date(startDate) : null;
    if (endDate   !== undefined) update['ads.$.endDate']   = endDate   ? new Date(endDate)   : null;

    await Advertiser.updateOne(
      { _id: req.params.id, 'ads._id': req.params.adId },
      { $set: update }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/advertisers/:id/ads/:adId', requireAdmin, async (req, res) => {
  try {
    const advertiser = await Advertiser.findById(req.params.id).lean();
    if (!advertiser) return res.status(404).json({ error: 'Not found' });
    const ad = advertiser.ads.find(a => String(a._id) === req.params.adId);
    if (ad) {
      const f = path.join(AD_ROOT, ad.imageFile);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    await Advertiser.updateOne(
      { _id: req.params.id },
      { $pull: { ads: { _id: req.params.adId } } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
