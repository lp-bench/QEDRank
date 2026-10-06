#!/usr/bin/env bash
#SBATCH --job-name=proofbench-eval
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=12:00:00
#SBATCH --output=logs/slurm-%j.out
# One evaluation run on a Slurm cluster without Docker: Inspect runs inside the
# Apptainer image with the "local" sandbox, so tool calls stay in the container.
# Needs: the .sif from scripts/build_apptainer.sh, API keys in $HOME/.proofbench_keys
# (export ANTHROPIC_API_KEY=... etc.), and outbound HTTPS from the node (or
# HTTPS_PROXY set).  For a self-hosted model use MODEL=openai-api/kimi/<name>
# with OPENAI_API_BASE pointing at the vLLM server on the GPU node.
set -euo pipefail
# Disabled: the agent's commands run in the same container as Inspect, with this
# repo mounted at /work, so it could read data/ (all statements), .env, logs/ and
# the API keys.  Re-enable only once the Apptainer sandbox (ROADMAP 10-12) exists.
echo "slurm_eval.sbatch is disabled until the Apptainer sandbox exists (see ROADMAP.md)" >&2
exit 1
cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")/..}"
module load apptainer 2>/dev/null || true
source "$HOME/.proofbench_keys"
SIF=${SIF:-$HOME/proofbench-sandbox.sif}
MODEL=${MODEL:?}
EFFORT=${EFFORT:-}
SEARCH=${SEARCH:-false}
EPOCHS=1  # one attempt per model and problem: a problem is never restarted from scratch
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "$MODEL" | tr '/:' '__')_search-${SEARCH}}
LOG_DIR=logs/$RUN_ID
python3 scripts/manifest.py "$LOG_DIR" model="$MODEL" effort="$EFFORT" search="$SEARCH" \
  epochs="$EPOCHS" sandbox=local image="$(sha256sum "$SIF" | cut -c1-16)" slurm_job="${SLURM_JOB_ID:-}"
# --max-samples 1: with the local sandbox all samples share /opt/proofbench/Submission,
# so run them one at a time.  --writable-tmpfs gives the read-only image a scratch overlay.
apptainer exec --containall --writable-tmpfs --bind "$PWD":/work --pwd /work \
  --env-file "$HOME/.proofbench_keys" "$SIF" \
  inspect eval proofbench_eval/task.py@proofbench \
    --model "$MODEL" ${EFFORT:+--reasoning-effort "$EFFORT"} \
    -T ids="$IDS" -T sandbox=local -T search="$SEARCH" \
    --epochs "$EPOCHS" --max-samples 1 --token-limit 300000 --time-limit 7200 \
    --working-limit 3600 --log-dir "$LOG_DIR" --tags "proofbench,pilot,hpc"
python3 scripts/analyze.py "$LOG_DIR"
