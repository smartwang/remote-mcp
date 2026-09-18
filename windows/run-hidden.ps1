# Hidden launcher used by the Scheduled Task created in install-autostart.ps1.
# Started as:  powershell.exe -WindowStyle Hidden -File run-hidden.ps1
# Because the parent PowerShell window is hidden, the child node process
# inherits that hidden console and no window flashes on screen.
#
# Encoding note (measured): on a Chinese Windows, PowerShell 5.1 decodes a
# native child's stdout using the console codepage (CP936), so piping node's
# UTF-8 straight into Out-File produces mojibake logs. Setting
# [Console]::OutputEncoding to UTF-8 first fixes the decode side; Out-File
# -Encoding utf8 fixes the write side. Both are needed.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found on PATH' }
  $node = $cmd.Source
}

$log = Join-Path $PSScriptRoot 'server.out.log'
"--- started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | node=$node ---" |
  Out-File -LiteralPath $log -Encoding utf8 -Append

& $node (Join-Path $PSScriptRoot 'server.js') 2>&1 |
  Out-File -LiteralPath $log -Encoding utf8 -Append
