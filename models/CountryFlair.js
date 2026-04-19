'use strict';

const mongoose = require('mongoose');

const countryFlairSchema = new mongoose.Schema({
  fromCountry: { type: String, required: true, uppercase: true, trim: true },
  toCountry:   { type: String, required: true, uppercase: true, trim: true },
  label:       { type: String, required: true, trim: true },
  color:       { type: String, default: '#e2e8f0' },
  bgColor:     { type: String, default: '#374151' },
}, { timestamps: true });

countryFlairSchema.index({ fromCountry: 1, toCountry: 1 }, { unique: true });

module.exports = mongoose.model('CountryFlair', countryFlairSchema);
