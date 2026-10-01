<#
.SYNOPSIS
  Enter the API keys for the ten QEDRank model slots with masked input, and store them in the
  Vercel project, in your Windows user environment, or in the current PowerShell session.

.DESCRIPTION
  Each key is read with Read-Host -AsSecureString: nothing is echoed, and the script prints
  only a masked form (first four characters). Press Enter to skip a provider.

    -Target Vercel   pipes each key to `vercel env add <NAME> production --sensitive --force`
                     (and preview with -IncludePreview); redeploy afterwards for the web app to
                     pick them up (-Redeploy does that).
    -Target User     stores each key as a Windows user environment variable (new terminals see it;
                     the local CLI and runner read it).
    -Target Session  sets the keys only in the current PowerShell session; dot-source the script:
                     . .\scripts\set-llm-keys.ps1 -Target Session

  Keys are never written to a file by this script.

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target Vercel -Redeploy

.EXAMPLE
  .\scripts\set-llm-keys.ps1 -Target User -Only groq,gemini,openrouter

.EXAMPLE
  . .\scripts\set-llm-keys.ps1 -Target Session
#>
[CmdletBinding()]
param(
  [ValidateSet('Vercel', 'User', 'Session')] [string] $Target = 'Session',
  [string[]] $Only = @(),
  [switch] $IncludePreview,
  [switch] $Redeploy,
  [switch] $SkipCustom
)

$ErrorActionPreference = 'Stop'

# Slot order matches the default roster in lib/providers.js.
$providers = @(
  @{ Id = 'mistral';     Name = 'MISTRAL_API_KEY';     Label = 'Mistral AI (Leanstral)';           Portal = 'https://console.mistral.ai' },
  @{ Id = 'deepseek';    Name = 'DEEPSEEK_API_KEY';    Label = 'DeepSeek';                         Portal = 'https://platform.deepseek.com' },
  @{ Id = 'openrouter';  Name = 'OPENROUTER_API_KEY';  Label = 'OpenRouter';                       Portal = 'https://openrouter.ai/keys' },
  @{ Id = 'groq';        Name = 'GROQ_API_KEY';        Label = 'Groq Cloud';                       Portal = 'https://console.groq.com/keys' },
  @{ Id = 'siliconflow'; Name = 'SILICONFLOW_API_KEY'; Label = 'SiliconFlow';                      Portal = 'https://cloud.siliconflow.cn/account/ak' },
  @{ Id = 'custom';      Name = 'QEDRANK_CUSTOM_API_KEY'; Label = 'Custom OpenAI-compatible slot'; Portal = '(your provider)' },
  @{ Id = 'together';    Name = 'TOGETHER_API_KEY';    Label = 'Together AI';                      Portal = 'https://api.together.ai/settings/api-keys' },
  @{ Id = 'gemini';      Name = 'GEMINI_API_KEY';      Label = 'Google AI Studio';                 Portal = 'https://aistudio.google.com/apikey' },
  @{ Id = 'huggingface'; Name = 'HF_TOKEN';            Label = 'Hugging Face';                     Portal = 'https://huggingface.co/settings/tokens' },
  @{ Id = 'nvidia';      Name = 'NVIDIA_API_KEY';      Label = 'NVIDIA NIM';                       Portal = 'https://build.nvidia.com' }
)

function Read-Masked([string] $prompt) {
  $secure = Read-Host -AsSecureString $prompt
  if ($secure.Length -eq 0) { return $null }
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  $secure.Dispose()
  return $plain.Trim()
}

function Format-Masked([string] $value) {
  if (-not $value) { return '(none)' }
  $n = [Math]::Min(4, $value.Length)
  return $value.Substring(0, $n) + '****************'
}

function Set-Value([string] $name, [string] $value) {
  switch ($Target) {
    'Vercel' {
      $targets = @('production')
      if ($IncludePreview) { $targets += 'preview' }
      foreach ($t in $targets) {
        # The value goes through stdin, never through the command line or a file.
        $value | & vercel env add $name $t --sensitive --force *> $null
        if ($LASTEXITCODE -ne 0) { throw "vercel env add $name $t failed (exit $LASTEXITCODE). Run 'vercel link' in this folder first." }
      }
    }
    'User' { [Environment]::SetEnvironmentVariable($name, $value, 'User'); Set-Item -Path "Env:$name" -Value $value }
    'Session' { Set-Item -Path "Env:$name" -Value $value }
  }
}

$selected = if ($Only.Count) { $providers | Where-Object { $Only -contains $_.Id } } else { $providers }
if ($SkipCustom) { $selected = $selected | Where-Object { $_.Id -ne 'custom' } }

Write-Host "Target: $Target. Press Enter to skip a provider; input is hidden."
Write-Host ''
$saved = @()
foreach ($p in $selected) {
  Write-Host ("[{0}] {1}  (key from {2})" -f $p.Id, $p.Label, $p.Portal)
  $value = Read-Masked "  $($p.Name)"
  if (-not $value) { Write-Host '  skipped'; continue }
  try {
    Set-Value $p.Name $value
    Write-Host "  saved $($p.Name) = $(Format-Masked $value)"
    $saved += $p.Name
  } finally {
    $value = $null
  }

  if ($p.Id -eq 'custom') {
    $base = Read-Host '  QEDRANK_CUSTOM_BASE_URL (e.g. https://<resource>.services.ai.azure.com/models)'
    $model = Read-Host '  QEDRANK_CUSTOM_MODEL (e.g. DeepSeek-R1)'
    $auth = Read-Host '  QEDRANK_CUSTOM_AUTH_HEADER (Enter for "Authorization: Bearer"; "api-key" for Azure)'
    foreach ($pair in @(@('QEDRANK_CUSTOM_BASE_URL', $base), @('QEDRANK_CUSTOM_MODEL', $model), @('QEDRANK_CUSTOM_AUTH_HEADER', $auth))) {
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
    & vercel deploy --prod --yes --archive=tgz
  } else {
    Write-Host 'Redeploy for the web app to use them:  vercel deploy --prod --yes --archive=tgz'
  }
}
if ($Target -eq 'User') { Write-Host 'Open a new terminal (or VS Code window) for other programs to see the user variables.' }
Write-Host 'Check them with:  node qedrank/cli.js ping'
