"""Two-layer Lean grading in a fresh container.

Only the submission's source text leaves the agent's sandbox: the main file
and the files under `Submission/` it imports, transitively.  They are written
into the `verifier` sandbox, a second container from the same image that ran
nothing of the agent's, and graded there:

1. the fast check (image/check_proof.py, streamed over stdin): statement and
   definitions unchanged, allowed imports, no `sorry`/`axiom`/`native_decide`
   in any file, helper files build, main file compiles, standard axioms only;
2. if that passes, Comparator (leanprover/comparator), the Lean FRO's
   adversarial proof checker: it builds the trusted statement module and the
   submission module separately in a Landlock sandbox, requires identical
   statements and dependencies, replays the proof through the kernel and
   checks the axioms.  It runs as the unprivileged `verifier` user where the
   sandbox supports users (Docker); under Apptainer everything already runs as
   the invoking user.

A submission counts as correct only if both layers accept it.  Both reports
go to the score metadata.  The session loop (sessions.py) runs layer 1 alone
in the agent's sandbox after each session, only to decide whether to stop.

An open problem has two targets (see `targets`): the statement `Pxxx` and its
negation `Pxxx_disprove` in `Submission/Pxxx_DISPROVE.lean`, graded in that
order against their own reference files and Challenge modules.  The first
that both layers accept makes the sample correct.  The metadata holds the
report of that target, else of the one the agent edited; `polarity` says which
(`prove` or `disprove`), and `other` holds the report of the other target when
it was graded.
"""

import json
import re
from pathlib import Path
from typing import Any

from inspect_ai.scorer import CORRECT, INCORRECT, NOANSWER, Score, Target, accuracy, scorer, stderr
from inspect_ai.solver import TaskState
from inspect_ai.util import SandboxEnvironment, SandboxUserUnsupportedError, sandbox

CHECK_SCRIPT = (Path(__file__).resolve().parent.parent / "image" / "check_proof.py").read_text(
    encoding="utf-8"
)
PERMITTED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"]
COMPARATOR = "/opt/verifier/bin/comparator"
COMPARATOR_LIB = "/opt/verifier/lib"
SUBMISSION_IMPORT = re.compile(r"^import (Submission(?:\.[A-Za-z0-9_']+)+)\s*$", re.M)
MAX_FILES = 100


def module_path(module: str, project_dir: str) -> str:
    """`Submission.P110.Lemmas` -> `<project>/Submission/P110/Lemmas.lean`."""
    return f"{project_dir}/" + "/".join(module.split(".")) + ".lean"


def targets(md: dict[str, Any]) -> list[dict[str, Any]]:
    """The theorems that solve a sample, in grading order: the statement, then,
    for an open problem, its negation.  Each is the sample metadata with that
    file's submission, reference, theorem and sorry count."""
    out = [{**md, "polarity": "prove"}]
    if md.get("disprove"):
        out.append({**md, **md["disprove"], "polarity": "disprove"})
    return out


def edited(t: dict[str, Any], report: dict[str, Any]) -> bool:
    """Whether the agent changed the target's main file or gave it helper files."""
    text = report.get("submission_text", "")
    return bool(text) and (text.strip() != t["reference"].strip() or bool(report.get("submission_files")))


def pick(graded: list[dict[str, Any]]) -> dict[str, Any]:
    """The graded target to report ({target, layer1, ok, ...}): the first that
    passed, else the first the agent edited, else the first."""
    return next((g for g in graded if g["ok"]), None) or next(
        (g for g in graded if edited(g["target"], g["layer1"])), graded[0]
    )


def helper_modules(files: dict[str, str], md: dict[str, Any]) -> list[str]:
    """Module names of the helper files in `files` (main file excluded)."""
    prefix = md["project_dir"] + "/"
    return [p[len(prefix) : -len(".lean")].replace("/", ".") for p in files if p != md["submission"]]


async def collect_submission(sb: SandboxEnvironment, md: dict[str, Any]) -> dict[str, str]:
    """{absolute path: text} of the main file and the Submission files it imports,
    transitively.  Unreadable files are left out (the checker reports them)."""
    files: dict[str, str] = {}
    todo = [md["submission"]]
    while todo and len(files) < MAX_FILES:
        path = todo.pop()
        if path in files:
            continue
        try:
            text = await sb.read_file(path)
        except Exception:
            continue
        files[path] = text
        todo += [module_path(m, md["project_dir"]) for m in SUBMISSION_IMPORT.findall(text)]
    return files


async def check_submission(
    sb: SandboxEnvironment, md: dict[str, Any], files: dict[str, str] | None = None
) -> dict[str, Any]:
    """Layer 1 in sandbox `sb` for one target (see `targets`).  `files` (from
    collect_submission) are written there first when given; otherwise the files
    already in `sb` are checked."""
    stem = Path(md["submission"]).stem  # Pxxx, or Pxxx_DISPROVE
    ref_path = f"{md['project_dir']}/Submission/_reference_{stem}.lean"
    await sb.write_file(ref_path, md["reference"])
    if files is not None:
        for path, text in files.items():
            await sb.write_file(path, text)
    else:
        files = await collect_submission(sb, md)
    extra = {
        "submission_text": files.get(md["submission"], ""),
        "submission_files": {p: t for p, t in files.items() if p != md["submission"]},
    }
    if md["submission"] not in files:
        return {"ok": False, "errors": ["cannot read submission"], **extra}
    try:  # a timeout or oversized output is a failed verdict, not an infrastructure error
        result = await sb.exec(
            ["python3", "-", md["project_dir"], md["submission"], ref_path, md["theorem"],
             ",".join(md.get("permitted_axioms") or PERMITTED_AXIOMS)],
            input=CHECK_SCRIPT,
            timeout=1200,
        )
    except Exception as e:
        return {"ok": False, "errors": [f"checker did not finish: {type(e).__name__}: {str(e)[:200]}"], **extra}
    try:
        report = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        return {
            "ok": False,
            "errors": [f"checker failed: rc={result.returncode}\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}"],
            "checker_error": True,
            **extra,
        }
    return {**report, **extra}


async def run_comparator(sb: SandboxEnvironment, md: dict[str, Any], sample_id: Any) -> dict[str, Any]:
    """Layer 2 for one target: Comparator on the trusted statement module vs. the
    submission module (`Pxxx` or `Pxxx_DISPROVE`)."""
    pid = str(sample_id)
    stem = Path(md["submission"]).stem
    config = {
        "challenge_module": f"ProofBench.PROBLEMS.{pid}.{stem}",
        "solution_module": f"Submission.{stem}",
        "theorem_names": [md["theorem"]],
        "permitted_axioms": md.get("permitted_axioms") or PERMITTED_AXIOMS,
    }
    config_path = f"{md['project_dir']}/Submission/_comparator_{stem}.json"
    await sb.write_file(config_path, json.dumps(config))
    cmd = [
        "/bin/sh", "-c",
        f'cd "$1" && LD_LIBRARY_PATH={COMPARATOR_LIB} exec lake env {COMPARATOR} "$2"',
        "sh", md["project_dir"], config_path,
    ]
    try:
        try:
            result = await sb.exec(cmd, user="verifier", timeout=3600)
            ran_as = "verifier"
        except SandboxUserUnsupportedError:  # Apptainer: already the invoking, unprivileged user
            result = await sb.exec(cmd, timeout=3600)
            ran_as = "invoking user"
    except Exception as e:  # timeout etc.: rejected, as any non-zero exit
        return {"ok": False, "returncode": None, "ran_as": "", "config": config, "stdout": "",
                "stderr": f"comparator did not finish: {type(e).__name__}: {str(e)[:200]}"}
    return {
        "ok": result.success,
        "returncode": result.returncode,
        "ran_as": ran_as,
        "config": config,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def _verifier() -> SandboxEnvironment | None:
    try:
        return sandbox("verifier")
    except Exception:
        return None


def _explain(report: dict[str, Any], comparator: dict[str, Any] | None, use_comparator: bool, ok: bool) -> str:
    if not report["ok"]:
        return "; ".join(report["errors"])
    if not use_comparator:
        return "fast check passed (comparator off)"
    if not ok:
        return "fast check passed, comparator rejected: " + (
            (comparator or {}).get("stderr") or (comparator or {}).get("stdout") or ""
        )[-500:]
    return "fast check and comparator passed"


@scorer(metrics=[accuracy(), stderr()])
def lean_check():
    async def score(state: TaskState, target: Target) -> Score:
        md = state.metadata
        verifier = _verifier()
        sb = verifier or sandbox()
        use_comparator = md.get("comparator", True)
        graded: list[dict[str, Any]] = []
        for t in targets(md):
            files = await collect_submission(sandbox(), t)
            if t["submission"] in files:
                report = await check_submission(sb, t, files)
            else:
                report = {"ok": False, "errors": ["cannot read submission"]}
            comparator: dict[str, Any] | None = None
            if report["ok"] and use_comparator:
                comparator = await run_comparator(sb, t, state.sample_id)
            ok = report["ok"] and (not use_comparator or (comparator is not None and comparator["ok"]))
            graded.append({"target": t, "layer1": report, "comparator": comparator, "ok": ok,
                           "explanation": _explain(report, comparator, use_comparator, ok)})
            if ok:
                break
        main = pick(graded)
        if md.get("disprove"):
            explanation = " | ".join(f"{g['target']['polarity']}: {g['explanation']}" for g in graded)
        else:
            explanation = main["explanation"]
        sessions = state.store.get("sessions", [])
        abort = state.store.get("provider_abort")  # "provider" or "quota" when the chain was stopped
        metadata: dict[str, Any] = {
            **main["layer1"],
            "polarity": main["target"]["polarity"],
            "comparator": main["comparator"] if use_comparator else "off",
            "graded_in": "verifier" if verifier else "agent sandbox",
            "sessions_used": sum(1 for r in sessions if r.get("counted", True)),
            "provider_failures": sum(1 for r in sessions if not r.get("counted", True)),
            "provider_abort": abort,
            "infrastructure_error": bool(abort and not main["ok"]),
        }
        if md.get("disprove"):
            other = next((g for g in graded if g is not main), None)
            metadata["other"] = None if other is None else {
                **other["layer1"],
                "polarity": other["target"]["polarity"],
                "comparator": other["comparator"] if use_comparator else "off",
            }
        if metadata["infrastructure_error"]:
            # The provider, not the model, ended an unsolved chain: no verdict on the model
            # (NOANSWER; results.csv status N, left out of the rates; rerun the problem).
            reason = "the account's budget was used up" if abort == "quota" else "the provider kept failing"
            explanation = f"infrastructure: {reason} after {metadata['sessions_used']} session(s) | {explanation}"
        return Score(
            value=CORRECT if main["ok"] else NOANSWER if metadata["infrastructure_error"] else INCORRECT,
            answer=state.output.completion if state.output else None,
            explanation=explanation,
            metadata=metadata,
        )

    return score
