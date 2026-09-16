# IEML 全流程（代码核对版）

> 2026-09-17 按**代码实际实现**整理，不是照抄设计文档。
> ★ 标注「⚠ 文档不一致」的地方是实测代码与 `ARCHITECTURE.md` 对不上的，以代码为准。
>
> 本文有两部分：
> **A. 启动器自己的安装流程**（setup.exe → 能打开）
> **B. 游戏从下载到使用的流程**（点安装 → 能进游戏）

---

# A. 启动器的安装流程

## A.0 有两条路，别混

| 路径 | 怎么走 | 谁在用 |
|---|---|---|
| **用户路径** | `IEML_<版本>_x64-setup.exe`（NSIS） | 发布给玩家 |
| **开发/自用路径** | `pnpm desktop:build` → `tools/env/deploy-desktop.ps1` **直接把 exe 拷到桌面** | 本机现在就走的这条 |

★ **本机没有安装过 IEML**：`%LOCALAPPDATA%\IEML` 不存在、注册表无卸载项，
桌面上那个 `IEML.exe` 是开发部署路径来的。所以"装没装过"和"能不能用"是两件事。

## A.1 安装包本身

配置在 `src-tauri/tauri.conf.json` 的 `bundle`：

| 项 | 值 | 含义 |
|---|---|---|
| `targets` | `["nsis"]` | 只出 NSIS，不做 MSI |
| `installMode` | `"currentUser"` | **装到用户目录，不需要管理员**（不写 HKLM） |
| `languages` | `["SimpChinese","English"]` | 安装界面双语 |
| `resources` | `[]` | 不带额外资源 |

★ **没有自定义 NSIS 模板，也没有 installer hooks** —— 全是 Tauri 的默认行为。

## A.2 装到哪、装了什么

### ★ 实跑记录（2026-09-17，用 0.1.0-beta.43 真实安装了一次）

**装前**：安装目录不存在、桌面/开始菜单无快捷方式、注册表无卸载项 —— 全空。

**向导 3 屏**（标准 NSIS，中文界面，窗口标题「IEML 安装」）：

1. **欢迎页**：「欢迎使用 IEML 安装 / 此程序将引导你完成 IEML 的安装……点击 [下一步] 继续」
2. **安装页**：「正在安装 / IEML 正在安装，请稍候」
   ＋**输出目录：`C:\Users\Administrator\AppData\Local\IEML`** ＋ 进度条
   （期间弹过一次「IEML 正在运行！点击确定以终止运行。」—— NSIS 的进程占用检查）
3. **完成页**：「IEML 已经成功安装到本机」，两个**默认勾选**的选项：
   `☑ 运行 IEML(R)`、`☑ 创建桌面快捷方式`

**装后**：

| 落点 | 内容 |
|---|---|
| `%LOCALAPPDATA%\IEML\` | **只有两个文件**：`ieml.exe` 8.06 MB ＋ `uninstall.exe` 78 KB（合计 8.13 MB） |
| 桌面 | `IEML.lnk` → `%LOCALAPPDATA%\IEML\ieml.exe` |
| 开始菜单 | `IEML.lnk` → 同上 |
| 注册表 | `HKCU\...\Uninstall\IEML`：`DisplayName=IEML`、`DisplayVersion=0.1.0-beta.43`、`Publisher=ieml`、`InstallLocation`、`UninstallString`、`EstimatedSize=8328` |
| **HKLM** | **完全没动** ← 印证 `currentUser` 模式**不需要管理员** |

★ **只有两个文件**这件事值得单说：整个前端（HTML/JS/CSS/图标）都打在 `ieml.exe` 里，
没有 `resources/`、没有 `dist/` 目录 —— 所以**装完不联网也能打开界面**。

★ **安装目录里没有 WebView2 引导程序** → 印证 A.4 的推断：「缺了才联网下载」
（本机已有 WebView2，所以什么都没下）。

★ **安装版与开发部署版只差 3 个字节**：

```
%LOCALAPPDATA%\IEML\ieml.exe   8,447,488 B   偏移 7783306 处是 "NSS"
桌面 IEML.exe                  8,447,488 B   偏移 7783306 处是 "UNK"
```

`NSS` / `UNK` 是 Tauri 打的**打包类型标记**（NSIS / 未知），来自构建日志那句
`Patching ieml.exe with bundle type information: nsis`。**功能上完全一样** ——
但排查问题时要知道"用户跑的是哪个"，别把哈希不一致当成两个不同构建。

## A.3 ★ 数据目录是**另一个地方**，首次运行才决定

程序和**用户数据分开**，这是刻意的：

- 程序：`%LOCALAPPDATA%\IEML`
- 数据：**`D:\IEML`**（本机实际）—— `platform.rs` 选址，**刻意避开系统盘**
  （见 `docs/DEV-PLAN-dev3.md` 的选址记录：C: 是系统盘，选到 D:）
- 数据根下是 `.minecraft`（**PCL 同款命名**）；老布局叫 `shared`（0.1.0-beta.2 及以前）
  → 有**一次性迁移**，且**不覆盖已有文件**（有 5 条迁移测试守着）

★ **选址记录文件放在数据根目录「旁边」，不在里面** ——
因为"数据目录在哪"这个答案如果放进被它决定的目录里，就是循环依赖：
用户一旦把数据目录搬走，启动器就再也找不到那条记录了。

## A.4 ⚠ 一个值得定的事：WebView2 依赖

WebView2 是**硬依赖**（整个界面跑在它里面）。本机已装 `153.0.4234.32`，所以从没遇到问题。

但配置里**没有 `webview2InstallMode`** → 用 Tauri 默认值。而：

- 安装器 **3.14 MB**，app 本体 **8.4 MB** —— 压缩后基本占满
- 内嵌的 WebView2 引导程序约 **1.5 MB**，**装不下**

→ 所以基本可确定是"**缺了才联网下载**"模式（`downloadBootstrapper`）。
**后果**：在没有 WebView2 的干净 Windows（Win10 21H2 以前）上，
安装器会去**微软服务器**下载引导程序 —— 对国内网络是个失败点。

（Win11 / Win10 21H2+ 都预装 WebView2，绝大多数用户碰不到。
  要不要显式配 `embedBootstrapper` 或 `skip`，需要产品决策。）

## A.5 从安装到能用

```
setup.exe（NSIS，currentUser，不需要管理员）
  ↓ 解包到 %LOCALAPPDATA%\IEML ＋ 建快捷方式 ＋ 写 HKCU 卸载项
  ↓ （若缺 WebView2：联网装它 ← 见 A.4 的风险）
首次运行 IEML.exe
  ↓ platform.rs 选址数据根目录（避开系统盘 → D:\IEML）
  ↓ 老布局迁移（shared → .minecraft，一次性，不覆盖已有文件）
  ↓ 载入 ms_client_id.txt / prefs.json
  ↓ 起 WebView2 窗口，载入**内嵌**前端（无需联网）
  ↓ 后台 spawn 下载源探测（probe.rs，**不阻塞界面**）
可以用
```

---

# B. 游戏从下载到使用的流程

## 全景

```
入口 → 预检/组合校验 → 拉元数据 → 算出 InstallPlan → 执行下载 → 收尾落盘
                                                                    ↓
                                    Java 就绪 → 启动 → 运行中 → 退出/崩溃分析
```

---

## ① 入口：三条路，收敛到同一条流水线

| 入口 | 在哪 |
|---|---|
| **下载页**「安装游戏」 | `DownloadPage.tsx`（页签：安装游戏 / 整合包 / Mod / 资源包 / 光影 / 数据包） |
| **创建实例**弹窗 | `InstallComposer.tsx`：选版本 + 基础加载器 + 附加组件 |
| **整合包** | `ModpackTab` / 拖拽 `.mrpack`、CF zip |

编排层是 `src/flows/install.ts` —— 它**只负责把规则与 I/O 按顺序串起来并上报进度**：
规则在 `src/domain/`，I/O 在 `src/bridge/`。这一层单独存在是因为"点下载 → 建任务 →
调后端 → 更新进度 → 标记已安装"这段在版本页签、加载器页签、整合包面板里都要用，
写在组件里会抄三遍。

---

## ② 预检 + 组合校验（**在 Rust 侧做，前端不判断**）

命令：`validate_combination`、`plan_install`

- Java 版本是否匹配（不匹配 → 标记待下载，不是直接失败）
- 磁盘空间、内存分配是否合理
- **组合合法性**：基础加载器互斥（只能一个）、叠加层与基础加载器是否兼容
- 产出 `auto_bridges`（如 OptiFabric）/ `auto_apis`（如 Fabric API）

★ **为什么规则只在 Rust 侧**：否则会出现"前端以为能装、后端装不了"的不一致。
前端的职责只是把用户选择发过去、把结论渲染出来。

`plan_install` 返回的 `InstallPlan` 是**纯数据结构**，在真正下载前就完全算好 ——
所以能预览（"需下载 380 MB、将自动获取 Java 8"）、能显示准确文件数、能序列化续传、能单测。

---

## ③ 拉元数据（并发）

命令：`fetch_version_manifest`、`fetch_version_json`、各加载器的 profile

- 原版版本 JSON：Mojang / BMCLAPI
- 加载器：Fabric / Quilt 走各自 meta 的 `profile/json`；Forge / NeoForge 走 installer
- **`inheritsFrom` 必须展开**：Fabric 的 profile 里写着 `inheritsFrom: "1.20.1"`，
  不与原版 JSON 合并就拿不到完整 classpath

---

## ④ 算出安装计划

- 所有待下载文件**按 SHA1 去重**（Forge 与 OptiFine 共享大量 libraries，能省 30%+ 流量）
- 展开 `inheritsFrom` 继承链
- **按依赖顺序排列步骤**

### 安装顺序铁律（硬件约束，不是偏好）

```
原版 MC  →  基础加载器（四选一）  →  叠加层（OptiFine / LiteLoader）  →  桥接包（OptiFabric）  →  API 前置包
```

- Forge 必须装在原版之上（它改原版 jar 的行为）
- OptiFine 必须在 Forge 之上（要注入 Forge 的类加载链）
- **OptiFabric 必须在 OptiFine 之后**（依赖 OptiFine 已就位）
- API 前置包（Fabric API / QFAPI）是普通 Mod，直接放 `mods/`，不参与加载器流程

**步骤间串行、步骤内并发。**

---

## ⑤ 执行下载（引擎层）

命令：`install_version` → `download_batch`

- **每文件**：下载 → 流式写盘 → 校验 SHA1 → 失败换源/重试
- **分片下载**：每段独立落盘（`.part.N`）+ 段位图，断网重来只补缺的段
- **已存在且校验通过的文件直接跳过**
- **候选 URL 在任务构造时就钉进任务里**（见 `installer.rs` 的 `push_task`）——
  批次开始后不再重新推导，否则重试轮可能又推回同一个已被 429 的源
- 进度经 Tauri Channel 推送

### ★ 源策略（本轮 0.1.0-beta.34 新加）

每个源管理器（`source.rs`）的排序是**三层叠加**：

1. **限流冷却**（429 / 限流页）→ 直接 −5000 分，压过下面两项
2. **国内优先 +25**（"国内有的就用国内"）
3. **启动实测延迟**（`probe.rs`，每源 3 个端点取中位 TTFB，**10 分钟过期**）

★ 启动时探测是**后台 spawn、绝不 await** —— 拿不到结果就沿用默认序，界面不为它多等。

### 任务控制

`pause_install` / `resume_install` / `cancel_task`。
★ **暂停 ≠ 取消**：暂停是真的把后端暂停令牌按下去（在下一个任务开始前停下，
`.part` 分片全保留）；继续是抬起令牌 + 用记住的参数重新发起。

---

## ⑥ 收尾落盘

- 解压 natives 到实例的 natives 目录
- **写入合并后的版本 JSON** —— 下次启动直接用，不用重新联网
- 生成实例 + 写配置

到这一步，实例出现在列表里，可以直接启动。

---

## ⑦ Java（按需）

命令：`java_query`、`java_install`、`java_list_downloaded`

- 选源是 **Adoptium 官方**。★ **没有可用的国内镜像**（逐站实测：TUNA 整站 403、
  NJU/BFSU/SJTU/ZJU/PKU/阿里云 404、USTC 文件被反爬拦死、CERNET 302 跳回 TUNA、
  BMCLAPI 的 java-runtime 跳 Cloudflare）—— 详见 ADR-057
- 版本判据是 **13 条带优先级的规则**，不能做成"MC 版本 → Java 版本"的查表
- 下载后**真的执行 `java -version` 验证能跑**，不验可能装个坏包到启动时才炸

---

## ⑧ 启动

命令：`preview_launch` → `launch_minecraft`

- **预览**：显示真正会执行的命令行（令牌已隐藏）
- `launch.rs`：构建命令行 → `stdout/stderr` 重定向到日志文件 → 记录 `RunningGame { pid, started_at, log_path, offline }`
- ★ **记住"这次是不是离线身份"**：离线时游戏连不上 Mojang，日志里**必然**出现
  `401 Unauthorized`。崩溃判据必须知道这件事，否则会把"我们自己造成的现象"报成故障

---

## ⑨ 启动之后

- **退出检测**：子进程结束 → 通知前端 → 自动计算本次游玩时长 → `GameExit { exit_code, played_seconds, crashed }`
- **崩溃分析**：9 大类 70 条规则的日志特征匹配 + 堆栈启发式兜底 + 一键修复
- **补齐文件**：`verify_version` 检查缺失/损坏并补下

---

## ⑩ 本会话新增、已在这条链上的东西

| 版本 | 改动 | 在这条链的位置 |
|---|---|---|
| beta.34 | `probe.rs` 启动期源探测 + 国内优先排序 | ⑤ 下载 |
| beta.35 | 账号凭据**分片**存密钥环（单条上限 1280 字符） | 认证（启动前） |
| beta.36 | 「安装 Mod」跳下载页（修掉静默装错版本的 bug） | ① 入口 |
| beta.41-43 | 账号头像走 **Mojang 官方皮肤** + 本地裁头（9/8 帽子层） | 认证 |
| beta.37 | 图标瘦身：exe −1.94 MB | 分发 |

---

## ⚠ 文档与代码不一致（实测）

| 项 | `ARCHITECTURE.md` | 代码实际 |
|---|---|---|
| 下载并发度 | 「默认 **16**（可配 8–64）」 | **`DEFAULT_CONCURRENCY = 64`**（`source.rs:142`），下限 4 |
| Java 镜像 | 「**有国内镜像可换**」 | **没有**（已更正，见 ADR-057） |

→ 第一条**还没改**，需要有人定：是文档写错了，还是代码该改回 16。
（并发 64 是有实测依据的 —— 429 后会自动减半、成功后再逐步放回，
真凭据在 `source.rs` 的 `note_rate_limited` / `recover_concurrency`。）
