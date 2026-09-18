# Register a Scheduled Task that starts the Windows MCP server at logon.
# Run once:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove :  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#
# The task runs run-hidden.ps1 through a hidden PowerShell window, so nothing
# pops up at logon. Output goes to server.out.log next to this script.

[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$TaskName = 'WindowsMCPServer'
)

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "Scheduled task '$TaskName' does not exist."
  }
  return
}

if (-not (Test-Path (Join-Path $dir 'server.js'))) { throw "server.js not found in $dir" }
if (-not (Test-Path (Join-Path $dir 'server.env'))) {
  Write-Warning "server.env not found. Copy server.env.example to server.env first; the server will listen on /mcp without a path token otherwise."
}

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction `
  -Execute $ps `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\run-hidden.ps1`"" `
  -WorkingDirectory $dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Windows MCP server for OpenAI Secure MCP Tunnel (stdio-over-HTTP bridge)' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "Task '$TaskName' registered. State: $state"
Write-Host "Health check: curl.exe http://127.0.0.1:18090/healthz"
Write-Host "Logs        : $dir\server.out.log"
