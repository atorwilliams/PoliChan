'use strict';

const fs   = require('fs');
const path = require('path');

const Thread     = require('../models/Thread');
const Post       = require('../models/Post');
const Report     = require('../models/Report');
const Board      = require('../models/Board');
const SiteConfig = require('../models/SiteConfig');
const counter    = require('./counter');

const UPLOADS_ROOT = path.join(__dirname, '../public/uploads');
// Non-post media that survives a soft reset. Everything else under
// public/uploads is a per-board media folder and gets deleted.
const PRESERVED_DIRS = ['ads', 'banners', 'press', 'wall'];

const KEY = 'softResetAt';
const CHECK_INTERVAL_MS = 30 * 1000;

let running = false;

/**
 * Soft reset: delete every thread, post, report, and board media file.
 * Boards, accounts, bans, categories, ads, banners, press, and the wall
 * are untouched. Post numbering restarts at 1.
 */
async function run(io) {
  if (running) return;
  running = true;
  try {
    await Promise.all([
      Thread.deleteMany({}),
      Post.deleteMany({}),
      Report.deleteMany({})
    ]);

    await Board.updateMany({}, { $set: { threadCount: 0, postCount: 0 } });
    await counter.reset();

    if (fs.existsSync(UPLOADS_ROOT)) {
      for (const entry of fs.readdirSync(UPLOADS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (PRESERVED_DIRS.includes(entry.name)) continue;
        fs.rmSync(path.join(UPLOADS_ROOT, entry.name), { recursive: true, force: true });
      }
    }

    await SiteConfig.deleteOne({ key: KEY });

    if (io) io.emit('soft-reset');
    console.warn(`[SOFT-RESET] All threads and posts wiped at ${new Date().toISOString()}`);
  } finally {
    running = false;
  }
}

async function getScheduledAt() {
  const doc = await SiteConfig.findOne({ key: KEY }).lean();
  return doc?.value || null;
}

async function schedule(isoDate) {
  await SiteConfig.findOneAndUpdate(
    { key: KEY },
    { $set: { value: isoDate } },
    { upsert: true }
  );
}

async function cancel() {
  await SiteConfig.deleteOne({ key: KEY });
}

/**
 * Poll the stored schedule. DB-backed so it survives restarts; if the
 * server was down when the time passed, the reset fires on next boot.
 */
function init(io) {
  setInterval(async () => {
    try {
      const at = await getScheduledAt();
      if (!at) return;
      const ts = new Date(at).getTime();
      if (isNaN(ts)) { await cancel(); return; }
      if (Date.now() >= ts) {
        console.warn(`[SOFT-RESET] Scheduled time ${at} reached — executing`);
        await run(io);
      }
    } catch (err) {
      console.error('[SOFT-RESET] check failed:', err.message);
    }
  }, CHECK_INTERVAL_MS);
}

module.exports = { run, init, schedule, cancel, getScheduledAt };
