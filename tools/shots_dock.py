#!/usr/bin/env python3
"""Screenshots of the dock, closed and open, at desktop and phone width.

Kept separate from the assertions in ui_dock.py: that file decides whether the layout is correct,
this one only produces pictures of it.

    TC_UI_BASE=http://127.0.0.1:8787 python3 tools/shots_dock.py /tmp/out
"""
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test"))
from ui_dock import _find_chromium  # noqa: E402  (shares the browser lookup)

BASE = os.environ.get("TC_UI_BASE", "http://127.0.0.1:8787")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"


def main():
    os.makedirs(OUT, exist_ok=True)
    exe = os.environ.get("TC_CHROMIUM") or _find_chromium()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        try:
            # Desktop, with the panel open and a filled-in example.
            page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
            page.goto(BASE, wait_until="networkidle")
            page.screenshot(path=f"{OUT}/dock-closed.png")
            page.click("#bk-toggle")
            page.fill("#bk-key", "sk-or-v1-example-not-a-real-key")
            page.fill("#bk-model", "google/gemini-3.8-flash")
            page.wait_for_timeout(250)
            page.screenshot(path=f"{OUT}/dock-open.png")
            page.close()

            # Phone width.
            m = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            m.goto(BASE, wait_until="networkidle")
            m.click("#bk-toggle")
            m.wait_for_timeout(250)
            m.screenshot(path=f"{OUT}/dock-mobile.png")
            m.close()
        finally:
            browser.close()
    for f in ("dock-closed.png", "dock-open.png", "dock-mobile.png"):
        print(f"{OUT}/{f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
