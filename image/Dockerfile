# Sandbox image: Lean toolchain + Mathlib cache + the ProofBench statement layer
# + lean-lsp-mcp.  Build with scripts/build_image.sh (it stages image/context).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates python3 python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/opt/venv/bin:$PATH
COPY context/lean-toolchain /tmp/lean-toolchain
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      | sh -s -- -y --no-modify-path --default-toolchain "$(cat /tmp/lean-toolchain)"
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir lean-lsp-mcp==0.31.0 inspect-ai==0.3.276 inspect-tool-support \
    && inspect-tool-support post-install --no-web-browser
WORKDIR /opt/proofbench
COPY context/ /opt/proofbench/
RUN lake exe cache get && lake build ProofBench.Visible && mkdir -p Submission \
    && lake env lean ProofBench/Visible.lean
