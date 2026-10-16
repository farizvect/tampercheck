'use strict';
// A visitor-supplied endpoint, with the request-forgery surface closed as far as it can be closed.
//
// The request this makes carries the visitor's own credential to a host the visitor named. Two things
// must hold:
//
//   1. The deployment's own key never goes to a visitor-chosen host. If a custom endpoint is given
//      without a key, the request is refused rather than falling back to the server's key - otherwise
//      "point the endpoint at my server" would be a way to be handed the operator's credential.
//   2. The host must be somewhere a visitor is allowed to make this server reach. Loopback, private
//      ranges, link-local (which includes cloud metadata), CGNAT, multicast and the IPv6 equivalents
//      are refused, by literal and by resolved address.
//
// The resolved address is then PINNED for the actual connection. Checking the name and then fetching
// it would leave a rebinding window: a name that answers with a public address when checked and a
// private one a moment later. Pinning removes that window rather than documenting it away.
//
// Redirects are not followed. A custom endpoint that answered 302 to a private address would
// otherwise walk straight past the check above.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_URL = 300;
const MAX_HOSTS = 8; // resolved addresses considered; more than this is not a real endpoint

// Hostnames that name a place on the machine or the local network, whatever DNS says.
const BAD_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata|metadata\.google\.internal)$/i;

function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

// Every range that is not a public destination. Cloud metadata lives in 169.254/16, so blocking
// link-local matters on its own.
function isPrivateIPv4(ip) {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;          // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a === 169 && b === 254) return true;                    // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 192 && b === 0) return true;                      // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 198 && b === 51) return true;                     // TEST-NET-2
  if (a === 203 && b === 0) return true;                      // TEST-NET-3
  if (a >= 224) return true;                                  // multicast and reserved
  return false;
}

// An IPv6 address as its eight 16-bit groups, or null. Expanding first is what makes the embedded-v4
// forms checkable at all: the URL parser normalises `::ffff:127.0.0.1` to `::ffff:7f00:1`, so
// matching the dotted form textually would miss exactly the address that reaches loopback.
function expandIPv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  let tail = null;
  const dotted = /^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    tail = ipv4Parts(dotted[2]);
    if (!tail) return null;
    s = dotted[1];
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter(Boolean) : []) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length - (tail ? 2 : 0);
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (tail) {
    // A dotted quad is 4 bytes, which is two 16-bit groups, not four.
    groups = [...groups, ((tail[0] << 8) | tail[1]).toString(16), ((tail[2] << 8) | tail[3]).toString(16)];
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return false;
  const [a, b] = g;

  // ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated). In both, the last 32 bits
  // are a v4 destination, so it is judged as one - and the translated form puts the ffff one group
  // earlier than the mapped form, which is why matching only the mapped shape leaves it open.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
    return isPrivateIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  // The unspecified address and the loopback address, plus the deprecated v4-compatible range
  // (::x, of which only :: and ::1 are ever a real destination). Conservative on purpose.
  if (g.slice(0, 7).every((x) => x === 0)) return true;

  if ((a & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
  if (a === 0x2001 && b === 0x0000) return true; // 2001::/32 Teredo, a tunnel to a v4 host
  if (a === 0x0064 && b === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (a === 0x2002) {                          // 6to4 carries a v4 address in groups 1 and 2
    return isPrivateIPv4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`);
  }
  return false;
}

const isPrivate = (ip) => (net.isIPv6(ip) ? isPrivateIPv6(ip) : isPrivateIPv4(ip));

// Node keeps the brackets in `hostname` for an IPv6 literal (`new URL('http://[::1]/').hostname`
// is `[::1]`), and net.isIP does not accept them. Left as-is, every IPv6 literal would skip the
// literal check below - which is how a v4-mapped address like [::ffff:127.0.0.1] would reach
// loopback. Strip them once, here, and use the stripped form everywhere.
function hostOf(u) {
  const h = u.hostname || '';
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

// Parse and vet the URL itself. Returns { url, host } or { error }.
function parse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'endpoint_empty' };
  if (raw.length > MAX_URL) return { error: 'endpoint_too_long' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'endpoint_invalid' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'endpoint_scheme' };
  if (u.username || u.password) return { error: 'endpoint_credentials' };
  const host = hostOf(u);
  if (!host) return { error: 'endpoint_invalid' };
  if (BAD_NAMES.test(host)) return { error: 'endpoint_private' };
  if (net.isIP(host) && isPrivate(host)) return { error: 'endpoint_private' };
  return { url: u, host };
}

// Resolve, check every answer, and return the one to pin. All answers are checked, not just the
// first: a name with both a public and a private address must be refused, not raced.
async function resolve(hostname) {
  if (net.isIP(hostname)) return { addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { error: 'endpoint_unresolvable' };
  }
  if (!addrs.length) return { error: 'endpoint_unresolvable' };
  if (addrs.length > MAX_HOSTS) return { error: 'endpoint_unresolvable' };
  for (const a of addrs) if (isPrivate(a.address)) return { error: 'endpoint_private' };
  return { addresses: addrs };
}

// Full check: the URL, then what its name resolves to.
async function vet(raw) {
  const p = parse(raw);
  if (p.error) return p;
  const r = await resolve(p.host);
  if (r.error) return r;
  return { url: p.url, host: p.host, address: r.addresses[0] };
}

// A POST that can only reach the address that was vetted. The `lookup` override is the point: it
// answers with the pinned address regardless of what DNS says at connect time, so there is no window
// between the check and the connection. `servername` keeps TLS verification against the hostname, so
// pinning does not weaken the certificate check.
//
// Returns { status, ok, headers, text(), body } where body is an async iterable of Buffers. That is
// the shape both callers need: the streaming path iterates it, the plain path reads it whole.
function post(vetted, { path, headers, body, timeoutMs, signal }) {
  const u = vetted.url;
  const host = vetted.host; // bracket-stripped, so an IPv6 literal connects correctly
  const secure = u.protocol === 'https:';
  const lib = secure ? https : http;
  const payload = Buffer.from(body);
  const pinned = { address: vetted.address.address, family: vetted.address.family };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const req = lib.request({
      protocol: u.protocol,
      hostname: host,
      port: u.port || (secure ? 443 : 80),
      path,
      method: 'POST',
      headers: { ...headers, 'content-length': payload.length },
      servername: secure ? host : undefined,
      // The pin. Node calls this instead of resolving the name again.
      lookup: (host, opts, cb) => cb(null, pinned.address, pinned.family),
      timeout: timeoutMs,
    }, (res) => {
      settled = true;
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        return reject(new Error(`upstream_${res.statusCode}: the endpoint redirected, which is not followed`));
      }
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: res.headers,
        text: () => new Promise((ok, no) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
          res.on('error', no);
        }),
        body: res,
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    if (signal) {
      if (signal.aborted) return req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end(payload);
  });
}

// The route to call on a vetted endpoint. The endpoint a visitor names may carry a path of its own -
// `https://proxy.example.com/openai/v1` is a normal way to front a provider - so the route is
// appended to what they gave rather than replacing it. Dropping it would send the call to the wrong
// place on the right host.
function routePath(vetted, route) {
  const base = ((vetted && vetted.url && vetted.url.pathname) || '/').replace(/\/+$/, '');
  return base + route;
}

module.exports = { vet, post, routePath, isPrivate, parse, resolve, BAD_NAMES };
