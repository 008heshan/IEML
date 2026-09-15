# 本轮（0.1.0-dev.3）待办清单

> 这份文件是本轮对话的**工作台账**，一项做完就勾一项。
> 版本号规则见 `docs/VERSIONING.md`。

## 环境事实（实测，2026-09-14 采集）

| 项 | 值 | 怎么知道的 |
|---|---|---|
| 系统盘 | `C:`（剩余 51.7 GB） | `Get-PSDrive` |
| 非系统盘 | `D:`（541 GB 空闲）、`E:`（109 GB 空闲） | 同上 |
| IEML 数据目录（现状） | `C:\Users\Administrator\AppData\Roaming\ieml` | `prefs.json` 所在处 |
| 机器上的 Java | **25**（Adoptium，`C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot`）| 目录扫描 |
| | **25**（同上另一份，`JAVA_HOME` 指向 `C:\jdk25\jdk-25.0.3+9`，该目录**不存在**）| `$env:JAVA_HOME` |
| | **21.0.7**（Mojang 官方运行时 `.minecraft\runtime\java-runtime-delta`）| `release` 文件 |
| | **1.8.0_51**（Mojang 官方运行时 `.minecraft\runtime\jre-legacy`）| `release` 文件 |
| PATH 上的 java | 无 | `where.exe java` |
| PCL2 的 Java 列表 | 上面三份（8 / 21 / 25），缓存在 `%APPDATA%\PCL\config.json` | 读该文件 |

**结论：用户说"我确实有 java21"是对的** —— 只是那份 21 在
`%APPDATA%\.minecraft\runtime\java-runtime-delta`，是 Minecraft 官方启动器
自己下的运行时。IEML 的 `scan_java()` 只扫 `JAVA_HOME` / `PATH` /
`Program Files\*`，**从来没扫过 `.minecraft\runtime`**，所以看不见它。

---

## 任务表

| # | 任务 | 状态 | 证据 |
|---|---|---|---|
| 1 | Java 探测：扫到 `.minecraft\runtime`、PCL 缓存、注册表、盘符 | ✅ | 真机扫出 **8 / 21 / 25** 三份（`cargo test --test live_java_scan -- --ignored`） |
| 2 | Java：**禁止跨大版本兜底**，不满足时明确拒绝并说清装哪个 | ✅ | `find_java` 三段式 + 可行动的报错文案 |
| 3 | Mod 列表：补上"安装 Mod"入口（功能键） | ✅ | 概览页顶栏 / 事实行 / 版本列表 ⋯ 菜单 三处入口 + mods 目录说明 |
| 4 | 1.12.2 崩溃：定位并彻底修复 | ✅ | 根因是**老格式 natives 判据**（不是 Java 版本）；修完实测 1.12.2 在 Java 8 与 25 上都能进渲染循环 |
| 5 | OptiFine 幽灵状态 + 同类残留全量排查 | ✅ | 缓存命中漏写 `setOptifine` + `implemented` 一直假报 true（两处一起修） |
| 6 | 数据目录默认避开系统盘 | ✅ | 真机选址 → `D:\IEML`（C: 是系统盘）；老数据一次性复制迁移 |
| 7 | 版本号方案 `docs/VERSIONING.md` + 落到 `0.1.0-dev.3` | ✅ | 四处一致，`node tools/set-version.mjs --check` 已接进 `pnpm verify` |
| 8 | 重新打包并更新桌面 exe | ✅ | `tools/deploy-desktop.ps1` 用 SHA256 证明两份一致 |

**全部完成。** 本轮改动明细见 [`CHANGELOG.md`](../CHANGELOG.md) 的 `0.1.0-dev.3` 一节。
