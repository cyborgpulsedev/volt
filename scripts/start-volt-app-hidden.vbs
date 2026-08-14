' ============================================================
'  Volt - hidden desktop-app launcher
'
'  Launches start-volt-app.cmd with its console window HIDDEN
'  (window style 0), so starting Volt from the desktop behaves
'  like a normal program: only the app window appears, no cmd
'  prompt flashing up. Errors still pop the native Windows
'  error dialog, because start-volt-app.cmd routes every
'  failure through scripts\show-error.ps1.
'
'  Used by the desktop shortcut (create-volt-shortcut.ps1):
'      wscript.exe "C:\...\scripts\start-volt-app-hidden.vbs"
'  Double-clicking this file works the same way.
'
'  NOTE: keep this file pure ASCII - VBScript reads text files
'  with the system codepage and non-ASCII bytes garble it.
' ============================================================
Option Explicit

Dim fso, shell, projectDir, launcher
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' scripts\ is one folder below the project root, which holds
' start-volt-app.cmd - resolve it relative to this file so the
' launcher keeps working if the project is moved or renamed.
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
launcher = Chr(34) & projectDir & "\start-volt-app.cmd" & Chr(34)

' window style 0 = hidden console; bWaitOnReturn = False so
' wscript exits immediately and the app owns the session
shell.Run launcher, 0, False
