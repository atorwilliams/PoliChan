'use strict';

const express   = require('express');
const router    = express.Router();
const Thread    = require('../models/Thread');
const Post      = require('../models/Post');
const Board     = require('../models/Board');
const markup    = require('../services/markup');
const sourceTag = require('../services/sourceTag');
const ipHash    = require('../services/ipHash');
const media     = require('../services/media');
const counter   = require('../services/counter');
const upload    = require('../middleware/upload');
const captcha   = require('../middleware/captcha');
const { floodCheck } = require('../middleware/rateLimit');
const geoip     = require('../services/geoip');
const config    = require('../config');

// GET /api/threads/:boardUri — thread list (catalog or index view)
// ?preview=N  (1–5) attaches the last N replies as thread.lastPosts for index view
router.get('/:boardUri', async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    if (!isAdmin && (board.minTier || 0) > tier) {
      return res.status(403).json({ error: 'A higher-tier PoliPass is required to access this board' });
    }

    const threads = await Thread.find({ boardUri: req.params.boardUri, isArchived: false })
      .sort({ isPinned: -1, bumpedAt: -1 })
      .limit(board.settings.maxThreads)
      .lean();

    const preview = Math.min(Math.max(parseInt(req.query.preview) || 0, 0), 5);
    if (preview > 0 && threads.length) {
      const threadIds = threads.map(t => t.threadId);
      const allPosts  = await Post.find({
        boardUri: req.params.boardUri,
        threadId: { $in: threadIds }
      }).sort({ postId: 1 }).lean();

      // Group by threadId, keep last N per thread
      const byThread = {};
      for (const p of allPosts) {
        if (!byThread[p.threadId]) byThread[p.threadId] = [];
        byThread[p.threadId].push(p);
      }
      for (const t of threads) {
        t.lastPosts = (byThread[t.threadId] || []).slice(0, preview);
      }
    }

    res.json({ board, threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/:boardUri/:threadId — single thread with posts
router.get('/:boardUri/:threadId', async (req, res) => {
  try {
    const thread = await Thread.findOne({
      boardUri: req.params.boardUri,
      threadId: parseInt(req.params.threadId)
    }).lean();

    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/threads/:boardUri — create thread
router.post('/:boardUri', floodCheck('thread'), upload, captcha, async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri });
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // Region lock check
    if (board.allowedCountries?.length > 0) {
      const rawIpCheck = req.ip || req.connection.remoteAddress;
      const country    = geoip.getCountry(rawIpCheck);
      if (!country || !board.allowedCountries.map(c => c.toUpperCase()).includes(country.toUpperCase())) {
        return res.status(403).json({ error: 'This board is region-locked' });
      }
    }

    const { subject, body, name: rawName } = req.body;
    const name = rawName?.trim().slice(0, 50) || '';
    if (!body?.trim()) return res.status(400).json({ error: 'Body is required' });
    if (!req.file) return res.status(400).json({ error: 'An image or file is required to start a thread' });

    // Process upload if present
    let mediaDoc = null;
    if (req.file) {
      try {
        mediaDoc = await media.processUpload(req.file, board.uri);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Get next globally unique threadId
    const threadId = await counter.nextId();

    const rawIp = req.ip || req.connection.remoteAddress;
    const ip    = ipHash.hash(rawIp);

    // Flair: g:N = global, v:N = PoliPass variant, none = opt out, else session/country fallback
    let postFlair        = null;
    let postFlairColor   = null;
    let postFlairBgColor = null;

    const flairVal = req.body.flairVariant;
    const tier     = req.session?.poliPassTier || 0;

    if (flairVal === 'none') {
      // opted out
    } else if (flairVal?.startsWith('g:')) {
      const idx    = parseInt(flairVal.slice(2));
      const global = require('../config/globalFlairs.json');
      const chosen = global[idx];
      if (chosen) { postFlair = chosen.label; postFlairColor = chosen.color; postFlairBgColor = chosen.bgColor; }
    } else if (flairVal?.startsWith('v:') && tier > 0) {
      const idx      = parseInt(flairVal.slice(2));
      const variants = require('../config/variants.json');
      const chosen   = (variants[String(tier)] || [])[idx];
      if (chosen) { postFlair = chosen.label; postFlairColor = chosen.color; postFlairBgColor = chosen.bgColor; }
    } else {
      postFlair        = req.session?.flair        || null;
      postFlairColor   = req.session?.flairColor   || null;
      postFlairBgColor = req.session?.flairBgColor || null;
    }

    if (!postFlair) {
      const posterCountry = geoip.getCountry(rawIp);
      const boardCountry  = board.uri.split('-')[0];
      const foreign = geoip.foreignFlair(posterCountry, boardCountry);
      if (foreign) {
        postFlair       = foreign.label;
        postFlairColor  = foreign.color;
        postFlairBgColor = foreign.bgColor;
      }
    }

    const thread = await Thread.create({
      boardUri: board.uri,
      threadId,
      name,
      subject:  subject?.trim() || '',
      body:     body.trim(),
      bodyHtml: await markup.process(body.trim()),
      sourceTag: sourceTag.tag(body),
      media:    mediaDoc,
      bumpedAt: new Date(),
      ip,
      authorId:     req.session?.accountId || null,
      tripcode:     (req.body.showTripcode === 'true' && req.session?.tripcode) ? req.session.tripcode : null,
      flair:        postFlair,
      flairColor:   postFlairColor,
      flairBgColor: postFlairBgColor,
      isModPost:    req.session?.isAdmin || req.session?.staffRole === 'mod'
    });

    await Board.updateOne({ uri: board.uri }, { $inc: { threadCount: 1 } });

    // Prune oldest thread if over cap
    await pruneBoard(board);

    req.io.to(board.uri).emit('new-thread', { threadId: thread.threadId });
    res.status(201).json({ threadId: thread.threadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function pruneBoard(board) {
  const max = board.settings.maxThreads;
  const count = await Thread.countDocuments({ boardUri: board.uri, isArchived: false, isPinned: false });
  if (count <= max) return;

  const oldest = await Thread.findOne({ boardUri: board.uri, isArchived: false, isPinned: false })
    .sort({ bumpedAt: 1 }).lean();

  if (!oldest) return;

  if (oldest.replyCount >= config.threads.archiveThreshold) {
    await Thread.updateOne({ _id: oldest._id }, { isArchived: true });
  } else {
    await Thread.deleteOne({ _id: oldest._id });
    await Board.updateOne({ uri: board.uri }, { $inc: { threadCount: -1 } });
  }
}

module.exports = router;
