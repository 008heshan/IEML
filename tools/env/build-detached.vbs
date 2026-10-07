' 2026-10-07 (last fixed 2026-10-08): launch the IEML build from an independent
' Windows host, with NO output of any kind -- no console window, no dialog.
'
' ## Why an independent host
'
'   The agent harness injects ELECTRON_RUN_AS_NODE=1 into every process it
'   starts, and this machine has no real node.exe (only DSH's Electron-based
'   node.cmd shim). That makes cargo-tauri launch as Electron and read its own
'   executable path as a subcommand:
'
'       error: unrecognized subcommand D:\DSH\DSH Desktop\DSH Desktop.exe
'
'   wscript.exe is not a descendant of the agent shell, so the build gets a
'   clean environment. Run(..., 0, True) keeps the child hidden and waits for it.
'
' ## ★★ 2026-10-08: DO NOT USE WScript.Echo HERE
'
'   The user got a "Windows Script Host / build exit code = 0" message box
'   after every build. Cause: `WScript.Echo` under wscript.exe POPS A DIALOG
'   (that is its behaviour for GUI hosts -- it is not stdout). Under cscript.exe
'   it would print to the console, but we are deliberately not using a console.
'
'   => This script must stay SILENT. The build result already goes to
'      E:\IEML\build-out.log (written by build-detached.cmd). Read that file;
'      never make this script talk to the user.
'      Errors are reported the same way: the log plus the process exit code.
'
' Usage: wscript.exe //nologo tools\env\build-detached.vbs
'   Result: E:\IEML\build-out.log      Exit code: this process's exit code.

Option Explicit

Dim fso, sh, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If Not fso.FileExists("E:\IEML\tools\env\build-detached.cmd") Then
  ' ★ 连错误也不能弹框（见上面那段）。写进日志，用退出码表达失败。
  Dim f
  Set f = fso.CreateTextFile("E:\IEML\build-out.log", True)
  f.WriteLine "ERROR: tools\env\build-detached.cmd not found"
  f.Close
  WScript.Quit 2
End If

rc = sh.Run("cmd.exe /c ""E:\IEML\tools\env\build-detached.cmd""", 0, True)
WScript.Quit rc
