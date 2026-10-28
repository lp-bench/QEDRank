#!/usr/bin/env bash
# Grader attack suite: grade every case under cases/ with both layers, each on
# its own, in a fresh container from the evaluation image, and compare the
# verdict (accepted only if both layers accept) with the expectation in the
# case's first line, `-- expect: accept` or `-- expect: reject`.
# Cases that need a correct proof hold the placeholder REFERENCE_SOLUTION
# (whole file) or REFERENCE_PROOF (proof of the main theorem); it is filled in
# here from the private development repository, so that this repository never
# contains a solution.  Without that repository those cases are skipped.
# usage: tests/grader_attacks/run.sh [CASE ...]          (default: every case)
#   SIF=proofbench-sandbox.sif   Apptainer image (default when that file exists);
#                                otherwise Docker image proofbench-sandbox:latest
#   PB=../proofbench-hidden      development repository with the reference solutions
#   JOBS=4                       cases graded in parallel
# Writes results.jsonl next to this script; exits 1 if any verdict is unexpected.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SIF=${SIF:-$([ -f "$ROOT/proofbench-sandbox.sif" ] && echo "$ROOT/proofbench-sandbox.sif" || true)}
PB=${PB:-$ROOT/../proofbench-hidden}
JOBS=${JOBS:-4}
IN=$(mktemp -d); trap 'rm -rf "$IN"' EXIT
mkdir "$IN/cases"
if [ $# -gt 0 ]; then for c in "$@"; do cp -r "$HERE/cases/$c" "$IN/cases/"; done
else cp -r "$HERE/cases/." "$IN/cases/"; fi
cp "$HERE/one.sh" "$IN/"
cp "$ROOT/image/check_proof.py" "$IN/"  # the repository's checker, not the image's copy

python3 - "$IN/cases" "$PB" "$ROOT" <<'PY'
import re, shutil, subprocess, sys
from pathlib import Path
cases, pb, root = map(Path, sys.argv[1:4])
for main in sorted(cases.glob("*/*.lean")):
    text = main.read_text(encoding="utf-8")
    if "REFERENCE_" not in text:
        continue
    pid = main.stem
    sol = pb / "ProofBench/PROBLEMS" / pid / f"{pid}_sol.lean"
    built = main.with_suffix(".built")
    statement = root / "proofbench/ProofBench/PROBLEMS" / pid / f"{pid}.lean"
    made = sol.exists() and subprocess.run(
        [sys.executable, str(root / "scripts/solution_to_submission.py"), pid, str(statement), str(sol), str(built)],
        capture_output=True).returncode == 0
    if not made:
        print(f"skipped {main.parent.name}: needs {pid}_sol.lean from the development repository (PB={pb})")
        shutil.rmtree(main.parent)
        continue
    sub = built.read_text(encoding="utf-8")
    built.unlink()
    if "REFERENCE_PROOF" in text:  # the proof of `theorem Pxxx ... := by`
        lines = sub.splitlines()
        t = next(i for i, l in enumerate(lines) if re.match(rf"^theorem\s+{pid}\b", l))
        b = next(i for i in range(t, len(lines)) if lines[i].rstrip().endswith(":= by"))
        text = text.replace("  REFERENCE_PROOF\n", "\n".join(lines[b + 1:]) + "\n")
    main.write_text(text.replace("REFERENCE_SOLUTION\n", sub), encoding="utf-8")
PY
chmod -R a+rX "$IN"
mapfile -t CASES < <(ls "$IN/cases")

grade() {
  if [ -n "$SIF" ]; then
    apptainer exec --containall --cleanenv --writable-tmpfs --net --network none \
      --bind "$IN:/in:ro" "$SIF" bash /in/one.sh "$1"
  else
    docker run --rm --network none -v "$IN:/in:ro" proofbench-sandbox:latest bash /in/one.sh "$1"
  fi
}
export -f grade; export IN SIF
echo "grading ${#CASES[@]} cases with ${SIF:-docker}, $JOBS at a time"
printf '%s\n' "${CASES[@]}" | xargs -P "$JOBS" -I{} bash -c 'grade {} 2>/dev/null | tail -1' >"$HERE/results.jsonl"

python3 - "$HERE" "$IN/cases" <<'PY'
import json, re, sys
from pathlib import Path
here, cases = Path(sys.argv[1]), Path(sys.argv[2])
rows = [json.loads(l) for l in (here / "results.jsonl").read_text().splitlines() if l.startswith("{")]
bad, l1_only = 0, []
print(f"{'case':34} {'expect':7} {'layer1':7} {'layer2':7} {'verdict':8}")
for r in sorted(rows, key=lambda r: r["case"]):
    expect = re.match(r"-- expect: (accept|reject)", next((cases / r["case"]).glob("*.lean")).read_text()).group(1)
    l1, l2 = r["layer1"]["ok"], r["layer2"]["ok"]
    verdict = "accept" if l1 and l2 else "reject"
    flag = "" if verdict == expect else "   <-- UNEXPECTED"
    bad += bool(flag)
    if expect == "reject" and l1:
        l1_only.append(r["case"])
    show = lambda ok: "accept" if ok else "reject"
    print(f"{r['case']:34} {expect:7} {show(l1):7} {show(l2):7} {verdict:8}{flag}")
missing = sorted({p.name for p in cases.iterdir()} - {r["case"] for r in rows})
if missing:
    print("no result (container failed):", " ".join(missing)); bad += len(missing)
if l1_only:
    print("attacks layer 1 alone accepts (caught only by Comparator):", " ".join(l1_only))
print(f"{len(rows) - bad} as expected, {bad} unexpected; details in {here / 'results.jsonl'}")
sys.exit(1 if bad else 0)
PY
