'use strict';

const mongoose = require('mongoose');

const boardSchema = new mongoose.Schema({
  uri:         { type: String, required: true, unique: true, match: /^[a-z0-9-]+$/ },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  country:     { type: String, default: '' },  // 'ca', 'us' — first segment of uri
  region:      { type: String, default: '' },  // 'ab', 'pei' — second segment
  parentUri:   { type: String, default: null }, // null = top-level
  polimapKey:  { type: String, default: null }, // links to PoliMap region key
  threadCount: { type: Number, default: 0 },
  postCount:   { type: Number, default: 0 },
  settings: {
    maxThreads:       { type: Number, default: 150 },
    archiveThreshold: { type: Number, default: 10 }
  },
  rules:       { type: String, default: '' },
  isListed:    { type: Boolean, default: true },
  // 0 = public, 1 = Constituent+, 2 = Member+, 3 = Minister only
  minTier:     { type: Number, default: 0 },
  // Region lock — empty array means no restriction; populate with uppercase ISO-3166-1 alpha-2 codes (e.g. ['CA', 'US'])
  allowedCountries: [{ type: String }],
  // Home country for flair override — uppercase ISO alpha-2 (e.g. 'US'). Separate from region lock.
  homeCountry: { type: String, default: '' }
}, { timestamps: true });

// Derive country/region from uri on save
boardSchema.pre('save', function (next) {
  const parts = this.uri.split('-');
  this.country = parts[0] || '';
  this.region  = parts[1] || '';
  next();
});

module.exports = mongoose.model('Board', boardSchema);
