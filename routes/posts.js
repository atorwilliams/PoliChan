'use strict';

const express   = require('express');
const router    = express.Router();
const Post      = require('../models/Post');
const Thread    = require('../models/Thread');
const Board     = require('../models/Board');
const markup    = require('../services/markup');
const sourceTag = require('../services/sourceTag');
const ipHash    = require('../services/ipHash');
const counter   = require('../services/counter');
const upload    = require('../middleware/upload');
const captcha   = require('../middleware/captcha');
const { floodCheck } = require('../middleware/rateLimit');
const config         = require('../config');
const removal        = require('../services/removal');
const posterIds      = require('../services/posterId');
const postBuilder    = require('../services/postBuilder');

// GET /api/posts/find/:boardUri/:id — resolve a board-local post/thread ID
// to its thread. IDs are per-board, so the board is required context.
// MUST be defined before /:boardUri/:threadId to avoid being shadowed
router.get('/find/:boardUri/:id', async (req, res) => {
  const boardUri = req.params.boardUri;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const thread = await Thread.findOne({ boardUri, threadId: id })
    .select('boardUri threadId').lean();
  if (thread) {
    return res.json({ boardUri, threadId: thread.threadId, postId: id, isOp: true });
  }

  const post = await Post.findOne({ boardUri, postId: id })
    .select('boardUri threadId postId').lean();
  if (post) {
    return res.json({ boardUri, threadId: post.threadId, postId: id, isOp: false });
  }

  res.status(404).json({ error: 'Post not found' });
});

// GET /api/posts/:boardUri/:threadId — all posts in a thread
router.get('/:boardUri/:threadId', async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri }).select('minTier').lean();
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    if (board && !isAdmin && (board.minTier || 0) > tier) {
      return res.status(403).json({ error: 'A higher-tier PoliPass is required to access this board' });
    }

    const posts = await Post.find({
      boardUri: req.params.boardUri,
      threadId: parseInt(req.params.threadId)
    }).sort({ postId: 1 }).lean();

    // Staff see removed posts in full; everyone else gets a stub that keeps
    // the post's place in the thread but explains why the content is gone.
    const isStaff = removal.isStaffSession(req.session);
    const visible = isStaff ? posts : posts.map(p => p.isRemoved ? removal.stubPost(p) : p);

    // Never expose the ip hash (it correlates a poster site-wide);
    // serve the per-thread posterId instead.
    res.json({ posts: visible.map(p => posterIds.withPosterId(p, req.params.boardUri, p.threadId)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/posts/:boardUri/:threadId — reply to a thread
router.post('/:boardUri/:threadId', floodCheck('post'), upload, captcha, postBuilder.handle(async (req, res) => {
  const { boardUri, threadId: threadIdStr } = req.params;
  const threadId = parseInt(threadIdStr);

  const [thread, board] = await Promise.all([
    Thread.findOne({ boardUri, threadId }),
    Board.findOne({ uri: boardUri }).lean()
  ]);
  if (!thread || !board) return res.status(404).json({ error: 'Thread not found' });
  if (thread.isLocked) return res.status(403).json({ error: 'Thread is locked' });

  await postBuilder.checkAccess(req, board);

  // Replies may be image-only; threads still require both.
  const text = req.body.body?.trim() || '';
  if (!text && !req.file) return res.status(400).json({ error: 'A comment or an image is required' });
  if (text.length > 5000) return res.status(400).json({ error: 'Body must be 5000 characters or fewer' });

  const mediaDoc = await postBuilder.processMedia(req, boardUri);
  const postId   = await counter.nextId(boardUri);
  const author   = await postBuilder.authorFields(req, board);

  const post = await Post.create({
    boardUri,
    threadId,
    postId,
    body:      text,
    bodyHtml:  text ? await markup.process(text) : '',
    quotes:    markup.extractQuotes(text),
    sourceTag: sourceTag.tag(text),
    media:     mediaDoc,
    ...author
  });

  // Check sage
  const isSage = req.body.sage === 'true' || author.name.toLowerCase() === 'sage';
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

  const pub = posterIds.withPosterId(post.toObject(), boardUri, threadId);
  req.io.to(`${boardUri}:${threadId}`).emit('new-post', {
    postId:       pub.postId,
    threadId:     pub.threadId,
    name:         pub.name || '',
    bodyHtml:     pub.bodyHtml,
    tripcode:     pub.tripcode,
    flair:        pub.flair,
    flairColor:   pub.flairColor   || null,
    flairBgColor: pub.flairBgColor || null,
    isModPost:    pub.isModPost,
    media:        pub.media || null,
    quotes:       pub.quotes || [],
    posterId:     pub.posterId,
    createdAt:    pub.createdAt
  });

  res.status(201).json({ postId: post.postId });
}));

// POST /api/posts/:boardUri/:threadId/report
router.post('/:boardUri/:threadId/report', async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const { postId, reason } = req.body;
    if (!['spam', 'illegal', 'offtopic'].includes(reason)) {
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
