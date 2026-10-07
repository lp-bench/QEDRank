"""Sessions with handoff.

A problem is attempted in at most `sessions` fresh sessions.  Each session is
a new conversation that starts from the current file, the Lean output for it
and the handoff note of the previous session; it ends when the agent submits
or its output-token budget (reasoning included) runs out, with total tokens
and working time as safety caps.  After every session the Lean check of
scorer.py runs; the first session that passes ends the chain.  When a session
ends without a proof, the model writes a handoff note in a fixed format,
outside the session's budget.  Per-session records go to the sample store
under "sessions".
"""

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

from proofbench_eval.scorer import check_submission

SYSTEM = (
    "You are an expert in Lean 4 and Mathlib. Work carefully: check goals and "
    "diagnostics after every edit, and compile before submitting."
)

SESSION = """
This is session {k} of at most {n}.  A session ends when you call submit(),
or after {budget:,} output tokens from you (reasoning included).  If it ends
without a complete proof, you will be asked for a short handoff note, and the
next session starts fresh from the current file, its Lean output and that note.

Work incrementally and keep the file compiling: state helper lemmas with
`sorry` first, check that the main theorem compiles from them, then replace
the `sorry`s one at a time, compiling after each change.  A file that compiles
with a few `sorry`s is progress the next session can build on; only the final
submission must be free of `sorry`.

When the file compiles with the complete proof, call submit() with the text
"done".

Current content of `{submission}`:
```lean
{file}
```

Lean output for this file:
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
the next session.  It starts from the current file and its Lean output, but
sees nothing of this conversation.  Use exactly this format, at most 400 words,
and do not call tools:

PROVED:
- lemmas in the file that compile without sorry, by name
OPEN GOALS:
- what remains to be proved, as precisely as possible
FAILED APPROACHES:
- what you tried that did not work, and why
"""


def _complete_turns(messages: list[ChatMessage]) -> list[ChatMessage]:
    """Drop a final assistant turn whose tool calls were not all answered."""
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if isinstance(m, ChatMessageAssistant) and m.tool_calls:
            answered = sum(isinstance(x, ChatMessageTool) for x in messages[i + 1 :])
            return messages[:i] if answered < len(m.tool_calls) else messages
    return messages


async def _lean_output(md: dict[str, Any]) -> str:
    """Compiler messages for the submission, shortened to head and tail."""
    try:
        r = await sandbox().exec(
            ["bash", "-c", f"cd {md['project_dir']} && lake env lean {md['submission']}"], timeout=900
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


@solver
def handoff_sessions(
    tools: list[Tool | ToolSource],
    sessions: int = 10,
    output_tokens: int = 30_000,
    total_tokens: int | None = 1_000_000,
    working_seconds: float | None = 1800,
    note_tokens: int = 8000,
) -> Solver:
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        md = state.metadata
        note: str | None = None
        records: list[dict[str, Any]] = []
        transcript: list[ChatMessage] = []
        for k in range(1, sessions + 1):
            prompt = state.input_text + SESSION.format(
                k=k,
                n=sessions,
                budget=output_tokens,
                submission=md["submission"],
                file=await sandbox().read_file(md["submission"]),
                lean=await _lean_output(md),
            )
            if note is not None:
                prompt += NOTE.format(prev=k - 1, note=note)
            out_limit = token_limit(output_tokens, type="output")
            all_limit = token_limit(total_tokens)
            work_limit = working_limit(working_seconds)
            agent = react(prompt=AgentPrompt(instructions=SYSTEM), tools=tools, attempts=1)
            messages: list[ChatMessage] = []
            try:
                agent_state, exceeded = await run(
                    agent, prompt, limits=[out_limit, all_limit, work_limit], name=f"session {k}"
                )
                messages = agent_state.messages
                ended_by = exceeded.type if exceeded else "submit"
            except Exception as ex:
                ended_by = f"error: {type(ex).__name__}: {str(ex)[:200]}"
            report = await check_submission(sandbox(), md, state.sample_id)  # layer 1 only, to decide whether to stop
            record = {
                "session": k,
                "ended_by": ended_by,
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
        state.messages = transcript
        return state

    return solve
