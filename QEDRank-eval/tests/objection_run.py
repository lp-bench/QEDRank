"""Smoke test of the objection channel without any API: a scripted mock model replies
once without a tool call, then submits "FALSE: ..." in session 1 of a problem without a
negation file, in the real Apptainer sandbox.  Checks: the prompt offers the channel and
the early end of a session, the reply without a tool call is answered with the remaining
budget, the objection ends the chain (no note, no session 2), the attempt is scored
incorrect, and results.csv records it.
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
outputs = [
    ModelOutput.from_content(model=M, content="Thinking out loud, no tool call."),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": objection}),
]
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=False, sessions=2, session_working_time=900)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    log = read_eval_log(log.location, resolve_attachments=True)
    row = next(rows_for(Path(logdir)))
s = log.samples[0]
calls = [e for e in s.events if isinstance(e, ModelEvent)]
recs = s.store["sessions"]
prompt1 = [m.text for m in calls[0].input if m.role == "user"][0]
nudge = [m.text for m in calls[1].input if m.role == "user"][-1]
checks = {
    "run finished": log.status == "success",
    "prompt offers the channel": 'starting with "FALSE:"' in prompt1,
    "prompt offers an early end": "call submit() with a short status instead." in prompt1,
    "prompt does not say how many sessions": "This is session 1." in prompt1 and "at most" not in prompt1,
    "nudge gives the budget left": nudge.startswith("You have about 120,000 output tokens left"),
    "objection recorded": recs[0].get("objection") is True and recs[0].get("submitted") == objection,
    "chain ends, no note": len(recs) == 1 and "note" not in recs[0] and len(calls) == 2,
    "scored incorrect": s.scores["lean_check"].value == "I",
    "results.csv columns": row["objection"] == 1 and row["submitted"] == objection,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
