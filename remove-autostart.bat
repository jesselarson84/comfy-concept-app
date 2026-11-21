@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ComfyConceptApp.vbs" 2>nul
echo Autostart removed. (The app keeps running until you run stop-app.bat or restart.)
pause
