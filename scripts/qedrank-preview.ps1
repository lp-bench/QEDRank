<#
.SYNOPSIS
  Preview a (private) GitHub paper corpus with the QEDRank discovery API, entering the
  GitHub token as masked input.

.DESCRIPTION
  The token is read with Read-Host -AsSecureString (nothing is echoed), sent once over HTTPS
  in the request body to the QEDRank preview endpoint, and cleared from memory afterwards.
  It is never written to disk, to the console, or to the PowerShell history.

  With -Local the same discovery runs on this machine through the Node CLI instead of the
  deployed endpoint; the token is then passed through the GITHUB_TOKEN environment variable
  of the child process only.

.EXAMPLE
  .\scripts\qedrank-preview.ps1 -RepoUrl https://github.com/vaibhav-baj/ProofBench/tree/vb/Folders/ProofBench/PROBLEMS

.EXAMPLE
  .\scripts\qedrank-preview.ps1 -RepoUrl https://github.com/owner/repo -Ref main -Subdir papers -OutFile manifest.json

.EXAMPLE
  .\scripts\qedrank-preview.ps1 -RepoUrl https://github.com/owner/repo/tree/main -UseGhCli
  # takes the token from an existing `gh auth login` session instead of prompting

.EXAMPLE
  .\scripts\qedrank-preview.ps1 -RepoUrl https://github.com/owner/repo/tree/main -Local
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $RepoUrl,
  [string] $Ref = '',
  [string] $Subdir = '',
  [int] $ExpectedCount = 108,
  [string] $Endpoint = 'https://qedrank.vercel.app/api/qedrank/discover',
  [string] $OutFile = 'manifest.json',
  [switch] $NoToken,
  [switch] $UseGhCli,
  [switch] $Local
)

$ErrorActionPreference = 'Stop'

function Get-PlainToken {
  if ($NoToken) { return $null }
  if ($UseGhCli) {
    $t = (& gh auth token) 2>$null
    if (-not $t) { throw 'gh auth token returned nothing; run "gh auth login" first or omit -UseGhCli.' }
    return $t.Trim()
  }
  $secure = Read-Host -AsSecureString 'GitHub token (input hidden; press Enter to skip for a public repository)'
  if ($secure.Length -eq 0) { return $null }
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  $secure.Dispose()
  return $plain.Trim()
}

function Format-Masked([string] $token) {
  if (-not $token) { return '(none)' }
  $prefix = if ($token.Length -ge 4) { $token.Substring(0, 4) } else { '' }
  return "$prefix****************"
}

$token = Get-PlainToken
try {
  Write-Host "Repository : $RepoUrl"
  Write-Host "Token      : $(Format-Masked $token)"

  if ($Local) {
    $cliArgs = @('qedrank/cli.js', 'discover', '--repo', $RepoUrl, '--out', $OutFile)
    if ($Ref) { $cliArgs += @('--ref', $Ref) }
    if ($Subdir) { $cliArgs += @('--subdir', $Subdir) }
    $previous = $env:GITHUB_TOKEN
    try {
      if ($token) { $env:GITHUB_TOKEN = $token }
      & node @cliArgs
      if ($LASTEXITCODE -ne 0) { throw "qedrank discover exited with code $LASTEXITCODE" }
    } finally {
      if ($null -eq $previous) { Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue } else { $env:GITHUB_TOKEN = $previous }
    }
    $manifest = Get-Content -Raw -Encoding UTF8 $OutFile | ConvertFrom-Json
  } else {
    $payload = @{ repoUrl = $RepoUrl; expectedCount = $ExpectedCount }
    if ($Ref) { $payload.ref = $Ref }
    if ($Subdir) { $payload.subdir = $Subdir }
    if ($token) { $payload.token = $token }
    $body = $payload | ConvertTo-Json -Compress
    try {
      $response = Invoke-WebRequest -Method Post -Uri $Endpoint -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -UseBasicParsing -TimeoutSec 120
    } catch {
      $detail = $null
      if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $detail = $reader.ReadToEnd()
      }
      if ($detail) {
        $err = $detail | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($err) { throw "Preview failed [$($err.code)]: $($err.error)" }
        throw "Preview failed: $detail"
      }
      throw
    } finally {
      $body = $null
      $payload = $null
    }
    # Save the raw JSON (ConvertTo-Json in Windows PowerShell 5.1 truncates deep objects).
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutFile), $response.Content, (New-Object System.Text.UTF8Encoding($false)))
    $manifest = $response.Content | ConvertFrom-Json
  }

  $c = $manifest.counts
  $s = $manifest.source
  Write-Host ''
  Write-Host "Resolved   : $($s.resolved_ref) ($($s.ref_type)) @ $($s.commit)"
  Write-Host "Folder     : $(if ($s.subdir) { $s.subdir } else { '(whole repository)' })"
  Write-Host "Private    : $($s.private)"
  Write-Host "Papers     : $($c.papers) discovered, expected $($c.expected_count), matches: $($c.expected_count_matches)"
  Write-Host "With PDF   : $($c.papers_with_pdf)    Index matches: $($c.papers_with_index_entry)"
  Write-Host "Targets    : main $($c.targets.main_theorem), upper $($c.targets.upper_bound), lower $($c.targets.lower_bound), disproof $($c.targets.disproof)"
  Write-Host "All three  : $($c.papers_with_all_three_bounds)    Flagged for review: $($c.papers_flagged)"
  Write-Host "Inspected  : $($c.lean_files_inspected) of $($c.lean_files) Lean files in $([math]::Round($c.discovery_ms / 1000, 1)) s"
  Write-Host ''
  Write-Host 'Flags by code:'
  $c.flags_by_code.PSObject.Properties | Sort-Object Value -Descending | ForEach-Object { Write-Host ("  {0,-34} {1}" -f $_.Name, $_.Value) }
  Write-Host ''
  Write-Host "Manifest saved to $OutFile"
  if ($manifest.next_step) { Write-Host "Next step  : $($manifest.next_step)" }
} finally {
  $token = $null
  [System.GC]::Collect()
}
