"""Produce a demonstration agent run from scripted models, so the Evaluation page's agent panel
can be seen before any real run exists.

    harness\\.venv\\Scripts\\python harness\\scripts\\demo_agent_run.py [run-id]

Writes runs/<run-id>-<model>.json bundles and imports them as runs/<run-id>/ (default id: agent-demo).
The "models" are mockllm scripts with a stub grader: the numbers mean nothing.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "harness" / "tests"))

from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.model import get_model  # noqa: E402

from proofbench_harness.export import bundle_from_log  # noqa: E402
from test_pipeline import scripted, task  # noqa: E402


def main() -> None:
    run_id = sys.argv[1] if len(sys.argv) > 1 else "agent-demo"
    plans = {
        "strong": {"P901": ["solved"], "P902": ["partial", "solved"], "P903": ["solved"]},
        "weak": {"P901": ["partial", "solved"], "P902": ["partial", "stuck"], "P903": ["stuck", "stuck"]},
    }
    bundles = []
    for name, plan in plans.items():
        model = get_model(f"mockllm/{name}", custom_outputs=scripted(plan))
        [log] = inspect_eval(task(), model=model, log_dir=str(REPO / "runs" / "inspect-logs" / f"{run_id}-{name}"), display="none", max_samples=1)
        assert log.status == "success", log.error
        out = REPO / "runs" / f"{run_id}-{name}.json"
        out.write_text(json.dumps(bundle_from_log(log), default=str), encoding="utf-8")
        bundles.append(str(out))
    subprocess.run(["node", str(REPO / "qedrank" / "cli.js"), "import-agent", "--bundle", ",".join(bundles), "--run-id", run_id, "--force"], cwd=REPO, check=True)
    print(f"\nDemo run ready: runs/{run_id} (scripted models, stub grader). Load it on the Evaluation page.")


if __name__ == "__main__":
    main()
