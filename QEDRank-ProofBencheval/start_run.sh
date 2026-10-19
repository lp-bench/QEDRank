#!/usr/bin/env bash
# One run of the ProofBench agent harness on this Windows PC (Docker Desktop sandbox).
cd "$(dirname "$0")"
source .venv/Scripts/activate
export PYTHONUTF8=1 MSYS_NO_PATHCONV=1
export QWEN_API_KEY="${GWDG_API_KEY:-$LLAMA_API_KEY}" QWEN_BASE_URL=https://chat-ai.academiccloud.de/v1
export IDS="P109 P110 P111" MODEL=openai-api/qwen/qwen3-30b-a3b-instruct-2507 MAX_SAMPLES=1
export RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)_qwen3-30b-a3b-instruct-2507_search-false_windows-docker
echo "$RUN_ID" > last_run_id.txt
scripts/run.sh > "run_$RUN_ID.log" 2>&1
echo "exit $?" >> "run_$RUN_ID.log"
