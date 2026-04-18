'use strict';

const mongoose = require('mongoose');

const wordFilterSchema = new mongoose.Schema({
  word:        { type: String, required: true, unique: true },
  replacement: { type: String, required: true },
  isActive:    { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('WordFilter', wordFilterSchema);
