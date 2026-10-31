"""The web_search tool's handling of Tavily's answers, without any API or sandbox: a fake
HTTP client returns each status in turn.  Checks: results are formatted; a used-up plan
(432), a used-up pay-as-you-go limit (433) and a rejected key (401) raise SearchUnavailable,
which sessions.py classifies as a used-up budget ('quota'); a bad request (400) and a rate
limit that persists (429) are reported to the agent as ToolErrors.  A few seconds.
usage: .venv/bin/python tests/search_guard.py"""
import asyncio
import os
import sys
import types
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inspect_ai.tool import ToolError  # noqa: E402

import proofbench_eval.search as search  # noqa: E402
from proofbench_eval.sessions import error_kind  # noqa: E402

os.environ.setdefault("TAVILY_API_KEY", "test-key")
answers: list[tuple[int, dict]] = []


class FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        status, body = answers.pop(0)
        return httpx.Response(status, json=body, request=httpx.Request("POST", url))


# Only search.py sees the fake client; the real httpx stays in place everywhere else.
search.httpx = types.SimpleNamespace(AsyncClient=FakeClient, HTTPError=httpx.HTTPError)
search.asyncio = types.SimpleNamespace(sleep=lambda s: asyncio.sleep(0))  # no waits between retries
tool = search.web_search()


def call(*statuses_bodies):
    answers[:] = list(statuses_bodies)
    try:
        return asyncio.run(tool(query="Vizing theorem"))
    except Exception as ex:  # noqa: BLE001
        return ex


ok = call((200, {"results": [{"title": "A", "url": "https://a.example", "content": "first"},
                               {"title": "B", "url": "https://b.example", "content": "second"}]}))
plan = call((432, {"detail": {"error": "Plan limit exceeded"}}))
paygo = call((433, {"detail": {"error": "Pay-as-you-go limit exceeded"}}))
key = call((401, {"detail": {"error": "Unauthorized"}}))
bad = call((400, {"detail": {"error": "Query is too long"}}))
limited = call(*[(429, {"detail": {"error": "Too many requests"}})] * 4)
checks = {
    "results are numbered with their URLs": isinstance(ok, str) and ok.startswith("1. A\n   https://a.example\n   first")
    and "\n\n2. B\n" in ok,
    "432 (plan limit) raises SearchUnavailable": isinstance(plan, search.SearchUnavailable) and "432" in str(plan),
    "433 (pay-as-you-go limit) raises SearchUnavailable": isinstance(paygo, search.SearchUnavailable),
    "401 (key rejected) raises SearchUnavailable": isinstance(key, search.SearchUnavailable),
    "SearchUnavailable counts as a used-up budget": error_kind(plan) == "quota" and error_kind(key) == "quota",
    "400 is a ToolError for the agent": isinstance(bad, ToolError) and "HTTP 400" in str(bad),
    "a persisting 429 is a ToolError after the retries": isinstance(limited, ToolError) and "after retries" in str(limited)
    and not answers,
    "ToolErrors are not budget errors": error_kind(bad) == "other" or error_kind(bad) == "provider",
}
for name, good in checks.items():
    print(("ok   " if good else "FAIL ") + name)
print(f"{sum(not good for good in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
