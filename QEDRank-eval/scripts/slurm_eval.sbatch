#!/usr/bin/env bash
#SBATCH --job-name=proofbench-eval
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=12:00:00
#SBATCH --output=logs/slurm-%j.out
# One evaluation run on a Slurm cluster without Docker.  Inspect runs on the node
# and starts one Apptainer instance per problem through the inspect-apptainer
# sandbox: no host environment (no API keys), no network, no host directories
# inside the instances; only the one problem file is copied in.
# Needs on the cluster: this repo with its .venv (pip install -e . -e ../inspect-apptainer),
# the proofbench clone (problem statements), proofbench-sandbox.sif (built with scripts/build_image.sh,
# any mode, then copied), API keys in .env, and outbound HTTPS from the node
# (or HTTPS_PROXY in .env).  For a self-hosted model (vLLM on a GPU node) use
# MODEL=openai-api/kimi/<served-name> with KIMI_BASE_URL=http://<node>:8000/v1 in .env.
set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")/..}"
module load apptainer 2>/dev/null || module load singularity 2>/dev/null || true
source .venv/bin/activate
export SANDBOX=apptainer
export SIF=${SIF:-$PWD/proofbench-sandbox.sif}
export MAX_SAMPLES=${MAX_SAMPLES:-$(( ${SLURM_CPUS_PER_TASK:-8} / 2 ))}   # 2 cores per sandbox
export RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "${MODEL:?}" | tr '/:' '__')_search-${SEARCH:-false}_slurm${SLURM_JOB_ID:-}}
exec scripts/run.sh
