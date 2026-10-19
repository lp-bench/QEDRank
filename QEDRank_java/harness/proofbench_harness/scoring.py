"""Scoring: the verdict of the independent Lean check on the last session's file.

The scorer adds no judgement of its own. It reports what the session chain stored, and grades
the working file itself only when the chain ended before its last check (for example because
a sample-level safety limit cancelled it).

A grading that could not be carried out is neither a success nor a failure: such samples are
left out of `solve_rate` and counted by `grader_errors`.
"""

from __future__ import annotations

from typing import Any

from inspect_ai.scorer import Metric, SampleScore, Score, Scorer, Target, metric, scorer
from inspect_ai.solver import TaskState
from inspect_ai.util import sandbox

from .grader import Grader, grader_error
from .sessions import CHAIN_KEY, read_text


def _meta(s: SampleScore) -> dict[str, Any]:
    return s.score.metadata or {}


@metric
def solve_rate() -> Metric:
    """Share of problems whose final file passed the independent check, over the problems that could be graded."""

    def compute(scores: list[SampleScore]) -> float:
        graded = [s for s in scores if not _meta(s).get("grader_error")]
        return sum(1 for s in graded if _meta(s).get("verdict") == "solved") / len(graded) if graded else float("nan")

    return compute


@metric
def grader_errors() -> Metric:
    """Number of problems whose check could not be carried out (excluded from solve_rate)."""

    def compute(scores: list[SampleScore]) -> float:
        return float(sum(1 for s in scores if _meta(s).get("grader_error")))

    return compute


@metric
def mean_sessions() -> Metric:
    """Mean number of sessions used per problem."""

    def compute(scores: list[SampleScore]) -> float:
        used = [m["sessions_used"] for m in map(_meta, scores) if isinstance(m.get("sessions_used"), int)]
        return sum(used) / len(used) if used else float("nan")

    return compute


@metric
def mean_completeness_unsolved() -> Metric:
    """Mean completeness over unsolved problems whose final file compiles."""

    def compute(scores: list[SampleScore]) -> float:
        vals = [m["completeness"] for m in map(_meta, scores) if m.get("verdict") == "not_solved" and isinstance(m.get("completeness"), (int, float))]
        return sum(vals) / len(vals) if vals else float("nan")

    return compute


@scorer(metrics=[solve_rate(), grader_errors(), mean_sessions(), mean_completeness_unsolved()])
def lean_check(grader: Grader, work_path_template: str = "ProofBench/PROBLEMS/{id}/{id}.lean") -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        chain: dict[str, Any] | None = state.store.get(CHAIN_KEY)
        grade: dict[str, Any] | None = (chain or {}).get("final_grade")
        solution: str | None = (chain or {}).get("final_solution")
        sessions = (chain or {}).get("sessions") or []
        ungraded = grade is None or (sessions and sessions[-1].get("verdict") == "not_graded")
        if ungraded:
            problem_id = str(state.metadata.get("problem_id") or state.sample_id)
            try:
                solution = await read_text(sandbox(), work_path_template.format(id=problem_id))
                grade = await grader.grade(challenge=str(state.metadata["challenge"]), solution=solution, target=str(state.metadata["target"]))
            except Exception as err:
                grade = grader_error("final_check_failed", str(err))
            if chain is not None:
                chain.update(final_grade=grade, final_solution=solution, final_verdict=grade["verdict"], final_reasons=grade.get("reasons") or [], graded_by="scorer")
                if grade["verdict"] == "solved" and chain.get("solved_at_session") is None:
                    chain["solved_at_session"] = max(1, len(sessions))
                state.store.set(CHAIN_KEY, chain)
        assert grade is not None
        verdict = grade.get("verdict", "grader_error")
        comp = grade.get("completeness") or {}
        reasons = grade.get("reasons") or []
        return Score(
            value=1.0 if verdict == "solved" else 0.0,
            answer=solution,
            explanation=f"{verdict}{': ' + ', '.join(reasons) if reasons else ''}",
            metadata={
                "verdict": verdict,
                "reasons": reasons,
                "grader_error": verdict == "grader_error",
                "sessions_used": (chain or {}).get("sessions_used"),
                "sessions_max": (chain or {}).get("sessions_max"),
                "solved_at_session": (chain or {}).get("solved_at_session"),
                "completeness": comp.get("score") if comp.get("available") else None,
                "proof_lines": (grade.get("proof") or {}).get("proof_lines"),
                "compile_ms": (grade.get("timing") or {}).get("compile_ms"),
                "statement": ((grade.get("checks") or {}).get("statement") or {}).get("status"),
                "axioms": ((grade.get("checks") or {}).get("axioms") or {}).get("status"),
                "warnings": grade.get("warnings") or [],
                "totals": (chain or {}).get("totals"),
                "needs_manual_audit": verdict == "solved",
            },
        )

    return score
