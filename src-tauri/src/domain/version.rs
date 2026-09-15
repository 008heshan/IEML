//! 版本号比较与区间（对应前端 `src/domain/version.ts`，ADR-022）

use serde::Serialize;
use std::cmp::Ordering;

/// 把版本串拆成可比较的段；非数字段退化为 0，保证不会 panic
pub fn parse_version(v: &str) -> Vec<u32> {
    v.split('.')
        .map(|seg| {
            let digits: String = seg
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u32>().unwrap_or(0)
        })
        .collect()
}

/// -1 / 0 / 1
pub fn compare_version(a: &str, b: &str) -> Ordering {
    let pa = parse_version(a);
    let pb = parse_version(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    Ordering::Equal
}

/// Forge 版本匹配（源码事实：RequiredForgeVersion 的两种比较方式）
///
/// * 需求串是**完整三段式**（"47.2.0"）→ 精确比较
/// * 需求串是**两段式**（"36.2"）→ 按段位前缀匹配，所以 36.2.39 与 36.2.34 都通过
/// * 空串 → 无限制
///
/// 判据是**段数**而不是"含不含点"—— 这一点在前端踩过两次坑，见 version.ts 的注释。
pub fn forge_version_satisfies(required: &str, actual: &str) -> bool {
    let req = required.trim();
    if req.is_empty() {
        return true;
    }

    let req_segs: Vec<&str> = req.split('.').collect();
    let act_segs: Vec<&str> = actual.split('.').collect();

    if req_segs.len() >= 3 {
        return compare_version(req, actual) == Ordering::Equal;
    }

    if act_segs.len() < req_segs.len() {
        return false;
    }
    for (i, want) in req_segs.iter().enumerate() {
        let got = act_segs.get(i).copied().unwrap_or("");
        let w: u32 = want.parse().unwrap_or(0);
        let g: u32 = got.parse().unwrap_or(0);
        if w != g {
            return false;
        }
    }
    true
}

/// 版本区间（闭区间模型）
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct VersionRange {
    pub min: Option<f64>,
    pub min_inclusive: bool,
    pub max: Option<f64>,
    pub max_inclusive: bool,
}

impl VersionRange {
    pub fn contains(&self, value: f64) -> bool {
        if let Some(min) = self.min {
            if self.min_inclusive {
                if value < min {
                    return false;
                }
            } else if value <= min {
                return false;
            }
        }
        if let Some(max) = self.max {
            if self.max_inclusive {
                if value > max {
                    return false;
                }
            } else if value >= max {
                return false;
            }
        }
        true
    }

    pub fn format(&self) -> String {
        /*
         * ★ 无界的一侧用**圆括号**，例如 `[17, )` / `(, 9)`。
         *
         *   以前直接用 `max_inclusive` 决定方括号 —— 而 `atLeast(17)` 这类
         *   区间的 `max_inclusive` 字段是 `true`（它只是"没设上限"），
         *   于是会打印成 `[17, ]`：**看着像一个闭合区间，其实是无穷**。
         *   用户读到的是"最高 Java 空"，而我们要说的是"没有上限"。
         *
         *   与前端 `src/domain/java.ts` 的 `formatJavaRange` **逐字一致**
         *   （`tests/java-rules.cases.json` 两侧共用，改一边就红）。
         */
        let l = if self.min.is_some() && self.min_inclusive { '[' } else { '(' };
        let r = if self.max.is_some() && self.max_inclusive { ']' } else { ')' };
        let min = self.min.map(|v| v.to_string()).unwrap_or_default();
        let max = self.max.map(|v| v.to_string()).unwrap_or_default();
        format!("{l}{min}, {max}{r}")
    }
}

/// 解析形如 "[17.0, 22.0)" / "(,21]" / "[17,)" 的区间串。
/// 错误信息必须**可行动** —— 空区间要给出怎么改。
pub fn parse_range(text: &str) -> Result<VersionRange, String> {
    let t = text.trim();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() < 5 {
        return Err("格式形如 [17.0, 22.0) —— 方括号含该值、圆括号不含，留空一侧表示不限制".into());
    }
    let left = chars[0];
    let right = *chars.last().unwrap();
    if (left != '[' && left != '(') || (right != ']' && right != ')') {
        return Err("区间两端必须用方括号或圆括号，例如 [17.0, 22.0)".into());
    }
    let inner: String = chars[1..chars.len() - 1].iter().collect();
    let parts: Vec<&str> = inner.split(',').collect();
    if parts.len() != 2 {
        return Err("区间里必须正好有一个逗号，例如 [17.0, 22.0)".into());
    }

    let parse_side = |s: &str| -> Result<Option<f64>, String> {
        let s = s.trim();
        if s.is_empty() {
            return Ok(None);
        }
        s.parse::<f64>()
            .map(Some)
            .map_err(|_| format!("「{s}」不是合法数字"))
    };

    let min = parse_side(parts[0])?;
    let max = parse_side(parts[1])?;

    if min.is_none() && max.is_none() {
        return Err("两侧都不限制时，请直接用「自动选择」".into());
    }
    if let (Some(a), Some(b)) = (min, max) {
        if a > b {
            return Err(format!("下限 {a} 大于上限 {b}"));
        }
        if (a - b).abs() < f64::EPSILON && (left == '(' || right == ')') {
            return Err(format!(
                "({a}, {b}) 是空区间（开区间两端相等，什么都选不到）。如果只想允许 {a}，请写 [{a}, {a}]"
            ));
        }
    }

    Ok(VersionRange {
        min,
        min_inclusive: left == '[',
        max,
        max_inclusive: right == ']',
    })
}

/// 区间右侧闭区间的歧义提示（PCL2 的两种改法，ADR-022）
pub fn range_boundary_hint(r: &VersionRange, probe: u32) -> Option<String> {
    if let Some(max) = r.max {
        if max == probe as f64 && r.max_inclusive {
            return Some(format!(
                "如果不想允许 Java {probe}，请改为 {probe})；如果想允许，请改为 {})",
                probe + 1
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_two_segment_prefix_match() {
        // ★ 回归测试：两段式需求必须能匹配三段式实际版本
        assert!(forge_version_satisfies("36.2", "36.2.39"));
        assert!(forge_version_satisfies("36.2", "36.2.34"));
        assert!(!forge_version_satisfies("36.2", "36.1.0"));
    }

    #[test]
    fn forge_three_segment_exact() {
        assert!(forge_version_satisfies("47.2.0", "47.2.0"));
        assert!(!forge_version_satisfies("47.2.0", "47.2.1"));
    }

    #[test]
    fn forge_empty_means_unlimited() {
        assert!(forge_version_satisfies("", "anything"));
    }

    #[test]
    fn compare_handles_irregular_versions() {
        assert_eq!(compare_version("1.20.4", "1.20.1"), Ordering::Greater);
        assert_eq!(compare_version("1.20", "1.20.1"), Ordering::Less);
        assert_eq!(compare_version("24w45a", "1.20.1"), Ordering::Greater);
    }

    #[test]
    fn range_half_open() {
        let r = parse_range("[17.0, 22.0)").unwrap();
        assert!(r.contains(17.0));
        assert!(r.contains(21.0));
        assert!(!r.contains(22.0));
        assert!(!r.contains(16.0));
    }

    #[test]
    fn range_empty_interval_gives_actionable_error() {
        let e = parse_range("(21, 21)").unwrap_err();
        assert!(e.contains("21"), "{e}");
        assert!(e.contains("[21, 21]"), "{e}");
    }

    #[test]
    fn range_rejects_garbage() {
        assert!(parse_range("17-22").is_err());
        assert!(parse_range("[22, 17]").is_err());
        assert!(parse_range("(,)").is_err());
    }
}
