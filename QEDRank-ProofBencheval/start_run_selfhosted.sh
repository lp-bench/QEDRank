#!/usr/bin/env bash
# ProofBench agent harness on this PC (Docker sandbox) against Qwen3 served by vLLM on the HPC,
# reached through an SSH tunnel on 127.0.0.1:8000. The key comes from the environment
# (QWEN_API_KEY, set in PowerShell from the HPC's ~/.vllm_key); nothing is written to disk.
# Optional: IDS (default P109 P110 P111), MAX_SAMPLES (default 2), VLLM_LABEL (e.g. vllm0.11).
set -euo pipefail
cd "$(dirname "$0")"
source .venv/Scripts/activate
: "${QWEN_API_KEY:?set QWEN_API_KEY first (see the PowerShell steps)}"
export PYTHONUTF8=1 MSYS_NO_PATHCONV=1
export QWEN_BASE_URL=${QWEN_BASE_URL:-http://127.0.0.1:8000/v1}
export IDS=${IDS:-P109 P110 P111} MAX_SAMPLES=${MAX_SAMPLES:-2}
export MODEL=openai-api/qwen/qwen3-30b-a3b-instruct-2507
export RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)_qwen3-30b-a3b-instruct-2507_selfhosted-bf16-${VLLM_LABEL:-vllm}_windows-docker
echo "$RUN_ID" > last_run_id.txt
scripts/run.sh > "run_$RUN_ID.log" 2>&1
echo "exit $?" >> "run_$RUN_ID.log"
