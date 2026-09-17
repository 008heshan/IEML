# 构建**带更新签名**的启动器安装包。
# ------------------------------------------------------------------
# 为什么要这个脚本（不是"包一层 tauri build"图省事）：
#
#   1. MSVC 环境。这台机器的 vcvars64.bat 因为 reg.exe 被拦而静默失效
#      （见 `msvc-env.ps1` 的说明），必须自己拼 PATH/LIB/INCLUDE。
#
#   2. 签名环境。`tauri build` 只在 `TAURI_SIGNING_PRIVATE_KEY` 存在时才产出
#      `.sig`；漏了这个变量**构建照样成功**，只是悄悄少一个文件 ——
#      于是"发布成功但没人能更新"。所以这里必检。
#
#   3. ★ 公钥/私钥一致性。`tauri.conf.json` 里内置的 pubkey 和实际用来签名的
#      私钥**必须是一对**。不是一对的后果最恶劣：包发得出去、客户端也下得下来，
#      但每一个玩家都会验签失败 —— 而且**服务端完全看不出来**。
#      所以在这里、构建之前就把它拦住（等价于 verify-manifest.mjs 里那条检查，
#      只是提前到"还没花 8 分钟编译"的时候）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\env\build-signed.ps1
#   powershell ... -File tools\env\build-signed.ps1 -KeyName ieml3
param(
    # 用哪一对密钥（`~/.ieml-release/<名字>.key` 及同名 `.key.pub`）
    [string]$KeyName = 'ieml3',
    # 密钥目录；默认在用户目录下，**不在仓库里**（见 .gitignore 的 *.key）
    [string]$KeyDir = "$env:USERPROFILE\.ieml-release"
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

. "$PSScriptRoot\msvc-env.ps1"

# ---------- 1. 找密钥 ----------
$keyPath = Join-Path $KeyDir "$KeyName.key"
$pubPath = Join-Path $KeyDir "$KeyName.key.pub"
$pwPath  = Join-Path $KeyDir 'PASSWORD.txt'

foreach ($p in @($keyPath, $pubPath)) {
    if (-not (Test-Path -LiteralPath $p)) {
        throw "找不到密钥文件：$p`n（用 pnpm exec tauri signer generate -w `"$keyPath`" -p <密码> 生成）"
    }
}

if ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $pw = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    Write-Output "[build-signed] 密码来自环境变量 TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
} elseif (Test-Path -LiteralPath $pwPath) {
    $pw = (Get-Content -Encoding UTF8 -LiteralPath $pwPath -Raw).Trim()
    Write-Output "[build-signed] 密码来自 $pwPath"
} else {
    throw "没有密码。设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD，或在 $pwPath 里放一行密码。"
}

# ---------- 2. ★ 公钥必须和 conf 里内置的那把一致 ----------
$confPub = (Get-Content -Encoding UTF8 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json).plugins.updater.pubkey
$pairPub = (Get-Content -Encoding UTF8 -LiteralPath $pubPath -Raw).Trim()
if (-not $confPub) { throw 'tauri.conf.json 里没有 plugins.updater.pubkey' }
if ($confPub.Trim() -ne $pairPub) {
    throw @"
★ 公钥不一致，不能构建！

    tauri.conf.json 内置 : $($confPub.Trim().Substring(0, 40))…
    $KeyName.key.pub 对应 : $($pairPub.Substring(0, 40))…

用 $KeyName.key 签出来的包，客户端会拿 conf 里那把公钥去验 —— 验不过，
每个玩家都会更新失败，而服务端看不出任何异常。

要么换成对应的密钥：-KeyName <另一个名字>
要么把 conf 里的公钥改过来：node tools/release/set-pubkey.mjs "$pubPath"
"@
}

# ---------- 3. 签名环境 ----------
# 传**密钥内容**而不是路径：这是 tauri 文档写明的形式，少一层"路径对不对"的变量。
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Encoding UTF8 -LiteralPath $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw
Write-Output "[build-signed] 用 $KeyName 签名（公钥与 conf 一致 ✓）"

# ---------- 4. 构建 ----------
$version = (Get-Content -Encoding UTF8 'package.json' -Raw | ConvertFrom-Json).version
Write-Output "[build-signed] 开始构建 $version（Rust 全量编译，通常 5–10 分钟）"
$sw = [Diagnostics.Stopwatch]::StartNew()

pnpm exec tauri build
$code = $LASTEXITCODE
$sw.Stop()

if ($code -ne 0) {
    throw "tauri build 失败，退出码 $code（耗时 $([int]$sw.Elapsed.TotalMinutes) 分 $($sw.Elapsed.Seconds) 秒）"
}
Write-Output "[build-signed] 构建结束，耗时 $([int]$sw.Elapsed.TotalMinutes) 分 $($sw.Elapsed.Seconds) 秒"

# ---------- 5. 产物必检：没有 .sig 等于更新通道断了 ----------
$nsis = 'src-tauri\target\release\bundle\nsis'
$exe = Get-ChildItem $nsis -Filter "*$version*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$sig = Get-ChildItem $nsis -Filter "*$version*-setup.exe.sig" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $exe) { throw "构建成功了，但 $nsis 里找不到 $version 的安装包。" }
if (-not $sig) {
    throw @"
★ 有安装包但**没有 .sig** —— 等于更新通道断了。

    $($exe.Name)

说明签名没生效。检查：
  * bundle.createUpdaterArtifacts 是否为 true（tauri.conf.json）
  * TAURI_SIGNING_PRIVATE_KEY / _PASSWORD 有没有传进去
  * 密钥是不是 `--ci` 生成的无密码密钥 —— 那种密钥会让 signer **挂住**
    并打印误导性的 "Signing without password."
"@
}

Write-Output ""
Write-Output "[build-signed] ✓ 安装包 $($exe.Name)  $([math]::Round($exe.Length/1MB,2)) MB"
Write-Output "[build-signed] ✓ 签名   $($sig.Name)  $($sig.Length) 字节"
Write-Output ""
Write-Output "下一步："
Write-Output "  node tools/release/verify-manifest.mjs     # 上传前自检"
Write-Output "  node tools/release/publish-cnb.mjs --upload"
Write-Output "  node tools/release/verify-endpoint.mjs     # 上传后按客户端的方式真验一遍"

# ★ 必须显式 exit 0：编译过程会往 stderr 写 warning（linker messages 之类），
#   而 PowerShell 把原生命令的 stderr 记成 ErrorRecord —— 于是脚本**明明成功
#   跑完了却返回退出码 1**。放进任何自动化里都会被当成构建失败（实测踩到过）。
exit 0
