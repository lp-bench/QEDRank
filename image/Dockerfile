# Sandbox image: Lean toolchain + Mathlib cache + the ProofBench statement layer
# + lean-lsp-mcp.  Build with scripts/build_image.sh (it stages image/context).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates python3 python3-venv build-essential bzip2 \
      cadical nauty \
    && rm -rf /var/lib/apt/lists/*
# SageMath (bundles GAP, PARI and nauty) from conda-forge via micromamba: the
# Ubuntu archive has no sagemath package for 24.04.
ENV MAMBA_ROOT_PREFIX=/opt/micromamba
RUN curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /usr/local bin/micromamba \
    && micromamba create -y -q -p /opt/sage -c conda-forge sage python=3.12 \
    && micromamba clean -y -a \
    && ln -s /opt/sage/bin/sage /usr/local/bin/sage && ln -s /opt/sage/bin/gap /usr/local/bin/gap
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/opt/venv/bin:$PATH
COPY context/lean-toolchain /tmp/lean-toolchain
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      | sh -s -- -y --no-modify-path --default-toolchain "$(cat /tmp/lean-toolchain)"
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --timeout 120 --retries 10 lean-lsp-mcp==0.31.0 inspect-ai==0.3.276 inspect-tool-support \
         sympy networkx python-sat numpy scipy \
    && inspect-tool-support post-install --no-web-browser
# ripgrep: lean-lsp-mcp's lean_local_search needs `rg`.  A separate layer so the
# layers above (SageMath, toolchain) stay cached.
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/proofbench
# Mathlib's compiled cache depends only on the pinned manifest, so download it
# before copying the problem-specific files: a new IDS selection reuses it.
COPY context/lean-toolchain context/lakefile.toml context/lake-manifest.json /opt/proofbench/
RUN lake exe cache get
COPY context/ /opt/proofbench/
RUN lake build ProofBench.Visible && mkdir -p Submission \
    && lake env lean ProofBench/Visible.lean
