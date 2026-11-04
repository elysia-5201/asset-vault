# fixture.ps1 r9 — TEMP-only. Same io-core as production. Every NEG proves zero change.
# r9: each case reloads the manifest (no shared mutation), exact error anchors, new guard/preflight NEGs.
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$ManifestPath
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "exec-schema.ps1")
. (Join-Path $PSScriptRoot "guard.ps1")
. (Join-Path $PSScriptRoot "io-core.ps1")

$ProdRoot = "E:\tool\asset-vault\dist-desktop\win-unpacked\resources\app"
$temp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\")
$full = [IO.Path]::GetFullPath($Root).TrimEnd("\")
if ($full -eq $ProdRoot) { throw "FIXTURE: production root rejected" }
if (-not $full.StartsWith($temp + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "FIXTURE: root outside TEMP" }
if ([IO.Path]::GetFileName($full) -notmatch "^av-polish-fixture-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$") { throw "FIXTURE: root name pattern" }
Assert-NoReparse $full
if (Test-Path -LiteralPath $full) { throw "FIXTURE: root exists (exclusive)" }
New-Item -ItemType Directory -Path $full | Out-Null

$results = New-Object System.Collections.ArrayList
function Case([string]$Name, [scriptblock]$Body) {
  try { & $Body; [void]$results.Add("PASS " + $Name) }
  catch { [void]$results.Add("FAIL " + $Name + " :: " + $_.Exception.Message) }
}
function New-CaseManifest { return Read-ExecManifest $ManifestPath }
function New-Tree([string]$Tag, $m) {
  $base = Join-Path $full $Tag
  $stage = Join-Path $base "stage"; $target = Join-Path $base "target"; $bak = Join-Path $base "bak"
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  foreach ($p in $m.payload) {
    $rel = (Normalize-Rel ([string]$p.rel)).Replace("/", "\")
    $sd = Join-Path $stage $rel; $td = Join-Path $target $rel
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($sd)) -Force | Out-Null
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($td)) -Force | Out-Null
    [IO.File]::WriteAllText($sd, "NEW:" + $rel)
    if ($null -ne $p.old) { [IO.File]::WriteAllText($td, "OLD:" + $rel) }
  }
  foreach ($d in $m.doNotWrite) {
    $rel = (Normalize-Rel ([string]$d.rel)).Replace("/", "\")
    $td = Join-Path $target $rel
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($td)) -Force | Out-Null
    [IO.File]::WriteAllText($td, "KEEP:" + $rel)
  }
  foreach ($bk in @($m.baselineOld.PSObject.Properties.Name)) {
    $rel = (Normalize-Rel $bk).Replace("/", "\")
    $td = Join-Path $target $rel
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($td)) -Force | Out-Null
    [IO.File]::WriteAllText($td, "OLDJS:" + $rel)
  }
  return [ordered]@{ base = $base; stage = $stage; target = $target; bak = $bak; marker = (Join-Path $base "APPLY-OK.json") }
}
function Set-Pins($Tree, $m) {
  foreach ($p in $m.payload) {
    $rel = (Normalize-Rel ([string]$p.rel)).Replace("/", "\")
    $p.new = Get-Sha256 (Join-Path $Tree.stage $rel)
    if ($null -ne $p.old) { $p.old = Get-Sha256 (Join-Path $Tree.target $rel) }
  }
  foreach ($d in $m.doNotWrite) {
    $rel = (Normalize-Rel ([string]$d.rel)).Replace("/", "\")
    $d.sha256 = Get-Sha256 (Join-Path $Tree.target $rel)
  }
  foreach ($bk in @($m.baselineOld.PSObject.Properties.Name)) {
    $rel = (Normalize-Rel $bk).Replace("/", "\")
    $m.baselineOld.$bk = Get-Sha256 (Join-Path $Tree.target $rel)
  }
}
function Get-Snapshot([string]$Dir) {
  $h = @{}
  if (-not (Test-Path -LiteralPath $Dir)) { return $h }
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Recurse -File)) {
    $rel = Normalize-Rel ($f.FullName.Substring($Dir.Length + 1))
    $h[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $h
}
function Assert-Same([hashtable]$A, [hashtable]$B, [string]$Label) {
  if ($A.Count -ne $B.Count) { throw "$Label entry count changed: $($A.Count) -> $($B.Count)" }
  foreach ($k in $A.Keys) {
    if (-not $B.ContainsKey($k)) { throw "$Label entry removed: $k" }
    if ($A[$k] -ne $B[$k]) { throw "$Label bytes changed: $k" }
  }
}

# ---- POS ----
Case "POS content: 4 post hashes / 3 backups == old / marker post / order / index last / doNotWrite+baselineOld intact" {
  $m = New-CaseManifest
  $t = New-Tree "pos" $m
  Set-Pins $t $m
  $dnwBefore = Get-Snapshot (Join-Path $t.target "apps")
  $baseBefore = @{}
  foreach ($bk in @($m.baselineOld.PSObject.Properties.Name)) {
    $rel = Normalize-Rel $bk
    $baseBefore[$rel] = Get-Sha256 (Join-Path $t.target ($rel.Replace("/", "\")))
  }
  $r = Invoke-CoreApplyAll $m $t.stage $t.target $t.bak $t.marker
  if (@($r.writes).Count -ne 4) { throw "writes != 4" }
  $last = [string]$r.writes[$r.writes.Count - 1].rel
  if ($last -ne $script:IndexRel) { throw ("index not last, got " + $last) }
  foreach ($p in $m.payload) {
    $rel = Normalize-Rel ([string]$p.rel)
    $d = Join-Path $t.target ($rel.Replace("/", "\"))
    if ((Get-Sha256 $d) -ne $p.new) { throw "target bytes != new: $rel" }
  }
  $baks = @(Get-ChildItem -LiteralPath $t.bak -File)
  if ($baks.Count -ne 3) { throw ("backups != 3, got " + $baks.Count) }
  foreach ($p in $m.payload) {
    if ($null -eq $p.old) { continue }
    $name = [IO.Path]::GetFileName((Normalize-Rel ([string]$p.rel)))
    $hit = @($baks | Where-Object { $_.Name -like ("bak-" + $name + ".*") })
    if ($hit.Count -ne 1) { throw "backup missing for $name" }
    if ((Get-Sha256 $hit[0].FullName) -ne $p.old) { throw "backup bytes != old: $name" }
  }
  $mk = Get-Content -LiteralPath $t.marker -Raw | ConvertFrom-Json
  foreach ($p in $m.payload) {
    $rel = Normalize-Rel ([string]$p.rel)
    if ([string]$mk.post.$rel -ne $p.new) { throw "marker post != new: $rel" }
  }
  # M28: the real marker produced by Invoke-CoreApplyAll must satisfy start's handoff check.
  $startPaths = [ordered]@{ AppRoot = $t.target; StageRoot = $t.stage }
  Assert-MarkerForStart $mk $m $startPaths
  $dnwAfter = Get-Snapshot (Join-Path $t.target "apps")
  foreach ($d in $m.doNotWrite) {
    $rel = Normalize-Rel ([string]$d.rel)
    if ($dnwAfter[$rel] -ne $dnwBefore[$rel]) { throw "doNotWrite changed: $rel" }
  }
  foreach ($bk in @($m.baselineOld.PSObject.Properties.Name)) {
    $rel = Normalize-Rel $bk
    if ((Get-Sha256 (Join-Path $t.target ($rel.Replace("/", "\")))) -ne $baseBefore[$rel]) { throw "baselineOld changed: $rel" }
  }
}

# ---- NEG: every case proves zero change ----
function NegCase([string]$Name, [scriptblock]$Mutate, [string]$Expect) {
  Case $Name {
    $m = New-CaseManifest
    $t = New-Tree ("neg-" + ($Name -replace "[^a-z0-9]", "").Substring(0, [Math]::Min(12, ($Name -replace "[^a-z0-9]", "").Length))) $m
    Set-Pins $t $m
    & $Mutate $t $m
    $tBefore = Get-Snapshot $t.target; $bBefore = Get-Snapshot $t.bak
    $mBefore = Test-Path -LiteralPath $t.marker
    $threw = $false
    try { Invoke-CoreApplyAll $m $t.stage $t.target $t.bak $t.marker | Out-Null } catch { $threw = $true; if ($_.Exception.Message -notmatch $Expect) { throw ("wrong error: " + $_.Exception.Message) } }
    if (-not $threw) { throw "expected throw" }
    Assert-Same $tBefore (Get-Snapshot $t.target) "target"
    Assert-Same $bBefore (Get-Snapshot $t.bak) "backup"
    if ((Test-Path -LiteralPath $t.marker) -ne $mBefore) { throw "marker presence changed" }
  }
}

NegCase "NEG wrong sha (correct size)" { param($t, $m) $m.payload[0].new = ("0" * 64) } "^CORE: staged mismatch:"
NegCase "NEG old pin wrong" { param($t, $m) $m.payload[0].old = ("1" * 64) } "^CORE: old pin mismatch:"
NegCase "NEG newJS already exists" { param($t, $m)
  $js = @($m.payload | Where-Object { $null -eq $_.old })[0]
  $d = Join-Path $t.target ((Normalize-Rel ([string]$js.rel)).Replace("/", "\"))
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($d)) -Force | Out-Null
  [IO.File]::WriteAllText($d, "PREEXISTING")
} "^CORE: target exists:"
NegCase "NEG marker already exists" { param($t, $m) [IO.File]::WriteAllText($t.marker, "{}") } "^CORE: marker exists"
NegCase "NEG rel dotdot" { param($t, $m) $m.payload[0].rel = "../escape.bin" } "^GUARD: dotdot in rel:"
NegCase "NEG target outside root" { param($t, $m) $m.payload[0].rel = "..\..\outside.bin" } "^GUARD: dotdot in rel:"
NegCase "NEG doNotWrite changed" { param($t, $m) $m.doNotWrite[0].sha256 = ("0" * 64) } "^CORE: doNotWrite changed:"
NegCase "NEG baselineOld changed" { param($t, $m) $bk = @($m.baselineOld.PSObject.Properties.Name)[0]; $m.baselineOld.$bk = ("0" * 64) } "^CORE: baselineOld changed:"

# NEG5: independent Assert-Under counterexample. The dotdot NEG above is caught by
# Assert-SafeRel before any join; this case reaches Assert-Under itself.
Case "NEG5 Assert-Under independent counterexample" {
  $threw = $false
  try { Assert-Under "C:\outside\x.bin" "C:\root" "target" } catch { $threw = $true; if ($_.Exception.Message -notmatch "^GUARD: target outside boundary:") { throw ("wrong error: " + $_.Exception.Message) } }
  if (-not $threw) { throw "expected outside throw" }
  $threw2 = $false
  try { Assert-Under "C:\root2\x.bin" "C:\root" "target" } catch { $threw2 = $true; if ($_.Exception.Message -notmatch "^GUARD: target outside boundary:") { throw ("wrong error: " + $_.Exception.Message) } }
  if (-not $threw2) { throw "expected prefix-only throw" }
  Assert-Under "C:\root\a\b.bin" "C:\root" "target"
}

# ---- manifest-level NEG: real Read-ExecManifest on a TEMP copy ----
function ManifestNegCase([string]$Name, [scriptblock]$Mutate, [string]$Expect) {
  Case $Name {
    $m = New-CaseManifest
    & $Mutate $m
    $path = Join-Path $full ("manifest-" + ($Name -replace "[^a-z0-9]", "") + ".json")
    [IO.File]::WriteAllText($path, ($m | ConvertTo-Json -Depth 8))
    $threw = $false
    try { Read-ExecManifest $path | Out-Null } catch { $threw = $true; if ($_.Exception.Message -notmatch $Expect) { throw ("wrong error: " + $_.Exception.Message) } }
    if (-not $threw) { throw "expected throw" }
  }
}
ManifestNegCase "NEG manifest old null requires add-new-exclusive" { param($m) $m.payload[0].old = $null; $m.payload[0].action = "replace" } "^GUARD: old null requires add-new-exclusive:"
ManifestNegCase "NEG manifest appRoot relative" { param($m) $m.appRoot = "relative\app" } "^GUARD: manifest.appRoot must be an absolute drive path:"
ManifestNegCase "NEG manifest baselineOld missing" { param($m) $m.PSObject.Properties.Remove("baselineOld") } "^GUARD: manifest.baselineOld missing"
ManifestNegCase "NEG manifest baselineOld bad sha" { param($m) $bk = @($m.baselineOld.PSObject.Properties.Name)[0]; $m.baselineOld.$bk = "zz" } "^SCHEMA: baselineOld\("

# ---- r11 legacy archive declaration: real marker file + pure validation ----
function New-LegacyTree([string]$Tag, $m) {
  $appRoot = Join-Path $full ($Tag + "\app")
  $appPrivate = Join-Path $appRoot ".av-apply-private"
  New-Item -ItemType Directory -Path $appPrivate -Force | Out-Null
  $markerPath = Join-Path $appPrivate "APPLY-OK.json"
  $stage = Join-Path $appPrivate ".stage-20261103-184900"
  $post = [ordered]@{}
  foreach ($p in $m.payload) { if ($null -ne $p.old) { $post[(Normalize-Rel ([string]$p.rel))] = [string]$p.old } }
  foreach ($bk in @($m.baselineOld.PSObject.Properties.Name)) { $post[(Normalize-Rel $bk)] = [string]$m.baselineOld.$bk }
  $mk = [ordered]@{ status = "APPLY-OK"; stage = $stage; volumeSerial = "FIXTURE-VOL"; at = "2026-11-03T11:01:31Z"; post = $post; writes = @() }
  [IO.File]::WriteAllText($markerPath, ($mk | ConvertTo-Json -Depth 6))
  # Read the marker back exactly as archive-marker.ps1 does (ConvertFrom-Json shape).
  $mkObj = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  return [ordered]@{ appRoot = $appRoot; markerPath = $markerPath; stage = $stage; post = $post; marker = $mkObj }
}

Case "LEGACY archive declaration accepts real marker file" {
  $m = New-CaseManifest
  $t = New-LegacyTree "legacy-pos" $m
  $sha = Get-Sha256 $t.markerPath
  $decl = [pscustomobject]@{ markerPath = $t.markerPath; markerSha256 = $sha; status = "APPLY-OK"; stage = $t.stage; post = [pscustomobject]$t.post }
  Assert-LegacyArchiveDeclaration $decl $m $t.appRoot | Out-Null
  Assert-MarkerForArchive ([pscustomobject]$t.marker) $m $t.appRoot $decl $t.markerPath
  Assert-LegacyMarkerSha $t.markerPath $sha | Out-Null
}
Case "LEGACY archive rejects wrong file sha" {
  $m = New-CaseManifest
  $t = New-LegacyTree "legacy-sha" $m
  $threw = $false
  try { Assert-LegacyMarkerSha $t.markerPath ("0" * 64) | Out-Null } catch { $threw = $true; if ($_.Exception.Message -notmatch "^ARCHIVE: legacy marker sha mismatch") { throw ("wrong error: " + $_.Exception.Message) } }
  if (-not $threw) { throw "expected throw" }
}
Case "LEGACY archive rejects missing declaration" {
  $m = New-CaseManifest
  $t = New-LegacyTree "legacy-nodecl" $m
  $threw = $false
  try { Assert-MarkerForArchive ([pscustomobject]$t.marker) $m $t.appRoot } catch { $threw = $true; if ($_.Exception.Message -notmatch "^ARCHIVE: marker root missing and no legacy declaration") { throw ("wrong error: " + $_.Exception.Message) } }
  if (-not $threw) { throw "expected throw" }
}
Case "LEGACY archive rejects empty root" {
  $m = New-CaseManifest
  $t = New-LegacyTree "legacy-emptyroot" $m
  $sha = Get-Sha256 $t.markerPath
  $decl = [pscustomobject]@{ markerPath = $t.markerPath; markerSha256 = $sha; status = "APPLY-OK"; stage = $t.stage; post = [pscustomobject]$t.post }
  $mk = [pscustomobject]$t.marker
  $mk | Add-Member -NotePropertyName root -NotePropertyValue "" -Force
  $threw = $false
  try { Assert-MarkerForArchive $mk $m $t.appRoot $decl $t.markerPath } catch { $threw = $true; if ($_.Exception.Message -notmatch "^ARCHIVE: marker root empty") { throw ("wrong error: " + $_.Exception.Message) } }
  if (-not $threw) { throw "expected throw" }
}

$fail = @($results | Where-Object { $_ -like "FAIL *" })
foreach ($r in $results) { $r }
if ($fail.Count -gt 0) { "FIXTURE FAIL n=" + $fail.Count; exit 1 }
"FIXTURE PASS n=" + $results.Count
exit 0
