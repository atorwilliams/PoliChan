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
const fs         = require('fs');
const mongoose   = require('mongoose');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const morgan     = require('morgan');
const { Server } = require('socket.io');

const { attachSession } = require('./middleware/auth');
const Thread = require('./models/Thread');
const Board  = require('./models/Board');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// PM2 restarts the process on crash either way — log why before it happens,
// since otherwise the only trace is a silent restart with no error context.
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

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

app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

// Security headers. CSP is permissive on script/style because the app relies
// heavily on inline <script> blocks and onclick handlers (no nonce/build step
// to thread a nonce through every view) — this still blocks third-party script
// injection from compromised CDNs/iframes and locks down framing.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://challenges.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc:    ["'self'", 'blob:', 'https:'],
      fontSrc:     ["'self'", 'data:'],
      connectSrc:  ["'self'", 'https://challenges.cloudflare.com', 'wss:', 'ws:'],
      frameSrc:    ['https://challenges.cloudflare.com'],
      objectSrc:   ["'none'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachSession);

// Static files
app.use('/.static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Favicon + robots.txt
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.png')));
app.get('/favicon.ico', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.png')));
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Disallow: /manage\n' +
    'Disallow: /admin\n' +
    'Disallow: /api\n' +
    'Allow: /\n' +
    `Sitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const boards = await Board.find({ isListed: true }).select('uri').lean();
    const urls = [
      `${base}/`,
      `${base}/about`,
      `${base}/faq`,
      `${base}/constitution`,
      ...boards.map(b => `${base}/${b.uri}/`)
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') +
      `\n</urlset>`;
    res.type('application/xml').send(xml);
  } catch (err) {
    res.status(500).send('');
  }
});

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
app.get('/about',        (_req, res) => res.sendFile(path.join(__dirname, 'views', 'about.html')));
app.get('/faq',          (_req, res) => res.sendFile(path.join(__dirname, 'views', 'faq.html')));
app.get('/legal',        (_req, res) => res.sendFile(path.join(__dirname, 'views', 'legal.html')));
app.get('/contact',      (_req, res) => res.sendFile(path.join(__dirname, 'views', 'contact.html')));

// Serve the shell HTML for all non-API, non-admin routes (client JS takes over).
// Bots (Discord/Twitter unfurlers) don't run the client JS router, so board/thread
// routes get their og:* tags injected server-side here instead.
const indexHtml = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

app.get('*', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  let og = '';

  try {
    const threadMatch = req.path.match(/^\/([a-z0-9-]+)\/(\d+)\/?$/);
    const boardMatch  = !threadMatch && req.path.match(/^\/([a-z0-9-]+)\/?$/);

    if (threadMatch) {
      const [, boardUri, threadIdStr] = threadMatch;
      const thread = await Thread.findOne({ boardUri, threadId: parseInt(threadIdStr) })
        .select('subject body media').lean();
      if (thread) {
        const title = thread.subject || `Thread No.${threadIdStr}`;
        const desc  = (thread.body || '').slice(0, 200);
        const image = thread.media?.thumbName ? `${base}/uploads/${boardUri}/${thread.media.thumbName}` : null;
        og = `<meta property="og:title" content="${escAttr(title)} — /${escAttr(boardUri)}/">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:url" content="${base}${req.path}">
  <meta property="og:type" content="article">
  ${image ? `<meta property="og:image" content="${escAttr(image)}">` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`;
      }
    } else if (boardMatch) {
      const boardUri = boardMatch[1];
      const board = await Board.findOne({ uri: boardUri }).select('name description').lean();
      if (board) {
        og = `<meta property="og:title" content="/${escAttr(boardUri)}/ — ${escAttr(board.name)}">
  <meta property="og:description" content="${escAttr(board.description)}">
  <meta property="og:url" content="${base}${req.path}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">`;
      }
    }
  } catch (err) {
    console.error('OG meta injection error:', err);
  }

  res.send(indexHtml.replace('<!--OG_META-->', og));
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
