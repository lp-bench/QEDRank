"""Lean-only grading.

The checker script (image/check_proof.py) is streamed into the sandbox over
stdin, so the sandbox image needs only Lean and Python.  It verifies that the
reference statement survives verbatim, that imports are allowed, that the
file compiles without `sorry`, and that the theorem depends on the standard
axioms only.  Its JSON report is stored in the score metadata, so line
counts, axioms and compile time are available to scripts/analyze.py.
"""

import json
from pathlib import Path

from inspect_ai.scorer import CORRECT, INCORRECT, Score, Target, accuracy, scorer, stderr
from inspect_ai.solver import TaskState
from inspect_ai.util import sandbox

CHECK_SCRIPT = (Path(__file__).resolve().parent.parent / "image" / "check_proof.py").read_text(
    encoding="utf-8"
)


@scorer(metrics=[accuracy(), stderr()])
def lean_check():
    async def score(state: TaskState, target: Target) -> Score:
        md = state.metadata
        sb = sandbox()
        ref_path = f"{md['project_dir']}/Submission/_reference_{state.sample_id}.lean"
        await sb.write_file(ref_path, md["reference"])
        try:
            submission = await sb.read_file(md["submission"])
        except Exception as e:  # file deleted or unreadable
            return Score(value=INCORRECT, explanation=f"cannot read submission: {e}")
        result = await sb.exec(
            ["python3", "-", md["project_dir"], md["submission"], ref_path, md["theorem"]],
            input=CHECK_SCRIPT,
            timeout=1200,
        )
        try:
            report = json.loads(result.stdout.strip().splitlines()[-1])
        except Exception:
            return Score(
                value=INCORRECT,
                explanation=f"checker failed: rc={result.returncode}\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}",
                metadata={"checker_error": True},
            )
        return Score(
            value=CORRECT if report["ok"] else INCORRECT,
            answer=state.output.completion if state.output else None,
            explanation="; ".join(report["errors"]) if report["errors"] else "all checks passed",
            metadata={**report, "submission_text": submission},
        )

    return score
