# =============================================================
#  Volt - register .pdf file association (Windows, per-user, no admin)
#  Makes double-clicking any .pdf in Explorer open it in Volt.
#
#  Safe by design:
#    * HKCU only - no admin rights, no system-wide changes.
#    * On first registration the previous .pdf association is backed
#      up under HKCU\Software\Classes\Volt.PDF.Previous.
#    * If the user later re-associates .pdf with something else, this
#      script leaves it alone (doesn't fight the user).
#
#  Run:     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-volt-file-assoc.ps1
#  Restore: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-volt-file-assoc.ps1 -Revert
#  Quiet:   add -Silent (used by the launcher; no prompts, no output)
# =============================================================
param([switch]$Revert, [switch]$Silent)

$ErrorActionPreference = 'Stop'
$project  = Split-Path $PSScriptRoot -Parent
$appRoot  = Join-Path $project 'pdf-viewer'
$exe      = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'
$ico      = Join-Path $appRoot 'assets\volt.ico'
$progId   = 'Volt.PDF'
$classes  = 'HKCU:\Software\Classes'
$pdfKey   = Join-Path $classes '.pdf'
$progKey  = Join-Path $classes $progId
$backup   = Join-Path $classes "$progId.Previous"

if (-not (Test-Path $exe)) {
    Write-Host "Volt's Electron runtime not found:" -ForegroundColor Red
    Write-Host "  $exe" -ForegroundColor Red
    Write-Host 'Run start-volt-app.cmd once first so Electron is installed.' -ForegroundColor Red
    if (-not $Silent) { Read-Host 'Press Enter to exit' }
    exit 1
}

# refresh Explorer's icon cache for the new/removed association
Add-Type -Namespace Volt -Name Shell -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
'@
function Refresh-Icons { [Volt.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }

if ($Revert) {
    # restore the pre-Volt association (if we backed one up), then remove Volt's ProgID
    $prev = (Get-ItemProperty -Path $backup -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if ($prev) {
        New-Item -Path $pdfKey -Force | Out-Null
        Set-ItemProperty -Path $pdfKey -Name '(default)' -Value $prev
        Remove-Item -Path $backup -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Restored previous .pdf association: $prev"
    } else {
        Remove-Item -Path $pdfKey -Force -ErrorAction SilentlyContinue
        Write-Host 'No backup found - removed the .pdf association.'
    }
    Remove-Item -Path $progKey -Recurse -Force -ErrorAction SilentlyContinue
    Refresh-Icons
    exit 0
}

# ---- decide whether to take over ----------------------------------
$current = (Get-ItemProperty -Path $pdfKey -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
$alreadyVolt = ($current -eq $progId)
$firstTime   = -not (Test-Path $backup)

if ($current -and -not $alreadyVolt -and -not $firstTime) {
    # we registered before, but the user has since associated .pdf with
    # something else - respect that and leave it alone
    if (-not $Silent) {
        Write-Host ".pdf is currently associated with '$current' - leaving it as is." -ForegroundColor Yellow
        Write-Host "Run with -Revert to fully remove Volt, or re-register manually."
    }
    exit 0
}

if ($current -and -not $alreadyVolt) {
    New-Item -Path $backup -Force | Out-Null
    Set-ItemProperty -Path $backup -Name '(default)' -Value $current
    if (-not $Silent) { Write-Host "Backed up previous .pdf association ($current)." }
}

# ---- register ------------------------------------------------------
# HKCU\Software\Classes\.pdf -> Volt.PDF
New-Item -Path $pdfKey -Force | Out-Null
Set-ItemProperty -Path $pdfKey -Name '(default)' -Value $progId

# "Open with..." menu entry so Volt appears there too
$owp = Join-Path $pdfKey 'OpenWithProgids'
New-Item -Path $owp -Force | Out-Null
Set-ItemProperty -Path $owp -Name $progId -Value ''

# Volt.PDF ProgID
New-Item -Path $progKey -Force | Out-Null
Set-ItemProperty -Path $progKey -Name '(default)' -Value 'Volt PDF Reader'

# PDF file icons show the Volt icon in Explorer
$iconKey = Join-Path $progKey 'DefaultIcon'
New-Item -Path $iconKey -Force | Out-Null
Set-ItemProperty -Path $iconKey -Name '(default)' -Value "`"$ico`",0"

# double-click -> electron.exe <app root> <file>
$openCmd = Join-Path $progKey 'shell\open\command'
New-Item -Path $openCmd -Force | Out-Null
Set-ItemProperty -Path $openCmd -Name '(default)' -Value "`"$exe`" `"$appRoot`" `"%1`""

Refresh-Icons

if (-not $Silent) {
    $cmdDisplay = "`"$exe`" `"$appRoot`" `"%1`""
    Write-Host '.pdf is now associated with Volt - double-clicking a PDF opens it in the app.' -ForegroundColor Green
    Write-Host "Command: $cmdDisplay" -ForegroundColor DarkGray
    Write-Host 'Restore the old association anytime with: register-volt-file-assoc.ps1 -Revert' -ForegroundColor DarkGray
}

# explicit success exit: callers (e.g. create-volt-shortcut.ps1) rely on
# $LASTEXITCODE -eq 0 to detect success — without this, the script falls off
# the end and leaves the caller's $LASTEXITCODE untouched
# (and potentially unset) even though the association was registered.
exit 0
