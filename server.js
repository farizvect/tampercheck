'use strict';
// tampercheck - self-hosted hardware-wallet board inspector.
// Zero dependencies: node:http + global fetch (Node >= 18).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { observe, observeStream, probe, balance, MODEL } = require('./lib/vision');
const { buildReport, localize } = require('./lib/rules');
const signer = require('./lib/sign');
const store = require('./lib/store');
const budget = require('./lib/budget');
const byok = require('./lib/byok');

const PORT = Number(process.env.TC_PORT || 8787);
const HOST = process.env.TC_HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');

const devices = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
const KINDS = rules.anomalies.filter((a) => !a.rule_only).map((a) => a.kind);

// Every part number the reference data documents, for any model. Used to tell a genuinely swapped
// chip (the marking is a real part of another model) from a marking the model probably misread.
const KNOWN_PARTS = devices.brands
  .flatMap((b) => b.models)
  .flatMap((m) => m.chips || [])
  .flatMap((c) => (Array.isArray(c.part) ? c.part : [c.part]))
  .filter(Boolean);

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

// Hash each photo as it was submitted. Stored in the report so a result can be tied back to the
// exact images it was based on, and so a stored photo can be checked against what the report is
// about: if the two disagree, the picture is not the one this report describes.
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
    model: out.model, elapsedMs: out.elapsedMs, photos: photoDigests(images), knownParts: KNOWN_PARTS,
  });
  const signature = signer.sign(report);
  if (signature) report.signature = signature;
  const id = store.save(report);
  // Kept so the permalink can show what a finding was about. Storing the picture does not change
  // what is signed: the report still covers the digests, and a stored photo is only shown if it
  // hashes to the digest the signature covers.
  store.savePhotos(id, images);
  return { report, id };
}

// The stored photo for a report, but only while it still hashes to the digest the report carries.
// That digest is part of the signed facts, so a file that no longer matches is not the picture this
// report is about, and is treated as absent rather than shown.
function verifiedPhoto(id, n, digest) {
  const kept = store.loadPhoto(id, n);
  if (!kept || !digest) return null;
  let buf;
  try { buf = fs.readFileSync(kept.path); } catch { return null; }
  if (crypto.createHash('sha256').update(buf).digest('hex') !== digest.sha256) return null;
  return { ...kept, buf };
}

// Re-word for the requested language, and mark cache state.
function present(report, id, { lang, device, cached }) {
  const deviceRef = device || resolveDevice(report.device && report.device.brand, report.device && report.device.model);
  const out = localize(report, rules, lang, deviceRef);
  // A report describes itself: where its photos are still kept and still match, it says where to
  // fetch them. Otherwise the entry stays as a digest, and the page says so.
  out.photos = (out.photos || []).map((p, i) => {
    const f = verifiedPhoto(id, i + 1, p);
    return f ? { ...p, url: `/r/${id}/p/${i + 1}.${f.ext}` } : p;
  });
  return { ...out, id, cached: Boolean(cached) };
}

// A cache hit still has the photos in hand, so a report whose pictures were pruned - or which
// predates keeping them - gets them back rather than staying a text-only page. A hit means the
// fingerprint matched, so these are the exact images the report is about.
function ensurePhotos(id, images) {
  const digest = (images && images.length) ? photoDigests(images)[0] : null;
  if (!images.length || verifiedPhoto(id, 1, digest)) return;
  store.savePhotos(id, images);
}

async function analyze(req, res, ip) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return send(res, 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'bad_json' });
  }
  const parsed = parseAnalyze(body);
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const { device, images, lang } = parsed;

  // A visitor who brought a key pays for their own call, so the deployment's budget is not consulted
  // and not charged. The per-IP daily limit still applies: it is about how hard one caller may lean
  // on this instance, which is true whether or not they paid for the model call.
  let own;
  try { own = await byok.fromRequest(req); } catch (e) { return send(res, 400, { error: e.message }); }

  const fp = store.fingerprint(device, images, REVISION);
  const hit = store.findCached(fp);
  if (hit) {
    ensurePhotos(hit.id, images);
    return send(res, 200, { ...present(hit, hit.id, { lang, device, cached: true }), server_ms: 0 });
  }

  // Checked after the cache lookup and before the model call: a cached report costs nothing, so a
  // spent budget must not stop one being served.
  if (!own) {
    const b = await budget.status();
    if (b.exhausted) return send(res, 503, { error: 'budget_exhausted', budget: b });
  }

  if (!rateOk(ip)) return send(res, 429, { error: 'daily_limit' });

  const started = Date.now();
  let out;
  try {
    out = await observe(device, KINDS, images.map((im, i) => ({ n: i + 1, side: im.side || 'front', data: im.data })), null, own || undefined);
  } catch (err) {
    return send(res, 502, { error: 'analysis_failed', detail: String(err.message || err).slice(0, 200) });
  }
  if (!own) budget.record(out.usage);
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

  // Resolved before the stream headers go out, so a malformed credential is a plain 400 rather than
  // an error frame in a stream the client has already committed to.
  let own;
  try { own = await byok.fromRequest(req); } catch (e) { return send(res, 400, { error: e.message }); }

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
    if (hit) {
      ensurePhotos(hit.id, images);
      sse({ phase: 'done', report: { ...present(hit, hit.id, { lang, device, cached: true }), server_ms: 0 } });
      return;
    }

    if (!rateOk(ip)) { sse({ phase: 'error', error: 'daily_limit' }); return; }

    // Same rule as the JSON path: a cache hit is free, a model call is not, and a visitor's own key
    // means it is not this deployment's money.
    if (!own) {
      const b = await budget.status();
      if (b.exhausted) { sse({ phase: 'error', error: 'budget_exhausted', budget: b }); return; }
    }

    const started = Date.now();
    sse({ phase: 'queued', device: device.brandName + ' ' + device.modelName, photos: images.length });

    let out;
    try {
      out = await observeStream(device, KINDS,
        images.map((im, i) => ({ n: i + 1, side: im.side || 'front', data: im.data })),
        (ev) => sse(ev), ctl.signal, own || undefined);
    } catch (err) {
      sse({ phase: 'error', error: 'analysis_failed', detail: String(err.message || err).slice(0, 200) });
      return;
    }
    if (!own) budget.record(out.usage);
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

// The permalink page. Server-rendered, so a shared link shows the whole result without the app, and
// so the photos can be shown with the boxes drawn on them: a finding that says "a second board" is
// much easier to judge when you can see which board. A photo is only shown when it is still stored
// and still hashes to the digest the report carries (see servePhoto).
function sharePage(res, rec) {
  const r = rec.report;
  const id = rec.id;
  const title = `${r.device.name}: ${r.stamp} · tampercheck`;

  // Numbers are assigned the way the app assigns them - photo by photo, findings in report order -
  // so number 3 means the same finding here as it does in the app. `p.url` was set by present()
  // and only exists while the stored file still matches the digest, so a photo that was pruned or
  // altered simply has no source and the page shows the hash instead of a broken picture.
  const photos = (r.photos || []).map((p, i) => ({ ...p, n: i + 1, src: p.url || null }));
  const nums = new Map();
  let k = 0;
  for (const ph of photos) {
    for (const f of r.findings) if (Number(f.image) === ph.n && f.box) { k += 1; nums.set(f, k); }
  }

  const findings = r.findings.length
    ? `<ul class="findings">${r.findings.map((f) => `<li data-sev="${esc(f.severity)}">
<div class="fhead">${nums.has(f) ? `<span class="fnum ${esc(f.severity)}">${nums.get(f)}</span>` : ''}<span class="ftitle">${esc(f.title)}</span><span class="tag sev-${esc(f.severity)}">${esc(f.severity)}</span><span class="tag${f.source === 'rule' ? ' rule' : ''}">${esc(f.source)}</span></div>
<div class="fdetail">${esc(f.detail)}</div>
<div class="fwhere">photo ${esc(f.image)} · ${esc(f.region)}</div></li>`).join('')}</ul>`
    : '<p class="fine">No anomalies listed.</p>';

  const marked = photos.filter((p) => p.src).map((p) => {
    const hits = r.findings.filter((f) => Number(f.image) === p.n && f.box);
    const svg = hits.length
      ? `<svg class="boxes" aria-hidden="true">${hits.map((f) => {
          const b = f.box, x = pct(b.left), y = pct(b.top);
          return `<rect x="${x}" y="${y}" width="${pct(b.right - b.left)}" height="${pct(b.bottom - b.top)}" class="box ${esc(f.severity)}"/>`
            + `<text x="${x}" y="${y}" dx="0.35em" dy="1.05em" class="boxnum ${esc(f.severity)}">${nums.get(f)}</text>`;
        }).join('')}</svg>`
      : '';
    return `<figure class="annot"><div class="annot-wrap"><img src="${p.src}" alt="photo ${p.n}, ${esc(p.side)}">${svg}</div>
<figcaption class="fine">photo ${p.n} · ${esc(p.side)}</figcaption></figure>`;
  }).join('');

  const chips = (r.chips || []).length
    ? `<table><thead><tr><th>chip</th><th>marking read</th><th>legible</th><th>where</th></tr></thead><tbody>${
        r.chips.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.part_marking || '—')}</td><td>${c.readable === false ? 'no' : 'yes'}</td><td>${esc(c.region || '—')}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="fine">No chips recorded.</p>';

  const parts = (r.components || []).length
    ? `<h3>parts seen</h3><ul class="plain">${r.components.map((c) => `<li>${esc(`${c.name || c.marking || '?'}${c.status ? ' — ' + c.status : ''}`)}</li>`).join('')}</ul>`
    : '';
  const text = (r.visible_text || []).length
    ? `<h3>text visible in the photo</h3>${r.visible_text.map((v) => `<blockquote>${esc(typeof v === 'string' ? v : v.text)}</blockquote>`).join('')}`
    : '';
  const hashes = (r.photos || []).length
    ? `<h3>photos this report is based on</h3><table><thead><tr><th>side</th><th>sha256</th><th>bytes</th></tr></thead><tbody>${
        r.photos.map((p) => `<tr><td>${esc(p.side)}</td><td class="sha">${esc(p.sha256)}</td><td class="num">${esc(p.bytes)}</td></tr>`).join('')
      }</tbody></table><p class="fine">${photos.some((p) => p.src)
        ? 'The pictures above are the ones that were submitted, and each is checked against its hash before it is shown, so what you see is what this report is about.'
        : 'No picture is shown: either it is no longer kept on this instance, or the stored file no longer matches the hash the report carries. A picture that does not match is not shown, because it would not be the one this report is about. The hashes above still stand.'}</p>`
    : '';
  const sig = r.signature
    ? `<h3>signature</h3><p class="fine">ed25519, key ${esc(r.signature.key_id)}. It covers the findings, the chip readings and the photo hashes, not the wording. <a href="/api/verify/${esc(id)}">verify this report</a>.</p>`
    : '';
  const tips = (r.retake_tips || []).length
    ? `<h3>for a better result</h3><ul class="plain">${r.retake_tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<style>
:root{--ink:#ececec;--mid:#c2c2c2;--dim:#9a9a9a;--faint:#8a8a8a;--line:#2e2e2e;--line-2:#444;--bad:#e05252;--warn:#c9a227;--ok:#4caf7d}
body{background:#0b0b0b;color:var(--ink);font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:2rem 1.2rem;max-width:820px}
h1{font-size:1.05rem;margin:0 0 .2rem;font-weight:600}
h3{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mid);margin:1.6rem 0 .5rem;font-weight:600}
p{margin:.5rem 0}.fine{color:var(--dim);font-size:12px}.num{text-align:right}
.v{display:inline-block;border:2px solid #999;padding:.25rem .7rem;margin:.7rem 0 .3rem;font-weight:600}
.bad{border-color:var(--bad);color:#ff9c9c}.ok{border-color:var(--ok);color:#9ce0b8}.warn{border-color:var(--warn);color:#e8d27a}
.meta{color:var(--mid);font-size:12.5px}
ul{padding-left:1.1rem;margin:.4rem 0}li{margin:.55rem 0}
ul.plain{list-style:none;padding-left:0}
ul.findings{list-style:none;padding-left:0}
ul.findings .fhead{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.fnum{display:inline-flex;align-items:center;justify-content:center;min-width:1.25rem;height:1.25rem;border:1px solid var(--line-2);font-size:11px}
.fnum.high{color:var(--bad);border-color:var(--bad)}.fnum.medium{color:var(--warn);border-color:var(--warn)}
.ftitle{color:#fff;font-weight:600}
.tag{font-size:10.5px;color:var(--dim);border:1px solid var(--line-2);padding:0 .35rem}
.tag.sev-high{color:var(--bad);border-color:var(--bad)}.tag.sev-medium{color:var(--warn);border-color:var(--warn)}
.tag.rule{color:var(--warn);border-color:var(--warn)}
.fdetail{color:var(--mid);margin-top:.2rem}.fwhere{color:var(--faint);font-size:11.5px}
.marked{display:grid;gap:1.15rem;margin-top:.5rem}
figure.annot{margin:0}
.annot-wrap{position:relative;line-height:0;border:1px solid var(--line-2)}
.annot-wrap img{display:block;width:100%;height:auto}
.boxes{position:absolute;inset:0;width:100%;height:100%}
.box{fill:none;stroke:var(--bad);stroke-width:2}
.box.medium{stroke:var(--warn)}.box.low{stroke:var(--dim)}
.boxnum{fill:var(--bad);font:600 13px ui-monospace,monospace}
.boxnum.medium{fill:var(--warn)}.boxnum.low{fill:var(--mid)}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600}
td.sha{word-break:break-all;font-size:11px;color:var(--mid)}
blockquote{border-left:3px solid var(--line-2);margin:.5rem 0;padding:.35rem .8rem;color:var(--mid)}
.disclaimer{border-top:1px solid var(--line);margin-top:1.6rem;padding-top:.9rem}
a{color:#cfcfcf}
</style></head><body>
<h1>${esc(r.device.name)}</h1>
<p class="meta">${esc(rec.created.slice(0, 16).replace('T', ' '))} UTC · quality ${esc(r.photo_quality)}${r.photo_quality_reason ? ` (${esc(r.photo_quality_reason)})` : ''} · ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'} · model ${esc(r.model)}</p>
<div class="v ${esc(r.tone)}">${esc(r.stamp)}</div>
<p>${esc(r.meaning)}</p>
${r.injection_suspected ? '<p class="bad">Text in the photo appears to address the checker rather than describe the device. Treat the result with suspicion.</p>' : ''}
<h3>findings</h3>
${findings}
${marked ? `<h3>where they are</h3><p class="fine">Each box is where the model said it saw that finding, drawn over the photo it was given. The coordinates come from the model, so a box is a place to look, not a proven location.</p><div class="marked">${marked}</div>` : ''}
<h3>summary</h3>
<p>${esc(r.summary)}</p>
${tips}
<h3>detail</h3>
${chips}${parts}${text}${hashes}${sig}
<div class="disclaimer">
<h3>what this report is not</h3>
<ul class="plain">
<li>It reads only what the photo shows. An implant hidden under the screen, painted to match the board, or too small to resolve will not appear here.</li>
<li>A clean result does not mean the device is safe. It means nothing was visible in these photos.</li>
<li>A photograph cannot verify the secure element, and the manufacturer's own genuine check cannot detect physical additions either. Run it, and treat it as one input rather than an answer.</li>
<li>Not affiliated with, or endorsed by, any wallet manufacturer.</li>
</ul>
</div>
<p class="fine"><a href="/">Check your own wallet</a> · tampercheck, self-hosted.</p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  res.end(html);
}

// A stored photo is served only if it still hashes to the digest the report carries. That digest is
// part of the signed facts, so this is what ties the picture to the report: edit the file on disk
// and the link stops showing it, rather than showing a picture the report never described.
function servePhoto(res, rec, n) {
  const digest = (rec.report.photos || [])[n - 1];
  if (!digest) return send(res, 404, 'not found');
  const kept = store.loadPhoto(rec.id, n);
  if (!kept) return send(res, 404, 'not found');
  const ok = verifiedPhoto(rec.id, n, digest);
  if (!ok) return send(res, 409, { error: 'photo_changed' });
  res.writeHead(200, {
    'content-type': MIME['.' + ok.ext] || 'application/octet-stream',
    'cache-control': 'private, max-age=600',
    'x-robots-tag': 'noindex',
  });
  res.end(ok.buf);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Boxes are fractions of the photo, and SVG takes them as percentages. Rounded to two decimals so
// a coordinate does not turn into 30.000000000000004%.
const pct = (v) => (Math.round(v * 10000) / 100) + '%';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'x').toString();
  const p = url.pathname;

  try {
    if (p === '/api/status') return send(res, 200, { state: 'open', model: MODEL, daily_limit: DAILY_LIMIT, budget: await budget.status() });
    if (p === '/api/devices') return send(res, 200, devices);
    if (p === '/api/pubkey') return send(res, 200, signer.publicInfo());
    // Check a visitor's key, model and endpoint before they rely on them. The credential arrives in
    // a header, is used for this call, and is not stored or echoed: the response describes what the
    // provider said, never what was sent.
    if (p === '/api/model-check') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      let own;
      try { own = await byok.fromRequest(req); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!own) return send(res, 400, { error: 'byok_key_required' });
      if (!rateOk(ip)) return send(res, 429, { error: 'daily_limit' });
      let result;
      try {
        result = await probe(own);
      } catch (err) {
        return send(res, 502, { error: 'check_failed', detail: String(err.message || err).slice(0, 200) });
      }
      // What the key has left is a bonus: it only means something on a provider that reports it, so
      // a provider that does not must not turn a working check into a failure.
      let bal = null;
      try { bal = await balance(own); } catch { bal = null; }
      return send(res, 200, { ...result, balance: bal, endpoint: own.vetted ? 'custom' : 'this instance' });
    }
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
    // The photos a permalink shows, served only while they still match the report's digests.
    const mPhoto = /^\/r\/([a-z0-9]{4,32})\/p\/([0-9]{1,2})(?:\.[a-z0-9]+)?$/.exec(p);
    if (mPhoto) {
      const rec = store.load(mPhoto[1]);
      if (!rec) return send(res, 404, 'not found');
      return servePhoto(res, rec, Number(mPhoto[2]));
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
