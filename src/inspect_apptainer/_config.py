"""Configuration of the Apptainer sandbox.

The task's ``sandbox`` is ``("apptainer", CONFIG)`` where CONFIG is a path to a
``.sif`` image, a path to a YAML/JSON file with the fields below, or an
``ApptainerSandboxConfig``.
"""

import json
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


class ApptainerSandboxConfig(BaseModel, frozen=True):
    image: str
    """Image to run: a ``.sif`` path, or any image URI Apptainer accepts."""

    network: Literal["none", "host"] = "none"
    """``none`` starts the instance in an empty network namespace (``--net
    --network none``, the only network an unprivileged user may request);
    ``host`` shares the host network."""

    writable: list[str] = Field(default_factory=lambda: ["/tmp", "/var/tmp"])
    """Container paths that get a fresh, per-sample host scratch directory bound
    over them.  Everything written there is discarded with the sample.  The
    Inspect sandbox tools are installed under ``/var/tmp``."""

    writable_tmpfs: bool = True
    """Make the rest of the image writable through a small in-memory overlay
    (``--writable-tmpfs``; its size is set by the site, 64 MiB by default)."""

    binds: list[str] = Field(default_factory=list)
    """Extra ``--bind`` specifications (``src:dst[:ro]``), e.g. read-only data."""

    env: dict[str, str] = Field(default_factory=dict)
    """Environment variables set for every command.  The host environment is
    never passed in (``--cleanenv``); the image's own environment still applies."""

    workdir: str = "/"
    """Working directory for commands and for relative file paths."""

    timeout_command: str = "/usr/bin/timeout"
    """In-container ``timeout`` binary that bounds each command (GNU coreutils
    kills the whole process group; BusyBox only the direct child)."""

    fakeroot: bool = False
    """Start the instance with ``--fakeroot`` (appear as root inside)."""

    apptainer: str | None = None
    """Path or name of the Apptainer binary; by default ``apptainer`` is used,
    then ``singularity``."""

    start_args: list[str] = Field(default_factory=list)
    """Extra arguments for ``instance start``."""

    exec_args: list[str] = Field(default_factory=list)
    """Extra arguments for every ``exec``."""

    start_timeout: int = 600
    """Seconds allowed for ``instance start`` (large images mount slowly)."""

    def __hash__(self) -> int:
        # Inspect hashes sandbox configs to group samples; list and dict fields
        # make pydantic's default hash fail.
        return hash(self.model_dump_json())


def resolve_config(config: BaseModel | str | None) -> ApptainerSandboxConfig:
    if config is None:
        raise ValueError(
            "the apptainer sandbox needs a config: sandbox=('apptainer', 'image.sif') "
            "or a path to an apptainer.yaml"
        )
    if isinstance(config, ApptainerSandboxConfig):
        return config
    if isinstance(config, BaseModel):
        return ApptainerSandboxConfig(**config.model_dump())
    path = Path(config)
    if path.suffix in (".yaml", ".yml", ".json"):
        text = path.read_text(encoding="utf-8")
        data = json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)
        if not isinstance(data, dict):
            raise ValueError(f"{path}: expected a mapping of apptainer sandbox options")
        image = data.get("image")
        if isinstance(image, str) and "://" not in image and not Path(image).is_absolute():
            data["image"] = str((path.parent / image).resolve())
        return ApptainerSandboxConfig(**data)
    return ApptainerSandboxConfig(image=str(path))
