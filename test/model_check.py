#!/usr/bin/env python3
"""Check the model-check endpoint against a real key, without printing the key.

Reads the key from the env file, sends it as a BYOK header, and asserts the endpoint reports on the
key, the model, vision and JSON. Then asserts the same endpoint reports failures correctly for a bad
key and a bad model, and that no response echoes the key.

    TC_TEST_BASE=http://127.0.0.1:8787 python3 test/model_check.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787")
ENVF = os.environ.get("TC_ENV_FILE", os.path.expanduser("~/.config/tampercheck/.env"))
GOOD_MODEL = os.environ.get("TC_GOOD_MODEL", "google/gemini-3.8-flash")


def find_key():
    k = os.environ.get("TC_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k
    if os.path.exists(ENVF):
        for line in open(ENVF):
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def check(key, model, label, base=None):
    h = {"content-type": "application/json"}
    if key:
        h["x-tc-key"] = key
    if model:
        h["x-tc-model"] = model
    if base:
        h["x-tc-base-url"] = base
    r = urllib.request.Request(BASE + "/api/model-check", method="POST", data=b"{}", headers=h)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body}


def show(label, st, r):
    print(f"\n=== {label}   HTTP {st}")
    print(f"  ok      : {r.get('ok')}")
    for name, c in (r.get("checks") or {}).items():
        print(f"  {name:8s}: {c.get('ok')}  {c.get('detail', '')}")
    if r.get("balance"):
        print(f"  balance : {r['balance']}")
    if r.get("cost_usd"):
        print(f"  cost    : ${r['cost_usd']:.6f}   latency {r.get('latency_ms')} ms")
    if r.get("error"):
        print(f"  error   : {r['error']} {r.get('detail', '')}")


def main():
    key = find_key()
    if not key:
        print("no key available; cannot run the live check")
        return 1

    fails = []

    st, r = check(key, GOOD_MODEL, "good key, good model")
    show("real key + real model", st, r)
    if st != 200:
        fails.append(f"good case returned {st}")
    else:
        for name in ("key", "model", "vision", "json"):
            if not (r.get("checks") or {}).get(name, {}).get("ok"):
                fails.append(f"the {name} check failed on a working key")
        if not r.get("ok"):
            fails.append("overall check did not pass on a working key")
        if not r["checks"]["vision"].get("said"):
            fails.append("the vision check did not report what the model saw")

    st, r = check("sk-or-v1-" + "0" * 64, GOOD_MODEL,
                  "bad key")
    show("bad key", st, r)
    if st != 200:
        fails.append(f"bad-key case returned {st}, expected a 200 with a failed key check")
    else:
        if r.get("checks", {}).get("key", {}).get("ok"):
            fails.append("a bad key was reported as accepted")
        if r.get("ok"):
            fails.append("overall check passed on a bad key")

    st, r = check(key, "no-such-provider/no-such-model-at-all", "bad model")
    show("real key, bad model", st, r)
    if st != 200:
        fails.append(f"bad-model case returned {st}")
    else:
        c = r.get("checks") or {}
        if c.get("model", {}).get("ok") is not False:
            fails.append("a model id that does not exist was reported as working")
        if c.get("key", {}).get("ok") is not True:
            fails.append("a working key was blamed for a bad model id")

    st, r = check(key, "not a model id!!", "malformed model")
    show("malformed model id", st, r)
    if st != 400 or r.get("error") != "byok_model_invalid":
        fails.append(f"a malformed model id should be a 400 byok_model_invalid, got {st} {r.get('error')}")

    st, r = check("", GOOD_MODEL, "no key")
    show("no key", st, r)
    if st != 400 or r.get("error") != "byok_key_required":
        fails.append(f"a missing key should be 400 byok_key_required, got {st} {r.get('error')}")

    # A key with a space in it is malformed. (A newline cannot even be sent by a well-behaved client;
    # the server rejects whitespace so that a client which tries anyway gets a clean refusal.)
    st, r = check("sk-or-v1-bad key with space", GOOD_MODEL, "key with whitespace")
    show("key containing whitespace", st, r)
    if st != 400 or r.get("error") != "byok_key_invalid":
        fails.append(f"a key containing whitespace should be 400 byok_key_invalid, got {st} {r.get('error')}")

    # Provider error bodies carry the account's user_id. It is the operator's, and must not reach a
    # visitor, including on the paths that echo upstream text.
    st, r = check("sk-or-v1-" + "0" * 64, GOOD_MODEL, "bad key, checking for account leakage")
    blob = json.dumps(r)
    if "user_id" in blob and "[redacted]" not in blob:
        fails.append(f"an upstream account identifier reached the client: {blob[:200]}")

    print("\n=== the endpoint a visitor may name")
    # The safety property: a custom endpoint without a key would send the deployment's own key to a
    # host the visitor chose. It must be refused, not defaulted.
    st, r = check("", GOOD_MODEL, "endpoint without a key", base="https://example.com/v1")
    show("custom endpoint, no key", st, r)
    if st != 400 or r.get("error") != "byok_endpoint_needs_key":
        fails.append(f"a custom endpoint without a key must be refused, got {st} {r.get('error')}")

    for label, base in [
        ("loopback", "http://127.0.0.1:9119/v1"),
        ("this instance itself", f"{BASE}/v1"),
        ("cloud metadata", "http://169.254.169.254/latest/meta-data"),
        ("a private range", "http://10.0.0.5:8080/v1"),
        ("a carrier-grade NAT address", "http://100.64.0.1:9119/"),
        ("a bracketed loopback literal", "http://[::1]:9119/v1"),
        ("a v4-mapped loopback literal", "http://[::ffff:127.0.0.1]:9119/v1"),
        ("localhost by name", "http://localhost:9119/v1"),
    ]:
        st, r = check(key, GOOD_MODEL, f"endpoint = {label}", base=base)
        show(f"endpoint at {label}", st, r)
        if st != 400 or r.get("error") != "endpoint_private":
            fails.append(f"an endpoint at {label} must be refused, got {st} {r.get('error')}")

    st, r = check(key, GOOD_MODEL, "endpoint with a bad scheme", base="file:///etc/passwd")
    show("endpoint with a bad scheme", st, r)
    if st != 400 or r.get("error") != "endpoint_scheme":
        fails.append(f"a file:// endpoint must be refused, got {st} {r.get('error')}")

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS: the model check reports key, model, vision and JSON, and refuses bad input")
    return 0


if __name__ == "__main__":
    sys.exit(main())
