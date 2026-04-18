'use strict';

const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
  originalName: String,
  storedName:   String,  // uuid.ext
  thumbName:    String,
  type:         { type: String, enum: ['image', 'webm', 'mp4'] },
  size:         Number,
  width:        Number,
  height:       Number
}, { _id: false });

const pollSchema = new mongoose.Schema({
  question:  String,
  options:   [{ text: String, votes: { type: Number, default: 0 } }],
  voters:    [String],   // hashed IPs that have voted
  closesAt:  Date
}, { _id: false });

const sourceTagSchema = new mongoose.Schema({
  domain: String,
  tier:   { type: Number, min: 1, max: 4 }
}, { _id: false });

const threadSchema = new mongoose.Schema({
  boardUri:    { type: String, required: true, index: true },
  threadId:    { type: Number, required: true },  // sequential per board
  subject:     { type: String, default: '' },
  body:        { type: String, required: true },
  bodyHtml:    { type: String },                  // processed markup, cached
  name:        { type: String, default: '' },
  authorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  tripcode:    { type: String, default: null },
  flair:       { type: String, default: null },
  flairColor:  { type: String, default: null },
  flairBgColor: { type: String, default: null },
  media:       { type: mediaSchema, default: null },
  poll:        { type: pollSchema,  default: null },
  sourceTag:   { type: sourceTagSchema, default: null },
  isModPost:   { type: Boolean, default: false },
  isPinned:    { type: Boolean, default: false },
  isLocked:    { type: Boolean, default: false },
  isArchived:  { type: Boolean, default: false },
  replyCount:  { type: Number, default: 0 },
  bumpLimit:   { type: Boolean, default: false },
  lastReplyAt: { type: Date, default: null },
  bumpedAt:    { type: Date, default: Date.now },
  ip:          { type: String }                   // HMAC-SHA256 hashed
}, { timestamps: true });

threadSchema.index({ boardUri: 1, threadId: 1 }, { unique: true });
threadSchema.index({ boardUri: 1, bumpedAt: -1 });
threadSchema.index({ boardUri: 1, isPinned: -1, bumpedAt: -1 });

module.exports = mongoose.model('Thread', threadSchema);
