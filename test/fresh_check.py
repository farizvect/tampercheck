#!/usr/bin/env python3
"""Fresh (uncached) end-to-end check.

The demo photos are already cached, so this perturbs one pixel to guarantee a cache miss and
prove the whole path runs for real. Needs Pillow.

    TC_TEST_BASE=http://127.0.0.1:8787 python3 test/fresh_check.py
"""
import base64, json, os, random, sys, time, urllib.request

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787")
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "public", "assets", "demo", "genuine.jpg")

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("needs Pillow: pip install pillow")
    sys.exit(2)

if not os.path.exists(SRC):
    print(f"missing demo photo: {SRC}")
    sys.exit(1)

im = Image.open(SRC).copy()
d = ImageDraw.Draw(im)
# one pixel of unique noise is enough to defeat the content hash
d.point((random.randrange(im.size[0]), random.randrange(im.size[1])),
        fill=(random.randrange(256), 0, 0))
im.save("/tmp/tc_fresh.jpg", "JPEG", quality=85)

b = base64.b64encode(open("/tmp/tc_fresh.jpg", "rb").read()).decode()
body = {"brand": "ledger", "model": "nano-x",
        "images": [{"side": "front", "data": "data:image/jpeg;base64," + b}]}
req = urllib.request.Request(BASE + "/api/analyze", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json"})
t0 = time.time()
with urllib.request.urlopen(req, timeout=300) as resp:
    out = json.loads(resp.read().decode())

print("fresh (uncached) call: %.1fs  cached=%s" % (time.time() - t0, out.get("cached")))
print("verdict:", out["verdict"], "| quality:", out["photo_quality"], "| id:", out["id"])
print("model:", out["model"])
for f in out["findings"]:
    print("  -", f["severity"], f["kind"], "::", f["title"])
print("summary:", out["summary"][:220])

if out.get("cached") is True:
    print("\nFAIL: expected a cache miss, got a cached report")
    sys.exit(1)
print("\nPASS: uncached call completed end to end")
