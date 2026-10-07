"""Lean-only grading.

The checker script (image/check_proof.py) is streamed into the sandbox over
stdin, so the sandbox image needs only Lean and Python.  It verifies that the
reference statement survives verbatim, that imports are allowed, that the
file compiles without `sorry`, and that the theorem depends on the standard
axioms only.  Its JSON report is stored in the score metadata, so line
counts, axioms and compile time are available to scripts/analyze.py.  The
session loop (sessions.py) runs the same check after every session.
"""

import json
from pathlib import Path
from typing import Any

from inspect_ai.scorer import CORRECT, INCORRECT, Score, Target, accuracy, scorer, stderr
from inspect_ai.solver import TaskState
from inspect_ai.util import sandbox

CHECK_SCRIPT = (Path(__file__).resolve().parent.parent / "image" / "check_proof.py").read_text(
    encoding="utf-8"
)


async def check_submission(md: dict[str, Any], sample_id: Any) -> dict[str, Any]:
    """Checker report for the current submission, plus `submission_text`."""
    sb = sandbox()
    ref_path = f"{md['project_dir']}/Submission/_reference_{sample_id}.lean"
    await sb.write_file(ref_path, md["reference"])
    try:
        submission = await sb.read_file(md["submission"])
    except Exception as e:  # file deleted or unreadable
        return {"ok": False, "errors": [f"cannot read submission: {e}"], "submission_text": ""}
    result = await sb.exec(
        ["python3", "-", md["project_dir"], md["submission"], ref_path, md["theorem"]],
        input=CHECK_SCRIPT,
        timeout=1200,
    )
    try:
        report = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        return {
            "ok": False,
            "errors": [f"checker failed: rc={result.returncode}\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}"],
            "checker_error": True,
            "submission_text": submission,
        }
    return {**report, "submission_text": submission}


@scorer(metrics=[accuracy(), stderr()])
def lean_check():
    async def score(state: TaskState, target: Target) -> Score:
        report = await check_submission(state.metadata, state.sample_id)
        return Score(
            value=CORRECT if report["ok"] else INCORRECT,
            answer=state.output.completion if state.output else None,
            explanation="; ".join(report["errors"]) if report["errors"] else "all checks passed",
            metadata={**report, "sessions_used": len(state.store.get("sessions", []))},
        )

    return score
