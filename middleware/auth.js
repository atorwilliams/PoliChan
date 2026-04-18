'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Attach session to req.session if a valid JWT cookie exists.
 * Never rejects — routes decide if auth is required.
 */
function attachSession(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return next();

  try {
    req.session = jwt.verify(token, config.jwt.secret);
  } catch (e) {
    // Invalid or expired token — clear the cookie
    res.clearCookie('token');
  }

  next();
}

/**
 * Require an authenticated session. 401 if not present.
 */
function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/**
 * Require admin role. 403 if not admin.
 */
function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/**
 * Require mod or admin role (global).
 */
function requireMod(req, res, next) {
  if (!req.session?.isAdmin && !['mod', 'janitor'].includes(req.session?.staffRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/**
 * Require board-specific mod/janitor role for req.params.boardUri.
 * Passes if: admin, global mod/janitor, or board-specific role matches.
 */
function requireBoardMod(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.isAdmin) return next();
  if (['mod', 'janitor'].includes(req.session.staffRole)) return next();
  const boardUri  = req.params.boardUri;
  const boardRoles = req.session.boardRoles || [];
  if (boardRoles.some(r => r.boardUri === boardUri && ['mod', 'janitor'].includes(r.role))) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

/**
 * Issue a JWT and set it as an httpOnly cookie.
 */
function issueToken(res, payload) {
  const token = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  res.cookie('token', token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
  });
}

module.exports = { attachSession, requireAuth, requireAdmin, requireMod, requireBoardMod, issueToken };
