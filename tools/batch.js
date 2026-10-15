#!/usr/bin/env node
'use strict';
// Batch inspections for a pile of photos.
//
//   node tools/batch.js --dir ./photos --brand ledger --model nano-x
//   node tools/batch.js --manifest cases.csv --out ./reports
//
// With --manifest the CSV has a header and three columns: file,brand,model
// (brand and model may be left empty on a row to fall back to --brand/--model).
//
// Writes one JSON report per photo plus summary.json, and prints a one-line verdict per photo
// so a run over fifty boards is readable at a glance.

const fs = require('fs');
const path = require('path');

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function parseArgs(argv) {
  const out = { base: process.env.TC_TEST_BASE || 'http://127.0.0.1:8787', out: './batch-out', dir: null, manifest: null, brand: null, model: null, side: 'front' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--base') out.base = val();
    else if (a === '--out') out.out = val();
    else if (a === '--dir') out.dir = val();
    else if (a === '--manifest') out.manifest = val();
    else if (a === '--brand') out.brand = val();
    else if (a === '--model') out.model = val();
    else if (a === '--side') out.side = val();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `batch inspection

  node tools/batch.js --dir <photos> --brand <brand> --model <model> [--out <dir>]
  node tools/batch.js --manifest <cases.csv> [--out <dir>]

options
  --base <url>   server to talk to (default $TC_TEST_BASE or http://127.0.0.1:8787)
  --out <dir>    where reports are written (default ./batch-out)
  --side <name>  photo side to label each image as (default front)

manifest CSV
  header row required, columns: file,brand,model
  brand/model may be blank to use --brand/--model
`;

function listImages(dir) {
  return fs.readdirSync(dir)
    .filter((f) => MIME_BY_EXT[path.extname(f).toLowerCase()])
    .sort()
    .map((f) => path.join(dir, f));
}

function readManifest(file, fallback) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.slice(1).map((line) => {
    const [f, brand, model] = line.split(',').map((s) => (s || '').trim());
    return { file: f, brand: brand || fallback.brand, model: model || fallback.model };
  });
  return rows;
}

async function analyze(base, row, side) {
  const ext = path.extname(row.file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  const data = 'data:' + mime + ';base64,' + fs.readFileSync(row.file).toString('base64');
  const body = { brand: row.brand, model: row.model, images: [{ side, data }] };
  const res = await fetch(base + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error + (out.detail ? ` (${out.detail})` : ''));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.dir && !args.manifest)) {
    console.log(HELP);
    return args.help ? 0 : 2;
  }

  let rows;
  if (args.manifest) {
    rows = readManifest(args.manifest, args);
    rows = rows.map((r) => ({ ...r, file: path.resolve(r.file) }));
  } else {
    if (!args.brand || !args.model) {
      console.error('--dir needs --brand and --model (or use --manifest)');
      return 2;
    }
    rows = listImages(args.dir).map((file) => ({ file, brand: args.brand, model: args.model }));
  }
  if (!rows.length) {
    console.error('no photos found');
    return 2;
  }

  fs.mkdirSync(args.out, { recursive: true });
  const summary = [];
  let failed = 0;

  for (const row of rows) {
    const name = path.basename(row.file);
    try {
      const rep = await analyze(args.base, row, args.side);
      const dest = path.join(args.out, name.replace(/\.[^.]+$/, '') + '.json');
      fs.writeFileSync(dest, JSON.stringify(rep, null, 1));
      const top = rep.findings && rep.findings.length ? ` | ${rep.findings.map((f) => f.kind).join(',')}` : '';
      console.log(`${rep.verdict.padEnd(22)} ${name}${top}`);
      summary.push({ file: name, brand: row.brand, model: row.model, verdict: rep.verdict, id: rep.id, findings: (rep.findings || []).map((f) => f.kind) });
    } catch (e) {
      failed++;
      console.log(`${'ERROR'.padEnd(22)} ${name}  ${e.message}`);
      summary.push({ file: name, brand: row.brand, model: row.model, error: e.message });
    }
  }

  fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify({ base: args.base, count: rows.length, failed, results: summary }, null, 1));

  const counts = summary.reduce((acc, r) => { const k = r.verdict || 'error'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   '));
  console.log(`reports in ${args.out}`);
  return failed ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(1); });
