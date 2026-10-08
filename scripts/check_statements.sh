#!/usr/bin/env bash
# Sanity checks of the statement set against the built image, before any run.
#  1. Static: every statement passes the grader's checks except for its own
#     `sorry` (theorem found, imports allowed, nothing else flagged).  Fast.
#  2. Reference solutions: every problem with Pxxx_sol.lean in the private
#     ProofBench repo is accepted by both grading layers
#     (scripts/verify_comparator.sh, one fresh container each; ~1 min per problem).
# usage: [IDS="P083 P088"] scripts/check_statements.sh [--static-only] [../ProofBench] [proofbench-statements]
set -euo pipefail
cd "$(dirname "$0")/.."
STATIC_ONLY=0
if [ "${1:-}" = "--static-only" ]; then STATIC_ONLY=1; shift; fi
PB=${1:-../ProofBench}; ST=${2:-proofbench-statements}
IDS=${IDS:-$(ls "$ST/ProofBench/PROBLEMS" | grep -E '^P[0-9]{3}$' | tr '\n' ' ')}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp image/check_proof.py "$TMP/"
.venv/bin/python3 - "$ST" "$TMP/theorems.json" $IDS <<'PY' 2>/dev/null
import json, sys
sys.path.insert(0, ".")
from proofbench_eval.task import qualified_theorem
from pathlib import Path
st, out, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
names = {}
for pid in ids:
    try:
        names[pid] = qualified_theorem((Path(st) / "ProofBench/PROBLEMS" / pid / f"{pid}.lean").read_text(encoding="utf-8"), pid)
    except Exception as e:
        names[pid] = f"ERROR: {e}"
Path(out).write_text(json.dumps(names))
PY
echo "--- 1. static checks of $(echo $IDS | wc -w) statements (expected: only 'contains sorry')"
docker run -i --rm --network none -v "$TMP:/in:ro" -v "$(cd "$ST" && pwd)/ProofBench/PROBLEMS:/problems:ro" \
  proofbench-sandbox:latest python3 - <<'PY'
import json, subprocess
names = json.load(open("/in/theorems.json"))
bad = 0
for pid, thm in names.items():
    f = f"/problems/{pid}/{pid}.lean"
    if thm.startswith("ERROR"):
        print(f"{pid}: {thm}"); bad += 1; continue
    r = subprocess.run(["python3", "/in/check_proof.py", "/opt/proofbench", f, f, thm], capture_output=True, text=True)
    try:
        rep = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print(f"{pid}: checker crashed: {r.stderr[-300:]}"); bad += 1; continue
    errs = rep["errors"]
    if errs != ["contains sorry"]:
        print(f"{pid} ({thm}): {errs}"); bad += 1
print(f"static: {len(names) - bad} ok, {bad} flagged")
PY
[ "$STATIC_ONLY" = 1 ] && exit 0
echo "--- 2. reference solutions through both grading layers"
for pid in $IDS; do
  [ -f "$PB/ProofBench/PROBLEMS/$pid/${pid}_sol.lean" ] || continue
  out=$(scripts/verify_comparator.sh "$pid" "$PB" 2>&1 || true)
  l1=$(echo "$out" | grep -A1 "layer 1" | tail -1 | python3 -c "import sys,json; print('ok' if json.loads(sys.stdin.read())['ok'] else 'FAIL')" 2>/dev/null || echo "FAIL")
  l2=$(echo "$out" | grep -q "Your solution is okay" && echo ok || echo FAIL)
  echo "$pid: layer1=$l1 comparator=$l2"
  [ "$l1$l2" = "okok" ] || echo "$out" | tail -n 15 | sed 's/^/    /'
done
