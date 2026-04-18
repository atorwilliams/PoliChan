'use strict';

const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true, lowercase: true },
  tripcode:      { type: String },         // derived server-side, cached here
  showTripcode:  { type: Boolean, default: false },
  staffRole:     { type: String, enum: ['mod', 'janitor', null], default: null },
  // NOTE: admin role is never stored — derived at login from ADMIN_WALLETS env var
  // Board-specific role assignments (overrides staffRole for specific boards)
  boardRoles: [{
    boardUri: { type: String, required: true },
    role:     { type: String, enum: ['mod', 'janitor'], required: true }
  }],
  tokens: [{
    contractAddress: String,
    tokenId:         String,
    role:            String   // 'donor_bronze' | 'donor_silver' | 'donor_gold' | 'contributor' | 'verified'
  }],
  bannedUntil:   { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Account', accountSchema);
