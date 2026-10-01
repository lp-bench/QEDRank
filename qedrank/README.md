# QEDRank — batch benchmark mode

QEDRank extends the single-problem ProofBench workflow (one natural-language
problem → five LLMs) into a batch benchmark over a corpus of research papers.
For every paper it evaluates each of the project's five models on the
**main theorem**, **upper bound**, **lower bound** and an optional **disproof**
target, always against that paper's audited ground-truth Lean statement.

Everything that talks to a model, compiles Lean or compares statements runs on
your machine through `node qedrank/cli.js`. The web app's *QEDRank benchmark*
tab previews a corpus (`/api/qedrank/discover`) and renders finished or
in-progress runs.

## Contents

- [Quick start](#quick-start)
- [What is measured](#what-is-measured)
- [Corpus layout and annotations](#corpus-layout-and-annotations)
- [Run directory and resume](#run-directory-and-resume)
- [Configuration](#configuration)
- [Expert review inputs](#expert-review-inputs)
- [Isolation and safety policy](#isolation-and-safety-policy)
- [Statistics](#statistics)
- [Known limitations](#known-limitations)

## Quick start

```bash
npm install                      # adds pdfjs-dist for PDF text extraction

# 1. Lean sandbox (pinned toolchain + Mathlib). Needs elan (https://github.com/leanprover/elan).
cd lean && lake update && lake exe cache get && lake build && cd ..
node qedrank/cli.js toolchain    # must report available=true, mathlib_built=true, audit_built=true

# 2. Provider keys: the same five variables the single-problem mode uses
#    GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY, MISTRAL_API_KEY
#    (optional: QEDRANK_MODEL_<PROVIDER> pins a model id; GITHUB_TOKEN raises API limits)

# 3. Preview the corpus (no model calls)
node qedrank/cli.js discover --repo https://github.com/<owner>/<corpus> --ref main --out manifest.json

# 4. Run the benchmark at an immutable commit (defaults: pass@1, temperature 0)
node qedrank/cli.js run --repo https://github.com/<owner>/<corpus> --ref <sha-or-tag> --run-id my-run

# 5. Explore: serve runs to the web app (npm run dev → "QEDRank benchmark" tab → Load a run)
node qedrank/cli.js serve        # http://127.0.0.1:8787/runs
```

Useful options for `run`: `--models gemini,openai` · `--papers p001,p002` ·
`--targets main_theorem,upper_bound` · `--limit 10` · `--attempts k` ·
`--repair-rounds r` · `--concurrency n` · `--dry-run` (discovery + preparation
only) · `--fixtures DIR` (replay canned responses, see `qedrank/test/fixtures`).
`resume --run-id X [--retry-failed] [--reevaluate]` continues an interrupted run
without repeating completed items. `stats --run-id X` recomputes the summary and
exports only.

Try it without credentials or a corpus:

```bash
node qedrank/cli.js run --path qedrank/test/fixtures/corpus-a \
  --fixtures qedrank/test/fixtures/corpus-a/fixture-responses --run-id fixture-demo
```

## What is measured

Two tracks are kept apart, per model *m*, paper *p*, target *t*, always on the
pair `(ground_truth[p,t], model_output[m,p,t])`:

| Measurement | Definition | Denominator |
|---|---|---|
| **GT-faithful statement** | model's part-A statement is `definitionally_identical`, `equivalent` (both implications proved by bounded automation, each using its hypothesis, without the target being provable outright) or `expert_confirmed_equivalent` to the audited reference statement | statement-track eligible: reference statement elaborates; open claims included |
| **Compile** | the ORIGINAL part-B file compiles under the pinned toolchain within the resource limits | files that were submitted and passed the static screen |
| **Audit clean** | target declaration depends only on `propext`, `Classical.choice`, `Quot.sound`; no `sorryAx`, no user axioms, no `native_decide` (`Lean.ofReduceBool`), no `unsafe` | compiled files |
| **Verified pass@1** (primary endpoint on `main_theorem`) | compile ∧ audit clean ∧ GT-faithful ∧ the proof file proves the same statement as part A | proof-track eligible: statement-track eligible and the claim is `established` (or a `refuted` disproof) |
| Sandwich coverage | all three of main/upper/lower model statements are accepted matches and every declared bridge check has review status `passed` | papers whose three references are all audited |
| pass@k / repair | separate settings with identical k / repair budget for every model | same as verified |

Everything else is reported alongside, never folded into a score: statement
match distribution (`stronger`/`weaker`/`different` come only from expert
review; automated failure to find an equivalence is `unresolved`), abstention,
timeouts, infrastructure failures (excluded from every denominator and counted),
RMS calibration error with reliability bins for both confidence estimates,
observed latency / Lean time / total time (median, IQR, p90, timeout count over
all attempts), tokens and cost (only when the provider reports usage and
`pricing` is configured), and lines of code (rule stated in every record).
Apparent proofs of `open` claims are listed under `coverage.open_claim_escalations`
for independent review and never counted as successes.

## Repository links, private repositories and deployment

The corpus input is a GitHub repository, branch or folder link:
`https://github.com/<owner>/<repo>`, `https://github.com/<owner>/<repo>/tree/<branch-or-tag>`,
or `…/tree/<branch>/<folder>` (branch names may contain `/`; the longest prefix that is a real
ref is the branch and the rest is the folder that holds the paper folders). An explicit
`--ref` / "Branch, tag or commit" field overrides the link and `--subdir` / "Sub-folder" sets the
folder directly. Every run records the resolved commit SHA and the folder.

Example for a ProofBench-style repository (`PROBLEMS/Pnnn/{Pnnn.lean, Pnnn_UB.lean, Pnnn_LB.lean, Pnnn_DISPROVE.lean, *.pdf}`
plus `DATABASE/Database.json` and `DATABASE/content/pdf/Pnnn.pdf`):
`https://github.com/<owner>/ProofBench/tree/<branch>/ProofBench/PROBLEMS`. The index JSON
supplies titles, MSC codes and difficulty (its formal statements and proofs are never copied);
`Pnnn.pdf` files elsewhere in the repository are attached to the matching paper and flagged.

Index entries are joined to folders by the theorem names declared in the folder's main Lean
file, then by an id embedded in those names, then by the folder number, and are **accepted only
when the entry's title agrees with the folder's own evidence** (a `Paper: …` header in the main
Lean file, or informative PDF file names). Agreement needs two distinctive shared words, after
ignoring words that occur in many index titles. A contradicted entry is recorded under
`index_entry_rejected`, flagged `index_entry_conflicts_with_folder_content`, and its title,
subject and status are not used; the entry whose title the folder does describe is used
instead when one matches clearly (`join_rule: title_match`). This protects against folders
that were renumbered after the index was written.

| Situation | Web preview (Vercel) | Local runner (`node qedrank/cli.js …`) |
|---|---|---|
| Public repository | works as is | works as is |
| Private repository, HTTPS | paste a fine-grained GitHub token with read access to *Contents* in the "GitHub token" field (sent with that request only, never stored). A server-side `GITHUB_TOKEN` in the Vercel project also works, but then **anyone who can open the deployment can preview that private repository**: only do this behind Vercel Deployment Protection | `--token <PAT>` or `GITHUB_TOKEN` in the environment (the token is never written to `run.json`) |
| Private repository, SSH key / deploy key | not possible from a browser or a serverless function | `--repo git@github.com:<owner>/<repo>.git`: the runner shallow-clones with your own SSH agent or deploy key, resolves the commit, and reads the clone like a local directory; hooks and lakefiles of the clone are never executed |

Deploying the web app to Vercel (`vercel.json` is included; the preview function gets a 60 s
budget): import the GitHub repository in Vercel or run `vercel deploy --prod` from the
checkout. Add the five provider keys (and optionally `GITHUB_TOKEN`) as environment variables
in the Vercel project. Only the preview endpoint runs on Vercel; generation, Lean checking and
evaluation always run locally and are loaded into the page from `node qedrank/cli.js serve`
or from downloaded `summary.json` / `run.json` / `exports/items.json` files.

## Corpus layout and annotations

Discovery (`qedrank/lib/corpus.js`) accepts either a directory per paper or a
flat directory of PDFs. Lean files are classified by path tokens
(`main`/`theorem`, `upper`/`ub`, `lower`/`lb`, `disprove`/`counterexample`…);
`Defs.lean`, `Common.lean`, `Prelude.lean`… are treated as shared definition
files. Anything ambiguous (two files for one kind, no theorem found, several
theorems, a `DISPROVE` file with unconfirmed polarity, a reference containing
`sorry`) is flagged in `manifest.json` under `papers[].flags` and
`targets[].mapping_flags`. The expected paper count (108 by default) is only
compared against, never assumed: see `counts.expected_count_matches`.

Optional `metadata.json` / `paper.json` / `*.bib` / `README.md` in the paper
folder supply title, citation and `mathematical_status`. A repository-level
`qedrank-annotations.json` (or `--annotations file`) carries reviewed labels:

```json
{
  "papers": {
    "<paper_id>": {
      "title": "...", "citation": "...",
      "subject_tags": ["05A", "11B"], "difficulty": "medium", "requires_figures": false,
      "targets": {
        "main_theorem": { "mathematical_status": "established", "declaration_name": "main_thm",
                          "lean_path": "papers/x/Main.lean", "source_locator": { "section": "3", "page": 4 } },
        "disproof":     { "mathematical_status": "refuted" }
      },
      "bridge_checks": [ { "name": "upper_implies_main", "status": "passed", "reviewer": "..." } ]
    }
  }
}
```

`mathematical_status` defaults to `uncertain`, which keeps the item in the
statement track but out of the proof track.

## Run directory and resume

```
runs/<run_id>/
  run.json                 config snapshot, source commit, toolchain, models, stage status
  manifest.json            discovery output
  progress.json            counts per stage (polled by the UI)
  prepared/<paper>/        paper.pdf, pages.json, context__<kind>.txt, prelude.lean,
                           reference__<kind>.json, reference_statement__<kind>.lean, lean/ scratch
  items/<key>/             prompt-*.txt, response-*.txt, proof-*.lean, statement-*.lean,
                           compare-*.lean, attempt-a<k>r<r>.json, lean/ scratch
  results.json             every attempt record (qedrank-results-v1)
  summary.json             matrices, CIs, tests, calibration, subgroups (qedrank-summary-v1)
  exports/                 items.csv, items.json, matrix.csv, matrix.json
```

`resume` skips papers with `prepared/<paper>/done.json` and items whose
`attempt-*.json` has `evaluation_complete: true`; `--retry-failed` re-runs
infrastructure failures, `--reevaluate` re-runs Lean evaluation on stored
responses without calling models again. The source commit is re-resolved and
must match the run.

## Configuration

`qedrank.config.json` (optional, git-ignored) overrides the defaults in
`qedrank/lib/config.js`:

```json
{
  "generation": { "temperature": 0, "maxTokens": 4096, "timeoutMs": 180000, "attempts": 1, "repairRounds": 0 },
  "lean": { "timeoutMs": 600000, "memoryMb": 8192, "maxHeartbeats": 400000, "concurrency": 2 },
  "concurrency": { "items": 2 },
  "context": { "maxChars": 24000 },
  "bootstrap": { "B": 2000, "seed": 20260930 },
  "exploratoryThreshold": 10,
  "pricing": { "gpt-4": { "input": 30, "output": 60 } },
  "expectedPaperCount": 108
}
```

## Expert review inputs

Put reviewer decisions under `runs/<run_id>/review/` and re-run `stats` (or
`resume --reevaluate` for context/prelude changes):

- `decisions.json` — `{ "<paper>__<kind>__<provider>": { "statement_match": "weaker", "reviewer": "…", "note": "…", "date": "…" } }`
  overrides the automated classification (allowed: `expert_confirmed_equivalent`, `stronger`, `weaker`, `different`, `unresolved`).
- `reference-defects.json` — `{ "reviewed_references": ["p__main_theorem"], "reference_defects": [ { "reference": "p__main_theorem", "type": "missing_hypothesis", "reason": "…", "correction": true, "original_sha256": "…", "corrected_sha256": "…" } ] }`.
- `context/<paper>/<kind>.md` — reviewed paper passages that replace the automatic excerpt (all five models receive the same text).
- `prelude/<paper>.lean` — reviewed definitions-only prelude replacing the automatically stripped one.

The original and corrected reference versions both stay in the run directory
(`prepared/<paper>/corpus/` keeps the corpus copy byte for byte).

## Isolation and safety policy

- Models receive only: paper id, target kind, citation, the (reviewed or
  automatically excerpted) paper text, and the definitions-only prelude. They
  never receive the repository URL, reference Lean files, reference proof text
  or evaluator output; `run.js` aborts if a prompt contains reference proof text.
- The linked repository is read through the GitHub API and raw downloads only,
  with file-type, size and count limits. Its lakefiles and scripts are never run.
- Every Lean file (model or reference) passes a static screen before the
  compiler sees it: no `#eval`, `run_cmd`, `elab`, `macro`, `syntax`,
  `initialize`, `implemented_by`, `extern`, `unsafe`; imports restricted to
  Mathlib/Std/Lean/Init/Aesop/Batteries + `QEDRank.Prelude` + the paper's
  generated `QEDRank.Papers.<P>`; `maxHeartbeats` overrides capped.
- Compilation uses the pinned toolchain from `lean/lean-toolchain` and the
  Mathlib commit in `lean/lake-manifest.json`, with `-M`, `-DmaxHeartbeats` and a
  wall-clock timeout. Timeouts and toolchain faults are `timeout` /
  `infrastructure_failure`, never successes.
- Statement comparison runs in a scratch environment that imports only
  statement-only modules (every proof replaced by an evaluator-attached `sorry`,
  which is never credited) plus `QEDRank.Audit`; implication witnesses are
  checked for `sorryAx` and for actual use of their hypothesis.

## Statistics

95% intervals are percentile cluster bootstraps by paper (all targets and all
five models of a paper stay together in a resample). The five-model comparison
uses Cochran's Q on the common eligible papers and exact McNemar tests for the
ten pairs with Holm correction, reporting paired percentage-point differences
with bootstrap CIs. Rankings are descriptive; only pairs listed in
`statistically_supported_pairs` differ after correction. Subgroups with fewer
than `exploratoryThreshold` papers are labelled exploratory. No confidence
interval, p-value or ranking is produced before item records exist.

## Known limitations

- Prior training contamination cannot be ruled out for public papers or public
  Lean formalizations.
- The automated equivalence check is a bounded tactic portfolio; `unresolved`
  is expected to be common and is meant to be resolved by expert review.
- Provider integrations are the project's existing ones (`lib/providers.js`);
  the Anthropic and Cohere calls use the legacy completion endpoints and must be
  verified with real credentials before a full run.
- Loading Mathlib takes minutes per Lean invocation on some Windows machines;
  `lean.concurrency` and narrow imports in the prelude mitigate this.
