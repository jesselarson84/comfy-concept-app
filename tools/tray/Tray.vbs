' Tray.vbs - starts Tray.ps1 with no console window. Double-click, or put a
' shortcut to this file in the Startup folder. Optional argument: a config path.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cfg = dir & "\tray.config.json"
If WScript.Arguments.Count > 0 Then cfg = WScript.Arguments(0)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File """ & dir & "\Tray.ps1"" -ConfigPath """ & cfg & """", 0, False
