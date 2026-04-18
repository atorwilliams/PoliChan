'use strict';

const mongoose = require('mongoose');

const flairRuleSchema = new mongoose.Schema({
  name:         { type: String, required: true },   // Admin label (e.g. "Donor Gold")
  label:        { type: String, required: true },   // Text shown on posts (e.g. "Gold Donor")
  color:        { type: String, default: '#ffffff' },  // Text colour
  bgColor:      { type: String, default: '#b8860b' },  // Badge background
  matchType:    { type: String, enum: ['erc20', 'erc721', 'erc1155', 'manual', 'politician_sbt', 'polipass'], required: true },
  tokenAddress: { type: String, default: null },    // Contract address (not used for manual)
  tokenId:      { type: String, default: null },    // Specific token ID for ERC1155
  chainId:      { type: Number, default: 1 },       // 1=Ethereum, 137=Polygon, 8453=Base
  minBalance:   { type: String, default: '1' },     // String to handle BigNumber safely
  wallets:      [{ type: String, lowercase: true }],// Manual wallet list
  priority:     { type: Number, default: 0 },       // Higher = wins when multiple match
  isActive:     { type: Boolean, default: true }
}, { timestamps: true });

flairRuleSchema.index({ priority: -1 });

module.exports = mongoose.model('FlairRule', flairRuleSchema);
