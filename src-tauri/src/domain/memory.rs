//! 内存分配算法（对应前端 `src/domain/memory.ts`，ADR-029）
//!
//! 核心思想：**先按"游戏需要多少"定锚，再按"机器还剩多少"打折**。
//! 比"物理内存的一半"准得多，天然适配整合包。
//!
//! ★ 修掉了原设计稿实现里的一个 bug：原稿在"可用内存不足 T1"时仍给足 T1，
//!   导致分配值可能超过可用内存。这里保证**任何阶段都不得超发**。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceMemoryType {
    Modded,
    OptiFine,
    Vanilla,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct MemoryTargets {
    pub min: f64,
    pub t1: f64,
    pub t2: f64,
    pub t3: f64,
}

pub fn memory_targets(mod_count: u32, kind: InstanceMemoryType) -> MemoryTargets {
    let n = mod_count as f64;
    match kind {
        InstanceMemoryType::Modded => MemoryTargets {
            min: 0.5 + n / 150.0,
            t1: 1.5 + n / 90.0,
            t2: 2.7 + n / 50.0,
            t3: 4.5 + n / 25.0,
        },
        InstanceMemoryType::OptiFine => MemoryTargets {
            min: 0.5,
            t1: 1.5,
            t2: 3.0,
            t3: 5.0,
        },
        InstanceMemoryType::Vanilla => MemoryTargets {
            min: 0.5,
            t1: 1.5,
            t2: 2.5,
            t3: 4.0,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AutoMemoryResult {
    pub gb: f64,
    pub mod_count: u32,
    pub available_gb: f64,
    pub start_gb: f64,
    pub escalate_gb: f64,
    pub capped_by_available: bool,
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

/// 四阶段递减比例分配：
/// 阶段一 0→T1 取 100%；阶段二 T1→T2 取 70%；阶段三 T2→T3 取 40%；阶段四 T3→2·T3 取 15%。
/// 任一阶段后可用 < 0.1 GB 就停；最后 max(值, 最低值)，并受物理内存封顶。
pub fn auto_memory(
    mod_count: u32,
    kind: InstanceMemoryType,
    total_gb: f64,
    available_gb: f64,
) -> AutoMemoryResult {
    let t = memory_targets(mod_count, kind);
    let mut avail = available_gb.max(0.0);
    let mut give = 0.0;

    // 阶段一：0 → T1，全给
    let s1 = avail.min(t.t1);
    give += s1;
    avail -= s1;
    let capped = s1 < t.t1 - 1e-9;

    if !capped && avail >= 0.1 {
        let s2 = (avail * 0.7).min(t.t2 - t.t1);
        give += s2;
        avail -= s2;
    }
    if give >= t.t2 - 1e-9 && avail >= 0.1 {
        let s3 = (avail * 0.4).min(t.t3 - t.t2);
        give += s3;
        avail -= s3;
    }
    if give >= t.t3 - 1e-9 && avail >= 0.1 {
        let s4 = (avail * 0.15).min(t.t3);
        give += s4;
    }

    let gb = round1(give.max(t.min).min(total_gb.max(0.5)));

    AutoMemoryResult {
        gb,
        mod_count,
        available_gb: round1(available_gb),
        start_gb: round1(1.5 + mod_count as f64 / 90.0),
        escalate_gb: round1(2.7 + mod_count as f64 / 50.0),
        capped_by_available: capped || give < t.t2 - 1e-9,
    }
}

/// 生成"依据"文案 —— 用**真实算出来的数值**，不写死。
/// 原设计稿写死了"向 2.7 GB 递进"，而实际算出的是 3.2，说明文字与结果对不上。
pub fn memory_reasoning(mod_count: u32, r: &AutoMemoryResult) -> String {
    if r.capped_by_available {
        format!(
            "检测到 {mod_count} 个 Mod，按「1.5 + {mod_count}/90 ≈ {} GB」起步；受当前可用内存 {} GB 限制，分配 {} GB。",
            r.start_gb, r.available_gb, r.gb
        )
    } else {
        format!(
            "检测到 {mod_count} 个 Mod，按「1.5 + {mod_count}/90 ≈ {} GB」起步，可用内存充裕时向 {} GB 递进；本次分配 {} GB（可用 {} GB）。",
            r.start_gb, r.escalate_gb, r.gb, r.available_gb
        )
    }
}

/* ====================== 滑块档位映射 ====================== */

/// 档位 → GB 的分段映射（与原版一致，已数值验证）
pub fn gear_to_gb(v: u32) -> f64 {
    if v <= 12 {
        round1(v as f64 * 0.1 + 0.3)
    } else if v <= 25 {
        round1((v as f64 - 12.0) * 0.5 + 1.5)
    } else if v <= 33 {
        round1(v as f64 - 25.0 + 8.0)
    } else {
        round1((v as f64 - 33.0) * 2.0 + 16.0)
    }
}

/// 档位上限随物理内存动态变化
pub fn max_gear(total_gb: f64) -> u32 {
    let g = if total_gb <= 1.5 {
        ((total_gb - 0.3) / 0.1).floor().max(1.0)
    } else if total_gb <= 8.0 {
        ((total_gb - 1.5) / 0.5).floor() + 12.0
    } else if total_gb <= 16.0 {
        (total_gb - 8.0).floor() + 25.0
    } else {
        ((total_gb - 16.0) / 2.0).floor() + 33.0
    };
    g.max(0.0) as u32
}

/// GB → 最接近的档位。
/// ★ 修掉了原稿"手柄位置与显示值对不上"的问题：取**最接近**而不是向下取整，
///   并把该档对应的 GB 作为唯一真值。
pub fn gb_to_gear(gb: f64, total_gb: f64) -> u32 {
    let max = max_gear(total_gb);
    let mut best = 0u32;
    let mut best_diff = f64::INFINITY;
    for v in 0..=max {
        let diff = (gear_to_gb(v) - gb).abs();
        if diff < best_diff {
            best_diff = diff;
            best = v;
        }
    }
    best
}

/// 把任意内存值吸附到滑块能表达的最近档位
pub fn snap_to_gear(gb: f64, total_gb: f64) -> f64 {
    gear_to_gb(gb_to_gear(gb, total_gb))
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryBar {
    pub used_gb: f64,
    pub game_gb: f64,
    pub free_gb: f64,
    pub total_gb: f64,
    pub over_available: bool,
}

pub fn memory_bar(requested_gb: f64, total_gb: f64, available_gb: f64) -> MemoryBar {
    let used = (total_gb - available_gb).max(0.0);
    let game = requested_gb.min(available_gb);
    let free = (total_gb - used - game).max(0.0);
    MemoryBar {
        used_gb: round1(used),
        game_gb: round1(game),
        free_gb: round1(free),
        total_gb: round1(total_gb),
        over_available: requested_gb > available_gb + 1e-9,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gear_mapping_matches_original() {
        assert_eq!(gear_to_gb(12), 1.5);
        assert_eq!(gear_to_gb(25), 8.0);
        assert_eq!(gear_to_gb(33), 16.0);
    }

    #[test]
    fn gear_mapping_is_monotonic() {
        let mut prev = -1.0;
        for v in 0..=max_gear(32.0) {
            let gb = gear_to_gb(v);
            assert!(gb >= prev - 1e-9, "档 {v} 回退: {gb} < {prev}");
            prev = gb;
        }
    }

    #[test]
    fn auto_never_overshoots_available() {
        // ★ 回归测试：原设计稿在这里会超发
        let r = auto_memory(24, InstanceMemoryType::Modded, 8.0, 1.5);
        assert!(r.gb <= 1.5 + 1e-9, "分配 {} 超过可用 1.5", r.gb);
        assert!(r.capped_by_available);
    }

    #[test]
    fn auto_grows_with_mod_count() {
        let few = auto_memory(0, InstanceMemoryType::Modded, 32.0, 16.0).gb;
        let many = auto_memory(200, InstanceMemoryType::Modded, 32.0, 16.0).gb;
        assert!(many > few);
    }

    #[test]
    fn snap_keeps_handle_and_label_consistent() {
        let raw = auto_memory(24, InstanceMemoryType::Modded, 7.9, 3.2).gb;
        let g = gb_to_gear(raw, 7.9);
        assert_eq!(gear_to_gb(g), snap_to_gear(raw, 7.9));
    }

    #[test]
    fn bar_segments_add_up() {
        let b = memory_bar(2.5, 7.9, 3.2);
        let sum = b.used_gb + b.game_gb + b.free_gb;
        assert!((sum - b.total_gb).abs() < 0.11, "{sum} vs {}", b.total_gb);
    }
}
