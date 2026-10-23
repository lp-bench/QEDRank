<#
.SYNOPSIS
  Enter the API keys for the QEDRank model roster with masked input, and store them in the
  Vercel project, in your Windows user environment, or in the current PowerShell session.

.DESCRIPTION
  Each key is read with Read-Host -AsSecureString: nothing is echoed, and the script prints
  only a masked form (first four characters). Press Enter to skip a model.

  PASTING INTO A MASKED PROMPT: in Windows PowerShell 5.1 (conhost / the VS Code terminal)
  Ctrl+V is NOT paste inside a SecureString prompt - it inserts a literal control character
  and the "key" would be one invisible byte. Paste with a RIGHT-CLICK or Shift+Insert, or use
  -FromClipboard: copy the key, press Enter at the prompt, and the script reads the clipboard
  directly (then overwrites the clipboard). Input is validated: control characters or fewer
  than 8 characters are rejected and you are asked again.

  The ten roster slots (same order as the web app):
    fable           Claude Fable 5.1         ANTHROPIC_API_KEY   (shared with opus)
    opus            Claude Opus 5.5          ANTHROPIC_API_KEY
    qwen            Qwen3 30B-A3B Instruct   GWDG_API_KEY        (GWDG Chat AI / AcademicCloud; one key for the four GWDG slots)
    qwen35          Qwen3.5 397B-A17B        GWDG_API_KEY
    gpt6_astra      GPT-6 Astra              OPENAI_API_KEY      (shared by the four GPT slots)
    gpt6_sol        GPT-6 Sol                OPENAI_API_KEY
    gpt56_terra     GPT-5.6 Terra            OPENAI_API_KEY
    gpt54           GPT-5.4                  OPENAI_API_KEY
    glm             GLM-5.3 Flash            GWDG_API_KEY
    deepseek_flash  DeepSeek V4 Flash        GWDG_API_KEY        (an existing LLAMA_API_KEY still works for the GWDG slots)
  Former roster slots (until 2026-10-23), offered with -Optional: kimi (MOONSHOT_API_KEY),
  mistral (MISTRAL_API_KEY), llama (GWDG_API_KEY), deepseek (DEEPSEEK_API_KEY, DeepSeek's own API).

  A vendor key is asked for once and reused by every slot that shares it.

    -Target Vercel   pipes each value to `vercel env add <NAME> production --sensitive --force`
                     (and preview with -IncludePreview); redeploy afterwards for the web app to
                     pick them up (-Redeploy does that).
    -Target User     stores each value as a Windows user environment variable (new terminals see
                     it; the local CLI and runner read it).
    -Target Session  sets the values only in the current PowerShell session; dot-source the script:
                     . .\scripts\set-llm-keys.ps1 -Target Session

    -FromClipboard   read each key from the clipboard instead of a masked prompt (see above).
    -FromUserEnv     no prompts: copy the keys (and per-slot overrides) that are already stored in
                     your Windows user environment to the target. Typical use: you entered keys
                     with -Target User and now want the deployed web app to have them too:
                     .\scripts\set-llm-keys.ps1 -Target Vercel -FromUserEnv -Redeploy
                     The web app on Vercel NEVER sees keys stored with -Target User or Session.
    -Advanced        per-slot setup for gateways such as Azure AI Foundry where every deployment
                     has its own endpoint and key: stores the key as QEDRANK_API_KEY_<ID> and asks
                     for QEDRANK_BASEURL_<ID>, QEDRANK_MODEL_<ID> and QEDRANK_AUTH_HEADER_<ID>
                     (Enter keeps the default shown).
    -Optional        also offer the optional provider slots (the former roster slots kimi, mistral,
                     llama, deepseek, and openrouter, groq, siliconflow, together, gemini,
                     huggingface, nvidia, custom).

  Keys are never written to a file by this script.

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target User -Only gpt54,qwen

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target User -Only gpt54,qwen -FromClipboard

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target Vercel -Redeploy

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target User -Only qwen
  # the one GWDG Chat AI key, used by qwen, qwen35, glm and deepseek_flash

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target User -Only glm -Advanced
  # e.g. QEDRANK_BASEURL_GLM=https://<resource>.services.ai.azure.com/models, QEDRANK_AUTH_HEADER_GLM=api-key

.EXAMPLE
  . .\scripts\set-llm-keys.ps1 -Target Session
#>
[CmdletBinding()]
param(
  [ValidateSet('Vercel', 'User', 'Session')] [string] $Target = 'Session',
  [string[]] $Only = @(),
  [switch] $IncludePreview,
  [switch] $Redeploy,
  [switch] $FromClipboard,
  [switch] $FromUserEnv,
  [switch] $Advanced,
  [switch] $Optional
)

$ErrorActionPreference = 'Stop'

# Slot order matches the default roster in lib/providers.js.
$roster = @(
  @{ Id = 'fable';          Name = 'ANTHROPIC_API_KEY'; Label = 'Claude Fable 5.1';       Vendor = 'Anthropic';                 Model = 'claude-fable-5-1';            BaseUrl = 'https://api.anthropic.com/v1';        Portal = 'https://console.anthropic.com/settings/keys' },
  @{ Id = 'opus';           Name = 'ANTHROPIC_API_KEY'; Label = 'Claude Opus 5.5';        Vendor = 'Anthropic';                 Model = 'claude-opus-5-5';             BaseUrl = 'https://api.anthropic.com/v1';        Portal = 'https://console.anthropic.com/settings/keys' },
  @{ Id = 'qwen';           Name = 'GWDG_API_KEY';      Label = 'Qwen3 30B-A3B Instruct'; Vendor = 'Alibaba via GWDG Chat AI';  Model = 'qwen3-30b-a3b-instruct-2507'; BaseUrl = 'https://chat-ai.academiccloud.de/v1'; Portal = 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html' },
  @{ Id = 'qwen35';         Name = 'GWDG_API_KEY';      Label = 'Qwen3.5 397B-A17B';      Vendor = 'Alibaba via GWDG Chat AI';  Model = 'qwen3.5-397b-a17b';           BaseUrl = 'https://chat-ai.academiccloud.de/v1'; Portal = 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html' },
  @{ Id = 'gpt6_astra';     Name = 'OPENAI_API_KEY';    Label = 'GPT-6 Astra';            Vendor = 'OpenAI';                    Model = 'gpt-6-astra';                 BaseUrl = 'https://api.openai.com/v1';           Portal = 'https://platform.openai.com/api-keys' },
  @{ Id = 'gpt6_sol';       Name = 'OPENAI_API_KEY';    Label = 'GPT-6 Sol';              Vendor = 'OpenAI';                    Model = 'gpt-6-sol';                   BaseUrl = 'https://api.openai.com/v1';           Portal = 'https://platform.openai.com/api-keys' },
  @{ Id = 'gpt56_terra';    Name = 'OPENAI_API_KEY';    Label = 'GPT-5.6 Terra';          Vendor = 'OpenAI';                    Model = 'gpt-5.6-terra';               BaseUrl = 'https://api.openai.com/v1';           Portal = 'https://platform.openai.com/api-keys' },
  @{ Id = 'gpt54';          Name = 'OPENAI_API_KEY';    Label = 'GPT-5.4';                Vendor = 'OpenAI';                    Model = 'gpt-5.4';                     BaseUrl = 'https://api.openai.com/v1';           Portal = 'https://platform.openai.com/api-keys' },
  @{ Id = 'glm';            Name = 'GWDG_API_KEY';      Label = 'GLM-5.3 Flash';          Vendor = 'Z.ai via GWDG Chat AI';     Model = 'glm-5.3-flash';               BaseUrl = 'https://chat-ai.academiccloud.de/v1'; Portal = 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html' },
  @{ Id = 'deepseek_flash'; Name = 'GWDG_API_KEY';      Label = 'DeepSeek V4 Flash';      Vendor = 'DeepSeek via GWDG Chat AI'; Model = 'deepseek-v4-flash-0731';      BaseUrl = 'https://chat-ai.academiccloud.de/v1'; Portal = 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html' }
)
$optionalSlots = @(
  # former roster slots (until 2026-10-23)
  @{ Id = 'kimi';        Name = 'MOONSHOT_API_KEY';    Label = 'Kimi K3';                   Vendor = 'Moonshot AI';  Model = 'kimi-k3';                                BaseUrl = 'https://api.moonshot.ai/v1';                   Portal = 'https://platform.moonshot.ai/console/api-keys' },
  @{ Id = 'mistral';     Name = 'MISTRAL_API_KEY';     Label = 'Leanstral';                 Vendor = 'Mistral AI';   Model = 'labs-leanstral-2603';                    BaseUrl = 'https://api.mistral.ai/v1';                    Portal = 'https://console.mistral.ai/api-keys' },
  @{ Id = 'llama';       Name = 'GWDG_API_KEY';        Label = 'Llama 3.1 8B Instruct';     Vendor = 'Meta via GWDG Chat AI'; Model = 'meta-llama-3.1-8b-instruct';    BaseUrl = 'https://chat-ai.academiccloud.de/v1';          Portal = 'https://docs.hpc.gwdg.de/services/ai-services/saia/index.html' },
  @{ Id = 'deepseek';    Name = 'DEEPSEEK_API_KEY';    Label = 'DeepSeek V4 Pro';           Vendor = 'DeepSeek';     Model = 'deepseek-v4-pro';                        BaseUrl = 'https://api.deepseek.com';                     Portal = 'https://platform.deepseek.com/api_keys' },
  @{ Id = 'openrouter';  Name = 'OPENROUTER_API_KEY';  Label = 'OpenRouter';                Vendor = 'OpenRouter';   Model = 'nvidia/nemotron-3-ultra-550b-a55b:free'; BaseUrl = 'https://openrouter.ai/api/v1';                 Portal = 'https://openrouter.ai/keys' },
  @{ Id = 'groq';        Name = 'GROQ_API_KEY';        Label = 'Groq Cloud';                Vendor = 'Groq';         Model = 'openai/gpt-oss-120b';                    BaseUrl = 'https://api.groq.com/openai/v1';               Portal = 'https://console.groq.com/keys' },
  @{ Id = 'siliconflow'; Name = 'SILICONFLOW_API_KEY'; Label = 'SiliconFlow';               Vendor = 'SiliconFlow';  Model = 'deepseek-ai/DeepSeek-R1';                BaseUrl = 'https://api.siliconflow.cn/v1';                Portal = 'https://cloud.siliconflow.cn/account/ak' },
  @{ Id = 'together';    Name = 'TOGETHER_API_KEY';    Label = 'Together AI';               Vendor = 'Together AI';  Model = 'Qwen/Qwen3.8-Flash';                     BaseUrl = 'https://api.together.xyz/v1';                  Portal = 'https://api.together.ai/settings/api-keys' },
  @{ Id = 'gemini';      Name = 'GEMINI_API_KEY';      Label = 'Google AI Studio';          Vendor = 'Google';       Model = 'gemini-3.8-flash';                       BaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'; Portal = 'https://aistudio.google.com/apikey' },
  @{ Id = 'huggingface'; Name = 'HF_TOKEN';            Label = 'Hugging Face';              Vendor = 'Hugging Face'; Model = 'Qwen/Qwen2.5-Coder-32B-Instruct';        BaseUrl = 'https://router.huggingface.co/v1';             Portal = 'https://huggingface.co/settings/tokens' },
  @{ Id = 'nvidia';      Name = 'NVIDIA_API_KEY';      Label = 'NVIDIA NIM';                Vendor = 'NVIDIA';       Model = 'deepseek-ai/deepseek-v4.1-flash';        BaseUrl = 'https://integrate.api.nvidia.com/v1';          Portal = 'https://build.nvidia.com' },
  @{ Id = 'custom';      Name = 'QEDRANK_CUSTOM_API_KEY'; Label = 'Custom OpenAI-compatible slot'; Vendor = 'custom'; Model = '(QEDRANK_CUSTOM_MODEL)';               BaseUrl = '(QEDRANK_CUSTOM_BASE_URL)';                    Portal = '(your provider)' }
)

function Get-EnvId([string] $id) { return ($id.ToUpperInvariant() -replace '[^A-Z0-9]', '_') }

# $null when the value looks like a key; otherwise the reason it was rejected.
function Test-KeyValue([string] $value) {
  if (-not $value) { return 'empty' }
  $ctrl = @($value.ToCharArray() | Where-Object { [int]$_ -lt 32 }).Count
  if ($ctrl -gt 0) { return "$ctrl control character(s) - Ctrl+V was typed literally instead of pasting. Paste with a RIGHT-CLICK or Shift+Insert, or rerun with -FromClipboard" }
  if ($value.Length -lt 8) { return "only $($value.Length) character(s) long" }
  return $null
}

# Masked prompt (or clipboard) with validation; $null means skipped.
function Read-Key([string] $prompt) {
  for ($try = 1; $try -le 3; $try++) {
    $plain = $null
    if ($FromClipboard) {
      $answer = Read-Host "$prompt  [copy the key, then press Enter; s = skip]"
      if ($answer -match '^[sS]$') { return $null }
      $plain = Get-Clipboard -Raw -ErrorAction SilentlyContinue
      if ($null -eq $plain) { $plain = '' }
      $plain = $plain.Trim()
      Set-Clipboard -Value 'QEDRank: key consumed'   # do not leave the key on the clipboard
    } else {
      $secure = Read-Host -AsSecureString $prompt
      if ($secure.Length -eq 0) { return $null }
      $plain = [System.Net.NetworkCredential]::new('', $secure).Password
      $secure.Dispose()
      $plain = $plain.Trim()
    }
    $why = Test-KeyValue $plain
    if (-not $why) { return $plain }
    $plain = $null
    Write-Host "  NOT saved: the input is $why. Try again, or press Enter to skip." -ForegroundColor Yellow
  }
  return $null
}

function Format-Masked([string] $value) {
  if (-not $value) { return '(none)' }
  $n = [Math]::Min(4, $value.Length)
  return $value.Substring(0, $n) + '****************'
}

# Runs `vercel env add` through cmd.exe with the value written to its stdin exactly (no trailing
# newline; never on the command line or in a file). Using System.Diagnostics.Process keeps
# Windows PowerShell 5.1 from turning the CLI's stderr banner into a terminating
# NativeCommandError, which is what a redirected `& vercel ... *> $null` does under
# $ErrorActionPreference = 'Stop'.
function Invoke-VercelEnvAdd([string] $name, [string] $environment, [string] $value) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /c vercel env add $name $environment --sensitive --force"
  $psi.WorkingDirectory = (Get-Location).Path
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEndAsync()
  $stderr = $proc.StandardError.ReadToEndAsync()
  $proc.StandardInput.Write($value)
  $proc.StandardInput.Close()
  $proc.WaitForExit()
  $lines = @(($stderr.Result + "`n" + $stdout.Result) -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^Vercel CLI' })
  $detail = ($lines | Select-Object -Last 3) -join ' | '
  if ($value -and $detail) { $detail = $detail.Replace($value, '[redacted]') }
  return @{ ExitCode = $proc.ExitCode; Detail = $detail }
}

function Set-Value([string] $name, [string] $value) {
  switch ($Target) {
    'Vercel' {
      $targets = @('production')
      if ($IncludePreview) { $targets += 'preview' }
      foreach ($t in $targets) {
        $r = Invoke-VercelEnvAdd $name $t $value
        if ($r.ExitCode -ne 0) { throw "vercel env add $name $t failed (exit $($r.ExitCode)): $($r.Detail)  -- if the project is not linked, run 'vercel link' in this folder first." }
      }
    }
    'User' { [Environment]::SetEnvironmentVariable($name, $value, 'User'); Set-Item -Path "Env:$name" -Value $value }
    'Session' { Set-Item -Path "Env:$name" -Value $value }
  }
}

# Accept both -Only a,b,c (array) and -Only "a,b,c" (one string, e.g. from powershell -File).
$Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$slots = @($roster)
if ($Optional) { $slots += $optionalSlots }
$selected = if ($Only.Count) { $slots | Where-Object { $Only -contains $_.Id } } else { $slots }
if (-not $selected) { throw "No slot matches -Only $($Only -join ','). Ids: $(($slots | ForEach-Object { $_.Id }) -join ', ')" }

$saved = @()
$entered = @{}   # vendor variable -> masked value, so a shared key is asked for once

if ($FromUserEnv) {
  # Copy what is already stored in the Windows user environment (keys and per-slot overrides)
  # to the target. No prompt, no paste; only masked prefixes are printed.
  if ($Target -eq 'User') { throw '-FromUserEnv copies values FROM your user environment; use it with -Target Vercel (or Session).' }
  Write-Host "Target: $Target. Copying values that already exist in your Windows user environment (no prompts)."
  Write-Host ''
  $done = @{}
  foreach ($p in $selected) {
    $envId = Get-EnvId $p.Id
    $names = @($p.Name, "QEDRANK_API_KEY_$envId", "QEDRANK_BASEURL_$envId", "QEDRANK_MODEL_$envId", "QEDRANK_AUTH_HEADER_$envId", "QEDRANK_EFFORT_$envId")
    if ($p.Id -eq 'custom') { $names = @('QEDRANK_CUSTOM_API_KEY', 'QEDRANK_CUSTOM_BASE_URL', 'QEDRANK_CUSTOM_MODEL', 'QEDRANK_CUSTOM_AUTH_HEADER') }
    foreach ($name in $names) {
      if ($done.ContainsKey($name)) { continue }
      $done[$name] = $true
      $v = [Environment]::GetEnvironmentVariable($name, 'User')
      if (-not $v) {
        if ($name -eq $p.Name) { Write-Host "[$($p.Id)] $name is not set in your user environment - skipped" }
        continue
      }
      $isKey = $name -match '(API_KEY|TOKEN)'
      if ($isKey) {
        $why = Test-KeyValue $v
        if ($why) { Write-Host "[$($p.Id)] $name NOT copied: the stored value is $why" -ForegroundColor Yellow; continue }
      }
      Set-Value $name $v.Trim()
      if ($isKey) { Write-Host "[$($p.Id)] copied $name = $(Format-Masked $v) ($($v.Length) characters)" } else { Write-Host "[$($p.Id)] copied $name = $v" }
      $saved += $name
    }
    $v = $null
  }
  $selected = @()   # nothing left for the interactive loop
} else {
  $mode = if ($FromClipboard) { 'clipboard' } else { 'masked prompt: paste with RIGHT-CLICK or Shift+Insert (Ctrl+V does not paste here)' }
  Write-Host "Target: $Target$(if ($Advanced) { ' (advanced: per-slot endpoint, model and key)' }). Input: $mode. Press Enter to skip a model."
  Write-Host ''
}
foreach ($p in $selected) {
  $envId = Get-EnvId $p.Id
  Write-Host ("[{0}] {1}  ({2} - {3})" -f $p.Id, $p.Label, $p.Vendor, $p.Model)
  Write-Host ("      key from {0}" -f $p.Portal)

  if ($p.Id -eq 'custom') {
    $value = Read-Key "  $($p.Name)"
    if (-not $value) { Write-Host '  skipped'; continue }
    try { Set-Value $p.Name $value; Write-Host "  saved $($p.Name) = $(Format-Masked $value)"; $saved += $p.Name } finally { $value = $null }
    $base = Read-Host '  QEDRANK_CUSTOM_BASE_URL (e.g. https://<resource>.services.ai.azure.com/models)'
    $model = Read-Host '  QEDRANK_CUSTOM_MODEL (e.g. DeepSeek-R1)'
    $auth = Read-Host '  QEDRANK_CUSTOM_AUTH_HEADER (Enter for "Authorization: Bearer"; "api-key" for Azure)'
    foreach ($pair in @(@('QEDRANK_CUSTOM_BASE_URL', $base), @('QEDRANK_CUSTOM_MODEL', $model), @('QEDRANK_CUSTOM_AUTH_HEADER', $auth))) {
      if ($pair[1]) { Set-Value $pair[0] $pair[1].Trim(); $saved += $pair[0] }
    }
    continue
  }

  if (-not $Advanced -and $entered.ContainsKey($p.Name)) {
    Write-Host "  uses $($p.Name) entered above ($($entered[$p.Name]))"
    continue
  }

  $varName = if ($Advanced) { "QEDRANK_API_KEY_$envId" } else { $p.Name }
  $value = Read-Key "  $varName"
  if (-not $value) { Write-Host '  skipped'; continue }
  try {
    Set-Value $varName $value
    $masked = Format-Masked $value
    Write-Host "  saved $varName = $masked ($($value.Length) characters)"
    $saved += $varName
    if (-not $Advanced) { $entered[$p.Name] = $masked }
  } finally {
    $value = $null
  }

  if ($Advanced) {
    $base = Read-Host "  QEDRANK_BASEURL_$envId (Enter keeps $($p.BaseUrl))"
    $model = Read-Host "  QEDRANK_MODEL_$envId (Enter keeps $($p.Model))"
    $auth = Read-Host "  QEDRANK_AUTH_HEADER_$envId (Enter for 'Authorization: Bearer'; 'api-key' for Azure AI Foundry)"
    foreach ($pair in @(@("QEDRANK_BASEURL_$envId", $base), @("QEDRANK_MODEL_$envId", $model), @("QEDRANK_AUTH_HEADER_$envId", $auth))) {
      if ($pair[1]) { Set-Value $pair[0] $pair[1].Trim(); $saved += $pair[0] }
    }
  }
}
[System.GC]::Collect()

Write-Host ''
Write-Host "Saved $($saved.Count) value(s): $($saved -join ', ')"
if ($Target -eq 'Vercel' -and $saved.Count) {
  if ($Redeploy) {
    Write-Host 'Redeploying to production so the functions see the new keys...'
    # cmd merges stderr into stdout, so PowerShell 5.1 never sees a native stderr stream.
    & $env:ComSpec /d /c 'vercel deploy --prod --yes --archive=tgz 2>&1'
    if ($LASTEXITCODE -ne 0) { throw "vercel deploy failed (exit $LASTEXITCODE)." }
  } else {
    Write-Host 'Redeploy for the web app to use them:  vercel deploy --prod --yes --archive=tgz'
  }
}
if ($Target -eq 'User') { Write-Host 'Open a new terminal (or VS Code window) for other programs to see the user variables.' }
Write-Host 'Check them with:  node qedrank/cli.js models     and     node qedrank/cli.js ping'
