"""Runs Inspect's sandbox conformance suite against the Apptainer sandbox.

Needs Apptainer and a test image; set INSPECT_APPTAINER_TEST_IMAGE to a .sif
(default: tests/alpine.sif, built with `apptainer pull tests/alpine.sif
docker://alpine:3.20`).
"""

import os
from pathlib import Path

import pytest

from inspect_ai.util import SandboxEnvironment
from inspect_apptainer import ApptainerSandboxConfig, ApptainerSandboxEnvironment

IMAGE = os.environ.get(
    "INSPECT_APPTAINER_TEST_IMAGE", str(Path(__file__).parent / "alpine.sif")
)

# Checks the rootless Apptainer sandbox cannot satisfy.
XFAIL = {
    # No user switching: exec(user="root") raises SandboxUserUnsupportedError.
    "test_exec_as_user": "apptainer runs every command as the invoking user",
}


@pytest.fixture
async def sandbox_env(request: pytest.FixtureRequest) -> SandboxEnvironment:
    name = request.node.originalname
    if name in XFAIL:
        request.node.add_marker(pytest.mark.xfail(reason=XFAIL[name], strict=False))
    config = ApptainerSandboxConfig(image=IMAGE, workdir="/tmp")
    envs = await ApptainerSandboxEnvironment.sample_init("self-check", config, {})
    try:
        yield envs["default"]
    finally:
        await ApptainerSandboxEnvironment.sample_cleanup("self-check", config, envs, False)
