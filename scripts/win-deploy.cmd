@echo off
setlocal
set SRC=\\wsl.localhost\<distro>\root\Code\asset-vault
set DST=<drive>:\tool\asset-vault
if not exist "%DST%\NUL" (
  if exist "%DST%" del /f /q "%DST%"
  mkdir "%DST%"
)
echo [1/3] sync source
robocopy "%SRC%" "%DST%" /E /XD node_modules data logs .npm-cache /XF *.log /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
echo ROBOCOPY_SRC_EXIT=%ERRORLEVEL%
echo [2/3] sync data (vault.db + media)
if not exist "%DST%\data\NUL" mkdir "%DST%\data"
robocopy "%SRC%\data" "%DST%\data" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
echo ROBOCOPY_DATA_EXIT=%ERRORLEVEL%
echo [3/3] result
dir /b "%DST%"
echo SOURCE_FILES=%SRC%
echo DONE
