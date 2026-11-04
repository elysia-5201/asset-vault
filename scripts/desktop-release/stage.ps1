
# stage.ps1 (executor) - step 1: CreateNew same-volume stage with the 4 frozen payload bytes.
param(
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$SrcDir
)
$ErrorActionPreference = "Stop"
function Sha([string]$p) { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
$m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$appRoot = [string]$m.appRoot
$dataPrivate = [string]$m.dataPrivate
$appPrivate = Join-Path $appRoot ".av-apply-private"
$stageRoot = Join-Path $appPrivate (".stage-" + [string]$m.stamp + "-" + [string]$m.releaseId)

if (Test-Path -LiteralPath $stageRoot) { throw "STAGE: stage root already exists: $stageRoot" }
New-Item -ItemType Directory -Path $stageRoot -ErrorAction Stop | Out-Null

$rows = New-Object System.Collections.ArrayList
foreach ($p in @($m.payload)) {
  $rel = ([string]$p.rel).Replace("/","\")
  $src = Join-Path $SrcDir $rel
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "STAGE: src missing: $src" }
  $srcLen = (Get-Item -LiteralPath $src).Length
  $srcSha = Sha $src
  if ($srcLen -ne [long]$p.bytes) { throw "STAGE: src length mismatch $($p.rel): $srcLen != $($p.bytes)" }
  if ($srcSha -ne [string]$p.new) { throw "STAGE: src sha mismatch $($p.rel)" }
  $dst = Join-Path $stageRoot $rel
  $parent = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $fs = [IO.File]::Open($dst, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $b = [IO.File]::ReadAllBytes($src); $fs.Write($b,0,$b.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  $dstLen = (Get-Item -LiteralPath $dst).Length
  $dstSha = Sha $dst
  if ($dstLen -ne [long]$p.bytes) { throw "STAGE: dst length mismatch $($p.rel)" }
  if ($dstSha -ne [string]$p.new) { throw "STAGE: dst sha mismatch $($p.rel)" }
  [void]$rows.Add([ordered]@{ rel=[string]$p.rel; bytes=$dstLen; sha256=$dstSha; action=[string]$p.action })
}
$files = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File)
if ($files.Count -ne 4) { throw "STAGE: file count $($files.Count) != 4" }
$want = @{}
foreach ($p in @($m.payload)) { $want[(([string]$p.rel).Replace("/","\"))] = $true }
foreach ($f in $files) {
  $r = $f.FullName.Substring($stageRoot.Length + 1)
  if (-not $want.ContainsKey($r)) { throw "STAGE: unexpected file $r" }
}
[ordered]@{
  status = "STAGED"
  stageRoot = $stageRoot
  count = $files.Count
  files = $rows
} | ConvertTo-Json -Depth 6
exit 0

