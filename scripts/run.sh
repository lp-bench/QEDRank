#!/usr/bin/env bash
# One evaluation run on a machine with Docker.
# usage: IDS="P083 P088 P090" MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=false scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=${MODEL:?e.g. anthropic/claude-opus-5, openai/gpt-5.6, google/gemini-3.1-pro}
EFFORT=${EFFORT:-}                 # low|medium|high|xhigh|max (model-specific; recorded in manifest)
SEARCH=${SEARCH:-false}            # true -> web_search tool via SEARCH_PROVIDER
SEARCH_PROVIDER=${SEARCH_PROVIDER:-tavily}
NETWORK=${NETWORK:-$SEARCH}        # sandbox internet; default: only when search is on
EPOCHS=1  # one attempt per model and problem: a problem is never restarted from scratch
TOKEN_LIMIT=${TOKEN_LIMIT:-300000}
TIME_LIMIT=${TIME_LIMIT:-7200}     # seconds of wall clock per sample
WORKING_LIMIT=${WORKING_LIMIT:-3600}
IDS=${IDS:?problems to run, e.g. IDS="P083 P088 P090"}
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "$MODEL" | tr '/:' '__')_search-${SEARCH}}
LOG_DIR=logs/$RUN_ID

python3 scripts/manifest.py "$LOG_DIR" model="$MODEL" effort="$EFFORT" search="$SEARCH" \
  search_provider="$SEARCH_PROVIDER" network="$NETWORK" epochs="$EPOCHS" token_limit="$TOKEN_LIMIT" \
  time_limit="$TIME_LIMIT" working_limit="$WORKING_LIMIT" ids="$IDS" sandbox=docker

inspect eval proofbench_eval/task.py@proofbench \
  --model "$MODEL" ${EFFORT:+--reasoning-effort "$EFFORT"} \
  -T ids="$IDS" -T sandbox=docker -T network="$NETWORK" \
  -T search="$SEARCH" -T search_provider="$SEARCH_PROVIDER" \
  --epochs "$EPOCHS" --token-limit "$TOKEN_LIMIT" --time-limit "$TIME_LIMIT" \
  --working-limit "$WORKING_LIMIT" --max-connections 4 --max-sandboxes 4 \
  --log-dir "$LOG_DIR" --tags "proofbench,pilot" --metadata run_id="$RUN_ID"

python3 scripts/analyze.py "$LOG_DIR"
