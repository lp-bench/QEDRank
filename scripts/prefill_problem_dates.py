#!/usr/bin/env python3
"""Pre-fill data/problem_dates.csv: when the proof of each problem became public.

usage: scripts/prefill_problem_dates.py [PROOFBENCH_HIDDEN]   (default ../proofbench-hidden)

Reads the references of every problem from the development repository's
Database.json and their years from its bibliography (or from a year in the
reference key) and proposes, per problem:
  open problems                  no date (status `open`; left out of the contamination split)
  resolved recently              year and month from the write-up ("Status (October
                                 2026)", "open until October 2026", "claimed in July 2026")
  everything else                the latest dated reference (the proof usually
                                 follows the conjecture), status `unchecked`
Only years are written, never the references: this repository may become
public and must not say where the proofs are.  A person checks each row and
sets status to `checked`; rows marked `checked` are kept when this is rerun.
"""

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "problem_dates.csv"
COLS = ["problem", "category", "proof_public", "status", "candidate_years", "note"]
MONTHS = "January February March April May June July August September October November December".split()
RESOLVED = re.compile(r"(?:Status \(|open until |claimed in |appeared in )(" + "|".join(MONTHS) + r") (\d{4})")


def category(difficulty: str) -> str:
    first = difficulty.split()[0].lower() if difficulty else ""
    return {"undergraduate": "calibration"}.get(first, first)


def main() -> None:
    hidden = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "proofbench-hidden")
    db = json.loads((hidden / "ProofBench/DATABASE/Database.json").read_text(encoding="utf-8"))
    bib = (hidden / "ProofBench/DATABASE/content/tex/bibliography.bib").read_text(encoding="utf-8", errors="replace")
    year: dict[str, int] = {}
    for m in re.finditer(r"@\w+\s*\{\s*([^,\s]+)\s*,(.*?)(?=\n@|\Z)", bib, re.S):
        y = re.search(r"\byear\s*=\s*[{\"]?\s*(\d{4})", m.group(2), re.I)
        if y:
            year[m.group(1)] = int(y.group(1))

    def ref_year(key: str) -> int | None:
        found = re.findall(r"(?<!\d)(19\d\d|20[0-3]\d)(?!\d)", key)
        return year.get(key) or (int(found[0]) if found else None)

    kept = {}
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            kept = {r["problem"]: r for r in csv.DictReader(f) if r["status"] == "checked"}
    rows = []
    for e in db:
        pid = "P" + e["id"]
        if pid in kept:
            rows.append(kept[pid]); continue
        diff = e.get("difficulty", "")
        resolved = RESOLVED.search(" ".join(e.get("informal_statement") or []))
        years = sorted({y for y in map(ref_year, e.get("references", [])) if y})
        row = {"problem": pid, "category": category(diff), "proof_public": "", "status": "unchecked",
               "candidate_years": " ".join(map(str, years)), "note": ""}
        if row["category"] == "open":
            row.update(status="open", note="no public proof")
        elif resolved:
            month, y = resolved.groups()
            row.update(proof_public=f"{y}-{MONTHS.index(month) + 1:02d}", note=f"{month} {y}, from the write-up")
        elif m := re.search(r"\((\d{4})\)", diff):
            row.update(proof_public=m.group(1), note="year in the database note")
        elif years:
            row.update(proof_public=str(years[-1]), note="latest dated reference")
        else:
            row.update(note="no dated reference: fill in by hand")
        rows.append(row)
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["problem"]))
    n = lambda s: sum(r["status"] == s for r in rows)
    blank = sum(r["status"] == "unchecked" and not r["proof_public"] for r in rows)
    print(f"{OUT}: {n('checked')} checked (kept), {n('unchecked')} unchecked ({blank} without a date), {n('open')} open")


if __name__ == "__main__":
    main()
