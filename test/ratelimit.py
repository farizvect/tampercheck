#!/usr/bin/env python3
"""The per-caller daily limit, and who gets to say who the caller is.

The limit is keyed on the client address. If that address comes from a header the client sets, the
limit is not a limit: one header, rotated per request, makes every request the first one. This test
pins both directions - the header is ignored unless the deployment says a proxy sets it, and it is
honoured when it does.

It spends no money: the upstream is pointed at a port with nothing listening, so a request that gets
past the limit fails at the model call rather than reaching a provider.

    python3 test/ratelimit.py
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(f"{name}: {detail}")


def start(port, tmp, extra_env):
    env = dict(os.environ)
    env.update({
        "TC_HOST": "127.0.0.1", "TC_PORT": str(port),
        "TC_REPORT_DIR": tmp, "TC_DAILY_LIMIT": "2",
        "TC_BASE_URL": "http://127.0.0.1:9/v1",  # nothing listens here
        "TC_API_KEY": "sk-or-v1-not-a-real-key",
        "TC_BUDGET_USD": "1000",
    })
    env.update(extra_env)
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(80):
        try:
            urllib.request.urlopen(base + "/api/status", timeout=1).read()
            return proc, base
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError("server exited early")
            time.sleep(0.25)
    proc.kill()
    raise RuntimeError("server did not come up")


def analyze(base, img, headers=None):
    h = {"content-type": "application/json"}
    h.update(headers or {})
    body = json.dumps({"brand": "ledger", "model": "nano-x", "lang": "en",
                       "images": [{"side": "front", "data": img}]}).encode()
    req = urllib.request.Request(base + "/api/analyze", data=body, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def img_data():
    with open(os.path.join(ROOT, "public/assets/demo/implant.jpg"), "rb") as f:
        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


def main():
    img = img_data()
    tmp = "/tmp/tc-ratelimit"
    os.makedirs(tmp, exist_ok=True)

    # --- the default: a proxy header is not trusted ---
    print("\n=== no proxy in front (default)")
    proc, base = start(8802, os.path.join(tmp, "a"), {})
    try:
        codes = [analyze(base, img) for _ in range(3)]
        check("the limit applies to a caller with no header", codes[2] == 429,
              f"codes {codes}")

        # The finding this guards: rotating the header must not mint a fresh bucket each time.
        codes = [analyze(base, img, {"cf-connecting-ip": f"203.0.113.{i}"}) for i in range(1, 6)]
        check("a rotated cf-connecting-ip does not bypass the limit", 429 in codes,
              f"codes {codes}")
        check("the limit is reached on the third, as without the header",
              codes[2] == 429, f"codes {codes}")
    finally:
        proc.kill()
        proc.wait()

    # --- when a proxy is in front, the header is the answer ---
    print("\n=== behind a proxy that sets the header (TC_TRUST_PROXY=1)")
    proc, base = start(8803, os.path.join(tmp, "b"), {"TC_TRUST_PROXY": "1"})
    try:
        codes = [analyze(base, img, {"cf-connecting-ip": f"198.51.100.{i}"}) for i in range(1, 5)]
        check("distinct callers each get their own bucket", codes == [502] * 4, f"codes {codes}")
        codes = [analyze(base, img, {"cf-connecting-ip": "198.51.100.9"}) for _ in range(3)]
        check("one caller is still limited", codes[2] == 429, f"codes {codes}")
    finally:
        proc.kill()
        proc.wait()

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS: the daily limit is per real caller, and a spoofed header cannot rotate it away")
    return 0


if __name__ == "__main__":
    sys.exit(main())
