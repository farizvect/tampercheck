'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.TC_REPORT_DIR || path.join(__dirname, '..', 'data', 'reports');
fs.mkdirSync(DIR, { recursive: true });

// Photos are kept beside the report, and this is not optional: a permalink that claims a verdict
// about a device has to show the picture that verdict was reached from, or the claim cannot be
// checked. They are separate files rather than fields in the report JSON, because the report is
// re-served as JSON every time the wording changes language and a megabyte of base64 inside it
// would be paid for on each of those.
const PHOTO_DIR = path.join(DIR, 'photos');
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO_EXTS = ['jpg', 'png', 'webp'];

// A stored report holds the observations, the findings and the photo digests, never the photos
// inline: the pictures live beside it as files (see savePhotos).
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function newId(len = 12) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

function save(report) {
  const id = newId();
  const rec = { id, created: new Date().toISOString(), report };
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(rec));
  return id;
}

// Writes the submitted photos for a report, in submission order, so photo n on the page is the
// image the model called image n. These are the exact bytes that were sent to the model, which is
// also what the report hashed, so the picture a permalink shows can be checked against the digest
// the report carries. Returns how many were written.
function savePhotos(id, images) {
  if (!Array.isArray(images)) return 0;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  let n = 0;
  for (const im of images) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(String((im && im.data) || ''));
    if (!m) continue;
    const ext = EXT[String(m[1]).toLowerCase()] || 'jpg';
    try {
      fs.writeFileSync(path.join(PHOTO_DIR, `${id}-${++n}.${ext}`), Buffer.from(m[2], 'base64'));
    } catch { n -= 1; }
  }
  prunePhotos();
  return n;
}

// Photos are kept, so disk use grows with use. The cap is off unless an operator asks for one:
// losing the picture a permalink is about would defeat the point of keeping them, so this is a
// deliberate choice rather than a default. When it is set, the oldest sets go first, and a report
// whose pictures went still shows its verdict, its findings and its photo hashes.
function prunePhotos() {
  const mb = Number(process.env.TC_PHOTO_BUDGET_MB);
  if (!Number.isFinite(mb) || mb <= 0) return;
  const budget = mb * 1024 * 1024;
  let files;
  try { files = fs.readdirSync(PHOTO_DIR); } catch { return; }
  const stats = [];
  for (const f of files) {
    try { const st = fs.statSync(path.join(PHOTO_DIR, f)); stats.push({ f, size: st.size, mtime: st.mtimeMs }); }
    catch { /* vanished mid-listing */ }
  }
  let total = stats.reduce((s, x) => s + x.size, 0);
  if (total <= budget) return;
  stats.sort((a, b) => a.mtime - b.mtime);
  for (const x of stats) {
    if (total <= budget) break;
    try { fs.unlinkSync(path.join(PHOTO_DIR, x.f)); total -= x.size; } catch { /* already gone */ }
  }
}

// The photo for a report, if it is still stored. Returns null when it was pruned or never kept.
function loadPhoto(id, n) {
  if (!/^[a-z0-9]{4,32}$/.test(String(id || ''))) return null;
  if (!/^[0-9]{1,2}$/.test(String(n || ''))) return null;
  for (const ext of PHOTO_EXTS) {
    const p = path.join(PHOTO_DIR, `${id}-${n}.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}

function load(id) {
  if (!/^[a-z0-9]{4,32}$/.test(String(id || ''))) return null;
  const p = path.join(DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Cache: identical photos + same device must not be checked twice. The revision is the hash of
// the rule taxonomy and the reference data, so changing either invalidates old reports - a
// cached verdict produced by different rules would be a stale claim about a device.
function fingerprint(device, images, revision = '') {
  const h = crypto.createHash('sha256');
  h.update('v1:' + revision + '\n');
  h.update(device.brandId + '/' + device.modelId + '\n');
  for (const im of images) {
    h.update(im.side + ':');
    h.update(crypto.createHash('sha256').update(im.data).digest());
  }
  return h.digest('hex');
}

function findCached(fp) {
  const idx = path.join(DIR, '_index.json');
  let map = {};
  if (fs.existsSync(idx)) { try { map = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { map = {}; } }
  const id = map[fp];
  if (!id) return null;
  const rec = load(id);
  return rec && rec.report ? { ...rec.report, cached: true, id } : null;
}

function rememberCached(fp, id) {
  const idx = path.join(DIR, '_index.json');
  let map = {};
  if (fs.existsSync(idx)) { try { map = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { map = {}; } }
  map[fp] = id;
  fs.writeFileSync(idx, JSON.stringify(map));
}

module.exports = { save, load, savePhotos, loadPhoto, fingerprint, findCached, rememberCached, DIR };
