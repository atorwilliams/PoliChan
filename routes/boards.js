'use strict';

const express = require('express');
const router  = express.Router();
const Board   = require('../models/Board');

// GET /api/boards — full board list grouped by root board
router.get('/', async (req, res) => {
  try {
    const tier   = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    const boards = await Board.find({ isListed: true }).sort({ uri: 1 }).lean();
    const visible = isAdmin ? boards : boards.filter(b => (b.minTier || 0) <= tier);

    // Build URI lookup for parent traversal
    const byUri = {};
    for (const b of boards) byUri[b.uri] = b;

    // Walk up parentUri chain to find the root board's URI
    function rootUri(board, depth = 0) {
      if (depth > 10 || !board.parentUri) return board.uri;
      const parent = byUri[board.parentUri];
      if (!parent) return board.parentUri; // parent not in list
      return rootUri(parent, depth + 1);
    }

    const grouped = {};
    for (const board of visible) {
      const key = rootUri(board);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(board);
    }

    res.json({ boards: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/boards/:uri — single board info
router.get('/:uri', async (req, res) => {
  try {
    const board = await Board.findOne({ uri: req.params.uri }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;
    if (!isAdmin && (board.minTier || 0) > tier) {
      return res.status(403).json({ error: 'A higher-tier PoliPass is required to access this board' });
    }
    res.json({ board });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
