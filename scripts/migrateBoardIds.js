'use strict';

// One-off migration: switch from site-wide post numbering to per-board
// numbering. Renumbers every thread and post on each board to a dense
// 1..N sequence (in original posting order), rewrites >>N quote references
// in post bodies to the new numbers, regenerates cached bodyHtml, remaps
// report references, and seeds the per-board counters.
//
// Run once after deploying the per-board counter change, with the server
// stopped (or during quiet hours): node scripts/migrateBoardIds.js
//
// Old IDs were globally unique, so this is safe to run on live data: new
// IDs are assigned in ascending old-ID order and are always <= the old ID,
// which means the unique (boardUri, id) indexes can never collide mid-run.

const mongoose = require('mongoose');
const config   = require('../config');
const Thread   = require('../models/Thread');
const Post     = require('../models/Post');
const Report   = require('../models/Report');
const markup   = require('../services/markup');

function rewriteQuotes(body, map) {
  let changed = false;
  const out = body.replace(/>>(\d+)/g, (m, d) => {
    const to = map.get(parseInt(d));
    if (to === undefined) return m;   // cross-board or deleted target: leave as-is
    changed = true;
    return '>>' + to;
  });
  return { out, changed };
}

async function migrateBoard(boardUri) {
  const threads = await Thread.find({ boardUri }).lean();
  const posts   = await Post.find({ boardUri }).lean();

  // Threads and posts share one number space; renumber in posting order.
  const items = [
    ...threads.map(t => ({ kind: 'thread', old: t.threadId, doc: t })),
    ...posts.map(p => ({ kind: 'post', old: p.postId, doc: p }))
  ].sort((a, b) => a.old - b.old);

  const map = new Map();  // old id -> new id
  items.forEach((item, i) => map.set(item.old, i + 1));

  let bodiesRewritten = 0;
  const deadQuotes = [];

  for (const item of items) {
    const newId = map.get(item.old);

    // Rewrite >>N references in the body and refresh the cached HTML
    const body = item.doc.body || '';
    const { out: newBody, changed } = rewriteQuotes(body, map);
    for (const m of body.matchAll(/>>(\d+)/g)) {
      if (!map.has(parseInt(m[1]))) deadQuotes.push(`${boardUri}/${item.old} -> >>${m[1]}`);
    }

    if (item.kind === 'thread') {
      const set = { threadId: newId };
      if (changed) {
        set.body     = newBody;
        set.bodyHtml = await markup.process(newBody);
        bodiesRewritten++;
      }
      await Thread.updateOne({ _id: item.doc._id }, { $set: set });
    } else {
      const set = {
        postId:   newId,
        threadId: map.get(item.doc.threadId) ?? item.doc.threadId,
        quotes:   (item.doc.quotes || []).map(q => map.get(q)).filter(q => q !== undefined)
      };
      if (changed) {
        set.body     = newBody;
        set.bodyHtml = newBody ? await markup.process(newBody) : '';
        bodiesRewritten++;
      }
      await Post.updateOne({ _id: item.doc._id }, { $set: set });
    }
  }

  // Remap report references (old -> new is unambiguous within the board)
  const reports = await Report.find({ boardUri }).lean();
  for (const r of reports) {
    const set = {};
    if (map.has(r.threadId)) set.threadId = map.get(r.threadId);
    if (r.postId !== null && map.has(r.postId)) set.postId = map.get(r.postId);
    if (Object.keys(set).length) await Report.updateOne({ _id: r._id }, { $set: set });
  }

  // Seed this board's counter at the last assigned ID
  await mongoose.connection.collection('counters').updateOne(
    { _id: `board:${boardUri}` },
    { $set: { seq: items.length } },
    { upsert: true }
  );

  return { count: items.length, bodiesRewritten, deadQuotes };
}

async function main() {
  await mongoose.connect(config.mongo.uri);
  console.log(`Connected: ${config.mongo.uri}`);

  const boardUris = new Set([
    ...await Thread.distinct('boardUri'),
    ...await Post.distinct('boardUri')
  ]);

  for (const uri of [...boardUris].sort()) {
    const { count, bodiesRewritten, deadQuotes } = await migrateBoard(uri);
    console.log(`/${uri}/: renumbered ${count} items, rewrote ${bodiesRewritten} bodies`);
    for (const dq of deadQuotes) console.log(`  unresolved quote (left as-is): ${dq}`);
  }

  // Retire the legacy site-wide counter
  await mongoose.connection.collection('counters').deleteOne({ _id: 'global' });

  console.log('Done.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
