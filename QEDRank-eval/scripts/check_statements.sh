#!/usr/bin/env bash
# Sanity checks of the statement set against the built image, before any run.
#  1. Static: every statement, and every negation Pxxx_DISPROVE of an open
#     problem, passes the grader's checks except for its own `sorry` (theorem
#     found, imports allowed, nothing else flagged).  Fast.  Runs in the Docker
#     image, or without Docker in the Apptainer image SIF (default
#     proofbench-sandbox.sif).
#  2. Reference solutions: every problem with Pxxx_sol.lean in the private
#     ProofBench repo is accepted by both grading layers
#     (scripts/verify_comparator.sh, one fresh container each; ~1 min per problem).
# usage: [IDS="P083 P088"] scripts/check_statements.sh [--static-only] [../../proofbench-hidden] [proofbench]
set -euo pipefail
cd "$(dirname "$0")/.."
STATIC_ONLY=0
if [ "${1:-}" = "--static-only" ]; then STATIC_ONLY=1; shift; fi
PB=${1:-../../proofbench-hidden}; ST=${2:-proofbench}
IDS=${IDS:-$(ls "$ST/ProofBench/PROBLEMS" | grep -E '^P[0-9]{3}$' | tr '\n' ' ')}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp image/check_proof.py "$TMP/"
.venv/bin/python3 - "$ST" "$TMP/theorems.json" $IDS <<'PY' 2>/dev/null
import json, re, sys
sys.path.insert(0, ".")
from proofbench_eval.task import qualified_theorem, strip_comments
from pathlib import Path
st, out, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
names, several = {}, []  # file stem -> [path below PROBLEMS/, qualified theorem]
for pid in ids:
    for stem, short in [(pid, pid), (f"{pid}_DISPROVE", f"{pid}_disprove")]:
        f = Path(st) / "ProofBench/PROBLEMS" / pid / f"{stem}.lean"
        if stem != pid and not f.exists():
            continue
        try:
            text = f.read_text(encoding="utf-8")
            names[stem] = [f"{pid}/{stem}.lean", qualified_theorem(text, short)]
            if len(re.findall(r"\bsorry\b", strip_comments(text))) > 1:
                several.append(stem)
        except Exception as e:
            names[stem] = [f"{pid}/{stem}.lean", f"ERROR: {e}"]
Path(out).write_text(json.dumps(names))
print(f"{len(names)} files ({sum(s.endswith('_DISPROVE') for s in names)} DISPROVE); more than one sorry: {' '.join(several) or 'none'}")
PY
echo "--- 1. static checks of the statements and DISPROVE files (expected: only 'contains sorry')"
PROBLEMS="$(cd "$ST" && pwd)/ProofBench/PROBLEMS"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  RUN=(docker run -i --rm --network none -v "$TMP:/in:ro" -v "$PROBLEMS:/problems:ro" proofbench-sandbox:latest)
else
  RUN=(apptainer exec --containall --cleanenv --net --network none --bind "$TMP:/in:ro" --bind "$PROBLEMS:/problems:ro"
       "${SIF:-proofbench-sandbox.sif}")
fi
"${RUN[@]}" python3 - <<'PY'
import json, subprocess
names = json.load(open("/in/theorems.json"))
bad = 0
for stem, (rel, thm) in names.items():
    f = f"/problems/{rel}"
    if thm.startswith("ERROR"):
        print(f"{stem}: {thm}"); bad += 1; continue
    r = subprocess.run(["python3", "/in/check_proof.py", "/opt/proofbench", f, f, thm], capture_output=True, text=True)
    try:
        rep = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print(f"{stem}: checker crashed: {r.stderr[-300:]}"); bad += 1; continue
    errs = rep["errors"]
    if errs != ["contains sorry"]:
        print(f"{stem} ({thm}): {errs}"); bad += 1
print(f"static: {len(names) - bad} ok, {bad} flagged")
PY
[ "$STATIC_ONLY" = 1 ] && exit 0
echo "--- 2. reference solutions through both grading layers"
for pid in $IDS; do
  [ -f "$PB/ProofBench/PROBLEMS/$pid/${pid}_sol.lean" ] || continue
  out=$(scripts/verify_comparator.sh "$pid" "$PB" 2>&1 || true)
  if echo "$out" | grep -q "^SKIP:"; then echo "$pid: $(echo "$out" | grep "^SKIP:")"; continue; fi
  l1=$(echo "$out" | grep -A1 "layer 1" | tail -1 | python3 -c "import sys,json; print('ok' if json.loads(sys.stdin.read())['ok'] else 'FAIL')" 2>/dev/null || echo "FAIL")
  l2=$(echo "$out" | grep -q "Your solution is okay" && echo ok || echo FAIL)
  echo "$pid: layer1=$l1 comparator=$l2"
  [ "$l1" = ok ] || echo "$out" | grep -A1 "layer 1" | tail -n 1 | sed -E 's/"files".*//; s/^/    layer 1: /' | cut -c1-600
  [ "$l2" = ok ] || echo "$out" | tail -n 12 | sed 's/^/    /'
done
