'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const Thread  = require('../models/Thread');
const Post    = require('../models/Post');
const Ban     = require('../models/Ban');
const Report  = require('../models/Report');
const ipHash  = require('../services/ipHash');
const Board   = require('../models/Board');
const { requireMod } = require('../middleware/auth');
const media = require('../services/media');

const UPLOADS_ROOT = path.join(__dirname, '../public/uploads');

// Global staff pass everything; board mods pass only for their own board
// (boardUri comes from the request body on these routes).
function requireBoardScope(req, res, next) {
  const s = req.session;
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  if (s.isAdmin || ['mod', 'janitor'].includes(s.staffRole)) return next();
  const boardUri = req.body.boardUri;
  if (boardUri && (s.boardRoles || []).some(r => r.boardUri === boardUri && ['mod', 'janitor'].includes(r.role))) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// POST /api/mod/delete/thread
router.post('/delete/thread', requireBoardScope, async (req, res) => {
  try {
    const { boardUri } = req.body;
    const threadId = parseInt(req.body.threadId);
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

// POST /api/mod/delete/post
router.post('/delete/post', requireBoardScope, async (req, res) => {
  try {
    const { boardUri } = req.body;
    const postId = parseInt(req.body.postId);
    const post = await Post.findOne({ boardUri, postId }).lean();
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

// POST /api/mod/pin
router.post('/pin', requireBoardScope, async (req, res) => {
  try {
    const { boardUri, threadId, pinned } = req.body;
    await Thread.updateOne({ boardUri, threadId: parseInt(threadId) }, { isPinned: !!pinned });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/lock
router.post('/lock', requireBoardScope, async (req, res) => {
  try {
    const { boardUri, threadId, locked } = req.body;
    await Thread.updateOne({ boardUri, threadId: parseInt(threadId) }, { isLocked: !!locked });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/ban — global staff only
router.post('/ban', requireMod, async (req, res) => {
  try {
    const { boardUri, postId, threadId, reason, durationHours } = req.body;

    // Find IP from the post or thread
    const post = postId
      ? await Post.findOne({ boardUri, postId: parseInt(postId) }).lean()
      : await Thread.findOne({ boardUri, threadId: parseInt(threadId) }).lean();

    if (!post?.ip) return res.status(404).json({ error: 'Post not found' });

    const expiresAt = durationHours
      ? new Date(Date.now() + parseInt(durationHours) * 3600 * 1000)
      : null;

    await Ban.create({
      ip: post.ip,
      reason,
      boardUri: boardUri || null,
      expiresAt,
      createdBy: req.session.accountId
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/move/thread — global staff only (touches two boards)
router.post('/move/thread', requireMod, async (req, res) => {
  try {
    const { boardUri, threadId, targetBoardUri } = req.body;
    if (!boardUri || !threadId || !targetBoardUri)
      return res.status(400).json({ error: 'boardUri, threadId, and targetBoardUri are required' });
    if (boardUri === targetBoardUri)
      return res.status(400).json({ error: 'Source and target boards are the same' });

    const thread = await Thread.findOne({ boardUri, threadId: parseInt(threadId) }).lean();
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const target = await Board.findOne({ uri: targetBoardUri }).lean();
    if (!target) return res.status(404).json({ error: 'Target board not found' });

    const replyCount = thread.replyCount || 0;

    // Collect all media files from thread OP + replies
    const posts = await Post.find({ boardUri, threadId: parseInt(threadId) }).lean();
    const mediaItems = [thread, ...posts]
      .map(d => d.media)
      .filter(Boolean);

    // Move files on disk before updating DB
    const srcDir  = path.join(UPLOADS_ROOT, boardUri);
    const destDir = path.join(UPLOADS_ROOT, targetBoardUri);
    fs.mkdirSync(destDir, { recursive: true });

    for (const m of mediaItems) {
      for (const fname of [m.storedName, m.thumbName].filter(Boolean)) {
        const src  = path.join(srcDir, fname);
        const dest = path.join(destDir, fname);
        if (fs.existsSync(src)) fs.renameSync(src, dest);
      }
    }

    await Thread.updateOne({ boardUri, threadId: parseInt(threadId) }, { boardUri: targetBoardUri });
    await Post.updateMany({ boardUri, threadId: parseInt(threadId) }, { boardUri: targetBoardUri });

    await Board.updateOne({ uri: boardUri },       { $inc: { threadCount: -1, postCount: -replyCount } });
    await Board.updateOne({ uri: targetBoardUri }, { $inc: { threadCount:  1, postCount:  replyCount } });

    // Keep open reports pointing at the thread's new home
    await Report.updateMany(
      { boardUri, threadId: parseInt(threadId), resolved: false },
      { boardUri: targetBoardUri }
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/report/resolve — global staff only
router.post('/report/resolve', requireMod, async (req, res) => {
  try {
    const { reportId } = req.body;
    await Report.updateOne({ _id: reportId }, {
      resolved:   true,
      resolvedBy: req.session.accountId
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
