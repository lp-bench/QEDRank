"""ProofBench evaluation task for Inspect AI.

Each sample is one challenge file `Pxxx.lean` whose single `sorry` the agent
must replace.  The agent works inside a sandbox that holds the ProofBench
statement layer (Mathlib plus `ProofBench.Mathlib_Problems`), with bash,
python, the Lean MCP tools, and optionally web search.  Grading is a fresh
Lean check performed by the scorer (see scorer.py): statement unchanged, no
`sorry`, standard axioms only.

Task parameters (pass with `-T name=value`):
  ids         problems to run, e.g. P083,P088,P090 (required)
  statements  path to the proofbench-statements clone (default proofbench-statements)
  sandbox     "docker" (default) or "local" (for Apptainer on HPC)
  network     whether the docker sandbox has internet (default True)
  search      give the agent a web_search tool (default False)
  search_provider  "tavily" or "exa" (one external provider for all models)
  lean_mcp    give the agent the lean-lsp-mcp tools (default True); the web-backed
              search tools are removed when network is False
  project_dir Lean project root inside the sandbox (default /opt/proofbench)
  tool_timeout seconds per bash/python call (default 600)
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.agent import AgentPrompt, react
from inspect_ai.dataset import Sample
from inspect_ai.tool import bash, mcp_server_sandbox, mcp_tools, python, text_editor, web_search

ROOT = Path(__file__).resolve().parent.parent

LEAN_MCP_OFFLINE_TOOLS = [
    "lean_build", "lean_code_actions", "lean_completions", "lean_declaration_file",
    "lean_diagnostic_messages", "lean_file_outline", "lean_goal", "lean_hover_info",
    "lean_local_search", "lean_minimal_hypotheses", "lean_multi_attempt",
    "lean_profile_proof", "lean_references", "lean_run_code", "lean_term_goal",
    "lean_verify", "lean_get_widgets", "lean_get_widget_source",
]  # excluded offline: lean_leansearch, lean_loogle, lean_leanfinder, lean_state_search, lean_hammer_premise
if str(ROOT) not in sys.path:  # Inspect loads this file by path, not as a package
    sys.path.insert(0, str(ROOT))
from proofbench_eval.scorer import lean_check  # noqa: E402

INSTRUCTIONS = """\
You are proving a theorem in Lean 4 with Mathlib.

The file `{submission}` states the theorem `{theorem}` with its proof
replaced by `sorry`.  Replace that `sorry` with a complete proof.

Rules, checked automatically after you submit:
1. The theorem statement, every definition in the file, and their order must
   stay exactly as given.  You may add helper lemmas and definitions above
   the main theorem, and you may add imports, but only `Mathlib.*`,
   `ProofBench.Mathlib_Problems.*`, `Matroid.*`, `Archive.Sensitivity` and
   the imports the file already has.
2. No `sorry`, no `axiom`, no `native_decide`.  The proof must depend only on
   the axioms `propext`, `Classical.choice` and `Quot.sound`.
3. Compile with:  cd {project_dir} && lake env lean {submission}
   For experiments you also have Python (sympy, networkx, python-sat),
   SageMath with GAP and nauty (`sage`, `gap`), and the SAT solver `cadical`.
   The Lean language-server tools (goal state, diagnostics, search) are
   available when present; the file path for them is `{submission_rel}`.

When the file compiles with the complete proof, call submit() with the
text "done".  If you cannot finish, submit "incomplete" so the attempt is
recorded.
"""


def qualified_theorem(text: str, pid: str) -> str:
    """`pid` prefixed by the namespaces open at its declaration."""
    stack: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^namespace\s+(\S+)", line)
        if m:
            stack.append(m.group(1))
        elif re.match(r"^end\s+\S+", line) and stack:
            stack.pop()
        elif re.match(rf"^\s*theorem\s+{pid}\b", line):
            return ".".join(stack + [pid])
    raise ValueError(f"{pid}: no `theorem {pid}` found")


def load_samples(statements: str, ids: str | list[str], project_dir: str) -> list[Sample]:
    root = Path(statements)
    if not root.is_absolute():  # Inspect runs tasks from the task file's directory
        root = ROOT / root
    pids = ids.replace(",", " ").split() if isinstance(ids, str) else [str(i) for i in ids]
    if not pids:
        raise ValueError("no problems selected; pass -T ids=P083,P088,P090")
    git = lambda *a: subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True).stdout.strip()
    if git("status", "--porcelain"):
        raise ValueError(f"{root} has uncommitted changes; a run must use a committed version")
    commit = git("rev-parse", "HEAD")
    pb_commit = (root / "SOURCE_COMMIT").read_text().strip() if (root / "SOURCE_COMMIT").exists() else ""
    db = {e["id"]: e for e in json.loads((root / "ProofBench/DATABASE/Database.json").read_text(encoding="utf-8"))}
    samples: list[Sample] = []
    for pid in pids:
        src = root / "ProofBench/PROBLEMS" / pid / f"{pid}.lean"
        reference = src.read_text(encoding="utf-8")
        if reference.count("sorry") != 1:
            raise ValueError(f"{pid}: expected exactly one sorry, found {reference.count('sorry')}")
        theorem = qualified_theorem(reference, pid)
        entry = db.get(pid[1:], {})
        submission_rel = f"Submission/{pid}.lean"
        submission = f"{project_dir}/{submission_rel}"
        samples.append(
            Sample(
                id=pid,
                input=INSTRUCTIONS.format(
                    submission=submission,
                    submission_rel=submission_rel,
                    theorem=theorem,
                    project_dir=project_dir,
                ),
                target=theorem,
                files={submission: str(src)},
                metadata={
                    "name": entry.get("name", ""),
                    "difficulty": entry.get("difficulty", ""),
                    "theorem": theorem,
                    "submission": submission,
                    "project_dir": project_dir,
                    "reference": reference,
                    "statements_commit": commit,
                    "proofbench_commit": pb_commit,
                },
            )
        )
    return samples


@task
def proofbench(
    ids: str = "",
    statements: str = "proofbench-statements",
    sandbox: str = "docker",
    network: bool = True,
    search: bool = False,
    search_provider: str = "tavily",
    lean_mcp: bool = True,
    project_dir: str = "/opt/proofbench",
    tool_timeout: int = 600,
) -> Task:
    tools = [bash(timeout=tool_timeout), python(timeout=tool_timeout), text_editor(timeout=tool_timeout)]
    if lean_mcp:
        server = mcp_server_sandbox(
            name="lean",
            command="lean-lsp-mcp",
            cwd=project_dir,
            env={"LEAN_PROJECT_PATH": project_dir},
        )
        # Without network the web-backed search tools only return errors; the
        # same subset is removed for every model.  Names as of lean-lsp-mcp 0.31.
        if network:
            tools.append(mcp_tools(server))
        else:
            tools.append(mcp_tools(server, tools=LEAN_MCP_OFFLINE_TOOLS))
    if search:
        tools.append(web_search(search_provider))

    if sandbox == "docker":
        compose = ROOT / "image" / ("compose.yaml" if network else "compose-offline.yaml")
        sandbox_spec = ("docker", str(compose))
    elif sandbox == "local":
        sandbox_spec = "local"
    else:
        raise ValueError(f"unknown sandbox {sandbox!r}; use docker or local")

    agent = react(
        prompt=AgentPrompt(
            instructions="You are an expert in Lean 4 and Mathlib. Work carefully: "
            "check goals and diagnostics after every edit, and compile before submitting."
        ),
        tools=tools,
        attempts=1,
    )

    return Task(
        dataset=load_samples(statements, ids, project_dir),
        solver=agent,
        scorer=lean_check(),
        sandbox=sandbox_spec,
        metadata={
            "search": search,
            "search_provider": search_provider if search else None,
            "network": network,
            "lean_mcp": lean_mcp,
            "ids": ids,
        },
    )
