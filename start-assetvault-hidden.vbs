' AssetVault silent start (no console window). Put this file in the Startup folder to autostart.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node --import tsx apps\server\src\main.ts >> logs\server.out 2>&1", 0, False
