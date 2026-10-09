//! **一个版本在磁盘上叫什么名字** —— 唯一实现。
//!
//! ## 为什么必须有这个模块
//!
//!   `docs/DECISIONS.md` 的 ADR-055 决定八早就定下了目录名规范
//!   （`{mc_version}-{loader_type}-{loader_version}`，`1.20.1-forge-47.2.0`，
//!   **显示名与目录名用同一套**）。但规范只写在文档里，**代码里有两份实现**，
//!   于是真机上长出了三种互相不认识的名字：
//!
//!   | 谁写的 | 长什么样 |
//!   |---|---|
//!   | `InstallComposer.tsx` 的 `versionLabel` → 账本 `config.slug` | `26.3-fabric-0.19.5` |
//!   | 安装器（走 Fabric profile 自带的 `id`） | `fabric-loader-0.19.5-26.3` |
//!   | 更早的盘上目录 / 别的路径 | `vanilla-262` · `fabric-262` |
//!
//!   后果不是"名字难看"，而是**账本里的 slug 拼不出磁盘上的目录**
//!   （`DECISIONS.md` 54.1 那一节：拿 slug 去拼目录名把所有条目都判成了"目录不在"），
//!   以及同一个版本在盘上留下 `26.3-fabric-0.19.5` 与 `26.3-fabric-0.19.5-2`
//!   这种看不出差别的重复目录。
//!
//!   ⇒ 规则收敛到这里一份。Rust 侧谁要拼目录名都必须调它；
//!     前端那份 TS 镜像（`src/domain/naming.ts`）由跨语言测试锁住，
//!     两边算出来必须逐字一致。
//!
//!   ★★★★ 2026-10-08：**第二行那个名字不再被生产出来**。安装侧现在把合并后的
//!     加载器版本也写进规范目录（`commands_real::canonical_loader_dir_name`），
//!     并把真正写盘的目录名回报给前端当账本 slug
//!     （`InstalledSummary::version_dir`）—— 用户报的
//!     「**模组加载器被识别为了可启动游戏版本**」「**那个正确版本无法被收藏**」
//!     正是"一个版本两个目录 + slug 拼不出目录"长出来的那两件事。
//!     （`parse_dir_name` 仍然认 PCL 写法：老用户的盘上有，我们只是不再造它。）
//!
//! ## 与 PCL 的关系
//!
//!   PCL 建版本目录时也是拼出来的（`ModDownloadLib.vb`）：
//!   `fabric-loader-{loader}-{mc}` / `{mc}-OptiFine_{version}` / `{mc}-LiteLoader`。
//!   IEML 沿用 ADR-055 的 `{mc}-{loader}-{loaderVersion}` 而不是 PCL 的
//!   `fabric-loader-{loader}-{mc}`：**以 MC 版本开头，目录按版本号排序才是对的**
//!   （混装几个版本时，PCL 那种排法会把所有 Fabric 版本堆在一起）。
//!   两者的共同点是更要紧的那条：**目录名可读、且能反推出"这是哪个版本"**。

use crate::domain::types::{AddonKind, BaseLoaderKind};
use std::collections::BTreeSet;

/// 一套组合里的**成分清单**（用来算目录名与显示名）。
///
/// 刻意不用 `LoaderSelection` / `Instance`：那两者都带着与命名无关的字段
/// （下载源、并发数、内存…），传进来会让这个纯函数变得难测。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VersionParts {
    /// 原版版本号（`1.20.1` / `26.3`）。空串是错的输入，`build` 会拒绝。
    pub mc_version: String,
    /// 基础加载器（`None` = 纯原版）
    pub loader: Option<(BaseLoaderKind, String)>,
    /// 附加组件（OptiFine / LiteLoader），可以有不止一个
    pub addons: Vec<(AddonKind, String)>,
}

impl VersionParts {
    pub fn vanilla(mc_version: impl Into<String>) -> Self {
        Self {
            mc_version: mc_version.into(),
            loader: None,
            addons: Vec::new(),
        }
    }
}

/// 目录名 / 显示名里**不该出现**的字符。
///
/// 这一份与 `validate::safe_name_error`（PCL `ValidateFolderName` 的移植）
/// 判的是同一件事，但用途不同：那边**拒绝**用户的输入，这边**清洗**我们
/// 自己拼出来的名字（比如加载器版本号里带了个空格）。
/// 两份都不许放宽 —— 一个非法的目录名会让实例直接建不出来。
const ILLEGAL: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows 保留设备名（PCL `ValidateFolderName` 同一份表）。
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 把一个任意字符串洗成**能当目录名**的样子。
///
/// 规则（顺序有意）：
///   · 非法字符与控制字符 → `-`
///   · 连续 `-` 合并成一个（`a--b` 读起来像笔误）
///   · 去掉首尾的 `-`、空格、点（Windows 会静默吃掉结尾的点）
///   · 保留设备名 → 加后缀 `-ver`（`CON` → `CON-ver`）
///
/// 空输入返回 `None` —— 调用方**必须**处理，不许拿空串去拼路径
/// （`join("")` 会得到父目录，那等于把版本文件写到 `.minecraft/versions/` 里）。
pub fn sanitize_dir_name(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for c in raw.chars() {
        let c = if ILLEGAL.contains(&c) || (c as u32) < 0x20 { '-' } else { c };
        if c == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(c);
    }
    let trimmed = out.trim_matches(|c: char| c == '-' || c == ' ' || c == '.');
    if trimmed.is_empty() {
        return None;
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Some(format!("{trimmed}-ver"));
    }
    Some(trimmed.to_string())
}

/// **规范目录名**（ADR-055 决定八）—— 一个版本在 `versions/` 下应该叫什么。
///
///   · 原版        → `26.3`
///   · 基础加载器  → `26.3-fabric-0.19.5`
///   · 附加组件    → 接在加载器后面：`1.12.2-forge-14.23.5.2860-optifine-HD_U_E7`
///   · 没有版本号的加载器 → `26.3-fabric`（不硬凑一个空的尾巴）
///
/// ★ 顺序固定：**MC → 基础加载器 → 附加组件**。附加组件永远排在基础加载器
///   之后，因为"装了 Fabric 又装 OptiFine"读起来必须先是加载器。
///
/// ★ 返回 `None` 只有一种情况：`mcVersion` 洗完之后是空的 —— 那说明调用方
///   给的输入本身是坏的（比如空串），**不该猜**，也不该拿来拼路径。
pub fn version_dir_name(parts: &VersionParts) -> Option<String> {
    let mc = sanitize_dir_name(&parts.mc_version)?;
    let mut name = mc;
    if let Some((kind, version)) = &parts.loader {
        name.push('-');
        name.push_str(kind.as_str());
        if let Some(v) = sanitize_dir_name(version) {
            name.push('-');
            name.push_str(&v);
        }
    }
    for (kind, version) in &parts.addons {
        name.push('-');
        name.push_str(&kind.as_str().to_ascii_lowercase());
        if let Some(v) = sanitize_dir_name(version) {
            name.push('-');
            name.push_str(&v);
        }
    }
    Some(name)
}

/// 同名的版本已经存在时，**取下一个空位**（`26.3-fabric-0.19.5-2`、`-3`……）。
///
/// ★ 与 `src/domain/folder-versions.ts::instanceFromFolderVersion` 的后缀规则
///   **逐字一致**（那里也是 `-2`、`-3`）：同一个盘上两种后缀写法会让
///   "哪一个是第二个"变得说不清。
///
/// ★ `taken` 里放**已经在盘上或账本里出现过**的名字。去重判据是
///   **大小写无关**的（Windows 上 `Fabric` 与 `fabric` 是同一个目录，
///   只按字节比会让第二个实例撞进第一个的目录里）。
pub fn unique_dir_name<'a, I>(base: &str, taken: I) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    let used: BTreeSet<String> = taken
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect();
    if !used.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    for n in 2u32.. {
        let candidate = format!("{base}-{n}");
        if !used.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!("u32 用完了")
}

/// 显示名（版本列表里那一行）。
///
/// ADR-055 决定八要求"显示名与目录名用同一套"，但**显示名允许 Unicode**
/// （用户能改成「我的整合包」），所以两者不是同一个函数：
/// 目录名走 [`version_dir_name`]（会清洗），显示名保留原样。
///
///   · 原版   → `Minecraft 26.3`
///   · 加载器 → `Minecraft 26.3 + Fabric 0.19.5`
///
/// ★ 与前端 `src/domain/instance-name.ts::formatInstanceTitle` **逐字一致** ——
///   那条格式是用户明确确认过的（「版本列表的版本名称，后面的"：原版"和
///   "：模组加载器"不要」）。
pub fn version_display_name(parts: &VersionParts) -> String {
    let mut name = format!("Minecraft {}", parts.mc_version);
    if let Some((kind, version)) = &parts.loader {
        name.push_str(" + ");
        name.push_str(loader_label(*kind));
        let v = version.trim();
        if !v.is_empty() {
            name.push(' ');
            name.push_str(v);
        }
    }
    name
}

/// 加载器在界面上的名字（与前端 `instance-name.ts::loaderLabel` 一致）
pub fn loader_label(kind: BaseLoaderKind) -> &'static str {
    match kind {
        BaseLoaderKind::Forge => "Forge",
        BaseLoaderKind::NeoForge => "NeoForge",
        BaseLoaderKind::Fabric => "Fabric",
        BaseLoaderKind::Quilt => "Quilt",
    }
}

/// 从一个**已经在盘上的目录名**猜出 `VersionParts`（迁移老目录时用）。
///
/// 认清**两种**真实存在的写法：
///
///   · ADR-055（IEML 自己的规范）：`{mc}-{loader}-{loaderVer}` ——
///     `1.20.1-forge-47.2.0`、`26.3-fabric-0.19.5`
///   · PCL 的写法：`{loader}-loader-{loaderVer}-{mc}` ——
///     `fabric-loader-0.19.5-26.3`（真机上那个目录就是安装器按 Fabric profile
///     自带的 `id` 建的）
///
/// 只做保守的事：认得出 MC 版本号、加载器种类、加载器版本；
/// **认不出的一律 `None`**（调用方保留原目录名，绝不猜着改名 ——
/// 改错了名字会让启动器再也找不到那个版本）。
///
/// ★ PCL 那种写法**必须单独认**：它的 MC 版本在**最后**，与 ADR-055 正好相反。
///   第一版没认它，于是迁移时把 `fabric-loader-0.19.5-26.3` 规范成了 `26.3`
///   （加载器那一段被整段丢掉）—— 两个不同加载器的版本会撞进同一个目录名。
///   实测就是这条测试逼出来的。
///
/// ★ 为什么不用正则：合法字符太少（数字、点、字母、下划线、`-`），
///   手写扫描比正则更容易读懂"哪一段是版本号、哪一段是加载器名"。
pub fn parse_dir_name(dir: &str) -> Option<VersionParts> {
    // ① PCL 的写法：`fabric-loader-0.19.5-26.3` / `quilt-loader-0.27.0-1.20.1`
    if let Some(parts) = parse_pcl_style(dir) {
        return Some(parts);
    }

    let lower = dir.to_ascii_lowercase();
    // 从后往前找加载器名 —— 版本号里也可能出现 "forge"（比如快照名），
    // 但**加载器名后面的那一段才是加载器版本**，所以必须从右往左找。
    let mut loader: Option<(BaseLoaderKind, String, usize)> = None;
    for (needle, kind) in [
        ("neoforge", BaseLoaderKind::NeoForge),
        ("forge", BaseLoaderKind::Forge),
        ("fabric", BaseLoaderKind::Fabric),
        ("quilt", BaseLoaderKind::Quilt),
    ] {
        if let Some(pos) = lower.rfind(needle) {
            // 只认"作为独立一段出现"的加载器名（`26.3-fabric-0.19.5` 里的 `-fabric-`）
            let before_ok = pos == 0 || lower.as_bytes()[pos - 1] == b'-';
            if !before_ok {
                continue;
            }
            if loader.as_ref().is_none_or(|(_, _, p)| pos > *p) {
                let version = dir[pos + needle.len()..]
                    .trim_start_matches('-')
                    .to_string();
                loader = Some((kind, version, pos));
            }
        }
    }
    let mc_version = match &loader {
        Some((_, _, pos)) => dir[..*pos].trim_end_matches('-').to_string(),
        None => dir.to_string(),
    };
    if mc_version.is_empty() {
        return None;
    }
    // 附加组件：加载器那一段之后可能还有 `-optifine-X` / `-liteloader`
    let mut addons = Vec::new();
    if let Some((_, _, pos)) = &loader {
        let tail = &lower[*pos..];
        for (needle, kind) in [
            ("optifine", AddonKind::OptiFine),
            ("liteloader", AddonKind::LiteLoader),
        ] {
            if let Some(i) = tail.find(needle) {
                let seg = &tail[i..];
                let after = seg.splitn(2, '-').nth(1).unwrap_or("");
                // OptiFine 的版本号自己的写法是 `OptiFine_HD_U_E7`，目录里用 `_`
                addons.push((kind, after.to_string()));
            }
        }
    }
    Some(VersionParts {
        mc_version,
        loader: loader.map(|(k, v, _)| (k, v)),
        addons,
    })
}

/// PCL 那种 `{loader}-loader-{loaderVer}-{mc}` 的写法。
///
///   `fabric-loader-0.19.5-26.3` → mc `26.3`，fabric `0.19.5`
///   `quilt-loader-0.27.0-1.20.1` → mc `1.20.1`，quilt `0.27.0`
///
/// 认不出来返回 `None`（比如 `fabric-loader-0.19.5` 没有 MC 版本那一段）。
///
/// ★ 判据要**窄**：`{mc}-fabric-loader-X` 这种 ADR-055 风格的怪名字不该被
///   误判成 PCL 写法 —— 所以要求 `{loader}-loader-` 出现在**开头**。
fn parse_pcl_style(dir: &str) -> Option<VersionParts> {
    let lower = dir.to_ascii_lowercase();
    for (loader, kind) in [
        ("fabric-loader-", BaseLoaderKind::Fabric),
        ("quilt-loader-", BaseLoaderKind::Quilt),
        ("forge-", BaseLoaderKind::Forge),
        ("neoforge-", BaseLoaderKind::NeoForge),
    ] {
        if !lower.starts_with(loader) {
            continue;
        }
        // `forge-47.2.0-1.20.1` 这种也要能认：剩下的按 `-` 切，
        // 加载器版本 = 第一段，MC 版本 = 最后一段
        let rest = &dir[loader.len()..];
        let segs: Vec<&str> = rest.split('-').filter(|s| !s.is_empty()).collect();
        if segs.len() < 2 {
            // 只有加载器版本、没有 MC 版本 → 认不出来
            return None;
        }
        let loader_version = segs[0].to_string();
        let mc_version = segs[segs.len() - 1].to_string();
        // MC 版本得**像**个版本号（数字开头）—— 否则说明这不是 PCL 那种写法
        if !mc_version.starts_with(|c: char| c.is_ascii_digit()) {
            return None;
        }
        return Some(VersionParts {
            mc_version,
            loader: Some((kind, loader_version)),
            addons: Vec::new(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_loader(mc: &str, kind: BaseLoaderKind, v: &str) -> VersionParts {
        VersionParts {
            mc_version: mc.to_string(),
            loader: Some((kind, v.to_string())),
            addons: Vec::new(),
        }
    }

    /* ---------- 规范目录名 ---------- */

    #[test]
    fn vanilla_is_just_the_mc_version() {
        assert_eq!(version_dir_name(&VersionParts::vanilla("26.3")).unwrap(), "26.3");
        assert_eq!(version_dir_name(&VersionParts::vanilla("1.12.2")).unwrap(), "1.12.2");
    }

    #[test]
    fn a_loader_is_mc_then_loader_then_version() {
        // ADR-055 决定八的例子必须逐字成立
        assert_eq!(
            version_dir_name(&with_loader("1.20.1", BaseLoaderKind::Forge, "47.2.0")).unwrap(),
            "1.20.1-forge-47.2.0"
        );
        assert_eq!(
            version_dir_name(&with_loader("26.3", BaseLoaderKind::Fabric, "0.19.5")).unwrap(),
            "26.3-fabric-0.19.5"
        );
        assert_eq!(
            version_dir_name(&with_loader("1.21.1", BaseLoaderKind::NeoForge, "21.1.72")).unwrap(),
            "1.21.1-neoforge-21.1.72"
        );
    }

    /// ★ 加载器版本号缺失时不硬凑尾巴（`26.3-fabric`，不是 `26.3-fabric-`）
    #[test]
    fn a_loader_without_a_version_does_not_get_a_dangling_dash() {
        let p = with_loader("26.3", BaseLoaderKind::Fabric, "");
        assert_eq!(version_dir_name(&p).unwrap(), "26.3-fabric");
        // 只有空格也一样
        let p = with_loader("26.3", BaseLoaderKind::Fabric, "   ");
        assert_eq!(version_dir_name(&p).unwrap(), "26.3-fabric");
    }

    /// 附加组件排在基础加载器**之后**（顺序固定）
    #[test]
    fn addons_come_after_the_base_loader() {
        let p = VersionParts {
            mc_version: "1.12.2".into(),
            loader: Some((BaseLoaderKind::Forge, "14.23.5.2860".into())),
            addons: vec![(AddonKind::OptiFine, "HD_U_E7".into())],
        };
        assert_eq!(
            version_dir_name(&p).unwrap(),
            "1.12.2-forge-14.23.5.2860-optifine-HD_U_E7"
        );
        // OptiFine 可以独立装在纯原版上（ADR-003）
        let p = VersionParts {
            mc_version: "1.12.2".into(),
            loader: None,
            addons: vec![(AddonKind::OptiFine, "HD_U_E7".into())],
        };
        assert_eq!(version_dir_name(&p).unwrap(), "1.12.2-optifine-HD_U_E7");
    }

    /* ---------- 清洗 ---------- */

    #[test]
    fn illegal_characters_are_cleaned_not_rejected() {
        // 加载器版本号里混进空格/非法字符时，名字要能建出来
        assert_eq!(sanitize_dir_name("1.20.1").unwrap(), "1.20.1");
        assert_eq!(sanitize_dir_name("a/b").unwrap(), "a-b");
        assert_eq!(sanitize_dir_name("a:b*c").unwrap(), "a-b-c");
        // 连续非法字符合并成一个 `-`
        assert_eq!(sanitize_dir_name("a<>b").unwrap(), "a-b");
        // Windows 会吃掉结尾的点
        assert_eq!(sanitize_dir_name("1.20.1.").unwrap(), "1.20.1");
        assert_eq!(sanitize_dir_name("  x  ").unwrap(), "x");
    }

    /// ★ 空输入必须返回 None —— 空串拼进路径会写到父目录里
    #[test]
    fn an_empty_name_is_refused_instead_of_becoming_the_parent_dir() {
        assert_eq!(sanitize_dir_name(""), None);
        assert_eq!(sanitize_dir_name("   "), None);
        assert_eq!(sanitize_dir_name("..."), None);
        assert_eq!(sanitize_dir_name("///"), None);
        // 版本号是空的 → 目录名也算不出来，绝不返回 "fabric-0.19.5"
        let p = VersionParts {
            mc_version: String::new(),
            loader: Some((BaseLoaderKind::Fabric, "0.19.5".into())),
            addons: Vec::new(),
        };
        assert_eq!(version_dir_name(&p), None);
    }

    /// Windows 保留设备名不能直接当目录名
    #[test]
    fn reserved_device_names_are_escaped() {
        assert_eq!(sanitize_dir_name("CON").unwrap(), "CON-ver");
        assert_eq!(sanitize_dir_name("nul").unwrap(), "nul-ver");
        // 正常的版本号不受影响
        assert_eq!(sanitize_dir_name("1.20.1").unwrap(), "1.20.1");
    }

    /* ---------- 去重 ---------- */

    #[test]
    fn duplicates_get_a_numeric_suffix_matching_the_frontend() {
        let taken = ["26.3-fabric-0.19.5"];
        assert_eq!(
            unique_dir_name("26.3-fabric-0.19.5", taken),
            "26.3-fabric-0.19.5-2"
        );
        let taken = ["26.3-fabric-0.19.5", "26.3-fabric-0.19.5-2"];
        assert_eq!(
            unique_dir_name("26.3-fabric-0.19.5", taken),
            "26.3-fabric-0.19.5-3"
        );
        // 没撞就原样返回
        assert_eq!(unique_dir_name("26.3", ["1.20.1"]), "26.3");
    }

    /// ★ Windows 上大小写是同一个目录 —— 去重必须大小写无关
    #[test]
    fn duplicate_detection_is_case_insensitive() {
        assert_eq!(unique_dir_name("Fabric-1", ["fabric-1"]), "Fabric-1-2");
        assert_eq!(unique_dir_name("fabric-1", ["FABRIC-1"]), "fabric-1-2");
    }

    /* ---------- 显示名 ---------- */

    #[test]
    fn display_name_follows_the_users_confirmed_format() {
        assert_eq!(version_display_name(&VersionParts::vanilla("1.12.2")), "Minecraft 1.12.2");
        assert_eq!(
            version_display_name(&with_loader("26.2", BaseLoaderKind::Fabric, "0.19.5")),
            "Minecraft 26.2 + Fabric 0.19.5"
        );
        // 没有版本号 → 不留下悬空的空格
        assert_eq!(
            version_display_name(&with_loader("26.2", BaseLoaderKind::Fabric, "")),
            "Minecraft 26.2 + Fabric"
        );
    }

    /* ---------- 反解（迁移用） ---------- */

    /// ★★ 真机上那三种名字，反解的结果各自是什么 —— 这是迁移老目录的前提
    #[test]
    fn the_three_names_found_on_the_real_machine_all_parse() {
        // ① 账本 slug 那种（= 规范的写法）→ 反解得出来
        let a = parse_dir_name("26.3-fabric-0.19.5").unwrap();
        assert_eq!(a.mc_version, "26.3");
        assert_eq!(a.loader, Some((BaseLoaderKind::Fabric, "0.19.5".into())));

        /*
         * ② 安装器写的 PCL 那种：`fabric-loader-0.19.5-26.3`。
         *
         *    ★★ 它的 MC 版本在**末尾**，与 ADR-055 的 `{mc}-{loader}-{ver}` 相反 ——
         *      所以 `parse_dir_name` 里单独有一段 `parse_pcl_style` 认它。
         *      第一版没认，于是迁移时把它规范成了 `26.3`（加载器整段丢掉），
         *      两个不同加载器的版本会撞进同一个目录名。**这是测试逼出来的。**
         */
        let b = parse_dir_name("fabric-loader-0.19.5-26.3").unwrap();
        assert_eq!(b.mc_version, "26.3", "PCL 写法里 mc 版本在最后");
        assert_eq!(
            b.loader,
            Some((BaseLoaderKind::Fabric, "0.19.5".into())),
            "★ 加载器那一段不能丢 —— 丢了会让两个加载器的版本撞名"
        );

        // ③ 更早的 slug：认不出加载器，整串当"版本号"（保留原名，不改）
        let c = parse_dir_name("vanilla-262").unwrap();
        assert_eq!(c.mc_version, "vanilla-262");
        assert_eq!(c.loader, None);
    }

    /// PCL 写法的三件事：认得出、往返回规范名、认不出时不硬认。
    #[test]
    fn pcl_style_folder_names_are_understood_but_not_over_guessed() {
        // 认得出来，而且规范名是 ADR-055 那种
        for (pcl, canonical) in [
            ("fabric-loader-0.19.5-26.3", "26.3-fabric-0.19.5"),
            ("quilt-loader-0.27.0-1.20.1", "1.20.1-quilt-0.27.0"),
            ("forge-47.2.0-1.20.1", "1.20.1-forge-47.2.0"),
            ("neoforge-21.1.72-1.21.1", "1.21.1-neoforge-21.1.72"),
        ] {
            let parts = parse_dir_name(pcl).unwrap_or_else(|| panic!("{pcl} 应当能认"));
            assert_eq!(version_dir_name(&parts).unwrap(), canonical, "{pcl}");
        }
        // 只有加载器版本、没有 MC 版本 → 认不出来（保留原名，不许猜）
        assert_eq!(parse_dir_name("fabric-loader-0.19.5"), None);
        // MC 版本那一段不像版本号 → 也不认
        assert_eq!(parse_dir_name("forge-nightly-latest"), None);
    }

    #[test]
    fn a_vanilla_mc_version_is_not_mistaken_for_a_loader() {
        // `1.20.1` 里没有加载器名
        assert_eq!(parse_dir_name("1.20.1").unwrap().loader, None);
        // 快照名里带 forge 字样时，只有"独立一段"才算加载器
        let p = parse_dir_name("1.20.1-forge-47.2.0").unwrap();
        assert_eq!(p.mc_version, "1.20.1");
        assert_eq!(p.loader, Some((BaseLoaderKind::Forge, "47.2.0".into())));
    }

    #[test]
    fn neoforge_is_not_mistaken_for_forge() {
        let p = parse_dir_name("1.21.1-neoforge-21.1.72").unwrap();
        assert_eq!(p.loader, Some((BaseLoaderKind::NeoForge, "21.1.72".into())));
    }

    /// 目录名 → 成分 → 再拼回目录名，必须回到原样（能反解才敢改老目录名）
    #[test]
    fn a_canonical_name_round_trips() {
        for name in [
            "1.20.1-forge-47.2.0",
            "26.3-fabric-0.19.5",
            "1.21.1-neoforge-21.1.72",
            "26.3",
        ] {
            let parts = parse_dir_name(name).unwrap();
            assert_eq!(version_dir_name(&parts).unwrap(), name, "{name} 不能往返");
        }
    }

    /* ==================== 跨语言用例表（与前端逐字一致） ==================== */

    /// ★★ **`tests/naming-cases.json` 是这条规则的权威用例表** —— Rust 与
    ///   前端 `src/domain/naming.ts` 各跑一遍，算出来必须一致。
    ///
    ///   为什么必须有这条测试：规范"写在文档里"已经失败过一次
    ///   （真机上盘出三种名字，账本 slug 拼不出磁盘目录）。只要两边各有一份
    ///   实现，就必须有一张表把它们钉在一起 —— 与 `domain::java` 的
    ///   `java-rules.cases.json` 是同一条纪律。
    #[test]
    fn the_shared_case_table_holds() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/naming-cases.json");
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("读不到跨语言用例表 {path}：{e}"));
        let v: serde_json::Value = serde_json::from_str(&text).expect("用例表必须是合法 JSON");

        let loader_of = |s: &str| -> Option<BaseLoaderKind> {
            match s {
                "forge" => Some(BaseLoaderKind::Forge),
                "neoforge" => Some(BaseLoaderKind::NeoForge),
                "fabric" => Some(BaseLoaderKind::Fabric),
                "quilt" => Some(BaseLoaderKind::Quilt),
                _ => None,
            }
        };
        let addon_of = |s: &str| -> Option<AddonKind> {
            match s {
                "optifine" => Some(AddonKind::OptiFine),
                "liteloader" => Some(AddonKind::LiteLoader),
                _ => None,
            }
        };
        let parts_of = |c: &serde_json::Value| -> VersionParts {
            VersionParts {
                mc_version: c["mc"].as_str().unwrap_or("").to_string(),
                loader: c["loader"].as_str().and_then(loader_of).map(|k| {
                    (
                        k,
                        c["loaderVersion"].as_str().unwrap_or("").to_string(),
                    )
                }),
                addons: c["addons"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| {
                                let k = addon_of(x["kind"].as_str()?)?;
                                Some((k, x["version"].as_str().unwrap_or("").to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        };

        for c in v["dir"].as_array().expect("dir 段") {
            let got = version_dir_name(&parts_of(c));
            let want = c["want"].as_str().map(String::from);
            assert_eq!(got, want, "目录名用例 {c} 不一致");
        }
        for c in v["display"].as_array().expect("display 段") {
            let got = version_display_name(&parts_of(c));
            assert_eq!(got, c["want"].as_str().unwrap(), "显示名用例 {c} 不一致");
        }
        for c in v["sanitize"].as_array().expect("sanitize 段") {
            let got = sanitize_dir_name(c["raw"].as_str().unwrap());
            assert_eq!(got, c["want"].as_str().map(String::from), "清洗用例 {c} 不一致");
        }
        for c in v["unique"].as_array().expect("unique 段") {
            let taken: Vec<String> = c["taken"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            let refs: Vec<&str> = taken.iter().map(|s| s.as_str()).collect();
            let got = unique_dir_name(c["base"].as_str().unwrap(), refs);
            assert_eq!(got, c["want"].as_str().unwrap(), "去重用例 {c} 不一致");
        }
        for c in v["parse"].as_array().expect("parse 段") {
            let got = parse_dir_name(c["dir"].as_str().unwrap());
            match c["want"].as_object() {
                None => assert!(got.is_none(), "{} 应当反解不出来，实际 {got:?}", c["dir"]),
                Some(w) => {
                    let got = got.unwrap_or_else(|| panic!("{} 应当能反解", c["dir"]));
                    assert_eq!(
                        got.mc_version,
                        w["mc"].as_str().unwrap(),
                        "{} 的 mc 版本",
                        c["dir"]
                    );
                    let want_kind = w["loader"].as_str().and_then(loader_of);
                    assert_eq!(
                        got.loader.as_ref().map(|(k, _)| *k),
                        want_kind,
                        "{} 的加载器种类",
                        c["dir"]
                    );
                    if let (Some((_, v)), Some(wv)) = (&got.loader, w["loaderVersion"].as_str()) {
                        assert_eq!(v, wv, "{} 的加载器版本", c["dir"]);
                    }
                }
            }
        }
    }
}
