<#
.SYNOPSIS
  Show a native Windows error dialog. Used by start-volt-app.cmd so a failed
  app launch is never a silently closing console window: the user always gets
  a readable message box with the actual reason.

.DESCRIPTION
  Called by the launcher on every failure path (Node missing, Electron
  install/download failed, the app exited unexpectedly). Purely informational
  - the OK button is the only action. The message is also written to the
  console so terminal users see it in their log too.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File show-error.ps1 "Volt needs Node.js to run." "Volt - cannot start"
#>
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$Title = "Volt"
)

Write-Host "Volt error: $Message"

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  $Message,
  $Title,
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
