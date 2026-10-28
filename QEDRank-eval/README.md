# ProofBench evaluation harness

[Website](https://proof-bench.github.io) ·
[Problems](https://github.com/proof-bench/proofbench) ·
**Evaluation harness** (this repository) ·
[Apptainer sandbox](../inspectAI-apptainer)

This harness runs AI agents on [ProofBench](https://github.com/proof-bench/proofbench),
a benchmark of 116 research-level problems stated in Lean 4, and grades their
proofs with Lean alone. Every model gets the same agent loop, the same tools,
the same budget and the same sandbox, so differences in the results come from
the models and not from their tooling. It is built on
[Inspect AI](https://inspect.aisi.org.uk/) and runs its sandbox with Apptainer (the
default), on a Linux PC or an HPC cluster without root, or with Docker.

## How an evaluation works

1. **Sandbox.** Each problem gets its own container with Lean, Mathlib and the
   definitions that problem needs, and nothing else: no network (unless web
   search is on), no API keys, no other problems and no grading material.
2. **Agent.** A ReAct agent (a loop of reasoning steps and tool calls) works on
   the problem with a shell, Python, a file editor and the Lean language server
   (lean-lsp-mcp: goal states, diagnostics, Mathlib search). An optional web
   search tool uses the same search engine for every model. SageMath (with GAP
   and nauty), sympy, networkx, python-sat and the SAT solver CaDiCaL are
   installed. A proof may be split over several files.
3. **Sessions with handoff.** An attempt consists of up to 4 fresh sessions,
   each with an output-token budget (120,000 by default). At the end of a
   session the agent writes a handoff note in a fixed format (proved lemmas,
   open goals, failed approaches, unsaved drafts) that starts the next one.
   Fresh sessions keep models with short and long context windows comparable.
   An agent that is stuck may end a session early by submitting a short
   status; after a reply without a tool call it is told how much of the
   session's output budget is left.
4. **Grading.** After every session, the source text of the submission is
   checked in a fresh container that the agent never touched, in two layers:
   - [`image/check_proof.py`](image/check_proof.py): the statement and its
     definitions are unchanged, imports are allowed, there is no `sorry`, new
     axiom, `native_decide` or meta-level trick, the files compile, and the
     theorem uses only Lean's standard axioms;
   - [Comparator](https://github.com/leanprover/comparator), the Lean FRO's
     adversarial proof checker, which rebuilds statement and proof in a
     Landlock sandbox and replays the proof through the Lean kernel.

   The first session that passes ends the attempt. For an open problem, a
   proof of its negation (the theorem `Pxxx_disprove` in
   `Pxxx_DISPROVE.lean`) counts as well: the agent sees both files, either
   one solves the problem, and each is graded against its own statement.
   For every other problem, an agent convinced that the statement is false as
   formalized can submit a text starting with `FALSE:` and an explanation: this
   ends the attempt, unsolved, and is recorded for review by hand.
5. **Records.** Each run freezes its configuration in `manifest.json` (harness
   commit, image, Lean and Mathlib versions, problem commit, model, reasoning
   effort, search, budgets), and [`scripts/analyze.py`](scripts/analyze.py)
   writes one row per attempt to `results.csv`: verdict, polarity (prove or
   disprove), sessions used, input tokens (cached or not) and output tokens,
   cost at the list prices in [`data/model_prices.yml`](data/model_prices.yml)
   (Anthropic models; the free GWDG models have none), total and working time, tool and model calls, replies cut off at the token
   cap and refused replies, the largest context a single call needed, proof
   length and axioms, and whether the agent objected to the statement
   (`FALSE:`), with every submitted text other than "done".
   When a run ends, `run.sh` writes the SHA-256 checksums of these files to
   `SHA256SUMS` in the same folder and archives the run, the zipped folder and
   its checksums, as a new version of the project's Zenodo record
   ([`scripts/zenodo_publish.py`](scripts/zenodo_publish.py)); the receipt
   goes to `ZENODO.json`. The record's files stay restricted until
   publication. Only a complete run is archived: one that got to the end with
   a verdict (C or I) for every problem. A run that stopped early or has a
   problem without a verdict (a provider failure, status `N`, or a sample
   error) is skipped with the reason; `ZENODO=force` archives it anyway, and
   the message gives the command to archive it later. If the upload fails,
   the run is unaffected and the message says how to retry.

   One-time setup: a published Zenodo record with restricted files (any
   file, for example a short README, is needed to publish it), and a
   personal access token with the scopes `deposit:write` and
   `deposit:actions`. Add to `.env`: `ZENODO_TOKEN=<token>` and
   `ZENODO_CONCEPT=<concept record ID>` (the number in the record's "Cite all
   versions" DOI). Without them the step is skipped. A record holds 100 files,
   about 50 runs. For a test, use https://sandbox.zenodo.org with its own
   token and `ZENODO_API=https://sandbox.zenodo.org/api`. A test run that
   should not be archived takes `ZENODO=off`.
6. **Statistics.** [`scripts/stats.py`](scripts/stats.py) turns one or more
   runs into the tables of a results section, one row per configuration
   (model, search on or off; a configuration run in parts is pooled, with a
   warning when parts differ in their settings): solve rates with 95% bootstrap
   intervals (overall and per category), paired McNemar tests between models
   with Holm correction, a contamination split (proof public before or after
   the model's training cutoff), solve rate by release date, and per problem
   the earliest and the smallest model that solved it. Problem dates and model
   facts are in [`data/`](data/).

## Quick start

```bash
git clone https://github.com/proof-bench/QEDRank
cd QEDRank/QEDRank-eval
git clone https://github.com/proof-bench/proofbench              # the problems
scripts/setup.sh && . .venv/bin/activate     # Python environment with the harness

export IDS="P088 P089 P090"            # problems of this run (three calibration problems)
scripts/build_image.sh --apptainer    # sandbox image proofbench-sandbox.sif, about 40 min (--sif: via Docker)
echo "ANTHROPIC_API_KEY=..." >> .env   # keys stay on the host; the agents never see them
MODEL=anthropic/claude-opus-5-5 scripts/run.sh
inspect view --log-dir logs            # browse the transcripts
```

## On an HPC cluster with Apptainer

Clusters rarely offer Docker. The same image runs under Apptainer through
[inspect-apptainer](../inspectAI-apptainer), which is part of this repository and
installed by `scripts/setup.sh`, and it can be built there without root:

```bash
scripts/setup.sh && . .venv/bin/activate
IDS="..." scripts/build_image.sh --apptainer          # from image/proofbench.def, about 40 min
IDS="..." scripts/build_image.sh --update old.sif     # after problems change: rebuild on top of an image
scripts/hpc_preflight.sh proofbench-sandbox.sif       # network namespace, binds, Landlock, tmpfs
IDS="..." MODEL=... sbatch scripts/slurm_eval.sbatch  # one run as a Slurm job
```

Where Docker is available, `scripts/build_image.sh --sif` builds the Docker
image and converts it. `scripts/hpc_preflight.sh` prints PASS, WARN or FAIL for
everything the harness needs from the cluster; run it once on a compute node.

## On Windows

Linux is the reference platform, but the harness also runs on Windows with the
Docker sandbox (Apptainer is Linux-only): start Docker Desktop and use Git Bash,
which comes with Git for Windows. Set two variables in every Git Bash window
before the quick start's commands:

```bash
export PYTHONUTF8=1        # Python reads and writes UTF-8 (the Lean files are full of Unicode)
export MSYS_NO_PATHCONV=1  # Git Bash leaves Linux paths such as /opt/proofbench alone
export SANDBOX=docker      # Windows has no Apptainer: build the image with scripts/build_image.sh
scripts/setup.sh python && . .venv/Scripts/activate   # Windows keeps the environment in .venv/Scripts
```

## Models

- Commercial models through Inspect's providers: `anthropic/...`, `openai/...`,
  `google/...`, `grok/...`, with the provider's API key in `.env`. Chat
  subscriptions do not work; access is through the providers' APIs.
- Any OpenAI-compatible endpoint as `openai-api/<name>/<model>`, with
  `<NAME>_API_KEY` and `<NAME>_BASE_URL` in `.env`. For example a hosted
  open-weight model (`QWEN_BASE_URL=https://chat-ai.academiccloud.de/v1`, the
  GWDG Chat AI service), or a model you serve yourself with vLLM on a GPU node
  (`KIMI_BASE_URL=http://<gpu-node>:8000/v1`).

## Options

`scripts/run.sh` reads its settings from environment variables:

| Variable                | Default       | Meaning                                         |
|-------------------------|---------------|-------------------------------------------------|
| `IDS`                   | required      | problems to run, e.g. `"P088 P089 P090"`        |
| `MODEL`                 | required      | model, as above                                 |
| `EFFORT`                | `xhigh`       | reasoning effort (`low` ... `max`); empty = none |
| `SEARCH`                | `false`       | web search tool (Tavily; `SEARCH_PROVIDER=exa`) |
| `NETWORK`               | = `SEARCH`    | internet access in the sandbox                  |
| `SANDBOX`               | `apptainer`   | `apptainer` or `docker`                         |
| `COMPARATOR`            | `on`          | second grading layer                            |
| `SESSIONS`              | `4`           | sessions per problem                            |
| `SESSION_OUTPUT_TOKENS` | `120000`      | output-token budget per session                 |
| `MAX_TOKENS`            | `40000`       | output-token cap per model reply                |
| `MAX_RETRIES`           | `8`           | retries of a failing request (about 13 min)     |
| `PROVIDER_RETRIES`      | `2`           | uncounted restarts of a session ended by a provider error |
| `PROVIDER_BACKOFF`      | `30`          | seconds before such a restart, times its number |
| `MAX_SAMPLES`           | `4`           | problems in parallel                            |

Changing any setting that `manifest.json` records makes a new run.

## Repository layout

```
proofbench_eval/task.py      Inspect task: agent, tools, sandbox, instructions
proofbench_eval/sessions.py  sessions with handoff notes
proofbench_eval/scorer.py    two-layer grading in a fresh verifier container
image/check_proof.py         layer 1: statement unchanged, imports, forbidden constructs, compile, axioms
image/Dockerfile             sandbox image: Lean, Mathlib, statement library, lean-lsp-mcp,
                             Comparator, Python tools, SageMath, CaDiCaL
image/proofbench.def         the same image as an Apptainer recipe
scripts/setup.sh             one-time setup: .venv with the harness and ../inspectAI-apptainer
scripts/build_image.sh       stage the statements the selected problems import; build the image
scripts/run.sh               one run: manifest, evaluation, results.csv
scripts/slurm_eval.sbatch    one run as a Slurm job with the Apptainer sandbox
scripts/hpc_preflight.sh     day-one checks on a cluster
scripts/analyze.py           logs -> results.csv
scripts/extract_proofs.py    logs -> proofs/<problem>/Submission/... (final files, helpers included)
scripts/stats.py             runs -> intervals, model comparisons, contamination split, difficulty
scripts/prefill_problem_dates.py  draft of data/problem_dates.csv from the development repository
data/problem_dates.csv       when each problem's proof became public (year; status checked/unchecked/open)
data/model_facts.csv         release date, training cutoff and size of each model, with sources
data/model_prices.yml        list prices per million tokens, for Inspect's cost tracking
tests/grader_attacks/        cheating attempts the grader must reject, and run.sh to check both layers
tests/test_targets.py        proof or disproof: which file is graded and reported (fake sandbox, seconds)
tests/mock_run.py            a whole two-session run with a scripted mock model, no API (Apptainer, 1 min)
tests/provider_errors_run.py the same with a rate limit and a used-up daily limit: NOANSWER, not INCORRECT
tests/objection_run.py       a mock agent replies without a tool call (budget nudge), then submits FALSE:
```

## Good to know

- A submission is the main file `Submission/Pxxx.lean` plus every file under
  `Submission/` that it imports, transitively. All of them are checked and
  built before the main file compiles.
- Layer 1 is a permissive pre-filter that picks promising candidates;
  Comparator makes the final judgment. Keep it on (`COMPARATOR=on`) for every
  graded run: some tricks pass layer 1 by design (see tests/grader_attacks).
- Comparator needs Landlock in the host kernel; `scripts/hpc_preflight.sh`
  checks that it actually engages.
- Claimed solutions of open problems are checked by hand before any claim is
  made.
- Provider failures are not the model's: a session ended by a rate limit or a
  server or connection error is started again without counting, and a used-up
  account budget (daily limit, quota, credit) stops the problem at once. An
  unsolved problem stopped this way is scored NOANSWER (status `N` in
  `results.csv`, left out of the rates); run it again.
- Reasoning-effort settings differ between vendors, and some models always
  think; record the effort per model and report it.
- `scripts/check_statements.sh`, `scripts/verify_comparator.sh` and
  `scripts/solution_to_submission.py` test the grading against our reference
  proofs; they need the private development repository.
- `tests/grader_attacks/run.sh` grades known cheating attempts (changed
  statements or definitions, axioms, instances or `variable`s that change what
  the statement means, kernel bypasses, ...) with each layer separately; see
  [its README](tests/grader_attacks/README.md).
