# Handoff: GWDG model roster and ProofBench testing

Living checklist for the task started on 2026-10-23. Whoever continues (a new Claude Code
session after a context reset or a daily-usage stop, or the user) starts here. Tick boxes,
append to the log, and keep the memory note `project_gwdg_roster_handoff.md` in sync.

## 0. How to resume

1. `cd C:\QEDRank\QEDRank_java` (a git worktree on branch `QEDRank`; `main` is the one-folder
   layout where this app lives under `QEDRank_java/`). Run `git status --short` and
   `git log --oneline -3`; compare with section 2.
2. `node qedrank/cli.js models` must list ten slots in this order: fable, opus, qwen, qwen35,
   gpt6_astra, gpt6_sol, gpt56_terra, gpt54, glm, deepseek_flash. The four GWDG slots show
   `configured` as soon as `GWDG_API_KEY` or the older `LLAMA_API_KEY` is in the environment.
3. Continue at the first unchecked box in section 4. Do not redo finished steps.
4. Rules that stay in force: keys are entered only through the masked prompt (never pasted into
   chat, files or commits); the private-corpus guard stays on; commit, push and deploy only when
   the user has said so for that step.

## 1. What the task is

User request (2026-10-23): on the Evaluate Models page (page 2) and Convert a Problem (page 6)
replace Kimi K3 by `glm-5.3-flash`, Leanstral by `qwen3.5-397b-a17b`, DeepSeek `deepseek-v4-pro`
by `deepseek-v4-flash-0731`, and remove Llama 3.1 8B Instruct. All three new models are served by
GWDG Chat AI (AcademicCloud) at `https://chat-ai.academiccloud.de/v1` with one API key
(model list: https://docs.hpc.gwdg.de/services/ai-services/chat-ai/models/index.html). Then use
these models for ProofBench testing, resumably.

## 2. State (update this section when it changes)

Last update: 2026-10-23, session 1, after publish and deploy.

Done and verified:

- Registry [lib/providers.js](../lib/providers.js): roster is ten slots. New slots `qwen35`
  (Qwen3.5 397B-A17B), `glm` (GLM-5.3 Flash), `deepseek_flash` (DeepSeek V4 Flash 0731), all
  on the GWDG endpoint with `GWDG_API_KEY` (fallback `LLAMA_API_KEY`). `kimi`, `mistral`, `llama`
  and `deepseek` (DeepSeek's own API, `deepseek-v4-pro`) are kept as optional slots outside the
  roster so stored runs, test fixtures and `QEDRANK_MODELS` still resolve.
- Request shape: `glm` sends `reasoning_effort` low | high | max and `deepseek_flash` low | max
  (GWDG answers `high` for DeepSeek with an empty HTTP 500, probed 2026-10-23) when the run asks
  for one of those levels, plus a temperature; `qwen35` thinks by
  default, has no effort levels, and its `<think>` / `reasoning_content` output is separated from
  the answer and counted.
- Model facts for the three ids in [lib/model-facts.js](../lib/model-facts.js) (GWDG table +
  Hugging Face model cards; release months 2026-02, 2026-02, 2026-07).
- Mirrors updated: `scripts/set-llm-keys.ps1` (masked key entry; former slots under `-Optional`),
  `scripts/agent-run.ps1` synopsis, `.env.example`, `README.md`, `SETUP_GUIDE.md`,
  `qedrank/README.md`, `TESTING.md`, `docs/agent-evaluation.md`, UI (`vendor.js` colours,
  `ModelPicker.jsx` reasoning tag, `KeyHint.jsx`, `HomePage.jsx`), `qedrank/lib/config.js` comment.
- Run configs: `configs/glm-prove-pass4.json`, `configs/qwen35-prove-pass4.json`,
  `configs/deepseek-flash-prove-pass4.json` (4 attempts per the user's decision of 2026-10-23,
  30-minute timeout, 2 requests in flight, GWDG's recommended sampling; GLM and DeepSeek at effort
  `max` with a 65,536-token output budget, Qwen3.5 thinking with 32,768).
- Tests: `npm test` 151 tests, 148 pass, 3 skipped (Lean/bash-dependent), 0 fail. `npx vite build`
  passes. Both PowerShell scripts parse.
- Live smoke test with the GWDG key already on this PC (stored as `LLAMA_API_KEY`):
  `node qedrank/cli.js ping --models glm,qwen35,deepseek_flash` answered 3 of 3 (5.0 s / 7.7 s /
  6.8 s; ping sends effort `low`, so the endpoint accepts `reasoning_effort`). `GET /v1/models`
  lists exactly: deepseek-v4-flash-0731, gemma-4-31b-it, glm-5.3-flash, meta-llama-3.1-8b-instruct,
  qwen3-30b-a3b-instruct-2507, qwen3-coder-next, qwen3-omni-30b-a3b-instruct, qwen3.5-397b-a17b,
  qwen3.6-35b-a3b, qwen3.8-27b.
- New GWDG key entered by the user on 2026-10-23 (`GWDG_API_KEY`, Windows user environment,
  32 characters; a different key from the old `LLAMA_API_KEY`). Verified with it: `models` shows
  the four GWDG slots `configured`; `ping` answered for qwen, qwen35, deepseek_flash and, on the
  second try, glm (first try: HTTP 500 twice, empty body). See section 6 on GLM 500s.
- Machine config `qedrank.config.json` (gitignored): `privacy.allowedHosts` now contains
  `chat-ai.academiccloud.de`, so the four GWDG slots pass the private-corpus guard for ProofBench;
  Anthropic and OpenAI slots stay refused. (Reversible: remove the host.)

Published 2026-10-23 with the user's go-ahead:

- Commit `28162d1` on branch `QEDRank` (pushed), merged into `main` as `18af26d` with
  `git merge -X subtree=QEDRank_java --no-ff` in a temporary worktree (pushed; 20 files, all under
  `QEDRank_java/`). The stale root checkout `C:\QEDRank` (main@1f477d4) was not touched.
- `GWDG_API_KEY` copied into the Vercel project (`set-llm-keys.ps1 -Target Vercel -FromUserEnv
  -Only qwen -Redeploy`) and production redeployed: https://qedrank.vercel.app
  (deployment `dpl_ESZ7ccEktZN4jPgnXVbmqWDMvfLE`).
- Still uncommitted and NOT part of this task (older session): modified
  `paper/benchmark-comparison.tex` and untracked `paper/performance-metrics-methodology.*`,
  `paper/proofbench-measures.*`, `paper/proofbench-performance-matrix.*`.

Fixed 2026-10-23, late (commit `377a33e` on `QEDRank`, merged into main as `bef4a0c`; not deployed,
only a page placeholder changed):

- A prove run started from the Evaluate Models page without a Lean project (`runs/2026-10-23-515eb05`,
  corpus `vaibhav-baj/ProofBench@515eb05`, models qwen35 + glm, run defaults) graded against the
  audit project `lean/`, so 32 items were `challenge_does_not_compile` (`unknown module prefix
  'ProofBench'`); only about five model requests were spent because the per-item challenge compile
  runs before the model call. That run is invalid and can be deleted.
- `qedrank/lib/preflight.js` + `stagePreflightProve` in `run.js`: before the first model call of a
  prove run (and in `--dry-run`), every module the challenges import must resolve to an `.olean` on
  the project's LEAN_PATH. A whole prefix missing stops the run with a message naming the project
  and the built ProofBench checkout; single missing modules are listed (items end as
  `challenge_import_unavailable`). `--allow-missing-imports` downgrades the stop to a warning;
  the result is stored on the run as `import_check`.
- `loadConfig`: a prove run without `--lean-project` (and no `leanDir` in the config file) uses
  `harnesses.proofbench.leanProject` when it exists, so page-started runs cannot repeat the mistake.
- Verified: negative dry run on `lean/` stops (also catches the `Matroid` dependency); positive
  dry run over all 111 papers of `proofbench-statements@466b32a`: all 135 imported modules resolve
  in `C:\QEDRank\proofbench-statements`. Tests 152 pass.

Not done:

- Smoke runs `smoke-qwen35-20261023` and `smoke-glm-20261023` (P109, P110, 2 attempts each) were
  started right after the fix; their outcome goes into the log below. Full runs after that.

## 3. Facts needed for the runs

| Item | Value |
|---|---|
| Endpoint | `https://chat-ai.academiccloud.de/v1` (OpenAI-compatible; `GET /v1/models` lists ids) |
| Key variable | `GWDG_API_KEY` (user environment; `LLAMA_API_KEY` is accepted as fallback) |
| Slots → model ids | `qwen` → `qwen3-30b-a3b-instruct-2507`, `qwen35` → `qwen3.5-397b-a17b`, `glm` → `glm-5.3-flash`, `deepseek_flash` → `deepseek-v4-flash-0731` |
| GWDG recommended sampling | qwen T 0.6 / top_p 0.95; qwen35 T 0.6 / top_p 0.95 (card: top_k 20); glm T 1.0 / top_p 0.95; deepseek_flash T 1.0 / top_p 1.0 |
| Reasoning | glm: `reasoning_effort` low/high/max all accepted (no field = thinking at the model default). deepseek_flash: low and max accepted; `high` = instant empty HTTP 500; no field = answer WITHOUT thinking (so never drop `effort` for it). qwen35: always thinking, no levels. Probed 2026-10-23 with 30 tiny requests. |
| Rate limits | per key, in the response headers `X-RateLimit-Limit-Minute/Hour/Day/Month` (and `X-RateLimit-Remaining-*`) of a chat completion; `/v1/models` carries none. New key, read 2026-10-23: 30/min, 200/h, 1,000/day, 3,000/month (987 left that day, 2,987 that month). The counters are per account, not per key: requests sent with the old key lowered the new key's remaining counts, and failed requests (HTTP 500) count too. A second key adds no quota. |
| Corpus for `run` | `--repo https://github.com/vaibhav-baj/proofbench-statements --ref 466b32a95dfb0549aeb06a2c6215982a514505ba --subdir ProofBench` (private: `$env:GITHUB_TOKEN = (gh auth token)`) |
| Lean project for grading | `C:\QEDRank\proofbench-statements` (built at 466b32a) |
| Request budget | k = 4 (user decision 2026-10-23): 111 prove problems × 4 attempts = 444 requests per model plus retries; three models = 1,332 of the 3,000/month account pool, about 1.5 days per model at 1,000/day. (k = 8 would have been 888 per model, 2,664 for three.) |
| Privacy | `qedrank.config.json`: `privateCorpus: true`, `allowedHosts: ["chat-ai.academiccloud.de"]` |

## 4. Checklist

### 4A. Key entry and verification (user enters the key)

- [x] Enter the new GWDG key with masked input (PowerShell, from `C:\QEDRank\QEDRank_java`). Done 2026-10-23.
  Paste with a RIGHT-CLICK or Shift+Insert (Ctrl+V inserts a control character), or use
  `-FromClipboard`:

  ```powershell
  cd C:\QEDRank\QEDRank_java
  .\scripts\set-llm-keys.ps1 -Target User -Only qwen          # asks GWDG_API_KEY once; serves qwen, qwen35, glm, deepseek_flash
  # or: .\scripts\set-llm-keys.ps1 -Target User -Only qwen -FromClipboard
  ```

  `GWDG_API_KEY` wins over the old `LLAMA_API_KEY`. Open a new terminal afterwards.
- [x] Verify (new terminal, from `C:\QEDRank\QEDRank_java`, not from the home folder). Done 2026-10-23:

  ```powershell
  node qedrank/cli.js models                                   # 4 GWDG slots: GWDG_API_KEY · configured
  node qedrank/cli.js ping --models qwen,qwen35,glm,deepseek_flash --show
  ```
- [x] Read the new key's limits (headers only; the key is never printed). Done 2026-10-23, values in section 3; re-run before each full run to see what is left:

  ```powershell
  $h = @{ Authorization = "Bearer $env:GWDG_API_KEY"; 'Content-Type' = 'application/json' }
  $b = '{"model":"qwen3-30b-a3b-instruct-2507","messages":[{"role":"user","content":"Say OK"}],"max_tokens":2}'
  (Invoke-WebRequest -Uri https://chat-ai.academiccloud.de/v1/chat/completions -Method Post -Headers $h -Body $b -UseBasicParsing).Headers.GetEnumerator() | Where-Object { $_.Key -like 'x-ratelimit*' }
  ```

  Write the numbers into section 3 and choose k / concurrency accordingly (4C).
- [x] Deployed web app (Convert a Problem runs on Vercel): copy the key and redeploy, only after
  4B so the new roster is deployed too. Done 2026-10-23:
  `.\scripts\set-llm-keys.ps1 -Target Vercel -FromUserEnv -Only qwen -Redeploy`

### 4B. Publish the roster change (needs the user's go-ahead for push and deploy)

- [x] Commit on branch `QEDRank` (leave the `paper/` changes out unless the user wants them).
  Done 2026-10-23: `28162d1`, pushed:

  ```powershell
  cd C:\QEDRank\QEDRank_java
  git add .env.example README.md SETUP_GUIDE.md TESTING.md docs/agent-evaluation.md docs/handoff-proofbench-gwdg.md lib/providers.js lib/model-facts.js qedrank/lib/config.js qedrank/test/providers.test.js qedrank/test/harness.attempts.test.js scripts/set-llm-keys.ps1 scripts/agent-run.ps1 src/components/KeyHint.jsx src/components/ModelPicker.jsx src/components/vendor.js src/pages/HomePage.jsx configs/glm-prove-pass4.json configs/qwen35-prove-pass4.json configs/deepseek-flash-prove-pass4.json
  git commit -m "Roster: GWDG-served Qwen3.5 397B-A17B, GLM-5.3 Flash and DeepSeek V4 Flash replace Leanstral, Kimi K3, Llama 3.1 8B and deepseek-v4-pro"
  git push origin QEDRank
  ```
- [x] Merge into `main` (one-folder layout, app under `QEDRank_java/`) without touching the stale
  root checkout `C:\QEDRank` (still at `main@1f477d4`; switching it is a separate, pending user
  decision):

  ```powershell
  git worktree add "$env:TEMP\qedrank-main" origin/main --detach
  git -C "$env:TEMP\qedrank-main" merge -X subtree=QEDRank_java --no-ff QEDRank -m "Merge QEDRank_java/: GWDG model roster (Qwen3.5, GLM-5.3 Flash, DeepSeek V4 Flash)"
  git -C "$env:TEMP\qedrank-main" push origin HEAD:main
  git worktree remove "$env:TEMP\qedrank-main"
  ```
- [x] Deploy: `vercel deploy --prod --yes --archive=tgz` (from `QEDRank_java`; `.vercelignore` keeps
  the harness out), then 4A's Vercel key step. Done 2026-10-23 through the key script's `-Redeploy`
  (merge `18af26d` pushed to main first). Later app changes: repeat commit → push → subtree merge →
  deploy; the key stays in the Vercel project.

### 4C. ProofBench prove task with the new models (single-call protocol, pass@k)

Decided 2026-10-23 (section 5): k = 4; GLM and DeepSeek at effort `max`. Still open: whether
the prove prompt should first include the hidden definitions (open question since 2026-10-13;
changing it means re-running `qwen` for comparability). Ask before the full runs if the user has
not said.

- [x] Dry run with the import check over the whole corpus (done 2026-10-23: 135 modules, 111 files,
  nothing missing). `--lean-project` is now optional for prove runs on this machine (section 2).
- [ ] Smoke run per model: 2 problems × 2 attempts into a throw-away run id, then read
  `runs/<id>/summary.json` (`settings`, per-model `sampling`: temperature/effort as intended,
  `reasoning_chars` > 0 for the thinking models, no `empty_response`):

  ```powershell
  $env:GITHUB_TOKEN = (gh auth token)
  $corpus = @('--repo','https://github.com/vaibhav-baj/proofbench-statements','--ref','466b32a95dfb0549aeb06a2c6215982a514505ba','--subdir','ProofBench','--task','prove','--targets','main_theorem','--lean-project','C:\QEDRank\proofbench-statements')
  node qedrank/cli.js run @corpus --models glm            --papers P109,P110 --attempts 2 --config configs/glm-prove-pass4.json            --run-id smoke-glm-20261023
  node qedrank/cli.js run @corpus --models qwen35         --papers P109,P110 --attempts 2 --config configs/qwen35-prove-pass4.json         --run-id smoke-qwen35-20261023
  node qedrank/cli.js run @corpus --models deepseek_flash --papers P109,P110 --attempts 2 --config configs/deepseek-flash-prove-pass4.json --run-id smoke-deepseek-flash-20261023
  node qedrank/cli.js stats --run-id smoke-glm-20261023
  ```

  `--attempts` and `--papers` on the command line override the config file (cli.js builds
  `overrides.generation.attempts` from the flag), so the configs stay at 4.
  If a thinking model returns `empty_response`, raise `maxTokens` in its config before the full
  run (Qwen3.5 is at 32,768; GLM and DeepSeek already at 65,536). An instant empty HTTP 500 on every request means GWDG rejects the effort level
  for that model (seen for DeepSeek V4 Flash at `high`, hence its config uses `max`): pick a level
  the slot's `effortValues` allow. Do not remove `effort` for DeepSeek: without the field it does
  not think at all.
- [ ] Full runs (one model at a time; each is resumable with
  `node qedrank/cli.js resume --run-id <id> --retry-failed` after any stop, daily cap or 429 halt):

  ```powershell
  node qedrank/cli.js run @corpus --models glm            --config configs/glm-prove-pass4.json            --run-id glm-prove-pass4
  node qedrank/cli.js run @corpus --models qwen35         --config configs/qwen35-prove-pass4.json         --run-id qwen35-prove-pass4
  node qedrank/cli.js run @corpus --models deepseek_flash --config configs/deepseek-flash-prove-pass4.json --run-id deepseek-flash-prove-pass4
  ```

  Progress: `node qedrank/cli.js stats --run-id <id>`; the Evaluation page via
  `npm run qedrank:serve` (port 8787) + `npm run dev` (port 3000) → load the run.
  Record in the log: start date, requests used, halts, resume commands run.
- [ ] After each run: `stats`, pass@k curve on the Evaluation page, LaTeX export
  (`paper/make-tex.cjs` supports k > 1), note anomalies (rate of `empty_response`, timeouts,
  provider halts) here.
- [ ] Optional, only if the user asks for the agent protocol as well: smoke
  `node qedrank/cli.js agent-run --run-id agent-glm-smoke --models glm --problems P109,P110 --attempts 1 --sessions 1`
  (needs the Docker sandbox image `proofbench-sandbox:latest` from `scripts/build-sandbox.ps1` and
  the harness `.venv` in `C:\QEDRank\QEDRank-ProofBencheval`; see `docs/agent-evaluation.md`).

### 4D. Close-out

- [ ] Update the memory note `project_gwdg_roster_handoff.md` and this file (section 2 and the log).
- [ ] Update the Claude Doc "QEDRank Evaluation Methodology" (edit, do not recreate): roster
  table and the GWDG-served models' settings.
- [ ] Tell the user what ran, what the numbers are, and what is still open.

## 5. Decisions that belong to the user

1. **k vs quota.** Decided 2026-10-23: k = 4 (444 requests per model; 1,332 for three models
   against the 3,000/month account pool). k = 8 would have been 888 per model.
2. **Effort.** Decided 2026-10-23: GLM and DeepSeek V4 Flash both at `max`. The user left GLM
   open between `high` and `max`; `max` was chosen so both GWDG thinking models run at their
   default maximum (GWDG allows only `low` or `max` for DeepSeek). Output budget 65,536 tokens.
3. **Prove prompt and hidden definitions** (open since 2026-10-13).
4. **Go-ahead** for commit/push, merge to main, and the Vercel deploy: given 2026-10-23.
5. Whether to delete the former slots (`kimi`, `mistral`, `llama`, `deepseek`) later, which would
   also need the fixture directories `qedrank/test/fixtures/corpus-prove/responses/{kimi,llama}`
   to be renamed.

## 6. Gotchas

- Masked prompt: Ctrl+V does not paste in a SecureString prompt; right-click or Shift+Insert,
  or `-FromClipboard`. The script rejects control characters and keys under 8 characters.
- `models` says `configured` for the GWDG slots even before the new key is entered, because the
  old `LLAMA_API_KEY` is still in the user environment. Set `GWDG_API_KEY`; it wins.
- `ping` showed `attempts 2` for glm and qwen35: one request each was retried (rate limit or
  5xx). Keep `providerConcurrency` at 2 (configs) unless the headers allow more.
- GWDG probe, 2026-10-23 evening (30 tiny Lean prompts): GLM answered at effort high 3/3, low 5/5,
  max 2/2; DeepSeek V4 Flash at low 3/4, max 2/2, high 0/2 (instant empty 500), no field 2/3 but
  without thinking; plain Qwen3 2/2 in 0.5 s. Four requests to the two large thinking models
  stalled for the full 120 s timeout and one hung indefinitely without a timeout, so the endpoint
  stalls under load. The run configs' 30-minute timeout and 6 retries cover this, but every stalled
  or failed request still counts against the quota.
- `infrastructure_failure` with `challenge_does_not_compile` means the Lean project cannot compile
  the challenge (wrong project or project behind the corpus), never a network or compute problem;
  an HPC node changes nothing about it. Since 2026-10-23 the run stops up front in that case.
- The page's default corpus is `vaibhav-baj/ProofBench` at its newest commit; the built project
  tracks `proofbench-statements@466b32a` (111 problems). Newer corpus commits need the project
  synced and rebuilt first; the import check reports exactly which modules are missing.
- The private-corpus guard refuses Anthropic/OpenAI slots for ProofBench by design; a run with
  them exits 1 before any request.
- git prints "LF will be replaced by CRLF" warnings for the edited files; harmless (core.autocrlf).
- `npm run lint` is broken by its ts/tsx glob (pre-existing); use `npm test` and `npx vite build`.
- A Vite dev server started from a tool keeps running after TaskStop; kill it by PID.

## 7. Log

- 2026-10-23 (session 1): roster change implemented and verified (tests, build, live ping of the
  three new models with the existing key, `/v1/models` listing). Configs and this handoff
  written. Machine config now allows `chat-ai.academiccloud.de`. Old key's limits read from the
  headers (30/min, 200/h, 1,000/day, 3,000/month). Waiting for the user to enter the new key and
  to give the go-ahead for 4B.
- 2026-10-23 (session 1, later): the user entered the new key (saved as `GWDG_API_KEY`, 32
  characters). Verified from the project folder: `models` ok; `ping` ok for qwen, qwen35,
  deepseek_flash; glm 500 twice then ok on a second ping. New key's limits read: same tier, and
  the counters are shared with the old key (per account). The user's first attempt failed only
  because the new terminal opened in the home folder (`Cannot find module ...\qedrank\cli.js`).
- 2026-10-23 (session 1, evening): effort probe (section 6). Result: `deepseek_flash` now sends
  only low | max (`lib/providers.js` effortValues, test added) and its config uses `max`; docs
  updated. Roughly 45 of the day's 1,000 requests were spent on pings and probes.
- 2026-10-23 (session 1, night): user decided k = 4 and gave the go-ahead for publish and deploy;
  GLM effort set to `max` (uniform with DeepSeek), configs renamed to `*-prove-pass4.json` with a
  65,536-token budget for the two `max` models. Committed `28162d1` and pushed; merged into main as
  `18af26d` and pushed; `GWDG_API_KEY` copied to Vercel; production redeployed and aliased to
  https://qedrank.vercel.app. Verified live: `GET https://qedrank.vercel.app/api/models` returns
  the ten slots with qwen, qwen35, glm and deepseek_flash `configured` via `GWDG_API_KEY` (the
  Anthropic slots have no key there; the four GPT slots do). This handoff update was committed as
  a second commit on `QEDRank` and merged into `main` the same way. Next: 4C smoke runs, after
  asking about the hidden-definitions question (section 5, item 3).
- 2026-10-23 (session 1, night, 2): `qedrank/README.md` (roster table and ten-slot wording) had been left
  out of the first commit; committed and merged separately. Working tree is now clean apart from the
  older `paper/` files.
- 2026-10-23 (session 1, night, 3): the user's page-started run failed on the audit project (section
  2, "Fixed"). Import check and default Lean project implemented, tested, committed `377a33e`, merged
  `bef4a0c`. Full-corpus dry run clean. Smoke runs for qwen35 and glm started from the CLI with the
  pass4 configs (2 papers × 2 attempts); results follow in the next log line.
- 2026-10-23 16:07Z: the page-started job `job-1792769599642-1` (run `2026-10-23-515eb05`) was
  stopped (run server status `stopped`, process gone). It had kept running next to the smoke runs
  and was spending requests on the papers whose challenges import Mathlib only. Do not restart it
  from the page: the page launcher uses the run defaults and the newest corpus commit, not the
  pass4 configs and the built project's commit; start runs from the CLI commands in 4C.
- Smoke `smoke-qwen35-20261023` finished: import check ok, 4 of 4 items graded in
  `C:\QEDRank\proofbench-statements` (Lean 4.33.1), 0 infrastructure failures, 0 solved
  (compile errors in the model's proofs), median 149 s per item. The pipeline works end to end.
- 2026-10-26: the user started a GLM prove run from the page asking for 16 attempts (job
  `job-1792981965489-1`, run `2026-10-26-515eb05`, corpus `vaibhav-baj/ProofBench@515eb05`, 116
  papers). It ran with k = 1 because the page's single-call request (`src/qedrank/panels.jsx`,
  `request` and `commandLine`) never sends `attempts`; only the agent-run branch does
  (`jobs.js` would accept `--attempts` for `run`). The run also used the run defaults, not
  `configs/glm-prove-pass4.json` (temperature 0, effort high, 16,384 tokens, 5-min timeout), and
  `lake env` failed at start (`toolchain.available: false`; it works again from a shell the same
  day, cause unknown). Result: 64 one-sentence "cannot complete" answers, 44 with the whole
  budget spent on reasoning, 6 timeouts, 1 runner error, 1 file (P111) not graded; 0 proofs
  checked; 136 GWDG requests spent. Run is invalid. Page fix not made yet (open user decision).
- 2026-10-27: Lean environments (user's go-ahead for the plan "Part 1 steps 1–2 first, then the
  Selenium e2e suite"): `qedrank/lib/leanenv.js` (host | docker | apptainer backends, `auto`
  default = host when built), `LeanRunner` maps run-folder paths into the container and wraps each
  compile in `docker run --rm --network none` / `apptainer exec`, the prove-task import check runs
  inside the container, `lean-env/Dockerfile` + `.def` (benchmark-neutral image of any Lean
  project), CLI `lean-env status|build`, `--backend/--image/--sif` on every Lean command,
  `run.json.toolchain.environment`. Docs: qedrank/README (Quick start, Configuration, Isolation),
  docs/agent-evaluation.md §9 and §10a (HPC re-grade split), TESTING.md §3 (container variant of
  the grade fixtures), lean-env/README.md. Tests 165 pass. Uncommitted on branch QEDRank. Open:
  the 116-problem corpus still needs the Lean project at the 24 Oct statements (P003, P112–P115).
- 2026-10-27 (later): validated — image `qedrank-lean:lean-core` built from the fixture project by
  `lean-env build`; the 14 grader fixtures give identical verdicts on the host and inside that
  container (`QEDRANK_LEAN_BACKEND=docker`); one fix on the way: `#qr_olean_diff` / `#qr_replay`
  scripts now receive container-mapped paths. Page launcher fixed (single-call request and command
  preview carry `--attempts`). Selenium e2e suite (`npm run e2e`, `e2e/`, fixture runs
  `qedrank/test/fixtures/runs/{e2e-prove,e2e-formalize}`, `.github/workflows/e2e.yml`). The e2e
  servers scrub `*_API_KEY`/`GITHUB_TOKEN`/`QEDRANK_*` before loading the API functions: the first
  local runs (before that guard) let the Convert test send real requests to the GWDG and OpenAI
  slots configured on this PC (a few requests each, two runs + one debug run). e2e suite green
  (11 tests, headless Chrome 155) against `e2e-prove`. Image of the ProofBench project started:
  `qedrank-lean:proofbench-466b32a` (needs `sed` of CRLF in lean-toolchain — fixed in the Dockerfile).
- 2026-10-27 (page, user request): no "2. Load a run" step anywhere. The run server address is one
  shared setting (`qedrank.runServer` in localStorage, AppState `runServer`); the launcher loads
  the finished job's run by itself; the Evaluation page loads the newest run with statistics by
  itself and keeps a compact "Runs on this machine" row (server address + run files folded away);
  `RunPanel` removed, `RunSwitcher` + `useAutoLoadRun` in `src/qedrank/panels.jsx`. e2e tests and
  docs follow. Image build: `lake build` builds only library roots, so `lean-env/build-modules.sh`
  sweeps every module (or `--modules` prefixes; ProofBench: `ProofBench.Mathlib_Problems`); the
  build context is staged as `project/` + `qedrank/` so Mathlib layers stay cached.
- 2026-10-27 (evening): `qedrank-lean:proofbench-466b32a` built (3.3 GB; sweep: 46 modules under
  ProofBench.Mathlib_Problems, every module built). P001 graded against itself inside the image:
  not_solved [contains_sorry], target same, 0 definitions changed — and the compiles took 3–6 s
  against ~40 s on the Windows host (Linux Lean is far faster here): on this PC set
  `"verification": { "backend": "docker", "image": "qedrank-lean:proofbench-466b32a" }` in
  qedrank.config.json for grading, `auto` still picks the host. e2e green over both fixture runs
  (12 tests). Corpus-wide import check inside the image: `run … --dry-run --backend docker`
  (result below).
- 2026-10-27 (night, user request "fix it and produce pass@k 1–16"): the page-started run
  `2026-10-27-515eb05` (10 problems, glm+qwen, page defaults) had k=1, GLM 10× no file (5 one-line
  refusals, 5 thinking exhausted 16k tokens), Qwen 8× cut off at 16,384 tokens → compile errors.
  Fix: run server `GET /configs` lists `configs/*.json`; the launcher offers them plus temperature /
  effort / max tokens / timeout / in-flight fields; requests carry `config`, `attempts` and the
  settings (`jobs.js` validates: file name only, bounded numbers); CLI gained `--temperature
  --top-p --effort --max-tokens --timeout-ms --provider-concurrency` (override `--config`) and
  warns when attempts > 1 at temperature 0; the page sends temperature 1.0 in that case. pass@16
  joined the prominent k (stats.js PASS_K_PROMINENT, page table/figure). ProofBench image rebuilt
  with `--modules ProofBench.Mathlib_Problems,Matroid` (the Matroid package was missing; the
  Docker import check caught it; `build-modules.sh` now builds dependency packages named as
  prefixes). Tests 167; e2e 12/12. Docker import check with the statement-library-only image:
  10 modules missing (the 3 genuinely newer ones + 7 `ProofBench.PROBLEMS.Pxxx` modules that other
  challenges import), so the image is being rebuilt with `--modules ProofBench,Matroid`.
- 2026-10-27 (late): today's work committed on `QEDRank`, merged into `main` and deployed to
  Vercel with the user's go-ahead ("redeploy on vercel with updated branch"). Branch cleanup
  (retire `QEDRank`, `one-folder`, `consolidate`; switch the root checkout to `main`) proposed,
  not yet approved.
