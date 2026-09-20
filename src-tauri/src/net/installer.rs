//! 安装器：把真实版本 JSON 变成可执行的下载任务，并解压 natives
//!
//! 流程（对应 `ARCHITECTURE.md` 第 6 章的安装流水线）：
//!   ① 拿版本 JSON（原版来自 Mojang/BMCLAPI；Fabric/Quilt 来自各自的 profile JSON）
//!   ② 展平 inheritsFrom 链（Fabric profile 里有 `inheritsFrom: "1.20.1"`，
//!      必须与原版 JSON 合并才能得到完整 classpath）
//!   ③ 生成下载任务：客户端 jar + 库 + natives + 资源索引 + 资源文件
//!   ④ 并发下载（去重、断点续传、多源兜底）
//!   ⑤ 解压 natives 到实例的 natives 目录
//!   ⑥ 写下合并后的版本 JSON（下次启动直接用，不用重新联网）

use super::download::{download_batch, sha1_of_file, BatchOptions, DownloadTask};
use super::metadata::{self, Library, VersionJson};
use super::mirror::{self, Source};
use super::source;
use super::{NetError, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 构造一个下载任务，并**把候选 URL 钉进任务里**（`urls`）。
///
/// 为什么要把候选固化下来：批次开始后每个文件的候选是按当时的源健康排序的；
/// 如果只存一个 URL，后面的重试轮次会重新推导，可能又推导出同一个已经
/// 吃 429 的源。钉住候选列表 = 重试时仍能换到另一个源。
fn push_task(
    tasks: &mut Vec<DownloadTask>,
    path: PathBuf,
    url: String,
    sha1: String,
    size: u64,
    label: String,
    preferred: Source,
) {
    let mut urls: Vec<String> = mirror::candidate_urls(&url, preferred)
        .into_iter()
        .map(|(_, u)| u)
        .collect();
    // 主 URL 永远在列表里
    if !urls.iter().any(|u| *u == url) {
        urls.push(url.clone());
    }
    tasks.push(DownloadTask {
        path,
        url,
        urls,
        sha1,
        size,
        label,
    });
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallReporting {
    pub stage: String,
    pub detail: String,
}

/// 完整的安装产物描述
#[derive(Debug, Clone, Serialize)]
pub struct InstalledVersion {
    pub id: String,
    pub json_path: PathBuf,
    pub client_jar: Option<PathBuf>,
    pub classpath: Vec<PathBuf>,
    pub natives_dir: PathBuf,
    pub asset_index_id: String,
    pub main_class: String,
    pub libraries_count: usize,
    pub assets_count: usize,
    pub total_bytes: u64,
    /// 本次安装里失败补下的轮数（0 = 一次过）
    pub retry_rounds: u32,
    /// 本次安装里因校验不匹配被删掉重下的文件数
    pub repaired_files: usize,
    /// 最终仍失败的资源文件（`(文件名, 错误)`）。
    ///
    /// 资源文件允许部分失败（游戏会自己补），但**必须点名**——
    /// 只报"有 23 个失败"的话，日志里查不到是 404、超时还是校验失败。
    pub failed_assets: Vec<(String, String)>,
    /// ★★ **这次安装是被"暂停"停下的**（`false` = 正常跑完 / 被取消 / 失败）。
    ///
    /// ## 为什么必须往上传（P0-3，一条会骗人的真 bug）
    ///
    ///   下载引擎 `download_batch` 早就会如实报告 `paused` + `remaining`，
    ///   但 `install()` **把它们扔掉了**：两个阶段一被暂停，函数照样往下走，
    ///   最后照常返回 `Ok(InstalledVersion{…})`。
    ///   于是 `install_version` 报"安装成功"、前端任务中心写上"完成 100%"，
    ///   而**一个字节都还没下**。
    ///
    ///   更糟的是它会接着**跑 Forge 安装器**（`install_version` 在
    ///   `install()` 返回之后无条件跑那一步）—— 用户按的是"暂停"，
    ///   换来的是一次几 MB 的下载和一次几分钟的打补丁。
    ///
    ///   所以现在的契约：**暂停就从这里原样返回，不假装成功**。
    pub paused: bool,
    /// 暂停时**还没下**的文件数（交给界面显示"还剩 N 个"）。
    ///
    /// ★ 它是"这一次调用里没来得及开始的任务数"，不是磁盘审计结论 ——
    ///   「继续」由调用方按原参数重新发起（已下好的文件会走"校验通过 → 跳过"，
    ///   `.part` 分片也会被复用）。两个数说的是两件事，别混。
    pub remaining_files: usize,
    /// 暂停发生在**哪一步**（`"下载核心文件"` / `"下载资源文件"` / …）。
    ///
    /// ★ 为什么必须有它：`remaining_files` 只说"还剩几个文件"，
    ///   而"暂停在加载器安装那一步"是**一个文件都不剩、但活没干完** ——
    ///   只用数字表达，界面就分不清"下完了"和"还没做完"。
    ///   `paused = true` 时这里是 `Some`，否则 `None`。
    pub paused_stage: Option<String>,
}

/* ====================== 依赖展平 ====================== */

/// 把子版本 JSON 合并到父版本之上（处理 `inheritsFrom`）。
///
/// 规则（按 Mojang 实际行为）：
///   * libraries **追加**（子在前，父在后；同名时子优先）
///   * mainClass / assets / assetIndex **子覆盖父**
///   * arguments **拼接**（子的在前）
pub fn merge_versions(child: &VersionJson, parent: &VersionJson) -> VersionJson {
    let mut merged = child.clone();

    if merged.main_class.is_empty() {
        merged.main_class = parent.main_class.clone();
    }
    if merged.assets.is_empty() {
        merged.assets = parent.assets.clone();
    }
    if merged.asset_index.is_none() {
        merged.asset_index = parent.asset_index.clone();
    }
    if merged.downloads.is_none() {
        merged.downloads = parent.downloads.clone();
    }
    if merged.java_version.is_none() {
        merged.java_version = parent.java_version.clone();
    }

    /*
     * libraries：子在前，去重
     *
     * ★★ 去重键 = **库的身份**（完整坐标 + natives 平台），不是 `group:artifact`。
     *
     *   踩过两次，一次比一次隐蔽，都是这条键太粗造成的：
     *
     *   ① **丢掉本地库**：原版 1.16.5 的 JSON 里同一个坐标出现两次 ——
     *        `org.lwjgl:lwjgl:3.2.2` + `natives: {}`                        ← 进 classpath
     *        `org.lwjgl:lwjgl:3.2.2` + `natives: {windows:"natives-windows"}` ← 要解压 dll
     *      按 `group:artifact` 去重 → 第二条被当重复丢掉 → natives 从 8 个变 0 个
     *      → 游戏死在 `UnsatisfiedLinkError`。
     *
     *   ② **丢掉正确版本**（更隐蔽，实测 OptiFine 时暴露）：1.16.5 的 JSON 里
     *      **同时**列了 lwjgl `3.2.1` 与 `3.2.2`：
     *        `3.2.1` 的 rules 只允许 osx（在 Windows 上被过滤掉）
     *        `3.2.2` 的 rules 允许 windows
     *      而 `merge_versions` **不管 rules**，只看键 —— 于是先遇到的 `3.2.1` 赢，
     *      classpath 上出现的是 3.2.1，游戏直接
     *        `Caused by: java.lang.NoClassDefFoundError: org/lwjgl/BufferUtils`
     *      （BufferUtils 是 LWJGL 3 的类，3.2.1 的 jar 里没有；要 3.2.2 才有）。
     *      注意：**只有合并的时候才会撞上** —— 不合并时两条都留着，
     *      `scan_classpath` 按各自的 rules 过滤，3.2.2 自然胜出。
     *
     *   所以判据必须是"这两条是不是**同一个东西**"：
     *     · 坐标（含版本、含 classifier）不同 → 不同东西，都要留；
     *     · 坐标相同但 `natives` 平台映射不同 → 仍是不同东西（一个进 classpath，一个解压）；
     *     · 坐标与 natives 都相同 → 真重复，子优先（先遇到的赢）。
     *
     *   为什么不干脆"不过滤 rules 就按路径去重"：路径（maven 布局）里带版本，
     *   正好就是"身份"。用路径当键既准确又不依赖 rules 的求值环境。
     */
    let mut seen: HashSet<String> = HashSet::new();
    let mut libs: Vec<Library> = Vec::new();
    for l in child.libraries.iter().chain(parent.libraries.iter()) {
        if seen.insert(lib_identity(l)) {
            libs.push(l.clone());
        }
    }
    merged.libraries = libs;

    // arguments：子的 game/jvm 在前，父的在后
    merged.arguments = match (&child.arguments, &parent.arguments) {
        (Some(c), Some(p)) => Some(metadata::GameArguments {
            game: c.game.iter().chain(p.game.iter()).cloned().collect(),
            jvm: c.jvm.iter().chain(p.jvm.iter()).cloned().collect(),
        }),
        (Some(c), None) => Some(c.clone()),
        (None, Some(p)) => Some(p.clone()),
        (None, None) => None,
    };

    /*
     * ★★ **`minecraftArguments` 也必须沿链继承** —— 这是老版本的关键。
     *
     *   实测踩到（LiteLoader on 1.12.2 起不来）：
     *     1.12.2 是**老格式**版本，它的游戏参数写在 `minecraftArguments`
     *     这个**单字符串**里（`--username ${auth_player_name} --version … …`），
     *     而 `arguments` 是它的**新版**对应物。
     *
     *     LiteLoader 的版本 JSON（照 PCL 拼的）只写了
     *       `arguments.game = ["--tweakClass", "…LiteLoaderTweaker"]`
     *     —— 它**没有** `minecraftArguments`。
     *
     *     于是合并后：`arguments.game` 有 2 项、`minecraftArguments` 为空。
     *     启动器一看 `arguments` 存在就用它 → 游戏只收到两个参数 →
     *     连 `--username` / `--gameDir` / `--assetsDir` 都没有 → 启动即崩。
     *
     *   修法：**父版本的 `minecraftArguments` 也要继承下来**。
     *   两个字段并存是安全的 —— 启动侧优先用 `arguments`，
     *   只有当它为空时才回落到 `minecraftArguments`（见 launch_args.rs）。
     *
     *   （1.12.2 的版本 JSON 实测确实只有 `minecraftArguments`，没有 `arguments`。）
     */
    if merged.minecraft_arguments.is_none() {
        merged.minecraft_arguments = parent.minecraft_arguments.clone();
    }

    merged
}

/// 一条库的**身份**：完整坐标（含版本与 classifier）+ natives 平台映射。
///
/// 用于 `merge_versions` 的去重 —— 见那里的长注释（踩过两次）。
///
/// 与 `lib_key`（`group:artifact`，**不含版本**）的区别很重要：
///   · `lib_key` 用来回答"这两条是不是同一个库"（例如"补全检查"要去重）；
///   · `lib_identity` 用来回答"这两条是不是**同一份东西**"（合并时去重）。
///   `org.lwjgl:lwjgl:3.2.1` 与 `org.lwjgl:lwjgl:3.2.2` 是同一个库的两个版本，
///   但**不是同一份东西** —— 混用这两个问题就会丢文件。
pub fn lib_identity(lib: &Library) -> String {
    let mut key = lib.name.clone();
    if !lib.natives.is_empty() {
        let mut nats: Vec<String> = lib
            .natives
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        nats.sort();
        key.push_str("#natives:");
        key.push_str(&nats.join(","));
    }
    key
}

/// 库的去重键：`group:artifact[:classifier]`（**不含版本**）。
///
/// ★ 现在**只被测试用到**（`#[cfg(test)]`）—— `merge_versions` 已经改用 `lib_identity`
///   （因为"不含版本"这个键会让 lwjgl 3.2.1 顶掉 3.2.2，把游戏搞崩）。
///   留着它是因为它仍然回答一个**不同**的问题：
///   "这两条是不是同一个库的不同版本"（例如将来做"补全检查"时要去重）。
///
/// ★ 以前这里是 `#[allow(dead_code)]` —— 那等于说"它是死代码但别报"，
///   读者分不清"真死了"还是"只在测试里活"。改成 `#[cfg(test)]` 之后
///   它**不进 release 二进制**，而意图一眼可见（ADR-053）。
#[cfg(test)]
fn lib_key(name: &str) -> String {
    /*
     * ★ 规则的两半都是踩出来的：
     *   * **不含版本** —— 它回答"这两条是不是同一个库的不同版本"；
     *   * **含 classifier** —— 这是后来补的，因为丢 classifier 会造成
     *     **静默的库丢失**：Fabric 的 profile 里带一条
     *     `org.lwjgl:lwjgl:3.4.1:natives-linux`，而原版有
     *     `org.lwjgl:lwjgl:3.4.1`（无 classifier）。两者被当成"同一条"，
     *     子版本优先 → **原版那条基础 lwjgl 库被丢掉** →
     *     游戏起不来，只报 `ClassNotFoundException: org.lwjgl.system.CallbackI`。
     *     （natives-linux 在本平台还会被过滤掉，等于基础库彻底没了。）
     */
    let parts: Vec<&str> = name.split(':').collect();
    match parts.len() {
        0 | 1 => name.to_string(),
        // group:artifact —— 没有 classifier
        2 => parts[..2].join(":"),
        // group:artifact:version —— 有版本但没 classifier
        3 => parts[..2].join(":"),
        // group:artifact:version:classifier —— classifier 是身份的一部分
        _ => format!("{}:{}:{}", parts[0], parts[1], parts[3]),
    }
}

/* ====================== 生成下载任务 ====================== */

pub struct PlanInput {
    /// 合并后的完整版本 JSON
    pub version: VersionJson,
    /// 共享目录（libraries / assets 放这里，多实例复用）
    pub shared_root: PathBuf,
    /// 实例目录（natives 放这里）
    pub instance_dir: PathBuf,
    pub source: Source,
    /// 是否下载全部资源文件（false 时只下 asset index）
    pub download_assets: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannedTasks {
    /// 任务清单（序列化给 UI 预览用）
    pub tasks: Vec<TaskInfo>,
    pub natives: Vec<NativeToExtract>,
    pub classpath: Vec<PathBuf>,
    pub client_jar: Option<PathBuf>,
    pub asset_index_path: Option<PathBuf>,
    pub total_bytes: u64,
    pub libraries_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskInfo {
    pub label: String,
    pub path: PathBuf,
    pub size: u64,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeToExtract {
    /// natives jar 的磁盘路径
    pub jar: PathBuf,
    pub exclude: Vec<String>,
}

/// 把版本 JSON 展开成任务清单。
///
/// 这个函数是**纯描述**：不算 URL 之外的东西、不碰网络、不写盘。
/// 好处是可以在下载前把"要下多少、下到哪"完全展示给用户（ADR-002 的思路）。
pub fn plan_tasks(input: &PlanInput, preferred: Source) -> Result<PlannedTasks> {
    let (tasks, natives, classpath, client_jar, asset_index_path, total) =
        plan_download_tasks(input, preferred)?;

    let infos: Vec<TaskInfo> = tasks
        .iter()
        .map(|t| TaskInfo {
            label: t.label.clone(),
            path: t.path.clone(),
            size: t.size,
            kind: classify(&t.label),
        })
        .collect();

    let libraries_count = classpath.len();

    Ok(PlannedTasks {
        tasks: infos,
        natives,
        classpath,
        client_jar,
        asset_index_path,
        total_bytes: total,
        libraries_count,
    })
}

/// 从任务标签推断类型（只用于 UI 分组展示）
fn classify(label: &str) -> &'static str {
    if label.starts_with("客户端 ") {
        "client"
    } else if label.starts_with("本地库 ") {
        "native"
    } else if label.starts_with("库 ") {
        "library"
    } else if label.starts_with("资源索引") {
        "asset-index"
    } else {
        "other"
    }
}

/* ====================== classpath 归集（启动侧用） ====================== */

/// 需要下载/校验的库盘点结果
#[derive(Debug, Default)]
pub struct ClasspathScan {
    pub classpath: Vec<PathBuf>,
    /// 需要解压的 natives：(jar 路径, extract.exclude)
    pub natives: Vec<(PathBuf, Vec<String>)>,
    /// **本平台真正需要、但磁盘上没有**的库（坐标）
    pub missing: Vec<String>,
    /// **本该由加载器安装器在本地生成、却不在盘上**的库（坐标）。
    ///
    /// 目前只有 Forge 系的 `net.minecraftforge:forge:<ver>:client`
    /// （77 MB 的打补丁客户端 jar，见 `is_forge_generated_client`）。
    ///
    /// ★ 与 `missing` 分开，因为**修法完全不同**：
    ///   · `missing`          → 下载能补（我们的自愈就是干这个的）
    ///   · `missing_generated` → 下载补不了（远程压根没有这个文件），
    ///                           只能**重装加载器**，让 processor 再跑一遍
    ///
    /// 混在一起的话，自愈会去下一个 404 的地址、失败、然后告诉用户
    /// "网络问题，稍后重试" —— 而重试一百次也没用。
    pub missing_generated: Vec<String>,
}

/// 库是否**本平台需要**（`rules` 通过 + natives 的架构/系统匹配）。
///
/// ★ 这是唯一一份"这个库要不要"的判据，下载规划与启动检查都用它。
///   踩过两次坑，都是因为两侧各写了一份、然后漂移：
///     ① 启动侧的缺库检查没滤平台 → 把 `natives-linux` / `-windows-arm64`
///        算成缺失，弹出"22 个库文件缺失，启动必然失败"；
///     ② 下载规划只认 `downloads.artifact` → Fabric profile 里那些
///        "只有 maven 基址 url"的库一个都没下 → `ClassNotFoundException: …KnotClient`。
pub fn library_is_wanted(lib: &Library, features: &HashMap<String, bool>) -> bool {
    if !metadata::rules_allow(&lib.rules, features) {
        return false;
    }
    /*
     * ★ 别的平台/架构的 natives：不需要，也不该报缺失。
     *
     *   两条判据都要问（坐标 + `natives` 字段）—— 只问坐标会漏掉
     *   老格式的 `jinput-platform` / `lwjgl-platform`（见
     *   `metadata::is_native_lib` 的说明，那是 1.12.2 崩溃的根因之一）。
     */
    if metadata::name_looks_native(&lib.name)
        && !metadata::native_matches_current_platform(&lib.name)
    {
        return false;
    }
    /*
     * ★ 老格式（1.13 及以前）的 natives 走 `natives` 字段 + `classifiers`：
     *   如果这个库声明了 natives、但**没有当前平台**的分类器
     *   （例如 `ca.weblite:java-objc-bridge` 只有 `natives-osx`），
     *   它就是"别的平台的东西" —— 在 Windows 上不需要，也不该报缺失。
     */
    if metadata::declares_natives(lib) {
        let for_us = lib.natives.contains_key(metadata::current_os_name());
        if !for_us {
            return false;
        }
    }
    true
}

/// 这条库在磁盘上的路径（maven 布局）
///
/// ★ 这里必须区分「主 jar」与「natives jar」：
///   老格式的 natives 库（`lwjgl-platform`）`downloads.artifact` 是一个
///   **22 字节的占位 jar**，真正有用的是 `classifiers.natives-windows`。
///   拿错那一个，natives 目录就会是空的。
pub fn library_disk_relative(lib: &Library) -> Option<String> {
    if let Some(rel) = metadata::legacy_natives_relative(lib) {
        return Some(rel);
    }
    lib.downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .and_then(|a| a.path.clone())
        .or_else(|| metadata::maven_path(&lib.name))
}

/// 扫出 classpath / natives，并报出**本平台真正缺失**的库。
///
/// 抽成纯函数是为了能被单测与集成测试锁定 —— 这里踩过一个很糟的坑：
/// 判"缺失"时没有先过滤平台，于是 `natives-windows-arm64` /
/// `-natives-linux` / `-natives-macos` 这些**别的架构、别的系统**的库
/// 全被算成缺失，启动时弹出"这个版本有 22 个库文件缺失，启动必然失败"。
/// 而它们本来就**不该**被下载 —— 用户去重装一百次也修不好。
pub fn scan_classpath(version: &VersionJson, shared: &Path) -> ClasspathScan {
    let mut out = ClasspathScan::default();
    let features: HashMap<String, bool> = HashMap::new();
    // 同一个库可能出现多条（1.12.2 里 lwjgl-platform 有 2.9.4 与 2.9.2 两条），
    // 只有一个该进 classpath / natives —— 重复会把两份互相冲突的 dll 解到同一个目录
    let mut seen_classpath: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_natives: std::collections::HashSet<String> = std::collections::HashSet::new();

    for lib in &version.libraries {
        if !library_is_wanted(lib, &features) {
            continue;
        }
        let is_legacy_natives = metadata::is_native_lib(lib);
        /*
         * ★★ 没有主 jar 的库（只有 natives 的条目）**不该被算成"缺失"**。
         *
         *   1.12.2 的 `net.java.jinput:jinput-platform:2.0.5` 就是这样：
         *   `downloads` 里只有三个平台的 `classifiers`，没有 `artifact` ——
         *   那个 `jinput-platform-2.0.5.jar` **不存在**（全网上 404）。
         *
         *   不跳过的话，"补全文件"会永远报它缺失，用户不管重装多少次都消不掉
         *   —— 而它本来就不该被下载。
         *
         * ★ 但**老格式的 natives 例外**：`lwjgl-platform` 有 artifact（22 字节占位符），
         *   真正要找的是 `classifiers.natives-windows` 那一个 —— 由
         *   `library_disk_relative` 负责选对，这里不能因为"有 artifact"就当成普通库。
         */
        if !is_legacy_natives && !lib.has_artifact() {
            continue;
        }
        /*
         * ★★ **编不出下载地址的库（Forge 的 `:client`）不能在这里判缺失。**
         *
         *   Forge 56+ 的版本 JSON 里有 `net.minecraftforge:forge:…:client`：
         *   `downloads.artifact` 在、`url` 是**空串**（`download_url` 返回 None），
         *   因为那个 77 MB 的 client jar 是安装器的 processor 拿原版 jar
         *   打补丁**本地生成**的，没有远程地址。
         *
         *   ⚠️ 顺序陷阱，我自己先踩了一次：这条判断原来放在**看盘之前**，
         *     于是连装得好好的 `26.2-forge-65.1.3`（client jar 75.52 MB
         *     就在盘上）也被报成"本地生成缺失"。
         *     是 `live_repair_missing.rs` 把两个 Forge 版本一起列出来，
         *     才看出"有文件的那个也被报了"。
         *
         *   所以真正的判断放在**看完盘之后**（见下面 `p.is_file()` 那段）：
         *   盘上有 → 照常进 classpath；盘上没有 → 才报"要重装加载器"。
         */
        let Some(rel) = library_disk_relative(lib) else {
            continue;
        };
        let p = shared.join("libraries").join(&rel);

        /*
         * ★★ **编不出下载地址、但盘上确实有的库 → 正常进 classpath。**
         *
         *   Forge 56+ 的 `net.minecraftforge:forge:…:client` 就是这个形态：
         *   `url` 是空串（安装器 processor 本地打补丁生成的 77 MB jar），
         *   所以 `download_url()` 返回 `None`。
         *
         *   ⚠️ 这里有个顺序陷阱，我自己先踩了一次：
         *     **不能因为"编不出地址"就判定它缺失** —— 必须**先看盘**。
         *     第一次改的时候我把这条判断放在了 `p.is_file()` **前面**，
         *     于是连装得好好的 `26.2-forge-65.1.3`（client jar 75.52 MB
         *     就在盘上）也被报成"本地生成缺失"。
         *     是 `live_repair_missing.rs` 把两个 Forge 版本一起列出来，
         *     才看出"有文件的那个也被报了"。
         *
         *   正确顺序：**先看盘上有没有 → 有就照常进 classpath；没有才报缺。**
         */
        // 盘上有：不管地址编不编得出来，它就是可用的
        if p.is_file() {
            if is_legacy_natives {
                if seen_natives.insert(rel.clone()) {
                    out.natives.push((
                        p,
                        lib.extract
                            .as_ref()
                            .map(|e| e.exclude.clone())
                            .unwrap_or_default(),
                    ));
                }
            } else if seen_classpath.insert(rel.clone()) {
                out.classpath.push(p);
            }
            continue;
        }
        /*
         * ★ 走到这里 = **盘上没有这个文件**。分三类处理。
         */
        if !is_legacy_natives && lib.download_url().is_none() {
            /*
             * ① 编不出地址的**本地产物**（Forge 的 `:client`）：
             *    该在却没在 → 是加载器没装好，**必须报出来**，
             *    但要说清"只能重装加载器"（下载补不了，远程没这个文件）。
             */
            if crate::domain::loader_trace::is_forge_generated_client(&lib.name) {
                out.missing_generated.push(lib.name.clone());
            }
            // ② 其它本地产物：既补不了也不影响启动，不报
            continue;
        }
        if !is_legacy_natives {
            /*
             * ③ 编得出地址、盘上没有 → 真缺失，能补。
             *
             * ★ natives jar 缺失**不在这里报**。
             *
             *   为什么：这个函数的产物 `missing` 是给用户看的
             *   「缺哪些文件，去重新安装一次」清单，判据是"classpath 上少了东西"。
             *   而 natives jar 的缺失有一个**更准的**判据：启动前的
             *   `count_native_binaries` 闸门 —— 它看的是"解压出来的 dll 有几个"，
             *   那才是游戏真正需要的东西。
             *
             *   在这里也报一次会有两个坏处：
             *     ① 刚装完、还没启动过的实例会被报"缺文件"，而它其实什么都不缺
             *        （下载计划**会**把 natives jar 下下来，只是这条检查跑在前面）；
             *     ② 同一件事在两个地方各有一套判据，迟早漂移。
             *
             *   所以：natives 缺了就缺着，启动时会被明确拦住并说清怎么修。
             */
            out.missing.push(lib.name.clone());
        }
    }
    out
}

/// 真正返回 DownloadTask 的实现（install 与 plan_tasks 共用）
///
/// `preferred` 是"期望的源"（用户设置 + 源健康度的综合结论），只影响候选排序，
/// 不影响候选集合 —— 排序靠前的先试，失败照样能换到另一个源。
#[allow(clippy::type_complexity)]
fn plan_download_tasks(
    input: &PlanInput,
    preferred: Source,
) -> Result<(
    Vec<DownloadTask>,
    Vec<NativeToExtract>,
    Vec<PathBuf>,
    Option<PathBuf>,
    Option<PathBuf>,
    u64,
)> {
    let v = &input.version;
    let shared = &input.shared_root;
    let features: HashMap<String, bool> = HashMap::new();

    let mut tasks: Vec<DownloadTask> = Vec::new();
    let mut natives: Vec<NativeToExtract> = Vec::new();
    let mut classpath: Vec<PathBuf> = Vec::new();
    let mut total: u64 = 0;

    /*
     * ① 客户端 jar
     *
     * ★ **客户端 jar 属于"基础版本"，不属于加载器版本**（实测踩坑）。
     *
     *   加载器版本的 JSON 是 `merge_versions(profile, vanilla)` 的结果：
     *   它的 `id` 是 `fabric-loader-0.16.9-26.2`，但 `id` 是
     *      `downloads.client` 是从**原版**继承来的（39 MB 的客户端 jar）。
     *   以前按 `v.id` 拼路径 → 把 39 MB 的客户端 jar 下到
     *   `versions/fabric-loader-0.16.9-26.2/fabric-loader-0.16.9-26.2.jar`，
     *   而**没有任何代码读那个路径**（启动时用的是 `versions/26.2/26.2.jar`）。
     *
     *   实测现象（用户报"fabric 下不动"）：那个目录里堆着
     *   `.part.0 … .part.7` 一共 9.3 MB 的分片段，`total` 写的是 39193383
     *   —— 下载器在下 39 MB 的**原版 jar**，只是名字叫 fabric-loader。
     *   又因为 26.2 的客户端 jar 在劣化的 CDN 边缘上很慢，就一直卡着。
     *
     *   修法：用 `inherits_from`（基础版本 id）拼路径；没有才用 v.id。
     */
    let base_id = v.inherits_from.clone().unwrap_or_else(|| v.id.clone());
    let mut client_jar = None;
    if let Some(dl) = v.downloads.as_ref().and_then(|d| d.client.as_ref()) {
        let path = shared
            .join("versions")
            .join(&base_id)
            .join(format!("{base_id}.jar"));
        let url = if dl.url.is_empty() {
            format!("{}/version/{}/client", mirror::BMCLAPI_BASE, base_id)
        } else {
            dl.url.clone()
        };
        push_task(
            &mut tasks,
            path.clone(),
            url,
            dl.sha1.clone(),
            dl.size,
            format!("客户端 {base_id}.jar"),
            preferred,
        );
        total += dl.size;
        client_jar = Some(path);
    }

    // ② 库
    for lib in &v.libraries {
        // ★ 用**共享判据**（与启动侧的 scan_classpath 同一份实现）。
        //   这两边曾经各写一份然后漂移，害了两次：
        //     · 启动侧没滤平台 → 假报"22 个库缺失"
        //     · 下载侧只认 downloads.artifact → Fabric 的库一个都没下
        if !library_is_wanted(lib, &features) {
            continue;
        }
        if matches!(lib.clientreq, Some(false)) {
            continue;
        }

        /*
         * ★ natives 是**要解压、不进 classpath** 的库。
         *
         *   两种格式都要认（用 `is_native_lib`，坐标 + `natives` 字段一起问）：
         *     · 现代格式（1.14+）：独立的库条目，坐标带 `natives-windows`；
         *     · 老格式（1.13-）：natives 挂在 `natives` 字段上，
         *       坐标形如 `org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209`
         *       —— **1.12.2 崩溃的根因就是这条被判成了普通库**。
         *   （架构/系统的过滤已经在 `library_is_wanted` 里做过：
         *    windows / windows-arm64 / windows-x86 三个变体的 rules 都允许 windows，
         *    不过滤会三个都下来，互相冲突。）
         */
        if metadata::is_native_lib(lib) {
            let Some(path) = library_disk_relative(lib).map(|r| shared.join("libraries").join(r))
            else {
                continue;
            };
            /*
             * ★★ 地址也要选对那一个。
             *
             *   老格式（1.12.2 的 `lwjgl-platform`）里 `downloads.artifact.url`
             *   指向的是 **22 字节的占位 jar**，真正装着 `lwjgl64.dll` 的是
             *   `downloads.classifiers["natives-windows"].url`。
             *   以前这里取 artifact → 下到一个 22 字节的 jar → 解压出 0 个文件
             *   → natives 目录空着 → 游戏死在
             *   `UnsatisfiedLinkError: no lwjgl64 in java.library.path`。
             */
            let cls = lib
                .downloads
                .as_ref()
                .map(|d| &d.classifiers)
                .and_then(|m| {
                    m.iter()
                        .find(|(k, _)| path.to_string_lossy().contains(k.as_str()))
                        .map(|(_, v)| v.clone())
                });
            let (url, sha1, size) = match cls {
                Some(c) if !c.url.is_empty() => (c.url.clone(), c.sha1.clone(), c.size),
                _ => {
                    let Some(url) = lib.download_url() else { continue };
                    let art = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());
                    (
                        url,
                        art.map(|a| a.sha1.clone()).unwrap_or_default(),
                        art.map(|a| a.size).unwrap_or(0),
                    )
                }
            };
            push_task(
                &mut tasks,
                path.clone(),
                url,
                sha1,
                size,
                format!("本地库 {}", short_name(&lib.name)),
                preferred,
            );
            total += size;
            natives.push(NativeToExtract {
                jar: path,
                exclude: lib
                    .extract
                    .as_ref()
                    .map(|e| e.exclude.clone())
                    .unwrap_or_default(),
            });
            continue; // ★ natives 不进 classpath
        }

        /*
         * ★★ 只有 natives、没有主 jar 的库：**不下载、也不进 classpath**。
         *
         *   用户报的「1.12.2 装不下来」真凶就是这条：
         *   `net.java.jinput:jinput-platform:2.0.5` 的 `downloads` 里只有
         *   `classifiers`（三个平台的 natives），**没有 `artifact`** ——
         *   那个 `jinput-platform-2.0.5.jar` 在世界上不存在
         *   （Mojang / BMCLAPI / Forge maven / Maven Central 全 404）。
         *
         *   而 `download_url()` 的老兜底会拿 maven 坐标拼一个出来 → 404 →
         *   三轮重试 → 整个安装失败（用户看到的就是那个红色报错）。
         *   它的 natives 走下面 ③ 的分支（`natives` 字段 + classifiers），
         *   那才是它该走的路。
         */
        if !lib.has_artifact() {
            /*
             * ★ 这里**不能 `continue`** —— natives 还得从 classifiers 下。
             *   所以只跳过"主 jar + classpath"这一段，直接进 natives 分支。
             */
            if lib.natives.is_empty() {
                continue; // 既没主 jar 也没 natives → 这条库没有任何东西要下
            }
        } else {
            /*
             * ★ 别因为"没有 downloads 字段"就跳过这条库。
             *
             *   实测踩过（Fabric 26.2 起不来）：Fabric 的 profile JSON 里
             *   `net.fabricmc:fabric-loader:0.19.5` 只有
             *   `"name"` + `"url": "https://maven.fabricmc.net/"`，
             *   **没有 `downloads`**。以前这里 `let Some(downloads) = &lib.downloads
             *   else { continue }` 直接跳过 → Fabric 的库一个都没下 →
             *   启动时报 `ClassNotFoundException: …KnotClient`（日志 164 字节）。
             *
             *   地址统一用 `Library::download_url()` 推：
             *   `downloads.artifact` → 库上的 `url` 基址 + maven 坐标 → 官方兜底。
             */
            let url = match lib.download_url() {
                Some(u) => u,
                None => continue,
            };
            let path = lib
                .downloads
                .as_ref()
                .and_then(|d| d.artifact.as_ref())
                .and_then(|a| a.path.clone())
                .map(|p| shared.join("libraries").join(p))
                .or_else(|| metadata::library_disk_path(shared, &lib.name));
            let Some(path) = path else { continue };

            let art = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());
            push_task(
                &mut tasks,
                path.clone(),
                url,
                art.map(|a| a.sha1.clone()).unwrap_or_default(),
                art.map(|a| a.size).unwrap_or(0),
                format!("库 {}", short_name(&lib.name)),
                preferred,
            );
            total += art.map(|a| a.size).unwrap_or(0);
            classpath.push(path);
        }

        // ③ 老格式（1.13 及以前）：natives 挂在 `natives` 字段里
        if !lib.natives.is_empty() {
            let Some(classifier) = metadata::legacy_natives_classifier(&lib.natives) else {
                continue;
            };
            let rel = natives_rel_path(&lib.name, &classifier);
            let path = shared.join("libraries").join(&rel);
            let (url, sha1, size) = match lib
                .downloads
                .as_ref()
                .and_then(|d| d.classifiers.get(&classifier))
            {
                Some(dl) => (dl.url.clone(), dl.sha1.clone(), dl.size),
                None => (
                    format!("https://libraries.minecraft.net/{rel}"),
                    String::new(),
                    0,
                ),
            };
            if !url.is_empty() {
                push_task(
                    &mut tasks,
                    path.clone(),
                    url,
                    sha1,
                    size,
                    format!("本地库 {}", short_name(&lib.name)),
                    preferred,
                );
                total += size;
            }
            natives.push(NativeToExtract {
                jar: path,
                exclude: lib
                    .extract
                    .as_ref()
                    .map(|e| e.exclude.clone())
                    .unwrap_or_default(),
            });
        }
    }

    // ③ 资源索引
    let mut asset_index_path = None;
    if let Some(idx) = &v.asset_index {
        let path = shared
            .join("assets")
            .join("indexes")
            .join(format!("{}.json", idx.id));
        push_task(
            &mut tasks,
            path.clone(),
            idx.url.clone(),
            idx.sha1.clone(),
            idx.size,
            format!("资源索引 {}", idx.id),
            preferred,
        );
        total += idx.size;
        asset_index_path = Some(path);
    }

    Ok((tasks, natives, classpath, client_jar, asset_index_path, total))
}

/// natives jar 在 libraries 下的相对路径，如
/// `org.lwjgl:lwjgl:3.3.1` + `natives-windows` → `org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar`
fn natives_rel_path(coordinate: &str, classifier: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    let group = parts.first().copied().unwrap_or("").replace('.', "/");
    let artifact = parts.get(1).copied().unwrap_or("");
    let version = parts.get(2).copied().unwrap_or("");
    format!("{group}/{artifact}/{version}/{artifact}-{version}-{classifier}.jar")
}

fn short_name(coordinate: &str) -> String {
    let parts: Vec<&str> = coordinate.split(':').collect();
    match (parts.get(1), parts.get(2)) {
        (Some(a), Some(v)) => format!("{a}-{v}"),
        _ => coordinate.to_string(),
    }
}

/* ====================== 资源索引展开 ====================== */

/// 把 asset index 展开成资源文件下载任务。
///
/// ★ 3598 个文件（1.20.1）。全下约 500 MB、最快也要几分钟，
///   所以允许 `limit` 只下一个前缀子集（游戏缺资源时会自己联网补，
///   这样能先让"启动"这条路走通）。
pub fn asset_tasks(
    index: &metadata::AssetIndex,
    shared_root: &Path,
    limit: Option<usize>,
    preferred: Source,
) -> (Vec<DownloadTask>, u64) {
    let mut tasks = Vec::with_capacity(index.objects.len().min(limit.unwrap_or(usize::MAX)));
    let mut total = 0u64;

    // 排序保证可复现（HashMap 迭代顺序随机）
    let mut entries: Vec<(&String, &metadata::AssetObject)> = index.objects.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));

    for (name, obj) in entries {
        if let Some(l) = limit {
            if tasks.len() >= l {
                break;
            }
        }
        let path = metadata::asset_disk_path(shared_root, &obj.hash);
        let url = format!(
            "https://resources.download.minecraft.net/{}",
            metadata::asset_rel_path(&obj.hash)
        );
        push_task(
            &mut tasks,
            path,
            url,
            obj.hash.clone(),
            obj.size,
            name.clone(),
            preferred,
        );
        total += obj.size;
    }
    (tasks, total)
}

/* ====================== 老版本的虚拟资源 ====================== */

/// 虚拟资源的目标位置。
///
/// `name` 同时是 `--assetsIndex` / `--assetIndex` 要传的名字，
/// 也是 `assets/virtual/<name>/` 的目录名 —— **两边必须用同一个值**，
/// 否则游戏去一个目录找、我们把文件铺在另一个目录，结果还是"没有贴图"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualAssets {
    /// 铺开后的绝对路径
    pub dir: std::path::PathBuf,
    /// 名字（= 资源索引 id）
    pub name: String,
}

/// 这个版本的资源需要铺开吗？需要就返回目标位置（**纯函数，可单测**）。
///
/// 触发条件是索引自己的 `virtual` / `map_to_resources` 字段，
/// 不看 MC 版本号 —— Mojang 历史上两个字段都用过，猜版本号必然漏。
pub fn virtual_assets_kind(
    index: &metadata::AssetIndex,
    index_id: &str,
) -> Option<VirtualAssets> {
    if !index.needs_virtual_assets() {
        return None;
    }
    let name = metadata::virtual_assets_dir_name(index_id);
    Some(VirtualAssets {
        dir: std::path::PathBuf::from("virtual").join(&name),
        name,
    })
}

/// 把 `objects/<hash>` 里的资源**按原名**铺到 `assets/virtual/<name>/<原路径>`。
///
/// 优先硬链接（同卷零拷贝、不占额外空间），失败退回复制。
/// 返回 (成功数, 失败数)。失败不阻断安装 —— 游戏缺几个贴图还能跑，
/// 但日志里必须留下确切的数字（不能假装成功）。
pub async fn materialize_virtual_assets(
    index: &metadata::AssetIndex,
    shared_root: &Path,
    dest_rel: &Path,
) -> (usize, usize) {
    let dest_root = shared_root.join("assets").join(dest_rel);
    let objects = shared_root.join("assets").join("objects");
    let mut done = 0usize;
    let mut failed = 0usize;

    for (name, obj) in &index.objects {
        let src = objects.join(metadata::asset_rel_path(&obj.hash));
        // 目录穿越防护：索引里的 key 理论上可信，但绝不拿它拼出目录外的路径
        if name.split(['/', '\\']).any(|seg| seg == ".." || seg.is_empty()) {
            failed += 1;
            continue;
        }
        let dst = dest_root.join(name.replace('\\', "/"));
        if dst.is_file() {
            done += 1;
            continue;
        }
        if let Some(parent) = dst.parent() {
            if tokio::fs::create_dir_all(parent).await.is_err() {
                failed += 1;
                continue;
            }
        }
        if !src.is_file() {
            failed += 1;
            continue;
        }
        // ① 硬链接（同卷最快，且不额外占空间）
        if tokio::fs::hard_link(&src, &dst).await.is_ok() {
            done += 1;
            continue;
        }
        // ② 复制兜底（跨卷 / 文件系统不支持硬链接）
        match tokio::fs::copy(&src, &dst).await {
            Ok(_) => done += 1,
            Err(_) => failed += 1,
        }
    }
    (done, failed)
}

/* ====================== 执行安装 ====================== */

pub struct InstallOptions {
    pub concurrency: usize,
    pub download_assets: bool,
    /// 资源文件数量上限（None = 全下）
    pub asset_limit: Option<usize>,
    pub cancel: super::download::CancelToken,
    /// ★★ 暂停令牌。`None` = 这次安装不可暂停（自愈、测试、内部调用）。
    ///
    /// 它会被透传到两个下载批次（核心文件 + 资源文件），
    /// 所以"暂停"在**任何一个阶段**都能生效，而不只是第一阶段。
    pub pause: Option<super::download::PauseToken>,
    pub on_progress: std::sync::Arc<dyn Fn(String, super::download::DownloadProgress) + Send + Sync>,
}

impl InstallOptions {
    /// 最简构造（测试与 CLI 用）
    pub fn new(concurrency: usize, cancel: super::download::CancelToken) -> Self {
        Self {
            concurrency,
            download_assets: true,
            asset_limit: None,
            cancel,
            pause: None,
            on_progress: std::sync::Arc::new(|_, _| {}),
        }
    }
}

/// 发一条阶段进度（统一构造，避免每个调用点各自拼一遍字段）
///
/// ★ `finished_files` 是**这一阶段**的计数，不是整批的 ——
///   前端任务中心显示的是 `phase · finished / total 个文件`，
///   所以每个阶段开始时必须从 0 重新计数（否则会出现 "12 / 12" 接着又跳回 "0 / 3598"）。
fn report(opts: &InstallOptions, stage: &str, total_files: usize, finished: usize, current: String) {
    (opts.on_progress)(
        stage.to_string(),
        super::download::DownloadProgress {
            finished_files: finished,
            total_files,
            finished_bytes: 0,
            total_bytes: 0,
            bytes_per_second: 0,
            current_file: current,
            skipped_files: 0,
            failed_files: 0,
            source: String::new(),
            retry_round: 0,
        },
    );
}

/// 构造一份"**被暂停**"的安装结果（`paused = true`）。
///
/// ★ 存在的理由：暂停时**不能**走"最后那段收尾"（写最终 JSON、跑加载器
///   安装器、报 `Ok(装好了)`）。但调用方拿到的仍然要是一个完整的结构体 ——
///   所以这里把"此刻盘上真实有什么"如实填进去，并打上 `paused` 标记。
///   有没有下完，**由 `paused` 说**，不由字段是否为空来暗示。
#[allow(clippy::too_many_arguments)]
fn paused_result(
    input: &PlanInput,
    instance: &std::path::Path,
    classpath: Vec<PathBuf>,
    client_jar: Option<PathBuf>,
    libraries_count: usize,
    assets_count: usize,
    total_bytes: u64,
    retry_rounds: u32,
    repaired_files: usize,
    remaining_files: usize,
    stage: &str,
) -> InstalledVersion {
    InstalledVersion {
        id: input.version.id.clone(),
        json_path: input
            .shared_root
            .join("versions")
            .join(&input.version.id)
            .join(format!("{}.json", input.version.id)),
        client_jar,
        classpath,
        natives_dir: instance.join("natives"),
        asset_index_id: input
            .version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_default(),
        main_class: input.version.main_class.clone(),
        libraries_count,
        assets_count,
        total_bytes,
        retry_rounds,
        repaired_files,
        failed_assets: Vec::new(),
        paused: true,
        remaining_files,
        paused_stage: Some(stage.to_string()),
    }
}

/// 执行完整安装：下载 → 写版本 JSON
///
/// ★ **不在安装阶段解压 natives**（见函数末尾的说明）：
///   解压跟着实例目录走，放在启动时做。
pub async fn install(input: &PlanInput, opts: InstallOptions) -> Result<InstalledVersion> {
    let shared = input.shared_root.clone();
    let instance = input.instance_dir.clone();

    // ★ 连这个目录都**不建**：以前 `create_dir_all(instance/natives)` 会让每个
    //   装过的版本都在 instances/ 下留下一个空的 install-{mc} 孤儿目录
    //   （实测 install-26.1.1 / install-26.1.2 就是这种 0 字节的空壳）。
    //   natives 由启动流程解压到实例目录，安装阶段完全不碰。

    // ★ 安装开始**之前**清一次 `shared/` 下的下载残留（`.part` / `.part.N` /
    //   `.part.chunks`）。用户实测：`shared/versions/26.1.2/` 里躺了 37 MB 分片段、
    //   `1.21.1/` 里 23 MB —— 以前没有任何代码扫这里（clean_parts 只扫实例目录），
    //   装失败一次就永久留几十 MB。此刻是安全的：还没有任务在写临时文件。
    let cleaned = super::download::clean_shared_parts(&shared).await;
    if cleaned > 0 {
        say!("[IEML/installer] 清理了 {cleaned} 个上次残留的下载临时文件");
    }

    // ★ 期望源 = 用户设置 + 源健康度的综合结论（不是只看设置：
    //   用户选了官方源但官方正在 429 时，硬着头皮先撞一次没有意义）
    let manager = source::global();
    let preferred = if input.source == Source::Mojang && manager.is_cooling(Source::Mojang) {
        manager.preferred()
    } else {
        input.source
    };

    /*
     * ★★ **前置自检：修掉"有 jar、没有版本 JSON"的半成品目录。**
     *
     *   实测（本机真实数据）：`versions/1.20.1` / `1.21.1` / `26.1.1` / `rd-132211`
     *   这几份目录里**只有客户端 jar、没有同名 json**。这种目录：
     *     · 起不来 —— `prepare_spec` 找不到版本描述就报错
     *     · 也没法"点重新安装修好" —— 下载器看到 jar 已经在就跳过，
     *       而 json **永远不会**被补上（它是在安装**末尾**写的，
     *       中途取消/失败就没了）
     *
     *   为什么会这样：版本 JSON 在 `install()` 的**最后**才写盘，
     *   而客户端 jar 在第一批就下完了。安装一旦中途取消（用户点了取消、
     *   关掉启动器、断电），磁盘上就留下"jar 有了、json 没有"的半成品。
     *
     *   修法：安装**开始之前**检查这个版本目录 ——
     *   **没有同名 json 就把它整个删掉重来**。代价是可能重下几十 MB，
     *   换来的是"这份目录一定能被修好"。删之前只在 json 缺失时才动手，
     *   绝不动一份完好的版本。
     */
    {
        let vid = &input.version.id;
        let vdir = shared.join("versions").join(vid);
        let vjson = vdir.join(format!("{vid}.json"));
        if vdir.is_dir() && !vjson.is_file() {
            let has_any = std::fs::read_dir(&vdir)
                .map(|mut rd| rd.next().is_some())
                .unwrap_or(false);
            if has_any {
                say!(
                    "[IEML/installer] {vid} 的目录里没有版本描述（半成品，起不来也修不好）\
                     —— 删掉重下：{}",
                    vdir.display()
                );
                let _ = std::fs::remove_dir_all(&vdir);
            }
        }
    }

    // 并发：用户要的并发 与 源管理器建议的并发 取小（被限流过就降下来）
    let concurrency = manager.recommended_concurrency(opts.concurrency);
    if concurrency < opts.concurrency {
        say!(
            "[IEML/installer] 源被限流过，并发从 {} 降到 {concurrency}",
            opts.concurrency
        );
    }

    /*
     * ★★ **先把版本 JSON 落盘**，再去下载。
     *
     *   为什么顺序很重要（实测的"只有 jar 没有 json"就是这么来的）：
     *   版本 JSON 原来是安装**最后**才写的，而客户端 jar 第一批就下完了。
     *   中途取消/失败 → 留下"jar 有了、json 没有"的目录 →
     *   起不来，而且点"重新安装"也修不好（jar 在就跳过下载，json 永不补）。
     *
     *   先写一份的额外好处：安装失败时用户至少能在「版本列表」里看到这个版本，
     *   而不是一片空白加上一句"安装失败"。
     *   （末尾还会再写一次 —— 那次是合并后的最终状态。）
     */
    {
        let dir = shared.join("versions").join(&input.version.id);
        if tokio::fs::create_dir_all(&dir).await.is_ok() {
            if let Ok(text) = serde_json::to_string_pretty(&input.version) {
                let _ = tokio::fs::write(dir.join(format!("{}.json", input.version.id)), text).await;
            }
        }
    }

    let (mut tasks, natives, classpath, client_jar, asset_index_path, mut total) =
        plan_download_tasks(input, preferred)?;

    let lib_count = classpath.len();

    report(
        &opts,
        "准备",
        tasks.len(),
        0,
        format!("{} 个库 · {} 个文件 · 源 {}", lib_count, tasks.len(), preferred.as_str()),
    );

    // ---------- 第一批：客户端 + 库 + natives + 资源索引 ----------
    /*
     * ★★ 第一批**也要能暂停**（P0-3）。
     *
     *   这里原来是写死的 `pause: None` —— 而第一批恰恰是最大的一块
     *   （客户端 jar 37 MB + 几十个库），用户在这段时间里按"暂停"，
     *   界面显示"已暂停"、下载却一路跑到底。
     *   两批用同一个令牌，暂停在**任何一个阶段**都生效。
     */
    let stage1 = download_batch(
        std::mem::take(&mut tasks),
        BatchOptions {
            concurrency,
            source: preferred,
            cancel: opts.cancel.clone(),
            pause: opts.pause.clone(),
            on_progress: {
                let cb = std::sync::Arc::clone(&opts.on_progress);
                std::sync::Arc::new(move |p| cb("下载核心文件".into(), p))
            },
        },
    )
    .await?;

    /*
     * ★★ 被暂停 → **立刻如实返回"暂停"，不往下走**。
     *
     *   返回 `Ok` 而不是 `Err`：暂停不是失败（前端要区分"已暂停，可以继续"
     *   与"失败了"）。但返回的这份 `InstalledVersion` **不许**被当成
     *   "装好了" —— `paused = true` 就是给调用方的标记。
     */
    if stage1.paused {
        let remaining_files = stage1.remaining.len();
        say!(
            "[IEML/installer] 第一批被暂停：已完成 {} 个，还剩 {remaining_files} 个未开始",
            stage1.processed_files
        );
        return Ok(paused_result(
            input,
            &instance,
            classpath,
            client_jar,
            lib_count,
            0,
            total,
            stage1.retry_rounds,
            stage1.repaired_files,
            remaining_files,
            "下载核心文件",
        ));
    }

    if !stage1.failed.is_empty() {
        let sample: Vec<String> = stage1
            .failed
            .iter()
            .take(3)
            .map(|(n, e)| format!("{n}：{e}"))
            .collect();
        return Err(NetError::Other(format!(
            "有 {} 个文件下载失败（已自动重试 {} 轮），例如：{}",
            stage1.failed.len(),
            stage1.retry_rounds,
            sample.join("；")
        )));
    }
    // 引擎统计：用户/日志要能看到"补下过几轮、修过几个坏文件"
    let retry_rounds = stage1.retry_rounds;
    let mut repaired = stage1.repaired_files;

    // ---------- 第二批：资源文件 ----------
    let mut assets_count = 0usize;
    let mut asset_retry_rounds = 0u32;
    let mut failed_assets: Vec<(String, String)> = Vec::new();
    say!(
        "[IEML/installer] 资源阶段：download_assets={} asset_index_path={:?} asset_limit={:?}",
        opts.download_assets,
        asset_index_path.as_ref().map(|p| p.display().to_string()),
        opts.asset_limit
    );
    if opts.download_assets {
        if let Some(idx_path) = &asset_index_path {
            let text = tokio::fs::read_to_string(idx_path)
                .await
                .map_err(|e| NetError::Other(format!("读资源索引失败：{e}")))?;
            let index: metadata::AssetIndex = serde_json::from_str(&text)
                .map_err(|e| NetError::Other(format!("解析资源索引失败：{e}")))?;
            // 索引 id（= 文件名去掉 .json），虚拟资源目录名要用它
            let index_id = idx_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let (asset_tasks_v, asset_bytes) =
                asset_tasks(&index, &shared, opts.asset_limit, preferred);
            assets_count = asset_tasks_v.len();
            total += asset_bytes;

            let outcome = download_batch(
                asset_tasks_v,
                BatchOptions {
                    // ★ 资源文件是海量小文件，高并发收益远大于核心文件阶段——
                    //   至少 48 路，网络慢时能明显把吞吐顶上去（HTTP/2 复用连接，无副作用）。
                    //   但**仍然受源管理器约束**：吃过 429 就把并发压回去，
                    //   否则"更高并发"只会换来更多 429（PCL2 8.2 的教训）。
                    concurrency: manager.recommended_concurrency(opts.concurrency.max(48)),
                    source: preferred,
                    cancel: opts.cancel.clone(),
                    pause: opts.pause.clone(),
                    on_progress: {
                        let cb = std::sync::Arc::clone(&opts.on_progress);
                        std::sync::Arc::new(move |p| cb("下载资源文件".into(), p))
                    },
                },
            )
            .await?;

            /*
             * ★★ 资源阶段被暂停 → 同样**立刻如实返回**（P0-3）。
             *
             *   注意位置：在 `materialize_virtual_assets` 与"失败清单"之前。
             *   暂停不是"资源下失败了"，不该顺手去铺虚拟资源、也不该报
             *   "有 N 个资源文件失败"（那些只是**还没轮到**）。
             */
            if outcome.paused {
                let remaining_files = outcome.remaining.len();
                say!(
                    "[IEML/installer] 资源阶段被暂停：已完成 {} 个，还剩 {remaining_files} 个未开始",
                    outcome.processed_files
                );
                return Ok(paused_result(
                    input,
                    &instance,
                    classpath,
                    client_jar,
                    lib_count,
                    assets_count,
                    total,
                    retry_rounds + outcome.retry_rounds,
                    repaired + outcome.repaired_files,
                    remaining_files,
                    "下载资源文件",
                ));
            }

            asset_retry_rounds = outcome.retry_rounds;
            repaired += outcome.repaired_files;
            failed_assets = outcome.failed.clone();

            /*
             * ★★ 老版本（1.6.4 及以前）必须把资源**按原名铺开** ★★
             *
             *   现代版本的游戏从 `assets/indexes/<id>.json` + `assets/objects/`
             *   按 hash 找资源，所以"下到 objects 里"就够了。
             *   但 1.6.4 及更早的游戏**不认识内容寻址** —— 它按
             *   `assets/<命名空间>/<路径>` 直接读文件。若不铺开：
             *   游戏能起来，**所有贴图与声音全丢**（材质变成紫黑格、静音）。
             *
             *   触发条件来自索引自身（`virtual` / `map_to_resources` 任一为真），
             *   不靠版本号猜 —— Mojang 历史上这两个字段都用过。
             *   铺开用**硬链接**（同一卷上零拷贝），失败再退回复制。
             */
            if let Some(kind) = virtual_assets_kind(&index, &index_id) {
                let dest_root = shared.join("assets").join(&kind.dir);
                let (done, failed) =
                    materialize_virtual_assets(&index, &shared, &dest_root).await;
                say!(
                    "[IEML/installer] 虚拟资源：{} 个文件铺到 {}（失败 {} 个）",
                    done,
                    dest_root.display(),
                    failed
                );
                (opts.on_progress)(
                    format!("铺开老版本资源（{} 个）", done),
                    super::download::DownloadProgress {
                        finished_files: done,
                        /*
                         * ★ 这里 `done + failed` **就是**这一个阶段的总数
                         *   （`materialize_virtual_assets` 是同步跑完再返回的，
                         *   没有中间进度）—— 所以它不违反"分母必须是计划数"
                         *   那条纪律：它本身就是计划数，只是这个阶段的计划
                         *   要跑完才知道。
                         *
                         *   ★ 但它**不能**拿去当"整个安装"的分母 —— 那是
                         *     `plan.tasks.len()` 的事（见资源阶段那条注释）。
                         */
                        total_files: done + failed,
                        finished_bytes: 0,
                        total_bytes: 0,
                        bytes_per_second: 0,
                        current_file: dest_root.display().to_string(),
                        skipped_files: 0,
                        failed_files: failed,
                        source: preferred.as_str().to_string(),
                        retry_round: 0,
                    },
                );
            }

            // 资源文件允许部分失败（游戏会自己补），但要告知
            if !outcome.failed.is_empty() {
                // ★ 必须把**真实的错误文本**打出来。
                //   踩过的坑：只报"23 个失败"，日志里查不到任何原因 ——
                //   23 个是 404？是超时？还是校验失败？完全无法判断。
                say!(
                    "[IEML/installer] 资源文件失败 {} 个（已补下 {} 轮、修复 {} 个），样例：",
                    outcome.failed.len(),
                    outcome.retry_rounds,
                    outcome.repaired_files
                );
                for (label, err) in outcome.failed.iter().take(5) {
                    say!("    · {label} → {err}");
                }
                (opts.on_progress)(
                    format!("资源文件有 {} 个失败（游戏启动时会自行补全）", outcome.failed.len()),
                    super::download::DownloadProgress {
                        finished_files: outcome.finished_files,
                        /*
                         * ★★ 分母必须是**计划里的资源文件总数**。
                         *
                         *   原来这里写的是
                         *   `outcome.finished_files + outcome.failed.len()` ——
                         *   一个**自己拼出来的**分母，它不等于计划数：
                         *     · 漏了 `skipped_files`（已下过、这次跳过的）；
                         *     · 重试轮里下成功的那些既不在 finished 也不在 failed
                         *       （它们进了 finished），两个数加起来仍然不对。
                         *   结果界面上的"已完成 / 总数"与计划里标注的文件数
                         *   **对不上** —— 用户报的正是这个（「下载实际文件和我们
                         *   标注的文件数量不一致」）。
                         *
                         *   现在用计划数当分母、用"处理完了几个"当分子，
                         *   与进度事件、与批次结论三者同源。
                         */
                        total_files: assets_count,
                        finished_bytes: outcome.total_bytes,
                        total_bytes: outcome.total_bytes,
                        bytes_per_second: 0,
                        current_file: String::new(),
                        skipped_files: outcome.skipped_files,
                        failed_files: outcome.failed.len(),
                        source: preferred.as_str().to_string(),
                        retry_round: outcome.retry_rounds,
                    },
                );
            }
        }
    }

    /*
     * ---------- natives：**安装时不解压**（用户实机发现的问题） ----------
     *
     * 以前这里把每个 natives jar 解压到 `install-{mc_version}/natives/`，
     * 占 ~15 MB，然后**没有任何代码读它**：
     *   · 启动时 `prepare_spec` 会按实例 slug 重新解压到
     *     `instances/{slug}/natives/`；
     *   · 前端也从不读安装返回的 `natives_dir`。
     * 结果是每个装过的版本都在 instances/ 下留一个孤儿目录
     * （实测 install-26.1.1 / install-26.1.2 / install-26.2 三个，
     * 其中 install-26.2 里躺着 15 MB 的 dll），用户看到只会更困惑。
     *
     * 解压放在**启动时**才是对的：解压必须跟着实例目录走，
     * 而安装命令压根不知道实例 slug（同一个版本可以有多个实例）。
     */
    let natives_target = instance.join("natives");
    if !natives.is_empty() {
        say!(
            "[IEML/installer] {} 个 natives jar 不在安装阶段解压（启动时解压到实例目录：{}）",
            natives.len(),
            natives_target.display()
        );
    }

    /*
     * ---------- 写版本 JSON（**两个名字都写**） ----------
     *
     * ★ 这里踩过一个很隐蔽的坑：安装与启动对"版本 JSON 叫什么"的约定不一致。
     *
     *   安装：把 JSON 写在 `versions/{version.id}/{version.id}.json`。
     *         Fabric profile 的 `id` 是 **`fabric-loader-0.19.5-26.2`**（profile 自带），
     *         所以文件叫 `fabric-loader-0.19.5-26.2.json`。
     *   启动：`prepare_spec` 拼的是 `versions/{version_id}/{mc_version}.json`
     *         → 找 `versions/fabric-loader-0.19.5-26.2/26.2.json` → **找不到**。
     *
     *   找不到的后果不是"报错"，而是**静默落回原版 JSON**：
     *   于是主类还是 Fabric 的 `net.fabricmc.loader.impl.launch.knot.KnotClient`，
     *   但 classpath 里一个 Fabric 库都没有 →
     *   `错误: 找不到或无法加载主类 net.fabricmc.loader.impl.launch.knot.KnotClient`
     *   （实测 26.2 + Fabric 0.19.5 就是这个表现，日志只有 164 字节）。
     *
     *   修法：**两个名字都写一份**（内容完全相同）。成本是一个 36 KB 的副本，
     *   换来"谁来找都能找到" —— 比让两侧去猜对方的命名约定可靠得多。
     */
    let dir = shared.join("versions").join(&input.version.id);
    tokio::fs::create_dir_all(&dir).await?;
    let json_text = serde_json::to_string_pretty(&input.version)
        .map_err(|e| NetError::Other(format!("序列化版本 JSON 失败：{e}")))?;
    let json_path = dir.join(format!("{}.json", input.version.id));
    /*
     * ★★ **版本 JSON 要在**下载开始前**就先写一份。**
     *
     *   实测（本机真实数据）：`versions/1.20.1` / `1.21.1` / `26.1.1` /
     *   `rd-132211` 这几份目录里**只有客户端 jar、没有同名 json** ——
     *   起不来，而且点"重新安装"也修不好（jar 在 → 跳过下载；json 永不补）。
     *
     *   根因就是这个函数：它原来只在 `install()` 的**最后**被调用，
     *   而客户端 jar 在第一批就下完了。安装中途取消（用户点取消 / 关掉
     *   启动器 / 断电）就会留下"jar 有了、json 没有"的半成品。
     *
     *   现在改成**两处都写**：安装**一开始**先落一份（即使后面失败，
     *   版本描述也在，用户至少能看到这个版本、也能被补全），
     *   安装**结束后**再写一次（这次是最终状态，含合并结果）。
     */
    tokio::fs::write(&json_path, &json_text).await?;
    // 启动侧按 mc_version 找，所以再用 mc 版本号写一份（id 不同时才有必要）
    let alt_id = &input.version.id;
    let mc_like = input
        .version
        .inherits_from
        .clone()
        .unwrap_or_else(|| alt_id.clone());
    if mc_like != *alt_id {
        let alt = dir.join(format!("{mc_like}.json"));
        if !alt.is_file() {
            tokio::fs::write(&alt, &json_text).await?;
            say!(
                "[IEML/installer] 版本 JSON 写了两份：{}.json + {}.json（安装/启动两侧命名约定不同）",
                alt_id, mc_like
            );
        }
    }

    Ok(InstalledVersion {
        id: input.version.id.clone(),
        json_path,
        client_jar,
        classpath,
        natives_dir: natives_target,
        asset_index_id: input
            .version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_default(),
        main_class: input.version.main_class.clone(),
        libraries_count: lib_count,
        // assets_count 只统计"这一轮真的安排下过的资源文件数"
        assets_count,
        total_bytes: total,
        retry_rounds: retry_rounds + asset_retry_rounds,
        repaired_files: repaired,
        failed_assets,
        // 走到这里 = 两批都跑完了（没被暂停）—— 见两个阶段的 `paused` 提前返回
        paused: false,
        remaining_files: 0,
        paused_stage: None,
    })
}

/* ====================== 已有版本的"自愈" ====================== */

/// 一次自愈的结果
#[derive(Debug, Clone, Serialize)]
pub struct RepairReport {
    /// 盘上缺了几个文件（客户端 / 库 / natives / 资源索引）
    pub missing: usize,
    /// 这一轮真的补回来几个
    pub repaired: usize,
    /// 补不回来的（标签，原因）
    pub failed: Vec<(String, String)>,
    /// 给用户看的一句话
    pub summary: String,
}

/// ★★ **把已装版本缺的文件补齐**（自愈）。
///
/// ## 为什么非要有这个函数
///
/// 实测（本机真实数据）：`versions/1.20.1/` 里躺着 23 MB 的客户端 jar 和
/// 62 KB 的版本描述，但**43 个库里有 35 个根本不在盘上**。
/// 这种版本：
///   · 点启动 → `scan_classpath` 报"缺 35 个库文件" → 被拦下，玩不了；
///   · 点"重新安装" → 下载规划**会**把缺的库排进去，所以其实能修好，
///     但那要求用户自己想到"重新安装"；而界面上它明明写着"已安装"。
///
/// 一个"已安装"却打不开、用户又不知道该点哪里的版本，是我们最该消灭的状态。
/// 所以启动前先自愈：**缺什么补什么**，补不齐才报错。
///
/// ## 与 `install()` 的分工
///
///   `install()`  = 完整安装（下全部 + 写版本 JSON + 记统计）
///   `repair_missing()` = 只扫盘 → 只下缺的那些 → 报告
///
/// 两者共用同一个 `plan_download_tasks`，所以"该有哪些文件"这份判据只有一份，
/// 不会出现"安装认为齐全、启动认为缺失"这种两侧漂移。
///
/// ★ 只下**盘上没有的**文件：`download_batch` 本来就有"已存在且校验通过就跳过"
///   的逻辑，所以这里不下多余的东西，纯补缺。
pub async fn repair_missing(
    input: &PlanInput,
    opts: InstallOptions,
) -> Result<RepairReport> {
    let manager = source::global();
    let preferred = if input.source == Source::Mojang && manager.is_cooling(Source::Mojang) {
        manager.preferred()
    } else {
        input.source
    };

    let (tasks, _natives, _classpath, _client_jar, _asset_index, _total) =
        plan_download_tasks(input, preferred)?;

    // 只留"盘上没有"的 —— 有的话就甭管了（校验交给 download_batch）
    let missing: Vec<DownloadTask> = tasks
        .into_iter()
        .filter(|t| !t.path.is_file())
        .collect();

    let missing_count = missing.len();
    if missing_count == 0 {
        return Ok(RepairReport {
            missing: 0,
            repaired: 0,
            failed: Vec::new(),
            summary: "文件齐全，不需要补".to_string(),
        });
    }

    say!(
        "[IEML/repair] {} 缺 {missing_count} 个文件，开始自愈（源 {}）",
        input.version.id,
        preferred.as_str()
    );
    report(
        &opts,
        "补齐缺失文件",
        missing_count,
        0,
        format!("缺 {} 个文件，正在补", missing_count),
    );

    let concurrency = manager.recommended_concurrency(opts.concurrency);
    let outcome = download_batch(
        missing,
        BatchOptions {
            concurrency,
            source: preferred,
            cancel: opts.cancel.clone(),
            pause: None,
            on_progress: {
                let cb = std::sync::Arc::clone(&opts.on_progress);
                std::sync::Arc::new(move |p| cb("补齐缺失文件".into(), p))
            },
        },
    )
    .await?;

    let repaired = outcome.finished_files + outcome.skipped_files;
    let failed = outcome.failed.clone();
    for (label, err) in failed.iter().take(5) {
        say!("[IEML/repair] 补不上：{label} → {err}");
    }

    let summary = if failed.is_empty() {
        format!("补齐了 {} 个缺失文件", repaired)
    } else {
        format!(
            "缺 {} 个，补回 {} 个，还有 {} 个没补上",
            missing_count,
            repaired,
            failed.len()
        )
    };
    say!("[IEML/repair] {}：{summary}", input.version.id);

    Ok(RepairReport {
        missing: missing_count,
        repaired,
        failed,
        summary,
    })
}

/// 解压 natives jar 到目标目录。
///
/// 过滤规则（**都是必需的，少一条游戏就起不来或起得莫名其妙**）：
///   ① 跳过 `META-INF/` —— 里面是签名文件，解压出来会被 Java 当成非法签名
///   ② 跳过库自带的 `extract.exclude` 列表
///   ③ 跳过 LWJGL 官方发行物里混进来的 git 元数据 ——
///      实测 `lwjgl-3.3.1-natives-windows.jar` 里有 `.dll.git`、`.dll.sha1`
///      这类文件（官方启动器也会过滤掉），它们会在 natives 目录里制造噪音
///   ④ 只保留当前平台的子目录（jar 内结构是 `windows/x64/org/lwjgl/lwjgl.dll`）
///   ⑤ zip-slip 防护
pub fn extract_natives(jar: &Path, dest: &Path, exclude: &[String]) -> std::io::Result<usize> {
    let file = std::fs::File::open(jar)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    std::fs::create_dir_all(dest)?;
    let mut count = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let Some(path) = entry.enclosed_name() else {
            continue; // ⑤ zip-slip 防护
        };
        let name = path.to_string_lossy().replace('\\', "/");

        // ① META-INF
        if name.starts_with("META-INF/") || name.contains("/META-INF/") {
            continue;
        }
        // ② 库自带的排除列表
        if exclude
            .iter()
            .any(|e| name.starts_with(e.trim_end_matches('/')))
        {
            continue;
        }
        // ③ LWJGL 发行物里的 git / 校验元数据
        let lower = name.to_lowercase();
        if lower.ends_with(".git")
            || lower.ends_with(".sha1")
            || lower.ends_with(".sha256")
            || lower.ends_with(".md5")
            || lower.ends_with(".x")
        {
            continue;
        }
        if entry.is_dir() {
            continue;
        }

        // ④ 只保留当前平台的条目（`windows/x64/...` / `linux/x64/...` / `macos/...`）
        if let Some(first) = name.split('/').next() {
            let known_platforms = ["windows", "linux", "macos", "freebsd"];
            if known_platforms.contains(&first) && first != crate::net::metadata::current_os_name() {
                // macos 在 Mojang 里叫 osx
                let matches_osx = first == "macos"
                    && crate::net::metadata::current_os_name() == "osx";
                if !matches_osx {
                    continue;
                }
            }
        }

        let out = dest.join(path.file_name().unwrap_or(path.as_os_str()));
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut f = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut f)?;
        count += 1;
    }
    Ok(count)
}

/// 校验已安装的版本是否完整（启动前自检）
pub async fn verify_installed(installed: &InstalledVersion) -> Vec<String> {
    let mut problems = Vec::new();

    if !installed.json_path.is_file() {
        problems.push(format!("缺少版本描述文件：{}", installed.json_path.display()));
    }
    if let Some(jar) = &installed.client_jar {
        if !jar.is_file() {
            problems.push(format!("缺少客户端 jar：{}", jar.display()));
        }
    }
    for lib in &installed.classpath {
        if !lib.is_file() {
            problems.push(format!("缺少库文件：{}", lib.display()));
        }
    }

    // 顺带清理上次中断留下的 .part
    let cleaned = super::download::clean_parts(&installed.natives_dir.parent().unwrap_or(Path::new("."))).await;
    if cleaned > 0 {
        problems.push(format!("清理了 {cleaned} 个未完成的临时文件"));
    }

    problems
}

/// 计算文件 SHA1 的公开入口（给 Tauri 命令用）
pub async fn file_sha1(path: &Path) -> Result<String> {
    sha1_of_file(path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vj(id: &str, libs: Vec<Library>, main: &str) -> VersionJson {
        VersionJson {
            id: id.into(),
            inherits_from: None,
            release_type: "release".into(),
            main_class: main.into(),
            assets: String::new(),
            asset_index: None,
            downloads: None,
            libraries: libs,
            arguments: None,
            minecraft_arguments: None,
            java_version: None,
            logging: None,
            compliance_level: None,
        }
    }

    fn lib(name: &str) -> Library {
        Library {
            name: name.into(),
            downloads: None,
            url: None,
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        }
    }

    /// ★ Fabric profile 的写法：只有 name + maven 基址 url，**没有 downloads**。
    ///   实测这条被跳过导致 Fabric 起不来（`ClassNotFoundException: …KnotClient`）。
    #[test]
    fn library_url_falls_back_to_maven_base() {
        let l = Library {
            name: "net.fabricmc:fabric-loader:0.19.5".into(),
            downloads: None,
            url: Some("https://maven.fabricmc.net/".into()),
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        };
        assert_eq!(
            l.download_url().unwrap(),
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar"
        );

        // 基址没带结尾斜杠也要能拼对
        let l2 = Library {
            url: Some("https://maven.fabricmc.net".into()),
            ..l.clone()
        };
        assert_eq!(l2.download_url().unwrap(), l.download_url().unwrap());

        // 连 url 都没有 → 官方库兜底（老版本 JSON 常见）
        let l3 = Library {
            name: "org.ow2.asm:asm:9.5".into(),
            downloads: None,
            url: None,
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        };
        assert_eq!(
            l3.download_url().unwrap(),
            "https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar"
        );
    }

    /// ★★ **自带 `downloads` 但 `url` 是空的库 → 不可下载，不要替它编地址。**
    ///
    ///   Forge 56+ 的版本 JSON 里有 `net.minecraftforge:forge:…:client`：
    ///   `downloads.artifact` 在、`url` 是**空串** —— 那个 77 MB 的 client jar
    ///   是安装器的 processor 拿原版 jar 打补丁**本地生成**的，没有远程地址。
    ///
    ///   老代码在这里会拿 maven 坐标拼一个 `libraries.minecraft.net` 地址出来
    ///   （必然 404），于是 `26.1.2-forge-64.1.3` 永远被启动检查拦下，
    ///   报"缺 1 个库文件"，重装几次都消不掉。
    #[test]
    fn locally_generated_library_has_no_download_url() {
        let forge_client = Library {
            name: "net.minecraftforge:forge:26.1.2-64.1.3:client".into(),
            downloads: Some(metadata::LibraryDownloads {
                artifact: Some(metadata::DownloadRef {
                    path: Some(
                        "net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-client.jar"
                            .into(),
                    ),
                    url: String::new(), // ← Forge 给的就是空串
                    sha1: "2c0a98a0c35f5efac83aaaae96d95831235da51f".into(),
                    size: 77124153,
                }),
                classifiers: HashMap::new(),
            }),
            url: None,
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        };
        assert_eq!(
            forge_client.download_url(),
            None,
            "★ 空 url = 本地产物，远程没有这个文件；编一个地址只会永远 404"
        );
        assert!(
            crate::domain::loader_trace::is_forge_generated_client(&forge_client.name),
            "这个坐标要被认成「安装器本地生成」，否则启动时会去补一个补不到的文件"
        );

        // `:universal` 有真 url，必须照常能下
        let universal = Library {
            name: "net.minecraftforge:forge:26.1.2-64.1.3:universal".into(),
            downloads: Some(metadata::LibraryDownloads {
                artifact: Some(metadata::DownloadRef {
                    path: Some(
                        "net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-universal.jar"
                            .into(),
                    ),
                    url: "https://maven.minecraftforge.net/net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-universal.jar".into(),
                    sha1: "5692b73569869044c393a74227e7ee0df0c030bb".into(),
                    size: 2791745,
                }),
                classifiers: HashMap::new(),
            }),
            url: None,
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        };
        assert!(universal.download_url().is_some(), "有 url 就得照常能下");
        assert!(
            !crate::domain::loader_trace::is_forge_generated_client(&universal.name),
            ":universal 是下载来的，不属于「本地生成」那一类"
        );
    }

    /// ★★ 这条测试在 2026-09-14 改过断言，因为去重键**必须是库的身份**
    ///   （完整坐标 + natives），不能只是 `group:artifact`。
    ///
    ///   老断言是 `len() == 2`（"子版本的 asm:9.5 顶掉父版本的 asm:9.4"）——
    ///   而那个行为**会让加载器版本起不来**：
    ///   1.16.5 的 json 里 lwjgl 有 `3.2.1` 与 `3.2.2` 两代
    ///   （`3.2.1` 的 rules 只允许 osx、`3.2.2` 允许 windows），
    ///   按 `group:artifact` 去重 → 先遇到的 `3.2.1` 赢 →
    ///   classpath 上是 3.2.1 → 游戏崩在
    ///   `NoClassDefFoundError: org/lwjgl/BufferUtils`。
    ///
    ///   现在两个版本**都留着**，由 `scan_classpath` 按各自的 rules 过滤 ——
    ///   那才是正确的分工：**合并负责别丢东西，过滤负责选对东西**。
    #[test]
    fn merge_keeps_distinct_versions_and_dedups_identity() {
        let child = vj("child", vec![lib("org.ow2.asm:asm:9.5")], "ChildMain");
        let parent = vj(
            "parent",
            vec![lib("org.ow2.asm:asm:9.4"), lib("com.google:guava:31")],
            "ParentMain",
        );
        let m = merge_versions(&child, &parent);
        let names: Vec<&str> = m.libraries.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            m.libraries.len(),
            3,
            "★ 两个**不同版本**的 asm 都要留着（丢掉高版本会让游戏 NoClassDefFoundError）：{names:?}"
        );
        assert!(names.contains(&"org.ow2.asm:asm:9.5"));
        assert!(names.contains(&"org.ow2.asm:asm:9.4"));
        assert!(names.contains(&"com.google:guava:31"));
        assert_eq!(m.main_class, "ChildMain");

        // 真·重复（坐标完全相同）仍然只留一条，且子优先
        let dup_child = vj("c", vec![lib("a:b:1")], "M");
        let dup_parent = vj("p", vec![lib("a:b:1"), lib("a:b:2")], "M");
        let dm = merge_versions(&dup_child, &dup_parent);
        assert_eq!(
            dm.libraries.len(),
            2,
            "坐标完全相同的要按身份去重，只有版本不同的才并存：{:?}",
            dm.libraries.iter().map(|l| &l.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn merge_inherits_parent_mainclass_when_child_empty() {
        let child = vj("child", vec![], "");
        let parent = vj("parent", vec![], "net.minecraft.client.main.Main");
        let m = merge_versions(&child, &parent);
        assert_eq!(m.main_class, "net.minecraft.client.main.Main");
    }

    #[test]
    fn natives_rel_path_shape() {
        assert_eq!(
            natives_rel_path("org.lwjgl:lwjgl:3.3.1", "natives-windows"),
            "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar"
        );
    }

    /* ---------- ★★ 用户报的「1.12.2 装不下来」 ---------- */

    /// 真实的 1.12.2 原版 JSON 里那条 natives-only 库（从 BMCLAPI 实测拉下来的形状）。
    ///
    /// 关键：`downloads` 里**只有 `classifiers`**，没有 `artifact`。
    fn jinput_platform_lib() -> Library {
        serde_json::from_str(
            r#"{
                "name": "net.java.jinput:jinput-platform:2.0.5",
                "downloads": {
                    "classifiers": {
                        "natives-windows": {
                            "path": "net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-windows.jar",
                            "sha1": "385ee093e01f587f30ee1c8a2ee7d408fd732e16",
                            "size": 155179,
                            "url": "https://libraries.minecraft.net/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-windows.jar"
                        }
                    }
                },
                "natives": { "windows": "natives-windows" },
                "extract": { "exclude": ["META-INF/"] }
            }"#,
        )
        .unwrap()
    }

    /// ★★ 回归：natives-only 的库**不许**被当成"有主 jar"。
    ///
    ///   这条以前是错的，后果是用户看到的那条红色报错：
    ///   ```
    ///   有 1 个文件下载失败（已自动重试 3 轮），例如：库 jinput-platform-2.0.5：
    ///   所有下载源都失败了（试过 2 个）：mojang: HTTP 404 …；bmclapi: HTTP 404 …
    ///   /net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5.jar
    ///   ```
    ///   那个 jar **在世界上不存在**（实测 Mojang / BMCLAPI / Forge maven /
    ///   Maven Central 全 404），存在的只有 `…-natives-windows.jar`。
    ///   而 `download_url()` 的老兜底会拿 maven 坐标**拼一个出来** → 必然 404。
    #[test]
    fn natives_only_library_has_no_artifact_to_download() {
        let l = jinput_platform_lib();
        assert!(
            !l.has_artifact(),
            "★ 只有 classifiers 的库没有主 jar —— 不许去下载一个不存在的文件"
        );
        // 它的 natives 仍然要能拿到（走 downloads.classifiers）
        let c = metadata::legacy_natives_classifier(&l.natives).expect("windows 平台应当能解出 classifier");
        assert_eq!(c, "natives-windows");
        assert!(l.downloads.as_ref().unwrap().classifiers.contains_key(&c));
    }

    /// Fabric 那种**没有 `downloads` 字段**的库必须仍然被当成"有主 jar"
    /// （否则 26.2 的 Fabric 会一个库都不下 → `ClassNotFoundException: KnotClassLoader`）
    #[test]
    fn library_without_downloads_field_still_counts_as_having_an_artifact() {
        let l: Library = serde_json::from_str(
            r#"{"name":"net.fabricmc:fabric-loader:0.19.5","url":"https://maven.fabricmc.net/"}"#,
        )
        .unwrap();
        assert!(
            l.has_artifact(),
            "没有 downloads 字段是另一种写法，不是「没有主 jar」"
        );
        assert_eq!(
            l.download_url().unwrap(),
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar"
        );
    }

    /// ★ 扫描 classpath 时也不能把 natives-only 的库算成"缺失"。
    ///
    ///   不修的话"补全文件"会**永远**报它缺失，用户重装一百次也消不掉 ——
    ///   而它本来就不该被下载。
    #[test]
    fn scan_classpath_does_not_report_natives_only_library_as_missing() {
        let tmp = std::env::temp_dir().join(format!("ieml-scan-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let mut v = vj("1.12.2", vec![jinput_platform_lib()], "Main");
        v.assets = "1.12".into();
        let scan = scan_classpath(&v, &tmp);
        assert!(
            scan.missing.is_empty(),
            "★ natives-only 的库不该被报成缺失（它没有主 jar）：{:?}",
            scan.missing
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn short_name_uses_artifact_and_version() {
        assert_eq!(short_name("org.ow2.asm:asm:9.5"), "asm-9.5");
    }

    #[test]
    fn lib_key_ignores_version() {
        assert_eq!(lib_key("org.ow2.asm:asm:9.5"), "org.ow2.asm:asm");
        assert_eq!(lib_key("org.ow2.asm:asm:9.4"), "org.ow2.asm:asm");
    }

    /* ---------- 客户端 jar 的归属 ★ 用户报"fabric 下不动" ---------- */

    /// ★ 回归测试：**客户端 jar 属于基础版本**，不属于加载器版本。
    ///
    ///   加载器版本的 JSON 是 `merge_versions(profile, vanilla)` 的结果，
    ///   它的 `downloads.client` 是从**原版继承**来的（39 MB）。
    ///   以前按 `v.id` 拼路径 → 把 39 MB 的客户端 jar 下到
    ///   `versions/fabric-loader-0.16.9-26.2/fabric-loader-0.16.9-26.2.jar`，
    ///   而**没有任何代码读那个路径**（启动时用 `versions/26.2/26.2.jar`）。
    ///
    ///   实测现象：那个目录里堆着 `.part.0 … .part.7` 共 9.3 MB，段计划里
    ///   `total: 39193383` —— 用户看到的就是"fabric 下不动"
    ///   （其实是在下一个永远没人用的 39 MB 客户端 jar）。
    #[test]
    fn client_jar_belongs_to_the_base_version_not_the_loader() {
        let shared = std::env::temp_dir().join("ieml-test-clientjar");
        let _ = std::fs::remove_dir_all(&shared);

        let loader_json = r#"{
            "id": "fabric-loader-0.16.9-26.2",
            "inheritsFrom": "26.2",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [],
            "downloads": {
                "client": { "url": "https://piston-data.mojang.com/x/client.jar", "sha1": "abc", "size": 39193383 }
            }
        }"#;
        let version: VersionJson = serde_json::from_str(loader_json).unwrap();
        let input = PlanInput {
            version,
            shared_root: shared.clone(),
            instance_dir: shared.join("inst"),
            source: Source::Bmclapi,
            download_assets: false,
        };
        let (tasks, _, _, client_jar, _, _) = plan_download_tasks(&input, Source::Bmclapi).unwrap();

        let jar = client_jar.expect("应该有客户端 jar 任务");
        let rel = jar
            .strip_prefix(&shared)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            rel, "versions/26.2/26.2.jar",
            "★ 客户端 jar 必须落在**基础版本**目录下，实际：{rel}"
        );
        assert!(
            !rel.contains("fabric-loader"),
            "★ 不能落到加载器版本目录（没有任何代码读那里）：{rel}"
        );
        // 标签也用基础版本号，别让用户看到 "客户端 fabric-loader-….jar"
        assert_eq!(tasks[0].label, "客户端 26.2.jar");

        let _ = std::fs::remove_dir_all(&shared);
    }

    /// 没有 inheritsFrom 的普通版本：行为不变（jar 落在自己目录）
    #[test]
    fn client_jar_uses_own_id_for_vanilla() {
        let shared = std::env::temp_dir().join("ieml-test-clientjar2");
        let _ = std::fs::remove_dir_all(&shared);
        let json = r#"{
            "id": "26.2",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [],
            "downloads": { "client": { "url": "https://x/y", "sha1": "a", "size": 1 } }
        }"#;
        let version: VersionJson = serde_json::from_str(json).unwrap();
        let input = PlanInput {
            version,
            shared_root: shared.clone(),
            instance_dir: shared.join("inst"),
            source: Source::Bmclapi,
            download_assets: false,
        };
        let (_, _, _, client_jar, _, _) = plan_download_tasks(&input, Source::Bmclapi).unwrap();
        let rel = client_jar
            .unwrap()
            .strip_prefix(&shared)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(rel, "versions/26.2/26.2.jar");
        let _ = std::fs::remove_dir_all(&shared);
    }

    /// ★ 回归测试（Fabric 起不来）：去重键**必须带 classifier**。
    ///
    ///   Fabric 的 profile 带 `org.lwjgl:lwjgl:3.4.1:natives-linux`，
    ///   原版带 `org.lwjgl:lwjgl:3.4.1`。只按 group:artifact 去重时两者同名，
    ///   子版本优先 → 原版那条**基础 lwjgl 库被丢掉** →
    ///   `ClassNotFoundException: org.lwjgl.system.CallbackI`（实测）。
    #[test]
    fn lib_key_keeps_classifier() {
        assert_ne!(
            lib_key("org.lwjgl:lwjgl:3.4.1"),
            lib_key("org.lwjgl:lwjgl:3.4.1:natives-linux"),
            "带 classifier 与不带的库是**两条不同的库**，不能互相顶掉"
        );
        assert_eq!(lib_key("org.lwjgl:lwjgl:3.4.1:natives-linux"), "org.lwjgl:lwjgl:natives-linux");
        // 同 classifier 不同版本仍然互通（子顶父）
        assert_eq!(
            lib_key("org.lwjgl:lwjgl:3.4.1:natives-windows"),
            lib_key("org.lwjgl:lwjgl:3.3.1:natives-windows")
        );
        // 裸名字也不能炸
        assert_eq!(lib_key("foo"), "foo");
    }

    /// ★ 端到端回归：拿真实的 Fabric profile 合并原版，**基础 lwjgl 必须还在**。
    ///   手工构造会更省事，但真实 JSON 才能抓住"我没想到的那种条目"。
    #[test]
    fn merge_keeps_base_lwjgl_when_loader_brings_a_classifier_variant() {
        let base = |name: &str| Library {
            name: name.into(),
            downloads: None,
            url: None,
            rules: vec![],
            natives: HashMap::new(),
            clientreq: None,
            extract: None,
        };
        let child = vj(
            "fabric-loader-0.19.5-26.2",
            vec![
                base("org.lwjgl:lwjgl:3.4.1:natives-linux"), // 加载器带来的、本平台不要的变体
                base("net.fabricmc:fabric-loader:0.19.5"),
            ],
            "net.fabricmc.loader.impl.launch.knot.KnotClient",
        );
        let parent = vj(
            "26.2",
            vec![
                base("org.lwjgl:lwjgl:3.4.1"), // ★ 基础库：必须活下来
                base("org.lwjgl:lwjgl-glfw:3.4.1"),
            ],
            "net.minecraft.client.main.Main",
        );
        let m = merge_versions(&child, &parent);
        let names: Vec<&str> = m.libraries.iter().map(|l| l.name.as_str()).collect();
        assert!(
            names.contains(&"org.lwjgl:lwjgl:3.4.1"),
            "★ 基础 lwjgl 被 natives-* 变体顶掉了：{names:?}"
        );
        assert!(names.contains(&"org.lwjgl:lwjgl-glfw:3.4.1"), "{names:?}");
        assert!(names.contains(&"net.fabricmc:fabric-loader:0.19.5"), "{names:?}");
        assert_eq!(m.main_class, "net.fabricmc.loader.impl.launch.knot.KnotClient");
    }

    /* ---------- ★★ P0-3：暂停必须真的停下来、并且如实上报 ---------- */

    /// 一个"有活要干"的计划：一条库要下。库地址指向真实主机，但
    /// **暂停闸门在 spawn 之前**，所以这条测试一个网络请求都不会发。
    fn pause_fixture(tag: &str) -> (PlanInput, PathBuf) {
        let base = std::env::temp_dir().join(format!("ieml-pause-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let version = vj(
            "1.20.1",
            vec![lib("org.ow2.asm:asm:9.5"), lib("org.ow2.asm:asm-tree:9.5")],
            "net.minecraft.client.main.Main",
        );
        let input = PlanInput {
            version,
            shared_root: base.join("shared"),
            instance_dir: base.join("inst"),
            source: Source::Bmclapi,
            download_assets: false,
        };
        (input, base)
    }

    /// ★★ 一开始就按下暂停 → `install()` 必须
    ///   ① 返回 `Ok`（暂停**不是失败**）；② `paused = true`；
    ///   ③ 说清还剩几个文件；④ **不许**把这次当成装完了。
    ///
    ///   这就是 P0-3 那条缺陷的守门测试：老代码把引擎的 `paused` 扔掉，
    ///   照常往下走、照常返回"成功"，于是界面上写着"安装完成"而一个字节
    ///   都没下 —— 而第一批甚至根本没接上暂停令牌（写死的 `pause: None`）。
    #[tokio::test]
    async fn install_reports_paused_instead_of_pretending_success() {
        let (input, base) = pause_fixture("first");
        let pause = super::super::download::PauseToken::new();
        pause.pause();

        let mut opts = InstallOptions::new(2, super::super::download::CancelToken::new());
        opts.pause = Some(pause.clone());
        opts.download_assets = false;

        let r = install(&input, opts).await.expect("暂停不是错误，必须是 Ok");
        assert!(r.paused, "★ 暂停必须如实报告 paused=true");
        assert!(
            r.remaining_files >= 2,
            "★ 还要说清还剩几个文件没下（实际 {}）",
            r.remaining_files
        );
        assert!(
            !pause.is_paused() || r.paused,
            "令牌处于暂停态时结果不许是「已完成」"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 反向：**没按暂停**时 `paused` 必须是 `false`、`remaining_files` 必须是 0。
    ///
    ///   否则界面会把一次正常安装显示成"已暂停"（另一种骗人）。
    ///   这条会真的去下载那两个库（网络失败也算数）—— 因为我们只断言
    ///   "没有被标成暂停"，不断言成败。失败路径里 `install()` 返回 `Err`，
    ///   那同样不是"暂停"。
    #[tokio::test]
    async fn install_without_pause_is_never_reported_as_paused() {
        let (input, base) = pause_fixture("nopause");
        let mut opts = InstallOptions::new(2, super::super::download::CancelToken::new());
        opts.pause = Some(super::super::download::PauseToken::new()); // 从未按下
        opts.download_assets = false;

        match install(&input, opts).await {
            Ok(r) => {
                assert!(!r.paused, "没按暂停就不许报「已暂停」");
                assert_eq!(r.remaining_files, 0);
            }
            Err(_) => { /* 网络不通 → 失败路径，本来就不该谈暂停 */ }
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
