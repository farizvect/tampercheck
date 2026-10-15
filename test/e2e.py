#!/usr/bin/env python3
"""End-to-end test against a running server, over the plain JSON path.

Uses the demo photos shipped in public/assets/demo, so it needs no external files. Exits
non-zero if an expected verdict does not come back.

    TC_TEST_BASE=http://127.0.0.1:8787 python3 test/e2e.py
"""
import json, base64, os, urllib.request, urllib.error, time, sys

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
    results["genuine"] = show("GENUINE board", "onekey", "pro", [genuine])
    results["inject"] = show("PROMPT-INJECTION image", "onekey", "pro", [injection])

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

    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("PASS: implant flagged, injection flagged, repeat served from cache")
    return 0


if __name__ == "__main__":
    sys.exit(main())
