# Lean environment images

QEDRank compiles and grades proofs in a pinned Lean project. That project can be a built
directory on the machine (`--lean-project`, the default when one exists), or an image built from
it with the files here, so that a machine without elan, Mathlib or a long `lake build` — a DGX, a
reviewer's laptop, an HPC node — grades exactly the same way:

| Backend | What runs | Where it fits |
|---|---|---|
| `host` | `lake env lean` in the built project directory | a developer PC that already has the build |
| `docker` | one `docker run --rm --network none` per Lean process, run folders bind-mounted | any machine with Docker |
| `apptainer` | one `apptainer exec --containall` per Lean process, from the `.sif` | HPC nodes without root or Docker |

`verification.backend` in `qedrank.config.json` (or `--backend`) chooses; `auto` (the default)
takes the host project when it is built, else the Docker image, else the `.sif`. The grader, the
statistics and the page are unchanged; `run.json` records which environment graded the run
(`toolchain.environment`: kind, image id or `.sif`, the project's commit).

## Build

```bash
cd QEDRank_java
node qedrank/cli.js lean-env build --project C:/QEDRank/proofbench-statements --tag qedrank-lean:proofbench-466b32a --modules ProofBench,Matroid
node qedrank/cli.js lean-env build --project C:/QEDRank/proofbench-statements --tag qedrank-lean:proofbench-466b32a --modules ProofBench,Matroid --apptainer   # also the .sif (or a docker-archive tar + the command for the cluster)
node qedrank/cli.js lean-env status                                                        # what this machine has, and what a run would use
```

`Dockerfile` is benchmark-neutral: it installs the toolchain named in the project's
`lean-toolchain`, fetches Mathlib's object files from the public cache when the project depends on
Mathlib, and builds everything else from source — `lake build` for the libraries' roots, then
**every module of every library** (`build-modules.sh`), because Lake's default target stops at the
roots and a statement library's root (`ProofBench.lean`) may import nothing. `--modules` limits
that sweep to prefixes; a prefix that names a dependency package under `.lake/packages/` (the
Matroid fork, which Mathlib's cache does not cover) builds that package. For ProofBench use
`--modules ProofBench,Matroid`: the challenge files import the statement library *and* other
problem modules (`ProofBench.PROBLEMS.Pxxx.Pxxx`), so the whole library is needed. `node
qedrank/cli.js run … --dry-run --backend docker` runs the corpus's import check inside the image
and names whatever is still missing. Modules that fail to build are listed in the image
(`/project/.qedrank-build-warnings.txt`) and shown by `lean-env status`. The build context is the project's sources
(without `.lake` and `.git`), streamed by the CLI; the project's git commit and dirty flag go into
`/project/.qedrank-lean-env.json`. Tag images per project and commit when you keep several, e.g.
`--tag qedrank-lean:proofbench-466b32a`, and set `verification.image` accordingly.

Expect 30–90 minutes and 8–10 GB for a Mathlib project. The Docker daemon must be running (on
Windows: Docker Desktop); the Mathlib cache download needs network during the build only.

## Run

```bash
node qedrank/cli.js run ... --backend docker                                   # or verification.backend in the config
node qedrank/cli.js resume --run-id <id> --reevaluate --no-generate --backend apptainer --sif qedrank-lean.sif   # re-grade on a cluster
node qedrank/cli.js grade --challenge P001.lean --solution sol.lean --backend docker
```

Compiled files live in the run folder, which is mounted at `/work` inside the container (the
system temp directory at `/work-tmp`, for `grade --scratch` and the harness re-grader); nothing is
written into the image. The container has no network. Lean's own memory (`lean.memoryMb`) and
heartbeat limits apply unchanged; the wall-clock timeout kills the container as well as the client.

Limits: the formalize task's per-paper prelude is built with `lake build` inside the project tree,
which needs a host project — a container environment records that as an infrastructure failure
for the prelude rather than guessing. `lean-bench` and `proof-metrics` read the project's own
files from the host directory given with `--project`.

## Apptainer on a cluster

1. Build the `.sif` where Docker exists (`--apptainer`), or copy the docker-archive tar and run
   `apptainer build qedrank-lean.sif docker-archive://qedrank-lean.docker.tar` on the login node.
2. `scripts/hpc_preflight.sh` in the ProofBench harness folder checks the site's Apptainer
   settings; for QEDRank only `apptainer exec --containall --cleanenv --bind` is needed, no
   network namespace.
3. Site policies that need extra flags go into `verification.apptainerArgs` (or `dockerArgs`).
