#!/usr/bin/env node
'use strict';
// The endpoint guard. This is the part that decides what a visitor can make the server fetch, so it
// gets tested from both directions: the addresses that must be refused, and the ones that must not
// be refused by mistake (an over-eager blocklist that also blocks real providers is a broken feature,
// not a safe one).
const assert = require('assert');
const dns = require('dns');
const { isPrivate, parse, resolve, vet, routePath, BAD_NAMES } = require('../lib/endpoint');

let n = 0, failed = 0;
function test(name, fn) {
  n += 1;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function atest(name, fn) {
  n += 1;
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  console.log('endpoint guard - what is refused');

  // Every range that is not a public destination.
  const privateV4 = [
    '0.0.0.0', '0.1.2.3',            // this network
    '10.0.0.1', '10.255.255.255',    // private
    '100.64.0.1', '100.127.255.255', // CGNAT
    '127.0.0.1', '127.1.2.3',        // loopback
    '169.254.0.1', '169.254.169.254', // link-local, incl. cloud metadata
    '172.16.0.1', '172.31.255.255',  // private
    '192.0.0.1',                     // IETF assignments
    '192.168.0.1', '192.168.255.255', // private
    '198.18.0.1', '198.19.255.255',  // benchmarking
    '198.51.100.1', '203.0.113.1',   // TEST-NET
    '224.0.0.1', '239.255.255.255',  // multicast
    '240.0.0.1', '255.255.255.255',  // reserved
  ];
  for (const ip of privateV4) {
    test(`refuses ${ip}`, () => assert.ok(isPrivate(ip), `${ip} should be private`));
  }

  const privateV6 = [
    '::', '::1', '::2',
    'fc00::1', 'fd12:3456::1',       // unique local
    'fe80::1', 'febf::1',            // link-local
    'ff02::1',                       // multicast
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', // v4-mapped, dotted
    '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe',             // v4-mapped, normalised hex
    '64:ff9b::7f00:1',               // NAT64
    '2001:db8::1',                   // documentation
    '2001::1',                       // Teredo
    '2002:7f00:0001::',              // 6to4 wrapping 127.0.0.1
    '2002:0a00:0001::',              // 6to4 wrapping 10.0.0.1
    '2002:a9fe:a9fe::',              // 6to4 wrapping 169.254.169.254
  ];
  for (const ip of privateV6) {
    test(`refuses ${ip}`, () => assert.ok(isPrivate(ip), `${ip} should be private`));
  }

  // And the public ones must get through, or the feature does not work.
  const publicIPs = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '169.253.255.255', '169.255.0.1',
    '192.167.255.255', '192.169.0.1', '223.255.255.255', '198.20.0.1', '198.50.0.1',
    '2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1',
  ];
  for (const ip of publicIPs) {
    test(`allows ${ip}`, () => assert.ok(!isPrivate(ip), `${ip} should be public`));
  }

  console.log('\nendpoint guard - the URL itself');
  test('refuses localhost by name', () => assert.strictEqual(parse('http://localhost:8787/v1').error, 'endpoint_private'));
  test('refuses a subdomain of localhost', () => assert.strictEqual(parse('http://api.localhost/v1').error, 'endpoint_private'));
  test('refuses .internal', () => assert.strictEqual(parse('http://vault.internal/v1').error, 'endpoint_private'));
  test('refuses .local (mDNS)', () => assert.strictEqual(parse('http://printer.local/v1').error, 'endpoint_private'));
  test('refuses cloud metadata by name', () => assert.strictEqual(parse('http://metadata.google.internal/x').error, 'endpoint_private'));
  test('refuses a private literal', () => assert.strictEqual(parse('http://10.0.0.1/v1').error, 'endpoint_private'));
  test('refuses a v4-mapped literal', () => assert.strictEqual(parse('http://[::ffff:127.0.0.1]/v1').error, 'endpoint_private'));
  // The URL parser normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so the literal check cannot match
  // the dotted form; these two cover the expanded shape in both of its spellings.
  test('refuses a v4-mapped literal in normalised form', () => assert.strictEqual(parse('http://[::ffff:7f00:1]/v1').error, 'endpoint_private'));
  // IPv4-translated puts the ffff one group earlier than IPv4-mapped. Matching only the mapped
  // shape left this form open while the comment above the check claimed to cover it.
  test('refuses a v4-translated literal', () => assert.strictEqual(parse('http://[::ffff:0:127.0.0.1]/v1').error, 'endpoint_private'));
  test('refuses a v4-translated literal in normalised form', () => assert.strictEqual(parse('http://[::ffff:0:7f00:1]/v1').error, 'endpoint_private'));
  test('refuses a v4-translated literal pointing at a private range', () => assert.strictEqual(parse('http://[::ffff:0:10.0.0.1]/v1').error, 'endpoint_private'));
  test('still allows a v4-translated literal pointing somewhere public',
    () => assert.strictEqual(parse('http://[::ffff:0:1.1.1.1]/v1').error, undefined));
  // The literal check uses the bracket-stripped host, so the normalised shapes are the ones that
  // actually arrive.
  test('refuses a normalised v4-mapped metadata literal', () => assert.strictEqual(parse('http://[::ffff:a9fe:a9fe]/v1').error, 'endpoint_private'));
  // Node keeps the brackets on an IPv6 hostname, so these are the cases that would slip past a
  // literal check that used url.hostname directly.
  test('refuses a bracketed loopback literal', () => assert.strictEqual(parse('http://[::1]/v1').error, 'endpoint_private'));
  test('refuses a bracketed unspecified literal', () => assert.strictEqual(parse('http://[::]/v1').error, 'endpoint_private'));
  test('refuses a bracketed unique-local literal', () => assert.strictEqual(parse('http://[fd00::1]/v1').error, 'endpoint_private'));
  test('refuses a bracketed link-local literal', () => assert.strictEqual(parse('http://[fe80::1]/v1').error, 'endpoint_private'));
  test('refuses a bracketed 6to4-wrapped loopback', () => assert.strictEqual(parse('http://[2002:7f00:0001::]/v1').error, 'endpoint_private'));
  test('accepts a bracketed public IPv6 literal', () => {
    const p = parse('http://[2606:4700::1111]:8080/v1');
    assert.ok(p.url, `expected a URL, got ${p.error}`);
    assert.strictEqual(p.host, '2606:4700::1111', 'the brackets must be stripped for the check and the connection');
  });
  test('refuses file://', () => assert.strictEqual(parse('file:///etc/passwd').error, 'endpoint_scheme'));
  test('refuses ftp://', () => assert.strictEqual(parse('ftp://example.com/x').error, 'endpoint_scheme'));
  test('refuses gopher://', () => assert.strictEqual(parse('gopher://example.com/x').error, 'endpoint_scheme'));
  test('refuses credentials in the URL', () => assert.strictEqual(parse('https://user:pw@example.com/v1').error, 'endpoint_credentials'));
  test('refuses a non-URL', () => assert.strictEqual(parse('not a url').error, 'endpoint_invalid'));
  test('refuses an empty endpoint', () => assert.strictEqual(parse('').error, 'endpoint_empty'));
  test('refuses an over-long endpoint', () => assert.strictEqual(parse('https://example.com/' + 'a'.repeat(400)).error, 'endpoint_too_long'));
  test('accepts a public https endpoint', () => {
    const p = parse('https://openrouter.ai/api/v1');
    assert.ok(p.url, `expected a URL, got ${p.error}`);
    assert.strictEqual(p.url.hostname, 'openrouter.ai');
  });
  test('accepts a public endpoint on a custom port', () => {
    const p = parse('http://93.184.216.34:8080/v1');
    assert.ok(p.url, `expected a URL, got ${p.error}`);
  });

  console.log('\nendpoint guard - resolution');
  await atest('a name that resolves to loopback is refused', async () => {
    // localhost is in /etc/hosts on any normal machine, so this needs no network.
    const r = await resolve('localhost');
    assert.ok(r.error === 'endpoint_private', `expected endpoint_private, got ${JSON.stringify(r)}`);
  });
  await atest('a name that does not resolve is refused, not allowed', async () => {
    const r = await resolve('definitely-not-a-real-host-' + Date.now() + '.invalid');
    assert.ok(r.error === 'endpoint_unresolvable', `expected endpoint_unresolvable, got ${JSON.stringify(r)}`);
  });
  await atest('a public literal resolves to itself without DNS', async () => {
    const r = await resolve('93.184.216.34');
    assert.strictEqual(r.addresses[0].address, '93.184.216.34');
  });
  await atest('vet returns a pinned address for a public endpoint', async () => {
    const v = await vet('https://93.184.216.34/v1');
    assert.ok(v.address && v.address.address === '93.184.216.34', JSON.stringify(v));
    assert.strictEqual(v.url.hostname, '93.184.216.34');
  });
  await atest('vet refuses a private endpoint end to end', async () => {
    const v = await vet('http://127.0.0.1:9119/');
    assert.strictEqual(v.error, 'endpoint_private');
  });

  console.log('\nendpoint guard - the route on a vetted endpoint');
  // A visitor's endpoint is often a proxy in front of a provider, so it carries a path of its own.
  // Replacing that path instead of appending to it sends the call to the right host and the wrong
  // route, which fails in a way that looks like the visitor's mistake.
  test('appends the route to an endpoint that has a path', () =>
    assert.strictEqual(routePath({ url: new URL('https://proxy.example.com/openai/v1') }, '/chat/completions'),
      '/openai/v1/chat/completions'));
  test('appends to a bare host', () =>
    assert.strictEqual(routePath({ url: new URL('https://api.example.com') }, '/chat/completions'),
      '/chat/completions'));
  test('appends to a root path', () =>
    assert.strictEqual(routePath({ url: new URL('https://api.example.com/') }, '/chat/completions'),
      '/chat/completions'));
  test('does not double the slash on a trailing-slash path', () =>
    assert.strictEqual(routePath({ url: new URL('https://api.example.com/v1/') }, '/chat/completions'),
      '/v1/chat/completions'));
  test('keeps a deeper prefix', () =>
    assert.strictEqual(routePath({ url: new URL('https://gw.example.com/a/b/c') }, '/chat/completions'),
      '/a/b/c/chat/completions'));
  await atest('the route is what a vetted endpoint ends up carrying', async () => {
    const v = await vet('https://93.184.216.34/openai/v1');
    assert.strictEqual(v.error, undefined, JSON.stringify(v));
    assert.strictEqual(routePath(v, '/chat/completions'), '/openai/v1/chat/completions');
  });

  console.log('\nendpoint guard - blocklist shape');
  test('the name blocklist matches what it claims', () => {
    for (const h of ['localhost', 'a.localhost', 'x.internal', 'y.local', 'metadata']) {
      assert.ok(BAD_NAMES.test(h), `${h} should be blocked`);
    }
    for (const h of ['openrouter.ai', 'api.openai.com', 'my-provider.example.com']) {
      assert.ok(!BAD_NAMES.test(h), `${h} should not be blocked`);
    }
  });

  console.log(`\n${n} endpoint tests done - ${failed ? `${failed} FAILED` : 'all passed'}`);
  process.exitCode = failed ? 1 : 0;
})();
