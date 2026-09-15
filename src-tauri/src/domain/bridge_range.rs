//! OptiFabric 支持区间 —— **唯一一份**桥接可用范围的实现（Rust 侧）
//! ================================================================
//!
//! ★★ 这个文件与 `src/domain/bridge-range.ts` 是**同一份数据的两个语言实现**，
//!    两边的版本清单由各自的测试逐条钉住（TS: `tests/bridge-range.test.mjs`，
//!    Rust: 本文件的 `mcmod_table_versions_are_all_accepted`）。
//!    改一边必须改另一边，否则测试立刻红。
//!
//! ## 为什么要有这个文件（dev.10 犯的错，必须写下来）
//!
//! 上一轮我在 `combination.rs` 里用
//! `mc_version.split('.').get(1)` 判"1.14~1.15 段"，然后断言
//! 「1.16 以上没有桥接包」。**两处都错**：
//!
//!   ① 判据错：我查的是 **Modrinth**，`optifabric` 返回 404，
//!      于是下了结论「这个项目不存在」。实测它一直在
//!      **CurseForge 项目 322385** 发布 —— 75 个文件、1005 万次下载、
//!      最高版本 `optifabric-1.14.3.jar`（MC 1.19.3, 2024-01-12）。
//!      **它只是没上 Modrinth。我把"某个平台上没有"当成了"不存在"。**
//!
//!   ② 区间错：用户拿 MC百科 class/1703 的「支持MC版本」表纠正我 ——
//!      Fabric 1.14 ~ **1.20.4** 全都支持（Chocohead 1.16~1.20 /
//!      modmuss50 1.14~1.16），CurseForge Project ID 322385
//!      与我自己读到的项目号一模一样。
//!
//!   ③ 写法错：`split('.').get(1)` 对 `24w45a`、`26.2` 这类 id 会算出垃圾值。
//!      这个坑在 Java 要求那边踩过一次（26.2 显示需要 Java 8），
//!      这里又踩了第二次 —— 所以现在一律走 `compare_version`。
//!
//! 教训见 `docs/DECISIONS.md` ADR-050。

use crate::domain::types::BridgeKind;
use crate::domain::version::compare_version;
use std::cmp::Ordering;

/// OptiFabric 在 CurseForge 的项目页（项目 ID 322385，与 PCL 的 DlOptiFabricLoader 同源）
pub const OPTIFABRIC_CURSEFORGE_URL: &str =
    "https://www.curseforge.com/minecraft/mc-mods/optifabric";

/// OptiFabric Origins（1.14/1.15 段的非官方维护分支），Modrinth 上确实有
pub const OPTIFABRIC_ORIGINS_URL: &str = "https://modrinth.com/mod/optifabric-origins";

/// 支持区间的两端（含端点）
pub const RANGE_LOW: &str = "1.14.0";
pub const RANGE_HIGH: &str = "1.20.4";

/// 主项目 OptiFabric 覆盖的下界（1.14~1.15.2 段上游建议改用 Origins）
pub const MAIN_PROJECT_LOW: &str = "1.16.1";

/// `optifabric-origins`（Modrinth 实测）**只**发布了这两个版本。
/// 所以 1.14.0~1.15.2 里只有这两个能装，其余如实说不支持 ——
/// 不能因为"1.14 段有桥接"就把 1.14.1/1.14.2 也说成可用。
pub const ORIGINS_VERSIONS: [&str; 2] = ["1.14.4", "1.15.2"];

/// ★ `manual` 恒为 true 的事实依据（不要再写 `manual: false`）：
///
///   `bridgeFile()` 这个下载接口**只存在于 `src/bridge/web.ts`（浏览器演示模式）**，
///   生产用的 `src/bridge/tauri.ts` 根本没有它。也就是说**没有任何一条生产路径**
///   会去下载桥接包，而界面却写着「（会自动装）」—— 那正是用户抱怨的假承诺。
pub const BRIDGE_IS_MANUAL: bool = true;

/// 某个 MC 版本上"Fabric/Quilt + 高清修复"的桥接情况。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeAvailability {
    /// 这个 MC 版本上有没有可用的桥接包（`false` = 真的没有，不是"查不到"）
    pub available: bool,
    /// 可用的桥接包（`available == false` 时为 None）
    pub kind: Option<BridgeKind>,
    /// 需不需要用户手动下载（目前恒为 true）
    pub manual: bool,
    /// 该版本的额外注意事项
    pub notes: Vec<String>,
    /// 不可用时的具体理由
    pub reason: Option<String>,
}

impl BridgeAvailability {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            kind: None,
            manual: BRIDGE_IS_MANUAL,
            notes: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

/// 每个版本的额外注意事项（来自 MC百科的「注意」段落，逐条可核对）
fn version_notes(mc_version: &str) -> Vec<String> {
    let mut notes = Vec::new();
    if mc_version == "1.16.5" {
        notes.push(
            "这个组合要能跑，Fabric Loader 需要 0.14.21 这一代、OptiFine 需要 HD U G8\
             （MC百科明确写明）"
                .to_string(),
        );
    }
    if compare_version(mc_version, "1.20") != Ordering::Less {
        notes.push(
            "1.20 段有个已知问题：Fabric API 0.86.0 及以上会让文字显示成方框 —— \
             要么降低 Fabric API 版本，要么用 OptiFabric CI 207 及以上版本"
                .to_string(),
        );
    }
    notes
}

/// 判断某个 MC 版本上 Fabric/Quilt 能否挂高清修复、用哪个桥接包。
pub fn optifabric_availability(mc_version: &str) -> BridgeAvailability {
    // ---- 上界之外：真的没有 ----
    if compare_version(mc_version, RANGE_HIGH) == Ordering::Greater {
        return BridgeAvailability::unavailable(
            "OptiFabric 最后一个支持到 1.20.4（CurseForge 项目 322385）。\
             1.20.5 起 OptiFine 的渲染补丁换了挂载点，OptiFabric 至今没有跟进\
             （上游仓库里要 1.21 的 issue 还开着）",
        );
    }
    // ---- 下界之外：Fabric 生态都还没成型 ----
    if compare_version(mc_version, RANGE_LOW) == Ordering::Less {
        return BridgeAvailability::unavailable(
            "OptiFabric 最早支持到 1.14（再往前的桥接是 Legacy Fabric 那一支，不是 Fabric）",
        );
    }
    // ---- 1.14 ~ 1.15.2：走 Origins，但只有它发布过的两个版本 ----
    if compare_version(mc_version, "1.15.2") != Ordering::Greater {
        if !ORIGINS_VERSIONS.contains(&mc_version) {
            return BridgeAvailability::unavailable(format!(
                "1.14 ~ 1.15 段由 OptiFabric Origins 接续，而它只发布了 {} 两个版本，\
                 没有 {mc_version} 的包",
                ORIGINS_VERSIONS.join(" 和 ")
            ));
        }
        return BridgeAvailability {
            available: true,
            kind: Some(BridgeKind::OptiFabricOrigins),
            manual: BRIDGE_IS_MANUAL,
            notes: vec![format!(
                "1.14 ~ 1.15 段主项目已停更，上游建议改用 OptiFabric Origins：{OPTIFABRIC_ORIGINS_URL}"
            )],
            reason: None,
        };
    }
    // ---- 1.16.1 ~ 1.20.4：主项目 OptiFabric ----
    BridgeAvailability {
        available: true,
        kind: Some(BridgeKind::OptiFabric),
        manual: BRIDGE_IS_MANUAL,
        notes: version_notes(mc_version),
        reason: None,
    }
}

/// 桥接包的下载页（手动安装时给用户点的那个链接）
pub fn bridge_url(kind: BridgeKind) -> &'static str {
    match kind {
        BridgeKind::OptiFabric => OPTIFABRIC_CURSEFORGE_URL,
        BridgeKind::OptiFabricOrigins => OPTIFABRIC_ORIGINS_URL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★★ MC百科 class/1703「支持MC版本」表里列出的**全部** Fabric 版本，逐条抄下来。
    ///
    /// 这是这份数据的**来源本身** —— 表里有一个版本而这里判"不支持"，
    /// 就说明我又在下没有依据的结论。dev.10 的错就是漏了 1.16~1.20.4 一整段。
    const MCMOD_TABLE: [&str; 25] = [
        "1.20.4", "1.20.2", "1.20.1", "1.20", "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19",
        "1.18.2", "1.18.1", "1.18", "1.17.1", "1.17", "1.16.5", "1.16.4", "1.16.3", "1.16.2",
        "1.16.1", "1.15.2", "1.14.4", "1.14.3", "1.14.2", "1.14.1", "1.14",
    ];

    /// 表里的版本**除 1.14.1/1.14.2/1.14.3 三个以外**都必须判可用。
    ///
    /// 那三个是 Origins 的空档：MC百科把 1.14.x 整段记在主项目名下，
    /// 而 1.14 段实际由 Origins 接续，Origins 只发布了 1.14.4 和 1.15.2。
    /// 换句话说"1.14.1 装不了"是有依据的（Origins 没发布），
    /// 而不是凭空判死 —— 这条例外必须写明白，否则测试会掩盖真问题。
    #[test]
    fn mcmod_table_versions_are_all_accepted() {
        let origins_gap = ["1.14", "1.14.1", "1.14.2", "1.14.3"];
        for v in MCMOD_TABLE {
            let got = optifabric_availability(v);
            if origins_gap.contains(&v) {
                assert!(
                    !got.available,
                    "{v} 在 Origins 的发布清单里没有包，不该判可用"
                );
                let reason = got.reason.unwrap_or_default();
                assert!(
                    reason.contains("Origins") || reason.contains("1.14"),
                    "{v} 不可用的理由要说清是 Origins 没发布，实际是：{reason}"
                );
                continue;
            }
            assert!(got.available, "{v} 在 MC百科表里是支持的，却被判成不可用");
            let expect = if compare_version(v, MAIN_PROJECT_LOW) == Ordering::Less {
                BridgeKind::OptiFabricOrigins
            } else {
                BridgeKind::OptiFabric
            };
            assert_eq!(got.kind, Some(expect), "{v} 用错了桥接包");
        }
    }

    /// 上界：1.20.4 有，1.20.5 起没有 —— 这正是用户要的"提示不兼容"的那一段。
    #[test]
    fn range_upper_bound_is_1_20_4() {
        assert!(optifabric_availability("1.20.4").available);
        for v in ["1.20.5", "1.20.6", "1.21", "1.21.1", "1.21.5"] {
            let got = optifabric_availability(v);
            assert!(!got.available, "{v} 不该判可用");
            assert!(got.reason.unwrap_or_default().contains("1.20.4"));
        }
    }

    /// 下界。
    #[test]
    fn range_lower_bound_is_1_14() {
        for v in ["1.13.2", "1.12.2", "1.7.10"] {
            assert!(!optifabric_availability(v).available, "{v} 不该判可用");
        }
    }

    /// ★★ 桥接包**一律**要手动下载 —— 因为生产路径没有下载它的代码。
    ///
    /// 这条断言的价值：以前返回 `manual: false`，界面写着「（会自动装）」，
    /// 而 `manual: false` 是可验证的假话。哪天真写了自动下载，
    /// 先把 `bridgeFile` 加进 `SourceAdapter` 的生产实现，再来改这个断言。
    #[test]
    fn bridge_is_always_manual_because_nothing_downloads_it() {
        for v in ["1.14.4", "1.15.2", "1.16.5", "1.19.2", "1.20.1", "1.20.4"] {
            let got = optifabric_availability(v);
            assert!(got.available, "{v} 应当可用");
            assert!(got.manual, "{v} 的桥接包必须标成手动下载");
        }
        // 手动下载必须有可点的地址
        assert!(bridge_url(BridgeKind::OptiFabric).starts_with("https://"));
        assert!(bridge_url(BridgeKind::OptiFabricOrigins).starts_with("https://"));
    }

    /// 注意事项要真的按版本给出来（1.16.5 的 Loader 要求、1.20+ 的 Fabric API 坑）。
    #[test]
    fn version_specific_notes_are_present() {
        let n = optifabric_availability("1.16.5").notes.join(" ");
        assert!(n.contains("0.14.21"), "1.16.5 应当提示 Fabric Loader 0.14.21：{n}");
        assert!(n.contains("HD U G8"), "1.16.5 应当提示 OptiFine G8：{n}");
        assert!(!n.contains("方框"), "1.16.5 不该带 1.20 段的 Fabric API 提示");

        let n20 = optifabric_availability("1.20.1").notes.join(" ");
        assert!(n20.contains("0.86.0"), "1.20 段应当提示 Fabric API 0.86.0 的坑：{n20}");

        assert!(optifabric_availability("1.19.2").notes.is_empty(), "1.19.2 没有额外注意事项");
    }

    /// ★ `24w45a` 这类快照不能把区间判断搞崩（`split('.').get(1)` 的坑）。
    #[test]
    fn snapshot_versions_do_not_break_the_range() {
        let got = optifabric_availability("24w45a");
        // 24w45a 的主版本号是 24 → 远高于 1.20.4 → 没有桥接包
        assert!(!got.available, "24w45a 属于 1.20.4 之后，没有桥接包");
        assert!(optifabric_availability("26.2").available == false);
    }
}
