# Grading environment fix of 2026-11-02: lake's artifact cache and the Comparator

Found during the official runs (harness tag `official-v1`, commit 9e812aa, image
b41c11aaf9ec37f2…). Nothing in the harness code or the image changes; the runs from part 3
of the first configuration on carry one extra read-only mount, and the attempts graded
before that are re-graded offline with the same Comparator (see below).

## The defect

The Matroid package in the image (`utkuokur/Matroid`, rev e878b313) sets
`enableArtifactCache = true` and `restoreAllArtifacts = true` in its `lakefile.toml`. Lake
(Lean 4.34.1) then stores every artifact of a Matroid module in its artifact cache,
`$HOME/.cache/lake`, whenever it replays a build. The Comparator runs `lake build` inside a
Landlock sandbox (`landrun --ro / --rw /dev`, writable only the project's `.lake` directory)
with the environment stripped to `PATH`, `HOME`, `LEAN_ABORT_ON_PANIC`, so the cache write
fails ("failed to cache artifact: permission denied" or, where the attempt reaches the
read-only image, "read-only file system"), lake reports "build failed", and the Comparator
rejects the proof: the run records "fast check passed, comparator rejected".

Layer 1 (the fast check) is not affected: it runs without Landlock, and the sandbox's
home directory is a writable tmpfs. The model's session is not affected either.

Scope: every attempt whose Comparator build replays a Matroid module, i.e. the problems
whose statements import Matroid, **P002 and P015**, plus any proof that imports Matroid on
its own. In part 1 of the Fable configuration (run 20261101T123149Z…part1) this happened
once, P015: layer 1 passed with the standard axioms, the Comparator failed for this reason,
and the offline re-grade below accepts the proof. No other package in the image enables
the artifact cache (Mathlib only sets `restoreAllArtifacts`).

## The fix (environment only)

A pre-filled lake artifact cache, mounted read-only at `$HOME/.cache/lake` in every
sandbox. With the artifacts present lake writes nothing and the build replays. The cache
holds all 63 Matroid modules compiled into the image (built with `scripts/make_lakecache.sh`:
`lake build` of every Matroid module of the image plus the P002 and P015 statements, with
`HOME` under `.lake` so that lake may write, from a pristine copy of the Matroid build
directory, which the build leaves unchanged).

* `lakecache/lakecache-matroid-v1.tar.zst`, 14.9 MB, 504 files, 64 MB unpacked,
  sha256 `ad7f6bdef1450dae56dd295f7882ce98b9f6d80d8a40687dbe9812dcf3260f9e`
  (rebuilding from all 63 modules gives the identical cache: 2,125 jobs, 63 output entries).
* TUBAF: `APPTAINER_BIND=$HOME/proofbench/QED_Rank/QEDRank-eval/lakecache/lake:/home/<user>/.cache/lake:ro`
  exported in the job environment (Apptainer applies it to `instance start`); verified on
  the login node: the Comparator rejects P015 without the mount (16 cache errors) and
  accepts it with the mount.
* USC: `SINGULARITY_BIND` likewise; there Landlock is unavailable (kernel 3.10), the
  Comparator runs in best-effort mode and lake can write the tmpfs home, so the defect
  does not occur, and the mount only keeps the environments uniform.

Runs with the mount: Fable/search part 3 (job 9200, started 2026-11-02 06:34 CET) and all
later runs. Runs without: Fable/search parts 1 (job 9157) and 2 (job 9175).

## Offline re-grade

`scripts/comparator_offline.py RUN_DIR PROBLEM` re-runs the Comparator for one archived
attempt: the submission files and the Comparator configuration come from the run's Inspect
log, the image is the one in the manifest, the project build directory is seeded from the
image as in a run, and lake gets what the sandbox denied it: a writable copy of the Matroid
build directory and `HOME` under `.lake`. It writes `RUN_DIR/regrade/PROBLEM.json` (in-run
verdict, offline verdict, exit code, hashes of the files, command) and the full Comparator
output next to it. The archived run folders and their Zenodo versions stay unchanged; the
regrade records are released as a further Zenodo version, and the analysis reads them
(`REGRADE` records) so that tables show the corrected verdict with the original kept.
