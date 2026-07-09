'use strict';

// Regenerate bodyHtml from the raw body for every thread/post the word
// filter has touched. Run after changing filter behaviour (e.g. the
// URL/quotelink skip guard) to heal posts whose links were corrupted.
// Raw bodies are stored unfiltered, so this is a pure recompute: entries
// whose output is unchanged are left alone.
//
// Usage: node scripts/regenFilteredBodies.js [--dry-run]

const mongoose = require('mongoose');
const config   = require('../config');
const Thread   = require('../models/Thread');
const Post     = require('../models/Post');
const markup   = require('../services/markup');

const DRY = process.argv.includes('--dry-run');

async function regen(Model, label) {
  const docs = await Model.find({ bodyHtml: /word-filtered/ })
    .select('boardUri threadId postId body bodyHtml').lean();

  let changed = 0;
  for (const doc of docs) {
    const fresh = await markup.process(doc.body || '');
    if (fresh === doc.bodyHtml) continue;
    changed++;
    const id = doc.postId ?? doc.threadId;
    console.log(`  /${doc.boardUri}/ ${label} ${id}`);
    if (!DRY) await Model.updateOne({ _id: doc._id }, { bodyHtml: fresh });
  }
  console.log(`${label}s: ${docs.length} filtered, ${changed} ${DRY ? 'would change' : 'updated'}`);
}

(async () => {
  await mongoose.connect(config.mongo.uri);
  await regen(Thread, 'thread');
  await regen(Post, 'post');
  await mongoose.disconnect();
  console.log(DRY ? 'Dry run complete.' : 'Done.');
})().catch(err => { console.error(err); process.exit(1); });
