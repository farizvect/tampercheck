#!/usr/bin/env python3
"""Summarise bench/results.json by class, and list the cases that did not conclude."""
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(HERE, "bench", "results.json")))
rows = d["results"]

print(f"base: {d['base']}\n")
for kind in ("real", "real-crop", "synthetic"):
    sub = [r for r in rows if r["provenance"] == kind]
    if not sub:
        continue
    dec = [r for r in sub if r["outcome"] != "no claim"]
    ok = sum(1 for r in dec if r["outcome"] == "CORRECT")
    tp = sum(1 for r in sub if r["truth"] == "tampered" and r["outcome"] == "CORRECT")
    fn = sum(1 for r in sub if r["truth"] == "tampered" and r["outcome"] == "WRONG")
    tn = sum(1 for r in sub if r["truth"] == "genuine" and r["outcome"] == "CORRECT")
    fp = sum(1 for r in sub if r["truth"] == "genuine" and r["outcome"] == "WRONG")
    print(f"{kind:10s} {len(sub):3d} cases | decided {len(dec):3d} | correct {ok:3d}"
          f" | tampered {tp} flagged / {fn} missed | genuine {tn} clean / {fp} flagged")
    nc = [r for r in sub if r["outcome"] == "no claim"]
    if nc:
        print(f"           declined: {', '.join(sorted(r['id'] for r in nc))}")

print("\nverdict distribution:", dict(Counter(r["verdict"] for r in rows)))
print("\nnot concluded (all classes):")
for r in sorted((r for r in rows if r["outcome"] == "no claim"), key=lambda x: x["id"]):
    print(f"  {r['id']:44s} {r['truth']:8s} {r['verdict']}")
print("\nmisjudged:")
for r in sorted((r for r in rows if r["outcome"] == "WRONG"), key=lambda x: x["id"]):
    print(f"  {r['id']:44s} truth={r['truth']:8s} said {r['verdict']:18s} {r['findings']}")
