#!/bin/bash
# Inside the evaluation image: grade the case /in/cases/$1 with both layers,
# each on its own (layer 2 runs even when layer 1 rejects), exactly as the
# scorer calls them.  Prints one JSON line.  Called by run.sh.
# The main file is Pxxx.lean, or Pxxx_DISPROVE.lean for a disproof of an open
# problem.  A case may bring its own challenge files in _challenge/: they are
# copied to ProofBench/PROBLEMS/Pxxx/ and built first (a test problem that is
# not in the benchmark).
CASE=$1
P=/opt/proofbench
SRC=/in/cases/$CASE
MAIN=$(cd "$SRC" && ls *.lean)
STEM=${MAIN%.lean}                     # Pxxx, or Pxxx_DISPROVE
PID=${STEM%_DISPROVE}
SHORT=$PID; [ "$STEM" = "$PID" ] || SHORT=${PID}_disprove
(cd "$SRC" && find . -mindepth 1 -maxdepth 1 ! -name _challenge -exec cp -r {} "$P/Submission/" \;)
if [ -d "$SRC/_challenge" ]; then
  mkdir -p "$P/ProofBench/PROBLEMS/$PID"
  cp "$SRC/_challenge/"*.lean "$P/ProofBench/PROBLEMS/$PID/"
  for f in "$SRC/_challenge/"*.lean; do
    (cd "$P" && lake build "ProofBench.PROBLEMS.$PID.$(basename "$f" .lean)") >/dev/null 2>&1
  done
fi
REF=$P/ProofBench/PROBLEMS/$PID/$STEM.lean
THEOREM=$(python3 - "$REF" "$SHORT" <<'PY'
import re, sys
stack = []  # the namespaces open at the theorem, as in proofbench_eval/task.py
for line in open(sys.argv[1], encoding="utf-8").read().splitlines():
    m = re.match(r"^namespace\s+(\S+)", line)
    if m:
        stack.append(m.group(1))
    elif re.match(r"^end\s+\S+", line) and stack:
        stack.pop()
    elif re.match(rf"^\s*theorem\s+{sys.argv[2]}\b", line):
        print(".".join(stack + [sys.argv[2]]))
        break
PY
)
if [ "$(id -u)" = 0 ]; then  # Docker: Comparator runs as the unprivileged user, as in the scorer
  chown -R verifier "$P/Submission"; AS="runuser -u verifier --"
else
  AS=""
fi
python3 /in/check_proof.py "$P" "$P/Submission/$MAIN" "$REF" "$THEOREM" >/tmp/l1.out 2>&1
cat >"$P/Submission/_cmp.json" <<JSON
{"challenge_module": "ProofBench.PROBLEMS.$PID.$STEM", "solution_module": "Submission.$STEM",
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
    "layer1": {"ok": rep["ok"], "errors": [e[:300] for e in rep["errors"]]},
    "layer2": {"ok": rc == 0, "returncode": rc, "output": out[-600:]},
}))
PY
