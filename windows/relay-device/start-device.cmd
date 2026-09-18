@echo off
rem ===========================================================================
rem relay-device : connect THIS Windows box to a self-hosted MCP relay,
rem                as a SECOND device, without touching the official device
rem                that talks to mcp.desktopcommander.app.
rem
rem Why a launcher script is needed at all:
rem   1. npx cannot be used for a second instance. The official device runs
rem      from the npx cache and keeps <cache>\...\desktop-commander\dist as its
rem      cwd, which locks that directory - so npx's upgrade rename dies with
rem      EBUSY before the process ever starts.
rem   2. device.js hardcodes its state file at ~\.desktop-commander-device,
rem      holding {deviceId, session} and NO server URL. Two devices would
rem      overwrite each other's identity and the official one would break on
rem      its next restart.
rem   So we run a private local copy with a patched state path instead.
rem
rem   ZERO downloads: the payload is copied from the local npm cache.
rem
rem Usage:
rem   start-device.cmd                  prepare if needed, then run
rem   start-device.cmd prepare          prepare only, start nothing
rem   start-device.cmd reinstall        force re-copy from cache, then run
rem   start-device.cmd check            show resolved paths + patch status
rem   start-device.cmd logout           delete this device's saved credentials
rem   start-device.cmd <args...>        run, passing args to device.js
rem                                     (e.g. --no-persist-session)
rem
rem Config: device.env next to this script. See device.env.example.
rem Docs:   README.md next to this script.
rem
rem Note: this file is deliberately ASCII-only and every path is quoted.
rem Chinese console output comes from prepare.mjs / the device, and renders
rem correctly because of the chcp below.
rem ===========================================================================

setlocal EnableExtensions
chcp 65001 >nul

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "ENV_FILE=%HERE%\device.env"
set "PREPARE=%HERE%\prepare.mjs"
set "STATE_FILE="

rem ---- locate node ----------------------------------------------------------
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"

rem ---- load device.env ------------------------------------------------------
rem Lines starting with # are comments. Only the first '=' splits key/value.
if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%~A"=="" set "%%~A=%%~B"
  )
)

rem ---- defaults -------------------------------------------------------------
rem No baked-in server default on purpose. An unset MCP_SERVER_URL must fail
rem loudly here rather than fall back to some address that isn't yours and then
rem die with a confusing DNS / connection error.
if not defined MCP_SERVER_URL (
  echo.
  echo [ERROR] MCP_SERVER_URL is not set.
  echo         Put the relay address in device.env next to this script, e.g.
  echo             MCP_SERVER_URL=https://mcp.example.com
  echo         See device.env.example for the full template.
  echo.
  exit /b 1
)
if not defined DCD_DEVICE_ROOT set "DCD_DEVICE_ROOT=%HERE%\_device"

set "DCD_DEVICE_STATE_DIR=%DCD_DEVICE_ROOT%\state"
set "STATE_FILE=%DCD_DEVICE_STATE_DIR%\device.json"
set "DCD_DEVICE_ENTRY=%DCD_DEVICE_ROOT%\node_modules\@wonderwhy-er\desktop-commander\dist\remote-device\device.js"

rem ---- logout ---------------------------------------------------------------
if /i "%~1"=="logout" (
  echo.
  echo   relay-device : logout
  echo   state file: %STATE_FILE%
  if exist "%STATE_FILE%" (
    del /f /q "%STATE_FILE%"
    echo   OK - removed. Next start will ask for a new device code.
  ) else (
    echo   - nothing to remove.
  )
  echo.
  exit /b 0
)

if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Install Node.js 18 or newer first.
  exit /b 1
)

echo.
echo   relay-device
echo   server : %MCP_SERVER_URL%
echo   node   : %NODE_EXE%
echo   root   : %DCD_DEVICE_ROOT%
echo   state  : %STATE_FILE%
echo.

rem ---- check ----------------------------------------------------------------
if /i "%~1"=="check" (
  "%NODE_EXE%" "%PREPARE%" --check-only --root "%DCD_DEVICE_ROOT%" --state-dir "%DCD_DEVICE_STATE_DIR%"
  exit /b %ERRORLEVEL%
)

rem ---- prepare (idempotent, ~1s when already done) ---------------------------
set "PREPARE_ARGS="
if /i "%~1"=="reinstall" set "PREPARE_ARGS=--force"

"%NODE_EXE%" "%PREPARE%" %PREPARE_ARGS% --root "%DCD_DEVICE_ROOT%" --state-dir "%DCD_DEVICE_STATE_DIR%"
if errorlevel 1 (
  echo [ERROR] prepare failed - device NOT started.
  exit /b 1
)

if /i "%~1"=="prepare" (
  echo   Done. Nothing was started.
  exit /b 0
)

if not exist "%DCD_DEVICE_ENTRY%" (
  echo [ERROR] entry not found: %DCD_DEVICE_ENTRY%
  exit /b 1
)

rem ---- run ------------------------------------------------------------------
set "NODE_ARGS="
if /i not "%~1"=="reinstall" set "NODE_ARGS=%*"

echo   Starting device. Press Ctrl+C to stop.
echo   First run: open the printed verification URL and approve the device code.
echo.
"%NODE_EXE%" "%DCD_DEVICE_ENTRY%" %NODE_ARGS%
set "RC=%ERRORLEVEL%"
echo.
echo   Device exited with code %RC%.
exit /b %RC%
