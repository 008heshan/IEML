# 在 MSVC 环境下跑 cargo（链接 Windows 目标必需）。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\env\cargo.ps1 test --manifest-path src-tauri/Cargo.toml --lib
#
# ## 为什么需要它（一个入口，自动选路）
#
#   ① **首选 `vcvars64.bat`**（微软官方入口）：本机可用时一切照旧。
#   ② 不可用时自动改用自己拼的 MSVC 环境（`cargo-manual-msvc.ps1`）——
#      这个仓库真的遇到过：`reg.exe` 被安全中心拦住 → vcvars 静默失败 →
#      链接报 `LNK1181: cannot open advapi32.lib`。
#
#   ★ 以前这是**两个脚本**，调用方（package.json / verify.mjs）得记住"哪条命令用哪个"。
#     一个入口 + 自动回退之后，调用方只需要知道 `cargo.ps1`（ADR-053）。
#
#   ★ 回退**必须说出来**：静默换环境会让"为什么这次编译行为不一样"变成一个谜。
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$vcvars = if ($env:IEML_VCVARS64) {
    $env:IEML_VCVARS64   # 逃生口：VS 装在别处时指路（测试里也用它验证回退分支）
} else {
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
}

$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
if (-not (Test-Path -LiteralPath $cargo)) {
    Write-Output "ERROR: cargo not found at $cargo"
    exit 1
}

if (-not (Test-Path -LiteralPath $vcvars)) {
    Write-Output "[cargo.ps1] 找不到 vcvars64.bat（$vcvars）→ 改用自己拼的 MSVC 环境（cargo-manual-msvc.ps1）"
    & (Join-Path $here 'cargo-manual-msvc.ps1') @args
    exit $LASTEXITCODE
}

# vcvars 的输出（一大堆环境变量回显）没有用，直接吞掉。
$argLine = ($args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$cmd = "call `"$vcvars`" >nul 2>&1 && `"$cargo`" $argLine"
cmd /c $cmd
$code = $LASTEXITCODE

# vcvars 有时**退出码是 0 但没设置 %LIB%**（本机实测）——那种情况链接必然失败。
# 判据刻意用"LIB 为空"，而不是"退出码非 0"：编译错误也会让退出码非 0，
# 那种重试一次纯属浪费（用户要多等一轮编译）。
if ($code -ne 0 -and -not $env:LIB) {
    Write-Output "[cargo.ps1] vcvars64.bat 没设置 %LIB%（本机遇到过）→ 改用 cargo-manual-msvc.ps1 重试"
    & (Join-Path $here 'cargo-manual-msvc.ps1') @args
    exit $LASTEXITCODE
}
exit $code
