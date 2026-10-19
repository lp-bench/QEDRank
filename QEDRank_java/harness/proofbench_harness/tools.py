"""Tools given to the agent, and the record of what it looked up.

Without web search the sandbox has no network at all, and the Lean language server is offered
without its five web-backed search tools. With web search every model gets the same external
search provider (never a vendor's built-in search), plus a page fetcher; each query and each
address is written to the sample's search log.
"""

from __future__ import annotations

import re
import time
from typing import Any, Sequence

from inspect_ai.tool import MCPServer, Tool, ToolDef, ToolError, ToolResult, ToolSource, bash, mcp_server_sandbox, python, text_editor, tool, web_search
from inspect_ai.util import sandbox, store

#: lean-lsp-mcp tools that call a web service; removed when the network is off.
LEAN_LSP_WEB_TOOLS: tuple[str, ...] = ("lean_leansearch", "lean_loogle", "lean_leanfinder", "lean_state_search", "lean_hammer_premise")

SEARCH_LOG_KEY = "proofbench:search_log"
END_SESSION_KEY = "proofbench:end_session"
SESSION_INDEX_KEY = "proofbench:session_index"

URL_RE = re.compile(r"https?://[^\s'\"<>)\]}|\\]+")
_USER_AGENT = "proofbench-harness/0.1 (benchmark agent; see run log)"


def record_lookup(kind: str, value: str, **extra: Any) -> None:
    """Append one entry to the sample's search log.

    kind: "query" (web search), "fetch" (page fetched with web_fetch), "lean_search" (a web-backed
    Lean search tool) or "shell_url" (an address that appeared in a shell or Python command).
    """
    log = list(store().get(SEARCH_LOG_KEY, []))
    log.append({"kind": kind, "value": value, "session": store().get(SESSION_INDEX_KEY), "at": time.time(), **extra})
    store().set(SEARCH_LOG_KEY, log)


def urls_in(value: Any) -> list[str]:
    """Addresses that appear in a tool result or a tool call, in order, without duplicates."""
    seen: dict[str, None] = {}
    for url in URL_RE.findall(value if isinstance(value, str) else repr(value)):
        seen.setdefault(url.rstrip(".,;:"), None)
    return list(seen)


@tool
def end_session() -> Tool:
    async def execute(reason: str = "") -> str:
        """End this session. The working file is then checked independently. If the problem is
        not solved and sessions remain, a new session starts from the file and the handoff note.

        Args:
            reason: One line on why the session ends (for example "proof complete").
        """
        store().set(END_SESSION_KEY, reason.strip() or "ended by the agent")
        return "Session ended."

    return execute


@tool(name="web_search")
def logged_web_search(provider: str = "tavily", options: dict[str, Any] | None = None) -> Tool:
    """Web search through one external provider, the same for every model, with each query recorded."""
    inner = web_search({provider: options if options else True})  # type: ignore[misc]

    async def execute(query: str) -> ToolResult:
        """Search the web and return the most relevant results.

        Args:
            query: What to search for.
        """
        result = await inner(query)
        record_lookup("query", query, provider=provider, result_urls=urls_in(result)[:50])
        return result

    return execute


@tool
def web_fetch(max_chars: int = 40_000, timeout: int = 60) -> Tool:
    """Fetch one address from inside the sandbox, so the sandbox's network policy applies."""

    async def execute(url: str) -> str:
        """Fetch a web page or file and return its text.

        Args:
            url: The http or https address to fetch.
        """
        if not re.match(r"^https?://", url):
            raise ToolError("Only http and https addresses can be fetched.")
        record_lookup("fetch", url)
        result = await sandbox().exec(
            ["curl", "-sSL", "--max-time", str(timeout), "--max-filesize", "20000000", "-A", _USER_AGENT, url],
            timeout=timeout + 15,
        )
        if not result.success:
            raise ToolError(f"Fetch failed: {(result.stderr or '').strip()[:500]}")
        text = result.stdout
        return text if len(text) <= max_chars else f"{text[:max_chars]}\n… (truncated: {len(text):,} characters in total)"

    return execute


def lean_lsp_server(project_dir: str, command: str = "lean-lsp-mcp", timeout: int = 300) -> MCPServer:
    """The Lean language server (lean-lsp-mcp) running inside the sandbox on the project."""
    return mcp_server_sandbox(name="lean-lsp", command=command, cwd=project_dir, env={"LEAN_PROJECT_PATH": project_dir}, timeout=timeout)


def base_tools(*, tool_timeout: int = 600, web: bool = False, search_provider: str = "tavily", search_options: dict[str, Any] | None = None) -> list[Tool]:
    """Shell, Python and file editing; with ``web`` also search and fetch."""
    tools: list[Tool] = [bash(timeout=tool_timeout), python(timeout=tool_timeout), text_editor(), end_session()]
    if web:
        tools += [logged_web_search(provider=search_provider, options=search_options), web_fetch()]
    return tools


def tool_name(t: Tool | ToolDef) -> str:
    return t.name if isinstance(t, ToolDef) else ToolDef(t).name


async def resolve_tools(sources: Sequence[Tool | ToolDef | ToolSource], exclude: Sequence[str] = ()) -> list[Tool | ToolDef]:
    """Expand tool sources (such as a connected MCP server) into tools and drop the excluded names."""
    out: list[Tool | ToolDef] = []
    for src in sources:
        if isinstance(src, ToolSource):
            out.extend(await src.tools())
        else:
            out.append(src)
    banned = set(exclude)
    return [t for t in out if tool_name(t) not in banned]


def note_tool_calls(calls: Sequence[Any]) -> dict[str, int]:
    """Count tool calls by name and record addresses used from the shell or from Lean search tools."""
    counts: dict[str, int] = {}
    for call in calls:
        name = getattr(call, "function", "unknown")
        counts[name] = counts.get(name, 0) + 1
        args = getattr(call, "arguments", {}) or {}
        if name in LEAN_LSP_WEB_TOOLS:
            record_lookup("lean_search", str(args.get("query") or args)[:500], tool=name)
        elif name not in ("web_search", "web_fetch"):
            for url in urls_in(" ".join(str(v) for v in args.values()) if isinstance(args, dict) else str(args)):
                record_lookup("shell_url", url, tool=name)
    return counts
