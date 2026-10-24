"""Smoke test of a whole run without any API: a scripted mock model works on an open
problem for two sessions in the real Apptainer sandbox, graded by the real verifier.
Checks: both files reach the sandbox and the prompt, the handoff note is requested with
the session's own tools and reaches the next session, and the edited disproof is the
reported polarity.  About a minute; no Zenodo archive (run.sh is not used).
usage: .venv/bin/python tests/mock_run.py [SIF] [PID]   (default proofbench-sandbox.sif P005)"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.event import ModelEvent  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

sif = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(ROOT / "proofbench-sandbox.sif")
pid = sys.argv[2] if len(sys.argv) > 2 else "P005"
M = "mockllm/model"
outputs = [
    ModelOutput.for_tool_call(model=M, tool_name="bash", tool_arguments={
        "command": f"echo '-- an attempt' >> /opt/proofbench/Submission/{pid}_DISPROVE.lean && ls /opt/proofbench/Submission"}),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note)"),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
]
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=False, sessions=2, session_working_time=900)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    log = read_eval_log(log.location, resolve_attachments=True)
s = log.samples[0]
sc = s.scores["lean_check"]
calls = [e for e in s.events if isinstance(e, ModelEvent)]
recs = s.store["sessions"]
prompt1 = [m.text for m in calls[0].input if m.role == "user"][0]
prompt2 = [m.text for m in calls[3].input if m.role == "user"][0]
names = lambda e: sorted(t.name for t in e.tools)
checks = {
    "run finished": log.status == "success",
    "both files in the sandbox": f"{pid}_DISPROVE.lean" in next(m.text for m in s.messages if m.role == "tool"),
    "prompt shows both files": all(f"Submission/{f}.lean" in prompt1 for f in (pid, f"{pid}_DISPROVE")),
    "note written after session 1": recs[0].get("note") == "PROVED:\n- nothing (mock note)",
    "note request uses the session's tools": names(calls[2]) == names(calls[1]) and calls[2].tool_choice == calls[1].tool_choice,
    "session 2 starts from the note": "mock note" in prompt2,
    "edited disproof reported": sc.metadata["polarity"] == "disprove" and sc.metadata["other"]["polarity"] == "prove",
    "graded in the verifier": sc.metadata["graded_in"] == "verifier",
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
