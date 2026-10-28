#!/usr/bin/env bash
# Stage what the selected problems import and build the sandbox image.
# usage: IDS="P083 P088 P090" scripts/build_image.sh [--sif|--apptainer|--update BASE.sif] [proofbench]
#   default: docker build -> proofbench-sandbox:latest
#   --sif: the docker build, then convert that image to proofbench-sandbox.sif (same content)
#   --apptainer: apptainer build --fakeroot from image/proofbench.def (no Docker needed)
#   --update BASE.sif: new proofbench-sandbox.sif = BASE.sif with the freshly staged statement
#     modules copied in and rebuilt (no Docker, no network; toolchain, Mathlib and tools
#     come from BASE). For new or changed problems on a machine without Docker.
# Only the statement-layer modules (and challenge statements) the selected problems
# import, transitively, enter the image; anything else is an error.  For an open
# problem the negation Pxxx_DISPROVE and what it imports are staged as well.
set -euo pipefail
MODE=docker
if [ "${1:-}" = "--apptainer" ]; then MODE=apptainer; shift; fi
if [ "${1:-}" = "--sif" ]; then MODE=sif; shift; fi
if [ "${1:-}" = "--update" ]; then MODE=update; BASE=$(realpath "${2:?--update needs the base .sif}"); shift 2; fi
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${SIF_OUT:-$HERE/proofbench-sandbox.sif}   # .sif written by --apptainer and --update
# No-root Apptainer installs lack the newuidmap helper; --ignore-subuid then makes
# --fakeroot use a plain root-mapped namespace (enough for copying and compiling).
FAKEROOT="--fakeroot"
if ! command -v newuidmap >/dev/null && grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  FAKEROOT="--fakeroot --ignore-subuid"
fi
PB=${1:-$HERE/proofbench}
IDS=${IDS:?problems to build for, e.g. IDS="P083 P088 P090"}
CTX="$HERE/image/context"
rm -rf "$CTX"; mkdir -p "$CTX/ProofBench"
cp "$PB/lean-toolchain" "$PB/lakefile.toml" "$PB/lake-manifest.json" "$CTX/"
# The agent's files form the `Submission` library (Submission/Pxxx.lean -> module
# Submission.Pxxx), which the verifier resolves through lake.
printf '\n[[lean_lib]]\nname = "Submission"\n' >> "$CTX/lakefile.toml"
# Statement files carry no module docstring, by design.  Mathlib's header linter
# (in the project's mathlibStandardSet) would flag each of them, and the agent's
# files, in every `lake build` and in the language server.  The statements' lakefile
# switches it off itself since 2026-10-28; an older one gets the line here.
grep -q '^weak.linter.style.header = false' "$CTX/lakefile.toml" ||
  sed -i 's/^\[leanOptions\]$/[leanOptions]\nweak.linter.style.header = false/' "$CTX/lakefile.toml"
grep -q '^weak.linter.style.header = false' "$CTX/lakefile.toml" || { echo "no [leanOptions] in lakefile.toml" >&2; exit 1; }
: > "$CTX/ProofBench.lean"
python3 - "$PB" "$CTX" $IDS <<'PY'
import json, re, shutil, sys
from pathlib import Path
pb, ctx, ids = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
IMPORT = re.compile(r"^(?:public\s+)?import\s+(\S+)", re.M)
STATEMENT = re.compile(r"ProofBench\.(Mathlib_Problems\..+|PROBLEMS\.P\d{3}\.P\d{3}(_DISPROVE)?)$")
def imports(f):
    return IMPORT.findall(f.read_text(encoding="utf-8"))
# The selected problems' own statement modules are staged too: Comparator grades
# against them as the trusted Challenge modules (for an open problem, also the
# negation Pxxx_DISPROVE, which a disproof is graded against).
problems = [f"ProofBench.PROBLEMS.{i}.{i}" for i in ids]
problems += [f"ProofBench.PROBLEMS.{i}.{i}_DISPROVE" for i in ids
             if (pb / "ProofBench/PROBLEMS" / i / f"{i}_DISPROVE.lean").exists()]
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
# UTF-8 and "\n" explicitly: on Windows, Python's defaults (cp1252, "\r\n") would corrupt the
# manifest's «…» name and give lake build targets ending in "\r" (from the QEDRank fork).
(ctx / "modules.txt").write_text("".join(f"{m}\n" for m in sorted(staged)), encoding="utf-8", newline="\n")
print(f"staged {len(staged)} statement modules for {len(ids)} problems")
# Drop the Matroid dependency when nothing imports it (saves a long source build).
if not any(m.split(".")[0] == "Matroid" for m in seen):
    lf = ctx / "lakefile.toml"
    lf.write_text(re.sub(r'\[\[require\]\]\nname = "Matroid"\n(?:.*\n)*?(?=\[\[require\]\]|\[\[lean_lib\]\])', "", lf.read_text(encoding="utf-8")), encoding="utf-8", newline="\n")
    mf = ctx / "lake-manifest.json"
    m = json.loads(mf.read_text(encoding="utf-8")); m["packages"] = [p for p in m["packages"] if p["name"] != "Matroid"]
    mf.write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8", newline="\n")
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
elif [ "$MODE" = update ]; then
  [ "$BASE" != "$OUT" ] || { echo "--update: move the base image away from $OUT first" >&2; exit 1; }
  cat > "$CTX/update.def" <<DEF
Bootstrap: localimage
From: $BASE

%files
    $CTX /opt/context-update

%post
    set -e
    export ELAN_HOME=/opt/elan PATH=/opt/elan/bin:\$PATH
    cp -a /opt/context-update/. /opt/proofbench/
    rm -rf /opt/context-update
    cd /opt/proofbench
    xargs lake build < modules.txt
DEF
  # the base image is unpacked to APPTAINER_TMPDIR: about twice its size on disk
  export APPTAINER_TMPDIR=${APPTAINER_TMPDIR:-$HERE/.apptainer-tmp}; mkdir -p "$APPTAINER_TMPDIR"
  apptainer build $FAKEROOT "$OUT" "$CTX/update.def"
  echo "built $OUT ($(sha256sum "$OUT" | cut -c1-16)) from $(basename "$BASE")"
else
  export APPTAINER_TMPDIR=${APPTAINER_TMPDIR:-$HERE/.apptainer-tmp}; mkdir -p "$APPTAINER_TMPDIR"
  (cd "$HERE/image" && apptainer build $FAKEROOT "$OUT" proofbench.def)
  echo "built $OUT ($(sha256sum "$OUT" | cut -c1-16))"
fi
