#!/usr/bin/env python3
"""Write logs/<run>/manifest.json: everything needed to reproduce or audit a run."""

import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def main() -> None:
    run_dir = Path(sys.argv[1]); run_dir.mkdir(parents=True, exist_ok=True)
    kv = dict(a.split("=", 1) for a in sys.argv[2:])
    problems = Path(kv.get("problems", "data/problems.json"))
    manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": platform.node(),
        "harness_commit": sh(["git", "rev-parse", "HEAD"]),
        "harness_dirty": bool(sh(["git", "status", "--porcelain"])),
        "inspect_version": sh([sys.executable, "-c", "import inspect_ai;print(inspect_ai.__version__)"]),
        "image_id": sh(["docker", "image", "inspect", "--format", "{{.Id}}", "proofbench-sandbox:latest"]) or kv.get("image", ""),
        "lean_toolchain": (Path("image/context/lean-toolchain").read_text().strip() if Path("image/context/lean-toolchain").exists() else ""),
        "problems_source_commit": json.loads(problems.read_text())["source_commit"] if problems.exists() else "",
        "problem_ids": [p["id"] for p in json.loads(problems.read_text())["problems"]] if problems.exists() else [],
        **kv,
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
