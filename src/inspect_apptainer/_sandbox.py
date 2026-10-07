"""One fresh Apptainer instance per sample.

``sample_init`` starts ``apptainer instance start --containall --cleanenv
--writable-tmpfs [--net --network none] --bind ... IMAGE NAME``; every
command then runs as ``apptainer exec --cleanenv --pwd DIR instance://NAME
/bin/sh SCRIPT`` and ``sample_cleanup`` stops the instance and deletes the
scratch directories.

Commands travel as scripts, not as arguments: Apptainer puts the argument list
and ``--env`` values into a starter configuration capped at 1 MiB, so a large
command would be refused.  Each ``exec`` writes ``export`` lines and the
quoted command to a file in a per-sample control directory (bound read-only
at ``/.inspect-apptainer``) and deletes it afterwards.
Commands run as the invoking user: Apptainer has no user switching, so
``exec(user=...)`` is refused for any other user and Inspect installs its
sandbox tools in rootless mode.
"""

from __future__ import annotations

import base64
import dataclasses
import errno
import os
import pwd
import re
import shlex
import shutil
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Union, overload

from pydantic import BaseModel
from typing_extensions import override

from inspect_ai.util import (
    ExecResult,
    OutputLimitExceededError,
    SandboxConnection,
    SandboxEnvironment,
    SandboxEnvironmentConfigType,
    SandboxEnvironmentLimits,
    SandboxUnavailableError,
    SandboxUserUnsupportedError,
    sandboxenv,
    subprocess,
)

from inspect_apptainer._config import ApptainerSandboxConfig, resolve_config

INSTANCE_PREFIX = "inspect-"
CONTROL_DIR = "/.inspect-apptainer"  # per-sample command scripts, bound read-only

# Host-issued commands never resolve utilities through the image's PATH (see the
# `exec` contract of SandboxEnvironment): the shell is launched by absolute path
# and pins PATH to the system directories before running anything.
_SHELL = "/bin/sh"
_SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
_PIN = f"PATH={_SYSTEM_PATH}; export PATH; "

_READ_SCRIPT = """\
f="$1"; limit="$2"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 64; fi
if [ -d "$f" ]; then exit 65; fi
if [ ! -r "$f" ]; then exit 66; fi
size=$(wc -c < "$f") || exit 66
if [ "$size" -gt "$limit" ]; then exit 67; fi
exec cat -- "$f"
"""


def _shell(script: str, *args: str) -> list[str]:
    return [_SHELL, "-c", _PIN + script, "sh", *args]


def _is_current_user(user: str) -> bool:
    try:
        uid = int(user) if user.isdecimal() else pwd.getpwnam(user).pw_uid
    except KeyError:
        return False
    return uid == os.geteuid()


def apptainer_binary(cfg: ApptainerSandboxConfig) -> str:
    candidates = [cfg.apptainer] if cfg.apptainer else ["apptainer", "singularity"]
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    raise RuntimeError(
        f"no Apptainer binary found (tried {', '.join(candidates)}); install Apptainer "
        "or set `apptainer` in the sandbox config"
    )


@sandboxenv(name="apptainer")
class ApptainerSandboxEnvironment(SandboxEnvironment):
    _started: set[str] = set()  # instances started by this process

    @override
    @classmethod
    def config_files(cls) -> list[str]:
        return ["apptainer.yaml", "apptainer.yml"]

    @override
    @classmethod
    def config_deserialize(cls, config: dict[str, Any]) -> BaseModel:
        return ApptainerSandboxConfig(**config)

    @override
    @classmethod
    async def task_init(
        cls, task_name: str, config: SandboxEnvironmentConfigType | None
    ) -> None:
        cfg = resolve_config(config)
        apptainer_binary(cfg)
        if "://" not in cfg.image and not Path(cfg.image).exists():
            raise FileNotFoundError(f"apptainer sandbox image not found: {cfg.image}")

    @override
    @classmethod
    async def sample_init(
        cls,
        task_name: str,
        config: SandboxEnvironmentConfigType | None,
        metadata: dict[str, str],
    ) -> dict[str, SandboxEnvironment]:
        cfg = resolve_config(config)
        binary = apptainer_binary(cfg)
        name = f"{INSTANCE_PREFIX}{uuid.uuid4().hex[:12]}"
        scratch = Path(tempfile.mkdtemp(prefix="inspect-apptainer-"))
        args = [binary, "instance", "start", "--containall", "--cleanenv"]
        if cfg.writable_tmpfs:
            args.append("--writable-tmpfs")
        if cfg.network == "none":
            args += ["--net", "--network", "none"]
        if cfg.fakeroot:
            args.append("--fakeroot")
        for i, target in enumerate(cfg.writable):
            host_dir = scratch / f"w{i}"
            host_dir.mkdir(mode=0o700)
            args += ["--bind", f"{host_dir}:{target}"]
        for bind in cfg.binds:
            args += ["--bind", bind]
        control = scratch / "control"
        control.mkdir(mode=0o700)
        args += ["--bind", f"{control}:{CONTROL_DIR}:ro"]
        args += [*cfg.start_args, cfg.image, name]
        result = await subprocess(args, timeout=cfg.start_timeout)
        if not result.success:
            shutil.rmtree(scratch, ignore_errors=True)
            raise RuntimeError(
                f"apptainer instance start failed (exit {result.returncode}):\n{result.stderr}"
            )
        cls._started.add(name)
        return {"default": cls(binary, name, cfg, scratch)}

    @override
    @classmethod
    async def sample_cleanup(
        cls,
        task_name: str,
        config: SandboxEnvironmentConfigType | None,
        environments: dict[str, SandboxEnvironment],
        interrupted: bool,
    ) -> None:
        for env in environments.values():
            await env.as_type(ApptainerSandboxEnvironment)._stop()

    @override
    @classmethod
    async def task_cleanup(
        cls, task_name: str, config: SandboxEnvironmentConfigType | None, cleanup: bool
    ) -> None:
        if not cleanup:
            return
        cfg = resolve_config(config)
        binary = apptainer_binary(cfg)
        for name in sorted(cls._started):
            await _instance_stop(binary, name)
        cls._started.clear()

    @override
    @classmethod
    async def cli_cleanup(cls, id: str | None) -> None:
        # `inspect sandbox cleanup apptainer [NAME]`: stop this user's instances
        # that Inspect started (all of them, or the named one).
        binary = apptainer_binary(ApptainerSandboxConfig(image=""))
        names = [id] if id else await _list_instances(binary, INSTANCE_PREFIX)
        for name in names:
            await _instance_stop(binary, name)

    def __init__(
        self, binary: str, name: str, cfg: ApptainerSandboxConfig, scratch: Path
    ) -> None:
        super().__init__()
        self._binary = binary
        self._name = name
        self._cfg = cfg
        self._scratch = scratch
        self._stopped = False

    async def _stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        await _instance_stop(self._binary, self._name)
        type(self)._started.discard(self._name)
        shutil.rmtree(self._scratch, ignore_errors=True)

    def _prepare(
        self, cmd: list[str], cwd: str | None, env: dict[str, str] | None
    ) -> tuple[list[str], Path]:
        """The host argv that runs ``cmd`` in the instance, and the script it reads."""
        workdir = PurePosixPath(self._cfg.workdir)
        final_cwd = workdir if cwd is None else PurePosixPath(cwd)
        if not final_cwd.is_absolute():
            final_cwd = workdir / final_cwd
        lines = [
            f"export {key}={shlex.quote(value)}"
            for key, value in {**self._cfg.env, **(env or {})}.items()
        ]
        lines.append("exec " + " ".join(shlex.quote(a) for a in cmd))
        script = self._scratch / "control" / f"{uuid.uuid4().hex}.sh"
        script.write_text("\n".join(lines) + "\n", encoding="utf-8")
        args = [
            self._binary, "exec", "--cleanenv", "--pwd", str(final_cwd),
            *self._cfg.exec_args, f"instance://{self._name}",
            _SHELL, f"{CONTROL_DIR}/{script.name}",
        ]
        return args, script

    async def _run(
        self,
        args: list[str],
        input: str | bytes | None,
        timeout: int | None,
        timeout_retry: bool,
        concurrency: bool,
        output_limit: int | None,
        text: bool = True,
    ) -> ExecResult[Any]:
        # Host-side timeouts are retried like Docker's: up to twice, with the
        # timeout capped at 60 s and then 30 s.
        retries = [60, 30] if timeout_retry and timeout is not None else []
        while True:
            try:
                return await subprocess(
                    args,
                    text=text,  # type: ignore[arg-type]
                    input=input,
                    timeout=timeout,
                    output_limit=output_limit,
                    concurrency=concurrency,
                )
            except TimeoutError:
                if not retries:
                    raise
                timeout = min(timeout or 0, retries.pop(0))

    @override
    async def exec(
        self,
        cmd: list[str],
        input: str | bytes | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        user: str | None = None,
        timeout: int | None = None,
        timeout_retry: bool = True,
        concurrency: bool = True,
    ) -> ExecResult[str]:
        if user is not None and not _is_current_user(user):
            raise SandboxUserUnsupportedError(
                f"the apptainer sandbox cannot execute as {user!r}: commands run as "
                "the invoking user and Apptainer has no user switching"
            )
        if not cmd:
            raise ValueError("cmd must not be empty")
        # The in-container `timeout` kills the process tree when the limit fires;
        # the host-side timeout is only a backstop for a hung Apptainer call.
        in_cmd = cmd
        if timeout is not None:
            in_cmd = [self._cfg.timeout_command, "-k", "5s", f"{timeout}s", *cmd]
        host_timeout = timeout + 10 if timeout is not None else None
        args, script = self._prepare(in_cmd, cwd, env)
        start = time.monotonic()
        try:
            result = await self._run(
                args,
                input,
                host_timeout,
                timeout_retry,
                concurrency,
                SandboxEnvironmentLimits.MAX_EXEC_OUTPUT_SIZE,
            )
        finally:
            script.unlink(missing_ok=True)
        elapsed = time.monotonic() - start
        result = _normalize_signal_exit(result)
        if timeout is not None and result.returncode in (124, 137, 143):
            # 124: GNU/BusyBox timeout fired; 137/143: killed by SIGKILL/SIGTERM,
            # which is a timeout only if the command ran that long.
            if result.returncode == 124 or elapsed >= timeout:
                error = TimeoutError(f"Command timed out after {timeout} seconds")
                partial = (result.stdout or "") + (result.stderr or "")
                if partial:
                    setattr(error, "truncated_output", partial)
                raise error
        self._raise_for_provider_failure(result, cmd, in_cmd)
        return result

    def _raise_for_provider_failure(
        self, result: ExecResult[str], cmd: list[str], in_cmd: list[str]
    ) -> None:
        if result.success:
            return
        stderr = result.stderr or ""
        if re.search(r"no instance found with name", stderr):
            raise SandboxUnavailableError(
                f"the apptainer instance {self._name} is not running: {stderr.strip()}"
            )
        # Apptainer or the timeout wrapper could not start the caller's program
        # because it is not executable; a missing program stays an ordinary result.
        if result.returncode in (126, 255) and re.search(
            rf"{re.escape(cmd[0])}.*[Pp]ermission denied", stderr
        ):
            raise PermissionError(errno.EACCES, "Permission denied", cmd[0])
        if result.returncode == 255 and stderr.startswith("FATAL:"):
            # Apptainer itself failed before /bin/sh ran the command.
            raise SandboxUnavailableError(
                f"apptainer exec failed for instance {self._name}: {stderr.strip()}"
            )

    def _resolve(self, file: str) -> str:
        path = PurePosixPath(file)
        return str(path if path.is_absolute() else PurePosixPath(self._cfg.workdir) / path)

    @override
    async def write_file(self, file: str, contents: str | bytes) -> None:
        target = self._resolve(file)
        parent = PurePosixPath(target).parent.as_posix()
        result = await self.exec(_shell('mkdir -p -- "$1"', parent), timeout=120)
        if not result.success:
            if "permission denied" in result.stderr.casefold():
                raise PermissionError(errno.EACCES, "Permission denied", file)
            raise RuntimeError(f"failed to create directory {parent}: {result.stderr}")
        if isinstance(contents, str):
            result = await self.exec(
                _shell('exec cat > "$1"', target), input=contents, timeout=600
            )
        else:
            result = await self.exec(
                _shell('exec base64 -d > "$1"', target),
                input=base64.b64encode(contents).decode("ascii"),
                timeout=600,
            )
        if not result.success:
            lowered = result.stderr.casefold()
            if "permission denied" in lowered:
                raise PermissionError(errno.EACCES, "Permission denied", file)
            if "is a directory" in lowered:
                raise IsADirectoryError(errno.EISDIR, "Is a directory", file)
            raise RuntimeError(f"failed to write {file}: {result.stderr}")

    @overload
    async def read_file(self, file: str, text: Literal[True] = True) -> str: ...

    @overload
    async def read_file(self, file: str, text: Literal[False]) -> bytes: ...

    @override
    async def read_file(self, file: str, text: bool = True) -> Union[str, bytes]:
        limit = SandboxEnvironmentLimits.MAX_READ_FILE_SIZE
        args, script = self._prepare(
            _shell(_READ_SCRIPT, self._resolve(file), str(limit)), None, None
        )
        try:
            result: ExecResult[bytes] = await self._run(
                args, None, 600, True, True, limit + 1024, text=False
            )
        finally:
            script.unlink(missing_ok=True)
        if result.returncode == 64:
            raise FileNotFoundError(errno.ENOENT, "No such file or directory", file)
        if result.returncode == 65:
            raise IsADirectoryError(errno.EISDIR, "Is a directory", file)
        if result.returncode == 66:
            raise PermissionError(errno.EACCES, "Permission denied", file)
        if result.returncode == 67:
            raise OutputLimitExceededError(
                SandboxEnvironmentLimits.MAX_READ_FILE_SIZE_STR, None
            )
        if not result.success:
            stderr = result.stderr.decode("utf-8", errors="replace")
            if "no instance found with name" in stderr:
                raise SandboxUnavailableError(
                    f"the apptainer instance {self._name} is not running: {stderr.strip()}"
                )
            raise RuntimeError(f"failed to read {file} (exit {result.returncode}): {stderr}")
        return result.stdout.decode("utf-8") if text else result.stdout

    @override
    async def connection(self, *, user: str | None = None) -> SandboxConnection:
        if user is not None and not _is_current_user(user):
            raise SandboxUserUnsupportedError("the apptainer sandbox has no user switching")
        if self._stopped:
            raise ConnectionError(f"the apptainer instance {self._name} is not running")
        return SandboxConnection(
            type="apptainer",
            command=f"{self._binary} shell --cleanenv --pwd {self._cfg.workdir} instance://{self._name}",
            container=self._name,
        )

    @override
    def default_polling_interval(self) -> float:
        return 1.0


def _normalize_signal_exit(result: ExecResult[Any]) -> ExecResult[Any]:
    """Report a signal death as ``128 + signal``, as a shell would.

    When the command dies from a signal, Apptainer's starter kills itself with
    the same signal, so the host sees a negative return code (``-15`` for
    SIGTERM) where Docker would report ``143``.
    """
    if result.returncode < 0:
        return dataclasses.replace(result, success=False, returncode=128 - result.returncode)
    return result


async def _instance_stop(binary: str, name: str) -> None:
    try:
        await subprocess([binary, "instance", "stop", name], timeout=120)
    except TimeoutError:
        pass


async def _list_instances(binary: str, prefix: str) -> list[str]:
    result = await subprocess([binary, "instance", "list"], timeout=60)
    names = []
    for line in result.stdout.splitlines()[1:]:
        fields = line.split()
        if fields and fields[0].startswith(prefix):
            names.append(fields[0])
    return names
