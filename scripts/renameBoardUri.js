'use strict';

// Rename a board's URI in place: updates the Board doc, every Thread/Post
// referencing it, the per-board ID counter, and moves its uploads directory
// on disk so existing image/video links (built client-side as
// /uploads/{boardUri}/{file}) keep resolving under the new slug.
//
// Does NOT rewrite >>>/oldUri/ crosslinks in other boards' post bodies —
// check for those separately if renaming a board that might be referenced
// elsewhere.
//
// Usage: node scripts/renameBoardUri.js [--dry-run]
// Edit the RENAMES list below before running.

const fs      = require('fs');
const path    = require('path');
const mongoose = require('mongoose');
const config  = require('../config');
const Board   = require('../models/Board');
const Thread  = require('../models/Thread');
const Post    = require('../models/Post');

const DRY = process.argv.includes('--dry-run');
const UPLOADS_ROOT = path.join(__dirname, '../public/uploads');

const RENAMES = [
  { from: 'ca-ab-edm', to: 'yeg', homeCountry: 'CA' },
  { from: 'ca-bc-yvr', to: 'yvr', homeCountry: 'CA' },
  { from: 'ca-bc-yyj', to: 'yyj', homeCountry: 'CA' }
];

async function renameCounter(from, to) {
  const Counter = mongoose.model('Counter', new mongoose.Schema({ _id: String, seq: Number }), 'counters');
  const oldDoc = await Counter.findById(`board:${from}`).lean();
  if (!oldDoc) { console.log(`  no counter doc for board:${from}`); return; }
  console.log(`  counter board:${from} (seq ${oldDoc.seq}) -> board:${to}`);
  if (!DRY) {
    await Counter.updateOne({ _id: `board:${to}` }, { $set: { seq: oldDoc.seq } }, { upsert: true });
    await Counter.deleteOne({ _id: `board:${from}` });
  }
}

async function run({ from, to, homeCountry }) {
  console.log(`\n== ${from} -> ${to} ==`);

  const board = await Board.findOne({ uri: from });
  if (!board) { console.log('  board not found, skipping'); return; }

  const clash = await Board.findOne({ uri: to });
  if (clash) { console.log(`  ABORT: a board with uri "${to}" already exists`); return; }

  const threadCount = await Thread.countDocuments({ boardUri: from });
  const postCount   = await Post.countDocuments({ boardUri: from });
  console.log(`  board "${board.name}", ${threadCount} threads, ${postCount} posts`);

  if (!DRY) {
    board.uri = to;
    if (homeCountry) board.homeCountry = homeCountry;
    await board.save(); // triggers pre-save country/region derivation from new uri
  }

  if (!DRY) {
    await Thread.updateMany({ boardUri: from }, { $set: { boardUri: to } });
    await Post.updateMany({ boardUri: from }, { $set: { boardUri: to } });
  }

  await renameCounter(from, to);

  const oldDir = path.join(UPLOADS_ROOT, from);
  const newDir = path.join(UPLOADS_ROOT, to);
  if (fs.existsSync(oldDir)) {
    console.log(`  uploads dir: ${from}/ -> ${to}/`);
    if (!DRY) {
      if (fs.existsSync(newDir)) {
        console.log(`  ABORT: uploads dir ${to}/ already exists`);
      } else {
        fs.renameSync(oldDir, newDir);
      }
    }
  } else {
    console.log('  no uploads dir to move');
  }
}

(async () => {
  await mongoose.connect(config.mongo.uri);
  for (const r of RENAMES) await run(r);
  await mongoose.disconnect();
  console.log(DRY ? '\nDry run complete.' : '\nDone.');
})().catch(err => { console.error(err); process.exit(1); });
