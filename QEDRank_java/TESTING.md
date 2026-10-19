# Testing guidelines

How the benchmark is tested, from unit tests that run in seconds to the checks that precede a
reported run. Every level has a command, what it covers, what it cannot cover, and what to do
when it fails. The levels build on each other: do not run a level before the one above it is
green.

| Level | Command | Needs | Time |
|---|---|---|---|
| 1. Node unit tests | `npm test` | Node 18+ | ~5 s |
| 2. Harness unit tests | `cd harness && .venv\Scripts\python -m pytest -q -p no:logging` | Python 3.10+, Node | ~30 s |
| 3. Lean grading tests | `QEDRANK_LEAN_TESTS=1 node --test qedrank/test/grade.test.js` | elan + the pinned toolchain | 2–40 min (machine-dependent) |
| 4. Provider smoke test | `node qedrank/cli.js ping [--compile]` | API keys | seconds to minutes |
| 5. Corpus preparation | `node qedrank/cli.js run … --dry-run` | corpus access, Lean + Mathlib | minutes to hours |
| 6. Small live run | `node qedrank/cli.js run … --limit 2` | all of the above | depends on the models |
| 7. Agent harness end to end | `inspect eval … -T ids=P050 -T max_sessions=1` | Docker image, one key | one session |
| 8. Pre-run checklist | (manual) | — | 15 min |

## 1. Node unit tests

`npm test` runs `qedrank/test/**/*.test.js` with Node's built-in runner. No network, no Lean, no
keys: every provider test uses a fake `fetchImpl`, every Lean-facing test works on synthetic
`QR_…` records or on source text.

What is covered and where:

- `providers.test.js` — request shapes per vendor (what is sent, what is never sent, such as a
  temperature to a reasoning model), key resolution and per-slot overrides, retries, redaction of
  keys from error bodies.
- `source.test.js`, `corpus.test.js` — GitHub link parsing, ref resolution, discovery of the
  ProofBench layout (`qedrank/test/fixtures/corpus-b`), index joins and the renumbered-folder
  protection, difficulty labels.
- `leansrc.test.js`, `prompt.test.js`, `compare.test.js` — the static screen, declaration
  parsing, proof stripping, the prompt template, classification of comparison results.
- `grade.test.js` (first six tests) — import policy, statement-diff classification, completeness,
  proof length, compiler-output formatting, lakefile options.
- `analysis.test.js`, `metrics.test.js`, `stats.test.js` — effort by difficulty, difficulty
  proxies, capability by release, contamination split, agent summary, bootstrap intervals,
  McNemar/Holm, calibration, agent record import and the hand audit.

Rules for new tests:

- A pure function gets a unit test with hand-written input; a network call gets a fake
  `fetchImpl`; nothing in this level may read an environment variable with a real key.
- Assert on exact values (numerator and denominator, not just a rate; the exact request body,
  not just "it was called").
- A fixture that encodes a benchmark rule (a renumbered folder, a stale index entry, a changed
  definition) carries a comment saying which rule it protects.
- Files are LF; the test runner does not care, but Git on Windows warns otherwise.

When it fails: the assertion message names the file and line. A failure in `providers.test.js`
after a roster change usually means a vendor's request shape changed on purpose — update the
expectation and the README row together.

## 2. Harness unit tests

```powershell
cd harness
.venv\Scripts\python -m pytest -q -p no:logging        # create the venv once: python -m venv .venv; .venv\Scripts\pip install -e ".[dev]"
```

These run the whole session chain with a **scripted model** (`mockllm`, no key), the **local
sandbox** (a temporary directory, no Docker) and a **stub grader** (solved exactly when the file
has no `sorry`). They cover: the first passing session ends the chain; the second session is a
fresh context that sees only the file, the compiler output and the handoff note reduced to its
format; the output-token budget warns once and then ends the session; idle models and full
context windows end a session; a grading error is neither a success nor a failure; excluded
tools are not offered; lookups are logged; the handoff parser; problem loading from a checkout
(and that proctor material never reaches a sample); the export bundle; and
`test_pipeline.py`, which imports a bundle with `node qedrank/cli.js import-agent` and checks
the summary and the hand audit — the one test that crosses the Python/Node boundary.

Rules: a new solver behaviour gets a scripted-model test in `test_sessions.py` using the helpers
in `conftest.py` (`call`, `say`, `Script`, `make_task`); prompts are asserted by content, not by
length; nothing here may need Docker or a key.

## 3. Lean grading tests (opt-in)

```powershell
$env:QEDRANK_LEAN_TESTS = "1"; node --test qedrank/test/grade.test.js
$env:QEDRANK_LEAN_TESTS_ONLY = "solved,context_trick"      # a subset
```

This grades every file in `qedrank/test/fixtures/grade/` against `challenge.lean` with the real
Lean toolchain, using `qedrank/test/fixtures/lean-core` (a Lake project without Mathlib, so a
compile takes seconds). The fixtures are the **attack list** of the grader; each stands for one
way a submission could be wrong or could cheat:

| Fixture | Expected verdict and reason | Protects |
|---|---|---|
| `solved` | solved | the honest case; completeness 1 |
| `reformatted` | solved, warning "text edited, same statement" | reformatting is not a change |
| `partial` | not_solved: contains_sorry, completeness 2/3 | sorry audit; completeness counts steps |
| `untouched` | not_solved: contains_sorry, completeness 0 | an unused lemma is not progress |
| `unused_sorry` | not_solved: sorry_in_file | "no sorry anywhere" |
| `changed_statement` | not_solved: statement_changed | weakened theorem |
| `changed_definition` | not_solved: definition_changed | a definition rewritten to make the theorem easy |
| `changed_private_definition` | not_solved: definition_changed | private names compared too |
| `removed_definition` | not_solved: definition_removed | a challenge structure deleted |
| `context_trick` | not_solved: statement_changed, **ESCALATE** warning | identical text, a local instance changes its meaning |
| `axiom_cheat` | not_solved: non_standard_axioms, completeness 1/2 | declared axioms fail and count as open steps |
| `forbidden_command` | not_solved: static_screen_rejected | `#eval` never reaches the compiler |
| `hidden_import` | not_solved: disallowed_import | the proctor library is not importable |
| `compile_error` | not_solved: compile_error, completeness unavailable | errors are not solutions |

Rule: **every new check in `grade.js` or `Audit.lean` gets two fixtures — one that it rejects and
one that it accepts** — and a row in this table. A fixture must compile without Mathlib so that
the level stays runnable in minutes.

Why opt-in: on some Windows machines a Lean invocation takes 30–60 s even without Mathlib, so
the full set takes up to 40 minutes. In CI on Linux it takes about two.

When it fails: `qedrank/cli.js grade --lean-project qedrank/test/fixtures/lean-core --challenge
qedrank/test/fixtures/grade/challenge.lean --solution qedrank/test/fixtures/grade/<name>.lean
--scratch tmp/g` keeps the scratch directory; `tmp/g/scripts/*.lean` are the evaluator scripts
and can be run by hand. A `grader_error` verdict means the grader itself could not run (toolchain,
evaluator commands, replay); its `grader_error` field says which step.

## 4. Provider smoke test

```powershell
node qedrank/cli.js models                     # which slots have a key
node qedrank/cli.js ping --models kimi --show   # one short Lean task; shows the answer
node qedrank/cli.js ping --compile              # every configured model; compiles each answer with Lean
```

Expected: `ok`, a latency, an output-token count, and Lean code in the answer. Known readings:
`http_error 400` with a message about a parameter means the request shape is wrong for that
model (fix it in `lib/providers.js`, add a test in `providers.test.js`); `empty_response` on a
reasoning model means the output budget was spent on thinking (`ping` uses the run's 16k
budget by default); `rate_limited` on a free tier is normal — the runner retries with
`Retry-After`. Run this after every roster change and before every live run. Keys are entered
with `scripts/set-llm-keys.ps1` (masked); never paste a key into a chat, a file or a commit.

## 5. Corpus preparation (dry run)

```powershell
$env:GITHUB_TOKEN = (gh auth token)             # private corpus
node qedrank/cli.js discover --repo <link> --ref <commit> --out manifest.json
node qedrank/cli.js run --repo <link> --ref <commit> --targets main_theorem --run-id <id> --dry-run
```

`discover` is seconds and makes no model calls. Check in the manifest: `counts.papers` is what
you expect, `source.subdir` is the problem folder (not the whole repository), every paper's
`targets.main_theorem.declaration_name` is the intended theorem, `mathematical_status` is
`established` or `open` as intended, and the `flags` are ones you accept
(`mathematical_status_from_index_needs_review` is informational; `ambiguous_declaration` on a
target you will run is not).

`--dry-run` additionally compiles every reference in the pinned Lean project and builds the
statement-only modules. Afterwards `runs/<id>/prepared/<paper>/done.json` says per target
whether the reference compiled (`reference_proof_status`) and whether its statement is
available (`statement_available`). A reference that does not compile under the runner's Mathlib
is a corpus/toolchain mismatch, not a model failure: fix it before the live run, because those
items would be ineligible and silently absent from every rate.

## 5b. The prove task without model calls

```powershell
node qedrank/cli.js run --path qedrank/test/fixtures/corpus-prove --fixtures qedrank/test/fixtures/corpus-prove/responses --task prove --lean-project qedrank/test/fixtures/lean-core --models qwen,kimi,llama --targets main_theorem --run-id prove-fixture
```

Canned answers (one solved, one partial, one abstention) go through the whole prove pipeline
with real Lean on the dependency-free project: expect `verified 1/1` for `qwen`, `0/1` with
`contains_sorry` and completeness 2/3 for `kimi`, and an abstention for `llama`. A few minutes.
Load `prove-fixture` on the Evaluation page afterwards to see a prove run rendered.

## 6. Small live run

The Benchmark page can start this run for you (step 2 under the corpus preview) when
`npm run qedrank:serve` is running; it posts the same command to the local run server and follows
the log. The checks below are the same either way.

```powershell
node qedrank/cli.js run --repo <link> --ref <commit> --models qwen,llama --targets main_theorem --limit 2 --run-id smoke-1
node qedrank/cli.js stats --run-id smoke-1
```

Read `runs/smoke-1/summary.json` before anything larger: `coverage.items_infrastructure_failed`
should be 0 (otherwise a key, a quota or the toolchain is the problem); `eligible_items` should
equal the number of items; each model's `compile`, `audit_clean` and `verified_pass1` should
have the denominators you expect. Load the run on the Evaluation page (`npm run qedrank:serve`)
and check that every number there matches the JSON. `resume --run-id smoke-1 --retry-failed`
re-runs infrastructure failures only.

## 7. Agent harness end to end

In order:

1. Unit level (level 2) green.
2. Build the image (`harness/README.md`); record its id. A failing build is a packaging problem,
   not a protocol problem — fix the Dockerfile, do not work around it in the task.
3. One problem, one session, no search, with a model you have a key for:
   `inspect eval harness/proofbench_harness/task.py@proofbench --model <m> -T problems=<checkout> -T ids=P050 -T max_sessions=1 -T session_output_tokens=8000`.
   Open `inspect view`: the session must show tool calls, the handoff note being written, and a
   grade with a verdict. A `grader_error` here is the grading container (image, `--lean-project`
   path, node); an empty session is the model or the tools.
4. `proofbench-export logs/<log>.eval --out b.json` then
   `node qedrank/cli.js import-agent --bundle b.json --run-id agent-smoke`: the summary must
   show one problem, `sessions_max` 1, and the same verdict as `inspect view`.
5. Only then the search configuration (`-T web_search=true`), checking that `chain.search_log`
   has entries and the proxy log is present.

The same attack list as level 3 applies to the agent's output: the grader is the same code.

## 8. Before a reported run

- [ ] Levels 1–3 green on the commit you will run; `git status` clean; the commit pushed.
- [ ] `node qedrank/cli.js toolchain` reports `available`, `mathlib_built`, `audit_built`; the
      toolchain and Mathlib commit match what the paper will state.
- [ ] Every slot in `--models` answers `ping --compile`; `pricing` in `qedrank.config.json` is set
      for every paid model (cost is "unavailable" otherwise).
- [ ] Dry run of the exact corpus commit clean; `expected_count_matches` as intended.
- [ ] Agent runs: image id recorded; the same `max_sessions`, `session_output_tokens`, search
      flag and image for every model that will be compared (`import-agent` warns on
      `protocol_mismatches`; a warning means the models are not comparable).
- [ ] Hand audit planned: every solve lands in `summary.agent.by_model[*].awaiting_manual_audit`
      until `runs/<id>/review/audit.json` confirms or rejects it; an apparent proof of an open
      claim is listed under `open_claim_escalations` and is never counted.
- [ ] Nothing in the run directory is committed (`runs/` is ignored); summaries that leave the
      machine go through the Evaluation page's download buttons, which strip nothing but also
      add nothing.

## What the tests do not cover

- Whether a model's answer is mathematically interesting: only Lean decides, and only on the
  stated theorem.
- Contamination: the publication-date split is a warning signal, not a test.
- The Docker image and the proxy configuration were written without a Docker daemon at hand;
  level 7 is where they get exercised first.
- Mathlib drift between a corpus's pinned toolchain and the runner's: level 5 detects it, nothing
  prevents it.
