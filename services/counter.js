'use strict';

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.model('Counter', counterSchema);

// Counter docs are keyed "board:<uri>" so a board named "global" can never
// collide with the legacy site-wide counter doc (_id: 'global').
function key(boardUri) {
  return `board:${boardUri}`;
}

/**
 * Atomically increment and return the next post/thread ID for a board.
 * Threads and posts share one sequence per board, so every number on a
 * given board is unique — but numbering is independent between boards.
 */
async function nextId(boardUri) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key(boardUri) },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return doc.seq;
}

/**
 * On startup: sync each board's counter to max(existing threadIds, postIds)
 * on that board so it never collides with IDs created before the counter
 * existed. Safe to call every boot — a no-op if counters are already ahead.
 */
async function sync() {
  const Thread = mongoose.model('Thread');
  const Post   = mongoose.model('Post');

  const [threadMax, postMax] = await Promise.all([
    Thread.aggregate([{ $group: { _id: '$boardUri', max: { $max: '$threadId' } } }]),
    Post.aggregate([{ $group: { _id: '$boardUri', max: { $max: '$postId' } } }])
  ]);

  const maxByBoard = {};
  for (const { _id, max } of [...threadMax, ...postMax]) {
    maxByBoard[_id] = Math.max(maxByBoard[_id] || 0, max || 0);
  }

  for (const [boardUri, maxExisting] of Object.entries(maxByBoard)) {
    const res = await Counter.updateOne(
      { _id: key(boardUri), seq: { $lt: maxExisting } },
      { $set: { seq: maxExisting } },
      { upsert: true }
    ).catch(err => {
      // Upsert race with an existing doc whose seq is already ahead — fine.
      if (err.code === 11000) return null;
      throw err;
    });
    if (res?.modifiedCount || res?.upsertedCount) {
      console.log(`[counter] /${boardUri}/ synced to ${maxExisting}`);
    }
  }

  // Retire the legacy site-wide counter if it is still around.
  await Counter.deleteOne({ _id: 'global' });
}

/**
 * Reset all board counters so post numbering restarts at 1 everywhere.
 * Only safe when all threads and posts have been deleted (soft reset).
 */
async function reset() {
  await Counter.deleteMany({ _id: /^board:/ });
}

module.exports = { nextId, sync, reset };
