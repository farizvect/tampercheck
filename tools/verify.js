#!/usr/bin/env node
'use strict';
// Verify a report signature without trusting the server that produced it.
//
//   node tools/verify.js <report-id|report.json> [base-url]
//
// With an id it fetches the report and the public key from the server and checks that the
// signature covers the report body. With a file it checks the report against a key you pass
// with --key, or fetches the key from the base url.
//
// Exit code 0 = signature valid, 1 = not valid, 2 = could not check.

const fs = require('fs');
const { verify, canonical, signedPayload } = require('../lib/sign');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const keyFlag = args.indexOf('--key');
  const baseArg = args.find((a, i) => i > 0 && !a.startsWith('--') && a !== target);
  if (!target) {
    console.log('usage: node tools/verify.js <report-id|report.json> [base-url] [--key public.pem]');
    return 2;
  }

  let report, publicPem;
  const isFile = fs.existsSync(target);
  const base = (baseArg || process.env.TC_TEST_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');

  try {
    if (isFile) {
      const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
      report = raw.report || raw; // accept both a stored record and a bare report
      publicPem = keyFlag >= 0 ? fs.readFileSync(args[keyFlag + 1], 'utf8') : (await getJson(base + '/api/pubkey')).public_key_pem;
    } else {
      const rec = await getJson(`${base}/api/report/${target}`);
      report = rec.report || rec;
      publicPem = (await getJson(base + '/api/pubkey')).public_key_pem;
    }
  } catch (e) {
    console.log('could not load:', e.message);
    return 2;
  }

  if (!publicPem) {
    console.log('no public key available (signing disabled on the server?)');
    return 2;
  }

  const result = verify(report, publicPem);
  const id = report.id || target;
  if (result.ok) {
    console.log(`VALID   ${id}  (key ${result.key_id})`);
    console.log(`        verdict: ${report.verdict}  device: ${report.device && report.device.name}`);
    if (report.photos && report.photos.length) {
      for (const p of report.photos) console.log(`        photo ${p.side}: sha256 ${p.sha256}`);
    }
    return 0;
  }
  console.log(`INVALID ${id}  (${result.reason})`);
  if (result.reason === 'bad_signature') {
    console.log('        the signed facts do not match the signature: the report was edited after signing');
    console.log('        canonical facts length: ' + canonical(signedPayload(report)).length);
  }
  return 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
