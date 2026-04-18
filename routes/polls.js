'use strict';

const express = require('express');
const router  = express.Router();
const Thread  = require('../models/Thread');
const ipHash  = require('../services/ipHash');

// POST /api/polls/:boardUri/:threadId/vote
router.post('/:boardUri/:threadId/vote', async (req, res) => {
  try {
    const { boardUri, threadId: threadIdStr } = req.params;
    const { optionIndex } = req.body;
    const threadId = parseInt(threadIdStr);

    const thread = await Thread.findOne({ boardUri, threadId });
    if (!thread?.poll) return res.status(404).json({ error: 'No poll on this thread' });
    if (thread.poll.closesAt && thread.poll.closesAt < new Date()) {
      return res.status(403).json({ error: 'Poll is closed' });
    }

    const ip = ipHash.hash(req.ip || req.connection.remoteAddress);
    if (thread.poll.voters.includes(ip)) {
      return res.status(403).json({ error: 'Already voted' });
    }

    const idx = parseInt(optionIndex);
    if (idx < 0 || idx >= thread.poll.options.length) {
      return res.status(400).json({ error: 'Invalid option' });
    }

    thread.poll.options[idx].votes += 1;
    thread.poll.voters.push(ip);
    await thread.save();

    res.json({ options: thread.poll.options });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
