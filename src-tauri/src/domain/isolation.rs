//! **版本隔离**：ADR-005 的三段判定（**唯一实现**）。
//!
//! ## 这个模块存在的理由
//!
//!   隔离这件事以前有**三份说法**、而且都不算数：
//!
//!   * `commands::resolve_isolation` 是一份**没人调**的判定（前端一次都没 invoke 过）；
//!   * `src/domain/isolation.ts` 是另一份（措辞还不一样）；
//!   * 而**真正决定游戏目录的那一行**（`prepare_spec` 里的 `instance_game_dir`）
//!     两份都不看 —— 于是"不隔离"选了也白选。
//!
//!   ⇒ 现在规则只有这一份（纯函数，能单测），平台层 [`crate::platform::AppPaths::isolation_verdict`]
//!     负责把"账本 + 盘上的内容 + 全局默认"喂进来，`game_dir_of` 负责把它落到路径上，
//!     界面显示的就是这同一个结论（ADR-006：规则只写一次，且写在 Rust 侧）。
//!
//! ## 三段判定（ADR-005）
//!
//! ```text
//!   ① 用户对这个实例的显式设置（on / off）        ← 最高
//!   ② auto 时：该实例目录下已经有 mods/ 或 saves/ → 隔离
//!   ③ 都还没有 → 全局默认（设置页那个开关，默认 isolated）
//! ```
//!
//! ★ "整合包导入的实例一律隔离"**不在这里**：创建整合包实例时写的本来就是
//!   `isolation: "on"`（见下载页那一段），也就是第 ① 段已经覆盖了。
//!   再单开一段"看它是不是整合包"，就得在账本里认一个今天并不存在的字段 ——
//!   而那段判定永远不会被触发（死代码）。
//!
//! ## 隔离到底改变什么
//!
//!   只有**一件事**：这个实例的游戏目录（`--gameDir`，也就是 `saves/` `mods/`
//!   `config/` `resourcepacks/` 所在的那一层）是**它自己的**还是**共享的 `.minecraft`**。
//!   `natives/`、实例自己的日志、备份清单仍然跟着实例走 —— 那些不是游戏数据。

use crate::domain::types::IsolationMode;

/// 判定的依据（界面用它显示"谁决定的"）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 用户显式设置
    User,
    /// 按目录内容自动判定
    Content,
    /// 跟随全局默认
    Global,
    /// **读不到账本**（`instances.json` 缺失/损坏）—— 这时按最保守的方式处理
    Unknown,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::User => "user",
            Source::Content => "content",
            Source::Global => "global",
            Source::Unknown => "unknown",
        }
    }
}

/// 判定结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// 最终是否隔离（true = 用实例自己的 `game/`；false = 用共享的 `.minecraft`）
    pub isolated: bool,
    pub source: Source,
    /// 一句话依据，**必须具体**（"检测到了什么"、"你选了什么"）
    pub reason: String,
    /// 关闭隔离时的后果警告（这是一个真的会互相污染的选择，必须说清）
    pub warning: Option<String>,
}

impl Verdict {
    pub fn source_str(&self) -> &'static str {
        self.source.as_str()
    }
}

/// 共享目录里那些"会互相污染"的东西（写警告与迁移提示时用同一份清单）
///
/// ★ 只列**游戏会读的那个目录**里的东西：多版本共用一个 `mods/` 就是
///   "1.20.1 的 Forge Mod 进了 1.21.1 的 classpath"，那正是 ADR-005 要防的事。
pub const SHARED_DIRS: [&str; 6] = ["saves", "mods", "config", "resourcepacks", "shaderpacks", "datapacks"];

/// 三段判定（ADR-005）
///
/// * `mode`：账本里那个实例的 `config.isolation`
/// * `has_content`：该实例**自己的**游戏目录下已经有 `mods/` 或 `saves/`
/// * `global_default`：`prefs.json` 的 `globalIsolation`（`"isolated"` / `"shared"`）
/// * `ledger_readable`：账本读得到吗（读不到时**不猜**用户的意图，保持隔离）
pub fn resolve(
    mode: IsolationMode,
    has_content: bool,
    global_default: &str,
    ledger_readable: bool,
) -> Verdict {
    /*
     * ★★ 账本读不到 ⇒ 保持隔离。这一条是**代价不对称**的考虑：
     *   猜错的方向如果是"切到共享目录"，用户的游戏会突然看不到自己的存档与 Mod
     *   （他会以为东西丢了）；而猜成"隔离"最多是少共享一次，什么都不丢。
     *   所以缺证据时**不共享**。
     */
    if !ledger_readable {
        return Verdict {
            isolated: true,
            source: Source::Unknown,
            reason: "读不到实例清单，无法判断这个实例的设置 —— 先按隔离处理（不会把游戏目录切到共享目录）"
                .to_string(),
            warning: None,
        };
    }

    /* ---------- ① 用户显式设置 ---------- */
    match mode {
        IsolationMode::On => {
            return Verdict {
                isolated: true,
                source: Source::User,
                reason: "你给这个实例设了「强制隔离」，它的 mods / saves / config 独立存放".to_string(),
                warning: None,
            };
        }
        IsolationMode::Off => {
            return Verdict {
                isolated: false,
                source: Source::User,
                reason: format!(
                    "你给这个实例设了「不隔离」—— 它与共享目录（.minecraft）用的是同一份 {}",
                    SHARED_DIRS.join(" / ")
                ),
                warning: Some(
                    "★ 多个版本会共用同一个 mods/：1.20.1 的 Mod 会被 1.21.1 一起读进去，\
                     常常直接起不来。只有纯原版、或者你确实想共用一份 Mod 时才这样选。"
                        .to_string(),
                ),
            };
        }
        IsolationMode::Auto => {}
    }

    /* ---------- ② 按内容：已经有东西在里面了，就别动它 ---------- */
    if has_content {
        return Verdict {
            isolated: true,
            source: Source::Content,
            reason: "这个实例自己的目录里已经有 mods/ 或 saves/ —— 保持隔离，免得这些内容\
                     被别的版本看到"
                .to_string(),
            warning: None,
        };
    }

    /* ---------- ③ 跟着全局默认 ---------- */
    let isolated = global_default != "shared";
    Verdict {
        isolated,
        source: Source::Global,
        reason: if isolated {
            "实例目录还是空的，按全局默认启用隔离".to_string()
        } else {
            "实例目录还是空的，按全局默认与别的实例共用目录（不隔离）".to_string()
        },
        warning: None,
    }
}

/// 隔离模式怎么念（界面与日志共用一份措辞）
pub fn mode_label(mode: IsolationMode) -> &'static str {
    match mode {
        IsolationMode::Auto => "自动",
        IsolationMode::On => "强制隔离",
        IsolationMode::Off => "不隔离",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ① 用户显式设置压过一切：哪怕目录里有内容、全局默认相反
    #[test]
    fn the_users_choice_beats_content_and_the_global_default() {
        let on = resolve(IsolationMode::On, true, "shared", true);
        assert!(on.isolated);
        assert_eq!(on.source, Source::User);
        assert!(on.warning.is_none(), "强制隔离没有什么要警告的");

        let off = resolve(IsolationMode::Off, false, "isolated", true);
        assert!(!off.isolated, "显式选了不隔离，就得真的不隔离");
        assert_eq!(off.source, Source::User);
        // ★ 这是一个真的会互相污染的选择，警告必须给
        let w = off.warning.expect("关隔离必须警告互相污染");
        assert!(w.contains("mods"), "{w}");
        // 依据里要说清"共用的是哪几样"，不能只说"共用目录"
        assert!(off.reason.contains("saves"), "{}", off.reason);
        assert!(off.reason.contains("mods"), "{}", off.reason);
    }

    /// ② auto + 目录里有东西 → 隔离，并且理由说得出"检测到了什么"
    #[test]
    fn auto_isolates_when_the_instance_already_has_content() {
        let v = resolve(IsolationMode::Auto, true, "shared", true);
        assert!(v.isolated, "已经有内容了就不该切到共享目录");
        assert_eq!(v.source, Source::Content);
        assert!(v.reason.contains("mods"), "{}", v.reason);
        assert!(v.reason.contains("saves"), "{}", v.reason);
        assert!(v.warning.is_none());
    }

    /// ③ auto + 目录空的 → 跟全局默认（默认那一侧是 isolated）
    #[test]
    fn auto_follows_the_global_default_when_the_instance_is_empty() {
        let iso = resolve(IsolationMode::Auto, false, "isolated", true);
        assert!(iso.isolated);
        assert_eq!(iso.source, Source::Global);

        let shared = resolve(IsolationMode::Auto, false, "shared", true);
        assert!(!shared.isolated);
        assert_eq!(shared.source, Source::Global);

        // ★ 认不出来的值按**保守**那一侧走（等于默认 isolated），不然一个拼错的
        //   设置就会把用户切到共享目录去
        assert!(resolve(IsolationMode::Auto, false, "yes-please", true).isolated);
        assert!(resolve(IsolationMode::Auto, false, "", true).isolated);
    }

    /// ★★ 读不到账本 ⇒ 保持隔离（代价不对称：切错方向会让用户以为存档丢了）
    #[test]
    fn an_unreadable_ledger_keeps_isolation_instead_of_guessing() {
        let v = resolve(IsolationMode::Off, false, "shared", false);
        assert!(v.isolated, "读不到账本时不许把游戏目录切到共享目录");
        assert_eq!(v.source, Source::Unknown);
        assert!(v.reason.contains("读不到实例清单"), "{}", v.reason);
    }

    /// 措辞表与判定表都要能用（界面与日志共用）
    #[test]
    fn labels_and_shared_dirs_are_stable() {
        assert_eq!(mode_label(IsolationMode::Auto), "自动");
        assert_eq!(mode_label(IsolationMode::Off), "不隔离");
        assert!(SHARED_DIRS.contains(&"saves"));
        // 警告里点名的那几样，必须与"共享目录清单"同源（不能一处改一处忘）
        let off = resolve(IsolationMode::Off, false, "isolated", true);
        for d in SHARED_DIRS {
            assert!(off.reason.contains(d), "依据里少说了 {d}：{}", off.reason);
        }
    }
}
