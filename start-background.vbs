' Starts the Comfy Concept app with NO window. Double-click to start.
' Output goes to data\server.log. Stop it with stop-app.bat.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
If fso.FileExists(dir & "\runtime\node.exe") Then
  nodeExe = """" & dir & "\runtime\node.exe"""
Else
  nodeExe = "node"
End If
' Window style 0 = hidden, False = do not wait.
sh.Run "cmd /c " & nodeExe & " server\index.js >> data\server.log 2>&1", 0, False
