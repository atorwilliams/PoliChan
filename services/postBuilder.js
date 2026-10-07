'use strict';

// Shared pieces of creating a thread (OP) or a reply: access checks, media,
// and the author fields both documents carry. Routes keep only what differs.

const Ban          = require('../models/Ban');
const CountryFlair = require('../models/CountryFlair');
const geoip        = require('./geoip');
const ipHash       = require('./ipHash');
const media        = require('./media');
const tripcodes    = require('./tripcode');
const posterIds    = require('./posterId');
const globalFlairs = require('../config/globalFlairs.json');
const variants     = require('../config/variants.json');

class PostError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rawIp(req) {
  return req.ip || req.connection.remoteAddress;
}

/**
 * Active ban for this hashed IP on this board (or a global one), if any.
 */
function activeBan(ip, boardUri) {
  return Ban.findOne({
    ip,
    $and: [
      { $or: [{ boardUri: null }, { boardUri }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }
    ]
  }).sort({ expiresAt: -1 }).lean();
}

/**
 * Throws a PostError if this request may not post to the board:
 * banned, below the board's PoliPass tier, or outside its region lock.
 * Admins bypass the tier gate and bans (so staff can't lock themselves out).
 */
async function checkAccess(req, board) {
  const isAdmin = req.session?.isAdmin || false;
  const ip      = ipHash.hash(rawIp(req));

  if (!isAdmin) {
    const ban = await activeBan(ip, board.uri);
    if (ban) {
      const until = ban.expiresAt ? `until ${ban.expiresAt.toISOString()}` : 'permanently';
      const scope = ban.boardUri ? `from /${ban.boardUri}/` : 'from posting';
      throw new PostError(403, `You are banned ${scope} ${until} (reason: ${ban.reason})`);
    }

    const tier = req.session?.poliPassTier || 0;
    if ((board.minTier || 0) > tier) {
      throw new PostError(403, 'A higher-tier PoliPass is required to access this board');
    }
  }

  if (board.allowedCountries?.length > 0) {
    const country = geoip.getCountry(rawIp(req));
    if (!country || !board.allowedCountries.map(c => c.toUpperCase()).includes(country.toUpperCase())) {
      throw new PostError(403, 'This board is region-locked');
    }
  }
}

async function processMedia(req, boardUri) {
  if (!req.file) return null;
  try {
    return await media.processUpload(req.file, boardUri);
  } catch (err) {
    throw new PostError(400, err.message);
  }
}

// Flair: g:N = global, v:N = PoliPass variant, none = opt out, else session flair.
// A country flair always overrides when the poster is foreign to the board's home country.
async function resolveFlair(req, board) {
  let flair = { label: null, color: null, bgColor: null };

  const flairVal = req.body.flairVariant;
  const tier     = req.session?.poliPassTier || 0;

  if (flairVal === 'none') {
    // opted out
  } else if (flairVal?.startsWith('g:')) {
    const chosen = globalFlairs[parseInt(flairVal.slice(2))];
    if (chosen) flair = chosen;
  } else if (flairVal?.startsWith('v:') && tier > 0) {
    const chosen = (variants[String(tier)] || [])[parseInt(flairVal.slice(2))];
    if (chosen) flair = chosen;
  } else {
    flair = {
      label:   req.session?.flair        || null,
      color:   req.session?.flairColor   || null,
      bgColor: req.session?.flairBgColor || null
    };
  }

  const posterCountry = geoip.getCountry(rawIp(req));
  const homeCountry = board.homeCountry
    || (board.country?.length === 2 ? board.country.toUpperCase() : '');
  if (posterCountry && homeCountry && posterCountry !== homeCountry) {
    const rule = await CountryFlair.findOne({ fromCountry: posterCountry, toCountry: homeCountry }).lean();
    flair = rule || { label: posterCountry, color: '#e2e8f0', bgColor: '#374151' };
  }

  return { flair: flair.label, flairColor: flair.color, flairBgColor: flair.bgColor };
}

/**
 * Author fields shared by Thread and Post documents.
 */
async function authorFields(req, board) {
  const s       = req.session;
  const isAdmin = s?.isAdmin || false;

  let tripcode = null;
  if (isAdmin && req.body.randomTrip === 'true') tripcode = tripcodes.random();
  else if (req.body.showTripcode === 'true' && s?.tripcode) tripcode = s.tripcode;

  return {
    name:           req.body.name?.trim().slice(0, 50) || '',
    ip:             ipHash.hash(rawIp(req)),
    authorId:       s?.accountId || null,
    tripcode,
    ...(await resolveFlair(req, board)),
    isModPost:      (isAdmin || s?.staffRole === 'mod') && req.body.postAnon !== 'true',
    randomPosterId: (isAdmin && req.body.randomId === 'true') ? posterIds.randomPosterId() : null
  };
}

/**
 * Wraps a posting handler: PostErrors become their status, anything else a 500.
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err instanceof PostError ? err.status : 500).json({ error: err.message });
    }
  };
}

module.exports = { PostError, activeBan, checkAccess, processMedia, authorFields, handle };
