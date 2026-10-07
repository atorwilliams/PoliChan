'use strict';

const express   = require('express');
const router    = express.Router();
const Thread    = require('../models/Thread');
const Post      = require('../models/Post');
const Board     = require('../models/Board');
const markup    = require('../services/markup');
const sourceTag = require('../services/sourceTag');
const counter   = require('../services/counter');
const analytics = require('../services/analytics');
const upload    = require('../middleware/upload');
const captcha   = require('../middleware/captcha');
const { floodCheck } = require('../middleware/rateLimit');
const config       = require('../config');
const removal      = require('../services/removal');
const posterIds    = require('../services/posterId');
const postBuilder  = require('../services/postBuilder');

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

    analytics.recordVisit(req, 'site');
    analytics.recordVisit(req, req.params.boardUri);

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
      const isStaff = removal.isStaffSession(req.session);
      const byThread = {};
      for (const p of allPosts) {
        if (!byThread[p.threadId]) byThread[p.threadId] = [];
        byThread[p.threadId].push(p.isRemoved && !isStaff ? removal.stubPost(p) : p);
      }
      for (const t of threads) {
        t.lastPosts = (byThread[t.threadId] || []).slice(0, preview);
      }
    }

    // Strip ip hashes, attach per-thread poster IDs
    const pub = threads.map(t => {
      const scrubbed = posterIds.withPosterId(t, req.params.boardUri, t.threadId);
      if (scrubbed.lastPosts) {
        scrubbed.lastPosts = scrubbed.lastPosts.map(p => posterIds.withPosterId(p, req.params.boardUri, p.threadId));
      }
      return scrubbed;
    });

    res.json({ board, threads: pub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/:boardUri/archive — archived threads, paginated
router.get('/:boardUri/archive', async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    if (!isAdmin && (board.minTier || 0) > tier) {
      return res.status(403).json({ error: 'A higher-tier PoliPass is required to access this board' });
    }

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const skip  = (page - 1) * limit;

    const [threads, total] = await Promise.all([
      Thread.find({ boardUri: req.params.boardUri, isArchived: true })
        .sort({ bumpedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Thread.countDocuments({ boardUri: req.params.boardUri, isArchived: true })
    ]);

    res.json({
      board,
      threads: threads.map(t => posterIds.withPosterId(t, req.params.boardUri, t.threadId)),
      total, page, pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/:boardUri/:threadId — single thread with posts
router.get('/:boardUri/:threadId', async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri }).select('minTier').lean();
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    if (board && !isAdmin && (board.minTier || 0) > tier) {
      return res.status(403).json({ error: 'A higher-tier PoliPass is required to access this board' });
    }

    const thread = await Thread.findOne({
      boardUri: req.params.boardUri,
      threadId: parseInt(req.params.threadId)
    }).lean();

    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread: posterIds.withPosterId(thread, req.params.boardUri, thread.threadId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/threads/:boardUri — create thread
router.post('/:boardUri', floodCheck('thread'), upload, captcha, postBuilder.handle(async (req, res) => {
  const board = await Board.findOne({ uri: req.params.boardUri });
  if (!board) return res.status(404).json({ error: 'Board not found' });

  await postBuilder.checkAccess(req, board);

  const { subject, body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Body is required' });
  if (body.length > 5000) return res.status(400).json({ error: 'Body must be 5000 characters or fewer' });
  if (!req.file) return res.status(400).json({ error: 'An image or file is required to start a thread' });

  const mediaDoc = await postBuilder.processMedia(req, board.uri);
  const threadId = await counter.nextId(board.uri);
  const author   = await postBuilder.authorFields(req, board);

  const thread = await Thread.create({
    boardUri: board.uri,
    threadId,
    subject:  subject?.trim() || '',
    body:     body.trim(),
    bodyHtml: await markup.process(body.trim()),
    sourceTag: sourceTag.tag(body),
    media:    mediaDoc,
    bumpedAt: new Date(),
    ...author
  });

  await Board.updateOne({ uri: board.uri }, { $inc: { threadCount: 1 } });

  // Prune oldest thread if over cap
  await pruneBoard(board);

  req.io.to(board.uri).emit('new-thread', { threadId: thread.threadId });
  res.status(201).json({ threadId: thread.threadId });
}));

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
  }
  await Board.updateOne({ uri: board.uri }, { $inc: { threadCount: -1 } });
}

module.exports = router;
