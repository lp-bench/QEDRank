"""Shared test pieces: a stub grader, a file-writing tool, and a scripted model."""

from __future__ import annotations

from typing import Any, Callable

import pytest
from inspect_ai import Task
from inspect_ai.dataset import Sample
from inspect_ai.model import ModelOutput, ModelUsage, get_model
from inspect_ai.tool import Tool, tool
from inspect_ai.util import sandbox

from proofbench_harness.scoring import lean_check
from proofbench_harness.sessions import SessionLimits, session_chain
from proofbench_harness.tools import end_session

CHALLENGE = "def weight (n : Nat) : Nat := n + n\n\ntheorem P900 (n : Nat) : weight n = 2 * n := sorry\n"
PARTIAL = "def weight (n : Nat) : Nat := n + n\n\ntheorem step (n : Nat) : n + n = 2 * n := sorry\n\ntheorem P900 (n : Nat) : weight n = 2 * n := step n\n"
SOLVED = "def weight (n : Nat) : Nat := n + n\n\ntheorem step (n : Nat) : n + n = 2 * n := by omega\n\ntheorem P900 (n : Nat) : weight n = 2 * n := step n\n"
WORK = "PROBLEMS/P900/P900.lean"
NOTE = "PROBLEMS/P900/HANDOFF.md"
HANDOFF = "# Handoff\n\n## Proved lemmas\n- (none yet)\n\n## Open goals\n- step: n + n = 2 * n\n\n## Failed approaches\n- rfl does not close step\n\nfree text that is not part of the format\n"


class StubGrader:
    """Stands in for the Lean check: solved exactly when the file has no `sorry`."""

    def __init__(self, error_on: int | None = None) -> None:
        self.calls: list[str | None] = []
        self.error_on = error_on

    async def grade(self, *, challenge: str, solution: str | None, target: str) -> dict[str, Any]:
        self.calls.append(solution)
        if self.error_on == len(self.calls):
            return {"verdict": "grader_error", "reasons": ["toolchain_unavailable"], "warnings": [], "checks": {}, "completeness": {"available": False}, "proof": None, "compiler_output": "", "timing": {}}
        solved = solution is not None and "sorry" not in solution
        return {
            "schema": "qedrank-grade-v1",
            "verdict": "solved" if solved else "not_solved",
            "reasons": [] if solved else ["contains_sorry"],
            "warnings": [],
            "checks": {"statement": {"status": "unchanged"}, "axioms": {"status": "clean" if solved else "placeholder"}},
            "completeness": {"available": True, "score": 1.0 if solved else 0.5},
            "proof": {"proof_lines": 3},
            "compiler_output": "" if solved else "3:8: warning: declaration uses `sorry`",
            "timing": {"compile_ms": 12.0, "total_ms": 30.0},
        }

    def describe(self) -> dict[str, Any]:
        return {"mode": "stub"}


@tool
def write_file() -> Tool:
    async def execute(path: str, content: str) -> str:
        """Write a file in the sandbox.

        Args:
            path: File path.
            content: New content of the file.
        """
        await sandbox().write_file(path, content)
        return f"wrote {path}"

    return execute


def call(name: str, tokens: int = 100, **arguments: Any) -> ModelOutput:
    out = ModelOutput.for_tool_call("mockllm/model", name, arguments)
    out.usage = ModelUsage(input_tokens=1000, output_tokens=tokens, total_tokens=1000 + tokens)
    return out


def say(text: str, tokens: int = 100, stop_reason: str = "stop") -> ModelOutput:
    out = ModelOutput.from_content("mockllm/model", text, stop_reason=stop_reason)  # type: ignore[arg-type]
    out.usage = ModelUsage(input_tokens=1000, output_tokens=tokens, total_tokens=1000 + tokens)
    return out


class Script:
    """A scripted model that also records every prompt it was given."""

    def __init__(self, outputs: list[ModelOutput] | Callable[[int], ModelOutput]) -> None:
        self.outputs = outputs
        self.inputs: list[list[Any]] = []

    def __call__(self, input: list[Any], tools: Any, tool_choice: Any, config: Any) -> ModelOutput:
        self.inputs.append(list(input))
        i = len(self.inputs) - 1
        if callable(self.outputs):
            return self.outputs(i)
        if i >= len(self.outputs):
            raise ValueError("script ran out of outputs")
        return self.outputs[i]

    def model(self) -> Any:
        return get_model("mockllm/model", custom_outputs=self)

    def first_user_prompts(self) -> list[str]:
        """The opening user message of every session (a session starts with system + user only)."""
        return [m[1].text for m in self.inputs if len(m) == 2]


def make_task(grader: StubGrader, *, max_sessions: int = 3, limits: SessionLimits | None = None, extra_tools: list[Tool] | None = None, exclude: tuple[str, ...] = ()) -> Task:
    return Task(
        dataset=[Sample(id="P900", input="prove P900", target="solved", metadata={"problem_id": "P900", "target": "P900", "challenge": CHALLENGE, "difficulty": "Calibration", "mathematical_status": "established"})],
        solver=session_chain(grader=grader, tools=[write_file(), end_session(), *(extra_tools or [])], max_sessions=max_sessions, limits=limits or SessionLimits(output_tokens=10_000), work_path_template="PROBLEMS/{id}/{id}.lean", exclude_tools=exclude),
        scorer=lean_check(grader, work_path_template="PROBLEMS/{id}/{id}.lean"),
        sandbox="local",
        fail_on_error=False,
        metadata={"protocol": "agent", "web_search": False},
    )


@pytest.fixture
def grader() -> StubGrader:
    return StubGrader()
