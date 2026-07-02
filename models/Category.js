'use strict';

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name:  { type: String, required: true },
  slug:  { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]+$/ },
  type:  { type: String, enum: ['country', 'general'], default: 'general' },
  order: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Category', categorySchema);
