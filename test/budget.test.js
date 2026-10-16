#!/usr/bin/env node
'use strict';
// The spend guard: what it reports, when it refuses, and that it never hands back the key.
//
// The provider read is pointed at a port nothing listens on, so these exercise the local-ledger
// fallback. That is the path that runs when OpenRouter cannot be reached, which is exactly when a
// guard that quietly assumed there was budget would do the most damage.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-budget-'));
process.env.TC_REPORT_DIR = TMP;
process.env.TC_BUDGET_FILE = path.join(TMP, 'budget.json');
process.env.TC_BUDGET_USD = '5';
process.env.TC_BUDGET_TTL_MS = '0';
// A key that is not real: if it ever appeared in an output object, the assert below would catch it.
const FAKE_KEY = 'sk-or-v1-notarealkeynotarealkeynotarealkey';
process.env.TC_API_KEY = FAKE_KEY;
process.env.TC_BASE_URL = 'http://127.0.0.1:9/v1';

const budget = require('../lib/budget');

let n = 0;
const test = (name, fn) => {
  n += 1;
  return fn().then(() => console.log(`  ok  ${name}`), (e) => {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  });
};

const spent = () => JSON.parse(fs.readFileSync(path.join(TMP, 'budget.json'), 'utf8'));

(async () => {
  console.log('budget guard');

  await test('a fresh instance has the whole cap', async () => {
    const s = await budget.status();
    assert.strictEqual(s.cap_usd, 5);
    assert.strictEqual(s.spent_usd, 0);
    assert.strictEqual(s.remaining_usd, 5);
    assert.strictEqual(s.exhausted, false);
    assert.strictEqual(s.source, 'local', 'unreachable provider must fall back to the ledger');
  });

  await test('nothing is blocked while there is room', async () => {
    assert.strictEqual(await budget.blocked(), null);
  });

  await test('recording a cost moves the remaining figure', async () => {
    const cost = budget.record({ cost: 4.5, prompt_tokens: 10, completion_tokens: 2 });
    assert.strictEqual(cost, 4.5);
    const s = await budget.status();
    assert.strictEqual(s.spent_usd, 4.5);
    assert.strictEqual(s.remaining_usd, 0.5);
    assert.strictEqual(s.exhausted, false);
  });

  await test('crossing the cap reports exhausted and refuses', async () => {
    budget.record({ cost: 0.6 });
    const s = await budget.status();
    assert.ok(s.remaining_usd < 0, `expected a negative remainder, got ${s.remaining_usd}`);
    assert.strictEqual(s.exhausted, true);
    const why = await budget.blocked();
    assert.ok(why && /budget_exhausted/.test(why), `expected a refusal, got ${why}`);
  });

  await test('a call with no cost reported counts as a call, not as spend', async () => {
    const before = spent();
    budget.record(null);
    const after = spent();
    assert.strictEqual(after.calls, before.calls + 1);
    assert.strictEqual(after.spent, before.spent, 'an unknown cost must not be guessed at');
  });

  await test('the cap is configurable, and a zero cap is not a way to skip the guard', async () => {
    process.env.TC_BUDGET_USD = '0';
    const s = await budget.status();
    assert.strictEqual(s.cap_usd, 0);
    assert.strictEqual(s.exhausted, true);
    process.env.TC_BUDGET_USD = '5';
  });

  await test('an unreadable ledger closes the guard rather than assuming room', async () => {
    fs.writeFileSync(path.join(TMP, 'budget.json'), 'not json at all');
    const s = await budget.status();
    assert.strictEqual(s.exhausted, true, 'a damaged ledger must not read as a full budget');
    assert.strictEqual(s.source, 'ledger-unreadable');
    assert.ok(await budget.blocked(), 'and it must refuse');
    fs.unlinkSync(path.join(TMP, 'budget.json'));
  });

  await test('a missing ledger is a fresh install, not a damaged one', async () => {
    const s = await budget.status();
    assert.strictEqual(s.exhausted, false);
    assert.strictEqual(s.remaining_usd, 5);
    assert.strictEqual(s.source, 'local');
  });

  await test('a ledger that cannot be written stops the guard counting', async () => {
    // A directory in the ledger's place: the write fails, and the guard must not keep spending.
    const asDir = path.join(TMP, 'unwritable');
    fs.mkdirSync(asDir);
    process.env.TC_BUDGET_FILE = asDir;
    budget.record({ cost: 0.01 });
    const s = await budget.status();
    assert.strictEqual(s.exhausted, true, 'spend we cannot record must not be spend we ignore');
    assert.strictEqual(s.source, 'ledger-unreadable');
    process.env.TC_BUDGET_FILE = path.join(TMP, 'budget.json');
  });

  await test('no output ever contains the key', async () => {
    const s = await budget.status();
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes(FAKE_KEY), 'status() leaked the key');
    assert.ok(!blob.includes('sk-or-v1'), `status() carried key material: ${blob}`);
  });

  console.log(`\n${n} budget tests done - ${process.exitCode ? 'FAILURES' : 'all passed'}`);
  fs.rmSync(TMP, { recursive: true, force: true });
})();
