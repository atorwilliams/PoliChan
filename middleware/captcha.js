'use strict';

const https  = require('https');
const config = require('../config');

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    const body = `response=${encodeURIComponent(token)}&secret=${encodeURIComponent(config.turnstile.secret)}`;
    const req  = https.request({
      hostname: 'challenges.cloudflare.com',
      path:     '/turnstile/v0/siteverify',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid Turnstile response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res, next) => {
  if (!config.turnstile.enabled) return next();

  // Authenticated wallet users and admins skip captcha
  if (req.session?.accountId || req.session?.isAdmin) return next();

  const token = req.body?.['cf-turnstile-response'];
  if (!token) return res.status(400).json({ error: 'Captcha required' });

  try {
    const result = await verifyToken(token);
    if (!result.success) {
      return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
    }
    next();
  } catch (err) {
    if (config.env === 'production') {
      return res.status(503).json({ error: 'Captcha service unavailable' });
    }
    console.warn('[captcha] verification request failed:', err.message);
    next();
  }
};
