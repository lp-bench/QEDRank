"""error_kind of sessions.py, without any API or sandbox: which exceptions count as the provider's
or the node's failure (session restarted uncounted, then NOANSWER), which as a used-up budget, and
which as the model's own.  Instant.
usage: .venv/bin/python tests/error_kinds.py"""
import sys
from pathlib import Path

import httpx
import openai

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai.tool import ToolError  # noqa: E402
from inspect_ai.tool._sandbox_tools_utils.sandbox import SandboxInjectionError  # noqa: E402

from proofbench_eval.search import SearchUnavailable  # noqa: E402
from proofbench_eval.sessions import error_kind  # noqa: E402


def api_error(status: int, message: str) -> openai.APIStatusError:
    response = httpx.Response(status, json={"error": {"message": message}}, request=httpx.Request("POST", "https://x/v1"))
    return openai.APIStatusError(f"Error code: {status} - {message}", response=response, body=None)


# The messages of 2026-11-01 on the TUBAF cluster (job 9128), shortened.
injection = SandboxInjectionError(
    "Failed to inject sandbox tools into sandbox: Error executing command \nuname -s\n: sh: 7: uname: Too many open files")
exec_failure = RuntimeError("Sandbox.exec failure executing mcp_kill_server(session_id: 2): /.inspect-apptainer/8c77.sh: 2: exec: /bin/sh: Too many open files")
gone = ConnectionError("the apptainer instance inspect-ab12 is not running: FATAL: no instance found with name inspect-ab12")
wrapped = ExceptionGroup("tool failed", [RuntimeError("apptainer exec failed for instance inspect-ab12: error while loading shared libraries")])
checks = {
    "tool injection failure is the node's (provider)": error_kind(injection) == "provider",
    "an exec that cannot start is the node's": error_kind(exec_failure) == "provider",
    "a lost instance is the node's": error_kind(gone) == "provider",
    "a failure inside an exception group is found": error_kind(wrapped) == "provider",
    "rate limit is the provider's": error_kind(api_error(429, "Too many requests")) == "provider",
    "server error is the provider's": error_kind(api_error(503, "overloaded")) == "provider",
    "used-up daily limit is quota": error_kind(api_error(429, "User daily request rate limit exhausted (400 of 400).")) == "quota",
    "used-up search credits are quota": error_kind(SearchUnavailable("web search unavailable: Tavily HTTP 432")) == "quota",
    "a tool error is the model's (other)": error_kind(ToolError("search failed: HTTP 400")) == "other",
    "an ordinary exception is other": error_kind(ValueError("bad value")) == "other",
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
