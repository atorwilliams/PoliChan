'use strict';

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.model('Counter', counterSchema);

/**
 * Atomically increment and return the next global post ID.
 * Shared across threads and posts so every number on the site is unique.
 */
async function nextId() {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'global' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return doc.seq;
}

/**
 * On startup: sync the counter to max(existing threadIds, postIds) so it
 * never collides with IDs that were created before the counter existed.
 * Safe to call every boot — a no-op if counter is already ahead.
 */
async function sync() {
  const Thread = mongoose.model('Thread');
  const Post   = mongoose.model('Post');

  const [lastThread, lastPost, existing] = await Promise.all([
    Thread.findOne().sort({ threadId: -1 }).select('threadId').lean(),
    Post.findOne().sort({ postId: -1 }).select('postId').lean(),
    Counter.findOne({ _id: 'global' }).lean()
  ]);

  const maxExisting = Math.max(
    lastThread?.threadId || 0,
    lastPost?.postId    || 0
  );
  const currentSeq = existing?.seq || 0;

  if (maxExisting > currentSeq) {
    await Counter.findOneAndUpdate(
      { _id: 'global', seq: { $lt: maxExisting } },
      { $set: { seq: maxExisting } },
      { upsert: true }
    );
    console.log(`[counter] synced to ${maxExisting}`);
  }
}

module.exports = { nextId, sync };
