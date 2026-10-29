"""Inspect's portable sandbox checks, plus Apptainer-specific ones."""

from inspect_ai.util import SandboxEnvironment, SandboxUserUnsupportedError
from inspect_ai.util._sandbox.self_check import *  # noqa: F401,F403

import pytest


async def test_host_environment_not_inherited(sandbox_env: SandboxEnvironment) -> None:
    import os

    os.environ["INSPECT_APPTAINER_LEAK_TEST"] = "leaked"
    try:
        result = await sandbox_env.exec(["sh", "-c", "echo [$INSPECT_APPTAINER_LEAK_TEST]"])
    finally:
        del os.environ["INSPECT_APPTAINER_LEAK_TEST"]
    assert result.stdout.strip() == "[]", f"host variable visible in the sandbox: {result.stdout!r}"


async def test_env_values_with_commas_and_quotes(sandbox_env: SandboxEnvironment) -> None:
    value = 'a,b "quoted" c=d'
    result = await sandbox_env.exec(["sh", "-c", 'printf "%s" "$V"'], env={"V": value})
    assert result.stdout == value, f"env value mangled: {result.stdout!r}"


async def test_no_network(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(
        ["sh", "-c", "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"]
    )
    assert result.stdout.split() == ["lo"], f"network interfaces visible: {result.stdout!r}"


async def test_pid_namespace(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(["sh", "-c", "ls /proc | grep -cE '^[0-9]+$'"])
    assert int(result.stdout.strip()) < 20, f"too many processes visible: {result.stdout!r}"


async def test_background_process_survives(sandbox_env: SandboxEnvironment) -> None:
    await sandbox_env.exec(["sh", "-c", "(sleep 60 >/dev/null 2>&1 &); echo started"])
    result = await sandbox_env.exec(["sh", "-c", "ps -o comm | grep -c '^sleep'"])
    assert result.stdout.strip() != "0", "background process did not survive the exec"


# Command lines of all processes in the instance, one per line.
PROCESSES = "for d in /proc/[0-9]*; do tr '\\0' ' ' < $d/cmdline 2>/dev/null; echo; done"


async def test_timeout_ends_every_process_and_runs_once(sandbox_env: SandboxEnvironment) -> None:
    # `setsid` and a nested `timeout` start processes outside the command's process group,
    # which an in-container `timeout` would miss; they also keep the output open.
    import time

    start = time.monotonic()
    with pytest.raises(TimeoutError):
        await sandbox_env.exec(
            ["sh", "-c", "echo run >> /tmp/runs; (setsid sleep 100 &); timeout 300 sleep 99"],
            timeout=2,
        )
    assert time.monotonic() - start < 15, "the exec outlived its limit"
    runs = await sandbox_env.exec(["cat", "/tmp/runs"])
    assert runs.stdout == "run\n", f"the command did not run exactly once: {runs.stdout!r}"
    procs = (await sandbox_env.exec(["sh", "-c", PROCESSES])).stdout
    assert "sleep 100" not in procs and "sleep 99" not in procs, f"processes survived: {procs!r}"


async def test_bounded_command_leaves_nothing_behind(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(
        ["sh", "-c", "setsid sleep 101 </dev/null >/dev/null 2>&1 & "
                     "nohup sleep 102 >/dev/null 2>&1 & echo ok"],
        timeout=30,
    )
    assert result.stdout.strip() == "ok"
    procs = (await sandbox_env.exec(["sh", "-c", PROCESSES])).stdout
    assert "sleep 101" not in procs and "sleep 102" not in procs, f"processes survived: {procs!r}"


async def test_exit_status_124_of_the_command_is_kept(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(["sh", "-c", "exit 124"], timeout=30)
    assert result.returncode == 124


async def test_bounded_command_gets_its_input(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(["sh", "-c", "wc -l"], input="a\nb\n", timeout=30)
    assert result.stdout.strip() == "2"


async def test_exec_as_other_user_refused(sandbox_env: SandboxEnvironment) -> None:
    with pytest.raises(SandboxUserUnsupportedError):
        await sandbox_env.exec(["id"], user="root")


async def test_scratch_discarded_between_samples(sandbox_env: SandboxEnvironment) -> None:
    result = await sandbox_env.exec(["sh", "-c", "ls -A /tmp /var/tmp | grep -v ':' | grep -v '^$' | wc -l"])
    assert result.stdout.strip() == "0", f"scratch not fresh: {result.stdout!r}"
