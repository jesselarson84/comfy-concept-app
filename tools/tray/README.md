# Tray controller (Windows)

A system-tray icon for the app's Node server on 127.0.0.1:3100. It uses the app's own
icon: green dot = running, amber dot = starting (or port 3100 is used by another
program), greyed = stopped. Right-click: Start, Stop, Restart, Open log, Exit tray.
Exit tray leaves the server running. One tray per user session (named mutex).

- Start the tray: double-click `Tray.vbs` (PowerShell 5.1 + Windows Forms, no window,
  nothing to install).
- Finding the server: the process listening on the port whose command line contains
  `runtime\node.exe` (full path) and `server\index.js`, plus the `cmd /c` wrapper that
  `start-background.vbs` or the tray put around it. Stop kills exactly that process tree,
  never "all node.exe".
- Start runs `runtime\node.exe server\index.js` in the app folder with output appended to
  `data\server.log`, the same as `start-background.vbs`. The env and config are unchanged.
- At launch, if the server still isn't running after `LaunchGraceSec` (30 s, so the
  existing autostart goes first), the tray starts it.
- Settings: `tray.config.json` (port, exe, args, working directory, log, PID file).
  Relative paths are relative to this folder.
- Tests (dummy servers on 3198/3199, never the real one):
  `powershell -NoProfile -ExecutionPolicy Bypass -File Tray.Tests.ps1 -TrayLaunch`
- Icons: `icon-*.ico` (16-48 px) are made from `app/icons/icon-512.png`.
- Autostart is not changed by this folder. To use the tray at login, point the Startup
  item at `tools\tray\Tray.vbs` instead of `start-background.vbs`.
