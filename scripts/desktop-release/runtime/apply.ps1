# apply.ps1 r9 — production entry. Fixed ProdRoot; schema-driven paths; global preflight via io-core.
param(
  [Parameter(Mandatory=$true)][string]$Stage,
  [Parameter(Mandatory=$true)][string]$ManifestPath
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")
. (Join-Path $PSScriptRoot "io-core.ps1")

$ManifestData = Read-ExecManifest $ManifestPath
$AppRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$DataPrivate = "E:\tool\asset-vault\.av-apply-private"
Assert-ManifestRoots $ManifestData $AppRoot $DataPrivate
$paths = Resolve-ExecPaths $AppRoot $DataPrivate ([string]$ManifestData.stamp) ([string]$ManifestData.releaseId)

Assert-Stopped
$stageFull = [IO.Path]::GetFullPath($Stage).TrimEnd("\")
Assert-ExactPath $stageFull $paths.StageRoot "stage"
Assert-NoReparse $stageFull; Assert-NoReparse $paths.AppRoot; Assert-NoReparse $paths.AppPrivate

$stageFiles = @(Get-ChildItem -LiteralPath $stageFull -Recurse -File)
if ($stageFiles.Count -ne @($ManifestData.payload).Count) { throw "APPLY: stage file count mismatch" }
$wantRels = @{}
foreach ($p in $ManifestData.payload) { $wantRels[(Normalize-Rel ([string]$p.rel))] = $true }
foreach ($f in $stageFiles) {
  $rel = Normalize-Rel ($f.FullName.Substring($stageFull.Length + 1))
  if (-not $wantRels.ContainsKey($rel)) { throw "APPLY: unexpected staged file: $rel" }
}

# F5: backup -> apply hard gate. No write happens unless the close receipt is valid,
# the DB backup receipt binds that exact receipt hash, and every copied file still
# exists with the recorded bytes. A skipped backup stops here.
if (-not (Test-Path -LiteralPath $paths.Receipt -PathType Leaf)) { throw "APPLY: close receipt missing: $($paths.Receipt)" }
$closeReceipt = Get-Content -LiteralPath $paths.Receipt -Raw | ConvertFrom-Json
$prodExe = [IO.Path]::GetFullPath((Join-Path $AppRoot "..\..\AssetVault.exe"))
Assert-CloseReceipt $closeReceipt $prodExe ([string]$ManifestData.releaseId) ([string]$ManifestData.stamp) | Out-Null
$closeReceiptSha = Get-Sha256 $paths.Receipt
if (-not (Test-Path -LiteralPath $paths.BackupReceipt -PathType Leaf)) { throw "APPLY: backup receipt missing: $($paths.BackupReceipt)" }
$backupReceipt = Get-Content -LiteralPath $paths.BackupReceipt -Raw | ConvertFrom-Json
Assert-BackupReceiptShape $backupReceipt $paths $closeReceiptSha ([string]$ManifestData.releaseId) ([string]$ManifestData.stamp) | Out-Null
Assert-BackupFiles $backupReceipt

$r = Invoke-CoreApplyAll $ManifestData $stageFull $paths.AppRoot $paths.BakDir $paths.Marker
$r | ConvertTo-Json -Depth 6
exit 0
