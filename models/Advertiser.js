'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const adSchema = new Schema({
  type:          { type: String, enum: ['header', 'banner', 'footer', 'sidebar'], required: true },
  boardUri:      { type: String, default: null },
  imageFile:     { type: String, required: true },
  clickUrl:      { type: String, required: true },
  isActive:      { type: Boolean, default: true },
  startDate:     { type: Date, default: null },
  endDate:       { type: Date, default: null },
  impressions:   { type: Number, default: 0 },
  clicks:        { type: Number, default: 0 },
}, { _id: true });

const advertiserSchema = new Schema({
  slug:    { type: String, required: true, unique: true },
  company: { type: String, required: true },
  contact: { type: String, default: '' },
  ads:     { type: [adSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Advertiser', advertiserSchema);
