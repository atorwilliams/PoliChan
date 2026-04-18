'use strict';

let tiers = {};

try {
  tiers = require('../sourceTiers.json');
} catch (e) {
  // sourceTiers.json not present — no tagging
}

/**
 * Extract the first URL from a post body and return a sourceTag object,
 * or null if no URL or no matching tier.
 */
function tag(body) {
  const match = body.match(/https?:\/\/([^\s/]+)/i);
  if (!match) return null;

  const hostname = match[1].replace(/^www\./, '').toLowerCase();

  for (const [domain, tier] of Object.entries(tiers)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return { domain: hostname, tier };
    }
  }

  return null;
}

module.exports = { tag };
