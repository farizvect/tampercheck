'use strict';
// Compare candidate vision models on the real pipeline (same prompt, same rules).
//   node tools/model_compare.js <model> <image> [image...]
// Prints one line per image: verdict, findings, chips read, seconds.
const fs = require('fs');
const path = require('path');
const { observe } = require('../lib/vision');
const { buildReport } = require('../lib/rules');

const DATA = path.join(__dirname, '..', 'data');
const devices = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
const KINDS = rules.anomalies.filter((a) => !a.rule_only).map((a) => a.kind);

function device(brandId, modelId) {
  const b = devices.brands.find((x) => x.id === brandId);
  const m = b.models.find((x) => x.id === modelId);
  return {
    brandId: b.id, brandName: b.name, modelId: m.id, modelName: m.name,
    chips: m.chips || [], expect: m.expect || [], forbid: m.forbid || [],
    notes: m.notes || '', officialCheck: b.officialCheck, support: b.support,
  };
}

function dataUrl(p) {
  const ext = path.extname(p).toLowerCase().replace('.', '');
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
}

(async () => {
  const [model, ...specs] = process.argv.slice(2);
  for (const spec of specs) {
    const [brandId, modelId, imgPath] = spec.split('|');
    const dev = device(brandId, modelId);
    const t0 = Date.now();
    let out;
    try {
      out = await observe(dev, KINDS, [{ n: 1, side: 'front', data: dataUrl(imgPath) }], null, model);
    } catch (e) {
      console.log(JSON.stringify({ model, img: path.basename(imgPath), error: String(e.message).slice(0, 120) }));
      continue;
    }
    const rep = buildReport({
      device: dev, observations: out.observations, taxonomy: rules, verdicts: rules.verdicts,
      model: out.model, elapsedMs: Date.now() - t0, photos: [],
    });
    console.log(JSON.stringify({
      model, img: path.basename(imgPath), verdict: rep.verdict,
      findings: rep.findings.map((f) => f.kind),
      chips: (out.observations.chips || []).map((c) => c.id + '=' + (c.part_marking || '?') + (c.readable ? '' : '(unread)')),
      quality: rep.photo_quality, secs: Math.round((Date.now() - t0) / 100) / 10,
      usage: out.usage ? out.usage.completion_tokens : null,
    }));
  }
})();
