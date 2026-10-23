# QEDRank Setup Guide

## Prerequisites

You need Node.js (version 18 or higher) and npm installed on your system.

```bash
node --version
npm --version
```

If not installed, download from: https://nodejs.org/

## Quick Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Enter your API keys (masked input, PowerShell)

Nothing is echoed; only the first four characters are printed back; nothing is written to a file.

```powershell
# Windows user environment (local CLI, runner and `vercel dev` see them in a new terminal)
.\scripts\set-llm-keys.ps1 -Target User

# just the slots you have keys for today — press Enter to skip the rest
.\scripts\set-llm-keys.ps1 -Target User -Only gpt54,qwen

# the one GWDG Chat AI key (serves qwen, qwen35, glm and deepseek_flash)
.\scripts\set-llm-keys.ps1 -Target User -Only qwen

# a model served from your own endpoint (Azure AI Foundry, a gateway, Groq, NVIDIA NIM…)
.\scripts\set-llm-keys.ps1 -Target User -Only glm -Advanced
```

The ten slots and their key variables:

| Slot id | Model | Key variable |
|---|---|---|
| `fable`, `opus` | Claude Fable 5.1, Claude Opus 5.5 | `ANTHROPIC_API_KEY` (asked once) |
| `qwen`, `qwen35`, `glm`, `deepseek_flash` | Qwen3 30B-A3B Instruct, Qwen3.5 397B-A17B, GLM-5.3 Flash, DeepSeek V4 Flash (all GWDG Chat AI / AcademicCloud, `https://chat-ai.academiccloud.de/v1`) | `GWDG_API_KEY` (asked once; an existing `LLAMA_API_KEY` works) |
| `gpt6_astra`, `gpt6_sol`, `gpt56_terra`, `gpt54` | GPT-6 Astra, GPT-6 Sol, GPT-5.6 Terra, GPT-5.4 | `OPENAI_API_KEY` (asked once) |

Former roster slots, still available with `QEDRANK_MODELS=…` or `-Optional`: `kimi` (`MOONSHOT_API_KEY`),
`mistral` (`MISTRAL_API_KEY`), `llama` (`GWDG_API_KEY`), `deepseek` (`DEEPSEEK_API_KEY`, DeepSeek's own API).

Prefer a file? `cp .env.example .env.local` and fill it in (used by `vercel dev`). Per-slot
overrides (`QEDRANK_API_KEY_<ID>`, `QEDRANK_BASEURL_<ID>`, `QEDRANK_MODEL_<ID>`,
`QEDRANK_AUTH_HEADER_<ID>`, `QEDRANK_EFFORT_<ID>`) are documented there.

### 3. Check the roster
```bash
node qedrank/cli.js models          # which slots have a key
node qedrank/cli.js ping            # one small Lean task per configured model
node qedrank/cli.js ping --compile  # …and compile each answer with the pinned toolchain
```

### 4. Optional: feedback storage

**Supabase (recommended)** — create a project, run `supabase-setup.sql` in the SQL editor, set
`SUPABASE_URL` and `SUPABASE_ANON_KEY`.
**EmailJS** — set `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`.

### 5. Start the development server
```bash
npm run dev          # Vite only (pages render; /api routes need the next line)
vercel dev           # Vite + the serverless functions, reads .env.local
```
Visit http://localhost:3000 (or the port `vercel dev` prints).

### 6. Pages

- **Convert** `/` — choose models, state a problem, compare answers and the performance snapshot.
- **Benchmark** `/benchmark` — preview a corpus, get the run command, load runs.
- **Evaluation** `/evaluation` — the complete matrix, charts and statistics for the loaded run.

## Testing the setup

```bash
node test-setup.js   # required files present?
npm test             # provider + runner tests
npm run build
```

## Troubleshooting

1. **Port 3000 already in use:** `npm run dev -- --port 3001`
2. **A model shows “No key”:** its key variable is listed on the card; run the PowerShell script
   with `-Only <slot>` and open a new terminal.
3. **A model has a key but errors at call time:** the vendor key may not have access to that
   model id (e.g. an OpenAI key without GPT-6 access). Override the model with
   `QEDRANK_MODEL_<ID>` or deselect the model.
4. **A model you host elsewhere (Azure, gateway):** `.\scripts\set-llm-keys.ps1 -Only <slot> -Advanced`
   sets the per-slot endpoint, model id, auth header and key.
5. **`/benchmark` or `/evaluation` 404 on Vercel:** keep the `rewrites` entry in `vercel.json`.

## Deployment to Vercel

```bash
git push                       # to GitHub, then import the repo in Vercel, or:
vercel deploy --prod
.\scripts\set-llm-keys.ps1 -Target Vercel -Redeploy   # keys with masked input, then redeploy
```
