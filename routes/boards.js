'use strict';

const express  = require('express');
const router   = express.Router();
const Board    = require('../models/Board');
const Category = require('../models/Category');

// GET /api/boards — boards grouped by explicit category, nested by parentUri
router.get('/', async (req, res) => {
  try {
    const tier    = req.session?.poliPassTier || 0;
    const isAdmin = req.session?.isAdmin || false;

    const [categories, allBoards] = await Promise.all([
      Category.find().sort({ order: 1, name: 1 }).lean(),
      Board.find({ isListed: true }).sort({ uri: 1 }).lean()
    ]);

    const visible = isAdmin ? allBoards : allBoards.filter(b => (b.minTier || 0) <= tier);

    // Build children map keyed by parentUri, sorted alphabetically
    const childrenOf = {};
    for (const b of visible) {
      if (b.parentUri) {
        if (!childrenOf[b.parentUri]) childrenOf[b.parentUri] = [];
        childrenOf[b.parentUri].push(b);
      }
    }
    for (const key of Object.keys(childrenOf)) {
      childrenOf[key].sort((a, b) => a.uri.localeCompare(b.uri));
    }

    function buildTree(board) {
      return {
        uri:         board.uri,
        name:        board.name,
        threadCount: board.threadCount || 0,
        postCount:   board.postCount   || 0,
        minTier:     board.minTier     || 0,
        children:    (childrenOf[board.uri] || []).map(buildTree)
      };
    }

    const result = [];
    for (const cat of categories) {
      const topLevel = visible
        .filter(b => b.categorySlug === cat.slug && !b.parentUri)
        .sort((a, b) => a.uri.localeCompare(b.uri));

      if (!topLevel.length) continue;

      result.push({
        slug:  cat.slug,
        name:  cat.name,
        type:  cat.type,
        order: cat.order,
        boards: topLevel.map(buildTree)
      });
    }

    res.json({ categories: result });
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
