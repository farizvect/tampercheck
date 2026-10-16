'use strict';
// Bring-your-own-key. A visitor's credential, used for their own request and for nothing else.
//
// These values never leave this process except as an Authorization header on the one call the
// visitor asked for. They are not written to disk, not included in a report, not logged, and not
// echoed in an error. The report that comes out holds a verdict, findings and photo hashes; it has
// no field a credential could live in.
//
// This is a different thing from the server's own key in lib/vision.js. A call made with a visitor's
// key is paid for by the visitor, so it does not come out of this deployment's budget.
//
// A visitor-supplied endpoint is used only with the visitor's own key, and only after lib/endpoint.js
// has vetted it: the scheme, the host, and every address the name resolves to, with the vetted
// address then pinned for the connection. The operator's endpoint comes from TC_BASE_URL.

const endpoint = require('./endpoint');

const MAX_KEY = 200;
// Model ids in the wild look like `google/gemini-3.8-flash`, `openai/gpt-4o-mini:free`,
// `meta-llama/llama-3.1-70b-instruct`. Anything outside this shape is not a model id.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/;

function header(req, name) {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : '';
}

// A visitor may name the endpoint, but only together with their own key. That pairing is the whole
// safety property: if a custom endpoint could be given on its own, the request would go out with the
// deployment's key attached to a host the visitor chose, which is a way to be handed the operator's
// credential. So a custom endpoint without a key is refused, not silently defaulted.
//
// Returns { key, model, base, vetted } when the visitor supplied a credential, or null when they did
// not. Throws with a short code when what they supplied is malformed: quietly ignoring a bad key
// would run the call on the deployment's key instead, spending the operator's money on a request the
// visitor meant to pay for themselves.
async function fromRequest(req) {
  const key = header(req, 'x-tc-key');
  const model = header(req, 'x-tc-model');
  const rawBase = header(req, 'x-tc-base-url');
  if (!key && !model && !rawBase) return null;
  if (!key) throw new Error(rawBase ? 'byok_endpoint_needs_key' : 'byok_key_required');
  // A bearer token has no whitespace and no control characters. Rejecting them here means a
  // malformed header cannot be reflected into an upstream request.
  if (key.length > MAX_KEY || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('byok_key_invalid');
  if (model && !MODEL_RE.test(model)) throw new Error('byok_model_invalid');

  let vetted = null;
  if (rawBase) {
    if (String(process.env.TC_ALLOW_CUSTOM_ENDPOINT || '1') === '0') throw new Error('byok_endpoint_disabled');
    // Vetted here, once, and the result is what the request is made against. See lib/endpoint.js for
    // what is refused and why the resolved address is pinned.
    const v = await endpoint.vet(rawBase);
    if (v.error) throw new Error(v.error);
    vetted = v;
  }
  return { key, model: model || null, vetted };
}

// What is safe to say about a credential: that one was used, the model it was used for, and whether
// the endpoint was the visitor's. Never the credential, and never the endpoint URL - it can carry a
// token in its path or query.
function describe(creds) {
  if (!creds) return { byok: false, model: null, custom_endpoint: false };
  return { byok: true, model: creds.model || null, custom_endpoint: !!creds.vetted };
}

module.exports = { fromRequest, describe, MODEL_RE };
