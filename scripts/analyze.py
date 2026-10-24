#!/usr/bin/env python3
"""Summarise Inspect logs as a CSV: one row per sample attempt.

usage: scripts/analyze.py LOG_DIR [more LOG_DIRs]   -> writes LOG_DIR/results.csv and prints it
Columns: run, model, problem, epoch, correct, polarity, sessions_used, session_ends,
errors, tokens_in, tokens_out, tokens_total, total_time_s, working_time_s,
tool_calls, tool_errors, model_calls, max_context, lines, proof_lines, compile_s,
axioms, limit.
polarity is `prove`, or `disprove` when the grade is for the negation of an open
problem (Pxxx_DISPROVE.lean): the one that passed, else the one the agent edited.
session_ends lists how each session ended (submit, token, working, error).
max_context is the largest prompt of a single model call (input tokens, cached
or not): the context window a model needs for the attempt.
"""

import csv
import sys
from pathlib import Path

from inspect_ai.event import ModelEvent, ToolEvent
from inspect_ai.log import list_eval_logs, read_eval_log

COLS = ["run", "model", "problem", "epoch", "correct", "polarity", "sessions_used", "session_ends", "errors", "tokens_in",
        "tokens_out", "tokens_total", "total_time_s", "working_time_s", "tool_calls", "tool_errors", "model_calls",
        "max_context", "lines", "proof_lines", "compile_s", "axioms", "limit"]


def max_context(sample) -> int:
    """Largest prompt of a single model call in the sample, in tokens."""
    largest = 0
    for e in sample.events:
        if isinstance(e, ModelEvent) and e.output and e.output.usage:
            u = e.output.usage
            largest = max(largest, (u.input_tokens or 0) + (u.input_tokens_cache_read or 0)
                          + (u.input_tokens_cache_write or 0))
    return largest


def rows_for(log_dir: Path):
    for info in list_eval_logs(str(log_dir)):
        log = read_eval_log(info)
        for s in log.samples or []:
            sc = (s.scores or {}).get("lean_check")
            md = sc.metadata if sc and sc.metadata else {}
            usage = s.model_usage or {}
            sessions = (s.store or {}).get("sessions", [])
            yield {
                "run": log_dir.name,
                "model": log.eval.model,
                "problem": s.id,
                "epoch": s.epoch,
                "correct": int(sc.value == "C") if sc else "",
                "polarity": md.get("polarity", "prove" if md else ""),  # logs before disprove grading: prove
                "sessions_used": len(sessions),
                "session_ends": " ".join(str(r.get("ended_by", "")).split(":")[0] for r in sessions),
                "errors": " | ".join(md.get("errors", []))[:200] if md else (sc.explanation if sc else ""),
                "tokens_in": sum(u.input_tokens for u in usage.values()),
                "tokens_out": sum(u.output_tokens for u in usage.values()),
                "tokens_total": sum(u.total_tokens for u in usage.values()),
                "total_time_s": round(s.total_time or 0),
                "working_time_s": round(s.working_time or 0),
                "tool_calls": sum(isinstance(e, ToolEvent) for e in s.events),
                "tool_errors": sum(isinstance(e, ToolEvent) and e.error is not None for e in s.events),
                "model_calls": sum(isinstance(e, ModelEvent) for e in s.events),
                "max_context": max_context(s),
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
        print(f"{r['model']:28} {r['problem']:6} ok={r['correct']} {r['polarity']:8} sessions={r['sessions_used']} "
              f"[{r['session_ends']}] tok={r['tokens_total']:>8} out={r['tokens_out']:>7} t={r['total_time_s']:>5}s "
              f"tools={r['tool_calls']:>3} tool_errors={r['tool_errors']:>2} lines={r['lines']}")


if __name__ == "__main__":
    main()
