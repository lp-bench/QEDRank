# Sandbox image: Lean toolchain + Mathlib cache + the ProofBench statement layer
# + lean-lsp-mcp.  Build with scripts/build_image.sh (it stages image/context).
# ---- Verifier (second grading layer): Comparator, the Lean FRO's adversarial proof
# checker, with lean4export and landrun.  Pins as in epoch-research/LeanOpenProblems.
# Comparator is built with its own toolchain and never loads project files;
# lean4export reads the project's .olean files, so it is built with the project toolchain.
FROM golang:1.24-bookworm AS landrun_build
ARG LANDRUN_COMMIT=811cfff51ceaf3d9843708aa6d22e9b84ccac8b4
RUN git clone https://github.com/Zouuup/landrun.git /src/landrun \
    && git -C /src/landrun checkout --detach "${LANDRUN_COMMIT}" \
    && cd /src/landrun && CGO_ENABLED=0 go build -trimpath -o /out/landrun ./cmd/landrun

FROM ubuntu:24.04 AS lean_builder
ENV DEBIAN_FRONTEND=noninteractive ELAN_HOME=/opt/elan PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates build-essential libgmp-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --no-modify-path --default-toolchain none

FROM lean_builder AS comparator_build
ARG COMPARATOR_COMMIT=19e111e2141cf333c7daff0f64c5f24acc91dd2e
RUN git clone https://github.com/leanprover/comparator.git /opt/comparator \
    && git -C /opt/comparator checkout --detach "${COMPARATOR_COMMIT}" \
    && elan toolchain install "$(cat /opt/comparator/lean-toolchain)" \
    && cd /opt/comparator && lake build comparator \
    && mkdir -p /out/lib && cp .lake/build/bin/comparator /out/ \
    && cp -a "$(elan which lean --toolchain "$(cat lean-toolchain)" | xargs dirname)/../lib/lean/"*.so* /out/lib/ 2>/dev/null || true

FROM lean_builder AS lean4export_build
ARG LEAN4EXPORT_COMMIT=cacf989bd75f608700820f6afc595f32e7a99a4d
COPY context/lean-toolchain /tmp/lean-toolchain
RUN git clone https://github.com/leanprover/lean4export.git /opt/lean4export \
    && git -C /opt/lean4export checkout --detach "${LEAN4EXPORT_COMMIT}" \
    && cp /tmp/lean-toolchain /opt/lean4export/lean-toolchain \
    && elan toolchain install "$(cat /tmp/lean-toolchain)" \
    && cd /opt/lean4export && lake build lean4export && cp .lake/build/bin/lean4export /out-lean4export

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
# Mathlib's cache extracts owner-only files; the verifier user must read them (same layer: no copy-up).
RUN lake exe cache get && chmod -R a+rX /opt/proofbench/.lake
COPY context/ /opt/proofbench/
RUN xargs lake build < modules.txt && mkdir -p Submission

# Verifier binaries; the scorer runs comparator in a fresh container from this image.
COPY --from=landrun_build /out/landrun /opt/verifier/bin/landrun
COPY --from=comparator_build /out/comparator /opt/verifier/bin/comparator
COPY --from=comparator_build /out/lib/ /opt/verifier/lib/
COPY --from=lean4export_build /out-lean4export /opt/verifier/bin/lean4export
ENV COMPARATOR_LANDRUN=/opt/verifier/bin/landrun COMPARATOR_LEAN4EXPORT=/opt/verifier/bin/lean4export
# Comparator must not run as root; the verifier container runs it as this user,
# which therefore needs to write Submission/ and the project's own build outputs
# (not the dependency packages: a recursive chmod there would copy them into a new layer).
RUN useradd -m -u 1500 verifier && chmod a+rwX /opt/proofbench /opt/proofbench/.lake \
    && chmod -R a+rwX /opt/proofbench/.lake/build /opt/proofbench/Submission \
    && git config --system --add safe.directory '*'  # lake reads the root-owned package checkouts as this user
