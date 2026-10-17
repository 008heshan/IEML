//! ★★ **整合包安装收尾的三个结论**（纯逻辑，零 `crate::` 依赖）。
//!
//! ## 由来（2026-10-17，用户：「装完了但缺 N 个文件」）
//!
//!   整合包安装的收尾原来只有两档：`outcome.failed` 为空 ⇒ 成功；非空 ⇒
//!   `return Err`（于是整个 `modpack_install` / `cf_modpack_install` 失败 ——
//!   两条源共用 `install_pack_plan`）。而"有几个文件没下来"与"这个包根本起不来"
//!   是**两件完全不同的事**，把它们混成一句 `Err` 的代价是：
//!
//!   * 界面报「安装失败」、**不建实例** —— 用户拿到的是几百 MB 已经下完的文件
//!     加一个用不了的实例；
//!   * 而那几个缺的文件本来就**可以补齐**：安装记录在下载**之前**就写下了，
//!     「重新下载缺失的」正是按它补的。
//!
//! ⇒ 现在分三档：
//!
//! | 档位 | 条件 | 结果 |
//! |---|---|---|
//! | [`PackInstallTier::Complete`] | 清单里的文件全到手 | 成功（照旧） |
//! | [`PackInstallTier::Partial`] | ≥1 个文件没到手，但**骨架齐全** | **算成功**：建实例、进版本列表，返回里带缺了哪些 + 原因 + 总数 |
//! | [`PackInstallTier::Broken`] | 骨架没齐 | **仍然失败**（调用方返回 `Err`） |
//!
//! ★ 两条纪律（都是从这件事来的）：
//!   ① **不许拿 `Err` 当"部分完成"用** —— `Err` 只留给骨架缺；
//!   ② **不许把"骨架缺"混进"部分完成"** —— 那会让一个起不来的实例
//!      被当成装好了建进版本列表里（正是用户最初报的那个形状）。
//!
//! ## 「骨架」的定义
//!
//!   **包体本身 + 客户端 jar + 加载器就位 = 骨架齐全** ⇒ 这个实例**能起来**，
//!   缺的只是清单里的那些文件（mod / 资源包 / 光影）。
//!   三样各自的判据写在 [`SkeletonState`] 的字段上，每一格都是**三态**。
//!
//!   ★ 为什么三态而不是 `bool`：`None` = **计划里没有这一项**
//!     （这个包不要加载器 / 这个版本的 JSON 里没有客户端 jar 下载项）。
//!     那**不算缺** —— 这个仓库的纪律是"**不知道**不许说成**没有**"
//!     （`hash_choice::UnverifiedReason`、`pack_plan::MissingFile` 同一条）。
//!     反过来做的代价正好是这次要修的 bug：一个只缺几个文件的安装
//!     会被判成骨架缺、又变回 `Err`。
//!
//! ## 为什么放在 `domain/`
//!
//!   "这一次装成什么样"是**判定**，不是 I/O：给它三格事实与"缺了几个"，
//!   它就该能算出档位。所有读盘/读内存的事都在调用方（`commands_real`）。
//!   于是这一份能用 rustc 单编**真跑**断言（本机 `cargo test --lib` 起不来，
//!   见 `tools/` 里的记录）。

use serde::Serialize;

/// 骨架里的一件东西（缺了它，这个实例起不来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkeletonPart {
    /// 包体本身（Modrinth 的 `.mrpack` / CurseForge 的 zip）
    PackBody,
    /// 客户端 jar
    ClientJar,
    /// 加载器（Fabric / Quilt 的 profile，Forge / NeoForge 的安装器产物）
    Loader,
}

impl SkeletonPart {
    /// 用户看得懂的名字（错误文案里点名用；不写英文键名）
    pub fn label(self) -> &'static str {
        match self {
            Self::PackBody => "整合包体",
            Self::ClientJar => "客户端 jar",
            Self::Loader => "加载器",
        }
    }
}

/// 骨架三件套的**就位情况** —— 由调用方按手上的事实填（这一层不碰盘）。
///
/// ★ 每一格都是三态：`Some(true)` 确认在 / `Some(false)` 确认不在 /
///   `None` **计划里没有这一项**（不算缺，见模块头部的纪律）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkeletonState {
    /// 包体本身：这一次安装读的那份包**在手上**（清单就是从它里面解析出来的）。
    ///
    /// ★ 判据是"字节非空"：能走到收尾这一步，说明清单已经解析成功 ——
    ///   解析成功本身就是"这是一份完整可读的包"的证据。
    pub pack_body: Option<bool>,
    /// 客户端 jar（`versions/<基础版本>/<基础版本>.jar`）。
    ///
    /// `None` = 这个版本的 JSON 里**没有**客户端 jar 的下载项（计划里没这一项）。
    pub client_jar: Option<bool>,
    /// 加载器：`None` = 这个包**不要加载器**（没有"就位"这回事）；
    /// `Some(false)` = 要加载器，而启动侧那份解析器找不到它的版本目录。
    pub loader: Option<bool>,
}

impl SkeletonState {
    /// 三样都在（或计划里本就没有）—— 这个实例能起来。
    pub fn is_intact(&self) -> bool {
        self.missing_parts().is_empty()
    }

    /// **确认不在**的那几样（只算 `Some(false)`；`None` 一律不算）。
    pub fn missing_parts(&self) -> Vec<SkeletonPart> {
        let mut out = Vec::new();
        if self.pack_body == Some(false) {
            out.push(SkeletonPart::PackBody);
        }
        if self.client_jar == Some(false) {
            out.push(SkeletonPart::ClientJar);
        }
        if self.loader == Some(false) {
            out.push(SkeletonPart::Loader);
        }
        out
    }

    /// 缺的那几样的中文名（`、` 相连；齐了就返回空串）—— 错误文案直接用。
    pub fn missing_text(&self) -> String {
        self.missing_parts()
            .iter()
            .map(|p| p.label())
            .collect::<Vec<_>>()
            .join("、")
    }
}

/// 这一次安装落在哪一档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackInstallTier {
    /// 清单里的文件**全到手**（照旧成功）
    Complete,
    /// **装上了，但有缺**：≥1 个文件没到手，而骨架齐全 ⇒ **算成功**
    Partial,
    /// **骨架缺** ⇒ 仍然失败。
    ///
    /// ★ 它**不会**出现在成功返回里（调用方按 [`PackInstallTier::is_success`]
    ///   把它翻成 `Err`）—— 但它必须在这一档枚举里，因为"三档"是同一份判据
    ///   （[`classify_install`]）的三种输出，缺一种就又能被"顺手"混起来。
    Broken,
}

impl PackInstallTier {
    /// 这一档**算不算装成了**（前端据此建实例 / 进版本列表）。
    ///
    /// 只有 [`Self::Broken`] 不算 —— 见模块头部的两条纪律。
    pub fn is_success(self) -> bool {
        !matches!(self, Self::Broken)
    }

    /// 写日志用的中文名（**不是** wire 上的值：那是 `serde` 的事）
    pub fn label(self) -> &'static str {
        match self {
            Self::Complete => "全部装上",
            Self::Partial => "装上了但有缺",
            Self::Broken => "骨架没齐",
        }
    }
}

/// **唯一判据**：骨架 + "没到手的文件数" ⇒ 档位。
///
/// ★ `shortfall` = **该装但没到手**的条目总数 —— 两类之和：
///   · 地址有、但下载失败的（[`PackFailedFile`]）；
///   · 连下载地址都没解析出来的（`pack_plan::MissingFile`）。
///   两类**不会重叠**：没地址的条目从来没有进过下载任务表。
///
/// ★ 骨架缺**优先于**缺文件：一个文件都下齐了、而客户端 jar 不在盘上，
///   那也是"起不来"，不是"装上但有缺"。
pub fn classify_install(skeleton: &SkeletonState, shortfall: usize) -> PackInstallTier {
    if !skeleton.is_intact() {
        PackInstallTier::Broken
    } else if shortfall > 0 {
        PackInstallTier::Partial
    } else {
        PackInstallTier::Complete
    }
}

/// 一条**下载失败**的条目（地址有、文件没下来）。
///
/// ★ 这是"缺了哪些、为什么"的**数据**（前端要读它），不是一句日志 ——
///   2026-10-17 之前这一类只剩最后那句 `Err` 里的 3 个样例。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackFailedFile {
    /// 任务标签：`.mrpack` 给的是清单里的路径（`mods/xxx.jar`），
    /// CurseForge 给的是文件名 —— **照抄，不加工**（用户要认的就是它）。
    pub label: String,
    /// 为什么没下来（下载引擎的原话；已经带上重试轮数等上下文）。
    pub reason: String,
    /// 还能再试吗 —— 判据是 `domain::failure` 那一份，**不在这里另写一套**。
    pub retryable: bool,
}

impl PackFailedFile {
    pub fn new(label: impl Into<String>, reason: impl Into<String>, retryable: bool) -> Self {
        Self {
            label: label.into(),
            reason: reason.into(),
            retryable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三样都在盘上、一个文件都不缺 ⇒ 成功
    #[test]
    fn an_intact_skeleton_with_nothing_missing_is_complete() {
        let s = SkeletonState {
            pack_body: Some(true),
            client_jar: Some(true),
            loader: Some(true),
        };
        assert_eq!(classify_install(&s, 0), PackInstallTier::Complete);
        assert!(classify_install(&s, 0).is_success());
        assert!(s.missing_parts().is_empty());
        assert_eq!(s.missing_text(), "");
    }

    /// ★★ **这次要修的那一档**：骨架齐全 + 有文件没下来 ⇒ **算成功**（Partial）
    #[test]
    fn an_intact_skeleton_with_missing_files_is_partial_and_still_a_success() {
        let s = SkeletonState {
            pack_body: Some(true),
            client_jar: Some(true),
            loader: Some(true),
        };
        for n in [1usize, 2, 5, 338] {
            let tier = classify_install(&s, n);
            assert_eq!(tier, PackInstallTier::Partial, "缺 {n} 个也还是 partial");
            assert!(tier.is_success(), "★ partial 必须算成功（前端据此建实例）");
        }
    }

    /// 骨架缺 ⇒ Broken，**且与缺几个文件无关**（0 个也 Broken）
    #[test]
    fn a_broken_skeleton_is_never_a_partial_success() {
        let no_client = SkeletonState {
            pack_body: Some(true),
            client_jar: Some(false),
            loader: Some(true),
        };
        assert_eq!(classify_install(&no_client, 3), PackInstallTier::Broken);
        assert_eq!(
            classify_install(&no_client, 0),
            PackInstallTier::Broken,
            "★ 文件全到手、骨架却缺 ⇒ 仍然是失败（混起来就等于「起不来也报装上」）"
        );
        assert!(!PackInstallTier::Broken.is_success());

        let no_loader = SkeletonState {
            pack_body: Some(true),
            client_jar: Some(true),
            loader: Some(false),
        };
        assert_eq!(classify_install(&no_loader, 1), PackInstallTier::Broken);

        let no_body = SkeletonState {
            pack_body: Some(false),
            client_jar: Some(true),
            loader: Some(true),
        };
        assert_eq!(classify_install(&no_body, 1), PackInstallTier::Broken);
    }

    /// ★ `None`（计划里没有这一项）**不算缺** —— 这个包不要加载器、
    ///   或这个版本的 JSON 里没有客户端 jar，都还是"能起来"。
    #[test]
    fn a_part_that_the_plan_never_had_is_not_a_missing_part() {
        let s = SkeletonState {
            pack_body: Some(true),
            client_jar: None,
            loader: None,
        };
        assert!(s.is_intact());
        assert_eq!(classify_install(&s, 0), PackInstallTier::Complete);
        assert_eq!(classify_install(&s, 4), PackInstallTier::Partial);
    }

    /// 缺哪几样要**点名**（错误文案直接用它）
    #[test]
    fn missing_parts_are_named() {
        let s = SkeletonState {
            pack_body: Some(false),
            client_jar: Some(false),
            loader: Some(true),
        };
        assert_eq!(
            s.missing_parts(),
            vec![SkeletonPart::PackBody, SkeletonPart::ClientJar]
        );
        assert_eq!(s.missing_text(), "整合包体、客户端 jar");
        assert!(!s.is_intact());
    }

    /// 明细条目的形状（前端读的就是这三个字段）
    #[test]
    fn failed_file_carries_label_reason_and_retryable() {
        let f = PackFailedFile::new(
            "mods/balm-fabric-7.2.1.jar",
            "连接超时（重试 3 轮后仍失败）",
            true,
        );
        assert_eq!(f.label, "mods/balm-fabric-7.2.1.jar");
        assert!(f.reason.contains("连接超时"));
        assert!(f.retryable);
        let g = PackFailedFile::new("ftb-teams.jar", "404", false);
        assert!(!g.retryable);
    }
}
