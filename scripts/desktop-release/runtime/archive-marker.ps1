# archive-marker.ps1 r11 — exact old marker, baselineOld proof, non-overwriting same-volume rename.
# -InspectOnly is the step-0 read-only mode: it prints the real marker metadata/SHA and the
# validation verdict without moving or fabricating anything.
# Legacy: a marker written by an older apply has no "root" field. It is archived only when
# the manifest carries an explicit legacyArchive declaration for that exact file (path, SHA,
# stage, status, four post hashes). Undeclared or drifted markers fail closed.
param(
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$MarkerPath,
  [switch]$InspectOnly
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")

$ManifestData = Read-ExecManifest $ManifestPath
$AppRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$DataPrivate = "E:\tool\asset-vault\.av-apply-private"
Assert-ManifestRoots $ManifestData $AppRoot $DataPrivate
$paths = Resolve-ExecPaths $AppRoot $DataPrivate ([string]$ManifestData.stamp) ([string]$ManifestData.releaseId)
Assert-ExactPath $MarkerPath $paths.Marker "marker"
if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { throw "ARCHIVE: marker missing: $MarkerPath" }
$m = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
$legacyDecl = $null
if (@($ManifestData.PSObject.Properties.Name) -contains "legacyArchive") { $legacyDecl = $ManifestData.legacyArchive }
$hasRoot = @($m.PSObject.Properties.Name) -contains "root"
$markerSha = Get-Sha256 $MarkerPath

if ($InspectOnly) {
  # F6: read the real on-site marker and record its shape; never synthesize old data.
  $verdict = "OK"; $err = ""
  try { Assert-MarkerForArchive $m $ManifestData $AppRoot $legacyDecl $MarkerPath } catch { $verdict = "FAILED"; $err = $_.Exception.Message }
  $post = [ordered]@{}
  foreach ($prop in $m.post.PSObject.Properties) { $post[(Normalize-Rel $prop.Name)] = [string]$prop.Value }
  $declSha = if ($null -ne $legacyDecl) { [string]$legacyDecl.markerSha256 } else { "" }
  ([ordered]@{
    status = "MARKER-INSPECT-OK"
    root = [string]$m.root
    legacy = (-not $hasRoot)
    markerSha256 = $markerSha
    declaredSha256 = $declSha
    shaMatches = ($declSha -ne "" -and $declSha -eq $markerSha)
    stage = [string]$m.stage
    post = $post
    validation = $verdict
    error = $err
  }) | ConvertTo-Json -Depth 6
  if ($verdict -ne "OK") { exit 1 }
  exit 0
}

Assert-MarkerForArchive $m $ManifestData $AppRoot $legacyDecl $MarkerPath
if (-not $hasRoot) { Assert-LegacyMarkerSha $MarkerPath ([string]$legacyDecl.markerSha256) | Out-Null }

$archivePath = $paths.OldMarkerArchive
if (Test-Path -LiteralPath $archivePath) { throw "ARCHIVE: archive exists: $archivePath" }
if ((Get-VolumeSerial $MarkerPath) -ne (Get-VolumeSerial $archivePath)) { throw "ARCHIVE: archive not on same volume" }
# Non-overwriting same-volume rename: the marker bytes are preserved in the unique archive,
# and the original marker path is gone so apply's preflight can pass.
[IO.File]::Move($MarkerPath, $archivePath)
if (Test-Path -LiteralPath $MarkerPath) { throw "ARCHIVE: marker still present after move" }
if ((Get-Sha256 $archivePath) -ne $markerSha) { throw "ARCHIVE: archive bytes mismatch" }
"ARCHIVED " + $archivePath + " markerSha=" + $markerSha
exit 0
