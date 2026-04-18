'use strict';

const https  = require('https');
const config = require('../config');

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    const body = `response=${encodeURIComponent(token)}&secret=${encodeURIComponent(config.hcaptcha.secret)}`;
    const req  = https.request({
      hostname: 'hcaptcha.com',
      path:     '/siteverify',
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
        catch { reject(new Error('Invalid hCaptcha response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res, next) => {
  // Captcha disabled globally
  if (!config.hcaptcha.enabled) return next();

  // Authenticated wallet users and admins skip captcha (like a 4chan Pass)
  if (req.session?.accountId || req.session?.isAdmin) return next();

  const token = req.body?.['h-captcha-response'];
  if (!token) return res.status(400).json({ error: 'Captcha required' });

  try {
    const result = await verifyToken(token);
    if (!result.success) {
      return res.status(400).json({ error: 'Captcha verification failed — please try again' });
    }
    next();
  } catch (err) {
    // If hCaptcha is unreachable, fail open in dev, fail closed in prod
    if (config.env === 'production') {
      return res.status(503).json({ error: 'Captcha service unavailable' });
    }
    console.warn('[captcha] verification request failed:', err.message);
    next();
  }
};
