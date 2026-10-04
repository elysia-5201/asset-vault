@echo off
rem AssetVault launcher (Windows). 双击即可启动，浏览器打开 http://127.0.0.1:7317
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist data mkdir data
echo [AssetVault] starting on http://127.0.0.1:7317  (log: logs\server.out)
node --import tsx apps\server\src\main.ts >> logs\server.out 2>&1
