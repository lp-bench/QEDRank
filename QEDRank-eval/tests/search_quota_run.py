"""Used-up search credits in a whole run, without any API: a scripted mock model's first
action is a web search, and a fake HTTP client answers it with Tavily's HTTP 432 (plan limit
exceeded), in the real Apptainer sandbox with search on.  Checks: the session ends at once
instead of the agent working on without search, the chain stops without a second session,
and the problem is scored NOANSWER (results.csv status N), not INCORRECT.  About a minute;
no Zenodo archive (run.sh is not used).
usage: .venv/bin/python tests/search_quota_run.py [SIF] [PID]   (default proofbench-sandbox.sif P005)"""
import csv
import os
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai import eval as inspect_eval  # noqa: E402
from inspect_ai.log import read_eval_log  # noqa: E402
from inspect_ai.model import ModelOutput, get_model  # noqa: E402

import proofbench_eval.search as search  # noqa: E402
from proofbench_eval.task import proofbench  # noqa: E402

sif = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else str(ROOT / "proofbench-sandbox.sif")
pid = sys.argv[2] if len(sys.argv) > 2 else "P005"
M = "mockllm/model"
os.environ["TAVILY_API_KEY"] = "test-key"
searches = 0


class FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        global searches
        searches += 1
        return httpx.Response(432, json={"detail": {"error": "Plan limit exceeded"}}, request=httpx.Request("POST", url))


search.httpx = types.SimpleNamespace(AsyncClient=FakeClient, HTTPError=httpx.HTTPError)  # search.py only
outputs = [
    ModelOutput.for_tool_call(model=M, tool_name="web_search", tool_arguments={"query": "fan sequences graph"}),
    # never reached when the guard works: the session would go on and be submitted
    ModelOutput.for_tool_call(model=M, tool_name="submit", tool_arguments={"answer": "done"}),
    ModelOutput.from_content(model=M, content="PROVED:\n- nothing (mock note)"),
]
t0 = time.monotonic()
with tempfile.TemporaryDirectory() as logdir:
    task = proofbench(ids=pid, sandbox="apptainer", sif=sif, network=True, search=True, search_provider="tavily",
                      sessions=2, session_working_time=900)
    log = inspect_eval(task, model=get_model(M, custom_outputs=outputs), log_dir=logdir, display="none")[0]
    subprocess.run([sys.executable, str(ROOT / "scripts" / "analyze.py"), logdir], capture_output=True, check=True)
    row = next(csv.DictReader(open(Path(logdir) / "results.csv")))
    log = read_eval_log(log.location)
seconds = time.monotonic() - t0
s = log.samples[0]
sc = s.scores["lean_check"]
recs = s.store["sessions"]
checks = {
    "run finished": log.status == "success",
    "one search was attempted": searches == 1,
    "the session ended with the search error, uncounted": len(recs) == 1 and recs[0]["error_kind"] == "quota"
    and not recs[0]["counted"] and "SearchUnavailable" in recs[0]["ended_by"] and "432" in recs[0]["ended_by"],
    "no second session": s.store.get("provider_abort") == "quota" and all(r["session"] == 1 for r in recs),
    "unsolved problem scored NOANSWER": sc.value == "N" and sc.metadata["infrastructure_error"]
    and "search credits" in (sc.explanation or ""),
    "results.csv: status N, correct empty, quota_error": row["status"] == "N" and row["correct"] == ""
    and "quota_error" in row["session_ends"],
    "no long waits": seconds < 300,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures ({seconds:.0f} s)")
sys.exit(0 if all(checks.values()) else 1)
