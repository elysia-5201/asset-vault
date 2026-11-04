# backup-db.ps1 r9 — explicit manifest binding, DB + actually-present sidecars, CreateNew, len+sha, stable set, own receipt.
param(
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$ReceiptPath
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")

$ManifestData = Read-ExecManifest $ManifestPath
$AppRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$DataPrivate = "E:\tool\asset-vault\.av-apply-private"
Assert-ManifestRoots $ManifestData $AppRoot $DataPrivate
$paths = Resolve-ExecPaths $AppRoot $DataPrivate ([string]$ManifestData.stamp) ([string]$ManifestData.releaseId)
Assert-ExactPath $ReceiptPath $paths.Receipt "receipt"

if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { throw "BACKUP: close receipt missing: $ReceiptPath" }
$rc = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
# F2: strict schema. Missing after / null / string "false" / negative counts are failures,
# not defaults; [bool] on the string "false" is True, so the type is asserted explicitly.
$prodExe = [IO.Path]::GetFullPath((Join-Path $AppRoot "..\..\AssetVault.exe"))
Assert-CloseReceipt $rc $prodExe ([string]$ManifestData.releaseId) ([string]$ManifestData.stamp) | Out-Null
$closeReceiptSha = Get-Sha256 $ReceiptPath
Assert-Stopped

# The DB dir is the sibling "data" of the private root; deriving it keeps a single root
# source (DataPrivate) so the shadow harness only replaces the two manifest roots.
$dbDir = [IO.Path]::GetFullPath((Join-Path $DataPrivate "..\data"))
$dbPath = Join-Path $dbDir "vault.db"
if ([IO.Path]::GetFileName($dbPath) -ne "vault.db") { throw "BACKUP: db filename must be vault.db" }
if (-not (Test-Path -LiteralPath $dbPath -PathType Leaf)) { throw "BACKUP: db missing: $dbPath" }
Assert-NoReparse $dbPath
Assert-NoReparse $dbDir
if ((Get-VolumeSerial $dbDir) -ne (Get-VolumeSerial $DataPrivate)) { throw "BACKUP: db and backup dir not on same volume" }

# F3: the on-disk vault.db* set must be exactly db/wal/shm. A -journal or any unknown
# entry means the set cannot be copied consistently; stop without deleting anything.
$dbNames = @(Get-ChildItem -LiteralPath $dbDir -Filter "vault.db*" -Force | ForEach-Object { $_.Name })
Assert-DbSidecarSet $dbNames

$sidecarNames = @("vault.db-wal", "vault.db-shm")
function Get-SourceSet {
  $set = [ordered]@{}
  $set["vault.db"] = $dbPath
  foreach ($n in $sidecarNames) {
    $p = Join-Path $dbDir $n
    if (Test-Path -LiteralPath $p -PathType Leaf) { $set[$n] = $p }
  }
  return $set
}
function Get-Fingerprint($set) {
  $fp = [ordered]@{}
  foreach ($k in $set.Keys) {
    $f = Get-Item -LiteralPath $set[$k]
    $fp[$k] = [ordered]@{ path = $set[$k]; bytes = [long]$f.Length; sha256 = (Get-Sha256 $set[$k]) }
  }
  return $fp
}

$srcSet = Get-SourceSet
$before = Get-Fingerprint $srcSet
$sidecarState = if ($srcSet.Keys.Count -gt 1) { @($srcSet.Keys | Where-Object { $_ -ne "vault.db" }) } else { @() }
$sidecarLabel = if ($sidecarState.Count -eq 0) { "sidecar:none" } else { "sidecar:" + ($sidecarState -join ",") }

if (-not (Test-Path -LiteralPath $paths.DbBackupDir)) { New-Item -ItemType Directory -Path $paths.DbBackupDir -Force | Out-Null }
Assert-NoReparse $paths.DbBackupDir

$copied = [ordered]@{}
foreach ($k in $srcSet.Keys) {
  $src = $srcSet[$k]
  $dst = Join-Path $paths.DbBackupDir $k
  $fs = [IO.File]::Open($dst, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [IO.File]::ReadAllBytes($src); $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  $dstLen = (Get-Item -LiteralPath $dst).Length
  $dstSha = Get-Sha256 $dst
  if ($dstLen -ne $before[$k].bytes) { throw "BACKUP: length mismatch $k $($before[$k].bytes) -> $dstLen" }
  if ($dstSha -ne $before[$k].sha256) { throw "BACKUP: sha mismatch $k" }
  $copied[$k] = [ordered]@{ src = $src; dst = $dst; bytes = $dstLen; sha256 = $dstSha }
}

$afterSet = Get-SourceSet
$after = Get-Fingerprint $afterSet
if ($afterSet.Keys.Count -ne $srcSet.Keys.Count) { throw "BACKUP: sidecar set changed during copy" }
foreach ($k in $srcSet.Keys) {
  if (-not $after.Contains($k)) { throw "BACKUP: source vanished: $k" }
  if ($after[$k].bytes -ne $before[$k].bytes) { throw "BACKUP: source size changed: $k" }
  if ($after[$k].sha256 -ne $before[$k].sha256) { throw "BACKUP: source sha changed: $k" }
}

$receipt = [ordered]@{
  status = "DB-BACKUP-OK"
  at = (Get-Date).ToUniversalTime().ToString("o")
  releaseId = [string]$ManifestData.releaseId
  stamp = [string]$ManifestData.stamp
  closeReceipt = $ReceiptPath
  closeReceiptSha256 = $closeReceiptSha
  sidecar = $sidecarLabel
  sources = @($srcSet.Keys)
  before = $before
  after = $after
  copied = $copied
  backupDir = $paths.DbBackupDir
}
$json = $receipt | ConvertTo-Json -Depth 8
$fs = [IO.File]::Open($paths.BackupReceipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $b = [Text.Encoding]::UTF8.GetBytes($json); $fs.Write($b, 0, $b.Length); $fs.Flush($true) } finally { $fs.Dispose() }
"DB-BACKUP-OK " + $sidecarLabel + " files=" + $srcSet.Keys.Count + " receipt=" + $paths.BackupReceipt
exit 0
