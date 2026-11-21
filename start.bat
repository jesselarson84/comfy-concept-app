@echo off
REM Comfy Concept app - double-click to start.
REM Uses the bundled runtime\node.exe if present, otherwise a system Node.js (22+).
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server\index.js
) else (
  where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
  node server\index.js
)
pause
