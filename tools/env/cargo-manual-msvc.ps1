# 自己拼一套 MSVC 环境跑 cargo（`cargo.ps1` 的回退路径，一般不用直接调它）。
#
# 为什么存在：
#   `vcvars64.bat` 会调 `reg.exe` 去找 Windows SDK。这台机器的安全中心把
#   `reg.exe` 拦住了 → vcvars **退出码 0 却没设置 %LIB%/%INCLUDE%** →
#   链接报 `LNK1181: cannot open advapi32.lib`。这里把环境自己拼出来，
#   全程不碰 reg.exe。
#
# ★ 第五十六轮：环境拼法抽到了 `msvc-env.ps1`。
#   原因是带签名的打包（`build-signed.ps1`）需要**同一套**环境，
#   而"同一份规则写两遍"在这个仓库里已经漂过好几次。
#   这个文件现在只负责：设好环境 → 调 cargo → 把退出码原样带回去。
#
# 用法（通常由 tools\env\cargo.ps1 自动转过来）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\env\cargo-manual-msvc.ps1 test --manifest-path src-tauri/Cargo.toml --lib
$ErrorActionPreference = 'Continue'

# msvc-env.ps1 失败时是 throw（它被 dot-source，不能 exit）——
# 这里翻译回"打印 ERROR + exit 1"，保持与旧版一致的调用方契约。
try {
    . "$PSScriptRoot\msvc-env.ps1"
} catch {
    Write-Output "ERROR: $_"
    exit 1
}

$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
if (-not (Test-Path -LiteralPath $cargo)) {
    Write-Output "ERROR: cargo not found at $cargo"
    exit 1
}

& $cargo @args
exit $LASTEXITCODE
