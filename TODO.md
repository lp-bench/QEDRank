# To-do

Harness work in this repository, as of 2026-10-28.

## Done

- Theorem names follow Lean's scoping: P039, P105, P106 and P108 were ungradeable (ported from
  the QEDRank fork; checked in Lean for all 149 statement files).
- `QEDRank-eval/scripts/setup.sh`: one command builds the Python environment with the bundled
  `inspectAI-apptainer/` and the harness, also after the folder is moved or renamed.
- Provider errors (ported from the QEDRank fork): a session ended by a rate limit, server or
  connection error is started again without counting; a used-up account budget (GWDG's daily
  limit, a quota, the credit) stops the problem at once; an unsolved problem stopped this way is
  scored NOANSWER (status `N`), not INCORRECT. Inspect retries a failing request at most 8 times
  (`MAX_RETRIES`, about 13 min) instead of up to an hour. Test: `tests/provider_errors_run.py`.
- Statement check (ported from the QEDRank fork): layer 1 compares the main theorem's statement
  up to the first `:=` outside brackets, so a named argument such as P102's former `(F := F)` no
  longer hides the rest of the statement. No image rebuild needed: `check_proof.py` is sent to the
  sandbox from this repository at grading time.
- Windows: `build_image.sh` writes its staged files as UTF-8 with LF line ends (ported from the
  QEDRank fork; the Linux output is byte-identical), `setup.sh` finds `.venv/Scripts`, and the
  README has a section for Windows (Git Bash with Docker Desktop). Not ported, by decision: the
  fork's `MESSAGE_LIMIT` (no cap on the agent's tool calls) and its personal helper scripts.
- No Zenodo upload of incomplete runs: `run.sh` archives a run only when it got to the end with a
  verdict (C or I) for every problem; otherwise it says why and skips, and `ZENODO=force` archives
  anyway. Apptainer is the default sandbox (`SANDBOX=docker` for Docker).
- The sandbox image lives in `QEDRank-eval/proofbench-sandbox.sif` (statements c2a314b, id
  005029c58d207730).
- `QEDRank-ProofBencheval/` removed: everything it had is in `QEDRank-eval/` or left out by decision.
- `QEDRank-eval/` is self-contained for runs: `.env` (API keys, Zenodo token) moved here from the old
  harness folder (now `the_workspace/OLD_CODE/eval/`, with the older images); the old GitHub repos
  proofbench-eval-apptainer and inspect-apptainer were no longer reachable on 2026-10-28, but every
  commit that run records cite is in this repository's history, and the links point here now.

## So anyone can test their own agent

4. **A grading script.** It grades a folder of `Pxxx.lean` proofs made by any agent or person
   with both layers in the sandbox and writes `results.csv`. It generalises
   `scripts/verify_comparator.sh`; later the website could call it.

## The paper's results section

5. **Paper tables generated from `results.csv`:** the per-problem and summary tables as LaTeX,
   instead of copying numbers by hand.

Additions to `scripts/stats.py` modelled on QEDRank's statistics code (the JavaScript in
`QEDRank_java/qedrank/lib/` up to commit 0b097f7, and in github.com/vaibhav-baj/QEDRank):

5a. **Solved within k sessions** per model (k = 1, 2, 4, ..., the session limit) and the median
    number of sessions to a solve: how much the extra sessions help.
5b. **Hand-audit records:** a file of audit verdicts that `stats.py` reads, so a solve rejected in
    the hand audit no longer counts anywhere.
5c. **Effort by difficulty:** median tokens, time and sessions per category (calibration, research,
    open) and model; the paper's planned analysis (ii).
5d. **Failure classes:** why unsolved attempts failed (does not compile, `sorry` left, statement
    altered, budget used up, provider), from the logs.
5e. **Cochran's Q:** one test of whether the models differ at all, before the pairwise McNemar
    tests.

## Usability

6. **Automatic flags for search runs:** with web search on, mark P001, P004, P008, P027, P054,
   P084 and P092, whose complete Lean proofs are public.

## Housekeeping

10. **Move inspectAI-apptainer's GitHub tests** into this repository's top-level
    `.github/workflows/`; workflows in a subfolder do not run.
11. **Before publishing:** check for private material, and write a visitor README that credits
    QEDRank (the Apptainer sandbox becomes public with this repository, as it lives in it).

## Still pending

- **Opus pilots done** (2026-10-28, $10.50 together, `EFFORT=xhigh`, 4 sessions, 40k per reply,
  120k per session): P014, P034, P017, P019, P011, P012 solved, each in its first session
  (max reply 31k, max session output 71k); P115 (open) unsolved after 4 sessions, $3.29. Its
  session 2 ended on the 4M session total at 34k output, so `SESSION_TOKENS` is now 40M (a step-heavy session reaching 120k output needs about 30M). Before
  the official runs: one more check that a session ends on its 120k output budget, and the
  objection channel (`FALSE:`) with a real model.
  Open models: pass `EFFORT=` (empty), since they may not accept `xhigh`.
- **Harness for the official runs (2026-10-29):** the prompts no longer say how many sessions
  there are, the last session writes a handoff note too, and an unsolved attempt keeps a
  snapshot of the files the agent changed. Plan: run all problems with 4 sessions first; if the
  budget allows, continue unsolved problems later with more sessions. Still to build before
  such a continuation: a `continue from LOG_DIR` option (restore the snapshot and the last
  note, number the sessions on) and merging both stages in results.csv. Per reply 64k, request
  attempts 40 min.
- **Search (2026-10-29):** every model gets the plain Tavily tool (proofbench_eval/search.py, no
  AI answer), so that Claude, GLM and Kimi are comparable. The Fable pilot of 2026-10-29 used
  Claude's built-in search instead: before the official runs, a short check of Claude with
  Tavily (one or two problems), and a Tavily plan sized from the number of searches per problem
  (the Fable pilot made 5 searches on 4 problems; the account's free plan has 1,000 a month:
  turn on pay-as-you-go with a cap). Done 2026-10-31: used-up search credits or a rejected key
  (Tavily HTTP 432/433/401) end the session and score the problem NOANSWER, like a used-up
  model budget, instead of the agent working on without search (`SearchUnavailable` in
  search.py; tests `tests/search_guard.py`, `tests/search_quota_run.py`). `MAX_SAMPLES` now also
  sets `--max-connections` and `--max-sandboxes`.
- **Tool time limit (done 2026-10-29):** 30 minutes per bash/python call (`TOOL_TIMEOUT`, was
  10), stated in the prompt; the call ends with everything it started (sandbox watchdog).
- **Constructive track (P117):** the harness reads `permitted_axioms` from the statements
  database (both grading layers and the prompt). Still to do: export P117 to the statements
  repo (needs `permitted_axioms` in its database, and a decision whether the benchmark has 117
  problems), then drop "The grader does not enforce this yet" from P117's docstring.
- **Before the Fable pilot:** discuss harder research problems (Opus solved all four research
  problems of the pilot in one session), e.g. recent results from JCT.
- **GLM rerun** of P036, P022 and P099 (or P014 instead of P099) with the new limits, run from
  `QEDRank-eval/` (ready: `.env` and the image are in place). Done for P101 on 2026-10-31
  (`logs/pilot_20261031T101148Z_glm-5.3-flash_search-true`, Tavily search on, not archived):
  solved in 2 sessions, 30 min, 165k output tokens, 41 model calls; in the first pilot P101 failed
  after 8 sessions, 3.5 h and 707k output tokens, every one of its 13 cut-off replies being 32k
  tokens of thinking with no text or tool call. Now one cut-off (the opening think, 64k tokens,
  10 min), then normal work; session 1 ended on the 120k budget with a `DecidableEq` error, the
  handoff note let session 2 finish in 400 s. GLM never used the search tool. Still open: P036,
  P022, P099 or P017 (the other cut-off case) if a second data point is wanted.
- **Paper:** `main.tex` still gives the handoff note 8,000 tokens; the harness now uses 32,000.
