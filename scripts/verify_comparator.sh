#!/usr/bin/env bash
# End-to-end check of the grader on the built image: grade a known-correct proof
# (the reference solution Pxxx_sol.lean of the private ProofBench repo) with both
# layers exactly as the scorer does, in a fresh container as user `verifier`.
# The solution file is turned into a submission (statement file + proof):
#   - a standalone file proving `Pxxx_sol` is used as is with the theorem renamed;
#   - a file that imports the statement module and proves `Pxxx_sol` is inserted
#     before the statement's theorem, whose proof becomes `apply Pxxx_sol`;
#   - a file that needs the proctor library (ProofBench.Mathlib.*) is skipped:
#     that library is not in the sandbox.
# usage: scripts/verify_comparator.sh P090 [../proofbench-hidden]
set -euo pipefail
cd "$(dirname "$0")/.."
PID=${1:?problem id}; PB=${2:-../proofbench-hidden}
ST=proofbench/ProofBench/PROBLEMS/$PID/$PID.lean
SOL=$PB/ProofBench/PROBLEMS/$PID/${PID}_sol.lean
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 scripts/solution_to_submission.py "$PID" "$ST" "$SOL" "$TMP/$PID.lean" || exit $?
THEOREM=$(python3 -c "
import re,sys; t=open('$ST').read(); ns=[m.group(1) for m in re.finditer(r'^namespace\s+(\S+)', t, re.M)]
print('.'.join(ns+['$PID']))")
cp image/check_proof.py "$TMP/check_proof.py"
cat > "$TMP/config.json" <<JSON
{"challenge_module": "ProofBench.PROBLEMS.$PID.$PID", "solution_module": "Submission.$PID",
 "theorem_names": ["$THEOREM"], "permitted_axioms": ["propext", "Classical.choice", "Quot.sound"]}
JSON
docker run --rm --network none -v "$TMP:/in:ro" proofbench-sandbox:latest bash -c '
  set -e; cp /in/'"$PID"'.lean /opt/proofbench/Submission/; cp /in/config.json /opt/proofbench/Submission/_cmp.json
  chown verifier /opt/proofbench/Submission/*; cd /opt/proofbench
  echo "--- layer 1 (check_proof.py):"; python3 /in/check_proof.py /opt/proofbench /opt/proofbench/Submission/'"$PID"'.lean /opt/proofbench/ProofBench/PROBLEMS/'"$PID"'/'"$PID"'.lean '"$THEOREM"' | tail -1
  echo "--- layer 2 (comparator as user verifier):"
  time runuser -u verifier -- env LD_LIBRARY_PATH=/opt/verifier/lib PATH=/opt/elan/bin:$PATH lake env /opt/verifier/bin/comparator Submission/_cmp.json; echo "comparator exit: $?"'
