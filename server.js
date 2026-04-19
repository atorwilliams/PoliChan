'use strict';

const config = require('./config');

// Validate required secrets on startup
const required = ['jwt.secret', 'secrets.tripcode', 'secrets.ipHash'];
for (const key of required) {
  const val = key.split('.').reduce((o, k) => o?.[k], config);
  if (!val) {
    console.error(`Missing required config: ${key} — check your .env`);
    process.exit(1);
  }
}

const express    = require('express');
const http       = require('http');
const path       = require('path');
const mongoose   = require('mongoose');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { attachSession } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── Database ──────────────────────────────────────────────────────────────────

mongoose.connect(config.mongo.uri)
  .then(async () => {
    console.log(`MongoDB connected: ${config.mongo.uri}`);
    await require('./services/counter').sync();
  })
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });

// ── Middleware ────────────────────────────────────────────────────────────────

// Trust first proxy (nginx) so req.ip reflects the real client IP
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachSession);

// Static files
app.use('/.static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Attach io to req so routes can emit events
app.use((req, _res, next) => { req.io = io; next(); });

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/boards',  require('./routes/boards'));
app.use('/api/threads', require('./routes/threads'));
app.use('/api/posts',   require('./routes/posts'));
app.use('/api/polls',   require('./routes/polls'));
app.use('/api/mod',     require('./routes/mod'));
app.use('/api/wall',    require('./routes/wall'));
app.use('/admin',       require('./routes/admin'));
app.use('/manage',      require('./routes/manage'));

// NFT metadata + images
app.use('/pass', require('./routes/nft'));

// Public announcements API
app.get('/api/announcements', async (_req, res) => {
  try {
    const Announcement = require('./models/Announcement');
    const items = await Announcement.find({ isActive: true, boardUri: null })
      .sort({ createdAt: -1 }).lean();
    res.json({ announcements: items.map(a => ({ _id: a._id, text: a.text })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/announcements/:boardUri', async (req, res) => {
  try {
    const Announcement = require('./models/Announcement');
    const items = await Announcement.find({
      isActive: true,
      $or: [{ boardUri: req.params.boardUri }, { boardUri: null }]
    }).sort({ createdAt: -1 }).lean();
    res.json({ announcements: items.map(a => ({ _id: a._id, text: a.text, boardUri: a.boardUri })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public banners API
app.get('/api/banners/:boardUri', async (req, res) => {
  try {
    const Banner = require('./models/Banner');
    const banners = await Banner.find({
      $or: [{ boardUri: req.params.boardUri }, { isGlobal: true }]
    }).lean();
    res.json({ banners: banners.map(b => ({
      _id:      b._id,
      isGlobal: b.isGlobal,
      url: b.isGlobal
        ? `/uploads/banners/global/${b.storedName}`
        : `/uploads/banners/${b.boardUri}/${b.storedName}`
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public constitution API
app.get('/api/constitution', async (_req, res) => {
  try {
    const SiteConfig = require('./models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'constitution' }).lean();
    res.json({ text: doc?.value || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public ads API
app.get('/api/ads/:boardUri', async (req, res) => {
  try {
    const Advertiser = require('./models/Advertiser');
    const Board      = require('./models/Board');
    const now = new Date();
    const { boardUri } = req.params;
    const { type } = req.query;

    const board = await Board.findOne({ uri: boardUri }).lean();
    const scopeChain = [boardUri];
    if (board?.parentUri) scopeChain.push(board.parentUri);
    scopeChain.push(null);

    const advertisers = await Advertiser.find({
      'ads.isActive': true,
      'ads.type': type || { $exists: true }
    }).lean();

    const pool = [];
    for (const adv of advertisers) {
      for (const ad of adv.ads) {
        if (!ad.isActive) continue;
        if (type && ad.type !== type) continue;
        if (ad.startDate && ad.startDate > now) continue;
        if (ad.endDate   && ad.endDate   < now) continue;
        if (!scopeChain.includes(ad.boardUri)) continue;
        pool.push({ advertiserId: adv._id, adId: ad._id, type: ad.type,
          imageUrl: `/uploads/ads/${ad.imageFile}`, clickUrl: ad.clickUrl,
          scope: scopeChain.indexOf(ad.boardUri) });
      }
    }

    if (!pool.length) return res.json({ ad: null });
    pool.sort((a, b) => a.scope - b.scope);
    const bestScope = pool[0].scope;
    const candidates = pool.filter(a => a.scope === bestScope);
    const ad = candidates[Math.floor(Math.random() * candidates.length)];
    res.json({ ad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ads/:advertiserId/:adId/impression', async (req, res) => {
  try {
    const Advertiser = require('./models/Advertiser');
    await Advertiser.updateOne(
      { _id: req.params.advertiserId, 'ads._id': req.params.adId },
      { $inc: { 'ads.$.impressions': 1 } }
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.post('/api/ads/:advertiserId/:adId/click', async (req, res) => {
  try {
    const Advertiser = require('./models/Advertiser');
    await Advertiser.updateOne(
      { _id: req.params.advertiserId, 'ads._id': req.params.adId },
      { $inc: { 'ads.$.clicks': 1 } }
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// Static pages — must be before the catch-all
app.get('/pass',         (_req, res) => res.sendFile(path.join(__dirname, 'views', 'pass.html')));
app.get('/wall',         (_req, res) => res.sendFile(path.join(__dirname, 'views', 'wall.html')));
app.get('/constitution', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'constitution.html')));

// Serve the shell HTML for all non-API, non-admin routes (client JS takes over)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  socket.on('join-thread', ({ boardUri, threadId }) => {
    socket.join(`${boardUri}:${threadId}`);
  });
  socket.on('leave-thread', ({ boardUri, threadId }) => {
    socket.leave(`${boardUri}:${threadId}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(config.port, () => {
  console.log(`PoliChan running on port ${config.port} [${config.env}]`);
});

module.exports = { app, io };
