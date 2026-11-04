# io-core.ps1 r9 — global preflight BEFORE any backup/replace; per-item recheck before each write.
$ErrorActionPreference = "Stop"

function New-UniqueBackup([string]$Dst, [string]$OldSha, [string]$BakDir) {
  Assert-NoReparse $BakDir
  if (-not (Test-Path -LiteralPath $BakDir)) { New-Item -ItemType Directory -Path $BakDir -Force | Out-Null }
  $bak = Join-Path $BakDir ("bak-" + [IO.Path]::GetFileName($Dst) + "." + (New-Stamp (Get-Date).ToUniversalTime()) + "." + (New-Hex8))
  $fs = [IO.File]::Open($bak, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $old = [IO.File]::ReadAllBytes($Dst); $fs.Write($old, 0, $old.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  if ((Get-Sha256 $bak) -ne $OldSha) { throw "CORE: backup bytes mismatch: $bak" }
  return $bak
}

function Get-CoreOrder($ManifestData) {
  $rest = @($ManifestData.payload | Where-Object { (Normalize-Rel ([string]$_.rel)) -ne $script:IndexRel })
  $last = @($ManifestData.payload | Where-Object { (Normalize-Rel ([string]$_.rel)) -eq $script:IndexRel })
  if ($last.Count -ne 1) { throw "CORE: index.html must appear exactly once" }
  return @($rest + $last)
}

# S1: every precondition is proven before the first byte is written.
function Invoke-CorePreflight($ManifestData, [string]$Stage, [string]$Root, [string]$Marker) {
  if (Test-Path -LiteralPath $Marker) { throw "CORE: marker exists" }
  Assert-NoReparse $Root
  Assert-NoReparse $Stage
  if ((Get-VolumeSerial $Root) -ne (Get-VolumeSerial $Stage)) { throw "CORE: stage not on target volume" }
  # I2: doNotWrite and baselineOld must still match before any payload byte is written.
  $hashOf = {
    param($rel)
    $p = Join-Path $Root ($rel.Replace("/", "\"))
    Assert-Under $p $Root "preserved"
    Assert-NoReparse $p
    Get-Sha256 $p
  }.GetNewClosure()
  Assert-PreservedBytes $ManifestData $hashOf
  $ordered = Get-CoreOrder $ManifestData
  foreach ($p in $ordered) {
    $rel = Normalize-Rel ([string]$p.rel)
    # r8: re-assert rel safety here — the manifest object can be mutated after Read-ExecManifest (fixture NEG path).
    Assert-SafeRel $rel
    $s = Join-Path $Stage ($rel.Replace("/", "\"))
    $d = Join-Path $Root ($rel.Replace("/", "\"))
    Assert-Under $s $Stage "staged file"
    Assert-Under $d $Root "target"
    Assert-NoReparse $d
    if ((Get-Sha256 $s) -ne $p.new) { throw "CORE: staged mismatch: $rel" }
    if ($null -eq $p.old) {
      if (Test-Path -LiteralPath $d) { throw "CORE: target exists: $rel" }
    } else {
      if (-not (Test-Path -LiteralPath $d -PathType Leaf)) { throw "CORE: target missing: $rel" }
      if ((Get-Sha256 $d) -ne $p.old) { throw "CORE: old pin mismatch: $rel" }
    }
  }
  return $ordered
}

function Invoke-CoreReplace([string]$Src, [string]$Dst, [string]$OldSha, [string]$NewSha, [string]$BakDir, [string]$Root) {
  Assert-Under $Dst $Root "target"
  Assert-NoReparse $Dst
  if ((Get-Sha256 $Dst) -ne $OldSha) { throw "CORE: old pin mismatch (pre-write): $Dst" }
  $bak = New-UniqueBackup $Dst $OldSha $BakDir
  [IO.File]::Replace($Src, $Dst, [NullString]::Value, $true)
  if ((Get-Sha256 $Dst) -ne $NewSha) { throw "CORE: post mismatch: $Dst" }
  return $bak
}

function Invoke-CoreCreateNew([string]$Src, [string]$Dst, [string]$NewSha, [string]$Root) {
  Assert-Under $Dst $Root "target"
  Assert-NoReparse $Dst
  if (Test-Path -LiteralPath $Dst) { throw "CORE: target exists: $Dst" }
  $fs = [IO.File]::Open($Dst, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $b = [IO.File]::ReadAllBytes($Src); $fs.Write($b, 0, $b.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  if ((Get-Sha256 $Dst) -ne $NewSha) { throw "CORE: post mismatch: $Dst" }
}

function Invoke-CoreApplyAll($ManifestData, [string]$Stage, [string]$Root, [string]$BakDir, [string]$Marker) {
  $ordered = Invoke-CorePreflight $ManifestData $Stage $Root $Marker
  $writes = @()
  foreach ($p in $ordered) {
    $rel = Normalize-Rel ([string]$p.rel)
    Assert-SafeRel $rel
    $s = Join-Path $Stage ($rel.Replace("/", "\"))
    $d = Join-Path $Root ($rel.Replace("/", "\"))
    if ((Get-Sha256 $s) -ne $p.new) { throw "CORE: staged changed before write: $rel" }
    if ($null -eq $p.old) {
      Invoke-CoreCreateNew $s $d $p.new $Root
      $writes += [ordered]@{ rel = $rel; action = "created" }
    } else {
      $bak = Invoke-CoreReplace $s $d $p.old $p.new $BakDir $Root
      $writes += [ordered]@{ rel = $rel; action = "replaced"; backup = $bak }
    }
  }
  $post = [ordered]@{}
  foreach ($p in $ManifestData.payload) {
    $rel = Normalize-Rel ([string]$p.rel)
    Assert-SafeRel $rel
    $d = Join-Path $Root ($rel.Replace("/", "\"))
    $h = Get-Sha256 $d
    if ($h -ne $p.new) { throw "CORE: post mismatch: $rel" }
    $post[$rel] = $h
  }
  $obj = [ordered]@{ status = "APPLY-OK"; root = $Root; stage = $Stage; at = (Get-Date).ToUniversalTime().ToString("o"); post = $post; writes = $writes }
  $json = $obj | ConvertTo-Json -Depth 6
  $mfs = [IO.File]::Open($Marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $mb = [Text.Encoding]::UTF8.GetBytes($json); $mfs.Write($mb, 0, $mb.Length); $mfs.Flush($true) } finally { $mfs.Dispose() }
  return $obj
}
