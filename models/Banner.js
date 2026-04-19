'use strict';

const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  boardUri:     { type: String, default: null },  // null = global
  isGlobal:     { type: Boolean, default: false },
  storedName:   { type: String, required: true },
  originalName: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Banner', bannerSchema);
