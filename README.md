# proofbench-eval

Inspect AI harness for running ProofBench with the same agent loop, tools,
sandbox and budgets for every model, and grading proofs with Lean alone.
The private problems and the proctor library never enter this repository:
`scripts/export_problems.py` copies only the statement files into the
gitignored `data/` folder.

## Layout

    proofbench_eval/task.py     Inspect task: ReAct agent + bash/python + lean-lsp-mcp (+ web search)
    proofbench_eval/scorer.py   scorer: streams image/check_proof.py into the sandbox
    image/check_proof.py        statement unchanged, allowed imports, no sorry/axiom, compiles, standard axioms
    image/Dockerfile            Lean toolchain + Mathlib cache + ProofBench statement layer + lean-lsp-mcp
                                + Python (sympy, networkx, python-sat), SageMath (GAP, nauty), CaDiCaL
    image/compose*.yaml         docker sandbox, with and without network
    scripts/export_problems.py  stage problems from the ProofBench repo
    scripts/build_image.sh      stage the statement layer and build the image
    scripts/build_apptainer.sh  convert the image to .sif for HPC
    scripts/run.sh              one run on a Docker machine (writes manifest, runs, analyses)
    scripts/slurm_eval.sbatch   one run on Slurm with Apptainer and the local sandbox
    scripts/analyze.py          logs -> results.csv (verdict, tokens, time, tool calls, lines, axioms)

## Setup on a Docker machine

    python3 -m venv .venv && . .venv/bin/activate && pip install -e .
    scripts/export_problems.py --proofbench ../ProofBench --ids P083 P088 P090
    scripts/build_image.sh ../ProofBench            # ~30-60 min the first time (Mathlib cache)
    export ANTHROPIC_API_KEY=... OPENAI_API_KEY=... TAVILY_API_KEY=...
    MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=false EPOCHS=4 scripts/run.sh
    MODEL=anthropic/claude-opus-5 EFFORT=high SEARCH=true  EPOCHS=4 scripts/run.sh
    inspect view --log-dir logs                     # browse transcripts

Models are addressed as `provider/name` (`anthropic/claude-opus-5`,
`openai/gpt-5.6`, `google/gemini-3.1-pro`, `grok/grok-4`).  Model access is
through the providers' APIs with API keys; chat subscriptions do not work here.

## Setup without Docker (Apptainer: a WSL or Linux PC, or HPC)

    scripts/build_image.sh --apptainer ../ProofBench     # builds proofbench-sandbox.sif, no Docker needed
    export SIF=$PWD/proofbench-sandbox.sif
    MODEL=openai-api/qwen/qwen3-max bash scripts/slurm_eval.sbatch   # works without Slurm too

The run script uses Inspect's local sandbox inside the container, so samples
run one at a time.  Set `QWEN_API_KEY` and
`QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1` in
`$HOME/.proofbench_keys` for Qwen; any OpenAI-compatible endpoint works the
same way with `openai-api/<name>/<model>` and `<NAME>_API_KEY`, `<NAME>_BASE_URL`.

## Setup on HPC

1. Build the `.sif` as above (or on a Docker machine with
   `scripts/build_apptainer.sh`) and copy it to the cluster.
2. Clone this repo on the cluster and export the problems there too.
3. Put API keys in `$HOME/.proofbench_keys` (`export ANTHROPIC_API_KEY=...`).
4. Check that a compute node can reach the provider (`curl -sI https://api.anthropic.com`);
   otherwise set `HTTPS_PROXY` in the keys file or run from a login node.
5. `MODEL=anthropic/claude-opus-5 sbatch scripts/slurm_eval.sbatch`

For a self-hosted open-weight model (Kimi on a GPU node): start vLLM with an
OpenAI-compatible endpoint and use `MODEL=openai-api/kimi/<served-name>` with
`OPENAI_API_BASE=http://<gpu-node>:8000/v1` in the keys file.

## Frozen per run (manifest.json)

harness commit, image id, Lean toolchain, ProofBench commit of the exported
problems, model, reasoning effort, search on/off and provider, network,
epochs, token/time/working limits.  Change any of these and it is a new run.

## Known limits

* Statement integrity is checked textually (reference lines must survive in
  order, statement verbatim, imports restricted).  A transcript audit of every
  correct solve is still required before reporting.
* With the local sandbox (HPC) samples run one at a time; use Docker for parallel runs.
* Uniformity across vendors is not perfect: reasoning-effort dials differ, and
  Fable has always-on thinking.  Record the effort per model and report it.
