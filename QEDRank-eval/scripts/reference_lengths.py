#!/usr/bin/env python3
"""The length of each problem's reference solution, from the private development repository,
as data/reference_lengths.csv (problem, ref_lines, source): the lines of `Pxxx_sol.lean` where
that file exists, else of the `formal_proof` text in the database where it is not empty.  Open
problems have neither.  Only numbers leave the private repository.

usage: scripts/reference_lengths.py [PROOFBENCH_HIDDEN]   (default ../../proofbench-hidden)"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
hidden = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent.parent / "proofbench-hidden"
db = json.load(open(hidden / "ProofBench/DATABASE/Database.json"))
rows = []
for e in db:
    pid = "P" + e["id"]
    sol = hidden / "ProofBench/PROBLEMS" / pid / f"{pid}_sol.lean"
    proof = e.get("formal_proof")
    text = "\n".join(proof) if isinstance(proof, list) else (proof or "")
    if sol.exists():
        rows.append({"problem": pid, "ref_lines": sum(1 for _ in open(sol, errors="replace")), "source": "sol.lean"})
    elif text.strip():
        rows.append({"problem": pid, "ref_lines": len(text.strip().splitlines()), "source": "database"})
out = ROOT / "data" / "reference_lengths.csv"
with out.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["problem", "ref_lines", "source"])
    w.writeheader()
    w.writerows(sorted(rows, key=lambda r: r["problem"]))
print(f"{len(rows)} reference lengths -> {out} "
      f"({sum(r['source'] == 'sol.lean' for r in rows)} from solution files, the rest from the database)")
