# PCL2 源码研读 · 第二轮：下载引擎与加载器实时状态

> 对象：`E:\PCL-main`（Meloong-Git/PCL，VB.NET，`Plain Craft Launcher 2.sln`）
> 本文只记**与 IEML 的差异**和**我们该学什么**，不重复第一轮已有的结论。
> 第一轮的 41 条采纳清单在 `LAUNCHER_SOURCE_STUDY.md` 第 14 章。

## 0. 一句话结论

PCL2 的下载引擎里有 **7 处设计是我们的实现在原理上缺失的**，
其中 **3 处直接对应你报过的那几个症状**（"下载慢得要死"、
"最后一个文件必定重试然后失败"、"在线清单查询太慢而且查不到"）。
本轮已把其中 4 处做进 IEML，另外 3 处记录在案并说明为什么先不做。

---

## 1. 下载引擎逐条对照

对照对象：`Modules/Base/ModNet.vb`（1933 行，整个下载引擎都在这一个文件里）。

### 1.1 ★★ "慢"与"死"是两件不同的事（已采纳）

**PCL2 的判据**（`Thread()` 的读循环里，ModNet.vb:1025）：

```vb
If Th.LastReceiveTime > 0 AndAlso DeltaTime > 5000 AndAlso
   DeltaTime > RealDataCount Then        ' 间隔 > 5 秒，且速度 < 1 B/ms（= 1 KB/s）
    Throw New TimeoutException("由于速度过慢断开链接……")
End If
```

注意 `DeltaTime > RealDataCount`：`DeltaTime` 单位是毫秒，`RealDataCount` 是字节 ——
这个不等式的物理含义就是 **"速度低于 1 KB/s"**。阈值低到几乎只抓"死连接"。

**我们的问题**：绝对地板是 `SLOW_ABS_FLOOR_BPS = 320 KB/s`，比它高 **320 倍**。
而本机实测：Modrinth CDN ~230 KB/s、mcimirror ~146 KB/s —— **全都低于 320 KB/s**，
于是正常速度被判成"坏源"，15 秒一到就断连重试，三轮烧完重试预算报
`所有下载源都失败了（试过 1 个）`。你看到的"最后一个文件必定重试然后失败"就是它。

**已采纳**（`src-tauri/src/net/download.rs`）：
* 新增 `SpeedWatch::dead(total, since_last_data)`：静默 ≥ **5 秒** 且这一窗
  吞吐 < **1 KB/s** 才算死（`DEAD_SILENCE` / `DEAD_MIN_BPS`，都照抄 PCL2 的数值）；
* **"死"与有没有备用地址无关**：一个字节都不回来的连接必须掐掉，否则白占并发槽位
  和 300 秒总超时预算；
* **"慢"仍然只在有别的路可走时才放弃**（上一轮加的 `switchable`，两者互补）。

### 1.2 ★★ 服务端宣告的文件大小必须校验（已采纳）

**PCL2 的判据**（ModNet.vb:964-971）：

```vb
ElseIf Th.DownloadStart > 0 AndAlso ContentLength >= FileSize Then
NotSupportRange:
    Throw New RangeNotSupportedException($"该下载源不支持分段下载：……")
ElseIf Not FileSize - Th.DownloadStart = ContentLength Then
    Throw New RangeNotSupportedException($"获取到的分段大小不一致：……")
End If
```

**我们缺的**：只校验了 `Content-Range` 的**起始偏移**，没校验**总大小**。
如果服务器上的文件被换掉了（整合包作者重传、CDN 回源到新版本），
把新文件的尾部拼到旧文件的头部上会得到一份**长度正确、内容错位**的文件，
最后只表现为"SHA1 校验失败"，然后整份重下。

**已采纳**：新增 `parse_content_range_total()`，续传/下载前比对
`Content-Range` 的总大小与任务记录的 `size`；不一致就清掉残留从头下，
并明确报出"服务端上的文件大小已变（记录 X 字节，实际 Y 字节）"。

### 1.3 ★★ 重试是"有意设计的三段式"，不是等间隔重试（待采纳）

**PCL2 的做法**（`NetRequestByClientRetry`，ModNet.vb:44-88）：

| 第几次 | 超时 | 说明 |
|---|---|---|
| 第 1 次 | **10 秒** | 正常尝试（快速失败：不行的源 10 秒就让位） |
| 第 2 次 | **30 秒** | 等 500ms 后"慢速重试"（给慢源一次机会） |
| 第 3 次 | **4 秒** | 只有当**前两次合计超过 5.5 秒**才做（快失败优先） |

另外两条细节：
* **403 / 404 立刻抛出**，不重试（和我们的 `is_definitely_absent` 同一个结论）；
* **429 先睡 10 秒**再重试（`Thread.Sleep(10000)`）—— 我们只退避 0.5s/1s。

**我们的现状**：`get_text` 是 3 次等间隔退避（0.4s / 0.8s），单次请求**没有整体超时**，
靠外层的 `loader_fetch_timeout()`（75 秒）兜。这解释了"在线清单查询太慢"：
一个不通的源要占满 75 秒才轮到下一个。

**为什么先不做**：改超时策略要同时动 `get_text` / `get_text_via` / `with_timeout`
三处，而"哪一段该用 10 秒、哪一段该用 30 秒"需要用真实网络测一遍才好定。
**下一轮做，并且要带实测数据**（冷启动 vs 热启动各自的耗时分布）。

### 1.4 大文件下载前校验磁盘空间（待采纳，实现很便宜）

**PCL2 的做法**（ModNet.vb:951-961）：文件 > 50 MB 时检查目标盘与缓存盘：

```vb
Dim RequiredSpace = If(PathTemp.StartsWithF(DriveName), ContentLength * 1.1, 0) +
                    If(LocalPath.StartsWithF(DriveName), ContentLength + 5 * 1024 * 1024, 0)
If RequiredSpace > 0 AndAlso Drive.TotalFreeSpace < RequiredSpace Then
    Throw New Exception(DriveName & " 盘空间不足，无法进行下载。" & …)
```

注意它算的是**两份**：下载缓存一份（×1.1）+ 最终文件一份（+5MB）。
我们的引擎会把整个客户端 jar 下到 `.part` 再改名 —— 同样是两份空间，
磁盘满了的报错会是"写入文件失败：os error 112"，用户完全看不懂。

### 1.5 单文件下载来源的策略：先"多线程可用源"，退到"单线程逐个源"（待采纳）

**PCL2 的两级来源模型**（ModNet.vb:596-627）：

```vb
''' 所有已经被标记为失败的，但未完整尝试过的，不允许断点续传的下载源。
Public SourcesOnce As New ConcurrentList(Of NetSource)
''' 仅当合并失败或首次下载失败时，会将所有下载源重新标记为不允许断点续传的下载源，
''' 逐个重新尝试下载。这一策略可以兼容多个下载源中的一部分返回错误的文件的情况，
''' 以及部分在多线程下载时会抽风的源。
Private Retried As Boolean = False
```

即：**第一次失败后，不是"再试一遍同样的多源分片"，而是把所有源降级成
"单线程、从零下、逐个试"**。这个降级是有道理的 —— 多源分片时不同源返回的
字节被拼在一起，只要其中一个源的内容有问题（返回了错误页面、
CDN 缓存了旧版本），整份文件就是坏的，而重试同样的做法只会再坏一次。

**我们的现状**：只有"候选源依次尝试"+ 单文件 3 轮重试，没有"降级成单源单线程"这一步。
我们默认关掉了分片，所以风险比 PCL2 小，但"多源拼接"这条路径仍然存在
（`IEML_CHUNKED=1` 时）。

### 1.6 合并失败要重试，并且**失败后删掉半成品**（部分已采纳）

**PCL2 的做法**（`Merge()`，ModNet.vb:1163-1247）：
* 合并本身重试 3 次，间隔 500ms × 次数（文件被占用是暂时的）；
* 合并失败 → **删掉 `LocalPath`**（半成品绝不能留着），再 `SourceFail(Th, ex, True)`
  触发下载源降级；
* 合并成功后**先校验再删临时文件**（顺序不能反，否则校验失败时连证据都没了）。

**我们的现状**：`.part` → 目标名的改名有"被占用"重试（`finish_file_with_retry`），
但**校验在改名之前**（这是更安全的顺序，比 PCL2 好），
而"校验失败 → 删掉目标文件"这一步有做（`remove_file(&part)`）。
**差异点**：合并/改名连续失败后我们直接抛出，没有"降级成单源重下"的兜底。

### 1.7 全局下载管理器：按实测速度**动态加线程**（待采纳，改动最大）

**PCL2 的 `NetManagerClass`**（ModNet.vb:1719-1795）：
* 两个管理线程（按 `Uuid Mod 2` 分工）每 20ms 扫一遍所有文件；
* **为等待中的文件起线程**，直到全局线程数上限（`NetTaskThreadLimit`）；
* 然后：**如果当前总速度低于"速度下限"，就为正在下载的文件追加线程**；
* "速度下限"是**动态**算出来的：`SpeedLast.Take(10).Average * 0.85`
  （近 1 秒平均速度的 85%，只会往上调，不会往下掉）；
* 追加线程时要求"准备中的线程数 ≤ 下载中的线程数"（避免开一堆都没数据的连接）；
* 每起一个 BMCLAPI 线程就 `Sleep(100)` —— **主动降低镜像的请求频率**（防 429）。

**它解决的是什么**：线程数是"按需"的，不是固定的。文件多时每个文件一个线程；
文件少（比如只有一个 39 MB 的客户端 jar）时**同一个文件能吃到很多线程**。

**我们的现状**：全局固定 concurrency（默认 64），单文件单连接。
一个 39 MB 的客户端 jar 只能用一个连接 —— 实测 BMCLAPI 单连接 0.83 MB/s。

**为什么先不做**：这是引擎级的重构（线程模型从"每文件一个任务"变成
"全局调度器 + 可追加线程的链表"），而且我们上一轮的实测结论是
**分片在这台机器上只快 16%**（瓶颈是镜像按 IP 的总带宽，不是单连接速度）。
所以它的收益不确定，风险却不小 —— 要做的话应该先做 1.3 和 1.4 这些便宜的。

### 1.8 其他值得记的细节

| PCL2 的做法 | 位置 | 我们的现状 |
|---|---|---|
| 进度分状态机：连接 2% / 读首包 4% / 下载 5%~98%（**非线性** `1-(1-p)^0.9`）/ 合并 99% | ModNet.vb:728-752 | 只有"已完成/总数"，没有"正在连接"这一档 |
| 未知大小的文件**流式直传**到内存/文件（`FileSize = -1`, `IsUnknownSize`） | ModNet.vb:927-938 | `size == 0` 时不做大小校验，行为接近 |
| `SimulateBrowserHeaders`（模拟浏览器的 UA 与 Referer） | ModNet.vb:695 | 没有（有些 CDN 会因此拒掉我们） |
| 全局限速（`NetTaskSpeedLimitHigh`/`Low`，余量每秒补 1/10） | ModNet.vb:1779 | **没有**（设置里也没有这一项） |
| 下载前"已存在文件"智能复用：从**所有** MC 文件夹里按大小+哈希找同文件，找到就复制过去 | ModNet.vb:1509-1564 | 没有（多实例重复下载同一份库） |
| 文件名带 `RandomInteger(0,999999)` 防并发撞车 | ModNet.vb:984 | `.part` + 分片后缀，等效 |

---

## 2. 加载器实时状态逐条对照

对照对象：`Modules/Minecraft/ModDownload.vb`（1391 行）。

### 2.1 ★★ 加载器清单是"错峰竞速"，不是"并行等全部"（待采纳）

**PCL2 的 `DlSourceLoader`**（ModDownload.vb:1319-1382）：

```
LoaderList = [(源A, 0), (源B, 30), (源C, 60)]   ' 单位：百毫秒
```

* **第 30 个 100ms（3 秒）启动源 B**，第 60 个（6 秒）启动源 C；
* 任何一个成功 → 立刻取消其余全部；
* 前面全失败 → **立刻**启动后面的（不等满计时）；
* 全部失败 → 把每个源的错误汇总，抛第一个非"无"的错误。

而且**每个加载器都有自己的超时时间**，源不同超时也不同（30 秒 / 60 秒）。

**我们的现状**：`modloader::fetch_available_loaders` 用 `tokio::join!`
**同时**发 5 个源，然后等**全部**返回。慢的那个（比如 NeoForge 走官方 maven）
会把整个查询拖到它的超时。

**为什么值得抄**：这就是"冷启动 1.3 秒"能不能再降的关键 ——
5 个并行请求里最慢的那个决定了总时长，而错峰竞速让它变成"第一个成功的"。

**另一个细节**：`DlVersionListOrder(OfficialUrls, MirrorUrls)` 由
**一个设置项** `DlVersionListPreferMojang` 决定官方/镜像谁在前 ——
用户能自己选"要快"还是"要官方数据"。

### 2.2 加载器清单的来源是"官方 + BMCLAPI 双份"，不是单源

| 加载器 | 官方源 | BMCLAPI 源 | 我们的现状 |
|---|---|---|---|
| Forge | `files.minecraftforge.net/.../index_<mc>.html`（**正则抓 HTML 表格**） | `/forge/minecraft/<mc>` | 已用 BMCLAPI（第一轮修好了） |
| NeoForge | `maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge` | `/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge` | 已用 BMCLAPI |
| **NeoForge 旧代** | 同上但包名换成 `net.neoforged.forge` | 同左 | **我们没有** |
| Fabric | `meta.fabricmc.net/v2/versions` | `/fabric-meta/v2/versions` | 官方为主 |
| Quilt | （官方 meta） | — | 官方为主（BMCLAPI 的 Quilt 镜像实测 404） |
| LiteLoader | 官方 XML | `/liteloader` | **我们没有**（1.12.2 及以前唯一的选择） |
| OptiFine | `optifine.net/downloads` 抓 HTML | `/optifine/versionList` | 已用 BMCLAPI |

**NeoForge 旧代**（ModDownload.vb:831）值得单独说：

```vb
Dim PackageName As String = If(Inherit = "1.20.1", "forge", "neoforge")
Return $"https://maven.neoforged.net/releases/net/neoforged/{PackageName}/{ApiName}/…"
```

也就是 **1.20.1 及更早的 NeoForge 包名是 `net/neoforged/forge`**（不是 `neoforge`）。
我们只查 `neoforge` 那一条 —— 如果你在 1.20.1 上选 NeoForge，我们会说"没查到"，
而它其实是有的（只是换了 maven 坐标）。**下一轮补。**

### 2.3 Forge 的"安装器分类"与推荐版本（待采纳）

PCL2 解析 Forge 列表时会**按文件类型分类**并给优先级
（ModDownload.vb:753-778）：

| category | format | 优先级 | 适用范围（PCL2 注释给的实测范围） |
|---|---|---|---|
| `installer` | jar | 2（最高） | ~753（1.6.1 部分）、738~684（1.5.2） |
| `universal` | zip | 1 | 751~449（1.6.1 部分）、682~183（1.5.1~1.3.2） |
| `client` | zip | 0 | 182~（1.3.2 部分 ~） |

它对**古老版本**（1.2.4、1.3.2 这些）也要抓官方 HTML 页来补，
因为 BMCLAPI 上那些版本的元数据不全。我们目前在极老版本上会"没查到"。

另外 `IsRecommended` 来自 `promotions_slim.json` 的 `recommended` 字段 ——
我们的界面有"推荐"标记吗？（**待确认**）

### 2.4 我们做得比 PCL2 好的地方（别丢）

* **Quilt 的 API 前置包**：PCL2 只内置了 `fabric-api`
  （ModDownload.vb:1162 `ResourceVersion.FromProjectId("fabric-api", …)`），
  Quilt 用户得自己装。我们已经能自动装 QSL（slug `qsl`，联网验证过）。
* **SHA1 校验 + 416 自愈**：PCL2 靠 `FileChecker` 校验，
  但没有"416 说明本地 .part 比服务端还大 → 丢掉重下"这条自愈路径。
* **ADR-037 的「没查到 vs 确认没有」区分**：PCL2 用 `Throw New Exception("无")`
  表示"这个源没有"，靠字符串判断；我们用 `Option<Vec<_>>` + `NetError::Status`
  在类型层面区分。

---

## 3. 本轮已做进 IEML 的四条

| # | 内容 | 文件 | 验证方式 |
|---|---|---|---|
| 1 | "死连接"判据（5 秒 / 1 KB/s，照抄 PCL2） | `net/download.rs` `SpeedWatch::dead` | 4 条单元测试 |
| 2 | 服务端文件大小校验（`Content-Range` 总大小） | `net/download.rs` `parse_content_range_total` | 单元测试 + 实下 |
| 3 | mcimirror 兜底（Modrinth / CurseForge 的 CDN 与 API） | `net/mirror.rs` `mcimirror_url`；`net/mod.rs` `get_text_third_party` | 5 条单元测试 + 4 端点实测 |
| 4 | `quilt` 的 slug 修正（`qsl`）+ 整合包路径的 API 前置包 | `commands_real.rs`（上一轮） | `pnpm test:apilib` 7 条联网测试 |

实测数据（`pnpm test:apilib`，`--test-threads=1`）：
```
✓ 1.20.1 → fabric-api-0.92.12+1.20.1.jar        ⏱ 14.3s
✓ 1.21.1 → fabric-api-0.116.17+1.21.1.jar       ⏱  6.6s
✓ Quilt  → qfapi-7.7.0_qsl-6.3.0_fapi-…jar
✓ 官方 API 0.62s / 官方 CDN 11.61s / mcimirror API 0.50s / mcimirror CDN 1.04s
7 passed; 0 failed（修之前是 3 passed / 3 failed）
```

---

## 4. 下一轮清单（按性价比排序）

1. **`get_text` 三段式超时**（1.3）—— 直接对应"在线清单查询太慢"。
2. **磁盘空间预检**（1.4）—— 实现便宜，把"os error 112"变成人话。
3. **加载器清单错峰竞速**（2.1）—— 冷启动再降一档。
4. **LiteLoader 安装实现**（2.2）—— 现在是"界面说没做安装"，要做就得走它自己的 installer。
5. **Forge 古老版本的官方 HTML 兜底 + 推荐版本标记**（2.3）。
6. **全局下载管理器的动态增线程**（1.7）—— 收益不确定，先做前面的。
7. **下载前"已存在文件"智能复用**（1.8）—— 多实例省流量。

---

## 5. 本轮追加做掉的（原第 4 节第 2 条）

### 5.1 ★★ NeoForge 1.20.1 的 maven 坐标（PCL2 `ModDownload.vb:831`）

```vb
Dim PackageName As String = If(Inherit = "1.20.1", "forge", "neoforge")
Return $"https://maven.neoforged.net/releases/net/neoforged/{PackageName}/{ApiName}/{PackageName}-{ApiName}"
```

**1.20.1 及更早的 NeoForge 发布在 `net/neoforged/forge` 名下**
（版本号形如 `1.20.1-47.1.85`），1.20.2 起才改成 `net/neoforged/neoforge`。
我们原来一律拼 `neoforge` —— 于是 1.20.1 上装 NeoForge 会 **404**，
界面只说"安装失败"，用户完全不知道为什么。

**实现**（三层，从可靠到兜底）：

1. **用服务端给的路径**：BMCLAPI 的 `/neoforge/list/{mc}` 每条记录自带
   `installerPath`（实测 `/maven/net/neoforged/forge/1.20.1-47.1.85/forge-…-installer.jar`）
   —— 坐标这种事不该由我们猜。新增 `BmclNeoforgeBuild::installer_url()`。
2. **兜底按 MC 版本段拼**：`neoforge_package_for(Some("1.20.1"), …) == "forge"`。
   边界是 **1.20.1**（照抄 PCL2），不是"1.20.2 及以前"。
3. **只有版本号时看前缀**：`1.20.x-` 前缀 = 1.20.1 段（只有那一代长这样）。

**实测踩到的两个坑**（都靠联网测试抓到）：

* 第一版只按"版本号第一段 < 20 → forge"判 —— 但 1.20.1 段的版本号是
  `1.20.1-47.1.105`，剥掉前缀后的 `47.x` 与 1.21 段的 `47.x` **长得一样**，
  坐标却不同。必须**同时看 MC 版本**。
* 第二版把**目录**改成了 `forge/`，文件名仍写 `neoforge-…` —— **404**。
  服务端给的真实文件名是 `forge-1.20.1-47.1.85-installer.jar`，**文件名也跟着包名走**。

**新测试**（`src-tauri/tests/live_neoforge.rs`，`pnpm test:neoforge`）：

```
✓ 1.20.1 共 60 个 NeoForge 版本，最新是 47.1.105
✓ 实测 installerPath：/maven/net/neoforged/forge/1.20.1-47.1.85/forge-1.20.1-47.1.85-installer.jar
  → 安装器大小 7 736 927 字节
✓ 兜底（1.20.1 / 1.20.1-47.1.85）：…/net/neoforged/forge/…/forge-…-installer.jar
✓ 兜底（1.21.1 / 21.1.250）：…/net/neoforged/neoforge/…/neoforge-…-installer.jar
3 passed; 0 failed
```

### 5.2 ★★ LiteLoader："上游有"与"我们能装"分开（详见 ADR-045）

读 PCL2 的 LiteLoader 支持时发现我们这边有一个**同类但更严重的缺陷**：
静态表标着 1.7.10 / 1.12.2 可用、`addon_compatibility` 放行、
`loader_trace` 能识别已装的 —— **但 Rust 侧没有任何安装实现**。
用户勾上、点安装、界面报成功、磁盘上什么都没发生。

`AddonOption` 现在有 `exists` / `implemented` / `available` 三个字段，
界面显示「**没做安装**」而不是含糊的"不可用"。

### 5.3 ⚠ 已知重复：加载器能力表有两份实现（下一轮统一）

`loader_capabilities` 这个 Rust 命令**注册了但前端从来没调过**
（`src/bridge/tauri.ts` 有桥接方法，无人使用）；界面用的是
`src/domain/loader-caps.ts` 的本地实现。两份实现意味着同一个结论
（"这个版本能不能装 Forge"）有两个来源 —— 这正是 ADR-001 要消灭的东西。

现在两份都改成了同一套规则（`exists && implemented`），并且两边各有一条
同款测试（Rust `nothing_unimplemented_is_marked_available` /
JS `任何"没实现"的附加组件都不许标成可用`），但那只是"靠测试对齐"。

**下一轮**：让 `InstallComposer` 直接用 Rust 的 `loader_capabilities`
（在线清单作为入参传进去），TS 那份降级为**离线兜底 + 测试夹具**。
