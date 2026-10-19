"""Sessions with handoff.

A problem is attempted in at most `sessions` fresh sessions.  Each session is
a new conversation that starts from the current file (plus the names of the
helper files it imports), the Lean output for it and the handoff note of the
previous session; it ends when the agent submits
or its output-token budget (reasoning included) runs out, with total tokens
and working time as safety caps.  After every session the Lean check of
scorer.py runs; the first session that passes ends the chain.  When a session
ends without a proof, the model writes a handoff note in a fixed format
(proved, open, failed, unsaved draft), outside the session's budget.  Per-session records go to the sample store
under "sessions".
"""

import asyncio
import re
from typing import Any

from inspect_ai.agent import AgentPrompt, react, run
from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageTool,
    ChatMessageUser,
    GenerateConfig,
    get_model,
)
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import Tool, ToolSource
from inspect_ai.util import sandbox, token_limit, working_limit

from proofbench_eval.scorer import check_submission, collect_submission, helper_modules

SYSTEM = (
    "You are an expert in Lean 4 and Mathlib. Work carefully: check goals and "
    "diagnostics after every edit, and compile before submitting."
)

SESSION = """
This is session {k} of at most {n}.  A session ends when you call submit(),
or after {budget:,} output tokens from you (reasoning included).  If it ends
without a complete proof, you will be asked for a short handoff note, and the
next session starts fresh from the current file, its Lean output and that note.

Work incrementally and keep the files compiling: state helper lemmas with
`sorry` first, check that the main theorem compiles from them, then replace
the `sorry`s one at a time, compiling after each change.  Files that compile
with a few `sorry`s are progress the next session can build on; only the
final submission must be free of `sorry`.

When the file compiles with the complete proof, call submit() with the text
"done".

Current content of `{submission}`:
```lean
{file}
```
{others}
Lean output (helper files are built first, then this file):
```
{lean}
```
"""

NOTE = """
Handoff note from session {prev}:
{note}
"""

HANDOFF_REQUEST = """\
Your session has ended without a complete proof.  Write the handoff note for
the next session.  It starts from the current files and their Lean output, but
sees nothing of this conversation.  Use exactly this format and do not call
tools:

PROVED:
- lemmas in the files that compile without sorry, by name
OPEN GOALS:
- what remains to be proved, as precisely as possible
FAILED APPROACHES:
- what you tried that did not work, and why
DRAFT:
- Lean code you wrote in this conversation but did not save to a file, verbatim
  (empty if everything is in the files)
"""


def _complete_turns(messages: list[ChatMessage]) -> list[ChatMessage]:
    """Drop a final assistant turn whose tool calls were not all answered."""
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if isinstance(m, ChatMessageAssistant) and m.tool_calls:
            answered = sum(isinstance(x, ChatMessageTool) for x in messages[i + 1 :])
            return messages[:i] if answered < len(m.tool_calls) else messages
    return messages


async def _lean_output(md: dict[str, Any], files: dict[str, str]) -> str:
    """Compiler messages for the submission (helper modules built through lake
    first), shortened to head and tail."""
    mods = helper_modules(files, md)
    build = f"lake build {' '.join(mods)} && " if mods else ""
    try:
        r = await sandbox().exec(
            ["bash", "-c", f"cd {md['project_dir']} && {build}lake env lean {md['submission']}"], timeout=900
        )
        out = (r.stdout + r.stderr).strip() or "(no messages: the file compiles without errors or warnings)"
    except TimeoutError:
        out = "(lake env lean timed out after 900 s)"
    return out if len(out) <= 6000 else out[:3000] + "\n... (truncated) ...\n" + out[-3000:]


async def _handoff_note(messages: list[ChatMessage], max_tokens: int) -> str:
    try:
        output = await get_model().generate(
            _complete_turns(messages) + [ChatMessageUser(content=HANDOFF_REQUEST)],
            config=GenerateConfig(max_tokens=max_tokens),
        )
        return output.completion.strip() or "(no note: the model returned no text)"
    except Exception as ex:
        return f"(no note: {type(ex).__name__}: {str(ex)[:200]})"


# Exceptions (by class name) and messages that mean the model provider, not the model, failed.
PROVIDER_ERRORS = (
    "RateLimit", "APIStatus", "APIConnection", "APITimeout", "Timeout", "InternalServer", "ServiceUnavailable",
    "Overloaded", "BadGateway", "GatewayTimeout", "ConnectError", "ReadTimeout", "RemoteProtocol",
    "InsufficientQuota", "PermissionDenied", "AuthenticationError",
)
PROVIDER_MESSAGE = re.compile(r"\b(401|402|403|429|500|502|503|504)\b|rate.?limit|overloaded|insufficient.?(balance|quota)|connection (refused|reset|error)|temporarily unavailable", re.I)


def error_kind(ex: BaseException) -> str:
    """'provider' for transport, quota and server-side failures; 'other' for everything else."""
    name = type(ex).__name__
    if any(n in name for n in PROVIDER_ERRORS) or PROVIDER_MESSAGE.search(str(ex)):
        return "provider"
    return "other"


@solver
def handoff_sessions(
    tools: list[Tool | ToolSource],
    sessions: int = 10,
    output_tokens: int = 30_000,
    total_tokens: int | None = 1_000_000,
    working_seconds: float | None = 1800,
    note_tokens: int = 8000,
    provider_retries: int = 2,
    provider_backoff: float = 30.0,
) -> Solver:
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        md = state.metadata
        note: str | None = None
        records: list[dict[str, Any]] = []
        transcript: list[ChatMessage] = []
        k, provider_failures = 1, 0
        # A session that ends in a provider error is not the model's work: it is started again
        # (provider_retries times, after a backoff) without counting against `sessions`; when the
        # retries are used up the chain stops and the scorer reports NOANSWER (infrastructure).
        while k <= sessions:
            files = await collect_submission(sandbox(), md)
            rel = lambda p: p[len(md["project_dir"]) + 1 :]
            helpers = [rel(p) for p in files if p != md["submission"]]
            others = (
                f"\nFiles that `{rel(md['submission'])}` imports (read them as needed): " + ", ".join(helpers) + "\n"
                if helpers
                else ""
            )
            prompt = state.input_text + SESSION.format(
                k=k,
                n=sessions,
                budget=output_tokens,
                submission=md["submission"],
                file=files.get(md["submission"], "(file missing)"),
                others=others,
                lean=await _lean_output(md, files),
            )
            if note is not None:
                prompt += NOTE.format(prev=k - 1, note=note)
            out_limit = token_limit(output_tokens, type="output")
            all_limit = token_limit(total_tokens)
            work_limit = working_limit(working_seconds)
            agent = react(prompt=AgentPrompt(instructions=SYSTEM), tools=tools, attempts=1)
            messages: list[ChatMessage] = []
            kind = None
            try:
                agent_state, exceeded = await run(
                    agent, prompt, limits=[out_limit, all_limit, work_limit], name=f"session {k}"
                )
                messages = agent_state.messages
                ended_by = exceeded.type if exceeded else "submit"
            except Exception as ex:
                kind = error_kind(ex)
                ended_by = f"{'provider_error' if kind == 'provider' else 'error'}: {type(ex).__name__}: {str(ex)[:200]}"
            if kind == "provider":
                provider_failures += 1
                records.append({
                    "session": k, "ended_by": ended_by, "error_kind": "provider", "counted": False,
                    "retry": provider_failures, "output_tokens": int(out_limit.usage), "total_tokens": int(all_limit.usage),
                    "working_seconds": round(work_limit.usage), "passed": False, "errors": [],
                })
                state.store.set("sessions", records)
                if provider_failures <= provider_retries:
                    await asyncio.sleep(provider_backoff * provider_failures)
                    continue  # the same session index again: a provider failure consumes no session
                state.store.set("provider_abort", True)
                break
            try:  # layer 1 only, to decide whether to stop
                report = await check_submission(sandbox(), md, state.sample_id)
            except Exception as ex:
                report = {"ok": False, "errors": [f"check failed: {type(ex).__name__}: {str(ex)[:200]}"]}
            record = {
                "session": k,
                "ended_by": ended_by,
                "error_kind": kind,
                "counted": True,
                "output_tokens": int(out_limit.usage),
                "total_tokens": int(all_limit.usage),
                "working_seconds": round(work_limit.usage),
                "passed": bool(report.get("ok")),
                "errors": report.get("errors", [])[:3],
            }
            transcript += messages
            if not record["passed"] and k < sessions:
                note = (
                    await _handoff_note(messages, note_tokens)
                    if messages
                    else "(no note: the session ended before any model output)"
                )
                record["note"] = note
            records.append(record)
            state.store.set("sessions", records)
            if record["passed"]:
                break
            k += 1
        state.messages = transcript
        return state

    return solve
