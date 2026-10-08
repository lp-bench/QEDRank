Keep every item short: not much explanations.
When an item is done, delete it. When part of it is done, delete only that part.

# Roadmap
- Decide the next pilot (model, problems). Last: `qwen3.8-27b` solved P109–P111 3/3 (sessions 4, 3, 3; 40k output tokens/session; Comparator off).
- Prove-or-disprove for the 32 open problems: both files in the sandbox, "prove either", grade whichever passes, record the polarity. (needs your yes: changes the format)
- Handoff note: add a DRAFT section for Lean code not yet saved to a file; drop the 400-word limit.
- HPC pre-flight script: Apptainer version, network namespaces, binds, tmpfs size, Landlock, Python, GPU. Tested here, run on Capella on day one.
- Check which candidate models (2025–2026 list) are still served, and prices.
- inspect-apptainer: CI tests and packaging metadata, ready for the license decision.
- Wider local run of free Qwen on more problems, exercising Matroid (P002/P015). (needs your yes: more problems go to the university endpoint)
- When websearch is on, we must (?) allow the agent install Lean libraries and incorporate them in their proof. Checker must be adjusted accordingly because currently checker does not allow it. We should have this as a swtichable option. --libraries-on --libraries-off
(Claude: a library's code runs at compile time inside the same containers as the agent's own code, so no new way to reach the host, but unaudited third-party code. Belongs to the search-on configuration: finding and using a library is a capability we measure; fair because every model gets the same switch.)


## Claude not needed after this line. ##

WAITING for DECISION/HPC ACCESS/OTHER REASON
- inspect-apptainer: test on HPC; pick a license.
- Record cost per session. (not yet because we use free models for pilots.)
- Test P002/P015 (Matroid) end to end. (done automatically once we have a full run of an agent on all problems.)
- Check Landlock is active on Capella before trusting Comparator there.
- Test `--net --network none` on Capella first.
- Set up a read-only GitHub deploy key on the HPC cluster.
- Release the Apptainer sandbox as a package with the paper, meaning that will will publish harness on github. this is now "inspect-apptainer" repo.
- push `proofbench-statements` to private GitHub repo.

## CHANGES for me NOW
- ProofBench's `Hypergraph` (Mathlib_Problems/Combinatorics/Hypergraph/Basic.lean, used by P008, P029–P036, P043) clashes with Mathlib's new `Hypergraph` (v4.33): both in one file fails. Rename ours (e.g. namespace `ProofBench`) so agents can `import Mathlib`.
- P015 (4 `sorry`s), P017 (2), P070 (3): decide whether the agent must prove every `sorry` (current rule) or some are given facts.
- Ask ZIH: is rootless Podman available on Capella? (then use inspect-podman)
(Claude: Podman = a Docker-compatible container tool that can run without root. A ready-made Inspect sandbox for it exists (VectorInstitute/inspect-podman). If Capella offers it, we could use that instead of our own inspect-apptainer. One question in the ZIH email.)
- Paper: allowed imports also include Matroid, `Archive.Sensitivity`, imported statements.
(Claude: yes, one sentence in the grading section.)
- Paper: not only commercial APIs (Qwen via university endpoint, Kimi self-hosted).
(Claude: yes, one sentence in the harness section.)
- Paper: say each model gets one session chain per problem, never a restart.
- Paper: cite lean-eval and LeanOpenProblems as the grading designs we followed (one sentence in the grading section).
(Claude: yes. Prefer the standard term pass@1 (one attempt per problem), with "one epoch in Inspect" as a footnote; "epoch" alone usually means a training pass to readers.)
- Paper (sessions section): every session asks the model to keep the file compiling, with `sorry` for unfinished steps replaced one at a time; only the final submission must be `sorry`-free.

## OPTIONAL
- Support Gemini and Grok: libraries installed; test one sample each once keys exist.