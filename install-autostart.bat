@echo off
REM Makes the Comfy Concept app start hidden whenever you sign in to Windows.
REM It only drops one small file into your Startup folder. Undo with remove-autostart.bat.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\ComfyConceptApp.vbs"
> "%LAUNCHER%" echo CreateObject("WScript.Shell").Run "wscript.exe ""%~dp0start-background.vbs""", 0, False
if exist "%LAUNCHER%" (echo Installed: %LAUNCHER%) else (echo FAILED to write the launcher.)
REM Start it now too, so you do not have to sign out and back in.
wscript.exe "%~dp0start-background.vbs"
echo The app is starting in the background. Reload the page on your phone in a few seconds.
pause
