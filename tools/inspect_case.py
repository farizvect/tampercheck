#!/usr/bin/env python3
"""Submit one image and print the full report fields, for diagnosing a single case."""
import base64
import io
import json
import sys
import urllib.error
import urllib.request

from PIL import Image

BASE = sys.argv[1]
IMG = sys.argv[2]
BRAND = sys.argv[3]
MODEL = sys.argv[4]

im = Image.open(IMG).convert("RGB")
s = min(1, 2576 / max(im.size), (3.5e6 / (im.size[0] * im.size[1])) ** 0.5)
if s < 1:
    im = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.LANCZOS)
buf = io.BytesIO()
im.save(buf, "JPEG", quality=86)
data = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

body = {"brand": BRAND, "model": MODEL, "images": [{"side": "front", "data": data}]}
req = urllib.request.Request(BASE + "/api/analyze", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json"})
try:
    o = json.load(urllib.request.urlopen(req, timeout=300))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:400])
    sys.exit(1)

for k in ("verdict", "board_identity", "board_identity_reason", "photo_quality",
          "photo_quality_reason", "is_pcb", "summary"):
    print(f"{k:22s}: {str(o.get(k))[:200]}")
print("findings              :", [(f["kind"], f["severity"]) for f in o.get("findings", [])])
print("chips                 :", [(c["id"], c.get("part_marking"), c.get("readable")) for c in o.get("chips", [])])
