"""Independent check of a submitted Lean proof.  Runs inside the sandbox.

usage: python3 check_proof.py PROJECT_DIR SUBMISSION REFERENCE THEOREM [AXIOMS]
(AXIOMS: the permitted axioms, comma-separated; default propext, Classical.choice, Quot.sound)
The submission may import further files under Submission/ (module
Submission.X.Y is Submission/X/Y.lean); they are checked and built too.
Prints one JSON line: {ok, errors, files, lines, nonblank_lines, proof_lines,
axioms, compile_seconds}.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

# Imports a submission may add; any import of the reference file (e.g. another
# challenge statement) may also stay.
ALLOWED_IMPORT = re.compile(
    r"^import (Mathlib(\.\S+)?|ProofBench\.Mathlib_Problems\.\S+|Matroid(\.\S+)?|Archive\.Sensitivity|Submission\.\S+)\s*$"
)
SUBMISSION_IMPORT = re.compile(r"^import (Submission(?:\.[A-Za-z0-9_']+)+)\s*$", re.M)
ALLOWED_AXIOMS = {"propext", "Classical.choice", "Quot.sound"}
# Anywhere in any file.  Beyond sorry/axiom/native_decide: meta-level ways to
# add declarations without the kernel or to fake compiler output.  Comparator
# (layer 2) catches all of these by kernel replay; these guards matter when it
# is off.
FORBIDDEN = [
    (re.compile(r"\bsorry\b"), "contains sorry"),
    (re.compile(r"^\s*axiom\b", re.M), "declares an axiom"),
    (re.compile(r"\bnative_decide\b"), "uses native_decide"),
    (re.compile(r"\bimplemented_by\b|\bextern\b"), "uses implemented_by/extern"),
    (re.compile(r"\bskipKernelTC\b|\bofReduceBool\b|\bofReduceNat\b|\baddDecl\b"), "bypasses the kernel"),
    # elaboration-time code execution (IO is reachable from elaborators)
    (re.compile(r"^\s*(?:builtin_)?initialize\b|\brun_(?:cmd|tac|elab)\b|^\s*(?:(?:local|scoped)\s+)?elab(?:_rules)?\b", re.M),
     "runs code at elaboration time (initialize, run_cmd/run_tac/run_elab, elab)"),
    (re.compile(r"(?:^|\s)#(?:eval!?|guard|guard_expr|test|exit|print|time|html|widget)\b", re.M), "uses a # command"),
]
# Commands that can silently change what existing text means (rules for
# existing syntax are tried first; export aliases names): never in helper
# files, never among the lines added before the main theorem.  New notation,
# `macro`, `syntax`, `open`, `variable`, `set_option` are allowed: a clash with
# existing syntax or names makes Lean report an ambiguity rather than pick the
# new reading, and Comparator compares the elaborated statement anyway.
GLOBAL_SYNTAX = re.compile(r"^\s*(?:macro_rules|export|unif_hint)\b")
# Scoped to the enclosing section: fine in helper files (file-local), and
# before the main theorem only inside a section closed before it.
SCOPED_SYNTAX = re.compile(r"^\s*(?:local|scoped)\s+(?:macro_rules|unif_hint)\b|^\s*include\b")
OPENS = re.compile(r"^\s*(?:noncomputable\s+)?(?:section|namespace)\b")
CLOSES = re.compile(r"^\s*end\b")
MAX_FILES = 100


def norm(line: str) -> str:
    return " ".join(line.split())


def signature_end(lines: list[str], i: int) -> tuple[int, int, str] | None:
    """(line j, column, signature text) of the first `:=` at bracket depth 0 from line i on:
    the one that ends the theorem's signature.  A `:=` inside brackets, such as a named
    argument `(F := F)`, is skipped.  Ported from the QEDRank fork (Vaibhav Bajpai)."""
    depth = 0
    text: list[str] = []
    for j in range(i, len(lines)):
        l = lines[j]
        for k, c in enumerate(l):
            if c in "([{⟨":
                depth += 1
            elif c in ")]}⟩":
                depth = max(0, depth - 1)
            elif depth == 0 and l.startswith(":=", k):
                return j, k, " ".join(text + [l[:k]])
        text.append(l)
    return None


def statement_span(lines: list[str], short: str) -> tuple[int, int] | None:
    """Line range [i, j] of `theorem short ... :=` (j is the line holding the signature's `:=`)."""
    pat = re.compile(rf"^\s*(theorem|lemma)\s+{re.escape(short)}\b")
    for i, l in enumerate(lines):
        if pat.match(l):
            end = signature_end(lines, i)
            return (i, end[0]) if end else None
    return None


def strip_comments(text: str) -> str:
    text = re.sub(r"/-.*?-/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def closure(project: Path, main: Path) -> tuple[dict[Path, str], list[str]]:
    """The main file and every Submission file it imports, transitively."""
    files: dict[Path, str] = {}
    missing: list[str] = []
    todo = [main]
    while todo and len(files) < MAX_FILES:
        f = todo.pop()
        if f in files:
            continue
        try:
            files[f] = f.read_text(encoding="utf-8")
        except OSError:
            missing.append(str(f))
            continue
        todo += [project / Path(*m.split(".")).with_suffix(".lean") for m in SUBMISSION_IMPORT.findall(files[f])]
    return files, missing


def main() -> None:
    project, submission, reference, theorem = sys.argv[1:5]
    # The problem's permitted axioms (comma-separated); the standard three by default.
    allowed = set(sys.argv[5].split(",")) if len(sys.argv) > 5 and sys.argv[5] else ALLOWED_AXIOMS
    project_p, main_p = Path(project), Path(submission)
    short = theorem.split(".")[-1]
    errors: list[str] = []
    files, missing = closure(project_p, main_p)
    if main_p not in files:
        print(json.dumps({"ok": False, "errors": ["cannot read submission"], "files": [], "lines": 0,
                          "nonblank_lines": 0, "proof_lines": 0, "axioms": [], "compile_seconds": None}))
        return
    rel = lambda f: str(f.relative_to(project_p)) if f.is_relative_to(project_p) else str(f)
    helpers = [".".join(f.relative_to(project_p).with_suffix("").parts) for f in files if f != main_p]
    sub_text = files[main_p]
    ref_text = Path(reference).read_text(encoding="utf-8")
    sub_lines, ref_lines = sub_text.splitlines(), ref_text.splitlines()

    # 1. imports (every file)
    ref_imports = {norm(l) for l in ref_lines if l.startswith("import")}
    for f, text in files.items():
        for l in text.splitlines():
            if l.startswith("import") and not ALLOWED_IMPORT.match(l) and norm(l) not in ref_imports:
                errors.append(f"disallowed import in {rel(f)}: {l.strip()}")
    errors += [f"imported file not found: {m}" for m in missing]

    # 2. forbidden constructs (comments stripped so a mention in a comment is fine)
    code = strip_comments(sub_text)
    for f, text in files.items():
        stripped = strip_comments(text)
        for rx, msg in FORBIDDEN:
            if rx.search(stripped):
                errors.append(msg if f == main_p else f"{msg} ({rel(f)})")
        if f != main_p:
            for l in stripped.splitlines():
                if GLOBAL_SYNTAX.match(l):
                    errors.append(f"syntax/notation command in helper file {rel(f)}: {l.strip()[:60]}")

    # 3. statement and definitions unchanged: with comments stripped, every
    #    non-empty reference line up to the signature's `:=` of the main theorem must appear,
    #    in order, in the submission, and the statement itself verbatim.
    ref_code, sub_code = strip_comments(ref_text).splitlines(), code.splitlines()
    rspan = statement_span(ref_code, short)
    sspan = statement_span(sub_code, short)
    proof_lines = 0
    if rspan is None:
        errors.append("reference has no main theorem (export problem)")
    elif sspan is None:
        errors.append(f"submission no longer states theorem {short}")
    else:
        ref_stmt = norm(signature_end(ref_code, rspan[0])[2])
        sub_end = signature_end(sub_code, sspan[0])
        sub_stmt = norm(sub_end[2])
        if ref_stmt != sub_stmt:
            errors.append("theorem statement altered")
        needed = [norm(l) for l in ref_code[: rspan[0]] if norm(l) and not l.startswith("import")]
        have = [norm(l) for l in sub_code[: sspan[0]]]
        depth, after = 0, []  # section/namespace depth after each line
        for h in have:
            depth = depth + 1 if OPENS.match(h) else max(0, depth - 1) if CLOSES.match(h) else depth
            after.append(depth)
        k = 0
        for t, h in enumerate(have):
            if k < len(needed) and h == needed[k]:
                k += 1
            elif GLOBAL_SYNTAX.match(h):
                errors.append(f"line added before the theorem changes its syntax: {h[:60]!r}")
            elif SCOPED_SYNTAX.match(h):
                d = after[t - 1] if t else 0
                if not (d > 0 and min(after[t:]) < d):  # its section is not closed before the theorem
                    errors.append(f"line added before the theorem changes it: {h[:60]!r}")
        if k < len(needed):
            errors.append(f"reference line missing or altered before the theorem: {needed[k]!r}")
        after = sub_code[sspan[1]][sub_end[1] + 2 :].strip()
        proof_lines = sum(1 for l in sub_code[sspan[1] + 1 :] if l.strip()) + (1 if after not in ("", "by") else 0)
        if proof_lines == 0:
            errors.append("no proof after the statement")

    # 4. compile (helper modules first, through lake) and 5. axioms
    axioms: list[str] = []
    compile_seconds = None
    if not errors:
        t0 = time.time()
        out, rc = "", 0
        if helpers:
            try:
                b = subprocess.run(["lake", "build", *helpers], cwd=project, capture_output=True, text=True, timeout=900)
                out, rc = b.stdout + b.stderr, b.returncode
            except subprocess.TimeoutExpired:
                out, rc = "build timeout", 1
        if rc != 0:
            errors.append("helper build error: " + out.strip()[-1500:])
        else:
            tmp = project_p / "Submission" / f"_check_{short}.lean"
            tmp.write_text(sub_text.rstrip("\n") + f"\n\n#print axioms {theorem}\n", encoding="utf-8")
            try:
                r = subprocess.run(
                    ["lake", "env", "lean", str(tmp)], cwd=project, capture_output=True, text=True, timeout=900
                )
                out = r.stdout + r.stderr
            except subprocess.TimeoutExpired:
                r, out = None, "compile timeout"
            tmp.unlink(missing_ok=True)
            if r is None or r.returncode != 0 or re.search(r"^.*: error:", out, re.M):
                errors.append("compile error: " + out.strip()[-1500:])
            if "declaration uses 'sorry'" in out or "declaration uses `sorry`" in out:
                errors.append("declaration uses sorry")
            # The last report for our theorem: `#print axioms` is the file's last
            # command, so nothing in the submission can print after it.
            found = re.findall(rf"^'{re.escape(theorem)}' depends on axioms: \[(.*?)\]", out, re.M)
            if found:
                axioms = [a.strip() for a in found[-1].split(",") if a.strip()]
            elif r is not None and f"'{theorem}' does not depend on any axioms" not in out and not errors:
                errors.append("could not read axioms")
            bad = sorted(set(axioms) - allowed)
            if bad:
                errors.append(("non-standard axioms: " if allowed == ALLOWED_AXIOMS
                               else "axioms not permitted for this problem: ") + ", ".join(bad))
        compile_seconds = round(time.time() - t0, 1)
        # Build products made here (as root under Docker) must stay usable by the
        # unprivileged verifier user that runs Comparator next.
        for d in ("Submission", ".lake/build/lib/lean/Submission", ".lake/build/ir/Submission"):
            if (project_p / d).exists():
                subprocess.run(["chmod", "-R", "a+rwX", str(project_p / d)], check=False, capture_output=True)

    print(json.dumps({
        "ok": not errors,
        "errors": errors,
        "files": [rel(f) for f in files],
        "lines": sum(len(t.splitlines()) for t in files.values()),
        "nonblank_lines": sum(1 for t in files.values() for l in t.splitlines() if l.strip()),
        "proof_lines": proof_lines,
        "axioms": axioms,
        "compile_seconds": compile_seconds,
    }))


if __name__ == "__main__":
    main()
