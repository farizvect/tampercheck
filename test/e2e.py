#!/usr/bin/env python3
"""End-to-end test against a running server, over the plain JSON path.

Uses the demo photos shipped in public/assets/demo, so it needs no external files. Exits
non-zero if an expected verdict does not come back.

    TC_TEST_BASE=http://127.0.0.1:8787 python3 test/e2e.py
"""
import json, base64, os, urllib.request, urllib.error, time, sys, hashlib, re

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787")
HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.join(HERE, "..", "public", "assets", "demo")


def dataurl(p):
    return "data:image/jpeg;base64," + base64.b64encode(open(p, "rb").read()).decode()


def analyze(brand, model, paths, sides=None):
    sides = sides or ["front"] * len(paths)
    body = {"brand": brand, "model": model,
            "images": [{"side": s, "data": dataurl(p)} for p, s in zip(paths, sides)]}
    r = urllib.request.Request(BASE + "/api/analyze", data=json.dumps(body).encode(),
                               headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            return resp.status, json.loads(resp.read().decode()), round(time.time() - t0, 1)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode()), round(time.time() - t0, 1)


def show(name, brand, model, paths):
    st, r, dt = analyze(brand, model, paths)
    print(f"\n=== {name}  [{brand}/{model}]  status={st}  {dt}s")
    if st != 200:
        print("   ", r)
        return None
    print(f"  verdict   : {r['verdict']}  ({r['stamp']})")
    print(f"  quality   : {r['photo_quality']}  identity={r['board_identity']}  chips_read={r['chips_read']}")
    print(f"  injection : {r['injection_suspected']}")
    for f in r["findings"]:
        print(f"   - [{f['severity']}] {f['kind']} :: {f['title']}")
        print(f"       {f['detail'][:150]}")
    print(f"  summary   : {r['summary'][:220]}")
    print(f"  id={r['id']} cached={r['cached']}")
    return r


def get(path, raw=False):
    with urllib.request.urlopen(BASE + path, timeout=60) as resp:
        body = resp.read()
        return resp.status, (body if raw else body.decode())


def check_permalink(rep, source_path):
    """A permalink must show the picture the verdict came from, byte for byte.

    The report carries the sha256 of what was analysed. So: fetch the page, take the image it
    shows, hash it, and compare against both the digest in the report and the file that was
    submitted. Anything else - a re-encode, a stand-in, a stale file - fails here.
    """
    print("\n=== permalink carries the analysed photo ===")
    fails = []
    if not rep:
        return ["no report to build a permalink from"]
    st, html = get(f"/r/{rep['id']}")
    print(f"  page       : status={st} {len(html)} bytes")
    if st != 200:
        return [f"permalink returned {st}"]

    m = re.search(r'<img src="(/r/[a-z0-9]+/p/[0-9]+\.[a-z]+)"', html)
    if not m:
        return ["the permalink page shows no photo"]
    src = m.group(1)
    st, blob = get(src, raw=True)
    served = hashlib.sha256(blob).hexdigest()
    analysed = hashlib.sha256(open(source_path, "rb").read()).hexdigest()
    in_report = (rep.get("photos") or [{}])[0].get("sha256")
    print(f"  image      : {src} status={st} {len(blob)} bytes")
    print(f"  served     : sha256 {served[:32]}...")
    print(f"  submitted  : sha256 {analysed[:32]}...")
    print(f"  in report  : sha256 {str(in_report)[:32]}...")

    if st != 200:
        fails.append(f"the photo returned {st}")
    if served != analysed:
        fails.append("the photo on the permalink is not the one that was submitted")
    if served != in_report:
        fails.append("the photo does not match the digest the report carries")
    if len(blob) != (rep.get("photos") or [{}])[0].get("bytes"):
        fails.append("the photo size does not match the report")

    # And the boxes have to be on that picture, numbered to match the findings.
    boxes = re.findall(r'class="box ([a-z]+)"', html)
    nums = re.findall(r'class="boxnum [a-z]+">(\d+)</text>', html)
    print(f"  boxes      : {len(boxes)} rects, numbered {nums or 'none'}")
    if any(f.get("box") for f in rep["findings"]) and not boxes:
        fails.append("findings carry boxes but the page draws none")
    if nums and nums != [str(i) for i in range(1, len(nums) + 1)]:
        fails.append(f"box numbers are not sequential: {nums}")

    print("  " + ("FAIL" if fails else "PASS") + ": the page shows the analysed photo" +
          ("" if not fails else " - " + "; ".join(fails)))
    return fails


def main():
    implant = os.path.join(DEMO, "implant.jpg")
    genuine = os.path.join(DEMO, "genuine.jpg")
    injection = os.path.join(DEMO, "injection.jpg")
    for p in (implant, genuine, injection):
        if not os.path.exists(p):
            print(f"missing demo photo: {p}")
            return 1

    results = {}
    results["implant"] = show("REAL IMPLANT (Ledger Nano X)", "ledger", "nano-x", [implant])
    results["genuine"] = show("GENUINE board (Ledger Nano X)", "ledger", "nano-x", [genuine])
    results["inject"] = show("PROMPT-INJECTION image", "ledger", "nano-x", [injection])

    print("\n=== cache check (same implant photo again) ===")
    st, r, dt = analyze("ledger", "nano-x", [implant])
    print(f"  status={st} cached={r.get('cached')} {dt}s verdict={r.get('verdict')}")

    print("\n=== verdict distribution ===")
    for k, v in results.items():
        if v:
            print(f"  {k:8s} -> {v['verdict']}  injection={v['injection_suspected']}")

    # Contracts, not snapshots: an implant must never be cleared, and a photo carrying
    # instruction-like text must always be flagged.
    failures = []
    if results["implant"] and results["implant"]["verdict"] != "anomalies":
        failures.append(f"implant photo was not flagged (got {results['implant']['verdict']})")
    if results["inject"] and not results["inject"]["injection_suspected"]:
        failures.append("instruction text in the photo was not detected")
    if results["inject"] and results["inject"]["verdict"] != "anomalies":
        failures.append(f"injection photo was not flagged (got {results['inject']['verdict']})")
    if r.get("cached") is not True:
        failures.append("a repeated photo was not served from cache")

    failures += check_permalink(results["implant"], implant)

    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("PASS: implant flagged, injection flagged, repeat served from cache")
    return 0


if __name__ == "__main__":
    sys.exit(main())
