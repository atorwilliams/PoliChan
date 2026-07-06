'use strict';

// One-off scrub: strip metadata (EXIF/XMP/IPTC, mp4 GPS atoms) from every
// file already in public/uploads. Uploads made before the media.js fix kept
// their metadata; this re-encodes images (sharp default = strip everything)
// and copy-remuxes videos with -map_metadata -1 (no quality loss).
//
// Run from the app root: node scripts/scrubUploadMetadata.js
// Safe to re-run; already-clean files just get re-processed to the same state.

const path   = require('path');
const fs     = require('fs');
const sharp  = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

if (process.platform === 'win32') {
  const FFMPEG_DIR = path.join('C:', 'Users', 'justt', 'Documents', 'ffmpeg-7.1.1-essentials_build', 'bin');
  ffmpeg.setFfmpegPath(path.join(FFMPEG_DIR, 'ffmpeg.exe'));
  ffmpeg.setFfprobePath(path.join(FFMPEG_DIR, 'ffprobe.exe'));
}

const UPLOADS_ROOT = path.join(__dirname, '../public/uploads');

function remux(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(['-map_metadata', '-1', '-c', 'copy'])
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function scrubFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tmp = filePath + '.scrub' + ext;   // keep the extension so ffmpeg picks the right muxer

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const buf = await fs.promises.readFile(filePath);
    const meta = await sharp(buf).metadata();
    if (!meta.exif && !meta.xmp && !meta.iptc) return 'clean';
    await sharp(buf).rotate().toFile(tmp);
    await fs.promises.rename(tmp, filePath);
    return 'scrubbed';
  }

  if (ext === '.gif') {
    const buf = await fs.promises.readFile(filePath);
    await sharp(buf, { animated: true }).gif().toFile(tmp);
    await fs.promises.rename(tmp, filePath);
    return 'scrubbed';
  }

  if (['.mp4', '.webm'].includes(ext)) {
    await remux(filePath, tmp);
    await fs.promises.rename(tmp, filePath);
    return 'scrubbed';
  }

  return 'skipped';
}

async function main() {
  const counts = { scrubbed: 0, clean: 0, skipped: 0, failed: 0 };

  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );

  const files = walk(UPLOADS_ROOT);
  console.log(`${files.length} files under ${UPLOADS_ROOT}`);

  for (const f of files) {
    try {
      const result = await scrubFile(f);
      counts[result]++;
      if (result === 'scrubbed') console.log('scrubbed', path.relative(UPLOADS_ROOT, f));
    } catch (err) {
      counts.failed++;
      console.error('FAILED', path.relative(UPLOADS_ROOT, f), '-', err.message);
      // leave any partial tmp file cleanup to the catch-all below
      try { fs.readdirSync(path.dirname(f)).forEach(n => { if (n.includes('.scrub')) fs.unlinkSync(path.join(path.dirname(f), n)); }); } catch (_) {}
    }
  }

  console.log('Done.', JSON.stringify(counts));
}

main().catch(err => { console.error(err); process.exit(1); });
