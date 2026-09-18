@echo off
rem ---------------------------------------------------------------------------
rem Start the Windows MCP server in the foreground (for debugging).
rem Configuration comes from server.env next to this script.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Install Node.js 18+ first.
  pause
  exit /b 1
)

echo Node      : %NODE_EXE%
echo Script    : %~dp0server.js
echo Config    : %~dp0server.env
echo Endpoint  : http://localhost:18090/healthz
echo Press Ctrl+C to stop.
echo.

"%NODE_EXE%" "%~dp0server.js"
set "RC=%ERRORLEVEL%"

echo.
echo Server exited with code %RC%.
pause
exit /b %RC%
