# Roadmap
Keep every item short: not much explanations.
When an item is done, delete it. When part of it is done, delete only that part.

- Next local pilot run: `qwen3.8-27b` on P088, P089, new P090; same settings, after the current run. We need to choose easier problems for this model I believe. 90 can remain for now but 88 and 89 was failed by a stonger Qwen model. The new problems should be added to main proofbench repo rather than replacing 88 and 89.
- Copy paste and use interesting parts of lean-eval and epoch-research/LeanOpenProblems in proofbench-eval-docker and proofbench-eval-apptainer, for free and quality improvements.
- Allow the agent to write multiple files; session prompt then lists files, agent reads what it needs.
- Support Gemini and Grok: libraries installed; test one sample each once keys exist.
- two layer check. If first Lean check passes then comparator check kicks in.
- Get Comparator working on our toolchain which is too old, v4.33.0-rc1 
(we prefer to move to v4.33.1, even though its more work. We aim for perfection.)
- inspect-apptainer: test on a cluster; pick a license.

## Claude not needed after this line. ##

WAITING for DECISION/HPC ACCESS/OTHER REASON
- Record cost per session. (not yet because we use free models for pilots.)
- Test P002/P015 (Matroid) end to end. (done automatically once we have a full run of an agent on all problems.)
- When websearch is on, we must (?) allow the agent install Lean libraries and incorporate them in their proof. Checker must be adjusted accordingly because currently checker does not allow it. This is questionable, can wait.
- Check Landlock is active on Capella before trusting Comparator there.
- Test `--net --network none` on Capella first.
- Set up a read-only GitHub deploy key on the HPC cluster.
- Release the Apptainer sandbox as a package with the paper, meaning that will will publish harness on github. this is now "inspect-apptainer" repo.
- push `proofbench-statements` to private GitHub repo.

CHANGES NOW
- Ask ZIH: is rootless Podman available on Capella? (then use inspect-podman)
(what is this? if claude is reading this can you explain more? thanks.)
- Paper: allowed imports also include Matroid, `Archive.Sensitivity`, imported statements.
(Do we need to update the paper to say this?)
- Paper: not only commercial APIs (Qwen via university endpoint, Kimi self-hosted).
(do we need to update the paper? please let me know.)
- Paper: say each model gets one session chain per problem, never a restart.
(I think the technical language is we used one epoch for each agent test. If you agree plz let me know. Do we need to update the paper?)
- Paper (sessions section): every session asks the model to keep the file compiling, with `sorry` for unfinished steps replaced one at a time; only the final submission must be `sorry`-free.
