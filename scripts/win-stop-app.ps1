# Stop AssetVault: node server (main.ts) + packaged Electron app
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*apps\server\src\main.ts*' } |
  ForEach-Object { Write-Host ("stopping node pid " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }
Get-Process AssetVault | ForEach-Object { Write-Host ("stopping app pid " + $_.Id); Stop-Process -Id $_.Id -Force }
Start-Sleep -Seconds 2
$alive = (Get-Process AssetVault -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ("remaining AssetVault processes: " + $alive)
