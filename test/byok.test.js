#!/usr/bin/env node
'use strict';
// What a visitor is allowed to supply, and what the deployment must never do with it.
//
// The rule under test that matters most: a custom endpoint without a key is REFUSED. If it were
// allowed, the request would go out with the deployment's own key attached to a host the visitor
// chose - which is a way to be handed the operator's credential. Every other check here is a
// convenience; that one is the safety property.
const assert = require('assert');

// Set before require: the module reads the endpoint flag at call time, but keeping the environment
// settled makes the test order-independent.
delete process.env.TC_ALLOW_CUSTOM_ENDPOINT;

const byok = require('../lib/byok');
const vision = require('../lib/vision');

const KEY = 'sk-or-v1-' + 'a'.repeat(64);
const req = (headers) => ({ headers });

let n = 0, failed = 0;
async function test(name, fn) {
  n += 1;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function throws(fn, code) {
  try { await fn(); }
  catch (e) { assert.strictEqual(e.message, code, `expected ${code}, got ${e.message}`); return; }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

(async () => {
  console.log('byok - who supplies what');

  await test('no headers means no credential, and the deployment pays', async () => {
    assert.strictEqual(await byok.fromRequest(req({})), null);
  });

  await test('a key alone is accepted, with no model override', async () => {
    const c = await byok.fromRequest(req({ 'x-tc-key': KEY }));
    assert.strictEqual(c.key, KEY);
    assert.strictEqual(c.model, null);
    assert.strictEqual(c.vetted, null, 'no endpoint was named, so the operator\'s is used');
  });

  await test('a key with a model override is accepted', async () => {
    const c = await byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-model': 'openai/gpt-4o-mini:free' }));
    assert.strictEqual(c.model, 'openai/gpt-4o-mini:free');
  });

  await test('a model without a key is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-model': 'openai/gpt-4o' })), 'byok_key_required');
  });

  // The safety property.
  await test('a custom endpoint without a key is refused, not defaulted', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-base-url': 'https://example.com/v1' })),
      'byok_endpoint_needs_key');
  });

  await test('a custom endpoint pointing at loopback is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'http://127.0.0.1:9119/v1' })),
      'endpoint_private');
  });

  await test('a custom endpoint pointing at cloud metadata is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'http://169.254.169.254/latest/meta-data' })),
      'endpoint_private');
  });

  await test('a custom endpoint pointing at a private range is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'http://10.0.0.5:8080/v1' })),
      'endpoint_private');
  });

  await test('a custom endpoint pointing at the operator\'s own tailnet address is refused', async () => {
    // 100.64/10 is CGNAT, which is what a tailnet uses.
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'http://100.64.0.1:9119/' })),
      'endpoint_private');
  });

  await test('a custom endpoint with a bad scheme is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'file:///etc/passwd' })),
      'endpoint_scheme');
  });

  await test('a custom endpoint carrying credentials is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'https://u:p@example.com/v1' })),
      'endpoint_credentials');
  });

  await test('a public custom endpoint is vetted and pinned', async () => {
    const c = await byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'https://93.184.216.34/v1' }));
    assert.ok(c.vetted, 'a public endpoint should be accepted');
    assert.strictEqual(c.vetted.address.address, '93.184.216.34', 'the address must be pinned');
  });

  await test('a public custom endpoint is refused when the operator turned the feature off', async () => {
    process.env.TC_ALLOW_CUSTOM_ENDPOINT = '0';
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'https://93.184.216.34/v1' })),
      'byok_endpoint_disabled');
    delete process.env.TC_ALLOW_CUSTOM_ENDPOINT;
  });

  console.log('\nbyok - malformed input');
  await test('a malformed model id is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-model': 'not a model id!!' })), 'byok_model_invalid');
  });
  await test('a model id with a newline is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-model': 'a/b\nX' })), 'byok_model_invalid');
  });
  await test('a key containing whitespace is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': 'sk-or-v1-bad key' })), 'byok_key_invalid');
  });
  await test('an over-long key is refused', async () => {
    await throws(() => byok.fromRequest(req({ 'x-tc-key': 'k'.repeat(500) })), 'byok_key_invalid');
  });
  await test('a valid-looking model id shape is accepted', async () => {
    for (const m of ['google/gemini-3.8-flash', 'openai/gpt-4o-mini:free', 'meta-llama/llama-3.1-70b-instruct',
                     'local-model', 'a/b/c']) {
      const c = await byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-model': m }));
      assert.strictEqual(c.model, m);
    }
  });

  console.log('\nbyok - what is reported back');
  await test('describe() reports the shape of the credential, never the credential', async () => {
    const c = await byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-model': 'a/b' }));
    const d = byok.describe(c);
    const blob = JSON.stringify(d);
    assert.ok(!blob.includes(KEY), 'describe() leaked the key');
    assert.ok(!blob.includes('sk-or-v1'), `describe() carried key material: ${blob}`);
    assert.deepStrictEqual(d, { byok: true, model: 'a/b', custom_endpoint: false });
  });
  await test('describe() does not include a custom endpoint URL', async () => {
    const c = await byok.fromRequest(req({ 'x-tc-key': KEY, 'x-tc-base-url': 'https://93.184.216.34/v1' }));
    const blob = JSON.stringify(byok.describe(c));
    assert.ok(!blob.includes('93.184.216.34'), `describe() leaked the endpoint: ${blob}`);
    assert.ok(!blob.includes('/v1'), `describe() leaked the endpoint path: ${blob}`);
    assert.strictEqual(byok.describe(c).custom_endpoint, true);
  });
  await test('describe(null) says the deployment is paying', async () => {
    assert.deepStrictEqual(byok.describe(null), { byok: false, model: null, custom_endpoint: false });
  });

  console.log('\nbyok - the pairing, enforced where the two values meet');
  // lib/byok.js refuses to produce a vetted endpoint without a key. creds() checks it again, because
  // that is where the key is finally chosen: without the check, a caller that passed a vetted
  // endpoint and no key would get `|| KEY` - the deployment's credential - attached to a host the
  // visitor named. The pairing is the safety property, so it is asserted at both ends.
  await test('a vetted endpoint with no key is refused rather than defaulted', async () => {
    const vetted = { url: new URL('https://93.184.216.34/v1'), host: '93.184.216.34', address: { address: '93.184.216.34', family: 4 } };
    await throws(() => { vision.creds({ vetted, key: '' }); }, 'byok_endpoint_without_key');
  });
  await test('a vetted endpoint with a key is allowed', async () => {
    const vetted = { url: new URL('https://93.184.216.34/v1'), host: '93.184.216.34', address: { address: '93.184.216.34', family: 4 } };
    const c = vision.creds({ vetted, key: KEY });
    assert.strictEqual(c.key, KEY, 'the visitor key must be the one used');
    assert.strictEqual(c.vetted, vetted);
  });
  await test('no vetted endpoint falls back to the deployment key', async () => {
    const c = vision.creds({ key: KEY });
    assert.strictEqual(c.key, KEY);
    assert.strictEqual(c.vetted, null);
  });
  await test('the deployment key is never paired with a vetted endpoint', async () => {
    // Whatever else happens, these two must not travel together.
    const vetted = { url: new URL('https://93.184.216.34/v1'), host: '93.184.216.34', address: { address: '93.184.216.34', family: 4 } };
    let threw = false;
    try { vision.creds({ vetted, key: '' }); } catch { threw = true; }
    assert.ok(threw, 'creds() must not produce { key: <deployment>, vetted }');
  });

  console.log(`\n${n} byok tests done - ${failed ? `${failed} FAILED` : 'all passed'}`);
  process.exitCode = failed ? 1 : 0;
})();
