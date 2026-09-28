# 迭代期快速构建：**只出 exe，不打包不定签名**
#
# ## 为什么需要它（2026-09-29）
#
#   用户原话：「你这玩意太慢了，能不能有更好的方式，我想你快点」。
#
#   实测：`build-signed.ps1` 一次 6~10 分钟 —— 里面真正影响"我要验的东西"的
#   只有两步：**前端生产构建**（约 1 秒）+ **`cargo build --release`**（增量 30 秒 ~ 5 分钟）；
#   剩下的 NSIS 打包、签名、部署到桌面**只有发版才需要**，迭代期纯属白等。
#
#   ★ 谁用哪个：
#     · 迭代期（改代码 → 跑探针）：`tools/env/build-fast.ps1`（本文件）
#     · 发版（要安装包 + 签名 + 桌面副本）：`tools/env/build-signed.ps1`
#
#   ★★ **不许**在构建跑的时候拿 `target/release/ieml.exe` 跑探针 ——
#      exe 被占用会让 `tauri build` / `cargo` 以 `拒绝访问 (os error 5)` 失败
#      （本轮就这么白等了一次 6 分钟的构建）。`tools/live/lib/cdp.mjs` 现在
#      会在启动探针前拦住这种情况。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/build-fast.ps1
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$sw = [Diagnostics.Stopwatch]::StartNew()

if (-not $Quiet) { Write-Output '[build-fast] 前端生产构建…' }
& node 'node_modules/vite/bin/vite.js' build | Out-Null
if ($LASTEXITCODE -ne 0) { throw "前端构建失败（退出码 $LASTEXITCODE）" }

if (-not $Quiet) { Write-Output '[build-fast] cargo build --release（增量）…' }
& powershell -NoProfile -ExecutionPolicy Bypass -File 'tools/env/cargo.ps1' build --release --manifest-path 'src-tauri/Cargo.toml'
if ($LASTEXITCODE -ne 0) { throw "cargo build --release 失败（退出码 $LASTEXITCODE）" }

$exe = Get-Item 'src-tauri/target/release/ieml.exe'
Write-Output ("[build-fast] 好了：{0:N0} 字节 · {1} · 用时 {2:N1} 分钟" -f $exe.Length, $exe.LastWriteTime.ToString('HH:mm:ss'), $sw.Elapsed.TotalMinutes)
Write-Output '  ★ 这一步**没有**安装包 / 签名 / 桌面副本 —— 发版请用 build-signed.ps1'
