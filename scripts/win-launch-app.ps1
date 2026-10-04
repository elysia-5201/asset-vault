# Launch the packaged AssetVault (portable, no installer)
$exe = "<drive>:\tool\asset-vault\dist-desktop\win-unpacked\AssetVault.exe"
if (-not (Test-Path $exe)) { Write-Host ("MISSING: " + $exe); exit 1 }
$p = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
Write-Host ("started pid " + $p.Id)
Start-Sleep -Seconds 12
try {
  $h = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:7317/api/health" -TimeoutSec 10
  Write-Host ("health: " + $h.Content.Substring(0, [Math]::Min(140, $h.Content.Length)))
} catch { Write-Host ("health FAILED: " + $_.Exception.Message) }
