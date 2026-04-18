'use strict';

const config = require('../config');
const ipHash = require('../services/ipHash');

// In-memory store: hashedIp → { lastPost, lastThread }
// Simple enough for a single-process server. Replace with Redis if scaling.
const store = new Map();

function getRecord(hashedIp) {
  if (!store.has(hashedIp)) store.set(hashedIp, { lastPost: 0, lastThread: 0 });
  return store.get(hashedIp);
}

function getFloodLimits(session) {
  const tier = session?.poliPassTier || 0;
  if (tier >= 3) return { post: config.flood.minister,     thread: config.flood.threadMinister };
  if (tier >= 2) return { post: config.flood.member,       thread: config.flood.threadMember };
  if (tier >= 1) return { post: config.flood.constituent,  thread: config.flood.threadConstituent };
  return          { post: config.flood.anonymous,   thread: config.flood.threadAnon };
}

/**
 * Flood check middleware factory.
 * @param {'post'|'thread'} type
 */
function floodCheck(type) {
  return function (req, res, next) {
    if (req.session?.isAdmin) return next();

    const ip = req.ip || req.connection.remoteAddress;
    const hashed = ipHash.hash(ip);
    const limits = getFloodLimits(req.session);
    const record = getRecord(hashed);
    const now = Date.now();
    const lastKey = type === 'thread' ? 'lastThread' : 'lastPost';
    const limit = type === 'thread' ? limits.thread : limits.post;

    if (now - record[lastKey] < limit) {
      const waitSec = Math.ceil((limit - (now - record[lastKey])) / 1000);
      return res.status(429).json({ error: `Flood detected. Wait ${waitSec}s.` });
    }

    record[lastKey] = now;
    next();
  };
}

module.exports = { floodCheck };
