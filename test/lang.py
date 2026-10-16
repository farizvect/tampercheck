#!/usr/bin/env python3
"""Which language the page comes up in, checked in a real browser.

The default is English, and it is English because that is the app's default, not because the
browser happened to ask for it. A browser set to Indonesian must still get English on a first
visit: the language follows an explicit choice, and nothing else.

That distinction is invisible in the source - both readings of the old line look reasonable - and
it only shows up when a browser with a non-English locale loads the page. So it is asserted here,
against a real browser, in three states:

  - a first visit from an Indonesian-locale browser  -> English
  - after an explicit switch to Indonesian           -> Indonesian, and it sticks across a reload
  - a stale or hand-edited stored value              -> English, not a broken document

    TC_UI_BASE=http://127.0.0.1:8787 python3 test/lang.py
"""
import glob
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("TC_UI_BASE", "http://127.0.0.1:8787")

# The label on the language switcher is the cheapest thing to read back that differs per language.
EN_LABEL = "language"
ID_LABEL = "bahasa"

fails = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(f"{name}: {detail}")


def state(page):
    return page.evaluate(
        """() => ({
             doc: document.documentElement.lang,
             select: document.querySelector('#lang') ? document.querySelector('#lang').value : null,
             label: (() => { const e = document.querySelector('[data-i18n="language"]');
                             return e ? e.textContent.trim() : null; })(),
             stored: (() => { try { return localStorage.getItem('tc-lang'); } catch { return 'n/a'; } })(),
           })""")


def check_state(page, label, want_lang, want_label, want_select):
    s = state(page)
    check(f"{label}: the document language is {want_lang}", s["doc"] == want_lang, f"got {s['doc']!r}")
    check(f"{label}: the switcher shows {want_lang}", s["select"] == want_select, f"got {s['select']!r}")
    check(f"{label}: the visible text is {want_label!r}", s["label"] == want_label, f"got {s['label']!r}")


def run(page):
    # 1. First visit from an Indonesian-locale browser: English, because English is the default.
    print("\n=== first visit, browser locale id-ID")
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_timeout(300)
    check_state(page, "id-ID first visit", "en", EN_LABEL, "en")
    s = state(page)
    check("nothing was written to storage just by loading", s["stored"] is None, f"got {s['stored']!r}")

    # 2. An explicit switch is honoured and remembered.
    print("\n=== explicit switch to Indonesian")
    page.select_option("#lang", "id")
    page.wait_for_timeout(300)
    check_state(page, "after switching", "id", ID_LABEL, "id")
    check("the choice was stored", state(page)["stored"] == "id", f"got {state(page)['stored']!r}")

    print("\n=== reload keeps the choice")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(300)
    check_state(page, "after reload", "id", ID_LABEL, "id")

    # 3. A stored value that is not a language must not be trusted.
    print("\n=== stale stored value")
    page.evaluate("localStorage.setItem('tc-lang', 'xx')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(300)
    check_state(page, "stored 'xx'", "en", EN_LABEL, "en")

    page.evaluate("localStorage.removeItem('tc-lang')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(300)
    check_state(page, "cleared storage", "en", EN_LABEL, "en")


def _find_chromium():
    for pat in ("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome",
                "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    for cand in ("/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"):
        if os.path.exists(cand):
            return cand
    return None


def main():
    exe = _find_chromium()
    if not exe:
        print("no chromium found for playwright")
        return 1
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe, args=["--no-sandbox"])
        # The whole point: a browser that is not asking for English.
        ctx = browser.new_context(locale="id-ID", viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        try:
            run(page)
        finally:
            page.close()
            ctx.close()
            browser.close()

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS: the app defaults to English, and only an explicit choice changes it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
