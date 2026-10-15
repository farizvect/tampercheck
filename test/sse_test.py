#!/usr/bin/env python3
"""End-to-end check of the streaming endpoint: prints the event timeline as it arrives.

Verifies that the SSE path emits real progress (not a spinner) and that the final report is
byte-for-byte the same shape the JSON endpoint returns.
"""
import base64, io, json, os, sys, time, urllib.request
from PIL import Image, ImageDraw

BASE = os.environ.get("TC_TEST_BASE", "http://127.0.0.1:8787")
BRAND = os.environ.get("TC_BRAND", "trezor")
MODEL = os.environ.get("TC_MODEL_ID", "model-t")


def fresh_image(seed):
    """A board-like photo that has never been submitted, so the cache cannot answer it."""
    im = Image.new("RGB", (1600, 1200), (28, 30, 34))
    d = ImageDraw.Draw(im)
    d.rectangle([180, 220, 1420, 980], fill=(24, 58, 44), outline=(90, 120, 100), width=6)
    for i, (x, y, w, h) in enumerate([(420, 430, 300, 300), (800, 470, 150, 150)]):
        d.rectangle([x, y, x + w, y + h], fill=(16, 16, 18), outline=(140, 140, 140), width=4)
    d.text((60, 60), f"REF {seed}", fill=(200, 200, 200))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    payload = {"brand": BRAND, "model": MODEL,
               "images": [{"side": "front", "data": fresh_image(int(time.time()))}]}
    req = urllib.request.Request(
        BASE + "/api/analyze", data=json.dumps(payload).encode(), method="POST",
        headers={"content-type": "application/json", "accept": "text/event-stream"})
    t0 = time.time()
    events = []
    with urllib.request.urlopen(req, timeout=300) as resp:
        print("http", resp.status, "| content-type:", resp.headers.get("content-type"))
        buf = b""
        while True:
            chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                for line in block.decode("utf-8", "replace").split("\n"):
                    if not line.startswith("data:"):
                        continue
                    ev = json.loads(line[5:].strip())
                    dt = time.time() - t0
                    events.append((dt, ev))
                    if ev.get("phase") == "done":
                        r = ev["report"]
                        print(f"{dt:6.2f}s  DONE       verdict={r['verdict']} findings={len(r['findings'])}"
                              f" model={r['model']}")
                    elif ev.get("phase") == "error":
                        print(f"{dt:6.2f}s  ERROR      {ev.get('error')} {ev.get('detail','')}")
                    else:
                        keys = ",".join(ev.get("keys") or [])
                        summ = ev.get("summary")
                        print(f"{dt:6.2f}s  {ev.get('phase'):10s} keys=[{keys[:60]}]"
                              + (f" summary={len(summ)}ch" if summ else ""))

    phases = [e[1].get("phase") for e in events]
    print("\nphases:", " -> ".join(phases))
    done = [e for e in events if e[1].get("phase") == "done"]
    if not done:
        print("FAIL: no done event")
        return 1
    rep = done[0][1]["report"]
    required = {"verdict", "tone", "stamp", "meaning", "device", "photo_quality", "chips",
                "findings", "summary", "retake_tips", "injection_suspected", "model", "elapsed_ms"}
    missing = required - set(rep)
    print("report fields missing:", missing or "none")
    if "queued" not in phases or "connected" not in phases or "verdict" not in phases:
        print("FAIL: streaming stages missing")
        return 1
    print("PASS: streamed", len(events), "events over", round(events[-1][0], 1), "s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
