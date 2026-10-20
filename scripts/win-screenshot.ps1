<#
.SYNOPSIS
  Capture a screenshot of the AssetVault window (or the whole screen).

.DESCRIPTION
  Finds the app window by process id or process name, captures it with
  PrintWindow(PW_RENDERFULLCONTENT). If the result is nearly black (GPU
  compositing), falls back to CopyFromScreen of the same window rect.
  Writes a PNG plus a JSON sidecar (pid, hwnd, title, size, method) into -OutDir.
  Only the app window is captured unless -FullScreen is given.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-screenshot.ps1 -Name ui-main
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-screenshot.ps1 -Name ui-main -ProcessId 1234
#>
param(
  [string]$OutDir = "E:\tool\asset-vault\logs\v061",
  [string]$Name = "ui",
  [int]$ProcessId = 0,
  [string]$ProcessName = "AssetVault",
  [int]$WaitSeconds = 20,
  [switch]$FullScreen
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AvShot {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

function Find-AppWindow {
  param([int]$PidWanted, [string]$NameWanted)
  if ($PidWanted -gt 0) {
    $p = Get-Process -Id $PidWanted -ErrorAction SilentlyContinue
    if ($p) { $p.Refresh(); return $p }
    return $null
  }
  $list = @(Get-Process -Name $NameWanted -ErrorAction SilentlyContinue)
  foreach ($p in $list) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p }
  }
  if ($list.Count -gt 0) { return $list[0] }
  return $null
}

$proc = $null
$deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
while ($true) {
  $proc = Find-AppWindow -PidWanted $ProcessId -NameWanted $ProcessName
  if ($proc -ne $null) {
    $proc.Refresh()
    if ($FullScreen -or $proc.MainWindowHandle -ne [IntPtr]::Zero) { break }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 500
}
if ($proc -eq $null) {
  Write-Host ("SCREENSHOT_FAIL no process (name=" + $ProcessName + " pid=" + $ProcessId + ")")
  exit 2
}
$proc.Refresh()
$hwnd = $proc.MainWindowHandle
$title = $proc.MainWindowTitle

function Test-Dark {
  param([System.Drawing.Bitmap]$Bmp)
  $lit = 0
  $total = 0
  for ($x = 10; $x -lt $Bmp.Width; $x += 50) {
    for ($y = 10; $y -lt $Bmp.Height; $y += 50) {
      $c = $Bmp.GetPixel($x, $y)
      if (($c.R + $c.G + $c.B) -gt 24) { $lit++ }
      $total++
    }
  }
  if ($total -eq 0) { return $true }
  return ($lit -eq 0)
}

$method = ""
$bmp = $null
if ($FullScreen) {
  $vr = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vr.Width, $vr.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vr.Left, $vr.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $method = "fullscreen"
} else {
  if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host ("SCREENSHOT_FAIL no MainWindowHandle pid=" + $proc.Id + " title=" + $title)
    exit 3
  }
  $rect = [AvShot+RECT]::new()
  [void][AvShot]::GetWindowRect($hwnd, [ref]$rect)
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) {
    Write-Host ("SCREENSHOT_FAIL bad window rect " + $w + "x" + $h)
    exit 4
  }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [AvShot]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $method = "printwindow"
  if ((-not $ok) -or (Test-Dark -Bmp $bmp)) {
    $bmp.Dispose()
    [void][AvShot]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    $method = "copyfromscreen"
  }
}

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$outFile = Join-Path $OutDir ($Name + "-" + $stamp + ".png")
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$meta = [ordered]@{
  at = (Get-Date).ToString("o")
  outFile = $outFile
  pid = $proc.Id
  hwnd = $hwnd.ToInt64()
  title = $title
  width = $bmp.Width
  height = $bmp.Height
  method = $method
  bytes = (Get-Item -LiteralPath $outFile).Length
}
$bmp.Dispose()
$metaPath = Join-Path $OutDir ($Name + "-" + $stamp + ".json")
$metaJson = $meta | ConvertTo-Json
Set-Content -LiteralPath $metaPath -Value $metaJson -Encoding UTF8
Write-Host $metaJson
Write-Host ("SCREENSHOT_OK " + $outFile)
exit 0
