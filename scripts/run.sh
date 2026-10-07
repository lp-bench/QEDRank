#!/usr/bin/env bash
# One evaluation run. SANDBOX=docker (default) needs Docker; SANDBOX=apptainer needs
# Apptainer, the inspect-apptainer package and the .sif from scripts/build_image.sh --sif.
# usage: IDS="P083 P088 P090" MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=false scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=${MODEL:?e.g. anthropic/claude-opus-5, openai/gpt-5.6, google/gemini-3.1-pro}
EFFORT=${EFFORT:-}                 # low|medium|high|xhigh|max (model-specific; recorded in manifest)
SEARCH=${SEARCH:-false}            # true -> web_search tool via SEARCH_PROVIDER
SEARCH_PROVIDER=${SEARCH_PROVIDER:-tavily}
NETWORK=${NETWORK:-$SEARCH}        # sandbox internet; default: only when search is on
SANDBOX=${SANDBOX:-docker}         # docker | apptainer
SIF=${SIF:-proofbench-sandbox.sif} # image for the apptainer sandbox
COMPARATOR=${COMPARATOR:-on}       # on | off: Comparator as the second grading layer
EPOCHS=1  # one attempt per model and problem: a problem is never restarted from scratch
# Sessions with handoff: the output-token budget ends a session; the others are safety caps.
SESSIONS=${SESSIONS:-10}
SESSION_OUTPUT_TOKENS=${SESSION_OUTPUT_TOKENS:-30000}
SESSION_TOKENS=${SESSION_TOKENS:-1000000}
SESSION_WORKING_TIME=${SESSION_WORKING_TIME:-1800}
NOTE_TOKENS=${NOTE_TOKENS:-8000}
MAX_TOKENS=${MAX_TOKENS:-16000}           # cap per model reply
REQUEST_TIMEOUT=${REQUEST_TIMEOUT:-1800}  # total seconds per model request, retries included
ATTEMPT_TIMEOUT=${ATTEMPT_TIMEOUT:-600}   # seconds per single attempt of a request
MAX_SAMPLES=${MAX_SAMPLES:-4}             # problems in parallel (Inspect's default here was 1)
if [ "$SANDBOX" = apptainer ]; then IMAGE=$(sha256sum "$SIF" | cut -c1-16); else IMAGE=; fi
TIME_LIMIT=${TIME_LIMIT:-$((SESSIONS * SESSION_WORKING_TIME * 3))}  # wall clock per problem, all sessions
IDS=${IDS:?problems to run, e.g. IDS="P083 P088 P090"}
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "$MODEL" | tr '/:' '__')_search-${SEARCH}}
LOG_DIR=logs/$RUN_ID

python3 scripts/manifest.py "$LOG_DIR" model="$MODEL" effort="$EFFORT" search="$SEARCH" \
  search_provider="$SEARCH_PROVIDER" network="$NETWORK" epochs="$EPOCHS" sessions="$SESSIONS" \
  session_output_tokens="$SESSION_OUTPUT_TOKENS" session_tokens="$SESSION_TOKENS" \
  session_working_time="$SESSION_WORKING_TIME" note_tokens="$NOTE_TOKENS" max_tokens="$MAX_TOKENS" \
  request_timeout="$REQUEST_TIMEOUT" attempt_timeout="$ATTEMPT_TIMEOUT" max_samples="$MAX_SAMPLES" time_limit="$TIME_LIMIT" ids="$IDS" sandbox="$SANDBOX" comparator="$COMPARATOR" ${IMAGE:+image="$IMAGE"}

inspect eval proofbench_eval/task.py@proofbench \
  --model "$MODEL" ${EFFORT:+--reasoning-effort "$EFFORT"} \
  -T ids="$IDS" -T sandbox="$SANDBOX" -T sif="$SIF" -T network="$NETWORK" \
  -T search="$SEARCH" -T search_provider="$SEARCH_PROVIDER" \
  -T sessions="$SESSIONS" -T session_output_tokens="$SESSION_OUTPUT_TOKENS" \
  -T session_tokens="$SESSION_TOKENS" -T session_working_time="$SESSION_WORKING_TIME" \
  -T note_tokens="$NOTE_TOKENS" -T comparator=$([ "$COMPARATOR" = on ] && echo true || echo false) \
  --epochs "$EPOCHS" --max-tokens "$MAX_TOKENS" --timeout "$REQUEST_TIMEOUT" --attempt-timeout "$ATTEMPT_TIMEOUT" --time-limit "$TIME_LIMIT" \
  --max-samples "$MAX_SAMPLES" --max-connections 4 --max-sandboxes 4 \
  --log-dir "$LOG_DIR" --tags "proofbench,pilot" --metadata run_id="$RUN_ID"

python3 scripts/analyze.py "$LOG_DIR"
