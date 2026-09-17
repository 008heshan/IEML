# 把 MSVC + Windows SDK 的环境变量设好（PATH / LIB / INCLUDE）。
# ------------------------------------------------------------------
# 为什么单独抽出来：
#   以前这套逻辑只长在 `cargo-manual-msvc.ps1` 里，而它**直接调 cargo 然后 exit**，
#   没法被别的脚本复用。带签名的打包（`build-signed.ps1`）同样需要这套环境，
#   如果各写一份，两处迟早会漂 —— 这个仓库已经因为"同一份规则写两遍"踩过好几次。
#
# ★ 这个文件是**被 dot-source 的**：`. "$PSScriptRoot\msvc-env.ps1"`
#   所以它**绝不能 exit**（那只结束它自己，调用方会带着半套环境继续跑）。
#   失败一律 `throw`，让调用方停在原地。
#
# ★ 版本号不写死（ADR-053）：按目录名挑最新的一个。写死的那天换机器或升 VS
#   就会指到不存在的目录，而报错只会说"找不到 cl.exe"。

function Get-NewestVersionedDir($parent, $filter) {
    if (-not (Test-Path -LiteralPath $parent)) { return $null }
    $dirs = Get-ChildItem -LiteralPath $parent -Directory -Filter $filter -ErrorAction SilentlyContinue
    if (-not $dirs) { return $null }
    # 目录名是版本号（`14.44.35207` / `10.0.26100.0`）→ 按版本排序取最大
    return ($dirs | Sort-Object -Property @{ Expression = {
                $v = $_.Name -replace '[^0-9.]', ''
                [version]($v.TrimEnd('.'))
            } } -Descending | Select-Object -First 1).FullName
}

$script:MsvcVsRoot = if ($env:IEML_VS_ROOT) { $env:IEML_VS_ROOT } else { 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' }
$script:MsvcSdkRoot = if ($env:IEML_WINSDK_ROOT) { $env:IEML_WINSDK_ROOT } else { 'C:\Program Files (x86)\Windows Kits\10' }

$msvc = Get-NewestVersionedDir (Join-Path $MsvcVsRoot 'VC\Tools\MSVC') '14.*'
$sdkv = Get-NewestVersionedDir (Join-Path $MsvcSdkRoot 'Include') '10.*'

if (-not $msvc -or -not $sdkv) {
    throw @"
找不到 MSVC 或 Windows SDK：
    MSVC: $MsvcVsRoot\VC\Tools\MSVC\14.*   （找到：$msvc）
    SDK : $MsvcSdkRoot\Include\10.*        （找到：$sdkv）
装了 Visual Studio Build Tools（含 VCTools + Windows SDK）后重试，
或设 IEML_VS_ROOT / IEML_WINSDK_ROOT 指到实际位置。
"@
}

$sdkVer = Split-Path -Leaf $sdkv

# --- PATH：link.exe / cl.exe / rc.exe / mc.exe ---
$env:PATH = "$msvc\bin\HostX64\x64;$MsvcSdkRoot\bin\$sdkVer\x64;$env:PATH"

# --- LIB：vcvars 没设上的那个（advapi32.lib 在 um\x64 里）---
#     为什么不用 vcvars64.bat：它要调 reg.exe 找 SDK，而这台机器的安全中心
#     把 reg.exe 拦了 → 退出码 0 但环境没设上 → 链接报 LNK1181。
$env:LIB = "$msvc\lib\x64;$MsvcSdkRoot\Lib\$sdkVer\um\x64;$MsvcSdkRoot\Lib\$sdkVer\ucrt\x64"

# --- INCLUDE：C 构建脚本要用（ring / webview2-com）---
$env:INCLUDE = "$msvc\include;$MsvcSdkRoot\Include\$sdkVer\ucrt;$MsvcSdkRoot\Include\$sdkVer\um;$MsvcSdkRoot\Include\$sdkVer\shared"

# cargo 也顺手补进 PATH：tauri CLI 是 node 起的子进程，找不到 cargo 会直接失败
$cargoBin = "$env:USERPROFILE\.cargo\bin"
if ((Test-Path -LiteralPath $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Write-Output "[msvc-env] MSVC $(Split-Path -Leaf $msvc) · SDK $sdkVer"
