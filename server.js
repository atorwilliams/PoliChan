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

// Static pages — must be before the catch-all
app.get('/pass', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'pass.html')));
app.get('/wall', (_req, res) => res.sendFile(path.join(__dirname, 'views', 'wall.html')));

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
