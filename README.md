# QEDengine · QEDRank

Convert mathematical problems to Lean 4 with any set of frontier models, rate the answers, and
benchmark the same roster on a whole paper corpus with Lean-verified, statistically analysed
results.

## What is in the app

Three pages, one shared model selection:

| Page | What it does |
|---|---|
| **Convert** (`/`) | Modern front page: pick any number of the eleven roster models (cards show vendor, model id and whether a key is set), state a problem, get Lean 4 from every selected model side by side with latency, tokens and a 1–5 rating, plus a performance snapshot (latency chart + table) of the models you chose. |
| **Benchmark** (`/benchmark`) | QEDRank batch mode: freeze a GitHub corpus at a commit, preview the manifest, get the exact local run command (with `--models` set to your selection), serve/load runs and watch progress. |
| **Evaluation** (`/evaluation`) | The complete evaluation matrix and analysis for the loaded run: leaderboard with 95% paper-cluster CIs, models × targets heatmap, the full matrix table, statement-match distribution, time, tokens & cost, calibration diagrams, the k-model comparison (Cochran's Q, exact McNemar with Holm correction, paired-difference matrix), subgroups, coverage, reference audit and the filterable item table. Every chart has a table twin and CSV/JSON downloads. Light and dark themes. |

## Model roster

Eleven models, offered in this order. Nine use the OpenAI-compatible chat-completions protocol
and two the Anthropic Messages API; everything goes through one client (`lib/providers.js`)
that both the single-problem page and the benchmark use. Ids and endpoints were checked on
2026-10-01.

| # | Slot id | Model | Vendor / endpoint | Default model id | Key |
|---|---|---|---|---|---|
| 1 | `fable` | Claude Fable 5.1 | Anthropic Messages API | `claude-fable-5-1` | `ANTHROPIC_API_KEY` |
| 2 | `opus` | Claude Opus 5.5 | Anthropic Messages API | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| 3 | `qwen` | Qwen3 30B-A3B Instruct | GWDG Chat AI / AcademicCloud (`https://chat-ai.academiccloud.de/v1`) | `qwen3-30b-a3b-instruct-2507` | `GWDG_API_KEY` (shared with `llama`; an existing `LLAMA_API_KEY` works) |
| 4 | `mistral` | Leanstral | Mistral AI | `labs-leanstral-2603` | `MISTRAL_API_KEY` |
| 5 | `gpt6_astra` | GPT-6 Astra | OpenAI | `gpt-6-astra` | `OPENAI_API_KEY` |
| 6 | `gpt6_sol` | GPT-6 Sol | OpenAI | `gpt-6-sol` | `OPENAI_API_KEY` |
| 7 | `gpt56_terra` | GPT-5.6 Terra | OpenAI | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| 8 | `gpt54` | GPT-5.4 | OpenAI | `gpt-5.4` | `OPENAI_API_KEY` |
| 9 | `kimi` | Kimi K3 | Moonshot AI | `kimi-k3` | `MOONSHOT_API_KEY` |
| 10 | `llama` | Llama 3.1 8B Instruct | GWDG Chat AI / AcademicCloud (`https://chat-ai.academiccloud.de/v1`) | `meta-llama-3.1-8b-instruct` | `GWDG_API_KEY` (or `LLAMA_API_KEY`) |
| 11 | `deepseek` | DeepSeek V4 | DeepSeek | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` |

A slot without a key is shown as “no key” and skipped (benchmark items are recorded as
infrastructure failures, never as successes). Reasoning models (Claude, GPT-5.x/6) do not accept
a temperature; they receive an effort level instead and every record stores what was actually
sent.

**Every slot can be re-pointed without code changes** (`<ID>` = slot id upper-cased, e.g.
`GPT54`, `GPT6_ASTRA`, `LLAMA`):

```
QEDRANK_API_KEY_<ID>       key for this slot only (wins over the vendor key)
QEDRANK_BASEURL_<ID>       endpoint, e.g. https://<resource>.services.ai.azure.com/models
QEDRANK_MODEL_<ID>         model or deployment id
QEDRANK_AUTH_HEADER_<ID>   "api-key" for Azure AI Foundry (default: Authorization: Bearer)
QEDRANK_EFFORT_<ID>        low | medium | high | … for reasoning models
QEDRANK_MODELS=gpt54,deepseek,llama   restrict and order the roster
```

Optional provider slots outside the roster (`openrouter`, `groq`, `siliconflow`, `together`,
`gemini`, `huggingface`, `nvidia`, `custom`, `openai`, `anthropic`, `cohere`) remain available via
`QEDRANK_MODELS`. See [qedrank/README.md#model-roster](qedrank/README.md#model-roster).

## Entering API keys with masked input (PowerShell)

Keys are read with `Read-Host -AsSecureString`: nothing is echoed, only the first four
characters are printed back, and nothing is written to a file. A vendor key shared by several
slots (Anthropic, OpenAI) is asked for once.

```powershell
# local CLI / runner: Windows user environment variables
.\scripts\set-llm-keys.ps1 -Target User

# only the models you have keys for today
.\scripts\set-llm-keys.ps1 -Target User -Only gpt54,deepseek,llama

# deployed web app: Vercel project environment, then redeploy
.\scripts\set-llm-keys.ps1 -Target Vercel -Redeploy

# gateways such as Azure AI Foundry, where each deployment has its own endpoint + key
.\scripts\set-llm-keys.ps1 -Target User -Only llama -Advanced
#   -> QEDRANK_API_KEY_LLAMA, QEDRANK_BASEURL_LLAMA, QEDRANK_MODEL_LLAMA, QEDRANK_AUTH_HEADER_LLAMA

# already stored keys with -Target User? copy them to Vercel with no typing, then redeploy
.\scripts\set-llm-keys.ps1 -Target Vercel -FromUserEnv -Redeploy

# masked paste unreliable in your terminal? read each key from the clipboard instead
.\scripts\set-llm-keys.ps1 -Target User -Only llama -FromClipboard

# current session only (dot-source)
. .\scripts\set-llm-keys.ps1 -Target Session

node qedrank/cli.js models        # which slots have a key
node qedrank/cli.js ping          # one small Lean task per configured model
```

**Keys live in separate places.** `-Target User` stores them on your PC for the local CLI and
runner (`node qedrank/cli.js …`). The deployed web app reads only the **Vercel project's**
environment variables, so the site shows "No key" until you run the script with `-Target Vercel`
(or `-Target Vercel -FromUserEnv`) and redeploy. Check each side with `node qedrank/cli.js models`
(local) and `vercel env ls production` (deployed).

**Pasting:** in Windows PowerShell 5.1, Ctrl+V does not paste into a masked prompt (it inserts a
control character). Paste with a right-click or Shift+Insert, or use `-FromClipboard`. The script
rejects control characters and inputs shorter than 8 characters.

**Public deployments spend your credits.** `/api/verify` has no login: once keys are in Vercel,
anyone who can open the site can trigger model calls on your accounts. Turn on Vercel Deployment
Protection (Project → Settings → Deployment Protection) or put only low-cost keys there.

## Architecture

```
/
├── api/
│   ├── models.js        # GET roster (labels, model ids, which keys are set; never a key)
│   ├── verify.js        # POST one problem -> one model (the page sends one request per model)
│   ├── feedback.js      # feedback collection and storage
│   └── qedrank/discover.js  # corpus preview (GitHub URL + ref -> manifest)
├── lib/providers.js     # the model registry and the two transports (OpenAI-compatible, Anthropic Messages)
├── lib/model-facts.js   # release date, training cutoff and size per model id, with sources
├── qedrank/             # QEDRank batch benchmark runner (Node CLI) + tests
│   ├── cli.js           # models | ping | discover | run | resume | stats | grade | import-agent | serve | toolchain
│   └── lib/             # source, corpus, pdf, prompt, models, lean, evaluate, compare, grade, agent, metrics, analysis, stats, export
├── harness/             # Inspect AI agent harness: sessions, handoff, tools, sandbox image, export (see harness/README.md)
├── lean/                # pinned Lean 4 + Mathlib sandbox (QEDRank.Prelude, QEDRank.Audit = evaluator commands)
├── scripts/
│   ├── set-llm-keys.ps1     # masked key entry (Vercel / user env / session; -Advanced per-slot endpoints)
│   └── qedrank-preview.ps1  # masked GitHub token for private corpus previews
├── src/
│   ├── main.jsx, App.jsx    # router, top bar, theme toggle
│   ├── state/AppState.jsx   # roster, model selection, loaded run, theme
│   ├── components/          # ModelPicker, slot colours
│   ├── charts/primitives.jsx  # inline-SVG charts with tooltips and table twins
│   ├── pages/               # HomePage (Convert), BenchmarkPage
│   ├── evaluation/          # EvaluationPage, matrix/comparison/coverage/items views
│   └── qedrank/             # corpus and run-loader panels, helpers
├── .env.example
└── vercel.json              # function budgets + SPA rewrite (API paths excluded)
```

## QEDRank batch benchmark mode

1. On **Benchmark**, paste a GitHub repository, branch or folder link. The app resolves it to
   an immutable commit and shows the manifest of papers, PDFs and ground-truth Lean targets,
   flagging anything ambiguous. The expected paper count (108) is compared against, never assumed.
2. Run locally — model calls, Lean compilation in the pinned sandbox, dependency audits and
   statement comparison all happen on your machine. The page prints the command with your
   model selection:
   ```bash
   node qedrank/cli.js run --repo https://github.com/<owner>/<corpus> --ref <commit> --models gpt54,deepseek,llama
   ```
3. Serve the runs (`npm run qedrank:serve`), load one on **Benchmark**, and open **Evaluation**.
   Partial runs can be polled while in progress and resumed with `node qedrank/cli.js resume --run-id <id>`.

Full details (measurements, eligibility rules, corpus layout, annotations, expert-review inputs,
isolation policy, statistics) are in [qedrank/README.md](qedrank/README.md).

## Agent protocol (Inspect AI)

The paper's evaluation protocol — a tool-using agent on the challenge file, at most *x* fresh
sessions with a fixed handoff note, an independent Lean check after every session, web search
through one external provider or no network at all — is implemented in [harness/](harness/README.md)
on Inspect AI. The check is `node qedrank/cli.js grade` (compiled-declaration comparison, axiom
audit, kernel replay, completeness); results come back into QEDRank with
`node qedrank/cli.js import-agent` and get the same statistics and the same Evaluation page.

## Local development

Prerequisites: Node.js 18+ and npm.

```bash
npm install
.\scripts\set-llm-keys.ps1 -Target User     # or: cp .env.example .env.local and fill it in
npm run dev                                 # http://localhost:3000 (API routes need `vercel dev`)
npm test                                    # runner + provider tests
npm run build
```

Optional feedback storage: Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, see
`supabase-setup.sql`) or EmailJS (`EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`).

## Deployment to Vercel

1. Push the repository to GitHub and import it in Vercel (or `vercel deploy --prod` from the checkout).
2. Add the keys as environment variables — `.\scripts\set-llm-keys.ps1 -Target Vercel -Redeploy`
   does it with masked input — plus any feedback storage credentials.
3. `vercel.json` gives the two functions a 60 s budget and rewrites every non-`/api` path to the
   single-page app so `/benchmark` and `/evaluation` load directly.

Only the preview endpoint and the single-problem bridge run on Vercel; generation, Lean
checking and evaluation always run locally.

## API endpoints

### GET /api/models
The roster: label, vendor, model id, API host, which key variable is in use, reasoning flag, tier
and notes. Never returns a key.

### POST /api/verify
```json
{ "mathProblem": "Prove that the square root of 2 is irrational", "provider": "gpt54" }
```
Response: `{ "results": [{ "provider", "model", "modelId", "responseModel", "leanCode", "success", "latencyMs", "usage", "reasoningChars", "finishReason", "sampling": { "temperature", "effort" } }], "timestamp" }`.
Without `provider`, every configured roster model is called in parallel.

### POST /api/feedback
`{ "mathProblem", "results": [...], "feedback": { "gpt54": 5, "deepseek": 4 } }` — stored in
Supabase and/or sent through EmailJS when configured.

## License

MIT License - see LICENSE file for details.
