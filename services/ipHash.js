'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Hash an IP address using HMAC-SHA256 with a server secret.
 * Cannot be reversed without the secret even with full DB access.
 */
function hash(ip) {
  return crypto
    .createHmac('sha256', config.secrets.ipHash)
    .update(ip)
    .digest('hex');
}

module.exports = { hash };
