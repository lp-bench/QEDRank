<#
.SYNOPSIS
  One agent-protocol run on Windows: Inspect eval in the Docker sandbox, export, import into QEDRank.

.DESCRIPTION
  Runs harness/proofbench_harness/task.py@proofbench for one model, then turns the Inspect log
  into a QEDRank run (statistics + Evaluation page). Keys come from the Windows user environment
  where scripts\set-llm-keys.ps1 stored them; nothing is printed.

  Model names are Inspect's: moonshot/kimi-k3, anthropic/claude-opus-5-5, openai/gpt-5.4, and any
  OpenAI-compatible endpoint as openai-api/<name>/<model> with <NAME>_API_KEY and <NAME>_BASE_URL.
  The GWDG endpoint is pre-wired: openai-api/gwdg/qwen3-30b-a3b-instruct-2507 or
  openai-api/gwdg/meta-llama-3.1-8b-instruct use GWDG_API_KEY (or the stored LLAMA_API_KEY).

.EXAMPLE
  # smoke test: one problem, one session
  .\scripts\agent-run.ps1 -Model moonshot/kimi-k3 -Problems C:\ProofBench -Ids P050 -Sessions 1 -OutputTokens 8000
  # the 4-session tier on every problem, offline
  .\scripts\agent-run.ps1 -Model openai-api/gwdg/qwen3-30b-a3b-instruct-2507 -Problems C:\ProofBench -Sessions 4
  # with web search (one external provider for every model; needs TAVILY_API_KEY)
  .\scripts\agent-run.ps1 -Model moonshot/kimi-k3 -Problems C:\ProofBench -WebSearch
#>
param(
  [Parameter(Mandatory = $true)] [string] $Model,
  [Parameter(Mandatory = $true)] [string] $Problems,
  [string] $Ids = '',
  [int] $Sessions = 4,
  [int] $OutputTokens = 64000,
  [int] $SessionTimeS = 0,
  [switch] $WebSearch,
  [string] $SearchProvider = 'tavily',
  [string] $Image = 'proofbench-sandbox:latest',
  [string] $ReasoningEffort = '',
  [int] $Epochs = 1,
  [int] $MaxSamples = 4,
  [string] $RunId = '',
  [switch] $SkipImport,
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repo 'harness\.venv\Scripts'
$inspect = Join-Path $venv 'inspect.exe'
$python = Join-Path $venv 'python.exe'
if (-not (Test-Path $inspect)) { throw "Inspect is not installed: cd $repo\harness; python -m venv .venv; .venv\Scripts\pip install -e `".[dev]`"" }
$Problems = (Resolve-Path $Problems).Path
if (-not $RunId) { $RunId = "agent-{0}-{1}-x{2}" -f (Get-Date -Format 'yyyyMMdd-HHmm'), ($Model -replace '[^A-Za-z0-9.-]', '_'), $Sessions }
$logDir = Join-Path $repo "runs\inspect-logs\$RunId"

# ---- keys: user environment -> this process only -------------------------------------------
function Get-UserVar([string] $name) { return [Environment]::GetEnvironmentVariable($name, 'User') }
foreach ($n in 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'GWDG_API_KEY') {
  if (-not (Get-Item "Env:$n" -ErrorAction SilentlyContinue)) { $v = Get-UserVar $n; if ($v) { Set-Item "Env:$n" $v } }
}
if (-not $env:GWDG_API_KEY) { $v = Get-UserVar 'LLAMA_API_KEY'; if ($v) { $env:GWDG_API_KEY = $v } }
if (-not $env:GWDG_BASE_URL) { $env:GWDG_BASE_URL = 'https://chat-ai.academiccloud.de/v1' }
$provider = ($Model -split '/')[0]
$needed = @{ anthropic = 'ANTHROPIC_API_KEY'; openai = 'OPENAI_API_KEY'; moonshot = 'MOONSHOT_API_KEY'; deepseek = 'DEEPSEEK_API_KEY'; mistral = 'MISTRAL_API_KEY' }
if ($provider -eq 'openai-api') { $needed['openai-api'] = (($Model -split '/')[1]).ToUpperInvariant().Replace('-', '_') + '_API_KEY' }
if ($needed.ContainsKey($provider) -and -not (Get-Item "Env:$($needed[$provider])" -ErrorAction SilentlyContinue)) {
  throw "No key for $Model`: store $($needed[$provider]) with .\scripts\set-llm-keys.ps1 -Target User (or set it in this window)"
}
if ($WebSearch -and -not ($env:TAVILY_API_KEY -or $env:EXA_API_KEY)) { throw 'Web search needs TAVILY_API_KEY (or EXA_API_KEY with -SearchProvider exa)' }

# ---- the eval -------------------------------------------------------------------------------
$taskArgs = @("problems=$Problems", "max_sessions=$Sessions", "session_output_tokens=$OutputTokens", "image=$Image", "web_search=$($WebSearch.IsPresent.ToString().ToLower())", "search_provider=$SearchProvider")
if ($Ids) { $taskArgs += "ids=$Ids" }
if ($SessionTimeS -gt 0) { $taskArgs += "session_time_s=$SessionTimeS" }
$task = (Join-Path $repo 'harness\proofbench_harness\task.py') + '@proofbench'
$cmd = @('eval', $task, '--model', $Model, '--epochs', $Epochs, '--max-samples', $MaxSamples, '--max-sandboxes', $MaxSamples, '--log-dir', $logDir)
if ($ReasoningEffort) { $cmd += @('--reasoning-effort', $ReasoningEffort) }
foreach ($a in $taskArgs) { $cmd += @('-T', $a) }

Write-Host "Run $RunId"
Write-Host "  $inspect $($cmd -join ' ')"
if ($DryRun) { Write-Host '(dry run: nothing executed)'; return }

docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The Docker engine is not running. Start Docker Desktop, wait for "Engine running", then run this again.' }
docker image inspect $Image --format '{{.Id}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Image $Image not found; build it with .\scripts\build-sandbox.ps1 -ProofBench $Problems" }

Push-Location $repo
try {
  & $inspect @cmd
  if ($LASTEXITCODE -ne 0) { throw "inspect eval exited $LASTEXITCODE (the log in $logDir may still be usable: inspect view --log-dir $logDir)" }
  if ($SkipImport) { return }
  $bundle = Join-Path $repo "runs\$RunId-bundle.json"
  $logs = Get-ChildItem $logDir -Filter *.eval | ForEach-Object { $_.FullName }
  & $python -m proofbench_harness.export @logs --out $bundle
  if ($LASTEXITCODE -ne 0) { throw 'export failed' }
  node (Join-Path $repo 'qedrank\cli.js') import-agent --bundle $bundle --run-id $RunId --force
  Write-Host "`nTranscripts: $inspect view --log-dir $logDir"
  Write-Host "Statistics:  runs\$RunId\summary.json  (npm run qedrank:serve, then Evaluation -> List runs -> $RunId)"
} finally { Pop-Location }
