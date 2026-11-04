# sequence-harness.ps1 - offline targeted tests for the release sequence primitives and for
# real -File child-process semantics. Writes only under -WorkDir (a fresh Windows TEMP dir);
# never touches E:\, never connects to 7317, never starts or stops the App.
param(
  [Parameter(Mandatory=$true)][string]$CorePath,
  [Parameter(Mandatory=$true)][string]$WorkDir
)
$ErrorActionPreference = "Stop"
. $CorePath

$script:Total = 0
$script:Failed = 0
function Case([string]$Name, [scriptblock]$Body) {
  $script:Total++
  try { & $Body; "PASS $Name" }
  catch { $script:Failed++; "FAIL $Name :: " + $_.Exception.Message }
}
function Assert-True([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw $Msg } }
function Assert-Eq($Actual, $Expected, [string]$Msg) {
  if ("$Actual" -ne "$Expected") { throw "$Msg : actual=[$Actual] expected=[$Expected]" }
}

$paths = [ordered]@{
  StageRoot = "E:\fake\app\.av-apply-private\.stage-20260101-000000-deadbeef"
  Receipt   = "E:\fake\.av-apply-private\close-receipt-20260101-000000-deadbeef.json"
  Marker    = "E:\fake\app\.av-apply-private\APPLY-OK.json"
}
$steps = New-ReleaseSteps -ManifestPath "M:\manifest.json" -PayloadSource "M:\payload" -Paths $paths -RuntimeDir "M:\runtime" -StageScript "M:\stage.ps1"

Case "C1 fixed order and arguments" {
  $seen = New-Object System.Collections.ArrayList
  $runner = { param($s) [void]$seen.Add(($s.name + "|" + ($s.args -join ","))); return @{ rc = 0 } }.GetNewClosure()
  $r = Invoke-ReleaseSequence -Steps $steps -Runner $runner
  Assert-True $r.ok "ok should be true"
  Assert-Eq $seen.Count 6 "call count"
  Assert-Eq $seen[0] "stage|-ManifestPath,M:\manifest.json,-SrcDir,M:\payload" "stage args"
  Assert-Eq $seen[1] "close|-ManifestPath,M:\manifest.json" "close args"
  Assert-Eq $seen[2] ("backup|-ManifestPath,M:\manifest.json,-ReceiptPath," + $paths.Receipt) "backup args"
  Assert-Eq $seen[3] ("archive|-ManifestPath,M:\manifest.json,-MarkerPath," + $paths.Marker) "archive args"
  Assert-Eq $seen[4] ("apply|-Stage," + $paths.StageRoot + ",-ManifestPath,M:\manifest.json") "apply args"
  Assert-Eq $seen[5] "start|-ManifestPath,M:\manifest.json" "start args"
}

Case "C2 rc!=0 stops the sequence, later steps never run" {
  $seen = New-Object System.Collections.ArrayList
  $runner = { param($s) [void]$seen.Add($s.name); if ($s.name -eq "backup") { return @{ rc = 7 } } return @{ rc = 0 } }.GetNewClosure()
  $r = Invoke-ReleaseSequence -Steps $steps -Runner $runner
  Assert-True (-not $r.ok) "ok should be false"
  Assert-Eq $r.stoppedAt "backup" "stoppedAt"
  Assert-Eq $r.rc 7 "rc"
  Assert-Eq ($seen -join ",") "stage,close,backup" "executed steps"
}

Case "C3 all green runs start exactly once" {
  $seen = New-Object System.Collections.ArrayList
  $runner = { param($s) [void]$seen.Add($s.name); return @{ rc = 0 } }.GetNewClosure()
  $r = Invoke-ReleaseSequence -Steps $steps -Runner $runner
  Assert-True $r.ok "ok"
  Assert-Eq (@($seen | Where-Object { $_ -eq "start" }).Count) 1 "start count"
}

Case "C4 start failure is not retried and not rolled back" {
  $seen = New-Object System.Collections.ArrayList
  $runner = { param($s) [void]$seen.Add($s.name); if ($s.name -eq "start") { return @{ rc = 1 } } return @{ rc = 0 } }.GetNewClosure()
  $r = Invoke-ReleaseSequence -Steps $steps -Runner $runner
  Assert-True (-not $r.ok) "ok should be false"
  Assert-Eq $r.stoppedAt "start" "stoppedAt"
  Assert-Eq (@($seen | Where-Object { $_ -eq "start" }).Count) 1 "start count (no retry)"
  Assert-Eq $seen.Count 6 "no extra calls"
}

Case "C5 a duplicated start step is rejected" {
  $dup = @($steps) + @($steps[5])
  $runner = { param($s) return @{ rc = 0 } }
  $threw = $false
  try { Invoke-ReleaseSequence -Steps $dup -Runner $runner | Out-Null } catch { $threw = $true }
  Assert-True $threw "duplicate start must throw"
}

# ---- real -File child process: exit propagation / stderr / spaces in path / AU-OK closure ----
$spaceDir = Join-Path $WorkDir "with space"
New-Item -ItemType Directory -Path $spaceDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $spaceDir "helper.ps1") -Encoding ASCII -Value @'
function Assert-Under([string]$Path, [string]$Root, [string]$Label) { return "AU-OK" }
'@
Set-Content -LiteralPath (Join-Path $spaceDir "entry.ps1") -Encoding ASCII -Value @'
param([string]$Tag)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "helper.ps1")
$x = Assert-Under "a" "b" "c"
"INNER-RESULT: $x tag=$Tag"
[Console]::Error.WriteLine("boom-stderr")
exit 7
'@
Set-Content -LiteralPath (Join-Path $spaceDir "throw.ps1") -Encoding ASCII -Value @'
$ErrorActionPreference = "Stop"
throw "SCHEMA: marker root missing"
'@
Set-Content -LiteralPath (Join-Path $spaceDir "ok.ps1") -Encoding ASCII -Value @'
"OK-RAN"
exit 0
'@

$logDir = Join-Path $WorkDir "logs"
$runner = New-ProcessRunner -PowerShellPath (Join-Path $PSHOME "powershell.exe") -LogDir $logDir

Case "C6 real -File: closure function visible, exit 7 propagates, stderr captured, path with spaces" {
  $r = & $runner ([ordered]@{ name = "c6"; entry = (Join-Path $spaceDir "entry.ps1"); args = @("-Tag", "x y") })
  Assert-Eq $r.rc 7 "rc"
  Assert-True ($r.stdout -match "INNER-RESULT: AU-OK tag=x y") ("stdout=" + $r.stdout)
  Assert-True ($r.stderr -match "boom-stderr") ("stderr=" + $r.stderr)
}

Case "C7 real -File: thrown exception exits 1 with the message on stderr" {
  $r = & $runner ([ordered]@{ name = "c7"; entry = (Join-Path $spaceDir "throw.ps1"); args = @() })
  Assert-Eq $r.rc 1 "rc"
  Assert-True ($r.stderr -match "SCHEMA: marker root missing") ("stderr=" + $r.stderr)
}

Case "C8 real -File: clean exit is rc 0 and stdout lands on disk" {
  $r = & $runner ([ordered]@{ name = "c8"; entry = (Join-Path $spaceDir "ok.ps1"); args = @() })
  Assert-Eq $r.rc 0 "rc"
  Assert-True ($r.stdout -match "OK-RAN") ("stdout=" + $r.stdout)
  Assert-True (Test-Path -LiteralPath (Join-Path $logDir "c8.out.txt")) "stdout log missing"
  Assert-True (Test-Path -LiteralPath (Join-Path $logDir "c8.rc")) "rc log missing"
}

"PASS n=$script:Total"
"FAIL n=$script:Failed"
if ($script:Failed -ne 0) { exit 1 }
exit 0
