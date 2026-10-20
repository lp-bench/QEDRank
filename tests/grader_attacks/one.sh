#!/bin/bash
# Inside the evaluation image: grade the case /in/cases/$1 with both layers,
# each on its own (layer 2 runs even when layer 1 rejects), exactly as the
# scorer calls them.  Prints one JSON line.  Called by run.sh.
CASE=$1
P=/opt/proofbench
SRC=/in/cases/$CASE
MAIN=$(cd "$SRC" && ls *.lean)
PID=${MAIN%.lean}
cp -r "$SRC/." "$P/Submission/"
THEOREM=$(python3 -c "
import re,sys; t=open('$P/ProofBench/PROBLEMS/$PID/$PID.lean').read()
ns=[m.group(1) for m in re.finditer(r'^namespace\s+(\S+)', t, re.M)]
print('.'.join(ns+['$PID']))")
if [ "$(id -u)" = 0 ]; then  # Docker: Comparator runs as the unprivileged user, as in the scorer
  chown -R verifier "$P/Submission"; AS="runuser -u verifier --"
else
  AS=""
fi
python3 /in/check_proof.py "$P" "$P/Submission/$MAIN" "$P/ProofBench/PROBLEMS/$PID/$PID.lean" "$THEOREM" >/tmp/l1.out 2>&1
cat >"$P/Submission/_cmp.json" <<JSON
{"challenge_module": "ProofBench.PROBLEMS.$PID.$PID", "solution_module": "Submission.$PID",
 "theorem_names": ["$THEOREM"], "permitted_axioms": ["propext", "Classical.choice", "Quot.sound"]}
JSON
[ -n "$AS" ] && chown verifier "$P/Submission/_cmp.json"
cd "$P" && timeout 1800 $AS env LD_LIBRARY_PATH=/opt/verifier/lib PATH=/opt/elan/bin:$PATH \
  lake env /opt/verifier/bin/comparator Submission/_cmp.json >/tmp/l2.out 2>&1
echo $? >/tmp/l2.rc
python3 - "$CASE" <<'PY'
import json, sys
l1 = open("/tmp/l1.out").read().strip().splitlines()
try:
    rep = json.loads(l1[-1])
except Exception:
    rep = {"ok": False, "errors": ["checker crashed: " + " ".join(l1[-5:])[-300:]]}
rc = int(open("/tmp/l2.rc").read())
out = open("/tmp/l2.out").read().strip()
print(json.dumps({
    "case": sys.argv[1],
    "layer1": {"ok": rep["ok"], "errors": [e[:300] for e in rep["errors"]], "completeness": rep.get("completeness")},
    "layer2": {"ok": rc == 0, "returncode": rc, "output": out[-600:]},
}))
PY
