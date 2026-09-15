# IEML — 极简 Minecraft 启动器

> 极致轻量 · 真跨平台 · 现代 UI/UX · **实用优先**

一个从零构建的 Minecraft 启动器。不做"功能最多"，做"最快、最小、最好用"。

**当前版本：`0.1.0-beta.16`（公开测试版）** —— 版本号规则见
[`docs/VERSIONING.md`](docs/VERSIONING.md)，改动见 [`CHANGELOG.md`](CHANGELOG.md)。

> ★ **进阶到 beta 是用户的决定，不是"三条判据全满足"的自然结果**：
> 判据①（功能表里没有 ❌）**没有完全满足** —— 下面「功能状态」表里
> 「macOS / Linux 未实测」仍是 ❌。**没有把它涂成 ✅**，逐条判定见
> `docs/VERSIONING.md` §3.3。

**当前状态：可运行的应用**（不是设计稿）。领域规则、UI、桌面壳都已落地；
真实下载与真实启动都跑通过，带 **382 项 Rust 单元测试** + 前端测试
（这些数字是 2026-09-14 实测的，见「测试」一节 —— 不写估数）。

**下载引擎（ADR-034 / ADR-049）**：**单连接为主**（实测分片在 BMCLAPI 上并不更快，
默认关闭，见下文「下载引擎」一节）· 单源尝试与失败换源 · 源健康记忆与 **429 指数退避** ·
限流页检测 → 降并发 + 冷却 · 续传对不上就**重发整份请求** · 读完响应体再校验长度 ·
校验失败自动删除重下 · 批次失败降并发补下。

**数据目录默认不在系统盘**：`libraries` + `assets` + 实例很容易超过 20 GB，
而系统盘通常最小、最满、最不该被写满。选址规则见
`platform::resolve_data_root`（D: → E: → … 按空闲空间挑），老数据会
**一次性复制**过去（只复制、不删源）。

**数据目录长什么样（0.1.0-beta.3 起，游戏数据像 PCL 那样放进 `.minecraft`）**：

```
D:\IEML\                     ← 数据根目录（选址规则见上）
├─ .minecraft\               ← ★ 游戏数据（0.1.0-beta.3 从 shared\ 改名而来）
│   ├─ assets\               资源文件（音效 / 语言 / 贴图，按 hash 存）
│   ├─ libraries\            库文件（含各加载器的）
│   └─ versions\             已装的版本（每个版本一个目录）
├─ instances\<名字>\game\    每个实例的存档 / Mod / 配置（隔离就是靠这一层）
├─ java\ cache\ logs\        自动下载的 Java · 安装器与清单缓存 · 启动日志
└─ instances.json prefs.json ms_client_id.txt
```

改名是**同卷 rename**（原子、1.4 GB 瞬间完成），旧布局会在启动时自动迁移；
五种情况（含"目标已存在"与"重复启动"）都有单元测试守着。
**注意**：`E:\IEML` 是**代码仓库**，不是数据目录 —— 两者别混。

**界面结构参照 PCL2 的「正副级页面」**：一级侧栏只有 4 项，进入某个版本后
整条侧栏换成该版本的二级页。见下文「界面结构」。

---

## 快速开始

```bash
pnpm install

# 浏览器里开发（最快，规则逻辑完全可用；加 ?demo=1 会给出演示实例）
pnpm dev

# 桌面版（需要 Rust + MSVC，见下方"工具链"）
pnpm desktop:dev

# 打包成 exe 与 NSIS 安装程序
pnpm desktop:build
#   → src-tauri/target/release/ieml.exe                                 （绿色版）
#   → src-tauri/target/release/bundle/nsis/IEML_0.1.0-beta.16_x64-setup.exe（安装程序）
#   并把绿色版**逐字节复制**到桌面「IEML 启动器.exe」（见 tools/env/deploy-desktop.ps1）
#
# ★ 为什么打包脚本必须顺手更新桌面那份：真实事故 —— 用户双击桌面图标测修复，
#   而那个文件是前一天构建的。"我修好了"和"用户看到的还是坏的"可以同时为真。
#   `pnpm desktop:build` 现在是"构建 + 部署 + 用 SHA256 证明两份一致"。

# 一键验证（类型 + 前端测试 + 端到端 + 子进程窗口抑制 + 版本号一致性
#           + 文档版本口径一致 + Rust 测试 + 前端生产构建 + exe 内嵌前端一致性）
pnpm verify

# 改版本号（规则见 docs/VERSIONING.md）—— 一条命令同步六处（含 README）
node tools/set-version.mjs 0.1.0-dev.13
node tools/set-version.mjs --check        # 只校验一致性（verify 里会跑）
node tools/set-version.mjs --docs         # 只校验文档口径（README / CHANGELOG）
```

### 真机验证（单元测试证明不了"用户点得到那个按钮"）

```powershell
# ① 界面层：启动桌面版，用 WebView2 自带的 CDP 读真实 DOM 并跑断言
powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/deploy-desktop.ps1
node tools/live/live-ui-check.mjs
#   → 14 条断言：能点进版本、有「安装 Mod」键、点了真弹搜索框、
#     OptiFine 开关置灰且理由是三种真实原因之一、
#     「关于」卡片显示的版本号 == package.json 里的版本号

# ①b 「盘上有」与「有版本在用」必须一致
#     （用户报的"删掉实例后下载页还显示已装"）
node tools/live/live-inuse-check.mjs
#   → 直接比对**两个数据源**：后端给的 in_use vs 磁盘上的 instances.json；
#     且 in_use === false 的行界面上不许出现"已装"

# ② 交付物层：证明 release exe 里的前端就是当前 dist
node tools/gates/check-frontend-embedded.mjs

# ③ 启动链路层（会联网，默认 #[ignore]）
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo test --manifest-path src-tauri\Cargo.toml --test live_repair_missing -- --ignored --nocapture
cargo test --manifest-path src-tauri\Cargo.toml --test live_liteloader -- --ignored --nocapture
cargo test --manifest-path src-tauri\Cargo.toml --test live_forge_processor -- --ignored --nocapture
```

> `live-ui-check.mjs` 的期望版本号**从 `package.json` 读**，不写死 ——
> 写死的话每次升版本都要跟着改，忘了改就会出现"测试说版本不对、
> 其实代码是对的"这种最浪费时间的红。

### 界面截图（自动化，不靠手点）

二级页必须"点进去"才看得到，所以有一个 CDP 驱动脚本：

```powershell
pnpm exec vite --port 5199 --strictPort            # 一个终端
node tools/live/shot.mjs "http://127.0.0.1:5199/?demo=1" tmp/shots tmp/plan-primary.json
```

剧本是一个 JSON 数组，元素可以是 `{"eval":"..."}` / `{"wait":600}` / `{"shot":"name.png"}`。
脚本自己拉起 Chrome，结束时收掉。

> **两件注意**：① 默认是**空列表**，只有 `?demo=1` 才有演示实例 ——
> 预置几个"看起来能玩"、点启动必然失败的实例，比空列表更糟。
> ② Vite 的 HMR 产物会被 headless Chrome 缓存，脚本已强制
> `Network.setCacheDisabled` + URL 加时间戳，否则你会看到"改了没生效"。

### 国内网络打包（重要）

Tauri 的打包器需要从 GitHub Releases 下载 NSIS，**国内直连会超时**（实测 `timeout: global`）。
用官方支持的环境变量走镜像即可，无需手动塞文件：

```powershell
$env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = 'https://gh-proxy.com'
pnpm desktop:build
```

Tauri 还提供 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR_TEMPLATE` 做 URL 重写
（模板变量 `<owner> <repo> <version> <asset>`）。这两个变量名是从 CLI 二进制里
提取出来的（`tauri_bundler::utils::http_utils`），官方文档里没显眼写。

---

## 界面结构（★ 参照 PCL2 的正副级页面）

```
一级（侧栏永远这 4 项 + 下半部分"最近玩过 / 数据目录 / 关于与设置"）
  启动          版本身份卡（图标 / MC / 加载器 / 内存 / Java / 累计时长 + 四个直达动作）
                + 版本下拉 + 一个大按钮 + 一行状态 + 其它版本 + 本机状态
  版本列表      一行一个版本（**按世代配色的方块图标**），**整行可点**进二级页；
                行尾「启动」+「⋯」菜单
  下载          **六个页签**：安装游戏（版本 + 加载器同一页选好）· 整合包 ·
                Mod · 资源包 · 光影 · 数据包（后四格是同一个资源中心）
  设置          全局：外观 / Java 环境 / 新版本默认值 / 下载 / 账号 / 存储 / 关于

二级（进入某个版本后，侧栏整条替换）
  ← 返回版本列表 + 版本卡（版本名 / MC 版本 / 加载器徽标）
  概览          顶栏「启动 / 安装 Mod」+ **动作条**（打开目录 · 查看日志 ·
                检查并补齐文件 · 重命名 · 创建副本）+ 只读现状表 +
                折叠的危险区（删除）
  设置          只作用于当前版本：隔离 / 窗口标题 / Java / 内存
  Mod 管理      工具条（检查更新 · 刷新 · 添加 Mod · mods 目录 · 资源包/光影/数据包）·
                筛选 · 搜索 · 启用禁用 · 更新 · 删除 · 批量
  日志          统计 / 崩溃分析 / 导出（脱敏）/ 原始日志 / "怎么看日志"
  底部          常驻主按钮「启动这个版本」/「停止游戏」

顶栏：品牌 · 面包屑「版本列表 › 版本名」（仅二级页）· **账号按钮** · 任务中心 · 主题开关
```

> ★ 账号按钮在**顶栏**（0.1.0-beta.3）：正版登录不再只藏在「设置 → 账号」里。
> 账号是**状态**（我现在是谁、能不能进正版服务器），不是"改一次就不动"的设置，
> 所以它和任务中心、主题开关并排，点开就是完整的登录面板
> （与设置页用的是**同一个组件** `AccountPanel`，一份实现两处使用）。

**为什么二级"替换"一级而不是并排两栏**：并排就成了"左侧两栏导航"，
218px 的侧栏塞不下，而且用户分不清哪一栏是全局、哪一栏属于当前版本。
替换之后「我在第几层」由侧栏本身回答 —— 因此顶栏那个 340px 的实例切换器被删掉了。

完整推演见 `docs/DECISIONS.md` 的 **ADR-032**（结构）与 **ADR-033**（密度与三条铁律）。

### 三条铁律（违反即 bug）

| # | 铁律 | 反面例子 |
|---|---|---|
| ① | **一个值只能有一个地方能改** | 概览页展示可编辑的内存 + 设置页也能改 → 两处不同步 |
| ② | **导航层级表达作用域，不表达功能分类** | 把「日志」「Mod 管理」放一级 → 用户不知道这是全局还是某个版本的 |
| ③ | **派生状态必须随上下文清空** | 切换版本后 Mod 列表仍是上一个版本的 → 概览显示 0、Mod 管理显示 25 |

---

## 核心指标

| 维度 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 安装包体积 | ≤ 8 MB | NSIS 安装程序 **2.81 MB** · 裸 exe **7.66 MB**（8,032,768 B） | ✅ 达成 |
| 冷启动到可交互 | ≤ 500 ms | 待精确测（首次启动 WebView2 初始化约 1–2 s） | ⚠️ 待测 |
| Rust 主进程内存 | ≤ 60 MB | **30.5 MB** 工作集 | ✅ |
| 前端产物 | —— | JS 370.8 kB（gzip 127.1）+ CSS 71.4 kB + html 0.6 kB = **442 kB** | ✅ |

> ★ **0.1.0-beta.2 曾经为了字体主动超标**（打包 HarmonyOS Sans SC Medium，+8.2 MB，
> exe 13.17 MB），0.1.0-beta.3 按用户要求改回**系统字体栈**，体积回到 8 MB 以内 ——
> 上表是**实测值**，不是估计。

### ★ 仓库体积：50 GB 是**构建缓存**，不是数据

2026-09-15 实测 `E:\IEML` 一度占 **50.77 GB**，而交付物 exe 只有 12.6 MB。拆开看：

| 位置 | 大小 | 性质 |
|---|---|---|
| `src-tauri/target/debug/incremental` | 28.8 GB | 增量编译缓存 |
| `src-tauri/target/debug/deps` | 16.9 GB | 其中 13.5 GB 是 `.pdb` 调试符号 |
| `src-tauri/target/{debug/build,release}` | 5.9 GB | 构建产物缓存 |

删掉 `target/debug` 后 **50.77 GB → 3.36 GB**；同时改了 `Cargo.toml` 的 dev/test profile
（`debug = "line-tables-only"` + `incremental = false`）免得它再长回来。
要单步调试时把 `debug` 临时改回 `true` 即可 —— 代价就是那十几 GB。

### ★ 关于内存指标：原目标是错的，实测后修正

`docs/ARCHITECTURE.md` 里写的目标「空闲 ≤ 60 MB」**在 Tauri 下无法达成**，
原因不在我们的代码里：

| 组成 | 实测 |
|---|---|
| Rust 主进程（`ieml.exe`） | **30.5 MB** |
| WebView2 子进程（6 个） | 约 331 MB |
| **合计** | **约 359 MB** |

WebView2 是系统组件、多进程架构，任何 Tauri 应用都躲不开。
**诚实的做法是改目标而不是改数字**：把目标重新定义为
「**Rust 主进程 ≤ 60 MB**」（已达成），并在文档里写明总占用包含系统 WebView2。
这样别人拿 Electron 对比时不会以为我们在藏。

---

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 内核 | **Rust** | zip 解压、SHA1 边下边算、并发下载、进程管理 |
| 外壳 | **Tauri 2.x** | 系统 WebView，不打包 Chromium（Electron 光壳就 ~150 MB） |
| 前端 | **React 18 + TypeScript + Vite** | |
| 样式 | **手写 CSS + 设计令牌** | 不引 UI 框架，为了体积与可控性（产物 355 kB） |
| 测试 | node:test + Rust lib tests + 真实端到端 | |

---

## 架构：三层，规则只实现一次

```
① UI 层（React）          只渲染结论，不做业务判断
        ↓ 只调用
② 桥接层（bridge/）       一个接口，两套实现：
     types.ts               · web.ts   —— 浏览器演示（真实状态机 + 假下载）
     web.ts / tauri.ts      · tauri.ts —— 真后端（37 个 Tauri 命令）
        ↓
③ 领域层（domain/）       规则唯一的权威实现
     TS 版 ↔ Rust 版 一一对应，由同一批测试用例锁定
```

**核心纪律：校验只实现一次。** 前端 UI 的置灰、桥接提示、API 补全
**全部是 Rust/domain 结论的呈现**，前端不得自己维护一份规则 ——
否则两侧必然漂移。这是 `src/domain` 与 `src-tauri/src/domain` 一一对应的原因。

### 领域模块

| 模块 | 负责 |
|---|---|
| `version.ts` | 版本号解析与比较（**三段式**，不是两段 —— 踩过坑）、Java 区间判定 |
| `combination.ts` | 三层加载器组合校验、自动补齐 API、桥接包排序 |
| `loader-caps.ts` | 每个 MC 版本上哪些加载器可用、为什么不可用（必须给具体理由） |
| `isolation.ts` | 版本隔离三段判定（关 / 自动 / 强制） |
| `memory.ts` | 内存自动分配 + 依据文字（数字必须是算出来的） |
| `java.ts` | Java 需求规则、区间文本解析 |
| `mods.ts` | Mod 状态判定（启用/禁用/可更新/可能不兼容/前置库） |
| `crash.ts` | 崩溃日志分类与修复建议 + **导出前脱敏** |
| `install-plan.ts` | 安装计划生成（步骤、预计体积、预计耗时） |

---

## 关键设计决策

完整列表见 `docs/DECISIONS.md`（**ADR-001 ~ ADR-055**）。

### 1. 加载器是三层结构，不是"可多选的复选框"（ADR-002 / ADR-003）

| 层 | 内容 | 控件 | 互斥性 |
|---|---|---|---|
| 第一层 基础加载器 | Forge / NeoForge / Fabric / Quilt | **单选** | 严格互斥 |
| 第二层 附加组件 | OptiFine / LiteLoader | 多选，受约束 | 有条件的叠加 |
| 第三层 API 前置包 | Fabric API / QFAPI | **只读**，自动补齐 | 由第一层决定 |

关键事实（都来自 PCL2 / HMCL 源码研读）：

- **OptiFine 可独立装在纯原版上** —— 它调用自带的 `optifine.Patcher` 对原版 jar
  **打字节码补丁**，不是"文件覆盖"。UI 文案统一写"将对原版 jar 打补丁"。
- **NeoForge 与 OptiFine 无条件不兼容**；Forge 1.13~1.14.3 段也不兼容；Fabric ≥1.20.5 也不兼容。
- **Fabric/Quilt + OptiFine 需要 OptiFabric 桥接，且桥接包必须排在 OptiFine 之后安装**。
- **Fabric API 的版本号与 MC 版本绑定**（形如 `0.92.2+1.20.1`），必须动态查询。
- **LiteLoader 只能配合 Forge，且仅 1.7.10 ~ 1.12.2**。

### 2. Mod 绝不自动更新（ADR-018）

Mod、API、游戏版本、加载器构成**四角绑定**，任何一角变动都可能让游戏起不来 ——
这与 App 的"无状态更新"模型根本不同。所以**更新永远需要用户手动点**
（右上角「检查更新」→ 逐个更新），启动器不会在后台替你换 Mod。

> ★ 这一节在 `0.1.0-beta.1` 之前写着两句**与代码不符**的话：
> "启动器只在启动时后台检查并打角标"（没有启动时检查，只有你点按钮那一条路）
> 和"旧文件先移入回收站"（`install_mod` 直接覆盖同名文件；文件名不同时旧 jar
> 会**留在原地**，于是同一个 Mod 两份；`delete_mods` 也是直接删，没有回收站）。
> 代码注释与界面文案在 dev.12 就更正过，README 一直没跟上 —— 现在对齐。

### 3. 校验只实现一次（ADR-011）

见上文「架构」。这条是最容易违反、后果最隐蔽的一条：
前端"顺手"写一句 `if (mcVersion.startsWith('1.20'))` 就是在制造第二份规则。

### 4. 「装完之后」那一半必须存在

原设计稿只做了"选择与安装"，完全没有：**日志 / 控制台 / 崩溃分析 /
启动失败界面 / 停止游戏**。现在这些都有：

- 启动时 stdout/stderr 重定向到日志文件，退出监测算出游玩时长
- 崩溃弹出分析弹窗，**首屏是「原因 + 建议动作」，不是堆栈**
- 导出报告自动脱敏，并**主动告诉用户处理了什么**（账号令牌 / 用户名 / IP）

### 5. 镜像不是可选优化，是默认路径

本机实测：`maven.fabricmc.net`、`maven.neoforged.net`、`maven.quiltmc.org`
**全部不可达**（TLS 失败 / 403）。所以 **BMCLAPI 是默认下载源**，
Mojang 官方源作为可选。所有 maven 下载都走 `bmclapi2.bangbang93.com/maven/<path>`。

### 5.5 两个资源库：Modrinth 与 CurseForge（ADR-052）

> ⚠️ 这一节以前写的是「`api.curseforge.com` **不可达**（403），所以 CurseForge 用不了」。
> 那句话只对了一半：403 是**没带 API Key**时的响应。带上 key 之后它是通的
> （实测 `GET /v1/games/432` → 200）。现在是两个来源都能搜、都能装。

「资源中心」里可以切来源，两边是**两批作者、两套收录**，
同一个 Mod 可能只在其中一边 —— 所以查不到 ≠ 不存在（ADR-050 的教训）：

| | Modrinth | CurseForge |
|---|---|---|
| 鉴权 | 不需要 | 需要 API Key（**内置一把**，设置页可换成你自己的） |
| 反查更新用什么 | **SHA1** | **MurmurHash2 指纹**（种子 1，先剔除 `\t \n \r 空格`） |
| 官方 CDN | `cdn.modrinth.com`（国内实测 ~230 KB/s，稳） | `edge.forgecdn.net`（**本机时好时坏**：200 / 连接失败 / 404 都见过） |
| 兜底 | mcimirror | `mediafilez.forgecdn.net` + `mod.mcimirror.top/files/…`（两个都实测能取到字节） |
| 作者能拒绝第三方下载吗 | 不能 | **能**（`allowModDistribution=false` → 文件 `downloadUrl` 是 null，界面提前标出来并说明） |

工具（都不想让它进 `verify`，因为要联网）：

```bash
pnpm probe:cf        # 连通性 + 每种资源的 classId / 加载器编号 / 指纹端点 / CDN 候选
pnpm test:cf-live    # 真机端到端：搜索 → 文件 → 下载 → 指纹反查（#[ignore]，显式跑）
pnpm test:cf         # 指纹判据表（离线，verify 里也跑这条）
```

### 6. 下载引擎：单连接为主，分片**默认关着**（ADR-034 / ADR-049）

> ⚠️ **这一节以前写的是"加速靠分片，不靠多源抢"**，还把"39 MB 客户端 jar 走分片"
> 当成实测证据。那**不是现在的事实**：分片在 2026-09-13 就被实测推翻并默认关掉了
> （见 `download.rs::chunking_enabled()` 的注释），而 README 一直没跟上。
> 现在如实写。

ADR-026 原本定的是「多源竞速」（同一文件官方源与镜像源**同时**下，谁快用谁）。
实装后发现它不加速反而添乱：两条连接分薄同一条带宽，小文件白付一次握手，
而且镜像被双倍并发更容易回 **429**。改成 PCL2 的实际策略：**单源尝试 + 失败换源**。

分片（8 路 Range 并行）也走过同一条路：**先做出来、再被自己的实测数据推翻**。
本机实测 BMCLAPI 的 23 MB 客户端 jar —— 单连接 27.9 秒（0.83 MB/s），
8 路并行 23.4 秒（**只快 16%**，瓶颈是镜像按 IP 的总带宽而不是单连接速度），
而代价是：更容易吃 429（实测日志 `分片不可用（HTTP 429）→ 回退单连接`，
**净亏一轮**）、以及一串只在分片路径上存在的失败（段文件、段计划、
"服务器不支持 Range"、拼装时 os error 2 —— 用户报的"最后一个文件必定重试然后失败"
就落在这条路上）。所以现在的默认值：**单连接**；想要分片就设 `IEML_CHUNKED=1`
（`IEML_CHUNK_COUNT=4` 调段数），代码与测试都还在。

| 机制 | 做法 |
|---|---|
| 源选择 | **单源尝试 + 失败换源**，候选按「期望源 + 源健康分」排序，429 冷却中的源沉底 |
| 429 限流 | 指数退避（`2^(n-1)` 秒，封顶 60s）+ **并发减半**（下限 4），冷却期内不派活 |
| **限流页** | 任务说文件 286 KB、服务端只回 **146 字节** → 认定被搪塞：冷却该源 + 并发减半（`note_throttled`） |
| 分片下载 | ≥4 MB **才考虑**分片，段数 ⌊大小/2 MB⌋ 夹在 1..=8 —— **默认不启用**，要 `IEML_CHUNKED=1` |
| 段级续传 | 分片启用时：每段独立落盘（`.part.N`）+ 段计划（`.part.chunks` 记 total 与段边界） |
| **续传对不上** | `Content-Range` 的偏移或总大小与本地状态不符 → **丢掉这份响应、清残留、重发不带 `Range` 的请求**（P0-4；以前会把错位的数据照写下去） |
| **长度校验** | **读完响应体之后**再比：短了/长了都算失败（没有 SHA1 的任务靠它兜底），限流页也在这一步被认出来（P0-5） |
| 校验失败 | 删除坏文件重新下载（不是"跳过"） |
| 批次容错 | 失败文件按 1/4 并发 → 单线程补下，最多 3 轮 + 退避 |
| **暂停** | 真的暂停：不再开始新任务、在跑的收尾、`.part` 全部保留；**第一批也生效**（P0-3） |
| **同内容去重** | 同 SHA1 只下一次；目标路径相同的直接丢弃（资源文件是内容寻址的，两个名字同一个文件） |
| 加载器库 | Fabric / Forge / NeoForge 的 maven **不给官方候选**（那边根本没有，白等一次 404） |

> **实测**：全量安装 1.20.1 —— 52 个核心任务（77 MB，含 39 MB 客户端 jar，**单连接**）
> + **3598 个资源文件**，**0 个失败、0 轮补下**，SHA1 全部对上。
> 第一轮全量实测 29.7 秒。
>
> 同一轮里引擎自己抓到并修好了一个坏文件：
> `资源索引 5 校验不匹配（期望 0dd020f0，实际 954f04b4）→ 删除重下`。

---

## 功能状态

> ★ 这张表按**实机验证过什么**写，不按"代码里有没有"写。
> 「已实测」= 有跑过的证据（测试或手点）；「已实现未实测」= 代码路径完整但没人跑过。

| 功能 | 状态 |
|---|---|
| **真实下载**（版本清单 / 版本 JSON / 客户端 jar / 库 / natives / 资源文件） | ✅ 已实测 |
| **真实启动**（拼装参数、natives 解压、进程管理、日志重定向） | ✅ 已实测 |
| **自动获取 Java**（Adoptium，含 SHA256 校验与实跑验证） | ✅ 已实测 |
| **Java 探测 8 类来源**（含 Mojang 官方运行时 `.minecraft\runtime`、注册表、PCL2 缓存、盘符浅扫描） | ✅ 已实测（本机扫出 8 / 21 / 25 三份） |
| **Java 要求按 PCL 的「多约束求交集」算**（读版本的 `javaVersion`） | ✅ 已实测（26.2+Forge 真机对照：Java 25 通过 / Java 21 报原错） |
| **微软设备码登录**（device code flow，令牌进系统密钥环） | ⚠️ **分成两半，别混着说**：① **微软侧已实测通过** —— 2026-09-15 用户在浏览器里真的完成了同意，微软页面显示「大功告成！你现在已登录到 Prism Launcher」；② **应用侧还没完成过一次** —— 那次启动器没在跑，没有人去把设备码换成令牌（`prefs.json` 里 `accountUuid` 仍是 null）。下一次**保持启动器开着**走一遍才能算端到端 |
| 离线模式 | ✅ 已实测 |
| Fabric 安装（profile JSON） | ✅ 已实测（26.2 + Fabric 0.19.5 真跑进渲染循环） |
| **Fabric API 自动安装** | ✅ 已实测（26.2 装到 `fabric-api-0.160.0+26.2.jar`，2.5 MB 真落盘） |
| Quilt 安装（profile JSON） | ⚠️ 已实现未实测（与 Fabric 同一条代码路径） |
| **Forge / NeoForge 官方安装器** | ✅ 已实测（1.20.1 + Forge 47.2.0 装出 29 个库、零缺失） |
| **OptiFine 自动安装** | ✅ 已实测（1.16.5 + HD U G8：下载 6 MB 安装器 → 跑官方 Patcher → **装完真的进游戏**，ConnectedTextures 在工作） |
| **LiteLoader 自动安装** | ✅ 已实测（1.12.2-SNAPSHOT：写版本描述 + 下 3 个库 → **装完真的进游戏**，LiteLoader 正常 bootstrap） |
| **整合包（.mrpack）** | ✅ 已实测（清单解析 → 建实例 → 本体+加载器 → Mod → overrides 全覆盖） |
| **社区资源中心**（Mod / 资源包 / 光影 / 数据包：列出 / 翻页 / 封面 / **玩家自选版本**） | ✅ 已在界面走通（下载页四个页签 + Mod 管理页「添加 Mod」）；安装链路与 Mod 同一条（`install_resource`） |
| Mod 管理（扫描 / 状态判定 / 启停 / 批量） | ✅ 已实测 |
| **从 Modrinth 搜索并下载 Mod 放进 mods/** | ✅ 已实测 |
| 崩溃分析与脱敏导出 | ✅ 已实测 |
| 下载引擎（单连接 + 换源 + 429 退避 + 限流页检测 + 校验自愈） | ✅ 已实测（ADR-034 / ADR-049） |
| **暂停 / 恢复** | ✅ **真的暂停**（P0-3，dev.12）：`PauseToken` 让引擎在下一个任务边界停下，在跑的收尾、`.part` 保留；**第一批也生效**；`paused / remaining_files / paused_stage` 一路上报到界面，点「继续」按原参数续下 |
| macOS / Linux | ❌ 未实测（只测过 Windows） |

### ★★ 关于正版登录：内置的 client_id 是怎么定的，以及**授权页为什么写着别人的名字**

老代码写死了 `client_id = 00000000402b5328`（Minecraft 官方启动器历史用过的那个），
而**微软已经把它删了**。真机打接口：
```text
POST login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
→ 400 {"error":"unauthorized_client",
       "error_description":"AADSTS700016: Application with identifier
       '00000000402b5328' was not found in the directory ..."}
```
也就是说**正版登录从来没有成功过一次**，而当初 README 那句
「✅ 已实现，未实测」把这件事盖住了。

**2026-09-14 又测了一遍**（用户要求就用那个 id，探针
`tools/probe/probe-ms-clientids.ps1`，同批请求带一个**随机编造**的 id 作对照）：

| client_id | 结果 |
|---|---|
| `00000000402b5328` | **400 AADSTS700016 不存在** |
| `<随机编造>` | 400 AADSTS700016 —— **与上面一字不差** |
| `c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb`（Prism Launcher 公开 id） | **200，真的发了设备码** |

对照组说明：那个 id 现在的状态就是"**没注册过**"。写进代码 = 交付一个
"点了必然失败"的按钮，所以**没有**照抄它。

> **2026-09-15 现状**：内置值已按用户要求换成他自己提供的那把
> （`32bde9cc-…`，**未实测** —— 用户明确说"不要验证，只换上"）。
> 上面 Prism 那把的实测记录保留着，因为它是"哪一类 id 能用"的证据，
> 与"现在内置的是哪一把"是两件事。

> ### ★ client_id 是**一对一的**：它标识"哪个应用在请求授权"
>
> 2026-09-15 用户实测把这一点问出来了：授权成功后，微软的页面写着
> **「大功告成！你现在已登录到 Prism Launcher」**（当时内置的是 Prism 那把 id）。
>
> 这不是 bug，是 client_id 的定义 —— 微软会把这个应用**注册时的名字**显示给用户。
> 我们用谁的 id，用户在授权页上就会看到谁的名字。
> 换了内置 id 之后，页面上显示的名字也会跟着变成那把 id 所属应用的名字。
>
> 所以：
> * 想让授权页显示「IEML」，就得**自己注册一个 Azure 应用**（portal.azure.com → 应用注册，
>   免费、约 5 分钟），把「应用程序(客户端) ID」填进界面里的
>   「登录用的应用 ID → 换成自己的」；
> * 或者启动前设环境变量 `IEML_MS_CLIENT_ID=<你的 id>`；
> * 自己注册之后，把 `src-tauri/src/auth/mod.rs` 里的 `BUILTIN_CLIENT_ID` 换成它，
>   就变成"开箱即用 + 显示自己的名字"（**只需要改这一个常量**）。
>
> 界面（顶栏账号按钮 → 正版登录）里**任何时候都能换**，并且会如实写着
> 现在用的是哪一把、是谁的。

诊断链路已经真机验证过：没配时不发请求就给结论；配了一个无效 id 时，
微软的 `AADSTS700016` 会被翻成"去哪填、怎么申请"。XSTS 的五个错误码
（封禁 / 没注册 Xbox / 地区不支持 / 年龄 / 家庭组）也逐条翻成了人话
（照 PCL `ModLaunch.vb` 991-1016 那张表）。

### ★ 这一轮删掉的假承诺（留档：它们曾经真的写在界面上）

> dev.12 逐条核对"代码真的做到了吗"，删掉/修实了这些话。
> 留下记录是因为**它们都是同一类错**：界面说了一件后端没做的事。

1. **「暂停 = 取消」** —— 任务中心的暂停按钮以前走 `cancelTask`，而 README、
   代码注释、甚至 TaskCenter 的说明都写着"后端只有取消一种原语"。
   引擎早就有 `PauseToken` 了，这几句话（以及 README 的三行）一直没删。
2. **界面写死的 Java 规则** —— 启动页那句「1.20.5 及以上需要 Java 21，
   1.18 ~ 1.20.4 需要 Java 17，1.16.5 及更早需要 Java 8」是**第二套规则**，
   而且对 26.2 这类两位数版本号必然说错（真相是 Java 25）。现在由后端算、界面只呈现。
3. **`stop_game` 里的 `exit_code: Some(0)`** —— 一个编出来的退出码（它走 taskkill，
   根本没读过子进程状态）。整个函数连着它的孪生 `launch_game` 一起删了：
   它们在 `invoke_handler` 里没登记，前端永远调不到。
4. **「下载引擎加速靠分片」** —— 见上一节：分片默认是关的。

### ★ 这一轮的启动前自愈（dev.5 起，dev.12 起判据收敛到一处）

以前一个"界面上写着已安装、其实缺 35 个库"的版本，点启动只会得到一句
「请回到「下载」页重新安装一次」。**我们把该自己干的活推给了用户** ——
他凭什么知道"已安装"是假的？

现在启动前会自动扫盘、缺什么补什么、补完**重新扫一遍**
（真相以磁盘为准，不以"下载器说补好了"为准），只有补不齐才拦下并说明原因。
实测 1.20.1：缺 43 个 → 补回 43 个 → classpath 从 8 项涨到 43 项。

**顺带挖出的两条真故障**：

* **Forge 的本地生成 client jar 被误报成"缺库"** —— Forge 56+ 的版本 JSON 里
  `net.minecraftforge:forge:<ver>:client` 的 `url` 是**空串**，
  因为那个 77 MB 的 jar 是安装器的 processor 拿原版 jar 打补丁
  **本地生成**的。老代码会给它编一个 `libraries.minecraft.net` 地址（必然 404），
  于是**装好的 Forge 版本永远被拦在启动之前**，重装几次都消不掉。
  现在这类缺口单独报："这是装坏了，要重装 Forge"（而不是"请重新下载"）。
* **一条测试在"假绿"** —— "真实版本不缺库"那条把数据目录写死成旧路径，
  数据目录搬走后就变成**每次都跳过**。改成 `AppPaths::resolve()` 后它立刻变红，
  抓出了上面那个 1.20.1。

> 教训：**测试不跑，等于没有**。跳过（skip）和通过（pass）在报告里长得一样绿。

### ★★ 已经不是"挡住用户"，而是"做完并真机验证过"的

**OptiFine / LiteLoader 的自动安装**（2026-09-14 实装）。

这条的历史值得留着，因为它是一个**反复犯的错**：

1. 起初 `addon_install_implemented(OptiFine)` 返回 `true`，注释还写着
   "`install_version` 里有 Patcher 分支"——**那句话不成立**，
   全仓库没有任何一处下载 OptiFine、跑它的 Patcher 或写版本 JSON。
   界面上那个开关于是**一半能点一半不能点**：清单查到了就能勾（勾了没效果），
   查不到就灰掉。用户报的「显示有高清修复，实际上点击后不让选」正是它。
2. 然后两个都改成 `false`（诚实，但功能确实没有）。
3. 现在两个都**真的实现了**，并且都有真机测试证明装完能进游戏：
   * `net::optifine` —— 照 PCL 的 `McDownloadOptiFineInstall`：
     下载安装器 → **读 `optifine/Installer.class` 的 class 头**决定要哪个 Java →
     造临时 `.minecraft` 跑官方 Patcher → 产物拷回。
     实测 1.16.5 + HD U G8：装完启动、活过 30 秒、ConnectedTextures 在工作。
   * `net::liteloader` —— 照 PCL 的 `McDownloadLiteLoaderLoader`：
     它**没有安装器**，就是写一个带 `--tweakClass` 的版本描述 +
     下 launchwrapper / asm-all / 本体三个 jar。
     实测 1.12.2：装完启动、LiteLoader 正常 bootstrap。
     **挂载点跟着基座加载器走**：选了 Forge 就沿 `inheritsFrom` 挂到
     Forge 那份版本描述上（否则 Forge 的库一个都不会进 classpath）。

> 记住这条判据：**"上游有没有"与"我们做没做"必须分开回答**。
> 代码里它是 `available === exists && implemented` 这一行，
> 前后端各有一条测试钉着它。

### ★ 已实测的真实启动证据

用真实下载的 Minecraft 1.20.1 启动，日志里 **7/7 初始化标记全部命中**：

```
Setting user: IEMLTest
Backend library: LWJGL version 3.3.1 build 7
OpenAL initialized on device 扬声器 (Realtek(R) Audio)
Reloading ResourceManager: vanilla
Sound engine started
Created: 1024x512x4 textures/atlas/blocks.png-atlas
Datafixer Bootstrap: 188 optimizations took 240 milliseconds
```

下载规模：**912 个版本清单条目 → 88 个库（架构过滤后 43 个）→ 3598 个资源文件**，
耗时 355 秒，峰值 67 MB/s。

`Failed to verify authentication` 是离线模式的**预期输出**，不是错误。

### ★ 1.12.2（老版本）的 natives：一个值得记住的坑
1.12.2 起不来，日志只有一句
`UnsatisfiedLinkError: no lwjgl64 in java.library.path`，而 natives 目录**是空的**。

根因不是 Java 版本，而是**老格式的 natives 在坐标里看不出来**：

```
org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209     ← 没有任何 natives- 字样
  ├─ downloads.artifact      → lwjgl-platform-2.9.4-nightly-20150209.jar        （22 字节，占位符）
  ├─ downloads.classifiers   → …-natives-windows.jar                            （613 KB，装着 lwjgl64.dll）
  └─ natives: {windows: "natives-windows"}                                      ← 关键信息在这里
```

只按坐标判"是不是 natives" → 判错 → 22 字节的占位 jar 进了 classpath，
613 KB 的真正 natives jar 没人解压 → dll 一个都没有。

修完之后实测：1.12.2 在 **Java 8 与 Java 25 上都能进到渲染循环**
（`LWJGL Version: 2.9.4` / `Sound engine started`），
所以"1.12.2 崩了"确实与 Java 版本无关 —— 但**启动前仍然会拦住 Java 版本不对的情况**，
因为"能起来但随时崩"比直接崩更难查。

判据现在只有一个入口：`metadata::is_native_lib(&Library)` ——
坐标与 `natives` 字段**一起问**。谁只用一半，编译期就会看到
`name_looks_native` 这个名字在提醒他。

### ★ 子进程不能弹窗：`CREATE_NO_WINDOW` 只有一处可以写

Windows 上，**GUI 子系统进程**（`ieml.exe` 没有控制台）启动
**控制台子系统程序**（`java.exe` / `tar.exe` / `taskkill.exe`）时，
系统必须新建一个控制台 —— 不传 `CREATE_NO_WINDOW` 就会**弹出那个窗口**。

用户看到的就是「安装 Forge 调出来个啥也没有的 cmd」：
Forge 安装器的输出被启动器接走了（要判断成功失败、给用户看进度），
所以窗口里什么都没有，只剩一个空壳。

> Forge 官方只提供 installer jar 这一个无人值守接口
> （`java -jar forge-installer.jar --installClient <dir>`），
> 所以**用命令行跑是对的** —— 错的是让那个窗口露出来。

这个魔数**只允许出现在 `platform.rs` 一处**，通过
`platform::hide_console`（std）/ `hide_console_async`（tokio）使用。
理由：手写 `0x0800_0000` 抄错一位就是一个新黑框，而且不会有任何报错。
本轮审计发现全仓库 **4 处加了、13 处没加**，而唯一会真的弹给用户看的
那一处（安装 Forge）恰好用的是 `tokio::process::Command` ——
标志只加在了 std 那一侧。

`pnpm verify` 里的 `tools/gates/audit-spawn-windows.mjs` 会逐处审计这件事。

> ⚠️ 这个黑框**在 `cargo test` 里复现不出来**：测试宿主自带控制台，
> 子进程会**继承**它、不新建窗口。要真复现需要一个没有控制台的父进程
> （也就是 ieml.exe 自己）。所以这里靠静态审计 + 人工双击确认。

---

## 工具链（Windows）

```powershell
# 1. Rust
#    https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -y

# 2. MSVC 生成工具 + Windows SDK（Rust 链接必需）
#    https://aka.ms/vs/17/release/vs_buildtools.exe
#    --add Microsoft.VisualStudio.Workload.VCTools
#    --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64
#    --add Microsoft.VisualStudio.Component.VC.ATL
#    --add Microsoft.VisualStudio.Component.Windows11SDK.26100

# 3. 编译时用 tools/env/cargo.ps1 —— **跑 cargo 的唯一入口**
#    （首选 vcvars64.bat；它不可用时自动改用自己拼的 MSVC 环境并把这件事说出来）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 build --manifest-path src-tauri/Cargo.toml
```

**踩过的坑**：`vs_installer.exe modify --installPath D:\VS ...` 在已装的
VS Community 上永远返回 **exit 87**，加 `--passive` 变成 **5007**。
用独立引导器 `vs_buildtools.exe` 才成功。

**踩过的坑（vcvars 静默失败）**：`vcvars64.bat` 会调 `reg.exe` 找 Windows SDK，
而这台机器上 `reg.exe` 被安全中心拦过 —— 它**退出码是 0 却没设置 `%LIB%`**，
链接随后报 `LNK1181: cannot open advapi32.lib`（看着像代码问题，其实是环境没搭上）。
现在 `tools/env/cargo.ps1` 会检查 `%LIB%`，没设上就自动改用
`tools/env/cargo-manual-msvc.ps1`（自己拼 PATH/LIB/INCLUDE，MSVC 与 SDK 版本**自动发现**，不写死）。
两条路都实测过（正常路径 `cargo 1.98.1`；把 `IEML_VCVARS64` 指到一个不存在的路径即可验证回退分支）。

**踩过的坑（PowerShell 脚本的编码）**：Windows PowerShell 5.1 会把**没有 BOM 的 `.ps1`**
按**系统 ANSI（本机是 GB2312）** 读 —— 中文注释会变成乱码，而乱码的字节对**会吃掉后面的引号或反引号**，
于是报错指向的是**别的地方**（实测：报"第 30 行的 `&&` 不是合法分隔符"，真正的原因在第 35 行的中文串）。
所以 `tools/env/*.ps1` 与 `tools/probe/probe-ms-devicecode.ps1` 一律存成 **UTF-8 with BOM**。

**踩过的坑（PATH）**：`cargo` 装在 `%USERPROFILE%\.cargo\bin`，但**这个目录不一定在
PATH 上**。此时 `pnpm desktop:build` 会以
`failed to run 'cargo metadata' …: program not found` 失败 —— 报错来自 tauri-cli，
看起来很吓人，其实只是找不到 cargo。`tools/env/cargo.ps1` 内部用的是 cargo 绝对路径，
所以它不受影响（这也是"cargo.ps1 能编译、pnpm desktop:build 却不行"的原因）。
修法二选一：把 `%USERPROFILE%\.cargo\bin` 加进 PATH 并用 **`pnpm desktop:build`**
（推荐 —— 它会正确把前端 `dist/` 嵌进 exe），或者只用 cargo.ps1 跑 Rust 测试。

> ⚠️ 别用裸 `cargo build --release` 代替 `pnpm desktop:build`：编译能过，但产出的
> exe **完全没有前端资源**，跑起来是一个空白窗口。实测（2026-09-11）：
> `cargo build --release` → 6 778 880 B，在二进制里搜不到任何前端资源标识
> （`createRoot` 出现 0 次）；`pnpm desktop:build` → 6 907 904 B，前端正常内嵌。
> 差值 129 KB 正好对应压缩后的 365 KB `dist/`。

---

## 目录结构

```
src/
  app/AppShell.tsx        外壳：一级/二级侧栏分支、面包屑、Toast
  pages/                  页面（LaunchPage / VersionsPage / DownloadPage / SettingsPage
                          / InstanceOverview / InstanceSetup / ModsPanel / LogsPanel）
  components/TaskCenter   任务中心（下载进度、暂停、重试）
  flows/install.ts        安装流程编排（调桥接层，不在 UI 里写规则）
  bridge/                 ② 桥接层：types.ts 接口 + web.ts / tauri.ts 两套实现
  domain/                 ③ 领域层（TS 版，与 Rust 版一一对应）
  state/                  store（reducer）+ AppContext（事件桥）+ events.ts（事件名契约）
  styles/                 tokens.css（设计令牌）/ app.css（骨架）/ pages.css（页面）
  ui/                     Button / Card / Chip / Note / Modal / Segmented / Icons…
src-tauri/
  src/domain/             ③ 领域层（Rust 版）
  src/net/                下载引擎、镜像重写、元数据、安装器、Adoptium
  src/auth/               微软设备码登录 + 密钥环
  src/game/               启动参数拼装、进程管理
  src/platform.rs         数据目录选址与迁移、Java 探测（8 类来源）、机器信息
  src/commands_real.rs    Tauri 命令（真实实现）
  tests/                  真实端到端测试（#[ignore]，需 -- --ignored 显式跑）
tools/
  README.md                 **脚本索引**（一个脚本回答一个问题，按用途分目录）
  verify.mjs / set-version.mjs / make-icons.mjs / gen-…-cases.mjs
  gates/                    静态门禁（进 verify）：子进程窗口、内嵌前端、打包产物…
  env/                      构建环境：cargo.ps1（唯一入口，自动回退）/ deploy-desktop.ps1
  live/                     真机验证：live-*-check.mjs / shot.mjs
  probe/                    打上游接口的探针（先证明事实，再写代码）
  diag/                     一次性诊断与考古（看本机数据目录到底怎么了）
docs/                     ARCHITECTURE / DECISIONS / DESIGN_SYSTEM / ROADMAP /
                          VERSIONING / LAUNCHER_SOURCE_STUDY / MS-LOGIN-PCL-STUDY /
                          PCL_DOWNLOAD_ENGINE_STUDY / pcl-download-reference
tests/                    领域规则与判据表的测试（node --test）+ 跨语言判据表 JSON
design/mockup.html        最初的可交互设计稿（图标由它生成）
```

---

## 文档

| 文档 | 内容 |
|---|---|
| `docs/DECISIONS.md` | **ADR-001 ~ ADR-055**：决定了什么、为什么、依据 |
| `docs/DESIGN_SYSTEM.md` | 设计令牌、组件规范、信息架构 |
| `docs/ARCHITECTURE.md` | 分层、数据流、性能目标 |
| `docs/LAUNCHER_SOURCE_STUDY.md` | 对 PCL2 / HMCL 源码的研读结论 |
| `docs/MS-LOGIN-PCL-STUDY.md` | **PCL2 微软登录逐行研读**（六步流程 / 缓存层 / 错误翻译表）与我们的对照 |
| `docs/ROADMAP.md` | 后续计划 |
| `.workbuddy/memory/` | 逐轮的开发记忆（踩过的坑、实测数据） |

---

## 测试

> 下面的项数是 **2026-09-14（dev.12）实测**的。写死数字有风险（下一轮就会变），
> 所以规则是：**改了测试就顺手改这里**，别让它变成第二个"README 落后 8 个版本"。

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # 前端领域测试 111 项（含 Java 规则的跨语言判据表）
pnpm test:e2e       # 端到端规则校验 59 项
pnpm test:rust      # Rust 领域测试 382 项
pnpm verify         # 以上全部 + 生产构建 + 子进程/版本号/文档口径/内嵌前端/两张判据表
```

### ★★ 跨语言的规则判据表（dev.12 新增）

「这个版本需要 Java 几」有两份实现（Rust 启动时用它挑 Java、TS 界面显示它）。
两边漂移的后果不是"显示不好看"，而是**用户被两个答案骗**。
所以规则期望值写在**一份表**里：`tests/java-rules.cases.json`（26 条，全部来自
PCL 的 `ModJava.vb`），TS 与 Rust 各跑各自的引擎、比对同一个期望区间字符串。

```bash
node --test tests/java-rules.test.mjs                 # TS 侧
powershell -File tools/env/cargo.ps1 test --manifest-path src-tauri/Cargo.toml \
  --lib domain::java                                  # Rust 侧（同一条用例表）
```

写这份表的时候它当场抓出了 3 处期望值误判 —— 这正是它存在的意义。

### 真实端到端测试（默认跳过）

```bash
# ① 真实下载：版本清单 → 版本 JSON → 客户端 jar → 库 → natives → 3598 个资源文件
$env:IEML_LIVE_ASSET_LIMIT = '0'   # 0 = 下全部；测试时可用 150 只下一部分
powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
  test --manifest-path src-tauri/Cargo.toml --test live_launch -- --nocapture --ignored

# ② 自动下载 Java + 真实启动 + 校验 7 个初始化标记
powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
  test --manifest-path src-tauri/Cargo.toml --test live_launch_java -- --nocapture --ignored
```

测试数据目录：`%TEMP%\ieml-live-test`（含完整 1.20.1，约 584 MB）。

### ★ 测试抓到过的真 bug（这就是不纸上谈兵的价值）

| Bug | 后果 |
|---|---|
| **现代格式的 natives 是独立库条目**（`org.lwjgl:lwjgl-glfw:3.3.1:natives-windows`），不是老的 `natives` 字段 | 1.20.1 实测 `natives` 字段 **0 个**、带 `natives-*` classifier 的库 **12 个**。按老办法解析 → `UnsatisfiedLinkError: Failed to locate library: lwjgl.dll` |
| **natives 的架构没过滤**：`natives-windows` / `-arm64` / `-x86` 三种变体的 rules 都是 allow windows | 32 位 dll 覆盖 64 位 → `Can't load this .dll (machine code=0x14c) on a AMD 64-bit platform`。且 `read_dir` 顺序不确定，结果时好时坏。修法：精确架构过滤 + 解压前清空目录 |
| **Java 版本正则 `version "1?(\d+)"` 在 `"17.0.20"` 上贪婪吃掉 `1`，捕获到 `7`** | 下载完 Java 17 后报"实际得到 Java 7"，启动被拒。正确写法 `version "(?:1\.)?(\d+)"` |
| **下载引擎没有传输超时** —— `connect_timeout` 只管建连 | 下 3598 个资源时最后几十个**永久挂住**（实测卡了 20 分钟）。加 chunk 超时（20s×3）+ 文件总超时（300s） |
| **镜像改写表漏了 `piston-data.mojang.com`** —— 新版本（实测 26.2）的客户端 jar 已从 `launcher.mojang.com` 迁到这里 | jar 永远走官方直连，实测单文件 39 MB **被中途掐断** → 整个安装失败，表现为"点了下载没反应"。且 `candidate_urls` 对未改写域**只返回 1 个候选**，等于没有兜底。修法：补改写规则 + 任何情况都保留两个候选 |
| **`1.20.1` 被解析成 `major=1, minor=20`** | 三段式比较全部错位，Java 判定从 17 变成 21 |
| **下载页签的图标把文字挤成竖排** | 内联 SVG 不带 `width` 属性时浏览器按"视口面积开方"猜尺寸（实测 29.86px）；flex 子项默认 `flex-shrink:1` 又会把图标压成 0 宽。已在 `tokens.css` 用 `svg { flex-shrink: 0 }` 兜底 |
| **Mod 列表是上一个版本的残留值** | 概览页说「Mod 0 个」，点进 Mod 管理是「25 个」，同一个版本两个数字。修法：切换版本时在 reducer 里清空 |
| **natives 解压层级随版本变了**（实测 26.2 / LWJGL 3.4.1） | 新版版本 JSON 自带 `-Djava.library.path=${natives_directory}/java`，指向的是**子目录**；仍把 dll 平铺在 natives 根目录 → 游戏刚起就崩：`UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。修法：解压目标从版本 JSON 自己声明的位置推导（`metadata::natives_java_subdir`），不写死 |
| 启动摘要 `2048 MB` 显示成 `2 MB`（整数除法） | 用户以为内存设错了 |

---

## 已知限制（诚实清单）

> 这份清单**每一轮都要重读一遍**：上一轮列的限制，这一轮很可能已经做完了
> —— 留着过期的 ❌ 和留着过期的 ✅ 一样有害（前者让人白绕路，后者让人白高兴）。
> 2026-09-14（dev.12）按实际代码逐条核对过一次（上一次是 dev.5）。

| # | 限制 | 现状 |
|---|---|---|
| 1 | ~~Forge / NeoForge 安装器未执行~~ | ✅ **已做**：静默跑官方 `--installClient`（控制台窗口已全量抑制，`pnpm verify` 里有审计）。真机验证含 processor 产物 |
| 2 | ~~整合包只做到清单解析~~ | ✅ **已做**：`.mrpack` 走 `modpack_install`（本体 + 加载器 + Mod + overrides） |
| 3 | ~~Mod 下载未实现~~ | ✅ **已做**：`installMod` + Modrinth 搜索，另有「下载页 → Mod」页签作为入口 |
| 4 | ~~暂停 = 取消~~ | ✅ **已做（dev.12，P0-3）**：真正的暂停令牌 + 两批都生效 + `paused/remaining/stage` 上报；点「继续」按原参数续下 |
| 5 | **只测过 Windows** | ⚠️ 仍在：macOS / Linux 未实测（代码里没有平台硬编码，但没有证据） |
| 6 | **Quilt 已实现但未实测** | ⚠️ 仍在：走与 Fabric 同一条 profile 合并路径，本机没装过 Quilt 版本 |
| 7 | ~~CurseForge 不可用~~ | ✅ **已做（dev.13，ADR-052）**：资源中心多一个「CurseForge」来源（Mod / 资源包 / 光影 / 数据包 搜索 + 安装 + 按指纹查更新）。**内置了一把 API Key**（开箱即用），设置页可以换成你自己的 |
| 8 | **总内存约 359 MB** | ℹ️ 其中约 331 MB 是系统 WebView2 的多进程开销，Tauri 结构决定 |
| 9 | **内置的 client_id 是一次性的、且未实测** | ⚠️ 2026-09-15 按用户要求换成他自己提供的那把（**没有验证过** —— 用户明确说"不要验证，只换上"）。它的状态只有第一次真的点登录才知道：不认时界面会把 `AADSTS700016` 翻成人话。想稳就在界面里填自己注册的 id，或设 `IEML_MS_CLIENT_ID` |
| 10 | **没有做真机启动验证** | ⚠️ `0.1.0-beta.2` 这一轮改的是界面 + 一个 client_id 常量 + 命名规范，用 CDP 截图逐页看过，但**没有点一次"启动游戏"**、也没有真的装一次资源。交付到桌面请先 `pnpm desktop:build`（构建 + 部署 + SHA256 证明两份一致） |
| 11 | **资源中心没有"已装"标记** —— **按用户决定不做**（2026-09-15，用户原话"明确不做"） | ⚠️ `0.1.0-beta.2` 新增：列表里不会标出"这个项目你已经装了"—— 需要跨项目 id 与本地文件名/哈希比对，本轮没做。装重复了不会拦你 |

### 已经清掉的（留个记录，别再当成 ❌）

* **Java 找不到 Java 21** —— 现在扫 8 类来源（含 `.minecraft\runtime`），实测找到 8 / 21 / 25 三个
* **1.12.2 崩在 `no lwjgl64 in java.library.path`** —— 老格式 natives 的 classifier 选错
* **装好的版本缺文件却没人管** —— 现在启动前会自愈（见上）
* **界面写着"已安装"但起不来** —— 同上；本机 14 个版本现在全部 classpath 完整

---

## 许可

**GPL-3.0**（全文见 [`LICENSE`](LICENSE)）—— 与 PCL2 同一个协议：
可以用、可以改、可以再发布，但**衍生作品必须同样开源**。

> ★ 为什么选它：这个项目的很多结论来自对 PCL2 / HMCL 源码的研读
> （见 `docs/LAUNCHER_SOURCE_STUDY.md`、`docs/MS-LOGIN-PCL-STUDY.md`），
> 而它们都是 GPL 系。用同一个协议，是这份"站在别人肩膀上"的关系里最省事的做法。

### ★★ 仓库现在是**私有**的，而且**不能直接改成公开**（有一条硬理由）

源码里内置了一把 CurseForge API Key（`src-tauri/src/net/curseforge.rs` 的
`BUILTIN_API_KEY`），它是"装完就能搜 CurseForge"这个开箱即用体验的来源。
**公开仓库会把这把 key 一起发出去**（额度共用、随时可能被撤销或封）。

所以要把这个仓库转公开，**必须先做一件事**：

1. 把 `BUILTIN_API_KEY` 置空（`const BUILTIN_API_KEY: &str = "";`），
   改由用户自己填（界面里的「设置 → 下载」，或环境变量 `IEML_CF_API_KEY`）；
2. 确认 `git log` 里**没有**这把 key 的历史（本仓库的第一版就有它 —— 所以
   简单删掉还不够，要么重建历史，要么换一把 key 并撤销旧的）；
3. 顺手检查 `.workbuddy/memory/**`：那是逐轮的工作记忆，里面有本机路径之类的
   内部细节，公开前值得过一遍。

Minecraft 是 Mojang Studios 的商标，本项目与 Mojang / Microsoft 无任何关联，
**不含任何游戏资源文件**（界面里的版本图标是按世代配色**自绘**的方块形状，
不是官方贴图 —— 见 `src/components/VersionIcon.tsx` 的说明）。
