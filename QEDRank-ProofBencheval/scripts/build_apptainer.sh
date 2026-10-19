#!/usr/bin/env bash
# Convert the Docker image to an Apptainer image for HPC (run where Docker exists).
# usage: scripts/build_apptainer.sh [out.sif]
set -euo pipefail
OUT=${1:-proofbench-sandbox.sif}
apptainer build "$OUT" docker-daemon://proofbench-sandbox:latest
echo "built $OUT; copy it to the cluster and point scripts/slurm_eval.sbatch at it"
