' AssetVault 静默启动（无控制台窗口）。把它放进「启动」文件夹即可开机自启。
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node --import tsx apps\server\src\main.ts >> logs\server.out 2>&1", 0, False
