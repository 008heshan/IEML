@echo off
@rem 2026-10-07: build IEML from an independent Windows host, without the tauri CLI.
@rem
@rem ## Why not `pnpm desktop:build`
@rem
@rem   `tauri build` needs the `cargo-tauri` binary. It is NOT installed on this
@rem   machine (checked ~/.cargo/bin) and CANNOT be installed: crates.io is
@rem   unreachable from here (verified: "Could not resolve host: index.crates.io").
@rem   So `cargo tauri build` fails with "no such command: tauri", and the npm CLI
@rem   path fails differently (the native addon asks cargo for the same missing
@rem   subcommand, and in the agent shell that cargo resolves to an Electron
@rem   shim, which is where "unrecognized subcommand <path to DSH Desktop.exe>"
@rem   came from).
@rem
@rem ## What actually produces the shipped exe
@rem
@rem   tools\env\deploy-desktop.ps1 copies src-tauri\target\release\ieml.exe.
@rem   That file is produced by an ordinary `cargo build --release`:
@rem   tauri-build's codegen reads tauri.conf.json's `frontendDist` ("../dist")
@rem   at COMPILE time and embeds those assets into the binary
@rem   (verified in tauri-build-2.6.3/src/codegen/context.rs:87-91).
@rem
@rem   So the two real steps are: build the frontend into dist/, then compile.
@rem   `beforeBuildCommand` in tauri.conf.json is "pnpm exec vite build" -- the
@rem   tauri CLI would have run exactly that.
@rem
@rem ## Why wscript
@rem
@rem   Started via build-detached.vbs so this is not a descendant of the agent
@rem   shell, and with window style 0 so no cmd window flashes on screen.
@rem
@rem Output: %TEMP%\ieml-build.log
@rem
@rem 2026-10-08: this log used to go to E:\IEML\build-out.log -- the repo root.
@rem The repo has a gate (tools\gates\check-repo-root.mjs) whose whole point is
@rem "the root is the public face of the repo, nothing extra lives there", and
@rem it flags any *.log. The `*.log` line in .gitignore hid the file from git
@rem but not from the gate -- and the gate is right: %TEMP% is where logs go.
@rem Keep this writing to %TEMP%.

setlocal
cd /d E:\IEML
set "ELECTRON_RUN_AS_NODE="

echo ==== build started %DATE% %TIME% ==== > %TEMP%\ieml-build.log

echo ---- step 1/2: vite build (frontend -> dist) ---- >> %TEMP%\ieml-build.log
call "%APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd" exec vite build >> %TEMP%\ieml-build.log 2>&1
set "RC1=%ERRORLEVEL%"
echo ---- vite rc=%RC1% ---- >> %TEMP%\ieml-build.log
if not "%RC1%"=="0" goto done

echo ---- step 2/2: cargo build --release (embeds dist) ---- >> %TEMP%\ieml-build.log
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\IEML\tools\env\cargo.ps1" build --release --manifest-path "E:\IEML\src-tauri\Cargo.toml" >> %TEMP%\ieml-build.log 2>&1
set "RC2=%ERRORLEVEL%"
echo ---- cargo rc=%RC2% ---- >> %TEMP%\ieml-build.log
if not "%RC2%"=="0" goto done

echo ---- step 3/3: deploy to Desktop ---- >> %TEMP%\ieml-build.log
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\IEML\tools\env\deploy-desktop.ps1" >> %TEMP%\ieml-build.log 2>&1
echo ---- deploy rc=%ERRORLEVEL% ---- >> %TEMP%\ieml-build.log

:done
echo ==== build finished %DATE% %TIME% ==== >> %TEMP%\ieml-build.log
@endlocal
exit /b 0
