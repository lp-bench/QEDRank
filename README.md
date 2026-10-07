# inspect-apptainer

An [Inspect AI](https://inspect.aisi.org.uk/) sandbox environment backed by
[Apptainer](https://apptainer.org/) (formerly Singularity), for running agent
evaluations on HPC clusters where Docker is not available and users have no
root. Each sample gets a fresh container instance with no host environment, no
network and no host directories; everything it writes is discarded with the
sample.

Status: implemented and passing Inspect's sandbox conformance suite (49 checks)
on Apptainer 1.5; not yet tried on a cluster.

## Usage

```bash
pip install inspect-apptainer   # or: pip install -e path/to/inspect-apptainer
```

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

Build the `.sif` where you have root or Docker and copy it to the cluster, e.g.
`apptainer build image.sif docker-daemon://my-image:latest` or
`apptainer pull image.sif docker://python:3.12`.

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
    it; `--writable-tmpfs` makes the rest of the image writable through a small
    in-memory overlay (its size is set by the site, 64 MiB by default).
  - No host directory other than those scratch directories is bound.
- `exec` runs `apptainer exec --cleanenv --pwd DIR instance://NAME /bin/sh
  SCRIPT`. Commands travel as scripts in a per-sample control directory (bound
  read-only at `/.inspect-apptainer`), not as arguments: Apptainer caps the
  argument list and `--env` values at 1 MiB. The script exports the requested
  environment and `exec`s the command, so the process the agent sees is the
  command itself. Timeouts use the in-container `timeout` binary, so the whole
  process group is killed when the limit fires.
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
- An image with `/bin/sh`, `tar`, `base64` and a `timeout` binary
  (`timeout_command`, default `/usr/bin/timeout`; GNU coreutils and BusyBox both
  work).
- Writable paths the agent needs must be listed in `writable` (or fit in the
  tmpfs overlay): the image is read-only and the agent is not root.

## Tests

```bash
pip install -e '.[test]'
apptainer pull tests/alpine.sif docker://alpine:3.20
pytest
```

The suite is Inspect's portable `self_check` plus Apptainer-specific checks
(no host environment, no network, PID namespace, background processes survive,
fresh scratch per sample). Set `INSPECT_APPTAINER_TEST_IMAGE` to test another
image.

## Prior art

Inspect has no Apptainer sandbox; its maintainers welcomed one
([inspect_ai#2764](https://github.com/UKGovernmentBEIS/inspect_ai/issues/2764)).
Related code: VectorInstitute/inspect-podman, mini-swe-agent's `singularity`
environment, NVIDIA ProRL's `SingularityRuntime`.

## License

To be decided.
