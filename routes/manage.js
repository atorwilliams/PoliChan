'use strict';

const express  = require('express');
const path     = require('path');
const router   = express.Router();
const Thread   = require('../models/Thread');
const Board    = require('../models/Board');
const counter  = require('../services/counter');
const markup   = require('../services/markup');
const ipHash   = require('../services/ipHash');
const { requireBoardMod } = require('../middleware/auth');

// Helper: check if session has board-mod access to a given boardUri
function hasBoardAccess(session, boardUri) {
  if (!session) return false;
  if (session.isAdmin) return true;
  if (['mod', 'janitor'].includes(session.staffRole)) return true;
  return (session.boardRoles || []).some(
    r => r.boardUri === boardUri && ['mod', 'janitor'].includes(r.role)
  );
}

// ── API routes (must come before page catch-all) ──────────────────────────────

// GET /api/manage/:boardUri — session + board info for the panel
router.get('/api/:boardUri', requireBoardMod, async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.boardUri }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const role = req.session.isAdmin ? 'admin'
      : (req.session.staffRole || (req.session.boardRoles || []).find(r => r.boardUri === req.params.boardUri)?.role || null);

    res.json({
      board:   { uri: board.uri, name: board.name },
      session: {
        accountId: req.session.accountId,
        role,
        isAdmin:   req.session.isAdmin || false
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manage/:boardUri/polls — list threads with polls on this board
router.get('/api/:boardUri/polls', requireBoardMod, async (req, res) => {
  try {
    const threads = await Thread.find({ boardUri: req.params.boardUri, poll: { $ne: null } })
      .select('threadId subject poll isPinned isLocked createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ polls: threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manage/:boardUri/polls — create a new poll (creates a pinned thread)
router.post('/api/:boardUri/polls', requireBoardMod, async (req, res) => {
  try {
    const { boardUri } = req.params;
    const { question, options, closesAt } = req.body;

    if (!question?.trim()) return res.status(400).json({ error: 'question required' });
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
      return res.status(400).json({ error: '2–6 options required' });
    }

    const board = await Board.findOne({ uri: boardUri });
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const threadId = await counter.nextId();
    const ip       = ipHash.hash(req.ip || req.connection.remoteAddress);
    const bodyText = question.trim();

    const thread = await Thread.create({
      boardUri,
      threadId,
      subject:   question.trim(),
      body:      bodyText,
      bodyHtml:  await markup.process(bodyText),
      ip,
      bumpedAt:  new Date(),
      isPinned:  true,
      isModPost: true,
      authorId:  req.session?.accountId || null,
      poll: {
        question: question.trim(),
        options:  options.map(o => ({ text: String(o).trim(), votes: 0 })),
        voters:   [],
        closesAt: closesAt ? new Date(closesAt) : null
      }
    });

    await Board.updateOne({ uri: boardUri }, { $inc: { threadCount: 1 } });

    res.status(201).json({ threadId: thread.threadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/manage/:boardUri/polls/:threadId — close (lock) or delete a poll thread
router.delete('/api/:boardUri/polls/:threadId', requireBoardMod, async (req, res) => {
  try {
    const { boardUri } = req.params;
    const threadId = parseInt(req.params.threadId);
    const { action } = req.body;  // 'close' | 'delete'

    if (action === 'delete') {
      await Thread.deleteOne({ boardUri, threadId });
      await Board.updateOne({ uri: boardUri }, { $inc: { threadCount: -1 } });
    } else {
      // Default: close the poll (lock thread, keep results)
      await Thread.updateOne({ boardUri, threadId }, { isLocked: true });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/manage/:boardUri/polls/:threadId/export.json — download poll results
router.get('/api/:boardUri/polls/:threadId/export.json', requireBoardMod, async (req, res) => {
  try {
    const { boardUri } = req.params;
    const threadId = parseInt(req.params.threadId);

    const thread = await Thread.findOne({ boardUri, threadId })
      .select('threadId subject poll createdAt').lean();
    if (!thread?.poll) return res.status(404).json({ error: 'Poll not found' });

    const total = thread.poll.options.reduce((s, o) => s + o.votes, 0);
    const payload = {
      boardUri,
      threadId:   thread.threadId,
      subject:    thread.subject || '',
      question:   thread.poll.question,
      closesAt:   thread.poll.closesAt || null,
      totalVotes: total,
      options:    thread.poll.options.map(o => ({
        text:  o.text,
        votes: o.votes,
        pct:   total > 0 ? +((o.votes / total) * 100).toFixed(1) : 0
      })),
      exportedAt: new Date().toISOString()
    };

    const filename = `poll-${boardUri}-${threadId}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Page (must come last — catch-all for /:boardUri) ─────────────────────────

// GET /manage/:boardUri — serve the manage panel (auth gated server-side)
router.get('/:boardUri', (req, res) => {
  if (!hasBoardAccess(req.session, req.params.boardUri)) {
    return res.status(403).sendFile(path.join(__dirname, '../views/manage/403.html'));
  }
  res.sendFile(path.join(__dirname, '../views/manage/index.html'));
});

module.exports = router;
