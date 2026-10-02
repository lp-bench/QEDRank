"""ProofBench evaluation task for Inspect AI.

Each sample is one challenge file `Pxxx.lean` whose single `sorry` the agent
must replace.  The agent works inside a sandbox that holds the ProofBench
statement layer (Mathlib plus `ProofBench.Mathlib_Problems`), with bash,
python, the Lean MCP tools, and optionally web search.  Grading is a fresh
Lean check performed by the scorer (see scorer.py): statement unchanged, no
`sorry`, standard axioms only.

Task parameters (pass with `-T name=value`):
  problems    path to the problems manifest written by scripts/export_problems.py
  sandbox     "docker" (default) or "local" (for Apptainer on HPC)
  network     whether the docker sandbox has internet (default True)
  search      give the agent a web_search tool (default False)
  search_provider  "tavily" or "exa" (one external provider for all models)
  lean_mcp    give the agent the lean-lsp-mcp tools (default True)
  project_dir Lean project root inside the sandbox (default /opt/proofbench)
  tool_timeout seconds per bash/python call (default 600)
"""

import json
import sys
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.agent import AgentPrompt, react
from inspect_ai.dataset import Sample
from inspect_ai.tool import bash, mcp_server_sandbox, mcp_tools, python, web_search

ROOT = Path(__file__).resolve().parent.parent
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
   the main theorem, and you may add imports, but only `Mathlib.*` and
   `ProofBench.Mathlib_Problems.*`.
2. No `sorry`, no `axiom`, no `native_decide`.  The proof must depend only on
   the axioms `propext`, `Classical.choice` and `Quot.sound`.
3. Compile with:  cd {project_dir} && lake env lean {submission}
   The Lean language-server tools (goal state, diagnostics, search) are
   available when present; the file path for them is `{submission_rel}`.

When the file compiles with the complete proof, call submit() with the
text "done".  If you cannot finish, submit "incomplete" so the attempt is
recorded.
"""


def load_samples(problems_file: str, project_dir: str) -> list[Sample]:
    path = Path(problems_file)
    if not path.is_absolute():  # Inspect runs tasks from the task file's directory
        path = ROOT / path
    spec = json.loads(path.read_text(encoding="utf-8"))
    samples: list[Sample] = []
    for p in spec["problems"]:
        src = (path.parent / p["file"]).resolve()
        submission_rel = f"Submission/{p['id']}.lean"
        submission = f"{project_dir}/{submission_rel}"
        samples.append(
            Sample(
                id=p["id"],
                input=INSTRUCTIONS.format(
                    submission=submission,
                    submission_rel=submission_rel,
                    theorem=p["theorem"],
                    project_dir=project_dir,
                ),
                target=p["theorem"],
                files={submission: str(src)},
                metadata={
                    "name": p.get("name", ""),
                    "difficulty": p.get("difficulty", ""),
                    "theorem": p["theorem"],
                    "submission": submission,
                    "project_dir": project_dir,
                    "reference": src.read_text(encoding="utf-8"),
                    "source_commit": spec.get("source_commit", ""),
                },
            )
        )
    return samples


@task
def proofbench(
    problems: str = "data/problems.json",
    sandbox: str = "docker",
    network: bool = True,
    search: bool = False,
    search_provider: str = "tavily",
    lean_mcp: bool = True,
    project_dir: str = "/opt/proofbench",
    tool_timeout: int = 600,
) -> Task:
    tools = [bash(timeout=tool_timeout), python(timeout=tool_timeout)]
    if lean_mcp:
        server = mcp_server_sandbox(
            name="lean",
            command="lean-lsp-mcp",
            cwd=project_dir,
            env={"LEAN_PROJECT_PATH": project_dir},
        )
        tools.append(mcp_tools(server))
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
        dataset=load_samples(problems, project_dir),
        solver=agent,
        scorer=lean_check(),
        sandbox=sandbox_spec,
        metadata={
            "search": search,
            "search_provider": search_provider if search else None,
            "network": network,
            "lean_mcp": lean_mcp,
            "problems": problems,
        },
    )
