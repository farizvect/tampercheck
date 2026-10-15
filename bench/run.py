#!/usr/bin/env python3
"""Benchmark tampercheck against a labelled set of board photos.

    python3 bench/run.py                       # all cases against the default server
    python3 bench/run.py --base http://host:port
    python3 bench/run.py --only implant-ledger-gen3-underscreen
    python3 bench/run.py --no-synthetic        # real photographs only

Images are fetched from their published source and checked against the sha256 in manifest.json, so
nothing third-party is redistributed with the repository. Three kinds of case are reported
separately, because they are not equally strong evidence:

  real       an unmodified photograph of a real device. The only cases that measure real accuracy.
  real-crop  a crop of one of those photographs. Same evidence, framed differently: it tests that a
             conclusion survives a tighter crop, not an independent device.
  synthetic  a variant generated locally from a genuine photo by pasting an extra board and drawing
             bodge wires. It exercises one skill (spotting an addition) and is much easier than a
             real implant, so it never stands in for the real numbers.

Results are written to bench/results.json. Exit code is 1 if a REAL case is misjudged.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("needs Pillow: pip install pillow")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.join(HERE, "images")
MANIFEST = os.path.join(HERE, "manifest.json")

# Must mirror the browser preprocessing in public/assets/app.js, so the service sees what it
# would see from a real submission.
MAX_EDGE, MAX_PIXELS = 2576, 3.5e6

FLAGGED = {"anomalies", "board_mismatch"}
CLEAN = {"no_visible_anomalies"}

KINDS = ["real", "real-crop", "synthetic"]


def preprocess(path):
    """Resize and re-encode exactly like the client does."""
    im = Image.open(path).convert("RGB")
    s = min(1, MAX_EDGE / max(im.size), (MAX_PIXELS / (im.size[0] * im.size[1])) ** 0.5)
    if s < 1:
        im = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86)
    return buf.getvalue()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def download(case):
    """Fetch a case's published original once, verifying its hash."""
    os.makedirs(IMAGES, exist_ok=True)
    dest = os.path.join(IMAGES, case["id"] + ".jpg")
    want = case.get("sha256", "")
    if os.path.exists(dest):
        have = sha256(open(dest, "rb").read())
        if not want or have.startswith(want):
            return dest
    req = urllib.request.Request(case["url"], headers={"User-Agent": "tampercheck-bench/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    have = sha256(data)
    if want and not have.startswith(want):
        raise SystemExit(f"{case['id']}: hash mismatch\n  expected {want}\n  got      {have}")
    open(dest, "wb").write(data)
    return dest


def materialise(case, by_id):
    """Path of the image to submit for this case, generating crops on demand."""
    if not case.get("crop_of"):
        return download(case)
    src = download(by_id[case["crop_of"]])
    dest = os.path.join(IMAGES, case["id"] + ".jpg")
    box = case["box"]
    im = Image.open(src).convert("RGB")
    w, h = im.size
    im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h))).save(dest, "JPEG", quality=92)
    return dest


def make_synthetic(case):
    """Paste an extra board and draw bodge wires onto a genuine photo."""
    src = Image.open(download(case)).convert("RGB")
    w, h = src.size
    im = src.copy()
    d = ImageDraw.Draw(im)

    # an extra board, off to one side of the main PCB
    bw, bh = max(40, w // 6), max(30, h // 6)
    bx, by = int(w * 0.06), int(h * 0.62)
    d.rectangle([bx, by, bx + bw, by + bh], fill=(22, 66, 48), outline=(150, 170, 155), width=2)
    for i in range(3):
        px = bx + int(bw * (0.2 + 0.3 * i))
        py = by + int(bh * 0.45)
        d.rectangle([px, py, px + max(6, bw // 8), py + max(6, bh // 8)], fill=(200, 200, 200))

    # hand-soldered wires from the extra board to the main PCB
    for k in range(3):
        x0, y0 = bx + bw, by + int(bh * (0.3 + 0.2 * k))
        x1, y1 = int(w * 0.45), int(h * (0.45 + 0.06 * k))
        d.line([x0, y0, (x0 + x1) // 2, y0 - 12, x1, y1], fill=(190, 120, 60), width=3)

    out = os.path.join(IMAGES, case["id"] + ".jpg")
    im.save(out, "JPEG", quality=88)
    return out


def analyze(base, brand, model, path, timeout=300):
    data = "data:image/jpeg;base64," + base64.b64encode(preprocess(path)).decode()
    body = {"brand": brand, "model": model, "images": [{"side": "front", "data": data}]}
    req = urllib.request.Request(base + "/api/analyze", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read().decode())
        return (out if isinstance(out, dict) else {"error": "unexpected_response"}), round(time.time() - t0, 1)
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()[:200]}, round(time.time() - t0, 1)


def classify(verdict):
    if verdict in FLAGGED:
        return "flagged"
    if verdict in CLEAN:
        return "clean"
    return "no_claim"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787"))
    ap.add_argument("--only", default=None)
    ap.add_argument("--no-synthetic", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "results.json"))
    args = ap.parse_args()
    base = args.base.rstrip("/")

    manifest = json.load(open(MANIFEST))
    by_id = {c["id"]: c for c in manifest["cases"]}
    cases = [c for c in manifest["cases"] if not args.only or c["id"] == args.only]

    work = []
    for c in cases:
        work.append((c, c.get("provenance", "real"), materialise(c, by_id)))
    if not args.no_synthetic:
        for c in cases:
            if c["truth"] == "genuine" and c.get("synthetic_ok"):
                s = dict(c)
                s["id"] = c["id"].replace("genuine-", "") + "-synthetic-extraboard"
                s["truth"] = "tampered"
                work.append((s, "synthetic", None))

    print(f"benchmark against {base}")
    print(f"{'case':46s} {'truth':9s} {'kind':10s} {'verdict':22s} {'result':9s} s")
    print("-" * 110)

    results, failures = [], []
    for case, kind, path in work:
        if path is None:
            path = make_synthetic(case)
        rep, secs = analyze(base, case["brand"], case["model"], path)
        verdict = rep.get("verdict", "error")
        got = classify(verdict)
        want = "flagged" if case["truth"] == "tampered" else "clean"
        if got == "no_claim":
            outcome = "no claim"
        elif got == want:
            outcome = "CORRECT"
        else:
            outcome = "WRONG"
            if kind == "real":
                failures.append((case["id"], case["truth"], verdict))
        print(f"{case['id']:46s} {case['truth']:9s} {kind:10s} {str(verdict):22s} {outcome:9s} {secs}")
        results.append({"id": case["id"], "truth": case["truth"], "provenance": kind,
                        "verdict": verdict, "outcome": outcome, "seconds": secs,
                        "findings": [f.get("kind") for f in rep.get("findings", [])],
                        "source": case.get("source", "")})

    def summary(rows, label):
        tp = sum(1 for r in rows if r["truth"] == "tampered" and r["outcome"] == "CORRECT")
        fn = sum(1 for r in rows if r["truth"] == "tampered" and r["outcome"] == "WRONG")
        tn = sum(1 for r in rows if r["truth"] == "genuine" and r["outcome"] == "CORRECT")
        fp = sum(1 for r in rows if r["truth"] == "genuine" and r["outcome"] == "WRONG")
        nc = sum(1 for r in rows if r["outcome"] == "no claim")
        decided = tp + fn + tn + fp
        if not rows:
            return fn, fp
        print(f"\n{label}  ({len(rows)} cases, {nc} declined to conclude)")
        print(f"  tampered flagged   {tp}   tampered missed  {fn}")
        print(f"  genuine clean      {tn}   genuine flagged  {fp}")
        if decided:
            print(f"  accuracy on decided cases: {round(100 * (tp + tn) / decided)}%  ({tp + tn}/{decided})")
        return fn, fp

    print()
    for kind in KINDS:
        rows = [r for r in results if r["provenance"] == kind]
        if not rows:
            continue
        label = {
            "real": "real photographs (the only cases that measure real accuracy)",
            "real-crop": "crops of real photographs (same evidence, different framing)",
            "synthetic": "synthetic additions (generated, much easier than a real implant)",
        }[kind]
        summary(rows, label)

    json.dump({"base": base, "results": results}, open(args.out, "w"), indent=1)
    print(f"\nsaved {args.out}")

    if failures:
        print("\nFAILURES on real cases:")
        for cid, truth, verdict in failures:
            print(f"  {cid}: truth={truth} but the app said {verdict}")
        return 1
    print("\nPASS: no real case was misjudged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
