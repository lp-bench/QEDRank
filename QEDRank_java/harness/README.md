# ProofBench agent harness (Inspect AI)

The evaluation protocol of the paper, as code: a tool-using agent works on one challenge
file in a sandbox, in at most *x* fresh-context sessions joined by a handoff note, and
after every session an independent Lean check decides whether the problem is solved. The
harness is [Inspect AI](https://inspect.aisi.org.uk); the check is QEDRank's `grade`
command (`qedrank/lib/grade.js`), and QEDRank's statistics read the results.

```
harness/
  proofbench_harness/   the Inspect task: problems, prompts, tools, sessions, grading, scoring, export
  sandbox/              Dockerfile for the sandbox/grader image, compose files, proxy configuration
  tests/                runs the whole chain with a scripted model, no API key or Docker needed
```

## What the harness does

| Protocol | Implementation |
|---|---|
| Harness: Inspect AI, API access only | `inspect eval` with any provider Inspect supports; no vendor chat harness is involved |
| Tools: shell, Lean language server (lean-lsp-mcp), file editing, Python with sympy and networkx, SageMath (GAP, nauty), CaDiCaL | `bash`, `python`, `text_editor` and `end_session`; lean-lsp-mcp started inside the sandbox; the rest is installed in the image (`sandbox/Dockerfile`) |
| Network off: no downloads; the five web-backed Lean search tools removed | `compose.offline.yaml` (`network_mode: none`); `LEAN_LSP_WEB_TOOLS` are filtered out of what the model is offered, not merely left failing |
| Web search through one external provider for every model | `-T web_search=true`: a `web_search` tool on Tavily/Exa/Google (never a vendor's built-in search) plus `web_fetch`; the sandbox reaches the internet only through a logging proxy (`compose.search.yaml`) |
| Every query and address recorded | `chain.search` and `chain.search_log` per sample: search queries with the result addresses, pages fetched, Lean web-search queries, addresses used in shell or Python commands, and the proxy log |
| At most *x* sessions; fresh context; file + compiler output + handoff note | `session_chain`: each session is a new conversation of system prompt + one user message; the note is `HANDOFF.md` next to the file, reduced to its fixed format (`handoff.py`) before it is passed on |
| First session that passes ends the chain | the check runs after every session; a pass stops the loop |
| Output-token budget per session, enforced by the harness | Inspect's `token_limit(…, type="output")` around each session; the model is warned once at 85 % of the budget to update its note |
| Wall-clock and total-token limits as safety nets | `session_time_s`, `session_total_tokens` (per session) and sample-level limits sized at 1.25 × *x* × the session limits |
| Total and working time | per session: wall clock, Inspect's working time (wall clock minus waits on retries, rate limits and connection slots), model-call time of the calls that succeeded, tool time, grading time |
| Tool-call and model-call counts | per session and per tool name |
| Grading: compiles in a clean container, no sorry, standard axioms, statement and definitions unchanged, imports restricted, proof length and compile time | `grader=docker`: `docker run --rm --network none <image> node qedrank/cli.js grade …` with only the file's text taken from the sandbox; see [the grade command](../qedrank/README.md#independent-check-grade) |
| Hand audit of every solve | `runs/<id>/review/audit.json` (see QEDRank README); solves are listed as awaiting audit until then |
| Frozen per run | `eval.metadata`: harness commit and dirtiness, problem-set commit, Lean toolchain and Mathlib commit of the problem set, sandbox image id, web-search flag, limits, grader settings; model id and reasoning effort are in the eval header and per sample |
| Measured per session | verdict, tokens (input, output, cached, reasoning), cost (when Inspect knows the model's prices), total and working time, model and tool calls, proof length, compile time, completeness |

## Setup

```bash
cd harness
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest                                            # scripted model, local sandbox, stub grader
```

Build the sandbox image from the QEDRank repository root with a ProofBench checkout as a
named context (the proctor material is removed in a separate build stage):

```bash
docker build -f harness/sandbox/Dockerfile \
    --build-context proofbench=/path/to/ProofBench \
    --build-arg PROOFBENCH_COMMIT=$(git -C /path/to/ProofBench rev-parse HEAD) \
    -t proofbench-sandbox:$(git -C /path/to/ProofBench rev-parse --short HEAD) .
```

The image has not been built on the machine this code was written on (Docker was not
running there); expect to adjust package names on first build. Pin `LEAN_LSP_MCP_SPEC` and
`SAGE_SPEC` once the first build works, and keep the image id with the run record.

## Running

```bash
export ANTHROPIC_API_KEY=…            # the provider of the model under test
export TAVILY_API_KEY=…               # only for -T web_search=true

# offline tier of 4 sessions, 64k output tokens per session
inspect eval harness/proofbench_harness/task.py@proofbench \
    --model anthropic/claude-fable-5-1 --reasoning-effort high \
    -T problems=/path/to/ProofBench -T max_sessions=4 -T session_output_tokens=64000 \
    -T image=proofbench-sandbox:abc1234 --max-sandboxes 4

# the same with web search
inspect eval … -T web_search=true

# independent restarts are epochs; a subset of problems
inspect eval … --epochs 3 -T ids=P001,P004,P007
```

`inspect view` shows the sessions, tool calls and grades of every sample. Task arguments are
documented in `proofbench_harness/task.py` (`proofbench(...)`).

Local grading (`-T grader=local -T grader_lean_project=/path/to/ProofBench`) runs the check
on this machine against a Lake project here; it is for development, not for reported runs.
`-T sandbox_type=local` runs the agent without Docker in a temporary directory on this
machine, with no isolation at all; use it only with a scripted model.

## On Windows (Docker Desktop)

The commands above are bash. On Windows two scripts do the same without shell translation;
start Docker Desktop first and wait for "Engine running":

```powershell
gh repo clone vaibhav-baj/ProofBench C:\ProofBench                       # private; uses your gh login
.\scripts\build-sandbox.ps1 -ProofBench C:\ProofBench -Ref <commit>      # tags proofbench-sandbox:<short commit>
.\scripts\agent-run.ps1 -Model moonshot/kimi-k3 -Problems C:\ProofBench -Ids P050 -Sessions 1 -OutputTokens 8000 -Image proofbench-sandbox:<short>
.\scripts\agent-run.ps1 -Model openai-api/gwdg/qwen3-30b-a3b-instruct-2507 -Problems C:\ProofBench -Sessions 4 -Image proofbench-sandbox:<short>
```

`agent-run.ps1` reads the keys that `set-llm-keys.ps1` stored (the GWDG key under `GWDG_API_KEY`
or `LLAMA_API_KEY`), runs the eval, exports the log and imports it as a QEDRank run; `-DryRun`
prints the composed `inspect eval` command instead.

## From logs to the statistics

```bash
proofbench-export logs/*.eval --out bundle.json             # one log per model; several logs merge
node qedrank/cli.js import-agent --bundle bundle.json --run-id agent-x4
```

`import-agent` creates `runs/agent-x4/` with one record per problem, model and epoch and
computes the usual summary: solved-within-*k*-sessions rates with paper-clustered bootstrap
intervals, paired McNemar tests with Holm correction, effort by difficulty, difficulty
proxies per problem, capability by model release date, and the contamination split. The
web app's Evaluation page loads the run like any other.

A grading that could not be carried out (`grader_error`) is an infrastructure failure: left
out of every rate, counted separately. `proofbench-export --regrade errors` re-runs the check
on the stored final file without re-running the agent.

## Not yet done

- The Docker image, the compose files and the proxy log were written without a Docker
  daemon at hand and have not been exercised.
- With web search on, libraries the agent installs are not yet carried into the clean
  grading container. The grader accepts them (`--extra-lean-path`), but the harness does not
  export them from the sandbox; a solution that imports such a library currently fails the
  check with `disallowed_import` unless `allow_extra_imports` is set and the library is
  reachable by the grader.
- Cost is taken from Inspect's price table when it has the model; otherwise configure
  `pricing` in `qedrank.config.json` for the QEDRank summary.
