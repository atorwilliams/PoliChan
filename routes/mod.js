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

const UPLOADS_ROOT = path.join(__dirname, '../public/uploads');

router.use(requireMod);

// POST /api/mod/delete/thread
router.post('/delete/thread', async (req, res) => {
  try {
    const { boardUri, threadId } = req.body;
    await Thread.deleteOne({ boardUri, threadId: parseInt(threadId) });
    await Post.deleteMany({ boardUri, threadId: parseInt(threadId) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/delete/post
router.post('/delete/post', async (req, res) => {
  try {
    const { boardUri, postId } = req.body;
    await Post.deleteOne({ boardUri, postId: parseInt(postId) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/pin
router.post('/pin', async (req, res) => {
  try {
    const { boardUri, threadId, pinned } = req.body;
    await Thread.updateOne({ boardUri, threadId: parseInt(threadId) }, { isPinned: !!pinned });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/lock
router.post('/lock', async (req, res) => {
  try {
    const { boardUri, threadId, locked } = req.body;
    await Thread.updateOne({ boardUri, threadId: parseInt(threadId) }, { isLocked: !!locked });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mod/ban
router.post('/ban', async (req, res) => {
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

// POST /api/mod/move/thread
router.post('/move/thread', async (req, res) => {
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

// POST /api/mod/report/resolve
router.post('/report/resolve', async (req, res) => {
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
