# start.ps1 r9 — verify marker + post + preserved + stopped, then exactly one normal start.
param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")

$ManifestData = Read-ExecManifest $ManifestPath
$AppRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$DataPrivate = "E:\tool\asset-vault\.av-apply-private"
Assert-ManifestRoots $ManifestData $AppRoot $DataPrivate
$paths = Resolve-ExecPaths $AppRoot $DataPrivate ([string]$ManifestData.stamp) ([string]$ManifestData.releaseId)

if (-not (Test-Path -LiteralPath $paths.Marker -PathType Leaf)) { throw "START: marker missing" }
$m = Get-Content -LiteralPath $paths.Marker -Raw | ConvertFrom-Json
Assert-MarkerForStart $m $ManifestData $paths

$hashOf = {
  param($rel)
  $p = Join-Path $AppRoot ($rel.Replace("/", "\"))
  Assert-Under $p $AppRoot "preserved"
  Assert-NoReparse $p
  Get-Sha256 $p
}.GetNewClosure()
Assert-PreservedBytes $ManifestData $hashOf

Assert-Stopped

$exe = Join-Path $AppRoot "..\..\AssetVault.exe"
$exe = [IO.Path]::GetFullPath($exe)
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "START: exe missing: $exe" }
$proc = Start-Process -FilePath $exe -PassThru
$startedPid = $proc.Id

try {
  $deadline = (Get-Date).AddSeconds(60)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:7317/api/health" -TimeoutSec 5; if ($h.ok) { $ok = $true; break } } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $ok) { throw "START: health not ok within 60s" }
  $servedSha = Get-HealthServerSha $h
  # F1: full-set listen query then filter; a query failure throws, never reads as "no listener".
  $listen = @(Get-ListenSet 7317)
  if ($listen.Count -ne 1) { throw "START: listen count $($listen.Count)" }
  $owner = [int]$listen[0].OwningProcess
  # F4: the server runs inside the Electron main process (apps/desktop/main.mjs startServer),
  # so the port owner must be exactly the pid Start-Process returned. No parent/child exception.
  if ($owner -ne $startedPid) { throw "START: port owner $owner != startedPid $startedPid" }
  $live = @(Get-ProcessById $owner)
  if ($live.Count -ne 1) { throw "START: port owner process missing: $owner" }
  if ([string]$live[0].ExecutablePath -ne $exe) { throw "START: port owner exe mismatch" }
  $serverRel = "apps/desktop/build/server.mjs"
  $serverHits = @($ManifestData.payload | Where-Object { (Normalize-Rel ([string]$_.rel)) -eq $serverRel })
  if ($serverHits.Count -ne 1) { throw "START: server payload must appear exactly once, got $($serverHits.Count)" }
  if ($servedSha -ne [string]$serverHits[0].new) { throw "START: served serverSha mismatch" }

  $idx = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:7317/" -Headers @{ "Accept-Encoding" = "identity" } -TimeoutSec 30
  if ($idx.StatusCode -ne 200) { throw "START: index status $($idx.StatusCode)" }
  $idxHash = (Get-FileHash -InputStream ([IO.MemoryStream]::new($idx.RawContentStream.ToArray())) -Algorithm SHA256).Hash.ToLowerInvariant()
  $idxPin = (Get-PayloadByRel $ManifestData $script:IndexRel).new
  if ($idxHash -ne $idxPin) { throw "START: served index hash mismatch" }

  $jsHits = @($ManifestData.payload | Where-Object { [string]$_.action -eq "add-new-exclusive" })
  if ($jsHits.Count -ne 1) { throw "START: add-new-exclusive payload must appear exactly once, got $($jsHits.Count)" }
  $jsRel = Normalize-Rel ([string]$jsHits[0].rel)
  $jsName = [IO.Path]::GetFileName($jsRel)
  if ([string]::IsNullOrWhiteSpace($jsName)) { throw "START: new JS filename empty" }
  if ($idx.Content -notmatch [regex]::Escape($jsName)) { throw "START: served index does not reference new JS $jsName" }
  foreach ($bk in @($ManifestData.baselineOld.PSObject.Properties.Name)) {
    $oldName = [IO.Path]::GetFileName((Normalize-Rel $bk))
    if (-not [string]::IsNullOrWhiteSpace($oldName) -and $idx.Content -match [regex]::Escape($oldName)) { throw "START: served index still references old JS $oldName" }
  }

  $jsUrl = "http://127.0.0.1:7317" + (Get-StaticAssetUrl $jsRel)
  $js = Invoke-WebRequest -UseBasicParsing -Uri $jsUrl -Headers @{ "Accept-Encoding" = "identity" } -TimeoutSec 30
  if ($js.StatusCode -ne 200) { throw "START: js status $($js.StatusCode)" }
  $jsHash = (Get-FileHash -InputStream ([IO.MemoryStream]::new($js.RawContentStream.ToArray())) -Algorithm SHA256).Hash.ToLowerInvariant()
  $jsPin = (Get-PayloadByRel $ManifestData $jsRel).new
  if ($jsHash -ne $jsPin) { throw "START: served js hash mismatch" }

  "STARTED pid=$startedPid owner=$owner serverSha=$servedSha"
  exit 0
} catch {
  "START FAILED startedPid=$startedPid :: " + $_.Exception.Message
  "do not restart, do not force kill; inspect pid $startedPid manually"
  exit 1
}
