# 设计决策记录（ADR）

> 本文档记录 IEML 的每一项重要决策：**决定了什么、为什么这么决定、依据是什么**。
> 目的是避免日后「不知道当初为什么这么做」而反复返工。

---

## ADR-001　技术栈：Rust + Tauri 2.x

**日期**：2026-09-11
**状态**：已确认

**决定**：Rust 内核 + Tauri 2.x + 系统 WebView。

**理由**：Electron 自带完整 Chromium（~150 MB），与「极致轻量化」是架构级冲突，优化无法弥补；Go + Wails 体积可接受，但 Rust 在 zip 解压、哈希校验、并发下载上生态更成熟，且 Tauri 的 Channel IPC 天然适配下载进度这种高频流数据。

**代价**：三平台 WebView 行为有细微差异，需 CI 视觉回归；Rust 首次编译慢。

---

## ADR-002　加载器三层结构（不可做成并列多选）

**日期**：2026-09-11
**状态**：已确认（属于纠错，见 ADR-006）

**决定**：加载器选择分三层——基础加载器（单选互斥）、附加组件（多选受约束）、API 前置包（只读自动）。

**理由**：Forge / NeoForge / Fabric / Quilt 是四套互斥的底层框架，物理上不可能共存；OptiFine / LiteLoader 是在基础加载器之上做增强的叠加层；Fabric API / QFAPI 是「不装就跑不起来」的硬依赖。

**依据**：PCL2 的 `ModComp` 模块源码分析明确做了同样的区分。

---

## ADR-003　OptiFine 可独立安装在纯原版上

**日期**：2026-09-11
**状态**：已确认（第三轮修正）

**决定**：OptiFine **不是必须依附加载器**。纯原版 + OptiFine 是完全合法的安装组合，且这是 OptiFine 最常见的用法之一（只要光影不要 Mod）。

**原理**：OptiFine 的本质是**对原版 jar 做文件覆盖 + 类替换**（老版本直接改 jar，新版本走自带的 Java installer）。它同时具备两种身份：
- 作为**独立优化/光影方案**：直接覆盖原版 → 纯原版可用
- 作为**Mod（Forge 版）**：加载器模式下放到 `mods/` → 与 Forge 共存

**由此推出的实现要求**：
- 安装流水线中，OptiFine 的安装方式**取决于目标基座**：
  - 基座为纯原版 → 走独立的「覆盖式安装」路径
  - 基座为 Forge → 走 Forge 兼容路径
  - 基座为 Fabric/Quilt → 必须先装 OptiFabric 桥接
- 因此 `check_addon_compat` 的签名必须允许 `base: Option<LoaderKind>`，**None 表示纯原版**，且 `(None, OptiFine) => allowed`。
- **纠正上一版的错误**：架构文档曾写「无（原版）→ OptiFine ❌ 无依附对象」，这是错的。

**同时保留的约束**：OptiFine **不能声明 Minecraft 版本**（它没有这个元数据），只能跟随所选原版版本。且 OptiFine 的版本号（如 `HD_U_I6`）自带 MC 版本对应关系，选择时必须做匹配校验。

---

### ★ 2026-09-11 第六轮修正（源码研读后）

**修正 1：「文件覆盖」的机制描述不准确。**

HMCL `download/optifine/OptiFineInstallTask.java` 的真实实现是**两种路径，按 installer 里有没有 `optifine/Patcher.class` 分叉**：

```java
Path optiFineLibraryPath = gameRepository.getLayout().getLibraryFile(manifest.id(), optiFineLibrary);
if (Files.exists(fs.getPath("optifine/Patcher.class"))) {
    String[] command = {
        JavaRuntime.getDefault().getBinary().toString(),
        "-cp", installerFile.toString(),
        "optifine.Patcher",
        minecraftJar.toAbsolutePath().normalize().toString(),   // ← 原版 client jar 作为输入
        installerFile.toString(),
        optiFineLibraryPath.toString()                          // ← 输出
    };
    int exitCode = SystemUtils.callExternalProcess(command);
    if (exitCode != 0)
        throw new IOException("OptiFine patcher failed, command: " + new CommandBuilder().addAll(Arrays.asList(command)));
} else {
    FileUtils.copyFile(installerFile, optiFineLibraryPath);     // ← 老版本：直接复制
}
```

- **现代版本** —— 拉起 Java 子进程运行 OptiFine 自带的 `optifine.Patcher`，对原版 jar 做**字节码级补丁**
- **老版本**（无 `Patcher.class`）—— 直接复制 installer 当库文件

**结论不变**（仍可独立装在纯原版上，因为它的产物就是「被改造过的原版」），
但**实现必须支持「拉起子进程 + 传三个位置参数」**，不能简单复制文件。

**修正 2：安装时必须做两件原先没想到的事。**

1. **删 `META-INF/mods.toml`** —— OptiFine 的 installer 里带了这个文件，
   若留在 libraries 目录里，Forge 启动时会把它当成一个 Mod 去解析，导致冲突。
   **要对「installer 副本」和「产出的库 jar」各删一次**：
   ```java
   Path optiFineInstallerLibraryPath = gameRepository.getLayout().getLibraryFile(manifest.id(), optiFineInstallerLibrary);
   FileUtils.copyFile(installerFile, optiFineInstallerLibraryPath);
   try (FileSystem fs2 = CompressingUtils.createWritableZipFileSystem(optiFineInstallerLibraryPath)) {
       Files.deleteIfExists(fs2.getPath("/META-INF/mods.toml"));
   }
   // ...跑完 Patcher 后，对产出再删一次...
   try (FileSystem fs2 = CompressingUtils.createWritableZipFileSystem(optiFineLibraryPath)) {
       Files.deleteIfExists(fs2.getPath("/META-INF/mods.toml"));
   }
   ```

2. **处理 launchwrapper** —— installer 内部可能带两种：
   ```java
   Path launchWrapper2 = fs.getPath("launchwrapper-2.0.jar");
   if (Files.exists(launchWrapper2)) { /* 提取为库 optifine:launchwrapper:2.0 */ }

   Path launchWrapperVersionText = fs.getPath("launchwrapper-of.txt");
   if (Files.exists(launchWrapperVersionText)) {
       String launchWrapperVersion = Files.readString(launchWrapperVersionText).trim();
       Path launchWrapperJar = fs.getPath("launchwrapper-of-" + launchWrapperVersion + ".jar");
       if (Files.exists(launchWrapperJar)) { /* 提取为库 optifine:launchwrapper-of:<ver> */ }
   }
   // 若都没拿到：
   if (!hasLaunchWrapper) libraries.add(new Library(new Artifact("net.minecraft", "launchwrapper", "1.12")));
   ```

**修正 3：用 `priority = 10000` 从数据结构层面保证「最后装」。**

```java
setResult(new GameInstancePatch(
        GameComponentType.OPTIFINE.getPatchId(),   // "optifine"
        remote.getSelfVersion(),
        10000,                                      // ← 优先级极大值
        new Arguments().addGameArguments("--tweakClass", "optifine.OptiFineTweaker"),
        GameComponentAnalyzer.LAUNCH_WRAPPER_MAIN,
        libraries));
```

HMCL 的 `GameInstancePatch` 带优先级，数值越大越靠后应用。
OptiFine 用 10000 这个极大值，**比靠调用顺序的约定可靠得多**。
（HMCL `OptiFineInstallTask` 的类注释也直接写明：`Note: OptiFine should be installed in the end.`）

**修正 4：安装前置校验。**

```java
String originalMainClass = manifest.mainClass();
if (!GameComponentAnalyzer.FORGE_OPTIFINE_MAIN.contains(originalMainClass))
    throw new UnsupportedInstallationException(UnsupportedInstallationException.UNSUPPORTED_LAUNCH_WRAPPER);
```
原版 `mainClass` 必须在白名单内，否则拒绝安装。

**修正 5：Forge 1.17 的版本门槛。**

```java
Path buildofText = fs.getPath("buildof.txt");
if (Files.exists(buildofText)) {
    String buildof = Files.readString(buildofText).trim();
    VersionNumber buildofVer = VersionNumber.asVersion(buildof);
    if (GameComponentAnalyzer.BOOTSTRAP_LAUNCHER_MAIN.equals(originalMainClass)) {
        // OptiFine H1 Pre2+ is compatible with Forge 1.17
        if (buildofVer.compareTo("20210924-190833") < 0) {
            throw new UnsupportedInstallationException(UnsupportedInstallationException.FORGE_1_17_OPTIFINE_H1_PRE2);
        }
    }
}
```
若原版 mainClass 是 `BOOTSTRAP_LAUNCHER_MAIN`（Forge 1.17+）且 installer 的 `buildof.txt`
值 `< "20210924-190833"`，则拒绝安装 —— 这是 OptiFine H1 Pre2 之前的版本，
与 Forge 1.17 不兼容。

**修正 6：约束矩阵补全（原文档只写了 NeoForge 一条）。**

PCL2 `PageDownloadInstall.xaml.vb` 的 `LoadOptiFineGetError()`：

```vb
If SelectedNeoForge IsNot Nothing Then Return "与 NeoForge 不兼容"
' Forge 1.13 ~ 1.14.3 全部不兼容
If SelectedForge IsNot Nothing AndAlso
   CompareVersion(VanillaName, "1.13") >= 0 AndAlso CompareVersion("1.14.3", VanillaName) >= 0 Then
    Return "与 Forge 不兼容"
End If
' Fabric 1.20.5+ 全部不兼容
If SelectedFabric IsNot Nothing AndAlso CompareVersion(VanillaName, "1.20.4") > 0 Then
    Return "与 Fabric 不兼容"
End If
```

| 组合 | 结果 | 条件 |
|---|---|---|
| 原版 + OptiFine | ✅ 允许 | 无任何加载器时直接 `Return Nothing` |
| NeoForge + OptiFine | ❌ | 无条件 |
| Forge + OptiFine | ❌ | 仅 MC ∈ [1.13, 1.14.3] |
| Forge + OptiFine | ⚠️ 条件允许 | 其他版本需过 `IsOptiFineSuitForForge` |
| Fabric / Quilt + OptiFine | ❌ | 仅 MC ≥ 1.20.5 |
| Fabric / Quilt + OptiFine | ⚠️ 需 OptiFabric | ≤ 1.20.4；**1.14~1.15 需手动下 OptiFabric Origins** |

**修正 7：`IsOptiFineSuitForForge` 的四级判定规则（原先完全没覆盖）。**

```
① Inherit（MC 大版本）必须一致
② RequiredForgeVersion == Nothing   → 不兼容（该 OptiFine 不支持 Forge）
③ RequiredForgeVersion == 空白串    → 兼容（对应 PCL2 issue #4183）
④ RequiredForgeVersion 含 "."       → 与 Forge.Version 做 CompareVersion(...) == 0
⑤ RequiredForgeVersion 不含 "."     → 比较 Forge.Version.Revision == RequiredForgeVersion
```

**`RequiredForgeVersion` 字段的来源与语义**（PCL2 `ModDownload.vb` 源码注释逐字）：

```
需要的最低 Forge 版本。空字符串为无限制，Nothing 为不兼容，
"28.1.56" 表示版本号，"1161" 表示版本号的最后一位。
```
```vb
If Entry.RequiredForgeVersion.Contains("N/A") Then Entry.RequiredForgeVersion = Nothing
```
数据来自**正则抓取 `optifine.net/downloads` 的 HTML 表格** `colForge` 列：
```vb
Dim Forge As List(Of String) = Result.RegexSearch("(?<=colForge'>)[^<]*").ToList
```

**修正 8：离线版本反解（解决「OptiFine 无官方 API」的开放问题）。**

用户提供本地 installer jar 时，可从 `Config.class` 的**字节码常量池**读出精确版本：

```java
try (FileSystem fs = CompressingUtils.createReadOnlyZipFileSystem(installer)) {
    // Config.class 的位置试三种，对应不同年代的打包方式
    Path configClass = fs.getPath("Config.class");
    if (!Files.exists(configClass)) configClass = fs.getPath("net/optifine/Config.class");
    if (!Files.exists(configClass)) configClass = fs.getPath("notch/net/optifine/Config.class");
    if (!Files.exists(configClass)) throw new IOException("Unrecognized installer");

    ConstantPool pool = ConstantPoolScanner.parse(Files.readAllBytes(configClass), ConstantType.UTF8);
    List<String> constants = new ArrayList<>();
    pool.list(Utf8Constant.class).forEach(utf8 -> constants.add(utf8.get()));

    // 在常量池里找三个 key，取其后的第一个常量
    String mcVersion = getOrDefault(constants, constants.indexOf("MC_VERSION") + 1, null);
    String ofEdition = getOrDefault(constants, constants.indexOf("OF_EDITION") + 1, null);
    String ofRelease = getOrDefault(constants, constants.indexOf("OF_RELEASE") + 1, null);

    if (mcVersion == null || ofEdition == null || ofRelease == null)
        throw new IOException("Unrecognized OptiFine installer");
    if (!mcVersion.equals(gameVersion))
        throw new VersionMismatchException(mcVersion, gameVersion);   // ← 校验目标 MC 版本
    ...
}
```

**这是完全离线的兜底方案**：无需任何 API，直接读用户本地已有文件的字节码。
IEML 必须实现，作为 API 不可用时的降级路径。

**修正 9：libraries 目录布局与命名格式。**

```java
String mavenVersion = remote.getGameVersion() + "_" + remote.getSelfVersion();
// 形如：1.20.1_HD_U_I6

optiFineLibrary          = new Library(new Artifact("optifine", "OptiFine", mavenVersion));
optiFineInstallerLibrary = new Library(new Artifact("optifine", "OptiFine", mavenVersion, "installer"), ...);
```

```
libraries/optifine/OptiFine/<MC版本>_<OF自述版本>/
├── OptiFine-<MC版本>_<OF自述版本>.jar                    ← patch 产出的库
└── OptiFine-<MC版本>_<OF自述版本>-installer.jar          ← installer 副本（已删 mods.toml）
```

**mavenVersion 的绑定格式是 `<MC版本>_<OptiFine自述版本>`** ——
这是「MC 版本」与「OptiFine 版本」的绑定方式，也是校验依据。

---

## ADR-004　版本识别采用多级兜底

**日期**：2026-09-11
**状态**：已确认

**决定**：不能只靠读 `version.json` 的 `id` 字段判断版本，必须实现多级兜底识别。

**理由**：整合包、其他启动器导入的实例、用户手动改过的目录，往往元数据残缺。PCL2 为此实现了 11 级兜底：查发布时间 → 查快照标记 → 查 JumpLoader → 查 PCL/HMCL 下载元数据 → 查 Forge/NeoForge 参数 → 用 inheritedFrom 递归 → 解析下载 URL → 从库依赖提取 → 读 jar 内 `version.json` → 从文件夹名提取 → 正则扫 JSON 全文。

**代价**：这是脏活，工作量不可低估，M3 导入功能要留足工期。

---

## ADR-005　版本隔离策略：按需隔离（三段判定）

**日期**：2026-09-11
**状态**：已确认

**决定**：不采用「全局一刀切开关」，改用**三段优先级判定**：

```
1. 用户对该实例的显式设置（isolation: on/off/auto）
        ↓ 未设置则
2. 自动判断：该版本目录下是否已有 mods/ 或 saves/
        有 → 隔离
        ↓ 都没有则
3. 全局默认值（默认 auto）
```

**理由**：一刀切全隔离会让只想玩原版的用户纳闷「为什么每个版本都占一份资源」；全不隔离则多版本 Mod 必然互相污染（1.20.1 的 Forge Mod 进了 1.21.1 的 classpath 会直接崩）。PCL2 用的正是这个三段判定，实践验证有效。

**UI 表现**：实例设置页提供三档选择器（自动 / 强制隔离 / 强制不隔离），选「自动」时旁边显示当前判定结果与理由，让用户知道启动器帮他做了什么决定。

**默认值**：`auto`（而非 `on`）。

---

## ADR-006　约束校验逻辑只实现一次，且必须放 Rust 侧

**日期**：2026-09-11
**状态**：已确认（吸取 ADR-002 的教训）

**决定**：加载器组合的合法性规则**只在 Rust 侧实现一份**。前端的置灰、禁用理由、桥接提示、API 补齐列表，全部是调用 `validate_combination` 后渲染的结果。

**理由**：上一版把规则同时写在前端 JS 和后端文档里，两边必然漂移。只要规则存在两份实现，就一定会出现「前端以为能装、后端装不了」。

**落地要求**：
- 前端不允许写任何 `if (base === 'neoforge' && addon === 'optifine')` 这类判断。
- 新增约束时只改 Rust 侧，前端自动跟着变。
- `validate_combination` 是纯函数，可单独写单元测试。

---

## ADR-007　实例名称默认应合理，但必须可改

**日期**：2026-09-11
**状态**：已确认

**决定**：创建实例时，名称字段**预填一个合理的默认值**（而非留空），但**永远不锁定、不隐藏、不强制改名**。

**理由**：
- 留空的坏处：用户被迫想名字，或者一堆实例都叫「新实例」，最后分不清谁是谁。
- 强制固定名的坏处：用户从整合包导入后，得到一个叫「1.20.1-forge-47.2.0」的实例，既不可读也不可改，体验很差。

**默认名生成规则**（按优先级）：
```
加载器组合存在 →  "<加载器名> <MC版本>"        例：Forge 1.20.1
仅原版        →  "Minecraft <MC版本>"          例：Minecraft 1.21.1
重复名        →  追加序号                      例：Forge 1.20.1 (2)
从整合包导入  →  用整合包的 display name        例：RLCraft 2.9.3
```

**UI 位置**：名称输入框放在配置面板顶部，默认值预填且**光标默认全选**——用户想改就直接打字，不想改就直接下一步。

**同时注意**：实例的内部目录名与显示名要分离。目录名用安全的 slug（避免中文、空格、特殊字符导致 Java 类路径问题），显示名才允许任意 Unicode。重命名实例时只改显示名，不动目录，避免破坏已装好的东西。

---

## ADR-008　元数据与组件清单的缓存机制

**日期**：2026-09-11
**状态**：已确认

**决定**：所有网络元数据都要落地缓存，并采用「**先返回缓存、后台刷新、增量更新**」策略。

**理由**：冷启动时如果等 Mojang 元数据返回再渲染，国内网络下要等 3–10 秒，与「≤500ms 可交互」的指标直接冲突。

**缓存分层**：

| 缓存对象 | 存储位置 | TTL | 失效条件 |
|---|---|---|---|
| 版本清单 `version_manifest_v2` | `cache/manifest.json` | 6h | TTL 到期后后台刷新 |
| 单版本元数据 `<ver>.json` | `cache/versions/<ver>.json` | **永久** | 版本一旦发布不再变 |
| 加载器版本列表 | `cache/loaders/<kind>.json` | 12h | TTL |
| OptiFine 版本页解析结果 | `cache/optifine.json` | 24h | TTL（无官方 API，解析成本高，缓存更久） |
| 资源索引 assets index | `cache/assets/<index>.json` | **永久** | 不会变 |
| Mod 搜索/项目信息 | `cache/modrinth/*.json` | 1h | TTL |
| 实例列表与元信息 | `cache/instances.json` | — | 按需失效 |

**缓存 key 的设计**（抄 PCL2 的做法）：对「一组输入」求 hash 作为 key，例如版本列表缓存的 key = `hash(所有实例目录名 + 缓存格式版本号)`。这样只要实例目录变了、或我们升级了缓存格式，全局缓存自动整体失效，不需要手写失效逻辑。

> **★ 2026-09-11 第六轮补充（源码研读）**
>
> **哈希算法用 MurmurHash2，不要用 SHA。** HMCL 的缓存 key 实现是
> `util/MurmurHash2.java`（16KB 实现 + 11KB 测试），而不是加密哈希。
>
> 理由：缓存 key 只需要**快 + 分布均匀 + 跨平台字节级一致**，
> 不需要抗碰撞能力。MurmurHash2 是非加密哈希，速度远快于 SHA256。
> 测试文件 11KB 说明这里要求严格的跨平台一致性 —— 因为缓存要在
> 不同机器/不同版本之间稳定命中。
>
> **修正：ADR 原文写「求 hash」太笼统，应明确为 MurmurHash2。**
>
> **缓存的典型用法**（HMCL `OptiFineInstallTask`）：
> ```java
> var task = new FileDownloadTask(
>         dependencyManager.getDownloadProvider().injectURLsWithCandidates(remote.getUrls()),
>         installerFile, null);
> task.setCacheRepository(dependencyManager.getCacheRepository());
> task.setCaching(true);      // ← 开启缓存：先查缓存，命中则跳过网络
> ```
>
> **多源竞速**（PCL2 `DlSourceLoader`）：
> 每个资源都有**官方源 + 镜像源**两条，`DlSourceOrder` / `DlVersionListOrder` 决定优先级，
> 由设置 `ToolDownloadVersion` 控制（`0` = 优先镜像 / `1` = 先官方 / 其他 = 自定义）。
>
> **一个必须注意的细节：Forge / Fabric / NeoForge 的库文件不走原版源。**
> PCL2 源码明确注释「不添加原版源」：
> ```vb
> If {"minecraftforge", "fabricmc", "neoforged"}.Any(Function(k) Original.Contains(k)) Then
>     '不添加原版源
> ```
> 因为这些库**根本不在 Mojang 的源上**，加原版源只会白白浪费一次失败请求和等待时间。

**关键约束**：
- 缓存必须带**格式版本号**。日后数据结构变了，靠版本号一次性作废旧缓存，而不是写迁移代码。
- 缓存损坏不能让启动器崩溃——解析失败就当缓存不存在，重新拉取。
- 提供「清空缓存」按钮（设置页），并显示当前缓存占用体积。
- 缓存目录不参与体积指标统计（它是运行期数据，不是安装包）。

---

## ADR-009　API 前置包是有版本的，不能硬编码

**日期**：2026-09-11
**状态**：已确认（第三轮修正）

**决定**：Fabric API / QFAPI / OptiFabric 这些前置包**必须按 MC 版本 + 加载器版本查询真实可用版本**，不允许在代码里写死版本号。

**理由**：Fabric API 的版本号形如 `0.92.2+1.20.1`——**`+` 后面就是它绑定的 MC 版本**。同一时刻，1.20.1 和 1.21.1 各自有完全不同的 Fabric API 版本，且每个 MC 版本对应多个 Fabric API 版本，需要选最新兼容的。硬编码必然过期。

**由此推出的实现要求**：
- API 前置包版本必须**动态查询**（Modrinth API 按 MC 版本 + 加载器过滤，取最新稳定版）。
- 版本列表要**带缓存**（见 ADR-008），避免每次进创建页都打一圈 API。
- 查询失败时不能让创建流程卡死——降级为「跳过自动安装 Fabric API，并在摘要中警告用户：需要手动安装」，而不是安装失败。
- 依赖版本区间校验同样适用：Mod 声明 `depends: fabric-api >= 0.90.0`，必须校验装进去的 API 版本真的满足，而不是「装了就行」。

**同时约束**：`api_for_loader` 返回的 `ApiLibrary.version` 必须来自运行时查询结果，不能是常量。上一版文档里的示例把它写成了静态构造，需要改为异步查询。

---

## ADR-010　加载器安装进度的表达方式

**日期**：2026-09-11
**状态**：已确认

**决定**：加载器安装过程中，进度区**显示当前阶段名**，而非只显示百分比。

**理由**：安装 Forge/NeoForge 时，要先下载 installer jar，再用 Java 执行 installer 释放库文件，最后写 JSON。整个流程的文件总数在开始时并不确定（installer 执行后才产出库清单）。如果只显示百分比，会出现「卡在 43% 不动」的假死观感。PCL2 的做法是显示阶段描述。

**阶段命名规范**（面向用户，不出现内部术语）：

| 内部阶段 | 用户可见文案 |
|---|---|
| 下载 installer | 正在下载安装器… |
| 执行 installer | 正在释放库文件… |
| 收集 libraries | 正在整理依赖… |
| 写 version.json | 正在生成版本描述… |
| 完成 | 加载器安装完成 |

**要求**：每个阶段都应附带**该阶段的确定进度**（如第 2 阶段内的文件计数），让用户看到确实在动。

---

## ADR-011　崩溃分析采用三段式流水线

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：实现崩溃分析模块，采用「**高优先级特征匹配 → 堆栈分析 → 低优先级模糊匹配**」三段式。

**理由**：Mod 玩家崩溃是最高频痛点，「看不懂日志」是新手硬门槛。只保存日志没用，必须给出人话结论。

**三段设计**：

```
① 收集
   ├─ crash-reports/*.txt
   ├─ 版本目录下 latest.log / debug.log
   ├─ hs_err_pid*.log（JVM 级崩溃）
   └─ 启动器捕获的游戏 stdout

② 分析（按优先级）
   ├─ 高优先级：确定性特征
   │    OutOfMemoryError / UnsupportedClassVersionError /
   │    Unable to make protected final java.lang.Class（Java 不兼容）/
   │    OpenGL not supported / Mod 被解压成文件夹
   ├─ 堆栈分析：过滤 java|minecraft|forge|fabric 等噪音包名，
   │    剩下的包名反查 → 定位到具体 Mod
   │    同时读取 Forge 崩溃报告的 "Suspected Mod" 段
   └─ 低优先级：模糊特征兜底

③ 输出
   ├─ 人话结论（"内存不足，游戏试图分配超过上限的内存"）
   ├─ 一键修复动作（如：把内存从 2G 提到 4G）
   └─ 导出报告（见 ADR-012）
```

**必须覆盖的崩溃类型**（对齐 PCL2 的 `CrashReason` 枚举）：
Java 版本过高 / 过低、使用了 JDK 或 OpenJ9、内存不足、32 位 Java 内存限制、Mod 被解压成文件夹、重复 Mod、Mod 依赖缺失、OpenGL 不支持、驱动导致 access violation、Mod 文件名含特殊字符、Mixin 失败、Forge/Fabric 自身的错误。

**关键约束**：**分析动作必须是只读的**。「一键修复」是显式的用户操作，分析本身不改任何文件。

---

### ★ 2026-09-11 第六轮重写（源码研读后）

**原设计的「三段式流水线」前提不成立。** 两个成熟启动器都不用「三段式」，
它们的真实架构是**「日志特征匹配为主 + 堆栈启发式为辅」**，
而且**规则库的规模和分类远比我们设想的大**。

**HMCL 的真实架构**（`game/CrashReportAnalyzer.java`）：

```java
public final class CrashReportAnalyzer {
    private CrashReportAnalyzer() {}          // 工具类，不可实例化

    enum Rule {                                // ★ 约 70 条正则规则
        OPENJ9(Pattern.compile("..."), "groupName1", ...),
        LOADING_CRASHED_FORGE(Pattern.compile(
            "LoaderExceptionModCrash: Caught exception from (?<name>.*?) \\((?<id>.*)\\)"),
            "name", "id"),
        // ...
        ;
        private final Pattern pattern;
        private final String[] groupNames;     // ← 命名捕获组，用于提取 Mod 信息
    }

    record Result(Rule rule, String log, Matcher matcher) {}
    static Set<Result> analyze(String log);                     // 一次可命中多条
    static String findCrashReport(String log);
    static String extractCrashReport(String rawLog);
    static Set<String> findKeywordsFromCrashReport(String s);    // ★ 启发式兜底
    static int getJavaVersionFromMajorVersion(int majorVersion);
}
```

**规则是 `Rule` 枚举，一次 `analyze()` 可同时命中多条，返回 `Set<Result>`。**

**8 大类规则分布（必须全部覆盖，尤其第 1 类我们原先完全漏了）：**

| 类别 | 条数 | 规则名（verbatim） |
|---|---|---|
| **① JVM / Java / 环境** | 8 | `OPENJ9` `NEED_JDK11` `TOO_OLD_JAVA` `JVM_32BIT` `JDK_9` `JAVA_VERSION_IS_TOO_HIGH` `MODLAUNCHER_8` `MAC_JDK_8U261` |
| ② 内存 | 2 | `OUT_OF_MEMORY` `MEMORY_EXCEEDED` |
| ③ 图形 / OpenGL | 5 | `GL_OPERATION_FAILURE` `OPENGL_NOT_SUPPORTED` `GRAPHICS_DRIVER` `RESOLUTION_TOO_HIGH` `MACOS_FAILED_TO_FIND_SERVICE_PORT_FOR_DISPLAY` |
| ④ 模组加载 / 解析失败 | 15 | `DUPLICATED_MOD` `MOD_RESOLUTION` `FORGEMOD_RESOLUTION` `FORGE_FOUND_DUPLICATE_MODS` `MOD_RESOLUTION_CONFLICT` `MOD_RESOLUTION_MISSING` `MOD_RESOLUTION_MISSING_MINECRAFT` `MOD_RESOLUTION_COLLECTION` `MOD_RESOLUTION0` `FABRIC_WARNINGS` `FABRIC_VERSION_0_12` `MOD_FILES_ARE_DECOMPRESSED` `TOO_MANY_MODS_LEAD_TO_EXCEEDING_THE_ID_LIMIT` |
| ⑤ 模组导致加载崩溃 | 6 | `LOADING_CRASHED_FORGE` `BOOTSTRAP_FAILED` `LOADING_CRASHED_FABRIC` `MODMIXIN_FAILURE` `MIXIN_APPLY_MOD_FAILED` `FORGE_ERROR` |
| ⑥ 类 / 方法异常 | 8 | `FILE_CHANGED` `NO_SUCH_METHOD_ERROR` `NO_CLASS_DEF_FOUND_ERROR` `ILLEGAL_ACCESS_ERROR` `FILE_ALREADY_EXISTS` `CONFIG` `UNSATISFIED_LINK_ERROR` `INSTALL_MIXINBOOTSTRAP` |
| ⑦ 游戏内崩溃 | 3 | `ENTITY` `BLOCK` `DEBUG_CRASH` |
| ⑧ 特定 Mod 冲突 | 8 | `OPTIFINE_IS_NOT_COMPATIBLE_WITH_FORGE` `OPTIFINE_CAUSES_THE_WORLD_TO_FAIL_TO_LOAD` `SHADERS_MOD` `MOD_FOREST_OPTIFINE` `PERFORMANT_FOREST_OPTIFINE` `TWILIGHT_FOREST_OPTIFINE` `JADE_FOREST_OPTIFINE` `RTSS_FOREST_SODIUM` |
| ⑨ 安装 / 加载器问题 | 6 | `FORGE_REPEAT_INSTALLATION` `OPTIFINE_REPEAT_INSTALLATION` `MOD_NAME` `INCOMPLETE_FORGE_INSTALLATION` `NIGHT_CONFIG_FIXES` |

> **第 ① 类是我们的重大遗漏。** Java 版本、内存、显卡驱动这些**环境类崩溃**，
> 恰恰是用户最常见、又最容易误判成「Mod 问题」的。
> 我们的规则库如果只覆盖 ④⑤⑧，用户遇到「Java 版本不对」时会得到错误结论。

**精确定位肇事 Mod 的规则（必须逐字实现这些正则）：**

| 规则 | 正则 | 捕获组 |
|---|---|---|
| `LOADING_CRASHED_FORGE` | `LoaderExceptionModCrash: Caught exception from (?<name>.*?) \((?<id>.*)\)` | `name`, `id` |
| `BOOTSTRAP_FAILED` | `Failed to create mod instance\. ModID: (?<id>.*?),` | `id` |
| `LOADING_CRASHED_FABRIC` | `Could not execute entrypoint stage '(.*?)' due to errors, provided by '(?<id>.*)'!` | `id` |
| `MIXIN_APPLY_MOD_FAILED` | `Mixin apply for mod (?<id>.*) failed` | `id` |
| `DUPLICATED_MOD` | `Found a duplicate mod (?<name>.*) at (?<path>.*)` | `name`, `path` |
| `MOD_RESOLUTION_MISSING` | `ModResolutionException: Could not find required mod: (?<sourcemod>.*) requires (?<destmod>.*)` | `sourcemod`, `destmod` |
| `MOD_RESOLUTION_CONFLICT` | `ModResolutionException: Found conflicting mods: (?<sourcemod>.*) conflicts with (?<destmod>.*)` | `sourcemod`, `destmod` |
| `CONFIG` | `Failed loading config file (?<file>.*?) of type (.*?) for modid (?<id>.*)` | `id`, `file` |

> **特别注意 `MOD_RESOLUTION_MISSING_MINECRAFT`：**
> `...requires \{minecraft @ (?<version>.*)}` ——
> **这是「Mod 与 MC 版本不兼容」的运行时铁证。**
>
> 也就是说：「版本不匹配」这个判定，**在崩溃日志里是有明确签名的**。
> 这比在平时静态猜测可靠得多 —— **应该把判定权交给运行时，而不是靠元数据预检。**

**堆栈启发式兜底（`findKeywordsFromCrashReport`）—— 我们方案里完全没有的机制：**

规则匹配不到时，从崩溃报告堆栈提取可疑包名：

```
① 用 CRASH_REPORT_STACK_TRACE_PATTERN 截取堆栈：
   "Description: (.*?)[\n\r]+(?<stacktrace>[\w\W\n\r]+)A detailed walkthrough of the error"

② 逐行匹配 STACK_TRACE_LINE_PATTERN：
   "at (?<method>.*?)\((?<sourcefile>.*?)\)"

③ 把 method 按 "." 拆分，丢掉末尾 2 段（类名 + 方法名），只留包路径段

④ 过 PACKAGE_KEYWORD_BLACK_LIST（约 150 词）过滤官方包名

⑤ 剩下的作为候选，交给上层与「已安装 Mod 列表」比对

⑥ 额外处理 JPMS 模块：STACK_TRACE_LINE_MODULE_PATTERN = "\{(?<tokens>.*)}"
   遇到 xf:<name> 形式取第二个字段（同样过黑名单）
```

**`PACKAGE_KEYWORD_BLACK_LIST` 约 150 个词，按类别（逐字精选）：**

```
Minecraft : net minecraft item setup block assist optifine player unimi fastutil
            tileentity events common blockentity client entity mojang main gui world
            server dedicated map dsi renderer chunk model loading color pipeline
            inventory launcher physics particle gen registry worldgen texture biomes
            biome monster passive ai integrated tile state play override transformers
            structure nbt pathfinding audio entities items renderers storage universal
            oshi platform
Java/JDK  : java lang util nio io sun reflect zip jar jdk nashorn scripts runtime internal
Forge     : fml minecraftforge forge cpw modlauncher launchwrapper objectweb asm
            event eventhandler handshake modapi kcauldron
Fabric    : fabricmc loader game knot launch mixin
通用词    : mods mod impl org com cn cc jp core config registries lib ruby mc codec
            recipe channel embedded done net netty network load github handler
            content feature file machine shader general helper init library api
            integration engine preload preinit hellominecraft jackhuang
```

> **注意这份黑名单混进了大量过于通用的词**（`item` `block` `client` `world`
> `api` `core` `config` `lib`），说明它是**宽松优先**的 —— 宁可漏报也不误报。
> 代价是真 Mod 的包名也会被过滤掉。IEML 应保留同样倾向，但可以做得更好：
> **不靠黑名单，改为直接拿堆栈里的包名与已装 Mod 的包名集合求交集**，
> 这样既准确又不需要维护巨型黑名单。

**崩溃报告提取的两个正则（必须逐字照抄）：**

```java
// 定位文件路径
"#@!@# Game crashed! Crash report saved to: #@!@# (?<location>.*)"

// 无需读文件，直接从日志截取
extractCrashReport(rawLog):
    起点 = 最后一个 "---- Minecraft Crash Report ----"
    终点 = 最后一个 "#@!@# Game crashed! Crash report saved to"
    若任一缺失或起点 >= 终点 → 返回 null
```

**Java 版本反推（用于给「Java 过低」的提示标注精确目标版本）：**
```java
static int getJavaVersionFromMajorVersion(int majorVersion) {
    if (majorVersion >= 46) return majorVersion - 44;   // 46 → Java 1.2, 52 → Java 8, 55 → Java 11
    else return -1;
}
```
配合 `TOO_OLD_JAVA` 规则：`UnsupportedClassVersionError: (.*?) version (?<expected>\d+)\.0`
—— 捕获的 `expected` 就是 class 版本号，转换后即可告诉用户「这个 Mod 需要 Java 17」。

---

**PCL2 的崩溃检测：4 条字符串匹配 + 退出码（更朴素但更稳）**

PCL2 `Modules/Minecraft/ModWatcher.vb`，**检测崩溃只用 5 条字符串**，
且要求该行**不含 `[CHAT]`**（否则玩家在聊天栏打这些字就会误触发）：

| 匹配字符串 | 判定 |
|---|---|
| `Someone is closing me!` / `Restarting Minecraft with command` | 正常关闭 → `Ended` |
| `Crash report saved to` / `This crash report has been saved to:` | 崩溃 |
| `Could not save crash report to` | 崩溃 |
| `/ERROR]: Unable to launch` | 崩溃 |
| `An exception was thrown, the game will display an error screen and halt.` | 崩溃（Forge） |

**退出码判定（三个坑，全是实测得来）：**
```
① State == Loading 时进程退出                    → "尚未加载完成，可能已崩溃"
② ExitCode <> 0 且 State == Running
   且 Instance.ReleaseTime.Year >= 2012          → 崩溃
③ 其他且 State <> Crashed                        → 正常 Ended
```

源码注释里还留了三条**被否决**的思路，极有价值：
- `"Minecraft ran into a problem! Report saved to:"` —— 被注释
- `"Shutdown failure!"` —— 被注释，**原因：点 X 强关也会触发，不可用**
- **`ExitCode == 1` 当「任务管理器结束」的判据 —— 被否决，原因：崩溃同样是 1**

**崩溃后的处理时序（我们漏了「延迟 2 秒」）：**
```
State = Crashed
→ 报错日志 + 红色 Hint
→ FeedbackInfo()
→ 新线程 "Crash Analyzer"：等待 2 秒     ← 给崩溃报告写完的时间
→ new CrashAnalyzer(Instance).Collect(PathIndie, LatestLog).Prepare().Analyze()
→ Output(...) 产出：<实例>.json / Log1.txt / LatestLaunch.bat
```

**`LatestLog` 是 `ConcurrentQueue(Of String)`，上限约 501 条** ——
只保留最近 500 行，避免长跑时内存无限增长。

**加载进度用日志特征点驱动（这个方法比假进度条诚实得多）：**
```
1/5  已出现日志输出
2/5  Contains("Setting user:")
3/5  ContainsIgnoreCase("lwjgl version")
4/5  Contains("OpenAL initialized") OrElse Contains("Starting up SoundSystem")
5/5  (Contains("Created") AndAlso Contains("textures") AndAlso Contains("-atlas"))
     OrElse Contains("Found animation info")
```
`ProgressUpdate`：窗口出现或进度到 5 → 0.95 并置 `Running`；
否则 `Math.Min(LogProgress, 3) / 3 * 0.9`。

**窗口探测的三个必须知道的坑：**
- **类名白名单**：`GLFW30` / `SDL_app` / `LWJGL` / `SunAwtFrame`
- **标题排除**：以 `FML` 开头、等于 `PopupMessageWindow`、以 `GLFW` 开头
- **源码注释明确：Mod 可以修改窗口标题，所以不能只判断是否以 "Minecraft" 开头**
- **进程时间校验**：窗口所属进程的 `StartTime` 必须 ≥ 游戏进程的 `StartTime`
- `FML` / `Quilt Loader` 开头的是**加载器自己的窗口**，不是游戏主窗口
- 反作弊/安全软件会拦截窗口操作，抛 `Win32Exception`（PCL2 issue #1062），需优雅降级

---

**修正后的 IEML 崩溃分析架构：**

```
① 采集（只读）
   ├─ crash-reports/*.txt
   ├─ 版本目录下 latest.log / debug.log
   ├─ hs_err_pid*.log（JVM 级崩溃）
   ├─ 游戏 stdout/stderr（滚动缓冲，上限 500 行）
   └─ 触发条件：日志特征字符串命中（5 条）
               或 ExitCode != 0 且 State == Running 且发行年份 >= 2012
               或 State == Loading 时进程退出

② 规则匹配（9 大类，约 70 条正则）
   按类别优先级：环境类 → 加载器/解析类 → 游戏内类 → 特定 Mod 冲突类
   命中即产出 Result{rule, 捕获组}，一次可命中多条

③ 兜底启发式（规则全未命中时）
   ① 从堆栈提取包名段（丢掉末尾 2 段）
   ② 与「已安装 Mod 的包名集合」求交集   ← 比黑名单更准
   ③ 若仍为空，才退化为黑名单过滤法

④ 输出
   ├─ 人话结论（必须区分「环境问题」和「Mod 问题」）
   ├─ 一键修复动作（仅环境类可提供，如调整内存 / 换 Java）
   └─ 导出报告（见 ADR-012）
```

**关键约束（不变）**：分析动作只读。「一键修复」是显式的用户操作。

**新增约束**：
- 崩溃检测必须**过滤 `[CHAT]` 行**，否则玩家聊天内容会误触发。
- 崩溃分析**延迟 2 秒**再启动，给崩溃报告写完的时间。
- 结论必须**区分「环境问题」与「Mod 问题」** —— 把 Java 版本不对说成
  「某个 Mod 有问题」是误导，会浪费用户大量时间。

---

## ADR-012　崩溃报告一键打包

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：崩溃弹窗提供「导出报告」按钮，把分析结论 + 原始日志 + 系统信息打包成一个 ZIP。

**内容清单**：
```
IEML-crash-<时间戳>.zip
├── 分析结果.txt          ← 人话结论，放最外层方便直接看
├── latest.log
├── debug.log（若存在）
├── crash-report.txt
├── hs_err_pid*.log（若存在）
├── instance.json         ← 实例配置（内存/Java/加载器组合）
├── mods-list.txt         ← mods 目录清单（文件名 + SHA1）
└── system-info.txt       ← 系统版本 / CPU / 内存 / 显卡 / Java 版本清单
```

**目的**：用户把 ZIP 丢到论坛或群里，别人能立刻看懂发生了什么。**这是口碑功能**——它把「求助」这件事的成本从「你自己翻日志找关键行」降到「点一下按钮」。

**隐私约束**：打包前必须**脱敏**——日志里可能出现正版账号名、UUID、access token 片段。必须：
- 替换玩家名为 `<player>`、UUID 为 `<uuid>`
- 正则扫描并移除任何形如 `eyJ...` 的 JWT 字符串
- 打包完成后弹窗列出「已包含哪些文件、已脱敏哪些内容」，让用户知情

---

## ADR-013　Java 自动获取走 Adoptium

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：缺失 JRE 时自动下载，源用 **Adoptium Temurin API**。

**理由**：Adoptium 提供免登录直链（`api.adoptium.net/v3/binary/latest/...`），无需 API Key，支持多平台多架构，是启动器社区的事实标准。Oracle JDK 有许可问题，不能分发。

**版本映射表**（MC 版本 → Java 主版本）：

| Minecraft 版本 | Java |
|---|---|
| ≤ 1.12.2 | Java 8 |
| 1.13 – 1.16.5 | Java 8–11 |
| 1.17 – 1.20.4 | Java 17 |
| 1.20.5 – 1.21.x | Java 21 |

> **★ 2026-09-11 第六轮重写（源码研读后）**
>
> **上面这张表过于简化，必须弃用。** HMCL `game/JavaVersionConstraint.java`
> 的真实模型是**13 条带优先级的约束规则**，每条携带三个信息：
>
> ```java
> public enum JavaVersionConstraint {
>     private final boolean isMandatory;                               // 强制 or 建议
>     private final VersionRange<GameVersionNumber> gameVersionRange;  // 适用的游戏版本范围
>     private final VersionRange<VersionNumber> javaVersionRange;      // 允许的 Java 版本范围
>
>     public final boolean appliesToVersion(GameVersionNumber, GameInstanceManifest,
>                                           JavaRuntime, GameComponentAnalyzer) {
>         return gameVersionRange.contains(gameVersionNumber)
>                 && appliesToVersionImpl(gameVersionNumber, version, java, analyzer);
>     }
>     public boolean checkJava(...) {
>         return getJavaVersionRange(version, analyzer).contains(java.getVersionNumber());
>     }
> }
> ```
>
> - `appliesToVersion` —— **这条规则是否适用于这个实例**
> - `checkJava` —— **这个 Java 是否满足该规则**
> - **枚举声明顺序 = 优先级**，注释里明确写了 "give priority to..."
>
> **全部 13 条规则（verbatim）：**
>
> | 序 | 枚举名 | 强制 | 游戏版本范围 | Java 版本范围 | 附加条件 |
> |---|---|---|---|---|---|
> | 1 | `VANILLA` | ✅ | 全部 | 全部 | `version.javaVersion() == null` |
> | 2 | `GAME_JSON` | ✅ | 全部 | 动态 | MC ≥ 1.7.10 且 JSON 有 javaVersion |
> | 3 | `MODDED_JAVA_7` | ❌ | ≤1.7.2 | ≤1.7.999 | **有 Forge** |
> | 4 | `MODDED_JAVA_8` | ❌ | 1.7.10~1.16.999 | 1.8~1.8.999 | **有 Forge** |
> | 5 | `MODDED_JAVA_16` | ❌ | 1.17~1.17.999 | 16~16.999 | **有 Forge** |
> | 6 | `MODDED_JAVA_17` | ❌ | 1.18~1.20.4 | 17~17.999 | **有 Forge** |
> | 7 | `MODDED_JAVA_21` | ❌ | ≥1.20.5 | 21~21.999 | **有 Forge** |
> | 8 | `CLEANROOM` | ✅ | 1.12.2~1.12.999 | 动态 | 有 Cleanroom |
> | 9 | `LAUNCH_WRAPPER` | ✅ | ≤1.12.999 | ≤1.8.999 | mainClass 匹配且 launchwrapper < 1.13 |
> | 10 | `VANILLA_JAVA_8_51` | ❌ | ≥1.13 | ≥1.8.0_51 | — |
> | 11 | `VANILLA_LINUX_JAVA_8` | ✅ | ≤1.12.999 | ≤1.8.999 | **Linux + x86_64** |
> | 12 | `VANILLA_X86` | ❌ | 全部 | 全部 | ARM64 + (Win/macOS) + MC < 1.6 |
> | 13 | `MODLAUNCHER_8` | ❌ | 1.16.3~1.17.1 | 全部 | 按 Forge 补丁号细分 |
>
> **三个必须理解的要点：**
>
> **要点 1：`MODDED_JAVA_*` 五条全部绑定 `analyzer.has(GameComponentType.FORGE)`。**
> ```java
> return analyzer != null && analyzer.has(GameComponentType.FORGE)
>         && super.appliesToVersionImpl(gameVersionNumber, version, java, analyzer);
> ```
> - **「1.17→Java 16 / 1.18→Java 17 / 1.20.5→Java 21」这些规则只在装了 Forge 时生效！**
> - **原版（无 Forge）走 `VANILLA` + `GAME_JSON`**，Java 需求由版本 JSON 的 `javaVersion` 字段决定
> - **Fabric / Quilt / NeoForge 在这份源码里没有专门的 Java 约束规则**
>
> **要点 2：`GAME_JSON` 明确不信任 1.7.10 以下的元数据。**
> ```java
> // We only checks for 1.7.10 and above, since 1.7.2 with Forge can only run on Java 7,
> // but it is recorded Java 8 in game json, which is not correct.
> return gameVersionNumber.compareTo("1.7.10") >= 0 && version.javaVersion() != null;
> ```
> **启动器学会了「对老版本元数据不信任」。** IEML 也需要这类硬编码的例外。
>
> **要点 3：`MODLAUNCHER_8` 精细到 Forge 补丁号和 Java build 号。**
> ```java
> // 游戏侧：按 Forge 版本
> switch (gameVersionNumber.toString()) {
>     case "1.16.3": return forgePatchVersion.compareTo(VersionNumber.asVersion("34.1.27")) >= 0;
>     case "1.16.4": return true;
>     case "1.16.5": return forgePatchVersion.compareTo(VersionNumber.asVersion("36.2.23")) <= 0;
>     case "1.17.1": return VersionNumber.between("37.0.60", "37.0.75").contains(forgePatchVersion);
>     default: return false;
> }
> // 注释：Minecraft 1.16+Forge with crash because JDK-8273826
>
> // Java 侧：按主版本 + 补丁号
> if (parsedJavaVersion > 17)        return false;
> else if (parsedJavaVersion == 8)   return java.getVersionNumber().compareTo(VersionNumber.asVersion("1.8.0_321")) < 0;
> else if (parsedJavaVersion == 11)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("11.0.14")) < 0;
> else if (parsedJavaVersion == 15)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("15.0.6")) < 0;
> else if (parsedJavaVersion == 17)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("17.0.2")) < 0;
> else                               return true;
> ```
>
> **这些全是 bug 报告累积出的精确边界，靠猜永远猜不到。**
>
> **其他必须照抄的规则：**
>
> `VANILLA_LINUX_JAVA_8` —— Linux 上 JDK 9+ 无法启动 MC ≤ 1.12.2，
> 因为 JDK 9+ 不接受不同架构的原生库（64 位 JDK 无法加载 32 位 lwjgl）：
> ```java
> return OperatingSystem.CURRENT_OS == OperatingSystem.LINUX
>         && Architecture.SYSTEM_ARCH == Architecture.X86_64
>         && (java == null || java.getArchitecture() == Architecture.X86_64)
>         && (analyzer == null || !analyzer.has(GameComponentType.CLEANROOM));
> ```
>
> `LAUNCH_WRAPPER` —— LaunchWrapper ≤1.12 会崩，因为它假定系统类加载器是
> `URLClassLoader`（Java 8 的行为）：
> ```java
> GameComponentAnalyzer.LAUNCH_WRAPPER_MAIN.equals(version.mainClass()) &&
> version.getLibraries().stream()
>     .filter(library -> "launchwrapper".equals(library.artifactId()))
>     .anyMatch(library -> VersionNumber.asVersion(library.version())
>         .compareTo(VersionNumber.asVersion("1.13")) < 0)
> ```
>
> `VANILLA_JAVA_8_51` —— 注释：`Minecraft >= 1.13 may crash when generating world
> on Java [1.8, 1.8.0_51)`。**Java 8 的早期小版本在地形生成时会崩**，
> 这个细节极其隐蔽，必须保留这条约束。
>
> **修正后的 Java 选择模型：**
> ```
> 版本 JSON 的 javaVersion 字段优先（1.7.10 以上才信任）
>   ↓ 缺失或不可信时
> 按 13 条约束规则逐条 apply，取最高优先级的匹配
>   ↓ 其中 MODDED_JAVA_* 仅在装了 Forge 时参与
> 叠加硬件/OS 例外（Linux+旧版、ARM64+x86、LaunchWrapper）
>   ↓
> 得到「强制约束」（必须满足）与「建议范围」（提示但不阻断）两个集合
> ```

**下载后处理**：
- 解压到 `<数据目录>/java/<major>/`，已存在且校验通过则跳过（复用）。
- 校验方式是检查 `bin/java(.exe)` 可执行并读取 `release` 文件确认版本号与架构。
- 版本不匹配（如要求 17 但装了 21）时**不能直接用**——很多 Mod 在此崩溃。必须提示并允许用户选择已有 Java 或自动下载正确版本。

**用户可见性**：设置页列出所有探测到的 JRE（路径 / 版本 / 架构 / 来源），并支持手动指定路径。**自动下载的 JRE 必须能被用户看到和删除**，不能悄悄占几百 MB 磁盘。

---

## ADR-014　存档与配置的备份机制

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：实现实例级备份与回滚，支持手动备份与自动定时备份。

**理由**：Mod 玩家最痛的场景是「装了个 Mod 把存档搞坏了」或「改配置改崩了」。备份是低成本高价值的保险。

**备份范围**：
```
saves/           存档（最重要，体积大）
config/          配置
options.txt      游戏设置
servers.dat      服务器列表
mods/ 的清单     只存文件名+SHA1 清单，不存 jar 本体（jar 可从网上下回来，省空间）
```

**存储策略**：
- 位置 `<数据目录>/backups/<实例名>/<时间戳>/`
- **mods 不备份 jar**，只备份清单。回滚时按清单对比：缺的从缓存/网络补，多的删。这样一次备份通常只有几 MB 而不是几百 MB。
- `saves/` 占空间大，采用**滚动保留**：默认保留最近 5 份，超出删最旧的。
- 自动备份**默认开启**，触发时机为「启动游戏前」。

**回滚要求**：回滚前必须**先把当前状态也备份一份**（pre-rollback snapshot），避免用户回滚后后悔。

**UI 表现**：实例详情页有「备份」标签页，时间线形式列出各备份点，标注体积与包含内容，点击可预览差异（哪些存档文件会变化）再确认回滚。

---

## ADR-015　资源包 / 光影包管理

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：资源包（resourcepacks）与光影包（shaderpacks）纳入统一管理界面，并支持拖拽安装。

**区分规则**（拖拽时自动判定）：

| 类型 | 判定依据 | 目标目录 |
|---|---|---|
| 资源包 | zip 内有 `pack.mcmeta` | `resourcepacks/` |
| 光影包 | zip 内有 `shaders/` 目录（且通常在 `shaderpacks/` 语境） | `shaderpacks/` |
| Mod | zip/jar 内有 `fabric.mod.json` / `META-INF/mods.toml` / `neoforge.mods.toml` | `mods/` |
| 整合包 | zip 内有 `manifest.json` / `modrinth.index.json` | 走整合包流程 |

**注意**：判定顺序很重要——先判整合包，再判 Mod，最后判资源包/光影。因为整合包里也含有 `mods/` 目录，如果先判 Mod 会误判。

**光影依赖约束**：光影包**必须配合 OptiFine 或 Iris 才能用**。如果用户往一个没有光影支持的实例里拖光影包，必须提示「当前实例未安装 OptiFine 或 Iris，光影不会生效，是否现在安装？」

---

## ADR-016　中文搜索 Mod 的词表方案

**日期**：2026-09-11
**状态**：已确认（用户指定加入）

**决定**：支持用中文搜索 Mod，采用**本地别名映射表 + 平台原生搜索**双路。

**理由**：Modrinth 的搜索本身对中文支持有限，CurseForge 更差。中国玩家习惯搜中文名（「工业时代」「等价交换」「暮色森林」）。

**实现方案**：

```
用户输入中文
    ↓
① 查本地别名表（中文名 → 英文 slug/关键词）
     命中 → 用英文关键词调平台 API
    ↓ 未命中
② 原样提交给平台搜索（Modrinth 有一定中文支持）
    ↓ 仍无结果
③ 提示"未找到，试试英文名"
```

**别名表结构**：
```
{
  "工业时代": ["industrialcraft", "ic2"],
  "等价交换": ["projecte", "equivalent-exchange"],
  "暮色森林": ["twilightforest"],
  ...
}
```

**数据来源**：优先复用开源词表（PCL2 内置了一张表，社区也有公开整理）。自建部分通过「用户搜索日志 + 人工校对」逐步补全。

**注意**：词表是**共享的静态数据**，一次构建进包，不做网络更新（避免引入运营负担）。体积很小（几千条约几十 KB），可以接受。

---

## ADR-017　明确不做的事情

**日期**：2026-09-11
**状态**：已确认

以下功能**明确不实现**，因为它们与「极致轻量化」的核心定位冲突，且每加一个都是几百 KB 到几 MB 的成本：

| 不做的功能 | 原因 |
|---|---|
| 启动器内嵌音乐播放器 | PCL2 有（还接了系统 SMTC），但与启动游戏无关，纯属负担 |
| 多套装饰主题（12 套那类） | 深色 + 浅色两套足够；主题越多，每套的维护和视觉回归成本翻倍 |
| 隐藏解密彩蛋 | PCL2 的个性，但占用开发资源且不提升核心体验 |
| 内置联机模块 | 需要服务器基础设施和长期运营，不是启动器该背的包袱 |

**定位提醒**：我们的竞争力是「轻 + 快 + 跨平台 + 现代」，不是「功能最多」。**每一个新功能都要先过一遍：它值多少 KB？**

---

## ADR-018　Mod 绝不自动更新（★ 第五轮纠错）

**日期**：2026-09-11
**状态**：已确认

**决定**：**IEML 在任何情况下都不自动下载、替换或升级用户已安装的 Mod。**

更新只能由用户在 Mod 管理页**显式点击**触发，并且：
1. 更新前**必须**弹出确认，列出「哪个 Mod、从什么版本 → 到什么版本、目标版本是否与当前实例匹配」
2. 旧文件**移入回收站**，不是直接删除
3. 更新完成**必须**给出可撤销路径

**理由（用户指出的核心问题）**：

Mod 与 App 有本质区别。App 更新通常是自包含的，而 **Mod 是一个三方耦合体**：

```
        Minecraft 版本
              │
      必须严格对齐（三角兼容）
              │
   加载器版本 ─┴─ Mod 版本
              │
        API 前置包版本
              │
   ⚠ 任何一角变动，另外两角可能立即失效
```

具体会炸的场景：

- 新版 Mod 只支持 1.21.1，但实例是 1.20.1 → **加载时直接崩**
- 新版 Mod 要求的 Fabric API 版本比已装的更高 → 报
  `requires version [0.9x.x, ∞) of fabric-api, but only the wrong version is present!`
- 新版 Mod 依赖的加载器最低版本高于实例当前的 → Mixin 注入失败
- 旧版 Mod 与新版 Mod 的存档格式不兼容 → **存档损坏**

**而所有启动器的自动更新都只是"看起来比较新就下"**——它无法判断目标版本回到用户这个具体实例里还成不成立。
一旦"静默升级"发生，用户下次开游戏直接崩，且**不知道是启动器干的**。这比不更新恶劣得多。

> 用户原话：**"模组不是 app，默认更新会导致模组和 API、游戏版本不匹配。"**

### PCL2 的实际做法（源码核实）

我把 PCL2 的 `PageVersionMod.xaml.vb` 读了一遍，它的行为是：

| 环节 | PCL2 的做法 | 说明 |
|---|---|---|
| 检查更新 | 比对本地 Mod 与 CurseForge/Modrinth 元数据，**只标记 `CanUpdate`** | 纯标记，不改文件 |
| 触发方式 | `BtnSelectUpdate_Click()` → `UpdateMods()` | **用户手动点击才更新** |
| 更新前 | **弹出更新警告** | 不是闷声替换 |
| 旧版本 | **移入回收站** | 不是 `rm`，可恢复 |
| 失败处理 | 有独立 `Error` 状态筛选 | 更新失败的 Mod 能被找出来 |

**结论：PCL2 从不自动更新 Mod。** 这一点必须照抄，不能"优化"。

### 由此产生的实现要求

**① 状态机设计**

```
每个已安装 Mod 都有一个状态：
  Fine         正常启用
  Disabled     已禁用（.disabled 后缀）
  Unavailable  文件存在但读不出来（损坏 / 非 Mod）
  Mismatch ★   能读出来，但与当前实例的 MC 版本 / 加载器不匹配
  CanUpdate    有更新版本可用（仅标记，不动文件）

★ Mismatch 是我们比 PCL2 多做的一步：
  主动检测"这个 Mod 到底配不配当前实例"，而不是等游戏崩了再说。
```

**② Mismatch 检测怎么做**

Mod 的元数据里带兼容性声明，读取并比对：

| 加载器 | 元数据文件 | 兼容性字段 |
|---|---|---|
| Fabric | `fabric.mod.json` | `depends.minecraft`（版本区间） |
| Forge (1.13+) | `META-INF/mods.toml` | `[[dependencies.*]]` 里的 `versionRange` |
| Forge (≤1.12.2) | `mcmod.info` | `mcversion`（单值，必须精确相等） |
| NeoForge | `META-INF/neoforge.mods.toml` | 同 Forge |
| Quilt | `quilt.mod.json` | `depends` |

判定为 Mismatch 时，UI 必须说明**具体哪里不匹配**：
- ✅「此 Mod 支持 1.21.1，当前实例是 1.20.1」
- ❌「不兼容」

**③ 更新候选的版本选择规则（关键）**

用户点「更新」时，**不能简单取最新版**。必须按这个优先级选：

```
① 在当前实例的 MC 版本 + 加载器下，取最新版本        ← 首选
② 若无（说明该 Mod 已放弃这个 MC 版本）
   → 不做静默降级，而是明确告知：
     "此 Mod 已不再支持 1.20.1，最新版仅支持 1.21.1。
      继续更新会导致游戏无法启动。"
   → 提供一个「查看其他版本」入口，让用户自己挑
③ 绝不跨大版本跳跃（如从 1.20.1 跳到 1.21.1）后静默替换
```

**④ 更新前必须显示的确认信息**

```
┌─────────────────────────────────────────────────┐
│  更新 JEI                                        │
│                                                  │
│  当前    15.2.0.110  (1.20.1)                    │
│  目标    15.3.0.5    (1.20.1)   ← 同 MC 版本 ✓  │
│                                                  │
│  ⚠ 此 Mod 依赖的其他组件：                        │
│     · Fabric API 需 ≥ 0.92.0（当前 0.92.2 ✓）    │
│     · ✗ 新版要求 Minecraft 1.21.1，当前 1.20.1   │
│                                                  │
│  旧版本将移入回收站，可随时恢复。                 │
│                                                  │
│  [查看更新日志]  [取消]  [确认更新]               │
└─────────────────────────────────────────────────┘
```

**若检测到版本不匹配，`[确认更新]` 按钮应当是危险色**，且文案改为「仍要更新（有风险）」。

**⑤ 批量更新必须逐个校验**

用户全选 20 个 Mod 点更新时，**不能一把梭**。必须：
- 逐个用上述规则校验
- 把「可以安全更新」「会破坏兼容」分成两组展示
- 默认只勾选安全的那组，危险的那组需要用户单独确认

**⑥ 整合包实例默认锁定 Mod 版本**

从整合包安装的实例，其 Mod 版本由 manifest 指定。**默认不允许更新**（因为整合包作者已经验证过这套组合），UI 上更新按钮应置灰并说明「此实例由整合包管理，作者未提供新版本清单」。

若整合包提供了新版 manifest，则走**整合包整体更新**流程，而不是一个个 Mod 单独更新。

**⑦ 不做的事**

- ❌ 启动时自动检查并自动更新
- ❌ 后台静默替换文件
- ❌ 「一键更新全部」而不做兼容性校验
- ❌ 更新失败后删除原文件

**唯一可做的自动化**：**启动时后台检查、只提示不动作**——在 Mod 管理页显示一个「N 个 Mod 可更新」的角标。用户主动点进去才处理。

---

## ADR-019　Mod 管理页的完整信息结构（★ 第五轮新增）

**日期**：2026-09-11
**状态**：已确认

**决定**：Mod 管理页要能一眼看出每个 Mod 的**状态**，而不是只列文件名。

**理由**：用户带着"哪个 Mod 有问题"的问题来这个页面。只列文件名等于把排查工作丢回给用户。
PCL2 的 `McMod` 类带了 `State` / `CanUpdate` / `Comp` 三个关键字段，这个设计是对的。

**每个 Mod 项要显示的信息**：

```
┌──────────────────────────────────────────────────────────────┐
│ ☑  [图标]  JEI                                                 │
│          Just Enough Items · 15.2.0.110                        │
│          Fabric · 1.20.1 · jei-1.20.1-fabric-15.2.0.110.jar    │
│          [可更新 ↑]  [有依赖]                          [⋯]     │
└──────────────────────────────────────────────────────────────┘

徽标体系（互斥优先级从上到下）：
  Mismatch   红   版本不匹配（最严重，会崩）
  Error      红   文件损坏 / 读不出来
  CanUpdate  蓝   有可用更新（仅标记）
  Depends    灰   「有依赖」——此 Mod 依赖别的包
  Library    灰   「前置库」——别的 Mod 依赖它
  无徽标         正常
```

**筛选器（对齐 PCL2 并扩展）**：

| 筛选 | 说明 |
|---|---|
| 全部 | — |
| 已启用 | 状态为 Fine / CanUpdate / Mismatch |
| 已禁用 | 状态为 Disabled |
| 可更新 | CanUpdate |
| **不匹配** ★ | Mismatch —— **这是我们比 PCL2 多的** |
| 有错误 | Unavailable |

**批量操作侧栏**（选中任意 Mod 后从底部升起）：
`启用` / `禁用` / `更新` / `删除` / `取消选择`

**关键约束**：
- **删除和禁用都要走回收站语义**，禁用用改后缀（`.disabled`）而不是移走文件——这样用户能在文件管理器里自己看出来。
- **「可更新」筛选器只做标记，点进去仍然要逐个确认**（见 ADR-018）。

---

## ADR-020　加载器识别必须用「libraries 坐标 + 排除条件」（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：我们原先的版本识别（ADR-004）是基于「目录名 / jar 文件名 / JSON 字段」的多级兜底。
HMCL 的做法完全不同 —— 它从**已解析的 libraries 列表**里按 Maven 坐标识别组件。

**决定**：加载器与叠加组件的识别，**以 libraries 的 `groupId:artifactId` 为主**，
文件名启发式仅作最后的兜底。

**理由**：libraries 是加载器安装后**必然写入**的结构化数据，比文件名可靠得多；
而文件名会因为用户改名、下载源不同而失去规律。

**修复证据（HMCL `game/GameComponentType.java`）**：
```java
public enum GameComponentType {
    GAME("game"),
    LEGACY_FABRIC("legacyfabric", ModLoaderType.LEGACY_FABRIC),
    LEGACY_FABRIC_API("legacyfabric-api"),
    FABRIC("fabric",               ModLoaderType.FABRIC),
    FABRIC_API("fabric-api"),
    FORGE("forge",                 ModLoaderType.FORGE),
    CLEANROOM("cleanroom",         ModLoaderType.CLEANROOM),
    NEO_FORGE("neoforge",          ModLoaderType.NEO_FORGE),
    LITELOADER("liteloader",       ModLoaderType.LITE_LOADER),
    OPTIFINE("optifine"),                            // ★ 无 ModLoaderType
    QUILT("quilt",                 ModLoaderType.QUILT),
    QUILT_API("quilt-api"),
    ;
    public static final List<GameComponentType> ALL = List.of(values());
    public static final List<GameComponentType> MOD_LOADERS =
            ALL.stream().filter(GameComponentType::isModLoader).toList();
}
```

**关键设计：用构造函数有无第二个参数区分「加载器」与「伴随组件」。**
```java
public boolean isModLoader() { return modLoaderType != null; }
```
- **`OPTIFINE` 不带 `ModLoaderType` → 它不是加载器**
- 三个 API 包（`FABRIC_API` / `QUILT_API` / `LEGACY_FABRIC_API`）也不是
- `GAME` 也不是

> 这从源码层面**确证了 ADR-003 的判断**：OptiFine 与加载器正交，
> 它是叠加组件而非加载器。我们的三层模型方向正确。

**识别条件（逐字）：**

| 组件 | 识别条件 |
|---|---|
| `LEGACY_FABRIC` | `net.fabricmc:fabric-loader` **且** libraries 中存在 groupId == `net.legacyfabric` |
| `FABRIC` | `net.fabricmc:fabric-loader` **且** libraries 中**不存在** `net.legacyfabric` |
| `FORGE` | `net.minecraftforge:(forge\|fmlloader\|minecraftforge)` **且** NeoForge 未命中 |
| `NEO_FORGE` | `net.neoforged.fancymodloader:(core\|loader)` |
| `CLEANROOM` | `com.cleanroommc:cleanroom` |
| `LITELOADER` | `com.mumfrey:liteloader` |
| `QUILT` | `org.quiltmc:quilt-loader` |
| `OPTIFINE` | groupId ∈ {`net.optifine`, `optifine`} **且** artifactId 不含 `launchwrapper` |
| `FABRIC_API` | `net.fabricmc:fabric-api` |
| `QUILT_API` | `org.quiltmc:quilt-api` |

**两组必须处理的歧义陷阱：**

1. **Fabric vs LegacyFabric** —— 两者都用 `net.fabricmc:fabric-loader`。
   必须**再遍历 libraries 找 `net.legacyfabric`** 才能区分。

2. **Forge vs NeoForge** —— NeoForge 1.20.1 时代沿用 `net.minecraftforge` groupId。
   `FORGE.matchLibrary` 必须**先跑一次 `NEO_FORGE.matchLibrary`**，命中则返回 false。

**修正 ADR-002 的三层模型**：三层结构（基础加载器 / 叠加组件 / API 前置包）不变，
但**识别方式改为读 libraries 坐标**，且要显式处理上述两组歧义。

**同时补全支持列表**：原先漏了 **LegacyFabric** 和 **Cleanroom** ——
两者都是真实存在且被 HMCL 完整支持的加载器。

---

## ADR-021　Mod 兼容性只能「提示」不能「判定」（★ 第六轮纠错）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：ADR-019 设想用「读 Mod 元数据的兼容字段比对实例配置」来主动标出
「不匹配」（Mismatch 红色徽标）。源码研读发现，**这个方案不成立**。

**证据 1：HMCL 解析 Fabric Mod 元数据时根本不读依赖字段。**

`addon/meta/FabricModMetadata.java` 的**全部**字段：
```java
private final String id;
private final String name;
private final String version;
private final String description;
private final String icon;
private final List<FabricModAuthor> authors;
private final Map<String, String> contact;
```
**7 个字段。`fabric.mod.json` 里的 `depends` / `breaks` / `conflicts` /
`recommends` / `suggests` / `provides` / `environment` 一个都没解析。**

**证据 2：HMCL 读 Forge 的 `dependencies` 数组，但目的是判「归属」而非「兼容」。**

`addon/meta/ForgeNewModMetadata.java` 的 `analyzeLoader`：
```java
ModLoaderType result = null;
loop:
for (Map<String, Object> dependency : dependencies) {
    switch ((String) dependency.get("modId")) {
        case "forge":    result = ModLoaderType.FORGE;    break loop;
        case "neoforge": result = ModLoaderType.NEO_FORGE; break loop;
    }
}
if (result != null) {
    if (result != loader)
        LOG.warning("Loader mismatch for mod " + modID + ", found " + result + ", expecting " + loader);
    return result;
} else {
    LOG.warning("Cannot determine the mod loader for mod " + modID + ", expected " + loader);
    return loader;
}
```

**注意这两行 `LOG.warning` —— HMCL 自己承认会出现加载器归属不一致，
它的处理是：记个警告，然后采信 TOML 里声明的那个。**

> 这是关键信号：**连 HMCL 都不敢根据 Mod 元数据做硬性判定。**
> 现实中的 Mod 元数据太脏 —— 写错的、漏写的、故意写宽范围的，比比皆是。

**证据 3：PCL2 和 HMCL 都靠「崩溃日志分析」定位版本不匹配。**

HMCL 的崩溃规则里有专门的一条：
```
MOD_RESOLUTION_MISSING_MINECRAFT
  正则：...requires \{minecraft @ (?<version>.*)}
```
**「Mod 与 MC 版本不兼容」在崩溃日志里是有明确签名的。**
这比静态猜测可靠得多。

**决定**：Mod 兼容性采用**四级策略**，且**措辞必须保守**。

| 层次 | 做法 | 可信度 | UI 表现 |
|---|---|---|---|
| **L1 元数据读取** | 按加载器读对应元数据文件，取 MC 版本声明（`fabric.mod.json` 的 `depends.minecraft`、`mods.toml` 中 `modId=minecraft` 条目的 `versionRange`） | 声明可能不准 | — |
| **L2 展示为「提示」** | 若声明的版本范围不含当前实例版本 → 标 **「可能不兼容」**（黄色） | 仅供提示 | **黄色徽标 + 可点开的解释** |
| **L3 文件名启发式** | 括号里的版本号（`xxx-1.20.1-fabric.jar`）**仅用于排序**，不作为判定依据 | 不可信 | 不显示 |
| **L4 运行时判定（主力）** | 靠崩溃日志分析（`MOD_RESOLUTION_MISSING_MINECRAFT` 等规则） | **可信** | 红色徽标 + 精确定位 |

**UI 措辞必须改：**

| 原设计 | 改为 |
|---|---|
| 「不匹配」（红，`Mismatch`） | **「可能不兼容」**（黄，`MaybeIncompatible`） |
| 筛选项「不匹配」 | **「可能不兼容」** |

**徽标点击必须能展开解释：**
> 此判断基于 Mod 自述的兼容信息，作者可能未及时更新或填写不准。
> 实际是否可用**以能否启动为准**。如果启动时崩溃，IEML 会分析日志给出确切原因。

**保留原 ADR-019 的结构**，仅把 `Mismatch` 这一档降级为 `MaybeIncompatible`。
其余徽标（`Error` / `CanUpdate` / `Depends` / `Library`）不变。

**附：各加载器元数据文件位置（源码确认）：**

| 加载器 | 文件路径 | 解析类 |
|---|---|---|
| Fabric | `fabric.mod.json` | `FabricModMetadata` |
| Quilt | `quilt.mod.json` | `QuiltModMetadata` |
| Forge 1.13+ | `META-INF/mods.toml` | `ForgeNewModMetadata` |
| NeoForge | `META-INF/neoforge.mods.toml`（失败回退 `mods.toml`） | `ForgeNewModMetadata` |
| LiteLoader | — | `LiteModMetadata` |
| 资源包 | `pack.mcmeta` | `PackMcMeta` |
| 数据包 | — | `DataPack` |
| Forge jar-in-jar | `META-INF/jarjar/metadata.json` 或 `MANIFEST.MF: Embedded-Dependencies-Mod` | `ForgeNewModMetadata` |

**元数据解析的现实妥协（照抄 HMCL 的容错）：**

`ForgeNewModMetadata` 的读取顺序是三级 fallback：
```java
if (modLoaderType == ModLoaderType.NEO_FORGE) {
    try { return fromFile0("META-INF/neoforge.mods.toml", ...); } catch (Exception ignored) {}
}
try { return fromFile0("META-INF/mods.toml", ...); } catch (Exception ignored) {}
try { return fromEmbeddedMod(...); } catch (Exception ignored) {}   // jar-in-jar 内嵌
throw new IOException("File " + modFile + " is not a Forge 1.13+ or NeoForge mod.");
```

三个必须容错的坑：
1. **`dependencies` 数组格式不统一** —— 源码试了三种写法，且每层都包
   `catch (ClassCastException | Throwable ignored)`，还引用了 issue #5068。
   ```java
   toml.getArray("dependencies." + modID)   // 标准
   toml.getArray("dependencies")             // 注释：I have no idea why some of the Forge mods use [[dependencies]]
   toml.getTable("dependencies").getArray(modID)  // 变体
   ```
2. **`mods.get(0)` —— 只取第一个 mod 块**，后面的忽略。
3. **`${file.jarVersion}` 占位符** —— 需要从 `MANIFEST.MF` 的
   `Implementation-Version` 取值替换：
   ```java
   mod.getVersion().replace("${file.jarVersion}", jarVersion)
   ```

---

## ADR-022　版本区间用闭区间模型 + 交集运算（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：ADR-019 的伪代码里写「按 `versionRange` 匹配」，过于笼统。
HMCL `util/versioning/VersionRange.java` 给出了具体模型。

**决定**：实现一个 `VersionRange` 类型，**闭区间语义**，并提供交集运算。

```java
public final class VersionRange<T extends Comparable<T>> {
    private final T minimum;
    private final T maximum;

    public static <T> VersionRange<T> empty();
    public static <T> VersionRange<T> all();
    public static <T> VersionRange<T> between(T minimum, T maximum);   // 闭区间
    public static <T> VersionRange<T> atLeast(T minimum);
    public static <T> VersionRange<T> atMost(T maximum);
    public static <T> VersionRange<T> is(T version);

    public boolean contains(T versionNumber) {
        if (versionNumber == null) return false;
        if (isEmpty()) return false;
        if (isAll())   return true;
        return (minimum == null || minimum.compareTo(versionNumber) <= 0)
            && (maximum == null || maximum.compareTo(versionNumber) >= 0);
    }

    public boolean isOverlappedBy(final VersionRange<T> that);
    public VersionRange<T> intersectionWith(VersionRange<T> that);
}
```

**关键事实：`[minimum, maximum]` 是闭区间，两端都含。**

**它明确不支持（不要自己发明）：**
- ❌ Maven 半开区间（`[1.0,2.0)` / `(1.0,2.0]`）
- ❌ `> <` 运算符字符串解析（**没有 `parse` 方法，只有工厂方法**）
- ❌ 通配符 / `*` / `x` 语义
- ❌ `"any"` 特殊 token（`all()` 是显式调用）

> **所以我们的做法应该是：上游把各种声明形式统一转换成 `VersionRange` 对象，
> 再调用 `contains` / `isOverlappedBy` / `intersectionWith`。
> 而不是让 `VersionRange` 自己去解析字符串。**

**`intersectionWith` 是依赖冲突检测的数学工具：**

判断「A 要求 B ≥ 1.0，实装 B 是 0.9」：
```
B_required = atLeast("1.0")
B_actual   = is("0.9")
B_required.intersectionWith(B_actual).isEmpty() == true   → 冲突
```

多 Mod 的联合约束就**求交集**：
```
所有依赖同一库的 Mod 的区间 → fold(intersectionWith) → 结果非空即可满足
```

**这比逐条 if-else 判断清晰得多，应该照抄这个模型。**

**配套的版本号类型：**

| 类型 | 规模 | 说明 |
|---|---|---|
| `GameVersionNumber` | 33KB（+24KB 测试） | MC 版本号，须支持快照 `24w45a`、预发布 `1.20.1-pre1`、`1.16_combat-3` 等 |
| `VersionNumber` | 14KB | 通用版本号比较 |
| `VersionRange` | 5KB | 区间（本文） |

> **`GameVersionNumber` 有 24KB 测试文件**，说明 MC 版本号格式极其复杂。
> IEML 必须准备等价的实现。PCL2 也有对应的 `CompareVersion` 处理。

---

## ADR-023　实例修改采用 Draft 事务机制（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：ADR-014 的「备份回滚」是**用户视角**的 —— 先复制一份，
改坏了让用户点「恢复」。但它不解决**单次操作中途失败**的问题：
装 Forge 装到一半网络断了，实例会处于半损坏状态。

HMCL `game/DefaultGameRepositoryDraft.java` 给出了更好的答案：
**把实例修改做成数据库事务。**

**决定**：在备份机制之外，**额外实现一层 Draft 事务**。

**两者的分工**：

| 机制 | 职责 | 触发方式 |
|---|---|---|
| **Draft 事务** | 保证**单次操作**的原子性（装 Forge 到一半失败 → 自动还原） | 自动，用户无感 |
| **备份快照**（ADR-014） | 保证**跨操作**的版本历史（想退回昨天 → 用户主动恢复） | 用户显式操作 |

**Draft 的核心设计（逐字）：**

```java
/**
 * Manifest changes are retained in memory until commit.
 * A successful commit writes the final manifests and primary JARs,
 * applies removals and renames, and publishes one new immutable snapshot.
 * Shared library and asset cache writes are outside the rollback boundary.
 * Instances of this class are not thread-safe.
 */
public final class DefaultGameRepositoryDraft implements GameRepositoryDraft
```

**状态机**：`OPEN → COMMITTING → COMMITTED / FAILED / ABORTED`

**关键字段：**
```java
private final DefaultGameRepository repository;
private final DefaultGameRepositorySnapshot baseSnapshot;   // 打开草稿时的不可变基准
private final Map<GameInstanceID, GameInstanceManifest> manifests;  // 内存中的修改镜像
private final Set<GameInstanceID> modifiedIds;
private final Map<GameInstanceID, Path> primaryJarSources;
private final Set<GameInstanceID> createdIds;               // 本草稿新建的实例
private final Set<GameInstanceID> removedIds;
private final List<RenameOperation> renames;                // 有序
private GameRepositoryDraft.State state;
```

**`commit()` 的执行顺序（关键是第 4 步）：**
```
1. checkOpen() + repository.checkActiveDraft(this)
2. state = COMMITTING
3. 建立三类回滚记录：appliedRenames / removedRoots / appliedFiles，及 rollbackDirectory
4. buildCommittedSnapshot()           ← 先在内存造出最终不可变快照并 seal()
5. 若有 rename/remove → repository.flushPendingInstanceWrites()
6. 依次应用 renames
7. materializeCreatedInstanceRoots()  ← 为新实例创建根目录
8. 若有 removed/modified/jarSources：
   a. createRollbackDirectory()
   b. 循环 removedIds       → removeInstanceRoot(...)
   c. 循环 primaryJarSources → applyPrimaryJar(...)
   d. 循环 modifiedIds      → applyManifest(...)
9. repository.publishDraftSnapshot(this, committedSnapshot)
10. state = COMMITTED
11. repository.releaseDraft(this)
12. cleanupRollbackDirectoryAfterCommit(rollbackDirectory)
```

> **第 4 步是关键：在动磁盘之前，先在内存里把「最终状态」完整推演出来并 `seal()`。
> 这样磁盘操作阶段只是「把已确定的计划执行一遍」，不会有半途的中间状态不一致。**

**失败回滚 —— 严格逆序：**
```
① 逆序回滚已应用的文件（delete 新文件 → 恢复 backup）
② 逆序回滚被移除的根（move rollbackRoot → originalRoot）
③ 逆序回滚重命名（moveInstanceFiles(to → from)）
④ state = FAILED；releaseDraft；cleanupCreatedInstanceRoots；
   deleteDirectory(rollbackDirectory)；重抛（子异常 addSuppressed 聚合）
```

**三类回滚记录：**
```java
private record AppliedFile(Path targetFile, @Nullable Path backupFile) {}
private record RenameOperation(GameInstanceID from, GameInstanceID to) {}
private record RemovedRoot(Path originalRoot, Path rollbackRoot) {}
```

**四个额外的安全设计（必须照抄）：**

**1. 回滚目录隔离**
```
<baseDir>/.hmcl/repository-drafts/commit-<temp>/
├── removed/     被移除的实例根
└── backups/     被替换文件的备份
```
**成功即删、失败即恢复。**

**2. 原子移动优先**
```java
private static void moveReplacing(Path source, Path target) throws IOException {
    // 优先 Files.move(..., ATOMIC_MOVE, REPLACE_EXISTING)
    // 失败退化为 REPLACE_EXISTING
    // 再失败把原子失败作为 suppressed 抛出
}
```

**3. 路径越界防护（与我们的 zip-slip 防护同类）**
```java
private void validateInstanceFileTarget(GameInstanceID id, Path target, String description) {
    if (target.equals(expectedRoot) || !target.startsWith(expectedRoot))
        throw new IOException(description + " path escapes instance root: " + target);
}
```
**目标必须是实例根的严格后代。**

**4. 继承链联动（重命名实例时）**
```java
if (createdIds.contains(from))
    throw new IllegalStateException("Cannot rename an instance created by the same draft");
if (manifests.containsKey(to))
    throw new IllegalArgumentException("Target instance already exists: " + to);
// 且遍历所有 manifest，把 inheritsFrom() == from 的改成 to，纳入 modifiedIds
```
**重命名父实例时，必须联动改写所有子实例的 `inheritsFrom`。**

**边界声明（很重要）**：
> `Shared library and asset cache writes are outside the rollback boundary.`

**共享的 library / asset 缓存不在回滚范围内** —— 因为它们被多个实例复用，
回滚会牵连其他实例。**这个边界划分是对的，IEML 应保留。**

**Rust 实现提示**：
- 用 `Result<T, DraftError>` + RAII 风格守卫（`Drop` 时自动 `abort`）
- 回滚记录用 `Vec<AppliedAction>` + `Vec` 逆序遍历
- 原子移动用 `std::fs::rename`（同分区内即原子）
- 路径校验用 `path.strip_prefix(instance_root)` 检查是否是后代

---

## ADR-024　整合包导出必须有文件黑名单（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：我们设计了「整合包管理」，但**完全没有考虑导出时哪些文件该排除**。
如果不排除，导出的整合包会包含：别人的存档、登录凭据、几百 MB 的 libraries、
各种启动器的私有配置。

**决定**：实现两张黑名单，**并明确「登录凭据绝不进整合包」为安全红线**。

**`MODPACK_BLACK_LIST` —— 约 50 条，导出时绝不包含：**

**日志与备份**
```
regex:(.*?)\.log
regex:.*\.dat_old$    regex:.*\.old$
```

**各类启动器的私有文件（关键）**
```
clientId.txt", "PCL.ini"                       ← PCL2
.hmcl", "backup", "pack.json", "launcher.jar", "cache",
"modpack.cfg", "log4j2.xml", "hmclversion.cfg",
"instance-game-settings.json"                  ← HMCL
launcher_profiles.json", "launcher.pack.lzma"  ← 旧官方启动器
launcher_accounts.json", "launcher_cef_log.txt", "launcher_log.txt",
"launcher_msa_credentials.bin", "launcher_settings.json",
"launcher_ui_state.json", "realms_persistence.json",
"webcache2", "treatment_tags.json"             ← 新官方启动器
```

> **★ 安全红线：`launcher_msa_credentials.bin` 被列入黑名单。
> 微软登录凭据绝不能进整合包。** IEML 必须遵守这条。

**游戏本体与缓存**
```
versions", "assets", "libraries", "natives", "native",
"$native", "$natives", "jars", "logs", "crash-reports",
"server-resource-packs", "command_history.txt",
regex:.*-natives
```

**加载器运行期缓存**
```
.fabric", ".mixin.out", ".optifine"    ← Fabric / OptiFine
irisUpdateInfo.json"                    ← Iris
modernfix"                              ← ModernFix
modtranslations"                         ← Mod 翻译
mods/.connector"                        ← Sinytra Connector
```

**其他启动器与平台**
```
manifest.json", "minecraftinstance.json", ".curseclient"  ← Curse
modrinth.index.json"                                        ← Modrinth
regex:.*\.BakaCoreInfo$"                                    ← BakaXL
```

**Mod 产生的数据**
```
asm", "backups", "TCNodeTracker", "CustomDISkins", "data",
"CustomSkinLoader/caches", "debug", ".replay_cache",
"replay_recordings", "replay_videos", "schematics",
"journeymap/data"
```

**`MODPACK_SUGGESTED_BLACK_LIST` —— 默认不勾但可选：**
```
fonts"                    ← BetterFonts
saves", "servers.dat", "options.txt"  ← 存档、服务器列表、游戏设置
blueprints"               ← BuildCraft
optionsof.txt"            ← OptiFine 设置
journeymap"               ← JourneyMap
optionsshaders.txt"       ← 光影设置
mods/VoxelMods"
```
> **注意 `saves/` 默认不导出** —— 整合包分享不该带别人的存档。

**匹配语义（必须精确实现）：**
```java
static boolean match(List<String> l, String fileName, boolean isDirectory) {
    for (String s : l)
        if (isDirectory) {
            if (fileName.startsWith(s + '/')) return true;      // 目录：前缀匹配
        } else {
            if (s.startsWith("regex:")) {
                if (fileName.matches(s.substring("regex:".length()))) return true;
            } else {
                if (fileName.equals(s)) return true;             // 文件：精确相等
            }
        }
    return false;
}
```
- **目录** —— `startsWith(s + "/")`，前缀匹配（目录及其全部内容）
- **文件** —— 非 regex 条目是**精确相等**，不是前缀
- 路径格式统一为 `rel_path_to_dir/`（目录带尾斜杠）或 `rel_path_to_file`，**与操作系统无关**

**我们的优势**：因为我们有 ADR-015 的「类型判定顺序」和资源包/光影包体系，
可以比 HMCL 做得更细 —— 比如把「资源包」「光影包」单独归为一类，
让用户在导出时能直接勾选「包含光影包」。

---

## ADR-025　整合包安装需要 Completion 阶段（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：我们对整合包的设计只到「识别 manifest + 创建实例」，
**缺了「装完再校验补齐」这一层**。

**证据**：HMCL 的整合包 Provider 里，**每个都有独立的 `*CompletionTask`**：
```
modpack/curse/     CurseCompletionTask(10KB)
modpack/modrinth/  ModrinthCompletionTask(6KB)
modpack/mcbbs/     McbbsModpackCompletionTask(19KB)
modpack/server/    ServerModpackCompletionTask(10KB)
```
配套还有 `ModpackCompletionException` / `ModpackConfiguration`。

**而且四条 Provider 线路并存：**
```
modpack/curse/     CurseInstallTask(14KB)
modpack/modrinth/  ModrinthInstallTask(12KB) ModrinthModpackExportTask(10KB)
modpack/multimc/   MultiMCModpackInstallTask(21KB) MultiMCInstanceConfiguration(13KB)
                   MultiMCComponents / MultiMCInstancePatch(16KB)
modpack/mcbbs/     McbbsModpackLocalInstallTask(9KB) McbbsModpackManifest(13KB)
modpack/server/    ServerModpackLocalInstallTask / ServerModpackRemoteInstallTask
```

**决定**：整合包安装分两阶段，**必须有 Completion 阶段**。

```
① Install 阶段 —— 按 manifest 下载并安装所有文件
② Completion 阶段 —— 校验完整性 + 补齐缺失 + 修正元数据
```

**Completion 阶段要做的事：**
1. 逐个校验 manifest 里列的文件是否存在、大小/哈希是否匹配
2. 缺失的重新下载；下载源已失效的给出警告而非静默失败
3. 写入 `modpack.config` 记录来源与版本（用于后续更新与「是否为整合包」判定）
4. 修正实例元数据（加载器版本、Java 需求等）

**支持格式（对齐 HMCL，按优先级）：**
| 格式 | 扩展名 | 备注 |
|---|---|---|
| Modrinth | `.mrpack` | 有公开 API，实现最简单，**优先支持** |
| CurseForge | `.zip` + `manifest.json` | 需要 API Key（开放问题） |
| MCBBS | `.zip` | 国内社区格式 |
| MultiMC | `.zip` | 结构复杂（`MultiMCInstancePatch` 16KB），**可延后** |
| 服务端包 | — | `ServerModpackLocalInstallTask` / `Remote`，可延后 |

**注意 HMCL 最近的一个变更**：commit `df52bc6` (2026-09-10)
「不再支持导出 MultiMC 整合包 (#4017)」——
说明 MultiMC 格式的导出是负担。**IEML 初始版本不必支持 MultiMC。**

---

## ADR-026　多源竞速与镜像表（★ 第六轮新增）

**日期**：2026-09-11
**状态**：待确认（源码研读结论）

**背景**：国内网络下直连 Mojang / Forge 官方源经常超时。

**决定**：所有下载实现「**多源竞速**」—— 同一资源配置官方源 + 镜像源，
并发请求，取最快返回的那个。

**PCL2 的实现（`DlSourceLoader`）：**
- 每个资源都有**官方源 + 镜像源**两条
- `DlSourceOrder` / `DlVersionListOrder` 决定优先级
- 由设置 `ToolDownloadVersion` 控制（`0` = 优先镜像 / `1` = 先官方 / 其他 = 自定义）

**镜像表（可直接作为 IEML 默认值）：**
```
https://bmclapi2.bangbang93.com/assets
https://bmclapi2.bangbang93.com/maven
https://bmclapi2.bangbang93.com/libraries
https://bmclapi2.bangbang93.com/mc/game/version_manifest.json
https://bmclapi2.bangbang93.com/optifine/versionList
https://bmclapi2.bangbang93.com/forge/minecraft
https://bmclapi2.bangbang93.com/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge
https://bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json
https://bmclapi2.bangbang93.com/fabric-meta/v2/versions
mod.mcimirror.top / mod.mcimirror.top/modrinth / mod.mcimirror.top/curseforge
```

**官方源（对照）：**
```
GET https://launchermeta.mojang.com/mc/game/version_manifest.json        (要求 Versions.Count >= 200)
GET https://optifine.net/downloads                                        (正则解析 HTML 表格)
GET https://files.minecraftforge.net/maven/net/minecraftforge/forge/index_<MC>.html
GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge
GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge   (1.20.1 legacy)
GET https://meta.fabricmc.net/v2/versions
GET https://dl.liteloader.com/versions/versions.json
```

**三条必须照抄的细节：**

**① Forge / Fabric / NeoForge 的库文件不走原版源。**
PCL2 源码明确注释「不添加原版源」：
```vb
If {"minecraftforge", "fabricmc", "neoforged"}.Any(Function(k) Original.Contains(k)) Then
    '不添加原版源
```
因为这些库**根本不在 Mojang 的源上**，加原版源只会白白浪费一次失败请求的等待时间。

**② Forge 的版本分类优先级 —— 只选 installer 分类。**
```
Case "installer"  → Proi = 2   ← 优先（能用 installer 自动装）
Case "universal"  → Proi = 1   ← 无法自动安装
Case "client"     → Proi = 0   ← 无法自动安装
```
PCL2 的 `LoadForgeGetError()` 会**跳过 `Category = "universal"` 或 `"client"` 的版本**，
因为它们无法自动安装。

**③ NeoForge 有硬编码的坏版本黑名单。**
排除了 `47.1.82` —— PCL2 源码注释：「这个版本虽然在版本列表中，但不能下载」。

> **现实世界的脏数据必须硬编码规避。** IEML 需要一张可维护的「已知坏版本」表。

**其他有用的常量：**
```
OptiFabric → CurseForge 项目 ID 322385
Fabric API 版本格式：0.92.2+1.20.1（+ 后绑定 MC 版本）
LiteLoader 文件名：liteloader-installer-<MC>-00-SNAPSHOT.jar（跳过 MC 1.5 / 1.6）
```

**竞速的实现要求：**
- 并发发起，**首个成功的胜出**，其余取消
- **失败要聚合报告**（不能只报最后一个错误）
- 单源超时必须有上限（建议 8–10 秒），否则一个卡住的源会拖慢整体
- 缓存命中时**跳过整个竞速流程**（见 ADR-008）

---

## ADR-027　整合包独立成一级入口（★ 第八轮新增，撤销 ADR 级别的旧判断）

> ### ⚠️ 本决策已被 [ADR-032](#adr-032导航采用正副级页面一级-4-项进入版本后整条侧栏替换) 撤销（第十三轮）
>
> 撤销后的做法：整合包回到「下载」页，作为第三个页签（游戏版本 / 加载器 / 整合包）。
>
> **为什么当初的理由仍然成立，结论却要改**：下面那张"三条路径操作模型不同"的表
> 至今是对的 —— 整合包确实是"挑一个包"而不是"配一套环境"。错的是**由操作模型
> 直接推出导航层级**这一步：操作模型的差异可以用**页签内部的说明文字**表达
> （下载页每个页签上方都有一句"这条路径在做什么"），而一级入口每多一个，
> 用户就要多回答一次"我该走哪条路"。用户想的是"我要装个东西"，
> 不是"我要走哪条操作模型"。
>
> 保留本条目是为了记住这条教训：**分类正确不等于层级正确。**

**背景**

第七轮曾把「整合包」从侧边栏合并进「下载中心」，作为第 3 个页签。用户随后指出
「**整合包单开一个选项**」，该方案被推翻。

**决策**

整合包**独立为一级入口**，与「下载中心」并列。下载中心只保留「游戏版本 / 加载器 / 下载队列」。

**理由：三条路径的操作模型不同**

| 路径 | 操作模型 | 用户在做的事 | 失败恢复 |
|---|---|---|---|
| 游戏版本 | **用户做一系列选择** | 选版本 → 选加载器 → 配 Java | 中断只需重来 |
| 加载器 | **用户做一系列选择** | 选目标版本 → 选加载器版本 | 中断只需重来 |
| 整合包 | **用户挑一个别人做好的结果** | 看描述 → 挑一个 → 确认 | 要**按清单续传** |

前两者是"配一套环境"，后者是"挑一个成品"。整合包里的版本、加载器、Mod 由作者在
`manifest.json` / `modrinth.index.json` 里定死，用户不需要（也不应该）去选——
这跟"引导用户做选择"是相反的交互范式。

**第二个理由：页签栏放不下整合包需要的东西**

整合包是唯一需要**封面、来源、Mod 数量、加载量提示、排序**的路径。
挤在页签栏里时，这些能力一个都放不下（第一版方案里整合包页签只有 4 张裸卡片）。

**代价与对策**

- 代价：多一个一级入口，导航项从 6 个变成 7 个
- 对策 ①：下载中心页签栏右侧常驻「**找整合包？→**」跳转按钮，作为兜底路径
- 对策 ②：两者在导航中相邻排列，符合"都是获取内容"的直觉
- 对策 ③：**组件复用，入口分离**——三者共用同一个 `.setup-panel` 配置面板、
  同一份约束规则、同一条安装流水线，只是入口位置不同

**沉淀出的两条通用规则**

1. **导航入口名必须等于页面 `h1` 标题**。第七轮的问题根源就是入口叫「整合包」、
   页面叫「下载中心」——用户看到的不是"叫法不同"，而是"功能被塞进了别的地方"。
2. **操作模型不同 → 导航层级不同**。判断是否需要拆开，不看"数据是不是同一类"，
   而看"用户在这个页面上做的事是不是同一类"。

**相关**：[`DESIGN_SYSTEM.md` 第 9 章](./DESIGN_SYSTEM.md)（两阶段修正记录）、
[`DESIGN_SYSTEM.md` 7.17](./DESIGN_SYSTEM.md)（三路径配置项对照）。

---

## ADR-028　实例设置与全局设置必须视觉区分（★ 第九轮新增）

**背景**

第九轮研读 PCL2 的版本设置模块（`PageInstanceSetup`）时发现：PCL2 的
**「全局设置」和「版本设置」在界面上长得几乎一模一样**——同样的分组、同样的控件、
同样的标签文字。于是用户在"我改的是全局还是这个版本"上极易搞混。

PCL2 自己也知道这个问题，用了**三重手段**来区分：

1. 入口名区分：左栏叫「**版本**设置」而不是「设置」
2. **设置页顶部常驻蓝色提示条**：
   > 这些设置只对该游戏版本生效，不影响其他版本。
3. 几乎每个字段的 ToolTip 都追加一句「若留空，则跟随**全局设置**的值」

**决策**

IEML 的实例设置页必须做到：

1. **入口名明确作用域** —— 叫「实例设置」，不叫「设置」（与侧边栏的全局「设置」区分）
2. **页面顶部常驻作用域提示条** —— 「以下设置只作用于 <实例名>，不影响其他实例」
3. **每个可继承字段标注继承来源** —— 值旁边显示「跟随全局」或「已覆盖」标签，
   而不是只给一个空的输入框让用户猜

**「跟随全局 / 已覆盖」是比 PCL2 更彻底的方案**

PCL2 的做法是"空值 = 跟随全局"，但**用户看不出"我是留空了还是删掉了"**。
IEML 改为**显式双态标签**：

```
内存分配        [跟随全局]  ●        ← 未覆盖
Java            [已覆盖]    ○ 17.0.10 ← 已覆盖，显示生效值
```

这样用户扫一眼就知道**哪些项被自己改过、哪些在跟全局走**。
配合已有的 `.changed` 标记（第 7.17 节）形成一套完整的"配置来源可见性"体系。

**顺带确立：修改实例隔离设置必须弹警告**

PCL2 在改「版本隔离」时会弹框，且文案里有**可逆暗示**：

> 调整版本隔离设置后，你需要游戏存档、Mod 等文件手动迁移到新的游戏文件夹中。
> **如果发现存档消失，把这项设置改回来就能恢复。**
> 如果你不会迁移存档，不建议修改这项设置！

这句话是打消恐惧的关键——它同时说了"会出什么事"和"怎么退回去"。
IEML 照抄此文案结构，但**取消时要回滚控件选择**（PCL2 用 `IsReverting` 静态标志
防止回滚再触发 `SelectionChanged` 死循环，这个细节必须一并实现）。

**相关**：[`LAUNCHER_SOURCE_STUDY.md` 13.1 / 13.2](./LAUNCHER_SOURCE_STUDY.md)、
[`DESIGN_SYSTEM.md` 7.17](./DESIGN_SYSTEM.md)。

---

## ADR-029　内存分配采用「按 Mod 数量估算 + 四阶段递减」算法（★ 第九轮新增）

**背景**

原设计的安装配置步骤里，「内存分配」只有一个滑块 + 一个默认值。
用户（尤其整合包玩家）不知道该给多少——给少了卡顿崩溃，给多了浪费。

**决策**

采纳 PCL2 的自动内存算法（源码依据见 `LAUNCHER_SOURCE_STUDY.md` 13.3）。

**第一步 · 按实例类型算四个目标值（GB）**

| 实例类型 | 最低 | T1 | T2 | T3 |
|---|---|---|---|---|
| **可装 Mod**（有加载器） | `0.5 + n/150` | `1.5 + n/90` | `2.7 + n/50` | `4.5 + n/25` |
| OptiFine 版本 | 0.5 | 1.5 | 3 | 5 |
| 原版 | 0.5 | 1.5 | 2.5 | 4 |

`n` = `mods/` 下 `.jar` / `.zip` / `.litemod` 文件数（与生效判定用同一套扩展名规则）。

**第二步 · 按当前可用物理内存四阶段递减比例分配**

| 阶段 | 区间 | 取用比例 |
|---|---|---|
| 一 | 0 → T1 | **100%** |
| 二 | T1 → T2 | **70%** |
| 三 | T2 → T3 | **40%** |
| 四 | T3 → T3×2 | **15%** |

任一阶段后可用内存 < 0.1 GB 立即停止；最后 `max(结果, 最低值)` 兜底，保留 1 位小数。

**为什么这个算法值得抄**

它的结构是「**先按"游戏需要多少"定锚，再按"机器还剩多少"打折**」——
而不是反过来（"物理内存的一半"是从机器出发，完全不管游戏需要什么）。
对整合包场景尤其准：300 个 Mod 时 T1 就已经是 4.8 GB，不会给出 2 GB 这种必崩的值。

**同时采纳的三个细节**

1. **分配值超过可用内存时**：UI 上按可用值展示，但**文字仍显示真实分配值并标注「(可用 x.x GB)」**
   —— 不骗用户，也不画出一个物理上不存在的条
2. **滑块值是"档位"不是 MB**，需分段映射到 GB；
   且**滑块上限随物理内存动态变化**（4 档公式，见源码研读 13.3）
3. **实时刷新用 1 秒定时器**（PCL2 用 `DispatcherTimer`），
   但**只有值真变了才启动动画**（`Math.Round(x, 5)` 后比较），避免每秒重动画

**IEML 的差异点：不做内存条可视化**

PCL2 用三个星号宽度的 `GridLength` 画横向内存条（已用 / 游戏分配 / 空闲），
视觉效果好但**占掉一整块纵向空间**，与极致轻量目标冲突。

IEML 改为**一行紧凑文本**：
```
已用 4.7 / 共 7.9 GB  ·  分给游戏 2.5 GB  ·  自动配置 ▾
```
信息量等价（三段都表达了），高度从 ~90px 压到 ~22px。

**相关**：[`LAUNCHER_SOURCE_STUDY.md` 13.3](./LAUNCHER_SOURCE_STUDY.md)。

---

## ADR-030　Java 选择采用四模式（★ 第九轮新增，扩充 ADR-013）

**背景**

ADR-013 定了「Java 自动获取走 Adoptium」，但只解决了"去哪下载"，
没解决"**怎么选**"。原设计的实例设置里只有一个 Java 下拉框。

**决策**

采纳 PCL2 的四模式（源码依据见 `LAUNCHER_SOURCE_STUDY.md` 13.5）：

| 模式 | 用户给什么 | 附带控件 | 适用场景 |
|---|---|---|---|
| **自动选择** | 什么都不用给 | 无（只显示结果提示条） | 默认，绝大多数人 |
| **按版本区间选择** | 一个区间，如 `[17.0, 25.0)` | 区间输入框（带 7 条校验） | 某些 Mod 需要特定 Java |
| **使用实例文件夹中的 Java** | 无需输入，放进去即可 | 提示条（可点击打开文件夹） | **整合包自带 Java** |
| **使用指定的 Java** | 从已扫描列表里选 | Java 下拉列表 + 导入/移除 | 多 Java 环境的老手 |

**三条必须实现的设计**

1. **「使用实例文件夹中的 Java」** —— 这一条价值最高。
   整合包作者经常把 Java 一起打包进版本目录，用户不需要懂任何 Java 概念。
   我们原设计完全没考虑这个场景。
2. **提示条四态配色**：查找中(蓝) / 未找到但会自动下载(黄) / 本地无且需手动放(红) / 已找到(蓝)。
   注意「自动模式下没找到」是**黄**不是红——因为这不是错误，启动时会自动下载。
3. **区间校验不只报错，还给出改法**：
   ```
   「右侧闭区间的意图并不明确。如果不想允许 Java 21，请改为 21)。
     如果想允许 Java 21，请改为 22)。」
   ```
   这是"错误提示"的更高形态——**不只说错，还给两条出路让用户选**。

**相关**：[ADR-013](#adr-013java-自动获取走-adoptium)、
[`LAUNCHER_SOURCE_STUDY.md` 13.5](./LAUNCHER_SOURCE_STUDY.md)。

---

## ADR-031　创建实例降为弹窗，下载中心只管「浏览与选择」（★ 第十轮新增）

**背景**

用户提出：**「创建实例和下载中心的功能高度重合」**。

这个判断是对的。第九轮结束时的实际状态是：

| | 创建实例（一级入口） | 下载中心 |
|---|---|---|
| 版本列表 | 9 行，含 `1.21.1 / 1.20.1 / …` | 5 行，含 `1.21.1 / 1.20.1 / …` |
| 加载器选择 | 三层结构（基础/附加/API） | 加载器页签 + `.setup-panel` |
| 配置项 | 实例名、Java、内存、版本隔离 | 实例名、Java、内存、版本隔离 |
| 起始动作 | 鼠标划过就切换选中 | 点「安装」展开配置面板 |

**四处几乎逐一对应**。而且下载中心那个 `.setup-panel` 里也摆了内存滑块，
与第九轮刚建好的「实例设置」页又重了一遍——**于是变成三处做同一件事**。

根因不是"哪里做多了"，而是**没分清"选择"与"配置"**：

- 「选哪个版本 / 哪个加载器」= **浏览与选择**，信息来源是远端列表，可以反复挑
- 「这个实例给多少内存 / 用哪个 Java / 开不开隔离」= **配置环境**，
  信息来源是本机状态，且**它是持续存在的**，不是一次性的

前者的自然归宿是「列表页」，后者的自然归宿是「设置页」。
而「创建实例」把两者缝在一起，于是它既像列表页（有版本列表）
又像设置页（有 Java/内存），必然两头都像。

**决策**

1. **「创建实例」不再是一级入口，降为弹窗**。
   从三个地方唤起：版本管理页右上「新建实例」、下载中心任意未安装版的行、主页的「创建实例」卡片。
2. **下载中心只管「浏览与选择」**：保留版本列表与加载器列表（供浏览、搜索、筛选），
   但任何一行的动作都只有两个出口——**新建实例（弹窗）** 或 **作用域路由**。
3. **删除下载中心里的两个 `.setup-panel`**（版本面板、加载器面板），
   以及它在页面级重复的内存滑块与实例名输入框。
4. **侧边栏从 8 个入口减到 7 个**，并按用途分成三组。

**理由一：创建实例是「从别处发起的一次性动作」，不是目的地**

用户不是在"打开启动器 → 我要去创建实例页"。
他是在**版本管理页看到某个版本**、或在**下载中心翻到某个版本**时才起念。
此时把人拽到另一个页面会切断来路，做完还得自己找回来。

弹窗做完即走，回到原地。这正是 PCL2 的做法（下载页点「安装」直接弹配置窗）。

**理由二：弹窗天然表达「一次性」，页面天然表达「持续存在」**

Java / 内存 / 隔离这些**是实例的属性，会长期存在**。
把它们放进一个"关掉就没了"的弹窗里，作为"创建时的填表"，是合理的；
但**它们的主要编辑入口必须是「实例设置」页**，因为用户日后是去那里改的。

所以弹窗里的高级选项只留**真正的全局项**（下载源），
Java 与内存显示为一句说明 + 一个「去实例设置」跳转——
**同一件事只在一个地方可编辑**（这条与 7.20 的"来源可见性"是同一套原则）。

**理由三：必须补上「作用域路由」，否则会把重合变成错误**

删掉下载中心的配置面板后会出现一个新问题：
用户点一个显示为「已安装」的版本，系统该怎么办？

- 默默开下 → 重复下载已有版本
- 默默新建实例 → 凭空多出一个重名实例（**这是最糟的结果**）

所以点击「已安装」的行时，**必须先问**：

```
⚠ Minecraft 1.20.4 已经装过了，你想做什么？
   给已有实例装加载器 / 改设置  |  另建一个新实例  |  取消
```

前者跳到「实例设置」，后者开弹窗。
**这个路由是"下载中心与创建实例不重合"的最终保证**——
两个功能仍然相邻，但用户在岔路口被明确告知它们通向不同结果。

**理由四：侧边栏 8 项已经超载，该分了**

8 个并列入口对 220px 侧边栏偏多，且"创建实例 / 版本管理 / 下载中心"三项
在视觉上是平的，但在用途上不是。改为三组：

```
游戏   主页 / 版本管理 / 创建实例(弹窗) / Mod 管理 / 实例设置
获取   下载中心 / 整合包
其他   设置
```

**代价与对策**

| 代价 | 对策 |
|---|---|
| 「创建实例」不再是页，用户可能找不到 | 版本管理页右上主按钮、主页卡片、下载中心每行按钮，共 3 处入口 |
| 弹窗空间比页面小（860px vs 全宽） | `modal-lg` 860px + 左右分栏（版本列表 262px / 配置自适应），内部各自滚动 |
| 旧的 `go('create')` 链接会落到空页 | 保留 `page-create` 壳，显示"已改为弹窗"+ 两个去处按钮 |

**沉淀出的通用规则（第三条已在 ADR-027 记过，这里补一条）**

> **"选择"与"配置"要分开：选择放列表页，配置放设置页。**
>
> 判断方法：问「这个东西在用户不操作时，是否依然存在？」
> - 版本、加载器、整合包 → 不存在。它们只是一次选择的**输入**
> - Java、内存、隔离 → 存在。它们是实例的**属性**
>
> 前者属于列表页（可以来回挑），后者属于设置页（可以随时改）。
> 把两者缝在一个页面里，页面必然两头都像，也就必然与两边都重合。

**相关**：[ADR-005](#adr-005版本隔离策略按需隔离三段判定)（隔离是属性而非选择）、
[ADR-028](#adr-028实例设置与全局设置必须视觉区分)（同一套"作用域必须说清"的思路）、
[ADR-027](#adr-027整合包独立成一级入口--第八轮新增撤销-adr-级别的旧判断)（操作模型决定导航层级）、
[`DESIGN_SYSTEM.md` 第 9 章](./DESIGN_SYSTEM.md)、[`DESIGN_SYSTEM.md` 7.17](./DESIGN_SYSTEM.md)。

---

## ADR-032　导航采用「正副级页面」：一级 4 项，进入版本后整条侧栏替换

**日期**：2026-09-11（第十三轮）
**状态**：已确认（**撤销 ADR-027 的结论**，并纠正 ADR-020 / ADR-028 的落地方式）
**触发**：用户反馈——"我倒是喜欢 PCL 的正副级页面，因为它方便，现在这个 UI 特别繁复"

**决定**：导航只有两层，且第二层**替换**第一层：

```
一级（侧栏永远这 4 项）      二级（进入某个版本后，整条侧栏换成这 4 项）
  启动                         ← 返回版本列表
  版本列表                     概览 / 设置 / Mod 管理 / 日志
  下载                         （底部常驻「启动这个版本」）
  设置
```

- **整合包从一级入口收回「下载」页的第三个页签**（撤销 ADR-027）
- **删除全局实例切换器**。原来顶栏有一个 340px 的实例下拉，一级页全程挂着它，
  既占位置又制造"我现在改的是哪个实例"的持续疑问。现在：**打开哪个就编辑哪个**
- 二级页用面包屑（`版本列表 › 星河整合包`）+ 侧栏「返回」按钮双重出路

**理由**

1. **入口数量就是复杂度**。第 6~12 轮的导航长这样：主页 / 版本管理 / 下载中心 /
   整合包 / 实例设置 / 日志 / 设置 —— 7 个一级入口，其中 4 个与"当前实例"有关
   却平级摆放。用户停在一级页时无法回答一个最基本的问题：**我现在操作的是哪个版本？**
2. **PCL2 的两级结构解决的是"层级混淆"而不是"层级不够"**。副级页面把「当前实例」
   这个上下文**变成导航本身**（侧栏顶部就是版本名），不再需要额外的切换器去表达它。
3. **概览页的职责要收窄**。ADR-020 时期的概览页同时展示值与动作，结果是"设置页的
   只读副本"。现在它是**纯动作页**（补全文件 / 查看日志 / 图标与名称 / 复制 /
   删除），所有可改的值都在「设置」里 —— 一个值只有一个地方能改。
4. **整条替换 > 并排两栏**。并排就成了"左侧两栏导航"：218px 的侧栏塞不下，
   而且用户分不清哪一栏是全局、哪一栏属于当前版本。替换后"我在第几层"一目了然。

**代价与对策**

| 代价 | 对策 |
|---|---|
| 一级页少了一个「实例设置」入口，老用户会去找 | 版本行整行可点（单击进概览）、行内「⋯ → 打开设置」、概览页「改」链接，共 3 条路 |
| 从版本设置回不到"另一个版本的设置"，必须先返回 | 这是**故意的**。跨版本跳转正是"不知道自己改的是谁"的来源；返回一步的成本远低于改错版本的成本 |
| 整合包不再是独立入口，可能更难发现 | 启动页空状态与版本列表空状态都直接给「浏览整合包」按钮，并预选到该页签 |
| 一级/二级侧栏要维护两套 | 共用 `.sidebar` / `.nav-item` 一套样式，只有内容不同（见 `AppShell.tsx` 的单文件分支） |

**沉淀出的通用规则（补记第 4 条）**

> **导航层级应当表达"作用域"，而不是表达"功能分类"。**
>
> 判断方法：把每个一级入口念一遍，问「它说的是我，还是当前这个东西？」
> - 「下载」「设置」→ 说的是启动器本身 → 一级
> - 「Mod 管理」「日志」→ 说的是某一个版本 → 二级
>
> 混在一起时，用户永远无法确定自己改的是全局还是某个版本。

**相关**：[ADR-027](#adr-027整合包独立成一级入口--第八轮新增撤销-adr-级别的旧判断)（被本决策撤销）、
[ADR-020](#adr-020主页即当前实例概览)（概览页定位被本决策收窄）、
[ADR-028](#adr-028实例设置与全局设置必须视觉区分)（作用域的视觉区分，本决策沿用）、
[ADR-033](#adr-033界面的繁复来自留白与层级而非功能数量)（同一轮配套的减法）、
[`DESIGN_SYSTEM.md` 第 9 章](./DESIGN_SYSTEM.md)。

---

## ADR-033　「繁复」来自留白与层级而非功能数量：密度收敛与三条硬约束

**日期**：2026-09-11（第十三轮）
**状态**：已确认
**触发**：同上——"现在这个 UI 特别繁复"

**决定**：本轮做三类减法，并把它们写成硬约束。

**一、留白收敛（不是删功能，是删空转的空间）**

| 位置 | 改前 | 改后 | 理由 |
|---|---|---|---|
| 内容区内边距 | 24 / 32 / 40 | 20 / 24 / 32 | 1366×768 上原值吃掉近半屏高度 |
| 卡片内边距 | 16 | 12 / 16 | |
| 卡片标题 | 无分隔线，下方 12px | 加 1px 分隔线，下方 4px | 分组靠线而非靠空白，省高度且更清楚 |
| 卡片堆叠间距 | 16 | 12 | |
| 页头 | 24/0/16 + 上移 24 | 20/0/12 + 上移 20 | |
| 启动页 | hero 大卡 + 6 项统计侧栏 + 实例网格（约 620px，17 个可点目标） | 一个下拉 + 一个大按钮 + 一行状态（3 个可点目标） | 那 620px 换来的信息量是 0 |

**二、删除整个功能块（而不是把它们折叠起来）**

- 顶栏实例切换器（见 ADR-032）
- 主页的「我的实例」网格 —— 实例列表在「版本列表」里，主页只用下拉选一个
- 主页的 6 项统计侧栏 —— 内存/Java/PID 合并成启动按钮下面的一行
- 一级页的「版本隔离」卡与「备份回滚」卡 —— 那是**某个版本**的属性
- 一级页左侧筛选 + 右侧面板的两栏布局 —— 一行放得下全部信息
- 设置页的「界面缩放 / 毛玻璃 / 粒子效果」—— 没有实际作用或无法验证的装饰项

**三、三条硬约束（写进 DESIGN_SYSTEM，违反就是 bug）**

> ① **一个值只能有一个地方能改。** 概览页只允许出现"动作"与只读事实；
> 凡是可改的值，都必须有一个明确归属的页面（全局 → 设置；单版本 → 二级设置）。
>
> ② **内联 SVG 图标必须显式给 width/height（CSS）。** 图标不带尺寸属性时，
> 浏览器会按"视口面积开方"猜一个值（实测拿到 29.86px），表现为页签被图标撑大、
> 文字被挤成两行；而 flex 子项的默认 `flex-shrink:1` 又会把图标压成 0 宽。
> 已在 `tokens.css` 里用 `svg { flex-shrink: 0 }` 兜底，各组件仍须写明尺寸。
>
> ③ **派生状态必须随上下文清空。** Mod 列表是"当前打开的版本"的派生数据，
> 切换版本时必须在 reducer 里清空 —— 否则概览页显示 0 个、Mod 管理页显示 25 个，
> 同一个版本两个数字。这类"残留值"比没有值更有害。

**代价**

收敛密度意味着单屏能看到更多行，但视觉呼吸感下降；本项目的用户是"装完就玩"的
普通玩家，一次操作能看完比"页面很高级"更重要。视觉上的补偿靠**分组线 + 层级
字号**（页面标题 20px / 卡片标题 14px / 正文 13px / 提示 12px），而不是靠空白。

**相关**：[ADR-032](#adr-032导航采用正副级页面一级-4-项进入版本后整条侧栏替换)、
[`DESIGN_SYSTEM.md` 第 9 章与 7.x](./DESIGN_SYSTEM.md)。

---

## ADR-034　下载引擎：单源尝试 + 失败换源（**修正 ADR-026 的「多源竞速」**）

**日期**：2026-09-12
**状态**：已实施（含 18 项新单元测试 + 真实下载实测）

**背景**：ADR-026 决定"同一资源配置官方源 + 镜像源，并发请求，取最快返回的那个"。
实装之后发现三件事：

1. **竞速不加速，反而分薄带宽。** 两条连接共享同一条出口带宽，总吞吐并不会
   变成两倍；对于小文件（资源文件大多几 KB），多一次握手反而是净损失。
2. **竞速让镜像吃双倍并发。** BMCLAPI 对并发敏感，实测会被回 429；
   而竞速是"每个文件都双发"，等于把限流风险乘以二。
3. **真正该复用的是源的健康状态。** 一个源刚刚失败过 / 刚被限流过，
   下一个文件不该再拿它当首选 —— 竞速模型里没有地方记这件事。

**决定**：改成 PCL2 实际使用的策略 —— **单源尝试 + 失败换源 + 健康记忆**。

```
① 候选源列表   mirror::candidate_urls：官方 + 镜像（两者不同时）
                加载器 maven（fabric/forge/neoforged/quiltmc）**只给镜像候选**
② 排序         source::candidates_with：期望源 +1000 分，再加源健康分；
                处于 429 冷却的源直接沉底
③ 尝试         按顺序逐个试；成功 → 记成功（含字节数与耗时）；失败 → 记失败并换下一个
④ 单文件重试   候选全挂 → 指数退避（0.6s 起、封顶 10s、±20% 抖动）重来，最多 3 轮
⑤ 批次补下     本轮失败的文件按 1/4 并发 → 单线程补下，最多 3 轮
```

**四条照抄 PCL2 的细节：**

| PCL2 | IEML 实现 | 为什么 |
|---|---|---|
| `DlSourceLoader` 动态优先级 | `SourceManager::preferred()` | 「官方连得上就优先官方」被做成**按历史成败动态决定**，而不是每次花 4 秒试探 |
| 429 → 降并发 + 延迟重试 | `note_rate_limited`：冷却 `2^(n-1)` 秒（封顶 60s）+ 并发减半（下限 4） | 被限流还按原并发猛冲只会把冷却越推越长 |
| 失败降级到单线程 | `download_batch` 的补下轮次 | 老服务器/限流服务器扛不住并发，降下来反而能过 |
| 校验失败 → 删文件重下 | `download_one` 第 ① 步 | 坏文件必须删掉，否则下次被当成"已下载" |

**分片下载：段级续传（这是本轮真正的提速点）**

- 阈值 4 MB 以上才分片；段数 = ⌊大小 / 2 MB⌋ 夹在 1..=8
- 段大小下限**取 2 MB 而不是 PCL2 的 1 MB**：一次 Range 往返的握手开销
  在小段上占比过高，少几段反而更快
- ★ **每段独立落盘（`.part.N`）+ 段计划（`.part.chunks` 记 total 与每段边界）**。
  续传时逐段按长度校验，只补缺的段；段计划与本次边界不一致就整份作废。
  改前是"分片一失败就 `remove_file(part)` 从头来"——39 MB 客户端 jar
  下到 38 MB 被掐、重连后从 0 开始，验收标准里的「断网重连后能续传」根本不成立。

**顺带修掉的两个静默错误**

**① 续传（206）不看 `Content-Range`**，直接 append 到已有 `.part` 后面。
中间隔代理/CDN 时可能拿到偏移有偏差的 206，拼出来的文件"看着完整、内容错位"，
最后只在 SHA1 校验时表现为"莫名不匹配"。现在校验 `Content-Range` 起始偏移，
对不上（或不合规地没给）就从头下。

**② 同内容去重把"复制副本"和"下载原件"放进了同一个并发池**，
复制会在原件写到一半时去读它；更糟的是 —— **资源文件是内容寻址的**
（`assets/objects/<前两位>/<sha1>`），同一个 hash 被两个名字引用时
（实测 1.20.1：3598 个条目里有 23 个 hash 被两个名字共用），
两个名字算出的是**同一个磁盘路径**，于是"复制副本"实际执行的是
`copy(X, X)` —— 自己复制到自己，Windows 直接回 `os error 32`。

> 实测表现极具误导性：**固定 23 个文件失败**，错误是
> `写入文件失败：另一个程序正在使用此文件`，补下 3 轮全部失败，
> 看起来完全像杀毒软件在锁文件。实际原因写在 `dedup_pass` 的注释里：
> 同 hash **且同路径** → 什么都不用做，直接丢弃（文件早就下好了）。

现在批次是严格三段式：**去重拆解 → 网络并发下载（含降并发补下）→ 本地复制**。

**禁止事项（对齐 docs/docs/pcl-download-reference 11.3）**：不抄 VB.NET、不用 PCL 命名
（`NetFile`/`LoaderDownload`/`DlSourceLoader` → `DownloadTask`/`download_batch`/`source`）、
不自研 HTTP/TLS/JSON/压缩/哈希、不整读大文件。

**实测验收**（1.20.1 全量）：52 个核心任务（77 MB，含 39 MB 客户端 jar 走分片）
+ 3598 个资源文件 —— **0 个失败、0 轮补下**，客户端 jar SHA1 与原版一致，
无残留 `.part` / 段文件。对应 23 个新增单元测试（分片规划、段计划复用、
退避抖动、`Content-Range` 解析、源健康与冷却排序、去重同路径回归）。

**代价**：单源尝试意味着"这个源能用但很慢"时不会自动换快的（除非它失败）。
这是有意的取舍 —— 换源判据用"失败/限流"而不是"速度"，否则会陷入反复切换。
速度问题交给分片并行解决。

**相关**：[ADR-026](#adr-026多源竞速与镜像表-第六轮新增)（被本 ADR 修正）、
ADR-008（缓存命中跳过整个下载流程）、`src-tauri/src/net/source.rs`、`download.rs`。

---

## ADR-035　natives 的解压层级必须从版本 JSON 推导，不能写死

**日期**：2026-09-12
**状态**：已实施（含 4 项单元测试 + 真机 JVM 验证）

**背景**：实测启动 Minecraft **26.2** 时游戏刚起就崩：

```
java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll
	at org.lwjgl.system.Library.loadSystem(Library.java:177)
	at com.mojang.blaze3d.platform.NativeLibrariesBootstrap.loadLWJGLSystem(…)
```

磁盘上 `lwjgl.dll` **明明存在** —— 就在实例的 `natives/` 根目录里
（我们逐个解压 12 个 natives jar 的产物，14 个 dll 平铺着）。
而 26.2 的版本 JSON 自带的 JVM 参数是：

```text
-Djava.library.path=${natives_directory}/java
-Djna.tmpdir=${natives_directory}/jna
-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl
-Dio.netty.native.workdir=${natives_directory}/netty
```

**注意第一行指向的是 `${natives_directory}/java` 这个子目录。**
JVM 只在那一个目录里找 `lwjgl.dll`，而我们把它放在了上一层 → 找不到 → 崩。
（另外三条是 jna / lwjgl / netty **自己的临时目录**，由各库自行解压填充，
与 `java.library.path` 无关 —— 这就是 `natives/` 下会同时出现
`java`、`jna`、`lwjgl`、`netty` 四个子目录的原因。）

**决定**：

1. 新增 `metadata::natives_java_subdir(&VersionJson) -> Option<String>`：
   从版本 JSON 的 JVM 参数里读 `-Djava.library.path=${natives_directory}/<X>`，
   取出 `<X>`；取不到（老版本通常没有这条）就返回 `None` = 平铺。
2. 解压时**两个位置各解一份**：老的 natives 根目录 + 推导出的子目录。
   成本只是几个 MB 的复制，换来"同一套代码同时兼容两种布局"，
   不必按版本号猜（版本号猜法一定会被下一个世代再打一次脸）。
3. 子目录**必须**来自版本 JSON 的占位符，不能写死 `"java"` ——
   Mojang 换运行时（`java-runtime-epsilon` → 下一代）时这个目录名是会变的。

**回归测试**：
- `net::metadata::tests::detects_natives_java_subdir_on_modern_versions`（26.2 的 4 条参数）
- `old_versions_have_no_natives_subdir`（老版本平铺行为不变）
- `natives_subdir_handles_backslash_and_root`（反斜杠 / 就是根目录）
- `ignores_java_library_path_without_placeholder`（别人的绝对路径不能误判）
- `tests/natives_layout.rs`：复用启动器自己的 `build_command`，
  断言 `java.library.path` 指向的目录里**确实有** `lwjgl.dll`，
  然后真起 JVM 3 秒确认没有 native 加载错误

**教训**：**版本 JSON 自带的东西，一个都不能忽略。**
我们把 `arguments.jvm` 当"模板"整体替换占位符后就用，从没检查过它**声明了哪些目录**。
凡是 JSON 里出现的路径声明，都是启动器运行时的硬约束。

**相关**：ADR-034（下载引擎）、`src-tauri/src/net/metadata.rs`、
`src-tauri/src/commands_real.rs::prepare_spec`。

---

## ADR-036　跨 IPC 的契约分两类：**透传的必须 camelCase，手工映射的各自约定**

**日期**：2026-09-12
**状态**：已实施（含 5 项线格式回归测试）

**背景**：用户实机报错 —— 装完版本后提示

```
安装失败，invalid args `store` for command `save_instances`: missing field `memory_mb`
```

根因：`Instance` 这条契约是**原样透传**的（前端 `Instance` → `invoke('save_instances')`
→ Rust `InstanceStore`），而前端 `src/domain/types.ts` 里全是 camelCase
（`memoryMb` / `mcVersion` / `memorySource`），Rust 惯例是 snake_case。
于是 `memory_mb` 永远收不到 → **实例一个字节都存不下去**。

**这不是个例，是一类**。梳理后发现契约分两种，必须分别对待：

| 类型 | 例子 | 约定 |
|---|---|---|
| ① **原样透传**（前端把对象直接 post 过去 / 后端 payload 直接给前端用） | `Instance` / `InstanceConfig` / `LoaderCapabilities` / `download_sources` | **必须 camelCase** —— Rust 侧加 `#[serde(rename_all = "camelCase")]` |
| ② **桥接层手工映射**（`bridge/tauri.ts` 里一个字段一个字段地转） | `DownloadProgress` / `ModFile` / `MachineInfo` / `InstalledSummary` | 各自约定即可，TS 接口直接写 snake_case 更省事（如 `PlanPreview.total_files`） |

**决定**：

1. `Instance`、`InstanceConfig`、`LoaderRecord`、`AddonRecord`、`BridgeRecord`、
   `LoaderCapabilities`、`LoaderOption`、`AddonOption` 一律 `rename_all = "camelCase"`。
2. 前端会写、后端不读的字段（`createdAt` / `lastPlayedAt` / `totalPlaySeconds`）
   在 Rust 侧标 `#[serde(default)]` —— **反序列化时多余字段会被忽略，缺字段才会报错**，
   所以真正危险的是"前端不写、Rust 必填"的那种，不是反过来。
3. `download_sources` 改成手工拼 camelCase（`rateLimited` / `bytesPerSecond` /
   `coolingSeconds`）—— 直接透传 `SourceReport` 会让前端那三个值全是 `undefined`。
4. **加线格式回归测试**：`domain::types::wire_format` 与
   `commands_real::wire_tests`，用**前端真实的载荷形状**（照抄 TS 定义）做往返断言，
   并显式断言"不能混进 snake_case 字段"。

**扫过一遍全量清单**：Rust 侧共 60 个带下划线字段的结构体。
`tools/diag/diag-wire-fields.mjs` 逐个比对前端是否按 camelCase 读，
结果确认**只有上述几个透传契约有问题**，其余（`ManifestSummary` / `VersionDetail` /
`PlanPreview` / `InstalledSummary` / `Modrinth*`）的 TS 接口本身就写的是 snake_case，
与 Rust 一致，属于正常的第 ② 类。

**教训**：**跨 IPC 边界的字段名，编译器抓不到。**
两边都用 TypeScript 时 `tsc` 会报错，但一边是 Rust、一边是 TS，
`call<SomeType>()` 里的类型参数只是**断言**，不是校验 —— 它不会替你验证后端真的这么发。
所以：透传契约必须两侧同名 + 有往返测试；或者干脆别透传，老老实实手工映射。

**相关**：ADR-011（校验只实现一次）、`src-tauri/src/domain/types.rs`、
`src/bridge/tauri.ts`、`tools/diag/diag-wire-fields.mjs`。

---

## ADR-037　「没查到」与「确认没有」是两种结论，**不许合并**

**日期**：2026-09-12
**状态**：已确认
**背景**：用户报「Forge 的版本是有最新版，可是启动器说没有；而且如果点击了一个说没有
Forge 的版本，还会导致有 Forge 的版本说没有 Forge」。

**根因**（两层，都要修）：

1. **数据层**：`fetch_loaders(kind=forge)` 走的是 BMCLAPI 的
   `maven/net/minecraftforge/forge/maven-metadata.xml`，而那个文件是
   **2022-02 就停更的旧快照**（实测 `lastUpdated=20220221144517`，最新 MC 只到 1.18）。
   按 `1.20.1-` 前缀过滤的结果是**空数组** —— 而空数组在 UI 上的语义是
   「**确认**该加载器没有这个版本」。
2. **表达层**：接口返回一个**裸数组**，「HTTP 失败/解析失败」被前端 `catch` 成
   `[]`，与"确实没有"完全同形；界面于是把 Forge 置灰并写「没有 Forge 版本」。

**决定**：

1. 加载器清单接口返回结构体，带 `status: "ok" | "error"`。
   **只有 `status === "ok"` 且 `versions` 为空才表示"确认没有"**；
   `status === "error"` 只能显示成「这次没查到，可重试」，并给出重试按钮。
2. 加载器版本号改从**官方 build API** 取（Forge 走 BMCLAPI 的
   `/forge/minecraft/{mc}`，官方 maven 与 BMCLAPI 的 maven-metadata 依次兜底；
   NeoForge 走官方 maven-metadata），并加**内容校验**：可疑内容不落缓存。
3. 前端的加载器可用性用三态（`loading` / `ok` / `error`）：`loading` 与 `error`
   **都不做任何自动决策**（不置灰、不自动切换成原版）。查不到时允许用户重试，
   也允许用户选择纯原版继续装。
4. 缓存必须带**下载源**（`{source}:{mcVersion}`），且**只缓存成功的结果** ——
   失败的查询被缓存住，会让"这一次没查到"变成"接下来一直说没有"。
5. 切版本时**先清空再查询**（`querySeq` 世代号丢弃迟到的响应），
   并把 `base` / `addons` 一起清掉，避免上一个版本的结论"代言"新版本。

**教训**：**"空结果"是最容易被误用的状态。** 任何可能空的接口，都必须区分
「查询失败」与「查询成功但结果为空」；否则 UI 一定会把前者显示成后者，
而启动器对用户说的每一句「不支持」都是一次**错误的禁用**。

**相关**：ADR-004（不可用必须给具体理由）、ADR-020（加载器识别靠库坐标）、
`src-tauri/src/net/metadata.rs`、`src/components/InstallComposer.tsx`、
`src-tauri/tests/live_loaders.rs`。

---

## ADR-038　加载器 / 附加组装的「装没装上」必须**实时读盘**，不缓存结论

**日期**：2026-09-12
**状态**：已确认
**背景**：同一句用户诉求的另一半 ——「这个对应关系应该是你得实时监测他有没有包括
其他加载器和高清修复，这是一样的，能装就是能装，不能装就是不能装」。

**决定**：

1. 新增 `domain::loader_trace`，作为**唯一的**加载器痕迹判据：
   按**库坐标**（`net.minecraftforge:forge` / `net.neoforged:neoforge` /
   `net.fabricmc:fabric-loader` / `optifine:OptiFine` / `com.mumfrey:liteloader`）
   与主类判定，**不靠文件名或目录名猜**。
   判定顺序固定：先 NeoForge 再 Forge（`neoforge` 的坐标里含子串 `forge`）。
2. `fetch_version_manifest` 的每一行、以及新的 `detect_installed_loaders` 命令，
   都调用它并**当场读盘**；界面（版本列表每一行、下载页加载器面板）直接显示
   「已装 Forge 47.4.23 + OptiFine HD_U_I6」这样的**事实**。
3. 启动时的加载器定位（`resolve_loader_version_id`）与"加载器痕迹守卫"
   （`prepare_spec`）改用同一份判据 —— 以前三处各写各的，必然漂移：
   目录名兜底扫描、`text.contains("forge")`（会把 NeoForge 认成 Forge）、
   以及实例记录里的 `loader.version` 与磁盘目录名不一致。
4. 加载器版本号优先从**库坐标**里读（`net.minecraftforge:forge:1.20.1-47.4.23`），
   目录名只作兜底；读不出来就显示"版本未知"，**绝不编造**。

**教训**：**"用户记得住的事实"不该由启动器维护成状态，而应该每次都去问磁盘。**
凡是能从磁盘推出来的东西，一旦被缓存成状态，就一定会出现"界面说的和盘上不一样"。

**相关**：ADR-020、ADR-037、`src-tauri/src/domain/loader_trace.rs`、
`src-tauri/src/commands_real.rs`。

---

## ADR-039　加载器/附加组件的版本清单：**五种来源并行**，OptiFine 走 BMCLAPI 的 JSON

**日期**：2026-09-12
**状态**：已确认

**背景**：加载器清单以前是前端**串行**发 4 次 IPC，而且 OptiFine
（用户口中的"高清修复"）**根本没有自动来源** —— 界面上写着"版本清单尚未接入
自动查询"，静态表里那几条还是手抄的。

**实测数据**（本机）：

| 来源 | 接口 | 耗时 |
|---|---|---|
| Forge | BMCLAPI `/forge/minecraft/{mc}`（+ 官方 maven 兜底） | 3.9 s |
| NeoForge | 官方 maven-metadata.xml（+ BMCLAPI 兜底） | 2 s |
| Fabric | `meta.fabricmc.net` 590 KB | 4.5 s |
| Quilt | `meta.quiltmc.org` 892 KB | 6.7 s |
| OptiFine | BMCLAPI `/optifine/versionList` 78 KB（**结构化 JSON**） | 0.7 s |

**决定**：

1. 新增 `modloader::fetch_available_loaders`：**`tokio::join!` 并行**拉五种来源，
   实测总耗时从串行约 18 秒降到 **5.9 秒**（由最慢的一个决定）。前端改为**一次 IPC**。
2. OptiFine 走 BMCLAPI 的**结构化 JSON**，**不抓 HTML**：官方 downloads 页是
   203 KB 的 HTML、随改版就失效；JSON 少一个解析器、多出 `forge` 兼容要求字段。
3. 单个来源失败**不影响其余** —— 那一种的 `error` 有值，其余照常返回。
   `error` 为空 + 列表为空才是"确认没有"（延续 ADR-037）。
4. 清单请求加**总超时**（默认 75 秒，可用 `IEML_LOADER_TIMEOUT_SECS` 调）：
   重试与 `connect_timeout` 都管不住"连上了但一个字节不回"。
   为什么不设 30 秒：一次查询内部有两轮尝试（镜像 3 次 + 官方 3 次，带退避），
   实测 30 秒会在并行拉五个来源时误杀 Fabric。
5. 检测函数收敛成一个：`domain::loader_trace::detect_installed_modloaders`，
   **含 `inheritsFrom` 递归**、大小写不敏感、版本号取不到时给 `"unknown"`（不编造）；
   JSON 坏了返回 `ModLoaderError::InvalidJson`，**与"纯原版（空列表）"分开**。

**★ 顺带纠正了一个写错的认知**（这是本轮最有价值的发现）：

`loader_caps` 的表里写着「OptiFine 从 1.20.5 起不再支持」，测试还把这条断言固化了。
真机数据是：

| MC | OptiFine |
|---|---|
| 1.20.5 | 0 条（这一版确实被跳过） |
| 1.20.6 | 有**预览版**（HD U J1 pre17/pre18） |
| 1.21.1 | 已有**正式版**（OptiFine_1.21.1_HD_U_J1.jar），需 Forge 47.2.18 |

于是：静态表里"表里没有"不再写成"未发布"，而是如实说"要联网确认，这不代表没有"；
`1.20.6` / `1.21.1` 的表项改为**有** OptiFine；相关测试与 e2e 断言按事实重写。
**教训：把"我记得"写进断言，比不写测试更危险 —— 它会把错误锁死。**

**相关**：ADR-003（OptiFine 的安装机制另算）、ADR-037、
`src-tauri/src/modloader.rs`、`src-tauri/src/net/metadata.rs`、
`src-tauri/tests/live_loaders.rs`。

---

## ADR-040　内置表**退出**"能不能装"的判定；加载器清单靠后台按版本真实查询

**日期**：2026-09-12
**状态**：已确认（**修正 ADR-037 没覆盖到的一条旧路径**）

**背景**：用户报「什么叫 Forge 没发布 26.2 版本，PCL 是有的」。

**根因**（是我的实现缺陷，不是数据问题）：

`getLoaderCapabilities` 有三级回退：① 在线清单 → ② 内置表 → ③ 推断。
内置表只有 10 个版本、**没有 26.2**；在线清单那一瞬间没拿到（超时/失败/网络掐断）时，
代码掉进 ③，把 **"我不知道"写成了"尚未发布"** —— 对 Forge、NeoForge、Quilt 三个都这么说。

而 ADR-037 已经立过规矩：「没查到」与「确认没有」不许合并。这条规矩只落在了
在线那条路径上，**内置表这条老路径没执行**。实测数据：BMCLAPI 的
`/forge/minecraft/26.2` 有 **14 个 build**（65.0.0 … 65.1.3），26.1.2 有 21 个。

**决定**：

1. **内置表不再是"能不能装"的判据**。它给出的"没有"一律标 `confirmed: false`，
   界面只能说"内置参考里没有，以在线清单为准"，**不许说"未发布"**。
   没有在线数据时，所有加载器一律 `available: false` + `confirmed: false`。
2. 新增 `LoaderOption.confirmed`（TS 与 Rust 两侧同名，ADR-036）：
   `true` = 在线清单这种权威来源给的结论；`false` = 推断/未知。
   `validateCombination` 的报错措辞跟着它走：未确认时说"无法确认，请重试"，
   **不说"没有发布"**。
3. 新增 `domain/loader-catalog.ts` —— 加载器目录：
   · 只装**真实查到**的结果，按 MC 版本缓存（1 小时新鲜期，localStorage 持久化）；
   · 同一版本的并发调用合并成一次请求；
   · **没有条目 = 还没查到**，与"确认没有（空数组）"可区分；
   · 后台按优先级预热：**已装版本 → 常用版本 → 清单顺序（新版本在前）**，
     并发 3、单次会话上限 120 个版本，剩下的点开时现查。
4. 前端加载器查询全部走目录：命中即**即时**出结果（不用等那 5.9 秒），
   后台预热完成时通过订阅**自动刷新**当前版本，用户不用再点一次。

**为什么不一次查完 900+ 个版本**：900 × 5 个接口 = 4500 个请求，
既打爆上游也让用户干等。所以按"用户真正会碰到的顺序"预热 +
点开即查，两者共用同一份目录。

**与 ADR-008（元数据全量缓存）的关系**：那条针对的是**版本清单**（一个请求拿全量）；
加载器清单是**每个 MC 版本各一组接口**，必须按需 + 预热，不能全量。

**相关**：ADR-004、ADR-037、ADR-038、
`src/domain/loader-caps.ts`、`src/domain/loader-catalog.ts`、
`src-tauri/src/domain/loader_caps.rs`。

---

## ADR-041　"做了但没法用"要当成一类缺陷来体检：**界面上每句承诺都必须是代码真做到的**

**日期**：2026-09-13
**状态**：已确认

**背景**：用户要求「检查整个项目，有没有还没做的功能、做了但没法用的」。
于是对整个仓库做了两份系统审计（后端命令面 / 前端控件面），
**逐条把控件的值追到 Rust 命令注册表**再下结论 —— 只看前端会产生大量误报
（`width`/`height`/`offlineUsername`/`downloadSource`/`concurrentDownloads` 其实都是真被消费的）。

**审计结果**：`Backend` 契约 16 个方法两侧实现齐全；55 个注册命令全部存在、
51 个调用点全部命中 —— 但"做了但没法用"有**五类**：

| 类别 | 实例 | 处置 |
|---|---|---|
| 控件完全没接 | 崩溃弹窗「可以这样做」按钮**连 onClick 都没有** | 每个 `FixKind` 接真实动作 |
| 假成功 | Mod 单条启用/禁用只弹 toast；TaskCenter「重试」只改本地状态；「继续」对整合包静默失效 | 改走真实路径，失败如实报 |
| 前端传了、后端丢掉 | 窗口标题（`LaunchSpec` 里根本没这个字段） | 补字段 + 按版本决定传 `--title` |
| 做不到却承诺 | 删除说"存档一起删"（磁盘没动）；重置说"会自动备份"（没有备份）；隔离说"共用目录"（从不共用）；"旧文件移入回收站"（直接覆盖） | 删除/复制**真的动磁盘**；文案改为事实 |
| 静默失败 | MSA 登录用 `openPath` 开 URL（必然被拒）；Java 列表从不加载；`removeJava`/`scanJava`/`stop` 无 catch | 改用 `openUrl`、加 catch、进页面即加载 |

**决定**：

1. **界面文案 = 代码行为**。凡写"会自动 X / 已 X / X 会被删除"的地方，要么真做，要么改成事实。
   本轮删掉/改正 8 处假承诺。
2. **前端传的值必须有后端接收**：新增 `LaunchRequest.window_title` / `LaunchSpec.window_title`；
   `--title` 只在 1.14+ 追加（更早的版本没有这个参数）。
3. **破坏性操作必须真的作用在磁盘上**：新增 `delete_instance_files` / `copy_instance_files`
   （带 `instances/` 越界校验），按结果报告字节数；复制**跳过 `natives/`**
   （启动时按当前架构重新解压，复制可能带错版本的 dll）。
4. **"读失败"与"本来就没有"必须分开**：Java 列表读不出来时显示"读不到，可重试"，
   而不是"还没下载过 Java"。这与 ADR-037 是同一条原则。
5. **全局偏好必须落盘**：新增 `load_prefs` / `save_prefs`（原子写）。
   以前偏好只在内存里，`accountUuid` 一起丢 —— 用户登录过正版，第二天启动变成离线 "Player"。
   读取时逐字段校验（`sanitizePrefs`）：`prefs.json` 是纯文本，用户可能手改过。

**教训**：**"没接上的控件"比"没做的功能"更糟** —— 用户点一下，什么都没发生，
他只会怀疑自己点错了。所以体检的验收标准不是"功能清单都实现了吗"，
而是"**界面上每一个能点的地方、每一句承诺，背后都有真实行为**"。

**相关**：ADR-004、ADR-037、`src/pages/CrashModal.tsx`、
`src/components/TaskCenter.tsx`、`src-tauri/src/commands.rs`。

---

## ADR-042　删除默认**进系统回收站**；文案与行为同源，回收站不可用时不静默降级

**日期**：2026-09-13
**状态**：已确认

**背景**：参照 PCL2 的源码行为（源码研读第 13 章）：它的删除走系统回收站，
只有用户**按住 Shift 点删除**才是真删。而本项目当时的删除全是 `remove_dir_all`
/ `remove_file` —— 一键到底、没有后悔药。

但比"没有回收站"更糟的是**反过来的谎话**：ADR-041 修好磁盘删除之后，
三处确认框仍然写着「此操作不可撤销」，而那时它其实是一次性永久删除；
如果只加回收站而不改文案，就会变成另一种谎话 ——
用户以为文件和存档没了，其实还在回收站里躺着，白担心一场。

**决定**：

1. **默认进系统回收站**（`trash` crate），`permanent = true` 才是真删。
   涉及：删实例（含存档）、删 Mod、删已下载的 Java。
2. **文案与行为由同一处代码生成**：新增 `src/domain/delete.ts`，
   `describeDelete({ what, items, bytes, note, intent })` 一次返回
   `{ permanent, message, doneVerb }`。界面**不许**自己拼删除确认文案 ——
   否则"说什么"和"做什么"迟早会分叉，这次分叉就产生了两句假话。
   - 默认分支文案必须出现"回收站"，且**禁止**出现"不可撤销/无法恢复"；
   - Shift 分支文案必须出现"Shift"与"永久删除/找不回来"。
3. **Shift 是唯一入口**：`deleteIntent(e)` 从点击事件读 `shiftKey`。
   键盘/程序调用没有事件时按默认（回收站）处理 —— 危险方向必须显式表达。
4. **回收站失败不静默降级**：`trash::delete` 报错时（网络盘、精简版 Windows），
   Rust 侧把错误原样抛出并提示"按住 Shift 再点一次"，
   前端**弹出二次确认**"要改成永久删除吗"，用户同意才真删。
   绝不允许"移回收站失败 → 偷偷直接删" —— 那就等于把用户的文件永久删了
   还不告诉他。
5. **例外：清理下载缓存仍为永久删除**，且界面写明原因（几百上千个碎文件
   进回收站会把回收站塞爆）。它是可重新下载的缓存，不是用户数据。
6. **大小/清单来自真实数据**：算不出实例大小时就**不写大小**，不编数字
   （`describeDelete` 只在 `bytes > 0` 时输出该行）。

**教训**："可撤销"不是纯技术能力，而是**产品承诺**。承诺一旦写进文案，
它就和实现绑定了 —— 所以两者必须由同一个函数产生，靠 code review 守住
是不现实的（这次就是三处各写一遍、三处都写错）。

**相关**：ADR-041、`src/domain/delete.ts`、`tests/delete-semantics.test.mjs`、
`src-tauri/src/commands_real.rs`（`delete_path`）、`src-tauri/src/commands.rs`
（`delete_instance_files` / `remove_java`）、`src/state/AppContext.tsx`。

---

## ADR-043　"自动装前置包"必须真的联网验过；"慢"只有在**有别的路可走**时才是放弃的理由

**日期**：2026-09-13
**状态**：已确认

**背景**：ADR-041 发现「将自动安装 Fabric API」是句假话（代码里根本没这一步），
补上之后又攒了两个只有**真跑一次网络**才能发现的错：

**① slug 是照着包名猜的，猜错了。** `install_api_library` 里写
`quilted-fabric-api` —— Modrinth 上这个 slug 是 **404**，真名是 **`qsl`**
（Quilted Fabric API / Quilt Standard Libraries，project id `qvIfYCYJ`）。
后果特别隐蔽：404 在下载层被当作"网络不好"重试三轮，最后只说一句
"自动安装失败"，用户看到的是"Quilt 整合包永远缺前置包"。
**② 慢速检测会把"没有替代地址"的连接判死。** Modrinth 的 CDN 地址只有一个候选
（镜像表推不出替代地址），单连接实测 ~230 KB/s，低于 `SLOW_ABS_FLOOR_BPS`（320 KB/s）。
15 秒窗口一到就判"坏源"、中断重试、再判一次 —— 三轮烧完重试预算，
最后报 `所有下载源都失败了（试过 1 个）`。实测把 2 MB 的 Fabric API
判成"装不上"，而这个源一直是好的，只是没有 BMCLAPI 那么快。

**决定**：

1. **slug 映射收进一个函数** `api_library_project(base) -> (slug, kind)`，
   并新增一条**联网测试** `api_library_slugs_all_resolve`：逐个 slug 打
   `GET /v2/project/{slug}`，失败信息里直接写"这个 slug 在 Modrinth 上是 404"。
   映射错一次就红一次，不会再靠人去记。
2. **慢速检测加前提**：`SpeedWatch.switchable` = "这次重试轮里还有别的候选地址"。
   `switchable=false` 时慢速检测**只记录、不中断** ——
   慢一点的文件照样下得完，而中断只会把重试预算烧光然后报失败。
   有替代地址时行为完全不变（仍然是修"下载被限速"那条 bug 的判据）。
3. **整合包路径也要装前置包**，但**作者带了就绝不动**：
   `MrpackIndex::has_fabric_api()` 检查清单里有没有 API 的 jar。
   前缀必须包含 **`qfapi`** —— 实测 Quilt 的发布名是
   `qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar`，
   只认 `fabric-api` 前缀会让 Quilt 整合包里被塞进第二个 API 实现。
4. **共用逻辑抽成普通函数**（`install_api_library_for(mods_dir, …)`）而不是复制一遍：
   命令 `install_api_library` 与 `modpack_install` 都调它，这样**集成测试能直接调**
   （`State` 参数去掉了，只剩一个目录）—— "能被测试直接调用"是这次能发现上述两个 bug 的前提。
5. 补装失败**不算安装失败**：游戏本体已经装好，如实说明补了什么、没补上什么
   （`ModpackInstallResult.api_library` / `ApiLibInstall.note`）。

**新增测试**：`src-tauri/tests/live_apilib.rs`（6 条联网测试，`pnpm test:apilib`）
+ `MrpackIndex::has_fabric_api` 单元测试 + `SpeedWatch` 的
`slow_source_is_not_abandoned_when_there_is_nothing_to_switch_to`。

**教训**：**"查不到"和"查错了"在日志里长得一模一样**。
slug 404、网络失败、版本号抄错，最后都汇成一句"自动安装失败" ——
所以每一步都要能被单独验证：先测 slug 存不存在，再测版本查不查得到，
再测文件下不下得来。把链路切成可以用一条命令分别否证的小段，
比写一句"已尽力"有用得多。

**相关**：ADR-039、ADR-040、ADR-041、`src-tauri/tests/live_apilib.rs`、
`src-tauri/src/net/download.rs`、`src-tauri/src/modrinth.rs`。

---

## ADR-044　实例可以"启动即进服"；服务器地址**全角标点自动换半角**，但改了什么要说出来

**日期**：2026-09-13
**状态**：已确认

**背景**：源码研读第 13.4 节记下 PCL2 两条实践，本项目一条都没有：

1. **实例设置里能填服务器地址**，启动后自动进服 ——
   对"整合包测试服客户端""只玩一个服"的用户是刚需，每次手点多人游戏很烦。
2. **输入框里自动把全角标点换成半角**（PCL2 的 `TextChanged`）。
   中文输入法下 `mc.example.com：25565` 是**极其自然**的手误，
   而游戏只认半角 —— 报错信息里两个地址看起来**一模一样**，
   用户完全查不出问题在哪。这一条消灭一整类"我明明输对了却连不上"。

**决定**：

1. **新增实例级设置 `joinServer`**，启动时拼成 `--server <host> --port <N>`。
   ★ 原版客户端要的是**分开的两个参数**，不是 `host:port`；
   没写端口时**不传 `--port`**，交给游戏用默认 25565（不替用户猜）。
2. **解析规则只写两处、且互相钉住**：前端 `src/domain/server-address.ts`
   （为了"边输边纠正"），Rust `game::launch_args::parse_server_address`
   （为了真正拼命令行）。两边各有一张**逐字相同**的规则表测试
   （`server_address_matches_the_frontend_rule_table` /
   `规则表与 Rust 侧逐条一致`）—— 分叉时立刻可见。
   分叉的症状极隐蔽：输入框下面写着"会连 A"，实际参数里是 B。
3. **改了就要说**：输入框下方明确显示「已自动把全角字符换成半角：<最终地址>」，
   而不是悄悄改掉用户写的东西。三种语气各有语义：
   `fix`（改了，需要他知道）/ `ok`（会连到哪里）/ `warn`（有问题，要拦住）。
4. **端口写坏时只丢端口，绝不换目标**：`host:abc` 解析成只有主机名，
   并在提示里写明"地址会原样传给游戏，不会自动改成默认端口"。
   宁可让游戏连默认端口，也不要悄悄连到另一个服务器上 ——
   那才是真的灾难（用户会在一个陌生服里发现自己什么权限都没有）。
5. 顺带给错误**留出路**：提示行带一个「只用主机名 `<host>`」按钮，
   一键把自己写坏的端口去掉（设计系统第 13 章：给理由，也给路）。
6. 空输入 = 没设置（不是错误）；`--server` / `--port` 在没配置时
   **一个都不许出现在命令行里**（否则游戏会去连空地址）。

**相关**：ADR-001、`src/domain/server-address.ts`、`tests/server-address.test.mjs`、
`src-tauri/src/game/launch_args.rs`、`src/pages/InstanceSetup.tsx`、
`docs/LAUNCHER_SOURCE_STUDY.md` 第 13.4 / 14 节。

---

## ADR-045　学 PCL2 的下载引擎：**"慢"和"死"分开**、"上游有"和"我们能装"分开

**日期**：2026-09-13
**状态**：已确认

**背景**：用户把 PCL 源码放到 `E:\PCL-main`，要求逐项对照下载引擎与
"实时获取模组加载器状态"，把 PCL 更好的地方学过来。
逐行读完之后有 **7 处**是我们在原理上缺失的，其中 3 处**直接对应用户报过的症状**。
完整对照表见 `docs/PCL_DOWNLOAD_ENGINE_STUDY.md`。

### 一、"慢"与"死"是两件事，我们混成了一件（已在上一轮修了一半）

PCL2 的判据（`ModNet.vb:1025`）是"数据包间隔 > 5 秒**且**这一窗速度 < 1 KB/s"——
`DeltaTime > RealDataCount` 换算出来就是 **1 KB/s**，几乎只抓"死连接"。

我们上一轮把绝对地板定在 **320 KB/s**（比它高 320 倍），而实测
Modrinth CDN ~230 KB/s、mcimirror ~146 KB/s —— 正常速度全被判成"坏源"。
上一轮用 `switchable`（有没有别的路）堵住了最坏情况，但**判据本身仍然过严**。

**决定**：新增 `SpeedWatch::dead()`，阈值照抄 PCL2（`DEAD_SILENCE = 5s`、
`DEAD_MIN_BPS = 1024`），并且**与 `switchable` 无关**：

| | 判据 | 有没有备用地址重要吗 |
|---|---|---|
| **死** | 静默 ≥ 5 秒 且 < 1 KB/s | **不重要** —— 一个字节都不回来就该掐，否则白占并发槽位与 300 秒总超时 |
| **慢** | 低于地板 且 低于该源历史成绩的 1/3 | **重要** —— 没有别的路时绝不断连（慢文件照样下得完） |

### 二、服务端宣告的文件大小必须校验

PCL2 要求 `FileSize - DownloadStart = ContentLength`，不一致就整条连接判失败。
我们只校验了 `Content-Range` 的**起始偏移**，没校验**总大小** ——
文件被换掉时会拼出一份"长度正确、内容错位"的文件，最后只表现为 SHA1 失败。

**决定**：新增 `parse_content_range_total()`，与任务记录的 `size` 比对，
不一致就丢掉 `.part` 从头下，并明确报出"服务端上的文件大小已变（记录 X，实际 Y）"。

### 三、Modrinth / CurseForge 只有一条路（用户报的"下载慢"根因之一）

PCL2 的 `DlSourceModGet` 把这两个域的 API 与 CDN **整批改写**到 mcimirror。
我们一条都没做 —— 于是这两个域在候选列表里**永远只有一个地址**，
慢、被限流、CDN 边缘挂住时没有任何退路。
实测就是这样把 2 MB 的 Fabric API 判成"装不上"的。

**决定**：新增 `mirror::mcimirror_url()`（六条改写规则，逐条实测过），
但**刻意与 PCL2 相反地把镜像放在第二位**：
本机官方 230 KB/s 比镜像 146 KB/s 快，跟 PCL2 一样默认走镜像会拖慢所有人。
所以它是**兜底候选**，只在官方失败时被用到。
API 侧新增 `net::get_text_third_party()`（官方优先、失败换镜像、
**404 不换**——404 换过去还是 404，而 `is_definitely_absent` 要用它）。

### 四、★★ "上游有"和"我们能装"必须分开（这是用户最在意的那条）

用户原话：「**能装就是能装，不能装就是不能装**」。
读 PCL2 的 LiteLoader 支持时发现我们这边有一个**更严重的同类缺陷**：

LiteLoader 在本项目里**只在文档与静态表里存在** ——
* 静态表标着 1.7.10 / 1.12.2 可用；
* `addon_compatibility` 放行「1.12.2 + Forge + LiteLoader」；
* `loader_trace` 能认出已装的 LiteLoader；
* **但 Rust 侧没有任何安装实现**（`run_loader_installer` 只认 forge / neoforge）。

于是：用户勾上 LiteLoader → 点安装 → 界面报成功 → 实例记录里多一条
`LiteLoader` 附加组件 → **磁盘上什么都没发生**，启动后这个组件不存在。

**决定**：`AddonOption` 增加两个字段，把两个问题分开回答（Rust 与 TS 各一份）：

| 字段 | 回答的问题 | LiteLoader 现状 |
|---|---|---|
| `exists` | 上游发布过这个 MC 版本的吗？ | **true**（1.7.10 / 1.12.2 上确实有） |
| `implemented` | **IEML 自己实现安装了吗**？ | **false**（只有识别，没有安装） |
| `available` | 能勾选吗？（= `exists && implemented`） | **false** |

界面据此显示「**没做安装**」而不是含糊的"不可用" ——
因为用户唯一需要知道的是"该等它发布，还是该换个启动器装"。
`combination.rs` 的 LiteLoader 分支现在**第一句**就说"我们没做"。
`addon_install_implemented()` 是唯一判据，两边各有一条测试守着
（Rust `nothing_unimplemented_is_marked_available` /
JS `任何"没实现"的附加组件都不许标成可用`）。

**代价**：三处旧测试原本断言 `available === true` / `ok === true` ——
它们**钉住的正是那个 bug**。已改成断言正确的语义，并在注释里写清为什么改。

### 五、★★ NeoForge 1.20.1 的 maven 坐标（用户能直接撞上的下一个"启动器说没有"）

PCL2 `ModDownload.vb:831`：
```vb
Dim PackageName As String = If(Inherit = "1.20.1", "forge", "neoforge")
```
**1.20.1 及更早的 NeoForge 发布在 `net/neoforged/forge` 名下**，1.20.2 起才改。
我们一律拼 `neoforge` —— 1.20.1 上装 NeoForge 会 404。

**决定**（三层，可靠度递减）：
1. 用 BMCLAPI 列表里服务端自带的 `installerPath`（`BmclNeoforgeBuild::installer_url()`）——
   坐标这种事不该由我们猜；
2. 兜底按 **MC 版本段**拼（边界就是 1.20.1，照抄 PCL2）；
3. 只有版本号时看有没有 `1.20.x-` 前缀。

**联网实测抓到两个我自己写错的版本**（`src-tauri/tests/live_neoforge.rs`）：
* 只按"版本号第一段 < 20 → forge"判是错的 —— 1.20.1 段的 `1.20.1-47.1.105`
  剥掉前缀后是 `47.x`，与 1.21 段的 `47.x` 长得一样但坐标不同；
* 只把**目录**改成 `forge/`、文件名仍写 `neoforge-…` 会 **404** ——
  实测真实文件名是 `forge-1.20.1-47.1.85-installer.jar`，**文件名也跟着包名走**。

### 六、其余四项记录在案，本轮不做

`get_text` 的三段式超时（10s / 30s / 4s + 429 睡 10s）、
大文件下载前的磁盘空间预检、加载器清单的错峰竞速（3s / 6s 递进）、
下载管理器的动态增线程。完整清单见对照文档第 4 节。

**相关**：ADR-004、ADR-037、ADR-040、ADR-041、ADR-043、
`docs/PCL_DOWNLOAD_ENGINE_STUDY.md`、`src-tauri/src/net/download.rs`、
`src-tauri/src/net/mirror.rs`、`src-tauri/src/domain/loader_caps.rs`。

---

## ADR-046　"偏好会持久化"这句话**从来没被验证过**：启动基线要写一次，写失败要说出来

**日期**：2026-09-13
**状态**：已确认

**背景**：用户问「你重新编译 exe 了没」。核对产物时顺手看了一眼
**真实运行过的数据目录** `%APPDATA%\IEML`：

```
cache           2026/9/13 18:55:17
instances       2026/9/12 19:16:02
java            2026/9/11 17:05:10
logs            2026/9/12 21:58:03
shared          2026/9/12 22:01:21
instances.json  2026/9/13 22:24:32     ← 刚才那次运行写的
（没有 prefs.json）
```

`cache/` 里躺着 22:24~22:26 新写的 `fabric_loaders_*.json`、`forge_versions.json`、
`version_manifest.json` —— 说明**那次运行确实是新版**。
但 **`prefs.json` 根本不存在**。

**根因**（`src/state/AppContext.tsx` 的落盘 effect）：

```ts
if (!prefsLoadedRef.current) {
  prefsLoadedRef.current = true;
  return;          // ← boot 后的第一次直接返回，什么都不写
}
```

原本的意图是对的（"别用默认值覆盖刚读出来的用户设置"），但副作用是：
**用户只是打开启动器、什么设置都没改、然后关掉 —— `prefs.json` 永远不会被创建。**
于是"偏好会持久化"这条链路，在"不改任何设置"的路径上从未真正跑过一遍；
真出问题（目录没写权限、命令名写错、序列化失败）时，用户看到的是
"设置改完重启就没了"，而**日志里一个字都没有**（那个 `.catch(() => {})` 是空的）。

**决定**：

1. **boot 之后立即写一次**（基线）。此时 `state.prefs` 已经是"磁盘值合并后的结果"，
   写回去是幂等的 —— 既不会覆盖用户设置，又让整条读→写链路**每次启动都真的跑一遍**。
2. **写失败不再静默**：`prefsSaveFailed` 进入 context，设置页顶部显示一条
   「设置存不进磁盘 —— 这次会话有效，重启就会丢」+ 具体原因，
   并顺带 `console.warn`。这与"读失败 ≠ 一个都没下过"是同一条原则。
3. **验收方式**：跑一次启动器，`%APPDATA%\IEML\prefs.json` 必须出现。

**教训**：**"有代码"不等于"跑过"**。
`savePrefs` 命令、`prefs.json` 路径、`sanitizePrefs` 校验都写好了，
测试也全绿 —— 但没有任何一条测试会去问"没改设置的那条路径写了没有"。
真正的证据在**用户机器上的数据目录**里，不在测试报告里。
以后每加一条"会持久化 / 会落盘"的承诺，都要顺手列一眼真实目录。

**相关**：ADR-041、`src/state/AppContext.tsx`、`src/pages/SettingsPage.tsx`、
`src-tauri/src/commands.rs`（`load_prefs` / `save_prefs`）。

---

## ADR-047　"有 Forge/NeoForge 的版本说没有"：**过滤条件比接口本身更危险**

**日期**：2026-09-13
**状态**：已确认

**背景**：用户报「**有 Forge 和 NeoForge 的版本，说没有这些**」，并让照着 PCL 的做法查。

第一件事是**把"接口有没有数据"和"我们返回什么"并排打出来** ——
新增 `src-tauri/tests/live_forge_diag.rs`（`pnpm test:forge`），
逐版本输出「接口 N 条 → 我们 M 条」。结果一目了然：**接口全都有数据，是我们过滤掉了。**

### 一、★ NeoForge 的 `-beta` 过滤（真凶，一次砍掉 200+ 个可选版本）

`neoforge_normalize` 原来有一行 `.filter(|v| !v.ends_with("-beta") && !v.ends_with("-alpha"))`。
实测（2026-09-13，BMCLAPI `/neoforge/list/{mc}`）：

| MC 版本 | 接口条数 | 其中 `-beta` | 我们（旧） | 我们（现在） |
|---|---|---|---|---|
| 26.2 | 88 | 57 | 31 | **88** |
| 26.1 | 18 | **18** | **0 ← "没有 NeoForge"** | **18** |
| 1.21.9 | 17 | **17** | **0 ← 同上** | **17** |
| 1.21.11 | 45 | 42 | 3 | **45** |
| 1.20.6 | 125 | 100 | 25 | **125** |

**NeoForge 对新 MC 版本的正常发布流程就是先发 `-beta`**（长期停留在 beta，
玩家用的就是这些）。丢掉它们等于"新版本永远没有 NeoForge"。
更糟的是：**空数组的语义是"确认没有"** —— 界面据此把 NeoForge 置灰并说"未发布"，
而且这条**自信的错误结论**会被缓存 12 小时（前端 localStorage 还有一份）。

**决定**：保留后缀。它既是真实产物名的一部分
（`neoforge-26.2.0.87-beta-installer.jar`），也是用户需要知道的信息。
排序改为**正式版排在预发布前面**（`compare_version_desc`）。

### 二、Forge 1.7.10 的产物名少了分支后缀（"列得出来、装不上"）

maven 里的真实名字是 `1.7.10-10.13.4.1614-1.7.10` —— **`-1.7.10` 是构建分支**。
我们只输出 `10.13.4.1614` 去拼 URL → **404**。
PCL2 的对应处理（`DlForgeVersionEntry.New`）：1.7.10 且第 4 段 ≥ 1300 时拼上分支。

实测：`1.7.10-10.13.4.1614-1.7.10` → 200 ✅ ／ `1.7.10-10.13.4.1614` → 404 ❌。
顺便**不能无脑拼**：1.12.2 的 `branch` 就是 `1.12.2`，但产物名**不带**它。
所以判据照抄 PCL2（只有那个版本段 + build ≥ 1300）。

### 三、预发布 MC 版本要用 `_` 段（PCL2 的 #4057）

PCL2 `ModDownload.vb:746` 把 MC 版本里的 `-` 换成 `_` 再打接口，
注释点名了 issue #4057（Forge 1.7.10-pre4）。实测：
`/forge/minecraft/1.7.10-pre4` → **0 条**；`/forge/minecraft/1.7.10_pre4` → **10 条**。
★ 光换 URL 还不够 —— **比对 `mcversion` 时也要归一**（接口回的是 `1.7.10_pre4`），
否则就是"接口有 10 条、我们返回空"。

### 四、只看接口说"有产物"的 build

BMCLAPI 的每条 build 带 `files`（`category` = installer/universal/client）。
PCL2 正是靠它分类的（`ModDownload.vb:753-778`），更早的版本甚至什么都没有
（PCL 直接跳过）。我们现在也看这个字段，但 **`files` 为空时放行** ——
接口不给这个字段时不能因此把整批判死。

### 五、★★ 缓存里存的是**结论**，所以解析规则改了必须换缓存名

修好解析规则之后还有一个坑：用户机器上那份
`neoforge_list_26.1.json`（内容是**空数组**，语义是"确认没有"）还能活满 12 小时，
前端的 localStorage 目录还有另一份 —— "我修好了"和"用户看到修好了"差了半天。

**决定**：新增 `CACHE_VERSION`（Rust 的缓存文件名加 `v2_` 前缀）+ 前端
`KEY` 升到 `ieml.loaderCatalog.v2`。
**规则：凡是改了"从接口数据得出什么结论"的代码，就把它 +1。**
两边各有一条测试守着这个数字。

### 实测结果（`pnpm test:forge`，5/5 通过）

```
Forge   26.2   接口 14 条  → 我们 14 条，最新 65.1.3
Forge   1.7.10 接口 163 条 → 我们 163 条，最新 10.13.4.1614-1.7.10
NeoForge 26.1  接口 18 条  → 我们 18 条，最新 26.1.0.19-beta   （修之前是 0 条）
NeoForge 1.21.9 接口 17 条 → 我们 17 条，最新 21.9.16-beta     （修之前是 0 条）
Forge   1.7.10-pre4 → 10 个版本（修之前报"没查到"）
列出来的最新版逐个 HEAD 探测安装器 → 全部 HTTP 200
```

**教训**：**过滤条件比接口本身更危险。**
接口出错会报错，而过滤条件出错会**静默地返回一个很小的数字或空数组** ——
而空数组在我们的语义里是"**确认没有**"，是一句自信的假话。
所以每一条"从原始数据挑出可用项"的规则，都必须能用**真实接口数据**证明
"它没有丢掉应有的东西"（这就是 `live_forge_diag.rs` 存在的理由）。

**相关**：ADR-037、ADR-040、ADR-045、`src-tauri/tests/live_forge_diag.rs`、
`src-tauri/src/net/metadata.rs`、`src/domain/loader-catalog.ts`、
`docs/PCL_DOWNLOAD_ENGINE_STUDY.md` 第 2.2 / 2.3 节。

---

## ADR-048　"1.12.2 装不下来"：**natives-only 的库不该去下载一个不存在的 jar**

**日期**：2026-09-13
**状态**：已确认

**背景**：用户贴出的报错很具体：

```
有 1 个文件下载失败（已自动重试 3 轮），例如：库 jinput-platform-2.0.5：
所有下载源都失败了（试过 2 个）：mojang: HTTP 404 …；bmclapi: HTTP 404 …
https://libraries.minecraft.net/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5.jar
```

**先怀疑网络，但两个源都 404 就不像网络问题了。** 于是把 1.12.2 的真实
版本 JSON 拉下来看那一条库（实测数据）：

```json
{ "name": "net.java.jinput:jinput-platform:2.0.5",
  "downloads": { "classifiers": {
      "natives-windows": { "path": "…-natives-windows.jar", … },
      "natives-linux":   { … },
      "natives-osx":     { … } } },
  "natives": { "windows": "natives-windows", … },
  "extract": { "exclude": ["META-INF/"] } }
```

**它根本没有 `downloads.artifact`** —— 那个
`jinput-platform-2.0.5.jar` **在世界上不存在**。
实测四个仓库全部 404（Mojang 官方 / BMCLAPI / Forge maven / Maven Central），
**存在的只有 `…-natives-windows.jar`**（155 179 字节，200 OK）。

**根因**：`Library::download_url()` 的最后一条兜底是
「没有 artifact 就**用 maven 坐标拼一个** `libraries.minecraft.net/<path>`」。
这条兜底对 Fabric 那种"只有 `url` 基址 + 坐标"的写法是必需的，
但对"只有 classifiers"的 natives 条目就是**凭空造了一个不存在的地址** ——
然后必然 404、必然重试三轮、必然整个安装失败。

更糟的是：它还会被**塞进 classpath**（虽然文件不存在），
于是即使忽略下载错误，启动时也会因为 classpath 里有个不存在的 jar 而炸。
`scan_classpath` 也会把它报成"库文件缺失"，让用户在「补全文件」里
**永远**看到一个消不掉的缺失项。

**决定**：

1. 新增 `Library::has_artifact()`：
   * `downloads` **缺失** → `true`（Fabric 的写法，不是"没有主 jar"）
   * `downloads.artifact` **有** → `true`
   * `downloads` 有、`artifact` 为空 → **`false`**（没有主 jar）
   ★ 刻意**不**看 `classifiers` 是否为空：Minecraft 官方启动器里
   classpath 与 natives 是**两条独立列表**，有 natives ≠ 有主 jar。
2. 下载规划里：`has_artifact() == false` 的库**不下载主 jar、不进 classpath**，
   只走 `natives` 字段那条分支（用 `downloads.classifiers` 下 natives）。
   若它连 `natives` 字段都没有 → 整条跳过。
3. `scan_classpath` 同样跳过它们 —— 否则"补全文件"永远报缺失。

**实测验证（`IEML_TEST_VERSION=1.12.2 pnpm test:fresh`）**：

```
进度最后停在：37/37
✅ 安装成功：库 33 个、资源 0 个、重试 0 轮、修复 0 个
```

顺便看到一个**好的**副作用（同一次实测的日志）：

```
[IEML/download] 服务端文件大小变了（任务记录 208338，服务端 146）
  → 丢掉本地残留从头下：…/jinput-2.0.5.jar
```

BMCLAPI 在 64 路并发下给 `jinput-2.0.5.jar` 回了一个 **146 字节**的响应
（多半是限流页面）。ADR-045 刚加的那条"服务端宣告的大小必须与任务记录一致"
当场把它拦下来了 —— 以前这种响应会被写成 146 字节的文件、
然后在校验阶段失败、再整份重下。**新加的护栏第一次跑真实安装就生效了。**

**教训**：**"兜底"要区分"我不知道地址"和"这个文件不该存在"。**
拿坐标拼地址是个好兜底，但它的前提是"这个坐标**应该**有产物" ——
而 `downloads` 字段的存在与否，恰恰就是在回答这个前提。

**相关**：ADR-026、ADR-045、`src-tauri/src/net/metadata.rs`（`has_artifact`）、
`src-tauri/src/net/installer.rs`（下载规划与 `scan_classpath`）、
`src-tauri/tests/live_forge_diag.rs`、`src-tauri/tests/fresh_install.rs`。

---

## ADR-049　按 PCL2 的路子做网络优化：**错峰竞速、每源超时、限流页检测、大文件先下**

**日期**：2026-09-13
**状态**：已确认

**背景**：用户报「mc 下载速度降了好多，体验不佳；模组加载器查询在线清单速度也很慢，
甚至还有连不上而导致查不出来的问题」。要求按 PCL2 的做法优化。

**做法：先测，再改。** 新增两个基准测试，把"慢"变成数字：

* `src-tauri/tests/live_loader_speed.rs` —— 逐来源、冷/热各测一遍加载器查询；
* `fresh_install.rs` 补上"总耗时 / 传输量 / 平均速度"的打印。

**测出来的四个真问题**（都不是"感觉慢"，是实测数据）：

### 一、★★ Quilt 的 meta 在这台机器上根本连不通（清单"慢/查不出来"的直接原因）

| 地址 | 实测 |
|---|---|
| `meta.quiltmc.org/v3/versions/loader` | **40 秒超时**（两条路径都超时） |
| `bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader` | 22 KB / **0.31 秒** |

而我们的镜像改写表里**没有这一条** —— 于是每次冷启动都要等满超时才放弃 Quilt。
实测完整查询：**20 005 ms**，其中 Quilt 一个人占满 20 秒超时，
界面显示"没查到"，而它一直都在。

**修**：给 `meta.quiltmc.org` 与 `maven.quiltmc.org` 加镜像改写。
★ 同时**故意不给 Fabric 加** —— 实测官方 `meta.fabricmc.net` 直连 2.75 秒
（38 KB）比绕镜像更快，有更快的路就别绕。两条都写了测试钉住。

**改后实测（冷启动）：20 005 ms → 2 847 ms；Quilt 221 个版本、1 ms。**

### 二、★★ 五个来源"同时发、等全部"（PCL2 是错峰 + 每源超时）

原来 `tokio::join!` 五个来源共用 **75 秒**超时。而它们的真实耗时差三个数量级
（NeoForge 的按版本接口实测 87~632 ms），一条挂住的连接就能把总时长拖到 75 秒，
而另外四条早就成功了。

**修**（照 PCL2 的 `DlSourceLoader`）：
* **每个来源自己的超时**：Forge 20 秒、其余 20 秒（原来是统一的 75 秒）；
* 新增 `net::race_with_stagger()`：主路先跑，备路等 1.5 秒再上，谁先成功用谁 ——
  用在 `get_text_via` 的"镜像 vs 官方"两条路上。
  关键性质：**快源不受影响**（它在 stagger 之前就成功了，备路那次请求根本不会发出）。

### 三、★★ BMCLAPI 在并发 32 时用"146 字节的限流页"搪塞我们

实测日志（1.19.3 全新安装，`IEML_TEST_ASSETS=1`）：

```
[IEML/download] 服务端文件大小变了（任务记录 485752，服务端 146）→ 丢掉本地残留从头下：…netty-transport…
[IEML/download] 服务端文件大小变了（任务记录 947865，服务端 146）→ …oshi-core…
（同一次安装里 29 次）
```

一个 146 字节的响应**不是 HTTP 错误** —— 429 逻辑完全看不见它。
它要等到"大小校验失败"才暴露，而那时已经白烧一次往返 + 一次重试预算。
29 次 → 用户感觉"下载速度降了好多"。

**修**：新增 `looks_throttled(task_size, got)`（判据保守：任务知道该 >16 KB
**且** 只拿到 <1 KB）→ 识别出来就调 `SourceManager::note_throttled()`：
**冷却该源 5 秒 + 并发砍半**。这正是 PCL2 每起一个 BMCLAPI 线程就
`Thread.Sleep(100)` 想达到的效果（它的注释写得很明白：「减少 BMCLAPI 请求频率」），
只是我们用实测信号驱动。

### 四、大文件与小文件混在一起下（长尾是"最后一个大文件"）

任务顺序原来是生成顺序，跟大小无关。改成**按大小降序**（`sort_large_first`）：
大文件一开始就占住连接，小文件在后面填缝，收尾时剩下的都是"一眨眼就完"的。

★ 这是 PCL2 调度器自然产生的效果（它给**正在下载的**文件追加线程，
大文件会越吃越多线程），我们用显式排序达到同样目的，改动面小得多。

### 五、顺带：单次请求的三段式超时 + 429 等 10 秒

照 PCL2 的 `NetRequestByClientRetry`：第 1 次 10 秒（快速失败）→
第 2 次 30 秒（给慢源机会）→ 第 3 次 10 秒；**429 先睡 10 秒**再重试
（原来只等 0.5s/1s —— 而 429 的语义是"你太快了"，立刻重试只会再吃一次）。

### 实测对比（1.19.3 全新安装，含 3552 个资源文件，并发 32）

| | 改之前 | 改之后 |
|---|---|---|
| 加载器完整查询（冷） | 20 005 ms | **2 847 ms** |
| Quilt | 没查到（20 秒超时） | **221 个版本 / 1 ms** |
| 限流页（146 字节） | 29 次 | **0 次** |
| 补下轮次 | — | **0 轮** |
| 安装总耗时 / 平均速度 | — | **151.9 秒 · 4.23 MB/s · 0 失败** |

**教训**：**"慢"是一个可以被证伪的陈述。**
用户说"下载慢了好多"，第一步不该是改代码，而是**先把耗时和次数打出来** ——
三十分钟的测量直接指出了四个互不相干的病因（一个连不通的域名、
一个过长的统一超时、一种看不见的限流、一个与大小无关的调度顺序）。
其中"146 字节的限流页"这一条，**不测就永远发现不了**：
它不是错误码，日志里只表现为一句"大小变了"。

**相关**：ADR-045、ADR-048、`src-tauri/tests/live_loader_speed.rs`、
`src-tauri/src/net/mod.rs`（`race_with_stagger`）、
`src-tauri/src/net/mirror.rs`（Quilt 镜像）、
`src-tauri/src/net/source.rs`（`note_throttled`）、
`src-tauri/src/net/download.rs`（`sort_large_first` / `looks_throttled` / 自适应起步）。

---

## ADR-050　**"某个平台上 404" 不等于 "这东西不存在"**（dev.10 的错，必须记住）

**日期**：2026-09-14
**状态**：已确认（更正 ADR-045 之外的一处新错，并立为通用规矩）

### 我做了什么错事

用户要求「选择 Fabric 时如果有版本的 Fabric 与高清修复不兼容，应提示玩家不兼容」。
dev.10 我查了 **Modrinth**：

| 查询 | 结果 |
|---|---|
| `/v2/project/optifabric` | **404** |
| `/v2/project/legacy-optifabric` | 最高 MC 1.14.4，装载器 `legacy-fabric` / `ornithe` |
| `/v2/project/optifabric-origins` | 只有 1.14.4 / 1.15.2 |

于是我写下并实现了一条规则：

> **1.16 ~ 1.20.4 这一段，"Fabric + 高清修复"根本没有桥接包** ——
> OptiFabric 的主要作者在 1.16 前后停止维护，那个项目现在在 Modrinth 上
> 连项目页都没有。

**这条是错的。** 用户拿 MC百科的数据纠正我，两个证据都硬：

* `api.cfwidget.com/minecraft/mc-mods/optifabric` → 项目 **322385**，
  **75 个文件**、总下载 **10,056,111** 次，最高 `optifabric-1.14.3.jar`
  对应 MC **1.19.3**（2024-01-12 上传）；
* MC百科 class/1703「支持MC版本」表：Fabric **1.14 ~ 1.20.4** 全列，
  GitHub 归属 `Chocohead（1.16~1.20）` / `modmuss50（1.14~1.16）`，
  CurseForge Project ID 也正是 **322385** —— 与我自己读到的项目号一模一样。

### 错在哪（这是本条要记住的东西）

**我把"某个平台上没有"当成了"这东西不存在"。**
OptiFabric **从来就不在 Modrinth 发布** —— 我查错了平台，
还把那次缺席当成了铁证。更糟的是那三行"证据"**全来自同一个站**，
它们互相印证不了任何事，只是同一个错误重复了三遍。

### 决定（两条规矩，从今往后必须遵守）

1. **"上游有没有"必须落在它自己发布所在的那个平台上。**
   Modrinth 的缺席只能说明"不在 Modrinth"。要断言"不存在"，
   得去它真正的主场（这里：CurseForge 项目页 / 作者仓库）看过。
2. **"不知道"和"没有"必须分开表达。**
   `bridge-range` / `addon_exists_on` 因此都返回三态：
   有证据的"有"、有证据的"没有"（如 1.20.5 实测 0 条）、
   以及**"没有数据"** —— 第三种**永远不许**被当成"没有"去挡用户的组合。

### 由此产生的实现要求

* 桥接区间只留**一份**实现：`src/domain/bridge-range.ts` 与
  `src-tauri/src/domain/bridge_range.rs`，各自的测试把 MC百科表里的
  **25 个版本逐条核对**（`mcmod_table_versions_are_all_accepted` /
  「MC百科支持表里的 25 个 Fabric 版本逐个核对」）；
* 权限边界要写进测试：`bridge_is_always_manual_because_nothing_downloads_it`
  —— 生产路径没有下载桥接包的代码，所以**一律**标 `manual: true`，
  界面不许说「会自动装」（那是 dev.10 之前就在骗人的另一句假话）；
* 静态表不许再当"能不能装"的判据：`addon_exists_on()` 用**实拉核对过的**
  覆盖表（BMCLAPI `/optifine/versionList`，497 条），
  没数据的版本返回 `None`。

**相关**：ADR-037、ADR-040、ADR-045（同一个病根：拿不完整的表替上游下结论）、
`src/domain/bridge-range.ts`、`src-tauri/src/domain/bridge_range.rs`、
`src-tauri/src/domain/loader_caps.rs`（`addon_exists_on`）、
`tools/live/live-optifine-incompat-check.mjs`、
`CHANGELOG.md` 的 `0.1.0-dev.11` 一节。

---

## ADR-051　**"同一个判据写两遍"是这一类缺陷的共同形状**：七组 P0 的收敛（dev.12）

**日期**：2026-09-14
**状态**：已确认（对 ADR-001 / ADR-006 的一次全面回填）

### 背景：一次针对"承诺 vs 现实"的审计，翻出七组缺陷

这一轮没加功能。审计只问一句话：**这句承诺，代码真的做到了吗？**
翻出来的七组缺陷，**每一组都是"同一个判据存在两份/两套，其中一份错了"**：

| # | 缺陷 | 两份判据分别在哪 |
|---|---|---|
| P0-1 | `${library_directory}` 从 classpath 反推，推错就指向别的目录或空串 | "库根在哪"：`prepare_spec` 知道，`build_command` 却自己猜 |
| P0-2 | `.mrpack` 的 `files[].path` 不做路径校验（`extract_overrides` 做） | "路径安全吗"：解压那条路有，按清单下载那条路没有 |
| P0-3 | 暂停在第一批不生效、结论被扔掉、界面照样显示"完成 100%" | "停了吗"：引擎如实报 `paused`，`install()` 把它扔了 |
| P0-4 | 206 偏移不符时把**错位的数据**照写下去 | "这份响应能用吗"：判据在，但结论没被执行 |
| P0-5 | 长度校验在**读响应体之前**，限流页因此永远认不出来 | "大小对不对"：头部的宣告 vs 实际到手的字节 |
| P0-6 | 崩溃判据两条路径各一套：一条只看退出码、一条只看日志规则 | "算不算崩"：`watch_game_exit` vs `stop_minecraft` |
| P0-7 | Forge/Fabric 的版本段规则只有前端有；界面还从文案里抠 Java 数字 | "需要 Java 几"：Rust 与 TS 各一套规则 |

### 决定（四条规矩）

1. **一份判据只能有一个入口，而且入口要拿到全部事实。**
   `library_directory` 由 `LaunchSpec` 直接携带；崩溃判据收敛成
   `domain::crash::judge_crash(退出码, 是否用户停止, 是否离线, 时长, 日志)`；
   Java 要求的唯一入口是 `resolve_java_requirement`（两侧同名同义）。
   `JavaConstraintInput` 因此补上了 `forge_version` / `fabric_version` ——
   **判据拿不到的事实，等于这条判据不存在**（这正是 P0-7 的成因）。

2. **不可信输入的安全校验必须覆盖每一条落盘路径，而且共用同一个函数。**
   `.mrpack` 的清单路径与 zip 条目现在都过 `modrinth::safe_relative_path`。
   被拒绝的条目**必须报出来**（静默丢文件会让"装完少了东西"变成查不出的谜）。

3. **"停没停/崩没崩/装没装完"这类结论，只能由知道事实的那一层给，界面只呈现。**
   界面不许自己拼原因（`game-exit` 的文案）、不许从散文里抠数字
   （启动页的 `/Java (\d+)/` 已删）、不许在收到确认之前先说"已暂停"。
   启动失败因此改成结构化错误 `LaunchError { code, message, required_major, required_range }`。

4. **文档里的每个数字都要有出处，而且要被检查。**
   README 的「当前版本」落后 8 个版本、测试项数写的是 273/140/58/47（实际 369/111/59）、
   首页还写着"加速靠分片"（分片早已默认关掉）。
   现在：`tools/set-version.mjs` 把 README 纳入版本号落点，并新增 `--docs` 模式
   （README 与 CHANGELOG 最新一节必须逐字相同），`pnpm verify` 里多一项
   「文档版本口径一致」。**写死数字有风险，所以规则是"改了测试就顺手改文档"，
   而不是"记得改"。**

### 为什么这条 ADR 值得单独记

七组缺陷横跨下载引擎、安装器、启动参数、整合包、崩溃分析 —— 表面上毫不相干，
但**修法是同一个**：把那个"写了两遍、只改了一处"的判据找出来，收敛成一处，
再给它一个会红的测试。ADR-001（规则只实现一次）与 ADR-006（校验只实现一次）
早就立过这条规矩，这一轮是它在七个新地方的回填。

**相关**：ADR-001、ADR-006、ADR-011、ADR-036、ADR-037、ADR-045、ADR-049、
`src-tauri/src/game/launch_args.rs`、`src-tauri/src/modrinth.rs`、
`src-tauri/src/net/installer.rs`、`src-tauri/src/net/download.rs`、
`src-tauri/src/domain/crash.rs`、`src-tauri/src/domain/java.rs`、
`tests/java-rules.cases.json`、`tests/java-rules.test.mjs`、
`tools/set-version.mjs`、`tools/verify.mjs`、
`CHANGELOG.md` 的 `0.1.0-dev.12` 一节。

---

## ADR-052　CurseForge 接进来：**内置 key 的取舍**，与"接口自己当裁判"的验证法（dev.13）

**日期**：2026-09-14
**状态**：已确认（兑现 ADR-050 立下的那句话：要问"上游有没有"，就得去它自己发布的地方问）

### 背景

README 长期列着一条限制：「CurseForge 不可用 —— `api.curseforge.com` 返回 403，
需要 API Key」。这句话**只对了一半**：403 是**没带 key**时的响应。
用户给了一把 key，于是这一轮把它接上，并且按用户的选择：
**key 内置进源码当默认值**（PCL / HMCL 的做法），设置页可覆盖。

### 决定一：key 内置 + 可覆盖，但**必须如实说明它从哪来**

* 优先级：**设置页填的 > 环境变量 `IEML_CF_API_KEY` > 内置**，
  判据只写在 `curseforge::api_key()` 一处（两份判据迟早打架，ADR-051）。
* 设置页显示的是「**正在用内置的 key（随程序附带）**」而不是笼统的"已配置"——
  内置的 key 可能被人改掉或撤销，用户有权知道"这不是我填的"，
  也有权换成自己的（`console.curseforge.com` 免费申请）。
* 界面上只显示 key 的**前缀**；它**不进导出报告、不进整合包黑名单之外的地方**。

**代价（写清楚，不粉饰）**：这个 key 留在了源码树里。
它随时可被撤销，且额度记在它的所有者名下 —— 这是"开箱即用"换来的。
想避免就在设置页填自己的（内置那把随即不再被使用）。

### 决定二：「上游是什么样」只能实测，而且**用接口自己当裁判**

这一轮写代码之前先打了 4 个探针脚本，结论里有 4 条**推翻了猜测**：

| 我原以为 | 实测 |
|---|---|
| 指纹端点是 `/v1/mods/fingerprints` | **404**；正确的是 **`POST /v1/fingerprints`** |
| 指纹传有符号 int32 | 传**无符号**才通（有符号那次直接连接失败） |
| `gameVersions` 是 MC 版本列表 | 是**混合数组**：`["Client", "1.20.1", "NeoForge"]`（环境 + 版本 + 加载器） |
| LiteLoader 有 `modLoaderType` | `3` 在 1.12.2 上也是 **0 条** → 我们**不猜数字**，返回 `None`（= 不加这个条件） |

**指纹算法**的验证方式值得记住：下载一个真实文件 → 自己算 MurmurHash2 →
`POST /v1/fingerprints` → **接口把那个文件原样认了回来**。
算法错一个字节，接口就不会返回 exactMatch。
→ 于是那 12 条向量表（`tests/curseforge-fingerprint.cases.json`）是**可信的**，
Rust 与 JS 两侧读同一份（"判据只实现一次；真要两份就用同一张表钉住"）。

### 决定三：结果形状统一，但**不抹平差异**

CurseForge 的结果映射成与 Modrinth 同一个 `SearchResponse` 形状，
界面因此不需要第二套渲染（ADR-051）。但两处差异**如实带出来**：

* `distribution_allowed`：CF 上作者可以禁止第三方分发（热门 50 个里就有 1 个），
  那种项目我们**下不了** —— 界面**提前**标出来并说明，而不是等用户点了安装才报错；
  Modrinth 上没有这个概念，所以那边永远是 `None`（不适用），而不是 `false`（被拒绝）。
* `source`：这批结果从哪来，由后端给，界面不猜。

### 决定四：查更新的两条路，用 **SHA1 交叉验证**兜住"对应关系"

Modrinth 用 SHA1 反查、CurseForge 只认指纹（两个列表**按位置一一对应**，
空位传空串、后端保位置 —— 塌缩会让后面全部错位一格）。
实测 `exactFingerprints[i]` 与 `exactMatches[i]` 逐位对应，但**我们不只靠它**：
命中结果里带该文件的 SHA1，与本地 SHA1 对不上就**不采信**。
→ 万一上游改了对应关系，最坏结果是"查不到更新"，**绝不会装错版本**。

### 决定五：CF 的下载必须**多候选**（本机实测）

`edge.forgecdn.net`（API 给的那个）在这台机器上时好时坏：
同一个 URL 一次 200（2.5 MB 全拿到）、一次连接失败、一次 404。
而 `mediafilez.forgecdn.net` 与 `mod.mcimirror.top/files/…` 两次都通。
→ 按 URL 推导候选（CF 的文件地址里带着 id 的两段路径），只对**已知 CF 主机**推导。

**相关**：ADR-001、ADR-006、ADR-019、ADR-037、ADR-050、ADR-051、
`src-tauri/src/net/curseforge.rs`、`src-tauri/src/net/mod.rs`（带头的重试/兜底）、
`src/components/ResourceBrowser.tsx`、`src/pages/SettingsPage.tsx`、
`tools/probe/probe-curseforge*.mjs`、`tools/gen-curseforge-fingerprint-cases.mjs`、
`tests/curseforge-fingerprint.cases.json`、`src-tauri/tests/live_curseforge.rs`、
`CHANGELOG.md` 的 `0.1.0-dev.13` 一节。

---

## ADR-053　东西放在哪、叫什么：**目录按用途分，脚本按"回答什么问题"命名**（dev.14）

**日期**：2026-09-14
**状态**：已确认（用户要求"清理多余文件 / 优化代码 / 优化文件夹结构 / 规范命名"）

### 背景：不是"乱"，是**没有判据**

清理之前，仓库根躺着 41 个日志文件（`.build14.log` / `.verify.log` / 一个 1 MB 的
Forge 安装器日志）、`tmp/` 里 91 MB / 511 个文件、`logs/` 里三份**游戏**日志
（诊断时 cwd 用了仓库根，游戏就把 `logs/latest.log` 写这儿了），
`tools/` 里 54 个脚本平铺，其中 5 个**硬编码着 `C:/Users/Administrator/Desktop/IEML/…`**
—— 那个路径早就不存在了（项目在 `E:\IEML`）。

这些都不是"手滑"，而是**当时没有一条判据回答"它该不该在这儿"**。所以这一轮立的不是
"要整齐"，而是四条能拿来打架的判据：

### 决定一：删除的判据是"引用数为 0 且结论已固化"

* `tmp/` `logs/` 与根日志：**产物**，不是**结论**。结论在 CHANGELOG 与记忆里，
  产物留着只会让下一个人以为它是输入。→ 删。
* 5 个硬编码旧绝对路径的脚本：路径不存在 = 无法运行 = 死代码。→ 删。
* 4 个一次性 CurseForge 探针：它们各自回答的一个问题**已经写成测试**了
  （指纹端点/无符号、逐位对应、CDN 候选、镜像鉴权）—— **测试比脚本强**：
  脚本要人记得跑，测试会自己红。→ 删，并在 CHANGELOG 里写清"结论去哪了"。

### 决定二：`tools/` 按**什么时候跑**分目录

```
gates/  静态门禁（进 verify，红了别交付）
env/    构建与交付环境
live/   真机验证（要桌面版）
probe/  打上游接口（要联网）
diag/   一次性诊断（看本机数据目录）
```

判据是"**什么时候该跑它**"，不是"它是什么技术"（那样会分出 `mjs/` `ps1/` 这种没用的类）。
索引写在 `tools/README.md`：一张表回答"我想…去哪儿"。

### 决定三：名字要回答"它回答什么问题"

* **禁止 `xxx2.mjs` 这种后缀**：`check-natives.mjs` 与 `check-natives2.mjs` 谁是谁？
  这种名字等于承认"我不知道它们的区别" → 改成
  `natives-dir-and-jar.mjs` / `natives-vs-library-path.mjs`。
* `find-class-jar.mjs` 把主客体说反了（它找的是 **jar**）→ `class-comes-from-which-jar.mjs`。
* `check-bundle.cjs` → `gates/bundle-is-prod.cjs`（把**判据**写进名字）。
* 脚本**自己的用法注释**里的旧路径也一起改 —— 不改就是新的"假标识"。
* `CHANGELOG.md` 里一个旧路径都没改：那是历史记录（"发布过的不许改写"），
  新旧对照写在 dev.14 那一节。

### 决定四：一个入口，回退要说出来

`cargo.ps1` 与 `cargo-novcvars.ps1` 长期并存，调用方得记住"哪条命令用哪个"
（package.json 8 处走后者、verify 走前者）。现在合成**一个入口** `tools/env/cargo.ps1`：
首选 `vcvars64.bat`，它没设上 `%LIB%` 就自动回退到 `cargo-manual-msvc.ps1`，
并且**把回退这件事打印出来**（静默换环境会让"为什么这次编译行为不一样"变成谜）。
判据刻意用"%LIB% 为空"而不是"退出码非 0" —— 编译错误也会非 0，那种重试是浪费。
顺带把回退脚本里**写死的 MSVC/SDK 版本号**改成自动发现（写死的那天换台机器就指不到）。

### 附：这一轮踩到的两个环境坑（都值得记）

1. **PS 5.1 把无 BOM 的 `.ps1` 按 ANSI(GB2312) 读**：中文注释变乱码，而乱码的字节对
   **会吃掉后面的引号/反引号**，于是**报错指向别处**（实测：它报第 30 行的 `&&` 非法，
   真凶在第 35 行的中文串）。→ `.ps1` 一律存 UTF-8 with BOM。
2. 记忆里那条"vcvars64.bat 不可用"**已经过时**：本轮实测它正常，
   `tools/env/cargo.ps1` 走 vcvars 跑完了整套 Rust 测试。回退路径从"日常"降级为"保险"。

**相关**：ADR-006、ADR-051、`tools/README.md`、`tools/env/cargo.ps1`、
`tools/env/cargo-manual-msvc.ps1`、`tools/diag/find-orphans.mjs`、
`CHANGELOG.md` 的 `0.1.0-dev.14` 一节。

---

## ADR-054　界面的三条排版判据：**动作抬出来 · 一行说状态 · 让宽度还回来**（0.1.0-beta.1）

**日期**：2026-09-14
**状态**：已确认（用户要求"重构 UI，使其现代化、正式化；简化；把实用功能放显眼而不是藏起来；
文字太多、界面太挤"）

### 背景：不是"不好看"，是**三层信息挤在同一块地方**

改之前先用 `tools/live/shot.mjs` 把每一页拍下来（不靠"看代码觉得挤"），
拍出来的问题都能指到具体像素：

| 现象 | 证据 |
|---|---|
| 版本列表把同一件事说三遍 | 一屏 4 行里，"缺加载器"的完整告警句出现 **3 次**，每行占两行高 |
| 概览页半屏是解释 | 四张卡各带 2~3 行说明，按钮被挤到卡片最右侧 |
| 设置页断行断在词中间 | 标签列 156px，把提示折成"数据目 / 录：…" |
| 实用功能藏在说明里 | 「打开 mods 目录」在 Note 第二段；「下载 Java 21」在卡片最底部 |

共同形状是：**"要做的动作"、"现在的状态"、"为什么这样设计"三层信息挤在同一块地方**，
而用户只关心前两层。所以这一轮立的不是"要好看"，而是三条可复核的判据。

### 判据一：动作必须是按钮，且**在一眼能看到的位置**

* 概览页：四张解释卡 → **一条动作条**（打开目录 · 查看日志 · 检查并补齐文件 ·
  重命名 · 创建副本）。解释搬进 `title`（鼠标停一下就有，不占版面）。
* Mod 管理：「打开 mods 目录」从 Note 第二段抬到右上角工具条。
* 设置 → Java：「下载 Java 21」抬到卡片标题行（`CardTitle` 因此新增 `actions`）。
* 下载页：三个页签下面那条三行教学提示删掉；演示模式提示改成页头右侧一枚 Chip。

**推论（顺手做掉的一处简化）**：「检查」与「一键补齐」合成**一个**按钮。
缺文件没有任何需要用户决策的地方 —— 先 verify、缺了才下载、补完再 verify 报实数。
判据仍只有一处（`installer.verify` + `installGame`），界面只负责把两步串起来。
**这不违反 ADR-001**：界面没有新增任何规则，只是少了"让用户多点一次"。

### 判据二：一行状态用 Chip / `.field-hint`，**不要用 Note 块**

Note 是"用户需要据此做决定"的东西（缺前置包、组合不兼容、崩溃原因、写入失败）。
其余的一律降级：

| 以前是 Note | 现在 |
|---|---|
| 「概览页的定位」（解释设计意图） | 删（用户不需要知道设计过程） |
| 「游戏文件是共享的」（概念解释） | 删（页头副标题已写「盘上已装 N 份游戏文件」） |
| 「Mod 不会自动更新」4 行 + 「装 Mod 的两条路」4 行 | **压成一行**：留"不会自动更新"和"原地覆盖同名文件" |
| 「IEML 下载的 Java 由你掌控」 | 删（每行都有删除按钮，不用再承诺一次） |
| 「当前配置无需额外 API 包」的空框 | 整块不渲染（"没有"这件事不占地方） |
| 下载页 / Mod 列表页的演示模式提示 | 页头一枚 Chip |

★ **删的是解释，不是事实**：OptiFine 那两条 Note 各压到 2~3 行，但
"缺桥接包游戏会崩"这条硬事实**保留**（它会被删掉才叫出事）。

### 判据三：宽度与层级要么还回来，要么别占

* 标签列 `156px → 200px`（`≤1150px` 仍退化成单列）；卡片标题加 `.card-tail` / `.card-actions`。
* 列表行统一成一套原语（`.list` / `.list-row` / `.list-title` / `.list-sub` / `.list-side` /
  `.toolbar`），版本列表 / Java 列表 / Mod 一览共用；行高 `--row-min-h: 52px`。
* **长路径只显示尾部三段**（`…\jdk-21.0.2\bin\jawaw.exe`），完整值进 `title` ——
  这一处以前一行就被路径吃掉，真正要看的"是哪个 Java、多大"反而看不到。
* 加载器说明**只在选中或不可用**时显示（四个各带 1~2 行 = 右栏只剩字）。
* 界面换掉的东西，样式表里也不留：删掉 `.ov-*` / `.api-empty` / `.java-path` 五条死规则
  （判据同 ADR-053 决定一）。

### 附带更正：README 里两句**已被证伪却一直留着**的话

`README.md` §「Mod 绝不自动更新」还写着"启动器只在启动时后台检查并打角标""旧文件先移入回收站"。
这两句在 dev.12 的审计里就被证伪（没有启动时检查；`install_mod` 直接覆盖、
`delete_mods` 直接删），当时只改了代码注释与界面文案，**README 没跟上**。
这次对齐 —— 这一类"同一个事实两个说法"的漂移，与 ADR-051 是同一个病。

### 关于版本进阶（用户要求 → `0.1.0-beta.1`）

**进阶是用户的决定，不是判据全满足的结果。** 按 `docs/VERSIONING.md` §3.3：
判据①（功能表无 ❌）**未完全满足** ——「macOS / Linux 未实测」仍是 ❌，
**没有把它涂成 ✅**；判据②满足（`pnpm verify` 15 项全绿）；
判据③部分满足（Windows 上的阻断项已清空，剩下的 ⚠️ 是"只测过 Windows""Quilt 未实测"
"正版登录要自备 client_id"）。逐条判定写在 §3.3，这里不重复。

> ★ 2026-09-20 更正：上面这几条**引用的是当时的 README**（那会儿有「功能状态」表与
> 「已知会挡住用户的三件事」两节）。README 在 beta.45 重写之后**这两节都不存在了**，
> 所以判据表也跟着改成了对得上现在的检查单（见 §3.3 与 README 的「已知限制」）。
> **旧结论不改写，只标注它为什么不再适用** —— 与 ADR-051 同一条规矩。

**相关**：ADR-001、ADR-006、ADR-033（密度三铁律）、ADR-051、ADR-053、
`src/styles/app.css`、`src/styles/pages.css`、`src/pages/InstanceOverview.tsx`、
`src/components/InstallComposer.tsx`、`CHANGELOG.md` 的 `0.1.0-beta.1` 一节。

---

## ADR-055　资源中心：**列出、翻页、封面、玩家自选版本**（0.1.0-beta.2）

**日期**：2026-09-14
**状态**：已确认（用户逐条提出：列表要默认列出、要翻页、要封面、版本要玩家自己选、
下载页六格一字排开、别处入口删掉）

### 背景：四句话，四个都是"把选择权还给人"

用户的原话（这一轮的判据全部来自它们）：

1. 「添加 mod 什么的得给 mod 列出来然后让玩家选，**而不是让玩家自己搜，玩家记不住**」
2. 「居然**没有翻页**，就给这么一点，这太不对了」
3. 「这些应该给这些资源的**不同版本**……要选择资源版本进行安装，
   **而不是靠我们来推荐来自动匹配**」
4. 「这些是有**封面**的，我们得提供，得显示」

四句话指向同一个毛病：**界面替用户做了决定，而且只给了一点点**。

### 决定一：默认列出，搜索是**缩小范围**而不是**入场券**

打开资源中心就用空关键词查一次（热门/推荐），卡片显示封面、下载量、作者、简介、分类。
搜索框的占位文字直接写「留空 = 看热门」—— 用户不必先知道某个 Mod 叫什么名字。

★ **这条改法先证明再实现**：空关键词万一不返回内容，"默认列出"就是空话。
`tools/probe/probe-browse.mjs` 实测（走应用自己在用的镜像，本机直连
`api.modrinth.com` 是**连接超时**）：

| 种类 | 空关键词 | relevance vs downloads | 第 2 页与第 1 页 |
|---|---|---|---|
| Mod | 17 381 条 | 总数与首个完全相同 | 0 条重复 ✓ |
| 整合包 | 7 289 条 | 同上 | 0 条重复 ✓ |
| 资源包 | 17 080 条 | 同上 | 0 条重复 ✓ |
| 光影 | 596 条 | 同上 | 0 条重复 ✓ |
| 数据包 | 61 条 | 同上 | 0 条重复 ✓ |

顺带解释了后端那句写死的 `index=relevance` 为什么不用改：实测两种排序在空 query 下等价。

### 决定二：分页以**接口的真实上限**为准

Modrinth 的 `limit` 上限是 20，所以一页就是 20，翻页靠 `offset`。
底部永远显示 `已显示 N / M`，M 来自接口的 `total_hits` —— **不猜、不编**。
（CurseForge 的分页参数由后端那条命令统一翻译，界面不写 `if (source === …)`。）

### 决定三：版本由玩家选；我们不"推荐"，只说事实

点「选择版本并安装」先展开该项目的**全部兼容版本**：版本号、类型（正式/测试/抢先）、
发布日期、适配的 MC 版本、加载器、文件体积，以及"作者不允许第三方下载"这种硬事实。
列表顶部只写一句"第一个是上游最新发布的，**不代表最适合你**"。

**为什么不做"智能推荐"**：整合包与大型 Mod 的版本选择是有实际后果的决定
（存档兼容、服务器版本、依赖链），启动器没有能力替玩家判断哪一款合适；
给出全部事实 + 一句排序说明，比一个假装聪明的"推荐"更诚实也更有用。

### 决定四：下载页六格，别处不留重复入口

下载页 = 安装游戏 · 整合包 · Mod · 资源包 · 光影 · 数据包。
后四格是**同一个 `ResourceCenterBody`**，只换种类 —— 选项卡由后端那张表
（`domain/resources.rs`）生成，加一种资源不用改界面。
Mod 管理页右上角那个「资源包 / 光影 / 数据包」按钮**删掉**：入口只留一处，
否则"这两个按钮有什么区别"会变成用户的问题。

★ 同时删掉了旧的「Mod 列表」页签（它列的是**每个版本各装了什么**）——
玩家点「下载」要的是"能装什么"，"装了什么"属于 Mod 管理页。

### 决定五：图标必须有默认尺寸（一次已发生 bug 的制度性修复）

用户报"下载 mod 等资源的列表怎么又大对勾啊"。根因不是样式写错，而是
**SVG 没有 width/height 时按 100% 宽渲染**，而那个 `<IconCheck/>` 恰好落在
一个没有任何 `svg` 规则的容器里。

修法不是给那一个容器补一条 CSS（下次换个容器照样出事），而是给
`ui/Icons.tsx` 的 `base()` 加 `width="1em" height="1em"`。
**表现属性的优先级低于任何 CSS 规则** —— 已经显式定过尺寸的地方一点不受影响，
只有"漏了尺寸"的地方被兜住。

### 决定六：层级用令牌，不用魔数

同时修掉"下载栏会被奇怪的一些 UI 遮住"：根因是 **toast 固定在右下角**，
而下载页的主按钮就在右下角。toast 改到顶部居中；6 个散落的 `z-index`
（20/50/60/90/100/200）收成 `--z-sticky / --z-dropdown / --z-modal / --z-toast / --z-boot`。

### 决定七：字体随程序附带，并在「关于」声明

HarmonyOS Sans SC（只用 Medium 一个字重，8.2 MB；全套六档是 50 MB，
与"安装包 ≤ 8 MB"的核心指标冲突）。**代价写在 README 的体积指标里**，不藏。
许可全文随程序附带，「关于」页写明字体、字重与许可名称。

### 决定八：版本命名规范（用户给定）

`{mc_version}-{loader_type}-{loader_version}`（`1.20.1-forge-47.2.0`）。
**显示名与目录名用同一套** —— 以前显示名 `Forge 1.20.1` 与目录名 `forge-1201`
在"同一个 MC 版本换一个构建"时**双双撞车**，只能靠 `(2)` 区分，
而且名字里看不到加载器版本（它恰恰是"能不能跑"的关键）。只影响新建版本。

### 决定九：微软 client_id —— **实测否掉了用户的指定值**

用户要求用 `00000000402b5328`。实测（同批请求带一个随机编造的对照组）：

| client_id | devicecode 端点 |
|---|---|
| `00000000402b5328` | 400 `AADSTS700016` 不存在 |
| 随机编造 | 400 `AADSTS700016`，与上面一字不差 |
| Prism Launcher 公开 id | **200，真的发了设备码** |

所以**没有**照抄那个 id，改用可用的公开 id，并保留"设置页 / 环境变量覆盖"
（显式填的优先于内置）。**这一条记在这里的意义大于修好登录本身**：
用户的要求与实测冲突时，正确做法是**照实测做 + 把证据摆出来**，
而不是照做（交付一个必然失败的按钮）或照不做（当没听见）。

### 决定十：版本设置页"和 PCL 太像"——**用我们比 PCL 多的那个概念来改**

用户：「版本设置里，这个页面和 PCL 太像了，虽然确实很简便，适度调整」。

PCL 的版本设置是一条**从头读到尾的长清单**：十几行长得一模一样，想改内存
得先滚过隔离、窗口标题、服务器、Java。而我们这一页有一个 PCL 没有的概念：
**每一项可以"跟随全局"或"已覆盖"**。所以改法是：

* 顶部加一条**只读摘要**（内存 / Java / 隔离 / 窗口标题，全是真值），
  每项**可点 → 滚到对应那一行并高亮一下**。"在长清单里找一行"从"用眼睛扫"
  变成"从这里跳过去"。
  只读是刻意的：能改的地方仍然只有下面那些行（ADR-001 铁律①——一个值只能有一个地方能改）。
* **顺序按"改动频率"重排**：内存 → Java → 启动选项 → 其他。
  打开这一页的人十次有八次是为了改内存或 Java。

★ 为什么**不用 CSS `order` 蒙过去**：视觉顺序与 DOM 顺序不一致会让 Tab 焦点
乱跳（这一页全是输入控件）。所以是真的把 JSX 块移了位置。

### 本轮没做的（写下来，不含糊）

* 一次全站视觉走查（用户："整体 UI 让启动器宛如半成品，美化"）—— 只做了具体项。
* 资源中心没有"已装"标记（需要跨项目 id 与本地文件名/哈希比对）。

**相关**：ADR-050（"没查到"≠"没有"）、ADR-052（两个来源）、ADR-054（排版三判据）、
`src/components/ResourceBrowser.tsx`、`src/components/VersionIcon.tsx`、
`src/ui/Icons.tsx`、`src-tauri/src/auth/mod.rs`、`tools/probe/probe-ms-clientids.ps1`。

---

## ADR-056　**数据放哪、程序多大、登录在哪**：三条与"体积/位置"有关的决定（0.1.0-beta.3）

**日期**：2026-09-15
**状态**：已确认（用户要求：仓库 50 GB 深度清理 · 本体别那么大 · 用系统自带字体 ·
压缩启动器数据 · 游戏数据放进数据目录里的 `.minecraft`（像 PCL）· 正版登录要显眼）

### 决定一：50 GB 的真相 → 先量后删，删的是**构建缓存**

实测 `E:\IEML` = 50.77 GB，其中 `src-tauri/target/debug` 一个人 **47.4 GB**
（`incremental` 28.8 + `deps` 16.9，而 deps 里 13.5 GB 是 `.pdb` 调试符号）。
交付物 exe 只有 12.6 MB。删掉后 **50.77 → 3.36 GB**。

★ 光删不够（下次编译又长回来），所以同时改 `Cargo.toml`：
`[profile.dev] / [profile.test]` 用 `debug = "line-tables-only"` + `incremental = false`。
判据是"要能复原别人的现场"：panic 的**行号**还在（最常用的一档），
省掉的是类型/变量调试信息与增量缓存。

### 决定二：本体瘦身 → **不带字体**，用系统字体栈

0.1.0-beta.2 按用户要求打包了 HarmonyOS Sans SC Medium（**8.2 MB 一个字重**，
而本体一共才 8 MB 出头）。0.1.0-beta.3 用户改口要"电脑自带且通用又好看" →
删掉字体与 `@font-face`，改成：

```
system-ui → Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI
→ PingFang SC(macOS) → Noto Sans CJK SC(Linux) → HarmonyOS Sans SC(装了就用)
```

前端产物 8.67 MB → **442 kB**，exe 13.17 MB → **8.03 MB**。
★ 「关于」页的字体声明**同步改掉** —— 声明里留着一个程序根本没带的字体，就是假话。

### 决定三：游戏数据搬进 `<数据根>/.minecraft/`（像 PCL）

`shared/` → `.minecraft/`。全仓库 45 处引用都走 `AppPaths.shared` 一个字段，
所以换位置只改一行（字段名仍叫 `shared`：**"共享"是职责，`.minecraft` 是位置**）。
迁移用**同卷 `rename`**（原子），五种情况都有测试。

#### ★★ 这里踩到一个真 bug，值得单独记（**顺序也是判据的一部分**）

第一次真机验证时，启动器把 `%APPDATA%\IEML\shared`（几个月前留在 C 盘的旧数据，
6754 个文件 / 1079 MB）**复制**成了 `D:\IEML\.minecraft`，而真数据还在 `shared/` 里没动 ——
用户下次打开就会觉得"我的版本都不见了"。

原因是**我把"跨数据根补齐"排在了"本根布局迁移"前面**。补齐那条路按新映射
（`old/shared → new/.minecraft`）凭空造出一个"新布局"目录；随后布局迁移看到
`.minecraft` 已有内容，按自己的规矩跳过（**那是对的**，它不能猜用户目录里是什么）。

两条修法：
1. **顺序**：本根布局迁移必须最先（`lib.rs` 里写成了注释，防止以后被"整理代码"挪走）；
2. **判据**：`migrate_data_root` 不再死映射，改成**看目标根当前的布局**
   （目标还有 `shared/` 就放进 `shared/`）—— 一张回归测试钉住它。

**教训**：数据迁移的"目标路径"不能只由源决定，还要看**目标自己现在是什么状态**。

### 决定四：清理按**判据**分家，不做一个"一键清 1.4 GB"

量过数据目录（1.73 GB）之后才敢动：`assets` 816 MB + `libraries` 587 MB 是
**真正的游戏文件**；能安全回收的只有 `cache/`（27 MB，安装器与清单缓存）
与 `logs/`（每次启动一份）。所以：

* `clean_unused_files` —— "没有任何版本引用的库与资源"（判据窄）
* `clean_caches` —— "删了会自己回来的东西"（安装器 / 元数据 / 旧日志，留最近 5 份）

**两条命令、两套判据**，而不是合成一个"一键清 1.4 GB"的按钮 ——
那 1.4 GB 是用户的游戏，删了就得重下。

### 决定五：账号是**状态**，所以放在顶栏

新增 `AccountPanel`（设备码 → 自动轮询 → 三种失败 → 离线切换）**一份实现**，
顶栏账号按钮与设置页那张卡都用它。理由是账号回答的是"我现在是谁、能不能进正版服务器"，
属于**状态**而非"改一次就不动"的设置 —— 该一直看得见。

★ 顺带修了一个**会让登录必然失败**的隐患：数据目录里躺着一个手打的占位符
`11111111-2222-3333-4444-555555555555`，而优先级是"文件 > 环境变量 > 内置"，
它把**实测可用**的内置 id 挤掉了。现在占位符判据只有一份
（`looks_like_placeholder`：全零 / 连号 / 同字符重复的 GUID），**保存时拒绝、
启动时忽略、但不删用户的文件**。4 条测试守着，含"真的 id 不许误伤"。

**相关**：ADR-042（删除语义）、ADR-050（"没查到"≠"没有"）、ADR-052（内置 key 的取舍）、
ADR-055（资源中心）、`src-tauri/src/platform.rs`、`src-tauri/Cargo.toml`、
`src/components/AccountPanel.tsx`、`CHANGELOG.md` 的 `0.1.0-beta.3` 一节。

---

*文档创建：2026-09-11（第六轮补充 ADR-020 ~ ADR-026；第八轮补充 ADR-027；
第九轮补充 ADR-028 ~ ADR-030；第十轮补充 ADR-031；第十三轮补充 ADR-032 ~ ADR-033，
其中 ADR-032 撤销 ADR-027；第十四轮补充 ADR-034 ~ ADR-036，
修正 ADR-026 的竞速策略、修正 natives 布局与跨 IPC 字段命名；
第十五轮补充 ADR-037 ~ ADR-038，修正"加载器清单来源"与"装没装上的判定方式"；
第十六轮补充 ADR-039，加载器清单改为五种并行 + OptiFine 接入真实清单；
第十七轮补充 ADR-040，内置表退出"能不能装"的判定，改为按版本真实查询 + 后台预热；
第十八轮补充 ADR-041，全面审计"做了但没法用"并逐条修实；
第十九轮补充 ADR-042，删除改为回收站优先、文案与行为同源；
第二十轮补充 ADR-043，前置包安装接入整合包路径并联网验证 slug 与慢速判据；
第二十一轮补充 ADR-044，实例支持启动即进服 + 服务器地址全角标点自动纠正；
第二十二轮补充 ADR-045，对照 PCL2 源码修正下载引擎判据与"能装/不能装"的表达；
第二十三轮补充 ADR-046，偏好落盘的启动基线与失败提示；
第二十四轮补充 ADR-047，修正 Forge/NeoForge 的过滤条件并给缓存加版本号；
第二十五轮补充 ADR-048，natives-only 的库不再被下载与计入 classpath；
第二十六轮补充 ADR-049，按 PCL2 优化网络：错峰竞速/每源超时/限流页检测/大文件先下；
第二十七轮补充 ADR-050，更正 dev.10 的误判："某个平台上 404"不等于"这东西不存在"；
第二十八轮补充 ADR-051，收敛七组"同一判据写两遍"的 P0 缺陷，并把文档数字纳入检查；
第二十九轮补充 ADR-052，接入 CurseForge：内置 key 的取舍、接口当裁判的验证法、
跨源查更新的 SHA1 交叉验证、CF 下载的多候选；
第三十轮补充 ADR-053，目录按用途分、脚本按"回答什么问题"命名、一个入口 + 明说的回退；
第三十一轮补充 ADR-054，界面三条排版判据（动作抬出来 / 一行说状态 / 让宽度还回来）
与 beta 进阶的如实记录；
第三十二轮补充 ADR-055，资源中心列出/翻页/封面/玩家自选版本、六格一字排开、
图标的默认尺寸、层级令牌、附带字体、版本命名规范、
以及"用户指定的 client_id 被实测否掉"这条记录；
第三十三轮补充 ADR-056，50 GB 构建缓存的清理与 dev profile、去掉附带字体改系统字体栈、
游戏数据搬进 .minecraft（含"顺序也是判据"那次真机 bug）、清理按判据分两条命令、
账号提到顶栏 + 占位符 client_id 的拦截）*

---

## ADR-057　下载源策略：**国内优先 + 启动实测延迟决定次序**（★ 第四十六轮新增）

**日期**：2026-09-16
**状态**：已实施
**修正**：[ADR-026](#adr-026多源竞速与镜像表第六轮新增) 的镜像表顺序、
`mirror.rs` 中「Fabric meta 故意不改写」的旧结论。

### 背景

用户提出：「**国内有的就用国内，没有国内就用国内最近的、延迟低、能连的节点**」。

这句话看着像"把所有源换成国内镜像"就够了，但逐项实测表明**不能一刀切** ——
同一时刻，不同项目的快慢是**相反**的：

| 探测项 | 官方 | 国内镜像 | 谁快 |
|---|---|---|---|
| 原版版本清单 | **346 ms / 3-3** | 639 ms / 2-3 | **官方** |
| 原版库文件 asm-9.5 | 1136 ms | **157 ms** | **国内 7×** |
| Fabric loader jar | 1363 ms | **187 ms** | **国内 7×** |
| Forge installer jar | 1004 ms / **1-3** | **196 ms / 3-3** | **国内** |
| OptiFine 版本列表 | **0-3 全失败** | **51 ms / 3-3** | **国内** |
| CurseForge `/v1/games` | 2432 ms / 1-3 | **430 ms / 3-3** | **国内** |
| Modrinth `/v2/project/sodium` | **227 ms** | 266 ms | 相当 |
| Modrinth CDN jar | 1-3 | 0-3 | **两条路都不通** |

所以「无条件国内优先」会在原版版本清单上真的变慢，而「一律官方优先」
会在库文件上慢 7 倍。**顺序不能写死。**

### 决定

**三层叠加**，优先级从高到低：

1. **限流冷却** —— 429 / 限流页之后该源直接 −5000 分。
   这是"现在别用它"，比任何长期倾向都紧急。
2. **国内优先（策略，+25 分）** —— 落实用户要的"国内有的就用国内"。
   取值经过校准：大到能压过"官方仅快 300 ms"，小到能被"国内慢 13 倍"翻盘。
3. **实测延迟（TTFB）** —— 启动后台探测，越快加分越多（0~60），
   三端点全失败 −120（这次它真的不可达，此时不该再讲策略）。
   结论 **10 分钟过期** —— 源的好坏是时段性的，一次探测不能当永久结论。

顺序落在 `SourceManager::score()` 里（`source.rs`），
候选列表由 `candidates_with` → `sort_by_health` 按分数重排。

### 为什么是"探测三个端点取中位数"

只探一个端点会**系统性偏向一边**：只探"原版版本清单"偏向官方
（那是唯一官方更快的项），只探"库文件"偏向国内。
三个端点里刻意保留了一快一慢两类，取中位数才是对整体倾向的估计。

量的是 **TTFB（首字节时间）而不是总耗时**：总耗时受文件大小影响，
270 KB 的 JSON 和 3 KB 的 JSON 比"谁快"是错的。
（`reqwest` 的 `send()` 在收到响应头时返回，那一刻就是 TTFB。）

### 探测端点的额外价值

`PROBE_URLS` 里**只写官方地址**，镜像侧由 `mirror::mirror_url` 推导。
这样探测用的正是镜像表自己声称支持的路径 —— **镜像表写错了，探测会立刻暴露**
（表现为该源中位延迟变差或全失败），而不是等用户装游戏时才 404。

### 同时修正的两处旧结论

| 旧结论 | 复测结果 |
|---|---|
| `mirror.rs`：「Fabric meta 故意不改写，官方 2.75s 比镜像快」 | **反了**。官方 4 次里 3 次超时；镜像 `/profile/json`、`/game`、`/installer` 全部 200 / 0.3~0.5s。两侧**互补**（官方挂 3/5、镜像挂 1/5），改写后才有多候选兜底 |
| `mirror.rs`：「Modrinth/CF 官方在前，官方 230 KB/s vs 镜像 146 KB/s」 | **已不成立**。CF 实测国内 3-3/430ms、官方 1-3/2432ms。顺序反转为国内优先，官方仍是第二候选 |

**镜像非过期副本**（改写的前置条件，已验）：两侧 Fabric loader 列表都是
**253 条**，版本集合完全相同（仅官方有 0 个、仅镜像有 0 个）。
字节 40674 vs 29793 的差异只是 JSON 空白格式。

### 结果

- 新增 `src-tauri/src/net/probe.rs`（启动探测）
- `source.rs`：`SourceStats` 加探测字段、`score()` 加策略与实测两项、
  `snapshot()` 把实测值一并给前端（用户该看到"实测多少毫秒"，不只看到"猜"出来的分）
- `mirror.rs`：Fabric meta 改写、Modrinth/CF 顺序反转
- `lib.rs`：`.setup()` 里 `spawn` 探测，**绝不 await** ——
  拿不到结果就沿用默认序，界面不该为探测多等哪怕 4 秒
- 9 条新测试锁住：默认国内优先 / 国内全挂时让位 / 国内慢 13 倍时让位 /
  国内仅慢 300ms 时保持 / 探测过期失效 / 探测不污染传输统计 /
  加成单调有封顶 / 冷却压过策略 / Fabric 改写后确有两个候选

### 没做到的那一半（诚实记录）

「没有国内的就用最近的节点」这条**没有落地**，因为实测发现
**Adoptium（Java 运行时）根本没有可用的国内镜像**：
TUNA 整站 403、NJU/BFSU/SJTU/ZJU/PKU/阿里云 404、
USTC 有目录但文件被 JS 反爬拦死、CERNET 302 跳回 TUNA、
BMCLAPI 的 `java-runtime` 302 跳到 Cloudflare 后端（不是国内源）。

所以 Java 自动下载**只能走官方**，而官方 API 时段性不可达
（有时 223 ms / 3-3，有时整段超时）—— 属于国际出口问题，本机修不了。
`ARCHITECTURE.md` 里「有国内镜像可换」那句是错的，已删除并附实测表。

**相关**：ADR-026、ADR-034、ADR-045、ADR-049、
`src-tauri/src/net/probe.rs`、`src-tauri/src/net/source.rs`、`src-tauri/src/net/mirror.rs`、
`tools/probe/probe-source-policy.mjs`、`tools/probe/probe-ratelimit-artifact.mjs`、
`tools/probe/probe-adoptium-mirror.mjs`、`tools/probe/probe-ustc-adoptium.mjs`、
`tools/probe/probe-java-runtime-mirror.mjs`。
---

## ADR-058　启动器自身的更新：**CNB 公开发布仓 + 端到端验签**（★ 第五十六轮新增）

**背景**

用户问「有没有给客户端推送更新的功能」→ 核对结果：**一行都没有**。

| 检查项 | 结果 |
|---|---|
| `Cargo.toml` | 只有 `dialog` / `fs` / `opener`，**没有 `tauri-plugin-updater`** |
| `tauri.conf.json` | 没有 `plugins.updater`（无 endpoints、无 pubkey） |
| `createUpdaterArtifacts` | **没开** —— 不开这个，打包器根本不产出更新包 |

用户随即决定：「**做，如果不做，玩家怎么收到我们做的更新**」。

★ 注意与 **ADR-018（Mod 绝不自动更新）** 的关系：那条针对的是 **Mod**，
理由是"自动更新只能判断'有更新'，无法判断回到用户这个具体实例里还成不成立"。
**启动器自身是另一回事** —— 它没有"回装到某个实例里还成不成立"这个问题，
不更新的代价是玩家永远停在旧版本。

**已做（第五十六轮）**

1. `Cargo.toml` 加 `tauri-plugin-updater = "2"`（实测拉下 2.11.0 并编译通过）
2. `capabilities/default.json` 加 `"updater:default"`
3. `lib.rs` 注册 `tauri_plugin_updater::Builder::new().build()`
4. `tauri.conf.json`：
   - `bundle.createUpdaterArtifacts: true`（不开就产不出 `.tar.gz` + `.sig`）
   - `plugins.updater.pubkey` ← 真实公钥已写入
   - `plugins.updater.endpoints` ← **占位符 `https://REPLACE-ME/...`，待填**
5. 生成签名密钥对（**仓库外**：`~/.ieml-release/ieml.key` ＋ `.key.pub`），
   `.gitignore` 补了 `*.key` 兜底

**★ 第五十六轮更新：端点已定、界面已做、通道已端到端验证通过**

上面那份"待决策"已经落地。最终选型：**CNB 的公开发布仓**。

| 项 | 结果 |
|---|---|
| 端点 | `https://cnb.cool/IEML_Official/IEML-releases/-/releases/download/latest/latest.json` |
| 发布仓 | `IEML_Official/IEML-releases`（**公开**，与私密的代码仓 `IEML_Official/IEML` 分开） |
| 发布脚本 | `tools/release/publish-cnb.mjs`（`pnpm release:publish`） |

**为什么必须是公开仓**：Tauri 要求端点是**静态 URL**，且玩家要**匿名**下载。
实测 CNB 私密仓匿名访问是 401（API）/ 404（网页），网页的 `share` 参数只在
12 小时、最多 10 次下载内有效 —— 那条路走不通。（用户曾问「我这是私密库」，
这是当时的核对结论，也是把发布拆成独立公开仓的原因。）

**为什么用一个滚动的 `latest` tag**：端点写死在 exe 里、不能每次发版都改。
所以维护两个 release：`v<版本>` 存带版本的产物（只增不改），`latest` 只存一个
每次覆盖的 `latest.json`；端点固定指向 `latest`，由清单里的 `url` 指出该下哪个版本。

**签名密钥：已换成 `ieml3`，这次有真密码**

- `~/.ieml-release/ieml3.key` ＋ `ieml3.key.pub` ＋ `PASSWORD.txt`（32 位随机串）
- 同目录 `README-备份说明.txt` 写明**必须三个一起备份**、以及"为什么换密钥不可逆"

★ 换密钥**不可逆**：公钥编进 exe，装了旧版本的机器会认为新版本的签名是伪造的。
`beta.43`（`ieml2`，测试密码且已泄露在对话记录里）发布后 20 分钟内没有分发，
所以趁那个窗口换掉，并把版本号升到 `beta.44` —— **绝不能用同一个 `beta.43` 重发**，
否则世上会存在两个公钥不同的 `beta.43`，而装过第一版的人永远更新不了。

★ `--ci` 生成的无密码密钥**签不动**：`tauri signer sign` 会在解码成功后挂住，
还打印误导性的 `Signing without password.`。必须用带密码的密钥 +
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

**界面（本节要求"必须与 Mod 更新区分开"，已照办）**

- `src/hooks/useLauncherUpdate.ts`：检查 / 下载 / 安装的状态机
- 设置页「关于」卡新增一行，按钮文案是「**检查启动器更新**」而不是"检查更新"

★ Windows 上 `downloadAndInstall` 会**自己退出 app** 把控制权交给安装程序，
不需要（也不该）再加 `plugin-process` 去 relaunch —— 那是 macOS/Linux 的要求。

**两道自检（本轮最有价值的部分）**

上传**前** —— `tools/release/verify-manifest.mjs`：清单版本号、notes 编码、
url 与版本号一致、**签名 key id 与内置 pubkey 同源**、本地产物存在，共 16 项。

上传**后** —— `tools/release/verify-endpoint.mjs`：完全照客户端的做法走一遍，
匿名拉清单 → 匿名下包 → 用内置 pubkey 真验 Ed25519 签名。

★ 为什么值得专门写：这类失败**在服务端完全看不出来**（CNB 只会说上传成功），
只有玩家那边报"更新失败"。而且签名格式有真实的解析陷阱 —— `.sig` 是
**一层 base64 包着 minisign 文本**，文本里才是 base64 载荷；漏掉外层解码就会把
`untrusted` 的第 3 个字节当成 key id，从而误报"不同源"（我第一版就这么错过一次）。

**★ 第六十九轮更新：从"手动点"改成"热更新 + 静默安装"**

上面那条「设置页一行按钮」是**手动**路径：不点就不知道、点了才开始下、装的时候还有
一条 NSIS 进度条窗口（`installMode` 默认 `passive`）。现在补齐三件事：

| | 之前 | 现在 |
|---|---|---|
| 什么时候查 | 用户点按钮 | 开机 **8 秒**后自动查一次（失败**静默** —— 用户什么都没做，不该弹红条） |
| 什么时候下 | 点"下载并安装"才开始 | **查到就后台下**，用户看到角标时通常已经下好 |
| 怎么装 | `passive`：一条进度条 | **`quiet`：`/S`，完全无界面** |
| 装完 | —— | 插件补 `/R`：安装程序自己把启动器拉起来 |

* `tauri.conf.json` 加 `plugins.updater.windows.installMode: "quiet"`。
  ★ **档位与开关的对应关系是从插件源码读出来的**，不是猜的：
  `tauri-plugin-updater-2.11.0/src/config.rs` 里 `nsis_args()` 给
  `Quiet → ["/S"]`、`Passive → ["/P"]`；`nsis_restart_after_install_args()` 给
  `BasicUi → []`、其余 `["/R"]`，且 `restartAfterInstall` 默认 `true`。
* **状态只有一份**：`useLauncherUpdate` 提到 `AppContext`。角标与设置页看同一件事 ——
  各挂一份 hook 就是两份状态（一边"下载中 40%"、一边"发现新版本"），
  而且会**各查一次、各下一次**。
* `download()` 与 `install()` 拆开，`UpdatePhase` 新增 `ready`（包已在本地只等点）。
  合并成 `downloadAndInstall` 就只有"用户点了才开始下"这一条路。
  **下载失败退回 `available`、装失败退回 `ready`** —— 不许停在"下载中"。
* 顶栏 `src/components/UpdateChip.tsx`：三态角标（下载中 / 重启并更新 / 重试下载）。

**怎么验的（★ 这条以后每次改更新链路都要重做）**：**自己比自己永远没有更新可更**，
所以要把 debug 客户端**临时**编译成比线上旧一号的版本（`set-version` + 重建），
再依次验：不点就出角标（自动查+自动下）→ 点一下 → 进程退出 → 装完版本真的变了 →
`/R` 把启动器拉回来 → **轮询抓到安装器的命令行含 `/S`、不含 `/P`**。
最后一条是"静默"的唯一硬证据：`check-exe-wiring.mjs` 只探得到 `installMode`
这个**字段名**（serde 元数据，值未必明文），**字符串探针证明不了档位**。

**仍然没做**

- GitHub ↔ CNB 两个代码仓的自动同步（目前靠手动推两个 remote）
- 更新通道的**定期巡检**：万一 CNB 改了下载行为，只有玩家会发现
- 没验过的（如实记）：下载中那一档角标在宽带下几秒就跳过去了；
  **游戏运行中**点更新会怎样 —— 现在没有"更新前先关游戏"的判断

---

## ADR-059　液态玻璃：**真的折射**，三档，以及"能不能做"用探针先问

**背景（用户 2026-09-21 原话）**

> 我想要真实的液态玻璃
> 1. 边缘折射 … 2. 动态高光 … 3. 色散边缘 … 4. 厚度感 … 5. 内容适应性 …
> 视效也要三档，弱化视效，适中视效，灵动视效
> 当用户电脑是 win7 或者显卡不支持 WebGL 2.0 时，默认适中，并且不开放灵动视效
> 背景的光斑在灵动视效模式也要视效做的更好看更高级

### 一、先问"这一层能不能做"，再谈怎么做

五条里只有第 1、3 条**必须**依赖一个能力：`backdrop-filter: url(#svg滤镜)` ——
也就是"把**背后的内容**真的扭一下"。这件事有三层不确定：

1. WebView2（Chromium）认不认这个语法；
2. 认了之后**渲染**时会不会真的用；
3. 我们的窗口是 Tauri 的无边框窗口，合成路径会不会不一样。

★ 所以第一件事不是写玻璃，是写**探针** `tools/live/probe-webview-glass.mjs`：
现场烘一张圆角矩形的**镜片法线图**（canvas → dataURL → `feImage`）→
`feDisplacementMap` 扭 `SourceGraphic` → **开/关各截一张图比像素**。
本机结果（Intel UHD / Chromium 153）：语法认、并且**像素真的变了** ——
条纹在边缘被弯折（截图存档在 `%TEMP%\ieml-glass-probe\`）。承重墙因此立住。

★ 反面教训写在这里：探针里"坏引用"那一条是**正对照** ——
`url(#不存在)` 必须与"只有模糊"逐字节相同。没有这条对照，
"两张图不一样"可能只是别的东西在动。

### 二、五条各自落在哪（实现位置）

| # | 用户要的 | 怎么做的 |
|---|---|---|
| 1 | 边缘折射 | `backdrop-filter: blur() saturate() url(#ieml-lens-<尺寸>)`；每个尺寸烘一张法线图（`ui/glass.ts`），`feDisplacementMap` 把背后内容往内拉 |
| 2 | 动态高光 | 高光那层渐变的圆心是 `--glass-gx/--glass-gy`，指针位置写进去；灵动档再加一条 CSS 动画让它**自己流**（悬停时让位给指针） |
| 3 | 色散边缘 | 两条 1–2px 的**内阴影**（红在左、蓝在右）—— 真玻璃的色差 |
| 4 | 厚度感 | 内缘一圈辉光 `inset 0 0 26px -14px`：边缘比中间厚 |
| 5 | 内容适应性 | JS 按元素位置**采样背景层**（`ui/ambient.ts` 的采样器：把光斑画进 48×48 离屏 canvas 再读像素），算出 `--glass-tint` |

★ 第 5 条的**边界要写清**：桌面壁纸（窗口**后面**的东西）在 WebView 里**读不到像素**，
Tauri 只能让系统给它做"亚克力模糊"，**没法折射**。所以能适应的"内容"是
**应用自己的背景层**（光斑），不是桌面。第 1 条同理：折射的是窗口内的内容。

### 三、三档与降级（判据在 `ui/vfx.ts`，纯函数、有测试）

* `weak` 弱化：平玻璃（连标题条的磨砂也关掉 —— 否则"弱化"下还留着一条糊带子）
* `mid` 适中：五条都在，背景静、高光只跟指针
* `aura` 灵动：折射更厚、色散更宽、高光自流、**背景换成 WebGL2 流体**

**降级判据三条**（任一条不满足就不开放灵动）：
① 有 WebGL2 上下文；② **不是软件光栅化**（SwiftShader 也算"有上下文"，
但用户要的是"**显卡**支持"）；③ 不是老系统（NT 6.x = Win7/8/8.1）。
被挡下来时**不是把选项藏起来**，而是禁用 + 写明原因（含渲染器名，用户能拿去搜）。

★ 适中档的实现**分两条路**：够格的机器（能开灵动）→ 适中档也用真折射（弱一点），
材质是连续的；不够格的机器 → 纯 CSS，一个 SVG 滤镜都不装。
判据是 `vfxCapability().auraAllowed && CSS.supports('backdrop-filter','url(#x)')` ——
后者要**直接问**，因为"有好显卡但 WebView2 旧到不认 `url()`"是可能出现的，
那时硬装滤镜会让整条声明失效（连模糊一起没了）。

### 四、性能：三个"装饰渐变层"每帧吃掉 9ms（★ 这一节是本轮最有价值的实测）

同一屏（设置页，6 块玻璃）滚动帧时间，真机实测：

| 配置 | 帧时间 |
|---|---|
| 5 层背景渐变（缘光 + 色散横 + 色散纵 + 高光 + 调色） | **24.7ms** |
| 2 层（高光 + 调色），缘光与色散改走 `box-shadow` | **15.6ms** |
| 完全没有玻璃（低性能损耗模式） | 11.8ms |
| 装饰挪到 `::after` 独立合成层 | 26.6ms（**更慢**，别这么做） |

结论：**能让 `box-shadow` 干的贴边效果，不要用渐变层** ——
它们要跟着 `backdrop-filter` 每帧重新栅格化（滚动时背后内容一直在变）。

★ 另外两个测量陷阱（都踩过）：
* **第一次滚动 ≠ 稳定值**：首轮 24ms、之后 11ms（着色器编译 / 图层提升 / 首帧栅格化）。
  拿首轮当结论会得出"液态玻璃很卡"，然后去做一堆没必要的优化。
* **`CSSRule.cssText` 会丢掉尾注释**：我用 `includes('probe-xxx')` 删自己注入的规则，
  删除循环从来没命中过 → "恢复原样"那一步实际没恢复 → 测的是上一组配置，
  数据自相矛盾了好几轮。改成用一张独立的 `CSSStyleSheet`（`adoptedStyleSheets`），
  整表清空。

### 五、两个 CSS 陷阱（都不是"看代码能看出来"的）

1. ★★ **自定义属性里的 `var()` 在"声明它的元素"上求值**。
   `--glass-layers` 我一开始声明在 `:root`，于是里面的 `var(--glass-tint)`
   在 `:root` 就被替换成兜底色，元素自己（JS 算出来的）**永远进不来** ——
   症状是"取色算对了、画面却全是一个颜色"。
   修法：把它声明在 `.glass, .page-head::before` 上。
2. ★ **`getComputedStyle` 的序列化不按你写的顺序**：
   `inset 0 0 26px -14px rgba(...)` 会输出成
   `rgba(...) 0px 0px 26px -14px inset`；`rgb(r g b / a)` 可能保持现代语法。
   判据写死字符串必然误报 —— **按浏览器实际输出的样子写，或者用正则容忍两种**。

### 六、没做的 / 已知边界

- 桌面壁纸不折射、不参与取色（见第二节的边界）
- 列表里那几十张资源卡片**不做**逐块折射（只给尺寸稳定的大表面），
  否则每块一次离屏滤镜 pass
- 滚动长列表时：本机（Intel UHD 核显）弱化 7ms / 适中 24ms / 灵动 26ms 每帧。
  **弱化档就是给弱机的出口**；如果用户报卡，第一步是把 `--glass-blur` 降下来
- 探针 `probe-webview-glass.mjs` 与 `live-glass-check.mjs` 都在 `tools/live/`，
  换机器/换 WebView2 版本时先跑探针

### 七、第二轮：把"验到了没有"这件事本身做扎实（2026-09-21 晚）

第一轮的验证有个大洞：**② 动态高光只验了"`--glass-gx` 有没有值"** —— 而它
永远有值（CSS 里给了初始值）。补上"指针移两次，看这两个数有没有跟着变"之后，
**当场抓到一个真 bug**：

> `glass.ts` 写的是 `setProperty('--gx', …)`，而 CSS 读的是 `--glass-gx` ——
> 设置成功、**没人读**，高光永远停在初始的 26%/4%。
> 代码读起来毫无破绽（不报错、变量也确实写进去了）。

修完之后实测：左上 `(15%, 19.9%)` → 右下 `(85%, 75.1%)`。

**同一轮补上的另外两条断言**（都是"用户实际会走的路"，之前没验）：
* **应用内改档**（点设置页那个三档控件，**不重载**）—— 之前所有档位验证走的都是
  "写 localStorage + 重载"，那是**启动路径**；两条路的代码完全不同（`readVfx()` 对 `choose()`）。
* **模态**也是玻璃表面（它是折射最该见效的地方）。

### 八、第二轮踩的坑（每一条都是"代码看着对、结果不对"）

1. ★★ **`var()` 缺省值不能是 `none`**：`backdrop-filter: blur(16px) … var(--x, none)`
   在 `--x` 没设时是**非法值** → 整条声明失效 → **磨砂直接没了**（比"没有折射"糟得多）。
   修法：拆成两条规则 + 一个 `[data-lens]` 开关，缺省那条永远有效。
2. ★★ **模板字符串里的反引号**：这个检查脚本的函数体是模板字符串，
   注释里写 `` `--glass-gx` `` 会**提前结束字符串**，报错还指向别处。
   我在同一个文件里**踩了四次** —— 后来索性加了一道自扫（统计每行反引号奇偶）。
3. ★★ **`CSSRule.cssText` 会丢掉尾注释**：用 `includes('probe-x')` 删自己注入的规则
   **永远删不掉**（删除循环从来没命中过），于是"恢复原样"那一步实际没恢复、
   测的是上一组配置 —— 数据自相矛盾了好几轮。改成用一张独立的
   `CSSStyleSheet`（`adoptedStyleSheets`），整表清空。
4. ★ **`<style>` 元素受 CSP 拦，CSSOM 不受限**：第一版 A/B 用
   `document.head.appendChild(<style>)` 注入，五个用例**逐字节全同**（连"涂成红色"
   的正对照都没变）—— 因为注入压根没生效。改用 `insertRule` 立刻通了。
   ★ 教训：**A/B 之前先证明"注入生效了"**（回读计算样式），否则测的是空气。
5. ★ **不要在页面里用 canvas 比截图**：① 20 万像素 base64 塞进一次 `Runtime.evaluate`
   会把 CDP 拖死（实测卡十分钟）；② 页面里 `new Image()` 吃 data URL 被 CSP 拦；
   ③ 只写 `onload` 不写 `onerror` → Promise 永不 settle → `awaitPromise` 一直等。
   **改成在 Node 里自己解 PNG**（`zlib` 内置，几十行），三个问题一起消失。

### 九、关于"折射到底看不看得出来"（诚实结论）

真机上做了两组对照，结论不好听但必须记下来：

* **应用内**：把模态的 `url(#真滤镜)` 换成 `url(#恒等滤镜)`（`feOffset 0,0`，
  其余一字不动），**测不出差别** —— 而同一状态的噪声（连截两张）就有
  **平均差 5.83 / 54% 的像素在动**。也就是说：在这个界面上，折射的像素效果
  **小于它自己的抖动**。
* 原因两层：① 玻璃背后大多是**平滑的背景层**，把一片渐变扭一下还是那片渐变；
  ② 这个界面一直在动（取色重算、列表重渲染），静态对照的前提不成立。

所以分工定死：
* **机制**由 `tools/live/probe-webview-glass.mjs` 证明（那里有高对比条纹，
  开/关两张图的差异一眼可见，还有"坏引用"正对照）；
* **状态**由 `tools/live/live-glass-check.mjs` 验（滤镜挂上了、法线图烘出来了、
  三档与降级都对、指针高光真的跟着走）。

★ 顺手做的两个调整：
* `DISPLACE_PX` 26 → **44**：26 的时候折射在卡片上几乎测不出；
* **标题条那处折射已撤回**：它下面滚过文字，本来最该见效，但真机**测不出任何效果**
  （恒等对照：信号与噪声同为 0.98）。**没效果的代码不留**。
  顺带发现一个**没查清的问题**：那条标题条的磨砂（`blur(16px)`）也看不出在遮挡内容 ——
  同一台机器上探针证明 `backdrop-filter` 对"滚动容器内的元素"和"fixed 元素"都有效、
  标题条的 `::before` 也确实画得出来（去 mask 涂红可见），去掉 `isolation: isolate`
  （它会让元素成为 backdrop root）也没变化。**留作未解问题**，见 `MEMORY.md`。

### 十、第三轮：折射"看不见"的**真根因**在渲染顺序上

前两轮的结论是"背景太平滑，没东西可弯"。这句话只对了一半。真正的机制是：

> ★★ **`backdrop-filter` 是「先模糊、后位移」。**
> `backdrop-filter: blur(18px) … url(#lens)` 里，`blur` 先把背景糊掉，
> `feDisplacementMap` 再在那张**已经糊过的**图上做位移。
> 于是**细于模糊核（18px）的结构全被糊没了**，位移没有东西可弯 ——
> 不管背景里有多少细节，只要它比 blur 核细，就等于没有。

**验证**：在灵动档的背景里加一层 **~70px 尺度**的慢流场（值噪声两层，
`vnoise`，亮度用蓝色那团光斑的色调制），其余一字不动，再量同一组对照：

| | 噪声（同状态连截两张） | 信号（真滤镜 vs 恒等滤镜） |
|---|---|---|
| 平滑背景（第一轮） | 5.83 | 5.83（淹没） |
| **加了 70px 流场** | **0.49** | **1.19**（明显变化像素 0.63% → **10.6%**） |

★ 这一层流场**不是装饰，是折射可见性的前提**。反过来说：如果只想让背景好看，
加细噪点更省 —— 但那样折射永远看不见。（同理，未来的任何"背景美化"都要注意
**尺度别小于模糊核**。）

### 十一、这条判据最后没有留在应用内（诚实记）

上面那组"0.49 / 1.19"是在**静止时刻**量的。把同样的对照放进完整检查流程里就不成立：
**灵动档的背景自己在流动**，同状态连截两张（间隔压到 150ms）平均差仍有 **6.8**、
56% 的像素在变 —— 与"真滤镜/恒等滤镜"的差**完全相等**。

所以最终分工：
* **机制** → `tools/live/probe-webview-glass.mjs`（高对比条纹 + 坏引用正对照）；
* **可见性** → 上面那张表（一次性对照，数字记在这里）；
* **状态** → `live-glass-check.mjs` 的 32 条断言（滤镜挂着、法线图烘出来了、
  三档与降级都对、指针高光真的跟手、帧时间在预算内）。

★ 硬把"像素对照"塞进应用内检查，只会得到一条**永远红**或**永远绿**的假判据 ——
这也是本轮最值得记的一条经验：**判据要能被稳定地跑出来，否则它不是在验证，是在装饰**。

### 十二、第三轮附带：把"标题条的遮挡"这条老账查清了（顺带修好）

查折射时顺手发现：`.page-head`（粘性标题条）那条"磨砂玻璃的底"**看不出在遮挡内容**
（用户当初的原话是"页面标题区去掉黑底…做一个磨砂玻璃的底，这样没有割裂感**还能作遮挡**"）。
逐像素量：**磨砂开 / 关，画面差 0.000**（噪声也是 0.000）—— 它一直在磨空气。

**逐个排除（每一步都回读状态，这一步很关键）**：

| 假设 | 结果 |
|---|---|
| mask 把它裁没了 | ✗ 带 mask 涂红 → 整条 98% 宽度都是红的 |
| `isolation: isolate`（→ backdrop root） | ✗ 去掉后仍然 0.000（**但这一条我第一遍判错了**：没回读"注入是否生效"，得出"不是它"的结论，白绕一圈） |
| `z-index: -1`（负层） | ✗ 挪到 z-index 0 仍然 0.000 |
| 兄弟卡片自己也是 backdrop-filter 层 | ✗ 关掉卡片的滤镜仍然 0.000 |
| 伪元素 vs 真实元素 | ✗ 换成真实 div 仍然 0.000 |
| **`url()` 滤镜（折射）在链里** | ✅ **一旦加上 url(...)，整条 backdrop-filter 失效**（连 blur 一起）：实测「真滤镜 / 同结构但位移 1px 的克隆 / 完全关掉」三者像素**完全一样** |
| **父级是 `position: sticky`** | ✅ 最后一个变量：同样一个带 backdrop-filter 的 div，放 `.content` 里能把背后卡片糊掉，放 `.page-head` 里什么都不做（**平台行为**） |

**结论与处置**：

1. `isolation: isolate` **删掉**（`z-index: 20` 本来就够形成层叠上下文）；
2. 标题条**不挂折射**（挂上去等于把遮挡也一起关掉）；
3. **遮挡不再依赖 `backdrop-filter`** —— 改成"底色 → 透明"的**软渐变**：
   不挑机器、不吃 GPU、结果可预测，仍然和 mask 的羽化配合（"不割裂"照旧）。
   实测：遮挡开/关差 **16.25**、88.9% 的像素在变，而噪声 0.000。

★ 回归判据单独一个脚本：`tools/live/live-pagehead-frost-check.mjs`
（**它每一步都回读状态** —— 这是这一轮用血换来的规矩：
"我去掉了 X，结果没变化"这句话，必须先确认"X 真的被去掉了"）。

### 十三、第四轮：把"降级"从单测升级成真机验收（又抓到一个真缺陷）

用户那条要求是「Win7 或显卡不支持 WebGL 2.0 → **默认适中，并且不开放灵动视效**」。
以前只有 `tests/vfx-rules.test.mjs` 在验 —— 那验的是"**判据函数**算得对"，
**没验过"应用真的会降级"**。这一轮用 Chromium 自己的开关把 WebGL 真的关掉
（`--disable-webgl --disable-3d-apis`，不是往代码里塞假数据），然后逐条验。

结果：**抓到一个真的 UI 缺陷** ——

> 降级是生效了（`data-vfx` 确实是 `mid`），但设置页**没有任何说明**：
> 那一行显示的是"适中视效"被选中，而用户明明选的是灵动。
> 也就是"**用户的选择被悄悄改掉**" —— 正是这个项目的规矩里点名不许出现的那类行为。
>
> 根因：`AppContext` 里 `vfxWant` 的初始值取的是**校正后**的档位（`readVfx().level`），
> 于是 `want === level`，`clamped` 永远是 false，那条"已自动降到…"的提示自然不显示。
>
> 修法：把"**用户选的是什么**"和"**实际生效的是什么**"彻底分开 ——
> 新增 `storedVfx()`（只读存值、不做能力校正），`vfxWant` 用它初始化。
> 现在那一行会说："已自动降到「适中视效」—— 这台机器的显卡（或驱动）
> 不支持 WebGL 2.0，灵动视效开不了"。

真机 13 条断言全绿（`tools/live/live-glass-degrade-check.mjs`），其中值得记的三条：
* 存的还是 `aura`（**不覆盖用户的选择**），生效的是 `mid`；
* 「灵动视效」按钮是**禁用**的，并且 `title` 里写着原因（"不开放" ≠ "藏起来"）；
* **降级不是"变回没做"**：模糊 / 色散 / 厚度 / 调色四条材质都还在，只是没有折射与 GL 背景。

### 十四、覆盖面：玻璃目前只盖住了哪几块（未做，记下来）

跨页面体检（`tools/live/live-glass-pages-check.mjs`）发现：**四个页面里只有设置页有玻璃**
（6 块），启动 / 版本列表 / 下载三页一块都没有 —— 它们用的是 `.pack-card` / `.res-card`，
那两套卡片是**平的半透明面板**（只有 `background: var(--bg-raised)`，没有模糊/缘光/调色）。

**没有顺手铺开**，理由写在下面（这是一个"要不要做"的判断，不是"做不了"）：
* `.res-card` 住在**资源中心那个模态里**，而模态本身就是 backdrop-filter 元素 ——
  在它里面再给每张卡片挂一层模糊，是最贵的组合；
* 资源页一屏 20+ 张卡、还带封面图，材质铺开的代价必须先量（这一轮没量到，
  因为那两套卡片只在"资源中心"和"整合包搜索"出现，默认进不去）；
* 用户还没看过现在的效果，**覆盖面属于观感决策**，等他一句话比我先铺开更好。

★ 这一轮真正验到的是"**玻璃在全应用都成立**"这件事的另一面：**没有玻璃的地方不报错、
不掉帧、也不会被玻璃运行时碰坏**（四页各 4 条断言，含异常捕获）。

### 十五、第五轮：窗口缩放与"烘出来的图会不会攒成垃圾"

透镜法线图是**按元素当时的尺寸**烘的（`ui/glass.ts` 的 `LensRegistry`，
按 `宽×高×圆角` 量化成 key 缓存）。这带来两个**静止时完全看不出来**的问题，
这一轮用 `tools/live/live-glass-resize-check.mjs`（15 条）把它们钉住了：

1. **改了尺寸必须重烘** —— 否则那张图会被拉伸到新尺寸，边缘的弯折变形。
   真机（浏览器窗口 API 改尺寸，不是改 CSS）：
   `1180×760 → 1020×700` 时 key 从 `448x288x12` 变成 `784x288x12`，切回来又变回去 ✓；
   ★ 判据要分两种情况：**尺寸真变了** → key 必须变；**尺寸没变** → key 必须原样复用
   （第一版我把它们混成一条，于是"没改尺寸"被报成"没重烘"，白报了一次红）。
2. **反复改尺寸不能无限攒图** —— 量化到 8px 只是让增长变慢，**不是不增长**：
   加回收之前，三次改尺寸 +4 张、档位来回切再 +1 张（一个开几小时的启动器会攒几百张，
   每张 = 一个 SVG `filter` 节点 + 约 3 KB 的 PNG dataURI）。
   修法：`LensRegistry.prune(active)` —— **只回收当前没有任何元素引用**的那些
   （`data-lens` 里出现的 id 一律留着），在一轮重烘之后调用。
   实测：三次改尺寸之后滤镜数**稳定在 4 张**（= 在用的数量），不再单调增长。

顺带验了两件"只在特定条件下暴露"的事：
* **`StrictMode` 下 effect 跑两遍，GL 画布只有一个**（不泄漏上下文）；
* **档位来回切 3 个来回**之后 GL 画布仍然只有 1 个、折射仍然完好、全程无异常。

### 十六、第六轮：**低性能损耗模式被我自己的装饰层废掉了**（真回归）

`low-perf`（低性能损耗模式）是这个项目早先就有的"省电开关"，它承诺
"**只关装饰**（磨砂与氛围光晕），不动任何功能与布局"，靠 `!important` 关掉全部
`backdrop-filter`。我加玻璃材质时**没有回头看它**，于是第六轮一验就露了：

| 低性能损耗模式开着 | 帧时间（滚动设置页） |
|---|---|
| 只关 `backdrop-filter`（原来的行为） | 平均 **17.8ms** / p95 26.4ms |
| **连装饰渐变层一起关**（修好之后） | 平均 **7.0ms** / p95 7.2ms |

那两层渐变一个人吃掉 **11ms** —— 比它省下来的模糊还贵。也就是说：
**我一边给"弱化视效"档做出 7ms 的廉价路径，一边把"省电开关"变成了 27ms 的摆设。**
修法：`low-perf` 下同时 `--glass-layers: none; background-image: none`。
★ 阴影那 7 条**不花钱**（7.0 vs 6.9），所以留着 —— 剥掉它们只会让卡片像坏了。

**同一轮还修了一处状态不一致**：`low-perf` 开着时 CSS 已经用 `!important`
关掉了折射，但 JS 这边**还在维护透镜**（实测 6 块玻璃仍挂着 `data-lens`、
仍在按尺寸重烘法线图）。修法是给控制器加 `setLowPerf(on)`，
把它并进 `lensWanted()` 的判断里，并在开关变化时重新施加一遍。
★ 教训：**"CSS 用 `!important` 关掉"不是"JS 也该继续干"** —— 两边状态不一致时，
读到 `data-lens` 的人（包括我自己写的验证脚本）都会被误导。

真机 15 条断言：`tools/live/live-glass-lowperf-check.mjs`，其中最重要的是
"**关掉它之后能不能回来**"——用户选的灵动必须回来、GL 与折射必须回来
（只关不恢复是最常见的半成品）。



### 十七、第四轮：用户看过截图之后的四条改造（2026-09-22）

用户的原话（附一张顶部截屏）：

> 灵动视效的光斑好丑，我要原来的那个光斑，但背景有那种烟雾缭绕的感觉；
> 这个高光，你可以学习我的网站的写法 `C:\Users\Administrator\Desktop\Infinity`；
> 顶栏的大黑底好丑，顶部也要液态玻璃；
> 选择灵动视效并且启动器在前台时强制用 GPU 渲染，在后台时不渲染高级效果。

#### 17.1　高光：抄用户网站那套「固定光斑元素 + transform」

用户让我读的那个网站（Hexo 博客 `Infinity`）里，`source/custom/nav/nav-core.js`
把结论写得很清楚，**而且点名批评的正是我原来的写法**：

> 光斑做成独立合成层(.nav-glow-spot) … 位置全部由 JS【直写 style.transform】控制
> （不再用 CSS 变量，避免每帧变量传播/样式重算/背景重绘造成的拖影与跳动）。
> 原方案是在 ::after 上移动 radial-gradient 中心(改 --gx/--gy)，
> **但那属于每帧重绘(paint)**；改用固定尺寸光斑元素 + transform:translate3d，
> transform 只走合成器(compositor)不触发重绘，帧数更高、更跟手。

我原来的实现就是「指针每动一次就改 `--glass-gx/--glass-gy`」—— 也就是说
**指针每移动一格，整块玻璃的背景就要重画一次**。现在改成：

* 每块玻璃里放一个固定尺寸的光斑元素（`--glow-w/h`）与一圈边缘环（mask 抠 1.5px）；
* 位置与亮度**直写 `style.transform` / `style.opacity`**，只走合成器；
* 光心 = 指针到元素矩形的**最近投影点**（clamp）—— 指针在元素外但靠近时，
  光斑压在最靠边那一点上，边缘被照亮（"接近即泛光"）；
* 亮度按**椭圆归一化距离**衰减；
* **rect 缓存**：不是每次 pointermove 都 `getBoundingClientRect()`（那会强制同步布局），
  滚动/尺寸变化时按 rAF 重测；
* 顺带把 `--glass-layers` 从两层减到**一层**（高光不再占渐变层）。

★ 两个踩过的坑：

1. **`position: absolute` 的元素在没定位的滚动容器里不随内容滚动** ——
   "滚动后淡入"一开始完全不工作（`is-scrolled` 永远 false）：哨兵挂在
   `.content`（它没有 `position`）里，却相对更外层祖先定位。改成**在流内 + 负 margin**。
2. **位置与亮度必须各自去重** —— 我第一版写成"亮度没变就 continue"，
   于是指针在卡片**内部**滑动时（亮度恒为 1）**位置更新被一起跳过**，
   症状是"在卡片上滑动光斑不动"。真机检查一眼抓到（两次 transform 完全相同）。

#### 17.2　顶部：fixed 层 + 滚动后淡入（不再是一条大黑底）

用户嫌的那条"大黑底"，是上一轮为了"作遮挡"加的软渐变（底色 0.94 → 透明）。
遮挡是做到了，但它看起来就是一条黑带。现在换成 `.top-glass`：

* **`position: fixed`** —— 这是关键。第三轮已经量过：
  **粘性定位的元素采样不到滚动内容的 backdrop**（`backdrop-filter` 形同不存在），
  而 fixed 层在视口坐标系里采样正常。真机证据：摘掉它的 `backdrop-filter` 之后
  像素平均差 **3.09**、明显变化像素 **34.4%** —— 它**真的在糊内容**。
* **页面在顶部时完全透明**，滚过阈值才淡入（`<html>.is-scrolled` + 只过渡 `opacity`）——
  抄用户网站 `nav-glass.js`：它注释里写着"页面顶部时导航完全透明"，以及
  "只过渡 opacity，直接过渡渐变背景是动画不起来的"。
* 哨兵用 `IntersectionObserver`（不监听 scroll、不占主线程）—— 同样抄自它。
* `.page-head::before` 那一层**整块删掉**；页头只剩标题文字。

#### 17.3　灵动档背景：回到原来的三团光斑 + 烟雾缭绕

上一轮我加了"亮丝"（第三个东西）并把强度倍率提到 2.4 —— 用户的评价是"好丑"。
这一轮：倍率**降回 1.0**（等于直接用令牌里的 alpha，也就是原来的观感），
"高级感"改由**域扭曲（domain warping）**承担：先用两层慢速噪声把 uv 推开
（0.13 + 0.045 两级），再照常算那三团光斑 —— **配色与形状一点没变，只把边界揉成烟絮**；
另加一层浓淡不均（`density`）让烟有疏密。

★ 教训：**"更高级"不等于"加更多东西"**。加一层亮丝 + 提高亮度，结果是把原来
克制的三团彩光推成一片发灰的亮块。用户要的是"原来的光斑 + 烟雾感" ——
那就该动**质感**（边界/浓淡），而不是动**配色与亮度**。

#### 17.4　前台 GPU / 后台不渲染高级效果

用户网站还有一份 `perf/tab-visibility.js`，它把原因写得很清楚：

> 浏览器在标签页失焦时会对动画节流(throttling)，重新聚焦一瞬间会一次性
> 重算该全屏动画 + 全部 backdrop-filter 模糊层 → 卡一下。
> 方案: 页面隐藏时给 html 加 .tab-hidden，CSS 据此暂停所有动画；切回时移除。

照搬到我们这边，"高级效果"有三样，后台时**一起停**：
① GL 背景的 rAF 循环（`cancelAnimationFrame`，不只是 return）；
② 取色定时器（用 `document.hidden` 挡着）；
③ CSS 动画（`.tab-hidden` 里 `animation-play-state: paused`）。
另外把 GL 上下文从 `powerPreference: 'low-power'` 改成 **`'high-performance'`** ——
这是"前台强制用 GPU"里由我们控制的那部分（双显卡笔记本上 `low-power` 会丢给核显）。

★ 验证方式值得记：**把窗口最小化**（`Browser.setWindowBounds` → `windowState: minimized`），
`document.hidden` 会**真的**变成 true —— 不是造假数据。实测：后台时 `tab-hidden` 挂上、
背景画布 `visibility: hidden`，回前台全部恢复。

#### 17.5　本轮真机断言

新增 `tools/live/live-glass-round4-check.mjs`（22 条）。全套真机断言 **132 条**全绿：
主检查 40 + 本轮 22 + 跨页 16 + 降级 13 + 缩放 15 + 低性能 15 + 既有界面检查 11。

★ 同时删掉了 `tools/live/live-pagehead-frost-check.mjs` —— 它整篇验的是
"页头那层遮挡到底有没有生效"，而那一层**已经被这一轮删掉了**；
它的继任者就是上面那 22 条里的顶部玻璃部分（含"模糊真的在糊内容"的像素证据）。

### 十八、显卡与内存：把"跑在独显上"这件事做成应用自己的能力（2026-09-22）

用户看完任务管理器说「**这内存占用，好恐怖**」，随后补充：

> 我希望这些效果能吃 GPU 显存，而且是 GPU 的显存，比如我的是 4G，他就在那里面，
> 而不是堆到内存里。

#### 18.1　先把事实查清：那 335MB 里有一大块不是我们

* 任务管理器里那个"GPU 进程"的内存，**本来就是系统内存**（工作集），
  不是显存；显存要去「性能 → GPU → 专用 GPU 内存」看。
* 用户截图里那组 335MB 旁边，机器上还有**另一组 WebView2 进程**
  （`MicrosoftWindows.Client.CBS_...\EBWebView`，Windows 自己的组件，约 305MB）——
  两组名字一样，很容易看成一回事。
* 我按档位量了一遍（同一二进制、干净启动、隔离 profile、按 profile 目录名认进程）：

  | | 总工作集 | GPU 进程 | 专有显存 |
  |---|---|---|---|
  | 玻璃之前（beta.57） | 475 MB | 159 MB | 0（跑在核显） |
  | 玻璃 · 弱化 | 472 MB | 144 MB | 0 |
  | 玻璃 · 适中 | 549 MB | 207 MB | 0 |
  | 玻璃 · 灵动 | 600 MB | 261 MB | 0 |

  → 弱化档和"玻璃之前"几乎一样（472 vs 475），说明**涨的确实是玻璃**：
  适中 +77MB、灵动再 +51MB。

#### 18.2　真正的病根：它一直跑在**核显**上

`SystemInfo.getInfo`（CDP）给出的渲染器是
`ANGLE (Intel, Intel UHD Graphics …)` —— 这台机器有 **RTX 3050 Laptop（4GB）**，
但应用从头到尾用的是核显。**核显没有独立显存，所有表面只能落在共享/系统内存里** ——
这才是用户"堆到内存里"的观感的来源。

处置（两条都试了，只有第二条有效）：

1. Windows 的「图形性能首选项」（`HKCU\...\DirectX\UserGpuPreferences`）：
   只给 **IEML.exe** 写 `GpuPreference=2` → **完全无效**（实测渲染器仍是 Intel）。
   原因：GPU 工作发生在 **`msedgewebview2.exe`** 那个进程里，而那个镜像没有偏好。
   给运行时 exe 写**有效**（实测切到 NVIDIA），但它有两个毛病：
   ① 要按**带版本号**的路径写（`...\153.0.4234.48\msedgewebview2.exe`），
      WebView2 一升级就失效；② 那是**机器级**设置，会影响所有 WebView2 应用。
2. ✅ **`--force_high_performance_gpu`**：Chromium 自带的开关，由**应用自己**在启动时
   加进 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（必须在创建 WebView2 **之前**）。
   实测（先把注册表那条撤掉）：渲染器变成
   `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU …)`，专有显存 **55.7 MB**。

#### 18.3　什么时候开：按档位，而不是一直开

GPU 适配器在 WebView2 起来的那一刻就选定了，**跑起来改不了**。所以
`lib.rs::request_high_performance_gpu` 读的是**上一次存在 `prefs.json` 里的档位**：
只有 `vfx: aura` 才加那个开关。这既符合用户的原话
（「**选择灵动视效**并且启动器在前台时强制用 GPU 渲染」），也不让独显白白耗电。

真机验证（改 prefs → 重启 → 问 CDP），可重复：

```
prefs.vfx = aura  →  ANGLE (NVIDIA GeForce RTX 3050 Laptop GPU)
prefs.vfx = mid   →  ANGLE (Intel UHD Graphics)
prefs.vfx = aura  →  ANGLE (NVIDIA GeForce RTX 3050 Laptop GPU)
```

★ 因此前端的档位要**多写一份到 `prefs.json`**（localStorage 在 WebView2 profile 里，
Rust 启动时读不到）；设置页那行提示也补上了"会用独显渲染 —— **下次启动生效**"，
免得用户切完档以为没生效。

#### 18.4　顺带砍掉的两笔浪费

* **边缘高亮环那层原来是写死的 2400×1200**（≈11.5MB 显存/元素，还带
  `will-change: transform` → 常驻纹理）。抄用户网站时它只有一个导航栏，
  我铺给了**每个**玻璃元素。改成 `calc(100% + 520px) × calc(100% + 280px)`
  （JS 的位移式子同步改成 `cx - w/2, cy - h/2`）。
* **灵动档那块全屏 GL 画布按 0.6 倍分辨率渲染**：1475×950 → 885×570。
  它画的是糊光斑 + 烟雾，没有锐利细节，拉伸回去看不出来；每帧要填的像素少 64%。

结果（同一二进制）：

| | 优化前 | 优化后 |
|---|---|---|
| 适中 | 549 MB | **533 MB** |
| 灵动 | 600 MB | **539 MB**（其中 55.7MB 在显存里） |

#### 18.5　帧时间：换到独显之后是**另一个量级**

| 档位 | 核显（Intel UHD） | 独显（RTX 3050） |
|---|---|---|
| 灵动 | 平均 26.7ms / p95 35.1ms | **平均 7.2ms / p95 9.5ms** |
| 适中 | 平均 24.0ms / p95 30.8ms | **平均 7.4ms / p95 12.8ms** |
| 弱化 | 平均 6.9ms | 平均 7.0ms |

★ 也就是说：**"灵动档卡不卡"在我之前所有轮的测量里，测的都是核显**。
现在灵动档（7.2ms）和弱化档（7.0ms）几乎一样快 —— 因为它跑在该跑的那块卡上。

#### 18.6　顺带抓到一个我自己造的 regression：**画布铺不满了**

改低分辨率省显存之后，主检查里两条背景断言突然量出 **0.00**（两张截图逐字节相同）。
追下去发现采样区是一片纯色 `#12151a` —— 根因是：

> **`<canvas>` 是替换元素**。只写 `position: fixed; inset: 0` 而不给宽高时，
> `width: auto` 对它**不是"撑满"**，而是回退到 **`width` 属性值** ——
> 也就是我们刚按 0.6 倍设的 backing store 尺寸（885×570）。
> 于是在 1180×760 的窗口里，背景画布**只铺了左上角一块**，右下角全是 body 底色。

之前没露出来是因为老代码的 backing store 是 `视口 × dpr`（1475×950），**比视口还大**，
所以就算布局退回了属性值也照样盖住整窗 —— **是"缩小分辨率"这个优化把它暴露出来的**。

修法：给 `.glass-ambient-gl` 显式写 `width: 100%; height: 100%`（backing 仍然 885×570）。
并补了两条断言（`live-glass-round4-check.mjs`）：

* ★ 画布**盒子**必须 ≥ 视口（铺满）；
* backing store 必须**小于**视口（省显存的初衷还在）。

★ 教训一句话：**"画布变小"与"画的东西变小"是两件完全不同的事，必须分开断言。**

### 十九、第五轮：用户看实机之后的**减法**（2026-09-22）

这一轮用户提了六条，其中五条是**删东西**。原话：

> 烟雾缭绕的感觉不强；低性能损耗模式应是一键开启减少动效和弱化视效；
> 3 个视效模式都应用 GPU 强制渲染吧；卡片自身为什么带左红右蓝的颜色啊，请无颜色；
> 哦对，还有去除指针高光
>
> （稍后补充）哦对了，我不希望卡片会自发光

#### 19.1　删掉的三样（都是我在第一轮按"五要素"加上的）

| 删掉的 | 它当初的来历 | 用户为什么不要它 |
|---|---|---|
| **③ 色散边缘**（红/蓝各错开 1.5px 的内阴影） | 用户第一轮要求里的"色散边缘 1–2px" | 「卡片自身为什么带左红右蓝的颜色啊，**请无颜色**」 |
| **② 指针高光**（光斑元素 + 边缘环 + 距离衰减） | 同一轮要求里的"动态高光"；第四轮我还专门照他网站的写法重做过 | 「**还有去除指针高光**」 |
| **④ 厚度感的柔光内辉**（`inset 0 0 26px -14px` + 顶光） | 同一轮要求里的"厚度感" | 「**我不希望卡片会自发光**」 |

处置：
* 色散：那两条内阴影整条删除，`--glass-disp` / `--glass-disp-a` 两个令牌一并删掉；
* 指针高光：`ui/glass.ts` 里的光斑分层/位移/距离衰减/pointermove 监听、
  `.glass-glow*` / `.glass-edge*` 样式、`--glow-*` 令牌**全部删除**；
  连带 `glass-sheen`（那个类当年只为"高光自己流动"存在）也从 Modal 上摘掉；
* 自发光：那一圈白辉换成**一条清晰的内边**（`inset 0 0 0 1px rgba(255,255,255,.045)`）——
  **"厚度感"靠边界的清晰表达，不靠光晕**。

★★ 这三条连起来是一句值得记住的话：
**玻璃的"高级"来自透明与折射，不来自往卡片上叠装饰。**
我在第一轮把它们当成"五要素"一条条做出来，第五轮又被用户一条条删掉 ——
需求文档里的"要素"是**待验证的假设**，实机观感才是判据。

★ 判据也跟着翻：两个真机脚本里原来"××在"的断言全部改成**反向守卫**
（"DOM 里不许再有光斑元素""移指针不许改变画面""内边在、且不再是辉光"）。
留着一半旧断言就是永远红的假判据 —— 这个项目已经吃过一次亏。

#### 19.2　低性能损耗模式：一键降两档

用户要「**一键开启减少动效和弱化视效**」。原来这个开关只关"装饰"（模糊与氛围光晕），
动效与视效还得自己再点两次。现在它一次做完三件事：

1. 挂 `<html class="low-perf">`（原有的装饰开关）；
2. **动效 → 减少**（`setMotion('lite')`）；
3. **视效 → 弱化**（`vfx.choose('weak')`）。

★ 关键细节：**关掉时还回用户原来的档位**（原值存在 `lowPerfPrev` 里）。
只降不还的开关，用户下次就不敢开了 —— 真机断言里专门有一条"关掉后还回原档"。

#### 19.3　三个档位都强制 GPU

上一轮只在灵动档加 `--force_high_performance_gpu`（当时想的是省笔记本的电）；
用户要一致，于是改成**一律加**（`lib.rs::request_high_performance_gpu` 不再读档位）。
没装独显的机器上这个开关是无害的（Chromium 自己忽略）。

#### 19.4　烟雾：从"边缘有点毛"到真正的絮

上一版只有两级**单层**噪声、幅度 0.13/0.045 —— 用户的评价是「**烟雾缭绕的感觉不强**」。
这一版换成 Inigo Quilez 那套 **fbm domain warping**：

```
q   = fbm(uv)                     // 大团的形变
r   = fbm(uv + 3.6q)              // 在形变后的坐标上再取一次 → 卷曲的絮
wuv = uv + 0.34(q-0.5) + 0.16(r-0.5)
density = mix(0.55, 1.55, smoothstep(0.24, 0.86, fbm(wuv*3.4 + t)))
```

并且噪声本身从 `vnoise` 换成 **`fbm`（3 个倍频）**——单层噪声只有一档尺度，
幅度再大也只是"软斑"，出不来烟的层次。
★ **配色与亮度一律没动**（上一轮把它们推高过，用户的评价是"好丑"）：
"更像烟"靠的是**结构**，不是更亮。
