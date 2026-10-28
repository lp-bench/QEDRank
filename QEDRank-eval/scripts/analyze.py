#!/usr/bin/env python3
"""Summarise Inspect logs as a CSV: one row per sample attempt.

usage: scripts/analyze.py LOG_DIR [more LOG_DIRs]   -> writes LOG_DIR/results.csv and prints it
Columns: run, model, search, problem, epoch, correct, status, polarity, sessions_used,
provider_failures, session_ends, errors, tokens_in, tokens_cached, tokens_out, tokens_total, cost_usd, total_time_s,
working_time_s, tool_calls, tool_errors, model_calls, max_tokens_stops, refusals,
max_context, lines, proof_lines, compile_s, axioms, limit, objection, submitted.
tokens_in counts every input token, cached or not (Inspect's input_tokens leaves out
the cache reads and writes that providers such as Anthropic report separately), so it
means the same for every model; tokens_cached is the part read from the prompt cache.
cost_usd is the cost Inspect computed per call at the list prices of
data/model_prices.yml (run.sh passes the file); empty when a model has no price
there (e.g. the free GWDG models) and for logs from before 2026-10-26.
status is C (correct), I (incorrect) or N (no answer: the provider ended an unsolved
attempt, see provider_retries in task.py); correct is 1 or 0, and empty for N, so the
rates of stats.py leave such attempts out (rerun those problems).
polarity is `prove`, or `disprove` when the grade is for the negation of an open
problem (Pxxx_DISPROVE.lean): the one that passed, else the one the agent edited.
sessions_used counts the sessions the model worked in; provider_failures the sessions
that ended in a provider error and were started again without counting.
session_ends lists how each session ended (submit, token, working, error,
provider_error, quota_error).
max_tokens_stops counts replies cut off by the per-reply cap (MAX_TOKENS in
run.sh; thinking counts against it), refusals the replies a safety classifier
declined.  max_context is the largest prompt of a single model call (input
tokens, cached or not): the context window a model needs for the attempt.
objection is 1 when the agent submitted a text starting with "FALSE:", the channel
for reporting a statement it believes false as formalized (problems without a
negation file; it ends the attempt, unsolved); submitted lists every submitted
text other than "done", so that informal remarks show up as well.  Review both
by hand.
"""

import csv
import sys
from pathlib import Path

from inspect_ai.event import ModelEvent, ToolEvent
from inspect_ai.log import list_eval_logs, read_eval_log

COLS = ["run", "model", "search", "problem", "epoch", "correct", "status", "polarity", "sessions_used", "provider_failures",
        "session_ends", "errors", "tokens_in",
        "tokens_cached", "tokens_out", "tokens_total", "cost_usd", "total_time_s", "working_time_s", "tool_calls", "tool_errors",
        "model_calls", "max_tokens_stops", "refusals", "max_context", "lines", "proof_lines", "compile_s", "axioms", "limit",
        "objection", "submitted"]


def all_input(u) -> int:
    """Input tokens of a usage record, cached or not."""
    return (u.input_tokens or 0) + (u.input_tokens_cache_read or 0) + (u.input_tokens_cache_write or 0)


def max_context(sample) -> int:
    """Largest prompt of a single model call in the sample, in tokens."""
    largest = 0
    for e in sample.events:
        if isinstance(e, ModelEvent) and e.output and e.output.usage:
            largest = max(largest, all_input(e.output.usage))
    return largest


def cost(usage: dict) -> float | str:
    """Cost of all model calls at the prices Inspect was given; empty if a model had none."""
    costs = [u.total_cost for u in usage.values()]
    return round(sum(costs), 4) if costs and None not in costs else ""


def stop_reasons(sample) -> list[str]:
    return [e.output.stop_reason for e in sample.events if isinstance(e, ModelEvent) and e.output]


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
                "search": str(bool((log.eval.task_args or {}).get("search", False))).lower(),
                "problem": s.id,
                "epoch": s.epoch,
                "correct": int(sc.value == "C") if sc and sc.value != "N" else "",
                "status": sc.value if sc else "",
                "polarity": md.get("polarity", "prove" if md else ""),  # logs before disprove grading: prove
                "sessions_used": sum(1 for r in sessions if r.get("counted", True)),
                "provider_failures": sum(1 for r in sessions if not r.get("counted", True)),
                "session_ends": " ".join(str(r.get("ended_by", "")).split(":")[0] for r in sessions),
                "errors": " | ".join(md.get("errors", []))[:200] if md else (sc.explanation if sc else ""),
                "tokens_in": sum(all_input(u) for u in usage.values()),
                "tokens_cached": sum(u.input_tokens_cache_read or 0 for u in usage.values()),
                "tokens_out": sum(u.output_tokens for u in usage.values()),
                "tokens_total": sum(u.total_tokens for u in usage.values()),
                "cost_usd": cost(usage),
                "total_time_s": round(s.total_time or 0),
                "working_time_s": round(s.working_time or 0),
                "tool_calls": sum(isinstance(e, ToolEvent) for e in s.events),
                "tool_errors": sum(isinstance(e, ToolEvent) and e.error is not None for e in s.events),
                "model_calls": sum(isinstance(e, ModelEvent) for e in s.events),
                "max_tokens_stops": stop_reasons(s).count("max_tokens"),
                "refusals": stop_reasons(s).count("content_filter"),
                "max_context": max_context(s),
                "lines": md.get("lines", ""),
                "proof_lines": md.get("proof_lines", ""),
                "compile_s": md.get("compile_seconds", ""),
                "axioms": " ".join(md.get("axioms", [])),
                "limit": s.limit.type if s.limit else "",
                "objection": int(any(r.get("objection") for r in sessions)),
                "submitted": " | ".join(t for r in sessions if (t := r.get("submitted")) and t.lower() != "done")[:500],
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
              f"tools={r['tool_calls']:>3} tool_errors={r['tool_errors']:>2} lines={r['lines']}"
              + (" OBJECTION (statement false?)" if r["objection"] else ""))


if __name__ == "__main__":
    main()
