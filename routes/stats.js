'use strict';

const express = require('express');
const router  = express.Router();
const Board   = require('../models/Board');
const Thread  = require('../models/Thread');
const Post    = require('../models/Post');

// GET /api/stats — site-wide aggregate stats for the home page blurb
router.get('/', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [boards, oldestThread, oldestPost, postsLast24h, threadsLast24h] = await Promise.all([
      Board.find({ isListed: true }, 'uri name postCount threadCount').lean(),
      Thread.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
      Post.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
      Post.countDocuments({ createdAt: { $gte: cutoff } }),
      Thread.countDocuments({ createdAt: { $gte: cutoff } }),
    ]);

    const totalPosts   = boards.reduce((sum, b) => sum + (b.postCount || 0), 0);
    const totalThreads = boards.reduce((sum, b) => sum + (b.threadCount || 0), 0);

    const busiestBoard = boards.reduce((best, b) =>
      (!best || (b.postCount || 0) > (best.postCount || 0)) ? b : best, null);

    const candidateDates = [oldestThread?.createdAt, oldestPost?.createdAt].filter(Boolean);
    const launchDate = candidateDates.length
      ? new Date(Math.min(...candidateDates.map(d => new Date(d).getTime())))
      : null;

    res.json({
      totalPosts,
      totalThreads,
      postsLast24h: postsLast24h + threadsLast24h,
      launchDate,
      busiestBoard: busiestBoard ? { uri: busiestBoard.uri, name: busiestBoard.name, postCount: busiestBoard.postCount || 0 } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
