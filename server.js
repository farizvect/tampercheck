'use strict';
// tampercheck - self-hosted hardware-wallet board inspector.
// Zero dependencies: node:http + global fetch (Node >= 18).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { observe, observeStream, MODEL } = require('./lib/vision');
const { buildReport, localize } = require('./lib/rules');
const signer = require('./lib/sign');
const store = require('./lib/store');

const PORT = Number(process.env.TC_PORT || 8787);
const HOST = process.env.TC_HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');

const devices = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
const KINDS = rules.anomalies.filter((a) => !a.rule_only).map((a) => a.kind);

// Reports are cached by device + photo hash. The reference data and the rule taxonomy take part
// in that hash, so editing either one retires the old reports instead of serving a verdict that
// was produced by different rules.
const REVISION = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(DATA, 'rules.json')))
  .update(fs.readFileSync(path.join(DATA, 'devices.json')))
  .digest('hex').slice(0, 16);

const MAX_IMAGES = 3;
const MAX_BODY = 24 * 1024 * 1024;
const DAILY_LIMIT = Number(process.env.TC_DAILY_LIMIT || 40);

const bucket = new Map(); // ip -> {n, day}
function dayKey() { return new Date().toISOString().slice(0, 10); }
function rateOk(ip) {
  const d = dayKey();
  const cur = bucket.get(ip);
  if (!cur || cur.day !== d) { bucket.set(ip, { n: 1, day: d }); return true; }
  if (cur.n >= DAILY_LIMIT) return false;
  cur.n++;
  return true;
}

function resolveDevice(brandId, modelId) {
  const brand = (devices.brands || []).find((b) => b.id === brandId);
  if (!brand) return null;
  const model = (brand.models || []).find((m) => m.id === modelId);
  if (!model) return null;
  return {
    brandId: brand.id, brandName: brand.name, modelId: model.id, modelName: model.name,
    chips: model.chips || [], expect: model.expect || [], forbid: model.forbid || [],
    notes: model.notes || '', officialCheck: brand.officialCheck, support: brand.support,
  };
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validDataUrl(s) {
  if (typeof s !== 'string') return false;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return false;
  return Buffer.from(m[2], 'base64').length > 64;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function parseAnalyze(body) {
  const device = resolveDevice(body && body.brand, body && body.model);
  if (!device) return { error: 'unknown_device' };
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length || images.length > MAX_IMAGES) return { error: 'image_count' };
  for (const im of images) if (!validDataUrl(im && im.data)) return { error: 'bad_image' };
  const lang = typeof body.lang === 'string' && /^[a-z]{2}$/.test(body.lang) ? body.lang : null;
  return { device, images, lang };
}

// Hash each photo as it was submitted. Stored in the report so a result can be tied back to
// the exact images it was based on; the photos themselves are still not kept.
function photoDigests(images) {
  return images.map((im) => {
    const raw = Buffer.from(String(im.data).split(',')[1] || '', 'base64');
    return {
      side: im.side || 'front',
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      bytes: raw.length,
    };
  });
}

// Build, sign and store a report.
//
// The stored report is always worded in English: the facts it holds do not depend on language,
// and the signature covers those facts. The requested language is applied on the way out, so a
// report can be re-worded later without calling the model again.
function finalize({ device, out, images }) {
  const report = buildReport({
    device, observations: out.observations, taxonomy: rules, verdicts: rules.verdicts,
    model: out.model, elapsedMs: out.elapsedMs, photos: photoDigests(images),
  });
  const signature = signer.sign(report);
  if (signature) report.signature = signature;
  const id = store.save(report);
  return { report, id };
}

// Re-word for the requested language, and mark cache state.
function present(report, id, { lang, device, cached }) {
  const deviceRef = device || resolveDevice(report.device && report.device.brand, report.device && report.device.model);
  return { ...localize(report, rules, lang, deviceRef), id, cached: Boolean(cached) };
}

async function analyze(req, res, ip) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return send(res, 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'bad_json' });
  }
  const parsed = parseAnalyze(body);
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const { device, images, lang } = parsed;

  const fp = store.fingerprint(device, images, REVISION);
  const hit = store.findCached(fp);
  if (hit) return send(res, 200, { ...present(hit, hit.id, { lang, device, cached: true }), server_ms: 0 });

  if (!rateOk(ip)) return send(res, 429, { error: 'daily_limit' });

  const started = Date.now();
  let out;
  try {
    out = await observe(device, KINDS, images.map((im, i) => ({ n: i + 1, side: im.side || 'front', data: im.data })));
  } catch (err) {
    return send(res, 502, { error: 'analysis_failed', detail: String(err.message || err).slice(0, 200) });
  }
  const { report, id } = finalize({ device, out, images });
  store.rememberCached(fp, id);
  send(res, 200, { ...present(report, id, { lang, device, cached: false }), server_ms: Date.now() - started });
}

// Server-sent-events variant of /api/analyze. The vision call is streamed and each stage is
// forwarded, so the page can show the model working instead of an opaque 20-second wait.
// The report itself is identical to the JSON endpoint - this changes the delivery, not the result.
async function analyzeStream(req, res, ip) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return send(res, 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'bad_json' });
  }
  const parsed = parseAnalyze(body);
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const { device, images, lang } = parsed;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  let open = true;
  const sse = (ev) => { if (open) res.write('data: ' + JSON.stringify(ev) + '\n\n'); };
  const stop = () => { open = false; clearInterval(beat); };
  // Keeps intermediaries from closing an idle connection while the model is still thinking.
  const beat = setInterval(() => { if (open) res.write(': keep-alive\n\n'); }, 15000);
  const ctl = new AbortController();
  req.on('close', () => { stop(); ctl.abort(); });

  try {
    const fp = store.fingerprint(device, images, REVISION);
    const hit = store.findCached(fp);
    if (hit) { sse({ phase: 'done', report: { ...present(hit, hit.id, { lang, device, cached: true }), server_ms: 0 } }); return; }

    if (!rateOk(ip)) { sse({ phase: 'error', error: 'daily_limit' }); return; }

    const started = Date.now();
    sse({ phase: 'queued', device: device.brandName + ' ' + device.modelName, photos: images.length });

    let out;
    try {
      out = await observeStream(device, KINDS,
        images.map((im, i) => ({ n: i + 1, side: im.side || 'front', data: im.data })),
        (ev) => sse(ev), ctl.signal);
    } catch (err) {
      sse({ phase: 'error', error: 'analysis_failed', detail: String(err.message || err).slice(0, 200) });
      return;
    }
    sse({ phase: 'verdict', ms: Date.now() - started });

    const { report, id } = finalize({ device, out, images });
    store.rememberCached(fp, id);
    sse({ phase: 'done', report: { ...present(report, id, { lang, device, cached: false }), server_ms: Date.now() - started } });
  } catch (err) {
    sse({ phase: 'error', error: 'internal', detail: String(err.message || err).slice(0, 200) });
  } finally {
    stop();
    res.end();
  }
}

function sharePage(res, rec) {
  const r = rec.report;
  const title = `${r.device.name}: ${r.stamp} · tampercheck`;
  const rows = r.findings.map((f) => `<li><b>[${f.severity}] ${esc(f.title)}</b><br>${esc(f.detail)}</li>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<style>body{background:#0b0b0b;color:#e6e6e6;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:2rem;max-width:760px}
h1{font-size:1.15rem;margin:0 0 .25rem}b{color:#fff}ul{padding-left:1.1rem}li{margin:.6rem 0}
.v{display:inline-block;border:2px solid #999;padding:.2rem .6rem;margin:.5rem 0}
.bad{border-color:#e05252;color:#ff9c9c}.ok{border-color:#4caf7d;color:#9ce0b8}.warn{border-color:#c9a227;color:#e8d27a}
small{color:#8a8a8a}a{color:#cfcfcf}</style></head><body>
<h1>${esc(r.device.name)} · ${esc(rec.created.slice(0, 16).replace('T', ' '))} UTC</h1>
<div class="v ${esc(r.tone)}">${esc(r.stamp)}</div>
<p>${esc(r.meaning)}</p>
${rows ? `<ul>${rows}</ul>` : '<p>No anomalies listed.</p>'}
<p><small>Model: ${esc(r.model)} · quality: ${esc(r.photo_quality)} · photos are not stored.
<a href="/">Check your own wallet</a></small></p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  res.end(html);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'x').toString();
  const p = url.pathname;

  try {
    if (p === '/api/status') return send(res, 200, { state: 'open', model: MODEL, daily_limit: DAILY_LIMIT });
    if (p === '/api/devices') return send(res, 200, devices);
    if (p === '/api/pubkey') return send(res, 200, signer.publicInfo());
    if (p === '/api/analyze') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const wantsStream = /text\/event-stream/.test(req.headers.accept || '');
      return wantsStream ? await analyzeStream(req, res, ip) : await analyze(req, res, ip);
    }
    const mReport = /^\/api\/report\/([a-z0-9]{4,32})$/.exec(p);
    if (mReport) {
      const rec = store.load(mReport[1]);
      if (!rec) return send(res, 404, { error: 'not_found' });
      const lang = url.searchParams.get('lang');
      return send(res, 200, present(rec.report, rec.id, { lang, cached: true }));
    }
    // One-call verification: does this stored report carry a valid signature from this instance?
    const mVerify = /^\/api\/verify\/([a-z0-9]{4,32})$/.exec(p);
    if (mVerify) {
      const rec = store.load(mVerify[1]);
      if (!rec) return send(res, 404, { error: 'not_found' });
      const info = signer.publicInfo();
      if (!info.enabled) return send(res, 200, { id: mVerify[1], verified: false, reason: 'signing_disabled' });
      return send(res, 200, { id: mVerify[1], ...signer.verify(rec.report, info.public_key_pem), key_id: info.key_id });
    }
    const mShare = /^\/r\/([a-z0-9]{4,32})$/.exec(p);
    if (mShare) {
      const rec = store.load(mShare[1]);
      if (!rec) return send(res, 404, 'not found');
      const lang = url.searchParams.get('lang');
      return sharePage(res, { ...rec, report: present(rec.report, rec.id, { lang, cached: true }) });
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    if (p.startsWith('/assets/')) return serveStatic(res, p.slice(1));
    return send(res, 404, 'not found');
  } catch (err) {
    send(res, 500, { error: 'internal', detail: String(err.message || err).slice(0, 200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`tampercheck on http://${HOST}:${PORT}  model=${MODEL}  devices=${devices.brands.reduce((n, b) => n + b.models.length, 0)}`);
});
