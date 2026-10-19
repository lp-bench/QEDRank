"""Harness log -> bundle -> QEDRank run: the statistics see what the harness measured."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from inspect_ai import Task
from inspect_ai import eval as inspect_eval
from inspect_ai.dataset import Sample
from inspect_ai.model import get_model

from conftest import CHALLENGE, PARTIAL, SOLVED, StubGrader, call, write_file
from proofbench_harness.export import BUNDLE_SCHEMA, bundle_from_log, main as export_main
from proofbench_harness.scoring import lean_check
from proofbench_harness.sessions import SessionLimits, session_chain
from proofbench_harness.tools import end_session

REPO = Path(__file__).resolve().parents[2]
PROBLEMS = [
    ("P901", "Calibration", "established", "2015"),
    ("P902", "Research", "established", "2026-09"),
    ("P903", "Open", "open", None),
]
META = {
    "protocol": "agent",
    "prompt_version": "proofbench-agent-v1",
    "harness": {"commit": "a" * 40, "dirty": False},
    "problem_set": {"commit": "b" * 40},
    "lean": {"lean_toolchain": "leanprover/lean4:v4.33.0-rc1", "mathlib_commit": "c" * 40},
    "sandbox": {"type": "local", "image": None, "id": None},
    "web_search": False,
    "network": False,
    "max_sessions": 2,
    "limits": {"session_output_tokens": 10000},
    "grader": {"mode": "stub"},
}


def task() -> Task:
    grader = StubGrader()
    return Task(
        dataset=[Sample(id=pid, input=pid, target="solved", metadata={"problem_id": pid, "target": pid, "challenge": CHALLENGE.replace("P900", pid), "difficulty": diff, "mathematical_status": status, "publication_date": pub}) for pid, diff, status, pub in PROBLEMS],
        solver=session_chain(grader=grader, tools=[write_file(), end_session()], max_sessions=2, limits=SessionLimits(output_tokens=10_000), work_path_template="PROBLEMS/{id}/{id}.lean"),
        scorer=lean_check(grader, work_path_template="PROBLEMS/{id}/{id}.lean"),
        sandbox="local",
        fail_on_error=False,
        metadata=META,
    )


def scripted(plan: dict[str, list[str]]):
    """plan[problem] = what the model leaves in the file at the end of each session."""
    progress: dict[str, int] = {}

    def respond(input, tools, tool_choice, config):
        first = input[1].text
        pid = next(p for p in plan if f"Problem {p}." in first)
        session = int(first.split("Session ")[1].split(" ")[0])
        step = progress.get(f"{pid}:{session}", 0)
        progress[f"{pid}:{session}"] = step + 1
        if step == 0:
            content = {"solved": SOLVED, "partial": PARTIAL}.get(plan[pid][session - 1])
            if content:
                return call("write_file", path=f"PROBLEMS/{pid}/{pid}.lean", content=content.replace("P900", pid))
        return call("end_session", reason=plan[pid][session - 1])

    return respond


@pytest.fixture(scope="module")
def bundles(tmp_path_factory) -> list[Path]:
    out = tmp_path_factory.mktemp("bundles")
    plans = {
        # solves the first at once, the second in its second session, and (apparently) the open one
        "strong": {"P901": ["solved"], "P902": ["partial", "solved"], "P903": ["solved"]},
        # solves only the first, and needs both sessions for it
        "weak": {"P901": ["partial", "solved"], "P902": ["partial", "stuck"], "P903": ["stuck", "stuck"]},
    }
    files = []
    for name, plan in plans.items():
        model = get_model(f"mockllm/{name}", custom_outputs=scripted(plan))
        [log] = inspect_eval(task(), model=model, log_dir=str(out / name), display="none", max_samples=1)
        assert log.status == "success", log.error
        bundle = bundle_from_log(log)
        assert bundle["schema"] == BUNDLE_SCHEMA and len(bundle["samples"]) == 3
        f = out / f"{name}.json"
        f.write_text(json.dumps(bundle, default=str), encoding="utf-8")
        files.append(f)
    return files


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_bundles_import_into_a_qedrank_run(bundles: list[Path], tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    cmd = ["node", str(REPO / "qedrank" / "cli.js"), "import-agent", "--bundle", ",".join(str(b) for b in bundles), "--run-id", "agent-test", "--runs-dir", str(runs)]
    done = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr
    summary = json.loads((runs / "agent-test" / "summary.json").read_text(encoding="utf-8"))
    assert summary["run"]["protocol"] == "agent" and summary["run"]["harness"]["commit"] == "a" * 40
    assert summary["run"]["toolchain"]["toolchain"] == "leanprover/lean4:v4.33.0-rc1"
    assert summary["run"]["protocol_mismatches"] == []
    agent = summary["agent"]
    assert agent["sessions_max"] == 2 and agent["tiers"] == [1, 2] and agent["web_search"] is False
    strong, weak = agent["by_model"]["mockllm_strong"], agent["by_model"]["mockllm_weak"]
    # Two established problems each; the open problem is outside the denominator.
    assert (strong["solved_within"]["1"]["num"], strong["solved_within"]["1"]["den"]) == (1, 2)
    assert (strong["solved_within"]["2"]["num"], strong["solved_within"]["2"]["den"]) == (2, 2)
    assert (weak["solved_within"]["1"]["num"], weak["solved_within"]["2"]["num"], weak["solved_within"]["2"]["den"]) == (0, 1, 2)
    assert strong["sessions_to_success"]["distribution"] == {"1": 1, "2": 1}
    assert strong["open_claim_escalations"] == ["P903__main_theorem__mockllm_strong"] and weak["open_claim_escalations"] == []
    assert sorted(strong["awaiting_manual_audit"]) == ["P901__main_theorem__mockllm_strong", "P902__main_theorem__mockllm_strong"]
    assert strong["totals"]["tool_calls_by_tool"]["end_session"] == 4 and weak["totals"]["model_calls"] > strong["totals"]["model_calls"]
    assert weak["completeness_unsolved"]["mean"] == 0.5
    # The ordinary matrices work on agent records too.
    v = summary["by_target"]["main_theorem"]["mockllm_strong"]["verified_pass1"]
    assert (v["num"], v["den"]) == (2, 2)
    assert summary["effort"]["by_difficulty"]["Research"]["mockllm_strong"]["all"]["median_sessions"] == 2
    proxies = {r["paper_id"]: r for r in summary["difficulty_proxies"]["items"]}
    assert proxies["P901"]["solved_by"] == ["mockllm_strong", "mockllm_weak"] and proxies["P902"]["least_sessions"] == {"model": "mockllm_strong", "value": 2}
    assert "P903" not in proxies, "open problems have no solve-based difficulty proxy"
    items = json.loads((runs / "agent-test" / "exports" / "items.json").read_text(encoding="utf-8"))["items"]
    row = next(i for i in items if i["item_key"] == "P902__main_theorem__mockllm_strong")
    assert row["sessions_used"] == 2 and row["solved_at_session"] == 2 and row["verified"] == 1 and row["difficulty"] == "Research" and row["harness_commit"] == "a" * 40

    # Hand audit: a rejected solve stops counting when the statistics are recomputed.
    review = runs / "agent-test" / "review"
    review.mkdir()
    (review / "audit.json").write_text(json.dumps({"P902__main_theorem__mockllm_strong": {"status": "rejected", "reviewer": "kv", "note": "statement meaning changed"}, "P901__main_theorem__mockllm_strong": {"status": "confirmed", "reviewer": "kv"}}), encoding="utf-8")
    done = subprocess.run(["node", str(REPO / "qedrank" / "cli.js"), "stats", "--run-id", "agent-test", "--runs-dir", str(runs)], cwd=REPO, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr
    summary = json.loads((runs / "agent-test" / "summary.json").read_text(encoding="utf-8"))
    strong = summary["agent"]["by_model"]["mockllm_strong"]
    assert (strong["solved_within"]["2"]["num"], strong["solved_within"]["2"]["den"]) == (1, 2)
    assert strong["awaiting_manual_audit"] == []


def test_export_cli_merges_logs(bundles: list[Path], tmp_path: Path) -> None:
    logs = [next((b.parent / b.stem).glob("*.eval")) for b in bundles]
    out = tmp_path / "merged.json"
    assert export_main([str(p) for p in logs] + ["--out", str(out)]) == 0
    merged = json.loads(out.read_text(encoding="utf-8"))
    assert merged["schema"] == BUNDLE_SCHEMA and [b["model"] for b in merged["bundles"]] == ["mockllm/strong", "mockllm/weak"]
