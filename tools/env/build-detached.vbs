' 2026-10-07: launch the IEML build from an independent Windows host.
'
' Why: the agent harness injects ELECTRON_RUN_AS_NODE=1 into every process it
' starts, and this machine has no real node.exe (only DSH's Electron-based
' node.cmd shim). That makes cargo-tauri launch as Electron and read its own
' executable path as a subcommand:
'
'     error: unrecognized subcommand D:\DSH\DSH Desktop\DSH Desktop.exe
'
' wscript.exe is not a descendant of the agent shell, so the build gets a clean
' environment. Run() with window style 0 keeps it invisible (no cmd flashing).
'
' Usage: wscript.exe //nologo tools\env\build-detached.vbs

Option Explicit

Dim fso, sh, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If Not fso.FileExists("E:\IEML\tools\env\build-detached.cmd") Then
  WScript.Echo "ERROR: build-detached.cmd not found"
  WScript.Quit 2
End If

rc = sh.Run("cmd.exe /c ""E:\IEML\tools\env\build-detached.cmd""", 0, True)
WScript.Echo "build exit code = " & rc
WScript.Quit rc
