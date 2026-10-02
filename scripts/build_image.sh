#!/usr/bin/env bash
# Stage the ProofBench statement layer and build the sandbox image.
# usage: scripts/build_image.sh [--apptainer] /path/to/ProofBench
#   default: docker build -> proofbench-sandbox:latest
#   --apptainer: apptainer build --fakeroot -> proofbench-sandbox.sif (no Docker needed)
set -euo pipefail
MODE=docker
if [ "${1:-}" = "--apptainer" ]; then MODE=apptainer; shift; fi
PB=${1:?path to the ProofBench repository}
HERE=$(cd "$(dirname "$0")/.." && pwd)
CTX="$HERE/image/context"
rm -rf "$CTX"; mkdir -p "$CTX/ProofBench"
cp "$PB/lean-toolchain" "$PB/lakefile.toml" "$PB/lake-manifest.json" "$CTX/"
cp -r "$PB/ProofBench/Mathlib_Problems" "$CTX/ProofBench/"
: > "$CTX/ProofBench.lean"
# Drop the Matroid dependency when no visible module imports it (saves a long source build).
if ! grep -rq '^import Matroid' "$CTX/ProofBench/Mathlib_Problems"; then
  python3 - "$CTX" <<'PY'
import json, re, sys
from pathlib import Path
ctx = Path(sys.argv[1])
lf = ctx / "lakefile.toml"
lf.write_text(re.sub(r'\[\[require\]\]\nname = "Matroid"\n(?:.*\n)*?(?=\[\[require\]\]|\[\[lean_lib\]\])', "", lf.read_text()))
mf = ctx / "lake-manifest.json"
m = json.loads(mf.read_text()); m["packages"] = [p for p in m["packages"] if p["name"] != "Matroid"]
mf.write_text(json.dumps(m, indent=1) + "\n")
print("Matroid dependency dropped (unused by the statement layer)")
PY
fi
# Aggregator module so one `lake build` compiles the whole statement layer.
{ cd "$CTX"; find ProofBench/Mathlib_Problems -name '*.lean' | sort \
    | sed 's#/#.#g; s#\.lean$##; s#^#import #'; } > "$CTX/ProofBench/Visible.lean"
echo "staged $(grep -c . "$CTX/ProofBench/Visible.lean") visible modules"
if [ "$MODE" = docker ]; then
  docker build -t proofbench-sandbox:latest -f "$HERE/image/Dockerfile" "$HERE/image"
  docker image inspect --format 'image id {{.Id}}' proofbench-sandbox:latest
else
  (cd "$HERE/image" && apptainer build --fakeroot "$HERE/proofbench-sandbox.sif" proofbench.def)
  echo "built $HERE/proofbench-sandbox.sif ($(sha256sum "$HERE/proofbench-sandbox.sif" | cut -c1-16))"
fi
