<#
.SYNOPSIS
  Register (or unregister) the weekly Volt vendor-check Scheduled Task.

.DESCRIPTION
  Creates "Volt Weekly Vendor Check": every Monday at 09:00 (while you
  are logged on) it runs scripts\vendor-weekly.cmd, which executes
  `npm run update:vendor` and appends the full transcript (including
  any smoke-gate failure and rollback) to pdf-viewer\logs\vendor-update.log.
  If the PC is off at the scheduled time, a missed run fires at the next
  logon. Limited privileges, current user only - no admin rights needed.

  This is the loud, auditable companion to Volt's silent built-in
  background auto-update: the scheduled run logs every outcome, so a
  pdf.js regression is caught the week it appears.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule-vendor-weekly.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule-vendor-weekly.ps1 -Unregister
#>
param(
  [switch]$Unregister,
  [string]$TaskName = "Volt Weekly Vendor Check"
)
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "vendor-weekly.cmd"

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "Task '$TaskName' was not registered - nothing to remove." -ForegroundColor Yellow
  }
  exit 0
}

if (-not (Test-Path $runner)) {
  throw "Runner not found: $runner"
}

# Interactive-only (runs when you're logged on, so the headless Electron
# smoke test has a session), limited privileges. StartWhenAvailable covers
# a missed Monday while the PC was off. Overwrite any previous registration.
$action = New-ScheduledTaskAction -Execute $runner
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 09:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Weekly Volt vendored-library check (pdf.js / pdf-lib): runs npm run update:vendor and logs the result to pdf-viewer\logs\vendor-update.log." `
  -Force | Out-Null

Write-Host "Registered '$TaskName':" -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
(Get-ScheduledTaskInfo -TaskName $TaskName) | Select-Object NextRunTime, LastRunTime, LastTaskResult | Format-List

Write-Host "Log: $scriptDir\..\logs\vendor-update.log" -ForegroundColor Cyan
Write-Host "Manual test:  $runner --dry-run" -ForegroundColor Cyan
