"""The constructive track end to end, without any API: a scripted mock model submits the
reference solution of P011 (which uses Classical.choice) to P011 declared constructive for
this test (permitted axioms propext and Quot.sound), in the real Apptainer sandbox.  Checks:
the grader rejects it for its axioms, and nothing else.  About two minutes; needs the
private repository for the solution.  Comparator's own check of the permitted axioms is
covered by tests/test_targets.py (configuration) and was verified by hand on 2026-10-29.
usage: .venv/bin/python tests/constructive_run.py [PROOFBENCH_HIDDEN]   (default ../../proofbench-hidden)"""
import base64
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

hidden = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "../../proofbench-hidden").resolve()
M = "mockllm/model"
with tempfile.TemporaryDirectory() as tmp:
    sub = Path(tmp) / "P011.lean"
    subprocess.run([sys.executable, str(ROOT / "scripts/solution_to_submission.py"), "P011",
                    str(ROOT / "proofbench/ProofBench/PROBLEMS/P011/P011.lean"),
                    str(hidden / "ProofBench/PROBLEMS/P011/P011_sol.lean"), str(sub)], check=True)
    b64 = base64.b64encode(sub.read_bytes()).decode()
    write = ("import base64\nopen('/opt/proofbench/Submission/P011.lean', 'wb').write("
             f"base64.b64decode('{b64}'))\n")
    outputs = [ModelOutput.for_tool_call(model=M, tool_name="python", tool_arguments={"code": write}),
               ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"})]
    task = proofbench(ids="P011", sandbox="apptainer", network=False, sessions=1, session_working_time=1800)
    task.dataset[0].metadata["permitted_axioms"] = ["propext", "Quot.sound"]
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=tmp, display="none")[0]
    log = read_eval_log(log.location)
sc = log.samples[0].scores["lean_check"]
errors = sc.metadata.get("errors", [])
checks = {
    "run finished": log.status == "success",
    "scored incorrect": sc.value == "I",
    "rejected for Classical.choice only": errors == ["axioms not permitted for this problem: Classical.choice"],
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures" + ("" if all(checks.values()) else f"  errors: {errors}"))
sys.exit(0 if all(checks.values()) else 1)
