#!/usr/bin/env python3
"""Write logs/<run>/manifest.json: everything needed to reproduce or audit a run."""

import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The code the model faces and the grader: hashed into the manifest, so that runs whose
# commits differ only in analysis scripts or documentation can be shown to have run the same
# evaluation code.  The sandbox package's sources are added when it is an editable install.
EVALUATION_CODE = ["proofbench_eval", "scripts/run.sh", "image/check_proof.py"]


def sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def _mathlib_commit(manifest: Path) -> str:
    """Mathlib revision pinned by the statements' Lake manifest (what the image builds)."""
    if not manifest.exists():
        return ""
    for pkg in json.loads(manifest.read_text()).get("packages", []):
        if pkg.get("name") == "mathlib":
            return pkg.get("rev", "")
    return ""


def _package_checkout(module: str) -> str:
    """Folder of the git checkout an editable install of `module` runs from ("" otherwise)."""
    src = sh([sys.executable, "-c", f"import os, {module}; print(os.path.dirname({module}.__file__))"])
    return src if src and sh(["git", "-C", src, "rev-parse", "HEAD"]) else ""


def _evaluation_code_hash(apptainer_src: str) -> str:
    """SHA-256 over the names and contents of the evaluation code files (EVALUATION_CODE and
    the sandbox package), in a fixed order."""
    files: list[tuple[str, Path]] = []
    for rel in EVALUATION_CODE:
        p = ROOT / rel
        files += [(str(f.relative_to(ROOT)), f) for f in (sorted(p.rglob("*.py")) if p.is_dir() else [p])]
    if apptainer_src:
        files += [("inspect_apptainer/" + f.name, f) for f in sorted(Path(apptainer_src).glob("*.py"))]
    h = hashlib.sha256()
    for name, f in files:
        if f.is_file() and "__pycache__" not in f.parts:
            h.update(name.encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def main() -> None:
    run_dir = Path(sys.argv[1]); run_dir.mkdir(parents=True, exist_ok=True)
    kv = dict(a.split("=", 1) for a in sys.argv[2:])
    statements = Path(kv.get("statements", "proofbench"))
    apptainer_src = _package_checkout("inspect_apptainer")
    manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": platform.node(),
        "harness_commit": sh(["git", "rev-parse", "HEAD"]),
        "harness_dirty": bool(sh(["git", "status", "--porcelain"])),
        "inspect_version": sh([sys.executable, "-c", "import inspect_ai;print(inspect_ai.__version__)"]),
        "inspect_apptainer_version": sh([sys.executable, "-c",
                                         "from importlib.metadata import version;print(version('inspect-apptainer'))"]),
        "inspect_apptainer_commit": sh(["git", "-C", apptainer_src, "rev-parse", "HEAD"]) if apptainer_src else "",
        "inspect_apptainer_dirty": bool(apptainer_src and sh(["git", "-C", apptainer_src, "status", "--porcelain"])),
        "evaluation_code_sha256": _evaluation_code_hash(apptainer_src),
        "image_id": kv.get("image") or sh(["docker", "image", "inspect", "--format", "{{.Id}}", "proofbench-sandbox:latest"]),
        "lean_toolchain": (statements / "lean-toolchain").read_text().strip() if (statements / "lean-toolchain").exists() else "",
        "mathlib_commit": _mathlib_commit(statements / "lake-manifest.json"),
        "statements_commit": sh(["git", "-C", str(statements), "rev-parse", "HEAD"]),
        "proofbench_commit": (statements / "SOURCE_COMMIT").read_text().strip() if (statements / "SOURCE_COMMIT").exists() else "",
        "problem_ids": kv.get("ids", "").replace(",", " ").split(),
        **kv,
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
