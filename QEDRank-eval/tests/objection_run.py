"""Smoke test of the objection channel without any API: a scripted mock model submits
"FALSE: ..." in session 1 of a problem without a negation file, in the real Apptainer
sandbox.  Checks: the prompt offers the channel, the objection ends the chain (no note,
no session 2), the attempt is scored incorrect, and results.csv records it.
About a minute; no Zenodo archive (run.sh is not used).
usage: .venv/bin/python tests/objection_run.py [SIF] [PID]   (default proofbench-sandbox.sif P014)"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from analyze import rows_for  # noqa: E402
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.event import ModelEvent  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

sif = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(ROOT / "proofbench-sandbox.sif")
pid = sys.argv[2] if len(sys.argv) > 2 else "P014"
M = "mockllm/model"
objection = "FALSE: mock objection, the statement fails for n = 0"
outputs = [ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": objection})]
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=False, sessions=2, session_working_time=900)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    log = read_eval_log(log.location, resolve_attachments=True)
    row = next(rows_for(Path(logdir)))
s = log.samples[0]
calls = [e for e in s.events if isinstance(e, ModelEvent)]
recs = s.store["sessions"]
prompt1 = [m.text for m in calls[0].input if m.role == "user"][0]
checks = {
    "run finished": log.status == "success",
    "prompt offers the channel": 'starting with "FALSE:"' in prompt1,
    "objection recorded": recs[0].get("objection") is True and recs[0].get("submitted") == objection,
    "chain ends, no note": len(recs) == 1 and "note" not in recs[0] and len(calls) == 1,
    "scored incorrect": s.scores["lean_check"].value == "I",
    "results.csv columns": row["objection"] == 1 and row["submitted"] == objection,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
