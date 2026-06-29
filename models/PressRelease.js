'use strict';

const mongoose = require('mongoose');

const pressReleaseSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  body:        { type: String, required: true },
  isPublished: { type: Boolean, default: true },
  media: [{
    originalName: String,
    storedName:   String,
    thumbName:    String,
    width:        Number,
    height:       Number
  }]
}, { timestamps: true });

module.exports = mongoose.model('PressRelease', pressReleaseSchema);
