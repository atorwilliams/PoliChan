'use strict';

const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  boardUri:    { type: String, required: true },
  threadId:    { type: Number, required: true },
  postId:      { type: Number, default: null },  // null = report on the thread OP itself
  reason:      { type: String, enum: ['spam', 'illegal'], required: true },
  reporterIp:  { type: String },                 // hashed
  resolved:    { type: Boolean, default: false },
  resolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null }
}, { timestamps: true });

module.exports = mongoose.model('Report', reportSchema);
