# ProofBench evaluation harness

[Website](https://proof-bench.github.io) ·
[Problems](https://github.com/proof-bench/proofbench) ·
**Evaluation harness** (this repository) ·
[Apptainer sandbox](https://github.com/proof-bench/inspect-apptainer)

This harness runs AI agents on [ProofBench](https://github.com/proof-bench/proofbench),
a benchmark of 114 research-level problems stated in Lean 4, and grades their
proofs with Lean alone. Every model gets the same agent loop, the same tools,
the same budget and the same sandbox, so differences in the results come from
the models and not from their tooling. It is built on
[Inspect AI](https://inspect.aisi.org.uk/) and runs on a PC with Docker or on an
HPC cluster with Apptainer, without root.

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
3. **Sessions with handoff.** An attempt consists of up to 10 fresh sessions,
   each with an output-token budget (30,000 by default). At the end of a
   session the agent writes a handoff note in a fixed format (proved lemmas,
   open goals, failed approaches, unsaved drafts) that starts the next one.
   Fresh sessions keep models with short and long context windows comparable.
4. **Grading.** After every session, the source text of the submission is
   checked in a fresh container that the agent never touched, in two layers:
   - [`image/check_proof.py`](image/check_proof.py): the statement and its
     definitions are unchanged, imports are allowed, there is no `sorry`, new
     axiom, `native_decide` or meta-level trick, the files compile, and the
     theorem uses only Lean's standard axioms;
   - [Comparator](https://github.com/leanprover/comparator), the Lean FRO's
     adversarial proof checker, which rebuilds statement and proof in a
     Landlock sandbox and replays the proof through the Lean kernel.

   The first session that passes ends the attempt.
5. **Records.** Each run freezes its configuration in `manifest.json` (harness
   commit, image, Lean and Mathlib versions, problem commit, model, reasoning
   effort, search, budgets), and [`scripts/analyze.py`](scripts/analyze.py)
   writes one row per attempt to `results.csv`: verdict, sessions used, tokens,
   total and working time, tool and model calls, proof length and axioms.

## Quick start on a PC with Docker

```bash
git clone https://github.com/proof-bench/proofbench-eval-apptainer
cd proofbench-eval-apptainer
git clone https://github.com/proof-bench/proofbench              # the problems
python3 -m venv .venv && . .venv/bin/activate && pip install -e .

export IDS="P088 P089 P090"            # problems of this run (three calibration problems)
scripts/build_image.sh                 # sandbox image; 30-60 min the first time
echo "ANTHROPIC_API_KEY=..." >> .env   # keys stay on the host; the agents never see them
MODEL=anthropic/claude-opus-5-5 scripts/run.sh
inspect view --log-dir logs            # browse the transcripts
```

## On an HPC cluster with Apptainer

Clusters rarely offer Docker. The same image runs under Apptainer through
[inspect-apptainer](https://github.com/proof-bench/inspect-apptainer), and it
can be built there without root:

```bash
pip install -e . && pip install git+https://github.com/proof-bench/inspect-apptainer
IDS="..." scripts/build_image.sh --apptainer          # from image/proofbench.def, about 40 min
IDS="..." scripts/build_image.sh --update old.sif     # after problems change: rebuild on top of an image
scripts/hpc_preflight.sh proofbench-sandbox.sif       # network namespace, binds, Landlock, tmpfs
IDS="..." MODEL=... sbatch scripts/slurm_eval.sbatch  # one run as a Slurm job
```

Where Docker is available, `scripts/build_image.sh --sif` builds the Docker
image and converts it. `scripts/hpc_preflight.sh` prints PASS, WARN or FAIL for
everything the harness needs from the cluster; run it once on a compute node.

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
| `EFFORT`                | model default | reasoning effort (`low` ... `max`)              |
| `SEARCH`                | `false`       | web search tool (Tavily; `SEARCH_PROVIDER=exa`) |
| `NETWORK`               | = `SEARCH`    | internet access in the sandbox                  |
| `SANDBOX`               | `docker`      | `docker` or `apptainer`                         |
| `COMPARATOR`            | `on`          | second grading layer                            |
| `SESSIONS`              | `10`          | sessions per problem                            |
| `SESSION_OUTPUT_TOKENS` | `30000`       | output-token budget per session                 |
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
scripts/build_image.sh       stage the statements the selected problems import; build the image
scripts/run.sh               one run: manifest, evaluation, results.csv
scripts/slurm_eval.sbatch    one run as a Slurm job with the Apptainer sandbox
scripts/hpc_preflight.sh     day-one checks on a cluster
scripts/analyze.py           logs -> results.csv
```

## Good to know

- A submission is the main file `Submission/Pxxx.lean` plus every file under
  `Submission/` that it imports, transitively. All of them are checked and
  built before the main file compiles.
- Comparator needs Landlock in the host kernel; `scripts/hpc_preflight.sh`
  checks that it actually engages.
- Claimed solutions of open problems are checked by hand before any claim is
  made.
- Reasoning-effort settings differ between vendors, and some models always
  think; record the effort per model and report it.
- `scripts/check_statements.sh`, `scripts/verify_comparator.sh` and
  `scripts/solution_to_submission.py` test the grading against our reference
  proofs; they need the private development repository.
