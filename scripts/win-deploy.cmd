@echo off
setlocal
set SRC=\\wsl.localhost\<distro>\root\Code\asset-vault
set DST=<drive>:\tool\asset-vault
if not exist "%DST%\NUL" (
  if exist "%DST%" del /f /q "%DST%"
  mkdir "%DST%"
)
echo [1/3] sync source
rem /MIR（而不是 /E）：/E 只加不删，会在 DST 累积废弃文件——实测 apps\web\dist\assets 里攒了 19 个旧 hash 的 js（≈5.6MB），
rem 而且旧 hash 残留会让"到底加载的是哪一版"变得不可判断。
rem dist-desktop 必须排除：那是打包产物（win-unpacked），WSL 侧没有，/MIR 会把它删掉。
robocopy "%SRC%" "%DST%" /MIR /XD node_modules data logs .npm-cache dist-desktop .git /XF *.log /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
echo ROBOCOPY_SRC_EXIT=%ERRORLEVEL%
echo [2/3] sync data (vault.db + media)
if not exist "%DST%\data\NUL" mkdir "%DST%\data"
robocopy "%SRC%\data" "%DST%\data" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
echo ROBOCOPY_DATA_EXIT=%ERRORLEVEL%
echo [3/3] result
dir /b "%DST%"
echo SOURCE_FILES=%SRC%
echo DONE
