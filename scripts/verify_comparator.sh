#!/usr/bin/env bash
# End-to-end check of the verifier layer on the built image: grade a known-correct
# proof (the reference solution of a problem, taken from the private ProofBench repo)
# with Comparator exactly as the scorer does, in a fresh container as user `verifier`.
# usage: scripts/verify_comparator.sh P090 [../ProofBench]
set -euo pipefail
cd "$(dirname "$0")/.."
PID=${1:?problem id}; PB=${2:-../ProofBench}
ST=proofbench-statements/ProofBench/PROBLEMS/$PID/$PID.lean
SOL=$PB/ProofBench/PROBLEMS/$PID/${PID}_sol.lean
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$ST" "$SOL" "$TMP/$PID.lean" <<'PY'
import re, sys
from pathlib import Path
st, sol = Path(sys.argv[1]).read_text(), Path(sys.argv[2]).read_text()
proof = sol.split(":= by\n", 1)[1]                       # body of the reference proof
imports = sorted(set(re.findall(r"^import .*$", sol, re.M)) - set(re.findall(r"^import .*$", st, re.M)))
text = st.replace("  sorry\n", proof)
if imports:  # extra imports the reference needs go after the statement's own
    last = re.findall(r"^import .*$", text, re.M)[-1]
    text = text.replace(last, last + "\n" + "\n".join(imports), 1)
Path(sys.argv[3]).write_text(text)
PY
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
