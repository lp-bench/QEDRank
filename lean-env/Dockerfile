# syntax=docker/dockerfile:1.7
# QEDRank Lean environment: one pinned Lean project, built, with its own toolchain.
#
#   node qedrank/cli.js lean-env build --project <lean project dir> [--tag qedrank-lean:<name>] [--apptainer]
#
# The CLI streams the build context as a tar: the project directory (without .lake and .git)
# under project/, this file and build-modules.sh under qedrank/ — kept apart so that the project
# layers only change when the project does. The image is reproducible from the sources: the toolchain named in lean-toolchain,
# Mathlib's object files from the public cache when the project depends on Mathlib, every other
# package and the project itself built from source. The project's git commit, dirty flag and the
# build time are recorded in /project/.qedrank-lean-env.json (QEDRANK_LEAN_ENV_MANIFEST) and copied
# into run.json by QEDRank. The image is benchmark-neutral: it contains no QEDRank code; the
# evaluator module (lean/QEDRank/Audit.lean) is compiled at grading time into runs/.grade-cache,
# which QEDRank mounts into every container.
#
# Runtime contract (qedrank/lib/leanenv.js): the project is at /project, `lake env` works there,
# `sh`, `cat` and `printf` exist, and QEDRank mounts its run folders at /work (and the host's
# temp directory at /work-tmp). Nothing in the image is written at run time.

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tar zstd \
 && rm -rf /var/lib/apt/lists/*

# elan outside any home directory, so the image works under Apptainer's --containall as well.
ENV ELAN_HOME=/opt/elan
ENV PATH=/opt/elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN curl -sSfL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh \
 && sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain none \
 && rm /tmp/elan-init.sh

WORKDIR /project

# The toolchain first, in its own layer: it only changes when lean-toolchain does. A checkout on
# Windows may carry CRLF line endings; elan and Lake want the bare name.
COPY project/lean-toolchain ./
RUN sed -i 's/\r$//' lean-toolchain \
 && TC="$(tr -d '\r\n' < lean-toolchain)" && elan toolchain install "$TC" && elan default "$TC"

COPY project/ ./
RUN sed -i 's/\r$//' lean-toolchain

# Mathlib's prebuilt object files (gigabytes; the cache directory is a build-time mount, not a
# layer). The dependency clones are large; a failed fetch is retried from a clean packages folder.
RUN --mount=type=cache,target=/root/.cache/mathlib \
    if grep -q '"mathlib"' lake-manifest.json 2>/dev/null; then \
      ok=0; for attempt in 1 2 3; do \
        if lake exe cache get; then ok=1; break; fi; \
        echo "qedrank: cache get failed (attempt $attempt); retrying"; rm -rf .lake/packages; sleep 15; \
      done; [ "$ok" = 1 ]; \
    fi

# Everything the project declares, from source where no cache applies (e.g. the Matroid fork):
# `lake build` for the libraries' roots, then every module of every library (or of the prefixes in
# LEAN_MODULES, e.g. ProofBench.Mathlib_Problems), since Lake's default target stops at the roots
# and a statement library's root may import nothing. Modules that fail to build are listed in
# /project/.qedrank-build-warnings.txt and reported by QEDRank's probe.
COPY qedrank/build-modules.sh /usr/local/bin/qedrank-build-modules
ARG LEAN_MODULES=""
RUN lake build && sh /usr/local/bin/qedrank-build-modules $LEAN_MODULES

# What was built, for run.json and `lean-env status`.
ARG QEDRANK_LEAN_ENV_MANIFEST='{"schema":"qedrank-lean-env-v1"}'
RUN printf '%s\n' "$QEDRANK_LEAN_ENV_MANIFEST" > /project/.qedrank-lean-env.json

LABEL org.qedrank.lean-env="1"
CMD ["lake", "env"]
