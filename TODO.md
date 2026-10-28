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

- **Opus pilot** before the official runs: `IDS="P014 P034 P017 P019"` (two calibration problems with
  reference solutions, P017 unsolved by GLM, P019 a research problem with a 159-line reference
  solution), `SEARCH=false`, `ZENODO=off`, new defaults (`EFFORT=xhigh`, 4 sessions, 40k per reply, 120k per
  session, 4M session total, 90 min working time). Check `max_tokens_stops`, `session_ends` and
  cost per session in results.csv before the four official runs (4 sessions: about $11.7k worst case).
  Open models: pass `EFFORT=` (empty), since they may not accept `xhigh`.
- **GLM rerun** of P036, P022 and P099 (or P014 instead of P099) with the new limits, run from
  `QEDRank-eval/` (ready: `.env` and the image are in place).
- **Paper:** `main.tex` still gives the handoff note 8,000 tokens; the harness now uses 32,000.
