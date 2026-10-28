"""Provider errors in a whole run without any API: the scripted mock model's first call fails
with a rate limit (HTTP 429), session 1 is then worked normally, and session 2 fails because
the account's daily request limit is used up (GWDG's message), in the real Apptainer sandbox.
Checks: the rate-limited session is started again without counting, the used-up budget stops
the chain at once, and the unsolved problem is scored NOANSWER (results.csv status N), not
INCORRECT.  About a minute; no Zenodo archive (run.sh is not used).
usage: .venv/bin/python tests/provider_errors_run.py [SIF] [PID]   (default proofbench-sandbox.sif P005)"""
import csv
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import openai

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

sif = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(ROOT / "proofbench-sandbox.sif")
pid = sys.argv[2] if len(sys.argv) > 2 else "P005"
M = "mockllm/model"


def rate_limit(message: str) -> openai.RateLimitError:
    """The error the OpenAI client raises for an HTTP 429 from an OpenAI-compatible endpoint."""
    body = {"error": {"message": message, "type": "rate_limit_exceeded"}}
    response = httpx.Response(429, json=body, request=httpx.Request("POST", "https://chat-ai.academiccloud.de/v1/chat/completions"))
    return openai.RateLimitError(f"Error code: 429 - {body}", response=response, body=body)


model = get_model(M, custom_outputs=[
    ModelOutput.for_tool_call(model=M, tool_name="bash", tool_arguments={
        "command": f"echo '-- an attempt' >> /opt/proofbench/Submission/{pid}_DISPROVE.lean"}),
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note)"),
])
failures = {1: rate_limit("Too many requests"), 5: rate_limit("User daily request rate limit exhausted (400 of 400).")}
scripted = model.api.generate
calls = 0


async def generate(*args, **kwargs):
    global calls
    calls += 1
    if calls in failures:
        raise failures[calls]
    return await scripted(*args, **kwargs)


model.api.generate = generate
t0 = time.monotonic()
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=False, sessions=2, session_working_time=900,
                      provider_retries=2, provider_backoff=1)
    log = inspect_eval(task, model=model, log_dir=logdir, display="none")[0]
    subprocess.run([sys.executable, str(ROOT / "scripts" / "analyze.py"), logdir], capture_output=True, check=True)
    row = next(csv.DictReader(open(Path(logdir) / "results.csv")))
    log = read_eval_log(log.location)
seconds = time.monotonic() - t0
s = log.samples[0]
sc = s.scores["lean_check"]
recs = s.store["sessions"]
checks = {
    "run finished": log.status == "success",
    "rate limit: session 1 started again, uncounted": [r["session"] for r in recs] == [1, 1, 2]
    and recs[0]["error_kind"] == "provider" and not recs[0]["counted"] and recs[1]["counted"],
    "used-up budget stops the chain at once": recs[2]["error_kind"] == "quota" and not recs[2]["counted"] and calls == 5,
    "note written after the counted session": recs[1].get("note") == "PROVED:\n- nothing (mock note)",
    "unsolved problem scored NOANSWER": sc.value == "N" and sc.metadata["infrastructure_error"] and sc.metadata["provider_abort"] == "quota",
    "sessions_used counts the counted session only": sc.metadata["sessions_used"] == 1 and sc.metadata["provider_failures"] == 2,
    "results.csv: status N, correct empty": row["status"] == "N" and row["correct"] == "" and row["provider_failures"] == "2",
    "no long waits": seconds < 300,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures ({seconds:.0f} s)")
sys.exit(0 if all(checks.values()) else 1)
