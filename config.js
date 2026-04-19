'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/polichan'
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  admin: {
    wallets: (process.env.ADMIN_WALLETS || '')
      .split(',')
      .map(w => w.trim().toLowerCase())
      .filter(Boolean),
    publicKey: process.env.ADMIN_PUBLIC_KEY || null
  },

  secrets: {
    tripcode: process.env.TRIPCODE_SECRET,
    ipHash:   process.env.IP_HASH_SECRET
  },

  uploads: {
    dir:        process.env.UPLOAD_DIR || './public/uploads',
    maxImageMb: parseInt(process.env.MAX_IMAGE_MB) || 8,
    maxVideoMb: parseInt(process.env.MAX_VIDEO_MB) || 32
  },

  flood: {
    // post reply cooldowns (ms)
    anonymous:    60 * 1000,
    constituent:  30 * 1000,
    member:       15 * 1000,
    minister:     0,
    // thread creation cooldowns (ms) — 2× the post limit
    threadAnon:        120 * 1000,
    threadConstituent:  60 * 1000,
    threadMember:       30 * 1000,
    threadMinister:     0
  },

  threads: {
    bumpLimit:        500,
    defaultMaxThreads: 150,
    archiveThreshold:  10
  },

  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secret:  process.env.TURNSTILE_SECRET   || '',
    enabled: process.env.TURNSTILE_ENABLED !== 'false'
  },

  // JSON RPC endpoints for on-chain flair checks (chainId → URL)
  rpc: {
    1:        process.env.RPC_ETH      || 'https://eth.llamarpc.com',
    137:      process.env.RPC_POLYGON  || 'https://polygon.llamarpc.com',
    8453:     process.env.RPC_BASE     || 'https://base.llamarpc.com',
    11155111: process.env.RPC_SEPOLIA  || 'https://sepolia.llamarpc.com'
  },

  polipass: {
    address: process.env.POLIPASS_ADDRESS || '0x1B484d1814a42C1C72F65602b18c97cE2aE6573F',
    chainId: parseInt(process.env.POLIPASS_CHAIN_ID) || 11155111
  },

  wipe: {
    pubkey1: process.env.WIPE_PUBKEY_1 || null,
    pubkey2: process.env.WIPE_PUBKEY_2 || null
  }
};
