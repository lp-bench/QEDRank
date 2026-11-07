# inspect-apptainer

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)

**Run [Inspect AI](https://inspect.aisi.org.uk/) agent evaluations on HPC
clusters, where Docker is not available and you have no root.**

Inspect runs agents inside sandboxes, but its isolated sandboxes need Docker,
Kubernetes or cloud machines, which university and national clusters rarely
offer to their users. inspect-apptainer adds a sandbox backed by
[Apptainer](https://apptainer.org/) (formerly Singularity), the container
runtime that HPC centres do provide. Point a task at a `.sif` image, and every
sample gets its own fresh container:

- no host environment, so no API keys inside;
- no network, unless you ask for the host network;
- no host directories, only fresh scratch space that is deleted with the sample;
- its own process namespace, so the agent cannot look into the Inspect process.

It passes Inspect's sandbox conformance suite (49 checks) on Apptainer 1.5, and
it runs the [LPBench evaluation harness](https://github.com/lp-bench/QEDRank), whose
repository holds this package in the folder `inspectAI-apptainer/`.
It has been tested on a workstation and in CI; reports from clusters are welcome.

## Install

```bash
pip install "git+https://github.com/lp-bench/QEDRank#subdirectory=inspectAI-apptainer"
```

## Usage

```python
from inspect_ai import Task
from inspect_apptainer import ApptainerSandboxConfig

Task(..., sandbox=("apptainer", "path/to/image.sif"))

Task(..., sandbox=("apptainer", ApptainerSandboxConfig(
    image="path/to/image.sif",
    workdir="/opt/project",                       # cwd for commands and relative paths
    writable=["/tmp", "/var/tmp", "/opt/project/work"],  # fresh scratch per sample
    network="none",                               # or "host"
)))
```

Or `sandbox=("apptainer", "apptainer.yaml")` with the same fields as YAML
(a relative `image` is resolved against the YAML file).

`services={"verifier": {"network": "none"}}` starts additional named instances
per sample from the same config with the given fields overridden; the task
reaches them as `sandbox("verifier")`, e.g. to grade in a container the
agent never touched.

Build the `.sif` anywhere and copy it to the cluster:
`apptainer pull image.sif docker://python:3.12` needs no root, and
`apptainer build image.sif docker-daemon://my-image:latest` converts a local
Docker image.

## How it works

One Apptainer instance per sample:

- `sample_init` runs `apptainer instance start --containall --cleanenv
  --writable-tmpfs [--net --network none] --bind ... IMAGE NAME`.
  - `--containall` isolates the PID and IPC namespaces as well as the
    filesystem. Without it an agent running as the same user could read the API
    keys of the Inspect process from `/proc/<pid>/environ`.
  - `--cleanenv` passes no host environment variables; the image's own
    environment still applies.
  - `--network none` is the only network an unprivileged user may request.
  - Every path in `writable` gets a fresh per-sample host directory bound over
    it; a path also listed in `seed` has that directory filled with the image's
    content first (`cp -a` in a throwaway container), so a populated directory
    of the image becomes writable. `--writable-tmpfs` (`writable_tmpfs`, on by
    default) makes the rest of the image writable through a small in-memory
    overlay (its size is set by the site, 64 MiB by default). Leave it off for
    long sandboxes that read many files: rootless Apptainer provides that
    overlay with `fuse-overlayfs`, which keeps one file descriptor per file ever
    looked up and, at the process's limit, makes every `open()` in the sandbox
    fail with "Too many open files" (a Lean sandbox on a cluster with a 131,072
    limit got there after about 3,000 commands). Without it the root is a
    read-only kernel overlay and only the `writable` paths can be written.
  - No host directory other than those scratch directories is bound.
- `exec` runs `apptainer exec --cleanenv --pwd DIR instance://NAME /bin/sh
  SCRIPT`. Commands travel as scripts in a per-sample control directory (bound
  read-only at `/.inspect-apptainer`), not as arguments: Apptainer caps the
  argument list and `--env` values at 1 MiB. The script exports the requested
  environment and `exec`s the command, so the process the agent sees is the
  command itself. A command with a timeout runs under a small shell watchdog:
  every process it starts inherits a marker in its environment, and all of them
  are killed when the limit fires and when the command returns, also those that
  left the process group or session (`timeout`, `setsid`, `nohup`, background
  jobs). An in-container `timeout` misses those, and as they keep the command's
  output open, the exec would not return until they exit. A timed-out command
  is never retried, since running it again would repeat its side effects.
- `write_file` and `read_file` go through `exec` (stdin and stdout); host-issued
  commands launch `/bin/sh` by absolute path with a pinned `PATH`.
- `sample_cleanup` stops the instance and deletes the scratch directories.
- Commands run as the invoking user. Apptainer has no user switching, so
  `exec(user=...)` for another user raises `SandboxUserUnsupportedError` and
  Inspect installs its sandbox tools in rootless mode.
- `inspect sandbox cleanup apptainer` stops instances left behind (names start
  with `inspect-`).

## Requirements

- Apptainer (or Singularity) with user bind mounts enabled (`user bind control
  = yes`, the default) and network namespaces allowed for users (if a site
  disables them, set `network: host`).
- An image with `/bin/sh`, `tar`, `base64`, `sleep`, `tr`, `grep`, `kill` and,
  for `seed`, `cp` (GNU coreutils and BusyBox both work).
- Writable paths the agent needs must be listed in `writable` (seeded from the
  image with `seed` where the image ships content there, or fitting in the
  tmpfs overlay if `writable_tmpfs` is on): the image is read-only and the
  agent is not root.

## Tests

```bash
pip install -e '.[test]'
apptainer pull tests/alpine.sif docker://alpine:3.20
pytest
```

The suite is Inspect's portable `self_check` plus Apptainer-specific checks
(no host environment, no network, PID namespace, background processes of a
command without timeout survive, a command with a timeout ends every process it
started and is not retried, fresh scratch per sample). Set `INSPECT_APPTAINER_TEST_IMAGE` to test another
image.

## Prior art

Inspect has no Apptainer sandbox; its maintainers welcomed one
([inspect_ai#2764](https://github.com/UKGovernmentBEIS/inspect_ai/issues/2764)).
Related code: VectorInstitute/inspect-podman, mini-swe-agent's `singularity`
environment, NVIDIA ProRL's `SingularityRuntime`.

## License

MIT; see [LICENSE](LICENSE).
