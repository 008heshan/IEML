# 关闭 VBS 本体（2026-09-17，用户同意）
#
# ## 为什么关它有用 —— 证据不是"听说"
#
#   `HypervisorPresent = True`：虚拟机监控程序**现在就在运行**。
#   这是"有没有代价"的直接判据（不是猜的）。
#
# ## 为什么可以关 —— 两个前提都核过了
#
#   ① VBS 里跑的两个功能本机**都不需要**了：
#        · HVCI（内存完整性）—— 已经关掉（`HVCI\Enabled=0`）
#        · Credential Guard     —— 本来就没开（`LsaCfgFlags` 为空、
#                                  `SecurityServicesRunning` 里没有 1）
#      也就是说 VBS 现在是**空转**：什么都不跑，但 hypervisor 照样启动、照样收费。
#
#   ② 本机不用任何依赖 hypervisor 的东西 —— 实测：
#        · WSL 未安装
#        · Hyper-V 服务（vmcompute / vmms）不存在
#        · Containers / Docker 服务不存在
#        · `hypervisorlaunchtype` 未设置（= 由 Windows 按 VBS 需要自己决定）
#      所以设 VBS=0 之后 hypervisor 就不会再启动了。
#
# ## 代价（说清楚）
#
#   少一层**内核级**隔离。它防的是"已经拿到内核权限的东西"。
#   ★ 想恢复：把 `EnableVirtualizationBasedSecurity` 改回 1 并重启，
#     或在「Windows 安全中心 → 设备安全性 → 内核隔离」里重新打开。
#
# ## 和 bcdedit 的区别
#
#   这里**不用** `bcdedit /set hypervisorlaunchtype off`。那条是"一棍子打死"，
#   以后你要是想装 WSL2/Docker，还得记得改回来。改 VBS 这个开关更精准：
#   它只表达"我不要 VBS"，hypervisor 的启动方式仍由 Windows 按需要决定。

$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\ieml-vbs.log"
function Say($m) { $m | Tee-Object -FilePath $log -Append }

Say "=== 关闭 VBS 本体 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

$dgKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard'

# ---------- 改前 ----------
$before = (Get-ItemProperty -Path $dgKey -Name EnableVirtualizationBasedSecurity -ErrorAction SilentlyContinue).EnableVirtualizationBasedSecurity
$hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
Say "改前：EnableVirtualizationBasedSecurity = '$before'   HypervisorPresent = $hv"

# ---------- 安全闸：确认没有东西依赖它 ----------
#
# ★ 这里踩过一次坑（2026-09-17）：第一版用 `wsl -l -q` 的输出做判断，
#   而 wsl.exe 输出的是 **UTF-16**，在 PS 5.1 里被当成单字节读成乱码 ——
#   于是 `-match '未安装'` 永远匹配不到，**误报成"有 WSL 发行版"**，
#   把这次改动拦了下来。
#
#   现在改成**查注册表**：每个已安装的发行版在
#   `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\` 下有一个子键。
#   不依赖控制台编码，也不需要管理员。**没有子键 = 一个发行版都没有。**
$blockers = @()

if (Get-Service vmcompute, vmms -ErrorAction SilentlyContinue) { $blockers += 'Hyper-V 服务存在' }
if (Get-Service cexecsvc, com.docker.service -ErrorAction SilentlyContinue) { $blockers += 'Containers/Docker 服务存在' }

$lxss = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss'
$distros = @()
if (Test-Path $lxss) {
    $distros = Get-ChildItem $lxss -ErrorAction SilentlyContinue |
        ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DistributionName } |
        Where-Object { $_ }
}
if ($distros.Count -gt 0) { $blockers += "有 WSL 发行版：$($distros -join ', ')" }

if ($blockers.Count -gt 0) {
    Say "★ 检测到这些东西依赖 hypervisor，**没有改动**："
    $blockers | ForEach-Object { Say "    · $_" }
    Say "  想继续的话要先确认你不用它们。"
    exit 1
}
Say "  ✓ 确认：无 WSL 发行版（注册表 Lxss 下没有条目）/ 无 Hyper-V / 无 Docker"
Say "    —— 关掉不会影响任何东西"

# ---------- 关 VBS ----------
try {
    Set-ItemProperty -Path $dgKey -Name EnableVirtualizationBasedSecurity -Value 0 -Type DWord -ErrorAction Stop
    Say "  ✓ DeviceGuard\EnableVirtualizationBasedSecurity = 0"
} catch {
    Say "  ✗ 改失败：$($_.Exception.Message)"
    exit 1
}

# ---------- 回读 ----------
$after = (Get-ItemProperty -Path $dgKey -Name EnableVirtualizationBasedSecurity -ErrorAction SilentlyContinue).EnableVirtualizationBasedSecurity
Say ""
Say "改后回读：EnableVirtualizationBasedSecurity = $after  （0 = 已关闭）"
Say ""
Say "★ 重启后这样确认 hypervisor 真的不跑了："
Say "    (Get-CimInstance Win32_ComputerSystem).HypervisorPresent     # 期望 False"
Say "    (Get-CimInstance Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard).VirtualizationBasedSecurityStatus   # 期望 0"
Say ""
Say "★ 想恢复：把上面那个值改回 1，或到「Windows 安全中心 → 设备安全性 → 内核隔离」里打开。"
Say ""
Say "完成。日志: $log"
