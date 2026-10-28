# To-do

Harness work in this repository, as of 2026-10-28.

## Done

- Theorem names follow Lean's scoping: P039, P105, P106 and P108 were ungradeable (ported from
  the QEDRank fork; checked in Lean for all 149 statement files).
- `QEDRank-eval/scripts/setup.sh`: one command builds the Python environment with the bundled
  `inspectAI-apptainer/` and the harness, also after the folder is moved or renamed.

## Before any further run

1. **Port the provider-error fix.** A rate limit or outage no longer uses up a session; a problem
   that keeps failing counts as "not answered", not "failed". Also stop cleanly when GWDG's daily
   request limit runs out, instead of stalling for hours.
2. **No Zenodo upload of broken runs.** Archive only runs that ended normally without
   infrastructure errors; `ZENODO=force` for exceptions.
3. **Port the P102 statement-check fix.** Needs an image rebuild of about 15 minutes.

## So anyone can test their own agent

4. **A grading script.** It grades a folder of `Pxxx.lean` proofs made by any agent or person
   with both layers in the sandbox and writes `results.csv`. It generalises
   `scripts/verify_comparator.sh`; later the website could call it.

## Usability and the paper

5. **Paper tables generated from `results.csv`:** the per-problem and summary tables as LaTeX,
   instead of copying numbers by hand.
6. **Automatic flags for search runs:** with web search on, mark P001, P004, P008, P027, P054,
   P084 and P092, whose complete Lean proofs are public.
7. **Port the fork's conveniences:** the message-limit and retry settings, and the image build
   working on Windows.

## Housekeeping

8. **Delete `QEDRank-ProofBencheval/`** once 1, 3 and 7 are ported; those are its remaining fixes.
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
  `QEDRank-eval/` once 1 and 9 are done.
- **Paper:** `main.tex` still gives the handoff note 8,000 tokens; the harness now uses 32,000.
