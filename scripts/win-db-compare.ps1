<#
.SYNOPSIS
  Compare two win-db-snapshot.ps1 JSON snapshots for a rollback drill.

.DESCRIPTION
  Hard invariants (must be equal): item/asset/image/category/tag/collection/avatar-link counts
  and the media inventory hash (when both snapshots have one).
  Soft/informational (reported, not failed): jobs count, schema_meta.version, table list length.
  FAILED if integrity is not ok or any hard invariant differs.

.PARAMETER Before
  Earlier snapshot JSON.

.PARAMETER After
  Later snapshot JSON.

.PARAMETER Out
  Optional JSON report path.

.PARAMETER Ignore
  Hard keys to skip, e.g. -Ignore counts.asset_avatars.

.PARAMETER ExpectVersion
  Optional expected schema_meta.version in the AFTER snapshot (4 or 6). Mismatch is a hard fail.

.EXAMPLE
  powershell -File scripts\win-db-compare.ps1 -Before E:\tool\av-aud02\s1-before.json -After E:\tool\av-aud02\s1-after.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Before,
  [Parameter(Mandatory = $true)][string]$After,
  [string]$Out = "",
  [string[]]$Ignore = @(),
  [string]$ExpectVersion = ""
)

$ErrorActionPreference = "Stop"
function Fail([string]$m) { Write-Error $m; exit 1 }
foreach ($p in @($Before, $After)) { if (-not (Test-Path -LiteralPath $p)) { Fail ("snapshot not found: " + $p) } }
$b = Get-Content -LiteralPath $Before -Raw | ConvertFrom-Json
$a = Get-Content -LiteralPath $After -Raw | ConvertFrom-Json

$ignoreSet = @{}
foreach ($k in $Ignore) { $ignoreSet[$k] = 1 }

function Get-Path($obj, [string]$path) {
  $cur = $obj
  foreach ($seg in $path.Split(".")) {
    if ($null -eq $cur) { return $null }
    $cur = $cur.$seg
  }
  return $cur
}

$hardKeys = @(
  "counts.items", "counts.assets", "counts.images", "counts.categories",
  "counts.tags", "counts.collection_items", "counts.asset_avatars", "counts.item_avatars"
)
$softKeys = @("counts.jobs", "meta.version", "tables.count", "integrity")

$rows = @()
$failed = 0
foreach ($k in $hardKeys) {
  if ($ignoreSet.ContainsKey($k)) { continue }
  $bv = Get-Path $b $k
  $av = Get-Path $a $k
  $ok = ($bv -eq $av)
  if (-not $ok) { $failed++ }
  $rows += [ordered]@{ key = $k; before = $bv; after = $av; hard = $true; status = $(if ($ok) { "OK" } else { "MISMATCH" }) }
}
if ($null -ne $b.media -and $null -ne $a.media) {
  $ok = ($b.media.hash -eq $a.media.hash)
  if (-not $ok -and -not $ignoreSet.ContainsKey("media.hash")) { $failed++ }
  $rows += [ordered]@{ key = "media.hash"; before = $b.media.hash; after = $a.media.hash; hard = $true; status = $(if ($ok) { "OK" } else { "MISMATCH" }) }
}
foreach ($k in $softKeys) {
  $bv = Get-Path $b $k; $av = Get-Path $a $k
  if ($k -eq "tables.count") { $bv = @($b.verify.tables).Count; $av = @($a.verify.tables).Count }
  if ($k -eq "meta.version") { $bv = $b.verify.meta.version; $av = $a.verify.meta.version }
  if ($k -eq "integrity") { $bv = $b.verify.integrity; $av = $a.verify.integrity }
  $rows += [ordered]@{ key = $k; before = $bv; after = $av; hard = $false; status = $(if ($bv -eq $av) { "SAME" } else { "CHANGED" }) }
}

if ($a.verify.integrity -ne "ok") { $failed++; $rows += [ordered]@{ key = "after.integrity"; before = "ok"; after = $a.verify.integrity; hard = $true; status = "FAILED" } }
if ($ExpectVersion -ne "" -and [string]$a.verify.meta.version -ne $ExpectVersion) {
  $failed++
  $rows += [ordered]@{ key = "expect.version"; before = $ExpectVersion; after = $a.verify.meta.version; hard = $true; status = "MISMATCH" }
}

foreach ($r in $rows) {
  Write-Host ("[{0}] {1}: {2} -> {3}" -f $r.status, $r.key, $r.before, $r.after)
}
$result = [ordered]@{
  at = (Get-Date).ToString("o")
  before = [IO.Path]::GetFullPath($Before)
  after = [IO.Path]::GetFullPath($After)
  failed = $failed
  expectVersion = $ExpectVersion
  rows = $rows
}
if ($Out -ne "") {
  $d = Split-Path -Parent ([IO.Path]::GetFullPath($Out))
  if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  Set-Content -LiteralPath $Out -Value ($result | ConvertTo-Json -Depth 8) -Encoding UTF8
}
Write-Host ("COMPARE_" + $(if ($failed -eq 0) { "PASS" } else { "FAIL" }) + " failed=" + $failed)
if ($failed -eq 0) { exit 0 } else { exit 1 }
