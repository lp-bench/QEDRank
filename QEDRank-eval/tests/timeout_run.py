"""The time limit of a tool call, end to end without any API: a scripted mock model runs, with
a 5-second limit per call, the pattern that hung the Fable pilot (a command that starts its own
`timeout 3000`), then a command that leaves processes behind (`setsid`, `nohup`), then lists
the processes, in the real Apptainer sandbox.  Checks: the first call ends with a timeout
right after its limit and ran once; nothing either command started survives; Inspect's tool
server and the Lean language server do.  About a minute; no Zenodo archive.
usage: .venv/bin/python tests/timeout_run.py [SIF]   (default proofbench-sandbox.sif)"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.event import ToolEvent  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

sif = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(ROOT / "proofbench-sandbox.sif")
LIMIT = 5
M = "mockllm/model"
bash = lambda command: ModelOutput.for_tool_call(model=M, tool_name="bash", tool_arguments={"command": command})
outputs = [
    bash("echo run >> /tmp/runs.txt; timeout 3000 sleep 1000"),
    bash("setsid sleep 1001 </dev/null >/dev/null 2>&1 & nohup sleep 1002 >/dev/null 2>&1 & echo started"),
    bash("cat /tmp/runs.txt; for d in /proc/[0-9]*; do tr '\\0' ' ' < $d/cmdline 2>/dev/null; echo; done"),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note)"),
]
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids="P014", sandbox="apptainer", sif=sif, network=False, sessions=1,
                      session_working_time=900, tool_timeout=LIMIT)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    log = read_eval_log(log.location, resolve_attachments=True)
s = log.samples[0]
calls = [e for e in s.events if isinstance(e, ToolEvent) and e.function == "bash"]
first, listing = calls[0], str(calls[2].result)
seconds = (first.completed - first.timestamp).total_seconds() if first.completed else None
checks = {
    "run finished": log.status == "success",
    "the long call ended with a timeout": first.error is not None and first.error.type == "timeout",
    f"right after its {LIMIT}-second limit": seconds is not None and seconds < LIMIT + 15,
    "and ran once": listing.count("run\n") == 1,
    "nothing the commands started survives": not any(f"sleep {n}" in listing for n in (1000, 1001, 1002)),
    "Inspect's tool server and the Lean server survive": "inspect-sandbox-tools" in listing and "lean-lsp-mcp" in listing,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures  (first call: {seconds} s)")
sys.exit(0 if all(checks.values()) else 1)
