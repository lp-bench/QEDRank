#!/usr/bin/env bash
# One-time setup: the Python environment .venv with the harness and the Apptainer sandbox
# (../inspectAI-apptainer, part of this repository). Run it again after moving or renaming the
# folder: a virtual environment records absolute paths, so it is rebuilt from scratch.
# usage: scripts/setup.sh [python]      (default python3; Python 3.11 or newer)
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${1:-python3}
"$PY" -m venv --clear .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -e ../inspectAI-apptainer -e .
.venv/bin/python -c "import inspect_ai, inspect_apptainer, proofbench_eval; print(f'ready: inspect_ai {inspect_ai.__version__}; activate with: . .venv/bin/activate')"
