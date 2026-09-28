//! **这个整合包有没有新版本**（ADR-025 第 4 条："拿记录去问平台"）。
//!
//! ## 为什么这条规矩值得单独写成纯函数
//!
//!   0.15.0 把整合包实例的 Mod 更新锁上了，理由句里写着"作者没有提供新版清单"——
//!   而那句话当时**没法验证**：我们根本不知道作者有没有发新版。
//!   这一模块就是那半句缺的东西：拿记录里的身份去问平台，然后**如实**回答。
//!
//! ## 只做判定，不做网络
//!
//!   拉清单在命令层（要网络、要缓存、要报错）。这里只回答"这两串版本号谁新"、
//!   "新清单会让盘上少/多/换哪些文件"，于是每条规则都能用一串字面量单测。
//!
//! ## 三条不许含糊的规矩
//!
//!   ① **比不出来就说比不出来**：版本号是作者随手写的（`1.0`、`v2`、`最终版`），
//!      两串不可比时不许猜"新的那个就是新版" —— 那会让用户白下一整包。
//!      返回 `Different`（两边都报出来，让用户自己判断）。
//!   ② **本地比线上新时不许"降级"**：用户可能装的是 beta 或作者删过的版本，
//!      这时说"有新版本"再一键升回去，等于把用户的东西换掉。返回 `LocalAhead`。
//!   ③ **没有身份就如实说不知道**：拖进来的 `.mrpack` 里没有 project id，
//!      那就 `Unknown`，**不许**拿包名去搜一个看起来像的（搜错了会把别人的包
//!      装进这个实例）。

use crate::domain::pack_record::{PackFile, PackRecord};

/// 平台上的一个版本（只取我们真正要用的字段）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct RemotePackVersion {
    /// 平台那一侧的版本 id（Modrinth 的 `version.id`）
    pub id: String,
    /// 作者写的版本号（`version_number`）
    pub version: String,
    /// 发布时间（ISO 字符串，只用于显示）
    #[serde(default)]
    pub published: String,
    /// 包体下载地址（主文件）
    #[serde(default)]
    pub url: String,
    /// 包体大小（0 = 平台没给）
    #[serde(default)]
    pub size: u64,
    /// ★ **这一版是给哪个 MC 版本的**（Modrinth 的 `game_versions[0]`）。
    ///
    ///   为什么必须带上它才能判"能不能原地升"：整合包换 MC 版本时，
    ///   里面的 Mod、存档、世界格式全都跟着换 —— 那**不是升级，是换一个包**。
    ///   ADR-018 对单个 Mod 写的是"绝不跨大版本跳跃后静默替换"，整包同理。
    #[serde(default)]
    pub mc_version: Option<String>,
}

/// 问完平台之后的结论
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UpdateVerdict {
    /// 就是最新的
    UpToDate {
        version: String,
        /// 人话（界面直接显示这一句）
        summary: String,
    },
    /// 线上有更新的
    Newer {
        version: String,
        version_id: String,
        published: String,
        url: String,
        size: u64,
        summary: String,
    },
    /// 本地这个比线上最新的还新（或线上已经没有它了）—— **不降级**
    LocalAhead { version: String, summary: String },
    /// ★ 作者发的新版**换了 MC 版本** —— 那等于换一个包，**不提供原地升级**
    NewerMc {
        version: String,
        mc_version: String,
        version_id: String,
        url: String,
        size: u64,
        summary: String,
    },
    /// 版本号不可比：两边都报出来，用户自己判断
    Different {
        ours: String,
        theirs: String,
        version_id: String,
        url: String,
        size: u64,
        summary: String,
    },
    /// 问不出来（没有身份 / 平台没通 / 平台上没有这个包）
    Unknown { reason: String, summary: String },
}

impl UpdateVerdict {
    /// 界面显示的那一句话（**唯一来源**：措辞只写一遍）
    pub fn summary(&self) -> &str {
        match self {
            UpdateVerdict::UpToDate { summary, .. }
            | UpdateVerdict::Newer { summary, .. }
            | UpdateVerdict::LocalAhead { summary, .. }
            | UpdateVerdict::NewerMc { summary, .. }
            | UpdateVerdict::Different { summary, .. }
            | UpdateVerdict::Unknown { summary, .. } => summary,
        }
    }

    /// 有没有"可以**原地**升级的东西"（界面据此决定显不显示升级按钮）
    ///
    /// ★ `NewerMc` **故意不在**这里：换了 MC 版本的新版不能原地升（那会连存档
    ///   与世界格式一起换掉），界面会给一句解释而不是一个按钮。
    pub fn upgrade_target(&self) -> Option<&str> {
        match self {
            UpdateVerdict::Newer { version_id, .. } | UpdateVerdict::Different { version_id, .. } => {
                Some(version_id)
            }
            _ => None,
        }
    }
}

/// 比两串版本号。
///
/// 规则（够用就好，**不追求完整 semver**）：
///   · 先按 `.` `-` `_` `+` 切段；
///   · 数字段按**数值**比（`1.10 > 1.9` —— 这是最容易错的那条）；
///   · 非数字段按字典序（忽略大小写）比；
///   · 数字段 **小于** 非数字段（`1.0` < `1.0a`，同 HMCL 的习惯）；
///   · 前缀全等但段数不同 ⇒ 段多的那个大（`1.2` < `1.2.1`）；
///   · 有一段的**首个字符**既不是数字也不是字母（`最终版`、`??`）⇒ `None`（比不了）。
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;

    /// 前导 `v` 谁都会写，去掉它再比（`v1.2` 与 `1.2` 是同一个版本）
    fn trim_v(s: &str) -> &str {
        let t = s.trim();
        let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
        t.trim()
    }

    fn segs(s: &str) -> Option<Vec<String>> {
        let t = trim_v(s);
        if t.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        for part in t.split(['.', '-', '_', '+', ' ']) {
            if part.is_empty() {
                continue;
            }
            let c = part.chars().next()?;
            if !(c.is_ascii_digit() || c.is_ascii_alphabetic()) {
                return None;
            }
            out.push(part.to_string());
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    let (sa, sb) = (segs(a)?, segs(b)?);
    for i in 0..sa.len().max(sb.len()) {
        match (sa.get(i), sb.get(i)) {
            (None, None) => break,
            // 前缀全等但一边没了：段多的那个大
            (None, Some(_)) => return Some(Ordering::Less),
            (Some(_), None) => return Some(Ordering::Greater),
            (Some(x), Some(y)) => {
                let nx = x.parse::<u64>().ok();
                let ny = y.parse::<u64>().ok();
                let ord = match (nx, ny) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    // 数字段小于文字段
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.to_lowercase().cmp(&y.to_lowercase()),
                };
                if ord != Ordering::Equal {
                    return Some(ord);
                }
            }
        }
    }
    Some(Ordering::Equal)
}

/// 拿记录去比平台给的版本清单（**只看同一个 MC 版本的那些**）
///
/// 整体思路：
///   ① 先按"是不是同一个 MC 版本"把清单分成两堆；
///   ② 结论只看**同一堆**（跨 MC 的不叫升级，叫换包）；
///   ③ 同一堆里如果压根没有比我们新的，但**另一堆**有更新的 ⇒ `NewerMc`，
///      把"作者换 MC 版本了"这件事如实说出来（用户可能正想换）。
pub fn verdict_for(record: Option<&PackRecord>, remote: &[RemotePackVersion]) -> UpdateVerdict {
    let Some(rec) = record else {
        return UpdateVerdict::Unknown {
            reason: "这个实例没有整合包安装记录".into(),
            summary: "这个版本不是从整合包装出来的，没法比对整合包版本。".into(),
        };
    };

    if remote.is_empty() {
        return UpdateVerdict::Unknown {
            reason: "平台返回的版本清单是空的".into(),
            summary: format!(
                "平台上查不到「{}」的版本清单（可能作者把包设为私有或删了）。",
                rec.name
            ),
        };
    }

    /*
     * ★ 挑"最新"用的是**版本号比较**，不是清单顺序 ——
     *   平台虽然通常按时间倒序给，但那是它们的实现细节；
     *   比不出来的那些（作者写了 `最终版`）就退回清单顺序的第一条。
     */
    let newest_of = |list: &[&RemotePackVersion]| -> Option<RemotePackVersion> {
        let mut it = list.iter();
        let mut best: &RemotePackVersion = *it.next()?;
        for v in it {
            if let Some(std::cmp::Ordering::Greater) = compare_versions(&v.version, &best.version) {
                best = v;
            }
        }
        Some(best.clone())
    };

    // 平台没写 MC 版本的那些当作"同一堆"（信息缺失不等于换了版本）
    let same_mc: Vec<&RemotePackVersion> = remote
        .iter()
        .filter(|v| {
            v.mc_version
                .as_deref()
                .map(|m| m == rec.mc_version)
                .unwrap_or(true)
        })
        .collect();
    let other_mc: Vec<&RemotePackVersion> = remote
        .iter()
        .filter(|v| {
            v.mc_version
                .as_deref()
                .map(|m| m != rec.mc_version)
                .unwrap_or(false)
        })
        .collect();

    let newer_mc = newest_of(&other_mc).filter(|v| {
        matches!(
            compare_versions(&v.version, &rec.version),
            Some(std::cmp::Ordering::Greater)
        )
    });

    let Some(newest) = newest_of(&same_mc) else {
        // 同一个 MC 版本一版都没有：要么作者只为别的 MC 发过，要么就是换版本了
        return match newer_mc {
            Some(v) => newer_mc_verdict(rec, &v),
            None => UpdateVerdict::Unknown {
                reason: "平台上没有这个 MC 版本的包".into(),
                summary: format!(
                    "平台上「{}」没有给 {} 的版本（你现在装的就是这个 MC 版本）。",
                    rec.name, rec.mc_version
                ),
            },
        };
    };

    match compare_versions(&newest.version, &rec.version) {
        Some(std::cmp::Ordering::Equal) => match newer_mc {
            Some(v) => newer_mc_verdict(rec, &v),
            None => UpdateVerdict::UpToDate {
                version: rec.version.clone(),
                summary: format!("已是最新（{} {}）。", rec.name, rec.version),
            },
        },
        Some(std::cmp::Ordering::Less) => UpdateVerdict::LocalAhead {
            version: rec.version.clone(),
            summary: format!(
                "你装的 {} 比平台上最新的 {} 还新（作者可能撤过版本）—— 不动它。",
                rec.version, newest.version
            ),
        },
        Some(std::cmp::Ordering::Greater) => UpdateVerdict::Newer {
            version: newest.version.clone(),
            version_id: newest.id.clone(),
            published: newest.published.clone(),
            url: newest.url.clone(),
            size: newest.size,
            summary: if newest.published.is_empty() {
                format!(
                    "作者发布了新版本 {}（你装的是 {}）。",
                    newest.version, rec.version
                )
            } else {
                format!(
                    "作者发布了新版本 {}（{}，你装的是 {}）。",
                    newest.version,
                    &newest.published[..newest.published.len().min(10)],
                    rec.version
                )
            },
        },
        // ★ 比不出来：两边都报出来，让用户自己判断 —— 不猜
        None => UpdateVerdict::Different {
            ours: rec.version.clone(),
            theirs: newest.version.clone(),
            version_id: newest.id.clone(),
            url: newest.url.clone(),
            size: newest.size,
            summary: format!(
                "平台上最新的是「{}」，你装的是「{}」—— 版本号写法不一样，哪个新我看不出来，你自己判断。",
                newest.version, rec.version
            ),
        },
    }
}

/// 作者发的新版换了 MC 版本 —— 说清楚，但**不给原地升级的入口**
fn newer_mc_verdict(rec: &PackRecord, v: &RemotePackVersion) -> UpdateVerdict {
    let mc = v.mc_version.clone().unwrap_or_default();
    UpdateVerdict::NewerMc {
        version: v.version.clone(),
        mc_version: mc.clone(),
        version_id: v.id.clone(),
        url: v.url.clone(),
        size: v.size,
        summary: format!(
            "作者发布了 {}，但它换到 {} 了（这个实例是 {}）—— 那等于换一个包，\
             不建议在这里原地升：请在下载页新建一个实例装它。",
            v.version, mc, rec.mc_version
        ),
    }
}

/// 新清单会让盘上发生什么（按**路径**对齐，不看下载地址）
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct UpdatePlan {
    /// 新清单里有、旧记录里没有的
    pub add: Vec<String>,
    /// 两边都有但 sha1/大小对不上的（要重下）
    pub replace: Vec<String>,
    /// 旧记录里有、新清单里没有的（包不要它了）
    pub remove: Vec<String>,
    /// 两边一模一样，不动
    pub keep: Vec<String>,
}

impl UpdatePlan {
    /// 人话（界面直接显示）
    pub fn summary(&self) -> String {
        if self.add.is_empty() && self.replace.is_empty() && self.remove.is_empty() {
            return format!("文件清单没变（{} 个文件都不用动）。", self.keep.len());
        }
        format!(
            "新增 {} 个、更新 {} 个、移除 {} 个（另有 {} 个不动）。",
            self.add.len(),
            self.replace.len(),
            self.remove.len(),
            self.keep.len()
        )
    }

    /// 有没有要动的文件
    pub fn is_noop(&self) -> bool {
        self.add.is_empty() && self.replace.is_empty() && self.remove.is_empty()
    }
}

/// 对齐**做完了**的汇报（界面直接显示 `summary`）。
///
/// ★ 与 `UpdatePlan` 分开：计划是"打算做什么"，这里是"真的做了什么" ——
///   两者混在一个结构里，就一定会有一次把"打算"当成"做了"报出去。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppliedUpdate {
    pub add: usize,
    pub replace: usize,
    pub remove: usize,
    pub keep: usize,
    /// 被移除的文件放去了哪里（没移除任何东西时是 None）
    pub trash_dir: Option<String>,
    /// 移不动的那些（本来就不在盘上、或权限不对）—— 逐条列出来，不假装成功
    pub removed_failed: Vec<String>,
    pub summary: String,
}

/// 比对"旧记录里的文件"与"新清单里的文件"。
///
/// ## 两条判定细节
///
///   * **只有旧记录里的文件才可能被 `remove`**（记录里是"我们装下去的"，
///     用户自己丢进 `mods/` 的东西不在记录里 ⇒ 永远不会被这条规则删掉）；
///   * 判定"要不要重下"用 **sha1 优先、其次大小**：sha1 为空（很多包不给）
///     时退回比大小 —— 两样都缺就当作"不动"（宁可少下一次，也不无谓地重写盘）。
pub fn plan_update(old: &[PackFile], new: &[PackFile]) -> UpdatePlan {
    use std::collections::BTreeMap;

    let old_by: BTreeMap<&str, &PackFile> = old.iter().map(|f| (f.path.as_str(), f)).collect();
    let new_by: BTreeMap<&str, &PackFile> = new.iter().map(|f| (f.path.as_str(), f)).collect();

    let mut plan = UpdatePlan::default();
    for (path, nf) in &new_by {
        match old_by.get(path) {
            None => plan.add.push((*path).to_string()),
            Some(of) => {
                if same_file(of, nf) {
                    plan.keep.push((*path).to_string());
                } else {
                    plan.replace.push((*path).to_string());
                }
            }
        }
    }
    for path in old_by.keys() {
        if !new_by.contains_key(path) {
            plan.remove.push((*path).to_string());
        }
    }
    plan.add.sort();
    plan.replace.sort();
    plan.remove.sort();
    plan.keep.sort();
    plan
}

/// 两个条目是不是同一个文件（sha1 优先，其次大小）
fn same_file(a: &PackFile, b: &PackFile) -> bool {
    if !a.sha1.is_empty() && !b.sha1.is_empty() {
        return a.sha1.eq_ignore_ascii_case(&b.sha1);
    }
    if a.size > 0 && b.size > 0 {
        return a.size == b.size;
    }
    // 两样都没有可比信息 ⇒ 当"不动"（不许凭"名字一样"就重下几百 MB）
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    fn file(path: &str, sha1: &str, size: u64) -> PackFile {
        PackFile {
            path: path.into(),
            url: format!("https://example.invalid/{path}"),
            sha1: sha1.into(),
            size,
        }
    }

    fn record(version: &str, files: Vec<PackFile>) -> PackRecord {
        PackRecord {
            schema: 1,
            name: "探针包".into(),
            version: version.into(),
            source: "modrinth".into(),
            mc_version: "1.20.1".into(),
            loader_kind: Some("fabric".into()),
            loader_version: Some("0.15.0".into()),
            installed_at: 0,
            skipped: vec![],
            project_id: Some("probe-pack".into()),
            version_id: Some("old-version".into()),
            files,
        }
    }

    fn remote(id: &str, version: &str) -> RemotePackVersion {
        RemotePackVersion {
            id: id.into(),
            version: version.into(),
            published: "2026-09-01T00:00:00Z".into(),
            url: format!("https://example.invalid/{id}.mrpack"),
            size: 1234,
            mc_version: Some("1.20.1".into()),
        }
    }

    /// 同一个包但**换了 MC 版本**的新版（用来验"不给原地升级入口"）
    fn remote_other_mc(id: &str, version: &str, mc: &str) -> RemotePackVersion {
        RemotePackVersion {
            mc_version: Some(mc.into()),
            ..remote(id, version)
        }
    }

    /* ---------------- 版本号比较 ---------------- */

    /// ★ 数字段按**数值**比：`1.10 > 1.9`（按字典序会判反，这是最容易错的一条）
    #[test]
    fn version_numbers_compare_numerically() {
        assert_eq!(compare_versions("1.10", "1.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.9", "1.10"), Some(Ordering::Less));
        assert_eq!(compare_versions("2.0.0", "2.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("v1.2", "1.2"), Some(Ordering::Equal), "前导 v 不算差异");
        assert_eq!(compare_versions("1.2", "1.2.1"), Some(Ordering::Less), "段多的更大");
        assert_eq!(compare_versions("1.2.0-beta", "1.2.0"), Some(Ordering::Greater));
        assert_eq!(
            compare_versions("1.0", "1.0a"),
            Some(Ordering::Less),
            "数字段小于文字段"
        );
    }

    /// ★ 比不出来就**说比不出来**（不许猜"新的那个就是新版"）
    #[test]
    fn incomparable_versions_return_none() {
        assert_eq!(compare_versions("最终版", "1.0"), None);
        assert_eq!(compare_versions("??", "1.0"), None);
        assert_eq!(compare_versions("", "1.0"), None);
    }

    /* ---------------- 结论 ---------------- */

    #[test]
    fn same_version_is_up_to_date() {
        let rec = record("3.2.1", vec![file("mods/a.jar", "aa", 3)]);
        let v = verdict_for(Some(&rec), &[remote("v-new", "3.2.1")]);
        assert!(matches!(v, UpdateVerdict::UpToDate { .. }), "{v:?}");
        assert!(v.upgrade_target().is_none(), "已是最新就不该给升级入口");
        assert!(v.summary().contains("已是最新"), "{}", v.summary());
    }

    #[test]
    fn higher_remote_version_is_newer() {
        let rec = record("3.2.1", vec![]);
        let v = verdict_for(Some(&rec), &[remote("v330", "3.3.0")]);
        match &v {
            UpdateVerdict::Newer { version, version_id, .. } => {
                assert_eq!(version, "3.3.0");
                assert_eq!(version_id, "v330");
            }
            other => panic!("该判「有新版」：{other:?}"),
        }
        assert_eq!(v.upgrade_target(), Some("v330"));
        assert!(v.summary().contains("3.3.0") && v.summary().contains("3.2.1"), "{}", v.summary());
    }

    /// ★ 本地比线上新 ⇒ **不降级**（作者撤过版本时就是这样）
    #[test]
    fn local_ahead_is_not_downgraded() {
        let rec = record("3.4.0", vec![]);
        let v = verdict_for(Some(&rec), &[remote("v330", "3.3.0")]);
        assert!(matches!(v, UpdateVerdict::LocalAhead { .. }), "{v:?}");
        assert!(v.upgrade_target().is_none(), "不许给「降级」入口");
        assert!(v.summary().contains("不动它"), "{}", v.summary());
    }

    /// ★ 比不出来 ⇒ 两边都报出来（用户可以自己决定升不升）
    #[test]
    fn incomparable_remote_is_reported_side_by_side() {
        let rec = record("正式版", vec![]);
        let v = verdict_for(Some(&rec), &[remote("v999", "vNext")]);
        match &v {
            UpdateVerdict::Different { ours, theirs, .. } => {
                assert_eq!(ours, "正式版");
                assert_eq!(theirs, "vNext");
            }
            other => panic!("该判「比不出来」：{other:?}"),
        }
        assert!(v.summary().contains("看不出来"), "{}", v.summary());
        assert_eq!(v.upgrade_target(), Some("v999"), "比不出来时也要让用户能自己升");
    }

    /// 平台上没有这个包 / 清单是空的 ⇒ Unknown，**不是**"已是最新"
    #[test]
    fn empty_remote_list_is_unknown_not_latest() {
        let rec = record("1.0.0", vec![]);
        let v = verdict_for(Some(&rec), &[]);
        assert!(matches!(v, UpdateVerdict::Unknown { .. }), "{v:?}");
        assert!(!v.summary().contains("已是最新"), "空清单不许说「已是最新」：{}", v.summary());
    }

    /// 没有记录（不是整合包实例）⇒ Unknown 且说得出为什么
    #[test]
    fn no_record_is_unknown() {
        let v = verdict_for(None, &[remote("v1", "1.0")]);
        assert!(matches!(v, UpdateVerdict::Unknown { .. }), "{v:?}");
        assert!(v.summary().contains("不是从整合包装"), "{}", v.summary());
    }

    /// ★★ 作者发的新版**换了 MC 版本** ⇒ 说清楚，但**不给原地升级入口**
    ///    （那会连存档与世界格式一起换掉 —— ADR-018 对单个 Mod 就是这么要求的）
    #[test]
    fn cross_mc_newer_is_reported_without_upgrade_button() {
        let rec = record("3.2.1", vec![]);
        let v = verdict_for(Some(&rec), &[remote_other_mc("v400", "4.0.0", "1.21.1")]);
        match &v {
            UpdateVerdict::NewerMc { version, mc_version, .. } => {
                assert_eq!(version, "4.0.0");
                assert_eq!(mc_version, "1.21.1");
            }
            other => panic!("该判「换了 MC 版本」：{other:?}"),
        }
        assert!(
            v.upgrade_target().is_none(),
            "跨 MC 版本不许给原地升级入口：{:?}",
            v.upgrade_target()
        );
        assert!(v.summary().contains("新建一个实例"), "{}", v.summary());
    }

    /// ★ 同一 MC 版本有更新的、同时另一堆还有更新的 ⇒ **仍按同 MC 的判**
    ///   （原地升是能做到的那件事，先说它）
    #[test]
    fn same_mc_newer_wins_over_cross_mc() {
        let rec = record("3.2.1", vec![]);
        let v = verdict_for(
            Some(&rec),
            &[
                remote("v330", "3.3.0"),
                remote_other_mc("v400", "4.0.0", "1.21.1"),
            ],
        );
        assert_eq!(v.upgrade_target(), Some("v330"), "{v:?}");
    }

    /* ---------------- 文件对齐 ---------------- */

    /// 新增 / 更新 / 移除 / 不动 四类要分得清
    #[test]
    fn plan_splits_add_replace_remove_keep() {
        let old = vec![
            file("mods/不变.jar", "aa", 10),
            file("mods/要换.jar", "bb", 20),
            file("mods/包不要了.jar", "cc", 30),
        ];
        let new = vec![
            file("mods/不变.jar", "aa", 10),
            file("mods/要换.jar", "dd", 21),
            file("mods/新加的.jar", "ee", 40),
        ];
        let p = plan_update(&old, &new);
        assert_eq!(p.keep, vec!["mods/不变.jar"]);
        assert_eq!(p.replace, vec!["mods/要换.jar"]);
        assert_eq!(p.remove, vec!["mods/包不要了.jar"]);
        assert_eq!(p.add, vec!["mods/新加的.jar"]);
        assert!(!p.is_noop());
        assert!(p.summary().contains("新增 1 个、更新 1 个、移除 1 个"), "{}", p.summary());
    }

    /// ★ 用户自己丢进 `mods/` 的文件**不在记录里 ⇒ 永远不会被 remove**
    #[test]
    fn files_outside_the_record_are_never_removed() {
        let old = vec![file("mods/包里的.jar", "aa", 10)];
        let new: Vec<PackFile> = vec![];
        let p = plan_update(&old, &new);
        assert_eq!(p.remove, vec!["mods/包里的.jar"]);
        // 用户自己那个文件压根没进过 old ⇒ 计划里连提都不该提
        assert!(!p.remove.iter().any(|x| x.contains("用户自己")));
        assert_eq!(p.add.len(), 0);
    }

    /// sha1 都没有时退回**比大小**；两样都没有就当作"不动"
    #[test]
    fn falls_back_to_size_then_to_nothing() {
        let old = vec![file("mods/只有大小.jar", "", 10), file("mods/啥都没有.jar", "", 0)];
        let new = vec![file("mods/只有大小.jar", "", 11), file("mods/啥都没有.jar", "", 0)];
        let p = plan_update(&old, &new);
        assert_eq!(p.replace, vec!["mods/只有大小.jar"], "大小变了要重下");
        assert_eq!(p.keep, vec!["mods/啥都没有.jar"], "没可比信息就不动它");
    }

    /// 清单没变 ⇒ noop（界面据此说"不用动"，而不是让用户白等一次下载）
    #[test]
    fn identical_lists_are_a_noop() {
        let files = vec![file("mods/a.jar", "aa", 10), file("config/x.toml", "bb", 2)];
        let p = plan_update(&files, &files);
        assert!(p.is_noop());
        assert_eq!(p.keep.len(), 2);
        assert!(p.summary().contains("不用动"), "{}", p.summary());
    }
}
