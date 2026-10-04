@echo off
rem Stop AssetVault (match by command line so other node processes survive)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*apps\server\src\main.ts*' } | ForEach-Object { Write-Host ('stopping pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo done
