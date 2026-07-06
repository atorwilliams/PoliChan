'use strict';

const AuditLog = require('../models/AuditLog');

// Body fields worth showing in the changelog, in display order.
const INTERESTING_FIELDS = [
  'boardUri', 'targetBoardUri', 'uri', 'threadId', 'postId', 'name',
  'walletAddress', 'role', 'reason', 'word', 'replacement', 'title',
  'question', 'subject', 'label', 'fromCountry', 'toCountry', 'text',
  'pinned', 'locked', 'resolved', 'runAt', 'slug', 'minTier'
];
// Never log these even if present.
const REDACTED_FIELDS = new Set(['signature', 'challenge', 'hash', 'key', 'secret', 'token', 'confirm']);

function summarize(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  for (const f of INTERESTING_FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === '' || REDACTED_FIELDS.has(f)) continue;
    let v = String(body[f]);
    if (v.length > 60) v = v.slice(0, 57) + '...';
    parts.push(`${f}: ${v}`);
  }
  return parts.join(', ');
}

function actorOf(session) {
  if (!session) return { label: 'unknown', role: '' };
  const label = session.tripcode
    ? '##' + session.tripcode
    : (session.isAdmin ? 'admin:' + String(session.accountId || '').slice(-6) : String(session.accountId || 'unknown').slice(-6));
  const role = session.isAdmin ? 'admin'
    : session.staffRole ? session.staffRole
    : (session.boardRoles?.length ? 'board-mod' : '');
  return { label, role };
}

/**
 * Router-level middleware: records every successful (2xx/3xx) non-GET
 * request by an authenticated staff session. Attach after auth middleware
 * where possible; entries are only written when a session exists.
 */
function middleware(area) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      if (!req.session) return;
      const { label, role } = actorOf(req.session);
      AuditLog.create({
        accountId:  req.session.accountId || null,
        actorLabel: label,
        actorRole:  role,
        method:     req.method,
        path:       req.baseUrl + (req.path === '/' ? '' : req.path),
        area,
        summary:    summarize(req.body)
      }).catch(() => { /* logging must never break the action itself */ });
    });
    next();
  };
}

module.exports = { middleware };
