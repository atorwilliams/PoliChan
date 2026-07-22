'use strict';

// Regenerate bodyHtml for every thread/post containing a YouTube link, so
// existing posts pick up the current embed markup (see services/markup.js)
// instead of whatever the previous format was. Raw bodies are unaffected —
// this only recomputes the cached bodyHtml.
//
// Usage: node scripts/regenYoutubeEmbeds.js [--dry-run]

const mongoose = require('mongoose');
const config   = require('../config');
const Thread   = require('../models/Thread');
const Post     = require('../models/Post');
const markup   = require('../services/markup');

const DRY = process.argv.includes('--dry-run');
const YT_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[A-Za-z0-9_-]{11}/;

async function regen(Model, label) {
  const docs = await Model.find({ body: YT_RE }).select('boardUri threadId postId body bodyHtml').lean();

  let changed = 0;
  for (const doc of docs) {
    const fresh = await markup.process(doc.body || '');
    if (fresh === doc.bodyHtml) continue;
    changed++;
    const id = doc.postId ?? doc.threadId;
    console.log(`  /${doc.boardUri}/ ${label} ${id}`);
    if (!DRY) await Model.updateOne({ _id: doc._id }, { bodyHtml: fresh });
  }
  console.log(`${label}s: ${docs.length} with YouTube links, ${changed} ${DRY ? 'would change' : 'updated'}`);
}

(async () => {
  await mongoose.connect(config.mongo.uri);
  await regen(Thread, 'thread');
  await regen(Post, 'post');
  await mongoose.disconnect();
  console.log(DRY ? 'Dry run complete.' : 'Done.');
})().catch(err => { console.error(err); process.exit(1); });
