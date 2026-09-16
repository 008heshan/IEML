# 极简 Minecraft 启动器 — 技术架构方案

> 项目代号：**IEML**（*Idea: Extremely Minimal Launcher*）
> 目标：极致轻量 · 真跨平台 · 现代 UI/UX · **实用优先**
> 版本：v0.2 架构设计稿

---

## 0. 设计哲学：集百家之长，实用优先

### 0.1 先看别人做对了什么

在动手之前，先把主流启动器逐一拆开，看它们各自解决了什么问题、又在哪里失败。

| 启动器 | 最强的地方 | 明显短板 |
|---|---|---|
| **PCL2** | **单页组合安装**：版本 + 加载器（Forge/Fabric/OptiFine）在同一个界面用复选框组合勾选，一次搞定<br>拖拽导入整合包<br>下载速度优化到极致（多源自动切换）<br>中文社区最佳体验 | 仅 Windows（WPF 绑定）<br>需要 .NET 环境<br>代码不开源（曾开源过）<br>UI 是 WPF 风格，不够现代 |
| **HMCL** | **真跨平台**（含 ARM / 树莓派）<br>加载器支持最全：Forge/NeoForge/Fabric/Quilt/**LiteLoader/OptiFine**<br>依赖自动解析 + 冲突检测<br>崩溃日志分析助手 | Java 写的，启动慢、内存占用高<br>UI 偏传统 Swing/JavaFX 风格 |
| **Prism Launcher** | **实例隔离做到极致**（每个实例完全独立）<br>同时接入 CurseForge + Modrinth<br>导入格式支持最全（zip / mrpack / 其他启动器）<br>高级用户控制力强 | 创建实例的流程偏「向导式」，步骤多<br>UI 是 Qt 风格，谈不上现代<br>新手面对一堆选项容易懵 |
| **CurseForge App** | 整合包库最大<br>一键安装零门槛<br>更新管理好 | 体积大、有广告<br>必须装 Overwolf 全家桶<br>不能管理非 CF 内容 |
| **Modrinth App** | 界面最清爽<br>开源，.mrpack 格式规范<br>只做 Fabric 系做得很好 | 整合包库相对小<br>其他加载器支持弱 |
| **ATLauncher** | 整合包更新机制做得好 | UI 陈旧，社区小 |
| **官方启动器** | 官方认证 | 无 Mod 管理、无整合包、启动慢 |

### 0.2 我们要抄什么

**结论不是「做得功能最多」，而是把每家的长板在同一个软件里做到位。** 具体清单：

| 抄谁 | 抄什么 | 为什么 |
|---|---|---|
| **PCL2** | ① **单页组合安装**：版本 + 加载器 + 附加组件一个界面勾选完<br>② **拖拽导入**：整合包/Mod 文件拖进窗口即安装<br>③ **多源自动切换**：下载卡住自动换镜像<br>④ **推荐版本标记**：加载器版本标出"推荐"而非让用户猜 | 这是 PCL2 最核心的竞争力，直接决定新手能否上手 |
| **HMCL** | ① **加载器全覆盖**：含 LiteLoader / OptiFine 这些老古董<br>② **依赖自动解析**<br>③ **崩溃日志分析**（不只是显示日志，而是解析出原因） | 覆盖长尾需求，且崩溃分析是真实痛点 |
| **Prism** | ① **实例强隔离**（默认开启）<br>② **多源整合**（Modrinth + CurseForge 一次搜索）<br>③ **导入格式全**（zip / mrpack / 其他启动器目录）<br>④ **实例复制** | 数据安全和兼容性 |
| **Modrinth App** | 视觉语言：克制、留白、信息层次清晰 | 现代 UI 的标杆 |
| **CurseForge** | 一键安装整合包「不用懂任何概念」的体验 | 新手的心理模型 |

### 0.3 我们要避开什么

| 反面教材 | 问题 | 我们的做法 |
|---|---|---|
| 官方启动器 | 启动慢、无 Mod 管理 | Rust 内核 + 完整 Mod 管理 |
| 各种"破解版"启动器（TLauncher 等） | 捆绑广告、隐私风险、法律问题 | **绝不支持离线绕过正版验证用于联机**，只做合法的离线单机 |
| PCL2 的 Windows 绑定 | 用户被迫换启动器 | Rust 内核天然跨平台 |
| 向导式多步流程 | 新手点五次才装好 | **单页组合安装，一次点击** |

### 0.4 核心洞察：把「下载」这个动作重新定义

这是本次改版最重要的设计决策。

**旧设计（错误）**：把安装拆成三个独立 Tab —— 先选版本 → 再选加载器 → 再装 Mod。
这是**开发者视角**，它假设用户清楚自己要什么、以及这些东西的关系。

**新设计（正确）**：一个「创建实例」界面，所有选择同时可见、互相联动、实时反馈。

```
玩家的真实心智模型：
  "我要玩 1.20.1 的 Forge，加点优化模组"
                    ↓
  一个界面里：选版本 → 加载器复选框自动可用 → 勾 Forge → 显示版本下拉 → 完成
```

**关键交互细节（抄 PCL2 但做得更好）：**

1. **版本列表在左侧**，选中后右侧**立即**出现该版本可用的加载器选项——而不是让用户去另一个页面找加载器。
2. **加载器用复选框而非下拉**：Forge / Fabric / NeoForge / Quilt / OptiFine / LiteLoader 并列展示，**不支持的自动禁用并说明原因**（如"OptiFine 不支持 1.21.1"）。用户一眼看到全部可能性。
3. **勾选后展开版本选择**，默认选中「推荐」版本并标注理由（如"最新稳定版，模组兼容性最好"）。
4. **选项之间联动校验**：选了 OptiFine 又选 Fabric 会提醒兼容性风险；选了 1.7.10 自动提示将下载 Java 8。
5. **实时预估**：底部常驻一行摘要——"将下载 约 380 MB · 需要 Java 8 · 预计 45 秒"，让用户在点击前就知道会发生什么。
6. **一键完成**：点「安装」后自动串联「下载版本 → 装加载器 → 配 Java → 建实例」，不需要用户点第二次。

**这套设计同时覆盖三种用户：**

| 用户类型 | 路径 |
|---|---|
| 纯新手 | 打开 → 点推荐的「1.21.1 原版」→ 安装 → 玩（**2 次点击**） |
| 普通玩家 | 选版本 → 选 Forge → 安装（**4 次点击**） |
| 老玩家 | 展开高级选项 → 指定加载器版本、Java、内存、镜像源 |
| 玩整合包的 | 直接把整合包文件拖进窗口（**1 次拖拽**） |

#### 下载中心不是"另一个创建实例"——三者的分工与共用

> **★ 2026-09-11 补充（三轮）。**
> 第一轮：用户问「为什么下载中心整合在了整合包栏里」→ 发现是命名错误。
> 第二轮：用户指出「**整合包单开一个选项**」→ 推翻合并方案。
> 第三轮：用户指出「**创建实例和下载中心的功能高度重合**」→ 本轮修正。

**第三轮的核心修正（第十轮）**：删除下载中心里的两个 `.setup-panel`，
创建实例从独立页面**降为弹窗**。原因是**没分清"选择"与"配置"**：

| | 选择 | 配置 |
|---|---|---|
| 对象 | 版本、加载器、整合包 | Java、内存、隔离 |
| 用户在做的事 | 挑一个 | 定一个值 |
| 不操作时存在吗 | **不存在**（只是一次选择的输入） | **存在**（是实例的属性） |
| 自然归宿 | 列表页 | 设置页 |

「创建实例」把两者缝在一起，于是它既像列表页（有版本列表）又像设置页（有 Java/内存），
**必然两头都像，也就必然与两边都重合**。完整推演见 [`DECISIONS.md` ADR-031](./DECISIONS.md)。

**分工（第十轮修订版）**：

| 位置 | 形态 | 面向 | 操作模型 | 落点 |
|---|---|---|---|---|
| **创建实例** | **弹窗**（3 处唤起） | 「我知道我要什么」 | 一次把版本+加载器+附加组件+API 配好 | 新建实例 |
| **下载中心** | 页面 | 「我先看看有什么」 | 按类别浏览 / 搜索 / 筛版本 | **两个出口**：新建实例 / 作用域路由 |
| **实例设置** | 页面 | 「我想改现有实例」 | 逐项调 Java / 内存 / 隔离 | 改现有实例 |
| **整合包** | 页面（独立一级入口） | 「我想拿来就能玩」 | 浏览成品包，看作者配好的组合 | **挑结果** |

**「作用域路由」是拆开后的关键补偿**：用户点下载中心里一个「已安装」的行时，
系统**必须先问**「给已有实例改设置，还是另建一个新实例」，
而不是默默开下（重复下载）或默默新建（凭空多一个重名实例）。
见 [`DESIGN_SYSTEM.md` 7.21](./DESIGN_SYSTEM.md)。

**页签结构**：

```
下载中心                      整合包（独立一级入口）
├── 游戏版本  只装原版游戏      ├── 搜索 / 排序（热门·最新·最多下载）
├── 加载器    给已有版本叠加    ├── 筛选（版本 / 加载器）
└── 下载队列  进行中的任务      └── 卡片网格 + 加载量提示
            └─「找整合包？→」跳转
```

**为什么整合包不能和另外两个并列成页签**：三条路径虽然都是"装东西"，
但**操作模型有本质差异**——前两者是"用户做一系列选择去配一套环境"，
整合包是"用户挑一个别人已经做好的结果"（版本+加载器+Mod 由作者在
`manifest.json` / `modrinth.index.json` 里定死）。失败恢复方式也不同：
版本安装中断只需重来，整合包中断要按清单续传。

塞进同一个页签栏还有实际后果：页签栏被占满，而整合包真正需要的能力
（封面、来源、Mod 数量、加载量提示、排序）在这个位置根本放不下。

**一条流水线，多个入口**：三条路径共用同一份约束规则
（`VER_META` / `addonCompat` / `apiForBase`）、同一条安装流水线。
第十轮之后唯一保留 `.setup-panel` 内联配置面板的是**整合包**——
因为只有它的配置对象不在当前页面的列表里，内联展开不会与列表抢结构。

**「必要设置」怎么办（第十轮修订）**：「安装」按钮不再先展开配置面板——
版本与加载器的安装直接开**创建实例弹窗**；整合包仍走内联配置面板。

**「一键完成」的承诺不变**，而且更强了：创建实例弹窗里所有配置都预填好默认值，
用户什么都不改直接点「创建并安装」即可。
Java 与内存**从创建流程中移出**——按 Mod 数量自动估算，
要调就去「实例设置」（**同一件事只在一个地方可编辑**）。

弹窗里的「高级选项」只保留真正的全局项（下载源），
Java/内存一栏显示为一句说明 + 一个「去实例设置」跳转。

### 0.5 加载器不是"可多选的复选框"——必须搞清三层结构

这一节是纠正一个关键认知错误。**加载器之间存在硬性互斥关系，不能简单做成多选。**

#### 三层模型

```
第一层：基础加载器（Base Loader）—— 四选一，严格互斥
  ┌──────────┬──────────┬──────────┬──────────┐
  │  Forge   │ NeoForge │  Fabric  │  Quilt   │
  └──────────┴──────────┴──────────┴──────────┘
  · 这四者是四套完全不同的底层框架，各自有独立的类加载器、
    mixin 注入机制和 Mod 格式
  · 一个实例只能有其中一个。不存在"装 Forge 又装 Fabric"
  · NeoForge 是 Forge 在 1.20.2 之后的分支，二者同样互斥

第二层：叠加层（Add-on）—— 可叠加，但有严格约束
  ┌───────────────────────┬─────────────────────────┐
  │      OptiFine         │      LiteLoader         │
  └───────────────────────┴─────────────────────────┘
  · 它们不提供 Mod 加载能力，而是在基座之上做增强
  · 基座可以是「基础加载器」，也可以是「纯原版」（见下方重要说明）
  · 约束关系（下详）

第三层：API 前置包（API Library）—— 自动必装，用户无需关心
  ┌──────────────┬──────────────┬──────────────────┐
  │ Fabric API   │   QFAPI      │  各框架自身的 API │
  └──────────────┴──────────────┴──────────────────┘
  · Fabric 不装 Fabric API → 绝大多数 Fabric Mod 直接报
    "requires fabric-api, which is missing!"
  · Quilt 装 QFAPI（Quilted Fabric API，已内含 Fabric API）
  · 这些应作为"基础加载器的必要组成"由启动器自动补齐，
    而不是让用户自己去搜
  · **API 包是有版本的，且版本号必须动态查询**：
    Fabric API 的版本形如 `0.92.2+1.20.1`——`+` 后面就是它绑定的
    MC 版本。1.20.1 和 1.21.1 各自对应完全不同的 Fabric API 版本。
    因此绝不能在代码里硬编码版本号，必须按 MC 版本 + 加载器
    实时查询（详见 ADR-009）
```

#### 重要更正：OptiFine 可以装在纯原版上

**上一版的错误**：约束表里写了「无（原版）→ OptiFine ❌ 无依附对象」。
这是错的。**OptiFine 完全支持独立安装在纯原版上，而且这是它最主流的用法之一。**

原理是 OptiFine 的本质是**对原版 jar 做文件覆盖 + 类替换**：

```
OptiFine 的两种身份
├─ 身份一：独立的优化 / 光影方案
│    直接覆盖原版 jar 的类文件
│    → 纯原版 + OptiFine 合法，只要光影不要 Mod 的玩家都这么用
│
└─ 身份二：Forge 生态里的一个 Mod
     作为 jar 放进 mods/ 目录
     → Forge + OptiFine 共存
```

**由此产生的实现差异**——OptiFine 的安装方式**取决于目标基座**：

| 基座 | OptiFine 安装方式 |
|---|---|
| 纯原版 | **独立 Patcher 打补丁**（OptiFine 自带 `optifine.Patcher`，以原版 jar 为输入，产出补丁后的库 jar） |
| Forge | 走 Forge 兼容路径（仍走 Patcher，但产出物作为 Forge 的一个 library） |
| Fabric / Quilt | 必须先装 OptiFabric 桥接包（1.14~1.20.4 有包，**但要玩家自己下**；1.14~1.15.2 段用 OptiFabric Origins） |
| NeoForge | ❌ 不兼容，禁止 |

> **★ 2026-09-11 第六轮修正：所谓「覆盖式安装」并不准确。**
>
> HMCL `OptiFineInstallTask.execute()` 的真实逻辑是按 installer 里有无
> `optifine/Patcher.class` 分两条路：
>
> ```java
> if (Files.exists(fs.getPath("optifine/Patcher.class"))) {
>     // 现代版本：调外部 Patcher 程序，对原版 jar 做字节码级补丁
>     String[] command = {
>         JavaRuntime.getDefault().getBinary().toString(),
>         "-cp", installerFile.toString(), "optifine.Patcher",
>         minecraftJar.toAbsolutePath().normalize().toString(),  // 原版 jar 作为输入
>         installerFile.toString(), optiFineLibraryPath.toString()
>     };
>     SystemUtils.callExternalProcess(command);
> } else {
>     // 老版本：installer 本身就是成品 jar，直接复制
>     FileUtils.copyFile(installerFile, optiFineLibraryPath);
> }
> ```
>
> 所以准确说法是：**现代版本 = 调 Java 程序对原版 jar 打字节码补丁；老版本 = 直接复制文件。**
> 两条路径都必须实现。另外还有两个容易漏的收尾动作：
> - **必须删 `META-INF/mods.toml`**（installer 副本 + 产出的库 jar 各删一次），否则 Forge 会把它当普通 Mod 去解析
> - **launchwrapper 处理**：从 installer 里提取 `launchwrapper-2.0.jar` 或 `launchwrapper-of-<ver>.jar`；两者都没有时补 `net.minecraft:launchwrapper:1.12`
>
> 产出物落在 `libraries/optifine/OptiFine/<MC版本>_<OF自述版本>/`，例如 `1.20.1_HD_U_I6`。
> HMCL 源码在类注释里明确写了：`Note: OptiFine should be installed in the end.`

#### 约束矩阵（必须硬编码进 UI 校验逻辑）

| 组合 | 是否允许 | 处理方式 |
|---|---|---|
| Forge + OptiFine | ✅ 允许 | 但要过 `optifine_suits_forge()` 四级判定，对不上则禁止 |
| Forge（MC 1.13 ~ 1.14.3）+ OptiFine | ❌ **禁止** | 该区间 Forge 与 OptiFine 不兼容 |
| Forge + LiteLoader | ✅ 允许 | 正常安装 |
| **原版 + OptiFine** | ✅ **允许** | **独立 Patcher 打补丁**，不需要任何加载器 |
| Fabric + OptiFine（MC 1.16.1 ~ 1.20.4） | ⚠️ 需要桥接 | 桥接包 **OptiFabric 存在**（CurseForge 322385），但**必须玩家自己下载**放进 mods/，UI 给出地址 |
| Fabric + OptiFine（MC 1.14 ~ 1.15.2） | ⚠️ 需手动桥接 | 上游建议用 **OptiFabric Origins**；只有 1.14.4 / 1.15.2 有包，其余如实说不支持 |
| Fabric / Quilt + OptiFine（MC ≥ 1.20.5） | ❌ **禁止** | OptiFabric 最后一个版本支持到 1.20.4；1.20.5 起 OptiFine 换了补丁挂载点，桥接包从未跟进 |
| Quilt + OptiFine | ⚠️ 需要桥接 | 同 Fabric（桥接表只按 MC 版本判，与基座无关） |
| 原版 + LiteLoader | ❌ 禁止 | LiteLoader 需要 Forge 作为基座 |
| **NeoForge + OptiFine** | ❌ **禁止** | UI 直接禁用该组合 |
| Fabric + Forge | ❌ 禁止 | 互斥，选了 A 则 B 不可选 |
| Fabric + Quilt | ❌ 禁止 | 同上（Quilt 兼容 Fabric Mod，但加载器本身二选一） |
| Forge + NeoForge | ❌ 禁止 | 同上 |
| Fabric（任意版本） | — | 自动携带 Fabric API（版本动态查询） |
| Quilt（任意版本） | — | 自动携带 QFAPI（版本动态查询） |

**四级判定 `optifine_suits_forge()` 的规则**（源码依据：PCL2 `IsOptiFineSuitForForge()`）：

| 情况 | 判定 |
|---|---|
| OptiFine 自述的 Inherit 与所选 Forge 的 MC 版本不一致 | ❌ 不兼容 |
| `RequiredForgeVersion == Nothing` | ❌ 不兼容（表示该 OptiFine 版本不支持 Forge） |
| `RequiredForgeVersion` 为空白串 | ✅ 兼容（无限制） |
| `RequiredForgeVersion` 含 `.`（如 `28.1.56`） | 与 Forge 完整版本号**精确相等**才兼容 |
| `RequiredForgeVersion` 不含 `.`（如 `1161`） | 只比 Forge 版本号的**最后一位 revision** |

> `RequiredForgeVersion` 的语义，PCL2 源码注释是逐字这么写的：
> 「需要的最低 Forge 版本。空字符串为无限制，Nothing 为不兼容，"28.1.56" 表示版本号，"1161" 表示版本号的最后一位。」
> 注意名字叫「**最低**版本」但实际判定是**精确相等**（含 `.` 时用 `CompareVersion == 0`），不要被命名误导。
> 这些数据是 PCL2 用正则从 optifine.net/downloads 的 `colForge` 列抓来的。

**另一个必须注意的点**：OptiFine 的版本号自带 MC 版本对应关系（如 `HD_U_I6` 对应 1.20.1），
且 OptiFine **不声明也不感知** MC 版本——所以选择 OptiFine 版本时必须做匹配校验，
不能任由用户选一个不匹配的版本号。此外 Forge 1.17 有个特例：
若 installer 的 `buildof.txt` 小于 `20210924-190833`，要直接抛 `FORGE_1_17_OPTIFINE_H1_PRE2` 错误。

**顺序约束**：OptiFine 必须**最后安装**。HMCL 用 `priority = 10000` 从数据结构层面保证了这一点——
安装任务按 priority 排序，OptiFine 的优先级值远大于其他加载器，天然排在队尾。

> 这张表的依据：PCL2 的 `ModComp` 模块做了同样的兼容性检查，源码中明确会 "Disable incompatible combinations (e.g., NeoForge with OptiFine)"、"Automatically suggesting additional components when needed (e.g., OptiFabric when both OptiFine and Fabric are selected)"。

#### 由此得出的 UI 规则（这是对上一版设计的重要修正）

**上一版的错误**：把 Forge / Fabric / NeoForge / Quilt / OptiFine / LiteLoader 做成六个并列的可多选复选框。

这有三个问题：
1. 四个基础加载器做成多选 → 逻辑上就是错的，用户可能勾出无法实现的组合
2. 把基础加载器和叠加层混在一起 → 概念层级混乱
3. 没体现 API 前置包 → 用户不知道 Fabric API 会被自动装上

**修正后的设计**：

```
UI 分为两个明确分组

┌─ 模组加载器（单选）────────────────────────┐
│  ◉ 无（纯原版）                            │
│  ○ Forge        ○ NeoForge                 │
│  ○ Fabric       ○ Quilt                    │
│  单选按钮，四选一。选中后展开版本下拉       │
└────────────────────────────────────────────┘

┌─ 附加组件（可多选，随加载器联动）─────────┐
│  ☐ OptiFine       ☐ LiteLoader             │
│  ─ 纯原版下：OptiFine 可用                  │
│      （Patcher 对原版 jar 打字节码补丁）    │
│  ─ 纯原版下：LiteLoader 禁用（需 Forge）    │
│  ─ 选 NeoForge 时：OptiFine 置灰 + 原因     │
│  ─ 选 Forge 且 MC 在 1.13~1.14.3：置灰      │
│  ─ 选 Fabric/Quilt 且 MC ≥1.20.5：置灰      │
│  ─ 选 Fabric/Quilt 且 1.14≤MC≤1.20.4 提示： │
│      1.14~1.15.2："需手动下载 OptiFabric    │
│                   Origins 桥接包" + 地址    │
│      1.16.1~1.20.4："需桥接包 OptiFabric，  │
│                   要你自己下载" + 地址      │
│      （**不说"会自动装"** —— 生产路径没有   │
│        下载桥接包的代码，说了就是骗人）     │
└────────────────────────────────────────────┘

┌─ 将自动安装（只读展示，不可取消）─────────┐
│  · Fabric API 0.92.2+1.20.1                │
│  随加载器 + MC 版本动态查询，非硬编码       │
│  让用户知道会发生什么                      │
└────────────────────────────────────────────┘
```

**为什么"将自动安装"要单独展示而不是静默处理**：
用户装完游戏看到 mods 文件夹里多了个 Fabric API，如果启动器没提前说明，会困惑"这东西哪来的、能不能删"。明确列出反而增加信任感——这也符合第 0.4 节"点击前就知道会发生什么"的原则。

**API 包版本号必须动态查询**：Fabric API 的版本形如 `0.92.2+1.20.1`，`+` 后面就是它绑定的 MC 版本。1.20.1 和 1.21.1 各自对应的 Fabric API 版本完全不同，硬编码必然过期。所以 UI 上显示的版本号是查询结果，不是常量。

**交互细节**：

1. 基础加载器用**单选**（radio），视觉上是一行独立的选项，不是网格卡片——因为它是一次性决策。
2. 叠加层用**复选框**（checkbox），因为可以叠加。
3. 切换基础加载器时，**叠加层的可用性实时重算**。OptiFine 的置灰条件有三类（源码依据见 ADR-003 / `LAUNCHER_SOURCE_STUDY.md` 第 3 章）：
   - 选 **NeoForge** → 无条件置灰，「NeoForge 与 OptiFine 不兼容」
   - 选 **Forge** 且 MC 版本落在 **1.13 ~ 1.14.3** → 置灰，「Forge 1.13 ~ 1.14.3 与 OptiFine 不兼容」
   - 选 **Fabric / Quilt** 且 MC 版本 **≥ 1.20.5** → 置灰，「Fabric 1.20.5 及以上与 OptiFine 不兼容」
   - 其余情况下若选了 Forge，还要过一遍 `optifine_suits_forge()` 四级判定（OptiFine 自述的 `RequiredForgeVersion` 与所选 Forge 版本是否对得上），对不上同样置灰并说明是版本号对不上。
   - 切回「无（纯原版）」时 OptiFine 恢复可用。
4. 勾选 OptiFine + Fabric 时，出现**信息提示**（不是错误）：MC 在 **1.14 ~ 1.20.4** 时显示「需要桥接包 OptiFabric，**要你自己下载**」并给出下载地址（1.14 ~ 1.15.2 段是 OptiFabric Origins），并在底部摘要里体现这一点；MC **≥ 1.20.5** 时反过来 —— 上游确实没有桥接包，判**不兼容**、拦住安装按钮。**任何情况下都不说「会自动安装桥接包」**：全仓库只有 `src/bridge/web.ts`（浏览器演示模式）有 `bridgeFile()`，生产路径根本没有下载它的代码。这段区间的划分来自上游事实（MC百科 class/1703 + CurseForge 322385），不是我们的取舍。
5. API 前置包根据基础加载器 + MC 版本**异步查询**后展示在只读区。查询未返回时显示骨架屏，查询失败时降级为警告（不阻断安装）。
6. **实例名称预填合理默认值**（如「Forge 1.20.1」），光标默认全选，用户想改直接打字即可。绝不锁定、不隐藏。详见 ADR-007。

---

## 1. 设计目标与量化指标

「轻量」这个词如果不量化，就会变成一句空话。所以先把验收标准钉死：

| 维度 | 目标值 | 对标参考 |
|---|---|---|
| 安装包体积（Windows x64） | **≤ 8 MB** | PCL2 约 12 MB（.NET 依赖后 ~50 MB+）、HMCL 约 30 MB、官方启动器 ~180 MB |
| 空闲内存占用 | **≤ 60 MB** | Electron 系启动器普遍 200–400 MB |
| 冷启动到可交互 | **≤ 500 ms** | 官方启动器约 3–6 s |
| 启动一个已就绪实例的耗时 | **≤ 300 ms**（不含 JVM 启动） | — |
| 支持平台 | Windows 10+ / macOS 11+ / Linux (glibc 2.31+) | — |
| 架构 | x64 + arm64 双架构 | — |

这套指标决定了后面几乎所有技术决策。

---

## 2. 技术选型

### 2.1 最终选型

```
┌──────────────────────────────────────────────────────┐
│  前端 UI 层                                           │
│  React 18 + TypeScript + Vite                        │
│  TailwindCSS + Radix UI + Framer Motion              │
├──────────────────────────────────────────────────────┤
│  桥接层                                               │
│  Tauri 2.x  (IPC: Command + Event + Channel)         │
├──────────────────────────────────────────────────────┤
│  核心逻辑层（Rust）                                    │
│  tokio 异步运行时                                     │
│  ├─ auth       认证（MS OAuth2 / 离线）               │
│  ├─ meta       Mojang 元数据与版本清单                 │
│  ├─ download   并发下载调度 + 完整性校验               │
│  ├─ install    版本/加载器安装流水线                   │
│  ├─ java       JRE 探测与自动获取                      │
│  ├─ mod        Modrinth / CurseForge 集成             │
│  ├─ launch     启动参数拼装与进程管理                  │
│  └─ store      本地状态与配置持久化                    │
├──────────────────────────────────────────────────────┤
│  系统层                                               │
│  OS WebView (WebView2 / WKWebView / WebKitGTK)       │
│  + Rust native bindings (reqwest / zip / sha1 ...)   │
└──────────────────────────────────────────────────────┘
```

### 2.2 为什么是 Tauri 而不是其他

**为什么不用 Electron？**
Electron 每个窗口自带一整个 Chromium（~150 MB）+ Node 运行时。这与「极致轻量」的目标是根本性冲突的，不是优化能解决的，是架构决定的。直接淘汰。

**为什么不用 Go + Wails？**
Wails 是 Tauri 的合理替代品，体积约 15–25 MB。劣势在于：
1. Rust 生态在「压缩包处理（zip/7z）」「哈希校验（sha1/sha256 硬件加速）」「并发下载」这几块比 Go 更成熟、性能更好——而这恰恰是启动器最重的负载。
2. Tauri 的 IPC 有 Channel 类型，天然适合「下载进度」这种高频流式数据推送，Wails 在这块要自己造轮子。
3. 启动器社区（如 Rust 写的 `mc-launcher` 相关库、`mc-je` 等）已有可参考实现。

**为什么不用原生 GUI（egui / Flutter）？**
- egui：性能极好、体积最小，但 UI 表现力受限于即时模式绘图，做不出「现代 UI/UX」要求的细腻质感、模糊、流畅转场。
- Flutter：UI 能力强，但桌面端要带 Dart runtime + Skia 引擎，体积约 30–50 MB，且与系统 WebView 方案相比毫无体积优势。

**Tauri 的代价，必须诚实说清楚：**

| 风险点 | 说明 | 应对 |
|---|---|---|
| WebView 行为不一致 | 三大平台分别是 WebView2 / WKWebView / WebKitGTK，CSS 表现有细微差异 | 锁定 WebView 版本基线（Win10+ 用 WebView2 Evergreen），CI 三平台跑视觉回归；禁用实验性 CSS |
| Linux 依赖系统库 | WebKitGTK 需要一个系统包，部分精简发行版需手动装 | 打 `.deb`/`.rpm`/`.AppImage` 三种包，AppImage 自带依赖 |
| Rust 编译慢 | 首次全量编译 3–8 分钟 | 配 `sccache` + `lld` 链接器；增量编译后日常 5–20 s |
| 生态相对年轻 | 部分能力要自己写 | 本项目核心逻辑本来就要自研，影响可控 |

结论：**Tauri 是唯一同时满足「≤8MB 体积」和「现代 UI 表现力」的方案**，代价可接受。

### 2.3 前端技术选型理由

| 选型 | 理由 |
|---|---|
| **React 18** | 生态最广；`useTransition` / `Suspense` 适合下载列表这类高频更新场景；社区组件多，省开发成本 |
| **TypeScript** | 启动器状态多（版本、账号、进度、配置），类型系统能省掉大量运行时 bug |
| **Vite** | 开发期 HMR 毫秒级；生产构建产物小、tree-shaking 彻底 |
| **TailwindCSS** | 无需额外 CSS 运行时（对比 styled-components 省 ~12KB + 运行时开销），产出 CSS 体积极小 |
| **Radix UI** | 无样式 + 无障碍开箱即用，弹窗/下拉/Tabs 这些要做对很麻烦，直接复用 |
| **Framer Motion** | 3.x 版 tree-shake 后仅引入用到的动画，约 15–25 KB gzip |
| **Zustand** | 状态管理仅 ~1 KB，比 Redux 轻一个数量级，够用 |

**明确不用**：UI 组件库（MUI/AntD，体积 300KB+ 且风格雷同）、CSS-in-JS 运行时、moment.js。

> 前端产物目标：**JS + CSS gzip 后 ≤ 350 KB**。启动器 UI 不需要复杂路由和重型依赖，这个目标是可达的。

---

## 3. 核心模块设计

### 3.1 认证模块 `auth`

**正版登录（Microsoft OAuth2 授权码 + PKCE 流程）**

```
用户点击「登录」
  ↓
Rust 侧起本地回环 HTTP server (127.0.0.1:随机端口)
  ↓
生成 code_verifier / code_challenge (PKCE, S256)
  ↓
打开系统浏览器 → Microsoft OAuth 授权页
  ↓ (用户登录授权)
重定向到 localhost → 拿到 authorization_code
  ↓
换取 access_token + refresh_token
  ↓
Xbox Live 认证 → XSTS 授权 → Minecraft 服务认证
  ↓
获取 Minecraft profile (UUID + 用户名 + 皮肤)
  ↓
落盘: refresh_token 存 OS 密钥环, 其余存配置
```

**关键点：**
- **不用内嵌 WebView 登录**。微软自 2021 年起明确限制内嵌浏览器登录（会导致账号风控），必须走系统浏览器 + 回环回调。这是硬性要求。
- `refresh_token` 用 `keyring` crate 存进系统密钥环（Windows Credential Manager / macOS Keychain / Linux Secret Service），**绝不落地明文**。
- 令牌过期自动静默刷新；401 时清空并提示重登。

**离线登录**：自定义用户名 + 生成离线 UUID（`UUID v3` from `OfflinePlayer:<name>`），标记 `offline: true`。启动时参数与正版一致但不带 access token。

### 3.2 元数据模块 `meta`

数据来源与降级链：

```
主源：https://launchermeta.mojang.com/mc/game/version_manifest_v2.json
  ↓ 失败
镜像：BMCLAPI (https://bmclapi2.bangbang93.com)  ← 国内网络必备
  ↓ 失败
缓存：本地 manifest 快照（带 24h TTL）
```

- 启动时先读本地缓存，**网络请求不阻塞 UI**，拉到新数据后增量更新。
- 支持自定义镜像源（中国大陆用户高频需求），设置页可切换。
- 版本类型过滤：`release` / `snapshot` / `old_beta` / `old_alpha`，默认只显示 release。

**加载器元数据（支撑单页组合安装）**

单页安装要求「选定版本后立刻知道有哪些加载器可用」，所以需要一个统一的加载器能力查询接口。

注意：接口按**三层模型**返回，而不是一个扁平列表——这是纠错后的关键设计：

```rust
/// 查询某个 Minecraft 版本支持的加载器组合能力
#[tauri::command]
async fn get_loader_capabilities(mc_version: String) -> Result<LoaderCapabilities, Error>;

#[derive(Serialize)]
struct LoaderCapabilities {
    /// 第一层：基础加载器（四选一）
    base_loaders: Vec<BaseLoaderOption>,
    /// 第二层：叠加层（可多选，带约束）
    addons: Vec<AddonOption>,
    /// 第三层：随基础加载器自动决定的 API 前置包
    api_libraries: HashMap<LoaderKind, Vec<ApiLibrary>>,
}

#[derive(Serialize)]
struct BaseLoaderOption {
    kind: LoaderKind,               // Forge | NeoForge | Fabric | Quilt
    supported: bool,
    unsupported_reason: Option<String>,   // "NeoForge 未发布 1.12.2 版本"
    versions: Vec<LoaderVersion>,          // 可用版本列表
}

#[derive(Serialize)]
struct AddonOption {
    kind: AddonKind,                // OptiFine | LiteLoader
    supported: bool,
    unsupported_reason: Option<String>,
    versions: Vec<LoaderVersion>,
    /// 与各基础加载器的兼容性规则
    compat: HashMap<LoaderKind, AddonCompat>,
}

#[derive(Serialize)]
struct AddonCompat {
    allowed: bool,
    /// 禁止时的提示，如 "NeoForge 与 OptiFine 不兼容"
    reason: Option<String>,
    /// 允许但需要额外桥接时，给出要（用户手动）补装的包
    /// 如 Fabric + OptiFine → OptiFabric（1.14~1.20.4，需手动下载）
    requires_bridge: Option<BridgePack>,
}

#[derive(Serialize)]
struct ApiLibrary {
    name: String,                   // "Fabric API"
    id: String,                     // "fabric-api"
    version: String,                // 匹配当前 MC + 加载器的版本
    required: bool,
    note: String,                   // "绝大多数 Fabric Mod 依赖此包"
}

#[derive(Serialize)]
struct LoaderVersion {
    id: String,                     // "47.2.0"
    recommended: bool,
    stable: bool,
    released_at: String,
    note: Option<String>,
}
```

**组合校验接口**（前端每次改选都调用，用于实时反馈）：

```rust
/// 校验当前选择组合是否合法，返回规范化后的结果
#[tauri::command]
async fn validate_combination(sel: LoaderSelection) -> Result<ValidationResult, Error>;

#[derive(Deserialize)]
struct LoaderSelection {
    mc_version: String,
    base: Option<LoaderKind>,       // 单选，可为 None 表示纯原版
    addons: Vec<AddonKind>,         // 多选
}

#[derive(Serialize)]
struct ValidationResult {
    valid: bool,
    /// 被自动剔除的选项（UI 应同步取消勾选）
    removed: Vec<(LoaderKind, String)>,
    /// 需要自动补装的桥接包，如 OptiFabric
    auto_bridges: Vec<BridgePack>,
    /// 需要自动安装的 API 库
    auto_apis: Vec<ApiLibrary>,
    /// 警告（不阻止安装），如 "某些 Forge 版本与 OptiFine 存在冲突"
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct BridgePack {
    name: String,                   // "OptiFabric"
    id: String,
    version: String,
    reason: String,                 // "让 OptiFine 能在 Fabric 加载器上运行"
}
```

**约束规则表**（硬编码在 Rust 侧，前端不做判断——保证唯一真相来源）：

```rust
/// 叠加层约束
///
/// 注意签名：base 是 Option<LoaderKind>，None 表示「纯原版」。
/// 这不是可有可无的设计——OptiFine 能独立装在纯原版上，
/// 所以基座必须能表达「原版」这个状态。
///
/// ★ 本实现逐条对齐 PCL2 `PageDownloadInstall.xaml.vb` 的 `LoadOptiFineGetError()`，
///   以及 `IsOptiFineSuitForForge()`。所有版本边界都是实测得来的，不要凭直觉改。
fn check_addon_compat(
    base: Option<LoaderKind>,
    addon: AddonKind,
    mc_version: &str,
) -> AddonCompat {
    match (base, addon) {
        // ★ 纯原版 + OptiFine：合法，且是主流用法。
        //   源码依据：未选任何加载器时 PCL2 的 LoadOptiFineGetError 直接 Return Nothing。
        (None, OptiFine) if optifine_supports(mc_version) =>
            AddonCompat::allowed_standalone("将对原版 jar 做字节码补丁（OptiFine Patcher）"),

        // NeoForge 与 OptiFine：无条件不兼容
        (Some(NeoForge), OptiFine) =>
            AddonCompat::denied("NeoForge 与 OptiFine 不兼容"),

        // ★ Forge 1.13 ~ 1.14.3 段与 OptiFine 不兼容
        //   PCL2 源码：CompareVersion(VanillaName,"1.13")>=0 && CompareVersion("1.14.3",VanillaName)>=0
        (Some(Forge), OptiFine)
            if cmp_ver(mc_version, "1.13") >= 0 && cmp_ver("1.14.3", mc_version) >= 0 =>
            AddonCompat::denied("Forge 1.13 ~ 1.14.3 与 OptiFine 不兼容"),

        // Forge 其他版本：需要逐版本判定 RequiredForgeVersion（见下方 optifine_suits_forge）
        // 注意这里传入了 forge_version，不能只凭 MC 版本下结论
        (Some(Forge), OptiFine) =>
            if optifine_suits_forge(optifine_version, forge_version) {
                AddonCompat::allowed()
            } else {
                AddonCompat::denied("此 OptiFine 版本不支持当前的 Forge 版本")
            },

        // ★ Fabric / Quilt 1.20.5+ 与 OptiFine 一刀切不兼容
        //   PCL2 源码：CompareVersion(VanillaName,"1.20.4") > 0
        (Some(Fabric) | Some(Quilt), OptiFine) if cmp_ver(mc_version, "1.20.4") > 0 =>
            AddonCompat::denied("Fabric 1.20.5 及以上与 OptiFine 不兼容"),

        // Fabric / Quilt ≤ 1.20.4：需要 OptiFabric 桥接
        // 注意：1.14 ~ 1.15 段需手动下载 OptiFabric Origins，要单独提示
        (Some(Fabric) | Some(Quilt), OptiFine) =>
            if in_range(mc_version, "1.14", "1.15.999") {
                AddonCompat::allowed_with_bridge_manual(
                    "OptiFabric Origins",
                    "此 MC 版本需手动下载 OptiFabric Origins 安装"
                )
            } else {
                AddonCompat::allowed_with_bridge("OptiFabric", "让 OptiFine 运行在 Fabric 系加载器上")
            },

        // LiteLoader 必须有 Forge 作为基座，纯原版不行
        (None, LiteLoader) =>
            AddonCompat::denied("LiteLoader 需要 Forge 作为基座"),
        (Some(Forge), LiteLoader) => AddonCompat::allowed(),
        (_, LiteLoader) => AddonCompat::denied("LiteLoader 只能配合 Forge"),

        // 兜底
        _ => AddonCompat::allowed(),
    }
}

/// OptiFine 与 Forge 的逐版本适配判定
///
/// ★ 四级规则，逐条来自 PCL2 的 `IsOptiFineSuitForForge()`。
///   `RequiredForgeVersion` 字段语义（PCL2 ModDownload.vb 源码注释逐字）：
///     「需要的最低 Forge 版本。空字符串为无限制，Nothing 为不兼容，
///       "28.1.56" 表示版本号，"1161" 表示版本号的最后一位。」
///   数据来自正则抓取 optifine.net/downloads 的 colForge 列。
fn optifine_suits_forge(of_meta: &OptiFineMeta, forge_version: &str) -> bool {
    // ① Inherit（MC 大版本）必须一致
    if of_meta.inherit != forge_version.mc_part() {
        return false;
    }
    match &of_meta.required_forge_version {
        // ② Nothing → 该 OptiFine 不支持 Forge
        None => false,
        // ③ 空白串 → 兼容（PCL2 issue #4183）
        Some(v) if v.trim().is_empty() => true,
        // ④ 含 "." → 与 Forge 版本做精确比较
        Some(v) if v.contains('.') => cmp_ver(v, forge_version) == 0,
        // ⑤ 不含 "." → 只比较 Forge 版本的 revision 段
        Some(v) => forge_version.revision_str() == v,
    }
}

/// API 前置包按基础加载器决定
///
/// 关键：这是 async 的，因为版本号必须动态查询。
/// Fabric API 的版本是 `0.92.2+1.20.1` 这种形式，`+` 后面绑定 MC 版本，
/// 硬编码必然过期。详见 ADR-009。
async fn api_for_loader(
    base: Option<LoaderKind>,
    mc_version: &str,
    loader_version: Option<&str>,
) -> Result<Vec<ApiLibrary>, Error> {
    match base {
        Some(Fabric) => query_latest_api("fabric-api", mc_version, "fabric").await,
        Some(Quilt)  => query_latest_api("qsl", mc_version, "quilt").await,  // QFAPI
        // Forge / NeoForge 无统一 API 包；纯原版也不需要
        _ => Ok(vec![]),
    }
}
```

数据来源：

| 加载器 | 接口 |
|---|---|
| Fabric | `meta.fabricmc.net/v2/versions/loader/<mc_version>` |
| Quilt | `meta.quiltmc.org/v3/versions/loader/<mc_version>` |
| Forge | 官方 maven 索引 + promotions_slim.json（含 recommended 标记） |
| NeoForge | NeoForged maven 索引 |
| OptiFine | 解析官方版本清单页（无 API，需缓存） |
| LiteLoader | 自有版本清单 |
| OptiFabric | Modrinth API（按 MC 版本查） |
| Fabric API / QFAPI | Modrinth API（按 MC 版本查最新兼容版） |

**注意**：这些查询并发发起、各自独立容错——某个加载器源挂了不能拖慢整个界面。所以采用「先返回能拿到的，失败的标记为未知并允许重试」策略，而不是等全部完成。

### 3.3 安装流水线 `install`

#### 3.3.1 单页组合安装（核心流程）

这是全项目最重要的入口，一次点击要完成整条链路：

```
用户在「创建实例」界面做出组合选择
  { mc_version: "1.20.1",
    base: Forge@47.2.0,
    addons: [OptiFine@HD_U_I6],
    name: "我的整合" }
        ↓
① 预检 preflight
   ├─ Java 版本是否匹配（不匹配 → 标记待下载）
   ├─ 磁盘空间是否足够
   ├─ 内存分配是否合理
   └─ **组合合法性校验**（调 validate_combination）
      ├─ 基础加载器是否只有一个（互斥检查）
      ├─ 叠加层与该基础加载器是否兼容
      └─ 产出 auto_bridges / auto_apis
        ↓
② 拉取各组件元数据（并发）
   ├─ Minecraft 版本 JSON
   ├─ 基础加载器的 install profile
   ├─ 叠加层的安装数据
   └─ API 前置包 + 桥接包的下载信息
        ↓
③ 合并成统一安装计划 install plan
   ├─ 所有待下载文件去重（多组件共享同一批 libraries）
   ├─ 计算 inheritFrom 继承链
   ├─ **按依赖顺序排列步骤**（顺序错了必崩，见下方"安装顺序铁律"）
   └─ 产出：InstallPlan { steps, total_files, total_bytes, required_java, api_libraries }
        ↓
④ 串行执行步骤，每步内部并发下载
   Step 1: 下载并安装 Minecraft 原版
   Step 2: 安装基础加载器（Forge / NeoForge / Fabric / Quilt 之一）
   Step 3: 安装叠加层（OptiFine / LiteLoader）
   Step 4: 安装桥接包（如 OptiFabric，必须在叠加层之后）
   Step 5: 写入 API 前置包到 mods/（Fabric API / QFAPI）
   Step 6: 按需下载 Java
   Step 7: 生成实例 + 写入配置
        ↓
⑤ 完成 → 实例出现在列表中，可直接启动
```

**安装顺序铁律**（顺序错了必然崩溃，这是硬件约束不是偏好）：

```
原版 MC
   ↓ 必须最先
基础加载器（四选一）
   ↓ 必须在基础加载器之后
叠加层（OptiFine / LiteLoader）
   ↓ 必须在叠加层之后（桥接包依赖它已就位）
桥接包（OptiFabric）
   ↓ 独立，直接放 mods/
API 前置包（Fabric API / QFAPI）
```

- Forge 必须在原版之上安装（它修改原版 jar 的部分行为）
- OptiFine 必须在 Forge 之上（它要注入到 Forge 的类加载链里）
- **OptiFabric 必须在 OptiFine 之后**（它依赖 OptiFine 已就位才能建立桥接）
- API 前置包是普通 Mod，直接放 `mods/` 目录，不参与加载器安装流程

**关键设计点：**

- **预检必须前置**。让用户在确认框里看到「需下载 380 MB，将自动获取 Java 8，将自动安装 Fabric API」之后再决定，而不是下载到一半才发现没 Java。
- **组合校验在 Rust 侧做，前端不判断**。前端只负责把用户选择发过去、把结果渲染出来。这样约束规则只有一份实现，不会出现"前端以为能装、后端装不了"的不一致。
- **`InstallPlan` 是纯数据结构**，在真正下载前就完全计算出来。好处：可以预览、可以显示准确的文件数和体积、可以序列化用于断点续传、可以单独写单元测试。
- **文件去重**：Forge 和 OptiFine 依赖大量相同的 libraries，按 SHA1 去重后再下载，能省 30%+ 流量。
- **步骤间串行、步骤内并发**：加载器安装有严格顺序（Forge 必须在原版之上、OptiFine 必须在 Forge 之上），不能并行；但每个步骤内部的上百个文件可以高并发。

#### 3.3.2 各安装类型的执行差异

| 安装类型 | 差异 |
|---|---|
| 纯原版 | 只有 Step 1 + Step 4 + Step 5 |
| 原版 + 加载器 | Step 1 → 按顺序装各加载器 → 剩余步骤 |
| 整合包（.mrpack） | 读取 manifest → **强制使用包内指定的版本和加载器**（不允许用户改，改了会崩）→ 额外下载所有 mods + overrides |
| 整合包（CF zip） | 读取 manifest.json → 通过 CurseForge API 解析每个 mod 的 downloadUrl |
| 拖拽 .jar | 识别为模组，安装到当前选中实例的 mods/ 目录 |
| 拖拽整合包 | 触发上述整合包流程，弹出命名确认 |
| 导入其他启动器 | 扫描 PCL/HMCL/官方 的数据目录，识别实例并转换格式 |

#### 3.3.3 底层下载引擎

无论上层是哪种安装类型，都收敛到同一个下载引擎：

**并发下载调度**（这是启动器性能的核心）：
- 用 `tokio` + `futures::stream::buffer_unordered`，并发度默认 **16**（可配 8–64）。
- 每个文件：下载 → 流式写盘 → 校验 SHA1 → 失败重试（指数退避，最多 3 次）→ 换镜像重试。
- **多源自动切换**（抄 PCL2）：同一文件维护多个候选 URL（官方源 + 各镜像），某个源连续失败自动降级到下一个，而不是整体失败。
- 进度通过 Tauri Channel 批量推送（**聚合到 60ms 一次**，避免 IPC 被冲爆导致 UI 卡顿）。
- 支持断点续传（HTTP Range）+ 已存在且校验通过的文件直接跳过。


### 3.4 Java 环境管理 `java`

```
探测本机 JRE:
  ├─ 环境变量 JAVA_HOME
  ├─ 常见安装路径 (Program Files / /usr/lib/jvm / /Library/Java)
  ├─ 其他启动器残留目录 (PCL / HMCL / 官方)
  └─ Windows 注册表
  ↓
读取每个 JRE 的 版本 / 架构 / 厂商 (解析 release 文件)
  ↓
按 Minecraft 版本匹配要求:
  ≤ 1.12.2      → Java 8
  1.13 – 1.16.5 → Java 8–11
  1.17 – 1.20.4 → Java 17
  1.20.5+       → Java 21
  ↓
缺失时自动下载 (Adoptium Temurin API, 免登录直链)
  ↓
解压到 <数据目录>/java/<major>/ , 校验通过则复用不重复下载
```

**重点**：Java 下载走 Adoptium 官方 API（`api.adoptium.net/v3/assets/latest/...`），无需登录、支持断点续传。选择 Adoptium 而非 Oracle JDK 的原因是**许可问题**——Oracle JDK 不允许自由分发，启动器不能内置。详见 ADR-013。

> ★★ **更正（2026-09-16 逐项实测）**：本节原先写「**有国内镜像可换**」，**这句是错的**，
> 已删除。Adoptium 在实测中**没有可用作程序化下载的国内镜像**：
>
> | 镜像站 | 结果 |
> |---|---|
> | 清华 TUNA | **整站 403**（连 `/ubuntu/` 都是 403，不是 Adoptium 路径问题） |
> | 南大 NJU / 北外 BFSU / 上交 SJTU / 浙大 ZJU / 北大 PKU / 阿里云 | **404，没有 Adoptium 镜像** |
> | 中科大 USTC | 有目录（`adoptium/releases/temurin21-binaries/`），但**文件下载被 JS 反爬验证拦死** —— 返回 859 字节的 "Verifying" 页面而非文件 |
> | CERNET 联合镜像 | `/Adoptium/` **302 跳回 TUNA**（同样 403） |
> | BMCLAPI | 有 `/v1/products/java-runtime/` 路径，但 **302 跳到 Cloudflare 后端**（`*.749333.xyz` → `162.159.x`），**并非国内源** |
>
> 所以 Java 自动下载目前**只能走 Adoptium 官方**（`adoptium.rs` 的代码注释一直是对的，
> 是本节文档写错了）。官方 API 实测**时段性可用**：有时 223 ms / 3-3 成功，
> 有时整段超时 —— 与 GitHub / Modrinth 的抖动同源，属于国际出口问题，不是本机能修的。
>
> 复核脚本：`tools/probe/probe-adoptium-mirror.mjs`、`probe-adoptium-layout.mjs`、
> `probe-ustc-adoptium.mjs`、`probe-java-runtime-mirror.mjs`。

**必须做到的几点**：

1. **版本不匹配时不能用**。要求 Java 17 却给了 Java 21，很多 Mod 会崩。发现不匹配必须提示，让用户选「用已有 Java」或「自动下载正确的」。
2. **自动下载的 JRE 必须可见可删**。设置页列出所有 JRE（路径 / 版本 / 架构 / 来源），自动下载的那几个标出来，并显示各自占用的磁盘体积。**不能悄悄占几百 MB 而不让用户知道**。
3. **校验方式**：检查 `bin/java(.exe)` 可执行 + 读 `release` 文件确认版本号与架构（不是只看目录名）。
4. **架构要匹配**：ARM64 机器上装 x64 JRE 能跑但性能差，应优先选原生架构。

### 3.5 Mod / 整合包 `mod`

| 源 | 说明 |
|---|---|
| **Modrinth** | 开放 API，无鉴权即可搜索/下载，**作为默认源** |
| **CurseForge** | 需要 API Key，功能更全但受限；做成可选源，Key 可在设置里填 |

**搜索体验（集 Modrinth 的克制 + CurseForge 的一步到位）：**
- 按「当前实例的 Minecraft 版本 + 加载器」**自动过滤**搜索结果，避免装错版本。
- 多源聚合搜索：一次查询同时打 Modrinth 和 CurseForge，结果合并去重（同一 Mod 的作者名+ID 判重），优先展示 Modrinth 条目。
- 支持按中文关键词搜索（Modrinth 的搜索已支持中文，CF 需靠本地别名表兜底）。

**安装体验（抄 PCL2 的一键）：**
- 依赖解析：读取 Mod 的 `fabric.mod.json` / `mods.toml` / `neoforge.mods.toml` 声明的 `depends`，**递归解析整条依赖树**，一次性给出「安装此 Mod 还需安装这 3 个」的清单，一键全装。
- **API 前置包自动补全**（关键，新手最常踩的坑）：
  - Fabric 实例 → 自动确保 [Fabric API] 已安装；缺失时 Mod 会直接报
    `Mod 'Zoomify' (zoomify) requires any version of fabric-api, which is missing!`
  - Quilt 实例 → 自动确保 [QFAPI]（Quilted Fabric API，已内含 Fabric API）
  - Forge / NeoForge → 无统一 API，但某些 Mod 依赖特定框架 Mod（如 `blueprint`、`codechickenlib`），
    由依赖树解析统一处理
  - 这些不是普通可选依赖，而是"缺了就跑不起来"的硬依赖，启动器必须主动补齐而非等用户报错来找
  - **注意**：这里的"自动补齐"发生在**用户主动安装某个 Mod 时**，
    而不是在后台自动改动已装的 Mod 集合。两者性质完全不同，见下方「Mod 更新策略」。
- **版本区间校验**：依赖声明里带版本范围（如 `sodium` 要求 `[0.4.10, ∞)`），必须校验已装版本是否满足，不满足则提示升级。日志形态：
  `Sodium Extra requires version [0.4.10, ∞) of sodium, but only the wrong version is present!`
- 自动匹配加载器差异：同一个 Mod 在 Fabric 和 Forge 下的 jar 是不同文件，必须按实例加载器选对下载版本。
- 冲突检测：同一 Mod ID 的重复文件、声明了 `breaks` 的互斥组合、以及已知的运行时冲突对（维护一份社区冲突表）。
- **拖拽安装**：把 `.jar` 拖进窗口 → 自动识别是 Mod / 资源包 / 光影包 / 整合包 → 安装到正确位置。

**加载器互斥的运行时保护**：

除了安装时的 UI 校验，还要在**启动前**再检查一次实例配置，防止用户手动改配置文件造出非法组合：

```rust
/// 启动前校验实例的加载器组成是否合法
fn validate_instance(instance: &Instance) -> Result<(), LaunchError> {
    // 1. 基础加载器只能有一个
    if instance.base_loaders.len() > 1 {
        return Err(LaunchError::MultipleBaseLoaders);
    }
    // 2. 叠加层与基础加载器的兼容性
    for addon in &instance.addons {
        let compat = check_addon_compat(instance.base, addon);
        if !compat.allowed {
            return Err(LaunchError::IncompatibleCombo(compat.reason));
        }
    }
    // 3. 需要桥接的叠加层，桥接包是否存在
    //    如 Fabric + OptiFine 但 mods/ 里没有 OptiFabric → 提示补装
    ...
}
```

**为什么要在启动前再查一遍**：用户会手动改配置、会从别处拷贝实例、会在文件管理器里删文件。安装时的校验管不到这些情况。启动前拦截并给出明确原因，比让游戏崩在半路体验好得多。

#### Mod 更新策略：绝不自动更新（★ 第五轮核心决策）

**这是与"App 更新"本质不同的一件事。Mod 不是独立软件，它是一个三方耦合体：**

```
      Minecraft 版本
            │
    必须严格对齐（三角兼容）
            │
 加载器版本 ─┴─ Mod 版本
            │
     API 前置包版本

⚠ 任何一角变动，另外两角可能立即失效
```

**自动更新会造成的实际后果**：

| 场景 | 结果 |
|---|---|
| 新版 Mod 只支持 1.21.1，实例是 1.20.1 | 加载时直接崩 |
| 新版 Mod 要求更高版本的 Fabric API | 报 `requires version [0.9x.x, ∞) of fabric-api, but only the wrong version is present!` |
| 新版 Mod 要求更高的加载器版本 | Mixin 注入失败 |
| 新旧 Mod 存档格式不兼容 | **存档损坏（不可逆）** |

**而任何"自动更新"逻辑本质上只能判断"有更新"，无法判断"回到用户这个具体实例里还成不成立"。**
一旦静默替换，用户下次开游戏直接崩，且**不知道是谁干的**——这比不更新恶劣得多。

> 决策依据见 [`DECISIONS.md` ADR-018](./DECISIONS.md)。PCL2 的实际行为也已核实：
> `UpdateMods()` 只由用户手动点击触发，更新前弹警告，旧版本移入回收站。
> **PCL2 从不自动更新 Mod**——这一点照抄，不做"优化"。

**我们的规则：**

```
✅ 允许的自动化：启动时后台检查 → 只在 UI 上显示「N 个 Mod 可更新」角标
❌ 禁止的自动化：自动下载、自动替换、自动升级、一键全更新（无校验）

用户显式点击更新时，必须：
  ① 按「当前实例的 MC 版本 + 加载器」筛出合适的新版本（不是简单取最新）
  ② 展示 当前版本 → 目标版本 对照，标注是否跨 MC 版本
  ③ 校验目标版本对其他组件的新要求（API 版本、加载器最低版本）
  ④ 旧文件移入回收站而非删除
```

**更新候选的版本选择规则**（关键，不能简单取 latest）：

```rust
/// 为一个已安装的 Mod 挑选可更新的目标版本
fn pick_update_target(
    installed: &McMod,
    instance: &Instance,
    remote_files: &[CompFile],
) -> UpdateDecision {
    // ① 优先：当前实例的 MC 版本 + 加载器下，取最新
    if let Some(f) = remote_files.iter()
        .filter(|f| f.matches(&instance.mc_version, instance.loader))
        .max_by_key(|f| f.release_date) {
        return UpdateDecision::Available { file: f.clone() };
    }
    // ② 该 Mod 已放弃这个 MC 版本 → 明确告知，不静默降级
    let newest = remote_files.iter().max_by_key(|f| f.release_date);
    UpdateDecision::NoCompatibleVersion {
        msg: format!(
            "此 Mod 已不再支持 {}，最新版仅支持 {}。继续更新会导致游戏无法启动。",
            instance.mc_version, newest.supported_versions()
        ),
        fallback: newest.cloned(),   // 让用户自己决定
    }
}
```

**批量更新的规则**：用户全选点更新时，**逐个按上述规则校验，分成两组**：

```
可以安全更新（8 个）    ← 默认勾选
├── JEI      15.2.0.110 → 15.3.0.5    同 MC 版本 ✓
└── Sodium   0.5.8 → 0.5.11           同 MC 版本 ✓

会破坏兼容（2 个）      ← 默认不勾选，需单独确认
├── ⚠ Create  0.5.1 → 6.0.0   跨 MC 版本（1.20.1 → 1.21.1）
└── ⚠ Iris    1.6.5 → 1.7.0   要求加载器 ≥ 0.16.0，当前 0.15.7
```

**整合包实例的例外**：从整合包安装的实例，Mod 版本由 manifest 锁定，**更新按钮应置灰**并说明
「此实例由整合包管理，作者未提供新版本清单」。若整合包有新 manifest，走**整合包整体更新**流程，
而不是一个个 Mod 单独更新——因为整合包作者验证过的是一整套组合。

#### Mod 管理页的信息结构

每个 Mod 项要能**一眼看出状态**，而不是只列文件名：

```
┌──────────────────────────────────────────────────────────────┐
│ ☑  [图标]  JEI                                                 │
│          Just Enough Items · 15.2.0.110                        │
│          Fabric · 1.20.1 · jei-1.20.1-fabric-15.2.0.110.jar    │
│          [可更新 ↑]  [有依赖]                          [⋯]     │
└──────────────────────────────────────────────────────────────┘
```

**状态徽标**（优先级从上到下，只显示最高优先级的一个）：

| 徽标 | 色 | 含义 |
|---|---|---|
| **可能不兼容** | 黄 | Mod 自述的兼容范围不含当前实例 —— **仅提示，不代表一定不能跑** |
| 有错误 | 红 | 文件损坏 / 读不出来 |
| 可更新 | 蓝 | 有可用更新（**仅标记，不动文件**） |
| 有依赖 | 灰 | 此 Mod 依赖其他包 |
| 前置库 | 灰 | 其他 Mod 依赖它 |

> **★ 2026-09-11 第六轮修正：Mismatch 降级为「可能不兼容」。**
>
> 原设计想「主动检测 Mismatch」并标红。源码研读发现**这个方案不成立**：
>
> - HMCL 的 `FabricModMetadata` 解析 `fabric.mod.json` 时，
>   **只读 `id / name / version / description / icon / authors / contact` 七个字段，
>   完全不解析 `depends` / `breaks` / `conflicts`**
> - HMCL 的 `ForgeNewModMetadata` 虽然读 `dependencies` 数组，
>   但**只为了判断「这个 jar 属于 Forge 还是 NeoForge」**，不校验版本区间。
>   而且源码里有这两行：
>   ```java
>   LOG.warning("Loader mismatch for mod " + modID + ", found " + result + ", expecting " + loader);
>   LOG.warning("Cannot determine the mod loader for mod " + modID + ", expected " + loader);
>   ```
>   **连 HMCL 自己都只敢记个 warning，然后采信 TOML 里声明的那个。**
> - PCL2 的 `McMod` 只有 Fine / Disabled / Unavailable 三态，没有 Mismatch
>
> **现实中的 Mod 元数据太脏**：写错的、漏写的、故意写宽范围的比比皆是。
> 基于它做硬性判定会**大量误报**，反而让用户不信任徽标。
>
> **修正后的四级策略：**
>
> | 层次 | 做法 | UI 表现 |
> |---|---|---|
> | L1 元数据读取 | 读 MC 版本声明 | — |
> | L2 提示 | 声明范围不含当前实例 → 标「可能不兼容」 | **黄色 + 可点开解释** |
> | L3 文件名启发式 | 括号里的版本号仅用于排序 | 不显示 |
> | **L4 运行时判定（主力）** | 崩溃日志分析 | 红色 + 精确定位 |
>
> **「可能不兼容」徽标点击后必须展开说明：**
> > 此判断基于 Mod 自述的兼容信息，作者可能未及时更新或填写不准。
> > 实际是否可用**以能否启动为准**。如果启动时崩溃，IEML 会分析日志给出确切原因。
>
> **运行时判定才是可靠的**：HMCL 的崩溃规则里有专门一条：
> ```
> MOD_RESOLUTION_MISSING_MINECRAFT
>   正则：...requires \{minecraft @ (?<version>.*)}
> ```
> **「Mod 与 MC 版本不兼容」在崩溃日志里有明确签名。**
> 应该把判定权交给运行时，而不是靠元数据预检去猜。

各加载器的兼容性字段位置：

| 加载器 | 元数据文件 | 兼容性字段 |
|---|---|---|
| Fabric | `fabric.mod.json` | `depends.minecraft`（版本区间） |
| Forge (1.13+) | `META-INF/mods.toml` | `[[dependencies.*]]` 的 `versionRange`（`modId = "minecraft"` 那条） |
| Forge (≤1.12.2) | `mcmod.info` | `mcversion`（单值，必须精确相等） |
| NeoForge | `META-INF/neoforge.mods.toml`（失败回退 `mods.toml`） | 同 Forge |
| Quilt | `quilt.mod.json` | `depends` |
| LiteLoader | — | `LiteModMetadata` |
| Forge jar-in-jar | `META-INF/jarjar/metadata.json` 或 `MANIFEST.MF: Embedded-Dependencies-Mod` | 需递归解析内嵌 jar |

**解析时必须容错的三点（来自 HMCL 的实战经验）：**

1. **`dependencies` 数组格式不统一** —— HMCL 试了三种写法，且每层都包 `catch ignored`：
   ```java
   toml.getArray("dependencies." + modID)   // 标准
   toml.getArray("dependencies")             // 源码注释：I have no idea why some of the Forge mods use [[dependencies]]
   toml.getTable("dependencies").getArray(modID)  // 变体
   ```
   （对应 HMCL issue #5068）
2. **一个 jar 可能有多个 mod 块** —— HMCL 只取 `mods.get(0)`，后面的忽略
3. **`${file.jarVersion}` 占位符** —— 需从 `MANIFEST.MF` 的 `Implementation-Version` 取值替换

**提示「可能不兼容」时必须说明具体哪里不同**：
- ✅「此 Mod 自述支持 1.21.1，当前实例是 1.20.1（仅供参考）」
- ❌「不兼容」

**筛选器**：全部 / 已启用 / 已禁用 / 可更新 / **可能不兼容** / 有错误 / 前置库

**批量操作侧栏**（选中后从底部升起）：启用 / 禁用 / 更新 / 删除 / 取消选择

**禁用用改后缀（`.disabled`）而非移走文件**——这样用户能在文件管理器里直接看出来它是被禁用的。
PCL2 用 `.disabled` / `.old` 后缀，这个做法是对的，照抄。

**整合包管理：**
- 支持 `.mrpack`（Modrinth）、CF zip、以及通用 zip（无 manifest 的纯文件包）
- 生成独立实例，**强制锁定包指定的 MC 版本与加载器**（用户不可改，改了必然崩）
- 整合包 manifest 里已声明加载器与依赖，**不再重复询问用户**，也跳过 API 自动补全（包内已包含）
- 支持整合包更新：对比 manifest 版本，只下载差异部分

**资源包 / 光影包管理（★ 用户指定加入）：**

资源包（`resourcepacks/`）与光影包（`shaderpacks/`）纳入统一管理界面，并支持拖拽安装。

**拖拽时的类型判定顺序（顺序很重要，错了会误判）**：

```
第 1 步  整合包？  zip 内有 manifest.json / modrinth.index.json
第 2 步  Mod？     zip/jar 内有 fabric.mod.json / META-INF/mods.toml
                  / neoforge.mods.toml
第 3 步  光影包？  zip 内有 shaders/ 目录
第 4 步  资源包？  zip 内有 pack.mcmeta
```

**必须按这个顺序**：整合包里也有 `mods/` 目录，如果先判 Mod 会把整合包误判成一个 Mod。

**光影依赖约束**：光影包**必须配合 OptiFine 或 Iris 才能生效**。
用户往一个没有光影支持的实例里拖光影包时，必须提示：
「当前实例未安装 OptiFine 或 Iris，光影不会生效，是否现在安装？」
——而不是静默复制进去让用户对着不生效的光影发呆。

**中文搜索 Mod（★ 用户指定加入）：**

支持用中文搜索（「工业时代」「等价交换」「暮色森林」）。采用**本地别名映射表 + 平台原生搜索**双路（详见 ADR-016）：

```
用户输入中文
    ↓
① 查本地别名表（中文名 → 英文 slug/关键词）→ 命中则用英文调平台 API
    ↓ 未命中
② 原样提交给平台搜索（Modrinth 有一定中文支持）
    ↓ 仍无结果
③ 提示"未找到，试试英文名"
```

词表结构示例：
```json
{
  "工业时代": ["industrialcraft", "ic2"],
  "等价交换": ["projecte", "equivalent-exchange"],
  "暮色森林": ["twilightforest"]
}
```

词表作为**静态共享数据**一次构建进包，不做网络更新（避免运营负担）。
体积很小（几千条约几十 KB），可接受。优先复用开源词表，自建部分靠用户搜索日志逐步补全。


### 3.6 启动模块 `launch`

参数拼装是最容易出错的地方，需要严格按 Mojang 的 `arguments` 规范处理：

```
java -Xmx<mem> -Xms<mem> -Djava.library.path=<natives>
     -cp <libraries>:<client.jar>
     <mainClass>
     --username <name> --uuid <uuid> --accessToken <token>
     --version <ver> --gameDir <dir> --assetsDir <dir>
     --assetIndex <index> --userType <msa|legacy>
     --width <w> --height <h>
     [加载器附加参数]
     [用户自定义 JVM/游戏参数]
```

**要点：**
- **参数规则表**：Mojang 的 `arguments.game` / `arguments.jvm` 里含大量条件规则（`rules`），需按 OS / 特性逐条求值。老版本用 `minecraftArguments` 字符串模板，走 `-D` 变量替换路径。两条路都要实现。
- **进程管理**：`std::process::Command` 起子进程，stdout/stderr 重定向到日志文件，实时抓取崩溃信息（如 `Exit Code: -1` / OOM）。
- **退出检测**：子进程结束 → 通知前端 → 自动计算本次游玩时长。
- **启动前自检**：Java 版本是否匹配、内存是否超物理上限、关键文件是否完整——有问题先拦下来，而不是让游戏崩了再猜。

**崩溃分析（★ 用户指定加入，这是口碑功能）：**

不只是保存日志，而是**解析出人话结论**。采用**三段式流水线**（详见 ADR-011）：

```
① 收集
   ├─ crash-reports/*.txt
   ├─ 版本目录下 latest.log / debug.log
   ├─ hs_err_pid*.log（JVM 级崩溃，Java 自己挂掉时才产生）
   └─ 启动器捕获的游戏 stdout

② 分析（按优先级递进，高优先级先命中就提前返回）
   ├─ 高优先级特征：确定性结论
   │    OutOfMemoryError / UnsupportedClassVersionError /
   │    "Unable to make protected final java.lang.Class"（Java 不兼容）/
   │    OpenGL not supported / Mod 被解压成文件夹 / 32位Java内存限制
   ├─ 堆栈分析：过滤掉 java|minecraft|forge|fabric|mixin 等噪音包名，
   │    剩余包名反查定位到具体 Mod；
   │    同时读取 Forge 崩溃报告的 "Suspected Mod" 段
   └─ 低优先级模糊匹配：兜底
```

**崩溃模式库**（必须覆盖，对齐 PCL2 的 `CrashReason` 枚举）：

| 类别 | 日志特征 | 结论 | 一键修复 |
|---|---|---|---|
| 内存 | `java.lang.OutOfMemoryError` | 内存不足 | 提高内存分配（按物理内存给建议值） |
| 内存 | 32 位 Java + OOM | 32 位 Java 有 ~1.5G 上限 | 切换到 64 位 Java |
| Java | `UnsupportedClassVersionError` | Java 版本过低 | 切换到匹配版本 |
| Java | `Unable to make protected final java.lang.Class` | Java 版本过高 | 降级到匹配版本 |
| Java | 检测到 JDK 而非 JRE / OpenJ9 | 特定 JVM 有兼容问题 | 改用标准 JRE |
| 加载器 | `NoClassDefFoundError: net/minecraft/...` | 加载器未正确安装 | 重新安装加载器 |
| 加载器 | Mixin 相关异常 | Mixin 注入失败 | 定位到冲突 Mod |
| Mod | `Missing or unsupported mandatory dependencies` | Mod 依赖缺失 | 列出缺失项并一键安装 |
| Mod | 堆栈中定位到具体 Mod 包名 | 某 Mod 崩溃 | 建议禁用该 Mod |
| Mod | mods/ 下存在被解压的文件夹 | Mod 被解压了，无法加载 | 提示重新下载为 jar |
| Mod | 同名 Mod 存在多个版本 | 重复 Mod | 列出重复项，保留最新 |
| Mod | 文件名含特殊字符 | 加载器无法识别 | 建议重命名 |
| 图形 | `Pixel format not accelerated` | 显卡驱动 / OpenGL 问题 | 提示更新驱动 |
| 图形 | access violation | 驱动不兼容 | 提示更新或回滚驱动 |

**关键约束**：
- **分析本身只读**。「一键修复」是显式的用户操作，不分析完自动改东西。
- **禁止甩堆栈**：弹窗首屏必须是「可能原因 + 建议动作」，原始堆栈折叠在下面。

**崩溃报告导出（★ 用户指定加入）：**

崩溃弹窗提供「导出报告」按钮，打包成 ZIP：

```
IEML-crash-<时间戳>.zip
├── 分析结果.txt          ← 人话结论，放最外层方便直接看
├── latest.log / debug.log
├── crash-report.txt
├── hs_err_pid*.log（若存在）
├── instance.json         ← 实例配置（内存/Java/加载器组合）
├── mods-list.txt         ← mods 清单（文件名 + SHA1）
└── system-info.txt       ← 系统 / CPU / 内存 / 显卡 / Java 列表
```

**目的**：把「求助」的成本从「自己翻日志找关键行」降到「点一下按钮」。用户把 ZIP 丢到群里，别人立刻看懂。

**隐私约束（必须实现）**：日志里会出现正版账号名、UUID、token 片段。打包前必须脱敏——
玩家名替换为 `<player>`、UUID 替换为 `<uuid>`、正则扫描移除 `eyJ...` 形式的 JWT。
打包后弹窗列出「已包含哪些文件、已脱敏哪些内容」，让用户知情。

### 3.7 持久化 `store`

```
<数据目录>/                        # 默认: 各平台标准应用数据目录
├── launcher.json                  # 全局配置(主题/语言/并发数/镜像)
├── accounts.json                  # 账号列表(不含 token)
├── versions/                      # 每个实例
│   ├── 1.20.4/
│   │   ├── <ver>.json             # 合并后的完整版本描述
│   │   ├── <ver>.jar
│   │   ├── mods/
│   │   ├── resourcepacks/
│   │   ├── shaderpacks/           # 光影包
│   │   ├── saves/
│   │   └── instance.json          # 实例级配置(显示名/内存/Java/图标/隔离策略)
│   └── fabric-1.20.4-0.15.7/
├── libraries/                     # 全局共享库(跨实例复用)
├── assets/                        # 全局共享资源
├── java/                          # 下载的 JRE
├── cache/                         # 元数据缓存(见下方缓存机制)
├── backups/                       # 实例备份(见下方备份机制)
└── logs/                          # 运行日志 + 崩溃报告
```

- 格式用 **JSON**（人类可读、便于用户手动修）。
- 写入原子性：先写 `.tmp` 再 `rename`，避免断电写坏配置。
- **兼容读取其他启动器的目录**：可扫描 PCL2 / HMCL / 官方启动器的数据目录，识别已有实例并导入（不移动原文件，只建立引用或复制）。

#### 3.7.1 版本隔离策略：按需隔离（★ 用户指定为必要）

**不做「全局一刀切开关」**，改用**三段优先级判定**（详见 ADR-005）：

```
1. 用户对该实例的显式设置（isolation: auto | on | off）
        ↓ 为 auto 时
2. 自动判断：该版本目录下是否已存在 mods/ 或 saves/
        有 → 隔离
        ↓ 都没有
3. 判定为不隔离（默认值 auto）
```

**为什么不能一刀切**：
- 全隔离 → 只想玩原版的用户会纳闷「为什么每个版本都占一份资源」
- 全不隔离 → 1.20.1 的 Forge Mod 混进 1.21.1 的 classpath，**必崩**

**UI 表现**：实例设置页提供三档选择器（自动 / 强制隔离 / 强制不隔离）。选「自动」时，
旁边显示**当前判定结果与理由**（如"已检测到 mods 目录，将启用隔离"）——让用户知道
启动器替他做了什么决定，而不是黑箱。

#### 3.7.2 缓存机制（★ 用户指定为必要）

所有网络元数据落地缓存，采用「**先返回缓存、后台刷新、增量更新**」策略。
理由：冷启动等 Mojang 元数据返回，国内网络要 3–10 秒，与「≤500ms 可交互」直接冲突。

| 缓存对象 | 位置 | TTL | 说明 |
|---|---|---|---|
| 版本清单 manifest | `cache/manifest.json` | 6h | 到期后台刷新 |
| 单版本元数据 | `cache/versions/<ver>.json` | **永久** | 版本发布后不再变 |
| 加载器版本列表 | `cache/loaders/<kind>.json` | 12h | — |
| OptiFine 版本页解析结果 | `cache/optifine.json` | 24h | 无官方 API，解析成本高，缓存更久 |
| 资源索引 assets index | `cache/assets/<index>.json` | **永久** | 不会变 |
| Mod 搜索/项目信息 | `cache/modrinth/*.json` | 1h | — |
| 实例列表与元信息 | `cache/instances.json` | — | 按需失效 |

**缓存 key 的设计**（抄 PCL2）：对「一组输入」求 hash 作为 key。
例如版本列表缓存的 key = `hash(所有实例目录名 + 缓存格式版本号)`。
这样只要实例目录变了、或我们升级了缓存格式，缓存自动整体失效，**不需要手写失效逻辑**。

**关键约束**：
- 缓存必须带**格式版本号**。日后数据结构变了，靠版本号一次性作废旧缓存，而不是写迁移代码。
- 缓存损坏不能让启动器崩溃——解析失败就当缓存不存在，重新拉取。
- 设置页提供「清空缓存」按钮，并显示当前缓存占用体积。
- 缓存目录不参与安装包体积指标（它是运行期数据）。

#### 3.7.3 备份与回滚（★ 用户指定加入）

最痛的场景是「装了个 Mod 把存档搞坏了」。备份是低成本高价值的保险（详见 ADR-014）。

**备份范围**：
```
saves/           存档（最重要，体积大）
config/          配置
options.txt      游戏设置
servers.dat      服务器列表
mods/ 的清单     只存文件名 + SHA1，不存 jar 本体
```

**关键设计：mods 不备份 jar，只备份清单。**
回滚时按清单对比——缺的从缓存/网络补，多的删。这样一次备份通常只有几 MB
而不是几百 MB。没有这个设计，自动备份会把用户磁盘吃光。

**存储策略**：
- 位置 `backups/<实例名>/<时间戳>/`
- `saves/` 采用**滚动保留**：默认保留最近 5 份，超出删最旧的
- 自动备份**默认开启**，触发时机为「启动游戏前」

**回滚安全**：回滚前**必须先把当前状态也备份一份**（pre-rollback snapshot），
避免用户回滚后后悔却回不去。这是硬要求。

**UI 表现**：实例详情页有「备份」标签页，时间线形式列出各备份点，
标注体积与包含内容，点击可**预览差异**（哪些存档文件会变化）再确认回滚。


---

## 4. 性能与体积优化策略

### 4.1 体积控制

| 手段 | 收益 |
|---|---|
| Tauri 默认不打包 Chromium | 省 ~120 MB |
| Release 开 `opt-level="z"` + `lto="fat"` + `codegen-units=1` + `strip=true` + `panic="abort"` | 二进制再省 40–60% |
| 前端 tree-shaking + 代码分割 | JS 从 ~800KB 降到 ~350KB gzip |
| 图标用 SVG / 字体子集化 | 省数 MB |
| 压缩安装包 (NSIS/DMG/AppImage) | 最终安装包 ≤ 8 MB |

### 4.2 启动速度

- **Rust 侧**：本地缓存优先渲染，网络请求全部异步后台跑，UI 不等网络。
- **前端**：首屏只加载 Shell + 当前页，其他页面 `lazy()` 动态导入。
- **不做**：启动时全量扫描 libraries/assets（改成按需/后台增量校验）。

### 4.3 内存控制

- 不用重型状态管理，Zustand 按需订阅，避免全树重渲染。
- 下载列表用虚拟滚动（`react-window`），几千个文件也不卡。
- Rust 侧下载流式写盘，文件内容**不进内存**。

---

## 5. 跨平台方案

| 关注点 | Windows | macOS | Linux |
|---|---|---|---|
| WebView | WebView2 (Evergreen) | WKWebView | WebKitGTK 4.1 |
| 密钥环 | Credential Manager | Keychain | Secret Service |
| 数据目录 | `%APPDATA%\<app>` | `~/Library/Application Support/<app>` | `~/.local/share/<app>` |
| 打包 | NSIS `.exe` / MSI | `.dmg` (通用二进制) | `.deb` / `.rpm` / `.AppImage` |
| 路径分隔 | `\` | `/` | `/` |
| 进程创建 | 无窗口 (`CREATE_NO_WINDOW`) | 常规 | 常规 |

**统一抽象**：Rust 侧用 `dirs` crate 处理数据目录、`keyring` crate 处理凭据、`tauri::path` 处理资源路径，业务代码里不出现 `#[cfg(windows)]` 以外的平台分支。前端**不感知平台**，所有差异在 Rust 侧抹平。

**macOS 特别注意**：签名 + 公证（Notarization）否则会被 Gatekeeper 拦；ARM64 需原生编译，不要依赖 Rosetta。

---

## 6. 安全考量

1. **令牌安全**：Minecraft `access_token` / `refresh_token` 只存系统密钥环，配置文件里绝不出现。
2. **下载校验**：所有从 Mojang 下载的文件**强制 SHA1 校验**；第三方源（Modrinth）校验其提供的 SHA1/SHA512。
3. **路径穿越防护**：解压 zip 时必须校验条目路径，拒绝 `../` 逃逸（zip-slip 漏洞）。这是启动器常见失守点。
4. **不以管理员权限运行**：全程用户态，避免引入提权风险。
5. **依赖审计**：CI 里跑 `cargo audit` + `npm audit`，锁定依赖版本。
6. **不执行未校验内容**：绝不自动执行下载来的脚本/可执行文件。

---

## 7. IPC 通信设计

```rust
// 命令：前端 → Rust（请求-响应）
#[tauri::command]
async fn install_version(state: State<'_, AppState>, id: String) -> Result<(), Error>

// 事件：Rust → 前端（广播，低频，如状态变更）
app.emit("version-installed", payload)

// 频道：Rust → 前端（高频流式，如下载进度）★
app.channel("download-progress")  // 60ms 聚合批推
```

**约定**：
- 请求-响应用 `invoke`，高频进度用 Channel（比 Event 更适合大数据流）。
- 所有命令返回 `Result<T, AppError>`，`AppError` 实现 `serde::Serialize` 统一错误格式，前端拿到 `{ code, message, detail }`。
- 进度推送**必须节流聚合**，否则每秒数千次 IPC 会让 UI 卡死。

---

## 8. 目录结构规划

```
IEML/
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs               # 入口 + Tauri 构建
│   │   ├── commands/             # IPC 命令层(薄, 只做参数转换)
│   │   ├── core/
│   │   │   ├── auth/             # MS OAuth + 离线
│   │   │   ├── meta/             # Mojang 元数据
│   │   │   ├── download/         # 并发下载器
│   │   │   ├── install/          # 安装流水线
│   │   │   ├── java/             # JRE 管理
│   │   │   ├── mod/              # Modrinth/CF
│   │   │   ├── launch/           # 参数拼装 + 进程
│   │   │   └── store/            # 持久化
│   │   ├── models/               # 数据模型(serde)
│   │   ├── error.rs              # 统一错误
│   │   └── state.rs              # 共享状态
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                          # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── pages/                    # 页面(懒加载)
│   │   ├── Home/                 # 主页
│   │   ├── Versions/             # 版本管理(含「新建实例」按钮)
│   │   ├── Mods/                 # Mod 管理
│   │   ├── InstanceSetup/        # 实例设置(Java / 内存 / 隔离的唯一编辑入口)
│   │   ├── Discover/             # 下载中心(游戏版本 / 加载器 / 下载队列)
│   │   ├── Modpacks/             # 整合包(独立一级入口)
│   │   └── Settings/             # 设置(全局)
│   ├── components/               # 通用组件
│   │   ├── CreateInstanceModal/  # ★ 创建实例弹窗(不是页面,3 处唤起)
│   │   ├── ScopeRoute/           # ★ 作用域路由提示条
│   │   └── SetupPanel/           # 内联配置面板(现仅整合包使用)
│   ├── stores/                   # Zustand
│   ├── lib/ipc.ts                # IPC 封装(唯一调用点)
│   ├── styles/                   # 全局样式 + 设计令牌
│   └── assets/
├── docs/
│   ├── ARCHITECTURE.md           # 本文档
│   ├── DESIGN_SYSTEM.md          # 设计规范
│   └── ROADMAP.md                # 路线图
├── design/
│   └── mockup.html               # 可交互 UI 设计稿
├── .github/workflows/            # CI: 三平台构建 + 发布
└── README.md
```

**分层原则**：`commands/` 只做 IPC 出入参转换，所有业务逻辑在 `core/`；`core/` 不依赖 Tauri（除必要的 AppHandle 用于发事件）——这样 core 可以**单独写单元测试**，也能未来抽成 CLI。

---

## 9. 关键依赖清单

```toml
# 异步与运行时
tokio = { version = "1", features = ["full"] }
futures = "0.3"

# 网络
reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"] }

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 归档与校验
zip = "2"
sevenz-rust = "0.6"          # 处理 .7z 整合包
sha1 = "0.10"
sha2 = "0.10"

# 系统集成
keyring = "3"                 # 系统密钥环
dirs = "5"                    # 标准目录
open = "5"                    # 打开系统浏览器
sysinfo = "0.32"              # 内存检测/推荐值

# 工具
thiserror = "2"               # 错误定义
tracing = "0.1"               # 日志
tracing-subscriber = "0.3"
uuid = { version = "1", features = ["v3", "v5"] }
regex = "1"
```

**依赖克制的原则**：能用标准库就不加 crate；每个 crate 都要过一遍「它带来了多少编译时间和体积」。

---

## 10. 开发路线图

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M0 骨架** | Tauri 项目初始化、CI 三平台构建、UI 设计令牌落地、侧边栏布局 | 能跑起来的空壳（体积指标已达标） |
| **M1 核心启动** | 元数据获取、版本安装、Java 探测、离线启动打通 | **能启动原版 MC**（最关键里程碑） |
| **M1.5 单页安装** ★ | 「创建实例」界面：版本 + 加载器组合选择、预检、InstallPlan 预览、一键完成 | **新手 2 次点击装好游戏** ← 体验分水岭 |
| **M2 正版登录** | MS OAuth + 密钥环 + 令牌刷新 | 正版账号可玩 |
| **M3 实例管理** | 多版本管理、实例配置、版本隔离、复制、导入导出 | 完整的实例体系 |
| **M3.5 拖拽导入** ★ | 拖入 jar / mrpack / zip / 其他启动器目录，自动识别处理 | 老玩家的高效路径 |
| **M4 加载器** | Fabric / Quilt / NeoForge / Forge / OptiFine / LiteLoader 全支持 | 能玩模组 |
| **M5 Mod 管理** | 多源聚合搜索、依赖树解析、冲突检测、整合包 | Mod 生态打通 |
| **M6 Java 自动获取** | 缺失 JRE 自动下载与版本匹配 | 零配置开箱即用 |
| **M6.5 崩溃分析** ★ | 崩溃模式库 + 一键修复建议 | 用户不再对着堆栈发呆 |
| **M7 打磨** | 主题、快捷启动、国际化、性能优化、发布 | 发布 v1.0 |

★ 标记的是「集百家之长」新增的体验关键项。

**里程碑判据**：M1 跑通就证明整个架构成立，之后都是增量。**M1.5（单页安装）是体验分水岭**——它决定这个启动器是「能用」还是「好用」，建议紧随 M1 之后立即实现，因为它依赖的核心能力（元数据、加载器查询、安装流水线）在 M1 中已经具备。

---

## 11. 主要风险与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| 微软登录风控/接口变更 | 高 | 严格走系统浏览器 + 回环；令牌刷新逻辑解耦，便于快速适配 |
| Forge 兼容性（老版本尤其） | 高 | 参考现有开源实现；为每个大版本写集成测试 |
| 国内网络访问 Mojang 慢 | 高 | 内置镜像源切换（BMCLAPI）+ 多源自动降级；下载可断点续传 |
| OptiFine 无官方 API | 中 | 解析版本清单页 + 本地缓存 + 允许手动指定版本号兜底 |
| LiteLoader 等老加载器停止维护 | 中 | 保留支持但不投入优化；标记为"已停止维护" |
| 跨平台 WebView 渲染差异 | 中 | CI 三平台视觉回归 + 锁定 CSS 特性集 |
| 大整合包下载体积大、耗时长 | 中 | 高并发 + 断点续传 + 进度可暂停恢复 + 文件去重 |
| Mac 公证流程繁琐 | 中 | 提前配好 GitHub Actions 签名流水线 |

---

## 12. 参考实现（用于查证具体协议细节）

- **PCL2** — 单页组合安装、多源下载、中文体验标杆
- **HMCL** — 加载器全覆盖、崩溃分析、跨平台实现
- **Prism Launcher** — 实例隔离、多源整合、导入格式兼容
- **Modrinth App** — 视觉语言与 .mrpack 格式规范
- **modrinth/api**、**Adoptium API**、**Fabric Meta API** 官方文档

> 遇到协议细节（如 Forge 安装流程、assets 索引结构、加载器 install profile 格式）不确定时，**以这些成熟实现的行为为准**，不要凭猜测写。

---

*文档状态：设计稿 v0.4 —— **创建实例降为弹窗**：下载中心删除两个内联配置面板
（Java / 内存 / 隔离移出安装流程，统一归「实例设置」），新增「作用域路由」补足空档；
第 0.4 节补第三轮修正记录（三轮：命名错误 → 整合包独立 → 选择与配置分离），
第 11 章页面目录同步（`Create/` → `components/CreateInstanceModal/`，
新增 `InstanceSetup/` 与 `ScopeRouter`）。*
*v0.3：信息架构调整 —— 整合包拆为独立一级入口，下载中心精简为
「游戏版本 / 加载器 / 下载队列」（共 7 个一级入口）。*
*v0.2：已引入「集百家之长」取舍分析与单页组合安装设计。*
