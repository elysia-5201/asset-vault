<#
.SYNOPSIS
  Snapshot an AssetVault SQLite database (counts/schema/media) for rollback drills.

.DESCRIPTION
  Read-only with respect to the source: copies db + -wal + -shm into a temp dir,
  opens the COPY with better-sqlite3 and records integrity, schema_meta, counts and
  the table list. Optionally hashes a media directory inventory (relative path+size).
  Never opens the source database directly.

.PARAMETER Db
  Source database path (vault.db).

.PARAMETER Out
  Output JSON path.

.PARAMETER AppDir
  Deployed app dir used to resolve better-sqlite3 (default E:\tool\asset-vault).

.PARAMETER MediaDir
  Optional media dir; adds {count,bytes,hash} to the snapshot.

.EXAMPLE
  powershell -File scripts\win-db-snapshot.ps1 -Database E:\tool\av-aud02\data-s1\vault.db -Out E:\tool\av-aud02\s1-before.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Database,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$AppDir = "E:\tool\asset-vault",
  [string]$MediaDir = ""
)

$ErrorActionPreference = "Stop"
function Fail([string]$m) { Write-Error $m; exit 1 }

$dbFull = [IO.Path]::GetFullPath($Database)
if (-not (Test-Path -LiteralPath $dbFull)) { Fail ("db not found: " + $dbFull) }
$outFull = [IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$tmp = Join-Path $env:TEMP ("av-db-snapshot-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$copied = @()
foreach ($suf in @("", "-wal", "-shm")) {
  $src = $dbFull + $suf
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $tmp ("vault.db" + $suf)) -Force
    $copied += $suf
  }
}

$js = @'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const out = {};
out.integrity = db.pragma("integrity_check", { simple: true });
out.journalMode = db.pragma("journal_mode", { simple: true });
out.meta = {};
for (const r of db.prepare("SELECT key, value FROM schema_meta").all()) out.meta[r.key] = r.value;
out.counts = db.prepare("SELECT "
  + "(SELECT COUNT(*) FROM items) items,"
  + "(SELECT COUNT(*) FROM assets) assets,"
  + "(SELECT COUNT(*) FROM jobs) jobs,"
  + "(SELECT COUNT(*) FROM item_images) images,"
  + "(SELECT COUNT(*) FROM categories) categories,"
  + "(SELECT COUNT(*) FROM tags) tags,"
  + "(SELECT COUNT(*) FROM collection_items) collection_items,"
  + "(SELECT COUNT(*) FROM asset_avatars) asset_avatars,"
  + "(SELECT COUNT(*) FROM item_avatars) item_avatars").get();
out.tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
db.close();
console.log(JSON.stringify(out));
'@
$jsPath = Join-Path $tmp "snapshot.cjs"
Set-Content -LiteralPath $jsPath -Value $js -Encoding ASCII

$oldNodePath = $env:NODE_PATH
$env:NODE_PATH = Join-Path $AppDir "node_modules"
$raw = ""
$exit = 1
Push-Location $AppDir
try {
  $raw = ((& node $jsPath (Join-Path $tmp "vault.db")) 2>&1 | Out-String).Trim()
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
  if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
}
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($exit -ne 0) { Fail ("better-sqlite3 snapshot failed: " + $raw) }
$verify = $raw | ConvertFrom-Json

$dbHash = (Get-FileHash -LiteralPath $dbFull -Algorithm SHA256).Hash.ToLower()
$sizes = @{}
foreach ($suf in @("", "-wal", "-shm")) { $p = $dbFull + $suf; if (Test-Path -LiteralPath $p) { $sizes[$suf] = (Get-Item -LiteralPath $p).Length } }
# ConvertTo-Json cannot serialise an empty property name, so keep a named map for sidecars.
$sidecarBytes = [ordered]@{}
foreach ($suf in @("-wal", "-shm")) { if ($sizes.ContainsKey($suf)) { $sidecarBytes[$suf] = $sizes[$suf] } }

$media = $null
if ($MediaDir -ne "" -and (Test-Path -LiteralPath $MediaDir)) {
  $root = [IO.Path]::GetFullPath($MediaDir)
  $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($root.Length).Replace("\", "/") + ":" + $_.Length } | Sort-Object)
  $joined = [string]::Join([char]10, $lines)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($joined))).Replace("-", "").ToLower()
  } finally { $sha.Dispose() }
  $media = [ordered]@{ dir = $root; count = $lines.Count; bytes = (($lines | ForEach-Object { [int64]($_.Split(":")[-1]) } | Measure-Object -Sum).Sum); hash = $hash }
}

$snapshot = [ordered]@{
  at = (Get-Date).ToString("o")
  db = $dbFull
  dbBytes = $sizes[""]
  dbSha256 = $dbHash
  sidecars = @($sizes.Keys | Where-Object { $_ -ne "" })
  sidecarBytes = $sidecarBytes
  verify = $verify
  media = $media
}
$json = $snapshot | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $outFull -Value $json -Encoding UTF8
Write-Host ($json)
Write-Host ("SNAPSHOT_OK " + $outFull)
exit 0
