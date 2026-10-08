#!/usr/bin/env bash
# Stage what the selected problems import and build the sandbox image.
# usage: IDS="P083 P088 P090" scripts/build_image.sh [--sif|--apptainer] [proofbench-statements]
#   default: docker build -> proofbench-sandbox:latest
#   --sif: the docker build, then convert that image to proofbench-sandbox.sif (same content)
#   --apptainer: apptainer build --fakeroot from image/proofbench.def (no Docker needed)
# Only the statement-layer modules (and challenge statements) the selected problems
# import, transitively, enter the image; anything else is an error.
set -euo pipefail
MODE=docker
if [ "${1:-}" = "--apptainer" ]; then MODE=apptainer; shift; fi
if [ "${1:-}" = "--sif" ]; then MODE=sif; shift; fi
HERE=$(cd "$(dirname "$0")/.." && pwd)
PB=${1:-$HERE/proofbench-statements}
IDS=${IDS:?problems to build for, e.g. IDS="P083 P088 P090"}
CTX="$HERE/image/context"
rm -rf "$CTX"; mkdir -p "$CTX/ProofBench"
cp "$PB/lean-toolchain" "$PB/lakefile.toml" "$PB/lake-manifest.json" "$CTX/"
# The agent's files form the `Submission` library (Submission/Pxxx.lean -> module
# Submission.Pxxx), which the verifier resolves through lake.
printf '\n[[lean_lib]]\nname = "Submission"\n' >> "$CTX/lakefile.toml"
: > "$CTX/ProofBench.lean"
python3 - "$PB" "$CTX" $IDS <<'PY'
import json, re, shutil, sys
from pathlib import Path
pb, ctx, ids = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
IMPORT = re.compile(r"^(?:public\s+)?import\s+(\S+)", re.M)
STATEMENT = re.compile(r"ProofBench\.(Mathlib_Problems\..+|PROBLEMS\.P\d{3}\.P\d{3})$")
def imports(f):
    return IMPORT.findall(f.read_text(encoding="utf-8"))
# The selected problems' own statement modules are staged too: Comparator grades
# against them as the trusted Challenge modules.
problems = [f"ProofBench.PROBLEMS.{i}.{i}" for i in ids]
top = sorted({m for i in ids for m in imports(pb / "ProofBench/PROBLEMS" / i / f"{i}.lean")} | set(problems))
seen, todo, staged = set(top), [m for m in top if m.startswith("ProofBench.")], set()
while todo:
    m = todo.pop()
    if m in staged:
        continue
    if not STATEMENT.match(m):
        sys.exit(f"{m}: not a statement module (only Mathlib_Problems and Pxxx statements enter the image)")
    rel = Path(*m.split(".")).with_suffix(".lean")
    (ctx / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(pb / rel, ctx / rel)
    staged.add(m)
    seen.update(imports(pb / rel))
    todo += [i for i in imports(pb / rel) if i.startswith("ProofBench.")]
# Build targets: every staged module, one per line (each pulls in its own
# imports: statement layer, Matroid, Archive.Sensitivity).  They are built as
# separate targets, not through one aggregator module: statement libraries may
# clash with each other in a single environment (ProofBench's `Hypergraph`
# against Mathlib's) while each problem file is fine on its own.
(ctx / "modules.txt").write_text("".join(f"{m}\n" for m in sorted(staged)))
print(f"staged {len(staged)} statement modules for {len(ids)} problems")
# Drop the Matroid dependency when nothing imports it (saves a long source build).
if not any(m.split(".")[0] == "Matroid" for m in seen):
    lf = ctx / "lakefile.toml"
    lf.write_text(re.sub(r'\[\[require\]\]\nname = "Matroid"\n(?:.*\n)*?(?=\[\[require\]\]|\[\[lean_lib\]\])', "", lf.read_text()))
    mf = ctx / "lake-manifest.json"
    m = json.loads(mf.read_text()); m["packages"] = [p for p in m["packages"] if p["name"] != "Matroid"]
    mf.write_text(json.dumps(m, indent=1) + "\n")
    print("Matroid dependency dropped (no staged module imports it)")
PY
if [ "$MODE" = docker ] || [ "$MODE" = sif ]; then
  # host network: PyPI downloads stall on the default build network (WSL2)
  docker build --network host -t proofbench-sandbox:latest -f "$HERE/image/Dockerfile" "$HERE/image"
  docker image inspect --format 'image id {{.Id}}' proofbench-sandbox:latest
  if [ "$MODE" = sif ]; then
    # same bytes as the docker image; APPTAINER_TMPDIR needs ~2x the image size
    apptainer build --force "$HERE/proofbench-sandbox.sif" docker-daemon://proofbench-sandbox:latest
    echo "built $HERE/proofbench-sandbox.sif ($(sha256sum "$HERE/proofbench-sandbox.sif" | cut -c1-16))"
  fi
else
  (cd "$HERE/image" && apptainer build --fakeroot "$HERE/proofbench-sandbox.sif" proofbench.def)
  echo "built $HERE/proofbench-sandbox.sif ($(sha256sum "$HERE/proofbench-sandbox.sif" | cut -c1-16))"
fi
