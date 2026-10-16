'use strict';
// The spend ceiling for this deployment, in dollars, instance-wide.
//
// Two guards, and they are different things:
//
//   1. The key carries its own limit at OpenRouter. That is the one that cannot be bypassed: past
//      it every call fails upstream, whoever asks. This module reads it, so the app knows where the
//      line is instead of discovering it as a 402.
//   2. A local ledger of what this instance has spent, used when the provider cannot be reached.
//
// The cap is global on purpose. TC_DAILY_LIMIT is per visitor, which says nothing about what the
// deployment as a whole can afford.
//
// The key is read here the same way lib/vision.js reads it. It is never returned by anything in
// this module: the only values that leave are numbers and a boolean.

const fs = require('fs');
const path = require('path');

// Same resolution as lib/vision.js - keep the two in step.
const KEY = process.env.TC_API_KEY || process.env.OPENROUTER_API_KEY || '';
const BASE = (process.env.TC_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

const REPORT_DIR = process.env.TC_REPORT_DIR || path.join(__dirname, '..', 'data', 'reports');
// Read at call time, like the cap, so a test can point it elsewhere without reloading the module.
const ledgerPath = () => process.env.TC_BUDGET_FILE || path.join(REPORT_DIR, 'budget.json');

// Read at call time, not at import, so a test can set it before requiring this module.
const cap = () => {
  const n = Number(process.env.TC_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 5;
};

const PROVIDER_TTL_MS = Number(process.env.TC_BUDGET_TTL_MS || 60000);

// Set when a write fails. A guard whose ledger cannot be written has stopped counting, so rather
// than keep spending blind the next check refuses.
let writeFailed = false;

// `trusted` is false when the ledger exists but could not be read, or could not be written. A
// missing ledger is a fresh install and means nothing was spent; a damaged one means the record of
// what was spent is gone, and assuming zero would assume in the direction that overspends.
function ledger() {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(), 'utf8');
  } catch (e) {
    return { spent: 0, calls: 0, trusted: e && e.code === 'ENOENT' };
  }
  try {
    const l = JSON.parse(raw);
    return { spent: Number(l.spent) || 0, calls: Number(l.calls) || 0, trusted: true };
  } catch {
    return { spent: 0, calls: 0, trusted: false };
  }
}

function writeLedger(l) {
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(l));
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
}

let cache = { at: 0, data: null };

// What the provider says this key has left. Null when it cannot be read - no key configured, or the
// request failed - in which case the caller falls back to the local ledger rather than assuming
// there is budget.
async function provider(force) {
  if (!KEY) return null;
  if (!force && cache.data && Date.now() - cache.at < PROVIDER_TTL_MS) return cache.data;
  try {
    const res = await fetch(BASE + '/key', { headers: { authorization: 'Bearer ' + KEY } });
    if (!res.ok) return cache.data;
    const d = (await res.json()).data || {};
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    cache = {
      at: Date.now(),
      data: { limit: num(d.limit), usage: num(d.usage), remaining: num(d.limit_remaining) },
    };
    return cache.data;
  } catch {
    return cache.data; // last good reading, or null
  }
}

// Everything a caller needs to decide, and nothing that identifies the key.
async function status() {
  const p = await provider();
  const l = ledger();
  const capUsd = cap();
  const haveProvider = !!(p && p.remaining != null);
  const localTrusted = l.trusted && !writeFailed;
  // The provider's remaining is authoritative when it is readable: it already accounts for every
  // call this key has made, including any made outside this app. The local ledger is the fallback,
  // and when even that cannot be trusted the guard closes rather than assumes there is room.
  const spent = haveProvider && p.usage != null ? p.usage : l.spent;
  const remaining = haveProvider ? p.remaining : (localTrusted ? capUsd - l.spent : 0);
  return {
    cap_usd: haveProvider && p.limit != null ? p.limit : capUsd,
    spent_usd: Math.round(spent * 1e6) / 1e6,
    remaining_usd: Math.round(remaining * 1e6) / 1e6,
    exhausted: remaining <= 0,
    source: haveProvider ? 'provider' : localTrusted ? 'local' : 'ledger-unreadable',
  };
}

// Refuse before spending rather than after. Returns null when there is room, or a reason string.
async function blocked() {
  const s = await status();
  if (!s.exhausted) return null;
  return `budget_exhausted: $${s.cap_usd} limit reached (spent $${s.spent_usd})`;
}

// Add what a call actually cost, from the usage the provider reports. A call whose cost did not come
// back is counted as a call but not as spend, which understates rather than overstates: the provider
// limit is still the backstop.
function record(usage) {
  const cost = usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : 0;
  const l = ledger();
  writeLedger({ spent: l.spent + cost, calls: l.calls + 1 });
  cache.at = 0; // the next status() re-reads the provider rather than trusting a stale number
  return cost;
}

module.exports = { status, blocked, record };
