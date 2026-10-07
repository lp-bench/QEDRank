"""One fresh Apptainer instance per sample (see README.md for the design)."""

from typing import Literal, Union, overload

from inspect_ai.util import ExecResult, SandboxEnvironment, SandboxEnvironmentConfigType, sandboxenv


@sandboxenv(name="apptainer")
class ApptainerSandboxEnvironment(SandboxEnvironment):
    @classmethod
    async def sample_init(
        cls,
        task_name: str,
        config: SandboxEnvironmentConfigType | None,
        metadata: dict[str, str],
    ) -> dict[str, SandboxEnvironment]:
        """Start `apptainer instance start --containall --cleanenv --writable-tmpfs`."""
        raise NotImplementedError("inspect-apptainer: sample_init is not implemented yet")

    @classmethod
    async def sample_cleanup(
        cls,
        task_name: str,
        config: SandboxEnvironmentConfigType | None,
        environments: dict[str, SandboxEnvironment],
        interrupted: bool,
    ) -> None:
        """Stop the instance, discarding its scratch layer."""
        raise NotImplementedError("inspect-apptainer: sample_cleanup is not implemented yet")

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
        """Run `apptainer exec instance://NAME CMD`."""
        raise NotImplementedError("inspect-apptainer: exec is not implemented yet")

    async def write_file(self, file: str, contents: str | bytes) -> None:
        """Write through `exec` with the contents on stdin."""
        raise NotImplementedError("inspect-apptainer: write_file is not implemented yet")

    @overload
    async def read_file(self, file: str, text: Literal[True] = True) -> str: ...

    @overload
    async def read_file(self, file: str, text: Literal[False]) -> bytes: ...

    async def read_file(self, file: str, text: bool = True) -> Union[str, bytes]:
        """Read through `exec` from stdout."""
        raise NotImplementedError("inspect-apptainer: read_file is not implemented yet")
