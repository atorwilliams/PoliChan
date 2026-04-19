'use strict';

const express   = require('express');
const router    = express.Router();
const Post      = require('../models/Post');
const Thread    = require('../models/Thread');
const Board     = require('../models/Board');
const markup    = require('../services/markup');
const sourceTag = require('../services/sourceTag');
const ipHash    = require('../services/ipHash');
const media     = require('../services/media');
const counter   = require('../services/counter');
const upload    = require('../middleware/upload');
const captcha   = require('../middleware/captcha');
const { floodCheck } = require('../middleware/rateLimit');
const geoip          = require('../services/geoip');
const CountryFlair   = require('../models/CountryFlair');
const config         = require('../config');

// GET /api/posts/:boardUri/:threadId — all posts in a thread
router.get('/:boardUri/:threadId', async (req, res) => {
  try {
    const posts = await Post.find({
      boardUri: req.params.boardUri,
      threadId: parseInt(req.params.threadId)
    }).sort({ postId: 1 }).lean();

    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:boardUri/:threadId — reply to a thread
router.post('/:boardUri/:threadId', floodCheck('post'), upload, captcha, async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const threadId = parseInt(threadIdStr);

    const [thread, board] = await Promise.all([
      Thread.findOne({ boardUri, threadId }),
      Board.findOne({ uri: boardUri }).select('allowedCountries country minTier').lean()
    ]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.isLocked) return res.status(403).json({ error: 'Thread is locked' });

    // Region lock check
    if (board?.allowedCountries?.length > 0) {
      const rawIpCheck = req.ip || req.connection.remoteAddress;
      const country    = geoip.getCountry(rawIpCheck);
      if (!country || !board.allowedCountries.map(c => c.toUpperCase()).includes(country.toUpperCase())) {
        return res.status(403).json({ error: 'This board is region-locked' });
      }
    }

    const { body, name: rawName } = req.body;
    const name = rawName?.trim().slice(0, 50) || '';
    if (!body?.trim()) return res.status(400).json({ error: 'Body is required' });

    // Process upload if present
    let mediaDoc = null;
    if (req.file) {
      try {
        mediaDoc = await media.processUpload(req.file, boardUri);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Get next globally unique postId
    const postId = await counter.nextId();

    const rawIp = req.ip || req.connection.remoteAddress;
    const ip    = ipHash.hash(rawIp);

    // Flair: g:N = global, v:N = PoliPass variant, none = opt out, else session flair
    let postFlair        = null;
    let postFlairColor   = null;
    let postFlairBgColor = null;

    const flairVal = req.body.flairVariant;
    const tier     = req.session?.poliPassTier || 0;

    if (flairVal === 'none') {
      // user opted out — leave null
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

    // Country flair override — always applied when poster is foreign to the board's home country
    {
      const posterCountry = geoip.getCountry(rawIp);
      const homeCountry = board?.homeCountry
        || (board?.country?.length === 2 ? board.country.toUpperCase() : '');
      if (posterCountry && homeCountry && posterCountry !== homeCountry) {
        const rule = await CountryFlair.findOne({
          fromCountry: posterCountry,
          toCountry:   homeCountry
        }).lean();
        if (rule) {
          postFlair        = rule.label;
          postFlairColor   = rule.color;
          postFlairBgColor = rule.bgColor;
        } else {
          const { toFlag } = geoip;
          postFlair        = `${toFlag(posterCountry)} ${posterCountry}`;
          postFlairColor   = '#e2e8f0';
          postFlairBgColor = '#374151';
        }
      }
    }

    const post = await Post.create({
      boardUri,
      threadId,
      postId,
      name,
      body:      body.trim(),
      bodyHtml:  await markup.process(body.trim()),
      quotes:    markup.extractQuotes(body),
      sourceTag: sourceTag.tag(body),
      media:     mediaDoc,
      ip,
      authorId:     req.session?.accountId || null,
      tripcode:     (req.body.showTripcode === 'true' && req.session?.tripcode) ? req.session.tripcode : null,
      flair:        postFlair,
      flairColor:   postFlairColor,
      flairBgColor: postFlairBgColor,
      isModPost:    req.session?.isAdmin || req.session?.staffRole === 'mod'
    });

    // Check sage
    const isSage = req.body.sage === 'true' || req.body.name?.trim().toLowerCase() === 'sage';
    const hitBumpLimit = thread.replyCount + 1 >= config.threads.bumpLimit;

    const threadUpdate = {
      $inc: { replyCount: 1 },
      lastReplyAt: new Date()
    };

    if (!isSage && !thread.bumpLimit && !hitBumpLimit) {
      threadUpdate.bumpedAt = new Date();
    }

    if (hitBumpLimit && !thread.bumpLimit) {
      threadUpdate.bumpLimit = true;
    }

    await Thread.updateOne({ boardUri, threadId }, threadUpdate);
    await Board.updateOne({ uri: boardUri }, { $inc: { postCount: 1 } });

    req.io.to(`${boardUri}:${threadId}`).emit('new-post', {
      postId:      post.postId,
      threadId:    post.threadId,
      name:        post.name || '',
      bodyHtml:    post.bodyHtml,
      tripcode:    post.tripcode,
      flair:       post.flair,
      flairColor:  post.flairColor   || null,
      flairBgColor: post.flairBgColor || null,
      isModPost:   post.isModPost,
      media:       post.media || null,
      createdAt:   post.createdAt
    });

    res.status(201).json({ postId: post.postId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/find/:id — resolve a global post/thread ID to its location
router.get('/find/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  // Check threads first (OP posts live in Thread collection)
  const thread = await Thread.findOne({ threadId: id })
    .select('boardUri threadId').lean();
  if (thread) {
    return res.json({ boardUri: thread.boardUri, threadId: thread.threadId, postId: id, isOp: true });
  }

  // Check replies
  const post = await Post.findOne({ postId: id })
    .select('boardUri threadId postId').lean();
  if (post) {
    return res.json({ boardUri: post.boardUri, threadId: post.threadId, postId: id, isOp: false });
  }

  res.status(404).json({ error: 'Post not found' });
});

// POST /api/posts/:boardUri/:threadId/report
router.post('/:boardUri/:threadId/report', async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const { postId, reason } = req.body;
    if (!['spam', 'illegal'].includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }
    const Report = require('../models/Report');
    const ip = ipHash.hash(req.ip || req.connection.remoteAddress);
    await Report.create({
      boardUri,
      threadId: parseInt(threadIdStr),
      postId:   postId ? parseInt(postId) : null,
      reason,
      reporterIp: ip
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
