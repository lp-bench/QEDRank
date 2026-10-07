# inspect-apptainer

An [Inspect AI](https://inspect.aisi.org.uk/) sandbox environment backed by
[Apptainer](https://apptainer.org/) (formerly Singularity), for running agent
evaluations on HPC clusters where Docker is not available and users have no root.

Status: work in progress. The package registers the `apptainer` sandbox type,
but its methods are not implemented yet.

## Design

One fresh Apptainer instance per sample:

- `sample_init` starts `apptainer instance start --containall --cleanenv
  --writable-tmpfs [--net --network none] IMAGE NAME`.
  - `--containall` isolates PID and IPC as well as the filesystem: without
    separate process IDs an agent running as the same user could read the API
    keys of the Inspect process from `/proc/<pid>/environ`.
  - `--cleanenv` passes no host environment variables (no keys).
  - `--writable-tmpfs` gives a scratch layer that is discarded at the end.
  - No host directory is bound into the instance.
  - `--network none` is the only network setting unprivileged users may
    request; some sites disable network namespaces, so it must be tested per
    cluster.
- `exec` runs each tool call as `apptainer exec instance://NAME ...`; no control
  channel back to Inspect is needed.
- `write_file` / `read_file` go through `exec` with stdin/stdout.
- `sample_cleanup` stops the instance, which discards the scratch layer.
- The `apptainer` binary is preferred; `singularity` is the fallback on clusters
  that still ship only that name.

## Usage (planned)

```python
Task(..., sandbox=("apptainer", "path/to/image.sif"))
```

## Prior art

Inspect has no Apptainer sandbox; its maintainers welcomed one
([inspect_ai#2764](https://github.com/UKGovernmentBEIS/inspect_ai/issues/2764)).
Related code: VectorInstitute/inspect-podman (Inspect plumbing),
mini-swe-agent's `singularity` environment and NVIDIA ProRL's
`SingularityRuntime` (Apptainer invocation).

## License

To be decided.
