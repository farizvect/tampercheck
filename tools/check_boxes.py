#!/usr/bin/env python3
"""Crop the boxes a live report produced and ask what is in each one.

The overlay is only worth shipping if the coordinates point at the thing. The model that drew them
cannot be asked to check its own work, so this takes the boxes out of a real report, crops each one
with a margin, and puts the crop to a fresh question with no knowledge of the answer.

  python3 tools/check_boxes.py <base-url> <image> <brand> <model>
"""
import base64
import io
import json
import os
import sys
import urllib.request

from PIL import Image

KEY = [l.split("=", 1)[1].strip().strip('"') for l in
       open(os.path.expanduser("~/.config/tampercheck/.env"))
       if l.startswith("OPENROUTER_API_KEY=")][0]

WHAT = """What is in this image? Name the objects you actually see and their colours. If it is a
circuit board, say whether anything looks hand-added, glued on, soldered by hand, or not part of the
original design. Two sentences, no JSON."""


def post(url, body, auth=False):
    headers = {"content-type": "application/json"}
    if auth:
        headers["authorization"] = "Bearer " + KEY
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def ask(prompt, data_url):
    return post("https://openrouter.ai/api/v1/chat/completions", {
        "model": "google/gemini-3.8-flash", "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}}]}],
    }, auth=True)["choices"][0]["message"]["content"]


def main():
    base, path, brand, model = sys.argv[1:5]
    im = Image.open(path).convert("RGB")
    w, h = im.size
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    rep = post(base.rstrip("/") + "/api/analyze",
               {"brand": brand, "model": model, "lang": "en",
                "images": [{"side": "front", "data": data_url}]})
    print(f"verdict: {rep.get('verdict')}  findings: {len(rep.get('findings') or [])}\n")

    for i, f in enumerate(rep.get("findings") or [], 1):
        b = f.get("box")
        if not b:
            print(f"[{i}] {f['kind']}  -- no box")
            continue
        box = [b["left"] * w, b["top"] * h, b["right"] * w, b["bottom"] * h]
        m = 0.05 * max(w, h)
        crop = im.crop((max(0, box[0] - m), max(0, box[1] - m),
                        min(w, box[2] + m), min(h, box[3] + m)))
        cb = io.BytesIO()
        crop.save(cb, "JPEG", quality=92)
        said = ask(WHAT, "data:image/jpeg;base64," + base64.b64encode(cb.getvalue()).decode())
        print(f"[{i}] {f['kind']} ({f['severity']})")
        print(f"    box: left={b['left']:.2f} top={b['top']:.2f} right={b['right']:.2f} bottom={b['bottom']:.2f}"
              f"  -> crop {crop.size[0]}x{crop.size[1]}")
        print(f"    the crop, described cold: {said.replace(chr(10), ' ')[:330]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
