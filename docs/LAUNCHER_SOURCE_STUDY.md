# PCL2 与 HMCL 源码研读报告

> 目的：在设计 IEML 的加载器安装、Mod 管理、Java 选择、崩溃分析等模块之前，
> 先把两个成熟启动器的真实实现读一遍，避免凭空设计。
> 所有结论均标注来源文件；凡属**推测**的均显式标出，不与已证实内容混淆。
>
> 研读版本：
> - PCL2 `Meloong-Git/PCL` main 分支（2.13.1.1，2026-09）
> - HMCL `HMCL-dev/HMCL` main 分支（3.17，2026-09）

---

## 0. 先说结论：本次研读修正了我们的哪些判断

> 第一轮（第 1–11 章）修正 10 条；第二轮（第 12 章，Mod 列表模块）再修正 8 条；
> 第三轮（第 13 章，版本设置模块）再修正 6 条。合计 24 条，见下方表格。

| # | 我们原先的认知 | 源码事实 | 影响 |
|---|---|---|---|
| 1 | OptiFine 靠「文件覆盖」安装 | 现代版本是**独立 Patcher 程序对原版 jar 做字节码补丁**（`java -cp installer.jar optifine.Patcher`），仅老版本才直接复制 | ADR-003 修订 |
| 2 | OptiFine 仅与 NeoForge 不兼容 | 与 **Forge 1.13~1.14.3 段也不兼容**；与 **Fabric 1.20.5+ 也不兼容** | 约束矩阵补全 |
| 3 | Fabric + OptiFine 只需 OptiFabric 桥接 | 存在**版本上限**，1.20.5+ 一刀切不兼容；且 1.14~1.15 需手动装 OptiFabric Origins | 约束矩阵补全 |
| 4 | 加载器是三层（基础/附加/API） | 业界是**按 libraries 坐标识别组件**，OptiFine 被明确归类为**非加载器组件**（`isModLoader() == false`） | 印证分层正确，但识别方式要改 |
| 5 | 可做 Mod 静态兼容性预检（Mismatch 徽标） | **PCL2 和 HMCL 都不做**。HMCL 解析 Mod 元数据时**根本不读 depends 字段** | ADR-019 降级为「尽力而为 + 明确标注不确定性」 |
| 6 | Java 版本按 MC 版本查表 | 是**13 条带优先级的约束规则**，分强制/建议两档，且「1.17→16 / 1.18→17 / 1.20.5→21」**只在装了 Forge 时生效** | ADR-013 重写 |
| 7 | 「备份 + 让用户点回滚」 | HMCL 用**数据库事务式 Draft**：内存推演 → 一次性提交 → 失败自动逆序回滚，用户无感 | ADR-014 升级 |
| 8 | 崩溃分析是「三段式流水线」 | PCL2 是**日志字符串特征匹配 + 退出码 + 加载进度**的朴素组合；HMCL 是**约 70 条正则规则 + 堆栈关键字启发式兜底** | ADR-011 重写 |
| 9 | 未考虑导出整合包的文件排除 | HMCL 有**约 50 条黑名单**，明确排除各启动器私有文件、登录凭据、运行期缓存 | ADR-020 新增 |
| 10 | 未考虑 LegacyFabric / Cleanroom | 两者都是真实存在且被 HMCL 完整支持的加载器 | 支持列表补全 |
| 11 | 「已启用」状态记在自己的清单里 | **纯看文件扩展名**：`.jar`/`.zip`/`.litemod` 即启用，禁用 = 改名加 `.disabled`/`.old` | **ADR-019 必改**（正确性） |
| 12 | 更新判定按版本号比较 | **文件哈希反查在线库**：CF 用 MurmurHash2、Modrinth 用 SHA1；**不读本地 Mod 元数据** | **ADR-019 必改** |
| 13 | 未考虑重复 Mod（同名启用+禁用并存） | PCL2 用 `EnabledName` 归一化去重，内容不同时**拒绝批量操作** | ADR-019 必修 |
| 14 | 筛选器固定显示 | PCL2 **按数据自动隐藏无意义的筛选器**（无更新就不显示「可更新」），但选中项永远可见 | ADR-019 必修 |
| 15 | 有排序功能 | **PCL2 完全没有排序**，固定字母序 | 谨慎采纳（我们 Mod 数量级更大） |
| 16 | 递归扫描 mods 子目录 | 默认**不递归**，仅 Forge <1.13 且目录名 = 版本号时例外 | ADR-019 必修 |
| 17 | 更新提醒无差别弹 | **仅在 Mod ≥15 个时弹**（或用户主动开启提示） | ADR-019 参考 |
| 18 | 搜索按字段等权 | 加权模糊匹配：名字 1 / 描述 0.4 / 标签与版本 0.2 | ADR-019 参考 |
| 19 | 内存按「物理内存一半」分配 | PCL2 用**自动算法**：按 Mod 数量算四个目标值，再按可用内存四阶段递减比例分配 | **ADR 新增**（直接采纳） |
| 20 | 版本隔离三档卡片，无改动静止保护 | PCL2 改动时弹警告 + **给可逆暗示**（「改回来就能恢复」），取消则回滚选择 | ADR-005 补保护 |
| 21 | 删除实例只提示「存档会被删」 | PCL2 **列出每个存档名 + 上次修改时间**，按 Shift 才永久删 | 设计系统补 |
| 22 | 服务器地址靠用户自己输对 | PCL2 在 `TextChanged` 里**自动把全角标点换成半角** | 必须采纳 |
| 23 | Java 只有「选择某个 Java」 | **四种模式**：自动 / 指定版本区间 / 用版本文件夹中的 Java / 指定绝对路径 | ADR-013 扩充 |
| 24 | 全局设置与实例设置靠命名区分 | PCL2 **在两个位置反复强调**「只对本版本生效」+ 设置项顶部提示条 | 设计系统补 |

---

## 1. 两边源码结构对照

### 1.1 PCL2（VB.NET / WPF，175 个源文件）

```
Plain Craft Launcher 2/
├── Controls/          自定义 WPF 控件库（MyCard / MyListItem / MyMsg* 等）
├── Modules/
│   ├── Base/          ModBase(67KB) ModNet(95KB) ModLoader(37KB) ModAnimation(53KB) ModValidate(18KB)
│   ├── Minecraft/     ModMinecraft(131KB) ModLaunch(123KB) ModDownload(77KB)
│   │                  ModCrash(78KB) ModModpack(53KB) ModJava(35KB) ModWatcher(20KB)
│   ├── Resource/      ResourceProject(36KB) ResourceSearcher(30KB) LocalResourceLoaders(24KB)
│   │                  ResourceVersion(23KB) LocalResourceFile(10KB)
│   └── ModMain / ModEvent / ModSecret / ModMusic / ModDevelop
├── Pages/
│   ├── PageDownload/  ModDownloadLib(122KB) PageDownloadInstall(56KB) Resource/*
│   ├── PageInstance/  PageInstanceSetup(30KB) MyLocalModItem(24KB) PageInstanceExport(43KB)
│   ├── PageLaunch/    PageLaunchLeft(43KB) PageLoginMs / PageLoginAuth / PageSkin...
│   ├── PageSetup/     Settings(28KB) PageSetupUI(36KB) PageSetupLaunch(25KB)
│   └── PageOther / PageSpeed / PageSelect / PageLink
└── Resources/
```

**关键认知：PCL2 存在严重的**命名撞车**，必须按内容判断，不能按文件名。**

| 文件 | 名字看起来像 | 实际是 |
|---|---|---|
| `ModLoader.vb` | 模组加载器安装 | **异步任务调度框架**（`LoaderBase` / `LoaderTask` / `LoaderCombo`），与模组加载器零关系 |
| `ModValidate.vb` | 文件完整性校验 | **用户输入字符串校验**（`ValidateFolderName` / `ValidateHttp` 等规则链） |
| `ModMinecraft.vb` | Minecraft 本体 | 真正的版本管理 + 加载器安装 |
| `ModDownload.vb` | 下载 | 只负责**版本列表获取 + 下载源管理**，不含安装 |
| `ModWatcher.vb` | 崩溃分析 | 只是**进程/日志监视器**，真正的分析在 `ModCrash.vb` + `CrashAnalyzer` |

> PCL2 作者自己在源码库 README 里写：「代码绝大多数是几年前学生时代的产物……
> 经常出现奇葩命名，还有高耦合、没做单例、瞎勾八乱糊之类的问题……基于能跑就行」。

### 1.2 HMCL（Java / JavaFX，960 个源文件）

```
HMCLCore/src/main/java/org/jackhuang/hmcl/
├── addon/             附加内容管理
│   ├── AddonLoaderType / AddonLoader / LocalAddonManager / RemoteAddon(9KB)
│   ├── meta/          【关键】各加载器的 Mod 元数据解析器
│   │                  FabricModMetadata / ForgeNewModMetadata(14KB) / ForgeOldModMetadata
│   │                  QuiltModMetadata / LiteModMetadata / PackMcMeta(11KB)
│   ├── mod/           LocalModFile(7KB) ModManager(13KB) ModLoaderType
│   ├── datapack/      DataPack(13KB)
│   ├── resourcepack/  ResourcePackManager(23KB) ResourcePackFile / ResourcePackZipFile / ResourcePackFolder
│   └── repository/    CurseForgeRemoteAddonRepository(29KB) ModrinthRemoteAddonRepository(24KB)
├── download/          安装任务，按加载器分包
│   ├── optifine/      OptiFineInstallTask(14KB) / OptiFineBMCLVersionList / OptiFineRemoteVersion
│   ├── forge/         ForgeNewInstallTask(19KB) / ForgeInstallTask / ForgeOldInstallTask
│   │                  ForgeNewInstallProfile(7KB) / ForgeBMCLVersionList(9KB)
│   ├── neoforge/      NeoForgeOldInstallTask(18KB) / NeoForgeInstallTask / NeoForgeOfficialVersionList
│   ├── fabric/        FabricInstallTask / FabricAPIVersionList / FabricAPIInstallTask
│   ├── quilt/         QuiltInstallTask / QuiltAPIVersionList / QuiltAPIInstallTask
│   ├── liteloader/    LiteLoaderInstallTask / LiteLoaderBMCLVersionList / LiteLoaderVersionList
│   ├── legacyfabric/  LegacyFabricInstallTask / LegacyFabricAPIVersionList
│   ├── cleanroom/     CleanroomInstallTask / CleanroomVersionList
│   ├── game/          GameAssetDownloadTask / GameLibrariesTask / GameInstallTask
│   │                  GameVerificationFixTask / GameInstanceJsonDownloadTask
│   ├── java/          JavaPackageType / disco/DiscoJavaDistribution(6KB)
│   │                  mojang/MojangJavaDownloadTask(9KB)
│   ├── DefaultCacheRepository(9KB) / DefaultDependencyManager(23KB)
│   └── AutoDownloadProvider(8KB) / BMCLAPIDownloadProvider(8KB) / MojangDownloadProvider
├── game/             【最核心】
│   ├── GameComponentType(10KB)    组件类型枚举（13 个）
│   ├── GameComponentAnalyzer(8KB) 组件识别器
│   ├── GameInstanceManifest(38KB) / GameInstancePatch(33KB)
│   ├── DefaultGameRepository(22KB) / DefaultGameRepositoryDraft(27KB) ★事务机制
│   ├── DefaultGameRepositorySnapshot(10KB) / DefaultGameRepositoryDraft
│   ├── JavaVersionConstraint(15KB) ★13 条 Java 约束
│   ├── CrashReportAnalyzer(21KB) ★约 70 条崩溃规则
│   ├── GameJavaVersion / Library(10KB) / Arguments(5KB) / Renderer(23KB)
│   └── World(18KB) / GameInstanceLibraryBuilder(9KB) / LaunchManifestNormalizer(16KB)
├── launch/           DefaultLauncher(51KB) StreamPump / ProcessListener
├── modpack/          整合包：curse / modrinth / multimc / mcbbs / server 五套 Provider
│   └── ModAdviser(4KB) ★导出黑名单
├── task/             Task(43KB) FetchTask(28KB) FileDownloadTask AsyncTaskExecutor(15KB) CacheFileTask(7KB)
└── util/
    ├── versioning/   GameVersionNumber(33KB) VersionNumber(14KB) VersionRange(5KB) ★
    ├── CacheRepository(17KB) / MurmurHash2(16KB) ★缓存 key
    ├── io/           FileUtils(21KB) NetworkUtils(18KB) CompressingUtils(11KB) Zipper/Unzipper
    ├── gson/         JsonUtils(32KB) JsonSchema(20KB) ObservableSetting(17KB)
    └── platform/     OperatingSystem / Architecture / CommandBuilder(15KB) / hardware/* 
                      windows/* (WinReg 12KB, WinTypes 19KB) macos/* linux/*
```

**HMCL 的结构清晰度远高于 PCL2**，模块边界干净，每个加载器一个包，值得作为 IEML 的 Rust 侧模块划分参照。

---

## 2. 模组加载器：真实的类型体系

### 2.1 HMCL `GameComponentType` —— 13 个组件，分两类

源码 `game/GameComponentType.java`，是一个**带抽象方法 `matchLibrary` 的枚举**：

```java
public enum GameComponentType {
    GAME("game"),                              // 永远不通过 libraries 识别，单独传入
    LEGACY_FABRIC("legacyfabric",  ModLoaderType.LEGACY_FABRIC),
    LEGACY_FABRIC_API("legacyfabric-api"),
    FABRIC("fabric",               ModLoaderType.FABRIC),
    FABRIC_API("fabric-api"),
    FORGE("forge",                 ModLoaderType.FORGE),
    CLEANROOM("cleanroom",         ModLoaderType.CLEANROOM),
    NEO_FORGE("neoforge",          ModLoaderType.NEO_FORGE),
    LITELOADER("liteloader",       ModLoaderType.LITE_LOADER),
    OPTIFINE("optifine"),                      // ★ 无 ModLoaderType
    QUILT("quilt",                 ModLoaderType.QUILT),
    QUILT_API("quilt-api"),
    ;
    public static final List<GameComponentType> ALL = List.of(values());
    public static final List<GameComponentType> MOD_LOADERS =
            ALL.stream().filter(GameComponentType::isModLoader).toList();
}
```

**关键设计：用构造函数有无第二个参数来区分「加载器」和「伴随组件」。**

- `isModLoader()` 的实现就是 `return modLoaderType != null;`
- **`OPTIFINE` 不带 `ModLoaderType` → 它不是加载器**
- 三个 API 包（`FABRIC_API` / `QUILT_API` / `LEGACY_FABRIC_API`）也不带 → 不是加载器
- `GAME` 也不带 → 游戏本身不是加载器

> 这从源码层面**确证了用户第四轮的判断**：「OptiFine 是可以在原版安装的」——
> 因为它压根就不在加载器这个范畴里，它是与加载器正交的叠加组件。

### 2.2 识别方式：读 libraries 的 Maven 坐标

`matchLibrary(library, libraries)` 是识别核心。**不是看文件名，是看 libraries 列表里的 groupId:artifactId。**

| 组件 | 识别条件（verbatim） |
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

**两个真实的歧义陷阱（都在源码里被显式处理）：**

1. **Fabric vs LegacyFabric** —— 两者都用 `net.fabricmc:fabric-loader` 这个坐标。
   区分方法是**看 libraries 里有没有 `net.legacyfabric` 的 groupId**。
2. **Forge vs NeoForge** —— NeoForge 1.20.1 时代沿用 `net.minecraftforge` groupId。
   所以 `FORGE.matchLibrary` 里必须再跑一次 `NEO_FORGE.matchLibrary`，
   命中就返回 false。源码注释里也承认这是历史包袱。

**教训：IEML 的加载器识别必须用「坐标 + 排除条件」，不能只匹配单一坐标。**

### 2.3 `ModLoaderType` 枚举

位于 `addon/mod/ModLoaderType.java`，被 `GameComponentType` 引用。
从源码可确认存在的成员：`LEGACY_FABRIC`、`FABRIC`、`FORGE`、`CLEANROOM`、`NEO_FORGE`、
`LITE_LOADER`、`QUILT`（共 7 个真加载器）。

> 注意命名：是 `NEO_FORGE`（下划线）与 `LITE_LOADER`（下划线），不是 `NEOFORGE` / `LITELOADER`。

### 2.4 PCL2 的加载器判定：集中在 `PageDownloadInstall.xaml.vb`

PCL2 用一组 `LoadXxxGetError()` 函数，**返回 `Nothing` 表示可用，否则返回中文错误串**：

```vb
Function LoadOptiFineGetError() As String
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
    ' 未选任何加载器时 → 遍历 OptiFine 版本列表，可用
End Function
```

**这是 IEML 约束矩阵最权威的参照，逐条列出：**

| 组合 | 结果 | 条件 |
|---|---|---|
| 原版 + OptiFine | ✅ 允许 | 无任何加载器时 `Return Nothing` |
| NeoForge + OptiFine | ❌ | 无条件 |
| Forge + OptiFine | ❌ | 仅 MC ∈ [1.13, 1.14.3] |
| Forge + OptiFine | ⚠️ 条件允许 | 其他版本需过 `IsOptiFineSuitForForge` |
| Fabric + OptiFine | ❌ | 仅 MC > 1.20.4（即 ≥1.20.5） |
| Fabric + OptiFine | ⚠️ 需 OptiFabric | ≤1.20.4；且 1.14~1.15 要手动下 OptiFabric Origins |
| NeoForge + Forge / Fabric | ❌ | 无条件 |
| Forge + Fabric | ❌ | 无条件 |
| LiteLoader | ⚠️ 独立 | 仅 MC < 1.13（`VanillaDrop < 130`），只受 MC 大版本约束，不参与其他互斥 |

**`IsOptiFineSuitForForge(OptiFine, Forge)` 的完整规则：**

```
Inherit（MC 大版本）必须一致
├─ RequiredForgeVersion 为 Nothing  → 不兼容（该 OptiFine 不支持 Forge）
├─ RequiredForgeVersion 为空白串   → 兼容（对应 issue #4183）
├─ RequiredForgeVersion 含 "."     → 与 Forge.Version 做 CompareVersion(...) == 0
└─ RequiredForgeVersion 不含 "."   → 比较 Forge.Version.Revision == RequiredForgeVersion
```

### 2.5 交互层：冲突的消解方式（重要设计参考）

PCL2 处理冲突有**三个层次**，从强到弱：

1. **硬阻止** —— `CardXxx_PreviewSwap` 事件里，
   `If LoadXxxGetError() IsNot Nothing Then e.Handled = True` —— **不兼容的卡片根本展不开**。
   用户**在界面上选不出非法组合**。

2. **主动消解** —— 选中某项时**自动清掉冲突项**：
   - `OptiFine_Selected` 若与已选 Forge 不匹配 → `SelectedForge = Nothing`
   - `Forge_Selected` 若与已选 OptiFine 不匹配 → `SelectedOptiFine = Nothing`
   
   > 注意：不是弹窗报错，是**直接静默清掉**并刷新 UI。
   > 这比「报错让用户自己改」体验好得多，但代价是用户可能没注意到自己的选择被改了。

3. **软提示** —— 三条 `Hint` 横幅，只警告不阻止：
   - `HintFabricAPI` —— 选了 Fabric 但没装 Fabric API
   - `HintOptiFabric` / `HintOptiFabricOld` —— Fabric + OptiFine 缺桥接包
   - `HintModOptiFine` —— 1.16+ 同时选 OptiFine 与 Forge/Fabric

4. **兜底折叠** —— `ReloadSelected()` 里若仍有错误，强制 `CardXxx.IsSwapped = True` 折叠。

**另一个重要细节：OptiFine 卡片只在「有可用版本」时才展开列表**，
即 `LoadOptiFineGetError()` 返回 `Nothing` 之后，还要再遍历 OptiFine 版本列表确认存在适配版本。
**不是「允许」就一定「有货」。**

### 2.6 安装顺序：源码里的权威一句话

HMCL `OptiFineInstallTask` 类注释：

```java
/**
 * <b>Note</b>: OptiFine should be installed in the end.
 */
```

**OptiFine 必须最后装。** 这印证了我们的「安装顺序铁律」，且给出了明确终点。

---

## 3. OptiFine 的真实安装机制（重大修正）

### 3.1 不是「文件覆盖」，是「Patcher 打补丁」

HMCL `download/optifine/OptiFineInstallTask.java` 的 `execute()` 核心：

```java
Path optiFineLibraryPath = gameRepository.getLayout().getLibraryFile(manifest.id(), optiFineLibrary);
if (Files.exists(fs.getPath("optifine/Patcher.class"))) {
    String[] command = {
        JavaRuntime.getDefault().getBinary().toString(),
        "-cp", installerFile.toString(),
        "optifine.Patcher",
        minecraftJar.toAbsolutePath().normalize().toString(),   // ← 原版 jar 作为输入
        installerFile.toString(),
        optiFineLibraryPath.toString()                          // ← 输出
    };
    int exitCode = SystemUtils.callExternalProcess(command);
    if (exitCode != 0)
        throw new IOException("OptiFine patcher failed, command: " + ...);
} else {
    FileUtils.copyFile(installerFile, optiFineLibraryPath);   // ← 老版本：直接复制
}
```

**两种路径，按 installer 里有没有 `optifine/Patcher.class` 分叉：**

- **有 Patcher（现代版本）** —— 拉起一个 Java 子进程，用 OptiFine 自带的 Patcher
  对**原版 client jar** 做字节码级补丁，产出 OptiFine 库 jar
- **无 Patcher（老版本）** —— 直接复制 installer 当库文件

> 所以「OptiFine 是文件覆盖」这个说法**方向对、机制不准**。
> 准确说法：OptiFine 通过**修改原版 jar 的字节码**来注入渲染引擎，
> 现代实现是独立 Patcher 程序，不是简单覆盖文件。
> 但**结果上**它确实产出一个「被改造过的原版」，
> 所以「能独立装在纯原版上」这个结论**依然成立**。

### 3.2 安装时做的一堆琐事（我们完全没想到的）

```
1. 校验 minecraftJar 存在
2. 校验原版 mainClass 在 GameComponentAnalyzer.FORGE_OPTIFINE_MAIN 白名单内，
   否则抛 UnsupportedInstallationException(UNSUPPORTED_LAUNCH_WRAPPER)
3. 把 installer 复制到 libraries/optifine/OptiFine/<mcVer>_<ofVer>/ 下的 installer 路径
4. 【删文件】打开该 installer 的 zip，删掉 /META-INF/mods.toml
   —— 为了让 Forge 不把它当成一个 Mod 去加载
5. 跑 Patcher（或复制）
6. 【再删一次】对产出的库 jar，同样删掉 /META-INF/mods.toml
7. 处理 launchwrapper：
   - 若 installer 里有 launchwrapper-2.0.jar  → 提取为库 optifine:launchwrapper:2.0
   - 若 installer 里有 launchwrapper-of.txt   → 读版本号，提取 launchwrapper-of-<ver>.jar
8. 检查 buildof.txt：若原版 mainClass 是 BOOTSTRAP_LAUNCHER_MAIN（Forge 1.17+）
   且 buildofVer < "20210924-190833" → 抛 FORGE_1_17_OPTIFINE_H1_PRE2
   （注释：OptiFine H1 Pre2+ is compatible with Forge 1.17）
9. 若前面没拿到任何 launchwrapper → 补 net.minecraft:launchwrapper:1.12
10. 产出 GameInstancePatch：
    - id       = "optifine"
    - version  = remote.getSelfVersion()
    - priority = 10000   ← 【优先级极高】
    - 添加 gameArguments: --tweakClass optifine.OptiFineTweaker
    - mainClass = GameComponentAnalyzer.LAUNCH_WRAPPER_MAIN
11. 触发 GameLibrariesTask 下载上面收集到的所有库
```

**第 4 步和第 6 步的「删 `META-INF/mods.toml`」是一个非常巧妙的技巧** ——
OptiFine 的 installer jar 里带了这个文件，如果留在 libraries 里，
Forge 启动时会把它当成一个 Mod 去解析，导致冲突。删掉即可规避。

**第 10 步的 `priority = 10000`** ——
HMCL 的 `GameInstancePatch` 有优先级概念，数值越大越靠后应用。
OptiFine 用 10000 这个极大值，**从数据结构层面保证了「OptiFine 最后装」**，
而不是靠调用顺序的约定。

### 3.3 `libraries` 目录布局

```java
String mavenVersion = remote.getGameVersion() + "_" + remote.getSelfVersion();
// 形如：1.20.1_HD_U_I6

optiFineLibrary = new Library(new Artifact("optifine", "OptiFine", mavenVersion));
// → libraries/optifine/OptiFine/1.20.1_HD_U_I6/OptiFine-1.20.1_HD_U_I6.jar

optiFineInstallerLibrary = new Library(
    new Artifact("optifine", "OptiFine", mavenVersion, "installer"), null,
    new LibrariesDownloadInfo(new LibraryDownloadInfo(
        "optifine/OptiFine/" + mavenVersion + "/OptiFine-" + mavenVersion + "-installer.jar",
        remote.getUrls().get(0).toString()))
);
```

**mavenVersion 的格式是 `<MC版本>_<OptiFine自述版本>`**，例如 `1.20.1_HD_U_I6`。
这是「MC 版本」和「OptiFine 版本」的绑定方式。

### 3.4 从本地 installer 反解版本号（很妙的一招）

`OptiFineInstallTask.install(...)` 静态方法，**从用户给的 installer jar 里读出它对应的 MC 版本**：

```java
try (FileSystem fs = CompressingUtils.createReadOnlyZipFileSystem(installer)) {
    Path configClass = fs.getPath("Config.class");
    if (!Files.exists(configClass)) configClass = fs.getPath("net/optifine/Config.class");
    if (!Files.exists(configClass)) configClass = fs.getPath("notch/net/optifine/Config.class");
    if (!Files.exists(configClass)) throw new IOException("Unrecognized installer");

    ConstantPool pool = ConstantPoolScanner.parse(Files.readAllBytes(configClass), ConstantType.UTF8);
    // 在 Config.class 的常量池里找 MC_VERSION / OF_EDITION / OF_RELEASE
    String mcVersion = getOrDefault(constants, constants.indexOf("MC_VERSION") + 1, null);
    String ofEdition = getOrDefault(constants, constants.indexOf("OF_EDITION") + 1, null);
    String ofRelease = getOrDefault(constants, constants.indexOf("OF_RELEASE") + 1, null);

    if (mcVersion == null || ofEdition == null || ofRelease == null)
        throw new IOException("Unrecognized OptiFine installer");
    if (!mcVersion.equals(gameVersion))
        throw new VersionMismatchException(mcVersion, gameVersion);
    ...
}
```

**它用 `ConstantPoolScanner` 解析 `Config.class` 的字节码常量池**，
从 `MC_VERSION` / `OF_EDITION` / `OF_RELEASE` 三个常量后面读取值。

而且 `Config.class` 的位置**试了三种**：`Config.class`、`net/optifine/Config.class`、`notch/net/optifine/Config.class`
—— 对应不同年代的 OptiFine 打包方式。

**这解决了我们的一个开放问题（「OptiFine 无官方 API 的取法」）：**
即使完全拿不到在线 API，也能**从用户本地已有的 installer jar 里反解出精确版本**，
并且**校验它和目标 MC 版本是否匹配**（不匹配抛 `VersionMismatchException`）。
这是一个可靠的离线兜底方案，IEML 必须实现。

---

## 4. Mod 元数据解析：为什么「静态兼容性预检」不可行

### 4.1 HMCL 的 `FabricModMetadata` —— 完全不读依赖

`addon/meta/FabricModMetadata.java` 的全部字段：

```java
private final String id;
private final String name;
private final String version;
private final String description;
private final String icon;
private final List<FabricModAuthor> authors;
private final Map<String, String> contact;

public static LocalModFile fromFile(ModManager modManager, Path modFile, ZipFileTree tree) {
    ZipArchiveEntry mcmod = tree.getEntry("fabric.mod.json");
    if (mcmod == null) throw new IOException("File " + modFile + " is not a Fabric mod.");
    FabricModMetadata metadata = JsonUtils.fromNonNullJsonFully(tree.getInputStream(mcmod), FabricModMetadata.class);
    ...
}
```

**就这 7 个字段。`fabric.mod.json` 里明明有 `depends` / `breaks` / `conflicts` /
`recommends` / `suggests` / `provides` / `environment`，一个都没解析。**

### 4.2 HMCL 的 `ForgeNewModMetadata` —— 只读一个字段，且只为了判归属

它解析 `META-INF/mods.toml`，字段是：`modLoader` / `loaderVersion` / `logoFile` /
`license` / `mods[]`（每个 Mod 有 `modId` / `version` / `displayName` / `side` /
`displayURL` / `authors` / `description` / `logoFile`）。

**依赖相关的解析只有一处，叫 `analyzeLoader`，而且目的不是校验兼容性：**

```java
private static ModLoaderType analyzeLoader(TomlParseResult toml, String modID, ModLoaderType loader) {
    // 读 dependencies.<modID> 数组（兼容各种写错的格式）
    ...
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
}
```

**关键：它读 `dependencies` 里有没有 `modId == "forge"` 或 `"neoforge"` 这一条，
用来判断「这个 jar 属于哪个加载器」，而不是判断「这个 Mod 能不能在这个实例上跑」。**

而且注意这两行 `LOG.warning` —— **HMCL 自己承认会出现加载器归属不一致**，
它的处理是：**记个警告，然后采信 TOML 里声明的那个**。

> 这是一个非常重要的信号：**连 HMCL 都不敢根据 Mod 元数据做硬性判定。**
> 因为现实中的 Mod 元数据太脏了 —— 写错的、漏写的、故意写宽范围的，比比皆是。

### 4.3 `ForgeNewModMetadata` 的其他现实妥协

从源码能读出三个「现实的坑」：

**坑 1：`dependencies` 数组格式不统一。** 它试了三种写法：
```java
toml.getArray("dependencies." + modID)   // 标准写法
toml.getArray("dependencies")             // ??? 源码注释：I have no idea why some of the Forge mods use [[dependencies]]
toml.getTable("dependencies").getArray(modID)  // 另一种变体
```
而且每一层都包在 `try { } catch (ClassCastException | Throwable ignored) { }` 里，
还引用了 issue #5068 说明这是真实存在的问题。

**坑 2：`mods.get(0)` —— 只取第一个。**
```java
Mod mod = metadata.getMods().get(0);
```
一个 jar 里有多个 mod 块时，后面的全被忽略。
（现实中确实有 Mod 这么做，但 HMCL 选择了只认第一个。）

**坑 3：加载器探测有完整的三级 fallback：**
```java
if (modLoaderType == ModLoaderType.NEO_FORGE) {
    try { return fromFile0("META-INF/neoforge.mods.toml", ...); } catch (Exception ignored) {}
}
try { return fromFile0("META-INF/mods.toml", ...); } catch (Exception ignored) {}
try { return fromEmbeddedMod(...); } catch (Exception ignored) {}   // jar-in-jar 内嵌
throw new IOException("File " + modFile + " is not a Forge 1.13+ or NeoForge mod.");
```

第三级 `fromEmbeddedMod` 处理 **jar-in-jar**：
读 `META-INF/jarjar/metadata.json` 或 `MANIFEST.MF` 里的 `Embedded-Dependencies-Mod`，
把内嵌的 jar 解出来递归解析。这是 Forge 的「库内嵌」机制。

**坑 4：`${file.jarVersion}` 占位符。**
```java
jarVersion == null ? mod.getVersion() : mod.getVersion().replace("${file.jarVersion}", jarVersion)
```
mods.toml 里写 `${file.jarVersion}` 时，需要从 `MANIFEST.MF` 的
`Implementation-Version` 属性取值替换。

### 4.4 结论：IEML 的 Mod 兼容性策略必须调整

**原 ADR-019 设想：** 读 Mod 元数据的兼容字段，比对实例 MC 版本 + 加载器，
主动标出「不匹配」。

**源码事实：** PCL2 和 HMCL 都不这么做。HMCL 连 `depends` 都不解析。

**修正后的策略：**

| 层次 | 做法 | 可信度 |
|---|---|---|
| **L1 元数据读取** | 按加载器读对应元数据文件，**取 MC 版本声明**（`fabric.mod.json` 的 `depends.minecraft`、`mods.toml` 的 `dependencies` 里 `modId=minecraft` 的 `versionRange`） | 声明可能不准 |
| **L2 展示为「提示」而非「判定」** | 若声明的 MC 版本范围不含当前实例版本 → 标 **「可能不兼容」**（黄色，措辞保守），**不能标「不兼容」** | 只能提示 |
| **L3 文件名启发式** | 括号里的版本号（`xxx-1.20.1-fabric.jar`）仅作参考，**不能作为判定依据** | 仅供排序 |
| **L4 运行时兜底（主力）** | 真正的判定靠**崩溃日志分析** —— 这是两个启动器的共同选择 | 可信 |

**UI 用词必须改：** 「不匹配」→ **「可能不兼容」**，并且徽标要能点开说明
「此判断基于 Mod 自述信息，作者可能未及时更新，实际以能否启动为准」。

### 4.5 附：各加载器的元数据文件位置（源码确认）

| 加载器 | 文件路径 | 解析类 |
|---|---|---|
| Fabric | `fabric.mod.json` | `FabricModMetadata` |
| Quilt | `quilt.mod.json` | `QuiltModMetadata` |
| Forge 1.13+ | `META-INF/mods.toml` | `ForgeNewModMetadata` |
| NeoForge | `META-INF/neoforge.mods.toml`（失败则回退 `mods.toml`） | `ForgeNewModMetadata.fromNeoForgeFile` |
| LiteLoader | （由 `LiteModMetadata` 处理） | `LiteModMetadata` |
| 资源包 | `pack.mcmeta` | `PackMcMeta` |
| 数据包 | （`DataPack`） | `DataPack` |
| Forge jar-in-jar | `META-INF/jarjar/metadata.json` 或 `MANIFEST.MF: Embedded-Dependencies-Mod` | `ForgeNewModMetadata` |

---

## 5. Java 版本选择：13 条带优先级的约束规则

### 5.1 核心结构

HMCL `game/JavaVersionConstraint.java` 是一个**枚举**：

```java
public enum JavaVersionConstraint {
    // 每条规则携带三个信息：
    private final boolean isMandatory;                              // 强制 or 建议
    private final VersionRange<GameVersionNumber> gameVersionRange; // 适用的游戏版本范围
    private final VersionRange<VersionNumber> javaVersionRange;     // 允许的 Java 版本范围

    public final boolean appliesToVersion(GameVersionNumber, GameInstanceManifest,
                                          JavaRuntime, GameComponentAnalyzer) {
        return gameVersionRange.contains(gameVersionNumber)
                && appliesToVersionImpl(gameVersionNumber, version, java, analyzer);
    }

    public boolean checkJava(...) {
        return getJavaVersionRange(version, analyzer).contains(java.getVersionNumber());
    }
}
```

**两个概念要分清：**
- `appliesToVersion` —— **这条规则是否适用于这个实例**
- `checkJava` —— **这个 Java 是否满足该规则**

枚举声明顺序 = **优先级**，注释里明确写了 "give priority to..."。

### 5.2 全部 13 条规则（verbatim）

| 序 | 枚举名 | 强制 | 游戏版本范围 | Java 版本范围 | 附加条件 |
|---|---|---|---|---|---|
| 1 | `VANILLA` | ✅ | 全部 | 全部 | `version.javaVersion() == null` |
| 2 | `GAME_JSON` | ✅ | 全部 | 动态 | MC ≥ 1.7.10 且 JSON 有 javaVersion |
| 3 | `MODDED_JAVA_7` | ❌ | ≤1.7.2 | ≤1.7.999 | **有 Forge** |
| 4 | `MODDED_JAVA_8` | ❌ | 1.7.10~1.16.999 | 1.8~1.8.999 | **有 Forge** |
| 5 | `MODDED_JAVA_16` | ❌ | 1.17~1.17.999 | 16~16.999 | **有 Forge** |
| 6 | `MODDED_JAVA_17` | ❌ | 1.18~1.20.4 | 17~17.999 | **有 Forge** |
| 7 | `MODDED_JAVA_21` | ❌ | ≥1.20.5 | 21~21.999 | **有 Forge** |
| 8 | `CLEANROOM` | ✅ | 1.12.2~1.12.999 | 动态 | 有 Cleanroom |
| 9 | `LAUNCH_WRAPPER` | ✅ | ≤1.12.999 | ≤1.8.999 | mainClass 匹配且 launchwrapper < 1.13 |
| 10 | `VANILLA_JAVA_8_51` | ❌ | ≥1.13 | ≥1.8.0_51 | — |
| 11 | `VANILLA_LINUX_JAVA_8` | ✅ | ≤1.12.999 | ≤1.8.999 | Linux + x86_64 |
| 12 | `VANILLA_X86` | ❌ | 全部 | 全部 | ARM64 + (Win/macOS) + MC < 1.6 |
| 13 | `MODLAUNCHER_8` | ❌ | 1.16.3~1.17.1 | 全部 | 按 Forge 补丁号细分 |

### 5.3 三个「不看源码绝对想不到」的点

**点 1：`MODDED_JAVA_*` 五条全部绑定 `analyzer.has(GameComponentType.FORGE)`。**

```java
return analyzer != null && analyzer.has(GameComponentType.FORGE)
        && super.appliesToVersionImpl(gameVersionNumber, version, java, analyzer);
```

也就是说：
- **「1.17 要 Java 16 / 1.18 要 Java 17 / 1.20.5 要 Java 21」这些规则只在装了 Forge 时生效**
- **原版（无 Forge）走 `VANILLA` + `GAME_JSON`**，Java 需求由版本 JSON 的 `javaVersion` 字段决定
- **Fabric / Quilt / NeoForge 在这份源码里没有专门的 Java 约束规则**

> 这修正了我们 ADR-013 的「按 MC 版本查表」写法。
> 真实模型是：**版本 JSON 优先，Forge 特例覆盖，硬件/OS 兜底。**

**点 2：`GAME_JSON` 明确不信任 1.7.10 以下的元数据。**

```java
// We only checks for 1.7.10 and above, since 1.7.2 with Forge can only run on Java 7,
// but it is recorded Java 8 in game json, which is not correct.
return gameVersionNumber.compareTo("1.7.10") >= 0 && version.javaVersion() != null;
```

**源码注释直接写明：1.7.2+Forge 只能跑 Java 7，但游戏 JSON 里记的是 Java 8。**
所以启动器学会了**对老版本元数据不信任**。

**点 3：`MODLAUNCHER_8` 精细到 Forge 补丁号和 Java build 号。**

游戏侧（按 Forge 版本）：
```java
switch (gameVersionNumber.toString()) {
    case "1.16.3": return forgePatchVersion.compareTo(VersionNumber.asVersion("34.1.27")) >= 0;
    case "1.16.4": return true;
    case "1.16.5": return forgePatchVersion.compareTo(VersionNumber.asVersion("36.2.23")) <= 0;
    case "1.17.1": return VersionNumber.between("37.0.60", "37.0.75").contains(forgePatchVersion);
    default: return false;
}
```
注释：`Minecraft 1.16+Forge with crash because JDK-8273826`

Java 侧（按 Java 主版本 + 补丁号）：
```java
if (parsedJavaVersion > 17)        return false;
else if (parsedJavaVersion == 8)   return java.getVersionNumber().compareTo(VersionNumber.asVersion("1.8.0_321")) < 0;
else if (parsedJavaVersion == 11)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("11.0.14")) < 0;
else if (parsedJavaVersion == 15)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("15.0.6")) < 0;
else if (parsedJavaVersion == 17)  return java.getVersionNumber().compareTo(VersionNumber.asVersion("17.0.2")) < 0;
else                               return true;
```

**这些全是 bug 报告累积出来的精确边界，靠猜永远猜不到。**

### 5.4 其他值得抄的规则

**`VANILLA_LINUX_JAVA_8`：**
```java
return OperatingSystem.CURRENT_OS == OperatingSystem.LINUX
        && Architecture.SYSTEM_ARCH == Architecture.X86_64
        && (java == null || java.getArchitecture() == Architecture.X86_64)
        && (analyzer == null || !analyzer.has(GameComponentType.CLEANROOM));
```
注释：Linux 上 JDK 9+ 无法启动 MC ≤ 1.12.2，因为 JDK 9+ 不接受不同架构的原生库
（64 位 JDK 无法加载 32 位 lwjgl）。**这是纯 Linux 特有的坑。**

**`LAUNCH_WRAPPER`：**
```java
GameComponentAnalyzer.LAUNCH_WRAPPER_MAIN.equals(version.mainClass()) &&
version.getLibraries().stream()
    .filter(library -> "launchwrapper".equals(library.artifactId()))
    .anyMatch(library -> VersionNumber.asVersion(library.version())
        .compareTo(VersionNumber.asVersion("1.13")) < 0)
```
注释：LaunchWrapper ≤1.12 会崩，因为它假定系统类加载器是 `URLClassLoader`（Java 8 的行为）。

**`VANILLA_JAVA_8_51`：**
注释：`Minecraft >= 1.13 may crash when generating world on Java [1.8, 1.8.0_51)`
—— **Java 8 的早期小版本在地形生成时会崩**，这个细节极其隐蔽。

**`CLEANROOM` 的动态范围：**
```java
return VersionNumber.atLeast(String.valueOf(
    GameJavaVersion.getCleanroomJavaVersion(cleanroomVersion).majorVersion()));
```
按 Cleanroom 自己的版本查出所需 Java。

---

## 6. 版本区间匹配：`VersionRange` 的极简模型

### 6.1 完整实现（就两个字段）

HMCL `util/versioning/VersionRange.java`：

```java
public final class VersionRange<T extends Comparable<T>> {
    private final T minimum;
    private final T maximum;
    // 四个工厂方法
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

    public boolean isOverlappedBy(final VersionRange<T> that) { ... }
    public VersionRange<T> intersectionWith(VersionRange<T> that) { ... }
}
```

**关键事实：`[minimum, maximum]` 是闭区间，两端都含。**

`contains` 用的是 `minimum <= v && maximum >= v`。

### 6.2 它**不支持**什么（重要）

- ❌ **Maven 的半开区间**（`[1.0,2.0)` / `(1.0,2.0]`）
- ❌ **`> <` 运算符字符串解析**（没有 `parse` 方法，只有工厂方法）
- ❌ **通配符 / `*` / `x` 语义**
- ❌ **"any" 特殊 token**（`all()` 是显式调用）

**所以我们的伪代码里写「按 `versionRange` 匹配」是不成立的** ——
真实的做法是**上游把各种声明形式统一转换成 `VersionRange` 对象**，
再调用 `contains` / `isOverlappedBy` / `intersectionWith`。

### 6.3 `intersectionWith` 是依赖冲突检测的数学工具

判断「A 要求 B ≥ 1.0，实装 B 是 0.9」：
```
VersionRange B_required  = atLeast("1.0")
VersionRange B_actual    = is("0.9")
B_required.intersectionWith(B_actual).isEmpty() == true  → 冲突
```

多 Mod 的联合约束就**求交集**：
```
所有依赖同一库的 Mod 的区间 → fold(intersectionWith) → 结果非空即可满足
```

**这比逐条 if-else 判断清晰得多，IEML 应该照抄这个模型。**

### 6.4 相关的版本号工具

| 类 | 大小 | 作用 |
|---|---|---|
| `GameVersionNumber` | 33KB | MC 版本号（含快照、`1.20.1-rc1`、combat test 等特殊格式） |
| `VersionNumber` | 14KB | 通用版本号比较 |
| `VersionRange` | 5KB | 区间（本文） |

`GameVersionNumber` 有 24KB 的测试文件 `GameVersionNumberTest.java`，
说明 MC 版本号的格式极其复杂（快照 `24w45a`、预发布 `1.20.1-pre1`、
`1.16_combat-3` 等）。**IEML 必须准备等价的版本号比较实现。**

---

## 7. 实例修改的事务机制：Draft（重大收获）

### 7.1 设计目标

HMCL `game/DefaultGameRepositoryDraft.java` 的 Javadoc：

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

**它把游戏实例的修改做成了数据库事务。** 这是我们 ADR-014 里完全没有的层次。

### 7.2 状态机

```java
enum State { OPEN, COMMITTING, COMMITTED, FAILED, ABORTED }
// 初始 OPEN
// abort():  ABORTED → 直接返回；COMMITTED → 抛异常；FAILED → 直接返回
// close():  仅在 OPEN 时调用 abort()
```

### 7.3 关键字段（verbatim）

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

### 7.4 `commit()` 的执行顺序

```
1. checkOpen() + repository.checkActiveDraft(this)
2. state = COMMITTING
3. 建立三类回滚记录：appliedRenames / removedRoots / appliedFiles，以及 rollbackDirectory
4. buildCommittedSnapshot()          ← 先在内存造出最终不可变快照并 seal()
5. 若有 rename/remove → repository.flushPendingInstanceWrites()
6. 依次应用 renames
7. materializeCreatedInstanceRoots() ← 为新实例创建根目录
8. 若有 removed/modified/jarSources：
   a. createRollbackDirectory()
   b. 循环 removedIds      → removeInstanceRoot(...)
   c. 循环 primaryJarSources → applyPrimaryJar(...)
   d. 循环 modifiedIds      → applyManifest(...)
9. repository.publishDraftSnapshot(this, committedSnapshot)   ← 发布
10. state = COMMITTED
11. repository.releaseDraft(this)
12. cleanupRollbackDirectoryAfterCommit(rollbackDirectory)
```

### 7.5 失败回滚 —— 严格逆序

```java
catch (IOException | RuntimeException e) {
    // 1. 逆序回滚已应用的文件
    Collections.reverse(appliedFiles);
    for (AppliedFile file : appliedFiles) {
        Files.deleteIfExists(file.targetFile());
        if (file.backupFile() != null) moveReplacing(file.backupFile(), file.targetFile());
    }
    // 2. 逆序回滚被移除的根
    Collections.reverse(removedRoots);
    for (RemovedRoot root : removedRoots) moveReplacing(root.rollbackRoot(), root.originalRoot());

    // 3. 逆序回滚重命名
    Collections.reverse(appliedRenames);
    for (RenameOperation rename : appliedRenames)
        DefaultGameRepository.moveInstanceFiles(baseDir, rename.to(), rename.from());

    state = FAILED; repository.releaseDraft(this);
    cleanupCreatedInstanceRoots();
    FileUtils.deleteDirectory(rollbackDirectory);
    throw e;   // 所有子异常通过 addSuppressed 聚合
}
```

**三类回滚 record：**
```java
private record AppliedFile(Path targetFile, @Nullable Path backupFile) {}
private record RenameOperation(GameInstanceID from, GameInstanceID to) {}
private record RemovedRoot(Path originalRoot, Path rollbackRoot) {}
```

### 7.6 三个额外的安全设计

**1. 回滚目录：**
```
<baseDir>/.hmcl/repository-drafts/commit-<temp>/
├── removed/     被移除的实例根
└── backups/     被替换文件的备份
```
**成功即删、失败即恢复。**

**2. 原子移动优先：**
```java
private static void moveReplacing(Path source, Path target) throws IOException {
    // 优先 Files.move(..., ATOMIC_MOVE, REPLACE_EXISTING)
    // 失败退化为 REPLACE_EXISTING
    // 再失败把原子失败作为 suppressed 抛出
}
```

**3. 路径越界防护（相当于我们说的 zip-slip 防护）：**
```java
private void validateInstanceFileTarget(GameInstanceID id, Path target, String description) {
    if (target.equals(expectedRoot) || !target.startsWith(expectedRoot))
        throw new IOException(description + " path escapes instance root: " + target);
}
```
**目标必须是实例根的严格后代。**

**4. 特殊约束：`rename` 不允许改本草稿新建的实例**
```java
if (createdIds.contains(from))
    throw new IllegalStateException("Cannot rename an instance created by the same draft");
if (manifests.containsKey(to))
    throw new IllegalArgumentException("Target instance already exists: " + to);
```
而且 rename 会**联动重写 `inheritsFrom`** ——
遍历所有 manifest，把 `inheritsFrom() == from` 的改成 `to`，并纳入 `modifiedIds`。

### 7.7 对 IEML 的启示

我们的 ADR-014「备份回滚」是「用户视角的回滚」——
先复制一份，改坏了让用户点「恢复」。

HMCL 的 Draft 是「**系统视角的事务**」——
改动先在内存推演完，落盘时若中途失败，**自动逆序还原，用户甚至不知道出过错**。

**两者应该并存：**
- **Draft 机制**负责单次安装/更新操作的原子性（装 Forge 到一半失败 → 自动还原）
- **备份快照**负责跨操作的版本历史（今天装的，明天想退回昨天 → 用户主动恢复）

而且 HMCL 明确了边界：**共享的 library / asset 缓存不在回滚范围内**
（因为它们被多个实例复用，回滚会牵连其他实例）。这个边界划分是对的。

---

## 8. 崩溃分析：两边都靠「日志特征匹配」

### 8.1 HMCL `CrashReportAnalyzer` —— 约 70 条正则规则

`game/CrashReportAnalyzer.java`，结构是：

```java
public final class CrashReportAnalyzer {
    private CrashReportAnalyzer() {}          // 工具类，不可实例化

    enum Rule {                                // ★ 核心：规则枚举
        OPENJ9(Pattern.compile(...), "groupName1", "groupName2"),
        // ... 约 70 条
        ;
        private final Pattern pattern;
        private final String[] groupNames;
    }

    record Result(Rule rule, String log, Matcher matcher) {}

    static Set<Result> analyze(String log) { /* 遍历所有 Rule 匹配 */ }

    static String findCrashReport(String log);          // 定位崩溃报告文件路径
    static String extractCrashReport(String rawLog);    // 从日志截取崩溃报告正文
    static Set<String> findKeywordsFromCrashReport(String crashReport);  // ★ 启发式兜底
    static int getJavaVersionFromMajorVersion(int majorVersion);
}
```

**8 大类规则分布：**

| 类别 | 规则数 | 举例 |
|---|---|---|
| JVM / Java 版本 | 8 | `OPENJ9` `NEED_JDK11` `TOO_OLD_JAVA` `JVM_32BIT` `JDK_9` `JAVA_VERSION_IS_TOO_HIGH` `MODLAUNCHER_8` `MAC_JDK_8U261` |
| 内存 | 2 | `OUT_OF_MEMORY` `MEMORY_EXCEEDED` |
| 图形 / OpenGL | 5 | `GL_OPERATION_FAILURE` `OPENGL_NOT_SUPPORTED` `GRAPHICS_DRIVER` `RESOLUTION_TOO_HIGH` `MACOS_FAILED_TO_FIND_SERVICE_PORT_FOR_DISPLAY` |
| 模组加载 / 解析失败 | 15 | `DUPLICATED_MOD` `MOD_RESOLUTION` `FORGEMOD_RESOLUTION` `FORGE_FOUND_DUPLICATE_MODS` `MOD_RESOLUTION_CONFLICT` `MOD_RESOLUTION_MISSING` `MOD_RESOLUTION_MISSING_MINECRAFT` `MOD_RESOLUTION_COLLECTION` `FABRIC_WARNINGS` `FABRIC_VERSION_0_12` `MOD_FILES_ARE_DECOMPRESSED` `TOO_MANY_MODS_LEAD_TO_EXCEEDING_THE_ID_LIMIT` 等 |
| 模组导致加载崩溃 | 6 | `LOADING_CRASHED_FORGE` `BOOTSTRAP_FAILED` `LOADING_CRASHED_FABRIC` `MODMIXIN_FAILURE` `MIXIN_APPLY_MOD_FAILED` `FORGE_ERROR` |
| 类 / 方法异常 | 8 | `FILE_CHANGED` `NO_SUCH_METHOD_ERROR` `NO_CLASS_DEF_FOUND_ERROR` `ILLEGAL_ACCESS_ERROR` `FILE_ALREADY_EXISTS` `CONFIG` `UNSATISFIED_LINK_ERROR` `INSTALL_MIXINBOOTSTRAP` |
| 游戏内崩溃 | 3 | `ENTITY` `BLOCK` `DEBUG_CRASH` |
| 特定 Mod 冲突 | 8 | `OPTIFINE_IS_NOT_COMPATIBLE_WITH_FORGE` `OPTIFINE_CAUSES_THE_WORLD_TO_FAIL_TO_LOAD` `SHADERS_MOD` `MOD_FOREST_OPTIFINE` `PERFORMANT_FOREST_OPTIFINE` `TWILIGHT_FOREST_OPTIFINE` `JADE_FOREST_OPTIFINE` `RTSS_FOREST_SODIUM` |
| 安装 / 加载器问题 | 6 | `FORGE_REPEAT_INSTALLATION` `OPTIFINE_REPEAT_INSTALLATION` `MOD_NAME` `INCOMPLETE_FORGE_INSTALLATION` `NIGHT_CONFIG_FIXES` |

**最有价值的几条（精确定位肇事 Mod）：**

| 规则 | 正则（节选） | 捕获组 |
|---|---|---|
| `LOADING_CRASHED_FORGE` | `LoaderExceptionModCrash: Caught exception from (?<name>.*?) \((?<id>.*)\)` | `name`, `id` |
| `BOOTSTRAP_FAILED` | `Failed to create mod instance\. ModID: (?<id>.*?),` | `id` |
| `LOADING_CRASHED_FABRIC` | `Could not execute entrypoint stage '(.*?)' due to errors, provided by '(?<id>.*)'!` | `id` |
| `MIXIN_APPLY_MOD_FAILED` | `Mixin apply for mod (?<id>.*) failed` | `id` |
| `DUPLICATED_MOD` | `Found a duplicate mod (?<name>.*) at (?<path>.*)` | `name`, `path` |
| `MOD_RESOLUTION_MISSING` | `ModResolutionException: Could not find required mod: (?<sourcemod>.*) requires (?<destmod>.*)` | `sourcemod`, `destmod` |
| `MOD_RESOLUTION_CONFLICT` | `ModResolutionException: Found conflicting mods: (?<sourcemod>.*) conflicts with (?<destmod>.*)` | `sourcemod`, `destmod` |
| `CONFIG` | `Failed loading config file (?<file>.*?) of type (.*?) for modid (?<id>.*)` | `id`, `file` |

**注意 `MOD_RESOLUTION_MISSING_MINECRAFT`：**
`...requires {minecraft @ (?<version>.*)}` —— **这是「Mod 与 MC 版本不兼容」的运行时证据**。
所以「版本不匹配」这个判定，**在崩溃日志里是有明确签名的**，
完全可以等到崩溃时再精确判定，不必靠静态预检去猜。

### 8.2 `findKeywordsFromCrashReport` —— 堆栈启发式

当规则匹配不到时，从崩溃报告堆栈里提取可疑包名：

```java
static final Pattern CRASH_REPORT_STACK_TRACE_PATTERN = Pattern.compile(
    "Description: (.*?)[\\n\\r]+(?<stacktrace>[\\w\\W\\n\\r]+)A detailed walkthrough of the error");
static final Pattern STACK_TRACE_LINE_PATTERN = Pattern.compile(
    "at (?<method>.*?)\\((?<sourcefile>.*?)\\)");
static final Pattern STACK_TRACE_LINE_MODULE_PATTERN = Pattern.compile("\\{(?<tokens>.*)}");
```

算法：
1. 截取 `Description: ... A detailed walkthrough of the error` 之间的堆栈
2. 逐行匹配 `at <method>(<sourcefile>)`
3. 把 method 按 `.` 拆分，**丢掉末尾 2 段**（类名 + 方法名），只留包路径
4. 过 `PACKAGE_KEYWORD_BLACK_LIST` 过滤官方包名
5. 剩下的作为候选，交给上层**与已安装 Mod 列表比对**
6. 额外处理 JPMS 模块：`{xf:<name>}` 形式取第二个字段

**`PACKAGE_KEYWORD_BLACK_LIST` 约 150 个词，是这份源码里最有价值的资产之一。**
它实际上**逆向给出了 MC / Forge / Fabric 的完整包名空间**：

- **Minecraft**：`net minecraft item setup block assist optifine player unimi fastutil tileentity events common blockentity client entity mojang main gui world server dedicated map dsi renderer chunk model loading color pipeline inventory launcher physics particle gen registry worldgen texture biomes biome monster passive ai integrated tile state play override transformers structure nbt pathfinding audio entities items renderers storage universal oshi platform`
- **Java/JDK**：`java lang util nio io sun reflect zip jar jdk nashorn scripts runtime internal`
- **通用词**：`mods mod impl org com cn cc jp core config registries lib ruby mc codec recipe channel embedded done net netty network load github handler content feature file machine shader general helper init library api integration engine preload preinit hellominecraft jackhuang`
- **Forge**：`fml minecraftforge forge cpw modlauncher launchwrapper objectweb asm event eventhandler handshake modapi kcauldron`
- **Fabric**：`fabricmc loader game knot launch mixin`

> 注意：这个黑名单里混进了大量**过于通用的词**（`item` `block` `client` `world` `api`
> `core` `config` `lib`），说明这份名单是**宽松优先**的 —— 宁可漏报也不误报。
> 代价是很多真 Mod 的包名也会被过滤掉。

### 8.3 崩溃报告提取的两个正则

```java
// 定位文件路径
CRASH_REPORT_LOCATION_PATTERN = "#@!@# Game crashed! Crash report saved to: #@!@# (?<location>.*)"

// 无需读文件，直接从日志截取
extractCrashReport(rawLog):
    起点 = 最后一个 "---- Minecraft Crash Report ----"
    终点 = 最后一个 "#@!@# Game crashed! Crash report saved to"
    若任一缺失或起点 >= 终点 → 返回 null
```

### 8.4 Java 版本反推

```java
static int getJavaVersionFromMajorVersion(int majorVersion) {
    if (majorVersion >= 46) return majorVersion - 44;
    else return -1;
}
```
class 文件 major 46 → Java 1.2。用于 `TOO_OLD_JAVA` 规则：
正则捕获 `expected`（class 版本号），转换后告诉用户**精确的目标 Java 版本**。

### 8.5 PCL2 `ModWatcher` —— 朴素的进程监视器

PCL2 的做法比 HMCL 更「土」但更稳。`Modules/Minecraft/ModWatcher.vb` 分两层：
全局模块统计「是否有 MC 在跑」，`Watcher` 类管单进程。

**崩溃检测：4 条字符串匹配**（且要求该行**不含 `[CHAT]`**）：

| 匹配字符串 | 判定 |
|---|---|
| `Someone is closing me!` / `Restarting Minecraft with command` | 正常关闭 → `Ended` |
| `Crash report saved to` / `This crash report has been saved to:` | 崩溃 |
| `Could not save crash report to` | 崩溃 |
| `/ERROR]: Unable to launch` | 崩溃 |
| `An exception was thrown, the game will display an error screen and halt.` | 崩溃（Forge） |

**退出码判定（有实测得来的坑）：**
```
1. State == Loading 时进程退出     → "尚未加载完成，可能已崩溃"
2. ExitCode <> 0 且 State == Running 且 Instance.ReleaseTime.Year >= 2012 → 崩溃
3. 其他且 State <> Crashed         → 正常 Ended
```

源码注释里留了两条**被否决**的思路，很有价值：
- `"Minecraft ran into a problem! Report saved to:"` —— 被注释
- `"Shutdown failure!"` —— 被注释，原因：**点 X 强关也会触发，不可用**
- `ExitCode == 1` 当「任务管理器结束」的判据 —— 被否决，**因为崩溃同样是 1**

**加载进度用日志特征点做 1/5 ~ 5/5：**
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

> 这个设计比「假进度条」诚实得多 —— **进度直接反映真实的加载阶段**。

**窗口探测（几个必须知道的坑）：**
- 类名白名单：`GLFW30` / `SDL_app` / `LWJGL` / `SunAwtFrame`
- 标题排除：以 `FML` 开头、等于 `PopupMessageWindow`、以 `GLFW` 开头
- **注释明确：Mod 可以修改窗口标题，所以不能只判断是否以 "Minecraft" 开头**
- 进程时间校验：窗口所属进程的 `StartTime` 必须 ≥ 游戏进程的 `StartTime`
- `FML` / `Quilt Loader` 开头的是**加载器自己的窗口**，不是游戏主窗口
- 反作弊/安全软件会拦截窗口操作，抛 `Win32Exception`（issue #1062），需优雅降级

**崩溃后的处理：**
```
State = Crashed
→ 报错日志 + 红色 Hint
→ FeedbackInfo()
→ 新线程 "Crash Analyzer"：等待 2 秒 ← 给崩溃报告写完的时间
→ new CrashAnalyzer(Instance).Collect(PathIndie, LatestLog).Prepare().Analyze()
→ Output(...) 产出：<实例>.json / PCL/Log1.txt / PCL/LatestLaunch.bat
```

**另外 `LatestLog` 是 `ConcurrentQueue(Of String)`，上限约 501 条** ——
只保留最近 500 行日志，避免内存无限增长。

---

## 9. 整合包导出的文件黑名单（我们漏掉的功能）

HMCL `modpack/ModAdviser.java`。名字有误导性 ——
**它不是「Mod 兼容性顾问」，是整合包导出/导入时的文件过滤规则。**

```java
public interface ModAdviser {
    ModSuggestion advise(String fileName, boolean isDirectory);
    enum ModSuggestion { SUGGESTED, NORMAL, HIDDEN }
}
```

### 9.1 `MODPACK_BLACK_LIST` —— 约 50 条，导出时**绝不包含**

按类别整理（verbatim 精选）：

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
> **`launcher_msa_credentials.bin` 被列入黑名单 —— 微软登录凭据绝不能进整合包。**
> 这是安全红线，IEML 必须遵守。

**游戏本体与缓存（不该进整合包）**
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

### 9.2 `MODPACK_SUGGESTED_BLACK_LIST` —— 默认不勾但可选

```
fonts"                    ← BetterFonts
saves", "servers.dat", "options.txt"  ← 存档、服务器列表、游戏设置
blueprints"               ← BuildCraft
optionsof.txt"            ← OptiFine 设置
journeymap"               ← JourneyMap
optionsshaders.txt"       ← 光影设置
mods/VoxelMods"
```

> **注意 `saves/` 默认不导出** —— 这是对的，整合包分享不该带别人的存档。

### 9.3 匹配规则

```java
static boolean match(List<String> l, String fileName, boolean isDirectory) {
    for (String s : l)
        if (isDirectory) {
            if (fileName.startsWith(s + '/')) return true;
        } else {
            if (s.startsWith("regex:")) {
                if (fileName.matches(s.substring("regex:".length()))) return true;
            } else {
                if (fileName.equals(s)) return true;
            }
        }
    return false;
}
```

**匹配的语义很重要：**
- **目录** —— `fileName.startsWith(s + "/")`，即**前缀匹配**（目录及其全部内容）
- **文件** —— 非 regex 条目是**精确相等**，不是前缀
- 路径格式统一为 `rel_path_to_dir/`（目录带尾斜杠）或 `rel_path_to_file`，**与操作系统无关**

---

## 10. 缓存机制

### 10.1 HMCL 的缓存分层

| 类 | 大小 | 职责 |
|---|---|---|
| `util/CacheRepository.java` | 17KB | 缓存仓库抽象 |
| `download/DefaultCacheRepository.java` | 9KB | 默认实现 |
| `task/CacheFileTask.java` | 7KB | 缓存文件任务 |
| `util/MurmurHash2.java` | 16KB | 缓存 key 的哈希算法 |

**关键发现：缓存 key 用 MurmurHash2，不是 SHA。**
MurmurHash2 是**非加密哈希**，速度快、分布均匀，适合做缓存 key。
16KB 的实现（含 11KB 测试）+ 测试覆盖说明这里要求**跨平台字节级一致** ——
因为缓存要在不同机器/版本之间稳定命中。

**这和我们的设计一致（`key = hash(输入 + 缓存格式版本号)`），
但具体算法应该用 MurmurHash2 而不是 SHA256** —— 缓存 key 不需要抗碰撞。

### 10.2 缓存的使用方式

从 `OptiFineInstallTask` 可见典型用法：

```java
var task = new FileDownloadTask(
        dependencyManager.getDownloadProvider().injectURLsWithCandidates(remote.getUrls()),
        installerFile, null);
task.setCacheRepository(dependencyManager.getCacheRepository());
task.setCaching(true);   // ← 开启缓存
```

**`setCaching(true)` + `injectURLsWithCandidates`** ——
下载时先查缓存，命中则跳过网络。

### 10.3 多源竞速（PCL2 的 `DlSourceLoader`）

PCL2 的下载源管理值得借鉴：
- 每个资源都有**官方源 + 镜像源**两条
- `DlSourceLoader` 统管竞速，`DlSourceOrder` / `DlVersionListOrder` 决定优先级
- 由 `Settings("ToolDownloadVersion")` 配置：`0` = 优先镜像、`1` = 先官方、其他 = 自定义

**镜像域名（硬编码，可作 IEML 的默认镜像表）：**
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

**官方源（作对照）：**
```
GET https://launchermeta.mojang.com/mc/game/version_manifest.json     (要求 Versions.Count >= 200)
GET https://optifine.net/downloads                                     (正则解析 HTML 表格)
GET https://files.minecraftforge.net/maven/net/minecraftforge/forge/index_<MC>.html
GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge
GET https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge     (1.20.1 legacy)
GET https://meta.fabricmc.net/v2/versions
GET https://dl.liteloader.com/versions/versions.json
```

**一个必须注意的细节：`DlSourceLibraryGet` 里对 Forge/Fabric/NeoForge 的库文件，
源码明确「不添加原版源」：**
```vb
If {"minecraftforge", "fabricmc", "neoforged"}.Any(Function(k) Original.Contains(k)) Then
    '不添加原版源
```
因为这些库**根本不在 Mojang 的源上**，加原版源只会浪费一次失败请求。

**另一个细节：Forge 的版本分类优先级**
```
Case "installer"  → Proi = 2   ← 优先（能用 installer 自动装）
Case "universal"  → Proi = 1
Case "client"     → Proi = 0
```
**优先选 installer 分类的构建**，因为 universal/client 分类**无法自动安装**。
PCL2 的 `LoadForgeGetError()` 里会跳过 `Category = "universal"` 或 `"client"` 的版本。

**NeoForge 有个硬编码的黑名单：排除了 `47.1.82`** ——
源码注释：「这个版本虽然在版本列表中，但不能下载」。**现实世界的脏数据。**

---

## 11. 其他值得记录的实现细节

### 11.1 OptiFine 版本列表的解析（PCL2）

官方源是**正则解析 HTML**，因为 OptiFine 没有 API：
```vb
Request https://optifine.net/downloads
Dim Forge    As List(Of String) = Result.RegexSearch("(?<=colForge'>)[^<]*").ToList
Dim ReleaseTime As List(Of String) = Result.RegexSearch("(?<=colDate'>)[^<]+").ToList
Dim Name     As List(Of String) = Result.RegexSearch("(?<=OptiFine_)[0-9A-Za-z_.]+(?=.jar"")").ToList
```

**抓三个列：`colForge`（所需 Forge 版本）、`colDate`（发布日期）、文件名。**
所以 OptiFine 的「所需 Forge 版本」信息**来自 HTML 表格**，
这正是 HMCL 那个 `RequiredForgeVersion` 字段的数据来源。

**`RequiredForgeVersion` 的语义（PCL2 源码注释）：**
```
需要的最低 Forge 版本。空字符串为无限制，Nothing 为不兼容，
"28.1.56" 表示版本号，"1161" 表示版本号的最后一位。
```
判定：`If Entry.RequiredForgeVersion.Contains("N/A") Then = Nothing`（N/A → 不兼容 Forge）

### 11.2 `DlForgelikeEntry` 的继承结构（PCL2）

```
MustInherit Class DlForgelikeEntry  (实现 IComparable(Of DlForgelikeEntry))
├── Class DlForgeVersionEntry       (继承)
└── Class DlNeoForgeListEntry       (继承)
```
Forge 和 NeoForge 共用一个抽象基类 —— 因为它们的版本列表结构几乎一样。

### 11.3 Fabric 的附加列表

PCL2 除了 Fabric 主列表，还维护两个：
```
DlFabricApiLoader    → fabric-api
DlOptiFabricLoader   → OptiFabric（CurseForge 项目 ID 322385）
```
**`OptiFabric` 是从 CurseForge 拿的，项目 ID 是 322385。** 这个 ID 可以直接用。

### 11.4 LiteLoader 的版本号构造

```
跳过 MC 1.5 / 1.6
取 artefacts / snapshots 下的 com.mumfrey:liteloader.latest
构造文件名：liteloader-installer-<MC>-00-SNAPSHOT.jar
```

### 11.5 Forge 安装的三个 Task（HMCL），按版本分岔

| 类 | 大小 | 适用 |
|---|---|---|
| `ForgeOldInstallTask` | 4KB | 老版本 Forge |
| `ForgeInstallTask` | 11KB | 一般版本 |
| `ForgeNewInstallTask` | 19KB | 新版本（最复杂） |
| `ForgeNewInstallProfile` | 7KB | 新版 install_profile 解析 |

NeoForge 同理：`NeoForgeInstallTask`(8KB) / `NeoForgeOldInstallTask`(**18KB**)。

> **注意 NeoForge 的「Old」任务比「New」大得多**（18KB vs 8KB）——
> 因为 1.20.1 时代的 NeoForge 沿用 Forge 的安装体系，逻辑更绕。
> 这印证了 2.2 节说的 Forge/NeoForge 历史包袱。

### 11.6 HMCL 的 Java 获取双渠道

```
download/java/mojang/MojangJavaDownloadTask(9KB)  + MojangJavaDownloads / MojangJavaRemoteFiles
download/java/disco/DiscoJavaDistribution(6KB)    + DiscoFetchJavaListTask / DiscoJavaRemoteVersion(7KB)
download/java/JavaPackageType
```
`JavaDistribution` 是抽象，两个实现：Mojang 官方 + Disco。
**双渠道是必要的** —— Mojang 只提供特定版本，Disco 覆盖更全。

### 11.7 硬件检测（HMCL 独有，PCL2 没有）

HMCL 有完整的硬件检测体系，**这在启动器里是罕见的**：
```
util/platform/hardware/  CentralProcessor / GraphicsCard / HardwareDetector / HardwareVendor
                         PhysicalMemoryStatus / FastFetchUtils
util/platform/windows/   WinReg(12KB) WinTypes(19KB) Kernel32 Gdi32 User32 Dwmapi Shell32 Ole32 Advapi32
                         WindowsCPUDetector / WindowsGPUDetector / IPropertyStore
util/platform/linux/     LinuxCPUDetector(10KB) / LinuxGPUDetector(13KB) / LinuxHardwareDetector
util/platform/macos/     MacOSHardwareDetector(9KB) / ObjectiveCRuntime / HomebrewUtils
```
**用途推测**：崩溃分析时判断「是不是显卡驱动问题」、推荐合适的渲染设置。
（`GraphicsAPI` / `Renderer`(23KB) 也在 `game/` 下，可能与渲染后端选择有关。）

> 这对 IEML 的「崩溃分析」有参考价值：
> 判断 `GRAPHICS_DRIVER` 类崩溃时，如果有 GPU 信息就能给出更具体的建议
> （比如「检测到你使用 NVIDIA 显卡但游戏跑在集显上，请切换独显」）。

### 11.8 整合包四条 Provider 线路

```
modpack/curse/     CurseInstallTask(14KB) CurseCompletionTask(10KB)
modpack/modrinth/  ModrinthInstallTask(12KB) ModrinthCompletionTask(6KB) ModrinthModpackExportTask(10KB)
modpack/multimc/   MultiMCModpackInstallTask(21KB) MultiMCInstanceConfiguration(13KB)
                   MultiMCComponents / MultiMCInstancePatch(16KB)
modpack/mcbbs/     McbbsModpackLocalInstallTask(9KB) McbbsModpackCompletionTask(19KB)
                   McbbsModpackManifest(13KB)
modpack/server/    ServerModpackLocalInstallTask / ServerModpackRemoteInstallTask / ServerModpackCompletionTask
```

**名字里的 `CompletionTask` 很关键** ——
整合包安装分两步：**先按 manifest 装，再「补全」**（校验+补齐缺失文件）。
`ModpackCompletionException` / `ModpackConfiguration` 支撑这个机制。

> 我们对整合包的设计只到「识别 + 创建实例」，
> **缺了 `CompletionTask` 这一层「装完再校验补齐」**，应该补上。

### 11.9 `ModpackUpdateTask` —— 整合包也支持更新

`modpack/ModpackUpdateTask.java` 存在，说明 HMCL 支持**整合包版本升级**。
这比「Mod 更新」复杂得多（要处理新增/删除/替换的差异）。
**IEML 在 M 系列里程碑里应把它放在 Mod 管理之后。**

### 11.10 路径抽象

`util/PortablePath.java`(5KB) + `util/FileNameSet.java`(3KB)：
**跨平台路径处理需要专门的抽象层**，不能直接用 `std::path::Path` 裸拼。
（HMCL 有 `PortablePathTest` 3KB 测试）

### 11.11 GSON 层的严谨性

```
util/gson/JsonSchema(20KB)          ← JSON Schema 校验
util/gson/JsonUtils(32KB)           ← 序列化中枢
util/gson/Validation + ValidationTypeAdapterFactory
util/gson/JsonType + JsonSubtype + JsonTypeAdapterFactory  ← 多态类型
util/gson/ObservableSetting(17KB)   ← 可直接绑定 UI 的设置项
```
**`JsonSchema` + `Validation` 说明 HMCL 对元数据做了 schema 级校验**，
不是裸反序列化。这解释了为什么它能容忍那么脏的 mods.toml ——
它有完整的容错层（`TolerableValidationException`）。

---

## 12. PCL2 Mod 列表模块（★ 第八轮补研）

> 第二轮研读。起因：用户要求「看一下 PCL 的模组列表的功能有什么」，
> 目的是核对 IEML 的 Mod 管理页信息结构（ADR-019）是否有遗漏或误判。
>
> **精读文件**（GitHub REST API 拉取）：
> `Pages/PageInstance/PageInstanceMod.xaml.vb`（41 KB）、`PageInstanceMod.xaml`、
> `Controls/MyLocalModItem.xaml.vb`（24 KB）、`Modules/Minecraft/LocalResourceFile.vb`、
> `LocalResourceLoaders.vb`，外加 `ModMinecraft.vb` 的能力判定部分。

### 12.1 ★ 重大认知修正：「已启用」靠文件扩展名判定，不读元数据

**这是本轮最重要的发现，我们原设计写错了。**

```vb
Public ReadOnly Property IsEnabled As Boolean
    Get
        Return {".jar", ".zip", ".litemod"}.Contains(File.Extension.Lower)
    End Get
End Property

Public ReadOnly Property EnabledName As String
    Get
        Return File.Name.Replace(".disabled", "").Replace(".old", "")
    End Get
End Property
```

**禁用 = 改文件扩展名**，不是改任何清单文件，也不读 `mods.toml` / `fabric.mod.json`。
具体后缀：`.disabled`（通用）、`.old`（旧版本遗留）。

**为什么这个设计是对的**：这是加载器自己的行为约定——游戏加载 Mod 时只扫描
`.jar`/`.zip`/`.litemod` 三个扩展名，改成别的名字游戏就看不见它了。
所以"启用/禁用"状态**天然由文件系统承载，不需要额外维护状态文件**。

**对 IEML 的启示**：
- 状态判定必须读**文件系统**，不能读自己维护的清单（否则用户手动改文件名后会不一致）
- `EnabledName` 要**两个后缀都剥**（`.disabled` 和 `.old`），否则同名的启用/禁用版本会被当成不同 Mod
- 认 `.zip`！不只是 `.jar` —— 很多整合包内的 Mod 是 zip 形式

### 12.2 ★ 更新判定：文件哈希 + 在线库比对，完全不读本地元数据

PCL2 判断"这个 Mod 有没有新版本"的方式**不是**读本地 `mods.toml` 里的 `version`，
而是**算出文件哈希值，拿去在线库反查它属于哪个项目、哪个版本**：

| 来源 | 哈希算法 | 接口 |
|---|---|---|
| CurseForge | **MurmurHash2**（种子 1，**先剔除所有 `\t \n \r` 和空格**） | `POST /v1/fingerprints/432` |
| Modrinth | **SHA1** | `POST /v2/version_files` |

比对逻辑：
```vb
If Entry.ProjectVersion.ReleaseDate >= UpdateFile.ReleaseDate OrElse
   Entry.ProjectVersion.Hash = UpdateFile.Hash Then Continue For
```

**哈希缓存 key 的构造**（很有意思）：
```vb
$"{EnabledFullName}-{File.LastWriteTime.ToLongTimeString()}-{File.Length}-C"   ' CurseForge
$"{EnabledFullName}-{File.LastWriteTime.ToLongTimeString()}-{File.Length}-M"   ' Modrinth
```
存 `Cache\ModHash.ini`。

**为什么用"文件名 + 修改时间 + 文件长度"而不是文件内容哈希**：算完整文件哈希
对大 jar 很慢，而这三个字段在文件没动过时是稳定的——用户改了文件，这三个字段
必然至少变一个。**这是性能与正确性的折中。**

> **对 IEML 的启示**：哈希缓存不能只按文件名存，必须带 `mtime + size`，
> 否则用户替换了同名文件后会拿到过期结果。

### 12.3 筛选器：只有 4 个，且**按数据自动隐藏**

```vb
Public Enum FilterType As Integer
    All = 0
    Enabled = 1
    Disabled = 2
    CanUpdate = 3
End Enum
```

只有「全部 / 已启用 / 已禁用 / 可更新」四项。关键是**按钮的可见性由数据决定**：

```vb
BtnFilterAll.Text = If(IsSearching, "搜索结果", "全部") & $" ({AnyCount})"
BtnFilterCanUpdate.Visibility = If(Filter = FilterType.CanUpdate OrElse UpdateCount > 0, Visibility.Visible, Visibility.Collapsed)
BtnFilterEnabled.Visibility   = If(Filter = FilterType.Enabled   OrElse (EnabledCount > 0 AndAlso EnabledCount < AnyCount), Visibility.Visible, Visibility.Collapsed)
BtnFilterDisabled.Visibility  = If(Filter = FilterType.Disabled  OrElse DisabledCount > 0, Visibility.Visible, Visibility.Collapsed)
```

三条独立规则：

1. **「可更新」在没有更新时整个按钮消失** —— 没更新的场合，这个筛选毫无意义
2. **「已启用」在"全部都已启用"时消失** —— 因为筛了等于没筛
3. **「已禁用」只要有一个禁用项就出现**
4. 而**当前选中的那个筛选器永远可见**（`Filter = xxx` 条件）—— 否则选中后按钮消失会很怪

按钮文字带计数：`全部 (42)`；搜索状态下「全部」自动改叫「搜索结果」。

> **对 IEML 的启示**：筛选器不要写死。**没有意义的筛选器本身就是噪音**，
> 而"当前选中项永远可见"是必须的例外，否则会出现"筛选项自己把自己藏了"的怪状态。

### 12.4 PCL2 完全没有排序功能

Mod 列表顺序是固定死的：

```vb
ModList.OrderBy(Function(m) m.File.Name).ToList()
```

**没有按名称/日期/大小/状态排序的任何 UI**。理由推测（源码未注释）：
Mod 列表通常在几十个量级，字母序足够；排序是伪需求，
真正需要的是**筛选**（把要处理的那批捞出来）。

> **对 IEML 的启示**：这一条需要**谨慎采纳**。我们的 Mod 页设计里有排序，
> 理由是整合包动辄 300+ Mod。判断：**若支持排序，默认必须是字母序**（与 PCL2 一致），
> 排序只是可选加速手段，不能替代筛选。

### 12.5 ★ 重复 Mod 去重（此前完全未想到）

```vb
Dim DumpMod As LocalResourceFile = ModList.FirstOrDefault(Function(m) m.EnabledName = ModEntry.EnabledName)
If DumpMod IsNot Nothing Then
    Dim DisabledMod As LocalResourceFile = If(DumpMod.IsEnabled, ModEntry, DumpMod)
    Logger.Warn($"重复的 Mod 文件：{DumpMod.File.Name} 与 {ModEntry.File.Name}，已忽略 {DisabledMod.File.Name}")
End If
```

判定用 `EnabledName`（即剥掉 `.disabled`/`.old` 后的名字），所以
`foo.jar` 和 `foo.jar.disabled` 会被识别为**同一个 Mod 的两个状态**，只保留启用的那个。

**批量切换状态时的保护**（两文件内容不同则拒绝操作）：

> 「目前同时存在启用和禁用的两个 Mod 文件…注意，这两个文件的内容并不相同。
> 在手动删除或重命名其中一个文件后，才能继续操作。」

> **对 IEML 的启示**：这是**必须实现**的。现实里用户经常"禁用一个旧版 → 放进一个新版"，
> 结果两个文件都留着。列表必须能识别这种情况，而不是显示成两个 Mod。

### 12.6 扫描目录规则：默认只认 mods 根目录

```vb
If Not (是 "mods" 根目录) Then
    If Not (Instance.Version.HasForge AndAlso
            Instance.Version.Vanilla.Major < 13 AndAlso
            文件夹名 = $"1.{Major}.{Build}") Then Continue For
End If
```

**唯一例外**：Forge 且 MC < 1.13 时，如果子文件夹名恰好等于版本号
（如 `mods/1.12.2/`），也递归加载——这是老版本 Forge 的目录约定。

> **对 IEML 的启示**：默认**不递归**。不要"体贴地"帮用户扫描所有子目录，
> 那会把备份文件夹、临时文件夹里的 jar 全部误当 Mod 载入。

### 12.7 搜索：加权模糊匹配

```vb
SearchResult = Search(QueryList, SearchBox.Text, MaxBlurCount:=6, MinBlurSimilarity:=0.35) _
               .Select(Function(r) r.Item).ToList()
```

各字段权重：

| 字段 | 权重 |
|---|---|
| `Display`（显示名） | 1 |
| `FileName` | 1 |
| `Project.RawName` | 1 |
| `TranslatedName`（译名） | 1 |
| `Version` | 0.2 |
| `Description` | 0.4 |
| `Tags` | 0.2 |

**版本号权重最低（0.2）** —— 因为搜"1.20"会命中一大堆。
**描述权重 0.4** —— 有意义但不该压过名字。

> **对 IEML 的启示**：搜索排序权重应当照抄这个梯度（名字 > 描述 > 标签/版本）。

### 12.8 批量操作与选择语义

按钮可用性**由选中项的实际状态决定**：

```vb
BtnSelectDisable.IsEnabled = HasEnabled
BtnSelectEnable.IsEnabled  = HasDisabled
BtnSelectUpdate.IsEnabled  = HasUpdate
```

即：选中的项里没有"已启用"的，就禁用「批量禁用」按钮。

**全选只选当前筛选后可见的项**（源码注释 #4992 专门为此纠错过一次）。
**滑动多选**：按住左键划过列表即连续勾选（`Swiping` / `SwipToState` / `SwipeStart` / `SwipeEnd`）。

### 12.9 单选按钮与交互手势

选中某一行后，行内出现 **4 个图标按钮**（悬停淡入）：

| 按钮 | 功能 |
|---|---|
| `BtnCont` | 查看详情 |
| `BtnOpen` | 打开文件所在位置 |
| `BtnED` | 启用 / 禁用 |
| `BtnDelete` | 删除 |

- **右键 = 详情**（`AddHandler sender.MouseRightButtonUp, AddressOf Info_Click`）
- **更新交互**：左键弹确认框（更新 / 查看更新日志 / 取消）；右键**直接看日志**、不弹框
- 两个来源都有更新时，让用户选从哪边更新

### 12.10 ★ 更新警告文案（verbatim，含一个 15 的阈值）

```vb
If Not Settings.Get(Of Boolean)("HintUpdateMod") OrElse ModList.Count >= 15 Then
    MyMsgBox($"新版本 Mod 可能不兼容旧存档或者其他 Mod，这可能导致游戏崩溃，甚至永久损坏存档！{vbCrLf}如果你在游玩整合包，请千万不要自行更新 Mod！...")
End If
```

逻辑是：**只在装了 ≥15 个 Mod 时警告**（小列表更新风险低，不打扰）；
或者用户主动开着"每次提示"。

> **对 IEML 的启示**：警告要有**阈值判断**，不能无差别弹。无差别弹窗会被用户学会性忽略。

### 12.11 其他实现细节

| 细节 | 说明 |
|---|---|
| **删除的 Shift 语义** | `FileUtils.Delete(路径, Not IsShiftPressed)` —— 不按 Shift 进回收站，按 Shift 永久删 |
| **懒加载** | `LazyLoadBehavior.OnFirstEnterScrollViewerViewport`，滚进视口才 `Refresh()` |
| **列表项显示模式** | 由 `ToolModLocalNameStyle` 决定：0 = 标题显译名 + 描述显文件名；1 = 反之 |
| **禁用视觉** | 标题加删除线 `TextDecorations.Strikethrough` + 右下角灰色 `Icons/Disabled.png` |
| **标题三档压缩**（#4465） | 空间不足时：全部舒展 → 压副标题 → 压标题 |
| **在线信息缓存** | `Cache\LocalMod.json`，key = `ModrinthHash + VanillaName + ModLoaders`，**6 小时有效**，带 `version` 字段 |
| **并发** | Modrinth 与 CurseForge 各开一个线程，`EndedThreadCount = 2` 等两边结束；**无显式限速**（限速在 `DlModRequest` 内） |
| **更新前后文件名缩短** | 逐段移除前导/后导相同部分。源码注释警告：**不能移除所有相同项**，否则 `1.2-forge-2` 和 `1.3-forge-3` 中间的 `forge` 会被误删 |
| **OptiFine 的唯一出现** | 仅"百科搜索关键词修正" `pti+Fine → ptiFine`，无特殊逻辑 |

### 12.12 对 ADR-019 的修正清单

| # | 原设计 | 应改为 | 级别 |
|---|---|---|---|
| 1 | 启用/禁用状态记在实例清单里 | **纯看文件扩展名**（`.jar`/`.zip`/`.litemod` 为启用） | **必改**（正确性） |
| 2 | 未考虑同名启用+禁用并存 | 加 `EnabledName` 归一化去重 + 内容不同时拒绝批量操作 | **必修** |
| 3 | 筛选器固定显示 | **按数据自动隐藏**，但选中项永远可见 | 必修 |
| 4 | 排序（多字段） | 默认字母序；排序只作可选加速，不替代筛选 | 参考 |
| 5 | 更新判定按版本号比较 | 按**文件哈希反查在线库**；哈希缓存 key 必须含 `mtime + size` | **必改** |
| 6 | — | 搜索权重梯度：名字 1 / 描述 0.4 / 标签 0.2 / 版本 0.2 | 参考 |
| 7 | — | 默认**不递归**扫描子目录（仅 Forge <1.13 版本号同名目录例外） | 必修 |
| 8 | — | 更新警告加**阈值**（≥15 个 Mod 才弹） | 参考 |

---

## 13. PCL2 版本设置模块（★ 第九轮补研）

> 第三轮研读。起因：用户要求「看看版本设置里的功能」（附 PCL2 主界面截图，
> 左下角有「版本选择」「版本设置」两个按钮）。
>
> **精读文件**：`Pages/PageInstance/PageInstanceSetup.xaml.vb`（28 KB / 571 行）、
> `PageInstanceSetup.xaml`（26 KB）、`PageInstanceOverall.xaml.vb`（16 KB）、
> `PageInstanceOverall.xaml`、`PageInstanceLeft.xaml`、`PageInstanceLeft.xaml.vb`、
> `PageInstanceModDisabled.xaml.vb`。

### 13.1 它是「三级结构」，不是一个页面

```
① 游戏页（版本列表）
     └─ 双击某个版本
② 左栏（只属于当前版本）          右栏
     概览                          ← 版本信息卡（点击进入 ③ 的入口）
     设置（有「初始化」辅助按钮）     个性化 / 快捷方式 / 高级管理
     Mod 管理（仅 Modable 版本）
     Mod 管理（不可装 Mod 的版本）    ← 与上面同名，是**另一个页面**
     导出
③ 设置页 = 四张卡片
```

**几个关键事实**：

| 事实 | 源码依据 |
|---|---|
| 左栏第 2、3 项**同名**「Mod 管理」，按 `Modable` 二选一显示 | `PageInstanceLeft.xaml.vb` `RefreshModDisabled()`：`ItemMod.Visibility = If(Instance.Modable, Visible, Collapsed)` |
| 「设置」项带一个**「初始化」按钮**（悬停显形） | `PageInstanceLeft.xaml` 第 12 行 `ToolTip="初始化"`，点了弹「是否要初始化该版本的版本独立设置？**该操作不可撤销**」 |
| 设置页顶部有一条蓝色提示条 | `PageInstanceSetup.xaml` 第 10 行：**「这些设置只对该游戏版本生效，不影响其他版本。」** |
| 「高级选项」卡片**默认折叠** | `IsSwapped="True" CanSwap="True"` |

> **★ 这是本项目最该抄的一条**：PCL2 在两个位置反复强调「只对本版本生效」——
> 左栏是「版本设置」而非「设置」，设置页顶部还有一条提示条。
> 因为 PCL2 的「全局设置」和「版本设置」在界面上长得**一模一样**，
> 用户极易搞混「我改的是全局还是这个版本」。
> **IEML 如果同时有全局设置与实例设置，必须用视觉手段持续区分二者。**

### 13.2 卡片一 · 启动选项

| 字段 | 控件 | 关键点 |
|---|---|---|
| **版本隔离** | 下拉框，**只有「开启 / 关闭」两档** | **改动时弹警告框**，见下 |
| 游戏窗口标题 | 文本框 | 留空 = 跟随全局；支持**「替换标记」**语法 |
| 自定义信息 | 文本框 | 显示在游戏主界面左下角 + F3 左上角。**Mojang 在 26.1 移除了该设置** |
| **Java** | 下拉框 **4 选 1** + 条件显示的第二控件 | 见 13.5 |

**版本隔离的警告框（verbatim）**——这是 PCL2 少数会拦人的地方：

```
调整版本隔离设置后，你需要游戏存档、Mod 等文件手动迁移到新的游戏文件夹中。
如果发现存档消失，把这项设置改回来就能恢复。
如果你不会迁移存档，不建议修改这项设置！
                                    「我知道我在做什么」「取消」
```

取消时的代码是**把 ComboBox 的选择回滚到 `e.RemovedItems(0)`**，
并用 `Static IsReverting` 防止回滚本身触发 `SelectionChanged` 形成死循环。

> **对 IEML 的启示**：ADR-005 已经确认「版本隔离要三段判定」，
> 但 PCL2 只有 2 档（开/关）——**它的「自动判定」不在这个下拉框里**，
> 而是纯代码行为：判定为隔离就直接把设置写成 True。
> 我们用三段卡片是**更显式**的设计，可保留；但那个警告框必须照抄。
> 注意它给的是**可逆暗示**（「改回来就能恢复」）——这是打消恐惧的关键一句。

### 13.3 卡片二 · 内存分配

三个单选（`VersionRamType`）：**跟随全局设置(2) / 自动配置(0) / 自定义(1)**。
只有「自定义」时滑块才 `IsEnabled = True`。

**内存条可视化**（`PanRamDisplay`）：用三个星号宽度的 `ColumnDefinition`
画一条横向内存条，三段分别是**已使用 / 游戏分配 / 空闲**：

```vb
ColumnRamUsed.Width = New GridLength(RamUsed, GridUnitType.Star)
ColumnRamGame.Width = New GridLength(RamGameActual, GridUnitType.Star)
ColumnRamEmpty.Width = New GridLength(RamEmpty, GridUnitType.Star)
```
初值就是 `4.7* / 2.5* / 0.7*`。更新前先 `Math.Round(x, 5)` 再比较，
**只有值真变了才启动 800ms 缓动动画**（避免每秒钟重动画一次）。

`RamGameActual = Math.Min(RamGame, RamAvailable)` —— **分配值超过可用内存时，
条形图按可用值画，但文字仍显示真实分配值并标注「(可用 x.x GB)」**。

**自动配置算法**（`GetRam()`）：

先按实例类型取四个目标值（GB）：

| 实例类型 | 最低 | T1 | T2 | T3 |
|---|---|---|---|---|
| **可装 Mod**（`Modable`） | `0.5 + n/150` | `1.5 + n/90` | `2.7 + n/50` | `4.5 + n/25` |
| OptiFine 版本 | 0.5 | 1.5 | 3 | 5 |
| 普通版本 | 0.5 | 1.5 | 2.5 | 4 |

`n` = mods 目录下 `.jar` / `.zip` / `.litemod` 文件数（**又是这三个扩展名**，与第 12.1 节一致）。

再按「当前可用物理内存」四阶段递减比例分配：

| 阶段 | 区间 | 取用比例 |
|---|---|---|
| 一 | 0 → T1 | **100%** |
| 二 | T1 → T2 | **70%** |
| 三 | T2 → T3 | **40%** |
| 四 | T3 → T3×2 | **15%** |

任一阶段后可用内存 < 0.1 GB 就 `GoTo PreFin` 停止。
最后 `RamGive = Math.Max(RamGive, RamMininum)` 兜底，保留 1 位小数。

**滑块值 → GB 的分段映射**（滑块是"档位"不是 MB）：
```
0..12   →  0.1 * v + 0.3      (0.3 ~ 1.5 GB)
13..25  →  0.5 * (v-12) + 1.5 (2.0 ~ 8.0 GB)
26..33  →  1.0 * (v-25) + 8   (9 ~ 16 GB)
34..    →  2.0 * (v-33) + 16  (18 GB ~)
```
**滑块最大值随物理内存动态变化**：
```
总内存 ≤1.5GB → max = floor((总-0.3)/0.1)
       ≤8GB   → max = floor((总-1.5)/0.5) + 12
       ≤16GB  → max = floor((总-8)/1)     + 25
       其他    → max = floor((总-16)/2)    + 33
```

**还有一项**：`启动游戏前进行内存优化`（跟随全局 / 开启 / 关闭）。

> **对 IEML 的启示**：这套自动内存算法是**可以直接抄的资产**——
> 它用 Mod 数量估算需求，再用递减比例分配，比"物理内存的一半"这种土办法精确得多。
> 尤其「可装 Mod 版本按 n 线性加」这一条，正好解决整合包（300+ Mod）内存不够的问题。
>
> 但**内存条可视化不必抄**：它占掉一整块高度，而 IEML 追求极致轻量。
> **改为一行紧凑文本即可**：`已用 4.7 / 共 7.9 GB · 分给游戏 2.5 GB`。
>
> 另外注意那个 **`Math.Min(分配, 可用)`** —— 分配值超了物理内存时，
> 条形图按可用值画、但文字显示真实值并标注「可用 x.x GB」。
> 这个细节很妙：**不骗用户，但也不画出一个物理上不存在的条**。

### 13.4 卡片三 · 服务器

「登录方式」5 选 1，**选中后条件展开额外字段**：

| 选项 | 展开出的字段 |
|---|---|
| 正版登录或离线登录 | — |
| 仅正版登录 | — |
| 仅离线登录 | — |
| 第三方登录：统一通行证 | **服务器 ID**（校验：长度必须恰好 32） |
| 第三方登录：Authlib Injector 或 LittleSkin | 认证服务器（校验：必须是合法 HTTP URL）、注册链接、服务器名称 |

另有一个全场字段「**自动进入服务器**」，`TextChanged` 里自动替换中文标点：
```vb
Text.Replace("：", ":").Replace("。", ".")
```
并 `ValidateExcept` 排除 `"` `"` `"` 与 `http://` `https://`。

还有一个「**设置为 LittleSkin**」快捷按钮，点击时**二次确认**：
> 「即将把第三方登录设置覆盖为 LittleSkin 登录。除非你是服主，或者服主要求你这样做，否则请不要继续。」

**改登录方式会清空整个版本列表缓存**：
```vb
WriteIni(McFolderSelected & "PCL.ini", "InstanceCache", "")
LoaderFolderRun(McInstanceListLoader, ..., LoaderFolderRunType.ForceRun, ..., ExtraPath:="versions\")
```
因为登录方式影响版本的**分类显示**。

> **对 IEML 的启示**：
> ① **「自动替换中文标点」是个高频痛点**——用户输入服务器地址时中文输入法极易打出全角冒号，
>    这一个 `Replace` 省掉一整类"我明明输对了却连不上"的问题。**必须抄。**
> ② 登录方式影响版本分类 → 影响缓存，这个依赖关系容易漏。
> ③ 这条是最贴 IEML 实际的：我们的实例也要支持"指向某个服务器"（`测试服客户端` 那条示例就是）。

### 13.5 Java 的四种选择模式（★ 设计得最好的部分）

`ComboArgumentJava` 四级，**每一级切换会改变旁边显示什么控件**：

| 选项 | 旁边显示 | 说明 |
|---|---|---|
| **自动选择** | 一个提示条 | 由启动器分析需要的 Java，没有就自动下载 |
| **自动选择指定版本的 Java** | 提示条 + **版本区间输入框** | 适合部分 Mod 需要特定 Java 才能启动 |
| **使用版本文件夹中的 Java** | 提示条（可点击） | 适合**整合包自带 Java**；点击打开版本文件夹 |
| **使用指定的 Java** | **Java 下拉列表** | 手动指定绝对路径；选中后写进 `Configs.JavaForced` |
| （无） | — | 列表底部还有「导入电脑中已有的 Java…」 |

**提示条的四态**（`_UpdateJavaRelatedUi`），颜色语义明确：

| 状态 | 文案 | 颜色 |
|---|---|---|
| 正在查找 | 「正在查找 Java……」 | 蓝 |
| 自动模式下没找到 | 「你的电脑上没有可供该版本使用的 Java，**PCL 会在启动游戏时自动下载**。」 | **黄** |
| 用版本文件夹模式但文件夹里没有 | 「该版本的版本文件夹中没有发现任何 Java！请点击此处打开版本文件夹，然后将 Java 文件夹复制进去。」 | **红** |
| 找到 | 「将会使用：<路径>」 | 蓝 |

**版本区间输入框的校验规则**（7 条，`ValidateRules`）非常值得学：

```vb
If String.IsNullOrWhiteSpace(Str) Then Return "不能为空"
Dim Range = ValueRange(Of Version).FromString(Str, ...)
If Range.IsEmpty Then Return "范围下限的版本号比上限更高，导致该范围无法匹配到任何版本"
If Range.Lower.Major <= 1 AndAlso (Minor > 0 OrElse Build > 0 OrElse Revision > 0)
    Then Return "不应使用 1.x 格式进行匹配（例如，若想匹配 Java 17，应填写 17 而非 1.17）"
If Range.Upper.Major <= 4 Then Return "该范围所要求的 Java 版本过低"
If Range.IsUpperInclusive AndAlso Upper.Minor <= 0 AndAlso Upper.Build <= 0
    Then Return $"右侧闭区间的意图并不明确。如果不想允许 Java {Major}，请改为 {Major})。
                 如果想允许 Java {Major}，请改为 {Major+1})。"      ' ← 给出两种改法，让人选
If Range.Intersect(OpenClosed(5.0, 99.0)).IsEmpty()
    Then Return "该范围无法匹配到任何常见的 Java"
```

**首次进入该模式时自动填入推荐范围**：
```vb
If Not Settings.HasSaved("VersionArgumentJavaRange", Instance) Then
    Dim DefaultRange = GetJavaRequirement(Instance).Range.ToString.Replace("-∞","").Replace("+∞","")
    Settings.Set("VersionArgumentJavaRange", DefaultRange, Instance)
End If
```

**Java 列表项自带两个行内图标按钮**：
- 「从列表中移除」—— **官方 Java 禁用它**，ToolTip 改成「无法移除官方 Java」，
  并 `ToolTipService.SetShowOnDisabled(True)` 让禁用态也能看到提示
- 「打开文件夹」

> **对 IEML 的启示**：这四种模式比我们设想的「Java 下拉框」完整得多，值得整体采纳。
> 尤其三条：
> ① **「使用版本文件夹中的 Java」** —— 整合包自带 Java 是真实场景，我们完全没考虑
> ② **右侧闭区间歧义校验** —— 不直接报错，而是**给出两种改法让用户选**。
>    这是"错误提示"的更高形态：不只说错，还给出路。
> ③ **禁用按钮也要能让用户看到原因** —— `SetShowOnDisabled`。
>    我们的设计系统第 13 章也写了「给理由，不给黑箱」，这是它的具体实现手段。

### 13.6 卡片四 · 高级选项（默认折叠）

| 字段 | 控件 | 亮点 |
|---|---|---|
| Java 虚拟机参数 | **多行文本框** | 支持 MC 版本 JSON 的替换标记（`${library_directory}`）与 PCL 自有替换标记 |
| 游戏参数 | 文本框 | 直接拼在启动参数末尾，如 `--demo` 以试玩模式启动 |
| **内存管理** | 下拉框 **6 选 1** | 见下 |
| 启动前执行命令 | 文本框 | **不覆盖全局**：先执行全局的，再执行版本的 |
| └ 等待命令执行完成后再继续启动 | 复选框 | **只在命令框非空时才显示** |
| 禁止更新 Mod | 复选框 | 「防止**整合包玩家误操作**」 |
| 关闭文件校验 | 复选框 | 不校验 libraries / 登录库 / 主 jar 是否被改 |
| 禁用 Java Launch Wrapper | 复选框 | 修复 Java 18- 在**中文路径**下可能无法启动的问题 |
| 禁用 LWJGL Unsafe Agent | 复选框 | 修复 LWJGL 3.4.1 的一个性能问题 |

**GC 策略 6 选 1**（会**覆盖**「Java 虚拟机参数」里的 GC 相关参数）：
跟随全局 / 尽量使用 ZGC / 尽量使用分代 ZGC / 标准 G1GC / 调优 G1GC / 不指定（可自定义）。
每个选项的 ToolTip 都写清了「哪个 Java 版本用哪个 GC」和「覆盖了什么」。

**「启动前执行命令」的 ToolTip 是一段完整教程**，列了三个例子：
```
"{verpath}test.exe"              运行版本文件夹下的 test.exe
"{java}java.exe" -jar "{verpath}test.jar"   用 Java 运行版本文件夹下的 jar
notepad "{verindie}options.txt"  打开该版本的设置文件
```
并提醒「涉及路径的操作最好都打上双引号」。
另有 `ReplaceEnter`：把文本框里的换行**替换成空格**（因为命令不能跨行）。

> **对 IEML 的启示**：
> ① **「不指定（可自定义）」这个选项的措辞很聪明**——
>    它同时是「我不帮你设 GC」和「只有选这项你才能自己写 GC 参数」两个意思。
>    用户能自己推出因果关系，不需要额外解释。
> ② **「等待命令执行完成」只在命令非空时显示** —— 依赖性条件显示，避免无意义的控件。
> ③ 那两个「禁用 XXX 修复」的开关（JLW / LWJGL Unsafe Agent）
>    都是**已知环境问题的绕过开关**。IEML 应当有一张同类表，
>    但**默认应是自动判断而不是让用户勾**——给高级用户留逃生口即可。
> ④ 「禁止更新 Mod」这一项与我们的 ADR-018（Mod 绝不自动更新）**互相印证**：
>    PCL2 把它做成了一个**可关闭的保护**，说明连它都认为整合包用户会手抖。

### 13.7 概览页：管理动作，不是配置项

与设置页分工明确——**概览页全是「动作」，没有一个是"值"**：

| 卡片 | 内容 |
|---|---|
| （顶部）版本信息卡 | `Instance.ToListItem()` 生成的卡片 |
| **个性化** | 图标（13 个预设 + 自定义图片）、分类（6 档）、修改版本名、修改版本描述、加入收藏夹 |
| **快捷方式** | 版本文件夹 / 存档文件夹 / Mod 文件夹 / 截图文件夹（4 个按钮，点击即 `OpenExplorer` 并顺手 `Create` 目录） |
| **高级管理** | 导出启动脚本 / 补全文件 / 删除版本（`ColorType="Red"`） |

**两个细节**：

**① 「修改版本名」是一个真正的重命名事务**（11 个步骤）：
```
1. 校验新名字（ValidateFolderName，排除已存在的文件夹）
2. 重读 JSON（避免已合并的项被重新存储）
3. 移动主文件夹
4. 清理 ini 缓存
5. 重命名 {旧名}-natives 文件夹   ← 精确匹配旧名，不遍历
6. 重命名 {旧名}.jar               ← 源码注释 #6443：不能遍历重命名，
                                      版本名很短时容易误伤其他文件
7. 替换 Setup.ini 里的旧路径
8. 若当前选中版本就是它，更新 PCL.ini 的 Version
9. 改写 JSON 的 id 字段，删旧 json 写新 json
10. 刷新实例列表缓存
11. Hint 提示成功
```

**② 「删除版本」会先列出将被删的存档**：

```vb
Dim SaveEntries = SavesFolder.EnumerateDirectories
    .OrderByDescending(Save.LastWriteTime)
    .Select(Save => $"{Save.Name}（上次修改：{FormatTimeSpan(Save.LastWriteTime - Date.Now, False)}）")
```
提示框文案：
```
你确定要{永久}删除版本 {名称} 吗？
该版本对应的存档、资源包、Mod 等文件也将被一并删除！

这会删除以下存档：
· 存档A（上次修改：3 天前）
· 存档B（上次修改：昨天）
```
**按 Shift 才是永久删除**，`DirectoryUtils.Delete(路径, Not IsShiftPressed)`。

> **对 IEML 的启示**：
> ① **「删除前列出具体存档名 + 上次修改时间」是极好的一招。**
>    我们原设计只说「该实例的存档将被删除」，抽象警告对用户无效；
>    列出「· 我的世界（上次修改：3 天前）」才会让人真的停下来想一秒。**必须抄。**
> ② **重命名的 5、6 两步那个坑（#6443）我们要避开**：
>    版本名是用户输入的自由文本，直接拿它做前缀去遍历重命名，
>    在名字很短（如 `a`）时会命中大量无关文件。**必须精确匹配旧名。**

### 13.8 「文件补全」与「关闭文件校验」的联动

`BtnManageCheck_Click`（补全文件）开头有一道**前置守卫**：
```vb
If ShouldIgnoreFileCheck(Instance) Then
    Hint("请先关闭 [版本设置 → 设置 → 高级启动选项 → 关闭文件校验]，然后再尝试补全文件！", HintType.Blue)
    Return
End If
```
因为勾了「关闭文件校验」= 启动时不做校验，那"补全文件"这个动作本身就没意义了。

> **对 IEML 的启示**：**互为前提的两个功能必须互相拦截，并说清在哪一步操作。**
> 提示里把完整路径写出来（`版本设置 → 设置 → 高级启动选项 → 关闭文件校验`）——
> 这是"给理由给路径"的又一个实例。

### 13.9 对 IEML 的采纳清单

| # | 项 | 采纳程度 | 理由 |
|---|---|---|---|
| 1 | **自动内存算法**（Mod 数量 → 四目标 → 四阶段分配） | **直接采纳** | 比"物理内存一半"精确得多，且天然适配整合包 |
| 2 | **版本隔离改动弹警告 + 可逆暗示** | **必须采纳** | ADR-005 缺这层保护；「改回来就能恢复」这句是关键 |
| 3 | **删除版本前列出存档名与上次修改时间** | **必须采纳** | 抽象警告无效，具体清单才拦得住人 |
| 4 | **改中文标点自动替换**（`：`→`:`、`。`→`.`） | **必须采纳** | 消灭一整类"输入没问题却连不上" |
| 5 | **Java 四模式**（含「用版本文件夹里的 Java」） | **采纳** | 整合包自带 Java 是真实场景，我们漏了 |
| 6 | **版本区间歧义校验给两种改法** | **采纳** | 「错误提示」的更高形态：不只说错，还给路 |
| 7 | **禁用按钮显示原因**（`SetShowOnDisabled`） | **采纳** | 设计系统第 13 章原则的具体实现手段 |
| 8 | **重命名精确匹配旧名，不遍历** | **采纳** | 避开 #6443 那个真实 bug |
| 9 | **依赖项条件显示**（如「等待命令」只在命令非空时出现） | **采纳** | 减少无意义控件的通用手法 |
| 10 | **「不指定（可自定义）」式措辞** | **参考** | 让用户自己推出"选了才能自己写" |
| 11 | **全局 / 实例设置必须视觉区分** | **采纳** | 见 13.1：PCL2 在两处强调「只对本版本生效」 |
| 12 | 内存条可视化（三段式） | **不采纳** | 占高度，违背轻量目标；改一行紧凑文本 |
| 13 | 登录方式 5 选 1（含统一通行证 / LittleSkin） | **暂缓** | 先做正版 + 离线 + 自定义 Yggdrasil 即可 |
| 14 | GC 6 选 1 / JVM 参数 / 启动前命令 | **暂缓** | 归入「高级选项」折叠区，M2 之后再做 |
| 15 | 补全文件 ↔ 关闭文件校验 互拦 | **采纳** | 互为前提的功能必须互相拦截并给出路径 |

---

## 14. 汇总：IEML 应当采纳的条目

### 必改（推翻原设计）

1. **OptiFine 安装机制改为「Patcher 打补丁」** —— 现代版本要拉起 `optifine.Patcher` 子进程，老版本才复制
2. **约束矩阵补全** —— Forge 1.13~1.14.3 与 OptiFine 不兼容；Fabric ≥1.20.5 与 OptiFine 不兼容
3. **`IsOptiFineSuitForForge` 四级规则** —— Nothing=不兼容 / 空串=兼容 / 含点比版本 / 不含点比 revision
4. **Mod 兼容性预检降级** —— 从「不匹配」改为「可能不兼容」，措辞保守 + 可解释 + 提示以实跑为准
5. **Java 选择改为约束体系** —— 13 条规则、强制/建议两档、`MODDED_JAVA_*` 绑定 Forge
6. **崩溃分析扩为 8 大类** —— 尤其要补「环境类」（Java/内存/显卡），这是用户最常见的误判来源
7. **加堆栈启发式兜底** —— `findKeywordsFromCrashReport` 的算法 + 包名黑名单
8. **加导出整合包黑名单** —— 约 50 条，含启动器私有文件与登录凭据
9. **Mod 启用/禁用改为「看文件扩展名」**（★ 第八轮）—— 不维护自己的状态清单
10. **Mod 更新判定改为「文件哈希反查在线库」**（★ 第八轮）—— 哈希缓存 key 必须含 `mtime + size`

### 必修（补上缺失能力）

11. **加载器识别改「坐标 + 排除」** —— 必须处理 Fabric/LegacyFabric、Forge/NeoForge 两组歧义
12. **补 LegacyFabric 和 Cleanroom 支持**
13. **`VersionRange` 改为闭区间 + 交集运算** —— 用 `intersectionWith` 做依赖冲突检测
14. **引入 Draft 事务机制** —— 内存推演 → 一次性提交 → 失败自动逆序回滚
15. **缓存 key 用 MurmurHash2**，不用 SHA
16. **整合包加 `CompletionTask`** —— 装完再校验补齐
17. **实现 OptiFine installer 的离线版本反解** —— 用字节码常量池读 `MC_VERSION` / `OF_EDITION` / `OF_RELEASE`
18. **`priority = 10000`** —— 用数据结构保证「OptiFine 最后装」，而非靠调用顺序
19. **重复 Mod 去重**（★ 第八轮）—— `EnabledName` 归一化；内容不同时拒绝批量操作
20. **筛选器按数据自动隐藏**（★ 第八轮）—— 但选中项永远可见
21. **默认不递归扫描 mods 子目录**（★ 第八轮）—— 仅 Forge <1.13 版本号同名目录例外
22. **自动内存分配算法**（★ 第九轮）—— 按 Mod 数量算四目标 + 四阶段递减比例；比"物理内存一半"精确
23. **版本隔离改动加警告 + 可逆暗示**（★ 第九轮）—— 「改回来就能恢复」这句是打消恐惧的关键
24. **删实例前列出每个存档名与上次修改时间**（★ 第九轮）—— 抽象警告拦不住人
25. **服务器地址自动替换全角标点**（★ 第九轮）—— 消灭一整类"输对了却连不上"
26. **Java 四模式**（★ 第九轮）—— 尤其补「使用版本文件夹中的 Java」（整合包自带 Java 场景）
27. **全局设置与实例设置必须视觉区分**（★ 第九轮）—— PCL2 在两处反复强调「只对本版本生效」
28. **实例重命名必须精确匹配旧名，不遍历**（★ 第九轮）—— 避开 #6443 那个真实 bug
29. **互为前提的功能互相拦截并给出操作路径**（★ 第九轮）—— 「补全文件」↔「关闭文件校验」

### 参考（设计优化）

30. **OptiFine 安装时删 `META-INF/mods.toml`** —— 防止 Forge 把它当 Mod
31. **进度用日志特征点驱动** —— 而不是估算百分比
32. **窗口探测用类名白名单 + 进程启动时间校验** —— Mod 会改标题
33. **崩溃检测过滤 `[CHAT]` 行**；退出码判定加发行年份条件；崩溃后延迟 2 秒再分析
34. **多源竞速 + 镜像表**；Forge 只选 installer 分类；维护 `OptiFabric = CurseForge 322385`
35. **搜索权重梯度**（★ 第八轮）—— 名字 1 / 描述 0.4 / 标签与版本 0.2
36. **更新警告加阈值**（★ 第八轮）—— 仅 Mod ≥15 个时弹
37. **删除的 Shift 语义**（★ 第八轮）—— 默认进回收站，Shift = 永久删除
38. **懒加载列表项**（★ 第八轮）—— 滚进视口才渲染
39. **错误提示给出改法而非只报错**（★ 第九轮）—— 版本区间歧义时给两种改法让用户选
40. **禁用态的按钮也要能显示原因**（★ 第九轮）—— `SetShowOnDisabled`
41. **依赖项条件显示**（★ 第九轮）—— 如「等待命令」只在命令非空时出现

---

## 15. 仍未解决的开放问题

> ★ 2026-09-20 核对：这张表是 2026-09-11 写的，其中**前三条已经有结论了**，
> 标注在下面（结论不改写原问题，只标注它现在归哪儿）。
> 剩下的是**还没轮到的设计题**，不是欠账清单 —— 要用到哪一条就在那一轮读完。

| # | 问题 | 已知信息 | 待办 |
|---|---|---|---|
| 1 | OptiFine 官方列表解析 | PCL2 靠正则抓 HTML 表格；HMCL 走 BMCLAPI | ✅ **已有结论**：IEML 走 BMCLAPI 的结构化 JSON（`net/optifine.rs`），不抓 HTML —— 见 ADR 与 CHANGELOG 的 OptiFine 两轮 |
| 2 | CurseForge API Key | 需要申请 | ✅ **已有结论**：内置一把（ADR-052），界面不提供填写入口。★★ **2026-09-26 更正**：连"内置一把"也没有了 —— 用户定「cf 完全不用 key」，CF 全部走国内镜像，启动器里没有 key 这回事 |
| 3 | 中文别名词表来源 | PCL2/HMCL 都有本地化 | ✅ **已有结论**：**不做**（用户在 beta.38 明确「CFPA 这个先不做了」） |
| 4 | 备份保留份数 | HMCL Draft 只管单次事务，不做长期备份 | 仍需自行设计（**注意**：项目至今没有备份/回滚实现，见 README 的已知限制） |
| 5 | macOS 签名证书 | 两边源码均未涉及 | 0.1.0 只发 Windows，推到跨平台那一版再查 |
| 6 | `mods.toml` 的 `side` 字段 | 解析了但未用于兼容判定 | 确认是否要区分 client/server |
| 7 | HMCL 的 `ModpackUpdateTask` 细节 | 只知道存在（4KB） | 设计整合包更新时再精读 |
| 8 | `GameInstancePatch` 的优先级体系 | 只知道 OptiFine 用 10000 | 设计叠加层顺序时需完整读 |
| 9 | PCL2 更新检查的**限速策略** | Mod 列表模块未显式限速，推测在 `DlModRequest` 内 | 设计 Modrinth/CF 客户端时确认配额 |
| 10 | `MyLocalModItem` 的**行内按钮完整事件集** | 只确认了 4 个按钮的语义 | 实现列表项时再精读 |
| 11 | `LocalResourceLoaders` 的**资源包/光影包差异** | 本轮只看了 Mod 分支 | ✅ **已实现**（资源中心四种资源共用一套抽象），这一条可以划掉 |
| 12 | PCL2 的**整合包识别在 Mod 列表中的表现** | 未查 | 与 ADR-025 一起确认 |
| 13 | **替换标记语法**的完整清单 | 已知 `{verpath}` `{java}` `{verindie}` `${library_directory}` | ✅ **已实现**（`game/launch_args.rs` 的替换表），这一条可以划掉 |
| 14 | **内存条宽度动画**的触发精度 | `Math.Round(x,5)` 比较后再决定是否动画 | 实现紧凑版时确认逻辑 |
| 15 | `ValidateFolderName` 的完整规则 | 已知会排除已存在文件夹 | ✅ **已实现**（`domain/validate.rs` 的规则表 + 两侧同名测试） |
| 16 | **实例设置文件的存储格式** | `<版本目录>\PCL\Setup.ini` | ✅ **已定**：IEML 用 `instances.json` + `prefs.json`（JSON），不学 ini |
| 17 | 版本「分类」6 档的判定依据 | 自动 / 隐藏 / 可装 Mod / 常规 / 不常用 / 愚人节 | 设计实例分组时确认自动判定逻辑 |

---

*文档创建：2026-09-11*
*研读范围（第一轮）：PCL2 `Modules/Base|Minecraft|Resource`、`Pages/PageDownload|PageInstance`；
HMCL `addon/`、`download/`、`game/`、`modpack/`、`util/versioning|gson|platform`*
*研读范围（第二轮 / 第 12 章）：PCL2 `Pages/PageInstance/PageInstanceMod.xaml.vb`、
`PageInstanceMod.xaml`、`Controls/MyLocalModItem.xaml.vb`、
`Modules/Minecraft/LocalResourceFile.vb`、`LocalResourceLoaders.vb`、`ModMinecraft.vb`*
*研读范围（第三轮 / 第 13 章）：PCL2 `Pages/PageInstance/PageInstanceSetup.xaml.vb`、
`PageInstanceSetup.xaml`、`PageInstanceOverall.xaml.vb`、`PageInstanceOverall.xaml`、
`PageInstanceLeft.xaml`、`PageInstanceLeft.xaml.vb`*
*所有引用的代码片段均来自上述仓库 main 分支，逐字转录*
