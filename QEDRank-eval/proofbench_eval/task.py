"""ProofBench evaluation task for Inspect AI.

Each sample is one challenge file `Pxxx.lean` whose `sorry` (rarely several)
the agent must replace; it may add helper files under `Submission/`.  For an
open problem the agent may instead prove the negation stated in
`Pxxx_DISPROVE.lean`: either proof solves the sample.  The agent works inside
a sandbox that holds the ProofBench statement layer (Mathlib plus
`ProofBench.Mathlib_Problems`), with bash, python, the Lean MCP tools, and
optionally web search.  Grading is a fresh Lean check performed by the scorer
(see scorer.py): statement unchanged, no `sorry`, standard axioms only.

Task parameters (pass with `-T name=value`):
  ids         problems to run, e.g. P083,P088,P090 (required)
  statements  path to the clone of the proofbench repo (default proofbench)
  sandbox     "apptainer" (default; the inspect-apptainer package, installed by scripts/setup.sh) or "docker"
  sif         the .sif image for the apptainer sandbox (default proofbench-sandbox.sif)
  network     whether the docker sandbox has internet (default True)
  search      give the agent a web_search tool (default False)
  search_provider  "anthropic": Claude's built-in search, basic version (search.py), or
              "tavily": plain results, no AI-written answer, for models without one
  lean_mcp    give the agent the lean-lsp-mcp tools (default True); the web-backed
              search tools are removed when network is False
  project_dir Lean project root inside the sandbox (default /opt/proofbench)
  tool_timeout seconds per bash/python call (default 600)
  sessions    fresh sessions per problem, chained by handoff notes (default 4)
  session_output_tokens  output tokens per session, reasoning included (default 120000)
  session_tokens         safety cap: total tokens per session (default 40000000)
  session_working_time   safety cap: working seconds per session (default 5400)
  note_tokens  output tokens for writing a handoff note (default 32000)
  comparator  run Comparator as the second grading layer (default True)
  provider_retries  how often a session that ended in a provider error (rate limit, 5xx,
              connection) is started again without consuming a session (default 2); when
              they are used up, or the account's budget is used up, an unsolved problem is
              scored NOANSWER (infrastructure), not INCORRECT
  provider_backoff  seconds to wait before such a retry, times the retry count (default 30)
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.tool import bash, mcp_server_sandbox, mcp_tools, python, text_editor
from inspect_ai.tool import web_search as builtin_web_search

ROOT = Path(__file__).resolve().parent.parent

LEAN_MCP_OFFLINE_TOOLS = [
    "lean_build", "lean_code_actions", "lean_completions", "lean_declaration_file",
    "lean_diagnostic_messages", "lean_file_outline", "lean_goal", "lean_hover_info",
    "lean_local_search", "lean_minimal_hypotheses", "lean_multi_attempt",
    "lean_profile_proof", "lean_references", "lean_run_code", "lean_term_goal",
    "lean_verify", "lean_get_widgets", "lean_get_widget_source",
]  # excluded offline: lean_leansearch, lean_loogle, lean_leanfinder, lean_state_search, lean_hammer_premise
IMAGE_PATH = "/opt/elan/bin:/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"  # as in image/Dockerfile
if str(ROOT) not in sys.path:  # Inspect loads this file by path, not as a package
    sys.path.insert(0, str(ROOT))
from proofbench_eval.scorer import lean_check  # noqa: E402
from proofbench_eval.search import basic_anthropic_search, web_search  # noqa: E402
from proofbench_eval.sessions import handoff_sessions  # noqa: E402

INSTRUCTIONS = """\
You are proving a theorem in Lean 4 with Mathlib.

The file `{submission}` states the theorem `{theorem}` with its proof
replaced by `sorry`.  Replace every `sorry` in it with a complete proof.
{open_problem}
Rules, checked automatically after you submit:
1. The theorem statement, every definition in the file, and their order must
   stay exactly as given.  You may add helper lemmas and definitions above
   the main theorem, and you may add imports, but only `Mathlib.*`,
   `ProofBench.Mathlib_Problems.*`, `Matroid.*`, `Archive.Sensitivity`, the
   imports the file already has, and your own files under `Submission/`.
2. No `sorry`, no `axiom`, no `native_decide`.  The proof must depend only on
   the axioms `propext`, `Classical.choice` and `Quot.sound`.  Do not try Lean
   loopholes (meta code, `initialize`, `#` commands, new notation or macros,
   options that skip kernel checks): the verifier replays the proof through
   the kernel and rejects them.
3. Organise the work as in any Lean project.  For a larger proof, put helper
   lemmas and definitions in files under `Submission/{pid}/`:
   `Submission/{pid}/Name.lean` is the module `Submission.{pid}.Name`, imported
   with `import Submission.{pid}.Name`.  Rules 1 and 2 apply to every file; the
   main theorem stays in `{submission}`.  Files the main file does not import,
   directly or indirectly, are ignored.
4. Compile with:  cd {project_dir} && lake build Submission.{pid}
   (a file without helper files also compiles with `lake env lean {submission}`).
   For experiments you also have Python (sympy, networkx, python-sat),
   SageMath with GAP and nauty (`sage`, `gap`), and the SAT solver `cadical`.
   The Lean language-server tools (goal state, diagnostics, search) are
   available when present; the file path for them is `{submission_rel}`.
"""

# Added to INSTRUCTIONS for an open problem, which has a Pxxx_DISPROVE.lean.
OPEN_PROBLEM = """
This is an open problem: it is not known whether `{theorem}` is true.  The
file `{dis_submission}` states its negation, the theorem `{dis_theorem}`, with
its proof replaced by `sorry` as well.  A complete proof of either theorem
solves the problem, so work on the one you believe is true; you may switch.
The rules below apply to both files.  The proof of `{dis_theorem}` stays in
`{dis_submission}`; compile it with
`cd {project_dir} && lake build Submission.{pid}_DISPROVE`; its path for the
language-server tools is `{dis_submission_rel}`.
"""


def strip_comments(text: str) -> str:
    text = re.sub(r"/-.*?-/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def qualified_theorem(text: str, pid: str) -> str:
    """`pid` prefixed by the namespaces open at its declaration.

    Namespaces, sections and `mutual` blocks share one stack, as in Lean: `end`
    (named or bare) closes the innermost of them, so a section that ends before
    the theorem does not close its enclosing namespace (P039, P105, P106 and
    P108 open a section inside their namespace).  Comments are ignored.
    Ported from the QEDRank fork (Vaibhav Bajpai).
    """
    stack: list[tuple[str, str]] = []  # (kind, name)
    for line in strip_comments(text).splitlines():
        m = re.match(r"^\s*(?:noncomputable\s+)?(namespace|section|mutual)\b\s*(\S*)", line)
        if m:
            stack.append((m.group(1), m.group(2)))
        elif re.match(r"^\s*end\b", line) and stack:
            stack.pop()
        elif re.match(rf"^\s*theorem\s+{pid}\b", line):
            return ".".join([name for kind, name in stack if kind == "namespace"] + [pid])
    raise ValueError(f"{pid}: no `theorem {pid}` found")


def load_samples(
    statements: str, ids: str | list[str], project_dir: str, comparator: bool = True
) -> list[Sample]:
    root = Path(statements)
    if not root.is_absolute():  # Inspect runs tasks from the task file's directory
        root = ROOT / root
    pids = ids.replace(",", " ").split() if isinstance(ids, str) else [str(i) for i in ids]
    if not pids:
        raise ValueError("no problems selected; pass -T ids=P083,P088,P090")
    git = lambda *a: subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True).stdout.strip()
    if git("status", "--porcelain", "--untracked-files=no"):  # untracked files are never read
        raise ValueError(f"{root} has uncommitted changes; a run must use a committed version")
    commit = git("rev-parse", "HEAD")
    pb_commit = (root / "SOURCE_COMMIT").read_text().strip() if (root / "SOURCE_COMMIT").exists() else ""
    db = {e["id"]: e for e in json.loads((root / "ProofBench/DATABASE/Database.json").read_text(encoding="utf-8"))}
    samples: list[Sample] = []
    for pid in pids:
        src = root / "ProofBench/PROBLEMS" / pid / f"{pid}.lean"
        reference = src.read_text(encoding="utf-8")
        n_sorry = len(re.findall(r"\bsorry\b", strip_comments(reference)))
        if n_sorry == 0:
            raise ValueError(f"{pid}: the statement file has no sorry to replace")
        theorem = qualified_theorem(reference, pid)
        entry = db.get(pid[1:], {})
        submission_rel = f"Submission/{pid}.lean"
        submission = f"{project_dir}/{submission_rel}"
        files = {submission: str(src)}
        # An open problem also counts as solved by a proof of its negation.
        disprove: dict | None = None
        open_problem = ""
        dis_src = src.with_name(f"{pid}_DISPROVE.lean")
        if dis_src.exists():
            dis_reference = dis_src.read_text(encoding="utf-8")
            dis_sorries = len(re.findall(r"\bsorry\b", strip_comments(dis_reference)))
            if dis_sorries == 0:
                raise ValueError(f"{pid}: the DISPROVE file has no sorry to replace")
            dis_rel = f"Submission/{pid}_DISPROVE.lean"
            disprove = {
                "theorem": qualified_theorem(dis_reference, f"{pid}_disprove"),
                "submission": f"{project_dir}/{dis_rel}",
                "reference": dis_reference,
                "sorries": dis_sorries,
            }
            files[disprove["submission"]] = str(dis_src)
            open_problem = OPEN_PROBLEM.format(
                theorem=theorem,
                dis_theorem=disprove["theorem"],
                dis_submission=disprove["submission"],
                dis_submission_rel=dis_rel,
                project_dir=project_dir,
                pid=pid,
            )
        samples.append(
            Sample(
                id=pid,
                input=INSTRUCTIONS.format(
                    pid=pid,
                    submission=submission,
                    submission_rel=submission_rel,
                    theorem=theorem,
                    project_dir=project_dir,
                    open_problem=open_problem,
                ),
                target=theorem,
                files=files,
                metadata={
                    "name": entry.get("name", ""),
                    "difficulty": entry.get("difficulty", ""),
                    "theorem": theorem,
                    "submission": submission,
                    "project_dir": project_dir,
                    "reference": reference,
                    "sorries": n_sorry,
                    "disprove": disprove,
                    "statements_commit": commit,
                    "proofbench_commit": pb_commit,
                    "comparator": comparator,
                },
            )
        )
    return samples


@task
def proofbench(
    ids: str = "",
    statements: str = "proofbench",
    sandbox: str = "apptainer",
    sif: str = "proofbench-sandbox.sif",
    network: bool = True,
    search: bool = False,
    search_provider: str = "tavily",
    lean_mcp: bool = True,
    project_dir: str = "/opt/proofbench",
    tool_timeout: int = 600,
    sessions: int = 4,
    session_output_tokens: int = 120_000,
    session_tokens: int = 40_000_000,
    session_working_time: int = 5400,
    note_tokens: int = 32_000,
    comparator: bool = True,
    provider_retries: int = 2,
    provider_backoff: float = 30.0,
) -> Task:
    tools = [bash(timeout=tool_timeout), python(timeout=tool_timeout), text_editor(timeout=tool_timeout)]
    if lean_mcp:
        # The server gets only this environment (nothing is inherited from the
        # image), so it needs the image's PATH and ELAN_HOME to find lake.
        server = mcp_server_sandbox(
            name="lean",
            command="lean-lsp-mcp",
            cwd=project_dir,
            env={"LEAN_PROJECT_PATH": project_dir, "PATH": IMAGE_PATH, "ELAN_HOME": "/opt/elan",
                 "HOME": "/root" if sandbox == "docker" else "/tmp"},
        )
        # Without network the web-backed search tools only return errors; the
        # same subset is removed for every model.  Names as of lean-lsp-mcp 0.31.
        if network:
            tools.append(mcp_tools(server))
        else:
            tools.append(mcp_tools(server, tools=LEAN_MCP_OFFLINE_TOOLS))
    if search:
        if search_provider == "anthropic":
            basic_anthropic_search()
            tools.append(builtin_web_search(["anthropic"]))
        elif search_provider == "tavily":
            tools.append(web_search())
        else:
            raise ValueError(f"unknown search provider {search_provider!r}; anthropic or tavily (see search.py)")

    if sandbox == "docker":
        compose = ROOT / "image" / ("compose.yaml" if network else "compose-offline.yaml")
        sandbox_spec = ("docker", str(compose))
    elif sandbox == "apptainer":
        from inspect_apptainer import ApptainerSandboxConfig  # registers the sandbox type

        sif_path = Path(sif) if Path(sif).is_absolute() else ROOT / sif
        sandbox_spec = (
            "apptainer",
            ApptainerSandboxConfig(
                image=str(sif_path),
                network="host" if network else "none",
                # the image is read-only and the agent is not root: give it scratch
                # space where it needs to write
                writable=["/tmp", "/var/tmp", f"{project_dir}/Submission"],
                workdir=project_dir,
                # second, always-offline instance where the scorer grades
                services={"verifier": {"network": "none"}},
            ),
        )
    else:
        raise ValueError(f"unknown sandbox {sandbox!r}; use docker or apptainer")

    solver = handoff_sessions(
        tools,
        sessions=sessions,
        output_tokens=session_output_tokens,
        total_tokens=session_tokens,
        working_seconds=session_working_time,
        note_tokens=note_tokens,
        provider_retries=provider_retries,
        provider_backoff=provider_backoff,
    )

    return Task(
        dataset=load_samples(statements, ids, project_dir, comparator),
        solver=solver,
        scorer=lean_check(),
        sandbox=sandbox_spec,
        metadata={
            "search": search,
            "search_provider": search_provider if search else None,
            "network": network,
            "lean_mcp": lean_mcp,
            "sandbox_type": sandbox,
            "ids": ids,
            "sessions": sessions,
            "session_output_tokens": session_output_tokens,
            "session_tokens": session_tokens,
            "session_working_time": session_working_time,
            "note_tokens": note_tokens,
            "comparator": comparator,
            "provider_retries": provider_retries,
            "provider_backoff": provider_backoff,
        },
    )
