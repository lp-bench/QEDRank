"""Independent check of a submitted Lean proof.  Runs inside the sandbox.

usage: python3 check_proof.py PROJECT_DIR SUBMISSION REFERENCE THEOREM
Prints one JSON line: {ok, errors, lines, nonblank_lines, proof_lines,
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
    r"^import (Mathlib(\.\S+)?|ProofBench\.Mathlib_Problems\.\S+|Matroid(\.\S+)?|Archive\.Sensitivity)\s*$"
)
ALLOWED_AXIOMS = {"propext", "Classical.choice", "Quot.sound"}
FORBIDDEN = [
    (re.compile(r"\bsorry\b"), "contains sorry"),
    (re.compile(r"^\s*axiom\b", re.M), "declares an axiom"),
    (re.compile(r"\bnative_decide\b"), "uses native_decide"),
    (re.compile(r"\bimplemented_by\b|\bextern\b"), "uses implemented_by/extern"),
]


def norm(line: str) -> str:
    return " ".join(line.split())


def statement_span(lines: list[str], short: str) -> tuple[int, int] | None:
    """Line range [i, j] of `theorem short ... :=` (j is the line holding `:=`)."""
    pat = re.compile(rf"^\s*(theorem|lemma)\s+{re.escape(short)}\b")
    for i, l in enumerate(lines):
        if pat.match(l):
            for j in range(i, len(lines)):
                if ":=" in lines[j]:
                    return i, j
            return None
    return None


def strip_comments(text: str) -> str:
    text = re.sub(r"/-.*?-/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def main() -> None:
    project, submission, reference, theorem = sys.argv[1:5]
    short = theorem.split(".")[-1]
    errors: list[str] = []
    sub_text = Path(submission).read_text(encoding="utf-8")
    ref_text = Path(reference).read_text(encoding="utf-8")
    sub_lines, ref_lines = sub_text.splitlines(), ref_text.splitlines()

    # 1. imports
    ref_imports = {norm(l) for l in ref_lines if l.startswith("import")}
    for l in sub_lines:
        if l.startswith("import") and not ALLOWED_IMPORT.match(l) and norm(l) not in ref_imports:
            errors.append(f"disallowed import: {l.strip()}")

    # 2. forbidden constructs (comments stripped so a mention in a comment is fine)
    code = strip_comments(sub_text)
    for rx, msg in FORBIDDEN:
        if rx.search(code):
            errors.append(msg)

    # 3. statement and definitions unchanged: with comments stripped, every
    #    non-empty reference line up to the `:=` of the main theorem must appear,
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
        ref_stmt = norm(" ".join(ref_code[rspan[0] : rspan[1] + 1]).split(":=")[0])
        sub_stmt = norm(" ".join(sub_code[sspan[0] : sspan[1] + 1]).split(":=")[0])
        if ref_stmt != sub_stmt:
            errors.append("theorem statement altered")
        needed = [norm(l) for l in ref_code[: rspan[0]] if norm(l) and not l.startswith("import")]
        have = [norm(l) for l in sub_code[: sspan[0]]]
        k = 0
        for h in have:
            if k < len(needed) and h == needed[k]:
                k += 1
        if k < len(needed):
            errors.append(f"reference line missing or altered before the theorem: {needed[k]!r}")
        after = sub_code[sspan[1]].split(":=", 1)[1].strip()
        proof_lines = sum(1 for l in sub_code[sspan[1] + 1 :] if l.strip()) + (1 if after not in ("", "by") else 0)
        if proof_lines == 0:
            errors.append("no proof after the statement")

    # 4. compile and 5. axioms (only if the static checks passed)
    axioms: list[str] = []
    compile_seconds = None
    if not errors:
        tmp = Path(project) / "Submission" / f"_check_{short}.lean"
        tmp.write_text(sub_text.rstrip("\n") + f"\n\n#print axioms {theorem}\n", encoding="utf-8")
        t0 = time.time()
        try:
            r = subprocess.run(
                ["lake", "env", "lean", str(tmp)], cwd=project, capture_output=True, text=True, timeout=900
            )
            out = r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            r, out = None, "compile timeout"
        compile_seconds = round(time.time() - t0, 1)
        tmp.unlink(missing_ok=True)
        if r is None or r.returncode != 0 or re.search(r"^.*: error:", out, re.M):
            errors.append("compile error: " + out.strip()[-1500:])
        if "declaration uses 'sorry'" in out or "declaration uses `sorry`" in out:
            errors.append("declaration uses sorry")
        m = re.search(r"depends on axioms: \[(.*?)\]", out)
        if m:
            axioms = [a.strip() for a in m.group(1).split(",") if a.strip()]
        elif r is not None and "does not depend on any axioms" not in out and not errors:
            errors.append("could not read axioms")
        bad = sorted(set(axioms) - ALLOWED_AXIOMS)
        if bad:
            errors.append("non-standard axioms: " + ", ".join(bad))

    print(json.dumps({
        "ok": not errors,
        "errors": errors,
        "lines": len(sub_lines),
        "nonblank_lines": sum(1 for l in sub_lines if l.strip()),
        "proof_lines": proof_lines,
        "axioms": axioms,
        "compile_seconds": compile_seconds,
    }))


if __name__ == "__main__":
    main()
