#!/usr/bin/env python3
"""The files the browser asks for at the site root.

A service worker only controls a page if it is served from the site root, and the browser asks for
the manifest and the favicon at the root too. These live in public/ but outside /assets/, so they
need their own routes: without them the page renders perfectly while the offline shell and the
installable app are dead, which is the kind of failure that looks fine until someone relies on it.

Starts its own instance and spends nothing - no model call is made.

    python3 test/static.py
"""
import json
import os
import re
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


def get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=10) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, "", b""
    except Exception:
        return 0, "", b""


def main():
    port = 8806
    tmp = "/tmp/tc-static"
    os.makedirs(tmp, exist_ok=True)
    env = dict(os.environ)
    env.update({"TC_HOST": "127.0.0.1", "TC_PORT": str(port), "TC_REPORT_DIR": tmp,
                "TC_API_KEY": "unused", "TC_ENV_FILE": "/dev/null"})
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        up = False
        for _ in range(80):
            try:
                urllib.request.urlopen(base + "/api/status", timeout=1).read()
                up = True
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError("server exited early")
                time.sleep(0.25)
        if not up:
            raise RuntimeError("server did not come up")

        print("\n=== the page and what it asks the browser to load")
        st, _, page = get(base, "/")
        check("the page is served", st == 200 and b"<html" in page.lower(), f"{st}")

        # The contract that matters: whatever the served page points at must actually be there.
        # This is read from the response, the way a browser reads it, not from the source file.
        hrefs = re.findall(rb'<link[^>]+href="(/[^"]+)"', page)
        for h in hrefs:
            path = h.decode()
            st, ct, _ = get(base, path)
            check(f"the page's link {path} resolves", st == 200, f"{st} {ct}")

        print("\n=== the root files a browser fetches without being told to")
        st, ct, body = get(base, "/sw.js")
        check("/sw.js is served", st == 200, str(st))
        check("/sw.js is javascript", "javascript" in ct, ct)
        check("/sw.js is not empty", len(body) > 100, f"{len(body)} bytes")
        st, ct, body = get(base, "/manifest.webmanifest")
        check("/manifest.webmanifest is served", st == 200, str(st))
        check("/manifest.webmanifest has the manifest type", "manifest" in ct, ct)
        try:
            json.loads(body)
            check("/manifest.webmanifest is valid json", True)
        except Exception as e:
            check("/manifest.webmanifest is valid json", False, str(e))
        st, _, _ = get(base, "/favicon.ico")
        check("/favicon.ico is answered rather than 404", st == 200, str(st))

        print("\n=== and nothing else is opened up by that")
        st, _, _ = get(base, "/nothing-here.js")
        check("an unknown path is still a 404", st == 404, str(st))
        st, _, _ = get(base, "/../server.js")
        check("a traversal attempt is still a 404", st == 404, str(st))
    finally:
        proc.kill()
        proc.wait()

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS: the service worker and manifest are served at the root, so the offline shell and "
          "the installable app load")
    return 0


if __name__ == "__main__":
    sys.exit(main())
