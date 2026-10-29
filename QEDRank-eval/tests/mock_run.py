"""Smoke test of a whole run without any API: a scripted mock model works on an open
problem for two sessions in the real Apptainer sandbox, graded by the real verifier.
Checks: both files reach the sandbox and the prompt, the handoff note is requested with
the session's own tools and reaches the next session, the last session writes a note
too, the unsolved attempt leaves a snapshot of the files the agent changed, and the
edited disproof is the reported polarity.  About a minute; no Zenodo archive (run.sh is
not used).
usage: .venv/bin/python tests/mock_run.py [SIF] [PID]   (default proofbench-sandbox.sif P005)"""
import base64
import io
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from extract_proofs import extract  # noqa: E402
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
        "command": f"echo '-- an attempt' >> /opt/proofbench/Submission/{pid}_DISPROVE.lean && ls /opt/proofbench/Submission"
                   " && echo 'scratch' > /tmp/scratch.py && mkdir -p ~/.cache && echo junk > ~/.cache/junk"}),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note)"),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note 2)"),
]
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=False, sessions=2, session_working_time=900)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    log = read_eval_log(log.location, resolve_attachments=True)
    extract(Path(logdir))
    unpacked = Path(logdir) / "proofs" / pid / "snapshot" / "tmp" / "scratch.py"
    unpacked = unpacked.read_text() if unpacked.exists() else None
s = log.samples[0]
sc = s.scores["lean_check"]
calls = [e for e in s.events if isinstance(e, ModelEvent)]
recs = s.store["sessions"]
prompt1 = [m.text for m in calls[0].input if m.role == "user"][0]
prompt2 = [m.text for m in calls[3].input if m.role == "user"][0]
names = lambda e: sorted(t.name for t in e.tools)
snap = s.store.get("snapshot", {})
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(snap.get("tar_gz_base64", ""))), mode="r:gz") as tar:
    in_tar = {m.name: tar.extractfile(m).read().decode() for m in tar.getmembers() if m.isfile()}
checks = {
    "run finished": log.status == "success",
    "both files in the sandbox": f"{pid}_DISPROVE.lean" in next(m.text for m in s.messages if m.role == "tool"),
    "prompt shows both files": all(f"Submission/{f}.lean" in prompt1 for f in (pid, f"{pid}_DISPROVE")),
    "no objection channel (open problem)": '"FALSE:"' not in prompt1,
    "note written after session 1": recs[0].get("note") == "PROVED:\n- nothing (mock note)",
    "note written after the last session too": recs[1].get("note") == "PROVED:\n- nothing (mock note 2)",
    "prompt does not say how many sessions": "This is session 1." in prompt1 and "at most" not in prompt1,
    "snapshot keeps the agent's files": in_tar.get(f"opt/proofbench/Submission/{pid}_DISPROVE.lean", "").endswith("-- an attempt\n")
                                        and in_tar.get("tmp/scratch.py") == "scratch\n",
    "snapshot leaves out caches, checker and tool-server files": not any(
        ".cache" in n or "_reference_" in n or "_check_" in n or n.startswith("var/tmp/.") for n in in_tar)
                                                    and not snap.get("skipped"),
    "extract_proofs unpacks the snapshot": unpacked == "scratch\n",
    "note request uses the session's tools": names(calls[2]) == names(calls[1]) and calls[2].tool_choice == calls[1].tool_choice,
    "session 2 starts from the note": "mock note" in prompt2,
    "edited disproof reported": sc.metadata["polarity"] == "disprove" and sc.metadata["other"]["polarity"] == "prove",
    "graded in the verifier": sc.metadata["graded_in"] == "verifier",
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
