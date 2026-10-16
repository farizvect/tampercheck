#!/usr/bin/env python3
"""Assert the API key never reaches a client, on any path.

The key is the one thing in this deployment that must not leak: it is a bearer credential, so anyone
holding it can spend the account's balance. This walks every endpoint and every static asset and
looks for it, then pokes the paths most likely to echo it back - a failed analysis, a malformed body,
a traversal attempt.

The key is read from the environment or the env file the server itself uses. It is never printed.

    TC_TEST_BASE=http://127.0.0.1:8787 python3 test/key_leak.py
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787")
ENVF = os.environ.get("TC_ENV_FILE", os.path.expanduser("~/.config/tampercheck/.env"))


def find_key():
    k = os.environ.get("TC_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k
    if os.path.exists(ENVF):
        for line in open(ENVF):
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def req(path, method="GET", body=None, headers=None):
    """Returns (status, headers-as-text, body-as-text). Never raises on an HTTP error."""
    r = urllib.request.Request(BASE + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, str(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, str(e.headers), e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, "", f"(request failed: {e})"


def main():
    key = find_key()
    if not key:
        print("no key configured; nothing to leak, but the check cannot run either")
        return 1
    print(f"checking {len(key)}-byte key is absent from every response\n")

    # Fragments worth searching for: the whole key, and its distinctive middle, in case a response
    # shows a truncated form.
    needles = {key, key[8:], key[:24]}

    targets = [
        ("/", "GET", None, None),
        ("/index.html", "GET", None, None),
        ("/assets/app.js", "GET", None, None),
        ("/assets/styles.css", "GET", None, None),
        ("/assets/demo/implant.jpg", "GET", None, None),
        ("/sw.js", "GET", None, None),
        ("/manifest.webmanifest", "GET", None, None),
        ("/api/status", "GET", None, None),
        ("/api/devices", "GET", None, None),
        ("/api/pubkey", "GET", None, None),
        ("/api/analyze", "GET", None, None),                      # wrong method
        ("/api/analyze", "POST", {"nonsense": True}, None),        # unknown device
        ("/api/analyze", "POST", {"brand": "ledger", "model": "nano-x",
                                  "images": [{"side": "front", "data": "notadataurl"}]}, None),
        ("/api/analyze", "POST", {"brand": "ledger", "model": "nano-x",
                                  "images": [{"side": "front", "data": "data:image/jpeg;base64,AAAA"}]}, None),
        # Fields a caller might hope the server would honour. It must not.
        ("/api/analyze", "POST", {"brand": "ledger", "model": "nano-x",
                                  "base_url": "http://127.0.0.1:9/v1",
                                  "url": "http://127.0.0.1:9/",
                                  "api_key": "x", "proxy": "http://127.0.0.1:9",
                                  "images": [{"side": "front", "data": "data:image/jpeg;base64,AAAA"}]}, None),
        # The BYOK paths: a credential goes in on a header, so these are the responses most likely to
        # echo it back - a rejection message, a validation error, a check result.
        ("/api/model-check", "GET", None, None),
        ("/api/model-check", "POST", {}, {"x-tc-key": "sk-or-v1-" + "9" * 64}),
        ("/api/model-check", "POST", {}, {"x-tc-key": "sk-or-v1-" + "9" * 64, "x-tc-model": "no-such/model"}),
        ("/api/model-check", "POST", {}, {"x-tc-key": "sk-or-v1-bad key"}),
        ("/api/model-check", "POST", {}, {"x-tc-model": "google/gemini-3.8-flash"}),
        ("/api/model-check", "POST", {}, {"x-tc-key": "sk-or-v1-" + "9" * 64, "x-tc-base-url": "http://127.0.0.1:9119/v1"}),
        ("/api/model-check", "POST", {}, {"x-tc-key": "sk-or-v1-" + "9" * 64, "x-tc-base-url": "file:///etc/passwd"}),
        ("/api/analyze", "POST", {"brand": "ledger", "model": "nano-x",
                                  "images": [{"side": "front", "data": "data:image/jpeg;base64,AAAA"}]},
         {"x-tc-key": "sk-or-v1-" + "9" * 64}),
        ("/api/report/aaaaaaaaaaaa", "GET", None, None),
        ("/api/report/../../.env", "GET", None, None),
        ("/api/verify/aaaaaaaaaaaa", "GET", None, None),
        ("/r/aaaaaaaaaaaa", "GET", None, None),
        ("/r/aaaaaaaaaaaa/p/1.jpg", "GET", None, None),
        ("/assets/../.env", "GET", None, None),
        ("/assets/../../.env", "GET", None, None),
        ("/assets/%2e%2e/.env", "GET", None, None),
        ("/.env", "GET", None, None),
        ("/lib/vision.js", "GET", None, None),
        ("/server.js", "GET", None, None),
        ("/data/reports/_index.json", "GET", None, None),
        ("/does-not-exist", "GET", None, None),
    ]

    leaks = []
    for path, method, body, headers in targets:
        st, hdrs, text = req(path, method, body, headers)
        found = [n for n in needles if n and n in text]
        if found:
            leaks.append((path, method, len(found)))
        if key in hdrs:
            leaks.append((path, method, "in headers"))
        # A credential the caller SENT must not come back either. The server's own key is the one that
        # matters most, but echoing a visitor's key in an error message is the same class of mistake.
        # The model id is deliberately excluded: it is public, and naming the model that was checked
        # is the point of the response.
        for name, value in (headers or {}).items():
            if name.lower() in ('x-tc-key', 'x-tc-base-url') and value and value in text:
                leaks.append((path, method, f"echoed the {name} it was sent"))
        label = f"{method:4s} {path}"
        print(f"  {label:52s} {st:3d}  {'LEAK' if found else 'clean'}")

    # The env file itself must not be reachable through the static handler.
    st, _, text = req("/.env")
    if st == 200:
        leaks.append(("/.env", "GET", "served"))

    print()
    if leaks:
        for l in leaks:
            print("FAIL: key material exposed via", l)
        return 1
    print(f"PASS: {len(targets)} responses checked, no key material in any of them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
