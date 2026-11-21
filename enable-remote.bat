@echo off
REM Publishes the app (port 3100) to YOUR tailnet only, over HTTPS, using Tailscale Serve.
REM Not Tailscale Funnel: nothing is exposed to the public internet.
REM Run once; Tailscale remembers it (--bg). Undo with:  tailscale serve reset
set TS=tailscale
where tailscale >nul 2>nul || set TS="%ProgramFiles%\Tailscale\tailscale.exe"
echo Running: tailscale serve --bg 3100
%TS% serve --bg 3100
echo.
echo ---- Current serve status (look for the https://....ts.net address) ----
%TS% serve status
echo.
echo If it asks you to enable HTTPS / MagicDNS, open the link it prints, approve it, then run this again.
pause
