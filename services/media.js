'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const sharp  = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const config = require('../config');

// Point fluent-ffmpeg at the correct binary for the current platform
if (process.platform === 'win32') {
  const FFMPEG_DIR = path.join(
    'C:', 'Users', 'justt', 'Documents',
    'ffmpeg-7.1.1-essentials_build', 'bin'
  );
  ffmpeg.setFfmpegPath(path.join(FFMPEG_DIR, 'ffmpeg.exe'));
  ffmpeg.setFfprobePath(path.join(FFMPEG_DIR, 'ffprobe.exe'));
}
// On Linux, fluent-ffmpeg will find ffmpeg/ffprobe from PATH automatically

const UPLOADS_ROOT  = path.join(__dirname, '../public/uploads');
const THUMB_SIZE    = 250;   // max px for either dimension
const MAX_BYTES     = (config.uploads.maxImageMb || 8)  * 1024 * 1024;
const MAX_VIDEO_BYTES = (config.uploads.maxVideoMb || 32) * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/webm', 'video/mp4'
]);

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'video/webm': 'webm',
  'video/mp4':  'mp4'
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function boardDir(boardUri) {
  const dir = path.join(UPLOADS_ROOT, boardUri);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueName(ext) {
  return crypto.randomBytes(8).toString('hex') + '.' + ext;
}

// ── Image processing ──────────────────────────────────────────────────────────

async function processImage(file, boardUri) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new Error('Unsupported file type');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('File too large (max 10 MB)');
  }

  const ext       = MIME_TO_EXT[file.mimetype];
  const dir       = boardDir(boardUri);
  const storedName = uniqueName(ext);
  const thumbName  = 's_' + storedName;

  const storedPath = path.join(dir, storedName);
  const thumbPath  = path.join(dir, thumbName);

  // Get metadata first
  const meta = await sharp(file.buffer).metadata();
  const { width, height } = meta;

  // Write original (strip EXIF for images)
  await sharp(file.buffer)
    .rotate()                          // honour EXIF orientation then strip
    .withMetadata({ exif: {} })        // clear EXIF
    .toFile(storedPath);

  // Write thumbnail
  await sharp(file.buffer)
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .withMetadata({ exif: {} })
    .toFile(thumbPath);

  return {
    originalName: file.originalname,
    storedName,
    thumbName,
    type:   'image',
    size:   file.size,
    width,
    height
  };
}

// ── Video processing ──────────────────────────────────────────────────────────

function probeVideo(buffer) {
  return new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    const stream = Readable.from(buffer);
    ffmpeg.ffprobe(stream, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams?.find(s => s.codec_type === 'video');
      resolve({ width: vs?.width || 0, height: vs?.height || 0 });
    });
  });
}

function extractFrame(srcPath, thumbPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .seekInput(0)
      .frames(1)
      .size(`${THUMB_SIZE}x?`)
      .output(thumbPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function reencodeVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v', 'libx264',
        '-crf', '26',
        '-preset', 'fast',
        '-movflags', '+faststart',
        // Scale to fit within 1280×1280, maintain AR, ensure even dimensions
        '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease,scale=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function processWebm(file, boardUri) {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(`File too large (max ${config.uploads.maxVideoMb} MB for video)`);
  }

  const dir        = boardDir(boardUri);
  const storedName = uniqueName('webm');
  const thumbName  = 's_' + storedName.replace('.webm', '.jpg');
  const storedPath = path.join(dir, storedName);
  const thumbPath  = path.join(dir, thumbName);

  fs.writeFileSync(storedPath, file.buffer);

  let width = 0, height = 0;
  try {
    ({ width, height } = await probeVideo(file.buffer));
  } catch (_) {}

  try {
    await extractFrame(storedPath, thumbPath);
  } catch (err) {
    await sharp({
      create: { width: THUMB_SIZE, height: THUMB_SIZE, channels: 3, background: '#111' }
    }).jpeg().toFile(thumbPath);
  }

  return {
    originalName: file.originalname,
    storedName,
    thumbName,
    type:   'webm',
    size:   file.size,
    width,
    height
  };
}

async function processVideo(file, boardUri) {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(`File too large (max ${config.uploads.maxVideoMb} MB for video)`);
  }

  const dir      = boardDir(boardUri);
  const tmpName  = uniqueName('mp4');
  const outName  = uniqueName('mp4');
  const thumbName = 's_' + outName.replace('.mp4', '.jpg');
  const tmpPath  = path.join(dir, tmpName);
  const outPath  = path.join(dir, outName);
  const thumbPath = path.join(dir, thumbName);

  // Write original to disk so ffmpeg can read it
  fs.writeFileSync(tmpPath, file.buffer);

  let width = 0, height = 0;
  try {
    ({ width, height } = await probeVideo(file.buffer));
  } catch (_) {}

  // Re-encode with compression
  try {
    await reencodeVideo(tmpPath, outPath);
  } finally {
    // Always clean up the temp input
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  // Extract thumbnail from re-encoded file
  try {
    await extractFrame(outPath, thumbPath);
  } catch (err) {
    await sharp({
      create: { width: THUMB_SIZE, height: THUMB_SIZE, channels: 3, background: '#111' }
    }).jpeg().toFile(thumbPath);
  }

  const stat = fs.statSync(outPath);

  return {
    originalName: file.originalname,
    storedName:  outName,
    thumbName,
    type:   'mp4',
    size:   stat.size,
    width,
    height
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function processUpload(file, boardUri) {
  if (!file) return null;

  if (file.mimetype === 'video/webm') return processWebm(file, boardUri);
  if (file.mimetype === 'video/mp4')  return processVideo(file, boardUri);
  return processImage(file, boardUri);
}

module.exports = { processUpload, MAX_BYTES, MAX_VIDEO_BYTES, ALLOWED_MIME };
