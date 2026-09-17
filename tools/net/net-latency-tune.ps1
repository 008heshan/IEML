# 网络延迟/抖动优化（需要管理员）—— 2026-09-17
#
# 只改**有依据**的项，每一条都写清为什么。改之前打印原值，改之后回读验证。
#
# ★ 为什么用 -File 而不是 -EncodedCommand：这个仓库踩过 ——
#   `Start-Process -Verb RunAs` 配十几 KB 的 -EncodedCommand 会**静默失败**，
#   连 UAC 都不弹。用 -File 传路径是可靠的。

$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\ieml-net-tune.log"
function Say($m) { $m | Tee-Object -FilePath $log -Append }

Say "=== 网络延迟优化 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

$nic = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1
if (-not $nic) { Say "✗ 没有已连接的网卡"; exit 1 }
Say "网卡: $($nic.Name) / $($nic.InterfaceDescription)"

# ---------- 1. 网卡高级属性 ----------
# PowerSavingMode : Realtek 省电。会让链路层出现微停顿 —— 抖动的直接来源。
# GigaLite        : 降低发送信号幅度省电。线材/交换机稍差就出误码，表现就是抖动。
# *InterruptModeration : 攒批中断再交给 CPU，降低 CPU 占用但**增加延迟**。
#                        对延迟敏感的场景应当关闭（这台 CPU 完全吃得消）。
$settings = @(
    @{ kw = 'PowerSavingMode';    name = 'Power Saving Mode'; val = 0 },
    @{ kw = 'GigaLite';           name = 'Gigabit Lite';      val = 0 },
    @{ kw = '*InterruptModeration'; name = '中断调整';         val = 0 }
)

foreach ($s in $settings) {
    $before = (Get-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $s.kw -ErrorAction SilentlyContinue).DisplayValue
    if ($null -eq $before) { Say "  ? $($s.name)：这个网卡没有这一项，跳过"; continue }
    try {
        Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $s.kw -RegistryValue $s.val -NoRestart -ErrorAction Stop
        $after = (Get-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $s.kw -ErrorAction SilentlyContinue).DisplayValue
        Say "  ✓ $($s.name)：$before -> $after"
    } catch {
        Say "  ✗ $($s.name)：改不动 —— $($_.Exception.Message)"
    }
}

# 让上面的改动生效（网卡会闪断一两秒，属正常）
Say "  重启网卡使设置生效…"
Restart-NetAdapter -Name $nic.Name -ErrorAction SilentlyContinue
Start-Sleep -Seconds 6

# ---------- 2. TCP：关掉 Nagle 与延迟 ACK ----------
# ★ 只对**游戏的实时流量**有意义（小包、要求低延迟）。
#   TcpAckFrequency=1  → 收到包立刻回 ACK，不等攒批
#   TCPNoDelay=1       → 关掉 Nagle，小包立刻发，不攒成大包
#   代价：包变多（对本机带宽无所谓）。这是 FPS 游戏的常规做法。
$ifIndex = $nic.ifIndex
$tcpPath = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($nic.InterfaceGuid)"
if (Test-Path $tcpPath) {
    foreach ($kv in @(@{n='TcpAckFrequency';v=1}, @{n='TCPNoDelay';v=1}, @{n='TcpDelAckTicks';v=0})) {
        try {
            New-ItemProperty -Path $tcpPath -Name $kv.n -Value $kv.v -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            Say "  ✓ TCP $($kv.n) = $($kv.v)"
        } catch { Say "  ✗ TCP $($kv.n)：$($_.Exception.Message)" }
    }
} else {
    Say "  ? 找不到接口注册表路径，跳过 TCP 项"
}

# ---------- 3. 系统响应：把 CPU 更多留给前台（游戏） ----------
# 默认 SystemResponsiveness=20（20% 保留给后台多媒体）。改成 10 让前台拿到更多调度。
# ★ 这一项影响的是**帧生成**，不只是网络。
$mmPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$old = (Get-ItemProperty -Path $mmPath -Name SystemResponsiveness -ErrorAction SilentlyContinue).SystemResponsiveness
try {
    Set-ItemProperty -Path $mmPath -Name SystemResponsiveness -Value 10 -ErrorAction Stop
    Say "  ✓ SystemResponsiveness：$old -> $((Get-ItemProperty -Path $mmPath -Name SystemResponsiveness).SystemResponsiveness)"
} catch { Say "  ✗ SystemResponsiveness：$($_.Exception.Message)" }

# ---------- 4. 回读验证 ----------
Say ""
Say "=== 回读 ==="
foreach ($s in $settings) {
    $v = (Get-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $s.kw -ErrorAction SilentlyContinue).DisplayValue
    Say "  $($s.name) = $v"
}
Say "  TcpAckFrequency = $((Get-ItemProperty -Path $tcpPath -Name TcpAckFrequency -ErrorAction SilentlyContinue).TcpAckFrequency)"
Say "  TCPNoDelay      = $((Get-ItemProperty -Path $tcpPath -Name TCPNoDelay -ErrorAction SilentlyContinue).TCPNoDelay)"
Say "  SystemResponsiveness = $((Get-ItemProperty -Path $mmPath -Name SystemResponsiveness -ErrorAction SilentlyContinue).SystemResponsiveness)"
Say ""
Say "完成。日志: $log"
