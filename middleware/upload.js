'use strict';

const multer = require('multer');
const { ALLOWED_MIME } = require('../services/media');

const TIER_LIMITS_MB = [2, 4, 6, 8]; // index = poliPassTier (0–3)

function limitBytes(session) {
  if (session?.isAdmin) return 8 * 1024 * 1024;
  const tier = session?.poliPassTier || 0;
  return (TIER_LIMITS_MB[tier] ?? 2) * 1024 * 1024;
}

// Dynamic middleware — limit is set per-request from session tier so Multer
// cuts the connection before oversized data hits memory.
module.exports = function upload(req, res, next) {
  const limit = limitBytes(req.session);
  multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: limit },
    fileFilter(_req, file, cb) {
      if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
      else cb(new Error('Unsupported file type. Allowed: JPEG, PNG, GIF, WebP, WebM, MP4'));
    }
  }).single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      const mb = limit / (1024 * 1024);
      return res.status(413).json({ error: `File too large. Your upload limit is ${mb}MB.` });
    }
    next(err);
  });
};
