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
under "sessions".  For an open problem each session shows both files, the
statement and its negation (`Pxxx_DISPROVE.lean`), and the chain ends as soon
as either passes.  A session that ends in a provider error is started again
without counting (see `handoff_sessions`).  For a problem without a negation
file, an agent convinced that the statement is false submits a text starting
with "FALSE:" (an objection): if the file does not pass, this ends the chain,
and the objection is recorded for review by hand.
"""

import asyncio
import re
from typing import Any

from inspect_ai.agent import AgentPrompt, AgentSubmit, react, run
from inspect_ai.event import ModelEvent
from inspect_ai.log import transcript
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

from proofbench_eval.scorer import check_submission, collect_submission, helper_modules, pick, targets

SYSTEM = (
    "You are an expert in Lean 4 and Mathlib. Work carefully: check goals and "
    "diagnostics after every edit, and compile before submitting."
)

SESSION = """
This is session {k} of at most {n}.  A session ends when you call submit(),
or after {budget:,} output tokens from you (reasoning included).  If it ends
without a complete proof, you will be asked for a short handoff note, and the
next session starts fresh from {start} and that note.

Work incrementally and keep the files compiling: state helper lemmas with
`sorry` first, check that the main theorem compiles from them, then replace
the `sorry`s one at a time, compiling after each change.  Files that compile
with a few `sorry`s are progress the next session can build on; only the
final submission must be free of `sorry`.

When {which} compiles with the complete proof, call submit() with the text
"done".
{objection}{files}"""

# Added to SESSION for a problem without a negation file: a channel for
# reporting a statement that is false as formalized.
OBJECTION = """
If you are convinced that the statement as formalized is false, call submit()
with a text starting with "FALSE:" and a short explanation instead.  This ends
your work on the problem; it does not count as solved, but every such report
is reviewed by hand.
"""

# One per target file (two for an open problem).
FILE = """
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
the next session directly; do not continue working on the proof.  The next
session starts from the current files and their Lean output, but sees nothing
of this conversation.  Use exactly this format and do not call tools:

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


def _last_model_call() -> ModelEvent | None:
    """The most recent model call of the sample: the session's last one."""
    return next((e for e in reversed(transcript().events) if isinstance(e, ModelEvent)), None)


async def _handoff_note(messages: list[ChatMessage], max_tokens: int) -> str:
    # The request repeats the session's last call (same tools, same tool
    # choice) with the handoff request appended: Anthropic rejects a history
    # with tool calls but no tool definitions, and an unchanged prefix is read
    # from the prompt cache instead of being paid again in full.
    # A reasoning model may spend the whole budget thinking and return no
    # text; the request is then repeated once.
    call = _last_model_call()
    try:
        for _ in range(2):
            output = await get_model().generate(
                _complete_turns(messages) + [ChatMessageUser(content=HANDOFF_REQUEST)],
                tools=call.tools if call else [],
                tool_choice=call.tool_choice if call else None,
                config=GenerateConfig(max_tokens=max_tokens),
            )
            if output.completion.strip():
                return output.completion.strip()
        return "(no note: the model returned no text)"
    except Exception as ex:
        return f"(no note: {type(ex).__name__}: {str(ex)[:200]})"


# Exceptions (by class name) and messages that mean the model provider, not the model, failed.
PROVIDER_ERRORS = (
    "RateLimit", "APIStatus", "APIConnection", "APITimeout", "Timeout", "InternalServer", "ServiceUnavailable",
    "Overloaded", "BadGateway", "GatewayTimeout", "ConnectError", "ReadTimeout", "RemoteProtocol",
    "InsufficientQuota", "PermissionDenied", "AuthenticationError",
)
PROVIDER_MESSAGE = re.compile(
    r"\b(401|402|403|429|500|502|503|504|529)\b|rate.?limit|overloaded|insufficient.?(balance|quota)"
    r"|connection (refused|reset|error)|temporarily unavailable", re.I
)
# The account's budget is used up (a daily or monthly request limit, a quota, the credit):
# retrying cannot help before it resets.
QUOTA_MESSAGE = re.compile(
    r"(daily|monthly) (request )?(rate )?(limit|quota)|limit exhausted|insufficient.?quota"
    r"|exceeded your current quota|credit balance is too low|no credits remaining", re.I
)


def _exceptions(ex: BaseException):
    """The exception, the members of exception groups and the chain of causes."""
    seen: set[int] = set()
    todo: list[BaseException | None] = [ex]
    while todo:
        e = todo.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        yield e
        todo += [*getattr(e, "exceptions", ()), e.__cause__, e.__context__]


def error_kind(ex: BaseException) -> str:
    """'quota' when the account's budget is used up, 'provider' for rate limits, server
    and connection failures, 'other' for everything else."""
    provider = False
    for e in _exceptions(ex):
        if QUOTA_MESSAGE.search(f"{type(e).__name__}: {e}"):
            return "quota"
        provider |= any(n in type(e).__name__ for n in PROVIDER_ERRORS) or bool(PROVIDER_MESSAGE.search(str(e)))
    return "provider" if provider else "other"


@solver
def handoff_sessions(
    tools: list[Tool | ToolSource],
    sessions: int = 10,
    output_tokens: int = 120_000,
    total_tokens: int | None = 20_000_000,
    working_seconds: float | None = 5400,
    note_tokens: int = 32_000,
    provider_retries: int = 2,
    provider_backoff: float = 30.0,
) -> Solver:
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        md = state.metadata
        note: str | None = None
        records: list[dict[str, Any]] = []
        transcript: list[ChatMessage] = []
        rel = lambda p: p[len(md["project_dir"]) + 1 :]
        both = len(targets(md)) > 1
        # A session that ends in a provider error (rate limit, server or connection failure) is
        # not the model's work: it is started again after a pause, without counting against
        # `sessions`, at most `provider_retries` times per problem.  A used-up budget (daily
        # limit, quota, credit) stops the chain at once.  Either way an unsolved, aborted chain
        # is scored NOANSWER (infrastructure), not INCORRECT.  Ported from the QEDRank fork.
        k, failures = 1, 0
        while k <= sessions:
            blocks = []
            for t in targets(md):
                files = await collect_submission(sandbox(), t)
                helpers = [rel(p) for p in files if p != t["submission"]]
                others = (
                    f"\nFiles that `{rel(t['submission'])}` imports (read them as needed): " + ", ".join(helpers) + "\n"
                    if helpers
                    else ""
                )
                blocks.append(FILE.format(
                    submission=t["submission"],
                    file=files.get(t["submission"], "(file missing)"),
                    others=others,
                    lean=await _lean_output(t, files),
                ))
            prompt = state.input_text + SESSION.format(
                k=k,
                n=sessions,
                budget=output_tokens,
                start="the current files, their Lean output" if both else "the current file, its Lean output",
                which="either file" if both else "the file",
                objection="" if both else OBJECTION,
                files="".join(blocks),
            )
            if note is not None:
                prompt += NOTE.format(prev=k - 1, note=note)
            out_limit = token_limit(output_tokens, type="output")
            all_limit = token_limit(total_tokens)
            work_limit = working_limit(working_seconds)
            # answer_only: the submitted text alone becomes the agent's completion.
            submit = AgentSubmit(answer_only=True)
            agent = react(prompt=AgentPrompt(instructions=SYSTEM), tools=tools, attempts=1, submit=submit)
            messages: list[ChatMessage] = []
            kind, submitted = None, None
            try:
                agent_state, exceeded = await run(
                    agent, prompt, limits=[out_limit, all_limit, work_limit], name=f"session {k}"
                )
                messages = agent_state.messages
                ended_by = exceeded.type if exceeded else "submit"
                if not exceeded:
                    submitted = agent_state.output.completion.strip()[:2000]
            except Exception as ex:
                kind = error_kind(ex)
                ended_by = f"{'error' if kind == 'other' else kind + '_error'}: {type(ex).__name__}: {str(ex)[:200]}"
            if kind in ("provider", "quota"):
                failures += 1
                records.append({
                    "session": k, "ended_by": ended_by, "error_kind": kind, "counted": False, "retry": failures,
                    "output_tokens": int(out_limit.usage), "total_tokens": int(all_limit.usage),
                    "working_seconds": round(work_limit.usage), "passed": False, "errors": [],
                })
                state.store.set("sessions", records)
                if kind == "provider" and failures <= provider_retries:
                    await asyncio.sleep(provider_backoff * failures)
                    continue  # the same session again: a provider failure consumes no session
                state.store.set("provider_abort", kind)
                break
            graded = []  # layer 1 only, to decide whether to stop
            for t in targets(md):
                try:
                    report = await check_submission(sandbox(), t)
                except Exception as ex:
                    report = {"ok": False, "errors": [f"check failed: {type(ex).__name__}: {str(ex)[:200]}"]}
                graded.append({"target": t, "layer1": report, "ok": bool(report.get("ok"))})
                if graded[-1]["ok"]:
                    break
            main = pick(graded)
            record = {
                "session": k,
                "ended_by": ended_by,
                "error_kind": kind,
                "counted": True,
                "output_tokens": int(out_limit.usage),
                "total_tokens": int(all_limit.usage),
                "working_seconds": round(work_limit.usage),
                "passed": main["ok"],
                "polarity": main["target"]["polarity"],
                "errors": main["layer1"].get("errors", [])[:3],
                "submitted": submitted,
                "objection": not both and submitted is not None and submitted.upper().startswith("FALSE"),
            }
            transcript += messages
            if not record["passed"] and not record["objection"] and k < sessions:
                note = (
                    await _handoff_note(messages, note_tokens)
                    if messages
                    else "(no note: the session ended before any model output)"
                )
                record["note"] = note
            records.append(record)
            state.store.set("sessions", records)
            if record["passed"] or record["objection"]:
                break
            k += 1
        state.messages = transcript
        return state

    return solve
