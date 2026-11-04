# close.ps1 r9 — full identity snapshot, idle gate, one CloseMainWindow, receipt for both branches.
param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")

$ManifestData = Read-ExecManifest $ManifestPath
$AppRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$DataPrivate = "E:\tool\asset-vault\.av-apply-private"
Assert-ManifestRoots $ManifestData $AppRoot $DataPrivate
$paths = Resolve-ExecPaths $AppRoot $DataPrivate ([string]$ManifestData.stamp) ([string]$ManifestData.releaseId)
$prodExe = [IO.Path]::GetFullPath((Join-Path $AppRoot "..\..\AssetVault.exe"))

function Get-AppSnapshot {
  # F1: same fail-closed query helpers as Assert-Stopped; a query failure throws
  # instead of producing an empty snapshot that looks "already stopped".
  $procs = @(Get-ProcessSet)
  $listen = @(Get-ListenSet 7317)
  $main = @($procs | Sort-Object CreationDate | Select-Object -First 1)
  return [ordered]@{
    count = $procs.Count
    pids = @($procs | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
    mainPid = if ($main.Count -eq 1) { [int]$main[0].ProcessId } else { 0 }
    mainCreated = if ($main.Count -eq 1) { [string]$main[0].CreationDate } else { "" }
    mainExe = if ($main.Count -eq 1) { [string]$main[0].ExecutablePath } else { "" }
    mainCmd = if ($main.Count -eq 1) { [string]$main[0].CommandLine } else { "" }
    children = @($procs | Where-Object { $_.ParentProcessId -eq $main[0].ProcessId } | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
    listen = $listen.Count
    listenOwner = @($listen | ForEach-Object { [int]$_.OwningProcess })
  }
}

function Write-CloseReceipt($Receipt, [string]$Path) {
  $json = $Receipt | ConvertTo-Json -Depth 8
  $fs = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $b = [Text.Encoding]::UTF8.GetBytes($json); $fs.Write($b, 0, $b.Length); $fs.Flush($true) } finally { $fs.Dispose() }
}

$snap = Get-AppSnapshot
if ($snap.count -eq 0 -and $snap.listen -eq 0) {
  $receipt = [ordered]@{
    status = "CLOSED"
    at = (Get-Date).ToUniversalTime().ToString("o")
    releaseId = [string]$ManifestData.releaseId
    stamp = [string]$ManifestData.stamp
    alreadyStopped = $true
    mainPid = 0
    mainCreated = ""
    mainExe = ""
    mainCmd = ""
    children = @()
    listenOwner = @()
    jobs = [ordered]@{ checked = $false; reason = "already-stopped" }
    before = $snap
    after = $snap
  }
  Write-CloseReceipt $receipt $paths.Receipt
  "ALREADY-STOPPED receipt=" + $paths.Receipt
  exit 0
}

if ($snap.count -eq 0 -or $snap.listen -ne 1) { throw "CLOSE: inconsistent state procs=$($snap.count) listen=$($snap.listen)" }
if ($snap.listenOwner -notcontains $snap.mainPid) { throw "CLOSE: port 7317 not owned by main pid $($snap.mainPid)" }
Assert-ExactPath ([string]$snap.mainExe) $prodExe "main exe"
if ([string]::IsNullOrWhiteSpace([string]$snap.mainCreated)) { throw "CLOSE: mainCreated missing" }
$jobs = Get-InFlightJobs
$decision = Get-CloseDecision $snap $jobs
if ($decision -ne "CLOSE") { throw "CLOSE: unexpected decision $decision" }

$p = Get-Process -Id $snap.mainPid -ErrorAction Stop
$closed = $p.CloseMainWindow()
if (-not $closed) { throw "CLOSE: CloseMainWindow returned false for pid $($snap.mainPid)" }
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $now = Get-AppSnapshot
  if ($now.count -eq 0 -and $now.listen -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
$after = Get-AppSnapshot
if ($after.count -ne 0 -or $after.listen -ne 0) { throw "CLOSE: still running procs=$($after.count) listen=$($after.listen); no receipt" }

$receipt = [ordered]@{
  status = "CLOSED"
  at = (Get-Date).ToUniversalTime().ToString("o")
  releaseId = [string]$ManifestData.releaseId
  stamp = [string]$ManifestData.stamp
  alreadyStopped = $false
  mainPid = $snap.mainPid
  mainCreated = $snap.mainCreated
  mainExe = $snap.mainExe
  mainCmd = $snap.mainCmd
  children = $snap.children
  listenOwner = $snap.listenOwner
  jobs = $jobs
  before = $snap
  after = $after
}
Write-CloseReceipt $receipt $paths.Receipt
"CLOSED receipt=" + $paths.Receipt
exit 0
