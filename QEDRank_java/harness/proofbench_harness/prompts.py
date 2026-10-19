"""The text every model receives. Nothing in it depends on the model."""

from __future__ import annotations

from .handoff import HANDOFF_FORMAT_DESCRIPTION

PROMPT_VERSION = "proofbench-agent-v1"

SYSTEM_PROMPT = """\
You are proving one theorem in Lean 4 with Mathlib. You work in a sandbox with a shell, a file
editor, a Python interpreter and the Lean language server. The Lean toolchain, Mathlib and the
ProofBench statement library are installed, so you can compile at any time.

What counts as a solution
An independent check compiles your working file in a clean environment after every session. The
problem is solved when all of the following hold:
- the file compiles without errors;
- it contains no `sorry` or `admit`, anywhere;
- the main theorem depends only on the standard axioms (propext, Classical.choice, Quot.sound);
- the statement of the main theorem and every definition of the original file are unchanged.
  The check compares what the declarations compile to, so changing a `variable`, an `open`, a
  notation or an instance that alters their meaning counts as a change;
- the imports of the original file are all still there, and any import you add comes from
  {allowed_imports}.
You may add lemmas, definitions and proofs of your own to the file.

Not allowed in the file: `#eval`, `run_cmd`, `run_tac`, `elab`, `macro`, `syntax`, `initialize`,
`implemented_by`, `extern`, `unsafe` and `set_option maxHeartbeats` above {max_heartbeats} (the
file is rejected before compilation); `native_decide` and new `axiom`s (they fail the axiom check).

How the work is organised
You have at most {max_sessions} sessions. A session ends when you call `end_session`, or when
its output-token budget of {output_tokens} tokens is used up. The next session starts with a
fresh context: it sees only the working file as you left it, the compiler output for it, and
your handoff note. Nothing else you wrote or read is carried over.

So, throughout the session:
- keep the working file compiling. Put `sorry` where a proof is missing rather than leaving an
  error: a file with errors cannot be checked lemma by lemma;
- state intermediate results as separate lemmas, so that finished parts stay finished;
- keep the handoff note at `{handoff_path}` up to date. {handoff_format}

Call `end_session` when the file compiles with no `sorry` left, or when you want to stop early.
"""

SESSION_PROMPT = """\
Problem {problem_id}. Session {session} of {max_sessions}.

Main theorem: `{target}`
Working file: `{work_path}`
Handoff note: `{handoff_path}`

Current content of the working file:
```lean
{file_text}
```

{compiler_section}

{handoff_section}
"""

FIRST_SESSION_COMPILER = "This is the first session. The file compiles; its only gap is the `sorry` in the main theorem."
FIRST_SESSION_HANDOFF = "There is no handoff note yet."

LATER_COMPILER = """\
Result of the independent check at the end of the previous session: {verdict_line}
Lean compiler output for the working file:
```
{compiler_output}
```"""

LATER_HANDOFF = """\
Handoff note written in the previous session:
{handoff}"""

EMPTY_HANDOFF_NOTICE = "The previous session left no usable handoff note."

CONTINUE_PROMPT = "Continue working with the tools. Call `end_session` when you are done with this session."

BUDGET_WARNING = """\
You have used {used} of the {limit} output tokens of this session. Bring the working file to a
state that compiles (use `sorry` for what is unfinished) and update the handoff note now."""

SEARCH_ADDENDUM = """
Web search is enabled in this run. You may search the web and read what you find. Every query
and every address you fetch is recorded.
"""


def system_prompt(*, max_sessions: int, output_tokens: int | None, handoff_path: str, allowed_imports: str, max_heartbeats: int, web_search: bool) -> str:
    text = SYSTEM_PROMPT.format(
        max_sessions=max_sessions,
        output_tokens=f"{output_tokens:,}" if output_tokens else "unlimited",
        handoff_path=handoff_path,
        handoff_format=HANDOFF_FORMAT_DESCRIPTION,
        allowed_imports=allowed_imports,
        max_heartbeats=max_heartbeats,
    )
    return text + (SEARCH_ADDENDUM if web_search else "")


def session_prompt(*, problem_id: str, target: str, session: int, max_sessions: int, work_path: str, handoff_path: str, file_text: str, compiler_output: str | None, verdict_line: str | None, handoff_text: str | None) -> str:
    if session == 1:
        compiler_section = FIRST_SESSION_COMPILER
        handoff_section = FIRST_SESSION_HANDOFF
    else:
        compiler_section = LATER_COMPILER.format(verdict_line=verdict_line or "not solved", compiler_output=(compiler_output or "(no diagnostics)").strip())
        handoff_section = LATER_HANDOFF.format(handoff=handoff_text.strip()) if handoff_text else EMPTY_HANDOFF_NOTICE
    return SESSION_PROMPT.format(
        problem_id=problem_id,
        target=target,
        session=session,
        max_sessions=max_sessions,
        work_path=work_path,
        handoff_path=handoff_path,
        file_text=file_text.rstrip(),
        compiler_section=compiler_section,
        handoff_section=handoff_section,
    )
