#!/usr/bin/env python3
"""Count the box-stroke pixels in a screenshot, to prove the overlay actually rendered.

A box that exists in the DOM but is drawn off-screen, behind the photo, or in a colour that blends
in would still pass a DOM check. Looking for the stroke colour in the pixels does not.

  python3 tools/box_pixels.py <shot.png> [hex]
"""
import sys

from PIL import Image

TARGET = (0xE0, 0x52, 0x52)  # --bad, the high-severity stroke
TOL = 40


def main():
    path = sys.argv[1]
    target = tuple(int(sys.argv[2].lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)) if len(sys.argv) > 2 else TARGET
    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    hits, rows = 0, set()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - target[0]) <= TOL and abs(g - target[1]) <= TOL and abs(b - target[2]) <= TOL:
                hits += 1
                rows.add(y)
    print(f"{path} {w}x{h}  stroke {target} -> {hits} px across {len(rows)} rows")
    print("PASS: the overlay is on the pixels" if hits > 200 else "FAIL: no overlay found")


if __name__ == "__main__":
    main()
