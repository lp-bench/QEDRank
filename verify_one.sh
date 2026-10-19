#!/usr/bin/env bash
# Windows/Git-Bash version of scripts/verify_comparator.sh: same two grading layers, paths converted per side.
set -euo pipefail
PID=$1; PB=$2; SUBFILE=${3:-}
cd "$(dirname "$0")"
ST=proofbench-statements/ProofBench/PROBLEMS/$PID/$PID.lean
TMP=$(mktemp -d -p "$PWD" vtmp.XXXX); trap 'rm -rf "$TMP"' EXIT
if [ -n "$SUBFILE" ]; then cp "$SUBFILE" "$TMP/$PID.lean"; else python3 scripts/solution_to_submission.py "$PID" "$ST" "$PB/ProofBench/PROBLEMS/$PID/${PID}_sol.lean" "$(cygpath -m "$TMP")/$PID.lean"; fi
THEOREM=$(python3 -c "import re; t=open(r'$(cygpath -w "$ST")',encoding='utf-8').read(); ns=[m.group(1) for m in re.finditer(r'^namespace\s+(\S+)', t, re.M)]; print('.'.join(ns+['$PID']))")
cp image/check_proof.py "$TMP/check_proof.py"
printf '{"challenge_module": "ProofBench.PROBLEMS.%s.%s", "solution_module": "Submission.%s", "theorem_names": ["%s"], "permitted_axioms": ["propext", "Classical.choice", "Quot.sound"]}\n' "$PID" "$PID" "$PID" "$THEOREM" > "$TMP/config.json"
MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(cygpath -w "$TMP"):/in:ro" proofbench-sandbox:latest bash -c '
  set -e; cp /in/'"$PID"'.lean /opt/proofbench/Submission/; cp /in/config.json /opt/proofbench/Submission/_cmp.json
  chown verifier /opt/proofbench/Submission/*; cd /opt/proofbench
  echo "--- layer 1 (check_proof.py):"; python3 /in/check_proof.py /opt/proofbench /opt/proofbench/Submission/'"$PID"'.lean /opt/proofbench/ProofBench/PROBLEMS/'"$PID"'/'"$PID"'.lean '"$THEOREM"' | tail -1
  echo "--- layer 2 (comparator as user verifier):"
  set +e; runuser -u verifier -- env LD_LIBRARY_PATH=/opt/verifier/lib PATH=/opt/elan/bin:$PATH lake env /opt/verifier/bin/comparator Submission/_cmp.json 2>&1 | tail -3; echo "comparator exit: ${PIPESTATUS[0]}"'
