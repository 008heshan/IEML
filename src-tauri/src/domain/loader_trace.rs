//! 加载器痕迹判定（共享给安装页 / 版本列表 / 启动定位）
//! ------------------------------------------------------------------
//! **为什么必须有这个模块**（用户报的两个 bug 的根因）：
//!
//!   ① 「点击一个没有 Forge 的版本，会导致有 Forge 的版本也说没有 Forge」
//!      —— 界面上的加载器可用性曾经是**缓存的推导结果**，切版本时旧结果
//!      会短暂地"代言"新版本。判定必须**每次从磁盘上的真实文件读**，
//!      而不是从"上次查到的结论"里读。
//!
//!   ② 「启动一个装了 Forge 的版本，却报没有加载器痕迹」
//!      —— 判定逻辑曾经散在三处（`fetch_version_manifest` 的 `installed`、
//!      `resolve_loader_version_id`、`find_version_json`），各写各的，必然漂移。
//!      这里只实现一次，三处都调它。
//!
//! **判据是"库坐标 + 主类"，不是目录名。**
//!   目录名是安装器随手起的（`1.20.1-forge-47.4.23`、`fabric-loader-0.19.5-26.2`、
//!   老版本甚至是 `1.7.10-Forge10.13.4.1614-1.7.10` 这种大小写混排），
//!   而库坐标（`net.minecraftforge:forge`）与主类（`KnotClient`）是**内容事实**。
//!   另外老版本没有加载器版本 JSON —— 它们是把库直接写进版本 JSON 的，
//!   所以"看库"是唯一能同时覆盖新旧两种安装形态的办法。

use serde::{Deserialize, Serialize};

/// 实例里能叠的东西：基础加载器 + 附加组件。
///
/// 注意 `optifine` / `liteloader` 也在这里 —— 用户说的"高清修复"就是 OptiFine，
/// 它同样是一个"装没装上"的事实，必须和加载器一起被实时判定（ADR-004）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderFlavor {
    Forge,
    NeoForge,
    Fabric,
    Quilt,
    OptiFine,
    LiteLoader,
}

impl LoaderFlavor {
    /// URL / 请求里用的短名（与前端 `BaseLoaderKind` 对齐）
    pub fn key(self) -> &'static str {
        match self {
            Self::Forge => "forge",
            Self::NeoForge => "neoforge",
            Self::Fabric => "fabric",
            Self::Quilt => "quilt",
            Self::OptiFine => "optifine",
            Self::LiteLoader => "liteloader",
        }
    }

    /// 面向用户的名字
    pub fn display(self) -> &'static str {
        match self {
            Self::Forge => "Forge",
            Self::NeoForge => "NeoForge",
            Self::Fabric => "Fabric",
            Self::Quilt => "Quilt",
            Self::OptiFine => "OptiFine",
            Self::LiteLoader => "LiteLoader",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "forge" => Some(Self::Forge),
            "neoforge" | "neo_forge" => Some(Self::NeoForge),
            "fabric" => Some(Self::Fabric),
            "quilt" => Some(Self::Quilt),
            "optifine" => Some(Self::OptiFine),
            "liteloader" => Some(Self::LiteLoader),
            _ => None,
        }
    }

    /// 基础加载器（附加组件返回 false）
    pub fn is_base(self) -> bool {
        matches!(self, Self::Forge | Self::NeoForge | Self::Fabric | Self::Quilt)
    }

    pub const ALL: [Self; 6] = [
        Self::Forge,
        Self::NeoForge,
        Self::Fabric,
        Self::Quilt,
        Self::OptiFine,
        Self::LiteLoader,
    ];
}

/// 从一份版本 JSON 的**原始文本**里读出痕迹。
///
/// ★ 收文本而不是收结构体：启动/安装两侧用的是 `VersionJson`，
///   但"某个目录里躺着什么"还需要看其它形态的文件（老版本、手改的 JSON）。
///   收文本让本函数成为唯一的判据来源，也便于单测（不需要构造完整结构体）。
///
/// ★ 判据的顺序很关键：`neoforge` 的库坐标里含子串 `forge`，
///   所以**必须先判 NeoForge**，否则 NeoForge 会被误判成 Forge。
pub fn detect_flavors(raw_json: &str) -> Vec<LoaderFlavor> {
    let t = raw_json.to_lowercase();
    let mut out = Vec::new();

    // ① NeoForge：库坐标 net.neoforged / net/neoforged，或主类 neoforge 相关
    if t.contains("neoforged")
        || t.contains("neoforge")
        || t.contains("neo_forge")
    {
        out.push(LoaderFlavor::NeoForge);
    }
    // ② Forge：库坐标 net.minecraftforge，或老版本的 minecraftforge 目录
    if t.contains("minecraftforge") || t.contains("net.minecraftforge") {
        out.push(LoaderFlavor::Forge);
    }
    // ③ Fabric：fabric-loader / fabricmc / KnotClient
    if t.contains("fabricmc") || t.contains("fabric-loader") || t.contains("knotclient") {
        out.push(LoaderFlavor::Fabric);
    }
    // ④ Quilt：quiltmc / quilt-loader / QuiltKnot
    if t.contains("quiltmc") || t.contains("quilt-loader") || t.contains("quiltknot") {
        out.push(LoaderFlavor::Quilt);
    }
    // ⑤ OptiFine：optifine 库坐标或 OptiFine 主类（高清修复）
    if t.contains("optifine") {
        out.push(LoaderFlavor::OptiFine);
    }
    // ⑥ LiteLoader：liteloader / com.mumfrey
    if t.contains("liteloader") || t.contains("mumfrey") {
        out.push(LoaderFlavor::LiteLoader);
    }

    out
}

/// 只要主类就算数的"强判据"版本 —— 用于分辨 `forge` 与 `neoforge` 这种子串包含关系。
pub fn main_class_hint(raw_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    v.get("mainClass")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/* ====================== 加载器生成的"本地产物" ====================== */

/// Forge 系的 `:client` 坐标 = **本地打补丁生成的客户端 jar**。
///
/// Forge 56+ 的版本 JSON 里长这样（`26.1.2-64.1.3` 的真实内容）：
/// ```json
/// { "name": "net.minecraftforge:forge:26.1.2-64.1.3:client",
///   "downloads": { "artifact": {
///       "path": "net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-client.jar",
///       "url":  "",                    ← 空：没有远程地址
///       "size": 77124153 } } }
/// ```
/// 这个 77 MB 的 jar **不是下载来的**，是 Forge 安装器的 processor
/// 拿原版 jar 打补丁**本地生成**的 —— 所以 `url` 是空串。
///
/// ## 为什么值得单独认出来
///
///   · **安装**时必须由 processor 生成（`--installClient` 那一步省不掉）；
///   · **启动**时必须在 classpath 上（游戏本体就是它）；
///   · 两边都不能"没有就当没有" —— 缺了就是装坏了，
///     而且修法是**重装 Forge**，不是"补下文件"（远程地址根本不存在）。
///
///   实测：`26.1.2-forge-64.1.3` 缺这个 jar（processor 没跑成），
///   而 `26.2-65.1.3` 有（75.52 MB）。老代码给这个空 url 编了个
///   `libraries.minecraft.net` 地址 → 必然 404 → 那个版本永远被拦下，
///   报"缺 1 个库文件"，用户重装几次都消不掉。
pub fn is_forge_generated_client(coordinate: &str) -> bool {
    let parts: Vec<&str> = coordinate.split(':').collect();
    parts.len() >= 4 && parts[0] == "net.minecraftforge" && parts[1] == "forge" && parts[3] == "client"
}

/* ====================== 加载器版本号的规范化 ====================== */

/// 从磁盘上的一个版本 id 里剥出加载器自身的版本号。
///
/// ★ 这只是**兜底**：真正的版本号应该从版本 JSON 的库坐标里读
///   （`loader_versions_in_json`）。目录名是安装器随手起的，这里只负责
///   把最常见的几种形态认出来。
///
/// 实测的目录名形态（都是真实产出，不能只认一种）：
///   `1.20.1-forge-47.4.23`             → `47.4.23`
///   `1.20.1-neoforge-21.1.72`          → `21.1.72`
///   `neoforge-1.20.4-20.4.237`         → `20.4.237`
///   `1.7.10-Forge10.13.4.1614-1.7.10`  → `10.13.4.1614`
///   `1.7.10-Forge10.13.4.1614`         → `10.13.4.1614`
///   `fabric-loader-0.19.5-26.2`        → `0.19.5`
///   `quilt-loader-0.20.0-1.20.1`       → `0.20.0`
///   `OptiFine_1.20.1_HD_U_I6`          → `HD_U_I6`
///   `1.20.1-OptiFine_HD_U_I6`          → `HD_U_I6`
pub fn loader_version_from_id(id: &str) -> Option<String> {
    let lower = id.to_lowercase();

    // ① fabric / quilt：`<kind>-loader-<ver>[-<mc>]`。
    //    ★ 必须切**最后**一个 `-loader-`：坐标形态 `net.fabricmc:fabric-loader:0.19.5`
    //      里同时含 `fabric-loader`（组名+artifact）与真正的前缀，
    //      `find` 会命中第一个，切出来就成了 `loader:0.19.5` —— 废的。
    for prefix in ["fabric-loader-", "quilt-loader-"] {
        if let Some(pos) = lower.rfind(prefix) {
            let rest = &id[pos + prefix.len()..];
            if let Some(v) = parse_loader_version_of(rest) {
                return Some(v);
            }
        }
    }

    // ② forge / neoforge。★ 两条纪律：
    //    a) `neoforge` 是独立形态，不能并进 forge 那组：它的目录名有
    //       `neoforge-1.20.4-20.4.237` 这种**以加载器名开头**的写法；
    //    b) 长的针必须排在短的前面（`-forge-` 先于 `-forge`），
    //       否则 `1.12.2-forge1.12.2-14.23.5.2860` 会被 `-forge` 切出
    //       `1.12.2-14.23.5.2860`，再取第一段就得到 `1.12.2`（错得离谱）。
    for needle in ["-neoforge-", "-neoforge", "-forge-", "-forge"] {
        if let Some(pos) = lower.find(needle) {
            let rest = &id[pos + needle.len()..];
            let cleaned = rest.trim_start_matches(['-', '_']);
            if let Some(v) = parse_loader_version_of(cleaned) {
                return Some(v);
            }
        }
    }
    for prefix in ["neoforge-", "forge-"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest_orig = &id[id.len() - rest.len()..];
            let cleaned = rest_orig.trim_start_matches(['-', '_']);
            // `neoforge-1.20.4-20.4.237`：剥掉 MC 版本，剩下的才是加载器版本
            if let Some(v) = strip_mc_prefix(cleaned).filter(|v| looks_like_loader_version(v)) {
                return Some(v.to_string());
            }
            if let Some(v) = parse_loader_version_of(cleaned) {
                return Some(v);
            }
        }
    }

    // ③ OptiFine：`OptiFine_1.20.1_HD_U_I6` / `1.20.1-OptiFine_HD_U_I6`
    if let Some(pos) = lower.find("optifine") {
        let rest = &id[pos + "optifine".len()..];
        let rest = rest.trim_start_matches(['_', '-']);
        let rest = strip_mc_prefix(rest).unwrap_or(rest);
        let v = rest.trim_matches(['_', '-']).to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }

    None
}

/// 从"加载器 token 之后剩下的字符串"里取出加载器版本号。
///
/// 入口形态五花八门，这里统一定成两条规则，**顺序固定**：
///
///   ① **尾段是 MC 版本就剥掉，然后取第一段。**
///      加载器目录名总是 `<加载器><版本>-<MC 版本>` 的形状，所以最后一段
///      如果"长得像 MC 版本"，它就是 MC 版本，不是加载器版本的一部分：
///        `47.4.23-1.20.1`      → `47.4.23`
///        `0.19.5-26.2`         → `0.19.5`
///        `10.13.4.1614-1.7.10` → `10.13.4.1614`
///        `47.4.23`             → `47.4.23`（没有尾段，原样）
///
///   ② **首段是 MC 版本就跳过它，取第二段**（少数镜像/手改目录是这个顺序）：
///        `1.12.2-14.23.5.2860` → `14.23.5.2860`
///
/// ★ 为什么不能用"哪一段更像版本号"来挑：`0.19.5`（Fabric）与 `1.20.1`（MC）
///   在"纯数字加点"这个判据下**完全同形**，靠猜必然出错一半。
///   位置（尾段 = MC 版本）才是可靠的信息。
fn parse_loader_version_of(rest: &str) -> Option<String> {
    let s = rest
        .trim_end_matches(".jar")
        .trim_end_matches(".json")
        .trim_matches(['-', '_']);
    if s.is_empty() {
        return None;
    }
    let segs: Vec<&str> = s.split('-').filter(|x| !x.is_empty()).collect();
    if segs.is_empty() {
        return None;
    }

    // ① 尾段是 MC 版本 → 剥掉
    if segs.len() >= 2 && is_mc_version_like(segs[segs.len() - 1]) {
        let head = segs[..segs.len() - 1].join("-");
        if is_loader_version_token(&head) {
            return Some(head);
        }
        return None;
    }

    // ② 首段是 MC 版本 → 取第二段
    if segs.len() >= 2 && is_mc_version_like(segs[0]) && is_loader_version_token(segs[1]) {
        return Some(segs[1].to_string());
    }

    // ③ 单段：是版本号就用它
    if segs.len() == 1 && is_loader_version_token(segs[0]) {
        return Some(segs[0].to_string());
    }

    // ④ 认不出来就返回 None（UI 会显示"版本未知"，绝不编一个）
    None
}

/// 这一段长得像加载器版本号吗？
///
/// ★ 只用来判**已经被位置规则挑出来的那一段**，不做"哪段更像"的比较 ——
///   判据就是一个加载器版本号的样子：`47.4.23` / `0.19.5` / `10.13.4.1614`
///   （以数字开头、全部是数字与点、且带点）。
fn is_loader_version_token(s: &str) -> bool {
    !s.is_empty()
        && s.contains('.')
        && s.chars().next().is_some_and(|c| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// 从版本 JSON 的库坐标里读出加载器自身的版本号（**权威来源**）。
///
/// 例：`net.minecraftforge:forge:1.20.1-47.4.23` → `47.4.23`；
///     `net.fabricmc:fabric-loader:0.19.5`      → `0.19.5`。
///
/// Forge 的坐标把 MC 版本拼在前面（`1.20.1-47.4.23`），NeoForge 新版本则是
/// 纯自己的版本号（`21.1.72`），两种都要剥得掉。
///
/// ## ★★ 前缀匹配必须停在 artifact 结尾（实测抓到的 bug）
///
/// 判据原来是 `name.starts_with("net.minecraftforge:forge")` —— 看起来对，
/// 其实是个**前缀陷阱**，因为 `net.minecraftforge` 这个组底下还有一堆
/// **别的** artifact，名字都以 `forge` 开头：
///
///   `net.minecraftforge:forgespi:7.0.1`      ← 一个 SPI 库，**不是** Forge 本体
///   `net.minecraftforge:forge-transformers:…`
///   `net.minecraftforge:forge:1.20.1-47.2.0`  ← 这个才是本体
///
/// 实测症状：`1.20.1-forge-47.2.0` 的版本 JSON 里**没有** `:forge:` 那一条
/// （老版本 Forge 不写它，只有 `fmlloader` / `fmlearlydisplay` / `forgespi`），
/// 于是循环先撞上 `forgespi` → 把 SPI 的版本号 **7.0.1** 当成了 Forge 版本。
/// 界面上写的是「已装 Forge **7.0.1**」，而实际装的是 **47.2.0** ——
/// 而 `26.2-forge-65.1.3` 恰好有 `:forge:` 那一条，所以它显示正确。
/// **同一个功能，两个版本一个对一个错**，是最容易漏掉的那种。
///
/// 修法：判据要求 **artifact 段完全相等**（`group:artifact:` 加上那个冒号，
/// 把边界钉死）。只判 `contains` 又会把别的组里的同名 artifact 捞进来。
pub fn loader_versions_in_json(raw_json: &str, flavor: LoaderFlavor) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    let libs = v.get("libraries")?.as_array()?;

    // 各加载器的"自己是哪一个库"的判据（顺序即优先级）
    //
    // ★ 每一项都带结尾冒号：`group:artifact:` —— 前缀必须正好停在
    //   artifact 的边界上，不能让它继续匹配 `forgespi` 这种同名开头的库。
    let wants: &[&str] = match flavor {
        LoaderFlavor::Forge => &["net.minecraftforge:forge:"],
        LoaderFlavor::NeoForge => &["net.neoforged:neoforge:"],
        LoaderFlavor::Fabric => &["net.fabricmc:fabric-loader:"],
        LoaderFlavor::Quilt => &["org.quiltmc:quilt-loader:"],
        LoaderFlavor::LiteLoader => &["com.mumfrey:liteloader:"],
        LoaderFlavor::OptiFine => &["optifine:optifine:", "optifine:OptiFine:"],
    };

    for lib in libs {
        let name = lib.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let lower = name.to_lowercase();
        if !wants.iter().any(|w| lower.starts_with(&w.to_lowercase())) {
            continue;
        }
        let parts: Vec<&str> = name.split(':').collect();
        let ver = parts.get(2).copied().unwrap_or("");
        if ver.is_empty() {
            continue;
        }
        // `1.20.1-47.4.23` → 去掉 MC 前缀；`21.1.72` / `0.19.5` 原样返回
        if let Some(rest) = strip_mc_prefix(ver).filter(|r| looks_like_loader_version(r)) {
            return Some(rest.to_string());
        }
        return Some(ver.to_string());
    }
    None
}

/* ====================== 已安装加载器的完整检测（含 inheritsFrom 递归） ====================== */

/// 检测失败的原因。
///
/// ★ 刻意与"没装加载器"分开：一份 JSON 解析不了，与"这是一份纯原版 JSON"
///   是两件事。前者必须报错（文件坏了 / 装了一半），后者是**正常结果**（空列表）。
///   把它们混成一个"空结果"，界面就会把损坏的版本显示成纯原版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModLoaderError {
    /// JSON 解析失败（文件损坏 / 装了一半）
    InvalidJson(String),
    /// `inheritsFrom` 链条太深或成环（防无限递归）
    InheritLoop(String),
}

impl std::fmt::Display for ModLoaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson(e) => write!(f, "版本描述不是有效的 JSON：{e}"),
            Self::InheritLoop(id) => write!(
                f,
                "版本继承链有问题（`inheritsFrom` 成环或层数超过上限）：{id}"
            ),
        }
    }
}

impl std::error::Error for ModLoaderError {}

/// 递归合并父版本时允许的最大层数。
///
/// 现实里的链最多 2~3 层（Forge 版本 → 原版；Fabric profile → 原版），
/// 8 层足够宽裕，同时能挡住"自己继承自己"这种坏文件。
const MAX_INHERIT_DEPTH: usize = 8;

/// 一个已安装的模组加载器 / 附加组件。
///
/// 字段名对齐前端契约（`kind` / `name` / `version` / `is_base`）——
/// 这是**透传**结构，`commands_real::InstalledLoader` 与 `src/bridge/tauri.ts`
/// 的 `InstalledLoader` 都是它，三处必须同名（ADR-036）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InstalledModLoader {
    /// `forge` / `neoforge` / `fabric` / `quilt` / `optifine` / `liteloader`
    pub loader_type: String,
    /// 面向用户的名字
    pub name: String,
    /// 加载器自身版本；**取不到时是 `"unknown"`**（不编造、也不留空让 UI 去猜）
    pub version: String,
    /// 是不是基础加载器（附加组件为 false）
    pub is_base: bool,
    /// ★★ **还有没有版本（实例）在用它**。
    ///
    /// ## 为什么必须区分这两件事
    ///
    /// 用户报的：「版本列表删除有模组加载器的版本之后，下载列表的对应版本
    /// 有模组加载器的版本，**还显示已装**」。
    ///
    /// 根因是两张表读的是**两个不同的东西**：
    ///   · 「版本列表」= `instances.json`（用户建的版本）
    ///   · 「下载」页   = 直接扫 `shared/versions/`（盘上有什么）
    ///
    /// 删实例只删 `instances/{slug}/`（存档 / Mod / 配置），
    /// **共享的游戏文件**（`shared/versions/`、`libraries/`）故意留着 ——
    /// 多个实例可能共用同一份，删了会把别人的游戏弄坏。
    /// 于是下载页照旧扫到那个加载器版本目录，继续显示"已装"。
    ///
    /// 两句话都对，但合在一起就是界面在骗人：
    /// 「已装」让人以为**可以用**，而它其实是个没有版本在用的空壳。
    ///
    /// 所以 `detect_installed_modloaders` 之后要调 [`annotate_usage`]，
    /// 把"盘上有"和"有版本在用"分开说。
    ///
    /// `None` = 调用方没有做这项标注（检测逻辑本身不知道实例，那要读 I/O）。
    #[serde(default)]
    pub in_use: Option<bool>,
}

/// ★★ 给一批"盘上检测到的加载器"标注**有没有版本在用**。
///
/// `instance_loader_kinds` = 这个 MC 版本下，实例记录里出现过的基础加载器种类
/// （小写；没有加载器的实例写空串）。空集合 = **这个 MC 版本一份实例都没有**。
///
/// 判据与界面的"已装"是同一份事实来源：
///   · 集合为空 → 全部标 `false`（盘上有，但没有任何版本在用）
///   · 否则 → 这个加载器**在这一版的实例里被引用过**才算 `true`
///
/// ★ 为什么按"种类"而不是"精确版本号"匹配：
///   实例记录里的 `loader.version` 与我们实际装出来的目录名**不一定逐字相同**
///   （实测：记录写 `47.2.0`，盘上是 `1.20.1-forge-47.4.23` —— 装的时候用了
///   当时最新的 build）。按精确版本匹配会把**真在用**的判成"没人用"，
///   那种误报会让用户去删一份正在用的游戏。
///   宁可保守：只要这一类加载器被引用过就算在用。
pub fn annotate_usage(
    loaders: &mut [InstalledModLoader],
    instance_loader_kinds: &std::collections::HashSet<String>,
) {
    for l in loaders.iter_mut() {
        let key = l.loader_type.to_lowercase();
        l.in_use = Some(instance_loader_kinds.contains(&key));
    }
}

/// 检测一份版本 JSON 里包含哪些模组加载器（**含 `inheritsFrom` 递归**）。
///
/// ## 为什么必须递归
/// 加载器版本的 JSON 是**增量**的：Fabric 的 profile 声明 `inheritsFrom: 26.2`，
/// 而有些工具的产物只在自己那份里写加载器库、把 OptiFine 之类的附加组件
/// 留在父版本里。只看当前这一份，就会漏报 —— 用户看到的正是
/// 「明明装了却检测不到」。
///
/// ## 为什么用闭包而不是直接读盘
/// 领域层不许有 I/O（本项目的铁律，见 `domain/mod.rs`）。父版本怎么拿到
/// 是调用方的事：装机侧从 `versions/<id>/` 读文件，测试里直接塞字符串。
///
/// `resolve_parent` 收到父版本 id，返回它那份 JSON 的**原文**；返回 `None`
/// 表示父版本不在本机（这不是错误 —— 装了一半的版本很常见，如实少报即可）。
///
/// ## 判据
/// 只看 `libraries` 的 **Maven 坐标**（不看文件名、不看目录名 —— ADR-020）。
/// 版本号优先从库坐标里读，读不出来时退回 `"unknown"`。
pub fn detect_installed_modloaders(
    version_json: &str,
    resolve_parent: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<InstalledModLoader>, ModLoaderError> {
    let mut out: Vec<InstalledModLoader> = Vec::new();
    let mut current = Some(version_json.to_string());
    let mut seen: Vec<String> = Vec::new();

    while let Some(raw) = current {
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| ModLoaderError::InvalidJson(e.to_string()))?;

        // ① 这一份里有哪些加载器（按库坐标 + 主类判定）
        for flavor in detect_flavors(&raw) {
            let version = version_of_flavor(&v, flavor).unwrap_or_else(|| "unknown".to_string());
            merge_one(&mut out, flavor, version);
        }

        // ② 沿 inheritsFrom 往上走
        let parent_id = v
            .get("inheritsFrom")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let Some(pid) = parent_id else { break };
        if pid.is_empty() {
            break;
        }
        if seen.iter().any(|s| s == &pid) || seen.len() >= MAX_INHERIT_DEPTH {
            return Err(ModLoaderError::InheritLoop(pid));
        }
        seen.push(pid.clone());
        // 父版本不在本机 → 停下来，但**不报错**：已经拿到的部分照样有效
        current = resolve_parent(&pid);
    }

    // 稳定排序：基础加载器在前，同类按 kind 名字
    out.sort_by(|a, b| b.is_base.cmp(&a.is_base).then_with(|| a.loader_type.cmp(&b.loader_type)));
    Ok(out)
}

/// 把一条检测结果并进列表：同一种加载器只留**版本号更具体**的那条。
///
/// 「更具体」= 不是 `unknown`。父版本往往只写了坐标不写版本，
/// 子版本写了版本；反过来也可能。
fn merge_one(out: &mut Vec<InstalledModLoader>, flavor: LoaderFlavor, version: String) {
    if let Some(existing) = out.iter_mut().find(|e| e.loader_type == flavor.key()) {
        if existing.version == "unknown" && version != "unknown" {
            existing.version = version;
        }
        return;
    }
    out.push(InstalledModLoader {
        loader_type: flavor.key().to_string(),
        name: flavor.display().to_string(),
        version,
        is_base: flavor.is_base(),
        // 领域层的"检测"只回答"盘上/JSON 里有什么"，不回答"有没有版本在用"
        // （那要读 instances.json，是 I/O）—— 由调用方 `annotate_usage` 补。
        in_use: None,
    });
}

/// 从一份已解析的版本 JSON 里取出某个加载器的版本号。
///
/// 库坐标形态（都是实测见过的）：
///   `net.minecraftforge:forge:1.20.1-47.2.0`   → `47.2.0`
///   `net.neoforged:neoforge:21.1.72`          → `21.1.72`
///   `net.fabricmc:fabric-loader:0.15.0`       → `0.15.0`
///   `org.quiltmc:quilt-loader:0.20.0`         → `0.20.0`
///   `optifine:OptiFine:1.20.1_HD_U_I6`        → `HD_U_I6`
///   `com.mumfrey:liteloader:1.12.2`           → `1.12.2`
///
/// ★ 另有一条兜底：有些加载器把自己的版本号写在库的 `version` 字段之外
///   （例如 `downloads.artifact.path` 里），所以取不到时**再看一眼
///   `mainClass`**（`net.minecraftforge` 的 `BootstrapLauncher` 不带版本），
///   最后返回 `None` → 调用方填 `"unknown"`。**绝不编造一个版本号。**
fn version_of_flavor(v: &serde_json::Value, flavor: LoaderFlavor) -> Option<String> {
    /*
     * ★★ 每一项都带**结尾冒号**（`group:artifact:`）—— 把 artifact 的边界钉死。
     *
     *   这里踩过和 `loader_versions_in_json` **一模一样**的前缀陷阱，
     *   而且因为两处各写了一份判据，修一处漏一处：
     *     `starts_with("net.minecraftforge:forge")` 也会匹配
     *     `net.minecraftforge:forgespi:7.0.1` —— 于是把 SPI 库的版本号
     *     当成了 Forge 本体版本，界面写「已装 Forge 7.0.1」而实际是 47.2.0。
     *
     *   ★ 教训：**同一个判据写在两个地方，就一定会有一处忘记改。**
     *     改这里的时候必须同时看 `loader_versions_in_json`（上面那个函数）。
     */
    let wants: &[&str] = match flavor {
        LoaderFlavor::Forge => &["net.minecraftforge:forge:"],
        LoaderFlavor::NeoForge => &["net.neoforged:neoforge:", "net.neoforge:"],
        LoaderFlavor::Fabric => &["net.fabricmc:fabric-loader:"],
        LoaderFlavor::Quilt => &["org.quiltmc:quilt-loader:"],
        LoaderFlavor::LiteLoader => &["com.mumfrey:liteloader:"],
        LoaderFlavor::OptiFine => &["optifine:optifine:", "optifine:OptiFine:"],
    };
    let libs = v.get("libraries")?.as_array()?;
    for lib in libs {
        let name = lib.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let lower = name.to_lowercase();
        if !wants.iter().any(|w| lower.starts_with(w)) {
            continue;
        }
        let coord: Vec<&str> = name.split(':').collect();
        let raw_ver = coord.get(2).copied().unwrap_or("");
        if raw_ver.is_empty() {
            continue;
        }
        // `1.20.1-47.2.0` → `47.2.0`（剥掉 MC 前缀）；`21.1.72` 原样
        if let Some(rest) = strip_mc_prefix(raw_ver).filter(|r| looks_like_loader_version(r)) {
            return Some(rest.to_string());
        }
        // OptiFine 的 `1.20.1_HD_U_I6` → `HD_U_I6`
        if flavor == LoaderFlavor::OptiFine {
            if let Some(rest) = strip_mc_prefix(raw_ver) {
                let cleaned = rest.trim_matches(['_', '-']).to_string();
                if !cleaned.is_empty() {
                    return Some(cleaned);
                }
            }
        }
        // 坐标里就是版本号本身（`net.fabricmc:fabric-loader:0.15.0`）
        return Some(raw_ver.to_string());
    }
    None
}

///
/// ★ 为什么需要这一层：`1.20.1` 这种字符串本身就是"MC 版本形态"，
///   剥完只剩空串 —— 那种情况下必须**原样保留**，不能返回空版本号。
///   而 `1.20.4-20.4.237` 剥完是 `20.4.237`（好的）。
fn looks_like_loader_version(s: &str) -> bool {
    let s = s.trim_matches(['-', '_', '.']);
    !s.is_empty() && s.chars().any(|c| c.is_ascii_digit())
}

/// 去掉开头的 `<mc 版本>_`（`1.20.1_HD_U_I6` → `HD_U_I6`）
fn strip_mc_prefix(s: &str) -> Option<&str> {
    let mut it = s.char_indices();
    let mut cut = 0usize;
    for (i, c) in it.by_ref() {
        if c.is_ascii_digit() || c == '.' {
            cut = i + c.len_utf8();
        } else {
            break;
        }
    }
    if cut == 0 {
        return None;
    }
    let head = &s[..cut];
    if is_mc_version_like(head) {
        Some(s[cut..].trim_start_matches(['_', '-']))
    } else {
        None
    }
}

/// `1.7.10` / `26.2` / `1.20.1` 这种形态：**最多三段的纯数字版本号**。
///
/// 刻意宽松 —— 它只用来回答"尾段是不是 MC 版本"这一个问题，
/// 而在这个位置上，四段以上的纯数字串（`10.13.4.1614`）就已经是加载器版本了。
fn is_mc_version_like(s: &str) -> bool {
    if s.is_empty() || s.len() > 8 {
        return false;
    }
    if !s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    s.chars().all(|c| c.is_ascii_digit() || c == '.')
        && (1..=2).contains(&s.matches('.').count())
}

/// 版本号按"点分段 + 数字优先"排序（`47.4.9` 必须排在 `47.2.0` 之后，
/// 而纯字典序会把它排到 `47.2.0` 前面）。
///
/// ★ 排序时**忽略 `-` 后面的尾巴**（`10.13.4.1614-1.7.10` 与 `10.13.4.1614`
///   视为同一个版本号）。这些尾巴是构建分支或预发布标记，不是版本号的组成部分：
///     · Forge 1.7.10 的产物名带分支（`10.13.4.1614-1.7.10`）
///     · NeoForge 的预发布是 `21.11.45` 之外的 `26.2.0.87-beta`
///   不剥掉的话 `"1614-1".parse::<u64>()` 会失败并被当成 0，
///   于是它们互相比较全相等，排序退化成字典序 —— 而字典序会把
///   `10.13.4.999` 排到 `10.13.4.1614` 后面（"最新版"就推荐错了）。
pub fn compare_version_desc(a: &str, b: &str) -> std::cmp::Ordering {
    fn nums(s: &str) -> Vec<u64> {
        s.split('-')
            .next()
            .unwrap_or(s)
            .split('.')
            .map(|x| x.parse().unwrap_or(0))
            .collect()
    }
    let pa = nums(a);
    let pb = nums(b);
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return y.cmp(&x); // 降序
        }
    }
    // 数字部分完全相同时：**正式版排在预发布版前面**（`21.11.45` > `21.11.45-beta`）
    let a_pre = a.contains("-beta") || a.contains("-alpha");
    let b_pre = b.contains("-beta") || b.contains("-alpha");
    if a_pre != b_pre {
        return if a_pre {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    b.cmp(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 痕迹判定 ---------- */

    /// ★ 回归：NeoForge 的库坐标里含 `forge`，绝不能被判成 Forge
    #[test]
    fn neoforge_is_not_forge() {
        let raw = r#"{"id":"1.20.4-neoforge-20.4.237",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "libraries":[{"name":"net.neoforged:neoforge:20.4.237"}]}"#;
        let f = detect_flavors(raw);
        assert!(f.contains(&LoaderFlavor::NeoForge));
        assert!(!f.contains(&LoaderFlavor::Forge), "NeoForge 被误判成 Forge：{f:?}");
    }

    #[test]
    fn forge_1_20_1_is_detected() {
        let raw = r#"{"id":"1.20.1-forge-47.4.23",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.4.23"},
                         {"name":"net.minecraftforge:fmlloader:1.20.1-47.4.23"},
                         {"name":"net.minecraftforge:securejarhandler:2.1.10"}]}"#;
        let f = detect_flavors(raw);
        assert!(f.contains(&LoaderFlavor::Forge));
        assert!(f.contains(&LoaderFlavor::NeoForge) == false);
    }

    #[test]
    fn fabric_and_optifine_are_both_detected() {
        let raw = r#"{"id":"fabric-loader-0.19.5-26.2",
            "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.19.5"}]}"#;
        assert_eq!(detect_flavors(raw), vec![LoaderFlavor::Fabric]);

        let opti = r#"{"id":"1.20.1-OptiFine_HD_U_I6",
            "libraries":[{"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#;
        assert!(detect_flavors(opti).contains(&LoaderFlavor::OptiFine));
    }

    #[test]
    fn vanilla_has_no_flavor() {
        let raw = r#"{"id":"1.20.1","mainClass":"net.minecraft.client.main.Main",
            "libraries":[{"name":"org.ow2.asm:asm:9.5"}]}"#;
        assert!(detect_flavors(raw).is_empty());
    }

    #[test]
    fn liteloader_is_detected() {
        let raw = r#"{"id":"1.7.10-LiteLoader1.7.10",
            "libraries":[{"name":"com.mumfrey:liteloader:1.7.10"}]}"#;
        assert!(detect_flavors(raw).contains(&LoaderFlavor::LiteLoader));
    }

    /// 从库坐标里读加载器版本（权威来源）
    #[test]
    fn reads_loader_version_from_library_coordinate() {
        let forge = r#"{"libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.4.23"},
                                      {"name":"net.minecraftforge:fmlloader:1.20.1-47.4.23"}]}"#;
        assert_eq!(
            loader_versions_in_json(forge, LoaderFlavor::Forge).as_deref(),
            Some("47.4.23")
        );

        let fabric = r#"{"libraries":[{"name":"net.fabricmc:fabric-loader:0.19.5"},
                                      {"name":"net.fabricmc:intermediary:26.2"}]}"#;
        assert_eq!(
            loader_versions_in_json(fabric, LoaderFlavor::Fabric).as_deref(),
            Some("0.19.5")
        );

        let neo = r#"{"libraries":[{"name":"net.neoforged:neoforge:21.1.72"}]}"#;
        assert_eq!(
            loader_versions_in_json(neo, LoaderFlavor::NeoForge).as_deref(),
            Some("21.1.72")
        );

        // 找不到对应库就返回 None，不瞎猜
        assert_eq!(
            loader_versions_in_json(r#"{"libraries":[{"name":"org.ow2.asm:asm:9.5"}]}"#, LoaderFlavor::Forge),
            None
        );
    }

    /* ---------- 加载器版本提取 ---------- */

    /* ---------- 完整检测（含 inheritsFrom 递归） ---------- */

    fn no_parent(_: &str) -> Option<String> {
        None
    }

    /// 纯原版 → **空列表**（不是错误）
    #[test]
    fn detect_vanilla_returns_empty_list() {
        let vanilla = r#"{"id":"1.20.1","mainClass":"net.minecraft.client.main.Main",
            "libraries":[{"name":"org.ow2.asm:asm:9.5"},
                         {"name":"com.google.guava:guava:31.1-jre"}]}"#;
        let got = detect_installed_modloaders(vanilla, &no_parent).expect("纯原版应当成功解析");
        assert!(got.is_empty(), "纯原版不该检测出加载器：{got:?}");
    }

    /// Forge 47.2.0（用户验收标准里的原话）
    #[test]
    fn detect_forge_with_version() {
        let json = r#"{"id":"1.20.1-forge-47.2.0",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].loader_type, "forge");
        assert_eq!(got[0].version, "47.2.0");
        assert!(got[0].is_base);
    }

    /// Fabric 0.15.0
    #[test]
    fn detect_fabric_with_version() {
        let json = r#"{"id":"fabric-loader-0.15.0-1.20.1",
            "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].loader_type, "fabric");
        assert_eq!(got[0].version, "0.15.0");
    }

    /// Forge + OptiFine → 两个，基础加载器排前面
    #[test]
    fn detect_forge_and_optifine_together() {
        let json = r#"{"id":"1.20.1-forge-47.2.0",
            "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0"},
                         {"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].loader_type, "forge");
        assert!(got[0].is_base);
        assert_eq!(got[1].loader_type, "optifine");
        assert_eq!(got[1].version, "HD_U_I6", "OptiFine 的版本号要剥掉 MC 前缀");
        assert!(!got[1].is_base, "OptiFine 是附加组件");
    }

    /// ★ 带 `inheritsFrom` 的版本要能合并**父版本**里的加载器
    #[test]
    fn detect_merges_loaders_from_parent() {
        // 自己这份只有 Fabric，父版本里写着 OptiFine
        let child = r#"{"id":"fabric-loader-0.15.0-1.20.1","inheritsFrom":"1.20.1-optifine",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;
        let parent = r#"{"id":"1.20.1-optifine",
            "libraries":[{"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#;
        let resolve = |id: &str| -> Option<String> {
            if id == "1.20.1-optifine" {
                Some(parent.to_string())
            } else {
                None
            }
        };
        let got = detect_installed_modloaders(child, &resolve).unwrap();
        let kinds: Vec<&str> = got.iter().map(|l| l.loader_type.as_str()).collect();
        assert!(kinds.contains(&"fabric"), "自己那份的 Fabric 不能丢：{kinds:?}");
        assert!(
            kinds.contains(&"optifine"),
            "父版本里的 OptiFine 必须被合并进来（只读自己那份就会漏报）：{kinds:?}"
        );
    }

    /// 父版本不在本机 → **不报错**，如实少报（装了一半很常见）
    #[test]
    fn detect_tolerates_missing_parent() {
        let child = r#"{"id":"fabric-loader-0.15.0-1.20.1","inheritsFrom":"1.20.1",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;
        let got = detect_installed_modloaders(child, &no_parent).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].loader_type, "fabric");
    }

    /// 格式错误的 JSON → `InvalidJson`（与"纯原版"分开！）
    #[test]
    fn detect_invalid_json_is_an_error_not_an_empty_list() {
        let bad = r#"{"id":"1.20.1","libraries":[{"name":"#;
        match detect_installed_modloaders(bad, &no_parent) {
            Err(ModLoaderError::InvalidJson(_)) => {}
            other => panic!("坏 JSON 必须报 InvalidJson，而不是 {other:?}"),
        }
    }

    /// `inheritsFrom` 成环 → `InheritLoop`，不能无限递归
    #[test]
    fn detect_inherit_loop_is_caught() {
        let a = r#"{"id":"a","inheritsFrom":"b","libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;
        let b = r#"{"id":"b","inheritsFrom":"a","libraries":[]}"#;
        let resolve = |id: &str| -> Option<String> {
            match id {
                "a" => Some(a.to_string()),
                "b" => Some(b.to_string()),
                _ => None,
            }
        };
        match detect_installed_modloaders(a, &resolve) {
            Err(ModLoaderError::InheritLoop(_)) => {}
            other => panic!("成环必须被拦住，实际 {other:?}"),
        }
    }

    /// 版本号提取不到时是 `unknown`，**绝不编造**
    #[test]
    fn detect_unknown_version_is_marked_unknown() {
        // 库坐标里没有第三段版本号
        let json = r#"{"id":"x","libraries":[{"name":"net.minecraftforge:forge"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].version, "unknown");
    }

    /// 大小写不敏感（spec 明确要求）
    #[test]
    fn detect_is_case_insensitive() {
        let json = r#"{"id":"x","libraries":[{"name":"NET.FABRICMC:FABRIC-LOADER:0.15.0"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].loader_type, "fabric");
    }

    /// NeoForge 不能被误判成 Forge（子串包含关系）
    #[test]
    fn detect_neoforge_is_not_forge_in_full_detection() {
        let json = r#"{"id":"1.20.4-neoforge-20.4.237",
            "libraries":[{"name":"net.neoforged:neoforge:20.4.237"}]}"#;
        let got = detect_installed_modloaders(json, &no_parent).unwrap();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].loader_type, "neoforge");
        assert_eq!(got[0].version, "20.4.237");
    }

    /// ★★ **完整检测链**上的前缀陷阱 —— 这才是用户看到的那条路径。
    ///
    ///   现场（本机真实数据，`1.20.1-forge-47.2.0` 的 JSON）：
    ///   老版本 Forge **不写** `net.minecraftforge:forge:` 这一条，
    ///   只写 `forgespi` / `fmlloader` / `fmlearlydisplay`。
    ///   于是 `version_of_flavor` 撞上 `forgespi:7.0.1`，
    ///   把 SPI 的版本号当成了 Forge 版本 → 界面写「已装 Forge **7.0.1**」，
    ///   而实际装的是 **47.2.0**。
    ///
    ///   ★ 这个 bug 在两个地方各有一份判据（`loader_versions_in_json` 与
    ///     `version_of_flavor`），**第一次只修了一处，界面照旧显示 7.0.1**。
    ///     教训：同一个判据写两遍，就一定有一处会忘。
    #[test]
    fn full_detection_does_not_take_forgespi_as_the_forge_version() {
        // 真实形态：没有 `:forge:` 本体，只有一堆 forge* 前缀的库
        let real = r#"{"id":"1.20.1-forge-47.2.0",
            "inheritsFrom":"1.20.1",
            "libraries":[
                {"name":"net.minecraftforge:accesstransformers:8.0.4"},
                {"name":"net.minecraftforge:forgespi:7.0.1"},
                {"name":"net.minecraftforge:coremods:5.0.1"},
                {"name":"net.minecraftforge:mergetool:1.1.5:api"},
                {"name":"net.minecraftforge:fmlloader:1.20.1-47.2.0"},
                {"name":"net.minecraftforge:fmlearlydisplay:1.20.1-47.2.0"}
            ]}"#;
        let got = detect_installed_modloaders(real, &no_parent).unwrap();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].loader_type, "forge");
        assert_eq!(
            got[0].version, "unknown",
            "★ 没有 `net.minecraftforge:forge:` 本体时必须报 unknown，\
             不许把 forgespi 的 7.0.1 当成 Forge 版本（实际装的是 47.2.0，\
             调用方会用目录名兜底成正确的 47.2.0）"
        );

        // 有本体（新版形态）时照常读出来
        let modern = r#"{"id":"26.2-forge-65.1.3","libraries":[
            {"name":"net.minecraftforge:forgespi:8.0.0"},
            {"name":"net.minecraftforge:forge:26.2-65.1.3:universal"}
        ]}"#;
        let got2 = detect_installed_modloaders(modern, &no_parent).unwrap();
        assert_eq!(got2[0].version, "65.1.3");
    }

    #[test]
    fn extracts_forge_versions_from_real_dirs() {
        assert_eq!(
            loader_version_from_id("1.20.1-forge-47.4.23").as_deref(),
            Some("47.4.23")
        );
        assert_eq!(
            loader_version_from_id("1.20.2-neoforge-20.2.86").as_deref(),
            Some("20.2.86")
        );
        assert_eq!(
            loader_version_from_id("neoforge-1.20.4-20.4.237").as_deref(),
            Some("20.4.237")
        );
        // ★ 老版本的怪命名（实测形态）
        assert_eq!(
            loader_version_from_id("1.7.10-Forge10.13.4.1614-1.7.10").as_deref(),
            Some("10.13.4.1614")
        );
        assert_eq!(
            loader_version_from_id("1.7.10-Forge10.13.4.1614").as_deref(),
            Some("10.13.4.1614")
        );
        assert_eq!(
            loader_version_from_id("1.12.2-forge1.12.2-14.23.5.2860").as_deref(),
            Some("14.23.5.2860")
        );
    }

    /// ★★ **前缀陷阱**：`net.minecraftforge:forge` 也会匹配
    ///    `net.minecraftforge:forgespi`，于是把 SPI 库的版本号当成了 Forge 版本。
    ///
    ///    现场（本机真实数据）：
    ///      · `1.20.1-forge-47.2.0` 的 JSON 里**没有** `:forge:` 那一条
    ///        （老版本 Forge 只写 `fmlloader` / `fmlearlydisplay` / `forgespi`），
    ///        循环先撞上 `forgespi:7.0.1` → 界面显示「已装 Forge **7.0.1**」，
    ///        而实际装的是 **47.2.0**；
    ///      · `26.2-forge-65.1.3` 恰好有 `:forge:` 那一条 → 显示正确。
    ///    同一个功能两个版本一个对一个错 —— 最容易漏掉的那种。
    #[test]
    fn forge_prefix_does_not_match_forgespi() {
        // 本体在前面 → 取本体
        let with_body = r#"{"libraries":[
            {"name":"net.minecraftforge:forgespi:7.0.1"},
            {"name":"net.minecraftforge:forge:1.20.1-47.2.0"}
        ]}"#;
        assert_eq!(
            loader_versions_in_json(with_body, LoaderFlavor::Forge).as_deref(),
            Some("47.2.0"),
            "★ 不许被 forgespi 抢走"
        );

        // ★ 真实形态：**没有**本体那一条，只有一堆 forge* 前缀的库
        //   （实测 1.20.1-forge-47.2.0 就是这样）
        let no_body = r#"{"libraries":[
            {"name":"net.minecraftforge:accesstransformers:8.0.4"},
            {"name":"net.minecraftforge:eventbus:6.0.5"},
            {"name":"net.minecraftforge:forgespi:7.0.1"},
            {"name":"net.minecraftforge:coremods:5.0.1"},
            {"name":"net.minecraftforge:mergetool:1.1.5:api"},
            {"name":"net.minecraftforge:fmlloader:1.20.1-47.2.0"}
        ]}"#;
        assert_eq!(
            loader_versions_in_json(no_body, LoaderFlavor::Forge),
            None,
            "★ 没有 `net.minecraftforge:forge:` 本体那一条时，必须返回 None（界面写「版本未知」）\
             —— 绝不能把 forgespi 的 7.0.1 当成 Forge 版本"
        );

        // `forge-transformers` 同样是"以 forge 开头但不是本体"
        let transformers = r#"{"libraries":[
            {"name":"net.minecraftforge:forge-transformers:26.2-65.1.3"}
        ]}"#;
        assert_eq!(
            loader_versions_in_json(transformers, LoaderFlavor::Forge),
            None,
            "forge-transformers 不是 Forge 本体"
        );

        // 而真正的本体（新版形态，带 classifier）照常读得出来
        let real = r#"{"libraries":[
            {"name":"net.minecraftforge:forge:26.2-65.1.3:universal"},
            {"name":"net.minecraftforge:forgespi:8.0.0"}
        ]}"#;
        assert_eq!(
            loader_versions_in_json(real, LoaderFlavor::Forge).as_deref(),
            Some("65.1.3")
        );
    }

    #[test]
    fn extracts_fabric_quilt_versions() {
        assert_eq!(
            loader_version_from_id("fabric-loader-0.19.5-26.2").as_deref(),
            Some("0.19.5")
        );
        assert_eq!(
            loader_version_from_id("quilt-loader-0.20.0-1.20.1").as_deref(),
            Some("0.20.0")
        );
    }

    #[test]
    fn extracts_optifine_versions() {
        assert_eq!(
            loader_version_from_id("OptiFine_1.20.1_HD_U_I6").as_deref(),
            Some("HD_U_I6")
        );
        assert_eq!(
            loader_version_from_id("1.20.1-OptiFine_HD_U_I6").as_deref(),
            Some("HD_U_I6")
        );
    }

    /// 读不出版本号时返回 None，绝不瞎猜一个（UI 会显示"版本未知"）
    #[test]
    fn unknown_shapes_return_none() {
        assert_eq!(loader_version_from_id("1.20.1"), None);
        assert_eq!(loader_version_from_id("26.2"), None);
    }

    /* ---------- 排序 ---------- */

    #[test]
    fn numeric_version_sort_is_not_lexicographic() {
        let mut v = vec!["47.2.0", "47.4.9", "47.0.3", "47.4.10"];
        v.sort_by(|a, b| compare_version_desc(a, b));
        assert_eq!(v, vec!["47.4.10", "47.4.9", "47.2.0", "47.0.3"]);
    }

    #[test]
    fn flavor_roundtrip_and_keys() {
        for f in LoaderFlavor::ALL {
            assert_eq!(LoaderFlavor::parse(f.key()), Some(f));
            assert!(!f.display().is_empty());
        }
        assert_eq!(LoaderFlavor::parse("高清修复"), None);
        assert!(LoaderFlavor::Forge.is_base());
        assert!(!LoaderFlavor::OptiFine.is_base());
    }
}
