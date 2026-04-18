'use strict';

const crypto = require('crypto');
const config = require('../config');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (num > 0n) {
    result = BASE58[Number(num % 58n)] + result;
    num = num / 58n;
  }
  return result.padStart(8, '1');
}

/**
 * Generate a deterministic tripcode from a wallet address.
 * Output: 8-char Base58 string, e.g. "A3F9Kx2M"
 */
function generate(walletAddress) {
  const hmac = crypto.createHmac('sha256', config.secrets.tripcode);
  hmac.update(walletAddress.toLowerCase());
  const digest = hmac.digest();
  return toBase58(digest).slice(0, 8);
}

module.exports = { generate };
