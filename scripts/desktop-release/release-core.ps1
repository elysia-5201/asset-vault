# release-core.ps1 - pure logic for the desktop release entry (offline testable).
#
# Frozen source: candidate/exec-r11 (13 files, aggregate b07f072e..., manifest 0f19d7ee...).
# This file does exactly three things: verify the frozen bytes, turn the manifest into a
# fixed 6-step plan, and run that plan in order. It implements no release semantics of its
# own: roots / freeze / old / new / marker / receipts stay enforced by the runtime scripts.
$ErrorActionPreference = "Stop"

# Trust root: the bytes of runtime/freeze.json and stage.ps1 are pinned here.
# Changing the frozen package means changing these two constants on purpose.
$script:FreezeSha256 = "d098c86c744e645ccd3a95664a22abb4c3fe36b7646c9ddd6a09342795a6c42b"
$script:StageScriptSha256 = "f1486de950711090518fdd21013ab36a2ae583e8ae91142a6520060810b84227"
$script:ExpectedAggregate = "b07f072e843e015c934c8adaa37443be812297e2a5e502d566ae306549364782"
$script:StepOrder = @("stage", "close", "backup", "archive", "apply", "start")

function Get-FileSha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "CORE: file missing: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace "-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Write-TextFile([string]$Path, [string]$Text) {
  $enc = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Text, $enc)
}

# Freeze check: freeze.json hash -> 13 files (bytes + sha256) -> name-sorted aggregate.
# Aggregate definition: sha256(join("\n", "<sha>  <name>")), sorted by name, no trailing newline.
function Assert-ReleaseRuntime([string]$RuntimeDir) {
  if ([string]::IsNullOrWhiteSpace($RuntimeDir)) { throw "FREEZE: RuntimeDir must be explicit" }
  $freezePath = Join-Path $RuntimeDir "freeze.json"
  if (-not (Test-Path -LiteralPath $freezePath -PathType Leaf)) { throw "FREEZE: freeze.json missing: $freezePath" }
  $freezeSha = Get-FileSha256 $freezePath
  if ($freezeSha -ne $script:FreezeSha256) { throw "FREEZE: freeze.json sha256 mismatch: $freezeSha" }
  $freeze = Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
  $files = @($freeze.files)
  if ($files.Count -ne 13) { throw "FREEZE: expected 13 files, got $($files.Count)" }
  # Ordinal sort on purpose: Sort-Object is culture-aware and would order
  # "fixture.ps1" before "fixture-manifest.sample.json", which is not the pinned definition.
  $byName = @{}
  foreach ($f in $files) { $byName[[string]$f.name] = $f }
  $names = [string[]]@($byName.Keys)
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $lines = New-Object System.Collections.ArrayList
  foreach ($name in $names) {
    $f = $byName[$name]
    if ($name -notmatch "^[A-Za-z0-9._-]+$") { throw "FREEZE: unsafe file name: $name" }
    $path = Join-Path $RuntimeDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "FREEZE: missing $name" }
    $len = (Get-Item -LiteralPath $path).Length
    if ($len -ne [long]$f.bytes) { throw "FREEZE: bytes mismatch $name : $len != $($f.bytes)" }
    $sha = Get-FileSha256 $path
    if ($sha -ne [string]$f.sha256) { throw "FREEZE: sha256 mismatch $name : $sha" }
    [void]$lines.Add($sha + "  " + $name)
  }
  $aggregate = Get-TextSha256 ([string]::Join("`n", [string[]]@($lines)))
  if ($aggregate -ne [string]$freeze.aggregate) { throw "FREEZE: aggregate mismatch: $aggregate != $($freeze.aggregate)" }
  if ($aggregate -ne $script:ExpectedAggregate) { throw "FREEZE: aggregate != pinned: $aggregate" }
  return [ordered]@{ dir = $RuntimeDir; files = $files.Count; aggregate = $aggregate; freezeSha256 = $freezeSha }
}

# Payload source check: the 4 build artifacts must equal manifest.new in bytes and sha256.
# Read-only; the payload source is an explicit input, never the production tree.
function Assert-ReleasePayload($Manifest, [string]$PayloadSource) {
  if ([string]::IsNullOrWhiteSpace($PayloadSource)) { throw "PAYLOAD: PayloadSource must be explicit" }
  if (-not (Test-Path -LiteralPath $PayloadSource -PathType Container)) { throw "PAYLOAD: source dir missing: $PayloadSource" }
  $rows = New-Object System.Collections.ArrayList
  foreach ($p in @($Manifest.payload)) {
    $rel = ([string]$p.rel).Replace("/", "\")
    $src = Join-Path $PayloadSource $rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "PAYLOAD: missing $($p.rel)" }
    $len = (Get-Item -LiteralPath $src).Length
    if ($len -ne [long]$p.bytes) { throw "PAYLOAD: bytes mismatch $($p.rel): $len != $($p.bytes)" }
    $sha = Get-FileSha256 $src
    if ($sha -ne [string]$p.new) { throw "PAYLOAD: sha256 mismatch $($p.rel): $sha" }
    [void]$rows.Add([ordered]@{ rel = [string]$p.rel; bytes = $len; sha256 = $sha })
  }
  # stage.ps1 requires exactly 4 files (r11 shape). Plan must not accept a manifest that the
  # first Execute step is guaranteed to reject.
  if ($rows.Count -ne 4) { throw "PAYLOAD: expected exactly 4 payload files, got $($rows.Count)" }
  return [ordered]@{ files = $rows.Count; rows = @($rows) }
}

# Canonical path for comparisons: full path, trailing separator trimmed, drive root kept as "X:".
function Get-CanonicalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "PATH: empty path" }
  $full = [IO.Path]::GetFullPath($Path)
  $trimmed = $full.TrimEnd("\")
  if ($trimmed -match "^[A-Za-z]:$") { return $trimmed + "\" }
  return $trimmed
}

# True when Child equals Parent or lives under it. Case-insensitive, directory-boundary aware
# (C:a is not inside C:ac).
function Test-PathWithin([string]$Child, [string]$Parent) {
  $c = Get-CanonicalPath $Child
  $p = Get-CanonicalPath $Parent
  if ([string]::Equals($c, $p, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = if ($p.EndsWith("\")) { $p } else { $p + "\" }
  return $c.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

# LogDir must be a brand-new directory: an existing directory (even empty) is rejected, never
# cleared or reused, so earlier evidence cannot be overwritten. Every existing component of the
# parent chain must be a real directory (no reparse point). Read-only.
function Assert-LogDirFresh([string]$LogDir) {
  if ([string]::IsNullOrWhiteSpace($LogDir)) { throw "LOGDIR: LogDir must be explicit" }
  $full = [IO.Path]::GetFullPath($LogDir)
  if (Test-Path -LiteralPath $full) { throw "LOGDIR: LogDir must not exist (fresh directory required): $full" }
  $parent = [IO.Path]::GetDirectoryName($full)
  while (-not [string]::IsNullOrWhiteSpace($parent)) {
    if (Test-Path -LiteralPath $parent) {
      $item = Get-Item -LiteralPath $parent -Force
      if (-not $item.PSIsContainer) { throw "LOGDIR: parent is not a directory: $parent" }
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "LOGDIR: reparse point in parent chain: $parent" }
    }
    $next = [IO.Path]::GetDirectoryName($parent)
    if ($next -eq $parent) { break }
    $parent = $next
  }
}

# LogDir must not intersect any protected tree: equal to it, inside it, or an ancestor of it.
# ManifestPath is compared as the exact file only (not its parent directory), so a normal
# sibling log directory next to the manifest is not blocked. Pure path comparison.
function Assert-LogDirIsolated([string]$LogDir, $Plan, [string]$PayloadSource, [string]$RuntimeDir, [string]$ManifestPath) {
  if ($null -eq $Plan -or $null -eq $Plan.paths) { throw "LOGDIR: plan paths missing" }
  $log = Get-CanonicalPath $LogDir
  $p = $Plan.paths
  $dataRoot = [IO.Path]::GetFullPath((Join-Path ([string]$p.DataPrivate) "..\data"))
  $protected = [ordered]@{
    AppRoot          = [string]$p.AppRoot
    AppPrivate       = [string]$p.AppPrivate
    DataPrivate      = [string]$p.DataPrivate
    DataRoot         = $dataRoot
    StageRoot        = [string]$p.StageRoot
    BakDir           = [string]$p.BakDir
    Receipt          = [string]$p.Receipt
    BackupReceipt    = [string]$p.BackupReceipt
    DbBackupDir      = [string]$p.DbBackupDir
    Marker           = [string]$p.Marker
    OldMarkerArchive = [string]$p.OldMarkerArchive
    PayloadSource    = $PayloadSource
    RuntimeDir       = $RuntimeDir
  }
  foreach ($k in @($protected.Keys)) {
    $v = [string]$protected[$k]
    if ([string]::IsNullOrWhiteSpace($v)) { continue }
    if (Test-PathWithin $log $v) { throw "LOGDIR: conflicts with $k (LogDir is equal to or inside it): $log" }
    if (Test-PathWithin $v $log) { throw "LOGDIR: conflicts with $k (LogDir is an ancestor of it): $log" }
  }
  if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $m = Get-CanonicalPath $ManifestPath
    if ([string]::Equals($log, $m, [StringComparison]::OrdinalIgnoreCase)) { throw "LOGDIR: conflicts with the manifest file: $log" }
    if (Test-PathWithin $m $log) { throw "LOGDIR: the manifest file is inside LogDir: $log" }
  }
}

# Fixed 6 steps: stage -> close -> backup -> archive -> apply -> start.
# Arguments mirror the runtime entry param blocks one to one; start appears exactly once.
function New-ReleaseSteps([string]$ManifestPath, [string]$PayloadSource, $Paths, [string]$RuntimeDir, [string]$StageScript) {
  return @(
    [ordered]@{ name = "stage";   entry = $StageScript;                                args = @("-ManifestPath", $ManifestPath, "-SrcDir", $PayloadSource) },
    [ordered]@{ name = "close";   entry = [IO.Path]::Combine($RuntimeDir, "close.ps1");          args = @("-ManifestPath", $ManifestPath) },
    [ordered]@{ name = "backup";  entry = [IO.Path]::Combine($RuntimeDir, "backup-db.ps1");      args = @("-ManifestPath", $ManifestPath, "-ReceiptPath", [string]$Paths.Receipt) },
    [ordered]@{ name = "archive"; entry = [IO.Path]::Combine($RuntimeDir, "archive-marker.ps1"); args = @("-ManifestPath", $ManifestPath, "-MarkerPath", [string]$Paths.Marker) },
    [ordered]@{ name = "apply";   entry = [IO.Path]::Combine($RuntimeDir, "apply.ps1");          args = @("-Stage", [string]$Paths.StageRoot, "-ManifestPath", $ManifestPath) },
    [ordered]@{ name = "start";   entry = [IO.Path]::Combine($RuntimeDir, "start.ps1");          args = @("-ManifestPath", $ManifestPath) }
  )
}

# Run in order: any rc != 0 returns immediately (no retry, no rollback, no auto-start of the
# old version); start is structurally limited to one invocation.
function Invoke-ReleaseSequence($Steps, $Runner) {
  if ($null -eq $Runner) { throw "SEQUENCE: runner missing" }
  $done = New-Object System.Collections.ArrayList
  $startCount = 0
  foreach ($s in @($Steps)) {
    if ([string]$s.name -eq "start") {
      $startCount++
      if ($startCount -gt 1) { throw "SEQUENCE: start invoked more than once" }
    }
    $r = & $Runner $s
    $rc = [int]$r.rc
    [void]$done.Add([ordered]@{ name = [string]$s.name; rc = $rc })
    if ($rc -ne 0) {
      return [ordered]@{ ok = $false; stoppedAt = [string]$s.name; rc = $rc; steps = @($done) }
    }
  }
  return [ordered]@{ ok = $true; stoppedAt = ""; rc = 0; steps = @($done) }
}

# Minimal correct Windows argv quoting (MSVCRT rules). Start-Process joins an -ArgumentList
# array with spaces and does not quote, so the command line must be built here:
#   - empty value            -> ""
#   - no whitespace / quote  -> verbatim
#   - otherwise              -> wrapped in quotes; backslashes before a quote are doubled and
#                               the quote escaped; trailing backslashes are doubled so they do
#                               not escape the closing quote.
# A legal trailing backslash is therefore preserved byte for byte.
function ConvertTo-WindowsArg([string]$Value) {
  if ($null -eq $Value) { $Value = "" }
  if ($Value.IndexOf([char]0) -ge 0) { throw "RUNNER: NUL byte in argument" }
  if ($Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $backslashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq [char]'\') { $backslashes++; continue }
    if ($ch -eq [char]'"') {
      [void]$sb.Append([char]'\', ($backslashes * 2 + 1))
      [void]$sb.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$sb.Append([char]'\', $backslashes); $backslashes = 0 }
    [void]$sb.Append($ch)
  }
  if ($backslashes -gt 0) { [void]$sb.Append([char]'\', ($backslashes * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# Real entry runner: every entry is its own top-level powershell.exe -File process with
# stdout / stderr / exit captured separately. -ExecutionPolicy Bypass applies to that child
# process only; the persistent scope is never changed.
function New-ProcessRunner([string]$PowerShellPath, [string]$LogDir) {
  if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) { throw "RUNNER: powershell missing: $PowerShellPath" }
  # The closure captures the data variables and the quoting function; file writes are inlined.
  $quote = ${function:ConvertTo-WindowsArg}
  return {
    param($Step)
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $out = Join-Path $LogDir ($Step.name + ".out.txt")
    $err = Join-Path $LogDir ($Step.name + ".err.txt")
    $rcFile = Join-Path $LogDir ($Step.name + ".rc")
    $argList = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", [string]$Step.entry) + @($Step.args)
    $cmdLine = (@($argList) | ForEach-Object { & $quote ([string]$_) }) -join " "
    $p = Start-Process -FilePath $PowerShellPath -ArgumentList $cmdLine -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $rc = [int]$p.ExitCode
    [IO.File]::WriteAllText($rcFile, [string]$rc, (New-Object Text.UTF8Encoding($false)))
    $stdout = if (Test-Path -LiteralPath $out) { [string](Get-Content -LiteralPath $out -Raw) } else { "" }
    $stderr = if (Test-Path -LiteralPath $err) { [string](Get-Content -LiteralPath $err -Raw) } else { "" }
    return [ordered]@{ rc = $rc; stdout = $stdout; stderr = $stderr; outFile = $out; errFile = $err }
  }.GetNewClosure()
}

# Plan redaction: the three input paths become placeholders so evidence logs never carry
# machine-private source paths.
function Format-RedactedArg([string]$Value, [string]$ManifestPath, [string]$PayloadSource, [string]$LogDir) {
  $pairs = @(
    @($ManifestPath, "<manifest>"),
    @($PayloadSource, "<payload-source>"),
    @($LogDir, "<log-dir>")
  )
  foreach ($pair in $pairs) {
    $p = [string]$pair[0]; $t = [string]$pair[1]
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    if ($Value.Equals($p, [StringComparison]::OrdinalIgnoreCase)) { return $t }
    if ($Value.StartsWith($p + "\", [StringComparison]::OrdinalIgnoreCase)) { return $t + $Value.Substring($p.Length) }
  }
  return $Value
}

# Plan object: steps carry the real arguments (execution), display is the redacted view
# (printing / evidence). Depends on the runtime exec-schema.ps1 (Resolve-ExecPaths) and
# guard.ps1 (Read-ExecManifest), dot-sourced by the caller after the freeze check passed.
function Get-ReleasePlan($Manifest, [string]$ManifestPath, [string]$PayloadSource, [string]$LogDir, $RuntimeInfo, [string]$StageScript) {
  if ($null -eq $Manifest) { throw "PLAN: manifest missing" }
  $paths = Resolve-ExecPaths ([string]$Manifest.appRoot) ([string]$Manifest.dataPrivate) ([string]$Manifest.stamp) ([string]$Manifest.releaseId)
  $payload = Assert-ReleasePayload $Manifest $PayloadSource
  $steps = New-ReleaseSteps -ManifestPath $ManifestPath -PayloadSource $PayloadSource -Paths $paths -RuntimeDir ([string]$RuntimeInfo.dir) -StageScript $StageScript

  $displaySteps = @()
  foreach ($s in $steps) {
    $args = @()
    foreach ($a in @($s.args)) { $args += (Format-RedactedArg ([string]$a) $ManifestPath $PayloadSource $LogDir) }
    $displaySteps += [ordered]@{ name = [string]$s.name; entry = [IO.Path]::GetFileName([string]$s.entry); args = $args }
  }
  $display = [ordered]@{
    mode = "plan"
    execute = $false
    manifest = [ordered]@{
      releaseId = [string]$Manifest.releaseId
      stamp = [string]$Manifest.stamp
      appRoot = [string]$Manifest.appRoot
      dataPrivate = [string]$Manifest.dataPrivate
      payload = @($Manifest.payload | ForEach-Object { [ordered]@{ rel = [string]$_.rel; bytes = [long]$_.bytes; old = $_.old; new = [string]$_.new; action = [string]$_.action } })
      baselineOld = $Manifest.baselineOld
      doNotWrite = @($Manifest.doNotWrite | ForEach-Object { [ordered]@{ rel = [string]$_.rel; sha256 = [string]$_.sha256 } })
      legacyArchive = (@($Manifest.PSObject.Properties.Name) -contains "legacyArchive")
    }
    runtime = [ordered]@{ files = $RuntimeInfo.files; aggregate = $RuntimeInfo.aggregate; freezeSha256 = $RuntimeInfo.freezeSha256; stageScriptSha256 = $script:StageScriptSha256 }
    payloadSource = [ordered]@{ files = $payload.files; verified = $true }
    paths = $paths
    steps = $displaySteps
    inputs = [ordered]@{ manifest = "<manifest>"; payloadSource = "<payload-source>"; logDir = "<log-dir>" }
    logDir = "<log-dir>"
  }
  return [ordered]@{ manifest = $Manifest; paths = $paths; steps = $steps; display = $display }
}

# Execute preflight (added by this entry, NOT a runtime capability):
# explicit reparse check on the AppPrivate chain (R1) plus one-volume check on four targets.
# Read-only.
function Test-ReleasePreflight($Plan) {
  $p = $Plan.paths
  $dataDir = [IO.Path]::GetFullPath((Join-Path ([string]$p.DataPrivate) "..\data"))
  $targets = @([string]$p.AppRoot, [string]$p.AppPrivate, [string]$p.DataPrivate, $dataDir)
  foreach ($t in $targets) { Assert-NoReparse $t }
  $serials = @($targets | ForEach-Object { Get-VolumeSerial $_ } | Sort-Object -Unique)
  if ($serials.Count -ne 1) { throw "PREFLIGHT: targets not on one volume: $($serials -join ',')" }
  return [ordered]@{ reparse = "none"; volume = [string]$serials[0]; targets = $targets.Count }
}
