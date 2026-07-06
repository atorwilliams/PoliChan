'use strict';

const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  boardUri:   { type: String, required: true, index: true },
  threadId:   { type: Number, required: true },
  postId:     { type: Number, required: true },  // sequential per board (shared with threadIds)
  // Empty for image-only replies (threads always have a body)
  body:       { type: String, default: '', maxlength: 5000 },
  bodyHtml:   { type: String },                  // processed markup, cached
  name:       { type: String, default: '' },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  tripcode:   { type: String, default: null },
  flair:      { type: String, default: null },
  flairColor:  { type: String, default: null },
  flairBgColor: { type: String, default: null },
  media: {
    originalName: String,
    storedName:   String,
    thumbName:    String,
    type:         { type: String, enum: ['image', 'webm', 'mp4'] },
    size:         Number,
    width:        Number,
    height:       Number
  },
  sourceTag: {
    domain: String,
    tier:   Number
  },
  quotes:     [Number],     // postIds this reply quotes (>>123)
  // Soft removal: content stays in the DB for the record, but the public API
  // serves a stub with the reason instead of the body/media.
  isRemoved:     { type: Boolean, default: false },
  removedReason: { type: String, default: null },
  isModPost:  { type: Boolean, default: false },
  ip:         { type: String }  // HMAC-SHA256 hashed
}, { timestamps: true });

postSchema.index({ boardUri: 1, threadId: 1 });
postSchema.index({ boardUri: 1, postId: 1 }, { unique: true });

module.exports = mongoose.model('Post', postSchema);
