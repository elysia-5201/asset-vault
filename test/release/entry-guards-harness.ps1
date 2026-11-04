# entry-guards-harness.ps1 - offline targeted tests for the Execute-path guards added to the
# desktop release entry: LogDir freshness / isolation, Windows argv quoting, per-step stop.
# Writes only under -WorkDir (a fresh Windows TEMP dir); never touches E:\, never connects to
# 7317, never starts or stops the App, never runs a real release step.
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
function Assert-Throws([scriptblock]$Body, [string]$Pattern, [string]$Msg) {
  $threw = $false
  try { & $Body | Out-Null } catch {
    $threw = $true
    if ($_.Exception.Message -notmatch $Pattern) { throw "$Msg : wrong error [$($_.Exception.Message)]" }
  }
  if (-not $threw) { throw "$Msg : did not throw" }
}

if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

# Synthetic plan: pure path data only. Nothing here is a production root.
$plan = [ordered]@{ paths = [ordered]@{
  AppRoot         = (Join-Path $WorkDir "app")
  AppPrivate      = (Join-Path $WorkDir "app\.av-apply-private")
  DataPrivate     = (Join-Path $WorkDir ".av-apply-private")
  StageRoot       = (Join-Path $WorkDir "app\.av-apply-private\.stage-20260101-000000-deadbeef")
  Receipt         = (Join-Path $WorkDir ".av-apply-private\close-receipt-20260101-000000-deadbeef.json")
  BackupReceipt   = (Join-Path $WorkDir ".av-apply-private\db-backup-receipt-20260101-000000-deadbeef.json")
  DbBackupDir     = (Join-Path $WorkDir ".av-apply-private\db-backup-20260101-000000")
  Marker          = (Join-Path $WorkDir "app\.av-apply-private\APPLY-OK.json")
  OldMarkerArchive= (Join-Path $WorkDir "app\.av-apply-private\APPLY-OK.previous-20260101-000000-deadbeef.json")
  BakDir          = (Join-Path $WorkDir "app\.av-apply-private\bak")
}}
$payloadSource = Join-Path $WorkDir "payload"
$runtimeDir = Join-Path $WorkDir "runtime"
$manifestPath = Join-Path $WorkDir "manifest.json"

function Assert-Isolated([string]$LogDir) {
  Assert-LogDirIsolated -LogDir $LogDir -Plan $plan -PayloadSource $payloadSource -RuntimeDir $runtimeDir -ManifestPath $manifestPath
}

# ---- LogDir freshness -------------------------------------------------------
Case "G1 fresh LogDir is accepted" {
  $d = Join-Path $WorkDir "fresh-ok"
  Assert-LogDirFresh $d
  Assert-True (-not (Test-Path -LiteralPath $d)) "fresh check must not create the dir"
}

Case "G2 existing empty LogDir is rejected and preserved" {
  $d = Join-Path $WorkDir "existing-empty"
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  Assert-Throws { Assert-LogDirFresh $d } "LOGDIR" "existing empty dir"
  Assert-True (Test-Path -LiteralPath $d) "existing dir must not be deleted"
  Assert-Eq (@(Get-ChildItem -LiteralPath $d -Force).Count) 0 "existing dir must not be cleared"
}

Case "G3 existing LogDir with evidence is rejected and preserved" {
  $d = Join-Path $WorkDir "existing-full"
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  $f = Join-Path $d "plan.json"
  [IO.File]::WriteAllText($f, "old-evidence", (New-Object Text.UTF8Encoding($false)))
  Assert-Throws { Assert-LogDirFresh $d } "LOGDIR" "existing dir with file"
  Assert-Eq ([IO.File]::ReadAllText($f)) "old-evidence" "old evidence must be untouched"
}

# ---- LogDir isolation -------------------------------------------------------
Case "G4 LogDir equal to AppRoot is rejected" {
  Assert-Throws { Assert-Isolated ([string]$plan.paths.AppRoot) } "LOGDIR" "AppRoot equal"
}
Case "G5 LogDir inside AppRoot is rejected" {
  Assert-Throws { Assert-Isolated (Join-Path ([string]$plan.paths.AppRoot) "data") } "LOGDIR" "AppRoot inside"
}
Case "G6 LogDir ancestor of AppRoot is rejected" {
  Assert-Throws { Assert-Isolated $WorkDir } "LOGDIR" "AppRoot ancestor"
}
Case "G7 LogDir equal to PayloadSource is rejected" {
  Assert-Throws { Assert-Isolated $payloadSource } "LOGDIR" "payload equal"
}
Case "G8 LogDir inside RuntimeDir is rejected" {
  Assert-Throws { Assert-Isolated (Join-Path $runtimeDir "logs") } "LOGDIR" "runtime inside"
}
Case "G9 LogDir equal to StageRoot is rejected" {
  Assert-Throws { Assert-Isolated ([string]$plan.paths.StageRoot) } "LOGDIR" "stage equal"
}
Case "G10 LogDir equal to the manifest file is rejected" {
  Assert-Throws { Assert-Isolated $manifestPath } "LOGDIR" "manifest file equal"
}
Case "G11 LogDir sibling of the manifest is accepted" {
  $d = Join-Path $WorkDir "logs"
  Assert-LogDirFresh $d
  Assert-Isolated $d
}
Case "G12 LogDir sibling prefix app-v2 is not confused with AppRoot" {
  $d = Join-Path $WorkDir "app-v2"
  Assert-LogDirFresh $d
  Assert-Isolated $d
}
Case "G13 LogDir inside the bak tree is rejected" {
  Assert-Throws { Assert-Isolated (Join-Path ([string]$plan.paths.BakDir) "x") } "LOGDIR" "bak inside"
}
Case "G14 LogDir equal to DataRoot is rejected" {
  Assert-Throws { Assert-Isolated (Join-Path $WorkDir "data") } "LOGDIR" "data root equal"
}

# ---- Windows argv quoting: the child must receive the exact value -----------
$qdir = Join-Path $WorkDir "quote"
New-Item -ItemType Directory -Path $qdir -Force | Out-Null
$child = Join-Path $qdir "echo-args.ps1"
$childBody = @'
param([string]$Value)
$b = [Text.Encoding]::UTF8.GetBytes($Value)
[Console]::Out.WriteLine("B64:" + [Convert]::ToBase64String($b))
[Console]::Error.WriteLine("ERR-MARK")
exit 7
'@
[IO.File]::WriteAllText($child, $childBody, (New-Object Text.UTF8Encoding($false)))
$qlog = Join-Path $WorkDir "qlogs"
$qrunner = New-ProcessRunner -PowerShellPath (Join-Path $PSHOME "powershell.exe") -LogDir $qlog

function Assert-QuotedValue([string]$Name, [string]$Value) {
  $r = & $qrunner ([ordered]@{ name = $Name; entry = $child; args = @("-Value", $Value) })
  Assert-Eq $r.rc 7 "rc"
  Assert-True ($r.stderr -match "ERR-MARK") ("stderr=" + $r.stderr)
  $line = @($r.stdout -split "`r?`n" | Where-Object { $_ -like "B64:*" })[0]
  Assert-True ($null -ne $line) ("no B64 line: " + $r.stdout)
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(4)))
  Assert-True ($decoded -ceq $Value) ("value mismatch: [" + $decoded + "] != [" + $Value + "]")
}

Case "G15 space + trailing backslash arrives exactly" {
  Assert-QuotedValue "q15" "C:\tmp\with space\"
}
Case "G16 double trailing backslash arrives exactly" {
  Assert-QuotedValue "q16" "C:\tmp\with space\\"
}
Case "G17 Unicode + space + trailing backslash arrives exactly" {
  Assert-QuotedValue "q17" "C:\tmp\中文 空格\"
}
Case "G18 plain space arrives exactly" {
  Assert-QuotedValue "q18" "plain space"
}
Case "G19 empty value arrives as an empty string" {
  Assert-QuotedValue "q19" ""
}
Case "G20 value without spaces arrives exactly" {
  Assert-QuotedValue "q20" "C:\tmp\no-space"
}
Case "G21 backslashes next to an embedded quote arrive exactly" {
  Assert-QuotedValue "q21" 'C:\tmp\a b\"c'
}

# ---- per-step failure: later steps never run, start at most once ------------
$steps = New-ReleaseSteps -ManifestPath "M:\manifest.json" -PayloadSource "M:\payload" -Paths $plan.paths -RuntimeDir "M:\runtime" -StageScript "M:\stage.ps1"
$order = @("stage", "close", "backup", "archive", "apply", "start")
foreach ($failAt in $order) {
  $idx = [Array]::IndexOf($order, $failAt)
  $expected = ($order[0..$idx]) -join ","
  $expectedStart = if ($failAt -eq "start") { 1 } else { 0 }
  $caseName = "G-step-" + $failAt + " failure stops the sequence"
  Case $caseName {
    $seen = New-Object System.Collections.ArrayList
    $runner = { param($s) [void]$seen.Add($s.name); if ($s.name -eq $failAt) { return @{ rc = 7 } } return @{ rc = 0 } }.GetNewClosure()
    $r = Invoke-ReleaseSequence -Steps $steps -Runner $runner
    Assert-True (-not $r.ok) "ok should be false"
    Assert-Eq $r.stoppedAt $failAt "stoppedAt"
    Assert-Eq $r.rc 7 "rc"
    Assert-Eq ($seen -join ",") $expected "executed steps"
    Assert-Eq (@($seen | Where-Object { $_ -eq "start" }).Count) $expectedStart "start count"
  }.GetNewClosure()
}

"PASS n=$script:Total"
"FAIL n=$script:Failed"
if ($script:Failed -ne 0) { exit 1 }
exit 0
