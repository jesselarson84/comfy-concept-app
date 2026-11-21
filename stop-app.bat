@echo off
REM Stops the background Comfy Concept app (only the node.exe in this folder's runtime).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like '*comfy-concept-app\runtime\node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'Stopped PID ' + $_.ProcessId }"
pause
