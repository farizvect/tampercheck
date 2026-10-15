#!/usr/bin/env python3
"""Probe the JEV Box primitive on the same image, for comparison.

JEV is a separate model on a separate endpoint (the Decisions API), not a chat completion. A Box
question returns exactly one box and has no "not found" answer: it returns four edges even when
the target is absent, so presence has to be asked separately as a Noul question in the same call.
This measures what it actually returns before anything depends on it.

  python3 tools/jev_probe.py <image>
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

URL = "https://openrouter.ai/api/alpha/decisions"

# One Box question per target, because a Box question answers with one box. Presence is asked
# alongside it as a Noul, since a box is returned whether or not the thing is there.
QUESTIONS = {
    "extra_board_present": {"type": "noul",
                            "instructions": "Is a second, smaller circuit board present that is not part of the original design?",
                            "criteria": {"true": "A second circuit board is visible that is not part of the original design.",
                                         "false": "Only the original circuit board is present."}},
    "extra_board": {"type": "box", "instructions": "the extra circuit board that is not part of the original design"},
    "bodge_wires_present": {"type": "noul",
                            "instructions": "Are hand-soldered wires present that are not part of the original design?",
                            "criteria": {"true": "Hand-soldered wires are visible that are not part of the original design.",
                                         "false": "No hand-soldered wires beyond the original assembly."}},
    "bodge_wires": {"type": "box", "instructions": "hand-soldered wires that are not part of the original design"},
    "radio_module_present": {"type": "noul",
                             "instructions": "Is a shielded radio or cellular module present?",
                             "criteria": {"true": "A shielded radio or cellular module is visible.",
                                          "false": "No shielded radio or cellular module is visible."}},
    "radio_module": {"type": "box", "instructions": "the shielded radio or cellular module"},
}


def main():
    path = sys.argv[1]
    im = Image.open(path).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    body = {
        "model": "typesafe/jev-1.14",
        "state": ["Photo of an opened hardware-wallet circuit board:", {"type": "image_url", "image_url": {"url": url}}],
        "questions": QUESTIONS,
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:600]}")
        return 1
    print(json.dumps(data, indent=2)[:3000])
    print("\nusage:", data.get("usage"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
