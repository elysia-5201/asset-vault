<#
.SYNOPSIS
  Back up the AssetVault database (vault.db + -wal + -shm) with verification.

.DESCRIPTION
  Refuses to run while an instance is running or the pipeline lock is alive
  (override with -AllowRunning, not recommended).
  Copies db + wal + shm, computes SHA256 for each copy, then opens the COPY read-only
  with better-sqlite3 (resolved from -AppDir\node_modules) and reports integrity_check,
  schema_meta.version, and item/asset/job counts.
  The settings table is never read (it may contain credentials); nothing from it is printed.
  -DiscardAfterVerify deletes the copied database files afterwards and keeps manifest.json
  (hashes + verification evidence only).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-backup.ps1 -Version 0.6.1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-backup.ps1 -Version 0.6.1 -OutDir "E:\tool\asset-vault\logs\v061\backup-probe-20261020-2130" -DiscardAfterVerify
#>
param(
  [string]$Version = "0.0.0",
  [string]$AppDir = "E:\tool\asset-vault",
  [string]$DataDir = "",
  [string]$OutDir = "",
  [int[]]$Ports = @(7317, 7318, 7319, 7320, 7321),
  [switch]$AllowRunning,
  [switch]$DiscardAfterVerify
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
if ($DataDir -eq "") { $DataDir = Join-Path $AppDir "data" }
$dbPath = Join-Path $DataDir "vault.db"

if (-not (Test-Path -LiteralPath $dbPath)) {
  Write-Host ("BACKUP_FAIL database not found: " + $dbPath)
  exit 2
}

# --- safety: no running writer ---
$blockers = @()
$appProcs = @(Get-Process -Name "AssetVault" -ErrorAction SilentlyContinue)
if ($appProcs.Count -gt 0) { $blockers += ("AssetVault pid=" + (($appProcs | ForEach-Object { $_.Id }) -join ",")) }
try {
  $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and (($_.CommandLine -like "*apps\server\src\main.ts*") -or ($_.CommandLine -like "*apps\desktop*"))
  })
  if ($nodeProcs.Count -gt 0) { $blockers += ("node pid=" + (($nodeProcs | ForEach-Object { $_.ProcessId }) -join ",")) }
} catch { }
foreach ($p in $Ports) {
  try {
    $c = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
    if ($c.Count -gt 0) { $blockers += ("port=" + $p) }
  } catch { }
}
$lockPath = Join-Path $DataDir "pipeline.lock"
$lockAlive = $false
if (Test-Path -LiteralPath $lockPath) {
  try {
    $obj = (Get-Content -LiteralPath $lockPath -Raw) | ConvertFrom-Json
    if ($obj -and $obj.pid) { $lockAlive = [bool](Get-Process -Id ([int]$obj.pid) -ErrorAction SilentlyContinue) }
  } catch { }
}
if ($lockAlive) { $blockers += "pipeline.lock alive" }

if ($blockers.Count -gt 0 -and -not $AllowRunning) {
  Write-Host ("BACKUP_FAIL service looks active: " + ($blockers -join "; ") + " (stop it first, or pass -AllowRunning)")
  exit 3
}
if ($blockers.Count -gt 0) { Write-Host ("BACKUP_WARN active: " + ($blockers -join "; ") + " (copied anyway, consistency NOT guaranteed)") }

# --- copy ---
if ($OutDir -eq "") { $OutDir = Join-Path $DataDir ("backup-before-v" + $Version + "-" + $stamp) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$sources = @($dbPath, ($dbPath + "-wal"), ($dbPath + "-shm")) | Where-Object { Test-Path -LiteralPath $_ }
$files = @()
foreach ($s in $sources) {
  $name = Split-Path -Leaf $s
  $dest = Join-Path $OutDir $name
  Copy-Item -LiteralPath $s -Destination $dest -Force
  $hash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
  $len = (Get-Item -LiteralPath $dest).Length
  $files += [ordered]@{ name = $name; bytes = $len; sha256 = $hash }
  Write-Host ("copied " + $name + " bytes=" + $len + " sha256=" + $hash)
}
if ($files.Count -eq 0) {
  Write-Host "BACKUP_FAIL nothing copied"
  exit 4
}

# --- verify the copy with better-sqlite3 ---
$verifyDir = Join-Path $env:TEMP ("av-verify-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
foreach ($f in $files) {
  Copy-Item -LiteralPath (Join-Path $OutDir $f.name) -Destination (Join-Path $verifyDir $f.name) -Force
}
$js = @'
const Database = require("better-sqlite3");
const file = process.argv[2];
const db = new Database(file, { readonly: true, fileMustExist: true });
const out = {};
out.integrity = db.pragma("integrity_check", { simple: true });
out.journalMode = db.pragma("journal_mode", { simple: true });
const meta = db.prepare("SELECT key, value FROM schema_meta WHERE key IN ('version','taxonomy_version')").all();
out.meta = {};
for (const r of meta) out.meta[r.key] = r.value;
out.counts = db.prepare("SELECT (SELECT COUNT(*) FROM items) items, (SELECT COUNT(*) FROM assets) assets, (SELECT COUNT(*) FROM jobs) jobs").get();
try { out.tableCount = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c; } catch (e) { out.tableCount = null; }
db.close();
console.log(JSON.stringify(out));
'@
$jsPath = Join-Path $verifyDir "verify.cjs"
Set-Content -LiteralPath $jsPath -Value $js -Encoding ASCII

$verifyObj = $null
$verifyRaw = ""
$verifyExit = 1
$oldNodePath = $env:NODE_PATH
$env:NODE_PATH = Join-Path $AppDir "node_modules"
Push-Location $AppDir
try {
  $verifyRaw = ((& node $jsPath (Join-Path $verifyDir "vault.db")) 2>$null | Out-String).Trim()
  $verifyExit = $LASTEXITCODE
} catch {
  $verifyRaw = "VERIFY_ERROR " + $_.Exception.Message
} finally {
  Pop-Location
  if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
}
try { $verifyObj = $verifyRaw | ConvertFrom-Json } catch { $verifyObj = $null }
$verifyOk = ($verifyExit -eq 0 -and $verifyObj -ne $null -and $verifyObj.integrity -eq "ok")

$dbi = Get-Item -LiteralPath $dbPath
$sidecars = @()
foreach ($suf in @("-wal", "-shm")) { if (Test-Path -LiteralPath ($dbPath + $suf)) { $sidecars += $suf } }
$manifest = [ordered]@{
  at = (Get-Date).ToString("o")
  kind = "assetvault-db-backup"
  version = $Version
  outDir = $OutDir
  source = [ordered]@{
    dbPath = $dbPath
    dataDir = $DataDir
    dbBytes = $dbi.Length
    dbMtime = $dbi.LastWriteTime.ToString("o")
    sidecars = $sidecars
  }
  files = $files
  verify = $verifyObj
  verifyOk = $verifyOk
  verifyRaw = $verifyRaw
  activeAtCopyTime = $blockers
  host = [ordered]@{ node = ((& node --version) 2>$null | Out-String).Trim(); powershell = $PSVersionTable.PSVersion.ToString(); machine = $env:COMPUTERNAME }
}
$manifestJson = $manifest | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $OutDir "manifest.json"
Set-Content -LiteralPath $manifestPath -Value $manifestJson -Encoding UTF8

Write-Host ""
Write-Host $manifestJson
Write-Host ("manifest: " + $manifestPath)

# --- cleanup verify temp ---
Remove-Item -LiteralPath $verifyDir -Recurse -Force -ErrorAction SilentlyContinue

if ($DiscardAfterVerify) {
  foreach ($f in $files) { Remove-Item -LiteralPath (Join-Path $OutDir $f.name) -Force -ErrorAction SilentlyContinue }
  Write-Host ("discarded db copies (hashes retained in manifest): " + $OutDir)
}

if ($verifyOk) { exit 0 } else { Write-Host "BACKUP_FAIL verification failed"; exit 5 }
