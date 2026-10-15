'use strict';
// Detached Ed25519 signatures for reports.
//
// Why: a report is a claim about a physical device. If it is shown to a seller or used in a
// dispute, plain text proves nothing - anyone can write the same JSON. A signature ties the
// report to the instance that produced it.
//
// The key is generated on first use and kept next to the reports. Nothing leaves the machine.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_KEY = path.join(__dirname, '..', 'data', 'report-signing-key.pem');
const KEY_PATH = process.env.TC_SIGNING_KEY || DEFAULT_KEY;

// Deterministic serialisation: object keys sorted, no whitespace, no escaping of non-ASCII.
// A verifier in any language can reproduce these exact bytes, which is what makes the
// signature checkable outside this codebase.
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return 'null';
}

function keyId(publicPem) {
  return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

let cached = null;

function loadKey() {
  if (cached !== null) return cached;
  try {
    if (!fs.existsSync(KEY_PATH)) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
      fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    cached = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
  } catch {
    cached = false; // signing unavailable; reports are still produced, just unsigned
  }
  return cached;
}

function publicPem(key) {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
}

function publicInfo() {
  const key = loadKey();
  if (!key) return { enabled: false };
  const pem = publicPem(key);
  return { enabled: true, algorithm: 'ed25519', key_id: keyId(pem), public_key_pem: pem };
}

// The signature covers the FACTS of a report, not its prose or its delivery metadata.
//
// Which language the report is worded in does not change what was observed: the verdict, which
// findings fired, their severities, the chip markings that were read, and the hashes of the
// photos. So the signature is taken over those, and the wording (stamp, meaning, summary, tip
// text, finding titles and details) is excluded. That lets the same report be served in any
// language while still verifying, and a verifier can re-derive the prose from the signed kinds.
//
// Delivery metadata is excluded too: the report id is assigned when it is stored, `cached` says
// whether this response came from the cache, and `server_ms` is a timing. None of them describe
// the device, and all of them differ between two responses carrying the same facts.
const EXCLUDED_KEYS = ['stamp', 'meaning', 'summary', 'retake_tips', 'signature', 'id', 'cached', 'server_ms'];
const EXCLUDED_FINDING_KEYS = ['title', 'detail'];

function signedPayload(report) {
  const out = {};
  for (const [k, v] of Object.entries(report || {})) {
    if (EXCLUDED_KEYS.includes(k)) continue;
    out[k] = v;
  }
  if (Array.isArray(report && report.findings)) {
    out.findings = report.findings.map((f) => {
      const g = {};
      for (const [k, v] of Object.entries(f)) if (!EXCLUDED_FINDING_KEYS.includes(k)) g[k] = v;
      return g;
    });
  }
  return out;
}

// Sign a report and return the detached signature. The caller attaches it AFTER signing, so
// the signature covers the facts only.
function sign(report) {
  const key = loadKey();
  if (!key) return null;
  try {
    const pem = publicPem(key);
    const value = crypto.sign(null, Buffer.from(canonical(signedPayload(report)), 'utf8'), key);
    return { algorithm: 'ed25519', key_id: keyId(pem), value: value.toString('base64'), covers: 'facts' };
  } catch {
    return null;
  }
}

// Used by tools/verify.js and the tests.
function verify(report, publicPemText) {
  const signature = report && report.signature;
  if (!signature || !signature.value) return { ok: false, reason: 'no_signature' };
  try {
    const key = crypto.createPublicKey(publicPemText);
    const ok = crypto.verify(null, Buffer.from(canonical(signedPayload(report)), 'utf8'), key, Buffer.from(signature.value, 'base64'));
    return ok ? { ok: true, key_id: signature.key_id } : { ok: false, reason: 'bad_signature' };
  } catch (e) {
    return { ok: false, reason: 'verify_error: ' + e.message };
  }
}

module.exports = { sign, verify, publicInfo, canonical, signedPayload, KEY_PATH };
