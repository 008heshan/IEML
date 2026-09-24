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

## 修复进度（用户「全权交由你来做」之后，按第九节的顺序逐批修）

| # | 条目 | 状态 | 真机判据 |
|---|---|---|---|
| 1 | **A-0** 确认框全是摆设 | ✅ **已修**（`src/ui/confirm.tsx` + 14 处 `await`） | `probe-a0-fixed.mjs`：会弹窗 / 点取消真的拦住 / 点确认才真删 |
| 2 | **B-1** Mod 更新不删旧 jar（提示说"已替换"） | ✅ **已修**（判据 `oldFilesToDrop()` + 默认进回收站） | 单测三条；**端到端仍未复现**（见该节说明） |
| 2b | **A-5** 实例设置存不进磁盘 | ✅ **已修**（Rust `InstanceConfig` 补齐 7 个字段） | `probe-bug-repro-13.mjs`：13 个键一个不丢 + `--server` 真的传下去了 |
| 3 | **A-3** 假「已永久删除」 | ✅ **已修**（随 A-0 一起：改成"先删文件、成功后再删记录"） | 同上（第 ③ 条判据覆盖了"记录清了、目录也没了"） |
| 4 | **A-1** 三处「启动」按钮 | ✅ **已修**（监听器搬到常驻 `AppShell`；启动页那份已删） | `probe-a1-fixed.mjs`：监听器 1 个 / 切页且选中那一行 / 沙盒日志 + java / 无进程漏到真实根 |
| 5 | **A-4** 清单/偏好还在游戏根目录 | ✅ **已修**（四个文件搬进 `own_root`；老位置只读回退 + 启动时收养） | `probe-a4-fixed.mjs` 五条判据全绿 + 真实数据前后 mtime 对照（根里那两份一动没动） |
| 6 | **B-2 / B-3 / B-4** 界面说的和做的不一致 | ✅ **已修**（3 条：更新状态撒谎 / Quilt 又装 QFAPI / 端口提示说反） | `probe-b2-fixed.mjs`（含把代理指死逼出的失败支）+ `probe-bug-repro-1.mjs` ② 段 + `probe-server-hint.mjs` |
| 7b | **C-5** 整合包「点哪行装哪行」不成立 | ✅ **已修**（版本当参数传，不再依赖 state 时序） | `probe-c5-fixed.mjs` 差分判据：点 alpha.1 / alpha.2 → 装的是**各自**那个版本 |
| 7 | **C-2 / C-3 / C-4 / C-6 / C-7** + 廉价低项 | ✅ **已修**（5 条 + C-16/C-17/C-18/C-19/C-22/C-26） | `probe-bug-repro-9.mjs` 一次跑完四条全绿；C-2 有两条 Rust 测试钉着；`cargo test --lib` 453 通过 |
| 8 | **C-1** CF 的版本列表/安装链路 | ✅ **已修一半**（版本列表真的接上双源了；**CF 整合包的自动安装明确未做**、界面如实拒绝） | `probe-c1-fixed.mjs`：CF Mod 5 个版本 / CF 整合包 50 个版本 / 如实说明 |
| 8b | **C-8** 崩溃规则表两份（36 vs 35） | ✅ **已修**（12 条 id 对齐 + 两边共用判据表 + 进门禁） | 判据表立刻抓出 `gpu-driver` 正则**不跨行**的真缺陷（两侧都修） |
| 8c | **C-9** Rust 说 LiteLoader「还没做」 | ✅ **已修**（改按 `addon_install_implemented` 判；顺带把**从来没实现过**的两条上游约束真的实现了） | `cargo test --lib` 454 通过；测试改成断言两处说法一致 |
| 8d | 死代码与死 CSS | ✅ **已清理**（`rust` 对象 / 2 条 Rust 命令 / Rust 脱敏 / flows 死导出 / `.vi-*` 20 条） | `tsc` + `cargo test` + 门禁 |
| 8e | 更新日志页三处与实现不符 | ✅ **已修**（不在 CHANGELOG / ChangelogPage —— 在**面向用户的另一份**：`src/data/release-notes.ts`；三处假承诺按界面事实改掉） | 逐条与界面核对（版本名写法 / 不存在的"皮肤页"）+ ADR 70.12 |
| 8f | **用户报**：版本列表的版本被定位到 `%APPDATA%\IEML\instances` | ✅ **已修 + 已部署**（实例目录回到游戏根目录 `<root>/instances`；`java/cache/logs` 留在启动器自己的家） | `probe-instance-root.mjs` 五条判据：**同一份真机数据**上旧发布版 3/3 落在 C 盘（其中 2 个目录磁盘上根本不存在）→ 新构建 3/3 落在 `D:\IEML\instances` 且都存在；**部署后**又按用户原动作验 `probe-versions-page-dir.mjs`：版本列表 →「打开目录」的 toast = `D:\IEML\instances\vanilla-262`、资源管理器窗口的 LocationURL 也是它；ADR 七十一 |
| 8g | **同族**：`instance_health` / 下载页"有没有版本在用"仍在读**旧位置**的 `instances.json`；`migrate_data_root` 反向把 `java/cache/logs` 灌进游戏根目录 | ✅ **已修**（改走 `own_file_for_read`；跨根搬家只剩 `instances`，反方向新增 `adopt_own_dirs` 收养回 own_root） | `tools/live/probe-manifest-location.mjs`：旧发布版读到 `["root-only"]`（游戏根那份）→ 新构建读到 `["own-1","own-2"]`（启动器自己的家）；`cargo test --lib` 459 通过 |
| 8h | **用户要求（非缺陷）**：ABC 全做 —— 删 C 盘残留 + 把启动器自己的家也搬到游戏盘 | ✅ **已做**（`%APPDATA%\IEML` 从 1.11 GB 降到 **2516 字节 / 5 个文件**；家 = `D:\IEML-launcher`） | `tools/live/probe-own-root-move.mjs` 六条判据（含"存回偏好写进新家、C 盘连文件都没有"）+ 删除前逐项核对"目标侧已有"；ADR 七十二 |
| 8i | **用户报**：点侧栏切换页面时，滚动位置被上一页继承（不回顶部） | ✅ **已修**（`AppShell` 换屏时把 `.content` 滚回 0；`useLayoutEffect` + 只认"屏幕身份"那几个字段） | `tools/live/probe-page-scroll-top.mjs` 红绿对照：坏构建 设置→更新日志 停在 **906**、更新日志→设置停在 **906**；修好后都是 **0**；同一屏内拨开关不被拽回顶部；ADR 七十三 |
| 8j | **用户定格式**：更新日志正文改成「新增了 / 修复了 / 优化了 / 删除了 / 修改了」五段（必读模板） | ✅ **已定稿 + 已进门禁 + 已发布 rc.4**（`release-notes.ts` 文件头即模板、段名进类型、新增第 25 项门禁） | `tools/check-release-notes.mjs` 进 `verify.mjs`（门禁 **25 项全过**，四类规则都先证明能红）；`probe-changelog-format.mjs` 4/4 + 截图；ADR 七十四 |
| 8k | **用户报**（截图）：任务管理器里 IEML 与 WebView2 分成两摊 —— 「一个本体，一个渲染」 | ⚠️ **结构问题无法合并**（WebView2 子进程身份由运行时定，官方旗标清单里没有可改的；Tauri issue 仍开着）+ ✅ **顺手量出并修掉一个真缺陷**：最小化后仍在烧 CPU | 真机判据：修之前 前台 **77%** / 最小化 **37%**（单核）→ 修之后 前台 **33%** / 最小化 **2%**，且 `rootClass=tab-hidden` 证明暂停生效；ADR 七十六 |

> 每批的详细记录在 `docs/DECISIONS.md`（从 ADR 六十二 起）。

---

## 第 2–3 轮（2026-09-24）：把【代码】级的条目尽量升级成【真机】

这一轮专门补真机证据，结果如下（原始输出见文末「第 2 / 3 轮证据」）。
★ 第 3 轮最大的收获是 **A-0**：为了验 A-3 而做的沙盒删除，顺手炸出了
"全应用确认框都是摆设"这一条 —— 它比原来那份清单里任何一条都严重。

| 条目 | 升级结果 |
|---|---|
| **A-0 所有确认框都是摆设（第 3 轮新增，最严重）** | **【真机】+【根因】确认**：`confirm()` 返回 Promise（0ms）、await 后被 ACL 拒绝、守卫写法恒放行；14 处受影响，含"删游戏根目录"的两道确认 |
| B-3 Quilt 自动装 QFAPI | **【真机】确认**：1.20.1 + Quilt 那一页写着「将自动安装 **Quilted Fabric API 7.4.0+0.92.2**」，并有一条"安装前请确认"的提示，安装按钮可点 |
| C-1 CurseForge 那一半 | **【真机】确认**（比原判断更准，见下方改写） |
| C-12「把查不到说成没有」 | **【真机】确认**：CF 来源的包直接显示「上游没有给它发布任何文件」 |
| C-18「来自 Modrinth」写死 | **【真机】确认**：来源选 CurseForge 的包，安装页仍然写「来自 Modrinth」 |
| A-1 三处「启动」按钮 | 上轮已【真机】；本轮再确认：行菜单里确实有「启动」，而那一页 `ieml:launch-request` 监听器 = **0** |
| **A-3「已永久删除」但没删** | **【真机】确认**（第 3 轮，用沙盒做的）：① 弹出「已永久删除」② 记录消失 ③ `instances/<slug>/` 还在磁盘上 —— 三条判据同时成立 |
| **A-2 OptiFine 勾了也白勾** | **【真机】确认**（第 4 轮）：沙盒里两条只差 `addons` 的记录，命令行**逐字相同**且不含 OptiFine/tweakClass；两次确实选中了不同实例 |
| **B-1 Mod 更新不删旧 jar** | **【真机】确认**（第 5 轮，机制级）：沙盒里给一个实例连装 Sodium 的两个版本 → mods/ 里**两个 jar 并存**，两次都报「已装好」 |
| **C-3「把 .jar 拖进窗口」** | **【真机】确认**：`window` / `document` / `body` 上的拖放事件监听器**各为 0**（window 上其它事件共 21 个）⇒ 那句话没有实现 |
| **C-4「这些版本还没有游戏文件」假警报** | **【真机】确认**：沙盒实例是 26.3、`D:\IEML\.minecraft\versions\26.3` **确实存在**，版本列表底部照样写着「这些版本还没有游戏文件 起不来」 |
| **C-6 前置包判定两套名单** | **【真机】确认**：Quilt 实例的 mods/ 里放着 `fabric-api-0.92.2+1.20.1.jar` → 页面报「**缺 Quilted Fabric API**（判据是找 qsl 对应的 jar）」+「一键补装」，而 `modrinth.rs` 认为 `fabric-api` 就算有 ⇒ 两套判据不一致，且这条提示会引导用户再装一个 API 实现 |
| **C-7 侧栏「最近玩过」** | **【真机】确认**：有实例时 `.side-recent` 也是 **0 个**（侧栏只有导航与账号）—— 与"没有任何代码写 `lastPlayedAt`"对上 |
| C-2「mods 目录」按钮 | 仍是【代码】：5 个 `openDir(` 调用点都核对过（这一处传 `'instance'`）——**没有真机点**，因为会弹资源管理器窗口 |

★★ 本轮发现的一个**通用手法**（写下来给后面用）：启动器支持
`IEML_DATA_DIR`（游戏根目录）与 `IEML_OWN_DIR`（启动器自己的目录）两个环境变量，
**两个都指到 `%TEMP%` 下的沙盒就能把整个启动器关起来跑** ——
于是"删实例""删根目录"这种**破坏性流程可以在完全不碰用户数据的前提下真机复现**。
A-3 就是这么验的（`tools/live/probe-bug-repro-4.mjs`）。

---

## 一、严重（用户会直接撞上，且界面上说的与事实相反）

### A-0　★★ **全应用的"确认框"都是摆设**（14 处，一个都不会问、也不会拦）【真机 + 根因已定位】

**现象**：删实例 / 删游戏根目录（两道确认）/ 清缓存 / 删 Mod …… 所有"确定要删除吗？"
**一个框都不弹，点了就直接删**。

**根因（三段，逐段都有证据）**：

1. `tauri-plugin-dialog` 在窗口创建时注入了一段脚本（`tauri-plugin-dialog-2.7.3/src/init-iife.js`）：

   ```js
   window.confirm = async function (i) { return await n("plugin:dialog|confirm", { message: i.toString() }) };
   window.alert   = function (i) { n("plugin:dialog|message", { message: i.toString() }) };   // 不 await，同样不阻塞
   ```

   → `window.confirm()` **永远返回一个 Promise**，不是布尔。
2. 前端 14 处全部按**同步**写法用它：`if (!confirm(msg)) return;` ——
   `!Promise` 恒为 `false` ⇒ **守卫永远放行**（"点了取消"这件事在语法上就不可能发生）。
3. 而 `plugin:dialog|confirm` 这条命令**没被授权**：
   * 本机 `tauri-plugin-dialog-2.7.3/permissions/default.toml`：`permissions = ["allow-message", "allow-save", "allow-open"]`
     —— **没有 `allow-confirm`**；
   * 应用只授了 `dialog:default`（`src-tauri/capabilities/default.json`）。
   ⇒ 那个 Promise 直接以 `Command plugin:dialog|confirm not allowed by ACL` **失败**，框也不会出现。

**真机证据**（真实配置，不设任何沙盒变量）：

| 观察 | 结果 |
|---|---|
| `confirm('…')` 的返回值 | `[object Promise]`，耗时 **0ms**（不阻塞） |
| `await confirm('…')` | `Uncaught (in promise)` —— 被 ACL 拒绝 |
| 守卫写法 `!confirm('…')` 的结果 | 返回一个 Promise（真值）⇒ **放行** |
| 沙盒里走完整删除流程 | 两个"确认框" **0 个事件**，记录照样被删、还弹了「已永久删除」 |

**受影响的 14 处**（按危险程度）：

| 位置 | 它本该拦住什么 |
|---|---|
| `DataRootPicker.tsx:140` + `:146` | **删掉整个游戏根目录**（两道确认！）—— 而 `instances.json`/`prefs.json` 就住在那里（见 A-4），所以**一次误点 = 实例清单 + 全部设置一起没，且没有任何提示** |
| `VersionsPage.tsx:768` / `:786` | 删实例（连存档）/ 回收站失败后改永久删除 |
| `InstanceSetup.tsx:284` / `:300` / `:783` | 同上（实例设置页的三处） |
| `InstanceOverview.tsx:418` / `:437` | 同上（概览页） |
| `ModsPanel.tsx:500` / `:507` | 删 Mod（连"永久删除"那条） |
| `SettingsPage.tsx:531` | 清理缓存（几百上千个文件） |
| `SettingsPage.tsx:670` / `:688` | 删游戏根目录（设置页那一路） |

**复现**：`node tools/live/probe-confirm-acl.mjs`（只调一次 `confirm`，看返回值与耗时）。

**修法方向**（两条都得做，缺一不可）：
* 授权：`capabilities/default.json` 加 `dialog:allow-confirm`
  —— 但这只让**框弹出来**，第 2 条的"同步写法"还在；
* 调用点：`confirm()` 是 async，必须 `await` 或换成**应用自绘的确认弹窗**
  （同步 API 才能配 `if (!ok) return;` 这种写法）。★ 换句话说：
  **光加权限不够 —— 用户点了"取消"仍然会被当成"确定"。**

---
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

**✅ 已修（2026-09-24，第三批）**：监听器从 `LaunchPage`（只在启动页挂载）搬到
**常驻的 `AppShell`**，收到事件后 `setLaunchTarget(id)` → 切到启动页 →
轮询等 `#ieml-launch-btn` 出现再点它（最多 2 秒）。启动页里那份监听器**已删**
（留着会变成"两个监听者各启动一次"）。

真机判据（`tools/live/probe-a1-fixed.mjs`，debug exe）：

```
① 版本列表页上 ieml:launch-request 监听器 = 1          ← 修之前是 0
② 点了行菜单的「启动」=true；页="启动" 文本里含实例名=true
③ 沙盒启动日志：["probe-a1-1790188125.log"]   沙盒 java 进程数 = 1
④ 指向真实根 D:\IEML 的 java = 0
```

★ 这条探针原来的判据 ③ 是「沙盒里没有游戏文件 ⇒ 必然失败 ⇒ 出现失败提示就是流程跑通了」——
**前提不成立**：实测缺文件时启动流程会先下载（约 208 MB）**再真的把游戏跑起来**
（沙盒里留下了 `logs/probe-a1-*.log`、`natives/*.dll` 和活着的 java 进程）。
判据已改成"三类证据任一 + 安全判据（没有 java 指向真实根）"。

---

### A-2　纯原版实例的 OptiFine / LiteLoader：装了、报"已装好"，启动时**完全不用**【真机（沙盒）+ 代码】

**现象**：勾高清修复 → 弹「OptiFine 已装好」→ 启动进游戏，OptiFine 没生效；
而版本列表 / 概览 / 启动页仍然挂着「OptiFine」角标。

**真机复现**（`tools/live/probe-bug-repro-6.mjs`，全程在 `%TEMP%` 沙盒里）：
在沙盒里建**两条只差 `addons` 的实例记录**（同 mc 1.12.2、同加载器、一个无附加组件、
一个 `addons: [optifine]`），游戏文件用**目录联接**只读借用真实那份，
然后用启动页的「预览命令」分别看两条记录的命令行 ——
`preview_launch` 与 `launch_minecraft` 走的是**同一个** `prepare_spec`，所以预览一样就等于启动一样。

```
两次选中的实例（页头）：A="探针·无附加组件"  B="探针·带OptiFine"
两次确实选中了不同实例：是
两条记录的命令行（抹掉实例名后）逐字相同：是
命令行里出现 OptiFine / tweakClass：否
★★ 实例记录里的 OptiFine 对启动规格没有任何影响
```

**代码侧的机制**（三处对得上）：
* `LaunchRequest`（`commands_real.rs:2815-2845`）字段里**没有 addons** —— 附加组件根本没传到启动侧；
* `resolve_loader_version_id`（`:3130-3139`）：`loader_kind` 为空时 **直接 `return Some(mc_version)`**
  → 读的是 `versions/<mc>/<mc>.json`（原版 JSON），而 OptiFine 的产物在 `versions/<mc>-OptiFine_*/`；
* 启动闸（`:3455-3466`）只把 OptiFine 从"冒犯项"里**排除**（注释写着"纯原版 + OptiFine 是合法用法"），
  但**没有任何代码去用它**。

**影响**：这是一条"承诺 vs 现实"的正面冲突（ADR-041 那一类）。装上、报成功、角标都在，
而游戏里没有 OptiFine —— 用户无法从界面上看出来。

---

### A-3　「已永久删除」，磁盘上一个字节都没删【真机（沙盒）】

**现象**：删实例时第一次没删成（这里用"文件被独占占用"制造）→ 按提示确认"永久删除"
→ 弹「已永久删除」，但 `instances/<slug>/` **还在盘上**，而记录已经没了，
再没有入口能删它。

**判据（代码）**：`AppContext.removeInstance`（`:1062-1068`）：

```ts
const inst = instancesRef.current.find((i) => i.id === id);
dispatch({ type: 'instances/remove', id });   // ← 记录先删掉了
if (!inst) return 0;                          // ← 第二次调用时 inst 已经是 undefined
```

调用方（`VersionsPage.tsx:786-790`）在重试分支里 `.then(() => toast('warning','已永久删除', …))`
**无条件报成功**（成功分支会按 `bytes > 0` 分两种说法，重试分支没有）。

**真机复现**（`tools/live/probe-bug-repro-4.mjs`，全程在 `%TEMP%` 沙盒里，不碰用户数据）：

```
沙盒：%TEMP%\ieml-sbx-root + \ieml-sbx-own
  实例目录里放一个被独占打开的文件（让"移入回收站"必然失败）
删除前：{"行数":1,"第一行":"IEML 探针实例 1.12.2 原版 2 GB"}
  ⋯ 菜单：["打开设置","启动","重命名","创建副本","打开目录","删除"]
  弹出的原生确认框：[]                     ← 注意：一个都没弹（见 A-0）
删除后：{"行数":0,"提示条":["已永久删除IEML 探针实例"]}
  磁盘上 instances/probe-bug/ 还在吗：true
```

**影响**：用户以为删干净了，其实留了一份带存档的目录在磁盘上，且无法从界面清理。
★ 这条与 A-0 是**叠加**的：那两句"确认"本来就是摆设，所以这条重试路径
（"回收站不可用 → 改永久删除吗？"）在用户那里是**无声地自动走完**的。

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

**✅ 已修（2026-09-24，第四批）**：`instances.json` / `prefs.json` /
`ms_client_id.txt` / `cf_api_key.txt` 四个文件全部搬进**启动器自己的家**
（`own_root` = `%APPDATA%\IEML`）。写只写新位置；读优先新位置、没有才回退游戏根目录
（老用户升级当次就读得到）；启动时 `platform::adopt_records()` 做一次性收养 ——
**只复制、绝不删源**，目标不比源旧就不动它，真要覆盖先备份 `.bak`。

真机证据（**桌面那份发行版 exe**，真实数据）：

| 文件 | 启动前 | 启动后 |
|---|---|---|
| `D:\IEML\instances.json` | 17:25:15（3 个实例） | **17:25:15（一动没动）** |
| `D:\IEML\prefs.json` | 17:25:15（theme daiqing） | **17:25:15（一动没动）** |
| `%APPDATA%\IEML\instances.json` | 09-13 16:00（陈旧副本） | 19:13:22（**活的那份**） |
| `%APPDATA%\IEML\prefs.json` | 09-13 16:00（theme **dark**） | 19:13:22（theme **daiqing**） |
| `%APPDATA%\IEML\prefs.json.bak` | （不在） | 09-13 16:00（旧的**没丢**） |

沙盒判据（`tools/live/probe-a4-fixed.mjs`，五条全绿）：收养进 own_root /
偏好跟着走 / **老位置 mtime 未变** / **把整个游戏根目录删掉后重启，实例清单还在** /
删完设置也还在。

★ 顺带修掉两处**同类的假承诺**：
* 「删除游戏根目录」的第一道确认里现在写明「**不会**动到：启动器的实例清单、设置、
  登录用的 client_id、CurseForge Key」—— 以前一个字都没提；
* `lib.rs` 里那段"这些还住在游戏根目录里、整体搬迁要等用户同意"的**陈旧注释**已更正
  （用户 09-23 就同意了，只剩这四个文件没走完）。

---

### A-5　★★ **实例级的 7 个设置存不进磁盘**：Rust 的 `InstanceConfig` 比前端少 7 个字段【真机 + 代码】

**现象**：在实例设置页填了这些，**重启就没了**；其中「启动后自动进入服务器」**当场就不生效**：
* 启动后自动进服（`joinServer`）
* 指定 Java 路径（`javaPath`）、Java 区间（`javaRange`）
* 实例级 JVM 参数（`jvmArgs`）、游戏参数（`gameArgs`）
* 窗口标题覆盖（`windowTitle`）、自定义信息（`customInfo`）

**真机证据（就是上一节 B-4 那次沙盒实验顺手撞出来的）**：
沙盒实例的配置里明明写着 `joinServer: "1.2.3.4:abc"`，
而启动页「预览命令」的命令行里**既没有 `--server` 也没有 `--port`** ——
也就是这个值**根本没传到启动侧**。而 `redact_command` 不截断、预览弹窗也是整段渲染
（`LaunchPage.tsx:799 {preview.command}`），所以不是显示问题。

**代码证据（两份结构体字段数不一样）**：

| | 字段 |
|---|---|
| 前端 `src/domain/types.ts:85-116` | name · slug · isolation · memoryMb · memorySource · javaMode · **javaRange** · **javaPath** · **windowTitle** · **joinServer** · **customInfo** · **jvmArgs** · **gameArgs**（13 个） |
| Rust `src-tauri/src/domain/types.rs:245-253` | name · slug · isolation · memory_mb · memory_source · java_mode（**6 个**） |

**机制**：实例清单的**读写都要经过 Rust**（`save_instances` / `list_instances`，
`commands.rs:471/515`），而 serde **默认丢弃结构体里没有的字段** ——
于是前端那 7 个字段在**存盘那一刻就没了**，重启后自然读不回来。
界面上"填了、看着在"是因为内存里的 React state 还留着，**一重启就现原形**。

**影响**：7 条设置全是"能填、能保存、看着生效、实际不生效（或重启即失）"。
其中「启动后自动进服」是 PCL 同款能力、界面上有专门一栏，**从来没有工作过**。

**复现**：`node tools/live/probe-bug-repro-13.mjs`（沙盒 + 目录联接）：

```
启动前：键 13 个，mtime=17:42:14
启动后：键  6 个，mtime=17:42:18      ← 那次自动回写真的发生了，7 个字段全丢
界面：实例在列表里、名字正常（"探针·七字段"）
预览：含 --server：否   含 --demo：否   含 UseG1GC：否
```

机制链条（每一环都验过）：
1. `AppContext.tsx:675-680`：**读到实例列表之后 250ms 会 `saveInstances(...)` 回写一遍** ——
   所以**光启动一次就够**（不需要用户点任何东西）；
2. 回写要过 Rust（`save_instances` / `instances.json`），而 Rust 的 `InstanceConfig`
   只有 6 个字段、serde 默认丢弃未知字段 ⇒ 文件里那 7 个键当场消失；
3. 前端从此拿不到它们 ⇒ `join_server` 是 `null` ⇒ **启动参数里没有 `--server`**（预览实测）。

★★ **这条差点被我漏报**（值得记下来）：第一次做这个实验（`probe-12`）时我没建
`.minecraft/versions` 的目录联接，应用没走到"读到实例 → 回写"这条正常路径，
于是**文件一个键都没少** —— 我据此写了"字段没丢"。补上联接、让实例真的可用之后，
4 秒内 7 个字段全没了。**同一个实验，差一个前置条件，结论正好相反。**

---

## 二、高

### B-1　Mod 更新说「N 个 Mod 已替换为新版本」，旧 jar 一个都没删【真机（机制级）】(见第 2–3 轮升级表)

`ModsPanel.applyUpdates` 只调 `api.modrinth.installMod` → `install_mod`
（`commands_real.rs:1813-1836`）＝ `create_dir_all` + `download_one`，
**没有 remove_file / 替换逻辑**（我把函数体逐行看过，只有这两个文件操作）。
Modrinth 每次的 `filename` 通常带版本号 → 旧 jar 留着 → **同一个 Mod 两份**，
游戏可能同时加载，而界面说"已替换"。

**✅ 已修（2026-09-24，第七批）**：`applyUpdates` 装完新文件之后**删掉旧的那一份**，
判据收成一处纯函数 `domain/mods.ts::oldFilesToDrop()`，且刻意收得很窄：

* 只认**同一个 sha1** 的文件（sha1 就是"这次要更新的旧文件"的身份，来自在线库反查）；
* **新文件名与旧文件同名 → 不删**（`installMod` 会覆盖它，这时去删就等于删掉刚下的新文件）；
* 不用 displayName / 前缀相似度去猜 —— 那种猜会误删用户手放的其它版本；
* 空 sha1 = "不知道要更新谁" → **一个都不删**（宁可留旧文件）；
* 删除走**系统回收站**（`deleteMods(..., permanent=false)`），判据错了还能捞回来。

单测三条（`tests/domain.test.js`，跟着既有「领域单元测试」门禁跑）。
★ **诚实说明**：这一条的**端到端真机复现仍然没做到** —— 它需要"同一 Mod 两个版本、
版本号与实例对得上、且文件没被作者禁止第三方下载"，我第 2/3 轮试过两次都卡在最后一步
（见第七节）。现在验到的是：**判据（哪些该删）有单测**、**删除动作复用已在用的
`deleteMods`（默认回收站）**。要真正走完一次"更新旧版本"，还得挑一个合适的 Mod。

### B-2　检查更新失败时，关于页写「已是最新版本」【代码】

`AboutPage.tsx:61-69` 的三元链只处理 `unsupported / available / ready / checking`，
**其余全部落到 `'已是最新版本'`** —— 包括 `'error'`（断网 / 404 / 签名失败）。
`useLauncherUpdate` 已经把错误翻成中文写进 `state.error`，但**没有任何地方显示它**
（`UpdateChip` 在 `error` 时直接 `return null`）。
→ 用户断网点「检查更新」，界面告诉他一个**假事实**。

**✅ 已修（2026-09-24，第五批）**：状态→人话的映射搬进 `domain/update-copy.ts`（只有一处），
**只有 `uptodate` 允许说「已是最新版本」**；`error` 必须带出原因并标红；
认不出的状态如实报出名字。这条映射进了门禁（`tools/verify.mjs` 第 22 项
「更新状态文案」，`tests/update-copy.test.mjs`）。

真机证据（`tools/live/probe-b2-fixed.mjs`）：

```
① 刚进关于页："还没检查过更新"                ← 以前这里是「已是最新版本」（假的）
② 点过「检查更新」："已是最新版本"              ← 这台机器网络通，确实是最新（真的）
③ HTTPS_PROXY 指到死端口再跑：
   "检查更新失败：error sending request for url (https://cnb.cool/…/latest.json)"（标红）
```

★ 第三步顺带抓到**第二个问题**：`describeUpdateError` 的词表漏了 reqwest 最外层那句
`error sending request for url (…)`（connect/network/socket/dns/timeout 一个都不含），
所以断网用户看到的是一句**纯英文**。这条函数也搬进 domain 并补上实测串（有测试钉住）。

### B-3　Quilt 自动装 QFAPI：违背用户 2026-09-15 的明确决定【真机 + 代码】

* 用户决定（`CHANGELOG.md:2470` 原话）：「**不给 Quilt 装 API 了**」→
  Rust `api_for_base` 对 Quilt `return vec![]`，测试改成 `quilt_gets_no_api_library`，
  还写着「**规则仍只有一处**」。
* 而**活的那一侧**（TS）仍是：`loader-caps.ts:709` `base === 'quilt' ? 'quilted-fabric-api' : 'fabric-api'`
  → `combination.ts` 放进 `autoApis` → `InstallComposer.tsx:899-902` **真的调
  `install_api_library(..., 'quilt')`**。
* **【真机】（第 2 轮）**：安装页选 `1.20.1` → 点 Quilt 之后，页面上出现

  > **将自动安装** — Quilted Fabric API `7.4.0+0.92.2`｜已内含 Fabric API，同时支持 Fabric 与 Quilt Mod｜3 MB
  > 「安装前请确认：将自动安装 Quilted Fabric API 7.4.0+0.92.2（已内含 Fabric API，同时支持 Fabric 与 Quilt Mod）」

  底栏是「1.20.1 · Quilt 0.23.0 · 约下载 47 MB …」，安装按钮可点 —— 也就是说
  **点下去真的会装这个用户明确不要的包**。
* 两条测试互相钉着相反的结论（TS `tests/domain.test.js` 断言 QFAPI；Rust 断言空）。

**影响**：建一个 Quilt 实例会往 mods/ 里多塞一个用户明确不要的 QFAPI。

**✅ 已修（2026-09-24，第五批）**：TS 侧 `apiForBase` 改成 `if (base !== 'fabric') return []`
（依据写在注释里：用户决定 + Rust 侧早就是 `vec![]`）；`tests/domain.test.js` 那条断言
**反过来**，并加一条"警告里也不许承诺会自动装 QFAPI"。
★ `apiLibrariesFor` 仍把两个包都列出来 —— 那是"这个版本**可能**需要的 API 包"能力表，
不是"我会替你装什么"，两件事不能混。

真机证据（`probe-bug-repro-1.mjs` ② 段，debug exe）：

```
点了版本行 "1.20.1" → 点了 Quilt {found:true, disabled:false}
blocks: [{模组加载器四选一}, {附加组件 OptiFine 清单来自在线}]   ← 「将自动安装」整块没了
底栏: "1.20.1 · Quilt 0.31.0-beta.4 · 约下载 47 MB · 可复用 398 MB … 安装 Minecraft 1.20.1 + Quilt 0.31.0-beta.4"
```

### B-4　服务器地址端口写坏时，界面说的和启动器做的**相反**【代码 + 真机看到那句文案】

* 界面（`server-address.ts:130`，实测在实例设置页输入 `1.2.3.4:abc` 时页面里确实出现这句话）：
  「端口「abc」不是数字。**地址会原样传给游戏，不会自动改成默认端口**。」
* 真实行为（`launch_args.rs:356-363` + `:632-638`）：端口解析失败 → `port: None`
  → **只传 `--server host`，端口交给游戏用默认 25565**。
* 同一页面的注释（`InstanceSetup.tsx:830-831`）与 Rust 注释写的都是"只丢端口、连默认端口"。

**影响**：用户以为会报错，实际启动器把端口丢了、连上了 25565 —— 可能落到**另一个服务器**上，
而这正是这句提示想避免的事。

**✅ 已修（2026-09-24，第五批）**：两处端口错误（非数字 / 超范围）都改成说清真实行为：
「这个端口会被丢掉，启动器只把主机名「host」传给游戏（--server host），端口由游戏用
默认的 25565。想连指定端口，请把端口写成数字（例如 host:25565）。」

真机证据（`probe-server-hint.mjs`，debug exe，逐字）：

```
警告行原文："端口「abc」不是数字 —— 这个端口会被丢掉，启动器只把主机名「1.2.3.4」传给游戏
            （--server 1.2.3.4），端口由游戏用默认的 25565。想连指定端口，请把端口写成数字
            （例如 1.2.3.4:25565）。只用主机名 1.2.3.4"
全页含"原样传给游戏": false      全页含"端口会被丢掉": true
```

★ 测试也改了（`tests/server-address.test.mjs`）：断言「端口会被丢掉」+「25565」+「写成数字」，
并**显式断言那句假话不许再出现**。

---

## 三、中

| # | 现象 | 判据 | 等级 |
|---|---|---|---|
| C-1 | CurseForge 那一半是**假的**：搜是 CF 的数据，版本/安装走的是 **Modrinth** 的接口 | **【真机】**（第 2 轮）：选一个 CF 独有的包（RLCraft）→ 安装页「来自 Modrinth」+「这个整合包没有可下载的版本 / 上游没有给它发布任何文件」；两边都有的包（Fabulously Optimized）能出 472 个版本 —— 那是 Modrinth 的版本，不是 CF 的。页面自己还写着「包里的 **modrinth.index.json** 定死」。代码侧：两处仍走 `api.modrinth.versions(...)`（`DownloadPage.tsx:559-562`、`ResourceInstallPage.tsx:48`），CF 命中的 `project_id` 是 CF 数字 id；后端已有 source-aware 的 `resource_versions` 没用它 |
| C-2 | 「mods 目录」按钮打开的是**实例根目录** | 标签/title 写「打开这个实例的 mods 目录（game\mods）」，实参却是 `openDir('instance', slug)`；Rust 有 `"mods"` 分支且 `CrashModal` 用的就是它 | 【代码】 |
| C-3 | 「也可以把 .jar 文件直接拖进窗口。」——**没有任何拖放实现** | `onDrop/onDragOver/dataTransfer/onDragDropEvent` 在 `src` 里 **0 命中**，而 `tauri.conf.json` 是 `dragDropEnabled: true`（原生拖放被接管，没 JS 监听就等于什么都不做） | 【代码】 |
| C-4 | 版本列表底部「这些版本还没有游戏文件 / 起不来」是**假警报** | 判据是 `MC_PROFILES` 那 10 个内置版本的静态表 ∩ 实例的 mcVersion，**不读盘**；装 1.21.4 能跑，列表仍挂着这句 | 【代码】 |
| C-5 | 整合包安装页「点哪个装哪个」不成立 | `onPick` 里 `setPickedVersion(v)` 之后 `setTimeout(install, 0)` 捕获的是**本次渲染**的闭包，`pickedVersion` 仍是 `null` → 回退到"列表第一个" | 【代码】→ ✅ **已修（第八批）**：版本改成**当参数**传进 `install(v)`；真机差分判据见 `probe-c5-fixed.mjs`（点 alpha.1 / alpha.2 → 实际去装的是各自那个版本，缺陷版本下两者会是同一个） |
| C-6 | Fabric API 前置包判定有**两套文件名名单** | `commands_real.rs:2110-2115`（fabric → `fabric-api`/`fabric_api`，`contains`）vs `modrinth.rs:507-513`（4 个前缀，`starts_with`，限 `mods/*.jar`）。→ Quilt 整合包只带 `fabric-api-…jar` 时会被判"缺 QFAPI"并再装一个（正是 `modrinth.rs:486-493` 注释警告的"两个 API 实现"） | 【代码】 |
| C-7 | 侧栏「最近玩过」**永不出现** | 判据依赖 `lastPlayedAt`，而 Tauri 路径**没有任何写入方**（新建/复制/整合包建实例都写 `null`；`AppContext.tsx:748-758` 注释明说"不再写"） | 【代码】 |
| C-8 | 崩溃规则表**两份**：TS 36 条 / Rust 35 条，id 与正则都漂移（`out-of-memory-heap` vs `oom-heap` …） | 弹窗走 TS（并显示「查了 36 条日志特征」）；Rust 那份是死路径，但**有测试钉着它** | 【代码】 |
| C-9 | Rust 侧仍写着「LiteLoader 的自动安装 IEML 还没有做」 | `combination.rs:257` 无条件报"装不了"，测试 `unimplemented_addon_is_never_reported_as_installable` 钉着它；而 `loader_caps.rs:238` 同一份代码里写 `=> true`，且 `net::liteloader` 真的实现了 | 【代码】 |

> C-8 / C-9 的用户可见影响**今天为 0**：`src/bridge/tauri.ts` 里那套 `rust.*` 命令
> （capabilities / validate / autoMemory / isolation / analyzeCrash / redact）
> **全仓库 0 处调用**（我验过）。但它们是"代码里写着假话 + 测试钉着假话"，
> 属于同一类缺陷，且下次谁去接这套命令就会踩。

---

## 三·补　C-2 / C-3 / C-4 / C-6 / C-7 的**修复记录**（2026-09-24，第六批）

| 条目 | 修法 | 真机/单测判据 |
|---|---|---|
| C-2 | 前端改传 `'mods'`；Rust 把"路径怎么算"抽成纯函数 `resolve_open_dir()`（打开动作会弹资源管理器，只有拆开才能单测） | 两条 Rust 测试：`mods ≠ instance`、各分支互不相同 |
| C-3 | **删掉**「也可以把 .jar 文件直接拖进窗口」这句承诺，改指真的存在的那条路（「mods 目录」按钮）。**没有**去实现拖放 —— 那是新功能 | 前端产物里 `拖进窗口` 0 命中；拖放监听器仍为 0（现在界面也不再承诺它） |
| C-4 | 删掉 `installedCount`（内置 10 版本表的假判据），改成读盘的 `allRowsMissing`（复用 `instanceHealth()`） | 实例 26.3 + 磁盘上真有 `versions/26.3` → 「含"还没有游戏文件"」=**false**（修前是 true） |
| C-6 | 两套文件名名单收成一处 `domain::mods::api_library_from_filename()`；`check_api_library` 增加 `foundKind` | Quilt 实例 + `fabric-api-0.92.2+1.20.1.jar` → 「缺 Quilted Fabric API」=**false**、「一键补装」=**false** |
| C-7 | 删掉永不渲染的「最近玩过」块 + 对应 CSS。**没有**去恢复 `lastPlayedAt` 的写入（用户 2026-09-16 明确删掉了记录游玩时间的功能） | `.side-recent`=0、侧栏文本无「最近玩过」 |

顺带修掉的廉价低项：**C-16**（设置页 title 的「候选盘会列出来」→ 改成真的存在的
「会列出你用过的那些目录」）、**C-17**（安装页 `installNote` 写死 null → 从后端
`resource_kinds` 的 `install_note` 取，"还有一步"通路终于会触发）、**C-18**（「来自 Modrinth」
写死 → 跟着来源走）、**C-19**（「稍后在下载页重试」指向不存在的入口 → 改成真的能走的路）、
**C-22**（派发 `message` / 监听读 `desc` → 统一成 `desc`，那句话终于会显示）、
**C-26**（用户取消却弹红色「安装失败」→ 判据收进 `domain/cancel.ts`，取消就是"已取消安装"）。

★ C-19 我第一次改的时候也写错了一版（写成"版本设置页 → 附加组件那一栏"，而那里并没有这一栏）——
**改文案同样要核对真实入口**，否则只是把一句假话换成另一句假话。这一条已写进 ADR 六十七。

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
  → ✅ **已修（第六批）**：title 改成与实际行为一致（「整份复制到新实例（会占一份空间）」）——
  行为本身是对的（副本就该是副本），错的是按钮上那句话。
* 死导出与死 CSS 成块存在（`rust` 对象、`flows/install.ts` 5 个导出、`.vi-top/.vi-left/.vi-right` 等 20 余组）。
  → 部分已随 C-7 清理（`.side-recent*` / `.sri-*` 那一组）；其余**没动**（不是缺陷，是整理活）。

---

## 四·补　探针隔离的一个陷阱（第六批验证时发现，值得单独记）

**只设 `IEML_DATA_DIR` / `IEML_OWN_DIR` 并不能把沙盒隔干净。**

启动时那段"数据根目录补齐"（`platform::migrate_data_root`）会拿**真实的**
`%APPDATA%\IEML` 当源，把 `instances.json` / `prefs.json` 与实例/缓存目录
往新根目录**复制一份**。实测：一个**空**沙盒启动后，界面里出现了真实的 3 个实例，
沙盒 `ROOT` 与 `OWN` 里凭空长出 `instances.json` / `prefs.json` / `cache` / `instances` / `java` / `logs`。

* **不会丢数据**：那段逻辑只复制、从不覆盖目标已有的内容（有种子实例时判据不成立）。
  真机复核：`D:\IEML\{instances,prefs}.json` 的 mtime 全程未变，
  `%APPDATA%\IEML` 三份数据与 `.bak` 都在，实例名一致。
* **但会让"沙盒里只有我造的东西"这个前提不成立** ——
  我的几条探针都先塞了种子实例（所以结论没受影响：`probe-a4-fixed` 显示的就是那 2 个探针实例），
  可**空沙盒的探针会看到真实实例列表**。
* **正确做法**：把 `APPDATA` 也指到沙盒里 —— `dirs_data_dir()` 读的就是它，
  于是"老位置"也在沙盒内。`probe-a4-fixed.mjs` 已按这个改，改后空沙盒里再也看不到真实实例（实测通过）。

★ 这条写下来是因为它属于**验证方法本身**的缺陷：判据看起来全绿，
但绿的理由可能是"它读到了不该读到的真实数据"。

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
| `tools/live/probe-bug-repro-1.mjs` | ① 启动预览命令行 ② Quilt 的「将自动安装」 |
| `tools/live/probe-bug-repro-2.mjs` | 整合包切 CurseForge 之后点开一张卡 |
| `tools/live/probe-bug-repro-3.mjs` | CF 独有包 vs 两边都有的包（C-1 的判据） |
| `tools/live/probe-bug-repro-4.mjs` | **沙盒里真删一个实例**（A-3：说"已永久删除"、目录还在） |
| `tools/live/probe-bug-repro-5.mjs` | 删除流程 + 每个 CDP 事件带时间戳（用来对上"到底弹没弹框"） |
| `tools/live/probe-confirm-acl.mjs` | `confirm()` 的返回值/耗时（A-0 的判据，真实配置下跑） |
| `tools/live/probe-native-dialogs.mjs` | `confirm` / `alert` / `prompt` 三者的行为对照 |
| `tools/live/probe-bug-repro-6.mjs` | **沙盒里对比"只差 addons 的两条记录"的启动命令行**（A-2：OptiFine 勾了也白勾） |
| `tools/live/probe-bug-repro-7.mjs` | 沙盒里给探针实例连装同一 Mod 的两个版本，数 mods/ 里的 jar（B-1，**还没跑通**：见第七节） |
| `tools/live/probe-instance-root.mjs` | **真机数据**上对照旧发布版/新构建：实例目录落在 C 盘还是用户挑的游戏盘（8f）；顺带验"实例设置跟不跟着走" |
| `tools/live/probe-manifest-location.mjs` | 沙盒里 own 那份两条、root 那份一条**且不同**：`instance_health` 读的是哪一份清单（8g） |
| `tools/live/probe-own-root-move.mjs` | 真实数据上验"启动器自己的家"搬到了哪：记录文件、账本与界面互证、原样存回偏好证明写入落点（8h） |
| `tools/live/probe-page-scroll-top.mjs` | 换页是否滚回顶部（8i）：长页↔长页的红绿对照 + "同一屏内不重置"的反面 |
| `tools/live/probe-versions-page-dir.mjs` | 真实数据上按用户原动作走「版本列表 → ⋯ → 打开目录」，读 toast 里的路径并核对资源管理器窗口（8f 的端到端判据） |
| `tools/live/probe-changelog-format.mjs` | 「更新日志」页渲染出来是不是那个五段格式（8j）：五段有序、每条带类别词、最新一版是 rc.4，并留一张截图 |

跑法：`node tools/live/<脚本>.mjs ["<exe>"]`（默认用 `src-tauri/target/release/ieml.exe`，
可以传桌面那份 exe）。

---

## 七、本轮**没能**真机复现的条目（连同原因，不装样子）

| 条目 | 要复现需要什么 | 我为什么没做 |
|---|---|---|
| B-1 Mod 更新不删旧 jar | 装一个 Mod，等它有新版本，点「更新」 | 会真的往实例 mods/ 里写文件；`install_mod` 只有 `create_dir_all` + `download_one`（我逐行看过，没有任何 remove/rename）。★ **试过两次**（`probe-bug-repro-7.mjs`，沙盒里给一个 1.20.1+Fabric 的探针实例连装同一 Mod 的两个版本）：第一次选择器点错元素（卡片本身没有 onClick，按钮在卡片脚上）；第二次进到了安装页，但**点中的那行是 `blocked` 的**（版本不匹配/作者不允许第三方下载），`onClick` 直接 return，所以 mods/ 里没文件。**还差一步**：挑一个"版本号与 1.20.1 + Fabric 对得上、且没被 blocked"的 Mod（或者把探针实例改成 26.4 + Fabric）—— 下一轮补 |
| C-2「mods 目录」按钮 | 点一下，看资源管理器打开的是哪个目录 | 会在你桌面上弹出窗口。**已按另一条路验完（第六批）**：前端改传 `'mods'`；Rust 把"路径怎么算"抽成纯函数 `resolve_open_dir()`，两条单测断言 `mods ≠ instance` 且各分支互不相同。**没有**真的点那一按钮（不想在你桌面上弹窗口） |

★ 两次失败的探针本身也留下两条经验（写下来省得下次再踩）：
* 资源卡片**本身没有 onClick** —— 入口是卡片脚上那个「选择版本并安装」按钮；
* 判"列表有没有数据"要用**确切的类名**（`.res-card`）。
  我第一版用了一串松选择器，把版本 chips 也数成了"卡片"，
  于是"上游没数据"这种情况**没被识别出来**（本该干净跳过的却继续往下跑）。

★ 顺带一条**探针自己的坑**（写下来免得误导）：
第 2 轮的 CF 探针里，输入搜索词后我**立刻**去读卡片数，读到的还是上一批结果
（所以"RLCraft 的搜索结果第一张是 ATM10"是我读早了，**不是**产品的"搜索滞后"缺陷）。
要判"结果真的换了"，得像 `live-c3` 那样断言**结果集内容变了**，不能只断言"有卡片"。

---

## 八、第 2 / 3 轮证据（原始输出要点）

```
① 启动页「预览命令」（preview_launch 与 launch_minecraft 走同一个 prepare_spec）
   → 命令行里出现：-Djava.library.path=C:\Users\Administrator\AppData\Roaming\IEML\instances\vanilla-1122\natives
     （实例目录在 own_root —— 与 A-4 的"两处分裂"一致）
   磁盘上 1.12.2 的版本目录：1.12.2 / 1.12.2-forge-14.23.5.2864 / 1.12.2-LiteLoader（没有 OptiFine）

② 安装页 1.20.1 + Quilt →「将自动安装 Quilted Fabric API 7.4.0+0.92.2」+ 安装按钮可点   ← B-3

③ 整合包 · 来源 = CurseForge
   · 列表 20 张卡，标注「数据来自 CurseForge」
   · 点开 Fabulously Optimized → 出 472 个版本，但页面写「来自 Modrinth」
   · 点开 RLCraft（CF 独有）→ 「这个整合包没有可下载的版本：上游没有给它发布任何文件」
   · 点开 All the Mods 10 → 同上
   ← C-1 / C-12 / C-18

④ 版本列表页：ieml:launch-request 监听器 = 0；启动页 = 1；手动派发无任何反应；
   行菜单项 = ["打开设置","启动","重命名","创建副本","打开目录","删除"]；java 进程数 = 0   ← A-1

⑤ 沙盒里删一个探针实例（A-3）：
   ⋯ → 删除 → 「已永久删除」→ 记录消失 → instances/probe-bug/ **还在磁盘上**

⑥ confirm() 三段证据（A-0）：
   · 真实配置：返回 [object Promise]，0ms（不阻塞）
   · await 它：Uncaught (in promise) —— 被 ACL 拒绝
   · 守卫写法 !confirm(...)：得到真值 ⇒ 放行
   · 根因：tauri-plugin-dialog-2.7.3/src/init-iife.js 把 window.confirm 换成 async 包装；
     而该版本 permissions/default.toml 的 default 集是 ["allow-message","allow-save","allow-open"]
     —— 没有 allow-confirm，应用也只授了 dialog:default

⑦ A-2（沙盒 + 目录联接 + 两条只差 addons 的记录）：
   两次选中的实例（页头）：A="探针·无附加组件"  B="探针·带OptiFine"
   两条记录的命令行（抹掉实例名后）逐字相同：是；命令行里 OptiFine / tweakClass：否

⑧ B-1（沙盒里连装 Sodium 两个版本）：
   装第 1 次后 mods/ = ["sodium-neoforge-0.9.3-alpha.1+mc26.3.jar"]
   装第 2 次后 mods/ = ["sodium-fabric-0.9.3-alpha.1+mc26.3.jar", "sodium-neoforge-0.9.3-alpha.1+mc26.3.jar"]
   两次提示都是「已装好 Sodium … → <路径>」  ⇒ 旧文件没有被删

⑨ C-3 / C-4 / C-6 / C-7（同一条探针，沙盒 + 目录联接）：
   C-3 window/document/body 上的 drop|dragover|dragenter 监听器 = 0（window 其它事件 21 个）
   C-4 实例 26.3 + 磁盘上 versions/26.3 存在 → 仍显示「这些版本还没有游戏文件 起不来」
   C-6 Quilt 实例 + mods/fabric-api-0.92.2+1.20.1.jar →
       「缺 Quilted Fabric API —— 依赖它的 Mod 会加载失败」+「一键补装」
   C-7 有实例时 .side-recent = 0
   ★ 附带一条**探针自身的现象**（不是缺陷）：我那个假 jar 不是合法 zip，
     所以 Mod 列表显示「共 0 个 Mod」，而"缺 API"的判据只看文件名 —— 两处对同一个目录的看法不同。
     真 jar 不会这样，所以这条不算缺陷，只是提醒判据口径不同。
```

---

## 九、这轮之后，我建议的修复顺序（等你发话，不擅自改）

1. **A-0**（确认框全是摆设）—— 它是"所有删除动作的最后一道闸"，而且**一行授权 + 14 处调用点**就能修；修完再谈别的删除类缺陷才有意义。
2. **A-4**（`instances.json`/`prefs.json` 还在游戏根目录）—— 与 A-0 叠加 = 一次误点删掉整个根目录、实例与设置全没；要么把两个 JSON 搬进 `own_root`，要么在"删根目录"的确认里**明确写出会一起删掉什么**。
3. **A-3**（记录先删、目录没删却说"已永久删除"）—— 顺序改成"先删文件、成功后再删记录"。
4. **A-1**（三处「启动」按钮是死的）—— 要么把事件监听提到常驻层，要么直接调启动流程。
5. **B-2 / B-3 / B-4 / C-1**（界面说的和做的不一致）；**A-2**（OptiFine 承诺）要大一些，可以单独一轮。
