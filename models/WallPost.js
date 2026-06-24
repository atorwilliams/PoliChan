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

const wallPostSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, lowercase: true },
  displayName:   { type: String, default: '' },
  isAnon:        { type: Boolean, default: false },
  title:         { type: String, required: true, maxlength: 120 },
  body:          { type: String, required: true, maxlength: 10000 },
  signature:     { type: String, required: true },
  media:         { type: mediaSchema, default: null }
}, { timestamps: true });

wallPostSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WallPost', wallPostSchema);
