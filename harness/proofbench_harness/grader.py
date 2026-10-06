"""The independent Lean check, applied after every session.

The check is QEDRank's `grade` command (``qedrank/lib/grade.js``): static screen, import
policy, compilation, `sorry` and axiom audit, comparison of the compiled statement and
definitions with the challenge, and a kernel replay. It runs outside the agent's sandbox and
takes exactly one thing from it: the text of the working file.

Two ways to run it:

* ``local``  – ``node qedrank/cli.js grade`` on this machine, against a Lean project here.
* ``docker`` – the same command in a fresh container of the sandbox image with networking off,
  which is the "clean container" of the protocol.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from inspect_ai.util import subprocess

REPO_ROOT = Path(__file__).resolve().parents[2]


class Grader(Protocol):
    async def grade(self, *, challenge: str, solution: str | None, target: str) -> dict[str, Any]: ...

    def describe(self) -> dict[str, Any]: ...


def grader_error(reason: str, detail: str | None = None) -> dict[str, Any]:
    """A grade record for a check that could not be carried out. Never counted as solved or as failed."""
    return {
        "schema": "qedrank-grade-v1",
        "verdict": "grader_error",
        "reasons": [reason],
        "warnings": [],
        "grader_error": detail,
        "checks": {},
        "completeness": {"available": False, "reason": "not_computed"},
        "proof": None,
        "compiler_output": "",
        "timing": {"compile_ms": None, "total_ms": None},
    }


@dataclass
class QEDRankGrader:
    """Runs ``qedrank/cli.js grade`` locally or in a clean container."""

    mode: str = "local"  # "local" | "docker"
    #: local mode: the Lean project whose toolchain, Mathlib and statement library are used
    lean_project: str | None = None
    #: docker mode: image, and where the project and this repository live inside it
    image: str | None = None
    image_lean_project: str = "/workspace/ProofBench"
    image_repo: str = "/opt/qedrank"
    library_prefixes: list[str] = field(default_factory=lambda: ["ProofBench.Mathlib_Problems"])
    allow_extra_imports: bool = False
    extra_lean_path: str | None = None
    allow_unused_sorry: bool = False
    kernel_replay: bool = True
    timeout_s: int = 3600
    node: str = "node"
    repo_root: Path = REPO_ROOT

    def describe(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "lean_project": self.lean_project if self.mode == "local" else self.image_lean_project,
            "image": self.image if self.mode == "docker" else None,
            "network": "host" if self.mode == "local" else "none",
            "library_prefixes": self.library_prefixes,
            "allow_extra_imports": self.allow_extra_imports,
            "allow_unused_sorry": self.allow_unused_sorry,
            "kernel_replay": self.kernel_replay,
        }

    def _flags(self) -> list[str]:
        flags = ["--library-prefix", ",".join(self.library_prefixes)]
        if self.allow_extra_imports:
            flags.append("--allow-extra-imports")
        if self.allow_unused_sorry:
            flags.append("--allow-unused-sorry")
        if not self.kernel_replay:
            flags.append("--no-kernel-replay")
        return flags

    def command(self, work: Path, target: str) -> list[str]:
        """The command line for one grading; ``work`` holds challenge.lean and solution.lean."""
        if self.mode == "docker":
            if not self.image:
                raise ValueError("docker grading needs an image")
            cmd = [
                "docker", "run", "--rm", "--network", "none",
                "-v", f"{work}:/grade",
                "-w", self.image_repo,
                self.image,
                "node", "qedrank/cli.js", "grade",
                "--lean-project", self.image_lean_project,
                "--challenge", "/grade/challenge.lean", "--solution", "/grade/solution.lean",
                "--target", target, "--out", "/grade/grade.json", "--runs-dir", "/tmp/qedrank-runs",
            ]
            if self.extra_lean_path:
                cmd += ["--extra-lean-path", self.extra_lean_path]
            return cmd + self._flags()
        cmd = [
            self.node, str(self.repo_root / "qedrank" / "cli.js"), "grade",
            "--challenge", str(work / "challenge.lean"), "--solution", str(work / "solution.lean"),
            "--target", target, "--out", str(work / "grade.json"),
        ]
        if self.lean_project:
            cmd += ["--lean-project", str(Path(self.lean_project).expanduser().resolve())]
        if self.extra_lean_path:
            cmd += ["--extra-lean-path", self.extra_lean_path]
        return cmd + self._flags()

    async def grade(self, *, challenge: str, solution: str | None, target: str) -> dict[str, Any]:
        work = Path(tempfile.mkdtemp(prefix="proofbench-grade-"))
        try:
            (work / "challenge.lean").write_text(challenge, encoding="utf-8", newline="\n")
            if solution is not None:
                (work / "solution.lean").write_text(solution, encoding="utf-8", newline="\n")
            try:
                result = await subprocess(self.command(work, target), cwd=str(self.repo_root), timeout=self.timeout_s, capture_output=True)
            except TimeoutError:
                return grader_error("grader_timeout", f"no result after {self.timeout_s} s")
            except OSError as err:
                return grader_error("grader_not_runnable", str(err))
            out = work / "grade.json"
            if not out.is_file():
                return grader_error("grader_produced_no_result", (result.stderr or result.stdout or "")[-2000:])
            try:
                return json.loads(out.read_text(encoding="utf-8"))
            except ValueError as err:
                return grader_error("grader_result_unreadable", str(err))
        finally:
            shutil.rmtree(work, ignore_errors=True)
