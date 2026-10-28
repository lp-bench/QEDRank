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

## Before any further run

2. **No Zenodo upload of broken runs.** Archive only runs that ended normally without
   infrastructure errors; `ZENODO=force` for exceptions.

## So anyone can test their own agent

4. **A grading script.** It grades a folder of `Pxxx.lean` proofs made by any agent or person
   with both layers in the sandbox and writes `results.csv`. It generalises
   `scripts/verify_comparator.sh`; later the website could call it.

## Usability and the paper

5. **Paper tables generated from `results.csv`:** the per-problem and summary tables as LaTeX,
   instead of copying numbers by hand.
6. **Automatic flags for search runs:** with web search on, mark P001, P004, P008, P027, P054,
   P084 and P092, whose complete Lean proofs are public.
7. **Port the fork's conveniences:** the message-limit setting (`MESSAGE_LIMIT`), the image build
   working on Windows (UTF-8 and LF line ends), and the Git-Bash helpers for a Windows PC with
   Docker Desktop (`start_run.sh`, `start_run_selfhosted.sh`, `verify_one.sh`, with their
   `.gitignore` entries).

## Housekeeping

8. **Delete `QEDRank-ProofBencheval/`** once 7 is ported; that is its last remaining advantage.
9. **Move the sandbox images (`*.sif`) and `.env` into `QEDRank-eval/`** from the old harness
   folder, now `the_workspace/OLD_CODE/eval/`. The old `eval` and `inspect-apptainer` folders are
   in `the_workspace/OLD_CODE/`; archive their GitHub repos read-only rather than deleting them
   (old run records cite their commits).
10. **Move inspectAI-apptainer's GitHub tests** into this repository's top-level
    `.github/workflows/`; workflows in a subfolder do not run.
11. **Before publishing:** check for private material, write a visitor README that credits
    QEDRank, and make inspect-apptainer public together with this repository.

## Still pending

- **GLM rerun** of P036, P022 and P099 (or P014 instead of P099) with the new limits, run from
  `QEDRank-eval/` once 9 is done.
- **Paper:** `main.tex` still gives the handoff note 8,000 tokens; the harness now uses 32,000.
