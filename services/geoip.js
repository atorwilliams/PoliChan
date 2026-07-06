'use strict';

const geoip = require('geoip-lite');

// Strip IPv6-mapped IPv4 prefix (e.g. "::ffff:1.2.3.4" → "1.2.3.4")
function cleanIp(ip) {
  return (ip || '').replace(/^::ffff:/, '');
}

// Manual corrections for ranges the bundled GeoLite2 data places wrongly.
// Checked before the database. Add entries as users report misflags.
// 38.0.0.0/8 is legacy Cogent space subleased in chunks; GeoLite2 lumps
// much of it as "US, location unknown".
const OVERRIDES = [
  { cidr: '38.192.80.0/21', country: 'CA' }  // ViaNetTV Inc, Edmonton AB (ARIN NET-38-192-80-0-1)
];

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const _overrides = OVERRIDES.map(({ cidr, country }) => {
  const [base, bits] = cidr.split('/');
  const mask = (~0 << (32 - parseInt(bits))) >>> 0;
  return { base: (ipToInt(base) & mask) >>> 0, mask, country };
});

/**
 * Return ISO 3166-1 alpha-2 country code for an IP, or null.
 * Returns null for private/loopback addresses (geoip-lite returns null for these).
 */
function getCountry(ip) {
  const clean = cleanIp(ip);
  const n = ipToInt(clean);
  if (n !== null) {
    for (const o of _overrides) {
      if (((n & o.mask) >>> 0) === o.base) return o.country;
    }
  }
  const geo = geoip.lookup(clean);
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
