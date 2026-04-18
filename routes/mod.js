'use strict';

const express = require('express');
const router  = express.Router();
const Thread  = require('../models/Thread');
const Post    = require('../models/Post');
const Ban     = require('../models/Ban');
const Report  = require('../models/Report');
const ipHash  = require('../services/ipHash');
const { requireMod } = require('../middleware/auth');

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
