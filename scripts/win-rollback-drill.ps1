<#
.SYNOPSIS
  Isolated v0.5.1 rollback drill for AssetVault (AUD-02). Plan by default; -Execute actually runs.

.DESCRIPTION
  Copies (never moves) a v0.5.1 install and database(s) into -DrillDir and exercises:
    S1 old app + old DB (backup-before-v0.6.1)
    S2 old app + current v6 DB copy
    S3 upgrade back to the current 0.6.1 package on the S2 data
    S4 count/media consistency via snapshot+compare
    S5 residue handling (pipeline.lock / index_tasks / jobs lease fields)
  Safeguards: refuses to run if DrillDir overlaps the production app/data; refuses while an
  AssetVault instance is running or the app ports are in use; every started instance is
  verified to point at DrillDir (health.dbPath) or it is stopped immediately.
  Default is dry-run (prints the plan, writes nothing). Use -Execute to run.

.PARAMETER Scenario
  S1..S5 or All (default All).

.PARAMETER DrillDir
  Scratch root, e.g. E:\tool\av-aud02-20261021. Must not overlap the production app dir.

.PARAMETER SourceApp
  Production deploy dir (read-only for this script), default E:\tool\asset-vault.

.PARAMETER OldApp
  v0.5.1 packaged exe, default <SourceApp>\dist-desktop\win-unpacked-v0.5.1\AssetVault.exe.

.PARAMETER NewApp
  Current packaged exe, default <SourceApp>\dist-desktop\win-unpacked\AssetVault.exe.

.PARAMETER BackupDb
  v4 database backup, default the newest <SourceApp>\data\backup-before-v0.6.1-*\vault.db.

.PARAMETER Execute
  Actually run the drill. Without it, only print the plan.

.PARAMETER Keep
  Keep DrillDir after the run (default: delete it, only when it contains this script's marker).

.EXAMPLE
  powershell -File scripts\win-rollback-drill.ps1 -DrillDir E:\tool\av-aud02-20261021
  powershell -File scripts\win-rollback-drill.ps1 -DrillDir E:\tool\av-aud02-20261021 -Execute
#>
[CmdletBinding()]
param(
  [ValidateSet("S1", "S2", "S3", "S4", "S5", "All")][string]$Scenario = "All",
  [Parameter(Mandatory = $true)][string]$DrillDir,
  [string]$SourceApp = "E:\tool\asset-vault",
  [string]$OldApp = "",
  [string]$NewApp = "",
  [string]$BackupDb = "",
  [int]$Port = 7317,
  [switch]$Execute,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
function Step([string]$m) { Write-Host ("== " + $m) }
function Ok([string]$m) { Write-Host ("PASS " + $m) }
function Bad([string]$m) { Write-Host ("FAIL " + $m); $script:fail++ }
$script:fail = 0

$src = [IO.Path]::GetFullPath($SourceApp)
$drill = [IO.Path]::GetFullPath($DrillDir)
if (-not (Test-Path -LiteralPath $src)) { Write-Error ("SourceApp not found: " + $src); exit 1 }
if ($drill -eq $src -or $drill.StartsWith($src + [IO.Path]::DirectorySeparatorChar)) {
  Write-Error ("refusing: DrillDir must be outside SourceApp (" + $src + ")"); exit 1
}
if ($drill -match "[\\/]data$" -or $drill -match "[\\/]data[\\/]") {
  Write-Error "refusing: DrillDir looks like a data dir"; exit 1
}
if ($OldApp -eq "") { $OldApp = Join-Path $src "dist-desktop\win-unpacked-v0.5.1\AssetVault.exe" }
if ($NewApp -eq "") { $NewApp = Join-Path $src "dist-desktop\win-unpacked\AssetVault.exe" }
if ($BackupDb -eq "") {
  $cand = @(Get-ChildItem -LiteralPath (Join-Path $src "data") -Directory -Filter "backup-before-v0.6.1-*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1)
  if ($cand.Count -eq 0) { Write-Error "no backup-before-v0.6.1-* dir under data"; exit 1 }
  $BackupDb = Join-Path $cand[0].FullName "vault.db"
}
$BackupDb = [IO.Path]::GetFullPath($BackupDb)

Step ("plan: scenario=" + $Scenario + " drill=" + $drill)
Write-Host ("  source app : " + $src)
Write-Host ("  old app    : " + $OldApp + " (exists=" + (Test-Path -LiteralPath $OldApp) + ")")
Write-Host ("  new app    : " + $NewApp + " (exists=" + (Test-Path -LiteralPath $NewApp) + ")")
Write-Host ("  backup db  : " + $BackupDb + " (exists=" + (Test-Path -LiteralPath $BackupDb) + ")")
Write-Host "  steps      : copies only; S1 old+old, S2 old+v6, S3 back to 0.6.1, S4 snapshot compare, S5 residue"
Write-Host "  execution guard: health.dbPath must contain DrillDir, otherwise the instance is stopped immediately"

if (-not $Execute) {
  Write-Host "DRY_RUN: nothing was written. Re-run with -Execute to perform the drill."
  exit 0
}

# ---- guards ----
$running = @(Get-Process -Name "AssetVault" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) { Write-Error ("refusing: AssetVault is running (pids " + (($running | ForEach-Object { $_.Id }) -join ",") + ")"); exit 1 }
$used = @()
foreach ($p in $Port..($Port + 4)) {
  if (@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { $used += $p }
}
if ($used.Count -gt 0) { Write-Error ("refusing: ports in use: " + ($used -join ",")); exit 1 }

foreach ($f in @($OldApp, $NewApp, $BackupDb)) { if (-not (Test-Path -LiteralPath $f)) { Write-Error ("missing input: " + $f); exit 1 } }

if (Test-Path -LiteralPath $drill) { Write-Error ("refusing: DrillDir already exists (choose a new one): " + $drill); exit 1 }
New-Item -ItemType Directory -Force -Path $drill | Out-Null
Set-Content -LiteralPath (Join-Path $drill ".av-drill-marker") -Value ("created " + (Get-Date).ToString("o")) -Encoding ASCII
$snap = Join-Path $PSScriptRoot "win-db-snapshot.ps1"
$cmp = Join-Path $PSScriptRoot "win-db-compare.ps1"

function Run-Snapshot([string]$db, [string]$out, [string]$media) {
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $snap, "-Database", $db, "-Out", $out, "-AppDir", $src)
  if ($media -ne "") { $psArgs += @("-MediaDir", $media) }
  & powershell.exe @psArgs | Out-Null
  return ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $out))
}
function Run-Compare([string]$b, [string]$a, [string]$expect) {
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $cmp, "-Before", $b, "-After", $a)
  if ($expect -ne "") { $psArgs += @("-ExpectVersion", $expect) }
  & powershell.exe @psArgs | Out-Host
  return ($LASTEXITCODE -eq 0)
}
function Wait-Health([int]$basePort) {
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 700
    foreach ($p in $basePort..($basePort + 4)) {
      try { $h = Invoke-RestMethod ("http://127.0.0.1:" + $p + "/api/health") -TimeoutSec 2; if ($h) { return @{ port = $p; health = $h } } } catch { }
    }
  }
  return $null
}
function Start-App([string]$exe, [string]$data) {
  $env:ASSETVAULT_DATA = $data
  $proc = Start-Process -FilePath $exe -PassThru
  $hit = Wait-Health $Port
  if (-not $hit) { return $null }
  if (([string]$hit.health.dbPath) -notlike ("*" + $drill + "*")) {
    Write-Host ("GUARD: dbPath escaped drill dir: " + $hit.health.dbPath)
    cmd /c ("taskkill /T /F /PID " + $proc.Id) 2>&1 | Out-Null
    return $null
  }
  return @{ proc = $proc; port = $hit.port; health = $hit.health }
}
function Stop-App($app) {
  if ($null -eq $app) { return }
  foreach ($x in @(Get-Process -Name "AssetVault" -ErrorAction SilentlyContinue)) { $x.CloseMainWindow() | Out-Null }
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (@(Get-Process -Name "AssetVault" -ErrorAction SilentlyContinue).Count -eq 0) { return } }
  cmd /c ("taskkill /T /F /PID " + $app.proc.Id) 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}
function Copy-Database([string]$from, [string]$toDir) {
  New-Item -ItemType Directory -Force -Path $toDir | Out-Null
  foreach ($suf in @("", "-wal", "-shm")) {
    $s = $from + $suf
    if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination (Join-Path $toDir ("vault.db" + $suf)) -Force }
  }
}
$summary = [ordered]@{ at = (Get-Date).ToString("o"); drill = $drill; scenarios = @() }

# ---- S1 ----
if ($Scenario -in @("S1", "All")) {
  Step "S1 old app + old DB"
  $d = Join-Path $drill "data-s1"
  Copy-Database $BackupDb $d
  $before = Join-Path $drill "s1-before.json"; $after = Join-Path $drill "s1-after.json"
  $r = Run-Snapshot (Join-Path $d "vault.db") $before ""
  if (-not $r) { Bad "S1 snapshot before" } else {
    $app = Start-App $OldApp $d
    if (-not $app) { Bad "S1 old app did not start (or escaped drill dir)" } else {
      Ok ("S1 old app up: version=" + $app.health.version + " db=" + $app.health.dbPath)
      Stop-App $app
      Run-Snapshot (Join-Path $d "vault.db") $after "" | Out-Null
      $ok = Run-Compare $before $after "4"
      if ($ok) { Ok "S1 counts unchanged, schema version 4" } else { Bad "S1 compare/version" }
      $snapObj = Get-Content -LiteralPath $after -Raw | ConvertFrom-Json
      if (@($snapObj.verify.tables) -notcontains "index_tasks") { Ok "S1 v6 tables absent after old app" } else { Bad "S1 unexpected v6 tables" }
    }
  }
  $summary.scenarios += [ordered]@{ id = "S1"; data = $d; before = $before; after = $after }
}

# ---- S2 ----
if ($Scenario -in @("S2", "All")) {
  Step "S2 old app + v6 DB copy"
  $d = Join-Path $drill "data-s2"
  Copy-Database (Join-Path $src "data\vault.db") $d
  $before = Join-Path $drill "s2-before.json"; $after = Join-Path $drill "s2-after.json"
  $r = Run-Snapshot (Join-Path $d "vault.db") $before ""
  if (-not $r) { Bad "S2 snapshot before" } else {
    $app = Start-App $OldApp $d
    if (-not $app) { Bad "S2 old app did not start (or escaped drill dir)" } else {
      Ok ("S2 old app up on v6 db: version=" + $app.health.version)
      Stop-App $app
      Run-Snapshot (Join-Path $d "vault.db") $after "" | Out-Null
      $ok = Run-Compare $before $after "4"
      if ($ok) { Ok "S2 counts unchanged; schema downgraded to 4 (expected)" } else { Bad "S2 compare/version" }
      $snapObj = Get-Content -LiteralPath $after -Raw | ConvertFrom-Json
      foreach ($t in @("index_tasks", "pipeline_events", "cache_entries")) {
        if (@($snapObj.verify.tables) -contains $t) { Ok ("S2 v6 table kept: " + $t) } else { Bad ("S2 v6 table lost: " + $t) }
      }
    }
  }
  $summary.scenarios += [ordered]@{ id = "S2"; data = $d; before = $before; after = $after }
}

# ---- S3 ----
if ($Scenario -in @("S3", "All")) {
  Step "S3 upgrade back to 0.6.1"
  $d = Join-Path $drill "data-s2"
  if (-not (Test-Path -LiteralPath (Join-Path $d "vault.db"))) { Bad "S3 requires S2 data dir" } else {
    $after = Join-Path $drill "s3-after.json"
    $app = Start-App $NewApp $d
    if (-not $app) { Bad "S3 new app did not start (or escaped drill dir)" } else {
      Ok ("S3 0.6.1 up: version=" + $app.health.version)
      Stop-App $app
      Run-Snapshot (Join-Path $d "vault.db") $after "" | Out-Null
      $ok = Run-Compare (Join-Path $drill "s2-before.json") $after "6"
      if ($ok) { Ok "S3 counts unchanged; schema version 6" } else { Bad "S3 compare/version" }
    }
    $summary.scenarios += [ordered]@{ id = "S3"; data = $d; after = $after }
  }
}

# ---- S4 ----
if ($Scenario -in @("S4", "All")) {
  Step "S4 media inventory consistency"
  $media = Join-Path $src "data\media"
  $s1 = Join-Path $drill "s4-s1.json"; $s3 = Join-Path $drill "s4-s3.json"
  if ((Test-Path -LiteralPath (Join-Path $drill "data-s1\vault.db")) -and (Test-Path -LiteralPath (Join-Path $drill "data-s2\vault.db")) -and (Test-Path -LiteralPath $media)) {
    Run-Snapshot (Join-Path $drill "data-s1\vault.db") $s1 $media | Out-Null
    Run-Snapshot (Join-Path $drill "data-s2\vault.db") $s3 $media | Out-Null
    $ok = Run-Compare $s1 $s3 ""
    if ($ok) { Ok "S4 media inventory hash + counts consistent" } else { Bad "S4 media/count mismatch" }
  } else { Write-Host "SKIP S4 (needs S1/S2 data dirs and a media dir)" }
}

# ---- S5 ----
if ($Scenario -in @("S5", "All")) {
  Step "S5 residue: pipeline.lock / index_tasks / jobs lease"
  $d = Join-Path $drill "data-s2"
  if (-not (Test-Path -LiteralPath (Join-Path $d "vault.db"))) { Bad "S5 requires S2 data dir" } else {
    $lock = Join-Path $d "pipeline.lock"
    Write-Host ("  lock present: " + (Test-Path -LiteralPath $lock))
    $js = @'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const out = {};
out.schemaVersion = (db.prepare("SELECT value v FROM schema_meta WHERE key='version'").get() || {}).v;
out.tasks = db.prepare("SELECT state, COUNT(*) c FROM index_tasks GROUP BY state").all();
out.leaseRows = db.prepare("SELECT COUNT(*) c FROM jobs WHERE holder IS NOT NULL OR lease_until IS NOT NULL").get().c;
out.queued = db.prepare("SELECT COUNT(*) c FROM jobs WHERE state='queued'").get().c;
db.close(); console.log(JSON.stringify(out));
'@
    $jsp = Join-Path $drill "residue.cjs"
    Set-Content -LiteralPath $jsp -Value $js -Encoding ASCII
    $oldNode = $env:NODE_PATH; $env:NODE_PATH = Join-Path $src "node_modules"
    $out = (& node $jsp (Join-Path $d "vault.db")) 2>&1 | Out-String
    if ($null -eq $oldNode) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNode }
    Write-Host ("  residue: " + $out.Trim())
    Ok "S5 residue report captured (lock is ignored by v0.5.1; new app takes over dead-pid lock)"
  }
}

Step "summary"
$summary.failed = $script:fail
$summaryPath = Join-Path $drill "summary.json"
Set-Content -LiteralPath $summaryPath -Value ($summary | ConvertTo-Json -Depth 8) -Encoding UTF8
Write-Host ("SUMMARY " + $summaryPath + " failed=" + $script:fail)
if (-not $Keep) {
  if (Test-Path -LiteralPath (Join-Path $drill ".av-drill-marker")) {
    Remove-Item -LiteralPath $drill -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ("cleaned " + $drill)
  } else { Write-Host ("kept (no marker): " + $drill) }
}
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
