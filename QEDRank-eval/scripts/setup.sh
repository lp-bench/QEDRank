#!/usr/bin/env bash
# One-time setup: the Python environment .venv with the harness and the Apptainer sandbox
# (../inspectAI-apptainer, part of this repository). Run it again after moving or renaming the
# folder: a virtual environment records absolute paths, so it is rebuilt from scratch.
# usage: scripts/setup.sh [python]      (default python3; Python 3.11 or newer; on Windows see README)
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${1:-python3}
"$PY" -m venv --clear .venv
BIN=.venv/bin; [ -d .venv/Scripts ] && BIN=.venv/Scripts  # Windows keeps the environment's programs in Scripts
"$BIN/python" -m pip install --quiet --upgrade pip
"$BIN/python" -m pip install --quiet -e ../inspectAI-apptainer -e .
"$BIN/python" -c "import inspect_ai, inspect_apptainer, proofbench_eval; print(f'ready: inspect_ai {inspect_ai.__version__}; activate with: . $BIN/activate')"
