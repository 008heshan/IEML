# 自己拼一套 MSVC 环境跑 cargo（`cargo.ps1` 的回退路径，一般不用直接调它）。
#
# 为什么存在：
#   `vcvars64.bat` 会调 `reg.exe` 去找 Windows SDK。这台机器的安全中心把
#   `reg.exe` 拦住了 → vcvars **退出码 0 却没设置 %LIB%/%INCLUDE%** →
#   链接报 `LNK1181: cannot open advapi32.lib`。这里把环境自己拼出来，
#   全程不碰 reg.exe。
#
# ★ 与旧版的区别（ADR-053）：MSVC 与 SDK 的版本号**不再写死**——
#   写死的那天换一台机器（或 VS 升级）就会指到一个不存在的目录，
#   而报错只会说"找不到 cl.exe"。现在按目录名**挑最新的一个**；
#   找不到就明确报错（说清去哪儿装/怎么指路），而不是拼一个坏环境继续跑。
#
# 用法（通常由 tools\env\cargo.ps1 自动转过来）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\env\cargo-manual-msvc.ps1 test --manifest-path src-tauri/Cargo.toml --lib
$ErrorActionPreference = 'Continue'

function Newest-Child($parent, $filter) {
    if (-not (Test-Path -LiteralPath $parent)) { return $null }
    $dirs = Get-ChildItem -LiteralPath $parent -Directory -Filter $filter -ErrorAction SilentlyContinue
    if (-not $dirs) { return $null }
    # 目录名是版本号（`14.44.35207` / `10.0.26100.0`）→ 按版本排序取最大
    return ($dirs | Sort-Object -Property @{ Expression = {
                $v = $_.Name -replace '[^0-9.]', ''
                [version]($v.TrimEnd('.'))
            } } -Descending | Select-Object -First 1).FullName
}

$vsRoot = if ($env:IEML_VS_ROOT) { $env:IEML_VS_ROOT } else { 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' }
$sdk    = if ($env:IEML_WINSDK_ROOT) { $env:IEML_WINSDK_ROOT } else { 'C:\Program Files (x86)\Windows Kits\10' }

$msvc = Newest-Child (Join-Path $vsRoot 'VC\Tools\MSVC') '14.*'
$sdkv = Newest-Child (Join-Path $sdk 'Include') '10.*'

if (-not $msvc -or -not $sdkv) {
    Write-Output "ERROR: 找不到 MSVC 或 Windows SDK —— 这条回退路径需要它们："
    Write-Output "       MSVC: $vsRoot\VC\Tools\MSVC\14.*   （找到：$msvc）"
    Write-Output "       SDK : $sdk\Include\10.*            （找到：$sdkv）"
    Write-Output "       装了 Visual Studio Build Tools（含 VCTools + Windows SDK）后重试，"
    Write-Output "       或者设 IEML_VS_ROOT / IEML_WINSDK_ROOT 指到实际位置。"
    exit 1
}

$sdkVer = Split-Path -Leaf $sdkv

# --- PATH：link.exe / cl.exe / rc.exe / mc.exe ---
$env:PATH = "$msvc\bin\HostX64\x64;$sdk\bin\$sdkVer\x64;$env:PATH"

# --- LIB：vcvars 没设上的那个（advapi32.lib 在 um\x64 里）---
$env:LIB = "$msvc\lib\x64;$sdk\Lib\$sdkVer\um\x64;$sdk\Lib\$sdkVer\ucrt\x64"

# --- INCLUDE：C 构建脚本要用（ring / webview2-com）---
$env:INCLUDE = "$msvc\include;$sdk\Include\$sdkVer\ucrt;$sdk\Include\$sdkVer\um;$sdk\Include\$sdkVer\shared"

$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
if (-not (Test-Path -LiteralPath $cargo)) {
    Write-Output "ERROR: cargo not found at $cargo"
    exit 1
}

Write-Output "[cargo-manual-msvc] MSVC $((Split-Path -Leaf $msvc)) · SDK $sdkVer"
& $cargo @args
exit $LASTEXITCODE
