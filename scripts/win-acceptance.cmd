@echo off
setlocal EnableExtensions
rem =====================================================================
rem Run the AssetVault acceptance scripts on Windows.
rem
rem The acceptance scripts call spawnSync("python3") to build their fixtures.
rem On Windows "python3" is a WindowsApps stub and Node cannot execute a .cmd
rem shim (spawnSync returns status 9009), so this wrapper provides a real
rem executable: it copies the py.exe launcher to %TEMP%\av-py3-shim\python3.exe
rem and prepends that directory to PATH. The acceptance scripts are reused
rem unchanged.
rem
rem Usage: scripts\win-acceptance.cmd [pipeline|preview|categories|all]
rem Evidence: %APPDIR%\logs\v061\accept-<name>.log
rem =====================================================================
set "WHAT=%~1"
if not defined WHAT set "WHAT=all"
set "APPDIR=%~dp0.."
if defined AV_APPDIR set "APPDIR=%AV_APPDIR%"
cd /d "%APPDIR%"
set "EV=%APPDIR%\logs\v061"
if not exist "%EV%" mkdir "%EV%" >nul 2>nul

set "SHIM=%TEMP%\av-py3-shim"
if not exist "%SHIM%" mkdir "%SHIM%" >nul 2>nul
if exist "%SHIM%\python3.cmd" del /q "%SHIM%\python3.cmd" >nul 2>nul
powershell -NoProfile -Command "$p=(Get-Command py.exe -ErrorAction SilentlyContinue).Source; if($p){Copy-Item -LiteralPath $p -Destination (Join-Path $env:TEMP 'av-py3-shim\python3.exe') -Force; exit 0}; exit 1" >nul 2>&1
if errorlevel 1 (
  echo AV_ACCEPT_FAIL python launcher py.exe not found; Python 3 is required
  exit /b 3
)
"%SHIM%\python3.exe" -V >nul 2>&1
if errorlevel 1 (
  echo AV_ACCEPT_FAIL python3 shim does not run; check "py -3 -V" manually
  exit /b 3
)
set "PATH=%SHIM%;%PATH%"
echo AV_ACCEPT appdir=%APPDIR%
echo AV_ACCEPT evidence=%EV%
echo AV_ACCEPT what=%WHAT%

set "FAILED=0"
if /i "%WHAT%"=="all" goto :all
if /i "%WHAT%"=="pipeline" goto :only_pipeline
if /i "%WHAT%"=="preview" goto :only_preview
if /i "%WHAT%"=="categories" goto :only_categories
echo AV_ACCEPT_FAIL unknown target: %WHAT%
exit /b 2

:all
call :run pipeline scripts\acceptance-pipeline.mjs
if errorlevel 1 set "FAILED=1"
call :run preview scripts\acceptance-scan-preview.mjs
if errorlevel 1 set "FAILED=1"
call :run categories scripts\acceptance-categories.mjs
if errorlevel 1 set "FAILED=1"
goto :finish

:only_pipeline
call :run pipeline scripts\acceptance-pipeline.mjs
if errorlevel 1 set "FAILED=1"
goto :finish

:only_preview
call :run preview scripts\acceptance-scan-preview.mjs
if errorlevel 1 set "FAILED=1"
goto :finish

:only_categories
call :run categories scripts\acceptance-categories.mjs
if errorlevel 1 set "FAILED=1"
goto :finish

:finish
echo AV_ACCEPT_FAILED=%FAILED%
if "%FAILED%"=="1" exit /b 1
exit /b 0

:run
set "NAME=%~1"
set "SCRIPT=%~2"
echo ==== %NAME% ====
set "LOGF=%EV%\accept-%NAME%.log"
node --import tsx "%SCRIPT%" > "%LOGF%" 2>&1
set "RC=%ERRORLEVEL%"
findstr /R /C:"PASS" /C:"FAIL" /C:"=====" "%LOGF%"
echo %NAME%_EXIT=%RC% log=%LOGF%
exit /b %RC%
