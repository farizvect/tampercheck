#!/usr/bin/env python3
"""Crop a full-width browser screenshot down to the content column, for the README.

The page is a fixed-width column centred in a wide viewport, so a raw screenshot is mostly empty
margin. This keeps the column and drops the rest, which also keeps the file small.

  python3 tools/crop_shots.py <shot.png> <out.png> [left] [right]
"""
import os
import sys

from PIL import Image

COL_LEFT, COL_RIGHT = 470, 1450


def main():
    src = sys.argv[1]
    out = sys.argv[2]
    left = int(sys.argv[3]) if len(sys.argv) > 3 else COL_LEFT
    right = int(sys.argv[4]) if len(sys.argv) > 4 else COL_RIGHT
    im = Image.open(src).convert("RGB")
    w, h = im.size
    box = (max(0, left), 0, min(w, right), h)
    crop = im.crop(box)
    # A screenshot of a report is mostly photograph, which PNG stores badly. JPEG keeps the README
    # from carrying a megabyte per image; the UI is high-contrast monospace, so it survives q88.
    if out.lower().endswith((".jpg", ".jpeg")):
        crop.save(out, "JPEG", quality=88, optimize=True)
    else:
        crop.save(out)
    kb = round(os.path.getsize(out) / 1024)
    print(f"{os.path.basename(src)} {w}x{h} -> {os.path.basename(out)} "
          f"{box[2] - box[0]}x{h}  {kb} KB")


if __name__ == "__main__":
    main()
