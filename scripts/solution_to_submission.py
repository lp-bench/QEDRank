#!/usr/bin/env python3
"""Turn a reference solution (ProofBench's Pxxx_sol.lean) into a submission file.

usage: solution_to_submission.py Pxxx STATEMENT.lean SOLUTION.lean OUT.lean
Exit 3 (and a SKIP: line) when the solution cannot be used in the sandbox.
"""

import re
import sys
from pathlib import Path


def norm(l: str) -> str:
    return " ".join(l.split())


def main() -> None:
    pid, st_path, sol_path, out = sys.argv[1:5]
    st, sol = Path(st_path).read_text(encoding="utf-8"), Path(sol_path).read_text(encoding="utf-8")
    sol_imports = [l for l in sol.splitlines() if l.startswith("import")]
    if any(re.match(r"import ProofBench\.Mathlib\.", l) for l in sol_imports):
        print(f"SKIP: {pid}_sol.lean imports the proctor library (ProofBench.Mathlib.*), not in the sandbox")
        sys.exit(3)
    stmt_mod = f"ProofBench.PROBLEMS.{pid}.{pid}"
    if not any(norm(l) == f"import {stmt_mod}" for l in sol_imports):
        # Standalone: restates the definitions and the theorem; rename the theorem.
        text, n = re.subn(rf"^(theorem|lemma)\s+{pid}_sol\b", f"theorem {pid}", sol, flags=re.M)
        if n == 0 and not re.search(rf"^theorem\s+{pid}\b", sol, re.M):
            print(f"SKIP: {pid}_sol.lean has neither `theorem {pid}` nor `theorem {pid}_sol`")
            sys.exit(3)
        mode = "standalone file, theorem renamed"
    else:
        # Imports the statement module: put its content before the statement's
        # theorem and prove that theorem from Pxxx_sol.
        st_lines = st.splitlines()
        i_thm = next(i for i, l in enumerate(st_lines) if re.match(rf"^theorem\s+{pid}\b", l))
        i_imp = max(i for i, l in enumerate(st_lines) if l.startswith("import")) + 1
        st_imports = {norm(l) for l in st_lines[:i_imp]}
        extra = [l for l in sol_imports if norm(l) != f"import {stmt_mod}" and norm(l) not in st_imports]
        helpers = [l for l in sol.splitlines() if not l.startswith("import")]
        j = i_thm  # keep a docstring / attributes attached to the theorem
        while j > 0 and st_lines[j - 1].strip() and not st_lines[j - 1].rstrip().endswith(("-/", ")", ":=")) \
                and (st_lines[j - 1].lstrip().startswith(("@[", "/--")) or any("/--" in l for l in st_lines[max(0, j - 10):j]) and not any(l.rstrip().endswith("-/") for l in st_lines[max(0, j - 10):j - 1])):
            j -= 1
        while j > 0 and any("/--" in l for l in st_lines[max(0, j - 10):j]) and not any(l.rstrip().endswith("-/") for l in st_lines[max(0, j - 10):j]):
            j -= 1
        thm = st_lines[j:]
        k = max(i for i, l in enumerate(thm) if re.search(r"\bsorry\b", l))
        if thm[k].strip() == "sorry":
            thm[k] = thm[k].replace("sorry", f"apply {pid}_sol <;> assumption")
        else:
            thm[k] = re.sub(r"\bsorry\b", f"(by apply {pid}_sol <;> assumption)", thm[k], count=1)
        text = "\n".join(st_lines[:i_imp] + extra + st_lines[i_imp:j] + helpers + [""] + thm) + "\n"
        mode = f"statement + solution file, proof `apply {pid}_sol`"
    Path(out).write_text(text, encoding="utf-8")
    print(f"submission built from {pid}_sol.lean: {mode}")


if __name__ == "__main__":
    main()
