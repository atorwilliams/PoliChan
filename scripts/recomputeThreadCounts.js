'use strict';

// One-off fix for board.threadCount drift caused by the pruneBoard() archive
// branch never decrementing it (see routes/threads.js). Run once after
// deploying that fix to bring existing boards' counts back in line with
// reality: node scripts/recomputeThreadCounts.js

const mongoose = require('mongoose');
const config   = require('../config');
const Board    = require('../models/Board');
const Thread   = require('../models/Thread');

async function main() {
  await mongoose.connect(config.mongo.uri);
  console.log(`Connected: ${config.mongo.uri}`);

  const boards = await Board.find().select('uri threadCount').lean();
  let changed = 0;

  for (const board of boards) {
    const actual = await Thread.countDocuments({ boardUri: board.uri, isArchived: false });
    if (actual !== board.threadCount) {
      await Board.updateOne({ _id: board._id }, { $set: { threadCount: actual } });
      console.log(`/${board.uri}/: ${board.threadCount} -> ${actual}`);
      changed++;
    }
  }

  console.log(`Done. ${changed} of ${boards.length} boards corrected.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
