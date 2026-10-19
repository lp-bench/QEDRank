<#
.SYNOPSIS
  Build the ProofBench sandbox/grader image from a local ProofBench checkout (Windows, Docker Desktop).

.DESCRIPTION
  Wraps `docker build` for harness/sandbox/Dockerfile: checks that the Docker engine is running,
  reads the checkout's commit, tags the image with its short id, and prints the image id to keep
  with the run record. The proctor material of the checkout never enters the image (it is removed
  in a build stage of its own, see the Dockerfile).

.EXAMPLE
  .\scripts\build-sandbox.ps1 -ProofBench C:\ProofBench
  .\scripts\build-sandbox.ps1 -ProofBench C:\ProofBench -Ref bd5dd8eca7d22c8101d77a1d9869d8287fb0eb2a
#>
param(
  [Parameter(Mandatory = $true)] [string] $ProofBench,
  [string] $Ref = '',
  [string] $Tag = '',
  [switch] $NoCache
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$ProofBench = (Resolve-Path $ProofBench).Path
if (-not (Test-Path (Join-Path $ProofBench 'lean-toolchain'))) { throw "$ProofBench is not a Lean project (no lean-toolchain); clone ProofBench first: gh repo clone vaibhav-baj/ProofBench C:\ProofBench" }

docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The Docker engine is not running. Start Docker Desktop, wait for "Engine running", then run this again.' }

if ($Ref) {
  git -C $ProofBench checkout --quiet $Ref
  if ($LASTEXITCODE -ne 0) { throw "git checkout $Ref failed in $ProofBench" }
}
$commit = (git -C $ProofBench rev-parse HEAD).Trim()
$dirty = (git -C $ProofBench status --porcelain --untracked-files=no)
if ($dirty) { throw "$ProofBench has uncommitted changes; an image must be built from a committed version" }
if (-not $Tag) { $Tag = "proofbench-sandbox:$($commit.Substring(0, 7))" }

Write-Host "Building $Tag from $ProofBench at $commit (first build: 30-60 min for the Mathlib cache, several GB)"
$args = @('build', '-f', (Join-Path $repo 'harness\sandbox\Dockerfile'), '--build-context', "proofbench=$ProofBench", '--build-arg', "PROOFBENCH_COMMIT=$commit", '-t', $Tag)
if ($NoCache) { $args += '--no-cache' }
$args += $repo
& docker @args
if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }
$id = docker image inspect --format '{{.Id}}' $Tag
Write-Host "`nBuilt $Tag"
Write-Host "image id: $id   (recorded by the harness when Docker is reachable; keep it with the run)"
Write-Host "next:     .\scripts\agent-run.ps1 -Model moonshot/kimi-k3 -Problems $ProofBench -Ids P050 -Sessions 1 -Image $Tag"
