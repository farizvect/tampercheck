#!/usr/bin/env python3
"""Verify a report signature in Python, to prove the signature is not a Node-only artefact.

The signature covers a canonical JSON serialisation (object keys sorted, no whitespace). This
script reimplements that serialisation in Python and checks the Ed25519 signature with the
`cryptography` package, so a third party can verify a report without running any of this code.

    python3 test/verify_signature.py                 # newest stored report
    python3 test/verify_signature.py <report-id>     # a specific report
    TC_TEST_BASE=http://host:port python3 test/verify_signature.py
"""
import base64
import glob
import json
import os
import sys
import urllib.request

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787").rstrip("/")
HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.environ.get("TC_REPORT_DIR", os.path.join(HERE, "..", "data", "reports"))

try:
    from cryptography.hazmat.primitives.serialization import load_pem_public_key
    from cryptography.exceptions import InvalidSignature
except ImportError:
    print("needs cryptography: pip install cryptography")
    sys.exit(2)


def canonical(v):
    """Must match lib/sign.js::canonical byte for byte."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + canonical(v[k]) for k in sorted(v)
        ) + "}"
    raise TypeError(f"cannot canonicalise {type(v)}")


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


# The signature covers the facts of a report, not its wording or its delivery metadata.
# Must match lib/sign.js::signedPayload.
EXCLUDED_KEYS = {"stamp", "meaning", "summary", "retake_tips", "signature", "id", "cached", "server_ms"}
EXCLUDED_FINDING_KEYS = {"title", "detail"}


def signed_payload(report):
    out = {k: v for k, v in report.items() if k not in EXCLUDED_KEYS}
    if isinstance(report.get("findings"), list):
        out["findings"] = [
            {k: v for k, v in f.items() if k not in EXCLUDED_FINDING_KEYS} for f in report["findings"]
        ]
    return out


def load_report(arg):
    if arg:
        path = os.path.join(REPORTS, arg + ".json")
        if os.path.exists(path):
            return json.load(open(path))
        return get_json(f"{BASE}/api/report/{arg}")
    files = [f for f in glob.glob(os.path.join(REPORTS, "*.json")) if not f.endswith("_index.json")]
    if not files:
        return None
    newest = max(files, key=os.path.getmtime)
    return json.load(open(newest))


def main():
    rec = load_report(sys.argv[1] if len(sys.argv) > 1 else None)
    if not rec:
        print("no stored report found; run an inspection first")
        return 2

    report = rec.get("report", rec)
    signature = report.get("signature")
    if not signature:
        print("FAIL: report carries no signature")
        return 1

    body = signed_payload(report)
    message = canonical(body).encode("utf-8")

    key_pem = get_json(f"{BASE}/api/pubkey").get("public_key_pem")
    if not key_pem:
        print("FAIL: server reports no public key")
        return 1
    public_key = load_pem_public_key(key_pem.encode())

    try:
        public_key.verify(base64.b64decode(signature["value"]), message)
    except InvalidSignature:
        print("FAIL: signature does not cover this report body")
        return 1

    print(f"VALID  {rec.get('id', '?')}  (key {signature.get('key_id')})")
    print(f"       algorithm: {signature.get('algorithm')}  covers: {signature.get('covers', 'facts')}"
          f"  canonical bytes: {len(message)}")
    print(f"       verdict: {report.get('verdict')}  device: {(report.get('device') or {}).get('name')}")
    for p in report.get("photos") or []:
        print(f"       photo {p.get('side')}: sha256 {p.get('sha256')}")

    # A tampered body must not verify: flip one field and re-check.
    tampered = dict(body)
    tampered["verdict"] = "no_visible_anomalies"
    try:
        public_key.verify(base64.b64decode(signature["value"]), canonical(tampered).encode("utf-8"))
        print("FAIL: a tampered report still verified")
        return 1
    except InvalidSignature:
        pass
    print("       tamper check: an edited verdict does not verify (correct)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
