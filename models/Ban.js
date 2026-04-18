'use strict';

const mongoose = require('mongoose');

const banSchema = new mongoose.Schema({
  ip:        { type: String, required: true, index: true },  // hashed
  reason:    { type: String, enum: ['spam', 'illegal'], required: true },
  boardUri:  { type: String, default: null },  // null = global ban
  expiresAt: { type: Date, default: null },     // null = permanent
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' }
}, { timestamps: true });

module.exports = mongoose.model('Ban', banSchema);
