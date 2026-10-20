<#
.SYNOPSIS
  AssetVault Windows preflight check (read-only).

.DESCRIPTION
  Verifies it is safe to stop, start or deploy AssetVault: no running instance, no
  listener on the app ports, no live pipeline lock, database present, packaged app
  present, enough disk space, long-path support, node/npm available.
  Prints human-readable lines, then a JSON summary. Exit 0 = safe, 1 = hard blocker.
  -AllowRunning downgrades process/port checks to warnings.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-preflight.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-preflight.ps1 -AppDir "E:\tool\asset-vault" -EvidenceDir "E:\tool\asset-vault\logs\v061"
#>
param(
  [string]$AppDir = "E:\tool\asset-vault",
  [string]$EvidenceDir = "",
  [int[]]$Ports = @(7317, 7318, 7319, 7320, 7321),
  [switch]$AllowRunning
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$checks = New-Object System.Collections.ArrayList
$script:hardFail = 0
$script:softFail = 0

function Add-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail, [string]$Level = "hard")
  $entry = [ordered]@{ name = $Name; ok = $Ok; level = $Level; detail = $Detail }
  [void]$checks.Add($entry)
  if ($Ok) { $tag = "OK  " } elseif ($Level -eq "hard") { $tag = "FAIL" } else { $tag = "WARN" }
  Write-Host ("[{0}] {1}: {2}" -f $tag, $Name, $Detail)
  if (-not $Ok) {
    if ($Level -eq "hard") { $script:hardFail++ } else { $script:softFail++ }
  }
}

# --- app dir and version ---
$appExists = Test-Path -LiteralPath $AppDir
Add-Check "appDir" $appExists $AppDir
$version = ""
if ($appExists) {
  $pkg = Join-Path $AppDir "package.json"
  if (Test-Path -LiteralPath $pkg) {
    try { $version = (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $version = "" }
  }
}
Add-Check "appVersion" ($version -ne "") ("version=" + $version)

$dataDir = Join-Path $AppDir "data"
$dbPath = Join-Path $dataDir "vault.db"

# --- running instances ---
$procLevel = "hard"
if ($AllowRunning) { $procLevel = "soft" }

$appProcs = @(Get-Process -Name "AssetVault" -ErrorAction SilentlyContinue)
$appDetail = "none"
if ($appProcs.Count -gt 0) { $appDetail = (($appProcs | ForEach-Object { "pid=" + $_.Id }) -join ",") }
Add-Check "assetvaultProcess" ($appProcs.Count -eq 0) $appDetail $procLevel

$nodeProcs = @()
try {
  $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and (($_.CommandLine -like "*apps\server\src\main.ts*") -or ($_.CommandLine -like "*apps\desktop*") -or ($_.CommandLine -like "*electron*"))
  })
} catch { }
$nodeDetail = "none"
if ($nodeProcs.Count -gt 0) { $nodeDetail = (($nodeProcs | ForEach-Object { "pid=" + $_.ProcessId + " cmd=" + $_.CommandLine }) -join " | ") }
Add-Check "assetvaultNodeProcess" ($nodeProcs.Count -eq 0) $nodeDetail $procLevel

# --- ports ---
$used = @()
foreach ($p in $Ports) {
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
    foreach ($c in $conns) { $used += ("port=" + $p + ",pid=" + $c.OwningProcess) }
  } catch { }
}
$portsDetail = "free (checked " + ($Ports -join ",") + ")"
if ($used.Count -gt 0) { $portsDetail = ($used -join ";") }
Add-Check "portsFree" ($used.Count -eq 0) $portsDetail $procLevel

# --- pipeline lock ---
$lockPath = Join-Path $dataDir "pipeline.lock"
$lockState = "absent"
$lockAlive = $false
if (Test-Path -LiteralPath $lockPath) {
  $raw = ""
  try { $raw = Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue } catch { }
  $obj = $null
  try { $obj = $raw | ConvertFrom-Json } catch { $obj = $null }
  if ($obj -and $obj.pid) {
    $lockPid = [int]$obj.pid
    $lockAlive = [bool](Get-Process -Id $lockPid -ErrorAction SilentlyContinue)
    $lockState = "pid=" + $lockPid + ",host=" + $obj.host + ",alive=" + $lockAlive
  } else {
    $lockState = "unparsable"
  }
}
Add-Check "pipelineLock" (-not $lockAlive) ($lockState + " @ " + $lockPath) $procLevel

# --- database files ---
Add-Check "database" (Test-Path -LiteralPath $dbPath) $dbPath
if (Test-Path -LiteralPath $dbPath) {
  $dbi = Get-Item -LiteralPath $dbPath
  $side = @()
  foreach ($suf in @("-wal", "-shm")) { if (Test-Path -LiteralPath ($dbPath + $suf)) { $side += $suf } }
  $dbDetail = "bytes=" + $dbi.Length + ",mtime=" + $dbi.LastWriteTime.ToString("s") + ",sidecars=[" + ($side -join ",") + "]"
  Add-Check "databaseSize" ($dbi.Length -gt 0) $dbDetail "soft"
}

# --- packaged app ---
$exe = Join-Path $AppDir "dist-desktop\win-unpacked\AssetVault.exe"
Add-Check "packagedExe" (Test-Path -LiteralPath $exe) $exe "soft"
$packagedVersion = ""
$pkgApp = Join-Path $AppDir "dist-desktop\win-unpacked\resources\app\package.json"
if (Test-Path -LiteralPath $pkgApp) {
  try { $packagedVersion = (Get-Content -LiteralPath $pkgApp -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $packagedVersion = "" }
}
Add-Check "packagedVersion" ($packagedVersion -ne "") ("version=" + $packagedVersion) "soft"

# --- disk ---
$freeBytes = 0
$driveLetter = ""
if ($AppDir.Length -ge 2) { $driveLetter = $AppDir.Substring(0, 1) }
if ($driveLetter -ne "") {
  try { $freeBytes = (Get-PSDrive -Name $driveLetter -ErrorAction Stop).Free } catch { $freeBytes = 0 }
}
$freeGB = [math]::Round($freeBytes / 1GB, 1)
Add-Check "diskFree" ($freeBytes -ge 2GB) ("drive=" + $driveLetter + ":,freeGB=" + $freeGB) "soft"

# --- long paths ---
$lp = 0
try { $lp = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled } catch { $lp = 0 }
Add-Check "longPaths" ($lp -eq 1) ("LongPathsEnabled=" + $lp) "soft"

# --- toolchain ---
$nodeV = ""
try { $nodeV = ((& node --version) 2>$null | Out-String).Trim() } catch { }
Add-Check "node" ($nodeV -ne "") ("node=" + $nodeV) "soft"
$npmV = ""
try { $npmV = ((& npm.cmd -v) 2>$null | Out-String).Trim() } catch { }
Add-Check "npm" ($npmV -ne "") ("npm.cmd=" + $npmV) "soft"

# --- summary ---
$ok = ($script:hardFail -eq 0)
$summary = [ordered]@{
  at = (Get-Date).ToString("o")
  appDir = $AppDir
  version = $version
  ok = $ok
  hardFailures = $script:hardFail
  warnings = $script:softFail
  checks = $checks
}
$json = $summary | ConvertTo-Json -Depth 6
Write-Host ""
Write-Host $json
if ($EvidenceDir -ne "") {
  try {
    if (-not (Test-Path -LiteralPath $EvidenceDir)) { New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null }
    $jsonPath = Join-Path $EvidenceDir ("preflight-" + $stamp + ".json")
    Set-Content -LiteralPath $jsonPath -Value $json -Encoding UTF8
    Write-Host ("evidence: " + $jsonPath)
  } catch { Write-Host ("evidence write failed: " + $_.Exception.Message) }
}
if ($ok) { exit 0 } else { exit 1 }
