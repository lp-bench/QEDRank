# proofbench-eval

Inspect AI harness for running ProofBench with the same agent loop, tools,
sandbox and budgets for every model, and grading proofs with Lean alone.
The private problems and the proctor library never enter this repository:
the statements live in a clone of the private proofbench-statements repo,
in the gitignored folder `proofbench-statements/`, and a run names its
problems with `IDS`.

## Layout

    proofbench_eval/task.py     Inspect task: ReAct agent + bash/python + lean-lsp-mcp (+ web search)
    proofbench_eval/scorer.py   two-layer grading in a fresh `verifier` container: check_proof.py, then Comparator
    image/check_proof.py        layer 1: statement unchanged, allowed imports, no sorry/axiom, compiles, standard axioms
    image/Dockerfile            Lean toolchain + Mathlib cache + ProofBench statement layer + lean-lsp-mcp
                                + the verifier: Comparator (leanprover/comparator), lean4export, landrun
                                + Python (sympy, networkx, python-sat), SageMath (GAP, nauty), CaDiCaL
    image/compose*.yaml         docker sandbox, with and without network
    scripts/build_image.sh      stage only the statement modules the exported problems import; build the image
    scripts/build_apptainer.sh  convert the image to .sif for HPC
    scripts/run.sh              one run on a Docker machine (writes manifest, runs, analyses)
    scripts/slurm_eval.sbatch   one run on Slurm with the Apptainer sandbox
    scripts/analyze.py          logs -> results.csv (verdict, tokens, time, tool calls, lines, axioms)

## Setup on a machine with Docker (university server or a PC with Docker)

    python3 -m venv .venv && . .venv/bin/activate && pip install -e .
    git clone <proofbench-statements> proofbench-statements   # private; gitignored here
    export IDS="P083 P088 P090"                     # the problems of this run
    scripts/build_image.sh                          # ~30-60 min the first time (Mathlib cache)
    export ANTHROPIC_API_KEY=... OPENAI_API_KEY=... TAVILY_API_KEY=...
    MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=false scripts/run.sh
    MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=true  scripts/run.sh
    inspect view --log-dir logs                     # browse transcripts

Models are addressed as `provider/name` (`anthropic/claude-opus-5`,
`openai/gpt-5.6`, `google/gemini-3.1-pro`, `grok/grok-4`).  Model access is
through the providers' APIs with API keys; chat subscriptions do not work here.

## Setup without Docker (Apptainer, for HPC)

The same image runs under Apptainer through the
[inspect-apptainer](../inspect-apptainer) sandbox: Inspect runs on the node
and starts one container instance per problem with no host environment (no
API keys), no network and no host directories inside; only the problem file is
copied in.  Build the image where Docker exists and convert it:

    IDS="P088 P089 P090" scripts/build_image.sh --sif      # docker build + proofbench-sandbox.sif
    pip install -e ../inspect-apptainer
    SANDBOX=apptainer MODEL=openai-api/qwen/qwen3.8-27b scripts/run.sh

Without Docker anywhere, `scripts/build_image.sh --apptainer` builds the
`.sif` from `image/proofbench.def` with `--fakeroot` instead.

Any OpenAI-compatible endpoint works with `openai-api/<name>/<model>` and the
variables `<NAME>_API_KEY`, `<NAME>_BASE_URL` in `.env`, e.g.
`QWEN_BASE_URL=https://chat-ai.academiccloud.de/v1` (GWDG) for hosted
open-weight models.

## Setup on HPC

1. Build `proofbench-sandbox.sif` as above and copy it to the cluster.
2. Clone this repo and `proofbench-statements` (into the repo folder) on the
   cluster; create the venv: `pip install -e . -e ../inspect-apptainer`.
3. Put API keys in `.env` (Inspect reads it; the agents never see it).
4. Check that a compute node can reach the provider (`curl -sI https://api.anthropic.com`);
   otherwise set `HTTPS_PROXY` in `.env`.
5. Check once that an unprivileged `apptainer instance start --net --network none`
   works on a compute node; if the site disallows network namespaces, the
   sandbox config needs `network: host`.
6. `IDS="..." MODEL=anthropic/claude-opus-5 sbatch scripts/slurm_eval.sbatch`

For a self-hosted open-weight model (Kimi on a GPU node): start vLLM with an
OpenAI-compatible endpoint and use `MODEL=openai-api/kimi/<served-name>` with
`KIMI_BASE_URL=http://<gpu-node>:8000/v1` in `.env`.

## Frozen per run (manifest.json)

harness commit, image id, Lean toolchain, ProofBench commit of the exported
problems, model, reasoning effort, search on/off and provider, network,
epochs, token/time/working limits.  Change any of these and it is a new run.

## Known limits

* Grading runs in a second container the agent never touched; only the
  submission's source text crosses over.  Layer 1 is the textual and compile
  check of `check_proof.py`; layer 2 is Comparator, which rebuilds statement
  and submission in a Landlock sandbox, requires identical statements and
  dependencies, replays the proof through the Lean kernel and checks the
  axioms.  Comparator needs Landlock in the host kernel (check `landrun`
  actually engages on a new machine).  Solves of open problems are still
  audited by hand.
* Uniformity across vendors is not perfect: reasoning-effort dials differ, and
  Fable has always-on thinking.  Record the effort per model and report it.
