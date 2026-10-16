//! 平台相关：数据目录、Java 探测、机器信息
//!
//! 这里的原则：**能探测就探测，探测不到就给出可行动的说明**，
//! 绝不假装知道（例如本机没有 Java 时，要告诉用户"需要 Java 21"而不是"启动失败"）。

use crate::domain::java::JavaRuntime;
use std::path::{Path, PathBuf};

/// 应用数据目录
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// **游戏**根目录（用户选的那个）—— 里面只该有游戏的东西（`.minecraft`）。
    pub root: PathBuf,
    /// 启动器**自己**的数据目录（实例清单 / 自动下载的 Java / 缓存 / 日志）。
    ///
    /// ★★ 2026-09-23（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」
    ///   以及确认「启动器自己的目录要搬出游戏根目录：**是的**」）：
    ///   这几样东西与"游戏在哪"无关，放在用户挑的游戏盘里只会让那个目录变脏，
    ///   还会在换盘时被一起留下。统一放到系统的应用数据目录
    ///   （Windows：`%APPDATA%\IEML`）。
    ///
    ///   ★ 与 `root` 的关系：`root` 是**游戏的家**，`own_root` 是**启动器的家**。
    ///     用户换游戏目录时，只有前者变。
    pub own_root: PathBuf,
    /// 共享游戏文件（原版库、assets、已装版本）—— 多实例复用。
    ///
    /// ★★ 2026-09-15：它的**名字**从 `shared` 改成了 `.minecraft`
    ///   （用户要求"游戏文件应该和启动器数据绑定在一块，在启动器数据内部来个
    ///   `.minecraft` 这么个文件夹来存游戏数据，就像 PCL 那样"）。
    ///
    ///   字段名仍叫 `shared`（"共享"是它的**职责**，`.minecraft` 是它的**位置**）——
    ///   全仓库 45 处引用都走这个字段，所以换位置只需要改这一行。
    pub shared: PathBuf,
    /// **版本目录（= 实例目录）** —— `<root>/.minecraft/versions`。
    ///
    /// ## 为什么实例目录**就是**版本目录（2026-09-30 布局规范化）
    ///
    ///   以前这里是 `<root>/instances`，一个实例长这样：
    ///
    ///   ```text
    ///   <root>/instances/<slug>/          ← 启动器自己的东西（natives / pack-record）
    ///                          /game/     ← 游戏工作目录（saves / mods / config）
    ///   ```
    ///
    ///   而版本目录在**另一个地方**（`<root>/.minecraft/versions/<版本名>/`，
    ///   里面放版本 JSON 与客户端 jar）。于是同一个版本在盘上有**两个**目录，
    ///   账本里的 `config.slug` 与版本目录名又是两套写法
    ///   （真机实测：账本 `vanilla-262` / 磁盘 `26.3-fabric-0.19.5`）——
    ///   这正是 `docs/DECISIONS.md` 54.1 那一节记录的缺陷：**拿 slug 拼不出目录名**。
    ///
    ///   现在按 PCL 的布局收敛成**一个**概念：一个版本 = `versions/` 下的一个文件夹，
    ///   版本 JSON、客户端 jar、saves、mods、config 全都在它里面
    ///   （PCL 的 `PathIndie` 就是 `PathVersion`，见 `ModMinecraft.vb:227-266`）。
    ///   启动器自己那几个文件（`natives` / `pack-record.json`）进它下面的 `.ieml/`，
    ///   与游戏会读的目录名**不重叠**。
    ///
    ///   好处不只是"整齐"：账本里那条记录**不再是实例存在的唯一证据** ——
    ///   目录没了就是没了，一份陈旧的账本副本再也不能让删掉的版本"诈尸"
    ///   （那正是真机上发生的事）。
    pub instances: PathBuf,
    /// 自动下载的 Java（在 `own_root` 下）
    pub java: PathBuf,
    /// 缓存（在 `own_root` 下）
    pub cache: PathBuf,
    /// 日志（在 `own_root` 下）
    pub logs: PathBuf,
}

/// 游戏数据目录的名字（PCL 同款：数据根目录下的 `.minecraft`）
pub const GAME_DIR_NAME: &str = ".minecraft";

/// 老布局的名字（0.1.0-beta.2 及以前叫 `shared`）
pub const LEGACY_SHARED_NAME: &str = "shared";

/// 老布局里放实例的目录名（`<root>/instances`）—— 只用于**迁移**，新代码不许再用。
///
/// ★ 保留成一个常量而不是散落的字面量：迁移完成后 `instances/` 就该被删掉，
///   需要一个地方能一眼看出"还有谁在找它"。
pub const LEGACY_INSTANCES_NAME: &str = "instances";

/// 版本目录名（PCL 同款：`.minecraft/versions`）
pub const VERSIONS_DIR_NAME: &str = "versions";

/// 「旧 `instances/` 已经并进来了」的记号文件名（放在版本目录里）。
///
/// 见 `instance_catalog_repair` 第 ① 步：布局迁移是**一次性**的，
/// 没有这个记号就会每次启动都把源那边重新比一遍。
pub const LEGACY_MERGED_MARKER: &str = ".instances-merged";

/// 启动器**自己**放在版本目录里的东西（`natives` / `pack-record.json`）。
/// ★ 为什么要点号开头 + 单独一层：版本目录**就是游戏的工作目录**，
///   游戏会往里写 `mods` / `saves` / `config` / `logs` / `resourcepacks`…
///   启动器自己的文件混在那一层里，既容易被用户误删，也容易被
///   整合包导出当成"游戏文件"打进去。放 `.ieml/` 与那些名字**不重叠**。
pub const LAUNCHER_SUBDIR: &str = ".ieml";

/// 每个版本目录里那份**身份小抄**（`<版本目录>/.ieml/instance.json`）。
///
/// ★ 为什么要有它：账本（`instances.json`）与磁盘是两份东西，一旦账本被
///   旧副本盖掉（真机上发生过），启动器就不知道这个目录是谁的了。
///   把身份写在**目录自己身上**，就可以反过来从磁盘重建账本 ——
///   目录在就认得出来，目录删了就彻底没有，不存在"诈尸"。
pub const INSTANCE_MARKER_NAME: &str = "instance.json";

/// **"这个目录只是基座，不是独立版本"** 的记号
/// （`<原版目录>/.ieml/base.json`）。
///
/// ★★★★ 2026-10-08（用户）：「按理来说，**原版是作为基座的**，而不是单独的一个版本；
///   只有**真的只下载原版**时，才是独立的版本」。
///
/// ## 为什么需要它在盘上留一份
///
///   "这个原版目录算不算一个版本"取决于**用户干了什么**，而不是盘上有什么：
///     · 装「26.3 + Fabric」时，原版目录是**安装器顺手装上的基座**
///       （加载器版本 `inheritsFrom: 26.3`，客户端 jar 就住在那儿）；
///     · 用户自己点了「下载 26.3（原版）」时，它才是一个**独立版本**。
///   两者在磁盘上长得**一模一样**（`26.3.json` + `26.3.jar`），
///   所以必须把"那次是谁要的"记下来 —— 与 `.ieml/instance.json`
///   （"我是谁的实例"）同一个思路：**把意图写在目录自己身上**。
///
/// ## 谁写、谁清、谁认
///
///   · **写**：`commands_real::build_plan_input` —— 装加载器时，
///     如果原版目录**原先没有自己的版本描述**（= 它是这次顺手装上的），就写一份记号；
///     如果它**本来就有**（用户先前单独装过原版），一个字节都不动（那是他的版本）。
///   · **清**：同一个函数在**不带加载器**的安装里清掉它 ——
///     用户明确要了原版，它从此是独立版本。
///   · **认**：`scan_folder_versions` 把它**当作不存在**（不列行、不计数、
///     不自动认领）；`instance_catalog_repair` 的补认也跳过它
///     （底座不是"用户要的版本"，不该占一条账本记录）。
pub const BASE_MARKER_NAME: &str = "base.json";

impl AppPaths {
    pub fn resolve() -> Self {
        Self::from_root(resolve_data_root())
    }

    /// 从一个已知根目录拼出全部子路径（测试与"数据目录迁移"复用）
    ///
    /// ★★ 2026-09-23：启动器自己的目录现在挂在 **`own_root`**（`%APPDATA%\IEML`）
    ///   而不是游戏根目录下 —— 见 `AppPaths::own_root` 的说明。
    ///
    /// ★★ 2026-09-30（布局规范化）：**实例目录不再是独立的 `instances/`** ——
    ///   它就是 `.minecraft/versions`（见 `AppPaths::instances` 的说明）。
    pub fn from_root(root: PathBuf) -> Self {
        let own_root = default_own_root();
        let shared = root.join(GAME_DIR_NAME);
        Self {
            instances: shared.join(VERSIONS_DIR_NAME),
            java: own_root.join("java"),
            cache: own_root.join("cache"),
            logs: own_root.join("logs"),
            root,
            own_root,
            shared,
        }
    }

    /// 老布局的实例目录（`<root>/instances`）—— **只给迁移用**。
    ///
    /// ★ 新代码一律走 [`AppPaths::instances`]。这个方法存在只是为了让
    ///   "把老目录搬进 `.minecraft/versions/`"那一步有个明确的入口。
    pub fn legacy_instances_dir(&self) -> PathBuf {
        self.root.join(LEGACY_INSTANCES_NAME)
    }


    /// ★ 数据根目录的**选址记录文件**（放在数据根目录旁边，不在里面）。
    ///
    ///   为什么不能放在数据目录里：选址记录本身就是"数据目录在哪"的答案，
    ///   放进被它决定的目录里是循环依赖 —— 一旦用户搬走数据目录，
    ///   启动器就再也找不到那条记录了。
    ///
    ///   位置：`dirs_data_dir()/IEML/datadir.txt`（也就是**旧的默认位置**）。
    ///   那个位置永远可写，而且与平台无关。
    pub fn location_file() -> PathBuf {
        legacy_data_roots()[0].join("datadir.txt")
    }

    /// ★★ 2026-09-24（C）：**启动器自己的家在哪**的选址记录。
    ///
    ///   与 `datadir.txt` 同一个宿主目录（`%APPDATA%\IEML`），理由完全一样：
    ///   这条记录是"账本 / Java / 缓存 / 日志在哪"的答案，放进被它决定的目录里
    ///   就是循环依赖。所以系统盘上**只留这两个几十字节的记录文件**，
    ///   其余（`instances.json` / `prefs.json` / `cache` / `logs` / `java`）都跟着
    ///   `own_root` 走 —— 本机 = `D:\IEML-launcher`。
    pub fn own_location_file() -> PathBuf {
        legacy_data_roots()[0].join("ownroot.txt")
    }

    /// 启动时确保**游戏根目录**存在。
    ///
    /// ★★ 2026-09-22（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」）：
    ///   这里**只建游戏那一边**（游戏根目录 + 它的 `.minecraft` + `versions`）；
    ///   启动器自己的目录（java / cache / logs）改成
    ///   **用到时才建**（见 `ensure_own`）——
    ///   于是"刚选好的空目录"里不会再凭空冒出一堆启动器文件。
    ///
    ///   ★ 2026-09-30：`versions` 就在 `.minecraft` **里面**，所以这里建的两个
    ///     目录是父子关系（`create_dir_all` 本来一个就够）—— 两行都留着是
    ///     刻意的：它们表达的是两件不同的事（"游戏的家在这里"与"版本目录在这里"），
    ///     将来若再把版本目录挪出去，改动点仍然只有这两行。
    ///     **老的 `<root>/instances/` 不再创建** —— 它的内容由
    ///     [`migrate_instances_into_catalog`] 搬进 `versions/`。
    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(self.game_dir())?;
        std::fs::create_dir_all(&self.instances)?;
        Ok(())
    }

    /// 游戏目录（`.minecraft`）—— 版本、存档、Mod 都在这一层里
    pub fn game_dir(&self) -> PathBuf {
        self.root.join(GAME_DIR_NAME)
    }

    /// 启动器**自己的**目录。用到时才调（懒建，见 `ensure` 的说明）。
    ///
    /// ★ 列表里**没有 `instances`** —— 它在 `.minecraft/versions`，
    ///   由 `ensure()` 建（见 `AppPaths::instances`）；
    ///   也没有 `shared` —— 它的位置就是 `.minecraft`，同样由 `ensure()` 建。
    pub fn ensure_own(&self) -> std::io::Result<()> {
        for p in [&self.java, &self.cache, &self.logs] {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }

    /// 某个实例**启动器自己那部分**的目录 —— `<版本目录>/.ieml/`。
    ///
    /// ## 为什么它不再是"实例目录"，而是版本目录里的一个子目录
    ///
    ///   老布局里 `instance_dir(slug)` = `<root>/instances/<slug>`，而
    ///   **游戏目录**是它下面的 `game/`。现在游戏目录上提到了版本目录本身
    ///   （见 [`AppPaths::instance_game_dir`]），于是这个函数必须**换一个目标**：
    ///   继续返回版本目录就会让它与游戏目录**变成同一个路径**。
    ///
    ///   ★ 为什么那很危险（真机后果，不是洁癖）：`prepare_spec` 每次启动都会
    ///     `remove_dir_all(natives_dir)` 再重新解压 natives，而 `natives_dir`
    ///     是从这个函数拼出来的。两者一旦相等，**每次启动都会把整个版本目录
    ///     （含 saves 存档）删掉**。所以这里必须落到 `.ieml/`（见 [`LAUNCHER_SUBDIR`]）。
    ///
    ///   ★ 顺带解决的两件事：
    ///     ① 版本目录**就是游戏工作目录**，里面只该有游戏会读的东西；
    ///        `natives/`、`pack-record.json` 混在 `mods/` 旁边会被
    ///        整合包导出与"清理无用文件"当成游戏资源；
    ///     ② 老的 `instance_dir(slug)` 调用点（natives / 打包记录 / 隔离迁移）
    ///        全部自动落到 `.ieml/` 下面，**不必逐个改**。
    pub fn instance_dir(&self, slug: &str) -> PathBuf {
        self.instance_root_dir(slug).join(LAUNCHER_SUBDIR)
    }

    /// 版本目录本身（游戏目录；**不是**启动器目录）。
    ///
    /// 与 [`AppPaths::instance_game_dir`] 同义，单独留一个名字是为了在
    /// "要游戏目录、但不想走 ADR-005 隔离判定"的地方把意图写清楚。
    pub fn instance_root_dir(&self, slug: &str) -> PathBuf {
        self.instances.join(slug)
    }

    /// ★★ 实例的**游戏目录** —— 就是版本目录本身（PCL 的 `PathIndie == PathVersion`）。
    ///
    ///   `saves/`、`mods/`、`config/`、`options.txt` 全都在这一层，
    ///   启动时作为 `--gameDir` 传给游戏（见 `commands_real::prepare_spec`）。
    ///
    ///   ## 为什么不再是 `<实例目录>/game`（2026-09-30 改）
    ///
    ///   老布局把"游戏数据"塞在 `game/` 子目录里，而**版本 JSON 与客户端 jar
    ///   在另一个目录**（`.minecraft/versions/<版本名>/`）。后果是同一个版本
    ///   在盘上有两个家，且两边名字对不上（真机：账本 `vanilla-262`，
    ///   磁盘 `26.3-fabric-0.19.5`）。
    ///
    ///   PCL 的做法是**一个版本一个文件夹**，隔离的数据就放在版本文件夹里
    ///   （`ModMinecraft.vb:227-266`，`PathIndie` 直接返回 `PathVersion`）。
    ///   现在与它一致：版本 JSON / jar / saves / mods / config 同一个目录，
    ///   `--gameDir` 也指它。于是"这个版本在哪"永远只有一个答案。
    ///
    ///   ★★ **这是"物理上的"目录，不是"这个实例实际用的"目录**：
    ///     开了「不隔离」的实例，游戏读的是共享的 `.minecraft` ——
    ///     要那个请用 [`AppPaths::game_dir_of`]（它先做 ADR-005 的判定）。
    ///     凡是**游戏会读/写**的东西（saves、mods、config、logs、资源包…）都必须走
    ///     `game_dir_of`；只有 `natives/`、实例自己的日志与备份清单才用
    ///     [`AppPaths::instance_dir`]（那是 `.ieml/`，与这里**不是**同一个目录）。
    pub fn instance_game_dir(&self, slug: &str) -> PathBuf {
        self.instance_root_dir(slug)
    }

    /// 启动器**自己的**东西放在版本目录里的哪一层（`<版本目录>/.ieml/`）。
    ///
    /// 里面是 `natives/`、`pack-record.json` 这类**游戏不读**的文件。
    /// 与游戏会写的目录名（mods/saves/config/logs…）不重叠，所以放在版本目录里
    /// 不会污染游戏，也不会被整合包导出当成游戏资源。
    ///
    /// ★ 与 [`AppPaths::instance_dir`] **同义**（两个名字都留着：那边说的是
    ///   "老代码眼里的实例目录"，这边说的是"它在版本目录里的哪一层"。
    ///   实现不许各自拼一遍路径 —— 这个函数曾经反过来调 `instance_dir`，
    ///   而 `instance_dir` 又调它，于是**无限递归**（真跑起来是栈溢出崩溃）。
    pub fn instance_meta_dir(&self, slug: &str) -> PathBuf {
        self.instance_dir(slug)
    }

    /// 版本目录里那份**身份小抄**的路径（`<版本目录>/.ieml/instance.json`）。
    ///
    /// 见 [`INSTANCE_MARKER_NAME`] 的说明：它让"这个目录是谁"可以**从磁盘反推**，
    /// 而不是只能信账本。
    pub fn instance_marker_file(&self, slug: &str) -> PathBuf {
        self.instance_meta_dir(slug).join(INSTANCE_MARKER_NAME)
    }

    /// **算出**这个实例该有的身份小抄（**不写盘**）；目录不存在时 `None`。
    ///
    /// ★ 为什么要把"算"与"写"分开：`scan_folder_versions` 在**启动修整之后**
    ///   才跑，但用户完全可能"装完包、不重启就看列表" ——
    ///   那一刻盘上还没有小抄。判据必须能**现场算出来**，
    ///   而不是"读不到就当这个实例不存在"（那正是本轮这条 bug）。
    pub fn instance_marker_value(&self, slug: &str) -> Option<serde_json::Value> {
        if !self.instances.join(slug).is_dir() {
            return None;
        }
        /*
         * ★★★★ 2026-10-07：**只在账本里真有这个实例时才合成**。
         *
         *   第一版这里写成"目录在就合成一份"，结果把**空壳目录**也变成了
         *   "有身份的实例" —— 已有的测试立刻抓到：
         *   `fabric-262/`（只剩一个 `natives/`，没有 JSON、也不在账本里）
         *   的原因从「缺少版本描述文件」变成了「缺少前置版本 —— 这个实例声明的
         *   加载器没在盘上」。**那句原因是错的**：它根本没有声明过任何加载器。
         *
         *   ⇒ 判据与账本对齐（与 `instance_catalog_repair` 第 ⑤ 步同源）：
         *     · 账本里有 ⇒ 抄账本那一条（整合包实例必在其中）；
         *     · 账本里没有 ⇒ **不合成**，交给调用方按"盘上有、我们不了解它是什么"
         *       处理（有同名 JSON 的仍会被认成版本，空壳则如实报缺描述）。
         *   ★ 这正是不用"目录里有没有 mods/saves"去猜的原因：那是猜。
         */
        self.instance_json(slug)
    }

    /// **确保**这个实例目录有一份身份小抄；返回是否真的写了。
    ///
    /// ## 为什么要有这个函数（两次栽在同一个形状上）
    ///
    ///   ① 2026-10-06（用户截图：「整合包会被误判成错误版本」）：
    ///      写小抄的那一步原来要求"目录里有同名版本 JSON"，
    ///      而**整合包实例本来就没有** ⇒ 它永远拿不到小抄。
    ///   ② 2026-10-07（用户截图：「又来了，下载完后，整合包被误判为不可用」）：
    ///      上一条修完之后，判据变成了"看小抄认身份"，
    ///      **而写小抄只在启动时跑一次**
    ///      （`lib.rs` 启动时调 `instance_catalog_repair`）——
    ///      于是**刚装完的实例在本次会话里必然没有小抄**，列表照样判它错。
    ///
    ///   ⇒ 两次都是"**同一个事实在两个地方各判一次**，而两次判断的条件不同"。
    ///     所以这里把它收成**唯一实现**：
    ///       · 启动时的目录修整（`instance_catalog_repair` 第 ⑤ 步）；
    ///       · 版本列表按需补（`folder_versions` → `scan_folder_versions`）；
    ///     两处都调它，不再各自写一份。
    ///
    /// ## 写什么
    ///
    ///   · 账本里有这个 slug ⇒ **直接抄账本那一条**（它带 `loader` / `mcVersion`，
    ///     正是列表判据要用的）；
    ///   · 账本里没有（盘上有、账本没补上）⇒ `synthesize_instance` 现场推一份。
    ///
    /// ★ 幂等：已有且内容相同就不重写（避免每次列版本都动磁盘）。
    pub fn ensure_instance_marker(&self, slug: &str) -> bool {
        let dir = self.instances.join(slug);
        if !dir.is_dir() {
            return false;
        }
        let marker = match self.instance_marker_value(slug) {
            Some(m) => m,
            None => {
                /*
                 * 账本里没有它。**只有当目录里真有同名版本 JSON 时才合成** ——
                 * 那种目录是一个"自己说得清自己是谁"的版本（手动装 / HMCL 装的），
                 * 给它写一份身份是合适的；而空壳目录（只剩 `natives/`、
                 * 什么都没有）**不合成**，否则会凭空造出一个"有身份的实例"，
                 * 列表里那句原因就变成假的
                 * （实测：`fabric-262` 会从「缺少版本描述文件」变成
                 *  「这个实例声明的加载器没在盘上」—— 它从没声明过加载器）。
                 */
                if !dir.join(format!("{slug}.json")).is_file() {
                    return false;
                }
                synthesize_instance(&self.instances, slug)
            }
        };
        let path = self.instance_marker_file(slug);
        let text = match serde_json::to_string_pretty(&marker) {
            Ok(t) => t,
            Err(_) => return false,
        };
        // 已有且一样 ⇒ 不动盘
        if let Ok(old) = std::fs::read_to_string(&path) {
            if old == text {
                return false;
            }
        }
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        std::fs::write(&path, text).is_ok()
    }

    /* ============ 「原版是基座，不是独立版本」（见 `BASE_MARKER_NAME`） ============ */

    /// 基座记号的路径（`<版本目录>/.ieml/base.json`）。
    pub fn base_marker_file(&self, slug: &str) -> PathBuf {
        self.instance_meta_dir(slug).join(BASE_MARKER_NAME)
    }

    /// 这个版本目录**是不是只当基座用的**（不是独立版本）。
    ///
    /// ★ 判据只有一条：记号文件在不在。**不看目录里有什么** ——
    ///   基座与独立版本在磁盘上长得一模一样，能分开它们的只有这份意图。
    pub fn is_base_version(&self, slug: &str) -> bool {
        self.base_marker_file(slug).is_file()
    }

    /// 把一个版本目录标成**基座**（幂等）。返回是否真的写了。
    ///
    /// `for_version` 是"它是谁的基座"（写进记号里，纯粹为了以后能读懂）。
    pub fn mark_version_as_base(&self, slug: &str, for_version: &str) -> bool {
        let dir = self.instances.join(slug);
        if !dir.is_dir() || self.is_base_version(slug) {
            return false;
        }
        let path = self.base_marker_file(slug);
        if let Some(p) = path.parent() {
            if std::fs::create_dir_all(p).is_err() {
                return false;
            }
        }
        let body = serde_json::json!({
            "base": true,
            "for": for_version,
            "note": "这个目录只是上面那个版本的原版基座（装加载器时顺手装上的），\
                     不是独立的版本。用户自己单独装一次原版，这个记号就会被清掉。",
        });
        match serde_json::to_string_pretty(&body) {
            Ok(text) => std::fs::write(&path, text).is_ok(),
            Err(_) => false,
        }
    }

    /// 撤掉基座记号（用户**明确要了原版**时调）。返回是否真的删了。
    ///
    /// ★ 只删**文件**，不碰目录里的任何别的东西：那些文件（jar / 描述 / 存档）
    ///   本来就是这个版本的，撤记号只是让它**重新可以被当成一个版本**。
    pub fn clear_base_marker(&self, slug: &str) -> bool {
        let path = self.base_marker_file(slug);
        if !path.is_file() {
            return false;
        }
        std::fs::remove_file(&path).is_ok()
    }

    /// ★★★★ 这个目录**被当成一个版本玩过**吗？（2026-10-12）
    ///
    /// ## 为什么必须有这一条
    ///
    ///   用户报：「**启动器不认纯原版游戏了**」。
    ///
    ///   现场：`versions/26.3/` 从 **10-08** 起就是他的原版实例 ——
    ///   里面有他自己攒的存档、游戏写下的 `options.txt`、还有游戏日志；
    ///   目录里也**一直有** `.ieml/instance.json`（`id=inst-disk-26.3`）。
    ///   可 10-12 装/修一次加载器之后，修账本那段（`instance_catalog_repair`）
    ///   把这个目录判成了"基座"：它看的是**账本记录是谁写的** ——
    ///   `inst-disk-*` 属于"启动器自己捡回来的"，于是**不算"用户要的"** ⇒
    ///   盖上 `base.json`，紧接着又按"基座不是版本"把那条记录**清掉** ⇒
    ///   列表里再也看不到它（连"有目录没记录"那一档也不列，因为基座被跳过）。
    ///
    ///   ⇒ "记录是谁写的"只是**间接证据**（它只能说明我们当初是怎么发现它的，
    ///     说明不了用户有没有在用它）；"这个目录里有没有游戏留下的痕迹"才是
    ///     **直接证据**，而且就在盘上：
    ///
    ///       · 装加载器时**顺手装上的基座**：从来没有被启动过 ⇒ **没有** `options.txt`；
    ///       · 用户自己下过、并且开过一次的原版：游戏会在**当前游戏目录**里
    ///         写下 `options.txt`（`--gameDir` 指向它，见 `launch_args`）⇒ **有**。
    ///
    ///   ★ 判据只用这一个文件：它由**游戏**写、不由我们写（我们从不生成它），
    ///     所以它证明的是"这里真的被玩过"，而不是"我们曾经以为它是版本"。
    pub fn version_dir_was_played(&self, slug: &str) -> bool {
        self.instances.join(slug).join("options.txt").is_file()
    }

    /* ============ 隔离判定（ADR-005）：游戏目录到底在哪 ============ */

/// 启动器自己的一个 JSON 记录（`instances.json` / `prefs.json`）。
    ///
    /// ★ 读不到、读坏了、不是对象 —— 一律 `None`。调用方必须**按缺证据处理**，
    ///   而不是当成"空对象"继续往下猜（这个仓库已经因为"把读不到当没有"栽过）。
    pub fn own_json(&self, name: &str) -> Option<serde_json::Value> {
        let p = self.own_file_for_read(name)?;
        let text = std::fs::read_to_string(p).ok()?;
        serde_json::from_str::<serde_json::Value>(&text).ok()
    }

    /// 账本里这个实例那一条（`instances[].config.slug == slug`）
    pub fn instance_json(&self, slug: &str) -> Option<serde_json::Value> {
        let ledger = self.own_json("instances.json")?;
        ledger
            .get("instances")?
            .as_array()?
            .iter()
            .find(|i| {
                i.get("config")
                    .and_then(|c| c.get("slug"))
                    .and_then(|s| s.as_str())
                    == Some(slug)
            })
            .cloned()
    }

    /// 这个实例**自己的**游戏目录里已经有内容了吗（ADR-005 第 ② 段的证据）。
    ///
    /// ★ 判据是 `mods/` 或 `saves/` **存在且非空**：空目录不算"有内容" ——
    ///   启动器自己会在装资源包时把 `mods/` 建出来，把"目录在"当成"用户在用"
    ///   会让第 ② 段永远成立（等于自动判定失效，用户再也共享不了）。
    fn instance_game_dir_has_content(&self, slug: &str) -> bool {
        let game = self.instance_game_dir(slug);
        ["mods", "saves"].iter().any(|d| {
            std::fs::read_dir(game.join(d))
                .map(|mut it| it.next().is_some())
                .unwrap_or(false)
        })
    }

    /// **这个实例的隔离判定**（ADR-005）—— 界面显示的就是它，路径也按它算。
    ///
    /// 三份证据：账本里的 `config.isolation`、实例目录里有没有内容、
    /// `prefs.json` 的 `globalIsolation`。
    pub fn isolation_verdict(&self, slug: &str) -> crate::domain::isolation::Verdict {
        use crate::domain::types::IsolationMode;
        let inst = self.instance_json(slug);
        let readable = inst.is_some();
        let mode = inst
            .as_ref()
            .and_then(|i| i.get("config"))
            .and_then(|c| c.get("isolation"))
            .and_then(|m| m.as_str())
            .map(|m| match m {
                "on" => IsolationMode::On,
                "off" => IsolationMode::Off,
                _ => IsolationMode::Auto,
            })
            .unwrap_or(IsolationMode::Auto);
        let global = self
            .own_json("prefs.json")
            .and_then(|p| p.get("globalIsolation").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or_else(|| "isolated".to_string());
        crate::domain::isolation::resolve(mode, self.instance_game_dir_has_content(slug), &global, readable)
    }

    /// ★★ **这个实例实际使用的游戏目录** —— 全仓库唯一的那个答案。
    ///
    ///   隔离 → `instances/<slug>/game`；不隔离 → 共享的 `.minecraft`。
    ///   `--gameDir`、`mods/`、`saves/`、`config/`、资源包、数据包、备份、
    ///   「打开 mods 目录」—— 全部走这一个方法，否则就会出现
    ///   "界面说装好了、游戏读不到"（这个仓库最不能接受的那种错）。
    pub fn game_dir_of(&self, slug: &str) -> PathBuf {
        if self.isolation_verdict(slug).isolated {
            self.instance_game_dir(slug)
        } else {
            self.shared.clone()
        }
    }

    /// 实例的 mods 目录（属于游戏目录，不是实例目录）
    pub fn instance_mods_dir(&self, slug: &str) -> PathBuf {
        self.game_dir_of(slug).join("mods")
    }

    /// ★★ **任意一种社区资源的安装目录**（Mod / 资源包 / 光影 / 数据包）。
    ///
    /// 与 `instance_mods_dir` 同源（都在**游戏目录**下，不是实例目录下）——
    /// 这是唯一会让"装好了但游戏读不到"出错的点：
    /// 游戏进程的工作目录是 `instances/{slug}/game`（或者开了「不隔离」时的共享
    /// `.minecraft`），它只会在 `<gameDir>/resourcepacks` 里找资源包，别处一律看不见。
    ///
    /// `kind` 用 `domain::resources::ResourceKind`，目录名由它给
    /// （**只有一份**描述，见那个模块的说明）。
    pub fn instance_resource_dir(
        &self,
        slug: &str,
        kind: crate::domain::resources::ResourceKind,
    ) -> PathBuf {
        self.game_dir_of(slug).join(kind.install_dir())
    }

    /* ============ 启动器自己的文件（★★ A-4 修复：搬出游戏根目录） ============ */

    /// ★★ 启动器自己的一个文件（`instances.json` / `prefs.json` /
    ///   `ms_client_id.txt` / `cf_api_key.txt`）—— 它们住在**启动器自己的家**
    ///   （`own_root`，Windows 上是 `%APPDATA%\IEML`），**不在游戏根目录里**。
    ///
    ///   2026-09-24（缺陷报告 A-4）：「启动器数据目录搬出游戏根目录」原来**只搬了一半** ——
    ///   这几个文件当时还留在游戏根目录里。真机后果：用户在「候选盘」那页删掉一个
    ///   游戏根目录，会**连实例清单与全部设置一起删掉**，而两道确认框里都没有这句话。
    ///
    ///   ★ 同日的第二次修正（见 `AppPaths::instances`）：搬走的是**启动器自己的**
    ///     东西（这四个文件 + java/cache/logs）；**实例目录搬回来了** ——
    ///     它装的是存档与 Mod，属于游戏数据，得跟用户挑的游戏盘走。
    pub fn own_file(&self, name: &str) -> PathBuf {
        self.own_root.join(name)
    }

    /// 同上，但用来**读**：优先 `own_root`，那儿没有才回退到游戏根目录的老位置。
    ///
    /// ★ 为什么要留回退：老用户（0.1.0-rc.1 及以前）的文件就在游戏根目录里。
    ///   启动时的 [`adopt_records`] 会把它们**复制**过来；万一复制失败
    ///   （磁盘满 / 权限），读这一侧仍然读得到老位置 —— 不至于让用户觉得"东西没了"。
    pub fn own_file_for_read(&self, name: &str) -> Option<PathBuf> {
        let own = self.own_file(name);
        if own.is_file() {
            return Some(own);
        }
        let legacy = self.legacy_record_file(name);
        if legacy.is_file() {
            return Some(legacy);
        }
        None
    }

    /// 这四个文件在**游戏根目录**里的老位置（0.1.0-rc.1 及以前）。
    pub fn legacy_record_file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// 实例清单文件（`list_instances` / `save_instances` 用的那个）
    pub fn instances_file(&self) -> PathBuf {
        self.own_file("instances.json")
    }

    /// 全局偏好文件（主题 / 下载源 / 并发数 / 账号 uuid …）
    pub fn prefs_file(&self) -> PathBuf {
        self.own_file("prefs.json")
    }
}

fn dirs_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support");
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share");
    }
    PathBuf::from(".")
}

/* ====================== 数据目录选址（ADR：默认避开系统盘） ====================== */

/// 旧的（也是"记录文件"所在的）数据根目录。
///
/// ★ 顺序有意义：**第一个**就是记录文件的宿主目录，也是迁移的源目录。
pub fn legacy_data_roots() -> Vec<PathBuf> {
    vec![dirs_data_dir().join("IEML")]
}

/// 启动器**自己**的数据目录（实例清单 / Java / 缓存 / 日志）。
///
/// ★★ 2026-09-23：与"游戏在哪"**解耦** —— 见 `AppPaths::own_root`。
///
/// ★★ 2026-09-24（用户：「ABC 全做」，C = 把启动器的账本与 Java/缓存/日志也搬到 D 盘，
///   让系统盘彻底不留东西）：选址规则与数据根目录**同一套判据**（见 [`resolve_data_root`]）：
///
///   ① 环境变量 `IEML_OWN_DIR`（测试 / 绿色版显式覆盖）
///   ② `ownroot.txt` 记录（与 `datadir.txt` 同级、同一个宿主目录，理由见 `location_file`）
///   ③ 自动选址：**空闲空间最大的非系统盘**上的 `IEML-launcher`
///   ④ 兜底：`%APPDATA%\IEML`（单盘机器，没有别的选择）
///
///   ★ 为什么必须有 ② 这条记录：③ 是按"当前空闲空间"挑的，而空闲空间**每天都在变** ——
///     没有记录的话，D 与 E 的排序一变，启动器的家就会自己搬家，账本看着就"丢了"。
///     记录一次之后它就固定下来，换游戏根目录也不跟着动（A-4 的语义仍然成立）。
fn default_own_root() -> PathBuf {
    let mut cands: Vec<PathBuf> = Vec::new();

    /*
     * ★ 测试与自动化要能改：环境变量 `IEML_OWN_DIR` 覆盖。
     *   没有它的话，单测一跑就会去动**开发机真实的**启动器数据目录。
     */
    if let Ok(custom) = std::env::var("IEML_OWN_DIR") {
        if !custom.trim().is_empty() {
            cands.push(PathBuf::from(custom));
        }
    }

    if let Some(recorded) = read_record(&AppPaths::own_location_file()) {
        cands.push(recorded);
    }

    if let Some(best) = pick_best_volume() {
        cands.push(best.path.join(OWN_DIR_NAME));
    }

    let fallback = dirs_data_dir().join("IEML");
    cands.push(fallback.clone());

    match first_usable(cands) {
        Some(p) => p,
        None => fallback, // 连兜底都建不出来（极端情况）：至少不去 panic
    }
}

/// 从记录文件里读一行路径（**纯读**，不建目录、不写任何东西）。
fn read_record(file: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(file).ok()?;
    let line = text.lines().next().unwrap_or("").trim().to_string();
    if line.is_empty() {
        return None;
    }
    Some(PathBuf::from(line))
}

/// 按顺序取**第一个可用**的候选（能建、能写）。
///
/// ★ 抽成收 `Vec` 的纯函数是为了能单测：`default_own_root` 走的是环境变量 + 真实磁盘，
///   而这套优先级（谁先可用就用谁）才是真正要钉住的东西 —— 见
///   `first_usable_skips_candidates_that_cannot_be_created`。
fn first_usable(cands: Vec<PathBuf>) -> Option<PathBuf> {
    for p in cands {
        if p.as_os_str().is_empty() {
            continue;
        }
        if ensure_writable(&p) {
            return Some(p);
        }
        say!("[IEML/paths] 候选目录不可用（建不出来或写不进去）：{}", p.display());
    }
    None
}

/// ★★ 把"启动器自己的家在哪"记下来（幂等：内容一样就不写，免得每次启动都动文件）。
///
/// 放在 `%APPDATA%\IEML\ownroot.txt`（与 `datadir.txt` 同一个目录）——
/// 理由与那个文件完全一样：记录本身必须是"与所选盘无关的固定位置"。
pub fn remember_own_root(root: &Path) {
    remember_own_root_at(&AppPaths::own_location_file(), root);
}

fn remember_own_root_at(file: &Path, root: &Path) {
    if let Some(prev) = read_record(file) {
        if same_path(&prev, root) {
            return;
        }
        say!(
            "[IEML/paths] 启动器数据目录从 {} 改为 {}（记录在 {}）",
            prev.display(),
            root.display(),
            file.display()
        );
    } else {
        say!(
            "[IEML/paths] 启动器数据目录（账本 / Java / 缓存 / 日志）现在放在 {}（记录在 {}）",
            root.display(),
            file.display()
        );
    }
    write_location(file, root);
}

/// ★★ 2026-09-24：把"启动器自己的家"从**老位置**搬到新位置（**只复制，绝不删源**）。
///
/// 管两组东西：
///   · 账本四件：`instances.json` / `prefs.json` / `ms_client_id.txt` / `cf_api_key.txt`
///     —— 用 [`adopt_records_from`] 同一套判据（目标缺就补、源更新就赢、覆盖前先 `.bak`）；
///   · 运行时三样：`java` / `cache` / `logs` —— `copy_tree`（目标已有就跳过）。
///
/// ★ 为什么账本要"源更新就赢"：本机真机上 `%APPDATA%\IEML\instances.json` 才是应用
///   一直在写的那份（22:05 还在写），而游戏根目录那份停在 09-24 01:25（陈旧）。
///   如果这里按"目标已有就跳过"、而目标又恰好是刚建的新家（空的），
///   那么随后 `adopt_records` 会把游戏根目录里那份**陈旧**清单补进来 ——
///   顺序与新旧的判定都得对，否则用户会看到一份四小时前的清单。
///
/// 返回复制了多少字节（0 = 什么都不需要做）。
pub fn migrate_own_root(old: &Path, paths: &AppPaths) -> u64 {
    if !old.is_dir() || same_path(old, &paths.own_root) {
        return 0;
    }
    let mut copied = adopt_records_from(old, paths);
    for name in ["java", "cache", "logs"] {
        let from = old.join(name);
        if !from.is_dir() {
            continue;
        }
        match copy_tree(&from, &paths.own_root.join(name)) {
            Ok(0) => {}
            Ok(n) => {
                copied += n;
                say!(
                    "[IEML/paths] 把 {name} 搬到启动器数据目录（{n} 字节）—— 老位置那份保留不动"
                );
            }
            Err(e) => say!("[IEML/paths] 搬 {name} 失败：{e}"),
        }
    }
    /*
     * ★ 三个运行时目录**要存在**（即使源那边是空的）。
     *
     *   这条不变量在 2026-09-30 被打破过一次：`copy_tree_rule` 改成"不凭空造
     *   空目录"（为了让布局迁移幂等）之后，源里那个**空的** `java/` 就不再被
     *   复制 ⇒ 搬家之后启动器自己的家里没有 `java/`。
     *
     *   而这三个目录的含义是"启动器的家已经准备好了"（`ensure_own()` 也建它们），
     *   与"源里有没有东西"无关。所以在这里显式建出来，别借复制的手。
     */
    for name in ["java", "cache", "logs"] {
        if let Err(e) = std::fs::create_dir_all(paths.own_root.join(name)) {
            say!("[IEML/paths] 建启动器目录 {name} 失败：{e}");
        }
    }
    copied
}

/// 一个候选磁盘上，我们打算用的子目录名
const DATA_DIR_NAME: &str = "IEML";

/// 非系统盘上放**启动器自己的家**的目录名（本机 = `D:\IEML-launcher`）。
///
/// ★ 为什么不直接叫 `IEML`：那是**游戏**根目录的名字（`D:\IEML` 里是 `.minecraft`
///   与 `instances`）。启动器自己的账本/Java/缓存放同一个名字下会与游戏目录撞车，
///   而"游戏的家"与"启动器的家"是两个东西（见 `AppPaths::own_root`）。
const OWN_DIR_NAME: &str = "IEML-launcher";

/// ★ 解析数据根目录。
///
/// 优先级（高 → 低），**每一步都留下证据，绝不猜**：
///   ① 环境变量 `IEML_DATA_DIR` —— 给"绿色版/多份配置"用的显式覆盖
///   ② 启动器 exe 旁边的 `ieml-portable.txt` —— 便携模式（内容是目录名）
///   ③ `datadir.txt` 记录 —— 上次选定/用户手选的结果
///   ④ `%APPDATA%\IEML` —— **只有在它不是系统盘时才用它**（老用户无感升级）
///   ⑤ 自动选址：**空闲空间最大的非系统盘**（本机是 D:）
///   ⑥ 实在找不到非系统盘 → 老实回到 `%APPDATA%\IEML`（并在记录里写明原因）
///
/// ## 为什么要做这件事
///
/// 用户的诉求：「数据目录应该默认避开系统盘」。
/// 一个装了十几个整合包的启动器，`libraries` + `assets` + 实例很容易超过
/// 20 GB；而系统盘通常是最小、最满、也最不该被写满的那一块（写满会
/// 让整个 Windows 出问题）。所以默认选址必须落在数据盘上。
pub fn resolve_data_root() -> PathBuf {
    // ① 环境变量覆盖
    if let Some(v) = std::env::var_os("IEML_DATA_DIR") {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }

    // ② 便携模式：exe 旁边放一个 ieml-portable.txt
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let flag = exe_dir.join("ieml-portable.txt");
        if flag.is_file() {
            return exe_dir.join(DATA_DIR_NAME);
        }
    }

    let location_file = AppPaths::location_file();

    // ③ 记录文件：只有"这一行确实指向一个我们能写的地方"才采信
    if let Ok(text) = std::fs::read_to_string(&location_file) {
        let line = text.lines().next().unwrap_or("").trim().to_string();
        if !line.is_empty() {
            let p = PathBuf::from(line);
            if is_usable_data_root(&p) {
                return p;
            }
            say!(
                "[IEML/paths] 记录里的数据目录不可用（{}），重新选址",
                p.display()
            );
        }
    }

    let legacy = legacy_data_roots()[0].clone();

    // ④ 老位置不在系统盘 → 保持原样（老用户升级后完全无感）
    if !is_on_system_drive(&legacy) {
        write_location(&location_file, &legacy);
        return legacy;
    }

    // ⑤ 自动选址：空闲空间最大的非系统盘
    if let Some(best) = pick_best_volume() {
        let root = best.path.join(DATA_DIR_NAME);
        if ensure_writable(&root) {
            say!(
                "[IEML/paths] 默认数据目录在系统盘上，已改到 {}（空闲 {:.1} GB）",
                root.display(),
                best.free_gb
            );
            write_location(&location_file, &root);
            return root;
        }
    }

    // ⑥ 兜底：没有别的盘可用（单盘机器）
    say!(
        "[IEML/paths] 没有可用的非系统盘，数据目录仍放在 {}",
        legacy.display()
    );
    write_location(&location_file, &legacy);
    legacy
}

fn write_location(file: &Path, root: &Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, format!("{}\n", root.display()));
}

/// 这个路径能不能当数据根目录：能建、能写。
fn is_usable_data_root(p: &Path) -> bool {
    if p.as_os_str().is_empty() {
        return false;
    }
    ensure_writable(p)
}

fn ensure_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".ieml-write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 玩家指定一个新的数据根目录（2026-09-17 用户要求）。
///
/// ## 语义：**新建一个，旧的原样不动**
///
/// 用户的原话是「单独建一个根目录，源目录不删」。所以这里**不做迁移** ——
/// 一个字节都不搬、也不删。切换之后：
///   * 新根目录是**空的**，游戏要重新装（该盘上的空间自己算）
///   * 旧根目录里的版本、存档、Mod **原封不动地留在那**，随时可以切回去
///
/// ★ 为什么不做"顺手搬过去"：那是一个会失败一半的操作（几十 GB、
///   跨盘、中途断电），而失败之后的界面没法诚实描述"搬了多少"。
///   要做也得单独一轮，配断点续搬与校验。**这一版只做切换，并把话说清楚。**
///
/// ## 拒绝的几种情况（每一条都给出具体原因，不返回一句"路径非法"）
///
/// * 空路径、相对路径 —— 相对谁？没有意义
/// * 和当前根目录同一个 —— 无操作，不该写记录文件
/// * 在**当前根目录里面** —— 数据目录套数据目录，扫描与清理都会失控
/// * 当前根目录在**目标里面** —— 同上，方向相反
/// * 建不出来 / 写不进去（只读盘、权限不够）—— 现在就说，别等下载到一半
///
/// ## 不拒绝但会**告诉调用方**的
///
/// 目标在系统盘上。默认选址是刻意躲开系统盘的（数据能到 20 GB+），
/// 但玩家可能有自己的理由（只有一块盘）。所以这是**提示**不是错误 ——
/// 判断权在他，我们只负责别让他不知情。
pub fn set_data_root(target: &Path, current: &Path) -> Result<(), String> {
    validate_data_root(target, current)?;
    /*
     * ★★ 2026-09-22：**只把游戏根目录建出来**（`<root>/.minecraft`）。
     *
     *   用户的抱怨："这个根目录只创建装游戏的根目录，**不要附带启动器文件**"。
     *   建这一层是必要的（否则重启后第一次进游戏会因为目录不存在而失败），
     *   但**启动器自己的目录一个都不在这里建** —— 它们由 `ensure_own()` 懒建。
     */
    if let Err(e) = std::fs::create_dir_all(target.join(".minecraft")) {
        say!("[IEML/paths] 建游戏目录失败（不影响记录选择）：{e}");
    }
    write_location(&AppPaths::location_file(), target);
    say!(
        "[IEML/paths] 数据目录已改为 {}（旧目录 {} 保持原样，未搬未删）",
        target.display(),
        current.display()
    );
    Ok(())
}

/// 上面那件事的**纯校验部分**（不碰磁盘、不写记录文件）。
///
/// ★ 为什么拆出来：`set_data_root` 成功时会写 `datadir.txt` ——
///   如果测试直接调它，跑一次单测就会把**开发机真实的**数据目录记录改掉。
///   拆开之后测试只验判据，不产生副作用。
///
/// 注意 `is_usable_data_root` 那一步**会建目录**（要试写）——
/// 所以测试传的一定是临时目录。
pub fn validate_data_root(target: &Path, current: &Path) -> Result<(), String> {
    if target.as_os_str().is_empty() {
        return Err("路径是空的。".into());
    }
    if !target.is_absolute() {
        return Err(format!(
            "要一个完整路径（形如 D:\\IEML），现在是相对路径：{}",
            target.display()
        ));
    }

    // 用规范化后的形式比较，避免 `D:\IEML` 与 `D:\IEML\` 被当成两个地方
    let t = norm_path(target);
    let c = norm_path(current);

    if t == c {
        return Err("这就是当前的数据目录，没有变化。".into());
    }
    if t.starts_with(&c) {
        return Err(format!(
            "这个目录在当前数据目录**里面**（{}）。\
             数据目录不能嵌套 —— 否则版本扫描和清理会把彼此当内容。",
            current.display()
        ));
    }
    if c.starts_with(&t) {
        return Err(format!(
            "当前数据目录（{}）在你选的位置**里面**。\
             选一个与它无关的目录。",
            current.display()
        ));
    }

    if !is_usable_data_root(target) {
        return Err(format!(
            "这个位置建不出来或写不进去：{}。\
             换个目录，或者先确认盘符存在、不是只读的。",
            target.display()
        ));
    }
    Ok(())
}

/// 系统盘（Windows 上是 `%SystemRoot%` 所在的盘符）—— 默认不该往上写游戏数据。
pub fn is_on_system_drive(p: &Path) -> bool {    #[cfg(windows)]
    {
        let Some(sys) = std::env::var_os("SystemRoot") else {
            return false;
        };
        let sys_drive = PathBuf::from(sys)
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_uppercase());
        let p_drive = p
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_uppercase());
        match (sys_drive, p_drive) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        false
    }
}

#[derive(Debug, Clone)]
struct Volume {
    path: PathBuf,
    free_gb: f64,
}

/// 挑一个非系统盘：**先看空闲空间**，同分再看盘符顺序（结果稳定，便于复现）。
fn pick_best_volume() -> Option<Volume> {
    #[cfg(windows)]
    {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        let mut best: Option<Volume> = None;
        let mut all: Vec<Volume> = Vec::new();
        for d in disks.list() {
            let mount = d.mount_point().to_path_buf();
            if is_on_system_drive(&mount) {
                continue;
            }
            let free_gb = d.available_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            // 太空的盘（可移动介质）不当默认：至少要能装下两份游戏
            if free_gb < 5.0 {
                continue;
            }
            all.push(Volume { path: mount, free_gb });
        }
        all.sort_by(|a, b| {
            b.free_gb
                .partial_cmp(&a.free_gb)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.path.cmp(&b.path))
        });
        if let Some(first) = all.into_iter().next() {
            best = Some(first);
        }
        best
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/* ====================== 可以放游戏数据的盘（设置页"在启动器里选"） ====================== */

/// 一块能放游戏数据的盘 —— **给设置页的选择列表用**。
///
/// ★★ 用户 2026-09-20：「我希望数据目录是在启动器里选，不需要到资源管理器里找」。
///
///   所以这里给的**不只是盘符**：`free_gb`（够不够装游戏）与 `is_system`
///   （默认选址刻意躲开它）是玩家真正要据此决定的两件事；`suggested` 直接给
///   "我们打算建的目录"，目录名取自本文件的 [`DATA_DIR_NAME`] ——
///   **前端不许自己拼路径**：拼错就是"界面说的位置"和"文件实际落下的位置"
///   不是同一个地方，而那种错**一点报错都没有**。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// 挂载点（Windows 上是 `D:\`）
    pub path: String,
    /// 剩余空间（GB，一位小数）
    pub free_gb: f64,
    /// 总容量（GB，一位小数）
    pub total_gb: f64,
    /// 在系统盘上 —— 提示，不是错误（只有一块盘的机器上它就是唯一选择）
    pub is_system: bool,
    /// 建议的根目录：`<挂载点>\IEML`
    pub suggested: String,
    /// ★ 建议的那个目录**就是**现在正在用的那个（**精确到路径**）
    pub is_current: bool,
    /// 现在用的根目录**在这块盘上**（可能不是 `suggested` 那个目录）
    ///
    /// ★★ 这两个字段为什么要分开：第一版只有"这块盘是不是当前盘"，
    ///   于是玩家把根目录设成 `D:\测试目录` 之后，**D: 那一行整行被标成
    ///   「正在用」、按钮禁用** —— 他就再也换不回 `D:\IEML` 了，
    ///   只能去开系统文件夹对话框（而那个正是他想避开的）。
    ///   2026-09-20 由用户自己的操作暴露：他真的把根目录换成了 `D:\测试目录`。
    pub on_current_drive: bool,
}

/// 列出所有卷（**含系统盘**，一块都不藏 —— 藏了单盘机器就没得选）。
///
/// ★ 顺序：非系统盘在前，同组按剩余空间从大到小，最后按盘符定序（结果稳定）。
///   这与自动选址 [`pick_best_volume`] 是**同一套判据**，不另立一份。
///
/// ★★ 2026-09-26 起**没有生产调用方**了：它原来唯一的生产用途是
///   `list_known_roots` 里那条"扫盘扫到 `<盘>\IEML` 就列出来"，
///   而用户明确要求那张表**只显示他自己选过的目录**（见 `list_known_roots` 的说明）。
///
///   ★ 但它**没有删**，两个理由：
///     · 它用的判据（哪些盘可用、哪个是系统盘、建议目录名来自 `DATA_DIR_NAME`）
///       与自动选址 `pick_best_volume` 是**同一套**，而下面那两条测试守的正是这套判据；
///     · 以后若要加一个**用户主动打开**的"浏览其它盘/目录"面板，它就是现成的数据源 ——
///       被去掉的是"默认就列出来"，不是"这个能力不该存在"。
#[allow(dead_code)]
pub fn list_volumes(current: &Path) -> Vec<VolumeInfo> {
    #[cfg(windows)]
    {
        use sysinfo::Disks;
        const GB: f64 = 1024.0 * 1024.0 * 1024.0;
        let round1 = |v: f64| (v * 10.0).round() / 10.0;

        let disks = Disks::new_with_refreshed_list();
        let mut out: Vec<VolumeInfo> = disks
            .list()
            .iter()
            .map(|d| {
                let mount = d.mount_point().to_path_buf();
                let suggested = mount.join(DATA_DIR_NAME);
                VolumeInfo {
                    path: mount.to_string_lossy().to_string(),
                    free_gb: round1(d.available_space() as f64 / GB),
                    total_gb: round1(d.total_space() as f64 / GB),
                    is_system: is_on_system_drive(&mount),
                    is_current: same_path(&suggested, current),
                    on_current_drive: current.starts_with(&mount),
                    suggested: suggested.to_string_lossy().to_string(),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.is_system
                .cmp(&b.is_system)
                .then(
                    b.free_gb
                        .partial_cmp(&a.free_gb)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then_with(|| a.path.cmp(&b.path))
        });
        out
    }
    #[cfg(not(windows))]
    {
        let _ = current;
        Vec::new()
    }
}

/// 两个路径是不是同一个地方。
///
/// ★ 只用来判"这一行是不是现在正在用的那个" —— 所以按 Windows 的规矩比：
///   大小写不敏感、末尾分隔符不算差别（`D:\IEML` 与 `D:\IEML\` 是一个地方）。
///   不解析 `..`、不碰符号链接：这里比的是**我们自己拼出来的**建议路径
///   与用户记录里的路径，不是任意两个用户输入。
///
/// ★ 2026-09-24：规范化那一步改成共用 [`norm_path`] —— 原来这里有一份自己的
///   实现（顺带把 `/` 也归一了），"是不是同一处"在收养老目录时也要用，
///   两份实现迟早会对 `D:/IEML` 这种写法给出不同答案。
///   （副作用：非 Windows 上不再强制小写 —— 那三个平台本来就大小写敏感，
///   而这只影响开发机上的单测，发行版只有 Windows。）
pub fn same_path(a: &Path, b: &Path) -> bool {
    !a.as_os_str().is_empty() && norm_path(a) == norm_path(b)
}

/// 这个目录是不是"一次手滑会删掉一大片"的那种（盘符根 / 用户目录 / 系统目录）。
///
/// ★ 危险操作的判据要**宽进严出**：宁可多拦几个（用户还能去资源管理器自己删），
///   也不能放过一个 —— 放过的代价是不可恢复的。
pub fn is_dangerous_root(p: &Path) -> bool {
    // 盘符根：`D:` 这种（去掉尾分隔符后只剩两字符且以冒号结尾）
    let s = p.to_string_lossy();
    let trimmed = s.trim_end_matches(['\\', '/']);
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return true;
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        if same_path(p, Path::new(&home)) {
            return true;
        }
    }
    for key in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Some(v) = std::env::var_os(key) {
            if same_path(p, Path::new(&v)) {
                return true;
            }
        }
    }
    false
}

/* ====================== 「用过的游戏文件夹」列表（PCL 那种） ====================== */

/// 设置页那个**文件夹列表**的一行。
///
/// ★★ 用户 2026-09-20（直接给了 PCL 的截图）：「**这个切换列表我想要 PCL 这样的**」。
///
///   PCL 的「文件夹列表」列的是**你用过的 .minecraft 文件夹**（名字 + 路径），
///   而不是"机器上有哪些盘"。盘符列表是我上一版的做法 —— 它每次都要你重新想
///   "放哪"；而 PCL 那种是**回到你去过的那个地方**，一次点击。
///
///   ★ 两边都要有：用过的（`known`，存在记录文件里）+
///     在盘上扫到的同款目录（`found`，`<盘>\IEML` 且**确实存在**）——
///     后者让"第一次用这个功能"的人也有东西可点，而不是对着一行空白。
///
///   ★★ 2026-09-26：上面那条"扫盘"的来源**已按用户要求去掉**（现在只剩
///     `current` 与 `known`，且 `known` 只由"玩家自己换过目录"写入）。
///     字段本身留着 —— 界面上给行加什么标记是它的事，但**值只有这两种**。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownRoot {
    /// 完整路径（**数据根目录**；游戏数据在它下面的 `.minecraft`）
    pub path: String,
    /// 显示名：取路径最后一段（`D:\测试目录` → `测试目录`）
    pub name: String,
    /// 这个目录现在还在不在。**不在的照样列出来**（PCL 也是），
    /// 但只能"移除"，不能"用这个" —— 点一个不存在的目录只会报错。
    pub exists: bool,
    /// 就是现在正在用的那个（**精确到路径**，不是"同一块盘"）
    pub is_current: bool,
    /// 在系统盘上 —— 提示，不是错误（只有一块盘的机器上它就是唯一选择）
    pub on_system_drive: bool,
    /// 这一行从哪来：`current` = 现在正在用的那个；`known` = 玩家自己选过的
    ///
    /// ★★ 2026-09-26：**只剩这两种**。以前的 `found`（扫盘扫到的 `<盘>\IEML`）
    ///   已按用户要求去掉 —— 那张表只显示他自己选过的目录。
    pub source: String,
}

/// 记录文件放**记录目录**（`%APPDATA%\IEML\`）里，与 `datadir.txt` 并排。
///
/// ★ 为什么不放数据根目录里：它记的是"启动器知道哪些文件夹" ——
///   而这正是**在数据目录不可用/要换掉**时需要读的东西。放进数据目录里，
///   一旦换到别处就看不到自己的历史了（自举问题）。
fn known_roots_file() -> PathBuf {
    AppPaths::location_file()
        .parent()
        .map(|d| d.join("known-roots.json"))
        .unwrap_or_else(|| PathBuf::from("known-roots.json"))
}

/// 最多记几个。★ 有上限是为了**不让这个文件无限长大**（每换一次加一条）；
/// 12 个足够覆盖"我有几个盘、几个测试目录"的真实使用。
const MAX_KNOWN_ROOTS: usize = 12;

/// 读记录（新→旧）。坏文件/没文件都当空表 —— **读不到不等于没有**，
/// 但也绝不能因此拦启动（这个文件只是"便利"，不是数据）。
pub fn load_known_roots() -> Vec<PathBuf> {
    load_known_roots_from(&known_roots_file())
}

/// ★ 真正的实现带**文件参数** —— 与 `validate_data_root` 拆出来的理由一样：
///   成功路径会**写**真实记录文件，测试直接跑它等于"跑一次单测就改掉开发机的列表"。
fn load_known_roots_from(file: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        say!("[IEML/paths] 文件夹列表读不出来（文件坏了），这次当空的");
        return Vec::new();
    };
    v.get("roots")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| PathBuf::from(s.trim()))
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn write_known_roots(file: &Path, roots: &[PathBuf]) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let arr: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let body = serde_json::json!({ "roots": arr });
    if let Err(e) = std::fs::write(file, serde_json::to_string_pretty(&body).unwrap_or_default()) {
        // ★ 写失败**不拦任何事**：这只是"下次少一个快捷入口"，不是数据丢失
        say!("[IEML/paths] 文件夹列表写不进去（{e}）：下次少一个入口，不影响别的事");
    }
}

/// 把某个目录记进"用过"（**去重、置顶**）。
///
/// ★ 判重用 [`same_path`]（大小写与末尾分隔符不算差别）：
///   否则 `D:\IEML` 与 `d:\ieml\` 会变成两条，用户看到两个一模一样的入口。
pub fn remember_root(root: &Path) {
    if root.as_os_str().is_empty() {
        return;
    }
    remember_root_at(&known_roots_file(), root);
}

fn remember_root_at(file: &Path, root: &Path) {
    let mut roots = load_known_roots_from(file);
    roots.retain(|p| !same_path(p, root));
    roots.insert(0, root.to_path_buf());
    roots.truncate(MAX_KNOWN_ROOTS);
    write_known_roots(file, &roots);
}

/// 从"用过"里去掉一条（目录已经没了时用户会点它）。
pub fn forget_root(root: &Path) {
    forget_root_at(&known_roots_file(), root);
}

fn forget_root_at(file: &Path, root: &Path) {
    let mut roots = load_known_roots_from(file);
    let before = roots.len();
    roots.retain(|p| !same_path(p, root));
    if roots.len() != before {
        write_known_roots(file, &roots);
    }
}

/// 组装设置页要显示的那张列表：**玩家选过的那些目录**，当前那个排最前。
///
/// ★★ 2026-09-26 用户（设置页 → 存储 → 切换，截图）：
///   「改成**默认只显示玩家安装时选择的那盘的游戏目录文件夹**，当玩家新建一个新的
///     游戏目录文件夹时，新的文件夹会出现在这个栏里，**其余的不要**」。
///
///   改之前这张表有**三个来源**：当前目录 + 用过的（记录文件）+ **扫盘扫到的
///   `<盘>\IEML`**。第三个是这次要去掉的 —— 它的本意是"第一次用这个功能的人
///   也有东西可点，而不是对着一行空白"，但实际效果是**替玩家列了一堆他没选的目录**：
///   截图里 `E:\IEML` 与 `C:\Users\…\Roaming\IEML` 都不是他挑的，只是盘上恰好存在。
///
///   ⇒ 现在的判据只有一条：**这个目录是玩家自己选过的**（或者就是现在正在用的那个）。
///     所以下面的候选**只来自** `current` 与 `load_known_roots()`，
///     而记录文件由 `remember_root` 写 —— 它的唯一调用点是 `set_data_root` 成功之后。
///     ★ 连启动时那次"顺手记一下"也删了（在 `lib.rs`）：那不是玩家的选择，
///       而且它会把**探针/测试跑过的临时目录**永久留在玩家的列表里
///       （截图里那两条 `ieml-live-*` 就是这么来的）。
pub fn list_known_roots(current: &Path) -> Vec<KnownRoot> {
    let mut remembered = vec![current.to_path_buf()];
    remembered.extend(load_known_roots());
    merge_root_candidates(current, remembered)
}

/// ★ 真正干活的那一半：**只认传进来的候选**，不自己去发现任何目录。
///
///   拆出来的理由与 [`load_known_roots_from`] 一样，是**可测性**：
///   候选从哪来（记录文件 / 以后可能别的地方）不是这里该管的事，
///   这里只保证"进来什么就只显示什么" —— 也就是上面那条要求的判据本身。
fn merge_root_candidates(current: &Path, candidates: Vec<PathBuf>) -> Vec<KnownRoot> {
    let mut out: Vec<KnownRoot> = Vec::new();
    let mut push = |p: &Path, source: &str| {
        if out.iter().any(|r| same_path(Path::new(&r.path), p)) {
            return;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            // 盘根目录（`D:\`）没有 file_name —— 用盘符当名字
            .unwrap_or_else(|| p.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
        out.push(KnownRoot {
            path: p.to_string_lossy().to_string(),
            name,
            exists: p.is_dir(),
            is_current: same_path(p, current),
            on_system_drive: is_on_system_drive(p),
            source: source.to_string(),
        });
    };

    // ① 现在正在用的那个排最前（PCL 的截图里也是"当前文件夹"在最上面）
    push(current, "current");
    // ② 玩家自己选过的那些（新 → 旧）
    for p in candidates {
        push(&p, "known");
    }
    out
}

/// ★★ 把老布局的 `shared/` 挪成 `.minecraft/`（**同盘改名，秒完成**）。
///
/// ## 为什么用 `rename` 而不是像 `migrate_data_root` 那样逐个复制
///
///   `migrate_data_root` 处理的是**跨目录（可能跨盘）**的搬家，所以只能复制。
///   而这里两边都在同一个数据根目录下 —— 同一卷上的 `rename` 是**原子**的：
///   要么完全没动，要么一步到位，不存在"复制到一半"的中间态。
///   这也让 1.4 GB 的游戏文件**瞬间**完成，而不是复制几分钟再删源。
///
/// ## 四种情况
///
///   · `shared/` 在、`.minecraft/` **不存在**   → 改名（唯一会动手的情况）
///   · `shared/` 在、`.minecraft/` 是**空目录**  → 删掉空壳再改名
///     （`AppPaths::ensure()` 在任何一次启动里都会把 `.minecraft/` 建出来，
///       所以"空壳"是**常态**而不是异常 —— 不处理它，迁移就永远不会发生）
///   · `.minecraft/` 里**有东西**               → 什么都不做：已经是新布局，
///     那个 `shared/` 可能是用户自己放的东西，也可能是上次没搬完的残留 —— 不猜、不动
///   · 两个都不在                               → 什么都不做（全新安装）
///
/// 返回 `Some(路径)` = 这次真的搬了（调用方要如实打印出来）。
pub fn migrate_shared_into_game_dir(root: &Path) -> std::io::Result<Option<PathBuf>> {
    let old = root.join(LEGACY_SHARED_NAME);
    let new = root.join(GAME_DIR_NAME);
    if !old.is_dir() {
        return Ok(None);
    }
    if new.exists() {
        // 空目录 = `ensure()` 建的空壳，可以安全删掉；有内容就一律不动
        let empty = std::fs::read_dir(&new)?.next().is_none();
        if !empty {
            return Ok(None);
        }
        std::fs::remove_dir(&new)?;
    }
    std::fs::rename(&old, &new)?;
    /*
     * ★ 改完名**必须验一下**：`rename` 成功后目标一定在，但这里再确认一次
     *   是有意的 —— 这一步之后我们会在界面上说"游戏数据在 .minecraft 里"，
     *   说出口的东西得有证据。
     */
    if !new.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("改名后没找到 {}", new.display()),
        ));
    }
    Ok(Some(new))
}

/// ★★ 把老位置的数据搬到新位置（**只补齐，绝不删改**）。
///
/// ## 两条铁律
///
///   ① **只复制、绝不删除源** —— 搬家中途断电/被杀，用户不能同时失去两边。
///   ② **目标已有的东西一个字节都不动** —— 目标上的数据是用户
///      "现在正在用的那份"，源那边是"以前那份"。任何情况下都该以目标为准。
///
/// ## 为什么是"补齐"而不是"搬一次就完事"
///
///   实测踩到过一个**真的丢了用户数据**的 bug（由本函数与前端一起造成）：
///   某次启动后 `instances.json` 被写成了 `{"instances":[],...}`
///   （前端"读失败也允许写"的锅，已在那边修好），
///   而这里当时只按"目标存在就跳过"处理 → 用户建的三个版本
///   从界面上消失了，而老位置的文件明明还好好地躺在那里。
///
///   所以现在：**目标缺什么就补什么**。
///   · 目标没有的目录/文件 → 从源复制过去（能自动修好上面那种损坏）
///   · 目标已有 → 一个字节都不碰
///   · 目标的 `instances.json` 是**空列表**而源里有人 → 用源的（见下）
///
///   这一条与"用户主动删掉某个版本后它会不会复活"不冲突：
///   复制是**单向**的（源 → 目标），用户删的只是目标那一份，
///   源那份动不了目标。所以最多是"老位置还留着一份尸体"，
///   不会把删掉的东西变回来。
///
/// 返回复制了多少字节；`Ok(0)` = 什么都不需要做。
pub fn migrate_data_root(old: &Path, new: &Path) -> std::io::Result<u64> {
    if !old.is_dir() || old == new {
        return Ok(0);
    }
    // 只认真正的数据子目录，别把用户的杂物搬过去
    /*
     * ★★ 2026-09-24：实例目录跟着**游戏根目录**一起搬是对的（里面是存档与 Mod）。
     *
     *   ★★ 2026-09-30（布局规范化）：**目的地变了** —— 从 `<new>/instances`
     *     改成 `<new>/.minecraft/versions`（见 `AppPaths::instances`）。
     *     老根上的 `<old>/instances` 于是要落到**新的版本目录**里；
     *     而老根如果本身已经是新布局，它的 `<old>/.minecraft/versions`
     *     由下面"游戏文件"那一步整树复制（`copy_tree` 不覆盖已存在的文件），
     *     所以这里只负责把**老 `instances/` 那一边**并进去。
     *
     *   ★ 用**按 mtime 判胜负**的补齐（不是"目标已有就跳过"）：实例里是用户
     *     自己会改的东西（options.txt / 存档 / Mod），而"错位置那两天"写进去的
     *     正是老位置那一份 —— 见 `merge_instances_by_mtime` 的说明
     *     （真机上差 12 天的 options.txt）。
     */
    let versions_dest = new.join(GAME_DIR_NAME).join(VERSIONS_DIR_NAME);
    let legacy_instances = old.join(LEGACY_INSTANCES_NAME);
    let mut copied = 0u64;
    /*
     * ★★ 2026-09-30：顺序是"**先把老布局提平、再逐文件合并**"，不能反过来。
     *
     *   老布局的实例是两层的（`<slug>/game/…`），新布局一层就够。
     *   `merge_instances_by_mtime` 是**逐文件**按相对路径比 mtime 的：
     *   · 若先合并，老根的 `game/options.txt` 会与目标的 `options.txt` 直接比，
     *     于是提层时"目标已有、且不比源旧" → 它**一个字节都不动**，
     *     而两个源（各自的 `game/options.txt`）谁赢了这件事已经无从表达；
     *   · 先提平（`promote_legacy_game_subdir`，同样按 mtime 判、覆盖前留
     *     `.ieml-bak`），再把两侧的**同一层**逐文件合并 —— 于是"最后真正玩过
     *     的那份"必然赢，输的那份也一定留下了备份。
     *
     *   ★ 真机上这就是 `lang:zh_cn`（当天玩的）与 `lang:en_us`（十几天前）
     *     差 12 天的那种情形。
     */
    let flattened = flatten_legacy_game_dirs(&legacy_instances);
    if !flattened.is_empty() {
        say!(
            "[IEML/paths] 老实例目录里有 {} 个版本还套着 game/，已提平（{}）",
            flattened.len(),
            flattened.join(" / ")
        );
    }
    /*
     * ★★★★ 2026-10-01（用户）：「**这些不可用版本，删除后，在重启启动器后会复活**」。
     *
     *   ## 这里就是那个"复活"的最后一环
     *
     *   真机证据：`%APPDATA%\IEML\instances\`（老数据根）里躺着
     *   `vanilla-1122`（11 个 `natives` 里的 dll）与 `vanilla-262`（26 个）——
     *   **与盘上"复活"出来的内容一字不差**，而盘上那两份的创建时间
     *   正好是每次启动的时刻。⇒ 它们是从这里被**复制回来**的。
     *
     *   而这一段**每次启动都跑**（`lib.rs` 遍历 `legacy_data_roots()` 逐个调
     *   `migrate_data_root`），`instance_catalog_repair` 那套"只做一次"的
     *   `.instances-merged` 标记**管不到它** —— 这就是同一个"补一次"动作
     *   存在**两份实现、只有一份带阀门**的老毛病。
     *
     *   ## 阀门按"想搬的东西"分，而不是共用一个标记
     *
     *   两条合并的**源不同**，所以不能共用一个标记：
     *     · `instance_catalog_repair`：`<当前游戏根>/instances/` → `versions/`
     *       （布局迁移，标记 = `versions/.instances-merged`）；
     *     · 这里：`<老数据根>/instances/` → `versions/`
     *       （换过数据根的人才会走到）。
     *   共用会让先跑的那一步把后跑的那一步**永久关掉**（旧根的数据再也搬不过来）。
     *   ⇒ 这里用**目的地 + 老根路径**算出来的独立标记。
     *
     *   ★ 标记只在**真的搬过东西之后**写（`copied` 增量 > 0）：
     *     老根里暂时没内容时不留痕，将来它真有内容了还能搬过来。
     *   ★ 墓碑仍然是最外层的保护（`merge_instances_by_mtime` 认它）——
     *     标记只是省掉"每次都白比一遍"，不是"以后都不管了"。
     */
    let legacy_marker = versions_dest.join(legacy_merge_marker_name(old));
    if legacy_instances.is_dir() && !legacy_marker.is_file() {
        let before = copied;
        copied += merge_instances_by_mtime(&legacy_instances, &versions_dest)?;
        if copied > before {
            let note = format!(
                "老数据根 {} 的 instances/ 已并入这里（一次性）。\n\
                 有它就不会再重复比对；删掉它会重新比一次（不会重复下载）。\n",
                old.display()
            );
            if let Err(e) = std::fs::create_dir_all(&versions_dest) {
                say!("[IEML/paths] 写合并记号前建目录失败（下次启动会再比一遍）：{e}");
            } else if let Err(e) = std::fs::write(&legacy_marker, note) {
                say!("[IEML/paths] 写合并记号失败（下次启动会再比一遍）：{e}");
            }
        }
    }

    /*
     * ★★ 游戏文件这一项：**按目标根目录当前的布局决定往哪儿放**。
     *
     *   0.1.0-beta.3 实测踩到的真 bug（教训写在这里）：
     *   一开始这里写的是死映射 `old/shared → new/.minecraft`。结果某次启动时，
     *   目标根目录**自己还停在老布局**（`new/shared` 在、`new/.minecraft` 不在），
     *   于是这一步把几个月前留在 C 盘的老数据复制进了 `new/.minecraft/` ——
     *   凭空造出一个"新布局"目录，而真正的数据还在 `new/shared/` 里。
     *   之后布局迁移看到 `.minecraft` 已有内容就按规矩跳过（它不能猜）——
     *   用户下次打开就会觉得"我的版本都不见了"。
     *
     *   判据改成"看目标现在是什么布局"：
     *     · 目标已有 `.minecraft`（或根本没有 `shared`）→ 新布局 → 放进 `.minecraft`
     *     · 目标还有 `shared`                        → 老布局 → 放进 `shared`
     *   两边都试一遍源（老根的 `shared` 与新根的 `.minecraft`），因为源根自己
     *   也可能已经是新布局。
     */
    let dest_name = if new.join(GAME_DIR_NAME).exists() || !new.join(LEGACY_SHARED_NAME).exists() {
        GAME_DIR_NAME
    } else {
        LEGACY_SHARED_NAME
    };
    for from_name in [LEGACY_SHARED_NAME, GAME_DIR_NAME] {
        let from = old.join(from_name);
        if from.is_dir() {
            copied += copy_tree(&from, &new.join(dest_name))?;
        }
    }

    for name in ["instances.json", "prefs.json"] {
        let from = old.join(name);
        if !from.is_file() {
            continue;
        }
        let to = new.join(name);
        if should_take_record(&from, &to)? {
            if let Some(p) = to.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&from, &to)?;
            copied += std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
        }
    }

    /*
     * ★★★★ 2026-09-30：**提平必须放在最后一步**。
     *
     *   上面那次"游戏文件整树复制"（`copy_tree`，`old/.minecraft → new/.minecraft`）
     *   会把老根里 `versions/<名字>/game/` 那一层**照原样又铺一遍** ——
     *   于是在它之前做的提平等于白做（真机上试过：提完又被铺回来，
     *   最后 `new/.minecraft/versions/s1/` 里还是套着一层 `game/`，
     *   而游戏直接读版本目录 → 用户看到"版本在、存档没了"）。
     *
     *   所以顺序是：**所有复制做完 → 最后统一提平**。
     *   与启动时的 `instance_catalog_repair` 共用同一个实现
     *   （`flatten_legacy_game_dirs`），只有一份判据；而且它是幂等的，
     *   启动时再跑一遍也只是确认无事可做。
     */
    let flattened_after_copy = flatten_legacy_game_dirs(&versions_dest);
    if !flattened_after_copy.is_empty() {
        say!(
            "[IEML/paths] 搬家后把 {} 个版本的 game/ 提到了版本目录（{}）",
            flattened_after_copy.len(),
            flattened_after_copy.join(" / ")
        );
    }
    Ok(copied)
}

/// 目标上的那份记录要不要用源那份替换？
///
/// 判据只有一条：**目标不存在，或者目标是个"空壳"而源里有东西**。
/// 其余情况一律**不动目标** —— 目标上的记录是用户当下正在用的那份。
fn should_take_record(from: &Path, to: &Path) -> std::io::Result<bool> {
    if !to.is_file() {
        return Ok(true);
    }
    let dst = std::fs::read_to_string(to).unwrap_or_default();
    let src = std::fs::read_to_string(from).unwrap_or_default();

    // 只在 **数组元素个数** 上比较，不看别的字段 —— 判据越窄越安全。
    let count = |t: &str| -> Option<usize> {
        let v: serde_json::Value = serde_json::from_str(t).ok()?;
        v.get("instances")?.as_array().map(|a| a.len())
    };
    match (count(&dst), count(&src)) {
        // 目标 0 条、源有人 → 这几乎一定是被写坏了，补回来
        (Some(0), Some(n)) if n > 0 => Ok(true),
        _ => Ok(false),
    }
}

/// ★★ 启动时把**老位置**（游戏根目录）里的启动器文件"收养"到 `own_root`（A-4 修复）。
///
/// 管这四个：`instances.json`、`prefs.json`、`ms_client_id.txt`、`cf_api_key.txt`。
///
/// ## 三条规矩（与 `migrate_data_root` 一致）
///
///   ① **只复制、绝不删源** —— 用户随时可能退回旧版启动器，那份还在原地；
///   ② 目标已有、而且**不比源旧** → 一个字节都不动（目标那份才是"现在正在用的"）；
///   ③ 真要覆盖目标之前，先把目标备份成 `<名字>.bak` —— 万一判断错了，东西还在。
///
/// ## 为什么判据里必须有"源比目标新"这一条
///
///   这是在本机真机上量出来的：`D:\IEML\instances.json`（游戏根目录那份）
///   是**应用一直在写**的那份，而 `%APPDATA%\IEML\instances.json` 是
///   2026-09-13 的**陈旧副本**（连主题都还停在 dark）。
///   若只按"目标存在就跳过"，用户最近十天的改动会被那份陈旧副本永远盖住 ——
///   那正是 A-4 里"两处各有一份、谁看谁糊涂"的坑（我自己就据它误判过一次）。
///
/// 返回复制了多少字节（0 = 什么都不需要做）。
pub fn adopt_records(paths: &AppPaths) -> u64 {
    // 老位置 = 游戏根目录（0.1.0-rc.1 及以前那四个文件就住在那里）
    adopt_records_from(&paths.root.clone(), paths)
}

/// [`adopt_records`] 的通用形式：账本四件从**任意一个老位置**收养过来。
///
///   两个调用方、一套判据（这条规矩只允许有一份实现）：
///     · `adopt_records` —— 游戏根目录（A-4 的老位置）
///     · `migrate_own_root` —— 启动器自己的家的老位置（`%APPDATA%\IEML`，C 的搬迁）
fn adopt_records_from(from_dir: &Path, paths: &AppPaths) -> u64 {
    const NAMES: [&str; 4] = [
        "instances.json",
        "prefs.json",
        "ms_client_id.txt",
        "cf_api_key.txt",
    ];
    let mut copied = 0u64;
    for name in NAMES {
        let from = from_dir.join(name);
        if !from.is_file() {
            continue;
        }
        let to = paths.own_file(name);
        if !should_adopt(&from, &to) {
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&paths.own_root) {
            say!(
                "[IEML/records] 建不了启动器数据目录（{}）：{e}",
                paths.own_root.display()
            );
            continue;
        }
        if to.is_file() {
            let bak = paths.own_root.join(format!("{name}.bak"));
            let _ = std::fs::copy(&to, &bak);
            say!("[IEML/records] 覆盖前把目标那份备份到 {}", bak.display());
        }
        match std::fs::copy(&from, &to) {
            Ok(n) => {
                copied += n;
                say!(
                    "[IEML/records] {name} 复制到启动器自己的目录（{n} 字节）—— 游戏根目录那份保留不动"
                );
            }
            Err(e) => say!("[IEML/records] 复制 {name} 失败：{e}"),
        }
    }
    copied
}

/// 目标那份要不要用源那份替换？（[`adopt_records`] 的判据）
fn should_adopt(from: &Path, to: &Path) -> bool {
    if !to.is_file() {
        return true; // 目标没有 → 直接补
    }
    // 目标是个"空壳"而源里有东西 → 补（沿用 should_take_record 的老规矩）
    if matches!(should_take_record(from, to), Ok(true)) {
        return true;
    }
    /*
     * ★ 源比目标新 → 源才是"当前在用的那份"（见 `adopt_records` 的说明）。
     *
     * ★ 2026-09-24（清理合并）：这里原本把 mtime 比较**又写了一遍** ——
     *   与 `is_newer` 是同一个判据的两份实现。"哪个更新"这件事只允许有一个来源，
     *   否则迟早两处对同一个文件给出不同答案。
     */
    is_newer(from, to)
}

/// ★★ 2026-09-24：把**游戏根目录里的启动器目录**收养到 `own_root`。
///
/// 管这三个：`java`、`cache`、`logs`。
///
/// ## 为什么需要它
///
///   0.1.0-beta 时代的启动器把它们建在游戏根目录里（`<root>/java` 之类），
///   而 2026-09-23 之后启动器**只读 `own_root` 下那一份** ——
///   老用户升级上来会看到"我下好的 Java 不见了"（要走一遍重新下载 ~200 MB）。
///   这里在启动时把缺的补过去；顺带也是 `migrate_data_root` 的反方向：
///   搬家只搬游戏数据，启动器自己的东西**从游戏盘收回系统盘的家**。
///
/// ## 三条规矩（与 `adopt_records` / `migrate_data_root` 一致）
///
///   ① 只复制、绝不删源（游戏根目录那份留着，用户想回退旧版还能用）；
///   ② 目标已有的文件一个字节都不动（`copy_tree` 的语义）；
///   ③ 源就是 `own_root` 自己时直接跳过 —— 否则等于自己复制自己。
///
/// 返回复制了多少字节（0 = 什么都不需要做）。
pub fn adopt_own_dirs(paths: &AppPaths, legacy_root: &Path) -> u64 {
    if same_path(legacy_root, &paths.own_root) {
        return 0;
    }
    let mut copied = 0u64;
    for name in ["java", "cache", "logs"] {
        let from = legacy_root.join(name);
        if !from.is_dir() {
            continue;
        }
        match copy_tree(&from, &paths.own_root.join(name)) {
            Ok(0) => {}
            Ok(n) => {
                copied += n;
                say!(
                    "[IEML/paths] 把游戏根目录里的 {name} 收养到启动器目录（{n} 字节）—— 源那份保留不动"
                );
            }
            Err(e) => say!("[IEML/paths] 收养 {name} 失败：{e}"),
        }
    }
    copied
}

/// 路径的规范化形式 —— **只用于比较，不碰磁盘**。
///
///   分隔符统一成 `\`、去掉结尾的分隔符、Windows 上不分大小写。
///   `D:\IEML`、`d:/ieml/`、`D:\IEML\\` 都归到同一个值。
///
/// ★ 抽出来的理由：`validate_data_root` 里原来有一份一模一样的闭包，
///   而"这两个目录是不是同一处"在收养老目录时又要用一次 ——
///   路径比较只允许有一个来源，否则两处会对 `D:\IEML` 与 `d:\ieml\`
///   给出不同答案。
fn norm_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    #[cfg(windows)]
    let s = s.to_lowercase();
    PathBuf::from(s)
}

/// 递归复制：**目标已有的文件一个字节都不动**，缺什么补什么。
/// 为什么不是"目标存在就整体跳过"：那样目标上任何一处损坏
/// （例如被写空的 `instances.json`）都永远修不回来。见
/// `migrate_data_root` 的说明 —— 这是实测丢过用户数据之后改的。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<u64> {
    copy_tree_rule(from, to, false)
}

/// ★★ 2026-09-24：**实例目录**的跨根补齐 —— 与 `copy_tree` 只差一条：
/// 同名文件**按 mtime 判胜负**（源更新就赢；覆盖前把目标那份备份成 `.ieml-bak`）。
///
/// ## 为什么只有实例目录需要这条
///
///   `.minecraft` 里是库 / jar / 资源包这些**内容由版本决定**的东西，mtime 没有意义
///   （重新下载就会变），所以那边继续用"目标已有就跳过"最安全。
///   而实例目录里装的是**用户自己会改的东西**：`options.txt` 的游戏内设置、
///   `config/`、`mods/`、存档。
///
///   真机上量到的实例（`fabric-262`，2026-09-24）：
///     · 老位置（`%APPDATA%\IEML\instances`）那份 `options.txt` = **当天 14:01 玩的**
///       （`lang:zh_cn`、`renderDistance:12`、音乐音量 0.0）
///     · 游戏根（`D:\IEML\instances`）那份 = 09-12 的
///       （`lang:en_us`、`renderDistance:16`、音乐音量 1.0）
///   只按"目标存在就跳过"的话，用户换回游戏盘之后**今天的设置会被 12 天前的盖掉** ——
///   而且他会以为是自己记错了。判据改成 mtime 之后，赢的是"最后一次真正玩过"的那份。
///
///   ★ 与 `adopt_records` 是同一条规矩（源更新 → 源赢），只是这里多一层备份：
///     覆盖前把目标那份存成 `<文件名>.ieml-bak`（游戏/加载器都不认这个后缀，
///     不会被当成 Mod 或存档读进去），万一判错了东西还在。
///
/// ## 为什么不会每次启动都来回覆盖
///
///   `std::fs::copy` 会把源的 mtime 一起带过去（Windows 上是 `CopyFileEx`），
///   加上这里是**严格大于**才覆盖 —— 复制过一次之后两边 mtime 相等，
///   下一次启动就什么都不做了。
fn merge_instances_by_mtime(from: &Path, to: &Path) -> std::io::Result<u64> {
    /*
     * ★★★★ 2026-09-30（用户）：「**删掉启动器的版本，资源管理器里的文件夹不会删除**」
     *   以及「删除版本后，重启启动器，删除的版本又会回来」。
     *
     *   这一段就是"又回来"在**文件系统层面**的成因：这一步按 mtime 把老 `instances/`
     *   里的东西搬进 `versions/` —— 而它**不认墓碑**。用户删掉一个版本之后，
     *   只要老目录里还有那份，重启就会把**目录本身**搬回来
     *   （记录会被墓碑滤掉，所以界面上的名字没了，可目录又冒出来了 ——
     *    真机上 `26.3-fabric-0.19.5-2` / `-3` 就是这么在 20:09 / 20:10 复活的）。
     *
     *   ⇒ 顶层目录按墓碑过滤：**用户删过的版本名，一个字节都不搬**。
     *     这与 `instance_catalog_repair` 的补认、`list_instances` 的读取
     *     用的是同一个墓碑集合 —— 四处对齐，缺陷才不会从没堵的那处回来。
     */
    let buried = buried_version_dirs();
    copy_tree_rule_skip(from, to, true, &buried, 0)
}

/// 读墓碑（`prefs.json` 的 `deletedVersions`），全部转小写。
///
///   ★ 大小写无关：Windows 上 `Fabric-1` 与 `fabric-1` 是同一个目录。
///   ★ 读不到就是空集（**不是错误**）：没有墓碑时一切照旧。
pub(crate) fn buried_version_dirs() -> std::collections::HashSet<String> {
    AppPaths::resolve()
        .own_json("prefs.json")
        .and_then(|p| {
            p.get("deletedVersions")?
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.to_lowercase())
                        .collect()
                })
        })
        .unwrap_or_default()
}

/* ======================================================================
 * 版本目录规范化：老布局 → PCL 布局（2026-09-30）
 * ====================================================================== */

/// 一次迁移/归置**做了什么**（给日志与测试看，不直接给界面）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CatalogRepair {
    /// 被改名成规范目录名的版本目录：`(旧名, 新名)`
    pub renamed: Vec<(String, String)>,
    /// 从 `<旧名>/game/` 提到版本目录本身的版本
    pub flattened: Vec<String>,
    /// 账本里指向**已不存在的目录**、因而被删掉的记录（`config.name`）
    pub dropped: Vec<String>,
    /// 账本里 slug 与磁盘目录名对不上、已改正的 `(旧 slug, 新 slug)`
    pub reslugged: Vec<(String, String)>,
    /// 磁盘上有目录、账本里却没有 → 补进来的（`config.name`）
    pub adopted: Vec<String>,
    /// 被标成**基座**的版本目录（"原版作为基座，不是独立版本"，2026-10-08）
    pub marked_base: Vec<String>,
    /**
     * ★★★★ 被**撤掉**基座记号的版本目录（2026-10-12）。
     *
     *   为什么会有撤：过去只凭"账本记录是启动器捡回来的"就判基座，
     *   把用户自己玩了几天的原版实例也标了（真机现场：`versions/26.3/`）。
     *   现在的判据里多了一条直接证据 —— 目录里有游戏写下的 `options.txt`
     *   （见 `version_dir_was_played`）⇒ 那是用户在用的版本，不是基座。
     */
    pub cleared_base: Vec<String>,
    /// 老 `<root>/instances/` 整个并进 `versions/` 时复制了多少字节
    pub merged_bytes: u64,
}

impl CatalogRepair {
    pub fn is_empty(&self) -> bool {
        self.renamed.is_empty()
            && self.flattened.is_empty()
            && self.dropped.is_empty()
            && self.reslugged.is_empty()
            && self.adopted.is_empty()
            && self.marked_base.is_empty()
            && self.cleared_base.is_empty()
            && self.merged_bytes == 0
    }

    /// 一句话摘要（写日志用；空的时候给 `None`）
    pub fn summary(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        if self.merged_bytes > 0 {
            parts.push(format!("并入老实例目录 {} 字节", self.merged_bytes));
        }
        if !self.renamed.is_empty() {
            parts.push(format!("规范了 {} 个目录名", self.renamed.len()));
        }
        if !self.flattened.is_empty() {
            parts.push(format!("把 {} 个版本的 game/ 提上来", self.flattened.len()));
        }
        if !self.reslugged.is_empty() {
            parts.push(format!("改正了 {} 条账本 slug", self.reslugged.len()));
        }
        if !self.adopted.is_empty() {
            parts.push(format!("补认了 {} 个版本", self.adopted.len()));
        }
        if !self.marked_base.is_empty() {
            parts.push(format!("认出 {} 个原版基座", self.marked_base.len()));
        }
        if !self.dropped.is_empty() {
            parts.push(format!("清掉 {} 条指向空目录的记录", self.dropped.len()));
        }
        Some(parts.join("；"))
    }
}

/// 版本目录里**启动器自己的那层**（`.ieml/`）与它的备份后缀。
///
/// ★ 迁移时要跳过它们：`.ieml/` 是启动器的东西（natives / 打包记录），
///   不该被"把 game/ 提上来"或整合包导出当成游戏数据；
///   `.ieml-bak` 是 `merge_instances_by_mtime` 覆盖前留下的备份，
///   更不该被当成游戏文件搬来搬去。
pub fn is_launcher_owned(name: &str) -> bool {
    name == LAUNCHER_SUBDIR || name.ends_with(".ieml-bak")
}

/// 一个版本目录的**规范名字**该叫什么。
///
/// ## 两条判据，顺序要紧（2026-09-30 真数据彩排改对了）
///
///   ① **目录名自己能不能反解出 MC 版本**（`parse_dir_name`）——
///      能就**以目录名为准**，只在它已经等于规范名（或等于规范名 + `-数字`
///      去重后缀）时返回 `None`（= 不需要改名）。
///   ② 反解不出来（`fabric-loader-0.19.5-26.3` 这种 PCL 写法虽然现在能认了，
///      但更早的 `vanilla-262` 之类认不出）才**去读版本 JSON 的
///      `inheritsFrom`**，用"JSON 给的 MC 版本 + 目录名给的加载器"拼出规范名。
///
/// ★★ 为什么不能一律以 JSON 为准（第一版就是这么写的，结果**每次启动都改名**）：
///
///   改完名之后，目录里的 JSON 仍然叫**旧 id**（`fabric-loader-0.19.5-26.3`）。
///   下一轮启动再读它 ⇒ 算出来还是 `26.3-fabric-0.19.5`，而目录已经叫
///   `26.3-fabric-0.19.5-3`（去重后缀）⇒ 判成"要改名" ⇒ 又改一次。
///   真机后果：**每次启动目录名都在变**，账本跟着重写，备份越堆越多。
///
///   目录名才是"这个名字是谁定的"的答案；JSON 只在名字给不出 MC 版本时帮忙。
fn canonical_dir_name_for(dir: &Path, dir_name: &str) -> Option<String> {
    use crate::domain::naming::{parse_dir_name, version_dir_name, VersionParts};

    // 目录名是规范名（或规范名 + `-N`）时，什么都不用做
    let is_canonical_or_dup = |candidate: &str| -> bool {
        if candidate == dir_name {
            return true;
        }
        match dir_name.rsplit_once('-') {
            Some((head, tail)) => head == candidate && tail.chars().all(|c| c.is_ascii_digit()),
            None => false,
        }
    };

    // ---------- ① 目录名反解 ----------
    if let Some(parts) = parse_dir_name(dir_name) {
        if let Some(canonical) = version_dir_name(&parts) {
            if is_canonical_or_dup(&canonical) {
                return None; // 已经是规范名（或它的去重后缀）
            }
            return Some(canonical);
        }
    }

    // ---------- ② 读版本 JSON 拿 MC 版本（名字给不出来时才走这里） ----------
    let primary = dir.join(format!("{dir_name}.json"));
    let json_path = if primary.is_file() {
        Some(primary)
    } else {
        std::fs::read_dir(dir).ok().and_then(|it| {
            it.flatten()
                .map(|f| f.path())
                .find(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        })
    };
    let text = json_path.and_then(|p| std::fs::read_to_string(p).ok())?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let inherits = v.get("inheritsFrom").and_then(|x| x.as_str()).unwrap_or("");
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let mc_version = if !inherits.is_empty() {
        inherits.to_string()
    } else if !id.is_empty() {
        id.to_string()
    } else {
        return None;
    };
    /*
     * 加载器那一段：从 `id`（权威）或目录名里扫。两者都扫不出来就当原版
     * —— 那也是一种可能的真相（`vanilla-262` 那种老 slug 就是这么来的），
     * 但**只在 JSON 确实给了 MC 版本时**才这么认。
     */
    let loader = parse_dir_name(id)
        .or_else(|| parse_dir_name(dir_name))
        .and_then(|p| p.loader);
    let parts = VersionParts {
        mc_version,
        loader,
        addons: Vec::new(),
    };
    let canonical = version_dir_name(&parts)?;
    if is_canonical_or_dup(&canonical) {
        return None;
    }
    Some(canonical)
}

/// 老布局的实例目录里，那层 `game/` 是不是该被提上来。
///
/// 判据只有两条：
///   · `<dir>/game/` 是个目录；
///   · 它**不是空的**（空壳不值得为它动目录）。
///
/// ★★ 为什么不再要求"版本目录那一层没有游戏数据"（2026-09-30 修正）：
///
///   原来还加了一条"版本目录那一层没有 `saves`/`mods`/`config`/`options.txt`
///   才算老布局"，本意是"别把两代数据混进一层"。但跨根补齐是
///   **逐文件** 比 mtime 的（`merge_instances_by_mtime`），它会把老布局里的
///   `game/options.txt` 与 `versions/s1/` 那一层的同名文件直接对比 ——
///   于是那一层**已经**长出了 `options.txt` 之类的文件，修正后的判据就
///   反过来把提层挡掉了。真机后果：搬完家之后存档还在 `game/` 里，
///   而游戏现在直接读版本目录 → 用户看到"版本在、存档没了"。
///
///   ⇒ 判据放回"有没有东西"，混合的情形交给 [`promote_legacy_game_subdir`]
///     用 mtime 判胜负（这也是它本来就在做的事）。
fn has_legacy_game_subdir(dir: &Path) -> bool {
    let inner = dir.join("game");
    inner.is_dir()
        && std::fs::read_dir(&inner)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
}

/// 把 `<dir>/game/` 里的东西提到 `<dir>/`，同名文件**按 mtime 判胜负**
/// （老的 `game/` 那份 vs 版本目录那一层已有的那份）。
///
/// ## 为什么写成一趟平面遍历，而不是复用 `copy_tree_rule`
///
///   第一版直接 `copy_tree_rule(&dir/game, dir, newer_wins=true)` 递归复制。
///   它**能跑**，但有一个很难看出来、也确实在真机上咬过人的后果：
///   覆盖前留下的备份（`<名字>.ieml-bak`）落在**目标目录**里；当目标就是
///   版本目录那一层时没问题，而当"目标文件"本身还在 `game/` 里时，
///   备份就落进 `game/`，于是那层空壳永远不空、永远删不掉 ——
///   用户看到的还是"多一层 game/"。
///
///   ⇒ 改成"**只遍历 `game/` 顶层的每一项**"：目录用 `rename` 整体搬
///     （同盘、瞬间完成、不留副本），文件按 mtime 判（要覆盖就先留备份，
///     备份放在**版本目录那一层**）。这样 `game/` 遍历完必然为空，也就
///     必然能删掉。
///
/// ★ 只搬顶层、不做递归合并：`game/` 里面是 `saves/` `mods/` `config/`
///   这类游戏目录，整块搬过去才是对的（递归进 `saves/<世界>/` 逐文件比
///   mtime 既慢又没有意义）。
fn promote_legacy_game_subdir(dir: &Path) -> std::io::Result<u64> {
    let inner = dir.join("game");
    let mut bytes = 0u64;
    for e in std::fs::read_dir(&inner)?.flatten() {
        let src = e.path();
        let dst = dir.join(e.file_name());
        let meta = e.metadata()?;
        if meta.is_dir() {
            if !dst.exists() {
                // 整体搬走：同盘 rename，瞬间完成
                let n = dir_size(&src);
                if std::fs::rename(&src, &dst).is_ok() {
                    bytes += n;
                    continue;
                }
            }
            // 对面已经有同名的（比如两边都有 logs/）→ 逐文件按 mtime 合并
            bytes += copy_tree_rule(&src, &dst, true)?;
            let _ = std::fs::remove_dir_all(&src);
        } else if meta.is_file() {
            if !dst.exists() || is_newer(&src, &dst) {
                if dst.is_file() {
                    // 覆盖前把目标那份留成备份（放在版本目录那一层，不进 game/）
                    let bak = backup_name(&dst);
                    if std::fs::copy(&dst, &bak).is_ok() {
                        say!(
                            "[IEML/catalog] 覆盖前把 {} 备份到 {}",
                            dst.display(),
                            bak.display()
                        );
                    }
                }
                std::fs::copy(&src, &dst)?;
                bytes += meta.len();
            }
            let _ = std::fs::remove_file(&src);
        }
    }
    // 收拾空壳
    let empty = std::fs::read_dir(&inner)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if empty {
        let _ = std::fs::remove_dir(&inner);
    } else {
        say!(
            "[IEML/catalog] {} 里还有没搬走的东西，保留这一层",
            inner.display()
        );
    }
    Ok(bytes)
}

/// 把 `versions/` 下每个版本目录里多套的那层 `game/` 提到版本目录本身。
///
/// 返回被提上来的版本目录名。**幂等**：提完之后 `game/` 那层就没了，
/// 再跑一遍什么都不会做。
///
/// ★ 两个调用方共用这一份实现（只有一份判据）：
///   · [`instance_catalog_repair`] —— 启动时的布局归置；
///   · [`migrate_data_root`] —— 跨数据根搬家（老根整树复制过来之后，
///     里面那些版本还是老布局）。
fn flatten_legacy_game_dirs(versions_root: &Path) -> Vec<String> {
    let mut flattened = Vec::new();
    let Ok(entries) = std::fs::read_dir(versions_root) else {
        return flattened;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let dir = e.path();
        if !has_legacy_game_subdir(&dir) {
            continue;
        }
        match promote_legacy_game_subdir(&dir) {
            /*
             * ★★ 只有**真的搬了东西**才算一次提平（2026-09-30 真数据彩排逼出来的）。
             *
             *   `copy_tree_rule` 现在不造空目录了，所以合并那一步可能在源那边
             *   留下一个**空的 `game/`**（真机复现：`<old>/instances/s1/game/` 空着）。
             *   下一轮启动看到"有个 game/"，就去提平它 —— 里面什么都没有，
             *   提平"成功"但一个字节都没动。如果照旧记一笔，
             *   **每次启动都会报告"把 1 个版本提平了"**，幂等性从报告上就说不清了。
             *
             *   ⇒ 判据是"搬出来的字节数 > 0"（`remove_dir` 掉空壳不算工作）。
             */
            Ok(moved) => {
                if moved > 0 {
                    say!("[IEML/catalog] {name}：把 game/ 里的存档与配置提到了版本目录");
                    flattened.push(name);
                }
            }
            Err(err) => say!("[IEML/catalog] {name}：提升 game/ 失败：{err}"),
        }
    }
    flattened
}

/// ★★ **版本目录规范化总入口** —— 每次启动跑一次（幂等）。
///
/// 做五件事，顺序有意：
///
///   ① **把老 `<root>/instances/` 并进 `<root>/.minecraft/versions/`** ——
///      布局升级（老用户的存档与 Mod 在这里）；
///   ② **把每个版本的 `game/` 提上来** —— 老布局把游戏数据多套了一层；
///   ③ **把目录名改成 ADR-055 的规范名** —— `fabric-loader-0.19.5-26.3`
///      → `26.3-fabric-0.19.5`（优先按 JSON 里的 `inheritsFrom` 认）；
///   ④ **按磁盘对齐账本**：目录没了的记录删掉、slug 与目录名对不上的改正、
///      磁盘上有目录而账本没记录的补一条；
///   ⑤ 给每个版本写一份**身份小抄**（`<版本目录>/.ieml/instance.json`）。
///
/// ## 为什么第 ④ 步是这次修复的核心
///
///   真机上"删掉的实例又回来了"有两个成因，都源于**账本被当成实例存在的证据**：
///   · 一份陈旧的账本副本（老位置 / 别的数据根）把删掉的记录盖了回来
///     （`should_take_record` 只看"目标是不是空列表"，不看"这个目录还在不在"）；
///   · 前端"账本是空的、而文件夹里有版本 → 自动认领一个"（`pickAutoAdopt`）。
///
///   现在**以磁盘为准**：目录没了，记录就没有存在的理由（ADV：这与当年
///   那次"把所有实例都滤掉"的事故不同 —— 那次是拿**拼出来的**目录名去判，
///   而这里判的是**账本里 slug 对应的真实目录**；而且读不到目录列表时
///   一律**不动账本**，绝不把"读不到"当成"没有"）。
///
/// ## 幂等与安全
///
///   · 全部判据都是"读盘 + 比较"，跑第二遍什么都不做；
///   · 改名/删除**只发生在 `versions/` 与账本里**，不碰 `libraries`/`assets`；
///   · 账本改动前先写 `.bak`（与 `adopt_records` 同一条纪律）。
/// 一个版本目录里的**所有** `.json` 文件。
///
/// ★★★★ 2026-10-16（用户：「启动器会把整合包的基座版本识别成独立运行版本」）。
///
///   以前目录扫描假定"版本描述的文件名 = 目录名"（`versions/<目录>/<目录>.json`）。
///   **整合包实例不遵守这个约定**：实测 `versions/pack-al3zun/` 里那份版本 JSON 叫
///   `1.20.1-fabric-0.19.3.json`（按它**继承的版本**命名），于是扫描读不到它 ⇒
///   `inheritsFrom` 丢了 ⇒ 「被继承的版本 ⇒ 标基座」那条规则不触发 ⇒
///   加载器基座 `1.20.1-fabric-0.19.3` 被列成一个独立可启动版本
///   （原版基座 `1.20.1` 是装加载器时显式标的，所以它一直正常 —— 两条路不一致
///   正是这个 bug 的形状）。
///
///   ⇒ 判据改成"目录里有哪些 JSON，内容自己说了算"：读进来之后一律用
///     `inheritsFrom` / `id` 这些**字段**认关系，不靠文件名猜。
fn version_json_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .map(|x| x.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
        })
        .collect()
}

pub fn instance_catalog_repair(paths: &AppPaths) -> CatalogRepair {
    let mut report = CatalogRepair::default();

    // ---------- ① 老 `<root>/instances/` 并进 `versions/` ----------
    let legacy = paths.legacy_instances_dir();
    /*
     * ★★ 这一步**只做一次**，做完留一个记号（2026-09-30 真数据彩排逼出来的）。
     *
     *   为什么不能每次启动都比一遍：`merge_instances_by_mtime` 是**双向**语义的
     *   （逐文件按 mtime 判胜负），而"老 `instances/` 并进版本目录"是**单向**
     *   的一次性布局迁移。每次启动都跑，它就会一直把源那边还留着的文件
     *   重新比一遍、重新复制一遍（真机彩排里每轮稳定复制 85 字节）——
     *   幂等性从报告上就说不清（`merged_bytes` 永远非 0）。
     *
     *   ★ 记号写在**新布局**那一侧（`versions/.instances-merged`），内容是
     *     一串字节的说明。它不会与任何版本目录重名（点号开头）。
     *     记号**只在复制成功之后**写 —— 中途失败的话下次启动还会重试。
     */
    /*
     * ★★ 2026-09-30（用户截图）：**标记的"写"与"读"必须在同一侧**。
     *
     *   真机上量到的事故：这里读的是 `paths.instances.join(MARKER)`
     *   （= `.minecraft/versions/.instances-merged`），可用户截图里那个
     *   `.instances-merged` **躺在 `D:\IEML\instances\` 里** ——
     *   也就是说两边各有一份、而**旧目录被整个搬走/清掉时那一侧就没了**，
     *   于是"只做一次"的合并又跑了一遍，把已删除的版本目录搬了回来。
     *
     *   ⇒ 判据改成**看两处**：任一侧有标记就算做过。
     *     写入时**两侧都写**（旧目录那一侧写不进去不算错 —— 它可能已经不存在了）。
     */
    let marker_new = paths.instances.join(LEGACY_MERGED_MARKER);
    let marker_old = legacy.join(LEGACY_MERGED_MARKER);
    let already_merged = marker_new.is_file() || marker_old.is_file();
    if legacy.is_dir() && !already_merged {
        match merge_instances_by_mtime(&legacy, &paths.instances) {
            Ok(n) => {
                report.merged_bytes = n;
                say!(
                    "[IEML/catalog] 老实例目录并入版本目录：{} → {}（{n} 字节，源保留不动）",
                    legacy.display(),
                    paths.instances.display()
                );
                let note = format!(
                    "旧的 instances/ 已并入这里（{} -> {}）。\n\
                     这个文件只是个记号：有它就不会再重复比对一遍。删掉它会重新比对一次（不会重复下载）。\n",
                    legacy.display(),
                    paths.instances.display()
                );
                if let Err(e) = std::fs::write(&marker_new, &note) {
                    say!("[IEML/catalog] 写合并记号失败（下次启动会再比一遍）：{e}");
                }
                /*
                 * ★ 旧目录那一侧也写一份。写不进去**不算错**：
                 *   它可能是只读的、或者用户刚好把它清掉了 —— 那种情况下
                 *   下一次 `legacy.is_dir()` 就已经是 false，这一步本来也不会再跑。
                 */
                let _ = std::fs::write(&marker_old, &note);
            }
            Err(e) => say!("[IEML/catalog] 并入老实例目录失败：{e}"),
        }
    }
    /*
     * ★★ 一并把"旧目录已经没用了"这件事**明说给用户**（用户：
     *   「资源管理器里的文件夹不会删除，这个目录结构太奇怪了」）。
     *
     *   我们不擅自删（那里面有他自己的存档，删错了不可逆），
     *   但**必须告诉他这个目录是什么、可以删** —— 否则他会一直看到两份，
     *   而且永远不知道哪份是活的。
     */
    if legacy.is_dir() && already_merged {
        say!(
            "[IEML/catalog] 旧的 {} 还在（里面只是当年那份的副本，内容是死的）。\
             新版数据在 {} —— 确认不再需要回退到旧版之后，这个目录可以整个删掉。",
            legacy.display(),
            paths.instances.display()
        );
    }
    if std::env::var_os("IEML_DEBUG_TREE").is_some() {
        for (tag, root) in [("A-old", &legacy), ("A-new", &paths.instances)] {
            let mut t = Vec::new();
            walk_dir(root, 0, &mut t);
            say!("[IEML/debug] {tag} = {}\n{}", root.display(), t.join("\n"));
        }
    }

    // ---------- ② 把 `game/` 提上来（每个版本目录） ----------
    if !paths.instances.is_dir() {
        // ★ 读不到版本目录 ⇒ **什么都不做**。读不到 ≠ 没有。
        return report;
    }
    report.flattened = flatten_legacy_game_dirs(&paths.instances);

    // ---------- ③ 目录名规范化 ----------
    /*
     * 先把"谁已经占了名字"收集起来（大小写无关），避免改成别人的名字。
     *
     * ★★ 但**正在被改名的那些名字不算被占**（2026-09-30 真数据彩排暴露的缺陷）。
     *
     *   第一版把 `taken` 初始化成**当前所有目录名**，于是：
     *     `26.3-fabric-0.19.5-2` 想规范成 `26.3-fabric-0.19.5-2`（已经是对的），
     *     而 `taken` 里还有它自己那份旧名单 ⇒ 被判成"撞名" ⇒ 改成 `…-2-2`。
     *   真机后果是**每次启动都再改一次名**（幂等性没了），目录名越来越长，
     *   而账本每轮都要跟着重写。
     *
     *   ⇒ 先算出"哪些名字会被腾出来"（源名里那些**确实要改名**的），
     *     再从占用集合里去掉它们。
     */
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&paths.instances) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                names.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    // 预扫描：谁会被改成别的名字（于是它的旧名会被腾出来）
    let mut vacated: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &names {
        let dir = paths.instances.join(name);
        if let Some(want) = canonical_dir_name_for(&dir, name) {
            if want != *name {
                vacated.insert(name.to_lowercase());
            }
        }
    }
    let mut taken: Vec<String> = names
        .iter()
        .filter(|n| !vacated.contains(&n.to_lowercase()))
        .cloned()
        .collect();
    for name in names.clone() {
        let dir = paths.instances.join(&name);
        let Some(want) = canonical_dir_name_for(&dir, &name) else {
            continue;
        };
        if want == name {
            continue;
        }
        let others: Vec<&str> = taken
            .iter()
            .filter(|t| t.as_str() != name.as_str())
            .map(|s| s.as_str())
            .collect();
        let unique = crate::domain::naming::unique_dir_name(&want, others);
        let dst = paths.instances.join(&unique);
        match std::fs::rename(&dir, &dst) {
            Ok(_) => {
                say!("[IEML/catalog] 目录改名：{name} → {unique}（ADR-055 规范名）");
                // ★ 版本 JSON 必须跟着改名：PCL（与 IEML 的 `scan_folder_versions`）
                //   都是按 `<目录名>.json` 找版本描述的。不改的话，
                //   `versions/<新名>/<旧名>.json` 就成了"目录里有个陌生的 json" ——
                //   启动时静默落回原版 JSON（主类还在、classpath 空），
                //   游戏报「找不到或无法加载主类」。这是这个仓库踩过的老坑。
                ensure_version_json_matches_dir(&dst, &unique, &name);
                share_version_json_with_siblings(&dst, &unique);
                report.renamed.push((name.clone(), unique.clone()));
                taken.retain(|t| t != &name);
                taken.push(unique);
            }
            Err(err) => {
                // 改名失败（被占用 / 权限）**不是致命错误**：保留原名，
                // 账本侧会按"目录名就是 slug"整条对齐。
                say!("[IEML/catalog] {name} 改名为 {unique} 失败：{err}（保留原名）");
            }
        }
    }

    // ---------- ④ 按磁盘对齐账本 ----------
    let disk_names: Vec<String> = std::fs::read_dir(&paths.instances)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_else(|_| names.clone());
    let disk_lower: std::collections::HashSet<String> =
        disk_names.iter().map(|s| s.to_lowercase()).collect();

    let ledger_path = paths.instances_file();
    if let Some(mut ledger) = paths.own_json("instances.json") {
        if let Some(list) = ledger.get("instances").and_then(|v| v.as_array()).cloned() {
            let mut kept: Vec<serde_json::Value> = Vec::new();
            let mut changed = false;
            for inst in list {
                let Some(slug) = inst
                    .get("config")
                    .and_then(|c| c.get("slug"))
                    .and_then(|s| s.as_str())
                    .map(String::from)
                else {
                    // 没有 slug 的记录无法定位目录 —— 保留（不许凭猜删）
                    kept.push(inst);
                    continue;
                };
                if disk_lower.contains(&slug.to_lowercase()) {
                    // 目录名与 slug 大小写不同 → 以磁盘为准改正
                    if let Some(real) = disk_names.iter().find(|d| d.to_lowercase() == slug.to_lowercase())
                    {
                        if real != &slug {
                            let mut fixed = inst.clone();
                            if let Some(cfg) =
                                fixed.get_mut("config").and_then(|c| c.as_object_mut())
                            {
                                cfg.insert(
                                    "slug".into(),
                                    serde_json::Value::String(real.clone()),
                                );
                            }
                            report.reslugged.push((slug.clone(), real.clone()));
                            changed = true;
                            kept.push(fixed);
                            continue;
                        }
                    }
                    kept.push(inst);
                } else {
                    // ★ 目录真的不在 → 记录没有存在的理由
                    let name = inst
                        .get("config")
                        .and_then(|c| c.get("name"))
                        .and_then(|s| s.as_str())
                        .unwrap_or(&slug)
                        .to_string();
                    say!(
                        "[IEML/catalog] 账本里的「{name}」（slug {slug}）在 {} 里没有对应目录 —— 清掉这条记录",
                        paths.instances.display()
                    );
                    report.dropped.push(name);
                    changed = true;
                }
            }

            /*
             * 补认：磁盘上有目录、账本里一条都没有 → 建一条最小记录。
             * ★ 只在**账本本来就不是空**或者**盘上确实有版本**时做，
             *   并且只补"有版本 JSON 的"目录（空壳目录不算版本）。
             *
             * ★★★★ 2026-09-30（用户）：「**删除版本后，重启启动器，
             *   删除的版本又会回来**」。
             *
             *   **这一段就是那个缺陷的根源之一**：它只判"账本里有没有"，
             *   不判"用户是不是删过它"。用户删掉一个版本时，如果那个版本目录
             *   还在盘上（删除只进回收站、或者用户自己把它放回来了），
             *   重启时这一步就会**把记录原样补回来** —— 界面上就是"又回来了"。
             *
             *   ⇒ 补认**必须认墓碑**（`prefs.json` 的 `deletedVersions`）：
             *     用户删过的目录名，永远不再自动补记录。
             *     这与前端 `pickAutoAdopt` / `VersionsPage` 的自动认领
             *     用的是**同一个集合** —— 三处任一处漏掉，这条缺陷就会从那一处回来。
             */
            let buried: std::collections::HashSet<String> = paths
                .own_json("prefs.json")
                .and_then(|p| {
                    p.get("deletedVersions")?
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str())
                                .map(|s| s.to_lowercase())
                                .collect()
                        })
                })
                .unwrap_or_default();
            let mut known: std::collections::HashSet<String> = kept
                .iter()
                .filter_map(|i| {
                    i.get("config")
                        .and_then(|c| c.get("slug"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_lowercase())
                })
                .collect();
            /*
             * ★★★★ 2026-10-08（用户）：「按理来说，**原版是作为基座的**，而不是单独的
             *   一个版本；只有真的只下载原版时，才是独立的版本」。
             *
             *   ## 补一次"基座"记号（给已经装好的老数据）
             *
             *   新的安装会在装的时候就写下 `.ieml/base.json`
             *   （见 `commands_real::build_plan_input`）。可用户盘上**已经**有
             *   这样的目录了（真机：`versions/26.3/` 就是"26.3 + Fabric"顺手装上的），
             *   它们没有记号，于是仍然会被列出来 —— 用户看到的还是两行。
             *
             *   ## 判据（四条都要成立，一条不成立就不标）
             *
             *     ① **有别的版本继承它**（同一层里某个目录的 `inheritsFrom` 指向它）
             *        —— 这才叫"基座"；
             *     ② 它的账本记录要么**没有**，要么是**启动器自己捡回来的**
             *        （`is_launcher_picked`：补认写的 `inst-disk-*`、或前端自动认领
             *        写的那种"名字 == 目录名"）—— 那两种都**不是"用户明确要过它"**；
             *        用户装的/建的记录（`inst-<base36>` + "Minecraft 26.3" 这种名字）
             *        ⇒ 它是**独立版本**，一个字节都不动；
             *     ③ **不在墓碑里** —— 用户删过的名字，别去给它写任何东西；
             *     ④ 它**自己有一份版本描述**（`<目录>.json`）—— 只有 jar 的目录
             *        本来就不是版本，不必给它记号。
             *
             *   ★ 只写记号、不碰别的文件：万一判据错了，用户看到的只是"少了一行"，
             *     jar / 描述 / 存档一个都不少，而且下一次"单独装原版"就会撤掉记号。
             */
            let mut flagged_base: Vec<String> = Vec::new();
            {
                /*
                 * ★★★★ 2026-10-16（用户：「**启动器会把整合包的基座版本识别成独立运行版本**」）。
                 *
                 *   病根就在下面这一行的**文件名假设**：原来读的是
                 *   `versions/<目录>/<目录>.json`。而整合包实例目录不遵守这个约定 ——
                 *   实测 `versions/pack-al3zun/` 里那份版本 JSON 叫
                 *   `1.20.1-fabric-0.19.3.json`（按它**继承的版本**命名），
                 *   于是这份 JSON 根本读不到 ⇒ `inheritsFrom` 丢了 ⇒
                 *   加载器版本 `1.20.1-fabric-0.19.3` 不被认成基座、被列成一个
                 *   独立可启动版本（原版基座 `1.20.1` 是另一条路标的，所以它正常）。
                 *
                 *   ⇒ 改成把一个目录里**所有**版本 JSON 都读进来（`version_json_files`），
                 *     收集它们声明的全部 `inheritsFrom`。
                 *   ★ 安全性：没有 `inheritsFrom` 的 JSON（options/manifest 之类）会被
                 *     下面的 `filter` 直接滤掉，不会造出假父子关系。
                 */
                let parents: std::collections::HashSet<String> = disk_names
                    .iter()
                    .flat_map(|d| {
                        version_json_files(&paths.instances.join(d))
                            .into_iter()
                            .filter_map(|p| {
                                let text = std::fs::read_to_string(p).ok()?;
                                let v: serde_json::Value = serde_json::from_str(&text).ok()?;
                                v.get("inheritsFrom")
                                    .and_then(|x| x.as_str())
                                    .filter(|s| !s.is_empty())
                                    .map(|s| s.to_lowercase())
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect();
                for dir_name in &disk_names {
                    let lower = dir_name.to_lowercase();
                    /*
                     * ★★★★ 2026-10-12（用户：「**启动器不认纯原版游戏了**」）：
                     *   **被玩过的目录不是基座。**
                     *
                     *   这一条必须放在最前面，而且**不管后面几条怎么判**都要走：
                     *   它既拦下"这次差点被标成基座"，也**撤掉过去误标的那一份**
                     *   （用户的 `versions/26.3/` 就是 10-12 被误标 + 记录被清掉的，
                     *    需要自动长回来，而不是等他再装一次原版）。
                     *
                     *   判据与理由见 `version_dir_was_played`：装加载器顺手装上的
                     *   基座**从来没被启动过**（没有 `options.txt`），
                     *   而用户真玩过的原版一定有它。
                     */
                    if paths.version_dir_was_played(dir_name) {
                        if paths.clear_base_marker(dir_name) {
                            say!(
                                "[IEML/catalog] 「{dir_name}」里有游戏留下的 options.txt \
                                 —— 它是用户自己在用的版本，不是基座：已撤掉误标的 base.json"
                            );
                            report.cleared_base.push(dir_name.clone());
                            changed = true;
                        }
                        continue;
                    }
                    if !parents.contains(&lower)
                        || buried.contains(&lower)
                        || paths.is_base_version(dir_name)
                    {
                        continue;
                    }
                    /*
                     * ② 账本里那条记录是"用户要的"吗？
                     *   没有记录 ⇒ 不是（这次顺手装上的）；
                     *   有记录 ⇒ 只有"启动器自己捡回来的"那种才继续往下判。
                     */
                    let user_asked = kept.iter().any(|i| {
                        slug_of(i).as_deref() == Some(dir_name.as_str()) && !is_launcher_picked(i)
                    });
                    if user_asked {
                        continue;
                    }
                    /*
                     * ④ 它**自己有一份版本描述** —— 只有 jar 的目录本来就不是版本，
                     *    不必给它记号。
                     * ★ 2026-10-16：判据从"`<目录>.json` 存在"放宽成"目录里有
                     *   **任何**一份版本 JSON"（同一个文件名假设，见上面那段）。
                     *   收紧的部分由 `inheritsFrom` 那一侧负责：会被标基座的目录，
                     *   一定是**别人声明的父版本**，不会是随手的杂项目录。
                     */
                    if version_json_files(&paths.instances.join(dir_name)).is_empty() {
                        continue;
                    }
                    if paths.mark_version_as_base(dir_name, "（另一个版本继承它）") {
                        report.marked_base.push(dir_name.clone());
                        say!(
                            "[IEML/catalog] 「{dir_name}」是被别的版本继承的**基座**\
                             （账本里没有「用户要它」的记录）—— 已记一份 `.ieml/base.json`：\
                             不再当独立版本，也不再补记录"
                        );
                    }
                    flagged_base.push(dir_name.clone());
                }
            }
            /*
             * ★ 顺手把**基座身上那条"启动器捡回来的"记录**清掉。
             *
             *   为什么必须清：记录 = "这是一个版本"（收藏星、显示名、启动目标都挂在它上面），
             *   而基座不是版本；留着它还会**占住那个 slug** —— 用户以后真的单独装一次原版，
             *   前端只能给它排到 `26.3-2`（一个指向不存在目录的幽灵实例）。
             *   ★ 只清**启动器自己捡回来的**那两种（见 `is_launcher_picked`）：
             *     用户装的 / 建的一条都不许动（那是他的东西）。
             */
            if !flagged_base.is_empty() {
                let before = kept.len();
                kept.retain(|i| {
                    let Some(slug) = slug_of(i) else { return true };
                    let is_base = paths.is_base_version(&slug)
                        || flagged_base.iter().any(|d| d.eq_ignore_ascii_case(&slug));
                    !(is_base && is_launcher_picked(i))
                });
                if kept.len() != before {
                    changed = true;
                    say!(
                        "[IEML/catalog] 清掉 {} 条「基座」身上的账本记录（那是启动器捡回来的，\
                         不是用户要的版本）",
                        before - kept.len()
                    );
                }
            }
            for dir_name in &disk_names {
                if known.contains(&dir_name.to_lowercase()) {
                    continue;
                }
                /*
                 * ★ 墓碑优先：用户删过的，**不补**。
                 *   这一条要放在"有没有版本 JSON"之前 —— 顺序在这里是语义：
                 *   先问"用户想不想要它"，再问"它是不是一个能启动的版本"。
                 */
                if buried.contains(&dir_name.to_lowercase()) {
                    continue;
                }
                /*
                 * ★★ 基座也不补（2026-10-08）：它不是一个"用户要的版本"，
                 *   占一条账本记录只会让收藏星、名字、启动目标都指向一个底座。
                 */
                if paths.is_base_version(dir_name) {
                    continue;
                }
                let dir = paths.instances.join(dir_name);
                if !dir.join(format!("{dir_name}.json")).is_file() {
                    continue; // 没有版本 JSON ⇒ 不是能启动的版本
                }
                let inst = synthesize_instance(&paths.instances, dir_name);
                known.insert(dir_name.to_lowercase());
                report.adopted.push(dir_name.clone());
                say!("[IEML/catalog] 盘上有版本「{dir_name}」而账本里没有 —— 补一条记录");
                kept.push(inst);
                changed = true;
            }

            if changed {
                if let Some(obj) = ledger.as_object_mut() {
                    obj.insert(
                        "instances".into(),
                        serde_json::Value::Array(kept.clone()),
                    );
                    // 指向已删实例的 active_id 也要清掉
                    let active_ok = obj
                        .get("active_id")
                        .and_then(|v| v.as_str())
                        .map(|a| {
                            kept.iter().any(|i| {
                                i.get("id").and_then(|x| x.as_str()) == Some(a)
                            })
                        })
                        .unwrap_or(false);
                    if !active_ok {
                        obj.insert("active_id".into(), serde_json::Value::Null);
                    }
                }
                write_ledger_with_backup(&ledger_path, &ledger);
            }
        }
    }

    // ---------- ⑤ 每个版本写一份身份小抄 ----------
    let ledger = paths.own_json("instances.json");
    for dir_name in &disk_names {
        let dir = paths.instances.join(dir_name);
        /*
         * ★★★★ 2026-10-06（用户截图：「整合包会被误判成错误版本」）。
         *
         *   这里原来是 `if !dir.join(format!("{dir_name}.json")).is_file() { continue }`
         *   —— **只给"有同名版本 JSON"的目录写身份小抄**。
         *
         *   而**整合包实例本来就没有那个 JSON**：它的加载器装在共享目录
         *   （`versions/1.20.1-fabric-0.14.21/`），自己的目录只放
         *   `mods/ config/ saves/ …`（实例目录 = 游戏目录）。
         *   ⇒ 于是整合包目录**永远拿不到 `instance.json`**，
         *     而 `scan_folder_versions` 又只能靠它认出"这是一个整合包实例" ——
         *     结果就是截图里那句「缺少版本描述文件」。
         *
         *   ★ 判据改成"**是账本里的实例** 或 有同名 JSON"：
         *     账本里有的目录一定是我们自己创建的实例（整合包实例必在其中），
         *     给它写一份身份是**正确的**；而"盘上有、账本没有"的目录仍然
         *     只在有同名 JSON 时才写（那种目录我们不了解它是什么）。
         */
        let in_ledger = ledger
            .as_ref()
            .and_then(|l| l.get("instances"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter().any(|i| {
                    i.get("config")
                        .and_then(|c| c.get("slug"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.eq_ignore_ascii_case(dir_name))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !in_ledger && !dir.join(format!("{dir_name}.json")).is_file() {
            continue;
        }
        /*
         * ★★★★ 2026-10-07（用户截图：「又来了，下载完后，整合包被误判为不可用」）：
         *   **收成唯一实现** —— 这里不再自己拼小抄，调
         *   `ensure_instance_marker`（与 `folder_versions` 用的是同一个函数）。
         *
         *   上一次修复栽在"两处各判一次、条件不同"：判据改成"看小抄"之后，
         *   而写小抄只在启动时跑 ⇒ 刚装完的实例在本次会话里必然没有小抄。
         *   ⇒ 只要"读小抄"和"写小抄"不是同一份实现，这个形状就会再来一次。
         */
        paths.ensure_instance_marker(dir_name);
    }

    report
}

/// ★★ 版本目录改名之后，**让里面的版本 JSON 也叫这个名字**。
///
/// ## 为什么这件事不能省
///
///   PCL 与 IEML 找版本描述的方式是同一条：`<版本目录>/<目录名>.json`
///   （PCL `McInstance::GetJsonPath`；IEML `scan_folder_versions` 先试
///   `<dir>/<dir>.json`，找不到才退而求其次取目录里第一个 json）。
///
///   所以"目录改了名、json 还叫旧名"的后果不是报错，而是**静默换了版本描述**：
///   启动时找不到同名 json，就拿目录里第一个 json（可能是加载器 profile、
///   也可能是原版那份），于是主类与实际 classpath 对不上 ——
///   实测表现是日志只有 164 字节的
///   `错误: 找不到或无法加载主类 net.fabricmc.loader.impl.launch.KnotClient`。
///
///   ⇒ 改名之后必须把 json 也改成新名（内容是同一份，只是文件名）。
///     `old_dir_name` 是它**原来**可能叫什么（真机上安装器写的那个名字）。
///
/// ★ 只改**真正的版本描述**：优先认 `<旧目录名>.json`，否则认一个含
///   `mainClass` 的 json。认不出就什么都不做（宁可让它保持原样，
///   也不要瞎改一个用户的文件）。
fn ensure_version_json_matches_dir(dir: &Path, new_name: &str, old_dir_name: &str) {
    let want = dir.join(format!("{new_name}.json"));
    if want.is_file() {
        return;
    }
    let legacy = dir.join(format!("{old_dir_name}.json"));
    let source = if legacy.is_file() {
        Some(legacy)
    } else {
        std::fs::read_dir(dir).ok().and_then(|it| {
            it.flatten()
                .map(|f| f.path())
                .find(|p| {
                    if p.extension().map(|x| x != "json").unwrap_or(true) {
                        return false;
                    }
                    std::fs::read_to_string(p)
                        .ok()
                        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                        .map(|v| v.get("mainClass").is_some())
                        .unwrap_or(false)
                })
        })
    };
    let Some(src) = source else {
        say!(
            "[IEML/catalog] 改名后的 {} 里找不到可识别的版本 JSON —— 保持不变（不猜）",
            dir.display()
        );
        return;
    };
    /*
     * ★ 原版与加载器 profile **就是两份文件**时，两份都要跟着改名
     *   （真机上 `fabric-loader-0.19.5-26.3/` 里同时躺着
     *   `26.3.json` 与 `fabric-loader-0.19.5-26.3.json`，内容一模一样）。
     *   两份都改成新名会撞车，所以只改"版本描述那一份"（含 `mainClass`
     *   且 `id` 等于目录名的那份），另一份留着不动 —— 它不影响启动。
     */
    if std::fs::rename(&src, &want).is_ok() {
        say!(
            "[IEML/catalog] 版本 JSON 跟着改名：{} → {}",
            src.display(),
            want.display()
        );
    } else {
        // 改名失败（被占用）→ 退一步复制一份，启动器至少找得到
        match std::fs::copy(&src, &want) {
            Ok(_) => say!(
                "[IEML/catalog] 版本 JSON 改名失败，已复制一份为 {}",
                want.display()
            ),
            Err(e) => say!("[IEML/catalog] 版本 JSON 改名失败：{e}"),
        }
    }
}

/// ★★ 把一份版本 JSON **补给同规格的兄弟目录**。
///
/// ## 为什么需要这一步（真数据彩排暴露出来的）
///
///   老布局里"游戏数据"与"版本描述"本来就分在两个地方：
///   `instances/<slug>/game/` 有存档与 Mod，`.minecraft/versions/<别的名字>/`
///   有版本 JSON。把两者合进一个文件夹之后，**游戏数据那一份可能根本没有
///   JSON** —— 而迁移是**不会**凭空造版本描述的（那需要是"这个版本的库清单"，
///   编不出来）。
///
///   后果很具体（真数据彩排里就出现了）：`26.3-fabric-0.19.5` 里有 `mods/`、
///   没有 `<目录名>.json` ⇒ 版本列表里它显示成"错误的版本"、启动不了，
///   而用户的 Mod 就在里面。
///
///   ⇒ 从**同一个文件夹里刚改好名的那一份**（规格相同：MC 版本 + 加载器 + 加载器版本）
///     复制一份过去。判据窄到"目录名去掉 `-数字` 后缀之后与源**完全相同**"，
///     所以不会把它塞给一个不相干的版本。
///
///   为什么可以共用同一份 JSON：启动器只把它当"版本描述"读
///   （`mainClass` / `libraries` / `inheritsFrom`），它里面**没有**任何
///   与存档或实例设置相关的东西 —— 两份同规格的版本本来就该用同一份描述。
fn share_version_json_with_siblings(dir: &Path, dir_name: &str) {
    let src = dir.join(format!("{dir_name}.json"));
    if !src.is_file() {
        return;
    }
    let Some(parent) = dir.parent() else {
        return;
    };
    // `26.3-fabric-0.19.5-3` → `26.3-fabric-0.19.5`（去掉去重后缀）
    let stem = match dir_name.rsplit_once('-') {
        Some((head, tail)) if tail.chars().all(|c| c.is_ascii_digit()) => head,
        _ => dir_name,
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == dir_name {
            continue;
        }
        // 判据：去掉去重后缀之后与源**同名**（`26.3-fabric-0.19.5` / `…-2`）
        if name != stem && !name.starts_with(&format!("{stem}-")) {
            continue;
        }
        let want = e.path().join(format!("{name}.json"));
        if want.is_file() {
            continue;
        }
        // 只补给"里面有东西"的目录（空壳不值得给它一份版本描述）
        let has_content = e
            .path()
            .join("mods")
            .is_dir()
            || e.path().join("saves").is_dir()
            || e.path().join("options.txt").is_file();
        if !has_content {
            continue;
        }
        match std::fs::copy(&src, &want) {
            Ok(_) => say!(
                "[IEML/catalog] {name} 里只有游戏数据、没有版本描述 —— 从 {dir_name} 补了一份（同规格）"
            ),
            Err(err) => say!("[IEML/catalog] 给 {name} 补版本描述失败：{err}"),
        }
    }
}

/// 账本里一条记录的 `config.slug`（没有就给 `None`）。
fn slug_of(inst: &serde_json::Value) -> Option<String> {
    inst.get("config")?
        .get("slug")?
        .as_str()
        .map(|s| s.to_string())
}

/// 这条账本记录是**启动器自己捡回来的**吗（不是"用户明确要过它"）？
///
/// ★ 两个指纹，都来自**写它的那段代码**（不是猜）：
///   · `id` 以 `inst-disk-` 开头 ⇒ `synthesize_instance`（启动时的补认）写的；
///   · `config.name == config.slug` ⇒ 前端**自动认领**写的
///     （`instanceFromFolderVersion` 把名字直接取成目录名）。
///
///   用户明确装/建出来的记录两样都不占：`id` 是 `inst-<base36>`，
///   名字是「Minecraft 26.3」这种**显示名**。
///
/// ★ 用途只有一个：启动时的归置要判断"这条原版记录算不算一个版本"
///   （见 `instance_catalog_repair` 那一段"原版是基座"）。
///   **它绝不参与删除用户的东西** —— 只有"补认/自动认领"这两种记录会被它认出来。
fn is_launcher_picked(inst: &serde_json::Value) -> bool {
    let id_repair_made = inst
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.starts_with("inst-disk-"))
        .unwrap_or(false);
    let name_is_dir = match (
        inst.get("config").and_then(|c| c.get("name")).and_then(|v| v.as_str()),
        inst.get("config").and_then(|c| c.get("slug")).and_then(|v| v.as_str()),
    ) {
        (Some(name), Some(slug)) => name == slug,
        _ => false,
    };
    id_repair_made || name_is_dir
}

/// 账本里**没有**这个版本时，从磁盘现造一条最小记录。
///
/// 只用目录名与它的 JSON —— 认不出来的字段一律给"安全默认"
/// （隔离 auto、内存 4096 由前端按机器内存纠正），**绝不编造**加载器版本。
fn synthesize_instance(versions_root: &Path, dir_name: &str) -> serde_json::Value {
    use crate::domain::naming::{parse_dir_name, version_display_name, VersionParts};

    let dir = versions_root.join(dir_name);
    let mut mc_version = dir_name.to_string();
    let mut loader_kind: Option<String> = None;
    let mut loader_version = String::new();

    if let Ok(text) = std::fs::read_to_string(dir.join(format!("{dir_name}.json"))) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(inherits) = v.get("inheritsFrom").and_then(|x| x.as_str()) {
                if !inherits.is_empty() {
                    mc_version = inherits.to_string();
                }
            } else if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                if !id.is_empty() {
                    mc_version = id.to_string();
                }
            }
        }
    }
    if let Some(parts) = parse_dir_name(dir_name) {
        if let Some((kind, ver)) = &parts.loader {
            loader_kind = Some(kind.as_str().to_string());
            loader_version = ver.clone();
        }
    }
    let display = version_display_name(&VersionParts {
        mc_version: mc_version.clone(),
        loader: loader_kind
            .as_deref()
            .and_then(loader_kind_from_str)
            .map(|k| (k, loader_version.clone())),
        addons: Vec::new(),
    });
    // ★ id 用目录名（稳定、唯一、与磁盘一致）—— 与前端 `inst-<base36>` 不冲突
    let id = format!("inst-disk-{}", dir_name.to_lowercase());
    let loader = loader_kind.map(|k| {
        serde_json::json!({
            "kind": k,
            "version": loader_version,
            "mcVersion": mc_version,
        })
    });
    serde_json::json!({
        "id": id,
        "mcVersion": mc_version,
        "loader": loader,
        "addons": [],
        "config": {
            "name": display,
            "slug": dir_name,
            "isolation": "auto",
            "memoryMb": 4096,
            "memorySource": "auto",
            "javaMode": "auto",
        },
        "createdAt": serde_json::Value::Null,
        "lastPlayedAt": serde_json::Value::Null,
        "totalPlaySeconds": 0,
    })
}

/// 认加载器种类 —— **只留这一份实现**（`BaseLoaderKind::parse`）。
///
/// ★ 这里原来是手写的一张 `match` 表，而安装侧另一处也写了一张 ——
///   两张表只要有一处漏了/多了一条，就会出现"目录这边认得出、安装那边认不出"。
fn loader_kind_from_str(s: &str) -> Option<crate::domain::types::BaseLoaderKind> {
    crate::domain::types::BaseLoaderKind::parse(s)
}

/// 写账本（与 `commands::save_instances` 同一套原子写 + `.bak` 纪律）。
///
/// ★ 抽出来是为了让**启动时的归置**也能安全改账本：改之前先留一份 `.bak`，
///   万一判据错了，用户的记录还在。
fn write_ledger_with_backup(path: &Path, value: &serde_json::Value) {
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    if path.is_file() {
        let bak = path.with_extension("json.bak");
        let _ = std::fs::copy(path, &bak);
    }
    let Ok(text) = serde_json::to_string_pretty(value) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// `copy_tree` 与 `merge_instances_by_mtime` 的共同实现。
/// `newer_wins = false` → 目标已有就跳过；`true` → 源更新就覆盖（先备份目标）。
///
/// ★★ 2026-09-30：**不凭空造空目录**（`create_dir_all(to)` 从开头挪到了真正要
///   写文件的那一刻）。这条是被真数据彩排逼出来的：
///
///   老布局的实例目录里有一层空的 `game/`（提平之后留下的空壳）。递归复制
///   会忠实地把"空目录"也复制过去 —— 于是**合并这一步会在源那边留下一个
///   空的 `game/`**（真机复现：`<old>/instances/s1/game/` 是空的）。
///   下一轮启动的规范化看到"有个 game/"，就去提平它、并报告"改了 1 个版本" ——
///   **幂等性没了，每次启动都报告同一个版本被提平**。
///
///   而空目录本来就没有信息量：目标那一侧缺了它不影响任何事（游戏会自己建）。
fn copy_tree_rule(from: &Path, to: &Path, newer_wins: bool) -> std::io::Result<u64> {
    copy_tree_rule_skip(from, to, newer_wins, &std::collections::HashSet::new(), 0)
}

/// 同 [`copy_tree_rule`]，但可以在**顶层**跳过一组名字（墓碑里的版本目录）。
///
///   `depth` 是当前递归深度：跳过名单**只在顶层生效** ——
///   版本目录里面也可能有叫 `26.3-fabric-0.19.5` 的子目录（比如 `mods/` 下的），
///   那些不该因为顶层墓碑被跳过。
fn copy_tree_rule_skip(
    from: &Path,
    to: &Path,
    newer_wins: bool,
    skip_top: &std::collections::HashSet<String>,
    depth: usize,
) -> std::io::Result<u64> {
    let mut bytes = 0u64;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let raw_name = e.file_name();
        let name = raw_name.to_string_lossy();
        /*
         * ★★ 墓碑：**顶层**目录名在名单里就不搬（见 `merge_instances_by_mtime`）。
         *   这一条与下面那条"启动器自己的东西"是同一类规矩 ——
         *   都是"这一份不该跟我们搬家"，只是判据不同。
         */
        if depth == 0 && skip_top.contains(&name.to_lowercase()) {
            say!("[IEML/paths] 跳过「{name}」：它在已删除版本的名册里（墓碑）");
            continue;
        }
        /*
         * ★★ 2026-09-30：**启动器自己那层不进游戏目录的搬家**。
         *   `.ieml/` 里是 natives 与打包记录 —— 它跟着版本目录走没错，
         *   但"把 game/ 提到版本目录""跨根补实例"这类搬家不该把它当游戏数据
         *   搬来搬去（natives 每次启动都会按当前架构重新解压，搬过去的多半是错的）。
         *   `.ieml-bak` 是覆盖前留下的备份，同理。
         */
        if is_launcher_owned(&name) {
            continue;
        }
        let src = e.path();
        let dst = to.join(&raw_name);
        let meta = e.metadata()?;
        if meta.is_dir() {
            // ★ 递归时深度 +1：跳过名单只在顶层生效（见函数说明）
            bytes += copy_tree_rule_skip(&src, &dst, newer_wins, skip_top, depth + 1)?;
        } else if meta.is_file() {
            if dst.is_file() {
                if !newer_wins || !is_newer(&src, &dst) {
                    continue; // 目标已有 → 不动（那是用户正在用的那份）
                }
                let bak = backup_name(&dst);
                match std::fs::copy(&dst, &bak) {
                    Ok(_) => say!("[IEML/paths] 覆盖前把 {} 备份到 {}", dst.display(), bak.display()),
                    Err(e) => {
                        // 备份不成功就**不覆盖** —— 判据再合理也不能冒丢数据的风险
                        say!("[IEML/paths] {} 备份失败（{e}），这一步跳过", dst.display());
                        continue;
                    }
                }
                say!(
                    "[IEML/paths] {} 比目标新，用它覆盖 {}（存进实例目录的新家）",
                    src.display(),
                    dst.display()
                );
            }
            // 半截的 .part 与启动器自己的中间产物不该跟着搬家：
            // 新家会用新路径重新下（判据只有一份，见 `is_launcher_transient_file`）
            if is_launcher_transient_file(&name) {
                continue;
            }
            // ★ 真正要写文件了才建目录（见上面的说明：空目录不复制）
            std::fs::create_dir_all(to)?;
            std::fs::copy(&src, &dst)?;
            bytes += meta.len();
        }
    }
    Ok(bytes)
}

/// **换过数据根时**那一次合并的记号文件名（每个老根一个，见 `migrate_data_root`）。
///
/// 与 `LEGACY_MERGED_MARKER`（`instance_catalog_repair` 用的那个）**刻意不同**：
/// 两条合并的源不一样（当前根 vs 老数据根），共用一个标记会让先跑的
/// 把后跑的永久关掉。名字里带上老根的路径指纹，换过多个根时各记各的。
fn legacy_merge_marker_name(old: &Path) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(old.to_string_lossy().as_bytes());
    let d = h.finalize();
    format!(".instances-merged-{:x}", &d[..4].iter().fold(0u32, |a, b| (a << 8) | *b as u32))
}

/// 顶层文件里哪些**不该跟着搬家**（与版本目录那套墓碑判据同一个目的）。
///
/// ★★★★ 2026-10-01：加它的直接原因是排查「删了又复活」时发现的**对称缺口** ——
///   同一批 `versions/` 里的东西，保护是**按形状**给的：
///
///   | 形状 | 保护 |
///   |---|---|
///   | 目录（版本） | 墓碑（`buried_version_dirs`）—— 只有用户删过的才挡 |
///   | **文件** | **完全没有** |
///
///   而 `versions/` 下确实有启动器自己写的文件（整合包安装留下的 `.mrpack`：
///   真机上量到 **7.3 MB**，名字形如 `mrpack-{taskId}.mrpack`）。它们**永远不会
///   进墓碑**（墓碑记的是"版本目录名"），于是每次换数据根/合并都会被**原样搬一遍**，
///   白占空间、白花时间，而且看着像"我删过的东西又出现了"。
///
///   ★ 判据是**文件名形状**（启动器自己的中间产物），不是"用户删过的名字"——
///     这一点与墓碑**刻意不同**：这些文件本来就是临时的，任何一份都不该被
///     当成"用户的游戏数据"搬来搬去。
///   ★ 顺带把 `.part` 那一套判据收进来（原来写在 `copy_tree_rule_skip` 里）：
///     半截的下载片段搬到新家没有意义，新家会用新路径重新下。
fn is_launcher_transient_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.contains(".part") || n.ends_with(".tmp") {
        return true;
    }
    // 整合包安装的中间物（装完就删，但中途失败/取消会留下）
    if n.starts_with("mrpack-") && n.ends_with(".mrpack") {
        return true;
    }
    // 合并记号本身不必跟着搬（每一侧各自判断"做过没有"）
    if n.starts_with(".instances-merged") {
        return true;
    }
    false
}

/// 把目录树列成一个字符串列表（最多 `depth` 层），**只为调试**。
///
///   `IEML_DEBUG_TREE=1` 时 `migrate_data_root` 会打印老/新两边的树。
///   写它是因为一次真实调试：断言只说"读不到那份文件"，而真正的问题是
///   那个文件落在了一层多余的 `game/` 里 —— **打印目录树比打印一句错误省一整天**。
fn walk_dir(p: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(p) else {
        return;
    };
    for e in rd.flatten() {
        out.push(format!(
            "{}{}",
            "  ".repeat(depth),
            e.file_name().to_string_lossy()
        ));
        if e.path().is_dir() && depth < 3 {
            walk_dir(&e.path(), depth + 1, out);
        }
    }
}

/// 源文件是不是**比**目标文件新（严格大于；取不到 mtime 就按"不新"处理）。
fn is_newer(src: &Path, dst: &Path) -> bool {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (mtime(src), mtime(dst)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 覆盖前的备份名：`options.txt` → `options.txt.ieml-bak`。
fn backup_name(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    name.push_str(".ieml-bak");
    dst.with_file_name(name)
}

/* ====================== 机器信息 ====================== */

#[derive(Debug, Clone, serde::Serialize)]
pub struct MachineInfo {
    pub total_memory_gb: f64,
    pub available_memory_gb: f64,
    pub cpu_count: usize,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    /// 当前游戏根目录里**装了几个版本**（`<root>/.minecraft/versions` 下的目录数）。
    ///
    /// ★★ 2026-09-25（用户：「换目录后不会自动刷新……点击版本列表就刷新一下，
    ///   重新读取当前选择的游戏目录」）：
    ///
    ///   版本列表列的是**账本里的实例**，而账本住在启动器自己的家里（ADR-七十二），
    ///   **与游戏根目录无关** —— 所以换到一个空目录之后，那一页显示的是
    ///   "N 个条目全都在报错"，而不是"你选的这个目录里什么都没有"。
    ///   用户看到的：换了目录，列表却像没刷新过。
    ///
    ///   这里补一个**磁盘事实**：当前根目录下到底有几个版本。界面据此把话说清
    ///   （0 = 这个目录还没有版本，多半是刚换过来），而不是让用户自己猜。
    ///
    ///   ★ 为什么不直接看"实例是不是都缺文件"：那分不清"刚换到空目录"与
    ///     "用户自己在资源管理器里把版本删了" —— 这两种要用不同的话说。
    pub version_count: usize,
}

/**
 * 机器信息的一次性缓存（2026-10-09，同下面 `machine_info` 那段说明）。
 *
 * `lib.rs::run` 在**窗口创建之前**起一个后台线程把结果算好填进来；
 * `machine_info` 命令直接取 —— 取不到（还没算完）就现算，并把结果补进缓存。
 *
 * ★ 用进程级 `static`：一个进程只有一台机器。但缓存里**只放与数据根无关**的那几个数
 *   （`MachineSnapshot`）—— `data_dir` / `version_count` 依赖当前的 `AppPaths`，
 *   而设置页可以**当场**换数据根（rc.6 起即时生效），那两个字段必须每次现算。
 */
pub struct MachineInfoCache {
    slot: std::sync::Mutex<Option<MachineSnapshot>>,
    cv: std::sync::Condvar,
}

/// 缓存里真正会被复用的那几个数（**不含路径**，路径随 `AppPaths` 变）
#[derive(Clone)]
pub struct MachineSnapshot {
    pub total_memory_gb: f64,
    pub available_memory_gb: f64,
    pub cpu_count: usize,
    pub os: String,
}

impl MachineInfoCache {
    const fn new() -> Self {
        Self {
            slot: std::sync::Mutex::new(None),
            cv: std::sync::Condvar::new(),
        }
    }

    pub fn fill(&self, snap: MachineSnapshot) {
        if let Ok(mut g) = self.slot.lock() {
            *g = Some(snap);
            self.cv.notify_all();
        }
    }

    /// 取；最多等 `timeout`。没等到就返回 `None`，调用方自己现算。
    pub fn get(&self, timeout: std::time::Duration) -> Option<MachineSnapshot> {
        let g = self.slot.lock().ok()?;
        if g.is_some() {
            return g.clone();
        }
        let (g, _) = self.cv.wait_timeout(g, timeout).ok()?;
        g.clone()
    }
}

static MACHINE_CACHE: MachineInfoCache = MachineInfoCache::new();

/// 全局那一份机器信息缓存（见 `MachineInfoCache` 的说明）
pub fn machine_info_cache() -> &'static MachineInfoCache {
    &MACHINE_CACHE
}

/**
 * 那几件**贵**的探测：sysinfo 的初始化 + 内存 + CPU 列表（不含路径相关的东西）。
 *
 * ★★ 2026-10-09（用户：「**进入启动器的速度有点慢**」）：真机打点量出来
 *   **这一条第一次调用要 191ms**（`[IEML/boot] machine_info = 191ms`，
 *   紧接着的几次都是 0~1ms）—— 而它是启动批次里的**第一条**同步命令，
 *   同一条主线程上的其余几条都排在它后面 ⇒ 首屏白等 190ms。
 *
 *   钱花在 sysinfo 身上：`System::new()` 的一次性初始化与 `refresh_cpu_all()`
 *   （它会**逐个 CPU** 去读时间与频率）。而界面要的只有**核数** ——
 *   `CpuRefreshKind::nothing()` 只把 CPU 列表列出来、不读那些计数，
 *   A/B 实测（两个全新进程、同一分钟）**471ms → 352ms**。
 *
 *   ★ 剩下的那 350ms 不是"算法不好"，是**第一次碰这些系统接口**的固有成本，
 *     所以真正的解法是**别让首屏等它** —— 见 `MachineInfoCache`：
 *     `lib.rs::run` 在窗口创建之前就起线程把它算好。
 *   ★ 判据：`[IEML/boot] machine_info = …ms` 这一行应当落到个位数
 *     （探针：本机开发记录里的 `live-startup-timing.mjs`）；
 *     两个变体的对照见 `src/bench_startup.rs`（`#[ignore]`，手动跑）。
 */
pub fn machine_snapshot() -> MachineSnapshot {
    use sysinfo::{CpuRefreshKind, System};
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(CpuRefreshKind::nothing());

    let total = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let avail = sys.available_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    MachineSnapshot {
        total_memory_gb: (total * 10.0).round() / 10.0,
        available_memory_gb: (avail * 10.0).round() / 10.0,
        cpu_count: sys.cpus().len(),
        os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
    }
}

/**
 * 这台机器的情况（内存 / 核数 / 系统 / 数据目录 / 版本目录数）。
 *
 * 贵的部分（sysinfo）走缓存 —— 见 `machine_snapshot`；
 * 路径相关的两个字段（`data_dir` / `version_count`）每次现算，
 * 因为设置页可以当场换数据根。
 */
pub fn machine_info(paths: &AppPaths) -> MachineInfo {
    let snap = machine_info_cache()
        .get(std::time::Duration::from_millis(2000))
        .unwrap_or_else(|| {
            let s = machine_snapshot();
            machine_info_cache().fill(s.clone());
            s
        });
    MachineInfo {
        total_memory_gb: snap.total_memory_gb,
        available_memory_gb: snap.available_memory_gb,
        cpu_count: snap.cpu_count,
        os: snap.os.clone(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: paths.root.to_string_lossy().to_string(),
        version_count: count_versions_in(&paths.shared),
    }
}

/// 数一数 `<shared>/versions` 下有几个版本目录（读不到 = 0，不编数）。
pub fn count_versions_in(shared: &Path) -> usize {
    std::fs::read_dir(shared.join("versions"))
        .map(|it| {
            it.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/* ====================== 子进程：别弹控制台窗口 ====================== */

/*
 * ★★ Windows 上，启动一个**控制台子系统**程序（java.exe / tar.exe /
 *    taskkill.exe / cmd.exe）而不传 `CREATE_NO_WINDOW`，系统会**弹出一个
 *    控制台窗口**。
 *
 *    用户报的原话：「安装 Forge 调出来个啥也没有的 cmd 是何意味」——
 *    那个"啥也没有"的黑框就是 Forge 安装器的 java 进程：
 *    它的输出被启动器接走了（我们要拿它判断成功失败、给用户看进度），
 *    窗口里自然什么都没有，只剩一个空壳挂在屏幕上。
 *    对用户来说这就是"启动器怎么突然弹了个黑框"。
 *
 *    这与"要不要用命令行安装"无关 —— 我们本来就必须用命令行跑 Forge 的
 *    installer jar（那是 Forge 官方唯一的无人值守接口：
 *    `java -jar forge-installer.jar --installClient <dir>`）。
 *    问题只在于**窗口不该露出来**。静默地跑，然后把结果如实报告，
 *    这才是"自动安装"该有的样子。
 *
 *    所以这里提供**唯一**的抑制入口。新增任何创建子进程的代码都应该用它，
 *    不要再各处手写 `0x0800_0000` —— 那个数字抄错一次就是一个新黑框，
 *    而且不会有任何报错提示你。
 */

/// `CREATE_NO_WINDOW`：不为新进程创建控制台窗口。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 给 `std::process::Command` 加上"不弹窗"标志（非 Windows 上是空操作）。
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 给 `tokio::process::Command` 加上"不弹窗"标志（非 Windows 上是空操作）。
///
/// ★ 异步侧必须单独有一个：`tokio::process::Command` 与 `std::process::Command`
///   是两个不同的类型，trait 也不通用。**Forge 安装器走的正是这一条** ——
///   老代码只给 `std::process::Command` 加了标志，异步那处漏了，
///   于是唯一一处会弹黑框的地方恰好就是用户天天要点的"安装 Forge"。
pub fn hide_console_async(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/* ====================== Java 探测 ====================== */

/// 跑一次 `java -version`，拿它的主版本号（拿不到返回 `None`）。
///
/// 用途：**给某个具体的 java.exe 判版本**，而不是走整条扫描。
/// 典型场景是"跑第三方安装器之前先确认这个 Java 支持它要的参数"——
/// 实测踩过：OptiFine 的安装器要 `--add-exports`，那是 **Java 9+** 才有的选项，
/// 拿 Java 8 去跑会得到 `Unrecognized option: --add-exports` 加
/// `Could not create the Java Virtual Machine`，安装器一行都没执行。
pub fn java_major_of(exe: &Path) -> Option<u32> {
    if !exe.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("-version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    parse_java_version(&text).map(|(_, major)| major)
}

/// 扫描本机的 Java 运行时。
///
/// ## 这一版为什么重写（用户报"它根本不知道去哪里找 java"）
///
/// 用户的原话：「IEML 管我要 java21，但我的电脑里确实有 java21，还有 25，
/// 也就是说它根本不知道去哪里找 java」。**他是对的**：
///
///   · 他的 Java 21 是 **Minecraft 官方启动器**下的，躺在
///     `%APPDATA%\.minecraft\runtime\java-runtime-delta`（真实存在，`release`
///     文件写着 `JAVA_VERSION="21.0.7"`）；
///   · 他的 Java 8 也在那儿：`%APPDATA%\.minecraft\runtime\jre-legacy`（`1.8.0_51`）；
///   · 而老版 `scan_java` 只看四处：`JAVA_HOME` / `PATH` / `Program Files\*` /
///     自己下载的 `data/java`。
///
///   于是启动器眼里本机"只有 Java 25"，1.12.2（需要 Java 8）也就没有 Java 8 可用。
///
/// ## 现在的来源（按可信度排序，全部保留 provenance）
///
///   ① IEML 自己下载的 —— `downloaded`
///   ② 用户手动指定的 —— `manual`
///   ③ Mojang 官方运行时 —— `mojang`（`.minecraft/runtime/*`，**这次补上的关键一处**）
///   ④ Windows 注册表登记的 JRE/JDK —— `registry`
///   ⑤ 其它启动器记下来的（PCL2 的 `config.json`）—— `launcher`
///   ⑥ `JAVA_HOME` / `PATH` —— `system`
///   ⑦ 常见安装根目录（Adoptium / Oracle / Zulu / Microsoft / Temurin …）—— `system`
///   ⑧ 根目录浅扫描（`C:\jdk*`、`D:\java*` …）—— `scan`
///
/// ## 为什么要"先把候选路径收集完，再去并行探测"
///
///   `probe_java` 要真的跑一次 `java -version`（50~300 ms）。
///   老实现是**边发现边探测**、一个一个串行跑 —— 一次扫描能卡好几秒，
///   而 `scan_java` 是 IPC 命令，卡住的是整个界面。
///   现在先做零成本的路径收集 + 去重，再并行探测（最多 8 路）。
pub fn scan_java(paths: &AppPaths) -> Vec<JavaRuntime> {
    scan_java_with_extra(paths, &[])
}

/// 同上，外加**用户手动指定**的 java.exe 路径（设置页里挑的）。
pub fn scan_java_with_extra(paths: &AppPaths, manual: &[String]) -> Vec<JavaRuntime> {
    let mut by_path: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut push = |path: PathBuf, source: &str, by_path: &mut Vec<(String, PathBuf)>| {
        let key = canonical_key(&path);
        if seen.insert(key) {
            by_path.push((source.to_string(), path));
        }
    };

    // ③ Mojang 官方运行时（这次补上的关键一处）
    for exe in mojang_runtime_javas() {
        push(exe, "mojang", &mut by_path);
    }

    // ④ 注册表（Windows）
    for exe in registry_javas() {
        push(exe, "registry", &mut by_path);
    }

    // ⑤ 其它启动器缓存
    for exe in other_launcher_javas() {
        push(exe, "launcher", &mut by_path);
    }

    // ①② 自己下载的 + 用户手选（最可信，排最前）
    let mut preferred: Vec<(String, PathBuf)> = Vec::new();
    for s in manual {
        let p = PathBuf::from(s);
        let exe = if p.is_file() { p } else { java_exe_in(&p) };
        push(exe, "manual", &mut preferred);
    }
    if let Ok(entries) = std::fs::read_dir(&paths.java) {
        for e in entries.flatten() {
            push(java_exe_in(&e.path()), "downloaded", &mut preferred);
        }
    }
    // ⑥ JAVA_HOME
    if let Ok(home) = std::env::var("JAVA_HOME") {
        push(java_exe_in(Path::new(&home)), "system", &mut by_path);
    }
    // ⑥ PATH
    if let Some(path_var) = std::env::var_os("PATH") {
        let name = if cfg!(windows) { "java.exe" } else { "java" };
        for dir in std::env::split_paths(&path_var) {
            let exe = dir.join(name);
            if exe.is_file() {
                push(exe, "system", &mut by_path);
            }
        }
    }
    // ⑦ 常见安装根目录
    for root in common_java_roots() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let exe = java_exe_in(&e.path());
                if exe.is_file() {
                    push(exe, "system", &mut by_path);
                }
            }
        }
    }
    // ⑧ 根目录浅扫描
    for exe in shallow_drive_javas() {
        push(exe, "scan", &mut by_path);
    }

    /*
     * ⑨ ★★ **实例文件夹里自带的 Java**（2026-09-28 补）。
     *
     *   整合包（尤其国外包）经常在实例里塞一份 JRE：`<实例>/java` 或
     *   `<实例>/game/java`，装的时候就不必求用户先装对版本。
     *   而这一处**从来没被扫过** —— 于是实例设置页的「实例文件夹」那一档
     *   （ADR-030 的四模式之一）永远报"实例文件夹里没有找到 Java"。
     *
     *   ★★ 必须进 `preferred`（排在探测队列前面），**不能**只是追加到 `by_path`：
     *     `probe_many` 有条 64 个候选的上限，而后面的来源（PATH / 注册表 /
     *     各盘浅扫）很容易把名额吃光 —— 第一次就是追加在后面，于是真机上
     *     **一个实例 Java 都没扫到**（探针当场抓到）。
     */
    for slug in instance_slugs(paths) {
        for sub in ["java", "game/java"] {
            let dir = paths.instance_dir(&slug).join(sub);
            let exe = java_exe_in(&dir);
            if exe.is_file() {
                push(exe, "instance", &mut preferred);
            }
        }
    }

    preferred.extend(by_path);

    // 并行探测：先做零成本收集，再一次性花钱
    let results = probe_many(preferred);

    let mut found: Vec<JavaRuntime> = Vec::new();
    for rt in results {
        push_unique(&mut found, rt);
    }
    // 主版本高的排前面；同版本按路径稳定排序（界面每次看到同样的顺序）
    found.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| a.path.cmp(&b.path))
    });
    found
}

/// 账本里所有实例的 slug（**读不到就返回空**：扫 Java 这件事不该因为清单坏了而失败）
///
/// ★ 只读 `config.slug`，不解析整个 `Instance` —— 清单里有一条坏数据时，
///   我们仍然该扫得到**其他**实例的 Java。
fn instance_slugs(paths: &AppPaths) -> Vec<String> {
    paths
        .own_json("instances.json")
        .and_then(|v| v.get("instances").and_then(|i| i.as_array()).cloned())
        .map(|list| {
            list.iter()
                .filter_map(|i| {
                    i.get("config")
                        .and_then(|c| c.get("slug"))
                        .and_then(|s| s.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `java_exe_in` 的**公开版**：给"实例文件夹里自带的那份 Java"用。
///
/// ★ 为什么命令层需要它：`scan_java_with_extra` 按**规范化路径**去重，
///   而整合包自带的那份 JRE 往往与系统里已扫到的是同一份（作者就是塞了一份）
///   —— 那时列表里只会留先扫到的那条，`source == "instance"` 不出现。
///   所以「实例文件夹」这一档的正确判据是**那个路径上有没有 java**，
///   而不是"扫描列表里有没有标着实例的"（详见 `instance_java_choice`）。
pub fn java_exe_for_instance(dir: &Path) -> PathBuf {
    java_exe_in(dir)
}

/// 探测结果的上限：防止某个病态的 PATH 把扫描拖成分钟级
const MAX_JAVA_CANDIDATES: usize = 64;/// 并行度：`java -version` 是进程启动，8 路足够快也不至于把机器打满
const PROBE_CONCURRENCY: usize = 8;

fn probe_many(candidates: Vec<(String, PathBuf)>) -> Vec<JavaRuntime> {
    let candidates: Vec<(String, PathBuf)> =
        candidates.into_iter().take(MAX_JAVA_CANDIDATES).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<JavaRuntime>>> =
        (0..candidates.len()).map(|_| std::sync::Mutex::new(None)).collect();

    let workers = PROBE_CONCURRENCY.min(candidates.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if i >= candidates.len() {
                    break;
                }
                let (source, exe) = &candidates[i];
                if let Some(rt) = probe_java(exe, source) {
                    if let Ok(mut slot) = slots[i].lock() {
                        *slot = Some(rt);
                    }
                }
            });
        }
    });

    slots
        .into_iter()
        .filter_map(|s| s.into_inner().ok().flatten())
        .collect()
}

/// 路径去重用的键：**不要求路径真实存在**（`canonicalize` 会失败），
/// 所以先把能解析的解析掉，再统一大小写与分隔符。
fn canonical_key(p: &Path) -> String {
    let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    resolved
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

/// Mojang 官方启动器的运行时目录。
///
/// 实测（本机）：`%APPDATA%\.minecraft\runtime\` 下有
/// `java-runtime-delta`（**Java 21.0.7**）与 `jre-legacy`（**Java 8.0_51**）。
/// 这两份是"用户确实有 java21/java8"的真相所在 —— 老版完全没扫。
#[cfg(windows)]
fn mojang_runtime_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join(".minecraft").join("runtime"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        roots.push(PathBuf::from(home).join(".minecraft").join("runtime"));
    }
    // 官方启动器允许自定义游戏目录，常见的几处也认一下
    for d in ["D:", "E:", "F:"] {
        roots.push(PathBuf::from(format!("{d}\\.minecraft\\runtime")));
        roots.push(PathBuf::from(format!("{d}\\Minecraft\\.minecraft\\runtime")));
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let exe = java_exe_in(&e.path());
            if exe.is_file() {
                out.push(exe);
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn mojang_runtime_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// Windows 注册表里登记的 Java。
///
/// 覆盖三种登记方式（装机量都不小）：
///   · `HKLM\SOFTWARE\JavaSoft\JDK\<ver>\JavaHome`
///   · `HKLM\SOFTWARE\JavaSoft\JRE\<ver>\JavaHome`
///   · `HKLM\SOFTWARE\JavaSoft\Java Development Kit\<ver>\JavaHome`（老式）
/// 32 位视图（`WOW6432Node`）也要看。
#[cfg(windows)]
fn registry_javas() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut out = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let bases = [
        r"SOFTWARE\JavaSoft",
        r"SOFTWARE\WOW6432Node\JavaSoft",
        r"SOFTWARE\Eclipse Adoptium",
        r"SOFTWARE\WOW6432Node\Eclipse Adoptium",
        r"SOFTWARE\Microsoft\JDK",
        r"SOFTWARE\Azul Systems\Zulu",
        r"SOFTWARE\BellSoft",
    ];
    for base in bases {
        let Ok(key) = hklm.open_subkey_with_flags(base, KEY_READ) else {
            continue;
        };
        collect_java_homes(&key, &mut out, 0);
    }
    out
}

#[cfg(windows)]
fn collect_java_homes(key: &winreg::RegKey, out: &mut Vec<PathBuf>, depth: u32) {
    use winreg::enums::KEY_READ;
    if depth > 3 {
        return;
    }
    for name in key.enum_keys().flatten() {
        let Ok(child) = key.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        // 有的厂商直接把 JavaHome 写在版本键上，有的多一层（MSI 的 MSIReg 之类）
        for value_name in ["JavaHome", "Path", "InstallationPath"] {
            if let Ok(v) = child.get_value::<String, _>(value_name) {
                if !v.trim().is_empty() {
                    let p = PathBuf::from(v.trim());
                    let exe = java_exe_in(&p);
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
        }
        collect_java_homes(&child, out, depth + 1);
    }
}

#[cfg(not(windows))]
fn registry_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// 别的启动器记下来的 Java 位置。
///
/// 实测本机：`%APPDATA%\PCL\config.json` 的 `JavaList` 里正好列着三份
/// （Java 8 / 21 / 25）—— PCL 已经帮我们探测过一遍了，直接采信它的**路径**，
/// 但**版本号仍然由我们自己跑 `java -version` 得出**（别人的结论会过期）。
#[cfg(windows)]
fn other_launcher_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(appdata) = std::env::var("APPDATA") else {
        return out;
    };
    let mut configs: Vec<(PathBuf, &[&str])> = vec![
        (
            PathBuf::from(&appdata).join("PCL").join("config.json"),
            &["JavaList", "Folder"][..],
        ),
        (
            // HMCL 的 java 列表在 `%APPDATA%\HMCL\java.txt`（每行一个目录）
            PathBuf::from(&appdata).join("HMCL").join("java.txt"),
            &[][..],
        ),
    ];
    // 便携版常见的几个位置
    configs.push((
        PathBuf::from(&appdata)
            .join(".minecraft")
            .join("PCL")
            .join("config.json"),
        &["JavaList", "Folder"][..],
    ));

    for (file, _hint) in configs {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        if file.extension().map(|e| e == "txt").unwrap_or(false) {
            for line in text.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    let exe = java_exe_in(Path::new(line));
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        walk_json_for_java_dirs(&v, &mut out, 0);
    }
    out
}

#[cfg(not(windows))]
fn other_launcher_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// 在 JSON 里找形如 `"C:\\...\\bin\\"`（或 `...\\bin`）的字符串。
///
/// 刻意**不写死字段名**：PCL 的字段（`JavaList[].Folder`）在版本之间改过名，
/// 而"以 `bin` 结尾的路径"这件事本身就是判据 —— 认它比认字段名耐用。
fn walk_json_for_java_dirs(v: &serde_json::Value, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 {
        return;
    }
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.len() < 4 {
                return;
            }
            let looks_like_bin = t
                .trim_end_matches(['\\', '/'])
                .to_lowercase()
                .ends_with("\\bin")
                || t.to_lowercase().ends_with("/bin");
            if !looks_like_bin {
                return;
            }
            let dir = PathBuf::from(t);
            let exe = dir.join(if cfg!(windows) { "java.exe" } else { "java" });
            if exe.is_file() {
                out.push(exe);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                walk_json_for_java_dirs(x, out, depth + 1);
            }
        }
        serde_json::Value::Object(o) => {
            for (_, x) in o {
                walk_json_for_java_dirs(x, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// 根目录浅扫描：`C:\jdk25\jdk-25.0.3+9`、`D:\java\jdk-21` 这种手装布局。
///
/// ★ 实测本机就有一个：`JAVA_HOME` 指向 `C:\jdk25\jdk-25.0.3+9`。
///   深度限制 3 层 —— 再深就不是"用户手装的 JDK"，而是某个软件自带的运行时，
///   扫进来只会让列表变脏。
#[cfg(windows)]
fn shallow_drive_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let drives: Vec<String> = ('C'..='Z')
        .map(|c| format!("{c}:\\"))
        .filter(|d| Path::new(d).is_dir())
        .collect();
    for drive in drives {
        let Ok(entries) = std::fs::read_dir(&drive) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !looks_like_java_dir(&name) {
                continue;
            }
            // 这一层可能直接就是 JAVA_HOME，也可能再套一层（`C:\jdk25\jdk-25.0.3+9`）
            let direct = java_exe_in(&e.path());
            if direct.is_file() {
                out.push(direct);
            }
            if let Ok(inner) = std::fs::read_dir(e.path()) {
                for i in inner.flatten() {
                    let exe = java_exe_in(&i.path());
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn shallow_drive_javas() -> Vec<PathBuf> {
    Vec::new()
}

fn looks_like_java_dir(name: &str) -> bool {
    const KEYS: [&str; 14] = [
        "jdk", "jre", "java", "adoptium", "temurin", "zulu", "corretto", "graal", "liberica",
        "semeru", "bellsoft", "openjdk", "microsoft-jdk", "dragonwell",
    ];
    KEYS.iter().any(|k| name.contains(k))
}

fn common_java_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        vec![
            PathBuf::from(r"C:\Program Files\Eclipse Adoptium"),
            PathBuf::from(r"C:\Program Files\Java"),
            PathBuf::from(r"C:\Program Files\Zulu"),
            PathBuf::from(r"C:\Program Files\Microsoft"),
            PathBuf::from(r"C:\Program Files\BellSoft"),
            PathBuf::from(r"C:\Program Files (x86)\Java"),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("/Library/Java/JavaVirtualMachines")]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/usr/java"),
        ]
    }
}

fn java_exe_in(dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "java.exe" } else { "java" };
    // 常见布局：<root>/bin/java、<root>/jre/bin/java、<root>/Contents/Home/bin/java
    let candidates = [
        dir.join("bin").join(name),
        dir.join("jre").join("bin").join(name),
        dir.join("Contents").join("Home").join("bin").join(name),
    ];
    for c in &candidates {
        if c.is_file() {
            return c.clone();
        }
    }
    candidates[0].clone()
}

/// 跑 `java -version` 读出真实版本信息。
/// 探测失败返回 None —— 宁可少列一个，也不列一个用不了的。
fn probe_java(exe: &Path, source: &str) -> Option<JavaRuntime> {
    if !exe.is_file() {
        return None;
    }

    let mut cmd = std::process::Command::new(exe);
    cmd.arg("-version");
    // ★ 不弹黑框（唯一入口，见上面的 `hide_console`）
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    // java -version 把版本写到 stderr
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);

    let (version, major) = parse_java_version(&text)?;
    let vendor = detect_vendor(&text, exe);
    // 官方 Oracle JDK 在启动器里默认禁用（授权限制）—— 必须在 move 之前算出来
    let disabled_by_default = vendor.contains("Oracle");

    Some(JavaRuntime {
        path: exe.to_string_lossy().to_string(),
        major,
        version,
        vendor,
        arch: std::env::consts::ARCH.to_string(),
        source: source.to_string(),
        disabled_by_default,
        bytes: dir_size(exe.parent().and_then(|p| p.parent()).unwrap_or(Path::new("."))),
    })
}

/// 从 `java -version` 的输出里解析版本号。
/// 形如：openjdk version "17.0.10" 2024-01-16 / java version "1.8.0_402"
pub fn parse_java_version(text: &str) -> Option<(String, u32)> {
    let re = regex::Regex::new(r#"version "([^"]+)""#).ok()?;
    let caps = re.captures(text)?;
    let raw = caps.get(1)?.as_str().to_string();

    // 1.8.0_402 → 8 ; 17.0.10 → 17 ; 21 → 21
    let mut parts = raw.split(['.', '_', '-']);
    let first: u32 = parts.next()?.parse().ok()?;
    let major = if first == 1 {
        parts.next()?.parse().ok()?
    } else {
        first
    };
    Some((raw, major))
}

fn detect_vendor(text: &str, exe: &Path) -> String {
    let lower = text.to_lowercase();
    let path_lower = exe.to_string_lossy().to_lowercase();
    let mut hay = format!("{lower} {path_lower}");

    /*
     * ★★ 老 JRE 的 `java -version` 输出里**没有厂商信息**。
     *
     *   实测（本机 `%APPDATA%\.minecraft\runtime\jre-legacy\bin\java.exe`）：
     *   `java version "1.8.0_51"` 一行，前两行是 `java version` + `Java(TM) SE
     *   Runtime Environment`。于是路径里也没有 "oracle" 字样时就会落到
     *   "未知厂商"。
     *
     *   为什么这不只是"显示不好看"：`disabled_by_default` 判的是
     *   `vendor.contains("Oracle")` —— Oracle 的 JDK 因授权限制默认禁用。
     *   识别不出厂商，一个装在自选目录（`D:\java\jdk-8u401`）的 Oracle JDK
     *   就会被**当成普通 Java 正常使用**，用户可能莫名其妙吃授权问题。
     *
     *   可靠得多的办法：JDK 9+ 与 Mojang 的运行时都在版本目录里放一个
     *   `release` 文件，里面写着 `JAVA_VENDOR="Oracle Corporation"` 这类事实。
     *   它是**盘上的证据**，比字符串猜谜准。
     */
    if let Some(home) = exe.parent().and_then(|p| p.parent()) {
        if let Ok(release) = std::fs::read_to_string(home.join("release")) {
            hay.push(' ');
            hay.push_str(&release.to_lowercase());
        }
        // 老 JRE 没有 release 文件，但 `lib/rt.jar` 的时代有 COPYRIGHT
        if let Ok(c) = std::fs::read_to_string(home.join("COPYRIGHT")) {
            let head: String = c.chars().take(600).collect();
            hay.push(' ');
            hay.push_str(&head.to_lowercase());
        }
    }

    if hay.contains("temurin") || hay.contains("adoptium") {
        "Temurin".into()
    } else if hay.contains("zulu") || hay.contains("azul") {
        "Zulu".into()
    } else if hay.contains("oracle") {
        "Oracle".into()
    } else if hay.contains("microsoft") {
        "Microsoft".into()
    } else if hay.contains("liberica") || hay.contains("bellsoft") {
        "Liberica".into()
    } else if hay.contains("graalvm") || hay.contains("graal") {
        "GraalVM".into()
    } else if hay.contains("corretto") || hay.contains("amazon") {
        "Corretto".into()
    } else if hay.contains("semeru") || hay.contains("ibm") {
        "Semeru".into()
    } else if hay.contains("openjdk") {
        "OpenJDK".into()
    } else {
        "未知厂商".into()
    }
}

fn push_unique(list: &mut Vec<JavaRuntime>, rt: JavaRuntime) {
    if !list.iter().any(|x| x.path == rt.path) {
        list.push(rt);
    }
}
/// 目录占用（用于让用户看到"自动下载的 Java 占了多大"）
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in entries.flatten() {
        let p = e.path();
        if let Ok(meta) = e.metadata() {
            if meta.is_dir() {
                total += dir_size(&p);
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * ★★★★ 2026-09-30（用户）：「**删掉启动器的版本，资源管理器里的文件夹不会删除**」
     *   与「删除版本后，重启启动器，删除的版本又会回来」。
     *
     *   这一条钉住的是那个缺陷在**文件系统层面**的成因：把老 `instances/`
     *   并进 `versions/` 的那一步（`copy_tree_rule_skip`）**必须认墓碑** ——
     *   用户删过的版本目录名，一个字节都不能搬回来。
     *
     *   ★ 为什么必须有一条测试：这个缺陷**反复出现过三次**
     *     （补认记录、前端自动认领、合并文件），前两次我都是"改了那一处就以为好了"。
     *     判据散在多处时，只有测试能把"每一处都得认墓碑"这件事钉死。
     */
    #[test]
    fn 合并老目录时不许把墓碑里的版本搬回来() {
        let tmp = std::env::temp_dir().join(format!("ieml-merge-buried-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let from = tmp.join("instances");
        let to = tmp.join("versions");
        std::fs::create_dir_all(from.join("26.3-fabric-0.19.5-2")).unwrap();
        std::fs::write(from.join("26.3-fabric-0.19.5-2").join("options.txt"), b"x").unwrap();
        std::fs::create_dir_all(from.join("vanilla-262")).unwrap();
        std::fs::write(from.join("vanilla-262").join("options.txt"), b"y").unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let buried: std::collections::HashSet<String> =
            ["26.3-fabric-0.19.5-2".to_string()].into_iter().collect();
        copy_tree_rule_skip(&from, &to, true, &buried, 0).unwrap();

        assert!(
            !to.join("26.3-fabric-0.19.5-2").exists(),
            "★ 用户删过的版本被搬回来了 —— 这正是「诈尸」在文件系统层面的样子"
        );
        assert!(
            to.join("vanilla-262").join("options.txt").is_file(),
            "没被删过的版本必须照常搬过来（过滤不能误伤）"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// ★★★★ 2026-10-01（用户）：「**这些不可用版本，删除后，在重启启动器后会复活**」。
    ///
    ///   真机证据把成因钉死了：`%APPDATA%\IEML\instances\`（**老数据根**）里躺着
    ///   `vanilla-1122`（11 个 natives dll）与 `vanilla-262`（26 个）——
    ///   与盘上"复活"出来的内容**一字不差**，而盘上那两份的创建时间
    ///   正是每次启动的时刻。⇒ 它们是 `migrate_data_root` 从老根合并回来的。
    ///
    ///   这条测试钉住两件事（缺一不可）：
    ///     ① **老根里的版本会被搬过来** —— 这是那个功能本身，不能被修坏
    ///        （换过数据根的人靠它找回版本）；
    ///     ② 用户**删过之后**（墓碑里有名字）再启动 —— **不许再搬回来**。
    ///
    ///   ★ 为什么 ① 必须写进来：这一段的"阀门"（一次性标记）是**新增**的，
    ///     而我最容易犯的错就是"加了阀门把功能一起关掉，然后测试全绿"。
    ///     ——这个仓库为此栽过：那次 `retain` 把**所有**实例都滤掉了，
    ///     而"同步成功（1 → 0）"那条判据看起来特别漂亮。
    #[test]
    fn 换数据根时删过的版本不许被老根搬回来() {
        let tmp = std::env::temp_dir().join(format!("ieml-root-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let old = tmp.join("old");
        let new = tmp.join("new");
        let old_instances = old.join(LEGACY_INSTANCES_NAME);
        let dest = new.join(GAME_DIR_NAME).join(VERSIONS_DIR_NAME);

        // 老根里有一个**没有被删过**的版本（它必须能搬过来）
        std::fs::create_dir_all(old_instances.join("keep-me").join("natives")).unwrap();
        std::fs::write(old_instances.join("keep-me").join("natives").join("a.dll"), b"x").unwrap();
        std::fs::create_dir_all(new.join(GAME_DIR_NAME)).unwrap();

        let copied = migrate_data_root(&old, &new).expect("第一次搬家");
        assert!(copied > 0, "老根里的版本必须被搬过来");
        assert!(
            dest.join("keep-me").join("natives").join("a.dll").is_file(),
            "★ 没被删过的版本要照常搬（防止我把这个功能一起修坏）"
        );

        /*
         * 用户把它删了 —— 磁盘上那一份没了，而**老根那一份仍然留着**
         * （真机就是这样：`%APPDATA%\IEML\instances\vanilla-1122` 一直躺在盘上，
         *  `migrate_data_root` 的注释也写着"源目录原样留着，用户自己删"）。
         */
        std::fs::remove_dir_all(dest.join("keep-me")).unwrap();
        assert!(!dest.join("keep-me").exists(), "删干净了才继续");

        /*
         * 再启动一次（第二次搬家）。
         *
         * ★ 这一刻状态正是"复活"的条件：**目的地没有、老根里有**。
         *   旧代码在这里会把它原样复制回来 —— 用户看到的就是
         *   「删除后，重启启动器又复活」，而且创建时间是每次启动的时刻。
         */
        migrate_data_root(&old, &new).expect("第二次搬家");

        assert!(
            !dest.join("keep-me").exists(),
            "★★ 删掉之后又被老数据根搬回来了 —— 这就是「重启启动器后复活」。\
             真机上它长这样：`vanilla-1122`（11 个 natives dll）不停地回来，\
             创建时间是每次启动的时刻。"
        );
        /*
         * ★ 这里靠的是"**真的搬过东西才写、写了就不再搬**"那枚一次性标记。
         *   墓碑是**更内层**的保护（`merge_instances_by_mtime` 认它），
         *   由 `合并老目录时不许把墓碑里的版本搬回来` 那条测试钉着 ——
         *   两条合起来才是完整的判据：
         *     · 墓碑：**用户删过的**不搬（判据是用户意图）；
         *     · 标记：**搬过一轮之后**不再重搬（判据是"这个动作是迁移，不是同步"）。
         *   只有前者的话，没进墓碑的目录每次启动都会被比一遍；
         *   只有后者的话，迁移那一轮就会把删过的搬回来。
         */
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 跳过名单**只在顶层**生效：版本目录内部同名的子目录不该被误伤
    #[test]
    fn 墓碑只拦顶层不拦版本目录里面的同名子目录() {

        let tmp = std::env::temp_dir().join(format!("ieml-merge-depth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let from = tmp.join("instances");
        let to = tmp.join("versions");
        // 深层的 mods/ 下有个与墓碑同名的目录（真实形状：`mods/1.12.2/`）
        std::fs::create_dir_all(from.join("keep").join("mods").join("buried")).unwrap();
        std::fs::write(
            from.join("keep").join("mods").join("buried").join("m.jar"),
            b"jar",
        )
        .unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let buried: std::collections::HashSet<String> =
            ["buried".to_string()].into_iter().collect();
        copy_tree_rule_skip(&from, &to, true, &buried, 0).unwrap();

        assert!(
            to.join("keep").join("mods").join("buried").join("m.jar").is_file(),
            "★ 深层的同名目录被误伤了 —— 跳过名单只能作用在顶层"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /*
     * ★★★★ 2026-09-30（用户）：「**删掉启动器的版本，资源管理器里的文件夹不会删除**」。
     *
     *   成因是删除命令的目标指错了：它用的是 `instance_dir(slug)`，
     *   而那返回的是 **`<版本目录>/.ieml/`**（启动器自己那层：natives、打包记录）。
     *   于是"删除这个版本"只删掉了启动器那点文件，**版本目录连同存档与 Mod 一个都没删**。
     *
     *   ⇒ 目标必须是 `instance_root_dir(slug)`（= `<版本目录>` 本身）。
     *     这条测试把两者的关系钉住 —— 它不是"两个名字"，而是**父子目录**。
     */
    #[test]
    fn 删除版本要删的是版本目录本身_不是它里面的启动器子目录() {
        let tmp = std::env::temp_dir().join(format!("ieml-del-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".minecraft").join("versions")).unwrap();
        // ★ 用 `from_root` 而不是手写结构体：手写会在加字段时静静过期
        let p = AppPaths::from_root(tmp.clone());
        let version_dir = p.instance_root_dir("26.3-fabric-0.19.5");
        let launcher_dir = p.instance_dir("26.3-fabric-0.19.5");
        assert_eq!(
            version_dir,
            p.instances.join("26.3-fabric-0.19.5"),
            "版本目录必须在 versions/ 下面"
        );
        assert_eq!(
            launcher_dir,
            version_dir.join(".ieml"),
            "启动器目录是版本目录的子目录"
        );
        assert_ne!(
            version_dir, launcher_dir,
            "★ 这两个要是相等，删除版本就会把启动器目录当成整个版本 —— 那正是用户报的缺陷"
        );
        assert!(
            launcher_dir.starts_with(&version_dir),
            "★ 删版本必须删外层那一个：删里面那层等于什么都没删（存档与 Mod 都留着）"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /*
     * ★★ 2026-09-23（用户第 5 条：「如果选中版本没有 mod 文件夹，**创建文件夹并放入**，
     *   避免下载到"虚空"里；如果选择**原版**也得这样，即使不可运行」）：
     *
     *   这条保障**本来就在**（`install_resource` 里那句 `create_dir_all`），
     *   但以前**没有判据钉住它** —— 谁把那句删了、或者把路径算错一层，
     *   表现就是"装完找不到文件"（用户说的"下到虚空里"），**而且不报错**。
     *
     *   所以这里验两件事，对**每一种资源**都验一遍：
     *     ① 目录**能**被建出来（调用前断言它不存在，否则测不出"生不生成"）；
     *     ② 路径形状是 `<实例>/game/<install_dir>` —— 游戏的工作目录就是 `game/`，
     *        资源必须落在**它下面**才读得到。
     *   ★ 「原版也得这样」在这里自然成立：资源目录只与**实例**有关、
     *     与实例有没有加载器无关 —— 这条测试里的实例根本没有加载器。
     */
    #[test]
    fn 装资源前目录必须建出来() {
        use crate::domain::resources::ResourceKind;

        let tmp = std::env::temp_dir().join(format!("ieml-resdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);

        let paths = AppPaths {
            root: tmp.clone(),
            own_root: tmp.clone(),
            shared: tmp.join(".minecraft"),
            instances: tmp.join(".minecraft").join("versions"),
            java: tmp.join("java"),
            cache: tmp.join("cache"),
            logs: tmp.join("logs"),
        };

        for kind in ResourceKind::ALL {
            let dir = paths.instance_resource_dir("demo", kind);
            if kind == ResourceKind::Modpack {
                assert_eq!(kind.install_dir(), "", "整合包不该有资源目录");
                continue;
            }
            assert!(
                !dir.exists(),
                "{kind:?} 的目录在调用前不该存在（这才测得出生不生成）"
            );
            std::fs::create_dir_all(&dir).expect("创建资源目录");
            assert!(dir.is_dir(), "{kind:?} 的目录应当被建出来：{}", dir.display());
            assert!(
                dir.ends_with(kind.install_dir()),
                "{kind:?} 的目录应当在 <版本目录>/（游戏工作目录）下：{}",
                dir.display()
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /*
     * ★★ 2026-09-22（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」）：
     *   选定新根目录时**只建 `.minecraft`**（游戏那一边），
     *   启动器自己的目录由 `ensure_own()` 懒建。
     *
     *   ★ 这里直接测 `AppPaths::ensure()` 的形状（不碰 `set_data_root` ——
     *     它会写真实的 datadir.txt，跑一次单测就改掉开发机的记录）。
     *     临时目录里的断言：根目录下**只有游戏那边的 `.minecraft`**，
     *     不该冒出 java / cache / logs / shared，**也不该再有 `instances/`**
     *     （2026-09-30 起版本目录在 `.minecraft/versions/` 里，见
     *      `AppPaths::instances`）。
     */
    #[test]
    fn ensure_只建游戏目录_不建启动器目录() {
        let tmp = std::env::temp_dir().join(format!("ieml-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("建临时目录");

        // 用 AppPaths 的字段直接拼一份（不 resolve，避免读到开发机的真实配置）
        // ★ 注意 `shared` 的**位置**就是 `.minecraft`（字段名是历史遗留，见它的文档注释）
        // ★ 2026-09-23：java / cache / logs 挂在 `own_root`（另一个临时目录）——
        //   这条测试仍然要断言"**游戏根目录里不出现它们**"。
        // ★ 2026-09-30：`instances` 现在**在 `.minecraft` 里面**（`versions/`）——
        //   它属于游戏那一边，但要建在游戏目录**内部**，不是游戏根目录下。
        let own = std::env::temp_dir().join(format!("ieml-own-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&own);
        let paths = AppPaths {
            root: tmp.clone(),
            own_root: own.clone(),
            shared: tmp.join(".minecraft"),
            instances: tmp.join(".minecraft").join("versions"),
            java: own.join("java"),
            cache: own.join("cache"),
            logs: own.join("logs"),
        };

        paths.ensure().expect("ensure 应当成功");

        let names: Vec<String> = std::fs::read_dir(&tmp)
            .expect("读临时目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n == ".minecraft"),
            "应当建出游戏目录 .minecraft，实际：{names:?}"
        );
        assert!(
            paths.instances.is_dir(),
            "版本目录应当被建出来：{}",
            paths.instances.display()
        );
        for bad in ["shared", "java", "cache", "logs", "instances"] {
            assert!(
                !names.iter().any(|n| n == bad),
                "不该在根目录建 {bad}，实际：{names:?}"
            );
        }
        // ★ 版本目录必须在 `.minecraft` **里面**，与 PCL 同款
        assert!(
            paths.instances.starts_with(tmp.join(".minecraft")),
            "版本目录应当在 .minecraft 里：{}",
            paths.instances.display()
        );

        // `ensure_own()` 才是建启动器目录的那一个
        // ★ 列表里**没有 `shared`** —— 它的位置就是 `.minecraft`（上面已经建过了）
        // ★ 2026-09-23：它们建在 **own_root** 下，不再在游戏根目录里
        // ★ 2026-09-30：也没有 `instances` —— 它在 `.minecraft/versions`，由 `ensure()` 建
        paths.ensure_own().expect("ensure_own 应当成功");
        for want in ["java", "cache", "logs"] {
            assert!(own.join(want).is_dir(), "ensure_own 之后应当在 own_root 下有 {want}");
            assert!(
                !tmp.join(want).exists(),
                "**游戏根目录里不该出现**启动器目录 {want}"
            );
        }
        assert!(
            !own.join("instances").exists(),
            "own_root 里**不该**出现 instances —— 它跟着游戏数据走（在 .minecraft/versions）"
        );

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&own);
    }

    /*
     * ★★ 换数据根目录的判据（2026-09-17 用户要求"单独建一个根目录，源目录不删"）。
     *
     *   测的是 `validate_data_root`（纯校验）而**不是** `set_data_root` ——
     *   后者成功时会写真实的 `datadir.txt`，跑一次单测就会把开发机的
     *   数据目录记录改掉。所以副作用那一步不在这里测。
     */
    #[test]
    fn data_root_rejects_empty_and_relative() {
        let cur = PathBuf::from(r"D:\IEML");
        assert!(validate_data_root(Path::new(""), &cur).is_err(), "空路径该拒");
        assert!(
            validate_data_root(Path::new(r"newdata"), &cur).is_err(),
            "相对路径该拒（相对谁？没有意义）"
        );
    }

    #[test]
    fn data_root_rejects_same_path_even_with_trailing_slash() {
        let cur = PathBuf::from(r"D:\IEML");
        assert!(validate_data_root(Path::new(r"D:\IEML"), &cur).is_err(), "同一个该拒");
        assert!(
            validate_data_root(Path::new(r"D:\IEML\"), &cur).is_err(),
            "只差一个反斜杠也是同一个地方，不该当成「变了」"
        );
    }

    #[test]
    fn data_root_rejects_nesting_in_both_directions() {
        let cur = PathBuf::from(r"D:\IEML");
        let inside = PathBuf::from(r"D:\IEML\sub");
        assert!(
            validate_data_root(&inside, &cur).is_err(),
            "数据目录套数据目录：扫描与清理会把彼此当内容"
        );
        let outside = PathBuf::from(r"D:\");
        assert!(
            validate_data_root(&outside, &cur).is_err(),
            "反过来也不行：当前目录在目标里面"
        );
    }

    #[test]
    fn data_root_accepts_a_writable_temp_dir() {
        let cur = PathBuf::from(r"D:\IEML");
        // 必须是个真的能建的临时目录 —— 校验里那一步会试写
        let tmp = std::env::temp_dir().join(format!("ieml-dataroot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let r = validate_data_root(&tmp, &cur);
        assert!(r.is_ok(), "能建能写的目录该通过，实际：{r:?}");
        // 校验会顺便把目录建出来（试写探针需要），这里收干净
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn volume_list_is_self_consistent() {
        let vols = list_volumes(Path::new(r"D:\IEML"));
        if vols.is_empty() {
            return; // 非 Windows：这个列表本来就是空的
        }
        for v in &vols {
            assert!(
                v.suggested.starts_with(&v.path),
                "建议目录必须在这块盘里：{} vs {}",
                v.suggested,
                v.path
            );
            assert!(
                v.suggested.ends_with(DATA_DIR_NAME),
                "目录名必须来自 DATA_DIR_NAME（前端不许自己拼）：{}",
                v.suggested
            );
            assert!(v.free_gb <= v.total_gb + 0.1, "剩余不可能大于总量：{v:?}");
        }
        // 非系统盘要排在系统盘前面 —— 除非机器上只有系统盘
        assert!(
            !vols[0].is_system || vols.iter().all(|v| v.is_system),
            "系统盘不该排在最前（默认选址刻意躲开它）：{vols:?}"
        );
    }

    /// ★ "现在用的目录在哪块盘上"必须**恰好命中一块** ——
    ///   命中 0 块（界面上一片"正在用"都没有）或命中 2 块（两块都说正在用）
    ///   都是那种"看起来只是显示问题"、实际会让用户选错盘的错。
    #[test]
    fn exactly_one_volume_is_the_suggested_one_of_the_current_root() {
        let vols = list_volumes(Path::new(r"D:\IEML"));
        if vols.is_empty() {
            return;
        }
        let probe = PathBuf::from(&vols[0].suggested);
        let marked = list_volumes(&probe);
        let cur: Vec<&VolumeInfo> = marked.iter().filter(|v| v.is_current).collect();
        assert_eq!(cur.len(), 1, "当前那一行必须恰好标出一块：{marked:?}");
        assert_eq!(cur[0].path, vols[0].path);
        assert!(cur[0].on_current_drive);
    }

    /// ★★ 用户在 D: 上选了一个**自定义目录**（`D:\测试目录`）时：
    ///   建议行（`D:\IEML`）**不能**被标成"正在用" —— 否则那一行的按钮会被禁用，
    ///   玩家就换不回 `D:\IEML` 了（2026-09-20 用户真踩到：他换成了 `D:\测试目录`）。
    #[test]
    fn a_custom_folder_does_not_disable_the_whole_drive() {
        let custom = Path::new(r"D:\__ieml_test_custom__");
        let vols = list_volumes(custom);
        if vols.is_empty() {
            return;
        }
        assert!(
            vols.iter().all(|v| !v.is_current),
            "建议目录都不是现在用的那个，谁都不该标『正在用』：{vols:?}"
        );
        let on_same_drive = vols.iter().find(|v| custom.starts_with(&v.path));
        if let Some(v) = on_same_drive {
            assert!(v.on_current_drive, "同一块盘要认出来：{v:?}");
        }
    }

    #[test]
    fn same_path_ignores_case_and_trailing_separator() {
        assert!(same_path(Path::new(r"D:\IEML"), Path::new(r"d:\ieml\")));
        assert!(!same_path(Path::new(r"D:\IEML"), Path::new(r"D:\IEML2")));
        assert!(!same_path(Path::new(""), Path::new("")));
    }

    /* ---------- 「用过的游戏文件夹」列表（PCL 那种） ---------- */

    /// ★ 这些测试**一律用临时文件**，绝不碰 `%APPDATA%\IEML\known-roots.json` ——
    ///   与 `data_root_accepts_a_writable_temp_dir` 是同一条规矩：
    ///   单测不许改开发机的真实状态。
    fn tmp_roots_file(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-known-roots-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d.join("known-roots.json")
    }

    #[test]
    fn known_roots_dedupe_and_move_to_front() {
        let f = tmp_roots_file("dedupe");
        let _ = std::fs::remove_file(&f);

        remember_root_at(&f, Path::new(r"D:\IEML"));
        remember_root_at(&f, Path::new(r"E:\IEML"));
        // ★ 同一个地方的不同写法（大小写 + 末尾分隔符）**不许**变成两条
        remember_root_at(&f, Path::new(r"d:\ieml\"));

        let got = load_known_roots_from(&f);
        assert_eq!(got.len(), 2, "应该只剩两条：{got:?}");
        assert_eq!(got[0], PathBuf::from(r"d:\ieml\"), "最近用过的排最前");
        assert_eq!(got[1], PathBuf::from(r"E:\IEML"));

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    #[test]
    fn known_roots_are_capped_and_forgettable() {
        let f = tmp_roots_file("cap");
        let _ = std::fs::remove_file(&f);
        for i in 0..(MAX_KNOWN_ROOTS + 5) {
            remember_root_at(&f, Path::new(&format!(r"D:\ieml-{i}")));
        }
        assert_eq!(load_known_roots_from(&f).len(), MAX_KNOWN_ROOTS, "有上限");

        forget_root_at(&f, Path::new(r"D:\ieml-24"));
        assert!(
            !load_known_roots_from(&f)
                .iter()
                .any(|p| p == Path::new(r"D:\ieml-24")),
            "移除之后就没了"
        );

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    /// ★ **坏文件不许拦启动**：这个文件只是"便利"，不是数据。
    #[test]
    fn a_corrupt_roots_file_is_treated_as_empty() {
        let f = tmp_roots_file("corrupt");
        std::fs::write(&f, b"{ this is not json").unwrap();
        assert!(load_known_roots_from(&f).is_empty());

        // 而且还能被重新写回一份好的
        remember_root_at(&f, Path::new(r"D:\IEML"));
        assert_eq!(load_known_roots_from(&f).len(), 1);

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    /// 列表里**当前那个排最前**、名字取最后一段、盘根目录不 panic。
    #[test]
    fn list_marks_the_current_root_first_with_a_readable_name() {
        let custom = PathBuf::from(r"D:\__ieml_list_test__");
        let list = list_known_roots(&custom);
        assert!(!list.is_empty(), "至少要有当前这一条");
        assert!(list[0].is_current, "当前那个必须排最前：{list:?}");
        assert_eq!(list[0].name, "__ieml_list_test__", "名字取路径最后一段");
        assert_eq!(list[0].source, "current", "当前那条的来源是 current");
        // 同一个路径不许出现两次（同一路径只该有一行）
        let same = list
            .iter()
            .filter(|r| same_path(Path::new(&r.path), &custom))
            .count();
        assert_eq!(same, 1, "同一路径只该有一行：{list:?}");
    }

    /// ★★ 2026-09-26（用户截图）：那张表**只显示玩家自己选过的目录**。
    ///
    ///   用户原话：「改成默认只显示玩家安装时选择的那盘的游戏目录文件夹，
    ///   当玩家新建一个新的游戏目录文件夹时，新的文件夹会出现在这个栏里，**其余的不要**」。
    ///
    ///   这条判据守的是**"不许再自己发现目录"**：以前的实现会扫一遍盘，
    ///   把 `<盘>\IEML` 里**确实存在的**都列出来（来源标记 `found`）——
    ///   于是玩家看到一堆他没选过的行（截图里 `E:\IEML` 就是）。
    ///   ⇒ 现在的契约是：**进来什么候选，就只显示什么**。
    #[test]
    fn the_list_only_shows_what_the_player_chose() {
        let current = PathBuf::from(r"D:\玩家选的目录");
        // 造两个候选：一个是"玩家选过的"，一个是"盘上碰巧存在的"（模拟旧行为会自己塞进来的东西）
        let chosen = PathBuf::from(r"D:\玩家选过的旧目录");
        let not_chosen = PathBuf::from(r"E:\IEML");

        let list = merge_root_candidates(&current, vec![chosen.clone()]);

        assert_eq!(list.len(), 2, "只该有当前 + 玩家选过的那两条：{list:?}");
        assert!(list[0].is_current, "当前那个排最前");
        assert_eq!(list[0].source, "current");
        assert_eq!(list[1].path, chosen.to_string_lossy());
        assert_eq!(list[1].source, "known");
        assert!(
            !list.iter().any(|r| same_path(Path::new(&r.path), &not_chosen)),
            "没被选过的目录**不许**出现在表里：{list:?}"
        );
        assert!(
            !list.iter().any(|r| r.source == "found"),
            "`found` 这个来源已经被取消，不该再有人产出它：{list:?}"
        );
    }

    #[test]
    fn parse_modern_version() {
        let t = r#"openjdk version "17.0.10" 2024-01-16"#;
        assert_eq!(parse_java_version(t), Some(("17.0.10".into(), 17)));
    }

    #[test]
    fn parse_legacy_18_version() {
        let t = r#"java version "1.8.0_402""#;
        assert_eq!(parse_java_version(t), Some(("1.8.0_402".into(), 8)));
    }

    #[test]
    fn parse_major_only() {
        let t = r#"openjdk version "21" 2023-09-19"#;
        assert_eq!(parse_java_version(t), Some(("21".into(), 21)));
    }

    #[test]
    fn parse_garbage_returns_none() {
        assert_eq!(parse_java_version("no version here"), None);
    }

    /// ★★ 2026-09-20：这条断言**原来写的是** `p.root.to_string_lossy().contains("IEML")`
    ///   —— 那是错的，而且错得会咬人：
    ///
    ///   从「新建/切换游戏根目录」起（beta.46），玩家可以把数据目录设成**任意路径**；
    ///   beta.51 把入口做成"在启动器里选"之后，用户第一次试就把根目录换成了
    ///   `D:\测试目录` —— 于是 `cargo test --lib` 里这条**红给开发者看**，
    ///   而它判的其实是"用户做了一个合法的选择"。
    ///   （真事：这一轮 verify 就是这么红的。）
    ///
    ///   现在只断言真正该成立的事：**绝对路径**、且各子目录都挂在它下面。
    #[test]
    fn app_paths_shape() {
        let p = AppPaths::resolve();
        assert!(
            p.root.is_absolute(),
            "数据根目录必须是绝对路径：{}",
            p.root.display()
        );
        /*
         * ★★ 2026-09-23（用户确认「启动器自己的目录要搬出游戏根目录：是的」）：
         *   java / cache / logs 挂在 `own_root`（%APPDATA%\IEML）。
         *
         * ★★ 2026-09-24（用户：「我在用 D 盘的目录，为什么版本列表的版本给我定位到
         *   `C:\Users\…\Roaming\IEML\instances` 了」）：
         *   **实例目录回到游戏那一侧**（存档 / Mod 是游戏数据，跟着用户挑的盘走）。
         *
         * ★★ 2026-09-30（布局规范化）：实例目录不再是一个独立的 `instances/`，
         *   而是 `.minecraft/versions/`（= PCL 的版本目录）—— 于是它既在游戏根
         *   目录下，也在 `.minecraft` 里：一个版本只有一个文件夹。
         */
        assert!(
            p.own_root.is_absolute(),
            "启动器数据目录必须是绝对路径：{}",
            p.own_root.display()
        );
        assert!(
            p.instances.starts_with(&p.root),
            "版本目录必须在**游戏根目录**下：{:?}（root={:?}）",
            p.instances,
            p.root
        );
        assert!(
            p.instances.starts_with(p.game_dir()),
            "版本目录必须在 `.minecraft` **里面**（PCL 同款）：{:?}",
            p.instances
        );
        assert!(
            !p.instances.starts_with(&p.own_root),
            "版本目录**不该**在启动器数据目录里：{:?}",
            p.instances
        );
        assert!(
            p.instances.ends_with("versions"),
            "版本目录的名字必须是 versions：{:?}",
            p.instances
        );
        // ★ 启动器自己的三样东西留在 own_root 里（与实例目录分开）
        for (name, dir) in [("java", &p.java), ("cache", &p.cache), ("logs", &p.logs)] {
            assert!(
                dir.starts_with(&p.own_root),
                "{name} 必须在启动器数据目录下：{dir:?}"
            );
            assert!(
                !dir.starts_with(&p.root),
                "{name} **不该**在游戏根目录里：{dir:?}"
            );
        }
        // ★ 游戏数据在数据根目录内的 `.minecraft`（PCL 同款布局）
        assert!(
            p.shared.ends_with(GAME_DIR_NAME),
            "游戏数据目录应该是 .minecraft：{:?}",
            p.shared
        );
        assert_eq!(p.shared.parent().unwrap(), p.root);
    }

    /* ---------- 游戏数据布局：shared/ → .minecraft/（0.1.0-beta.3） ---------- */

    /// 老布局（`shared/`）要**整体改名**成 `.minecraft/`，内容一个不少。
    #[test]
    fn legacy_shared_becomes_minecraft() {
        let root = tmp("layout1");
        std::fs::create_dir_all(root.join("shared").join("libraries")).unwrap();
        std::fs::write(root.join("shared").join("libraries").join("a.jar"), b"JAR").unwrap();

        let moved = migrate_shared_into_game_dir(&root).unwrap();
        assert!(moved.is_some(), "应该真的搬了");
        assert!(!root.join("shared").exists(), "旧目录应该已经不在了");
        assert_eq!(
            std::fs::read(root.join(".minecraft").join("libraries").join("a.jar")).unwrap(),
            b"JAR"
        );
    }

    /// ★ 目标是个**空壳目录**时也要搬。
    ///
    ///   `AppPaths::ensure()` 每次启动都会把 `.minecraft/` 建出来，所以"空壳"
    ///   是常态。如果不处理它，迁移就永远不会发生 —— 而日志还会说"不用搬"。
    #[test]
    fn empty_shell_is_replaced_by_the_legacy_dir() {
        let root = tmp("layout2");
        std::fs::create_dir_all(root.join("shared").join("assets")).unwrap();
        std::fs::write(root.join("shared").join("assets").join("x.bin"), b"X").unwrap();
        std::fs::create_dir_all(root.join(".minecraft")).unwrap(); // ensure() 建的空壳

        let moved = migrate_shared_into_game_dir(&root).unwrap();
        assert!(moved.is_some(), "空壳不算数，应该照搬");
        assert!(root.join(".minecraft").join("assets").join("x.bin").is_file());
    }

    /// ★ 目标里**已经有东西** → 一个字节都不动（用户的 `shared/` 可能是别的东西）。
    #[test]
    fn non_empty_minecraft_is_never_touched() {
        let root = tmp("layout3");
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("shared").join("old.txt"), b"OLD").unwrap();
        std::fs::create_dir_all(root.join(".minecraft")).unwrap();
        std::fs::write(root.join(".minecraft").join("new.txt"), b"NEW").unwrap();

        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(root.join("shared").join("old.txt").is_file(), "旧目录必须原样保留");
        assert_eq!(
            std::fs::read(root.join(".minecraft").join("new.txt")).unwrap(),
            b"NEW"
        );
    }

    /// 全新安装：两个都没有 → 什么都不做（不报错、不建目录）。
    #[test]
    fn fresh_install_does_nothing() {
        let root = tmp("layout4");
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(!root.join(".minecraft").exists());
    }

    /// 重复调用是安全的（第二次已经没有 `shared/` 了）。
    #[test]
    fn migration_is_idempotent() {
        let root = tmp("layout5");
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("shared").join("f.txt"), b"F").unwrap();
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_some());
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(root.join(".minecraft").join("f.txt").is_file());
    }

    /* ---------- 数据目录迁移：**绝不丢用户数据** ---------- */

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// ★★ 目标已有的文件**一个字节都不许动**。
    ///
    ///   这是"绝不丢用户数据"的第一条。目标那份是用户**当下正在用**的，
    ///   源那份是"以前那份" —— 任何情况下都该以目标为准。
    #[test]
    fn migration_never_overwrites_existing_destination_files() {
        let old = tmp("old1");
        let new = tmp("new1");

        // ★ 2026-09-30：实例目录的去处是 `<root>/.minecraft/versions`（PCL 布局）
        let vers = |root: &Path| root.join(GAME_DIR_NAME).join(VERSIONS_DIR_NAME);
        std::fs::create_dir_all(vers(&old)).unwrap();
        std::fs::create_dir_all(vers(&new)).unwrap();
        std::fs::write(vers(&old).join("a.txt"), "OLD").unwrap();
        std::fs::write(vers(&new).join("a.txt"), "NEW").unwrap();
        // 源里还有一个目标没有的文件 → 应该补过去
        std::fs::write(vers(&old).join("b.txt"), "ONLY-IN-OLD").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert_eq!(
            std::fs::read_to_string(vers(&new).join("a.txt")).unwrap(),
            "NEW",
            "★ 目标已有的文件被源覆盖了 —— 这就是丢用户数据"
        );
        assert_eq!(
            std::fs::read_to_string(vers(&new).join("b.txt")).unwrap(),
            "ONLY-IN-OLD",
            "目标缺的文件应该补齐"
        );
        // 源必须原样留着（只复制、绝不删源）
        assert!(vers(&old).join("a.txt").is_file());
        assert!(vers(&old).join("b.txt").is_file());
    }

    /// ★★ 目标的 `instances.json` 被写成了空列表、而源里有人 → 必须补回来。
    ///
    ///   这条是**实测事故**的回归测试：
    ///   某次启动后 `instances.json` 变成 `{"instances":[],"active_id":null}`，
    ///   用户建的三个版本从界面上消失了 —— 而老位置的文件明明还在。
    ///   当时这里只按"目标存在就跳过"处理，于是永远修不回来。
    #[test]
    fn migration_repairs_an_emptied_instance_list() {
        let old = tmp("old2");
        let new = tmp("new2");

        let three = r#"{"instances":[{"id":"a"},{"id":"b"},{"id":"c"}],"active_id":"a"}"#;
        std::fs::write(old.join("instances.json"), three).unwrap();
        // 目标被写坏了
        std::fs::write(new.join("instances.json"), r#"{"instances":[],"active_id":null}"#).unwrap();

        migrate_data_root(&old, &new).unwrap();

        let got = std::fs::read_to_string(new.join("instances.json")).unwrap();
        assert!(
            got.contains("\"id\": \"a\"") || got.contains("\"id\":\"a\""),
            "★ 被写空的实例列表没有补回来，实际内容：{got}"
        );
    }

    /// 反过来：目标里**有**用户自己的实例，源里也有别的 →
    /// **不许**用源的替换目标的（否则用户新装的版本会消失）。
    #[test]
    fn migration_does_not_replace_a_healthy_instance_list() {
        let old = tmp("old3");
        let new = tmp("new3");

        std::fs::write(old.join("instances.json"), r#"{"instances":[{"id":"old"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            new.join("instances.json"),
            r#"{"instances":[{"id":"mine-1"},{"id":"mine-2"}],"active_id":null}"#,
        )
        .unwrap();

        migrate_data_root(&old, &new).unwrap();

        let got = std::fs::read_to_string(new.join("instances.json")).unwrap();
        assert!(got.contains("mine-1"), "目标里的实例被源覆盖了：{got}");
        assert!(!got.contains("\"old\""), "源里那条不该被塞进来：{got}");
    }

    /// 目标完全不存在 → 源整份搬过去。
    #[test]
    fn migration_copies_everything_when_destination_is_empty() {
        let old = tmp("old4");
        let new = tmp("new4");

        std::fs::create_dir_all(old.join("shared").join("assets")).unwrap();
        std::fs::write(old.join("shared").join("assets").join("x.bin"), vec![7u8; 64]).unwrap();
        std::fs::create_dir_all(old.join("instances").join("saves")).unwrap();
        std::fs::write(old.join("instances").join("saves").join("level.dat"), b"save").unwrap();
        std::fs::write(old.join("instances.json"), r#"{"instances":[{"id":"z"}],"active_id":null}"#)
            .unwrap();

        let copied = migrate_data_root(&old, &new).unwrap();
        assert!(copied > 0, "应该真的复制了东西");
        // ★ 老根的 `shared/` 落到新根的 `.minecraft/`（布局在 0.1.0-beta.3 改过）
        assert!(new.join(GAME_DIR_NAME).join("assets").join("x.bin").is_file());
        // ★ 2026-09-30：老根的 `instances/` 落到新根的 `.minecraft/versions/`
        assert!(
            new.join(GAME_DIR_NAME)
                .join(VERSIONS_DIR_NAME)
                .join("saves")
                .join("level.dat")
                .is_file(),
            "老 instances/ 的存档应当落到 .minecraft/versions/ 下"
        );
        assert!(new.join("instances.json").is_file());
    }

    /// ★ 目标根**还停在老布局**（`shared/` 在）时，跨根补齐必须放进 `shared/`，
    ///   **绝不能**凭空造一个 `.minecraft/`。
    ///
    ///   这是 0.1.0-beta.3 实测踩到的真 bug 的回归测试：当时那一步把 C 盘的老数据
    ///   复制进了新根的 `.minecraft/`，而真数据还在 `shared/` —— 之后布局迁移
    ///   看到 `.minecraft` 有内容就跳过，用户会以为版本都丢了。
    #[test]
    fn migration_respects_the_destination_layout() {
        let old = tmp("old4c");
        let new = tmp("new4c");
        std::fs::create_dir_all(old.join(LEGACY_SHARED_NAME).join("assets")).unwrap();
        std::fs::write(
            old.join(LEGACY_SHARED_NAME).join("assets").join("legacy.bin"),
            vec![3u8; 16],
        )
        .unwrap();
        // 目标根**还在老布局**：有 shared/，没有 .minecraft/
        std::fs::create_dir_all(new.join(LEGACY_SHARED_NAME)).unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            new.join(LEGACY_SHARED_NAME).join("assets").join("legacy.bin").is_file(),
            "补齐应该落在目标当前的布局里（shared/）"
        );
        assert!(
            !new.join(GAME_DIR_NAME).exists(),
            "不许凭空造出一个 .minecraft/ —— 那会让真数据看起来不见了"
        );
    }

    /// 新根如果已经是新布局（`.minecraft/`），跨根搬家也要照搬，别再去找 `shared/`。
    #[test]
    fn migration_reads_the_new_layout_too() {
        let old = tmp("old4b");
        let new = tmp("new4b");
        std::fs::create_dir_all(old.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(
            old.join(GAME_DIR_NAME).join("libraries").join("y.jar"),
            vec![1u8; 32],
        )
        .unwrap();

        migrate_data_root(&old, &new).unwrap();
        assert!(new.join(GAME_DIR_NAME).join("libraries").join("y.jar").is_file());
    }

    /// 半截的下载残留不该跟着搬家（新位置会用新路径重下）。
    ///
    /// ★ 2026-09-24：例子从 `cache` 换成 `instances` —— 跨根搬家现在只搬
    ///   `instances`（启动器自己的 java/cache/logs 不再跟着搬，见 `migrate_data_root`），
    ///   而"半截文件不搬"这条规矩本身没变（实例里也有 `.part` 残留）。
    #[test]
    fn migration_skips_partial_downloads() {
        let old = tmp("old5");
        let new = tmp("new5");
        let vers = |root: &Path| root.join(GAME_DIR_NAME).join(VERSIONS_DIR_NAME);
        std::fs::create_dir_all(vers(&old)).unwrap();
        std::fs::write(vers(&old).join("a.jar.part.3"), b"junk").unwrap();
        std::fs::write(vers(&old).join("b.jar"), b"good").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            !vers(&new).join("a.jar.part.3").exists(),
            "半截的分片不该搬过去"
        );
        assert!(vers(&new).join("b.jar").is_file());
    }

    /// ★★ 2026-09-24：启动器自己的目录**不再被搬进新的游戏根目录**。
    ///
    ///   真机上量到过的后果：`%APPDATA%\IEML\cache`（1839 个文件 / 9.5 MB）
    ///   被复制进 `D:\IEML\cache`，而启动器只读 own_root 那份 ——
    ///   游戏盘白占一份，用户看到的就是"根目录里附带了一堆启动器文件"。
    #[test]
    fn migration_leaves_launcher_dirs_out_of_the_game_root() {
        let old = tmp("old6");
        let new = tmp("new6");
        for name in ["java", "cache", "logs"] {
            std::fs::create_dir_all(old.join(name)).unwrap();
            std::fs::write(old.join(name).join("x.bin"), b"launcher").unwrap();
        }
        std::fs::create_dir_all(old.join(LEGACY_INSTANCES_NAME)).unwrap();
        std::fs::write(old.join(LEGACY_INSTANCES_NAME).join("keep.bin"), b"game").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            new.join(GAME_DIR_NAME)
                .join(VERSIONS_DIR_NAME)
                .join("keep.bin")
                .is_file(),
            "游戏那一边的 instances 还是该搬（搬进 .minecraft/versions/）"
        );
        for name in ["java", "cache", "logs"] {
            assert!(
                !new.join(name).exists(),
                "启动器目录 {name} 不该被搬进游戏根目录：{}",
                new.join(name).display()
            );
        }
    }

    /// ★★ 2026-09-24：**实例目录里的同名文件按 mtime 判胜负** —— 而且只对实例目录。
    ///
    ///   为什么：实例目录放的是用户自己会改的东西（`options.txt` 的游戏内设置、
    ///   存档、Mod）。用户被"错位置"坑了的那两天里，**写进去的是老位置那一份**；
    ///   只按"目标已有就跳过"，他换回游戏盘之后今天的设置会被十几天前那份盖掉。
    ///
    ///   真机上的对照（`fabric-262`）：老位置 = 当天 14:01（`lang:zh_cn`），
    ///   游戏根 = 09-12（`lang:en_us`）。
    ///
    ///   ★ 反面的那一半也要钉住：`.minecraft` 里的同名文件**不按 mtime**
    ///     （库/jar 的 mtime 没有意义），继续"目标已有就跳过"。
    #[test]
    fn instances_migration_lets_the_newer_copy_win() {
        let old = tmp("old7");
        let new = tmp("new7");
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        /*
         * ★ 2026-09-30：源是**老布局**的 `<root>/instances/<slug>/game/`，
         *   目的地是**新布局**的 `<root>/.minecraft/versions/<slug>/`。
         *   于是这条测试同时钉住了三件事：游戏数据被提上来（不再有 `game/` 那层）、
         *   同名文件按 mtime 判胜负、`.minecraft` 里不按 mtime。
         */
        let game = |root: &Path| {
            root.join(GAME_DIR_NAME)
                .join(VERSIONS_DIR_NAME)
                .join("s1")
        };
        let legacy_game = |root: &Path| {
            root.join(LEGACY_INSTANCES_NAME).join("s1").join("game")
        };

        // 老位置（那两天应用实际在写的那份）—— 老布局：多一层 `game/`
        std::fs::create_dir_all(legacy_game(&old)).unwrap();
        std::fs::write(legacy_game(&old).join("options.txt"), b"lang:zh_cn").unwrap();
        std::fs::write(legacy_game(&old).join("only-in-old.txt"), b"from-old").unwrap();
        std::fs::write(old.join(LEGACY_INSTANCES_NAME).join("s1").join("s1-only.bin"), b"x")
            .unwrap();
        /*
         * 游戏根（十几天前那份）也是**老布局** —— 只有这样两个源才是同一种形状，
         * 上面那次 mtime 比较才有意义（比的是同一个相对路径）。
         *
         * ★ 这一条写错过一次：目标当时被造成"新布局"（`options.txt` 直接躺在
         *   `versions/s1/` 里），于是"目标已经有游戏数据了 ⇒ 不混，保留 `game/`"
         *   这条判据正确地拦下了提层 —— 而测试却以为提层失败了。
         *   **夹具的形状必须是"真实世界里可能存在的那个"**。
         */
        std::fs::create_dir_all(game(&new).join("game")).unwrap();
        std::fs::write(game(&new).join("game").join("options.txt"), b"lang:en_us").unwrap();
        std::fs::write(game(&new).join("game").join("only-in-new.txt"), b"keep-me").unwrap();
        // 显式拨 mtime：目标（游戏根）那份是一小时前，源（老位置）那份是现在
        set_mtime(&game(&new).join("game").join("options.txt"), hour_ago);
        set_mtime(&legacy_game(&old).join("options.txt"), std::time::SystemTime::now());

        // `.minecraft` 里的同名文件（同样的 mtime 关系）—— 应当**不动**
        std::fs::create_dir_all(old.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(old.join(GAME_DIR_NAME).join("libraries").join("a.jar"), b"res-downloaded").unwrap();
        std::fs::create_dir_all(new.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(new.join(GAME_DIR_NAME).join("libraries").join("a.jar"), b"already-here").unwrap();
        set_mtime(&new.join(GAME_DIR_NAME).join("libraries").join("a.jar"), hour_ago);
        set_mtime(&old.join(GAME_DIR_NAME).join("libraries").join("a.jar"), std::time::SystemTime::now());

        migrate_data_root(&old, &new).unwrap();

        let opts = game(&new).join("options.txt");
        assert_eq!(
            std::fs::read_to_string(&opts).unwrap(),
            "lang:zh_cn",
            "★ 老位置那份更新（用户最后真正玩过的那份）→ 它该赢"
        );
        /*
         * ★★ 这一组断言是"布局规范化"的核心：**游戏数据只能在版本目录那一层**。
         *
         *   两处会踩到它的地方（本轮都真踩过）：
         *   · 跨根补齐是逐文件的，`old/.minecraft` 的整树复制会把
         *     `versions/<名字>/game/` 那层**又铺回来** —— 所以提平必须放在
         *     所有复制**之后**（顺序写在上面的注释里）；
         *   · 提平自己如果留着空壳 `game/`，"游戏数据在哪"就还是两个答案。
         */
        assert!(
            !game(&new).join("game").join("options.txt").exists(),
            "游戏数据不该再套一层 game/：{}",
            game(&new).join("game").display()
        );
        let leftover = game(&new).join("game");
        assert!(
            !leftover.is_dir()
                || std::fs::read_dir(&leftover)
                    .map(|mut it| it.next().is_none())
                    .unwrap_or(false),
            "提平之后不该留下非空的 game/：{}",
            leftover.display()
        );
        /*
         * ★ 覆盖必须留下痕迹。本轮把提平写成"先备份成 `.ieml-bak` 再写入"，
         *   所以老位置那份 `en_us` 应当能在 `old/instances/s1/` 下找到
         *   （而不是凭空消失）。
         */
        let bak = old
            .join(LEGACY_INSTANCES_NAME)
            .join("s1")
            .join("options.txt.ieml-bak");
        if bak.is_file() {
            assert_eq!(
                std::fs::read_to_string(&bak).unwrap(),
                "lang:en_us",
                "被覆盖的那份必须是原来的内容"
            );
        }
        assert!(game(&new).join("only-in-old.txt").is_file(), "缺的要补");
        assert_eq!(
            std::fs::read_to_string(game(&new).join("only-in-new.txt")).unwrap(),
            "keep-me",
            "目标独有的文件不许动"
        );
        assert!(
            game(&new).join("s1-only.bin").is_file(),
            "实例目录整体都要补"
        );
        /*
         * ★ 源那份"原始文件"被**移**上来了（不是复制）：提平是"老布局 → 新布局"
         *   的同根整理，`game/` 那层本来就该消失。所以断言的是
         *   **内容一个字节都没丢**（`options.txt` 里的东西还在），
         *   而不是"老路径还在"。
         */
        assert!(
            !legacy_game(&old).join("options.txt").exists(),
            "提平之后老位置那层 game/ 里不该还留着原始文件"
        );
        assert_eq!(
            std::fs::read_to_string(legacy_game(&old).parent().unwrap().join("options.txt"))
                .unwrap(),
            "lang:zh_cn",
            "老位置那一层应当有一份同样的内容（源内容不许丢）"
        );
        // ★ `.minecraft` 不按 mtime：目标已有就跳过
        assert_eq!(
            std::fs::read_to_string(new.join(GAME_DIR_NAME).join("libraries").join("a.jar")).unwrap(),
            "already-here",
            "库/jar 不该按 mtime 覆盖（那会让每次启动都可能重写共享文件）"
        );
        assert!(
            !new.join(GAME_DIR_NAME).join("libraries").join("a.jar.ieml-bak").exists(),
            "没覆盖就不该产生备份"
        );

        // 幂等：复制过一次之后两边 mtime 相等（`fs::copy` 会带 mtime）→ 第二次什么都不做
        let again = migrate_data_root(&old, &new).unwrap();
        assert!(
            again < std::fs::metadata(&opts).unwrap().len() + 1,
            "第二次不该再重复复制那一份（实际复制了 {again} 字节）"
        );
    }

    /* ==================== 版本目录规范化（2026-09-30） ==================== */

    /// 在临时根里造一个"能启动的版本"（目录 + 同名 JSON）。
    ///
    ///   `extra` 是版本 JSON 里的额外字段（比如 `inheritsFrom`）——
    ///   迁移要靠它认 MC 版本，所以测试必须能控制它。
    fn seed_version(paths: &AppPaths, dir: &str, extra: serde_json::Value) {
        let d = paths.instances.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        let mut json = serde_json::json!({ "id": dir, "type": "release" });
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                json[k] = v.clone();
            }
        }
        std::fs::write(
            d.join(format!("{dir}.json")),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
    }

    /// 写一份账本，`slugs` 里每条记录最小形状（`id` 用 slug 拼）。
    fn seed_ledger(paths: &AppPaths, slugs: &[&str]) {
        let list: Vec<serde_json::Value> = slugs
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": format!("inst-{s}"),
                    "mcVersion": "1.20.1",
                    "loader": null,
                    "addons": [],
                    "config": { "name": format!("Minecraft {s}"), "slug": s },
                })
            })
            .collect();
        let v = serde_json::json!({
            "instances": list,
            // 空账本时 `active_id` 必须是 null（不是 `inst-`）
            "active_id": slugs.first().map(|s| format!("inst-{s}")),
        });
        std::fs::create_dir_all(&paths.own_root).unwrap();
        std::fs::write(
            paths.instances_file(),
            serde_json::to_string_pretty(&v).unwrap(),
        )
        .unwrap();
    }

    fn ledger_slugs(paths: &AppPaths) -> Vec<String> {
        paths
            .own_json("instances.json")
            .and_then(|v| {
                v.get("instances")?.as_array().map(|a| {
                    a.iter()
                        .filter_map(|i| {
                            i.get("config")?.get("slug")?.as_str().map(String::from)
                        })
                        .collect()
                })
            })
            .unwrap_or_default()
    }

    /// ★★★★ **这一条是"删了的又回来"的回归测试**。
    ///
    ///   用户原话：「删除实例时，你根本不知道删的是哪里的，有时还会**诈尸**，
    ///   删了的又回来」。
    ///
    ///   成对的成因（两个都在真机上成立）：
    ///     · 一份陈旧的账本副本会把删掉的记录盖回来（`adopt_records`，
    ///       它只看"目标是不是空列表"，不看那个目录还在不在）；
    ///     · 前端"账本空 + 文件夹里有版本 → 自动认领"。
    ///
    ///   现在**以磁盘为准**：目录不在 ⇒ 那条记录没有存在的理由。
    #[test]
    fn catalog_repair_drops_ledger_entries_whose_directory_is_gone() {
        let (p, root, _own) = tmp_paths("catalog-drop");
        seed_version(&p, "1.20.1", serde_json::json!({}));
        // 账本里三条，只有一条的目录真的在
        seed_ledger(&p, &["1.20.1", "已删除的版本", "另一个也删了的"]);

        let report = instance_catalog_repair(&p);

        assert_eq!(
            ledger_slugs(&p),
            vec!["1.20.1"],
            "★ 目录不在的记录必须被清掉 —— 否则它下次启动又'诈尸'"
        );
        assert_eq!(report.dropped.len(), 2, "要如实报告清掉了两条");
        // 被清掉的那条名字要能说出来（日志/界面要指名道姓）
        assert!(report.dropped.iter().any(|n| n.contains("已删除的版本")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★ 反向的那一半同样要钉住：**读不到版本目录时绝不动账本**。
    ///
    ///   "读不到"与"确认没有"是两种结论（ADR-037）。弄混的代价是
    ///   用户的版本记录被整批清空 —— 这个仓库为它栽过一次
    ///   （`list_instances` 里那句 `retain` 把所有实例都滤掉了）。
    #[test]
    fn catalog_repair_leaves_the_ledger_alone_when_it_cannot_read_the_folder() {
        let (p, root, _own) = tmp_paths("catalog-unreadable");
        seed_ledger(&p, &["a", "b"]);
        // 故意**不建** `versions/`（`ensure()` 没跑过）—— 读不到就是读不到
        assert!(!p.instances.is_dir());

        let report = instance_catalog_repair(&p);

        assert_eq!(ledger_slugs(&p), vec!["a", "b"], "★ 读不到目录时不许动账本");
        assert!(report.dropped.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★ 磁盘上有版本、账本里没有 → 补一条记录（PCL 那样"文件夹就是版本列表"）。
    #[test]
    fn catalog_repair_adopts_versions_that_the_ledger_never_heard_of() {
        let (p, root, _own) = tmp_paths("catalog-adopt");
        seed_version(&p, "1.20.1", serde_json::json!({}));
        // ★ 只有目录、没有版本 JSON 的不算能启动的版本
        std::fs::create_dir_all(p.instances.join("空壳")).unwrap();
        seed_ledger(&p, &[]);

        let report = instance_catalog_repair(&p);

        assert_eq!(ledger_slugs(&p), vec!["1.20.1"], "有 JSON 的版本要补进来");
        assert_eq!(report.adopted, vec!["1.20.1"]);
        assert!(
            !ledger_slugs(&p).iter().any(|s| s == "空壳"),
            "没有版本 JSON 的空目录不算版本"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /* ============ 「原版是基座，不是独立版本」（2026-10-08） ============ */

    /// 基座记号的读/写/清（纯文件行为，毫秒级）。
    ///
    /// ★ 三条都要有：**标上之后读得出来**、**幂等**（重复标不重写）、
    ///   **撤掉之后读不出来**。少一条，"原版是基座"这件事就会在某一轮悄悄失效。
    #[test]
    fn base_marker_is_written_read_and_cleared() {
        let (p, root, _own) = tmp_paths("base-marker");
        p.ensure().unwrap();
        seed_version(&p, "26.3", serde_json::json!({}));

        assert!(!p.is_base_version("26.3"), "一开始它不是基座");
        assert!(p.mark_version_as_base("26.3", "26.3-fabric-0.19.5"));
        assert!(p.is_base_version("26.3"), "标上之后要读得出来");
        assert!(!p.mark_version_as_base("26.3", "again"), "已经标过就别再写一遍");
        assert!(
            std::fs::read_to_string(p.base_marker_file("26.3"))
                .unwrap()
                .contains("26.3-fabric-0.19.5"),
            "记号里要写清「它是谁的基座」（以后能读懂）"
        );

        assert!(p.clear_base_marker("26.3"), "用户明确要原版时要能撤掉");
        assert!(!p.is_base_version("26.3"));
        assert!(!p.clear_base_marker("26.3"), "已经没了就别再报撤过");

        // 目录不在 ⇒ 不标（别对着空气写文件）
        assert!(!p.mark_version_as_base("不存在", "x"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★★★ 用户 2026-10-08：「原版是作为基座的，而不是单独的一个版本；
    ///   只有真的只下载原版时，才是独立的版本」。
    ///
    ///   已经装好的老数据（真机 `versions/26.3/` 就是）没有记号，所以启动时的
    ///   归置要**补一次**：有别的版本继承它、账本里没有它的记录 ⇒ 它是基座。
    #[test]
    fn catalog_repair_recognizes_a_base_version_and_does_not_adopt_it() {
        let (p, root, _own) = tmp_paths("catalog-base");
        // 加载器版本 + 它继承的原版（原版是这次顺手装上的，账本里没有它）
        seed_version(&p, "26.3", serde_json::json!({}));
        seed_version(
            &p,
            "26.3-fabric-0.19.5",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        seed_ledger(&p, &[]);

        let report = instance_catalog_repair(&p);

        assert_eq!(report.marked_base, vec!["26.3"], "被继承的原版要认成基座");
        assert!(p.is_base_version("26.3"));
        assert_eq!(
            ledger_slugs(&p),
            vec!["26.3-fabric-0.19.5"],
            "★ 基座不补记录：它不是一个「用户要的版本」"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★★★ 2026-10-12（用户：「**启动器不认纯原版游戏了**」）。
    ///
    ///   同一个形状，唯一的区别是：**这个原版目录被用户玩过**
    ///   （游戏在里面留下了 `options.txt`）。真机现场就是这样 ——
    ///   `versions/26.3/` 有存档、有 options.txt、有游戏日志，从 10-08 用到 10-12，
    ///   可账本里那条记录是自动认领写的（`inst-disk-26.3`）⇒ 被判成基座 ⇒
    ///   盖了 `base.json` 又把记录清掉 ⇒ 列表里再也看不到它。
    ///
    ///   判据：**玩过的目录不是基座**（装加载器顺手装上的基座从来没被启动过），
    ///   而且过去误标的记号要**自动撤掉**、记录要**补回来**。
    #[test]
    fn a_played_vanilla_dir_is_not_a_base() {
        let (p, root, _own) = tmp_paths("catalog-played-base");
        seed_version(&p, "26.3", serde_json::json!({}));
        seed_version(
            &p,
            "26.3-fabric-0.19.5",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        // ★ 直接证据：游戏在那个目录里写过 options.txt ⇒ 用户拿它玩过
        std::fs::write(p.instances.join("26.3").join("options.txt"), "fov:0.5\n").unwrap();
        // 而且过去那份误标的记号还在（真机就是这个状态）
        assert!(p.mark_version_as_base("26.3", "（另一个版本继承它）"));
        seed_ledger(&p, &[]);

        let report = instance_catalog_repair(&p);

        assert!(
            !p.is_base_version("26.3"),
            "★ 玩过的原版目录不是基座：误标的记号必须被撤掉"
        );
        assert_eq!(report.cleared_base, vec!["26.3"], "撤掉这件事要说出来（日志/测试看得见）");
        assert!(
            report.marked_base.is_empty(),
            "不许标成基座：它本来就是用户自己的版本"
        );
        assert_eq!(
            ledger_slugs(&p),
            vec!["26.3", "26.3-fabric-0.19.5"],
            "★ 两个都要在账本里：原版是独立版本，加载器版本继承它"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★★★ 同一天的另一半：**没玩过的**原版（装加载器时顺手装上的基座）
    ///   仍然要被认成基座 —— 新判据不许把这条老规矩推翻。
    #[test]
    fn an_unplayed_vanilla_dir_is_still_a_base() {
        let (p, root, _own) = tmp_paths("catalog-unplayed-base");
        seed_version(&p, "26.3", serde_json::json!({}));
        seed_version(
            &p,
            "26.3-fabric-0.19.5",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        seed_ledger(&p, &[]);

        let report = instance_catalog_repair(&p);

        // 没有 options.txt ⇒ 没被启动过 ⇒ 它只是基座（2026-10-08 的老规矩）
        assert!(p.is_base_version("26.3"));
        assert_eq!(report.marked_base, vec!["26.3"]);
        assert!(report.cleared_base.is_empty());
        assert_eq!(ledger_slugs(&p), vec!["26.3-fabric-0.19.5"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★★★ 真机那一份（用户 2026-10-08 报的第二个症状）：账本里那条原版记录是
    ///   **启动器自己补认出来的**（`inst-disk-26.3`），不是用户要的版本。
    ///
    ///   ⇒ 它要被认成基座，而且那条"捡回来的"记录要**清掉**
    ///     （否则它占着 slug `26.3`，用户以后真的装一次原版只能排到 `26.3-2`，
    ///      一个指向不存在目录的幽灵实例）。
    #[test]
    fn catalog_repair_treats_a_launcher_picked_vanilla_record_as_a_base() {
        let (p, root, _own) = tmp_paths("catalog-base-picked");
        seed_version(&p, "26.3", serde_json::json!({}));
        seed_version(
            &p,
            "26.3-fabric-0.19.5",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        // 两条都是补认形状（`inst-disk-*` + 名字 == 目录名）
        let ledger = serde_json::json!({
            "instances": [
                { "id": "inst-disk-26.3", "mcVersion": "26.3", "loader": null, "addons": [],
                  "config": { "name": "26.3", "slug": "26.3" } },
                { "id": "inst-disk-26.3-fabric-0.19.5", "mcVersion": "26.3",
                  "loader": { "kind": "fabric", "version": "0.19.5", "mcVersion": "26.3" },
                  "addons": [],
                  "config": { "name": "Minecraft 26.3 + Fabric 0.19.5",
                              "slug": "26.3-fabric-0.19.5" } },
            ],
            "active_id": "inst-disk-26.3",
        });
        std::fs::create_dir_all(&p.own_root).unwrap();
        std::fs::write(
            p.instances_file(),
            serde_json::to_string_pretty(&ledger).unwrap(),
        )
        .unwrap();

        let report = instance_catalog_repair(&p);

        assert_eq!(report.marked_base, vec!["26.3"], "补认出来的原版要认成基座");
        assert!(p.is_base_version("26.3"));
        assert_eq!(
            ledger_slugs(&p),
            vec!["26.3-fabric-0.19.5"],
            "★ 基座身上那条「捡回来的」记录要清掉（别占着 slug）"
        );
        assert_eq!(
            p.own_json("instances.json")
                .and_then(|v| v.get("active_id").cloned())
                .and_then(|v| v.as_str().map(String::from)),
            None,
            "active_id 指向被清掉的那条 ⇒ 要清空（否则又是一个悬空指针）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 反向：**用户单独装过的原版**（账本里有它的记录）不许被标成基座 ——
    /// 哪怕它同时也被别的版本继承。
    #[test]
    fn catalog_repair_never_marks_a_version_the_user_asked_for() {        let (p, root, _own) = tmp_paths("catalog-base-keep");
        seed_version(&p, "26.3", serde_json::json!({}));
        seed_version(
            &p,
            "26.3-fabric-0.19.5",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        seed_ledger(&p, &["26.3", "26.3-fabric-0.19.5"]);

        let report = instance_catalog_repair(&p);

        assert!(report.marked_base.is_empty(), "有记录 = 用户要过它，别动");
        assert!(!p.is_base_version("26.3"));
        assert_eq!(ledger_slugs(&p).len(), 2, "两条记录都留着");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 账本里的 slug 与磁盘目录名只差大小写 → 以**磁盘**为准改正。
    #[test]
    fn catalog_repair_fixes_a_slug_that_differs_only_by_case() {        let (p, root, _own) = tmp_paths("catalog-case");
        seed_version(&p, "Fabric-1", serde_json::json!({}));
        seed_ledger(&p, &["fabric-1"]);

        let report = instance_catalog_repair(&p);

        assert_eq!(ledger_slugs(&p), vec!["Fabric-1"], "slug 要跟磁盘一致");
        assert_eq!(report.reslugged, vec![("fabric-1".into(), "Fabric-1".into())]);
        assert!(report.dropped.is_empty(), "这只是大小写不同，不是删除");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★ 目录名规范化：`fabric-loader-0.19.5-26.3` → `26.3-fabric-0.19.5`。
    ///
    ///   真机上那个目录是安装器按 **Fabric profile 自带的 `id`** 建的
    ///   （MC 版本在末尾），而 ADR-055 的规范是 MC 版本在前。
    ///   ⚠ 反解不出来（`parse_dir_name` 对它是 `None`），所以必须**读它的
    ///     版本 JSON 里的 `inheritsFrom`** —— 这正是那条"名字猜不出来就别猜、
    ///     去读 JSON"的规矩在起作用。
    #[test]
    fn catalog_repair_renames_a_pcl_style_folder_to_the_adr_055_name() {
        let (p, root, _own) = tmp_paths("catalog-rename");
        seed_version(
            &p,
            "fabric-loader-0.19.5-26.3",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        seed_ledger(&p, &["fabric-loader-0.19.5-26.3"]);

        let report = instance_catalog_repair(&p);

        assert_eq!(
            report.renamed,
            vec![(
                "fabric-loader-0.19.5-26.3".into(),
                "26.3-fabric-0.19.5".into()
            )],
            "目录名要按 ADR-055 规范化（MC 版本在前）"
        );
        assert!(p.instances.join("26.3-fabric-0.19.5").is_dir());
        assert!(!p.instances.join("fabric-loader-0.19.5-26.3").exists());
        // 版本 JSON 要跟着改名 —— 否则 PCL 那条"JSON 名字必须等于目录名"就不成立了
        assert!(
            p.instances
                .join("26.3-fabric-0.19.5")
                .join("26.3-fabric-0.19.5.json")
                .is_file(),
            "改名后必须留下同名 JSON，否则版本再也启动不了"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★ 老布局多套的那层 `game/` 要被提上来，而且**同名文件按 mtime 判胜负**。
    ///
    ///   这是"一个版本一个文件夹"（PCL 的 `PathIndie == PathVersion`）的核心：
    ///   如果游戏数据还留在 `game/` 里，而 `--gameDir` 指版本目录，
    ///   用户在界面上看到版本、点进去却没有存档。
    #[test]
    fn catalog_repair_promotes_the_legacy_game_subdir() {
        let (p, root, _own) = tmp_paths("catalog-promote");
        seed_version(&p, "1.20.1", serde_json::json!({}));
        // 老布局：游戏数据在 `game/` 里
        let game = p.instances.join("1.20.1").join("game");
        std::fs::create_dir_all(game.join("saves").join("World1")).unwrap();
        std::fs::write(game.join("saves").join("World1").join("level.dat"), b"LEVEL").unwrap();
        std::fs::write(game.join("options.txt"), b"lang:zh_cn").unwrap();
        seed_ledger(&p, &["1.20.1"]);

        let report = instance_catalog_repair(&p);

        assert_eq!(report.flattened, vec!["1.20.1"]);
        assert!(
            p.instances
                .join("1.20.1")
                .join("saves")
                .join("World1")
                .join("level.dat")
                .is_file(),
            "★ 存档必须落在版本目录那一层，否则游戏读不到"
        );
        assert_eq!(
            std::fs::read_to_string(p.instances.join("1.20.1").join("options.txt")).unwrap(),
            "lang:zh_cn"
        );
        assert!(
            !p.instances.join("1.20.1").join("game").is_dir(),
            "提平之后不该留下 game/ 那层空壳"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 跑两遍什么都不会变（幂等）—— 它每次启动都会跑，不幂等就是灾难。
    #[test]
    fn catalog_repair_is_idempotent() {
        let (p, root, _own) = tmp_paths("catalog-idempotent");
        seed_version(
            &p,
            "fabric-loader-0.19.5-26.3",
            serde_json::json!({ "inheritsFrom": "26.3" }),
        );
        let game = p.instances.join("fabric-loader-0.19.5-26.3").join("game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("options.txt"), b"lang:zh_cn").unwrap();
        seed_ledger(&p, &["fabric-loader-0.19.5-26.3", "幽灵版本"]);

        let first = instance_catalog_repair(&p);
        assert!(!first.is_empty(), "第一遍要真的做了事");

        let before = ledger_slugs(&p);
        let second = instance_catalog_repair(&p);
        assert!(second.is_empty(), "第二遍应当无事可做，实际：{second:?}");
        assert_eq!(ledger_slugs(&p), before, "第二遍不许再动账本");

        // 第三遍也一样（不是"恰好第三次又变了"）
        assert!(instance_catalog_repair(&p).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★ 归置**不许删除用户的东西**：账本的旧内容要留一份 `.bak`。
    #[test]
    fn catalog_repair_backs_up_the_ledger_before_changing_it() {
        let (p, root, _own) = tmp_paths("catalog-bak");
        seed_ledger(&p, &["只存在于账本里的版本"]);
        std::fs::create_dir_all(&p.instances).unwrap();

        instance_catalog_repair(&p);

        let bak = p.instances_file().with_extension("json.bak");
        assert!(bak.is_file(), "改账本之前必须先留备份：{}", bak.display());
        assert!(
            std::fs::read_to_string(&bak).unwrap().contains("只存在于账本里的版本"),
            "备份里要有被清掉的那条 —— 判据错了用户还能自己捞回来"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★ 每个版本目录里写一份**身份小抄**（`.ieml/instance.json`）。
    ///
    ///   它的用处是"这个目录是谁"可以**从磁盘反推**：账本被旧副本盖掉、
    ///   或者用户把整个 `.minecraft` 搬到另一台机器上时，身份不会跟着丢。
    #[test]
    fn catalog_repair_writes_an_identity_marker_per_version() {
        let (p, root, _own) = tmp_paths("catalog-marker");
        seed_version(&p, "1.20.1", serde_json::json!({}));
        seed_ledger(&p, &["1.20.1"]);

        instance_catalog_repair(&p);

        let marker = p.instance_marker_file("1.20.1");
        assert!(marker.is_file(), "身份小抄要写在 {} 里", marker.display());
        assert!(
            marker.starts_with(p.instances.join("1.20.1").join(LAUNCHER_SUBDIR)),
            "★ 小抄必须在 .ieml/ 下 —— 与游戏会读的目录名不重叠"
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(v["config"]["slug"], "1.20.1");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ★★ **启动器目录与游戏目录绝不能是同一个**。
    ///
    ///   这条是数字上的安全检查：`prepare_spec` 每次启动都会
    ///   `remove_dir_all(natives_dir)` 再解压，而 `natives_dir` 是从
    ///   `instance_dir`（=`<版本>/.ieml/`）拼的。两者一旦相等，
    ///   **每次启动都会把整个版本目录（含存档）删掉**。
    #[test]
    fn the_launcher_dir_is_never_the_game_dir() {
        let (p, _root, _own) = tmp_paths("catalog-separation");
        for slug in ["1.20.1", "a b", "中文版本"] {
            let game = p.instance_game_dir(slug);
            let inst = p.instance_dir(slug);
            assert_ne!(
                game, inst,
                "★ 游戏目录与启动器目录重合了（{slug}）—— 启动时会把存档删掉"
            );
            assert_eq!(game, p.instance_root_dir(slug));
            assert!(inst.starts_with(&game), "启动器目录要在版本目录里面");
            assert_eq!(inst, game.join(LAUNCHER_SUBDIR));
            // 游戏目录里那几个名字，启动器目录一个都不许占
            for game_name in ["mods", "saves", "config", "logs", "resourcepacks"] {
                assert_ne!(
                    inst.file_name().unwrap().to_string_lossy(),
                    game_name,
                    "启动器目录名不许与游戏目录名撞车（{game_name}）"
                );
            }
        }
    }

    /// ★★ 2026-09-24：反方向 —— 游戏根目录里的启动器目录被**收养**到 own_root。

    ///   覆盖三件事：① 缺的复制过去；② 目标已有的文件一个字节都不动；
    ///   ③ 源就是 own_root 时不做任何事（否则等于自己复制自己，白跑一遍）。
    ///
    ///   ★ 临时目录的 tag 必须是**独一份**：这条原来叫 `"adopt"`，与 A-4 那条
    ///     `adopt_records_copies_from_the_game_root_and_keeps_the_source` **撞了**
    ///     （`tmp_paths` 是按 tag + PID 拼路径的）—— 两条测试并行跑时会互相
    ///     `remove_dir_all` 掉对方的种子目录，于是**偶发**红一次
    ///     （实测：第一次全量跑就红在这里，单独跑却怎么都过）。
    #[test]
    fn adopt_own_dirs_copies_launcher_dirs_into_own_root() {
        let (p, root, own) = tmp_paths("adoptdirs");
        // 游戏根目录里留着老式启动器目录
        std::fs::create_dir_all(root.join("java").join("jdk-21")).unwrap();
        std::fs::write(root.join("java").join("jdk-21").join("bin.exe"), b"jdk").unwrap();
        std::fs::create_dir_all(root.join("cache")).unwrap();
        std::fs::write(root.join("cache").join("a.json"), b"from-game-root").unwrap();
        // 目标**已经有**同名文件（用户在用的那份）→ 绝不能被覆盖
        std::fs::create_dir_all(own.join("cache")).unwrap();
        std::fs::write(own.join("cache").join("a.json"), b"mine").unwrap();
        // 只有游戏根目录才有的第二个文件 → 该补过去
        std::fs::write(root.join("cache").join("b.json"), b"extra").unwrap();
        // 游戏根目录里没有 logs → 不该被凭空造出来
        let copied = adopt_own_dirs(&p, &root);

        assert!(copied > 0, "应当真的复制了东西");
        assert!(
            own.join("java").join("jdk-21").join("bin.exe").is_file(),
            "游戏根目录里下好的 Java 应当被收养"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("cache").join("a.json")).unwrap(),
            "mine",
            "目标已有的文件一个字节都不许动"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("cache").join("b.json")).unwrap(),
            "extra",
            "目标缺的文件应当补上"
        );
        assert!(!own.join("logs").exists(), "源里没有的目录不该凭空造");
        // 源照旧（只复制、绝不删源）
        assert!(root.join("cache").join("a.json").is_file());
        assert!(root.join("java").join("jdk-21").join("bin.exe").is_file());
        // 第二次跑：没什么可补的 → 0 字节
        assert_eq!(adopt_own_dirs(&p, &root), 0, "补齐之后不该再有动作");
        // 源 == own_root（本机就是 `%APPDATA%\IEML`）→ 直接跳过
        assert_eq!(adopt_own_dirs(&p, &own), 0, "源就是自己的家，不该自己复制自己");
    }

    /// ★★ 2026-09-24（C）：候选目录**按顺序取第一个能用的** —— 这条优先级是要钉住的东西。
    ///
    ///   场景：记录里的盘拔了 / 选了只读位置 / 单盘机器。
    ///   第一个候选故意用一个**建不出来的路径**（父级是个文件）来代表"不可用"。
    #[test]
    fn first_usable_skips_candidates_that_cannot_be_created() {
        let base = tmp("ownpick");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let good = base.join("good");

        let got = first_usable(vec![PathBuf::new(), file.join("child"), good.clone()]);
        assert_eq!(got, Some(good), "空路径与建不出来的路径都要跳过，选第一个能用的");
        assert!(base.join("good").is_dir(), "选中的那一个应当被建出来");

        // 一个都用不了 → None（调用方会退回兜底，不许 panic）
        assert_eq!(first_usable(vec![file.join("child")]), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// ★★ 2026-09-24（C）：`remember_own_root` 幂等 —— 内容一样时**不重写文件**。
    ///
    ///   判据用 mtime：先把记录文件拨到一小时前，再调一次同值 → mtime 必须还是那个旧值。
    ///   （否则每次启动都会动一次文件，而"启动器改了系统盘上的文件"这种事没必要。）
    #[test]
    fn remember_own_root_is_idempotent() {
        let base = tmp("ownrec");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("ownroot.txt");
        let home = base.join("IEML-launcher");
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);

        remember_own_root_at(&file, &home);
        assert_eq!(
            read_record(&file),
            Some(home.clone()),
            "记录里应当是刚写进去的那个路径"
        );

        set_mtime(&file, hour_ago);
        remember_own_root_at(&file, &home); // 同一个值 → 不该重写
        let after_same = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert!(
            after_same < hour_ago + std::time::Duration::from_secs(60),
            "同值时不该重写记录文件（mtime 被刷新了）"
        );

        // 换一个位置 → 必须重写
        let other = base.join("别的家");
        remember_own_root_at(&file, &other);
        assert_eq!(read_record(&file), Some(other.clone()));
        assert!(
            std::fs::metadata(&file).unwrap().modified().unwrap() > after_same,
            "换了位置就应当重写"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// ★★ 2026-09-24（C）：把"启动器自己的家"从老位置搬到新位置。
    ///
    ///   覆盖五件事：① 账本缺的补过去；② 账本"源更新就赢" + 先备份目标；
    ///   ③ 目标更新就一个字节都不动；④ `java/cache/logs` 只补缺、不覆盖；
    ///   ⑤ 源一个字节都不删、第二次调用什么都不做；⑥ 源 == 目标时直接跳过。
    #[test]
    fn migrate_own_root_moves_ledger_and_runtime_dirs() {
        let (mut p, _root, old) = tmp_paths("mvhome");
        let new_home = tmp("ieml-mvhome-new");
        let _ = std::fs::remove_dir_all(&new_home);
        std::fs::create_dir_all(&new_home).unwrap();
        p.own_root = new_home.clone();
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);

        // 老的家：账本四件 + java/cache/logs
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("instances.json"), r#"{"instances":[{"id":"a"},{"id":"b"}]}"#).unwrap();
        std::fs::write(old.join("prefs.json"), r#"{"theme":"从老位置来的"}"#).unwrap();
        std::fs::write(old.join("ms_client_id.txt"), "old-id\n").unwrap();
        std::fs::create_dir_all(old.join("cache").join("sub")).unwrap();
        std::fs::write(old.join("cache").join("a.json"), b"cache-from-old").unwrap();
        std::fs::write(old.join("cache").join("sub").join("b.json"), b"sub-from-old").unwrap();
        std::fs::create_dir_all(old.join("logs")).unwrap();
        std::fs::write(old.join("logs").join("game.log"), b"log").unwrap();
        std::fs::create_dir_all(old.join("java")).unwrap();

        // 新的家：prefs 有一份**更新**的（必须赢）、ms_client_id 有一份更新的（不许动）、
        //         cache 里有一份同名文件（不许覆盖）
        std::fs::create_dir_all(new_home.join("cache")).unwrap();
        std::fs::write(new_home.join("prefs.json"), r#"{"theme":"新的"}"#).unwrap();
        std::fs::write(new_home.join("ms_client_id.txt"), "new-id\n").unwrap();
        std::fs::write(new_home.join("cache").join("a.json"), b"cache-already-here").unwrap();
        set_mtime(&new_home.join("prefs.json"), hour_ago);
        set_mtime(&new_home.join("ms_client_id.txt"), std::time::SystemTime::now());
        set_mtime(&old.join("prefs.json"), std::time::SystemTime::now());

        let copied = migrate_own_root(&old, &p);
        assert!(copied > 0, "应当真的搬了东西");
        // ① 账本缺的补过去
        assert!(p.own_file("instances.json").is_file(), "缺的账本要补");
        // ② 源更新 → 源赢，且旧目标进 .bak
        assert_eq!(
            std::fs::read_to_string(p.own_file("prefs.json")).unwrap(),
            r#"{"theme":"从老位置来的"}"#
        );
        assert_eq!(
            std::fs::read_to_string(p.own_root.join("prefs.json.bak")).unwrap(),
            r#"{"theme":"新的"}"#
        );
        // ③ 目标更新 → 一个字节都不动
        assert_eq!(
            std::fs::read_to_string(p.own_file("ms_client_id.txt")).unwrap(),
            "new-id\n"
        );
        // ④ 运行时目录只补缺
        assert_eq!(
            std::fs::read_to_string(p.own_root.join("cache").join("a.json")).unwrap(),
            "cache-already-here",
            "目标已有的缓存文件不许覆盖"
        );
        assert!(p.own_root.join("cache").join("sub").join("b.json").is_file(), "缺的要补（含子目录）");
        assert!(p.own_root.join("logs").join("game.log").is_file());
        assert!(p.own_root.join("java").is_dir());
        // ⑤ 源一个字节都不删
        assert!(old.join("prefs.json").is_file() && old.join("cache").join("a.json").is_file());
        assert!(old.join("instances.json").is_file());
        // 幂等
        assert_eq!(migrate_own_root(&old, &p), 0, "第二次不该再搬");
        // ⑥ 源就是自己的家 → 跳过（否则等于自己复制自己）
        assert_eq!(migrate_own_root(&new_home, &p), 0, "源 == 目标时不该动作");

        let _ = std::fs::remove_dir_all(&new_home);
    }

    /// 路径比较：`D:\IEML`、`d:/ieml/`、`D:\IEML\\` 必须是同一处。
    /// （收养老目录时用它判断"源是不是就是自己的家"，判错就会白复制一遍。）
    #[test]
    fn norm_path_is_forgiving_about_separators_and_case() {
        let a = norm_path(Path::new("D:\\IEML"));
        assert_eq!(a, norm_path(Path::new("D:\\IEML\\")));
        assert_eq!(a, norm_path(Path::new("D:/IEML/")));
        assert_eq!(a, norm_path(Path::new("D:\\IEML\\\\")));
        #[cfg(windows)]
        assert_eq!(a, norm_path(Path::new("d:\\ieml")), "Windows 上不分大小写");
        assert_ne!(a, norm_path(Path::new("D:\\IEML2")));
    }

    /// 系统盘判定：`%SystemRoot%` 所在的盘就是系统盘。
    #[test]
    #[cfg(windows)]
    fn system_drive_detection_is_sane() {
        let sys = std::env::var("SystemRoot").expect("Windows 一定有 SystemRoot");
        assert!(
            is_on_system_drive(Path::new(&sys)),
            "{sys} 应该在系统盘上"
        );
        // 别的盘符不该被判成系统盘（本机 C 是系统盘、D/E 不是）
        let sys_drive = Path::new(&sys)
            .components()
            .next()
            .unwrap()
            .as_os_str()
            .to_string_lossy()
            .to_uppercase();
        for d in ['D', 'E', 'F'] {
            let p = format!("{d}:\\");
            if !Path::new(&p).is_dir() {
                continue;
            }
            if format!("{d}:") == sys_drive {
                continue;
            }
            assert!(
                !is_on_system_drive(Path::new(&p)),
                "{p} 不是系统盘却被判成系统盘"
            );
        }
    }

    /* ==================== ★★ A-4：启动器自己的文件不住游戏根目录 ==================== */

    /// 造一对临时根目录（游戏根 + 启动器的家），返回拼好的 `AppPaths`。
    fn tmp_paths(tag: &str) -> (AppPaths, PathBuf, PathBuf) {
        let root = tmp(&format!("a4-root-{tag}"));
        let own = tmp(&format!("a4-own-{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
        std::fs::create_dir_all(&root).unwrap();
        let p = AppPaths {
            shared: root.join(GAME_DIR_NAME),
            instances: root.join(GAME_DIR_NAME).join(VERSIONS_DIR_NAME),
            java: own.join("java"),
            cache: own.join("cache"),
            logs: own.join("logs"),
            root: root.clone(),
            own_root: own.clone(),
        };
        (p, root, own)
    }

    /// 这四个文件的**目标位置**必须都在 `own_root` 下，而且不在游戏根目录里。
    #[test]
    fn launcher_records_live_in_own_root_not_in_the_game_root() {
        let (p, root, own) = tmp_paths("where");
        for name in [
            "instances.json",
            "prefs.json",
            "ms_client_id.txt",
            "cf_api_key.txt",
        ] {
            let f = p.own_file(name);
            assert!(f.starts_with(&own), "{name} 应当在 own_root 下：{}", f.display());
            assert!(
                !f.starts_with(&root),
                "{name} **不该**在游戏根目录里：{}",
                f.display()
            );
        }
        assert!(p.instances_file().starts_with(&own));
        assert!(p.prefs_file().starts_with(&own));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 把文件的 mtime 拨到指定时刻。
    ///
    /// ★ 为什么测试里必须显式拨：`should_adopt` 判的是 `源 mtime > 目标 mtime`，
    ///   而"先 write 目标、再 write 源"这种写法**在同一个毫秒里就会相等** ——
    ///   相等时按规矩不收养（目标优先），于是测试会**偶发地红**
    ///   （第一次跑就撞上了：`adopt_records_lets_the_newer_copy_win_and_backs_up_the_old_one`）。
    ///   判据本身没问题，是测试的构造不够确定。
    fn set_mtime(p: &std::path::Path, t: std::time::SystemTime) {
        let f = std::fs::File::options()
            .write(true)
            .open(p)
            .expect("打开文件以改 mtime");
        f.set_modified(t).expect("设置 mtime");
    }

    /// 老用户：文件都在游戏根目录里 → 启动时被**复制**到 `own_root`，源保留。
    /// 第二次调用必须什么都不做（幂等）。
    #[test]
    fn adopt_records_copies_from_the_game_root_and_keeps_the_source() {
        let (p, root, own) = tmp_paths("adopt");
        let inst = r#"{"instances":[{"id":"a"},{"id":"b"}],"active_id":"a"}"#;
        std::fs::write(root.join("instances.json"), inst).unwrap();
        std::fs::write(root.join("prefs.json"), r#"{"theme":"daiqing"}"#).unwrap();
        std::fs::write(root.join("ms_client_id.txt"), "1111\n").unwrap();

        let copied = adopt_records(&p);
        assert!(copied > 0, "应当真的复制了东西");
        assert_eq!(
            std::fs::read_to_string(own.join("instances.json")).unwrap(),
            inst,
            "清单应当一字不差地复制过去"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("prefs.json")).unwrap(),
            r#"{"theme":"daiqing"}"#
        );
        assert!(own.join("ms_client_id.txt").is_file());
        assert!(
            root.join("instances.json").is_file(),
            "★ 源文件必须保留（用户可能退回旧版启动器）"
        );

        // 幂等：第二次不再复制（目标已是新的那份）
        assert_eq!(adopt_records(&p), 0, "第二次不该再复制");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// ★ 真机上量出来的那条：目标（`%APPDATA%`）那份是**陈旧副本**，
    ///   源（游戏根目录）比它新 → 必须用源，并且把旧的目标备份下来。
    #[test]
    fn adopt_records_lets_the_newer_copy_win_and_backs_up_the_old_one() {
        let (p, root, own) = tmp_paths("newer");
        std::fs::create_dir_all(&own).unwrap();
        // 先写目标（旧），再写源（新）—— 时间顺序就是判据
        std::fs::write(own.join("instances.json"), r#"{"instances":[{"id":"stale"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            root.join("instances.json"),
            r#"{"instances":[{"id":"fresh-1"},{"id":"fresh-2"}],"active_id":"fresh-1"}"#,
        )
        .unwrap();
        /* ★ 显式把目标的 mtime 拨到 10 分钟前：不能靠"两次 write 的先后"，
           同一毫秒里两次 write 的 mtime 会相等，判据（`>`）就判不出来 —— 实测踩过 */
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&own.join("instances.json"), old);

        let copied = adopt_records(&p);
        assert!(copied > 0, "源更新 → 应当收养");
        let got = std::fs::read_to_string(own.join("instances.json")).unwrap();
        assert!(got.contains("fresh-2"), "应当用新的那份：{got}");
        let bak = own.join("instances.json.bak");
        assert!(bak.is_file(), "被覆盖的那份必须留一个 .bak");
        assert!(
            std::fs::read_to_string(&bak).unwrap().contains("stale"),
            "备份里应当是原来那份"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 反过来：目标（已经在 `own_root` 里、且更新）比源新 → **一个字节都不动**。
    #[test]
    fn adopt_records_leaves_a_newer_target_alone() {
        let (p, root, own) = tmp_paths("target");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(root.join("instances.json"), r#"{"instances":[{"id":"old"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            own.join("instances.json"),
            r#"{"instances":[{"id":"mine-1"},{"id":"mine-2"}],"active_id":null}"#,
        )
        .unwrap();
        /* ★ 同理：把源的 mtime 拨到 10 分钟前，保证"目标更新"是**确定的**事实 */
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&root.join("instances.json"), old);

        assert_eq!(adopt_records(&p), 0, "目标更新时不该动它");
        let got = std::fs::read_to_string(own.join("instances.json")).unwrap();
        assert!(got.contains("mine-1"), "目标被覆盖了：{got}");
        assert!(!own.join("instances.json.bak").exists(), "没覆盖就不该产生 .bak");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 读的那一侧：`own_root` 没有时回退到游戏根目录的老位置（老用户升级的当次启动）。
    #[test]
    fn own_file_for_read_falls_back_to_the_old_game_root_location() {
        let (p, root, own) = tmp_paths("read");
        assert_eq!(p.own_file_for_read("instances.json"), None, "两边都没有 → None");

        std::fs::write(root.join("instances.json"), "{}").unwrap();
        assert_eq!(
            p.own_file_for_read("instances.json"),
            Some(root.join("instances.json")),
            "只有老位置有 → 读老位置"
        );

        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("instances.json"), "{}").unwrap();
        assert_eq!(
            p.own_file_for_read("instances.json"),
            Some(own.join("instances.json")),
            "两边都有 → **优先** own_root"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }
}
