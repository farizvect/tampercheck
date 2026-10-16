#!/usr/bin/env python3
"""The own-key dock, checked against a real browser layout.

The dock is positioned with `position: fixed`, and a fixed element is exactly the kind of thing that
looks right in the CSS and wrong on the screen: a sticky sibling covers it, a stacking context traps
it, an inherited transform makes it scroll with the page. So these assertions are made against
getBoundingClientRect() on a rendered page, not against the stylesheet.

What is checked:
  - it is out of the page flow, in the bottom-left corner, and not inside the header or main content
  - it clears the action bar rather than sitting under it
  - the panel opens above the tab, fits in the viewport, and closes on Escape
  - the state dot reflects whether a key is set
  - the fields are reachable and the check button runs

    TC_UI_BASE=http://127.0.0.1:8787 python3 test/ui_dock.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("TC_UI_BASE", "http://127.0.0.1:8787")
DESKTOP = {"width": 1280, "height": 900}
MOBILE = {"width": 390, "height": 844}

fails = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(f"{name}: {detail}")


def rect(page, sel):
    return page.evaluate(
        """(s) => { const e = document.querySelector(s); if (!e) return null;
             const r = e.getBoundingClientRect();
             return {x:r.x, y:r.y, w:r.width, h:r.height, top:r.top, bottom:r.bottom, left:r.left, right:r.right}; }""",
        sel)


def run(page, viewport, label):
    print(f"\n=== {label}  {viewport['width']}x{viewport['height']}")
    page.set_viewport_size(viewport)
    page.goto(BASE, wait_until="networkidle")
    vw, vh = viewport["width"], viewport["height"]

    dock = rect(page, "#byok")
    tab = rect(page, "#bk-toggle")
    bar = rect(page, ".actionbar")
    check("the dock exists", dock is not None)
    if not dock:
        return

    # Out of the page flow.
    pos = page.evaluate("getComputedStyle(document.querySelector('#byok')).position")
    check("position is fixed, so it does not scroll with the page", pos == "fixed", pos)
    inside = page.evaluate("""() => {
        const d = document.querySelector('#byok');
        return !!d.closest('header, main, .panel, .rail, footer'); }""")
    check("it is not inside the header, main, the step rail or the footer", not inside)

    # Bottom-left.
    cx, cy = dock["x"] + dock["w"] / 2, dock["y"] + dock["h"] / 2
    check("it sits in the left third", cx < vw / 3, f"centre x={cx:.0f} of {vw}")
    check("it sits in the bottom third", cy > 2 * vh / 3, f"centre y={cy:.0f} of {vh}")

    # Above the action bar, not under it.
    if bar:
        check("it clears the action bar", dock["bottom"] <= bar["top"] + 1,
              f"dock bottom {dock['bottom']:.0f} vs bar top {bar['top']:.0f}")
    check("it is fully inside the viewport", dock["bottom"] <= vh and dock["left"] >= 0,
          f"bottom {dock['bottom']:.0f} of {vh}")

    # Hugging the window's own corner, outside the centred text column. The dock is a floating
    # control: aligning it with the column (which is what it did before) makes it read as part of the
    # page rather than as something sitting over it.
    check("it hugs the window's left edge", dock["left"] <= 24, f"left {dock['left']:.0f}px")
    col = rect(page, "main")
    if col and col["left"] > 40:
        check("on a wide viewport it sits outside the centred column",
              dock["right"] < col["left"], f"dock right {dock['right']:.0f} vs column left {col['left']:.0f}")

    # Closed by default.
    check("the panel starts closed", page.evaluate("document.querySelector('#bk-panel').hidden"))
    check("aria-expanded starts false", page.get_attribute("#bk-toggle", "aria-expanded") == "false")

    # Opens above the tab.
    page.click("#bk-toggle")
    page.wait_for_selector("#bk-panel:not([hidden])", timeout=3000)
    panel = rect(page, "#bk-panel")
    check("the panel opens above the tab", panel["bottom"] <= tab["top"] + 1,
          f"panel bottom {panel['bottom']:.0f} vs tab top {tab['top']:.0f}")
    check("the panel fits inside the viewport", panel["left"] >= 0 and panel["right"] <= vw,
          f"x {panel['left']:.0f}..{panel['right']:.0f} of {vw}")
    check("the panel is on screen", panel["top"] >= 0, f"top {panel['top']:.0f}")
    check("aria-expanded is now true", page.get_attribute("#bk-toggle", "aria-expanded") == "true")

    # The fields are real inputs.
    for sel, want in (("#bk-key", "password"), ("#bk-model", "text"), ("#bk-base", "text")):
        check(f"{sel} is a {want} input", page.get_attribute(sel, "type") == want)

    # Escape closes it.
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    check("Escape closes the panel", page.evaluate("document.querySelector('#bk-panel').hidden"))

    # A key turns the state dot on; clear turns it off.
    page.click("#bk-toggle")
    page.fill("#bk-key", "sk-or-v1-notarealkey")
    page.wait_for_timeout(150)
    check("the dock shows the active state once a key is typed",
          "on" in (page.get_attribute("#byok", "class") or ""))
    check("the state text says so", page.inner_text("#bk-state").strip() != "")
    page.click("#bk-clear")
    page.wait_for_timeout(150)
    check("clear removes the active state", "on" not in (page.get_attribute("#byok", "class") or ""))
    check("clear empties the key field", page.input_value("#bk-key") == "")

    # The key must not be persisted anywhere.
    stored = page.evaluate("""() => JSON.stringify({
        local: Object.keys(localStorage), session: Object.keys(sessionStorage) })""")
    check("nothing about the key is written to storage",
          "bk-key" not in stored and "key" not in stored.lower().replace("tc-lang", ""), stored[:80])

    # And the check button reaches the server.
    page.fill("#bk-key", "sk-or-v1-" + "0" * 64)
    with page.expect_response(lambda r: "/api/model-check" in r.url, timeout=30000) as resp:
        page.click("#bk-check")
    check("the check button calls the server", resp.value.status == 200, f"HTTP {resp.value.status}")
    page.wait_for_selector("#bk-result .ck", timeout=30000)
    text = page.inner_text("#bk-result")
    check("the result names the key check", "key" in text)
    check("the result carries no key material", "sk-or-v1-0000" not in text)


def main():
    # The installed playwright pins a browser build number that may not be the one in the cache, so
    # an available chromium is used explicitly rather than making the suite depend on a download.
    exe = os.environ.get("TC_CHROMIUM") or _find_chromium()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        try:
            for viewport, label in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
                page = browser.new_page(viewport=viewport)
                try:
                    run(page, viewport, label)
                finally:
                    page.close()
        finally:
            browser.close()

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS: the dock is out of the flow, in the bottom-left, above the action bar, and usable")
    return 0


def _find_chromium():
    import glob
    for pat in ("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome",
                "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    for cand in ("/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"):
        if os.path.exists(cand):
            return cand
    return None


if __name__ == "__main__":
    sys.exit(main())
