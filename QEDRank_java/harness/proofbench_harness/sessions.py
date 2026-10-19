"""The session chain: at most `max_sessions` fresh-context sessions on one problem.

A session starts from three things only: the working file as the previous session left it,
the Lean compiler output for that file, and the handoff note in its fixed format. After every
session the independent Lean check is applied; the first session that passes ends the chain.

Each session runs under an output-token budget enforced by Inspect's token limit. A total-token
limit and a wall-clock limit exist as safety nets and are meant never to be the binding one;
when one of them does end a session, the session record says so.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Sequence

from inspect_ai.model import ChatMessage, ChatMessageSystem, ChatMessageUser, Model, ModelOutput, execute_tools, get_model
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import MCPServer, Tool, ToolDef, ToolSource
from inspect_ai.util import LimitExceededError, apply_limits, sandbox, store, time_limit, token_limit, working_limit

from .grader import Grader, grader_error
from .handoff import HANDOFF_FILENAME, HANDOFF_TEMPLATE, parse_handoff, render_handoff
from .prompts import BUDGET_WARNING, CONTINUE_PROMPT, PROMPT_VERSION, session_prompt, system_prompt
from .tools import END_SESSION_KEY, SEARCH_LOG_KEY, SESSION_INDEX_KEY, note_tool_calls, resolve_tools

CHAIN_KEY = "proofbench:chain"

try:  # Inspect's own accounting: wall clock minus waits on retries, rate limits and connection slots.
    from inspect_ai._util.working import sample_waiting_time as _sample_waiting_time
except Exception:  # pragma: no cover - private module moved
    _sample_waiting_time = None


async def read_text(box: Any, path: str) -> str:
    """A text file from the sandbox with Unix line endings (a local Windows sandbox writes CRLF)."""
    return (await box.read_file(path)).replace("\r\n", "\n")


def _waiting_time() -> float | None:
    if _sample_waiting_time is None:
        return None
    try:
        return float(_sample_waiting_time())
    except Exception:
        return None


@dataclass
class SessionLimits:
    """Per-session limits. Only `output_tokens` is meant to bind."""

    output_tokens: int | None = 64_000
    total_tokens: int | None = None
    time_s: float | None = None
    working_s: float | None = None
    #: fraction of the output budget after which the agent is told once to write its handoff
    warn_fraction: float = 0.85
    #: consecutive turns without a tool call before the session is closed as idle
    max_idle_turns: int = 3


@dataclass
class SessionRecord:
    index: int
    stop_reason: str = "unknown"
    end_reason: str | None = None
    verdict: str = "not_graded"
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    model_calls: int = 0
    tool_calls: int = 0
    tool_calls_by_tool: dict[str, int] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    cost_usd: float | None = None
    total_s: float = 0.0
    working_s: float | None = None
    waiting_s: float | None = None
    model_s: float = 0.0
    tool_s: float = 0.0
    grade_s: float = 0.0
    budget_warning_sent: bool = False
    completeness: float | None = None
    proof_lines: int | None = None
    compile_ms: float | None = None
    statement: str | None = None
    axioms: str | None = None
    handoff: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def add_output(self, output: ModelOutput) -> None:
        self.model_calls += 1
        self.model_s += float(output.time or 0.0)
        u = output.usage
        if u is None:
            return
        self.input_tokens += int(u.input_tokens or 0)
        self.output_tokens += int(u.output_tokens or 0)
        self.total_tokens += int(u.total_tokens or 0)
        self.cache_read_tokens += int(u.input_tokens_cache_read or 0)
        self.cache_write_tokens += int(u.input_tokens_cache_write or 0)
        self.reasoning_tokens += int(u.reasoning_tokens or 0)
        if u.total_cost is not None:
            self.cost_usd = (self.cost_usd or 0.0) + float(u.total_cost)


def _limit_stop_reason(err: LimitExceededError, out_limit: Any) -> str:
    if err.type == "token":
        return "output_token_budget" if out_limit is not None and err.source is out_limit else "total_token_limit"
    return {"time": "time_limit", "working": "working_time_limit", "message": "message_limit", "cost": "cost_limit"}.get(err.type, f"{err.type}_limit")


async def run_session(model: Model, messages: list[ChatMessage], tools: Sequence[Tool | ToolDef], limits: SessionLimits, record: SessionRecord) -> list[ChatMessage]:
    """One fresh-context session: generate, run tools, repeat, until the agent ends it or a limit does."""
    out_limit = token_limit(limits.output_tokens, type="output") if limits.output_tokens else None
    scoped = [lim for lim in (out_limit, token_limit(limits.total_tokens) if limits.total_tokens else None, time_limit(limits.time_s) if limits.time_s else None, working_limit(limits.working_s) if limits.working_s else None) if lim is not None]
    store().set(END_SESSION_KEY, None)
    idle = 0
    started = time.monotonic()
    waiting_before = _waiting_time()
    try:
        with apply_limits(scoped, catch_errors=True) as scope:
            while True:
                output = await model.generate(messages, tools)
                record.add_output(output)
                messages.append(output.message)
                if output.stop_reason == "model_length":
                    # The context window is full. There is no compaction: the session ends here and
                    # the next one starts from the file and the handoff note.
                    record.stop_reason = "context_window"
                    break
                calls = output.message.tool_calls or []
                if calls:
                    idle = 0
                    for name, n in note_tool_calls(calls).items():
                        record.tool_calls_by_tool[name] = record.tool_calls_by_tool.get(name, 0) + n
                        record.tool_calls += n
                    t0 = time.monotonic()
                    result = await execute_tools(messages, tools)
                    record.tool_s += time.monotonic() - t0
                    messages.extend(result.messages)
                    ended = store().get(END_SESSION_KEY)
                    if ended:
                        record.stop_reason = "agent_ended"
                        record.end_reason = str(ended)[:300]
                        break
                else:
                    idle += 1
                    if idle >= limits.max_idle_turns:
                        record.stop_reason = "idle"
                        break
                    messages.append(ChatMessageUser(content=CONTINUE_PROMPT))
                if out_limit is not None and not record.budget_warning_sent and out_limit.usage >= limits.warn_fraction * limits.output_tokens:
                    record.budget_warning_sent = True
                    messages.append(ChatMessageUser(content=BUDGET_WARNING.format(used=f"{int(out_limit.usage):,}", limit=f"{limits.output_tokens:,}")))
        if scope.limit_error is not None:
            record.stop_reason = _limit_stop_reason(scope.limit_error, out_limit)
    finally:
        record.total_s = time.monotonic() - started
        waiting_after = _waiting_time()
        if waiting_before is not None and waiting_after is not None:
            record.waiting_s = max(0.0, waiting_after - waiting_before)
            record.working_s = max(0.0, record.total_s - record.waiting_s)
        store().set(END_SESSION_KEY, None)
    return messages


def _model_settings(model: Model) -> dict[str, Any]:
    cfg = model.config
    return {
        "model": str(model),
        "reasoning_effort": cfg.reasoning_effort or cfg.effort,
        "reasoning_tokens": cfg.reasoning_tokens,
        "max_tokens": cfg.max_tokens,
        "temperature": cfg.temperature,
    }


def _totals(sessions: list[SessionRecord]) -> dict[str, Any]:
    def total(attr: str) -> Any:
        values = [getattr(s, attr) for s in sessions if getattr(s, attr) is not None]
        return sum(values) if values else None

    by_tool: dict[str, int] = {}
    for s in sessions:
        for name, n in s.tool_calls_by_tool.items():
            by_tool[name] = by_tool.get(name, 0) + n
    return {
        **{k: total(k) for k in ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "cost_usd", "total_s", "working_s", "waiting_s", "model_s", "tool_s", "grade_s", "model_calls", "tool_calls")},
        "tool_calls_by_tool": by_tool,
    }


def _search_summary(log: list[dict[str, Any]]) -> dict[str, Any]:
    queries = [e["value"] for e in log if e.get("kind") == "query"]
    lean = [e["value"] for e in log if e.get("kind") == "lean_search"]
    fetched = [e["value"] for e in log if e.get("kind") in ("fetch", "shell_url")]
    listed = [u for e in log if e.get("kind") == "query" for u in e.get("result_urls", [])]
    return {"queries": queries, "lean_search_queries": lean, "urls": list(dict.fromkeys(fetched)), "result_urls": list(dict.fromkeys(listed)), "events": len(log)}


@solver
def session_chain(
    *,
    grader: Grader,
    tools: Sequence[Tool | ToolDef | ToolSource],
    max_sessions: int = 4,
    limits: SessionLimits | None = None,
    work_path_template: str = "ProofBench/PROBLEMS/{id}/{id}.lean",
    exclude_tools: Sequence[str] = (),
    web_search: bool = False,
    network: bool = False,
    allowed_imports: str = "Mathlib or the ProofBench statement library (ProofBench.Mathlib_Problems)",
    max_heartbeats: int = 400_000,
    proxy_service: str | None = None,
) -> Solver:
    """Solver that runs the session chain and stores its full record under ``proofbench:chain``."""
    lim = limits or SessionLimits()

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        meta = state.metadata
        problem_id = str(meta.get("problem_id") or state.sample_id)
        target = str(meta["target"])
        challenge = str(meta["challenge"])
        work_path = work_path_template.format(id=problem_id)
        handoff_path = f"{work_path.rsplit('/', 1)[0]}/{HANDOFF_FILENAME}" if "/" in work_path else HANDOFF_FILENAME
        box = sandbox()
        model = get_model()

        # Every sample starts from the pristine challenge: no file of an earlier run is inherited.
        await box.write_file(work_path, challenge)
        await box.write_file(handoff_path, HANDOFF_TEMPLATE)

        chain: dict[str, Any] = {
            "schema": "proofbench-chain-v1",
            "prompt_version": PROMPT_VERSION,
            "problem_id": problem_id,
            "target": target,
            "sessions_max": max_sessions,
            "sessions_used": 0,
            "solved_at_session": None,
            "final_verdict": "not_graded",
            "final_reasons": [],
            "web_search": web_search,
            "network": network,
            "limits": {"session_output_tokens": lim.output_tokens, "session_total_tokens": lim.total_tokens, "session_time_s": lim.time_s, "session_working_s": lim.working_s},
            "model": _model_settings(model),
            "grader": grader.describe(),
            "work_path": work_path,
            "sessions": [],
            "totals": {},
            "search": _search_summary([]),
            "final_grade": None,
            "final_solution": None,
            "tools": [],
        }
        store().set(CHAIN_KEY, chain)
        store().set(SEARCH_LOG_KEY, [])

        sys_msg = ChatMessageSystem(content=system_prompt(max_sessions=max_sessions, output_tokens=lim.output_tokens, handoff_path=handoff_path, allowed_imports=allowed_imports, max_heartbeats=max_heartbeats, web_search=web_search))
        records: list[SessionRecord] = []
        compiler_output: str | None = None
        verdict_line: str | None = None
        handoff_text: str | None = None

        async def run_chain(resolved: list[Tool | ToolDef]) -> None:
            nonlocal compiler_output, verdict_line, handoff_text
            from .tools import tool_name

            chain["tools"] = sorted(tool_name(t) for t in resolved)
            for index in range(1, max_sessions + 1):
                record = SessionRecord(index=index)
                records.append(record)
                store().set(SESSION_INDEX_KEY, index)
                file_text = await read_text(box, work_path)
                messages: list[ChatMessage] = [
                    sys_msg,
                    ChatMessageUser(content=session_prompt(problem_id=problem_id, target=target, session=index, max_sessions=max_sessions, work_path=work_path, handoff_path=handoff_path, file_text=file_text, compiler_output=compiler_output, verdict_line=verdict_line, handoff_text=handoff_text)),
                ]
                try:
                    messages = await run_session(model, messages, resolved, lim, record)
                finally:
                    # The session's conversation is what the log viewer shows for the sample; the
                    # full history of every session is in the transcript events.
                    state.messages = messages

                    # ---- independent check: only the text of the working file leaves the sandbox ----
                    try:
                        solution: str | None = await read_text(box, work_path)
                    except Exception as err:  # the agent deleted or broke the file
                        solution = None
                        record.error = f"working file unreadable: {err}"
                    t0 = time.monotonic()
                    try:
                        grade = await grader.grade(challenge=challenge, solution=solution, target=target)
                    except Exception as err:
                        grade = grader_error("grader_raised", str(err))
                    record.grade_s = time.monotonic() - t0
                    record.verdict = grade.get("verdict", "grader_error")
                    record.reasons = list(grade.get("reasons") or [])
                    record.warnings = list(grade.get("warnings") or [])
                    comp = grade.get("completeness") or {}
                    record.completeness = comp.get("score") if comp.get("available") else None
                    record.proof_lines = (grade.get("proof") or {}).get("proof_lines")
                    record.compile_ms = (grade.get("timing") or {}).get("compile_ms")
                    checks = grade.get("checks") or {}
                    record.statement = (checks.get("statement") or {}).get("status")
                    record.axioms = (checks.get("axioms") or {}).get("status")

                    # ---- handoff: read, reduce to the fixed format, write the reduced note back ----
                    try:
                        note = parse_handoff(await read_text(box, handoff_path))
                    except Exception:
                        note = parse_handoff(None)
                    record.handoff = note.stats()
                    handoff_text = None if note.is_empty else render_handoff(note)
                    try:
                        await box.write_file(handoff_path, render_handoff(note))
                    except Exception:
                        pass
                    compiler_output = grade.get("compiler_output") or ""
                    verdict_line = record.verdict if not record.reasons else f"{record.verdict} ({', '.join(record.reasons)})"

                    log = list(store().get(SEARCH_LOG_KEY, []))
                    chain.update(
                        sessions=[asdict(r) for r in records],
                        sessions_used=len(records),
                        totals=_totals(records),
                        final_verdict=record.verdict,
                        final_reasons=record.reasons,
                        final_grade=grade,
                        final_solution=solution,
                        search=_search_summary(log),
                        search_log=log,
                    )
                    if record.verdict == "solved":
                        chain["solved_at_session"] = index
                    store().set(CHAIN_KEY, chain)
                if record.verdict == "solved":
                    break

        servers = [t for t in tools if isinstance(t, MCPServer)]
        if servers:
            from contextlib import AsyncExitStack

            async with AsyncExitStack() as stack:
                for server in servers:
                    await stack.enter_async_context(server)
                await run_chain(await resolve_tools(tools, exclude_tools))
        else:
            await run_chain(await resolve_tools(tools, exclude_tools))

        if proxy_service:
            # Hosts contacted from inside the sandbox, as the proxy saw them.
            try:
                chain["proxy_log"] = (await sandbox(proxy_service).read_file("/var/log/squid/access.log"))[-200_000:]
                store().set(CHAIN_KEY, chain)
            except Exception as err:
                chain["proxy_log_error"] = str(err)
                store().set(CHAIN_KEY, chain)
        return state

    return solve
