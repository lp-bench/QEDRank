# Session limits as they acted in the official runs (2026-11-03)

Each attempt runs up to four sessions (`proofbench_eval/sessions.py`).  The budgets configured per
session and recorded in every manifest: 120,000 output tokens (reasoning included), 64,000 output
tokens per reply, a working-time cap of 90 minutes, 30 minutes per tool call; per attempt a
wall-clock limit of 18 hours (`time_limit` = sessions x working time x 3).

Finding from the Fable/search runs: **the 90-minute working-time cap never ended a session.**
Sessions ended by `submit`, by the output-token budget (`token`), or the attempt ended by the
18-hour limit (`time`, e.g. P066 in part 2, whose first session ran 13 hours of working time).
Cause: Inspect 0.3.276 only checks a scoped `working_limit()` (as passed to `react(limits=...)`)
in `util/_checkpoint/sample_runtime.py` when restoring a checkpoint; during a run only the
sample-level working limit is monitored, which the harness does not use.  Every run of the
campaign shares this behaviour (same pinned Inspect), so the runs stay comparable; the effective
per-session bound is the output-token budget, which is what the paper reports.  Not changed during
the campaign: a fix touches `sessions.py` (evaluation code) and alters agent behaviour.  After the
campaign: check the working limit after every tool call in the session loop, or upgrade Inspect.
