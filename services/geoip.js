'use strict';

const geoip = require('geoip-lite');

// Strip IPv6-mapped IPv4 prefix (e.g. "::ffff:1.2.3.4" → "1.2.3.4")
function cleanIp(ip) {
  return (ip || '').replace(/^::ffff:/, '');
}

/**
 * Return ISO 3166-1 alpha-2 country code for an IP, or null.
 * Returns null for private/loopback addresses (geoip-lite returns null for these).
 */
function getCountry(ip) {
  const geo = geoip.lookup(cleanIp(ip));
  return geo?.country || null;  // 'CA', 'US', 'GB', etc. — uppercase
}

// Convert ISO alpha-2 code to flag emoji (regional indicator pair)
function toFlag(code) {
  return code.toUpperCase().replace(/[A-Z]/g, c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

/**
 * If the poster's country differs from the board's country, return a flair
 * object { label, color, bgColor }. Otherwise return null.
 *
 * boardCountry: first URI segment of the board (e.g. 'ca', 'us', 'pol')
 * posterCountry: result of getCountry(ip) — uppercase ISO code, or null
 *
 * Only boards whose first segment is exactly 2 letters are treated as
 * country-scoped (e.g. 'ca', 'us', 'gb'). Boards like 'pol' and 'meta'
 * are skipped.
 */
function foreignFlair(posterCountry, boardCountry) {
  if (!posterCountry || !boardCountry) return null;
  // Only apply to country-scoped boards (2-letter prefix)
  if (!/^[a-z]{2}$/.test(boardCountry)) return null;
  // Same country — no flair
  if (posterCountry.toLowerCase() === boardCountry.toLowerCase()) return null;

  return {
    label:    `${toFlag(posterCountry)} ${posterCountry.toUpperCase()}`,
    color:    '#e2e8f0',
    bgColor:  '#374151'
  };
}

module.exports = { getCountry, foreignFlair, toFlag };
