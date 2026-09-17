# 关闭「内存完整性（HVCI）」—— 2026-09-17（用户明确同意）
#
# ## 为什么动它
#
#   CS2「帧生成延迟时不时变高」的头号已知成因。HVCI 让**每一次内核代码页
#   的映射都要过 hypervisor 校验**，代价是周期性的内核态停顿 ——
#   表现就是帧生成曲线上的尖刺（平均帧可能没事，1% low 很难看）。
#
#   本机实测确认它是开着的：`VirtualizationBasedSecurityStatus=2`、
#   `SecurityServicesRunning=2`（2 = HVCI）、注册表 `Enabled=1`。
#
# ## 代价（必须说清）
#
#   少一层**内核级**代码完整性保护。它防的是"已经拿到内核权限的恶意驱动"。
#   对一台日常打游戏的机器，这个风险是可接受的常见取舍；但它是**真的**取舍，
#   不是"关掉只会变快"。
#   想恢复：把 `Enabled` 改回 1 再重启，或界面里
#   「Windows 安全中心 → 设备安全性 → 内核隔离 → 内存完整性」重新打开。
#
# ## ★ 为什么**不**动 bcdedit hypervisorlaunchtype
#
#   把 hypervisor 整个关掉能再多省一点，但会**同时废掉 WSL2 / Docker /
#   Hyper-V / Windows 沙盒** —— 用户未必不用它们。
#   只关 HVCI 就够：本机的 `SecurityServicesRunning` 只有 2（HVCI），
#   没有 1（Credential Guard），所以关掉 HVCI 之后 VBS 就没有东西要跑了。

$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\ieml-hvci.log"
function Say($m) { $m | Tee-Object -FilePath $log -Append }

Say "=== 关闭内存完整性 HVCI $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

$hvciKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity'
$dgKey   = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard'

# ---------- 改前状态 ----------
$before = (Get-ItemProperty -Path $hvciKey -Name Enabled -ErrorAction SilentlyContinue).Enabled
$dgBefore = (Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard -ErrorAction SilentlyContinue)
Say "改前：HVCI Enabled=$before  VBS=$($dgBefore.VirtualizationBasedSecurityStatus)  服务=$($dgBefore.SecurityServicesRunning -join ',')"

# ---------- 关 HVCI ----------
try {
    if (-not (Test-Path $hvciKey)) { New-Item -Path $hvciKey -Force | Out-Null }
    Set-ItemProperty -Path $hvciKey -Name Enabled -Value 0 -Type DWord -ErrorAction Stop
    Say "  ✓ HypervisorEnforcedCodeIntegrity\Enabled = 0"
} catch {
    Say "  ✗ 改 HVCI 失败：$($_.Exception.Message)"
}

# ---------- 确认 VBS 不再被要求开启 ----------
# ★ 只在它**确实是 1** 时才动它。默认 Win11 这个值可能不存在或为 0，
#   乱写会把「Credential Guard」之类的其它 VBS 服务也一起关掉。
$vbs = (Get-ItemProperty -Path $dgKey -Name EnableVirtualizationBasedSecurity -ErrorAction SilentlyContinue).EnableVirtualizationBasedSecurity
Say "  DeviceGuard\EnableVirtualizationBasedSecurity = '$vbs'（当前值，先不动）"

# ---------- 检查有没有组策略/设备保护把它锁回去 ----------
$locked = $false
foreach ($p in @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeviceGuard',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\DeviceGuard'
)) {
    if (Test-Path $p) {
        $v = (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue)
        Say "  ⚠ 发现策略键 $p"
        $v.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { Say "      $($_.Name) = $($_.Value)" }
        if ($v.EnableVirtualizationBasedSecurity -eq 1 -or $v.LsaCfgFlags -eq 1) { $locked = $true }
    }
}
if ($locked) {
    Say "  ★ 有策略在强制开启 VBS —— 光改注册表重启后会被改回去，需要先删掉那条策略。"
} else {
    Say "  ✓ 没有发现强制开启的策略"
}

# ---------- 改后回读 ----------
$after = (Get-ItemProperty -Path $hvciKey -Name Enabled -ErrorAction SilentlyContinue).Enabled
Say ""
Say "改后回读：HVCI Enabled=$after  （0 = 已关闭，重启后生效）"
Say ""
Say "★ 必须重启才生效。重启后可以这样确认："
Say "    Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard |"
Say "      Select-Object VirtualizationBasedSecurityStatus, SecurityServicesRunning"
Say "  期望：VirtualizationBasedSecurityStatus=0，SecurityServicesRunning 为空"
Say ""
Say "完成。日志: $log"
