'use strict';

const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  text:     { type: String, required: true },
  boardUri: { type: String, default: null },  // null = global (all boards)
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
