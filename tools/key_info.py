#!/usr/bin/env python3
"""Print the account's own limit and usage from OpenRouter, never the key.

  python3 tools/key_info.py
"""
import json
import os
import urllib.request

ENVF = os.environ.get("TC_ENV_FILE", os.path.expanduser("~/.config/tampercheck/.env"))
KEY = os.environ.get("TC_API_KEY") or ""
if not KEY and os.path.exists(ENVF):
    for line in open(ENVF):
        if line.startswith("OPENROUTER_API_KEY="):
            KEY = line.split("=", 1)[1].strip().strip('"').strip("'")
            break


def get(path):
    req = urllib.request.Request("https://openrouter.ai/api/v1" + path,
                                 headers={"authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    print("key present:", bool(KEY), "len", len(KEY), "prefix", (KEY[:8] + "...") if KEY else "-")
    try:
        d = get("/key").get("data", {})
    except Exception as e:
        print("GET /key failed:", e)
        return 1
    for k in ("label", "usage", "limit", "limit_remaining", "is_free_tier", "is_provisioning_key", "rate_limit"):
        if k in d:
            print(f"  {k}: {d[k]}")
    try:
        c = get("/credits").get("data", {})
        print("credits:", {k: c.get(k) for k in ("total_credits", "total_usage") if k in c})
    except Exception as e:
        print("GET /credits failed:", e)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
