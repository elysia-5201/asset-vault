# exec-schema.ps1 r9 — single source of truth for manifest schema + path naming.
# Every entry script dot-sources this; no script invents its own names.
$ErrorActionPreference = "Stop"

$script:ExecActions = @("replace", "replace-LAST", "add-new-exclusive", "DO-NOT-WRITE")
$script:IndexRel = "apps/web/dist/index.html"
$script:StaticRootRel = "apps/web/dist"

function New-Hex8 { -join ((1..8) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] }) }
function New-Stamp([datetime]$Utc) { $Utc.ToString("yyyyMMdd-HHmmss") }

function New-StageName([datetime]$Utc) { return ".stage-" + (New-Stamp $Utc) + "-" + (New-Hex8) }
function New-ReceiptName([datetime]$Utc) { return "close-receipt-" + (New-Stamp $Utc) + "-" + (New-Hex8) + ".json" }
function New-MarkerArchiveName([datetime]$Utc) { return "APPLY-OK.previous-" + (New-Stamp $Utc) + "-" + (New-Hex8) + ".json" }
function New-BackupReceiptName([datetime]$Utc) { return "db-backup-receipt-" + (New-Stamp $Utc) + "-" + (New-Hex8) + ".json" }
function New-DbBackupName([datetime]$Utc) { return "db-backup-" + (New-Stamp $Utc) }

# Canonical path resolution: PURE function of (roots, stamp, releaseId).
# No Get-Date / Get-Random / New-Guid inside — two calls with the same inputs return identical values.
function Resolve-ExecPaths([string]$AppRoot, [string]$DataPrivate, [string]$Stamp, [string]$ReleaseId) {
  if ($Stamp -notmatch "^[0-9]{8}-[0-9]{6}$") { throw "SCHEMA: stamp must be yyyyMMdd-HHmmss: $Stamp" }
  if ($ReleaseId -notmatch "^[0-9a-f]{8}$") { throw "SCHEMA: releaseId must be 8 hex: $ReleaseId" }
  $appPrivate = Join-Path $AppRoot ".av-apply-private"
  return [ordered]@{
    AppRoot          = $AppRoot
    AppPrivate       = $appPrivate
    DataPrivate      = $DataPrivate
    StageRoot        = (Join-Path $appPrivate (".stage-" + $Stamp + "-" + $ReleaseId))
    Receipt          = (Join-Path $DataPrivate ("close-receipt-" + $Stamp + "-" + $ReleaseId + ".json"))
    OldMarkerArchive = (Join-Path $appPrivate ("APPLY-OK.previous-" + $Stamp + "-" + $ReleaseId + ".json"))
    DbBackupDir      = (Join-Path $DataPrivate ("db-backup-" + $Stamp))
    BackupReceipt    = (Join-Path $DataPrivate ("db-backup-receipt-" + $Stamp + "-" + $ReleaseId + ".json"))
    Marker           = (Join-Path $appPrivate "APPLY-OK.json")
    BakDir           = (Join-Path $appPrivate "bak")
  }
}

function Assert-Sha64([string]$Value, [string]$Label) {
  if ($null -eq $Value) { throw "SCHEMA: $Label is null" }
  if ($Value -notmatch "^[0-9a-f]{64}$") { throw "SCHEMA: $Label not sha256 hex64: $Value" }
}

function Normalize-Rel([string]$Rel) { return ([string]$Rel).Replace("\", "/") }

# Exact path equality: full path, trailing separator trimmed, Windows case-insensitive.
# Prefix-only matches are rejected (C:\a\b is not C:\a\bc).
function Assert-ExactPath([string]$Actual, [string]$Expected, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Actual)) { throw "SCHEMA: $Label missing" }
  if ([string]::IsNullOrWhiteSpace($Expected)) { throw "SCHEMA: $Label expected missing" }
  $a = [IO.Path]::GetFullPath($Actual).TrimEnd("\")
  $e = [IO.Path]::GetFullPath($Expected).TrimEnd("\")
  if (-not [string]::Equals($a, $e, [StringComparison]::OrdinalIgnoreCase)) { throw "SCHEMA: $Label mismatch: $a != $e" }
}

# Manifest roots must be exactly the production roots the entry script uses.
function Assert-ManifestRoots($ManifestData, [string]$AppRoot, [string]$DataPrivate) {
  Assert-ExactPath ([string]$ManifestData.appRoot) $AppRoot "manifest.appRoot"
  Assert-ExactPath ([string]$ManifestData.dataPrivate) $DataPrivate "manifest.dataPrivate"
}

# Static root is apps/web/dist; the server registers it at prefix "/".
# apps/web/dist/assets/x.js -> /assets/x.js (NOT /apps/web/dist/assets/x.js).
function Get-StaticAssetUrl([string]$Rel) {
  $r = Normalize-Rel $Rel
  Assert-SafeRel $r
  $prefix = $script:StaticRootRel + "/"
  if (-not $r.StartsWith($prefix, [StringComparison]::Ordinal)) { throw "SCHEMA: rel not under static root: $r" }
  $sub = $r.Substring($prefix.Length)
  if ([string]::IsNullOrWhiteSpace($sub)) { throw "SCHEMA: empty static rel: $r" }
  return "/" + $sub
}

# /api/health returns build = build-info.json; the served server hash is build.serverSha256.
function Get-HealthServerSha($Health) {
  if ($null -eq $Health) { throw "START: health response null" }
  $build = $Health.build
  if ($null -eq $build) { throw "START: health.build missing" }
  $sha = [string]$build.serverSha256
  if ([string]::IsNullOrWhiteSpace($sha)) { throw "START: health.build.serverSha256 missing" }
  Assert-Sha64 $sha "health.build.serverSha256"
  return $sha
}

# Close branch decision: already-stopped is a valid, receipt-bearing state; running requires
# a complete jobs response with zero in-flight jobs before the single CloseMainWindow.
function Get-CloseDecision($Snap, $Jobs) {
  if ($null -eq $Snap) { throw "CLOSE: snapshot missing" }
  if ([int]$Snap.count -eq 0 -and [int]$Snap.listen -eq 0) { return "ALREADY-STOPPED" }
  if ([int]$Snap.count -eq 0 -or [int]$Snap.listen -ne 1) { throw "CLOSE: inconsistent state procs=$($Snap.count) listen=$($Snap.listen)" }
  if (@($Snap.listenOwner) -notcontains [int]$Snap.mainPid) { throw "CLOSE: port 7317 not owned by main pid $($Snap.mainPid)" }
  if ($null -eq $Jobs) { throw "CLOSE: jobs response missing" }
  if ([int]$Jobs.inFlight -ne 0) { throw "CLOSE: in-flight jobs=$($Jobs.inFlight)" }
  return "CLOSE"
}

# Marker handoff for start: status/root/stage exact, post covers every payload new hash.
function Assert-MarkerForStart($Marker, $ManifestData, $Paths) {
  if ($null -eq $Marker) { throw "START: marker null" }
  if ([string]$Marker.status -ne "APPLY-OK") { throw "START: marker status not APPLY-OK: $($Marker.status)" }
  Assert-ExactPath ([string]$Marker.root) $Paths.AppRoot "marker root"
  Assert-ExactPath ([string]$Marker.stage) $Paths.StageRoot "marker stage"
  $post = @{}
  foreach ($prop in $Marker.post.PSObject.Properties) { $post[(Normalize-Rel $prop.Name)] = [string]$prop.Value }
  foreach ($p in $ManifestData.payload) {
    $rel = Normalize-Rel ([string]$p.rel)
    if (-not $post.ContainsKey($rel)) { throw "START: marker post missing: $rel" }
    if ($post[$rel] -ne [string]$p.new) { throw "START: marker post != expected new: $rel" }
  }
}

# ---- legacy archive declaration (parent-approved, exact file only) -----------
# The on-site marker written by an older apply has no "root" field. That is a legitimate
# historical format, but it is accepted ONLY when the manifest carries an explicit
# declaration for that exact marker: canonical path, original file SHA256, exact old stage
# path/format, status and the four post hashes. Undeclared / drifted markers fail closed.
# The legacy exception is never applied to start or to any other marker.
function Get-ExpectedArchivePost($ManifestData) {
  $post = [ordered]@{}
  foreach ($p in $ManifestData.payload) {
    if ($null -ne $p.old) { $post[(Normalize-Rel ([string]$p.rel))] = [string]$p.old }
  }
  foreach ($bk in @($ManifestData.baselineOld.PSObject.Properties.Name)) {
    $post[(Normalize-Rel $bk)] = [string]$ManifestData.baselineOld.$bk
  }
  return $post
}

function Assert-LegacyArchiveDeclaration($Decl, $ManifestData, [string]$AppRoot) {
  if ($null -eq $Decl) { throw "SCHEMA: legacyArchive declaration missing" }
  $props = @($Decl.PSObject.Properties.Name)
  foreach ($k in @("markerPath", "markerSha256", "status", "stage", "post")) {
    if ($props -notcontains $k) { throw "SCHEMA: legacyArchive.$k missing" }
  }
  $appPrivate = Join-Path $AppRoot ".av-apply-private"
  Assert-ExactPath ([string]$Decl.markerPath) (Join-Path $appPrivate "APPLY-OK.json") "legacyArchive.markerPath"
  Assert-Sha64 ([string]$Decl.markerSha256) "legacyArchive.markerSha256"
  if ([string]$Decl.status -ne "APPLY-OK") { throw "SCHEMA: legacyArchive.status must be APPLY-OK: $($Decl.status)" }
  $stage = [string]$Decl.stage
  if ([string]::IsNullOrWhiteSpace($stage)) { throw "SCHEMA: legacyArchive.stage empty" }
  if ($stage -notmatch "^[A-Za-z]:\\") { throw "SCHEMA: legacyArchive.stage must be an absolute drive path: $stage" }
  $stageFull = [IO.Path]::GetFullPath($stage).TrimEnd("\")
  $appPrivateFull = [IO.Path]::GetFullPath($appPrivate).TrimEnd("\")
  if (-not $stageFull.StartsWith($appPrivateFull + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "SCHEMA: legacyArchive.stage outside app private: $stageFull" }
  $stageName = [IO.Path]::GetFileName($stageFull)
  if ($stageName -notmatch "^\.stage-[0-9]{8}-[0-9]{6}$") { throw "SCHEMA: legacyArchive.stage format: $stageName" }
  $declPost = @{}
  foreach ($prop in $Decl.post.PSObject.Properties) {
    $k = Normalize-Rel $prop.Name
    if ($declPost.ContainsKey($k)) { throw "SCHEMA: legacyArchive.post duplicate key: $k" }
    Assert-Sha64 ([string]$prop.Value) "legacyArchive.post($k)"
    $declPost[$k] = [string]$prop.Value
  }
  $expected = Get-ExpectedArchivePost $ManifestData
  if ($declPost.Count -ne $expected.Count) { throw "SCHEMA: legacyArchive.post count $($declPost.Count) != $($expected.Count)" }
  foreach ($k in $expected.Keys) {
    if (-not $declPost.ContainsKey($k)) { throw "SCHEMA: legacyArchive.post missing: $k" }
    if ($declPost[$k] -ne $expected[$k]) { throw "SCHEMA: legacyArchive.post != manifest pin: $k" }
  }
  return $Decl
}

function Assert-LegacyMarkerSha([string]$MarkerPath, [string]$ExpectedSha) {
  Assert-Sha64 $ExpectedSha "legacyArchive.markerSha256"
  $actual = Get-Sha256 $MarkerPath
  if ($actual -ne $ExpectedSha) { throw "ARCHIVE: legacy marker sha mismatch: $actual != $ExpectedSha" }
  return $actual
}

# Marker handoff for archive: root exact, baselineOld present in post with the pinned hash.
# A marker with NO root property is the legacy format and is accepted only through the
# explicit declaration above; an empty root is rejected (it is not "absent").
function Assert-MarkerForArchive($Marker, $ManifestData, [string]$AppRoot, $LegacyDecl = $null, [string]$MarkerPath = "") {
  if ($null -eq $Marker) { throw "ARCHIVE: marker null" }
  $props = @($Marker.PSObject.Properties.Name)
  $post = @{}
  foreach ($prop in $Marker.post.PSObject.Properties) {
    $k = Normalize-Rel $prop.Name
    if ($post.ContainsKey($k) -and $post[$k] -ne [string]$prop.Value) { throw "ARCHIVE: conflicting normalized post key: $k" }
    $post[$k] = [string]$prop.Value
  }
  if ($props -contains "root") {
    $root = [string]$Marker.root
    if ([string]::IsNullOrWhiteSpace($root)) { throw "ARCHIVE: marker root empty (legacy requires absent root)" }
    Assert-ExactPath $root $AppRoot "marker root"
    foreach ($bk in @($ManifestData.baselineOld.PSObject.Properties.Name)) {
      $rel = Normalize-Rel $bk
      if (-not $post.ContainsKey($rel)) { throw "ARCHIVE: baselineOld rel absent from marker post: $rel" }
      if ($post[$rel] -ne [string]$ManifestData.baselineOld.$bk) { throw "ARCHIVE: baselineOld hash mismatch: $rel" }
    }
    return
  }
  if ($null -eq $LegacyDecl) { throw "ARCHIVE: marker root missing and no legacy declaration" }
  Assert-LegacyArchiveDeclaration $LegacyDecl $ManifestData $AppRoot | Out-Null
  Assert-NoReparse $AppRoot
  if ([string]$Marker.status -ne [string]$LegacyDecl.status) { throw "ARCHIVE: legacy status mismatch: $($Marker.status)" }
  Assert-ExactPath ([string]$Marker.stage) ([string]$LegacyDecl.stage) "legacy marker stage"
  $declPost = @{}
  foreach ($prop in $LegacyDecl.post.PSObject.Properties) { $declPost[(Normalize-Rel $prop.Name)] = [string]$prop.Value }
  if ($post.Count -ne $declPost.Count) { throw "ARCHIVE: legacy post count $($post.Count) != $($declPost.Count)" }
  foreach ($k in $declPost.Keys) {
    if (-not $post.ContainsKey($k)) { throw "ARCHIVE: legacy post missing: $k" }
    if ($post[$k] -ne $declPost[$k]) { throw "ARCHIVE: legacy post mismatch: $k" }
  }
  if (-not [string]::IsNullOrWhiteSpace($MarkerPath)) {
    Assert-ExactPath $MarkerPath (Join-Path $AppRoot ".av-apply-private\APPLY-OK.json") "legacy marker path"
  }
}

# Preflight preservation check: doNotWrite and baselineOld current bytes must match the manifest
# before the first payload byte is written. HashOf receives a normalized rel and returns sha256.
function Assert-PreservedBytes($ManifestData, [scriptblock]$HashOf) {
  if ($null -eq $HashOf) { throw "CORE: hash provider missing" }
  foreach ($d in @($ManifestData.doNotWrite)) {
    $rel = Normalize-Rel ([string]$d.rel)
    $h = [string](& $HashOf $rel)
    if ($h -ne [string]$d.sha256) { throw "CORE: doNotWrite changed: $rel" }
  }
  foreach ($bk in @($ManifestData.baselineOld.PSObject.Properties.Name)) {
    $rel = Normalize-Rel $bk
    $h = [string](& $HashOf $rel)
    if ($h -ne [string]$ManifestData.baselineOld.$bk) { throw "CORE: baselineOld changed: $rel" }
  }
}

# ---- F2: strict close receipt -------------------------------------------------
# A receipt is a handoff artifact: every field the next step relies on must exist
# with the right type. Missing fields and JSON type drift (null / "false" / 0.0)
# are failures, not defaults.
function Get-RequiredProp($Obj, [string]$Name, [string]$Label) {
  if ($null -eq $Obj) { throw "SCHEMA: $Label object missing" }
  if ($Obj.PSObject.Properties.Name -notcontains $Name) { throw "SCHEMA: $Label.$Name missing" }
  return $Obj.$Name
}
function Assert-IntValue($Value, [string]$Label, [switch]$NonNegative) {
  if ($null -eq $Value) { throw "SCHEMA: $Label is null" }
  if (-not ($Value -is [int]) -and -not ($Value -is [long])) { throw "SCHEMA: $Label not an integer: $Value" }
  if ($NonNegative -and [long]$Value -lt 0) { throw "SCHEMA: $Label negative: $Value" }
  return [long]$Value
}
function Assert-CloseReceipt($Receipt, [string]$ProdExe, [string]$ExpectedReleaseId, [string]$ExpectedStamp) {
  if ($null -eq $Receipt) { throw "SCHEMA: close receipt null" }
  $status = [string](Get-RequiredProp $Receipt "status" "close receipt")
  if ($status -ne "CLOSED") { throw "SCHEMA: close receipt status not CLOSED: $status" }
  $rid = [string](Get-RequiredProp $Receipt "releaseId" "close receipt")
  if ($rid -notmatch "^[0-9a-f]{8}$") { throw "SCHEMA: close receipt.releaseId not 8 hex: $rid" }
  if ($rid -ne $ExpectedReleaseId) { throw "SCHEMA: close receipt.releaseId mismatch: $rid != $ExpectedReleaseId" }
  $st = [string](Get-RequiredProp $Receipt "stamp" "close receipt")
  if ($st -notmatch "^[0-9]{8}-[0-9]{6}$") { throw "SCHEMA: close receipt.stamp not yyyyMMdd-HHmmss: $st" }
  if ($st -ne $ExpectedStamp) { throw "SCHEMA: close receipt.stamp mismatch: $st != $ExpectedStamp" }
  $already = Get-RequiredProp $Receipt "alreadyStopped" "close receipt"
  if (-not ($already -is [bool])) { throw "SCHEMA: close receipt alreadyStopped not boolean: $already" }
  $before = Get-RequiredProp $Receipt "before" "close receipt"
  $after = Get-RequiredProp $Receipt "after" "close receipt"
  $bc = Assert-IntValue (Get-RequiredProp $before "count" "close receipt.before") "close receipt.before.count" -NonNegative
  $bl = Assert-IntValue (Get-RequiredProp $before "listen" "close receipt.before") "close receipt.before.listen" -NonNegative
  $ac = Assert-IntValue (Get-RequiredProp $after "count" "close receipt.after") "close receipt.after.count" -NonNegative
  $al = Assert-IntValue (Get-RequiredProp $after "listen" "close receipt.after") "close receipt.after.listen" -NonNegative
  if ($ac -ne 0 -or $al -ne 0) { throw "SCHEMA: close receipt after not stopped: count=$ac listen=$al" }
  if ($already) {
    if ($bc -ne 0 -or $bl -ne 0) { throw "SCHEMA: close receipt alreadyStopped before not zero: count=$bc listen=$bl" }
  } else {
    $mainPid = Assert-IntValue (Get-RequiredProp $Receipt "mainPid" "close receipt") "close receipt.mainPid" -NonNegative
    if ($mainPid -le 0) { throw "SCHEMA: close receipt mainPid not positive: $mainPid" }
    $created = [string](Get-RequiredProp $Receipt "mainCreated" "close receipt")
    if ([string]::IsNullOrWhiteSpace($created)) { throw "SCHEMA: close receipt mainCreated empty" }
    $exe = [string](Get-RequiredProp $Receipt "mainExe" "close receipt")
    Assert-ExactPath $exe $ProdExe "close receipt mainExe"
    $owners = @(Get-RequiredProp $Receipt "listenOwner" "close receipt")
    if ($owners.Count -lt 1) { throw "SCHEMA: close receipt listenOwner empty" }
    $ownerInts = @($owners | ForEach-Object { Assert-IntValue $_ "close receipt.listenOwner[]" -NonNegative })
    if ($ownerInts -notcontains $mainPid) { throw "SCHEMA: close receipt listenOwner does not contain mainPid: $mainPid" }
  }
  return $Receipt
}

# ---- F5: backup -> apply hard gate -------------------------------------------
# apply must not write unless the DB backup receipt binds the current close receipt
# and every copied file is still present with the recorded bytes.
function Assert-BackupReceiptShape($Receipt, $Paths, [string]$CloseReceiptSha, [string]$ExpectedReleaseId, [string]$ExpectedStamp) {
  if ($null -eq $Receipt) { throw "SCHEMA: backup receipt null" }
  $status = [string](Get-RequiredProp $Receipt "status" "backup receipt")
  if ($status -ne "DB-BACKUP-OK") { throw "SCHEMA: backup receipt status not DB-BACKUP-OK: $status" }
  $rid = [string](Get-RequiredProp $Receipt "releaseId" "backup receipt")
  if ($rid -notmatch "^[0-9a-f]{8}$") { throw "SCHEMA: backup receipt.releaseId not 8 hex: $rid" }
  if ($rid -ne $ExpectedReleaseId) { throw "SCHEMA: backup receipt.releaseId mismatch: $rid != $ExpectedReleaseId" }
  $st = [string](Get-RequiredProp $Receipt "stamp" "backup receipt")
  if ($st -notmatch "^[0-9]{8}-[0-9]{6}$") { throw "SCHEMA: backup receipt.stamp not yyyyMMdd-HHmmss: $st" }
  if ($st -ne $ExpectedStamp) { throw "SCHEMA: backup receipt.stamp mismatch: $st != $ExpectedStamp" }
  $cr = [string](Get-RequiredProp $Receipt "closeReceipt" "backup receipt")
  Assert-ExactPath $cr $Paths.Receipt "backup receipt closeReceipt"
  $crSha = [string](Get-RequiredProp $Receipt "closeReceiptSha256" "backup receipt")
  Assert-Sha64 $crSha "backup receipt closeReceiptSha256"
  if ($crSha -ne $CloseReceiptSha) { throw "SCHEMA: backup receipt closeReceiptSha256 mismatch" }
  $bd = [string](Get-RequiredProp $Receipt "backupDir" "backup receipt")
  Assert-ExactPath $bd $Paths.DbBackupDir "backup receipt backupDir"
  $copied = Get-RequiredProp $Receipt "copied" "backup receipt"
  $names = @($copied.PSObject.Properties.Name)
  if ($names.Count -lt 1) { throw "SCHEMA: backup receipt copied empty" }
  if ($names -notcontains "vault.db") { throw "SCHEMA: backup receipt copied missing vault.db" }
  foreach ($n in $names) {
    $c = $copied.$n
    $dst = [string](Get-RequiredProp $c "dst" "backup receipt copied.$n")
    if ([string]::IsNullOrWhiteSpace($dst)) { throw "SCHEMA: backup receipt copied.$n.dst empty" }
    Assert-IntValue (Get-RequiredProp $c "bytes" "backup receipt copied.$n") "backup receipt copied.$n.bytes" -NonNegative | Out-Null
    Assert-Sha64 ([string](Get-RequiredProp $c "sha256" "backup receipt copied.$n")) "backup receipt copied.$n.sha256"
  }
  return $Receipt
}
function Assert-BackupFiles($Receipt) {
  $copied = Get-RequiredProp $Receipt "copied" "backup receipt"
  foreach ($n in @($copied.PSObject.Properties.Name)) {
    $c = $copied.$n
    $dst = [string](Get-RequiredProp $c "dst" "backup receipt copied.$n")
    $bytes = Assert-IntValue (Get-RequiredProp $c "bytes" "backup receipt copied.$n") "backup receipt copied.$n.bytes" -NonNegative
    $sha = [string](Get-RequiredProp $c "sha256" "backup receipt copied.$n")
    if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) { throw "SCHEMA: backup file missing: $dst" }
    if ((Get-Item -LiteralPath $dst).Length -ne $bytes) { throw "SCHEMA: backup file size mismatch: $dst" }
    if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) { throw "SCHEMA: backup file sha mismatch: $dst" }
  }
}

# ---- F3: DB sidecar set ------------------------------------------------------
# Only vault.db plus the two SQLite WAL sidecars may exist. A -journal or any
# unknown vault.db* entry means the on-disk set is not the one we can copy
# consistently; stop without deleting anything.
function Assert-DbSidecarSet([string[]]$Names) {
  $allowed = @("vault.db", "vault.db-wal", "vault.db-shm")
  $seen = @{}
  foreach ($n in @($Names)) {
    if ([string]::IsNullOrWhiteSpace($n)) { throw "BACKUP: empty db sidecar name" }
    if ($allowed -notcontains $n) { throw "BACKUP: unexpected db sidecar: $n" }
    if ($seen.ContainsKey($n)) { throw "BACKUP: duplicate db sidecar: $n" }
    $seen[$n] = $true
  }
  if (-not $seen.ContainsKey("vault.db")) { throw "BACKUP: vault.db missing from sidecar set" }
}

