# Roadmap
Keep every item short: not much explanations.
When an item is done, delete it. When part of it is done, delete only that part.

- Local pilot (Docker, Qwen): P088/P089 running with handoff; then the new P090 (SRG eigenvalues).
- Next run: `qwen3.8-27b` on P088, P089, new P090; same settings, after the current run (fresh daily quota).
- Copy paste and use interesting parts of lean-eval and epoch-research/LeanOpenProblems in 
proofbench-eval-docker and proofbench-eval-apptainer.
- Allow the agent to write multiple files; session prompt then lists files, agent reads what it needs.
- Test P002/P015 (Matroid) end to end. (done automatically once we have a full run of an agent on all problems.)
- Support Gemini and Grok (install `google-genai`, `xai-sdk`).
- Set up a read-only GitHub deploy key on the HPC cluster.
- two layer check. If first Lean check passes then comparator check kicks in.
- Get Comparator working on our toolchain which is too old, v4.33.0-rc1 
(we prefer to move to v4.33.1, even though its more work. We aim for perfection.)
- Check Landlock is active on Capella before trusting Comparator there.
- Write an Inspect Apptainer sandbox; fork inspect-podman + mini-swe-agent `singularity.py`.
(ultimately aim to drop the retired word singularity becase apptainer is the up-to-date approach now.)
- Sandbox: always `--containall`, never mount the repo (keys via `/proc`, `data/`).
- Test `--net --network none` on Capella first.
- Ask ZIH: is rootless Podman available on Capella? (then use inspect-podman)
(what is this? if claude is reading this can you explain more? thanks.)
- Release the Apptainer sandbox as a package with the paper, meaning that will will publish harness on github. should we make a new repo for just the apptainer sandbox to share it with people?
- push `proofbench-statements` to private GitHub repo.
- Record cost per session. (not yet because we use free models for pilots.)
- Manifest: record the Mathlib commit.
- When websearch is on, we must allow the agent install Lean libraries and incorporate them in their proof. Checker must be adjusted accordingly because currently checker does not allow it.  
- Paper: allowed imports also include Matroid, `Archive.Sensitivity`, imported statements.
(Do we need to update the paper to say this?)
- Paper: not only commercial APIs (Qwen via university endpoint, Kimi self-hosted).
(do we need to update the paper? please let me know.)
- Paper: say each model gets one session chain per problem, never a restart.
(I think the technical language is we used one epoch for each agent test. If you agree plz let me know. Do we need to update the paper?)
