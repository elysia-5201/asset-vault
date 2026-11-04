# scripts/desktop-release.ps1 - the single AssetVault desktop release entry (Plan by default).
#
# Plan (default): read-only checks of the manifest, the payload source and the frozen
#   runtime, then print the plan. No production access, no file writes, no child process.
# Execute: requires -Execute, an exact (case-sensitive) -ConfirmReleaseId (= manifest.releaseId),
#   and explicit -AppRoot / -DataPrivate that must equal the manifest roots exactly (no default
#   root). -LogDir must be a brand-new directory disjoint from every protected tree.
#   Fixed order stage -> close -> backup -> archive -> apply -> start (start at most once).
#   Every entry is its own top-level powershell.exe -File process with stdout / stderr /
#   exit captured separately. Any rc != 0 stops immediately: no retry, no patch, no
#   rollback, no automatic start of the old version.
#
# Frozen bytes come from candidate/exec-r11 (13 files, aggregate b07f072e...); runtime/ is
# byte-identical. This entry embeds no production drive, user directory or releaseId: all of
# that comes from explicit parameters and the manifest.
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$PayloadSource,
  [Parameter(Mandatory = $true)][string]$LogDir,
  [switch]$Execute,
  [string]$ConfirmReleaseId = "",
  [string]$AppRoot = "",
  [string]$DataPrivate = "",
  [string]$RuntimeDir = "",
  [string]$PowerShellPath = ""
)
$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) { $RuntimeDir = Join-Path $here "desktop-release\runtime" }
if ([string]::IsNullOrWhiteSpace($PowerShellPath)) { $PowerShellPath = Join-Path $PSHOME "powershell.exe" }
$stageScript = Join-Path $here "desktop-release\stage.ps1"

. (Join-Path $here "desktop-release\release-core.ps1")

try {
  # 1) Freeze gate: verify bytes first, then dot-source the runtime (unverified code never runs).
  $runtime = Assert-ReleaseRuntime $RuntimeDir
  $stageSha = Get-FileSha256 $stageScript
  if ($stageSha -ne $script:StageScriptSha256) { throw "FREEZE: stage.ps1 sha256 mismatch: $stageSha" }

  # 2) Reuse the runtime's strict manifest reader (schema / roots / payload / doNotWrite / baselineOld).
  . (Join-Path $RuntimeDir "exec-schema.ps1")
  . (Join-Path $RuntimeDir "guard.ps1")
  $manifest = Read-ExecManifest $ManifestPath

  # 3) Execute gates, in order, before any write / LogDir creation / child process / stage:
  #    exact confirmation (case-sensitive), explicit production roots, root identity.
  $rootsVerified = $false
  if ($Execute) {
    if ([string]::IsNullOrWhiteSpace($ConfirmReleaseId)) { throw "EXECUTE: -ConfirmReleaseId is required with -Execute" }
    if ($ConfirmReleaseId -cne [string]$manifest.releaseId) { throw "EXECUTE: -ConfirmReleaseId mismatch: $ConfirmReleaseId != $($manifest.releaseId)" }
    if ([string]::IsNullOrWhiteSpace($AppRoot)) { throw "EXECUTE: -AppRoot is required with -Execute (no default root)" }
    if ([string]::IsNullOrWhiteSpace($DataPrivate)) { throw "EXECUTE: -DataPrivate is required with -Execute (no default root)" }
    Assert-ManifestRoots $manifest $AppRoot $DataPrivate
    $rootsVerified = $true
  } elseif (-not [string]::IsNullOrWhiteSpace($AppRoot) -or -not [string]::IsNullOrWhiteSpace($DataPrivate)) {
    if ([string]::IsNullOrWhiteSpace($AppRoot) -or [string]::IsNullOrWhiteSpace($DataPrivate)) { throw "PLAN: -AppRoot and -DataPrivate must be given together" }
    Assert-ManifestRoots $manifest $AppRoot $DataPrivate
    $rootsVerified = $true
  }

  # 4) Plan: every payload source file must equal manifest.new in bytes and sha256.
  $plan = Get-ReleasePlan -Manifest $manifest -ManifestPath $ManifestPath -PayloadSource $PayloadSource -LogDir $LogDir -RuntimeInfo $runtime -StageScript $stageScript
  $plan.display["rootsVerified"] = $rootsVerified

  if (-not $Execute) {
    $plan.display | ConvertTo-Json -Depth 8
    exit 0
  }

  # 5) Execute preflight, still before any write or process:
  #    a) the derived paths must be exactly the explicit roots (pure path comparison);
  #    b) LogDir must be brand new and disjoint from every protected tree;
  #    c) the runtime's original reparse + one-volume gate.
  Assert-ExactPath ([string]$plan.paths.AppRoot) $AppRoot "plan AppRoot"
  Assert-ExactPath ([string]$plan.paths.AppPrivate) (Join-Path $AppRoot ".av-apply-private") "plan AppPrivate"
  Assert-ExactPath ([string]$plan.paths.DataPrivate) $DataPrivate "plan DataPrivate"
  Assert-LogDirFresh $LogDir
  Assert-LogDirIsolated -LogDir $LogDir -Plan $plan -PayloadSource $PayloadSource -RuntimeDir $RuntimeDir -ManifestPath $ManifestPath
  if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) { throw "EXECUTE: powershell missing: $PowerShellPath" }
  $pre = Test-ReleasePreflight $plan

  # 6) Only from here on does anything get written: log dir, plan copy, per-step stdout/stderr/rc.
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  Write-TextFile (Join-Path $LogDir "plan.json") (($plan.display | ConvertTo-Json -Depth 8) + "`n")
  $runner = New-ProcessRunner -PowerShellPath $PowerShellPath -LogDir $LogDir
  $result = Invoke-ReleaseSequence -Steps $plan.steps -Runner $runner

  $summary = [ordered]@{
    mode = "execute"
    ok = $result.ok
    stoppedAt = $result.stoppedAt
    rc = $result.rc
    releaseId = [string]$manifest.releaseId
    stamp = [string]$manifest.stamp
    preflight = $pre
    steps = $result.steps
  }
  $json = ($summary | ConvertTo-Json -Depth 8)
  Write-TextFile (Join-Path $LogDir "summary.json") ($json + "`n")
  $json
  if (-not $result.ok) {
    [Console]::Error.WriteLine("RELEASE: STOPPED at " + $result.stoppedAt + " rc=" + $result.rc + "; no retry, no rollback, no auto-start")
    exit $result.rc
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("RELEASE: " + $_.Exception.Message)
  exit 1
}
