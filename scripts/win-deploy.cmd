@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem =====================================================================
rem AssetVault Windows deploy: preflight -> DB backup -> source sync.
rem
rem Syncs %AV_SRC% (WSL source tree) into %AV_DST% with robocopy /MIR while
rem keeping node_modules, data, data-dev, logs, .npm-cache, dist-desktop and
rem .git untouched. The database backup (vault.db + -wal + -shm) runs first.
rem
rem /MIR (not /E) on purpose: /E only adds, so retired files accumulate in
rem %AV_DST% (e.g. old hashed bundles under apps\web\dist\assets), which makes
rem "which build is actually loaded" undecidable. dist-desktop is excluded
rem because it is a build product that does not exist in the WSL source tree.
rem
rem data/ is NOT synced: the WSL data dir is a dev sandbox and must never
rem overwrite the Windows production database. Migration is done by the app.
rem
rem Env overrides:
rem   AV_DISTRO         WSL distro name        (default Ubuntu-26.04-LTS)
rem   AV_DRIVE          Windows drive letter   (default E)
rem   AV_SRC            source path            (default \\wsl.localhost\%AV_DISTRO%\root\Code\asset-vault)
rem   AV_DST            deploy path            (default %AV_DRIVE%:\tool\asset-vault)
rem   AV_SKIP_BACKUP=1   skip DB backup (not recommended)
rem   AV_NO_PREFLIGHT=1  skip preflight (not recommended)
rem
rem Usage (from cmd, not PowerShell): scripts\win-deploy.cmd
rem =====================================================================
if /i "%~1"=="--run" goto :body

rem Self-copy before syncing: robocopy /MIR overwrites this file, and a batch
rem file must not be rewritten while cmd is reading it line by line.
set "SELF=%TEMP%\av-deploy-%RANDOM%%RANDOM%.cmd"
copy /y "%~f0" "%SELF%" >nul
call "%SELF%" --run %*
set "RC=%ERRORLEVEL%"
del "%SELF%" >nul 2>nul
exit /b %RC%

:body
if not defined AV_DISTRO set "AV_DISTRO=Ubuntu-26.04-LTS"
if not defined AV_DRIVE set "AV_DRIVE=E"
if not defined AV_DST set "AV_DST=%AV_DRIVE%:\tool\asset-vault"
if not defined AV_SRC set "AV_SRC=\\wsl.localhost\%AV_DISTRO%\root\Code\asset-vault"

set "TMPV=%TEMP%\av-deploy-value.txt"
powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" > "%TMPV%" 2>nul
set "STAMP="
set /p STAMP=<"%TMPV%"
del "%TMPV%" >nul 2>nul
if not defined STAMP set "STAMP=unknown"
if not exist "%AV_DST%\logs\v061" mkdir "%AV_DST%\logs\v061" >nul 2>nul
set "LOG=%AV_DST%\logs\v061\deploy-%STAMP%.log"

echo ==== AssetVault deploy ==== >>"%LOG%"
echo at=%DATE% %TIME% >>"%LOG%"
echo src=%AV_SRC% >>"%LOG%"
echo dst=%AV_DST% >>"%LOG%"

rem ---------- 1. fetch helper scripts into TEMP ----------
echo [1/5] fetch helper scripts >>"%LOG%"
robocopy "%AV_SRC%\scripts" "%TEMP%\av-deploy" win-preflight.ps1 win-backup.ps1 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1
echo helper_scripts_rc=!ERRORLEVEL! >>"%LOG%"

rem ---------- 2. source version ----------
set "SRCVER="
powershell -NoProfile -Command "(Get-Content -LiteralPath '%AV_SRC%\package.json' -Raw | ConvertFrom-Json).version" > "%TMPV%" 2>nul
set /p SRCVER=<"%TMPV%"
del "%TMPV%" >nul 2>nul
echo [2/5] source_version=!SRCVER! >>"%LOG%"
if not defined SRCVER (
  echo DEPLOY_FAIL cannot read source version >>"%LOG%"
  goto :done
)

rem ---------- 3. preflight ----------
if defined AV_NO_PREFLIGHT goto :skip_preflight
echo [3/5] preflight >>"%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\av-deploy\win-preflight.ps1" -AppDir "%AV_DST%" -EvidenceDir "%AV_DST%\logs\v061" >>"%LOG%" 2>&1
echo preflight_rc=!ERRORLEVEL! >>"%LOG%"
if errorlevel 1 (
  echo DEPLOY_FAIL preflight blocked >>"%LOG%"
  goto :done
)
goto :after_preflight
:skip_preflight
echo [3/5] preflight SKIPPED >>"%LOG%"
:after_preflight

rem ---------- 4. database backup ----------
if defined AV_SKIP_BACKUP goto :skip_backup
echo [4/5] database backup >>"%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\av-deploy\win-backup.ps1" -Version "!SRCVER!" -AppDir "%AV_DST%" >>"%LOG%" 2>&1
echo backup_rc=!ERRORLEVEL! >>"%LOG%"
if errorlevel 1 (
  echo DEPLOY_FAIL database backup failed >>"%LOG%"
  goto :done
)
goto :after_backup
:skip_backup
echo [4/5] database backup SKIPPED >>"%LOG%"
:after_backup

rem ---------- 5. sync source tree ----------
echo [5/5] robocopy /MIR >>"%LOG%"
robocopy "%AV_SRC%" "%AV_DST%" /MIR /XD node_modules data data-dev logs .npm-cache dist-desktop .git rollback-v0.5.1 /XF *.log /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1
set "SYNC_RC=!ERRORLEVEL!"
echo sync_rc=!SYNC_RC! >>"%LOG%"
if !SYNC_RC! GEQ 8 (
  echo DEPLOY_FAIL robocopy rc=!SYNC_RC! >>"%LOG%"
  goto :done
)

set "DSTVER="
powershell -NoProfile -Command "(Get-Content -LiteralPath '%AV_DST%\package.json' -Raw | ConvertFrom-Json).version" > "%TMPV%" 2>nul
set /p DSTVER=<"%TMPV%"
del "%TMPV%" >nul 2>nul
echo dst_version=!DSTVER! >>"%LOG%"
for %%f in ("%AV_DST%\apps\desktop\build\server.mjs" "%AV_DST%\apps\web\dist\index.html") do (
  if exist "%%~f" (echo artifact %%~nxf bytes=%%~zf >>"%LOG%") else (echo DEPLOY_WARN missing %%~f >>"%LOG%")
)
echo DEPLOY_DONE src_version=!SRCVER! dst_version=!DSTVER! >>"%LOG%"

:done
echo ==== log tail ==== >>"%LOG%"
type "%LOG%"
if not defined DSTVER exit /b 1
if not defined SRCVER exit /b 1
if /i "!DSTVER!"=="!SRCVER!" exit /b 0
exit /b 1
