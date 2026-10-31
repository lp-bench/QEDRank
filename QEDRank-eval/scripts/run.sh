#!/usr/bin/env bash
# One evaluation run. SANDBOX=apptainer (default) needs Apptainer, the inspect-apptainer package
# (scripts/setup.sh) and the .sif from scripts/build_image.sh --apptainer or --sif;
# SANDBOX=docker needs Docker and the image from scripts/build_image.sh.
# usage: IDS="P083 P088 P090" MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=false scripts/run.sh
# The whole script is one block, read before it runs: editing run.sh during a run (bash
# otherwise reads on from a byte offset) cannot break that run.
{
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=${MODEL:?e.g. anthropic/claude-opus-5, openai/gpt-5.6, google/gemini-3.1-pro}
EFFORT=${EFFORT-xhigh}             # low|medium|high|xhigh|max, recorded in manifest; EFFORT= (empty) sends none, e.g. for open models
SEARCH=${SEARCH:-false}            # true -> web search (proofbench_eval/search.py)
# tavily (every model): plain results, no AI-written answer; anthropic: Claude's built-in search (basic version)
SEARCH_PROVIDER=${SEARCH_PROVIDER:-tavily}
NETWORK=${NETWORK:-$SEARCH}        # sandbox internet; default: only when search is on
SANDBOX=${SANDBOX:-apptainer}      # apptainer | docker
SIF=${SIF:-proofbench-sandbox.sif} # image for the apptainer sandbox
COMPARATOR=${COMPARATOR:-on}       # on | off: Comparator as the second grading layer
EPOCHS=1  # one attempt per model and problem: a problem is never restarted from scratch
# Sessions with handoff: the output-token budget ends a session; the others are safety caps.
SESSIONS=${SESSIONS:-4}
SESSION_OUTPUT_TOKENS=${SESSION_OUTPUT_TOKENS:-120000}
SESSION_TOKENS=${SESSION_TOKENS:-40000000}     # safety cap on all tokens of a session: every step resends the context (mostly cache reads); 4M ended a session at 34k output, a step-heavy session reaching 120k output needs about 30M
SESSION_WORKING_TIME=${SESSION_WORKING_TIME:-5400}
TOOL_TIMEOUT=${TOOL_TIMEOUT:-1800}       # seconds per bash/python call, stated in the prompt; the call ends with everything it started
NOTE_TOKENS=${NOTE_TOKENS:-32000}
MAX_TOKENS=${MAX_TOKENS:-64000}           # cap per model reply, a safety cap (Opus pilot: at most 31k); about half of SESSION_OUTPUT_TOKENS
REQUEST_TIMEOUT=${REQUEST_TIMEOUT:-3600}  # no retry of a model request starts after this many seconds
ATTEMPT_TIMEOUT=${ATTEMPT_TIMEOUT:-2400}  # seconds per single attempt of a request (a 64k reply can take over 20 min)
MAX_RETRIES=${MAX_RETRIES:-8}             # retries of a failing request (waits from 3 s, doubling: 8 = about 13 min)
PROVIDER_RETRIES=${PROVIDER_RETRIES:-2}   # a session ended by a provider error is started again this often, uncounted
PROVIDER_BACKOFF=${PROVIDER_BACKOFF:-30}  # seconds before such a retry, times the retry count
MAX_SAMPLES=${MAX_SAMPLES:-4}             # problems in parallel (one model connection and one sandbox each)
TAGS=${TAGS:-proofbench}                  # Inspect log tags, e.g. TAGS=proofbench,pilot
ZENODO=${ZENODO:-on}                      # on | off | force: archive the run on Zenodo when it ends (on: only if complete)
# INSPECT_DISPLAY=conversation makes Inspect run one sample at a time; use `inspect view` to follow runs.
export INSPECT_DISPLAY=${INSPECT_DISPLAY:-plain}
[ "$INSPECT_DISPLAY" = conversation ] && echo "note: conversation display runs one sample at a time" >&2
if [ "$SANDBOX" = apptainer ]; then IMAGE=$(sha256sum "$SIF" | cut -c1-16); else IMAGE=; fi
TIME_LIMIT=${TIME_LIMIT:-$((SESSIONS * SESSION_WORKING_TIME * 3))}  # wall clock per problem, all sessions
IDS=${IDS:?problems to run, e.g. IDS="P083 P088 P090"}
RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$(echo "$MODEL" | tr '/:' '__')_search-${SEARCH}}
LOG_DIR=logs/$RUN_ID
# One folder per run.
if [ -e "$LOG_DIR" ]; then echo "error: $LOG_DIR already exists; choose another RUN_ID" >&2; exit 1; fi

# Succeeds when the run is complete: run.sh got to the end and every problem has a verdict
# (C or I in results.csv); otherwise prints why not and fails.
complete_run() {
  [ "$1" = 0 ] || { echo "the run stopped with exit status $1"; return 1; }
  python3 - "$LOG_DIR/results.csv" ${IDS//,/ } <<'PY'
import csv, sys
from pathlib import Path
path, ids = Path(sys.argv[1]), set(sys.argv[2:])
if not path.exists():
    sys.exit(print("no results.csv") or 1)
done = {r["problem"] for r in csv.DictReader(path.open()) if r.get("status") in ("C", "I")}
if ids - done:
    sys.exit(print("no verdict for " + " ".join(sorted(ids - done))) or 1)
PY
}

# At exit: checksums of the run's files, then the Zenodo archive (README, "Records").
checksums() {
  local status=$?
  if [ -d "$LOG_DIR" ]; then
    (
      cd "$LOG_DIR"
      files=()
      for f in manifest.json *.eval results.csv; do [ -e "$f" ] && files+=("$f"); done
      if [ ${#files[@]} -gt 0 ]; then
        sha256sum "${files[@]}" > SHA256SUMS
        echo "== checksums written to $LOG_DIR/SHA256SUMS (exit status $status):"
        cat SHA256SUMS
      fi
    )
    # Archive the run on Zenodo (skipped without a token, or with ZENODO=off). An incomplete run
    # (stopped early, or a problem without a verdict: provider failure N, sample error) is
    # archived only with ZENODO=force; it can still be archived later by hand.
    if [ "$ZENODO" = off ]; then
      echo "== Zenodo: skipped (ZENODO=off)"
    elif [ ! -e "$LOG_DIR/SHA256SUMS" ]; then
      :
    elif [ "$ZENODO" != force ] && ! why=$(complete_run "$status"); then
      echo "== Zenodo: skipped, the run is incomplete: $why"
      echo "   to archive it anyway: python3 scripts/zenodo_publish.py $LOG_DIR $RUN_ID"
    else
      python3 scripts/zenodo_publish.py "$LOG_DIR" "$RUN_ID" || true
    fi
  fi
  exit "$status"
}
trap checksums EXIT

python3 scripts/manifest.py "$LOG_DIR" model="$MODEL" effort="$EFFORT" search="$SEARCH" \
  search_provider="$SEARCH_PROVIDER" network="$NETWORK" epochs="$EPOCHS" sessions="$SESSIONS" \
  session_output_tokens="$SESSION_OUTPUT_TOKENS" session_tokens="$SESSION_TOKENS" \
  session_working_time="$SESSION_WORKING_TIME" tool_timeout="$TOOL_TIMEOUT" note_tokens="$NOTE_TOKENS" max_tokens="$MAX_TOKENS" \
  request_timeout="$REQUEST_TIMEOUT" attempt_timeout="$ATTEMPT_TIMEOUT" max_samples="$MAX_SAMPLES" time_limit="$TIME_LIMIT" ids="$IDS" sandbox="$SANDBOX" comparator="$COMPARATOR" \
  max_retries="$MAX_RETRIES" provider_retries="$PROVIDER_RETRIES" provider_backoff="$PROVIDER_BACKOFF" ${IMAGE:+image="$IMAGE"}

inspect eval proofbench_eval/task.py@proofbench \
  --model "$MODEL" ${EFFORT:+--reasoning-effort "$EFFORT"} \
  -T ids="$IDS" -T sandbox="$SANDBOX" -T sif="$SIF" -T network="$NETWORK" \
  -T search="$SEARCH" -T search_provider="$SEARCH_PROVIDER" \
  -T sessions="$SESSIONS" -T session_output_tokens="$SESSION_OUTPUT_TOKENS" \
  -T session_tokens="$SESSION_TOKENS" -T session_working_time="$SESSION_WORKING_TIME" -T tool_timeout="$TOOL_TIMEOUT" \
  -T note_tokens="$NOTE_TOKENS" -T comparator=$([ "$COMPARATOR" = on ] && echo true || echo false) \
  -T provider_retries="$PROVIDER_RETRIES" -T provider_backoff="$PROVIDER_BACKOFF" \
  --epochs "$EPOCHS" --max-tokens "$MAX_TOKENS" --timeout "$REQUEST_TIMEOUT" --attempt-timeout "$ATTEMPT_TIMEOUT" --time-limit "$TIME_LIMIT" \
  --max-retries "$MAX_RETRIES" \
  --max-samples "$MAX_SAMPLES" --max-connections "$MAX_SAMPLES" --max-sandboxes "$MAX_SAMPLES" \
  --model-cost-config data/model_prices.yml \
  --log-dir "$LOG_DIR" --tags "$TAGS" --metadata run_id="$RUN_ID"

python3 scripts/analyze.py "$LOG_DIR"
# The final submissions as Lean files in $LOG_DIR/proofs/ (derived from the .eval log: not
# checksummed, not archived); a failure here does not mark the run incomplete.
python3 scripts/extract_proofs.py "$LOG_DIR" || echo "== proof extraction failed; rerun scripts/extract_proofs.py $LOG_DIR"
exit
}
