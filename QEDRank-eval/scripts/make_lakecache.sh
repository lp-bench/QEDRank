#!/usr/bin/env bash
# Build the read-only lake artifact cache that the sandboxes mount at $HOME/.cache/lake
# (notes/grading_environment_2026-11-02.md): the artifacts of every Matroid module compiled
# into the image, produced by replaying their builds with a writable HOME.  The Matroid build
# directory is copied out of the image first and must come back unchanged.
# usage: scripts/make_lakecache.sh [proofbench-sandbox.sif] [outdir]   (default outdir: lakecache)
set -euo pipefail
SIF=${1:-proofbench-sandbox.sif}; OUT=${2:-lakecache}
A=${APPTAINER:-$(command -v apptainer || command -v singularity)}
W=$(mktemp -d "${TMPDIR:-/tmp}/lakecache.XXXXXX"); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/matroid" "$W/matroid0" "$W/home" "$W/build" "$W/sub" "$OUT"
X="$A exec --containall --cleanenv"
$X --bind "$W/matroid:/mnt/m" --bind "$W/build:/mnt/b" "$SIF" sh -c \
  'cp -a /opt/proofbench/.lake/packages/Matroid/.lake/build/. /mnt/m/ && cp -a /opt/proofbench/.lake/build/. /mnt/b/'
cp -a "$W/matroid/." "$W/matroid0/"
MODS=$($X "$SIF" sh -c 'cd /opt/proofbench/.lake/packages/Matroid/.lake/build/lib/lean && find . -name "*.olean" | sed "s|^\./||; s|\.olean$||; s|/|.|g"' | grep -E '^Matroid\.' | sort -u | tr '\n' ' ')
echo "Matroid modules in the image: $(wc -w <<< "$MODS")"
$X --bind "$W/matroid:/opt/proofbench/.lake/packages/Matroid/.lake/build" --bind "$W/home:/opt/proofbench/.lake/home" \
   --bind "$W/build:/opt/proofbench/.lake/build" --bind "$W/sub:/opt/proofbench/Submission" "$SIF" sh -c \
  "cd /opt/proofbench && export HOME=/opt/proofbench/.lake/home && lake env sh -c 'env -i PATH=\$PATH HOME=\$HOME LEAN_ABORT_ON_PANIC=1 lake build $MODS ProofBench.PROBLEMS.P002.P002 ProofBench.PROBLEMS.P015.P015' 2>&1 | grep -v '^trace:' | tail -2"
changed=$(diff -rq "$W/matroid0" "$W/matroid" | wc -l)
[ "$changed" = 0 ] || { echo "error: the build changed $changed files of the Matroid build directory"; exit 1; }
n=$(find "$W/home/.cache/lake" -type f | wc -l); e=$(find "$W/home/.cache/lake/outputs/Matroid" -type f | wc -l)
echo "cache: $n files, $e output entries, $(du -sh "$W/home/.cache/lake" | cut -f1)"
rm -rf "$OUT/lake"; cp -a "$W/home/.cache/lake" "$OUT/lake"
tag=lakecache-matroid-$(date -u +%Y%m%d)
tar -C "$W/home/.cache" -cf - lake | zstd -19 -T0 -q -o "$OUT/$tag.tar.zst"
(cd "$OUT" && sha256sum "$tag.tar.zst" | tee "$tag.tar.zst.sha256")
echo "mount with: APPTAINER_BIND=$PWD/$OUT/lake:/home/<user>/.cache/lake:ro  (SINGULARITY_BIND on Singularity)"
