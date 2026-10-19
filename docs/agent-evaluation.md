# Agent evaluation in QEDRank: harnesses, attempts, pass@k, statuses

QEDRank evaluates language models on a Lean 4 benchmark corpus in two ways: its own single-call
protocol (one request per problem and attempt, no tools) and, through the integration described
here, the ProofBench team's agent harness. Both produce the same run directory, so one summary,
one page and one set of LaTeX tables cover them.

## 1. Harnesses and their state

| Harness | What it is | State in QEDRank |
|---|---|---|
| `qedrank-single` | QEDRank's single call, graded by `grade` (compile in the pinned project, no `sorry`, standard axioms, statement and definitions unchanged as compiled declarations, kernel replay) | operational |
| `proofbench` | [proof-bench/proofbench-eval-apptainer](https://github.com/proof-bench/proofbench-eval-apptainer): Inspect AI ReAct agent with `bash`, `python`, `text_editor` and `lean-lsp-mcp` in a Docker/Apptainer sandbox, up to N sessions chained by handoff notes, graded in a second untouched container by `check_proof.py` (layer 1) and Comparator (layer 2) | **integrated**: driver (`agent-run`), importer (`import-harness`), run-server job, page configuration and results; executed end to end on this PC with Inspect's mock model (Section 8) |
| `matharena-arxivlean` | [eth-sri/matharena](https://github.com/eth-sri/matharena): MathArena agent with local Lean execution, Loogle, LeanExplore, a pre-submission check and a lemma file; 200 tool calls and a cost cap per attempt; Lean checker + Comparator | **not integrated**: listed with its state; no driver, no importer, no run executed. Requirements if it is integrated: its September 2026 setup only (local Lean; the earlier editions send proofs to the external Axle service and must never see private statements), its own Lean 4.34.1/Mathlib project kept apart from ProofBench's 4.33.1 + Matroid fork, and `dataset_mode: adapted` on every run that is not the official ArXivLean set |
| `qedrank-harness` | QEDRank's own Inspect harness (`harness/`) | **fallback, untested**: its Docker image and compose files have not been built or run here; not presented as operational |

`node qedrank/cli.js harnesses` (or `GET /harnesses` on the run server) prints every harness with
what this machine has of it: directory, `scripts/run.sh`, the venv's Python, bash, the statements
clone and its commit (dirty clones are refused by the harness), the sandbox image and the Lean
project used for the partial-progress re-grade. The page offers only harnesses reported `ready`.

The `inspect-apptainer` package (Apptainer sandbox for HPC) belongs to the ProofBench harness and
contributes no metric; the Docker route needs nothing of it.

## 2. Configuration

`qedrank.config.json` (machine-specific, not committed):

```json
{
  "harnesses": {
    "proofbench": {
      "dir": "C:/proofbench-eval",
      "statements": "proofbench-statements",
      "leanProject": "C:/proofbench-statements",
      "image": "proofbench-sandbox:latest"
    }
  },
  "pricing": { "kimi-k3": { "input": 3, "output": 15 } }
}
```

- `dir`: the harness checkout (branch `DGX_Testing` of this repository mirrors it, with the fork's fixes).
- `statements`: the private statements clone inside it, checked out at the dataset commit of the run.
- `leanProject`: the pinned Lean project (Lean 4.33.1, Mathlib, Matroid fork) for `--regrade`.
- `python`, `bash`: optional overrides (defaults: the harness `.venv`; Git's bash on Windows).
- `pricing`: USD per million tokens per model id; without it cost is "unavailable", never 0.

The model keys stay in the environment (`scripts/set-llm-keys.ps1`); the driver passes the key of
each selected slot to the harness process only, under the name Inspect expects (`QWEN_API_KEY`,
`ANTHROPIC_API_KEY`, ...). Nothing of it is logged or stored.

## 3. Running

From the page: **Evaluate Models → 2. Run the benchmark from here → Harness: ProofBench agent
harness**, choose the problems (ids, or "Select by filter" with the corpus's difficulty and
subject labels), the number of independent attempts (1–16), the budgets, and Start. The page
shows the equivalent command:

```bash
node qedrank/cli.js agent-run --run-id ag-qwen-x8 --models qwen --problems P109,P110,P111 \
  --attempts 8 --ref 0a4a476 --sessions 10 --session-output-tokens 30000 \
  --session-working-time 1800 --max-tokens 16000 --max-samples 2 --max-cost-usd 50 \
  [--effort high] [--comparator off] [--message-limit 400] [--retry-infra] [--regrade]
```

What happens:

1. The driver checks the harness (directory, bash, statements clone at `--ref`) and the model
   key, then for attempt a = 1..N and each model runs `scripts/run.sh` once with
   `RUN_ID=<run>/attempt-a` and `IDS` = the problems that attempt has not completed yet. Every
   attempt is a new Inspect run: fresh agent state, fresh sandbox containers per problem.
2. Budgets travel as the harness's own variables: `SESSIONS`, `SESSION_OUTPUT_TOKENS`,
   `SESSION_TOKENS`, `SESSION_WORKING_TIME`, `NOTE_TOKENS`, `MAX_TOKENS`, `REQUEST_TIMEOUT`,
   `ATTEMPT_TIMEOUT`, `TIME_LIMIT`, `MESSAGE_LIMIT` (Inspect's message limit, about two messages
   per tool call: the closest available tool-call cap) and `MAX_SAMPLES`. `--max-cost-usd` is
   QEDRank's: after each attempt it sums the estimated cost (reported usage × configured prices)
   and stops launching attempts once the cap is reached.
3. After every attempt all logs under `<harness>/logs/<run>/attempt-*/` are imported into
   `runs/<run>/` and the statistics rebuilt, so a stopped run is always loadable.
4. Stopping (page **Stop**, Ctrl+C, SIGTERM) ends the current Inspect run; samples that had
   finished are complete attempts and stay; the rest are `cancelled` in the plan. Running the
   same command again continues with the missing (attempt, problem) pairs and never repeats a
   completed one. `--retry-infra` additionally re-runs attempts that ended in an infrastructure error.

Importing logs produced elsewhere (for example on the DGX):

```bash
node qedrank/cli.js import-harness --run-id ag-dgx-1 --proofbench /path/to/logs/ag-dgx-1 \
  [--attempts 8] [--regrade --lean-project /path/to/proofbench-statements] [--merge-run 2026-10-11-466b32a-regrade]
```

`--proofbench` takes a directory of `attempt-N/` directories or a single log directory
(attempt 1). `--merge-run` adds another QEDRank run's main-theorem records (for example the
single-call baseline) under their own provider ids, so the page shows both harnesses side by side.

## 4. Statuses

One status per attempt record (`status`), with the evidence on the record:

| Status | Meaning |
|---|---|
| `fully_solved` | the final submission passed every required check of its harness. ProofBench: `check_proof.py` (statement and definitions unchanged, allowed imports, no `sorry`/`axiom`/`native_decide`/kernel bypass, helper files build, main file compiles, standard axioms only) **and** Comparator (kernel replay against the trusted statement module). Compilation alone never counts. |
| `partially_solved` | not solved, but QEDRank's independent re-grade of the final file (`--regrade`: the pinned Lean project, `#qr_module_report`) finds at least one auxiliary theorem the model wrote that compiles without `sorry` and depends only on standard axioms. `partial` holds the count, the completeness score, the open steps and the method. Without `--regrade` the record says `partial.assessed = false` and the status is `failed`. Partial progress never counts toward verified rates or pass@k. |
| `failed` | no accepted complete proof and no verified partial progress; `failure.class` and `failure.evidence` say why |
| `infrastructure_error` | the attempt could not be carried out or graded: Inspect sample error, every session ended in a provider/sandbox error before any model output, the checker failed, or the harness scored NOANSWER; excluded from every denominator, counted separately |
| `pending`, `running`, `cancelled` | planned attempts without a record (from `run.attempts.by_attempt`) |

Failure classes (`failure.class`), first identifiable cause: `syntax`, `elaboration` (unknown
name), `type`, `tactic` (unsolved goals, failed tactics), `timeout`, `dependency` (imports,
missing modules), `statement_mismatch` (textual or Comparator), `disallowed_proof` (axiom,
`native_decide`, kernel bypass, forbidden commands, non-standard axioms), `incomplete_proof`
(`sorry` left, token budget exhausted), `no_answer`, `provider`, `infrastructure`, `unknown`.

## 5. pass@k

For a problem with n determinate attempts (infrastructure errors excluded) of which c are fully
solved:

    pass@k = 1 − C(n − c, k) / C(n, k),   for n ≥ k

computed as the product ∏_{i=n−c+1..n} (1 − k/i) (no large binomials). Reported for every integer
k from 1 to the planned attempts (1, 2, 4 and 8 marked prominent), averaged over proof-track
problems with n ≥ k; a problem with fewer attempts is left out of that k and counted in
`items_short`. A k with no eligible problem is **unavailable**, never 0. Each point carries the
number of problems and attempts behind it, a 95 % paper-cluster bootstrap interval, and
`observed_within_k`: the share of problems solved in their first k attempts by attempt index,
kept apart from the estimate. Models are compared on their common problems;
`coverage.coverage_differences` lists what a model lacks.

Denominators: a cancelled attempt leaves no record and does not count; an infrastructure error
is not an attempt; a retry inside the harness (provider error, see Section 7) is not an attempt
either; a `--retry-infra` re-run replaces nothing, it adds a record. Every record keeps its status,
so no failure is dropped silently.

## 6. What is persisted

Per attempt, in `runs/<run>/items/<problem>__main_theorem__<provider>/`:
`attempt-a{n}r0.json` (the record: dataset commit, problem id, model and provider settings,
harness commit, image, Lean toolchain, budgets, timestamps, grading outcome, status, failure,
partial, usage, timing, tool calls), `submission-a{n}.lean` (the final file),
`grade-a{n}.json` (the harness's grading record with the original statement) and, with
`--regrade`, `regrade-a{n}.json`. `run.json` holds `harness_protocol` (commit, dirty flag, Inspect
version, image id, sandbox type, Lean toolchain, Mathlib and statements commits, tools, network,
search, Comparator, every budget), `attempts` (plan and state per attempt), `protocol_mismatches`
(fields that differ between attempts or models), `counting_rules`, and `machine` (import host;
per-attempt CPU/GPU/memory use is not measured by the harness and is reported as unavailable).
`attempts-plan.json` logs the driver's events and the cost estimate.

Proof text and grading records are served only by the local run server (127.0.0.1) and never
enter `exports/items.json`, the CSVs or the LaTeX report.

On the Evaluation page the run appears as the "Problems × models" grid (one row per problem,
model columns grouped by harness, one glyph per planned attempt, filters by status, difficulty,
subject and harness, sortable headers, grid CSV), a drawer per cell (attempt table; tabs for the
final proof file, the grading record and the attempt record with its sessions, fetched from the
run server), the "Attempts & failures" section (protocol block, status and failure-class
charts) and the pass@k table (every k, prominent 1/2/4/8, estimate with interval, observed
num/den, "—" where fewer than k attempts exist). The item-level table at the end filters by
status, failure class and harness as well as the single-call fields. A single-call run merged in
with `--merge-run` contributes its first attempts as primary records, so its compile, statement
and verified rates, tokens and latency are reported next to the agent harness's; subject groups
use the MSC code of each `Database.json` entry, as the single-call corpus loader does.

## 7. Fixes to the ProofBench harness (fork, branch `DGX_Testing`)

Both scoring fixes were located in the harness's code and implemented; see its README section
"Changes in the QEDRank fork":

1. `qualified_theorem` popped a namespace at the end of a *section*; P039, P105, P106 and P108
   were graded under the bare theorem name and could never pass. Verified over all 114
   statements: exactly those four names change.
2. A session that ended in a provider error counted as a session and the problem scored
   INCORRECT. The session is now retried without being counted (`provider_retries`, backoff),
   and when the retries are used up the scorer returns NOANSWER with `infrastructure_error`.
   Verified end to end with a mock provider raising rate-limit errors.

Also: `check_proof.py` compares the signature up to the first `:=` at bracket depth 0 (P102 has
a named argument `(F := F)`), and `run.sh` accepts `MESSAGE_LIMIT`, `PROVIDER_RETRIES`,
`PROVIDER_BACKOFF`.

## 8. What was executed and what remains untested

Executed on this PC (Windows 11, Docker Desktop):

- the ProofBench harness end to end with Inspect's mock model on P109–P111 (sandbox, sessions,
  layer-1 check, Comparator, NOANSWER path), the import of its `.eval` log, the statistics and
  the page;
- the attempts driver against a fake harness (`scripts/run.sh` stub): attempt loop, per-attempt
  import, cost cap stop, resume without repetition;
- the unit tests: statuses and failure classes, zip/zstd and log reading, importer, pass@k for
  every k with insufficient-data handling, observed vs estimate, coverage differences,
  cancelled attempts, merge of another harness's run, job allow-list;
- `--regrade` on the mock run (the P109 final file re-compiled in the pinned ProofBench project);
- the page in a headless browser against the merged run `qedrank-mock-vs-single` (mock agent run
  plus the 2026-10-11 single-call run): grid with 111 rows and harness-grouped columns, status
  filter, drawer fetching the proof, grading and attempt records from the run server, pass@k
  table with unavailable cells shown as dashes, protocol block, item filters, exports, and the
  Evaluate Models form with the ProofBench harness selected (budgets, command preview); 30/30
  checks, no console errors;
- `lean-bench` on P001 and P002 of the pinned ProofBench project (about 40 s per compile, about
  190 s per graded file on a 14-core PC). It exposed a grader false positive: `#qr_olean_diff`
  instantiated the solution's universe parameters, which also simplifies levels (`max 1 (u+1)`
  to `u+1`), but left the reference untouched, so a definition whose elaborated value carries
  such a level (P001 `hadwigerNumber`) compared as `value_changed` even between byte-identical
  object files. Fixed in `lean/QEDRank/Audit.lean` (both sides are instantiated and normalised);
  re-grading P001 against itself now reports only `contains_sorry`. None of the 22 stored grading
  records of earlier runs had been affected (checked), but any future submission to such a
  problem would have been rejected.

Not executed: a ProofBench run with a real model from QEDRank (needs the self-hosted Qwen3 server
or a priced API key), `--regrade` on the DGX, MathArena (not integrated), `harness/` (fallback),
a persistent Lean backend (Section 9).

## 9. Verification backend

`node qedrank/cli.js lean-bench --project C:/proofbench-statements --files 5` times Lean on
challenge files of the pinned project and prints a median per file and an assessment. A
persistent backend (Kimina Lean Server, LeanInteract) is added only when that measurement shows
compilation is the bottleneck on the target machine *and* the backend runs the exact toolchain
(`leanprover/lean4:v4.33.1`, this Mathlib, the Matroid fork). `verification.backend` in the config
is `lean-cli` and is the only implemented value.

## 10. Reproducible evaluation on the DGX

```bash
# once
git clone -b DGX_Testing https://github.com/vaibhav-baj/QEDRank.git ~/proofbench-eval   # the harness fork
cd ~/proofbench-eval && uv venv .venv --python 3.12 && . .venv/bin/activate && pip install -e .
git clone https://github.com/proof-bench/proofbench-statements proofbench-statements && git -C proofbench-statements checkout 0a4a476
IDS="P109 P110 P111" scripts/build_image.sh            # sandbox image for the selected problems
git clone -b QEDRank https://github.com/vaibhav-baj/QEDRank.git ~/qedrank && cd ~/qedrank && npm ci
cat > qedrank.config.json <<'EOF'
{ "harnesses": { "proofbench": { "dir": "/home/USER/proofbench-eval", "leanProject": "/home/USER/proofbench-statements" } } }
EOF
export QEDRANK_BASEURL_QWEN=http://127.0.0.1:8080/v1 QEDRANK_MODEL_QWEN=qwen3-30b-a3b-instruct-2507 QEDRANK_API_KEY_QWEN=...   # the llama.cpp server
# the evaluation (resumable: run the same command again after a stop)
tmux new -s qedrank
node qedrank/cli.js agent-run --run-id dgx-qwen-x8 --models qwen --problems P109,P110,P111 --attempts 8 --ref 0a4a476 --max-samples 2
# results
node qedrank/cli.js stats --run-id dgx-qwen-x8 && node paper/make-tex.cjs runs/dgx-qwen-x8
```

Label the run with the server and precision (`fp16-llamacpp-<commit>`) as the DGX's V100s run the
model in FP16; the page's protocol block records the rest.

## 11. Migrations

No database: runs are directories of JSON. All new fields (`status`, `failure`, `partial`,
`harness`, `artifacts`, `run.harness_protocol`, `run.attempts`, `summary.counting_rules`,
`summary.attempts`, `coverage.problems_by_model`, `pass_at_k.curve[].observed_within_k`) are
additive; records written before derive `status` and `failure` from their outcomes and grade when
read (`statusOf`, `failureOf`). Re-run `node qedrank/cli.js stats --run-id <id>` on an old run to
refresh its summary and exports.
