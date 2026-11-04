# guard.ps1 r9 — strict manifest reader (fail-closed) + jobs gate without fake pagination.
$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "GUARD: file missing: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-NoReparse([string]$Path) {
  $cur = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $cur) {
      $it = Get-Item -LiteralPath $cur -Force
      if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "GUARD: reparse in chain: $cur" }
    }
    $parent = Split-Path -Parent $cur
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cur) { break }
    $cur = $parent
  }
}

function Assert-Under([string]$Path, [string]$Root, [string]$Label) {
  $p = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  $r = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not $p.StartsWith($r + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "GUARD: $Label outside boundary: $p" }
}

function Assert-SafeRel([string]$Rel) {
  if ([string]::IsNullOrWhiteSpace($Rel)) { throw "GUARD: empty rel" }
  if ($Rel -match "^[/\\]") { throw "GUARD: absolute rel: $Rel" }
  if ($Rel -match ":") { throw "GUARD: colon in rel: $Rel" }
  # Windows exec package: backslash is a path separator too, so dotdot must be caught in both forms.
  if ($Rel -match "(^|[/\\])\.\.([/\\]|$)") { throw "GUARD: dotdot in rel: $Rel" }
  if ($Rel -match "\\\\") { throw "GUARD: UNC in rel: $Rel" }
}

# F1: a failed query must never look like "no process / no listener".
# Get-NetTCPConnection -LocalPort with no match raises CmdletizationQuery_NotFound itself,
# so the filtered form cannot distinguish "none" from "failed". Query the full listen set
# with -ErrorAction Stop, then filter in PowerShell. A full-set query that reports
# "no objects found" is a successful empty result, not an access/command failure.
function Get-ProcessSet {
  try { return @(Get-CimInstance Win32_Process -Filter "Name='AssetVault.exe'" -ErrorAction Stop) }
  catch { throw "GUARD: process query failed: $($_.Exception.Message)" }
}
function Get-ProcessById([int]$ProcessId) {
  try { return @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction Stop) }
  catch { throw "GUARD: process query failed: $($_.Exception.Message)" }
}
function Get-ListenSet([int]$Port = 7317) {
  try { $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) }
  catch {
    if ([string]$_.FullyQualifiedErrorId -like "CmdletizationQuery_NotFound*") { return @() }
    throw "GUARD: listen query failed: $($_.Exception.Message)"
  }
  return @($all | Where-Object { [int]$_.LocalPort -eq $Port })
}
function Assert-Stopped {
  $procs = @(Get-ProcessSet)
  $listen = @(Get-ListenSet 7317)
  if ($procs.Count -ne 0 -or $listen.Count -ne 0) { throw "GUARD: not stopped: procs=$($procs.Count) listen=$($listen.Count)" }
}

function Get-VolumeSerial([string]$Path) {
  $letter = [IO.Path]::GetPathRoot($Path).Substring(0,1)
  return (Get-Volume -DriveLetter $letter).UniqueId
}

# Real route has no offset (routes.ts:950-951 reads only state/limit; repo.listJobs has no offset).
# Strategy: one request at max limit; a full page means completeness is unprovable -> STOP.
$script:TerminalStates = @("done", "failed", "cancelled", "abandoned")
function Get-InFlightJobs([int]$MaxLimit = 1000) {
  $j = Invoke-RestMethod -Uri ("http://127.0.0.1:7317/api/jobs?limit=" + $MaxLimit) -TimeoutSec 10
  $all = @($j.jobs)
  if ($all.Count -ge $MaxLimit) { throw "GUARD: jobs page full at limit=$MaxLimit; completeness unprovable (route has no offset)" }
  $inFlight = @($all | Where-Object { $script:TerminalStates -notcontains [string]$_.state })
  return [ordered]@{ total = $all.Count; inFlight = $inFlight.Count; states = @($inFlight | ForEach-Object { [string]$_.state } | Sort-Object -Unique) }
}

# Pure shape validation: Read-ExecManifest reads JSON then calls this. Keeping it separate lets
# offline behavior tests exercise the real guard rules without writing a manifest file.
function Assert-ManifestShape($m) {
  if ($null -eq $m) { throw "GUARD: manifest null" }
  $mp = $m.PSObject.Properties.Name
  if ($mp -notcontains "schema") { throw "GUARD: manifest.schema missing" }
  if ([string]$m.schema -ne "av-exec-manifest/v1") { throw "GUARD: manifest.schema unsupported: $($m.schema)" }
  if ($mp -notcontains "appRoot") { throw "GUARD: manifest.appRoot missing" }
  if ($mp -notcontains "dataPrivate") { throw "GUARD: manifest.dataPrivate missing" }
  foreach ($rootName in @("appRoot", "dataPrivate")) {
    $v = [string]$m.$rootName
    if ([string]::IsNullOrWhiteSpace($v)) { throw "GUARD: manifest.$rootName empty" }
    if ($v -notmatch "^[A-Za-z]:\\") { throw "GUARD: manifest.$rootName must be an absolute drive path: $v" }
  }
  if ($mp -notcontains "releaseId") { throw "GUARD: manifest.releaseId missing" }
  if ([string]$m.releaseId -notmatch "^[0-9a-f]{8}$") { throw "GUARD: releaseId must be 8 hex" }
  if ($mp -notcontains "stamp") { throw "GUARD: manifest.stamp missing" }
  if ([string]$m.stamp -notmatch "^[0-9]{8}-[0-9]{6}$") { throw "GUARD: stamp must be yyyyMMdd-HHmmss" }
  $payload = @($m.payload)
  if ($payload.Count -lt 1) { throw "GUARD: payload empty" }
  $seen = @{}
  $indexCount = 0; $newJsCount = 0
  foreach ($p in $payload) {
    $props = $p.PSObject.Properties.Name
    if ($props -notcontains "rel") { throw "GUARD: payload.rel missing" }
    if ($props -notcontains "old") { throw "GUARD: payload.old missing (must be literal null for new files): $($p.rel)" }
    if ($props -notcontains "new") { throw "GUARD: payload.new missing: $($p.rel)" }
    if ($props -notcontains "bytes") { throw "GUARD: payload.bytes missing: $($p.rel)" }
    if ($props -notcontains "action") { throw "GUARD: payload.action missing: $($p.rel)" }
    Assert-SafeRel ([string]$p.rel)
    $k = Normalize-Rel ([string]$p.rel)
    if ($seen.ContainsKey($k)) { throw "GUARD: duplicate rel: $k" }
    $seen[$k] = $true
    Assert-Sha64 ([string]$p.new) "payload.new($k)"
    if ($null -ne $p.old) { Assert-Sha64 ([string]$p.old) "payload.old($k)" }
    if (-not ($p.bytes -is [int]) -and -not ($p.bytes -is [long])) { throw "GUARD: payload.bytes not integer: $k" }
    if ($p.bytes -lt 0) { throw "GUARD: payload.bytes negative: $k" }
    if ($script:ExecActions -notcontains [string]$p.action) { throw "GUARD: action not whitelisted: $($p.action) ($k)" }
    if ($k -eq $script:IndexRel) {
      $indexCount++
      if ([string]$p.action -ne "replace-LAST") { throw "GUARD: index action must be replace-LAST" }
      if ($null -eq $p.old) { throw "GUARD: index old must be a pin" }
    } else {
      if ([string]$p.action -eq "replace-LAST") { throw "GUARD: replace-LAST only allowed on index: $k" }
    }
    if ([string]$p.action -eq "add-new-exclusive") {
      $newJsCount++
      if ($null -ne $p.old) { throw "GUARD: add-new-exclusive old must be literal null: $k" }
    } else {
      if ($null -eq $p.old) { throw "GUARD: old null requires add-new-exclusive: $k" }
    }
  }
  if ($indexCount -ne 1) { throw "GUARD: index.html must appear exactly once" }
  if ($newJsCount -ne 1) { throw "GUARD: exactly one add-new-exclusive expected, got $newJsCount" }
  $dnw = @($m.doNotWrite)
  if ($dnw.Count -lt 1) { throw "GUARD: doNotWrite empty" }
  foreach ($d in $dnw) {
    $dp = $d.PSObject.Properties.Name
    if ($dp -notcontains "rel") { throw "GUARD: doNotWrite.rel missing" }
    if ($dp -notcontains "sha256") { throw "GUARD: doNotWrite.sha256 missing: $($d.rel)" }
    Assert-SafeRel ([string]$d.rel)
    Assert-Sha64 ([string]$d.sha256) "doNotWrite.sha256($($d.rel))"
  }
  if ($mp -notcontains "baselineOld") { throw "GUARD: manifest.baselineOld missing" }
  $baseKeys = @($m.baselineOld.PSObject.Properties.Name)
  if ($baseKeys.Count -lt 1) { throw "GUARD: baselineOld empty" }
  foreach ($bk in $baseKeys) {
    Assert-SafeRel ([string]$bk)
    Assert-Sha64 ([string]$m.baselineOld.$bk) "baselineOld($bk)"
  }
  # Legacy archive declaration (optional): when present it must be complete and well formed.
  # The cross-check against the payload/baselineOld pins happens in exec-schema's
  # Assert-LegacyArchiveDeclaration; this is the schema-level shape gate.
  if ($mp -contains "legacyArchive") {
    $la = $m.legacyArchive
    if ($null -eq $la) { throw "GUARD: manifest.legacyArchive null" }
    $lp = @($la.PSObject.Properties.Name)
    foreach ($k in @("markerPath", "markerSha256", "status", "stage", "post")) {
      if ($lp -notcontains $k) { throw "GUARD: manifest.legacyArchive.$k missing" }
    }
    $lmp = [string]$la.markerPath
    if ($lmp -notmatch "^[A-Za-z]:\\") { throw "GUARD: manifest.legacyArchive.markerPath must be an absolute drive path: $lmp" }
    Assert-Sha64 ([string]$la.markerSha256) "legacyArchive.markerSha256"
    if ([string]$la.status -ne "APPLY-OK") { throw "GUARD: manifest.legacyArchive.status must be APPLY-OK" }
    $lst = [string]$la.stage
    if ($lst -notmatch "^[A-Za-z]:\\") { throw "GUARD: manifest.legacyArchive.stage must be an absolute drive path: $lst" }
    $lpost = @($la.post.PSObject.Properties)
    if ($lpost.Count -lt 1) { throw "GUARD: manifest.legacyArchive.post empty" }
    foreach ($pp in $lpost) { Assert-Sha64 ([string]$pp.Value) "legacyArchive.post($($pp.Name))" }
  }
  return $m
}

function Read-ExecManifest([string]$ManifestPath) {
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) { throw "GUARD: ManifestPath must be explicit" }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "GUARD: manifest missing: $ManifestPath" }
  $m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  return Assert-ManifestShape $m
}

function Get-PayloadByRel($ManifestData, [string]$Rel) {
  $want = Normalize-Rel $Rel
  foreach ($p in $ManifestData.payload) { if ((Normalize-Rel ([string]$p.rel)) -eq $want) { return $p } }
  return $null
}
