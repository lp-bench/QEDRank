# syntax=docker/dockerfile:1.7
#
# Sandbox and grader image for the ProofBench agent harness.
#
# The image holds what a test-taker may see: the Lean toolchain, Mathlib, the public
# ProofBench statement library (ProofBench.Mathlib_Problems) and the tools of the protocol
# (shell, Python with sympy and networkx, SageMath with GAP and nauty, CaDiCaL, the Lean
# language server through lean-lsp-mcp). The proctor material of the corpus (the theorem
# sandwich library, the bound/solution/disproof files, the database) is removed in a build
# stage of its own, so it is in no layer of the final image.
#
# The same image grades: `docker run --rm --network none … node qedrank/cli.js grade …`.
#
# Build from the QEDRank repository root with a ProofBench checkout as a named context:
#
#   docker build -f harness/sandbox/Dockerfile \
#       --build-context proofbench=/path/to/ProofBench \
#       --build-arg PROOFBENCH_COMMIT=$(git -C /path/to/ProofBench rev-parse HEAD) \
#       -t proofbench-sandbox:$(git -C /path/to/ProofBench rev-parse --short HEAD) .
#
# Record the image id (`docker image inspect --format '{{.Id}}' <tag>`) with every run; the
# harness does this when Docker is reachable.

# ---- 1. the problem set, stripped of everything a test-taker must not see -------------------
FROM ubuntu:24.04 AS problem-set
COPY --from=proofbench / /src
RUN set -eu; cd /src; \
    rm -rf .git .github ProofBench/Mathlib ProofBench/DATABASE worklist.md evaluation_phase.md CLAUDE.md; \
    for d in ProofBench/PROBLEMS/*/; do n="$(basename "$d")"; find "$d" -type f ! -name "$n.lean" -delete; done; \
    find /src -name '__pycache__' -type d -prune -exec rm -rf {} +; \
    test -d ProofBench/Mathlib_Problems

# ---- 2. the sandbox --------------------------------------------------------------------------
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
ARG PROOFBENCH_COMMIT=unknown
# Pin these for a reproducible image; the versions used are written to /opt/proofbench-image.json.
ARG LEAN_LSP_MCP_SPEC="lean-lsp-mcp"
ARG SAGE_SPEC="sage"
ARG NODE_MAJOR=22

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential pkg-config \
        ripgrep cadical jq bzip2 xz-utils zstd unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js for the grader (qedrank/cli.js grade); nothing else in the image depends on it.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Python, sympy, networkx and SageMath (which brings GAP and nauty) in one conda-forge
# environment; its python3 is first on PATH, so the `python` tool sees all of them.
ENV MAMBA_ROOT_PREFIX=/opt/conda
RUN curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C /usr/local/bin --strip-components=1 bin/micromamba \
    && micromamba create -y -n math -c conda-forge python=3.12 "${SAGE_SPEC}" sympy networkx pip \
    && micromamba clean -a -y
ENV PATH=/opt/conda/envs/math/bin:${PATH}
RUN pip install --no-cache-dir "${LEAN_LSP_MCP_SPEC}"

RUN useradd -m -s /bin/bash -u 1001 agent
USER agent
ENV HOME=/home/agent
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
ENV PATH=/home/agent/.elan/bin:${PATH}

# The Lake project: toolchain from lean-toolchain, Mathlib and the other dependencies from
# lake-manifest.json (cache for Mathlib, source build for the rest), the public library built.
COPY --from=problem-set --chown=agent:agent /src /workspace/ProofBench
WORKDIR /workspace/ProofBench
RUN set -eu; \
    lake exe cache get; \
    find ProofBench/Mathlib_Problems -name '*.lean' | sed 's|/|.|g; s|\.lean$||' | xargs -r lake build; \
    find ProofBench/PROBLEMS -name '*.lean' | sed 's|/|.|g; s|\.lean$||' | xargs -r lake build; \
    rm -rf .lake/packages/*/.git

# The grader: this repository's checker, with the evaluator commands compiled on first use.
COPY --chown=agent:agent package.json /opt/qedrank/package.json
COPY --chown=agent:agent lib /opt/qedrank/lib
COPY --chown=agent:agent qedrank /opt/qedrank/qedrank
COPY --chown=agent:agent lean/QEDRank/Audit.lean /opt/qedrank/lean/QEDRank/Audit.lean
RUN rm -rf /opt/qedrank/qedrank/test

# What this image contains, for the run record.
RUN set -eu; jq -n \
      --arg proofbench "${PROOFBENCH_COMMIT}" \
      --arg toolchain "$(cat lean-toolchain)" \
      --arg lean "$(lake env lean --version)" \
      --arg mathlib "$(jq -r '.packages[] | select(.name=="mathlib") | .rev' lake-manifest.json)" \
      --arg node "$(node --version)" \
      --arg python "$(python3 --version)" \
      --arg sage "$(micromamba list -n math 2>/dev/null | awk '$1=="sage"{print $2}')" \
      --arg lean_lsp_mcp "$(pip show lean-lsp-mcp 2>/dev/null | awk '/^Version/{print $2}')" \
      --arg cadical "$(dpkg-query -W -f='${Version}' cadical)" \
      '{proofbench_commit:$proofbench, lean_toolchain:$toolchain, lean:$lean, mathlib_commit:$mathlib, node:$node, python:$python, sage:$sage, lean_lsp_mcp:$lean_lsp_mcp, cadical:$cadical}' \
      > /tmp/proofbench-image.json
USER root
RUN mv /tmp/proofbench-image.json /opt/proofbench-image.json && chmod 644 /opt/proofbench-image.json
USER agent

ENV LEAN_PROJECT_PATH=/workspace/ProofBench
WORKDIR /workspace/ProofBench
CMD ["sleep", "infinity"]
