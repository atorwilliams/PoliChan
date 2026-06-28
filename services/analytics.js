'use strict';

const Visit  = require('../models/Visit');
const ipHash = require('./ipHash');

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Fire-and-forget: records that this IP touched `scope` today. The duplicate-key
// error from the unique index (already counted today) is the expected, common
// case, not a failure -- this must never block or slow down the request it's
// attached to.
function recordVisit(req, scope) {
  const ip = req.ip || req.connection?.remoteAddress;
  if (!ip) return;
  Visit.create({ date: todayUTC(), ipHash: ipHash.hash(ip), scope }).catch(() => {});
}

module.exports = { recordVisit, todayUTC };
