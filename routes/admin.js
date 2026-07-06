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
const PressRelease  = require('../models/PressRelease');
const Advertiser    = require('../models/Advertiser');
const CountryFlair  = require('../models/CountryFlair');
const Category      = require('../models/Category');
const Visit         = require('../models/Visit');
const multer     = require('multer');
const markup     = require('../services/markup');
const media      = require('../services/media');
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

// Record every successful admin mutation for the Changelog page
router.use(require('../services/auditLog').middleware('admin'));

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
router.get('/press',           view('press'));
router.get('/ads',             view('ads'));
router.get('/categories',      view('categories'));
router.get('/country-flairs',  view('country-flairs'));
router.get('/polipass',        view('polipass'));
router.get('/analytics',       view('analytics'));
router.get('/changelog',       view('changelog'));

// ── Changelog (staff action audit log) ────────────────────────────────────────

router.get('/api/changelog', async (req, res) => {
  try {
    const AuditLog = require('../models/AuditLog');
    const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 180);
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const entries = await AuditLog.find({ createdAt: { $gte: cutoff } })
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    res.json({ entries, days });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Country Flairs ────────────────────────────────────────────────────────────

router.get('/api/country-flairs', requireAdmin, async (req, res) => {
  try {
    const rules = await CountryFlair.find().sort({ toCountry: 1, fromCountry: 1 }).lean();
    res.json({ rules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/country-flairs', requireAdmin, async (req, res) => {
  try {
    const { fromCountry, toCountry, label, color, bgColor } = req.body;
    if (!fromCountry || !toCountry || !label) return res.status(400).json({ error: 'fromCountry, toCountry, and label are required' });
    const rule = await CountryFlair.create({
      fromCountry: fromCountry.toUpperCase().trim(),
      toCountry:   toCountry.toUpperCase().trim(),
      label:       label.trim(),
      color:       color   || '#e2e8f0',
      bgColor:     bgColor || '#374151'
    });
    res.json({ rule });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Rule for that country pair already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/country-flairs/:id', requireAdmin, async (req, res) => {
  try {
    const { label, color, bgColor } = req.body;
    const rule = await CountryFlair.findByIdAndUpdate(
      req.params.id,
      { label: label?.trim(), color, bgColor },
      { new: true, runValidators: true }
    ).lean();
    if (!rule) return res.status(404).json({ error: 'Not found' });
    res.json({ rule });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/api/country-flairs/:id', requireAdmin, async (req, res) => {
  try {
    await CountryFlair.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Analytics ─────────────────────────────────────────────────────────────────
// All visitor-derived numbers come from Visit (date + HMAC-hashed IP + scope,
// see services/analytics.js) -- no raw IPs, no third-party trackers. Poster
// numbers come straight from Post (ip is the same hash scheme, authorId is set
// only when posting while logged into a wallet account).

router.get('/api/analytics', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    // Full list of UTC calendar days in range (oldest first) — charts get a
    // bucket for every day, including zero-activity days, so both charts
    // share the same axis and averages divide by the real day count.
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    const sinceDate = dates[0];
    const since = new Date(sinceDate + 'T00:00:00Z');

    const byDayPipeline = [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
    ];
    const byBoardPipeline = [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$boardUri', count: { $sum: 1 } } }
    ];

    // Content lives in two collections: Thread (OPs) + Post (replies).
    // Every post metric must count both or OPs vanish from the stats.
    const [
      visitorsByDayRaw,
      postsByDayRaw, threadsByDayRaw,
      uniqueVisitorHashes,
      postPosterHashes, threadPosterHashes,
      walletReplies, walletOps,
      totalReplies, totalOps,
      boardViews,
      boardPostsRaw, boardThreadsRaw
    ] = await Promise.all([
      Visit.aggregate([
        { $match: { scope: 'site', date: { $gte: sinceDate } } },
        { $group: { _id: '$date', count: { $sum: 1 } } }
      ]),
      Post.aggregate(byDayPipeline),
      Thread.aggregate(byDayPipeline),
      Visit.distinct('ipHash', { scope: 'site', date: { $gte: sinceDate } }),
      Post.distinct('ip', { createdAt: { $gte: since } }),
      Thread.distinct('ip', { createdAt: { $gte: since } }),
      Post.countDocuments({ createdAt: { $gte: since }, authorId: { $ne: null } }),
      Thread.countDocuments({ createdAt: { $gte: since }, authorId: { $ne: null } }),
      Post.countDocuments({ createdAt: { $gte: since } }),
      Thread.countDocuments({ createdAt: { $gte: since } }),
      Visit.aggregate([
        { $match: { scope: { $ne: 'site' }, date: { $gte: sinceDate } } },
        { $group: { _id: '$scope', count: { $sum: 1 } } }
      ]),
      Post.aggregate(byBoardPipeline),
      Thread.aggregate(byBoardPipeline)
    ]);

    const sumCounts = (...rowSets) => {
      const m = {};
      for (const rows of rowSets) {
        for (const r of rows) m[r._id] = (m[r._id] || 0) + r.count;
      }
      return m;
    };

    const visitorMap = sumCounts(visitorsByDayRaw);
    const postDayMap = sumCounts(postsByDayRaw, threadsByDayRaw);

    // Union of boards seen in posts, threads, or visits — a board with
    // traffic but no posts yet still belongs in the table.
    const contentByBoard = sumCounts(boardPostsRaw, boardThreadsRaw);
    const viewsByBoard   = sumCounts(boardViews);
    const postsByBoard = [...new Set([...Object.keys(contentByBoard), ...Object.keys(viewsByBoard)])]
      .map(uri => ({ boardUri: uri, posts: contentByBoard[uri] || 0, visits: viewsByBoard[uri] || 0 }))
      .sort((a, b) => (b.posts - a.posts) || (b.visits - a.visits));

    const uniqueVisitors = uniqueVisitorHashes.length;
    const uniquePosters  = new Set([...postPosterHashes, ...threadPosterHashes]).size;
    const walletPosts    = walletReplies + walletOps;
    const totalPosts     = totalReplies + totalOps;

    res.json({
      days,
      visitorsByDay: dates.map(d => ({ date: d, count: visitorMap[d] || 0 })),
      postsByDay:    dates.map(d => ({ date: d, count: postDayMap[d] || 0 })),
      uniqueVisitors,
      uniquePosters,
      // Visitors hashed via Visit who never appear as a poster's IP hash --
      // floored at 0 since hashing means an exact match isn't guaranteed
      // (e.g. a poster who only ever browsed from a different IP than they posted from).
      lurkers: Math.max(0, uniqueVisitors - uniquePosters),
      walletPosts,
      anonPosts: totalPosts - walletPosts,
      totalPosts,
      popularBoards: postsByBoard
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (parentUri && parentUri === uri) return res.status(400).json({ error: 'A board cannot be its own parent' });

    const board = await Board.create({
      uri, name,
      description:  req.body.description  || '',
      categorySlug: req.body.categorySlug || null,
      parentUri:    req.body.parentUri    || null,
      rules:        req.body.rules        || '',
      settings: {
        maxThreads:       req.body.maxThreads       || 150,
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
    const { name, description, rules, isListed, minTier, maxThreads, archiveThreshold, parentUri, allowedCountries, homeCountry } = req.body;
    const update = {};
    if (name !== undefined)        update.name = name;
    if (description !== undefined) update.description = description;
    if (rules !== undefined)       update.rules = rules;
    if (isListed !== undefined)    update.isListed = isListed;
    if (minTier !== undefined)     update.minTier = minTier;
    if (parentUri !== undefined) {
      if (parentUri && parentUri === req.params.uri) {
        return res.status(400).json({ error: 'A board cannot be its own parent' });
      }
      update.parentUri = parentUri || null;
    }
    if (req.body.categorySlug !== undefined) update.categorySlug = req.body.categorySlug || null;
    if (maxThreads !== undefined)  update['settings.maxThreads'] = maxThreads;
    if (archiveThreshold !== undefined) update['settings.archiveThreshold'] = archiveThreshold;
    if (allowedCountries !== undefined) {
      update.allowedCountries = (allowedCountries || []).map(c => c.trim().toUpperCase()).filter(Boolean);
    }
    if (homeCountry !== undefined) {
      update.homeCountry = homeCountry ? homeCountry.trim().toUpperCase() : '';
    }
    if (req.body.customCss !== undefined) {
      update.customCss = req.body.customCss || '';
    }

    // Re-derive country/region from current URI (updateOne bypasses pre-save hooks)
    const parts = req.params.uri.split('-');
    update.country = parts.length > 1 ? parts[0] : '';
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

// ── Categories ────────────────────────────────────────────────────────────────

router.get('/api/categories', requireAdmin, async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1, name: 1 }).lean();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/categories', requireAdmin, async (req, res) => {
  try {
    const { name, slug, type, order } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    const cat = await Category.create({ name, slug, type: type || 'general', order: parseInt(order) || 0 });
    res.status(201).json({ category: cat });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/categories/:slug', requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (req.body.name  !== undefined) update.name  = req.body.name;
    if (req.body.type  !== undefined) update.type  = req.body.type;
    if (req.body.order !== undefined) update.order = parseInt(req.body.order) || 0;
    await Category.updateOne({ slug: req.params.slug }, update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/categories/:slug', requireAdmin, async (req, res) => {
  try {
    await Category.deleteOne({ slug: req.params.slug });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────

// Open reports enriched with an excerpt of the reported content so mods can
// triage without opening every thread, plus whether the target still exists.
router.get('/api/reports', async (req, res) => {
  try {
    const reports = await Report.find({ resolved: false }).sort({ createdAt: -1 }).lean();

    const postIds   = [...new Set(reports.filter(r => r.postId).map(r => r.postId))];
    const threadIds = [...new Set(reports.map(r => r.threadId))];

    const [posts, threads] = await Promise.all([
      postIds.length
        ? Post.find({ postId: { $in: postIds } }).select('postId body isRemoved').lean()
        : [],
      Thread.find({ threadId: { $in: threadIds } }).select('threadId subject body isArchived removedReason').lean()
    ]);
    const postMap   = Object.fromEntries(posts.map(p => [p.postId, p]));
    const threadMap = Object.fromEntries(threads.map(t => [t.threadId, t]));

    const enriched = reports.map(r => {
      const target = r.postId ? postMap[r.postId] : threadMap[r.threadId];
      return {
        ...r,
        targetExists: !!target,
        targetRemoved: !!(target && (target.isRemoved || target.removedReason)),
        subject: (!r.postId && target?.subject) || '',
        excerpt: target ? (target.body || '').slice(0, 160) : ''
      };
    });

    res.json({ reports: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/reports/:id/resolve', async (req, res) => {
  try {
    await Report.updateOne({ _id: req.params.id }, { resolved: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Content removal (soft) ────────────────────────────────────────────────────
// The default moderation action: content is never destroyed. A removed post
// stays in its thread as a stub with the reason; a removed thread is locked
// and moved to the board's public archive with the reason attached.

router.post('/api/posts/:boardUri/:postId/remove', async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A removal reason is required' });

    const result = await Post.updateOne(
      { boardUri: req.params.boardUri, postId: parseInt(req.params.postId) },
      { $set: { isRemoved: true, removedReason: reason.slice(0, 200) } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Post not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/threads/:boardUri/:threadId/remove', async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A removal reason is required' });

    const boardUri = req.params.boardUri;
    const threadId = parseInt(req.params.threadId);
    const thread = await Thread.findOne({ boardUri, threadId });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const wasLive = !thread.isArchived;
    await Thread.updateOne({ boardUri, threadId }, {
      $set: { isArchived: true, isLocked: true, removedReason: reason.slice(0, 200) }
    });
    // Archived threads don't count against the live-thread cap (matches pruneBoard)
    if (wasLive) await Board.updateOne({ uri: boardUri }, { $inc: { threadCount: -1 } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Content deletion (permanent) ──────────────────────────────────────────────
// For content that can't be kept at all (illegal material). Also removes the
// media files from disk, which the old implementation leaked.

router.delete('/api/posts/:boardUri/:postId', async (req, res) => {
  try {
    const boardUri = req.params.boardUri;
    const post = await Post.findOne({ boardUri, postId: parseInt(req.params.postId) }).lean();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    media.deleteFiles(boardUri, post.media);
    await Post.deleteOne({ _id: post._id });
    await Thread.updateOne({ boardUri, threadId: post.threadId }, { $inc: { replyCount: -1 } });
    await Board.updateOne({ uri: boardUri }, { $inc: { postCount: -1 } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/threads/:boardUri/:threadId', async (req, res) => {
  try {
    const boardUri  = req.params.boardUri;
    const threadId  = parseInt(req.params.threadId);
    const thread = await Thread.findOne({ boardUri, threadId }).lean();
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const posts = await Post.find({ boardUri, threadId }).select('media').lean();
    media.deleteFiles(boardUri, thread.media);
    for (const p of posts) media.deleteFiles(boardUri, p.media);

    await Thread.deleteOne({ _id: thread._id });
    await Post.deleteMany({ boardUri, threadId });
    await Board.updateOne({ uri: boardUri }, {
      $inc: { threadCount: thread.isArchived ? 0 : -1, postCount: -posts.length }
    });
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

// walletAddress is included on purpose: this is the admin panel and the
// tripcode alone can't identify who a staff account belongs to.
router.get('/api/accounts', async (req, res) => {
  const accounts = await Account.find({ staffRole: { $ne: null } }).lean();
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
    if (!walletAddress?.trim()) return res.status(400).json({ error: 'walletAddress required' });
    // Login stores addresses lowercase — a checksummed address here would
    // create a duplicate account (with a different tripcode) that never
    // matches at login, so the role would silently do nothing.
    const addr = walletAddress.trim().toLowerCase();
    const tripcode = require('../services/tripcode');
    const tc = tripcode.generate(addr);
    await Account.findOneAndUpdate(
      { walletAddress: addr },
      { walletAddress: addr, staffRole, tripcode: tc },
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

// ── Timed soft reset ──────────────────────────────────────────────────────────
// Deletes all threads/posts/reports and board media at a scheduled time.
// Boards, accounts, bans, categories, ads, banners, press, and wall survive.

const softReset = require('../services/softReset');

router.get('/api/soft-reset', requireAdmin, async (req, res) => {
  try {
    res.json({ scheduledAt: await softReset.getScheduledAt() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/soft-reset', requireAdmin, async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    const ts = new Date(scheduledAt).getTime();
    if (!scheduledAt || isNaN(ts)) return res.status(400).json({ error: 'A valid date is required' });
    if (ts <= Date.now())          return res.status(400).json({ error: 'Scheduled time must be in the future' });
    await softReset.schedule(new Date(ts).toISOString());
    console.warn(`[SOFT-RESET] Scheduled for ${new Date(ts).toISOString()} by admin`);
    res.json({ ok: true, scheduledAt: new Date(ts).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/soft-reset', requireAdmin, async (req, res) => {
  try {
    await softReset.cancel();
    console.warn('[SOFT-RESET] Schedule cancelled by admin');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/soft-reset/run', requireAdmin, async (req, res) => {
  try {
    if (req.body.confirm !== 'RESET') {
      return res.status(400).json({ error: 'Type RESET in the confirmation box' });
    }
    await softReset.run(req.io);
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

// ── Press Releases ────────────────────────────────────────────────────────────

router.get('/api/press', requireAdmin, async (req, res) => {
  try {
    const releases = await PressRelease.find().sort({ createdAt: -1 }).lean();
    res.json({ releases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const pressUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Images only'), ok);
  }
}).array('images', 6);

router.post('/api/press', requireAdmin, (req, res) => {
  pressUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { title, body } = req.body;
      if (!title?.trim() || !body?.trim()) {
        return res.status(400).json({ error: 'Title and body are required' });
      }

      const mediaDocs = [];
      for (const file of req.files || []) {
        mediaDocs.push(await media.processUpload(file, 'press'));
      }

      const p = await PressRelease.create({ title: title.trim(), body: body.trim(), media: mediaDocs });
      res.json({ release: p });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.patch('/api/press/:id', requireAdmin, async (req, res) => {
  try {
    const { isPublished } = req.body;
    await PressRelease.updateOne({ _id: req.params.id }, { isPublished });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/press/:id', requireAdmin, async (req, res) => {
  try {
    const p = await PressRelease.findByIdAndDelete(req.params.id).lean();
    if (p) {
      const dir = path.join(__dirname, '../public/uploads/press');
      for (const m of p.media || []) {
        try { fs.unlinkSync(path.join(dir, m.storedName)); } catch (_) {}
        try { fs.unlinkSync(path.join(dir, m.thumbName)); } catch (_) {}
      }
    }
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
    const cfg = await SiteConfig.findOne({ key: 'bannerRotationSeconds' }).lean();
    res.json({ banners, rotationSeconds: parseInt(cfg?.value) || 30 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rotation interval for the on-site banner cycler (seconds)
router.patch('/api/banners/rotation', requireAdmin, async (req, res) => {
  try {
    const seconds = parseInt(req.body.seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
      return res.status(400).json({ error: 'seconds must be between 5 and 3600' });
    }
    await SiteConfig.findOneAndUpdate(
      { key: 'bannerRotationSeconds' },
      { value: String(seconds) },
      { upsert: true }
    );
    res.json({ ok: true, rotationSeconds: seconds });
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
