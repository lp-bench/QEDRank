# Roadmap
Keep every item short: not much explanations.
When an item is done, delete it. When part of it is done, delete only that part.

- Local pilot (Docker, Qwen, P088/P089/P090): finish image build, mock-model test, then Qwen.
- Image build: PyPI downloads stall in Docker's network; if `--network host` works, add it to `build_image.sh`.
- Dockerfile: run `lake exe cache get` before copying problem files (no re-download per IDS).
- Copy paste and use interesting parts of lean-eval and epoch-research/LeanOpenProblems.
- Allow the agent to write multiple files.
- Test P002/P015 (Matroid) end to end.
- Support Gemini and Grok (install `google-genai`, `xai-sdk`).
- Set up a read-only GitHub deploy key on the HPC cluster.
- two layer check. If first check passes then comparator.
- Get Comparator working on our toolchain v4.33.0-rc1 (or move to v4.33.1).
- Check Landlock is active on Capella before trusting Comparator there.
- Write an Inspect Apptainer sandbox; fork inspect-podman + mini-swe-agent `singularity.py`.
- Sandbox: always `--containall`, never mount the repo (keys via `/proc`, `data/`).
- Test `--net --network none` on Capella first.
- Ask ZIH: is rootless Podman available on Capella? (then use inspect-podman)
- Release the Apptainer sandbox as a package with the paper.
- push `proofbench-statements` to private GitHub repo.
- Sessions with handoff (paper): up to 10 fresh sessions, fixed-format note, check after each.
- Output-token budget per session; total-token and time limits only as safety caps.
- Record cost per session.
- Manifest: record the Mathlib commit.
- Decide: may the agent install Lean libraries when search is on? (paper yes, checker no)
- Paper: allowed imports also include Matroid, `Archive.Sensitivity`, imported statements.
- Paper: not only commercial APIs (Qwen via university endpoint, Kimi self-hosted).
- Paper: say each model gets one session chain per problem, never a restart.
