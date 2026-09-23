# IEML 缺陷报告（2026-09-24 自主巡检）

> **这份报告只报缺陷，不改代码。** 每条都给了「现象 / 判据 / 复现 / 影响」。
>
> **验证等级**（必须分清，别把我的推断当实测）：
> * **【真机】** —— 在这台机器上用 CDP 探针跑出来的，有脚本、有输出；
> * **【代码】** —— 我自己把两处（或以上的）代码读完对齐后的结论，**没有**实机复现；
> * **【已排除】** —— 我怀疑过、查完发现**不是**缺陷的（写出来免得下一轮再查一遍）。
>
> 分工：静态全量扫描由两个子代理做（重复判据 / 承诺与死路），
> 报告里每条**关键结论我都自己复核过**（读原文或真机跑探针），没复核过的会写明。

---

## 一、严重（用户会直接撞上，且界面上说的与事实相反）

### A-1　三处「启动」按钮点了什么都不发生【真机】

**现象**：版本列表行的 `⋯ → 启动`、概览页的「启动」、实例侧栏的「启动这个版本」——
点了之后菜单关掉，然后**不跳页、不启动、不报错**，什么都没有。

**判据（真机）**：CDP 问浏览器"这个页面上 `ieml:launch-request` 有几个监听器"：

| 页面 | 监听器数量 | 手动派发该事件 |
|---|---|---|
| 版本列表 | **0** | 3 秒后页面/提示/进程**毫无变化** |
| 启动 | 1 | （不测，见下） |

行的 `⋯` 菜单项实测为：`["打开设置","启动","重命名","创建副本","打开目录","删除"]` —— 「启动」确实在。
（探针**故意不点**菜单项而是直接派发事件：实测没有监听方，所以不会真的拉起游戏；java 进程数 0。）

**根因**：`ieml:launch-request` 的**唯一**监听方是 `LaunchPage` 的 effect，而它只在
`state.page === 'launch'` 时挂载；三个派发点全部发生在 `versions` 页。

**复现**：版本列表 → 任一行 `⋯` → 启动。或 `node tools/live/probe-launch-request.mjs`。

**影响**：版本列表与概览里最显眼的动作是死的（用户会以为"卡了"）。

---

### A-2　纯原版实例的 OptiFine / LiteLoader：装了、报"已装好"，启动时**完全不用**【代码】

**现象**：勾高清修复 → 弹「OptiFine 已装好」→ 启动进游戏，OptiFine 没生效；
而版本列表 / 概览 / 启动页仍然挂着「OptiFine」角标。

**判据（代码）**：
* `LaunchRequest`（`commands_real.rs:2815-2845`）字段里**没有 addons** ——
  附加组件根本没传到启动侧；
* `resolve_loader_version_id`（`:3130-3139`）：`loader_kind` 为空（纯原版）时
  **直接 `return Some(mc_version)`** → 读的是 `versions/<mc>/<mc>.json`（原版 JSON），
  而 OptiFine 的产物在 `versions/<mc>-OptiFine_*/`；
* 启动闸（`:3455-3466`）只把 OptiFine 从"冒犯项"里**排除**（注释写着"纯原版 + OptiFine 是合法用法"），
  但**没有任何代码去用它**。

**影响**：这是一条"承诺 vs 现实"的正面冲突（ADR-041 那一类）。装上、报成功、角标都在，
而游戏里没有 OptiFine —— 用户无法从界面上看出来。

---

### A-3　「已永久删除」，磁盘上一个字节都没删【代码】

**现象**：删实例时回收站不可用 → 按提示确认"永久删除" → 弹「已永久删除」，
但 `instances/<slug>/` **还在盘上**，而记录已经没了，再没有入口能删它。

**判据（代码）**：`AppContext.removeInstance`（`:1062-1068`）：

```ts
const inst = instancesRef.current.find((i) => i.id === id);
dispatch({ type: 'instances/remove', id });   // ← 记录先删掉了
if (!inst) return 0;                          // ← 第二次调用时 inst 已经是 undefined
```

调用方（`VersionsPage.tsx:786-790`）在重试分支里 `.then(() => toast('warning','已永久删除', …))`
**无条件报成功**（成功分支会按 `bytes > 0` 分两种说法，重试分支没有）。

**影响**：用户以为删干净了，其实留了一份带存档的目录在磁盘上，且无法从界面清理。

---

### A-4　`instances.json` / `prefs.json` 还住在**游戏根目录**：用启动器删根目录 = 删掉全部实例与全部设置【真机 + 代码】

**现象**：ADR「启动器数据目录搬出游戏根目录」只搬了一半 ——
`instances/ java/ cache/ logs/` 去了 `%APPDATA%\IEML`，但**两个 JSON 没走**。

**判据**：
* 代码：`commands.rs:471-472` 与 `:515-516` —— `state.paths.root.join("instances.json" / "prefs.json")`；
  而 `platform.rs:63-66` 把 instances/java/cache/logs 挂在 `own_root`（`%APPDATA%\IEML`）。
* **真机磁盘证据**（这一台）：

| 文件 | mtime | 说明 |
|---|---|---|
| `D:\IEML\instances.json` | **2026-09-23 17:06:58** | 应用现在读写的就是这一份（3 个实例） |
| `D:\IEML\prefs.json` | **2026-09-23 17:06:58** | 应用现在读写的偏好（主题 `daiqing`） |
| `%APPDATA%\IEML\instances.json` | 2026-09-13 16:00:57 | **陈旧副本**，内容还是 3 个实例 |
| `%APPDATA%\IEML\prefs.json` | 2026-09-13 16:00:57 | **陈旧副本**（主题 `dark`） |

* 我最初以为"主题没恢复"（冷启动 0.5s `data-theme="dark"`、2s 后变 `daiqing`），
  **查完发现主题是对的**：应用读的就是 `D:\IEML\prefs.json`（`daiqing`），
  我看的是 `%APPDATA%` 那份陈旧副本 —— 见「已排除 E-1」。

**影响（具体到用户会怎么撞上）**：
1. 用户明确要的「游戏根目录每行可删（连目录一起删）」（ADR-053）——
   在 `D:\IEML` 这行点删除，会**连带删掉 `instances.json` 与 `prefs.json`**：
   实例清单与全部偏好一起消失，而确认框里没有这句话。
2. 两个位置各有一份，谁看谁糊涂（我自己就因此误判了一次）。
3. 实例**目录**也在两个地方：`D:\IEML\instances\`（6 个，含清单里的 3 个 slug）
   与 `%APPDATA%\IEML\instances\`（只有 1 个孤儿目录）。
   本次查证：游戏根那 6 个里 `saves/`、`mods/` 都是**空的**，
   只有 `natives/`、`options.txt`、游戏日志 —— **没有真实存档被藏起来**（不夸大）。

**复现**：`node tools/live/probe-theme-restore.mjs`（看两个 prefs 的主题差）+
上表的 mtime 对比；删除路径不要真跑。

---

## 二、高

### B-1　Mod 更新说「N 个 Mod 已替换为新版本」，旧 jar 一个都没删【代码】

`ModsPanel.applyUpdates` 只调 `api.modrinth.installMod` → `install_mod`
（`commands_real.rs:1813-1836`）＝ `create_dir_all` + `download_one`，
**没有 remove_file / 替换逻辑**（我把函数体逐行看过，只有这两个文件操作）。
Modrinth 每次的 `filename` 通常带版本号 → 旧 jar 留着 → **同一个 Mod 两份**，
游戏可能同时加载，而界面说"已替换"。

### B-2　检查更新失败时，关于页写「已是最新版本」【代码】

`AboutPage.tsx:61-69` 的三元链只处理 `unsupported / available / ready / checking`，
**其余全部落到 `'已是最新版本'`** —— 包括 `'error'`（断网 / 404 / 签名失败）。
`useLauncherUpdate` 已经把错误翻成中文写进 `state.error`，但**没有任何地方显示它**
（`UpdateChip` 在 `error` 时直接 `return null`）。
→ 用户断网点「检查更新」，界面告诉他一个**假事实**。

### B-3　Quilt 自动装 QFAPI：违背用户 2026-09-15 的明确决定【代码】

* 用户决定（`CHANGELOG.md:2470` 原话）：「**不给 Quilt 装 API 了**」→
  Rust `api_for_base` 对 Quilt `return vec![]`，测试改成 `quilt_gets_no_api_library`，
  还写着「**规则仍只有一处**」。
* 而**活的那一侧**（TS）仍是：`loader-caps.ts:709` `base === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'`
  → `combination.ts` 放进 `autoApis` → `InstallComposer.tsx:899-902` **真的调
  `install_api_library(..., 'quilt')`**，界面上还写着「将自动安装 Quilted Fabric API 7.4.0+0.92.2」。
* 两条测试互相钉着相反的结论（TS `tests/domain.test.js` 断言 QFAPI；Rust 断言空）。

**影响**：建一个 Quilt 实例会往 mods/ 里多塞一个用户明确不要的 QFAPI。

### B-4　服务器地址端口写坏时，界面说的和启动器做的**相反**【代码 + 真机看到那句文案】

* 界面（`server-address.ts:130`，实测在实例设置页输入 `1.2.3.4:abc` 时页面里确实出现这句话）：
  「端口「abc」不是数字。**地址会原样传给游戏，不会自动改成默认端口**。」
* 真实行为（`launch_args.rs:356-363` + `:632-638`）：端口解析失败 → `port: None`
  → **只传 `--server host`，端口交给游戏用默认 25565**。
* 同一页面的注释（`InstanceSetup.tsx:830-831`）与 Rust 注释写的都是"只丢端口、连默认端口"。

**影响**：用户以为会报错，实际启动器把端口丢了、连上了 25565 —— 可能落到**另一个服务器**上，
而这正是这句提示想避免的事。

---

## 三、中

| # | 现象 | 判据 | 等级 |
|---|---|---|---|
| C-1 | CurseForge 那一半是假的：切到 CF 搜得到，点进去**装不了** | 两处仍走 `api.modrinth.versions(...)`（`DownloadPage.tsx:559-562`、`ResourceInstallPage.tsx:48`），而 CF 命中的 `project_id` 是 CF 数字 id；整合包还多一层 `mrpack_inspect` 只认 `modrinth.index.json`。后端已有 source-aware 的 `resource_versions`，这两条路没用它 | 【代码】 |
| C-2 | 「mods 目录」按钮打开的是**实例根目录** | 标签/title 写「打开这个实例的 mods 目录（game\mods）」，实参却是 `openDir('instance', slug)`；Rust 有 `"mods"` 分支且 `CrashModal` 用的就是它 | 【代码】 |
| C-3 | 「也可以把 .jar 文件直接拖进窗口。」——**没有任何拖放实现** | `onDrop/onDragOver/dataTransfer/onDragDropEvent` 在 `src` 里 **0 命中**，而 `tauri.conf.json` 是 `dragDropEnabled: true`（原生拖放被接管，没 JS 监听就等于什么都不做） | 【代码】 |
| C-4 | 版本列表底部「这些版本还没有游戏文件 / 起不来」是**假警报** | 判据是 `MC_PROFILES` 那 10 个内置版本的静态表 ∩ 实例的 mcVersion，**不读盘**；装 1.21.4 能跑，列表仍挂着这句 | 【代码】 |
| C-5 | 整合包安装页「点哪个装哪个」不成立 | `onPick` 里 `setPickedVersion(v)` 之后 `setTimeout(install, 0)` 捕获的是**本次渲染**的闭包，`pickedVersion` 仍是 `null` → 回退到"列表第一个" | 【代码】 |
| C-6 | Fabric API 前置包判定有**两套文件名名单** | `commands_real.rs:2110-2115`（fabric → `fabric-api`/`fabric_api`，`contains`）vs `modrinth.rs:507-513`（4 个前缀，`starts_with`，限 `mods/*.jar`）。→ Quilt 整合包只带 `fabric-api-…jar` 时会被判"缺 QFAPI"并再装一个（正是 `modrinth.rs:486-493` 注释警告的"两个 API 实现"） | 【代码】 |
| C-7 | 侧栏「最近玩过」**永不出现** | 判据依赖 `lastPlayedAt`，而 Tauri 路径**没有任何写入方**（新建/复制/整合包建实例都写 `null`；`AppContext.tsx:748-758` 注释明说"不再写"） | 【代码】 |
| C-8 | 崩溃规则表**两份**：TS 36 条 / Rust 35 条，id 与正则都漂移（`out-of-memory-heap` vs `oom-heap` …） | 弹窗走 TS（并显示「查了 36 条日志特征」）；Rust 那份是死路径，但**有测试钉着它** | 【代码】 |
| C-9 | Rust 侧仍写着「LiteLoader 的自动安装 IEML 还没有做」 | `combination.rs:257` 无条件报"装不了"，测试 `unimplemented_addon_is_never_reported_as_installable` 钉着它；而 `loader_caps.rs:238` 同一份代码里写 `=> true`，且 `net::liteloader` 真的实现了 | 【代码】 |

> C-8 / C-9 的用户可见影响**今天为 0**：`src/bridge/tauri.ts` 里那套 `rust.*` 命令
> （capabilities / validate / autoMemory / isolation / analyzeCrash / redact）
> **全仓库 0 处调用**（我验过）。但它们是"代码里写着假话 + 测试钉着假话"，
> 属于同一类缺陷，且下次谁去接这套命令就会踩。

---

## 四、低（一次性列清，不逐条展开）

* 一条重要提示的正文被丢掉：`AppContext.tsx:476-485` 派发用 `detail.message`，监听方读 `d.desc`
  → 「磁盘上的记录没有被清掉」这句话永远不显示。
* 更新日志页三处与实现不符（「：原版」写法、并不存在的「皮肤页」、设置页那两张卡已删）。
* 用户自己取消，却弹红色「安装失败：任务被取消」。
* 「附加组件可以稍后在「下载」页对这个版本重试」——下载页没有这个入口。
* 「来自 Modrinth」在资源安装页写死（从 CF 进来的也这么说）。
* 「还有一步」（数据包要放进世界 / 光影要 Iris）是死分支：唯一调用点写死 `installNote: null`。
* 「换一个游戏根目录（候选盘会列出来）」——`list_data_volumes` 这个命令根本不存在。
* 「创建副本」的 title 说"游戏文件共享、不多占几百 MB"，实参是 `copy_game_dir: true`（整份复制）。
* 死导出与死 CSS 成块存在（`rust` 对象、`flows/install.ts` 5 个导出、`.vi-top/.vi-left/.vi-right` 等 20 余组）。

---

## 五、已排除（我怀疑过、查完**不是**缺陷；写下来免得下一轮重查）

* **E-1 主题持久化是好的**：冷启动 0.5s `data-theme="dark"` → 2s 后 `daiqing`，
  我一开始当成"没恢复"。真因是**我看错了文件**：应用读写 `D:\IEML\prefs.json`（`daiqing`，
  今天 17:06 写的），而 `%APPDATA%\IEML\prefs.json` 是 09-13 的陈旧副本（`dark`）。
  → 主题功能本身没问题；问题在 A-4（两处副本）。
* **E-2 玻璃层没有挡住任何点击**：逐页把每个可点控件的中心点交给
  `document.elementFromPoint` 复核（10 个页面 × 全部按钮/页签/输入框）= **0 处被盖住**。
  （这条很重要：仓库里所有真机检查都用 JS `click()`，它**不做命中测试** —— 这类缺陷
  只能这样查。脚本：`tools/live/probe-click-blockers.mjs`。）
* **E-3 整合包页停在骨架屏不是卡死**：`load()` 有 `catch` 会出错误 Note + 重试按钮，
  我那次只是 3.5 秒还没返回（Modrinth 慢）。
* **E-4 各页没有 console 异常/NaN/undefined/横向溢出**：11 个页面逐页扫描干净
  （脚本：`tools/live/probe-pages-sweep.mjs`）。

---

## 六、这一轮新增的探针（都能重复跑）

| 脚本 | 回答什么问题 |
|---|---|
| `tools/live/probe-launch-request.mjs` | 「启动」按钮有没有人接住（A-1） |
| `tools/live/probe-theme-restore.mjs` | 主题有没有按 prefs 恢复（A-4 / E-1） |
| `tools/live/probe-prefs-persist.mjs` | 改一个设置 → 落盘 → 重启后还在不在 |
| `tools/live/probe-click-blockers.mjs` | 哪些控件被别的东西盖住（真机点不到，而 JS 能点） |
| `tools/live/probe-pages-sweep.mjs` | 逐页巡检：异常 / 可疑文案 / 压扁元素 / 破图 / 越界 |
| `tools/live/probe-server-hint.mjs` | 端口写坏时页面到底怎么说（B-4） |
| `tools/live/probe-loader-page-boxes.mjs` | 某一页每块的几何（可视高度 vs 内容高度） |

跑法：`node tools/live/<脚本>.mjs ["<exe>"]`（默认用 `src-tauri/target/release/ieml.exe`，
可以传桌面那份 exe）。
