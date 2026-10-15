'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.TC_REPORT_DIR || path.join(__dirname, '..', 'data', 'reports');
fs.mkdirSync(DIR, { recursive: true });

// Reports hold observations and findings only - never the photos.
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

module.exports = { save, load, fingerprint, findCached, rememberCached, DIR };
