# Creates a desktop shortcut that launches the Volt desktop app
# (an Electron app — its own window, no browser tab). The shortcut targets
# wscript.exe running scripts\start-volt-app-hidden.vbs, which starts
# start-volt-app.cmd with its console window HIDDEN — so double-clicking the
# shortcut behaves like a normal program: only the app window appears, no
# command-prompt box. Also adds a matching app icon (assets/volt.ico) and
# registers the .pdf file association (scripts\register-volt-file-assoc.ps1)
# so a fresh machine gets both the shortcut and the association in one step.
# If Volt's Electron runtime isn't installed yet, the association is deferred
# (the launcher finishes it on first launch) — the shortcut is still created.
# Run:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-volt-shortcut.ps1
# Shortcut only (no .pdf association):  ... -SkipAssociation
param(
    [switch]$SkipAssociation  # create the shortcut only; leave .pdf association alone
)

$project = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $project 'scripts\start-volt-app-hidden.vbs'
$assetsDir = Join-Path $project 'pdf-viewer\assets'
$icoPath = Join-Path $assetsDir 'volt.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Volt PDF Reader.lnk'

# ── generate a small app icon (violet rounded square with "V") ──────
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

# render at 256px so the exe/installer/shortcut icons stay crisp on any display
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$pad = 12
$rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
$radius = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(124, 108, 255),
    [System.Drawing.Color]::FromArgb(76, 201, 240),
    45)
$g.FillPath($brush, $path)
$g.DrawPath((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220,255,255,255), 6)), $path)

$font = New-Object System.Drawing.Font('Segoe UI', 136, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = [System.Drawing.Brushes]::White
$g.DrawString('V', $font, $white, 56, 32)

# save as .ico (multiple sizes so the shortcut looks sharp)
$iconHandle = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()

$g.Dispose(); $bmp.Dispose(); $path.Dispose(); $brush.Dispose(); $font.Dispose(); $icon.Dispose()

# ── create the shortcut ─────────────────────────────────────────────
# Target wscript.exe running the hidden VBS launcher: the app starts with NO
# console window (window style 0 inside the VBS), so the shortcut behaves
# like a normal executable — only the app's window and taskbar icon appear.
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = "`"$launcher`""
$lnk.WorkingDirectory = $project
$lnk.Description = 'Volt — local, private, AI-powered PDF reader (desktop app)'
$lnk.IconLocation = "$icoPath,0"
$lnk.Save()

Write-Host "Shortcut created: $lnkPath"
Write-Host "Icon: $icoPath"

# ── register the .pdf file association (one step for a fresh machine) ─────
# Mirrors what start-volt-app.cmd does on launch: idempotent, HKCU-only, and
# -Silent so it never prompts or blocks here. If Electron isn't installed yet
# the launcher will finish the association on the first app launch — the
# shortcut has still been created, so this script deliberately exits 0 either
# way (association is best-effort, exactly how the launcher treats it).
if (-not $SkipAssociation) {
    $assocScript = Join-Path $PSScriptRoot 'register-volt-file-assoc.ps1'
    try {
        & $assocScript -Silent
        if ($LASTEXITCODE -eq 0) {
            # exit 0 covers both "registered" and "left alone" (Volt registered
            # before, but the user has since re-associated .pdf elsewhere and
            # the script respected that) — verify what actually happened so the
            # message is never a lie
            $cur = (Get-ItemProperty 'HKCU:\Software\Classes\.pdf' -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
            if ($cur -eq 'Volt.PDF') {
                Write-Host 'PDF association registered: double-clicking a .pdf now opens it in Volt.' -ForegroundColor Green
            } else {
                Write-Host ".pdf is associated with '$cur' — left as you had it." -ForegroundColor DarkGray
            }
        } else {
            Write-Host "PDF association deferred: Volt's Electron runtime isn't installed yet." -ForegroundColor Yellow
            Write-Host '  Launch the app once (start-volt-app.cmd — it downloads Electron and registers' -ForegroundColor Yellow
            Write-Host '  the association automatically), or re-run this script afterwards.' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Could not register the .pdf association: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '  Re-run scripts\register-volt-file-assoc.ps1 after the first app launch.' -ForegroundColor Yellow
    }
}
