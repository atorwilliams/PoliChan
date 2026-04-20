'use strict';

// ── Word filter cache ──────────────────────────────────────────────────────────
// Loaded from DB at startup and after any admin mutation.
// process() is async so callers must await it.

let _cache = [];     // [{ word: String, replacement: String }]
let _loaded = false;

async function loadCache() {
  try {
    const WordFilter = require('../models/WordFilter');
    const rules = await WordFilter.find({ isActive: true }).lean();
    _cache = rules.map(r => ({ word: r.word, replacement: r.replacement }));
  } catch {
    _cache = [];
  }
  _loaded = true;
}

/** Force a cache reload — call this after any admin CRUD on word filter rules. */
async function reload() {
  await loadCache();
}

// ── HTML helpers ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyWordFilter(str) {
  let result = str;
  for (const { word, replacement } of _cache) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex,
      replacement ? `<span class="word-filtered">${replacement}</span>` : ''
    );
  }
  return result;
}

// ── Embed detection ────────────────────────────────────────────────────────────

const YT_RE      = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/g;
const CB_VIDEO   = /https?:\/\/files\.catbox\.moe\/\S+\.(?:mp4|webm)/gi;
const CB_AUDIO   = /https?:\/\/files\.catbox\.moe\/\S+\.mp3/gi;

function generateEmbeds(rawBody) {
  const parts = [];

  for (const m of rawBody.matchAll(YT_RE)) {
    const id = m[1];
    parts.push(
      `<div class="post-embed yt-embed">` +
      `<iframe src="https://www.youtube-nocookie.com/embed/${id}" ` +
      `frameborder="0" allowfullscreen loading="lazy" ` +
      `allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;fullscreen">` +
      `</iframe></div>`
    );
  }

  for (const m of rawBody.matchAll(CB_VIDEO)) {
    parts.push(`<div class="post-embed"><video src="${escapeHtml(m[0])}" controls loop preload="metadata"></video></div>`);
  }

  for (const m of rawBody.matchAll(CB_AUDIO)) {
    parts.push(`<div class="post-embed"><audio src="${escapeHtml(m[0])}" controls preload="metadata"></audio></div>`);
  }

  return parts.join('');
}

// ── Block-level tags (must run before line splitting) ─────────────────────────

function applyBlockTags(text) {
  // [code]...[/code] — preserve whitespace, skip further inline markup
  text = text.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, inner) =>
    `<pre><code>${inner.trim()}</code></pre>`
  );
  // [spoiler]...[/spoiler]
  text = text.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, (_, inner) =>
    `<span class="spoiler">${inner}</span>`
  );
  return text;
}

// ── Markup parsing ─────────────────────────────────────────────────────────────

function parseLine(line) {
  // Skip further inline markup inside pre/code blocks
  if (line.startsWith('<pre>') || line.startsWith('</pre>')) return line;

  // Greentext — line starts with >
  if (line.startsWith('&gt;') && !line.startsWith('&gt;&gt;')) {
    return `<span class="greentext">&gt;${line.slice(4)}</span>`;
  }

  // >>postId quote links
  line = line.replace(/&gt;&gt;(\d+)/g, (_, id) =>
    `<a class="quotelink" href="#p${id}">&gt;&gt;${id}</a>`
  );

  // Plain URLs → clickable links (http/https only, never javascript:/data:)
  line = line.replace(/https?:\/\/[^\s<>"]+/g, url => {
    const clean = url.replace(/[.,;:!?)]+$/, '');
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>`;
  });

  // **bold**
  line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ''italic'' (4chan style)
  line = line.replace(/''(.+?)''/g, '<em>$1</em>');

  // ~~strikethrough~~
  line = line.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // ==red text==
  line = line.replace(/==(.+?)==/g, '<span class="redtext">$1</span>');

  // `inline code`
  line = line.replace(/`(.+?)`/g, '<code>$1</code>');

  return line;
}

/**
 * Process raw post body into safe HTML.
 * Async because the word filter cache may need to be loaded first.
 */
async function process(body) {
  if (!_loaded) await loadCache();
  const escaped  = escapeHtml(body);
  const filtered = applyWordFilter(escaped);
  const blocked  = applyBlockTags(filtered);
  const lines    = blocked.split('\n');
  const bodyHtml = lines.map(parseLine).join('<br>');
  return bodyHtml + generateEmbeds(body);
}

/**
 * Extract quoted postIds from raw body (before HTML processing).
 */
function extractQuotes(body) {
  const matches = [...body.matchAll(/>>(\d+)/g)];
  return [...new Set(matches.map(m => parseInt(m[1])))];
}

module.exports = { process, extractQuotes, reload };
