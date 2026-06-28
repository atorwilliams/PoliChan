'use strict';

const mongoose = require('mongoose');

// One row per (date, ipHash, scope) -- scope is 'site' for any page load, or a
// board URI for a board view. The unique index makes recording idempotent: the
// same visitor hitting the same scope twice in a day just hits a duplicate-key
// error, which callers swallow. Growth is bounded by unique visitors x scopes
// touched per day, not by request volume.
const visitSchema = new mongoose.Schema({
  date:   { type: String, required: true }, // YYYY-MM-DD, UTC
  ipHash: { type: String, required: true }, // HMAC-SHA256, same scheme as Post.ip
  scope:  { type: String, required: true }  // 'site' or a board uri
}, { timestamps: true });

visitSchema.index({ date: 1, ipHash: 1, scope: 1 }, { unique: true });
visitSchema.index({ date: 1, scope: 1 });

module.exports = mongoose.model('Visit', visitSchema);
