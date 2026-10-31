"""Web search for the agent.

Every model gets the same search by default: `web_search` below, plain results from
Tavily (title, URL, Tavily's extract of the page) without an AI-written answer, so that
models of different providers search the same engine and the log holds exactly what
the agent saw.  Inspect's own Tavily (and Exa) provider asks for a generated answer and
passes only that answer to Claude: the sources come as citations, which Anthropic does
not accept in tool results, so Inspect strips them, and the agent would read another
model's summary, sometimes wrong, instead of search results.  The agent reads a page in
full with curl in the sandbox, which has internet access whenever search is on.
When Tavily refuses every request (credits used up, key rejected), the tool raises
`SearchUnavailable` instead of reporting an error to the agent: see that class.

Alternative for Claude models (SEARCH_PROVIDER=anthropic): Anthropic's built-in
search, as in IMProofBench, in its basic version (see `basic_anthropic_search`).
"""

import asyncio
import os
from typing import Any

import httpx
from inspect_ai.tool import Tool, ToolError, tool

TAVILY_URL = "https://api.tavily.com/search"
EXTRACT_CHARS = 1500  # per result


def format_results(results: list[dict[str, Any]]) -> str:
    if not results:
        return "No results."
    out = []
    for i, r in enumerate(results, 1):
        extract = " ".join(str(r.get("content") or "").split())
        if len(extract) > EXTRACT_CHARS:
            extract = extract[:EXTRACT_CHARS] + " ..."
        out.append(f"{i}. {r.get('title') or '(no title)'}\n   {r.get('url') or ''}\n   {extract}")
    return "\n\n".join(out)


class SearchUnavailable(Exception):
    """Tavily refuses every request: the search credits are used up (HTTP 432, the plan's
    limit; 433, the pay-as-you-go limit) or the key is rejected (401, 403).  Not a ToolError:
    the agent would just work on without search, and a run "with search" would quietly turn
    into one without.  This ends the session instead; sessions.py treats it like a used-up
    model budget and the problem is scored NOANSWER (results.csv status N), to be run again."""


@tool
def web_search(max_results: int = 5) -> Tool:
    async def execute(query: str) -> str:
        """Search the web.

        Returns the title, URL and an extract of each result.  To read a page in
        full, fetch it in the shell (for example with curl).

        Args:
            query: The search query.
        """
        key = os.environ.get("TAVILY_API_KEY")
        if not key:
            raise ToolError("web search is not configured (TAVILY_API_KEY is not set)")
        body = {"query": query, "max_results": max_results, "search_depth": "basic",
                "include_answer": False, "include_raw_content": False, "include_images": False}
        error = ""
        for attempt in range(4):  # rate limits and server errors: retried after 5, 10, 20 s
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    r = await client.post(TAVILY_URL, json=body, headers={"Authorization": f"Bearer {key}"})
            except httpx.HTTPError as ex:
                error = type(ex).__name__
            else:
                if r.status_code == 200:
                    return format_results(r.json().get("results") or [])
                if r.status_code in (401, 403, 432, 433):
                    raise SearchUnavailable(f"web search unavailable: Tavily HTTP {r.status_code}: {r.text[:300]}")
                if r.status_code not in (429, 500, 502, 503, 504):
                    raise ToolError(f"search failed: HTTP {r.status_code}: {r.text[:300]}")
                error = f"HTTP {r.status_code}"
            if attempt < 3:
                await asyncio.sleep(5 * 2**attempt)
        raise ToolError(f"search failed after retries ({error})")

    return execute


def basic_anthropic_search() -> None:
    """Make Inspect send Anthropic's basic search and fetch tools (web_search_20250305,
    web_fetch_20250910) instead of the versions with dynamic filtering, which Inspect
    0.3.276 always chooses for current Claude models and which run code on Anthropic's
    servers: all of the agent's computation stays in the sandbox, where it is logged and
    limited.  Inspect's documented `type` option for this is not read by that version,
    so its helper is wrapped instead (for this pinned version)."""
    from inspect_ai.model._providers import anthropic as provider

    if getattr(provider, "_proofbench_basic_search", False):
        return
    original = provider._web_search_tool_params
    provider._web_search_tool_params = lambda options, filtering: original(options, False)
    provider._proofbench_basic_search = True
