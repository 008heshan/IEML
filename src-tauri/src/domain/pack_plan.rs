//! **整合包要装哪些文件、哪些没装上**（纯逻辑，无 `crate::` 依赖）。
//!
//! ## 这个模块存在的理由（一个真实事故）
//!
//! 2026-10-16 真机：`Better MC [FABRIC] - BMC2` 装完之后进游戏，整合包**自带的**
//! 「Missing Mods」窗口弹出，点名 `Balm` / `FallingTree` / `FTB Teams` /
//! `Fabrication` / `Paintings ++` —— 而启动器这边**报了安装完成**。
//!
//! 盘上查证：`mods/` 里 333 个 jar，这 5 个确实不在；
//! 实例目录 `.ieml/` 里只有 `natives/` 与 `instance.json`，**没有任何清单**，
//! 所以事后连"这个包本来该装什么"都查不出来，更谈不上只重下缺的那几个。
//!
//! 根因不在下载器（它有重试、有失败清单），而在**解析地址**那一段：
//! CurseForge 整合包的每个文件都要先问一次接口换下载地址，而接口查不到时
//! 那个条目**从计划里彻底消失**，只剩一句日志，于是：
//!
//! ```text
//!   清单 338 项 → 解析失败 5 项（只留下一个计数）→ 任务 333 项
//!   → 下载 333 项全部成功 → 收尾校验：333 个文件都在 ✔ → 「安装完成」
//!   → 游戏里弹「Missing Mods」（包自己说的话才是真话）
//! ```
//!
//! ⇒ 本模块把"**该装哪些**"与"**哪些没装上**"变成两个**显式**的清单：
//!   · [`PackPlanManifest`] 落盘到 `<实例>/.ieml/pack-files.json`
//!     （每一条带路径、地址、校验值、以及 CurseForge 的 `project_id` / `file_id`
//!      —— 有了后两个，缺的那几个**以后能重新解析地址再下**，
//!      不必依赖当初那个 `.mrpack` 或整合包 zip 还在盘上）；
//!   · [`MissingFile`] 一路回传到界面（`ModpackInstallResult.missing_files`），
//!     于是"有 N 个 mod 没下下来"是**看得见**的，而不是等游戏弹窗来告诉我们。
//!
//! ## 为什么放在 `domain/`
//!
//!   "该装哪些 / 缺哪些"是**判定**，不是 I/O：给它一份"清单条目 + 解析结果"，
//!   它就该能算出结论。所有网络与落盘都在调用方（`commands_real`）。
//!   于是这一整套规则可以用真清单喂单测。
//!
//! ## 与 `pack_record` 的分工
//!
//!   * `pack_record`（`<实例>/.ieml/pack-record.json`）—— **记哪些文件要落盘**，
//!     "检查整合包完整性 / 补齐"用它。它只装得下**有下载地址**的条目。
//!   * `pack_plan`（`<实例>/.ieml/pack-files.json`）—— **记这一次的完整清单**，
//!     包括那些"地址还没解析出来"的条目（那正是最需要被记下来的那一类）。
//!
//!   两份都要留：前者是"补齐"的输入，后者是"当时发生了什么"的证据。

/// 计划里的一条文件。
///
/// 字段口径与 [`crate::domain::pack_record::PackFile`] 对齐（`path` 是
/// **相对游戏目录**的路径），但多两个 CurseForge 的身份字段 —— 见模块说明。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PackPlanFile {
    /// **相对游戏目录**的路径（`mods/xxx.jar`）
    pub path: String,
    /// 下载地址。**空串 = 这一次没解析出来**（CurseForge 的作者禁止第三方下载、
    /// 或接口查不到这个文件）—— 空串是"如实说不知道"，不是"没有地址"。
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha1: String,
    /// 期望大小（0 = 未知）
    #[serde(default)]
    pub size: u64,
    /// CurseForge 项目 id（拖进来的 `.mrpack` 给不出 ⇒ 0）
    #[serde(default)]
    pub project_id: u32,
    /// CurseForge 文件 id（同上 ⇒ 0）
    #[serde(default)]
    pub file_id: u32,
    /// **这一次为什么没弄到手**（只对没地址的条目有意义）。
    ///
    /// ★ 与 [`MissingFile::reason`] 分开存：这里是解析那一刻的**上游原话**，
    ///   由调用方填（它才知道是超时、404 还是作者禁止分发）。
    ///   把它留在条目本身上，"哪个条目因为什么原因失败"就不必事后去猜
    ///   （曾经靠"路径里有没有 `cf-<id>.jar`"去反查，那是会猜错的量法）。
    #[serde(default)]
    pub reason: String,
}

impl PackPlanFile {
    /// 只填路径与地址（拖进来的 `.mrpack` 走这条：清单里没有 CF 身份）
    pub fn new(path: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            url: url.into(),
            sha1: String::new(),
            size: 0,
            project_id: 0,
            file_id: 0,
            reason: String::new(),
        }
    }

    /// 这一次**能不能拿到下载地址**。
    ///
    /// ★ 空地址不是"不用下"：它意味着"该下、但地址没解析出来" ——
    ///   正是事故里那 5 个 mod 的形状。
    pub fn has_url(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// 有没有 CurseForge 身份（有 ⇒ 以后能重新解析地址再下）
    pub fn has_curseforge_identity(&self) -> bool {
        self.project_id != 0 && self.file_id != 0
    }
}

/// 解析阶段一条**没解析出下载地址**的条目。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MissingFile {
    /// 相对游戏目录的目标路径（CF 的文件名就是最终落盘的 jar 名）
    pub path: String,
    /// 给用户看的名字（通常是 jar 文件名；没有名字时退回 `CF 文件 <id>`）
    pub name: String,
    /// **为什么**没解析出来 —— 必须带回去，否则又变回"只有计数没有原因"
    pub reason: String,
    /// 还能再试吗（有 CF 身份 ⇒ 能；没有地址又没身份的 ⇒ 只能人工去网站下）
    #[serde(default)]
    pub retryable: bool,
}

/// 这一次安装的**完整**清单（落盘成 `<实例>/.ieml/pack-files.json`）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackPlanManifest {
    /// 结构版本（以后改形状时用它区分）
    pub schema: u32,
    /// 写这份清单的时刻（Unix 秒）
    pub written_at: u64,
    /// 包名 / 版本（照抄安装记录的口径，方便对账）
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// `modrinth` / `curseforge` / `local`
    #[serde(default)]
    pub source: String,
    /// 清单里**一共**要装几个（含没解析出地址的那些）
    pub total: usize,
    /// 这一次没解析出地址的条目 —— 逐条带原因
    #[serde(default)]
    pub missing: Vec<MissingFile>,
    /// 全部条目（含缺失的），每条带地址与 CF 身份
    pub files: Vec<PackPlanFile>,
}

impl PackPlanManifest {
    /// 落盘路径：`<实例>/.ieml/pack-files.json`。
    ///
    /// ★ 与 `pack-record.json` 同一个目录（启动器自己的那份），
    ///   于是它**从结构上**进不了整合包导出（那棵树只走游戏目录）。
    pub fn path_for(instance_dir: &std::path::Path) -> std::path::PathBuf {
        instance_dir.join("pack-files.json")
    }

    /// 一句人话（界面直接用这个，不自己拼措辞 —— 措辞写两遍一定有一次不一致）
    pub fn summary(&self) -> String {
        if self.missing.is_empty() {
            return format!("整合包清单里的 {} 个文件这一次都拿到了下载地址", self.total);
        }
        let retryable = self.missing.iter().filter(|m| m.retryable).count();
        let manual = self.missing.len() - retryable;
        let mut s = format!("有 {} 个没下下来", self.missing.len());
        if retryable > 0 {
            s.push_str(&format!("（{retryable} 个可以重试）"));
        }
        if manual > 0 {
            s.push_str(&format!("（{manual} 个要自己去整合包网站下）"));
        }
        s
    }
}

/// 从"全部条目"算出缺失清单（**纯函数**）。
///
/// 判据只有一条：**没有下载地址**就是没下下来。空地址的三种来源要分清：
///   · CurseForge 接口查不到这个文件（网络 / 404 / 上游删了）；
///   · 作者禁止第三方分发（`downloadUrl` 是 null）；
///   · 清单给不出地址（`.mrpack` 的 `downloads` 是空数组）。
///
/// ★ 为什么**不**按"盘上有没有这个文件"判：那是 `pack_record::verify` 的活
///   （它要读盘、要算哈希）。这里判的是"我们有没有能力把它下下来" ——
///   在下载开始**之前**就该知道的事。
pub fn plan_missing(files: &[PackPlanFile]) -> Vec<MissingFile> {
    files
        .iter()
        .filter(|f| !f.has_url())
        .map(|f| MissingFile {
            path: f.path.clone(),
            name: file_label(&f.path),
            reason: if f.reason.trim().is_empty() {
                "没解析出下载地址（接口查不到这个文件，或作者不允许第三方下载）".to_string()
            } else {
                format!("没解析出下载地址（{}）", f.reason.trim())
            },
            retryable: f.has_curseforge_identity(),
        })
        .collect()
}

/// 一条条目的显示名（取路径最后一段；空路径时退回整条）
pub fn file_label(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    if last.is_empty() {
        path.trim().to_string()
    } else {
        last.to_string()
    }
}

/// 给界面的那一句（`ModpackInstallResult.missing_summary`）。
///
/// ★ 刻意与 [`PackPlanManifest::summary`] 分开：这一句说的是**这一次安装**的结果，
///   带上 3 个样例名字，用户一眼能认出"是哪些 mod"。
pub fn missing_summary(missing: &[MissingFile]) -> String {
    if missing.is_empty() {
        return String::new();
    }
    let sample: Vec<String> = missing.iter().take(3).map(|m| m.name.clone()).collect();
    let more = if missing.len() > sample.len() {
        format!(" 等 {} 个", missing.len())
    } else {
        String::new()
    };
    format!(
        "整合包有 {} 个文件没下下来：{}{}。可以点「重新下载缺失的」再试一次。",
        missing.len(),
        sample.join("、"),
        more
    )
}

/// 组装一份要落盘的清单（**纯拼装**）。
#[allow(clippy::too_many_arguments)]
pub fn build_manifest(
    name: &str,
    version: &str,
    source: &str,
    files: Vec<PackPlanFile>,
    now: u64,
) -> PackPlanManifest {
    let missing = plan_missing(&files);
    PackPlanManifest {
        schema: 1,
        written_at: now,
        name: name.to_string(),
        version: version.to_string(),
        source: source.to_string(),
        total: files.len(),
        missing,
        files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cf(path: &str, pid: u32, fid: u32) -> PackPlanFile {
        PackPlanFile {
            path: path.into(),
            url: format!("https://example.invalid/{fid}.jar"),
            sha1: "0".repeat(40),
            size: 1234,
            project_id: pid,
            file_id: fid,
            reason: String::new(),
        }
    }

    /// 一条"地址没解析出来"的条目（事故里那 5 个的形状）
    fn unresolved(path: &str, pid: u32, fid: u32, why: &str) -> PackPlanFile {
        PackPlanFile {
            path: path.into(),
            url: String::new(),
            sha1: String::new(),
            size: 0,
            project_id: pid,
            file_id: fid,
            reason: why.into(),
        }
    }

    /// ★★ 事故的形状：清单里 5 条解析失败 ⇒ 它们**必须**出现在缺失清单里，
    ///    而且带得出名字与原因（不是只有一个计数）。
    #[test]
    fn entries_without_a_url_are_missing_and_named() {
        let files = vec![
            cf("mods/ok.jar", 1, 11),
            unresolved(
                "mods/balm-fabric-7.2.1.jar",
                531761,
                4741360,
                "上游接口超时",
            ),
        ];
        let missing = plan_missing(&files);
        assert_eq!(missing.len(), 1, "只有没地址的那条算缺");
        assert_eq!(missing[0].name, "balm-fabric-7.2.1.jar");
        assert!(missing[0].retryable, "有 CF 身份 ⇒ 以后能重新解析地址再下");
        assert!(
            missing[0].reason.contains("上游接口超时"),
            "原因要带上游原话：{}",
            missing[0].reason
        );
    }

    /// 缺了**又没有 CF 身份**的（拖进来的 `.mrpack` 地址是空的）⇒ 不能重试。
    ///   ★ 这一条防的是"界面给出一个点了必然失败的按钮"。
    #[test]
    fn a_missing_entry_without_identity_is_not_retryable() {
        let files = vec![PackPlanFile::new("mods/x.jar", "")];
        let missing = plan_missing(&files);
        assert_eq!(missing.len(), 1);
        assert!(!missing[0].retryable);
    }

    /// 全都有地址 ⇒ 缺失清单为空、总结说的是"都拿到了地址"。
    #[test]
    fn a_full_plan_has_no_missing_entries() {
        let m = build_manifest(
            "测试包",
            "1.0.0",
            "curseforge",
            vec![cf("mods/a.jar", 1, 2), cf("mods/b.jar", 1, 3)],
            0,
        );
        assert!(m.missing.is_empty());
        assert_eq!(m.total, 2);
        assert_eq!(m.files.len(), 2, "全部条目都要留下（包括以后要复查的）");
        assert!(m.summary().contains("2 个文件"), "{}", m.summary());
    }

    /// ★★ **清单为空地址的那一条也要落盘**。
    ///   事故里"事后什么都查不到"的根因就是它当初没被写下来 ——
    ///   这条断言钉住"缺失的条目留在 files 里，不只是留在 missing 里"。
    #[test]
    fn the_manifest_keeps_the_entries_it_could_not_resolve() {
        let files = vec![
            cf("mods/ok.jar", 1, 2),
            PackPlanFile::new("mods/ftb-teams-fabric-1.20.1-11.1.6.jar", ""),
        ];
        let m = build_manifest("BMC2", "1.20.1", "curseforge", files, 42);
        assert_eq!(m.total, 2, "total 是清单里的全量，不是任务数");
        assert_eq!(m.missing.len(), 1);
        assert_eq!(m.files.len(), 2);
        assert!(m.files.iter().any(|f| f.path.contains("ftb-teams")));
        assert!(m.files.iter().any(|f| f.project_id == 1 && f.file_id == 2));
    }

    /// 总结要分类说清"几个能重试、几个要人工下"（混成一句会把用户引到死路上）。
    #[test]
    fn the_summary_separates_retryable_from_manual() {
        let files = vec![
            unresolved("mods/a.jar", 7, 9, "超时"),
            PackPlanFile::new("mods/b.jar", ""),
        ];
        let m = build_manifest("p", "v", "curseforge", files, 0);
        let s = m.summary();
        assert!(s.contains("2 个没下下来"), "{s}");
        assert!(s.contains("1 个可以重试"), "{s}");
        assert!(s.contains("1 个要自己去整合包网站下"), "{s}");
    }

    /// 给界面的那句话要**点名**（最多 3 个 + "等 N 个"），空清单时是空串
    ///   —— 界面据此决定"要不要显示这一条"，不该显示一句空话。
    #[test]
    fn the_ui_line_names_three_at_most_and_is_empty_when_complete() {
        assert_eq!(missing_summary(&[]), "");
        let one = vec![MissingFile {
            path: "mods/balm.jar".into(),
            name: "balm.jar".into(),
            reason: "r".into(),
            retryable: true,
        }];
        assert!(missing_summary(&one).contains("balm.jar"));
        let many: Vec<MissingFile> = (0..5)
            .map(|i| MissingFile {
                path: format!("mods/m{i}.jar"),
                name: format!("m{i}.jar"),
                reason: "r".into(),
                retryable: true,
            })
            .collect();
        let s = missing_summary(&many);
        assert!(s.contains("5 个文件没下下来"), "{s}");
        assert!(s.contains("等 5 个"), "超过 3 个要如实说总数：{s}");
        assert!(!s.contains("m3.jar"), "只点名前 3 个：{s}");
    }

    /// 落盘路径：`<实例>/.ieml/pack-files.json`（与 `pack-record.json` 同处，
    /// 于是"记录在实例目录里"这条结构保证对它同样成立）。
    #[test]
    fn the_manifest_lives_beside_the_record() {
        let inst = std::path::PathBuf::from("/tmp/x/instances/foo/.ieml");
        let p = PackPlanManifest::path_for(&inst);
        assert_eq!(p, inst.join("pack-files.json"));
    }

    /// 显示名：取最后一段（Windows 反斜杠也要认），空路径退回整条、不 panic。
    #[test]
    fn labels_take_the_last_segment() {
        assert_eq!(file_label("mods/a.jar"), "a.jar");
        assert_eq!(file_label("mods\\a.jar"), "a.jar");
        assert_eq!(file_label(""), "");
    }

    /// 往返：落盘的 JSON 读回来必须一致（以后"只重下缺的那几个"全靠它）。
    #[test]
    fn the_manifest_round_trips() {
        let m = build_manifest("p", "v", "curseforge", vec![cf("mods/a.jar", 3, 4)], 7);
        let text = serde_json::to_string(&m).unwrap();
        let back: PackPlanManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(back.total, 1);
        assert_eq!(back.files[0].project_id, 3);
        assert_eq!(back.written_at, 7);
    }

    /// 老清单（以后加了字段）读回来不许崩：`#[serde(default)]` 那几项缺了也有默认值。
    #[test]
    fn a_manifest_without_optional_fields_still_loads() {
        let old = r#"{"schema":1,"written_at":0,"total":1,"files":[{"path":"mods/a.jar"}]}"#;
        let m: PackPlanManifest = serde_json::from_str(old).expect("缺字段也要读得回来");
        assert_eq!(m.files.len(), 1);
        assert!(!m.files[0].has_url());
        assert_eq!(m.source, "");
        assert!(m.missing.is_empty(), "missing 是当时的结论，不从 files 反推");
    }
}
