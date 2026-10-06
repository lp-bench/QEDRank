"""What a run is frozen to: the harness commit, the sandbox image, the Lean toolchain, the
Mathlib commit, the ProofBench commit, and whether web search was on.

The model identifier and its reasoning-effort setting are recorded by Inspect in the eval
header and again per sample in the session chain.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def _run(args: list[str], cwd: Path | None = None, timeout: int = 20) -> str | None:
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def git_revision(path: Path) -> dict[str, Any]:
    """Commit and cleanliness of the git checkout that contains `path`."""
    commit = _run(["git", "-C", str(path), "rev-parse", "HEAD"])
    if not commit:
        return {"commit": None, "dirty": None, "branch": None, "source": "unavailable"}
    status = _run(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"]) or ""
    branch = _run(["git", "-C", str(path), "rev-parse", "--abbrev-ref", "HEAD"])
    return {"commit": commit.strip(), "dirty": bool(status.strip()), "branch": branch.strip() if branch else None, "source": "git"}


def lean_project_info(project: Path) -> dict[str, Any]:
    """Toolchain and pinned dependencies of a Lake project."""
    info: dict[str, Any] = {"lean_toolchain": None, "mathlib_commit": None, "dependencies": {}}
    toolchain = project / "lean-toolchain"
    if toolchain.is_file():
        info["lean_toolchain"] = toolchain.read_text(encoding="utf-8").strip()
    manifest = project / "lake-manifest.json"
    if manifest.is_file():
        try:
            for pkg in json.loads(manifest.read_text(encoding="utf-8")).get("packages", []):
                info["dependencies"][pkg.get("name")] = pkg.get("rev")
        except ValueError:
            pass
        info["mathlib_commit"] = info["dependencies"].get("mathlib")
    return info


def _project_root(problems: Path) -> Path | None:
    for cand in (problems, *problems.parents):
        if (cand / "lean-toolchain").is_file():
            return cand
    return None


def image_info(image: str | None) -> dict[str, Any]:
    """Name and content id of the sandbox image, when Docker can be asked."""
    if not image:
        return {"image": None, "id": None, "digests": None}
    out = _run(["docker", "image", "inspect", "--format", "{{.Id}}|{{json .RepoDigests}}", image], timeout=30)
    if not out:
        return {"image": image, "id": None, "digests": None, "note": "image not found locally or Docker not running; the id could not be recorded"}
    image_id, _, digests = out.strip().partition("|")
    try:
        parsed = json.loads(digests)
    except ValueError:
        parsed = None
    return {"image": image, "id": image_id, "digests": parsed}


def freeze_run_metadata(*, problems: str, image: str | None, sandbox_type: str, web_search: bool, network: bool, grader: dict[str, Any], limits: dict[str, Any], max_sessions: int, tools: list[str], prompt_version: str) -> dict[str, Any]:
    source = Path(problems).expanduser().resolve()
    project = _project_root(source if source.is_dir() else source.parent)
    return {
        "protocol": "agent",
        "prompt_version": prompt_version,
        "harness": git_revision(REPO_ROOT),
        "problem_set": {"path": str(source), **git_revision(source if source.is_dir() else source.parent)},
        "lean": lean_project_info(project) if project else {"lean_toolchain": None, "mathlib_commit": None, "dependencies": {}},
        "sandbox": {"type": sandbox_type, **image_info(image if sandbox_type == "docker" else None)},
        "web_search": web_search,
        "network": network,
        "grader": grader,
        "max_sessions": max_sessions,
        "limits": limits,
        "tools_requested": tools,
    }
