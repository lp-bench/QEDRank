"""Turn Inspect eval logs into the bundle that QEDRank's statistics read.

    python -m proofbench_harness.export logs/2026-10-06T…_proofbench_….eval --out bundle.json
    node qedrank/cli.js import-agent --bundle bundle.json --run-id agent-x4

One log is one model; pass several logs to compare models in one QEDRank run.

`--regrade errors` runs the independent check again on the stored final file of every sample
whose check could not be carried out, so a grader hiccup does not cost a new agent run;
`--regrade all` re-checks every sample (for example after the checker was improved).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from inspect_ai.log import EvalLog, read_eval_log

from .grader import QEDRankGrader
from .sessions import CHAIN_KEY

BUNDLE_SCHEMA = "proofbench-agent-bundle-v1"
_PROBLEM_FIELDS = ("problem_id", "target", "title", "difficulty", "mathematical_status", "publication_date", "public_formal_proof", "subject", "notes")


def _dump(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "model_dump"):
        return obj.model_dump(exclude_none=True)
    return obj


def sample_record(sample: Any) -> dict[str, Any]:
    """Everything the statistics need about one sample, without the transcript."""
    store = sample.store or {}
    chain = store.get(CHAIN_KEY)
    meta = sample.metadata or {}
    usage = {name: _dump(u) for name, u in (sample.model_usage or {}).items()}
    return {
        "problem": {k: meta.get(k) for k in _PROBLEM_FIELDS} | {"problem_id": meta.get("problem_id") or str(sample.id)},
        "challenge": meta.get("challenge"),
        "epoch": sample.epoch,
        "chain": chain,
        "error": sample.error.message if sample.error else None,
        "sample_limit": _dump(sample.limit),
        "inspect_total_time_s": sample.total_time,
        "inspect_working_time_s": sample.working_time,
        "model_usage": usage,
        "scores": {name: {"value": s.value, "metadata": s.metadata} for name, s in (sample.scores or {}).items()},
    }


def bundle_from_log(log: EvalLog) -> dict[str, Any]:
    ev = log.eval
    return {
        "schema": BUNDLE_SCHEMA,
        "inspect": {
            "task": ev.task,
            "task_id": ev.task_id,
            "run_id": ev.run_id,
            "created": ev.created,
            "status": log.status,
            "packages": ev.packages,
            "revision": _dump(ev.revision),
            "task_args": ev.task_args,
        },
        "model": ev.model,
        "model_generate_config": _dump(ev.model_generate_config),
        "run_metadata": ev.metadata or {},
        "samples": [sample_record(s) for s in (log.samples or [])],
    }


async def regrade(bundle: dict[str, Any], grader: QEDRankGrader, which: str) -> int:
    """Re-run the independent check on stored final files. Returns the number of samples re-checked."""
    n = 0
    for s in bundle["samples"]:
        chain = s.get("chain")
        if not chain or chain.get("final_solution") is None or not s.get("challenge"):
            continue
        if which == "errors" and chain.get("final_verdict") != "grader_error":
            continue
        grade = await grader.grade(challenge=s["challenge"], solution=chain["final_solution"], target=s["problem"]["target"])
        chain["regraded_from"] = {"verdict": chain.get("final_verdict"), "reasons": chain.get("final_reasons")}
        chain["final_grade"] = grade
        chain["final_verdict"] = grade.get("verdict")
        chain["final_reasons"] = grade.get("reasons") or []
        sessions = chain.get("sessions") or []
        if grade.get("verdict") == "solved":
            chain["solved_at_session"] = chain.get("solved_at_session") or len(sessions) or 1
        else:
            chain["solved_at_session"] = None
        if sessions:
            sessions[-1]["verdict"] = grade.get("verdict")
            sessions[-1]["reasons"] = grade.get("reasons") or []
        n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="proofbench-export", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="+", help="Inspect eval logs (.eval or .json)")
    ap.add_argument("--out", required=True, help="bundle file to write (.json)")
    ap.add_argument("--regrade", choices=["none", "errors", "all"], default="none")
    ap.add_argument("--grader", choices=["local", "docker"], default="local")
    ap.add_argument("--lean-project", default=None, help="Lean project for local re-grading")
    ap.add_argument("--image", default="proofbench-sandbox:latest", help="image for docker re-grading")
    ap.add_argument("--library-prefix", default="ProofBench.Mathlib_Problems")
    args = ap.parse_args(argv)

    bundles = [bundle_from_log(read_eval_log(p)) for p in args.logs]
    if args.regrade != "none":
        for b in bundles:
            g = (b["run_metadata"].get("grader") or {})
            grader = QEDRankGrader(
                mode=args.grader,
                lean_project=args.lean_project,
                image=args.image if args.grader == "docker" else None,
                library_prefixes=[p.strip() for p in args.library_prefix.split(",") if p.strip()],
                allow_extra_imports=bool(g.get("allow_extra_imports")),
                allow_unused_sorry=bool(g.get("allow_unused_sorry")),
            )
            n = asyncio.run(regrade(b, grader, args.regrade))
            print(f"{b['model']}: re-checked {n} sample(s)", file=sys.stderr)
    out = {"schema": BUNDLE_SCHEMA, "bundles": bundles} if len(bundles) > 1 else bundles[0]
    Path(args.out).write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    total = sum(len(b["samples"]) for b in bundles)
    print(f"wrote {args.out}: {len(bundles)} log(s), {total} sample(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
