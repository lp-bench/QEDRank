#!/usr/bin/env bash
#SBATCH --job-name=proofbench-eval
#SBATCH --cpus-per-task=32
#SBATCH --mem=128G
#SBATCH --time=24:00:00   # a part of 39 problems takes 8-15 h; 24 h fits the scheduler's backfill window, 48 h does not
#SBATCH --output=logs/slurm-%j.out
# One evaluation run on a Slurm cluster without Docker.  Inspect runs on the node
# and starts one Apptainer instance per problem through the inspect-apptainer
# sandbox: no host environment (no API keys), no network, no host directories
# inside the instances; only the one problem file is copied in.
# Needs on the cluster: this repo with its .venv (scripts/setup.sh),
# the proofbench clone (problem statements), proofbench-sandbox.sif (built with scripts/build_image.sh,
# any mode, then copied), API keys in .env, and outbound HTTPS from the node
# (or HTTPS_PROXY in .env).  For a self-hosted model (vLLM on a GPU node) use
# MODEL=openai-api/kimi/<served-name> with KIMI_BASE_URL=http://<node>:8000/v1 in .env.
set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")/..}"
module load apptainer 2>/dev/null || module load singularity 2>/dev/null || true
source .venv/bin/activate
# Lake's artifact cache for the Comparator (notes/grading_environment_2026-11-02.md), mounted
# read-only at $HOME/.cache/lake in every sandbox.  Without it the Comparator rejects every proof
# that imports a package enabling the cache (Matroid) as "build failed", so the run refuses to
# start when the cache is missing.  LAKECACHE=<dir> names another cache; LAKECACHE=none runs
# without one (only for an image whose packages do not enable the artifact cache).  The manifest
# records the cache's checksum (scripts/manifest.py).
export LAKECACHE=${LAKECACHE:-$PWD/lakecache/lake}
if [ "$LAKECACHE" != none ]; then
  [ -d "$LAKECACHE/outputs" ] || { echo "error: lake cache $LAKECACHE missing; build it with scripts/make_lakecache.sh, or set LAKECACHE=none" >&2; exit 1; }
  export APPTAINER_BIND="${APPTAINER_BIND:+$APPTAINER_BIND,}$LAKECACHE:$HOME/.cache/lake:ro"
  export SINGULARITY_BIND="$APPTAINER_BIND"
fi
export SANDBOX=apptainer
export SIF=${SIF:-$PWD/proofbench-sandbox.sif}
export MAX_SAMPLES=${MAX_SAMPLES:-$(( ${SLURM_CPUS_PER_TASK:-8} / 4 ))}   # 4 cores per problem in progress
export RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "${MODEL:?}" | tr '/:' '__')_search-${SEARCH:-false}_slurm${SLURM_JOB_ID:-}}
exec scripts/run.sh
