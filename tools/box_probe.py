#!/usr/bin/env python3
"""Ask a vision model for bounding boxes of suspicious regions, and draw them.

This is a probe: it measures whether the chat model can localise at all before any of this is
wired into the report. Boxes come back as fractions of width/height, which is what the browser
overlay needs; the same fractions can be handed to JEV or any other box source later.

  python3 tools/box_probe.py <image> [--model M] [--out FILE]
"""
import argparse
import base64
import io
import json
import os
import sys
import urllib.request

from PIL import Image, ImageDraw

KEY = [l.split("=", 1)[1].strip().strip('"') for l in
       open(os.path.expanduser("~/.config/tampercheck/.env"))
       if l.startswith("OPENROUTER_API_KEY=")][0]

PROMPT = """You are a hardware inspection assistant looking at a photo of an opened hardware-wallet
circuit board. A genuine board has no extra circuit boards, no radio modules, no antennas and no
hand-soldered bodge wires.

For each suspicious region you can see, report its bounding box as fractions of the image:
left/right are fractions of the width, top/bottom are fractions of the height, all from the
top-left corner, all between 0 and 1. A box must tightly enclose the single region.

Reply with JSON only, no prose and no markdown fence:
{"regions":[{"label":"short name","why":"one sentence","box":{"left":0.0,"top":0.0,"right":0.0,"bottom":0.0}}]}
If there is nothing suspicious, reply {"regions":[]}."""


def ask(model, path):
    im = Image.open(path).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode()
    body = {
        "model": model,
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        ]}],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + KEY},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    return im, data["choices"][0]["message"]["content"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--model", default="google/gemini-3.8-flash")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    im, text = ask(a.model, a.image)
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        d = json.loads(t)
    except json.JSONDecodeError:
        print("NOT JSON:\n" + text[:800])
        return 1

    w, h = im.size
    print(f"image {w}x{h}  model {a.model}")
    draw = ImageDraw.Draw(im)
    for r in d.get("regions", []):
        b = r.get("box") or {}
        box = [b.get("left", 0) * w, b.get("top", 0) * h,
               b.get("right", 0) * w, b.get("bottom", 0) * h]
        print(f"  {r.get('label','?'):28s} box=({box[0]:6.1f},{box[1]:6.1f},{box[2]:6.1f},{box[3]:6.1f})"
              f"  {r.get('why','')[:60]}")
        draw.rectangle(box, outline=(255, 0, 0), width=6)
        draw.text((box[0] + 8, box[1] + 8), r.get("label", "?"), fill=(255, 0, 0))
    out = a.out or "/tmp/box_probe.png"
    im.save(out)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
