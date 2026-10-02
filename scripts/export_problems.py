#!/usr/bin/env python3
"""Copy challenge statement files out of the private ProofBench repository.

usage: scripts/export_problems.py --proofbench PATH --ids P083 P088 P090 [--out data]

Only `Pxxx.lean` (the statement with one sorry) is copied; `_sol`, `_LB`, `_UB`
and `_DISPROVE` files never leave the ProofBench repository.  Writes
OUT/problems/Pxxx.lean and OUT/problems.json.
"""

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path


def qualified_theorem(text: str, pid: str) -> str:
    stack: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^namespace\s+(\S+)", line)
        if m:
            stack.append(m.group(1))
        elif re.match(r"^end\s+\S+", line) and stack:
            stack.pop()
        elif re.match(rf"^\s*theorem\s+{pid}\b", line):
            return ".".join(stack + [pid])
    raise SystemExit(f"{pid}: no `theorem {pid}` found")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proofbench", required=True)
    ap.add_argument("--ids", nargs="+", required=True)
    ap.add_argument("--out", default="data")
    a = ap.parse_args()
    pb = Path(a.proofbench)
    db = {e["id"]: e for e in json.loads((pb / "ProofBench/DATABASE/Database.json").read_text())}
    commit = subprocess.run(["git", "-C", str(pb), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    out = Path(a.out) / "problems"
    out.mkdir(parents=True, exist_ok=True)
    problems = []
    for pid in a.ids:
        src = pb / "ProofBench/PROBLEMS" / pid / f"{pid}.lean"
        text = src.read_text(encoding="utf-8")
        if text.count("sorry") != 1:
            raise SystemExit(f"{pid}: expected exactly one sorry, found {text.count('sorry')}")
        shutil.copyfile(src, out / f"{pid}.lean")
        e = db.get(pid[1:], {})
        problems.append({
            "id": pid,
            "file": f"problems/{pid}.lean",
            "theorem": qualified_theorem(text, pid),
            "name": e.get("name", ""),
            "difficulty": e.get("difficulty", ""),
        })
        print(f"exported {pid}: {problems[-1]['theorem']}  ({e.get('difficulty','')})")
    (Path(a.out) / "problems.json").write_text(
        json.dumps({"source_commit": commit, "problems": problems}, indent=1, ensure_ascii=False) + "\n"
    )
    print(f"wrote {Path(a.out) / 'problems.json'} (ProofBench {commit[:10]})")


if __name__ == "__main__":
    main()
