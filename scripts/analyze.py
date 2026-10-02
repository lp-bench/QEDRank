#!/usr/bin/env python3
"""Summarise Inspect logs as a CSV: one row per sample attempt.

usage: scripts/analyze.py LOG_DIR [more LOG_DIRs]   -> writes LOG_DIR/results.csv and prints it
Columns: run, model, problem, epoch, correct, errors, tokens_in, tokens_out,
tokens_total, total_time_s, working_time_s, tool_calls, model_calls, lines,
proof_lines, compile_s, axioms, limit
"""

import csv
import sys
from pathlib import Path

from inspect_ai.event import ModelEvent, ToolEvent
from inspect_ai.log import list_eval_logs, read_eval_log

COLS = ["run", "model", "problem", "epoch", "correct", "errors", "tokens_in", "tokens_out", "tokens_total",
        "total_time_s", "working_time_s", "tool_calls", "model_calls", "lines", "proof_lines", "compile_s",
        "axioms", "limit"]


def rows_for(log_dir: Path):
    for info in list_eval_logs(str(log_dir)):
        log = read_eval_log(info)
        for s in log.samples or []:
            sc = (s.scores or {}).get("lean_check")
            md = sc.metadata if sc and sc.metadata else {}
            usage = s.model_usage or {}
            yield {
                "run": log_dir.name,
                "model": log.eval.model,
                "problem": s.id,
                "epoch": s.epoch,
                "correct": int(sc.value == "C") if sc else "",
                "errors": " | ".join(md.get("errors", []))[:200] if md else (sc.explanation if sc else ""),
                "tokens_in": sum(u.input_tokens for u in usage.values()),
                "tokens_out": sum(u.output_tokens for u in usage.values()),
                "tokens_total": sum(u.total_tokens for u in usage.values()),
                "total_time_s": round(s.total_time or 0),
                "working_time_s": round(s.working_time or 0),
                "tool_calls": sum(isinstance(e, ToolEvent) for e in s.events),
                "model_calls": sum(isinstance(e, ModelEvent) for e in s.events),
                "lines": md.get("lines", ""),
                "proof_lines": md.get("proof_lines", ""),
                "compile_s": md.get("compile_seconds", ""),
                "axioms": " ".join(md.get("axioms", [])),
                "limit": s.limit.type if s.limit else "",
            }


def main() -> None:
    dirs = [Path(d) for d in sys.argv[1:]] or [Path("logs")]
    rows = [r for d in dirs if d.exists() for r in rows_for(d)]
    if not rows:
        print("no samples found in", ", ".join(map(str, dirs))); return
    out = dirs[0] / "results.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS); w.writeheader(); w.writerows(rows)
    print(f"{len(rows)} attempts -> {out}")
    for r in rows:
        print(f"{r['model']:28} {r['problem']:6} e{r['epoch']} ok={r['correct']} tok={r['tokens_total']:>8} "
              f"t={r['total_time_s']:>5}s work={r['working_time_s']:>5}s tools={r['tool_calls']:>3} lines={r['lines']}")


if __name__ == "__main__":
    main()
