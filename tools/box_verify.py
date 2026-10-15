#!/usr/bin/env python3
"""Check whether a model's boxes actually contain what the model said they contain.

The probe cannot be trusted on its own: a box that is wrong still looks like an answer. So for
each box, crop it (with a margin), show the crop to the model again and ask a neutral question
about it. If the crop is described as the thing the box claimed, the coordinates are plausibly
right; if it is described as something else, the box is decoration.

  python3 tools/box_verify.py <image> [--model M]
"""
import argparse
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

FIND = """You are a hardware inspection assistant looking at a photo of an opened hardware-wallet
circuit board. A genuine board has no extra circuit boards, no radio modules, no antennas and no
hand-soldered bodge wires.

For each suspicious region you can see, report its bounding box as fractions of the image:
left/right are fractions of the width, top/bottom are fractions of the height, all from the
top-left corner, all between 0 and 1. A box must tightly enclose the single region.

Reply with JSON only:
{"regions":[{"label":"short name","why":"one sentence","box":{"left":0.0,"top":0.0,"right":0.0,"bottom":0.0}}]}
If there is nothing suspicious, reply {"regions":[]}."""

WHAT = """What is in this image? Describe what you actually see: name the objects and their
colours. If it is a circuit board, say so and say whether anything looks hand-added, glued on,
soldered by hand, or not part of the original design. Answer in two sentences, no JSON."""


def ask(model, data_url, prompt):
    body = {
        "model": model,
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + KEY},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def as_url(im, q=90):
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=q)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--model", default="google/gemini-3.8-flash")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    w, h = im.size
    text = ask(a.model, as_url(im), FIND).strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    d = json.loads(text)

    print(f"image {w}x{h}, model {a.model}")
    for i, r in enumerate(d.get("regions", []), 1):
        b = r["box"]
        box = [b["left"] * w, b["top"] * h, b["right"] * w, b["bottom"] * h]
        # a margin, so a box that is slightly tight still shows its surroundings
        m = 0.06 * max(w, h)
        crop = im.crop((max(0, box[0] - m), max(0, box[1] - m),
                        min(w, box[2] + m), min(h, box[3] + m)))
        said = ask(a.model, as_url(crop, 92), WHAT).replace("\n", " ").strip()
        print(f"\n[{i}] claims: {r['label']}  -- {r.get('why','')}")
        print(f"    box   : left={b['left']:.2f} top={b['top']:.2f} right={b['right']:.2f} bottom={b['bottom']:.2f}")
        print(f"    crop  : {crop.size[0]}x{crop.size[1]}")
        print(f"    says  : {said[:400]}")
    if not d.get("regions"):
        print("no regions reported")
    return 0


if __name__ == "__main__":
    sys.exit(main())
