"""The ProofBench agent task.

Offline configuration (no network in the sandbox; Lean search tools that call the web removed)::

    inspect eval harness/proofbench_harness/task.py@proofbench \\
        --model anthropic/claude-fable-5-1 --reasoning-effort high \\
        -T problems=/path/to/ProofBench -T max_sessions=4

Web-search configuration (one external search provider for every model; lookups recorded)::

    inspect eval harness/proofbench_harness/task.py@proofbench ... -T web_search=true

Independent restarts are Inspect epochs (``--epochs k``); they are reported separately from
continued sessions.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample

from .grader import QEDRankGrader
from .metadata import freeze_run_metadata
from .problems import load_problems
from .prompts import PROMPT_VERSION
from .scoring import lean_check
from .sessions import SessionLimits, session_chain
from .tools import LEAN_LSP_WEB_TOOLS, base_tools, lean_lsp_server

SANDBOX_DIR = Path(__file__).resolve().parents[1] / "sandbox"


def _list(value: str | list[str] | None) -> list[str] | None:
    if value is None:
        return None
    items = value if isinstance(value, list) else str(value).split(",")
    return [str(v).strip() for v in items if str(v).strip()] or None


@task
def proofbench(
    problems: str,
    ids: str | list[str] | None = None,
    limit_problems: int | None = None,
    include_open: bool = True,
    max_sessions: int = 4,
    session_output_tokens: int = 64_000,
    session_total_tokens: int | None = None,
    session_time_s: int | None = None,
    web_search: bool = False,
    search_provider: str = "tavily",
    lean_lsp: bool = True,
    sandbox_type: str = "docker",
    image: str = "proofbench-sandbox:latest",
    project_dir: str = "/workspace/ProofBench",
    grader: str = "docker",
    grader_lean_project: str | None = None,
    library_prefix: str = "ProofBench.Mathlib_Problems",
    allow_unused_sorry: bool = False,
    tool_timeout: int = 600,
) -> Task:
    """Prove each challenge in at most `max_sessions` fresh-context sessions.

    Args:
        problems: A ProofBench checkout (or its PROBLEMS folder), or a problems .jsonl/.json file.
        ids: Problem ids to run (comma-separated or a list); default all.
        limit_problems: Run only the first n problems.
        include_open: Also attempt problems labelled "Open". They are reported separately and a
            solve is escalated for review, never counted as an ordinary success.
        max_sessions: The x of the protocol. Suggested tiers: 1, 4 and 16.
        session_output_tokens: Output-token budget of one session, enforced by the harness.
        session_total_tokens: Safety limit on all tokens of one session; leave unset or set it
            high enough that it never binds.
        session_time_s: Safety limit on the wall-clock time of one session; same rule.
        web_search: Enable the search configuration. Off means no network in the sandbox.
        search_provider: The one external search provider every model uses ("tavily", "exa", "google").
        lean_lsp: Offer the Lean language server (lean-lsp-mcp) from inside the sandbox.
        sandbox_type: "docker" for real runs; "local" only for trying the harness without Docker.
        image: Sandbox image (see harness/sandbox/Dockerfile).
        project_dir: Root of the Lake project inside the sandbox.
        grader: "docker" (clean container of `image`, network off) or "local" (this machine).
        grader_lean_project: Lean project for local grading; default: the repository's lean/ folder.
        library_prefix: Module prefix of the public statement library (comma-separated for several).
        allow_unused_sorry: Accept a leftover `sorry` in a lemma the main theorem does not use.
        tool_timeout: Timeout in seconds of one shell or Python tool call.
    """
    selected = load_problems(problems, ids=_list(ids), limit=limit_problems, include_open=include_open)
    if not selected:
        raise ValueError(f"No problems selected from {problems}")
    docker = sandbox_type == "docker"
    network = bool(web_search)
    work_path_template = f"{project_dir.rstrip('/')}/ProofBench/PROBLEMS/{{id}}/{{id}}.lean" if docker else "PROBLEMS/{id}/{id}.lean"

    check = QEDRankGrader(
        mode=grader,
        lean_project=grader_lean_project,
        image=image if grader == "docker" else None,
        image_lean_project=project_dir,
        library_prefixes=_list(library_prefix) or ["ProofBench.Mathlib_Problems"],
        allow_extra_imports=web_search,
        allow_unused_sorry=allow_unused_sorry,
    )
    limits = SessionLimits(output_tokens=session_output_tokens, total_tokens=session_total_tokens, time_s=session_time_s)

    tools: list[Any] = list(base_tools(tool_timeout=tool_timeout, web=web_search, search_provider=search_provider))
    if lean_lsp and docker:
        tools.append(lean_lsp_server(project_dir))
    # Network off: the Lean search tools that call a web service are removed, not merely failing.
    exclude = () if web_search else LEAN_LSP_WEB_TOOLS

    if docker:
        os.environ.setdefault("PROOFBENCH_IMAGE", image)
        compose = SANDBOX_DIR / ("compose.search.yaml" if web_search else "compose.offline.yaml")
        sandbox_spec: Any = ("docker", str(compose))
    else:
        sandbox_spec = sandbox_type

    dataset = MemoryDataset(
        [
            Sample(
                id=p.id,
                input=f"Prove the theorem `{p.target}` in the working file of problem {p.id}.",
                target="solved",
                metadata=p.metadata(),
            )
            for p in selected
        ],
        name="proofbench",
    )
    meta = freeze_run_metadata(
        problems=problems,
        image=image,
        sandbox_type=sandbox_type,
        web_search=web_search,
        network=network,
        grader=check.describe(),
        limits={"session_output_tokens": session_output_tokens, "session_total_tokens": session_total_tokens, "session_time_s": session_time_s},
        max_sessions=max_sessions,
        tools=["bash", "python", "text_editor", "end_session", *(["web_search", "web_fetch"] if web_search else []), *(["lean-lsp-mcp"] if lean_lsp and docker else [])],
        prompt_version=PROMPT_VERSION,
    )
    return Task(
        dataset=dataset,
        solver=session_chain(
            grader=check,
            tools=tools,
            max_sessions=max_sessions,
            limits=limits,
            work_path_template=work_path_template,
            exclude_tools=exclude,
            web_search=web_search,
            network=network,
            allowed_imports="any library you install" if web_search else "Mathlib or the ProofBench statement library (ProofBench.Mathlib_Problems)",
            proxy_service="proxy" if (docker and web_search) else None,
        ),
        scorer=lean_check(check, work_path_template=work_path_template),
        sandbox=sandbox_spec,
        # Sample-level safety nets, sized so that the per-session limits are what binds.
        time_limit=int(max_sessions * session_time_s * 1.25) if session_time_s else None,
        token_limit=int(max_sessions * session_total_tokens * 1.25) if session_total_tokens else None,
        # One provider or grader failure must not discard the rest of an expensive run.
        fail_on_error=False,
        metadata=meta,
        version=1,
    )
