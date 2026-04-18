#!/usr/bin/env node
'use strict';

/**
 * PoliChan admin fallback login — sign a challenge with your ED25519 private key.
 *
 * Usage:
 *   node tools/sign.js "challenge-string-from-admin-login-page"
 *
 * Requires: admin-private.pem in the current directory (or set PRIVATE_KEY_PATH)
 *
 * Output: base64-encoded signature — paste into the admin login form.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const challenge = process.argv[2];
if (!challenge) {
  console.error('Usage: node tools/sign.js "challenge-string"');
  process.exit(1);
}

const keyPath = process.env.PRIVATE_KEY_PATH
  || path.join(process.cwd(), 'admin-private.pem');

if (!fs.existsSync(keyPath)) {
  console.error(`Private key not found at: ${keyPath}`);
  console.error('Set PRIVATE_KEY_PATH env var or place admin-private.pem in current directory.');
  process.exit(1);
}

const privateKey = fs.readFileSync(keyPath, 'utf8');

const signature = crypto.sign(null, Buffer.from(challenge), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363'
});

console.log(signature.toString('base64'));
