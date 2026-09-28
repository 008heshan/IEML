//! **这个实例是不是从整合包装出来的、装全了没有**（ADR-025 的 Completion 阶段）。
//!
//! ## 为什么需要它
//!
//!   装整合包是一件"下几百个文件"的事。中间断网、某个 Mod 的地址失效、
//!   用户手滑关了启动器 —— 实例看起来都**装好了**（目录在、能启动），
//!   少的那几个 Mod 要等进了游戏才发现（或者干脆崩在加载器上）。
//!
//!   ADR-025 的 Completion 阶段就是补这一层：
//!
//! ```text
//!   ① Install 阶段 —— 按 manifest 下载并安装所有文件
//!   ② Completion 阶段 —— 校验完整性 + 补齐缺失 + 修正元数据 + 留下记录
//! ```
//!
//! ## 记录放在**实例目录**，不放在游戏目录
//!
//!   `<instances>/<slug>/pack-record.json`。
//!
//!   ★ 为什么不放游戏目录里：那条路正是 ADR-024 的导出**会走**的路 ——
//!     放进去就得靠黑名单去挡（而黑名单是"排除表"，多一条就多一个漏的机会）。
//!     放在实例目录里，它**根本不在导出的树里**，从结构上就不可能被打进整合包。
//!     （ADR-024 的黑名单里那条 `pack.json` 是 HMCL 落在**游戏目录**里的文件，两者不是一回事。）
//!
//! ## 记录里存什么
//!
//!   每个文件的**相对路径 + 下载地址 + sha1 + 大小**，于是"补齐"不必依赖
//!   当初那个整合包文件还在 —— 用户把 `.mrpack` 删了也照样能补。
//!
//! ## 这个模块只做**判定**（能不能算"装全了"），不做下载
//!
//!   下载在命令层（它要拿网络、要报进度）。这里只回答"盘上对不对"，
//!   于是每条规则都能用临时目录喂真文件单测。

use std::path::{Path, PathBuf};

/// 记录里的一个文件
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PackFile {
    /// **相对游戏目录**的路径（`mods/xxx.jar`），与 ADR-024 的路径口径一致
    pub path: String,
    /// 下载地址（可能为空：包自己带的 overrides 文件没有地址）
    #[serde(default)]
    pub url: String,
    /// 期望 SHA1（空串 = 不校验）
    #[serde(default)]
    pub sha1: String,
    /// 期望大小（0 = 未知）
    #[serde(default)]
    pub size: u64,
}

/// 整合包安装记录（`<实例>/pack-record.json`）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackRecord {
    /// 记录格式版本（以后改结构时用它区分）
    pub schema: u32,
    pub name: String,
    pub version: String,
    /// `modrinth` / `curseforge` / `local`
    pub source: String,
    pub mc_version: String,
    #[serde(default)]
    pub loader_kind: Option<String>,
    #[serde(default)]
    pub loader_version: Option<String>,
    /// 装完的时刻（Unix 秒）
    pub installed_at: u64,
    /// 清单里指向游戏目录之外、或下不了的条目（安装时如实记下）
    #[serde(default)]
    pub skipped: Vec<String>,
    pub files: Vec<PackFile>,
}

impl PackRecord {
    /// 记录文件的路径（**实例目录**下，见模块说明）
    pub fn path_for(instance_dir: &Path) -> PathBuf {
        instance_dir.join("pack-record.json")
    }

    /// 校验：清单里的文件在不在、大小对不对
    ///
    /// * `game_dir`：这个实例**实际使用**的游戏目录（隔离与否由 `game_dir_of` 决定）
    /// * `check_hashes`：要不要算 SHA1（整合包动辄几百 MB，默认不算；
    ///   用户点"检查完整性"时才值得花那个时间）
    pub fn verify(&self, game_dir: &Path, check_hashes: bool) -> VerifyReport {
        let mut present = 0u64;
        let mut missing: Vec<String> = Vec::new();
        let mut wrong_size: Vec<String> = Vec::new();
        let mut wrong_hash: Vec<String> = Vec::new();
        let mut no_source: Vec<String> = Vec::new();

        for f in &self.files {
            let abs = game_dir.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let meta = std::fs::metadata(&abs);
            let Ok(meta) = meta else {
                missing.push(f.path.clone());
                // ★ 缺了**而且没有地址**：补齐也补不了，必须单独说（"给不出办法的报错"最讨嫌）
                if f.url.is_empty() {
                    no_source.push(f.path.clone());
                }
                continue;
            };
            if f.size > 0 && meta.len() != f.size {
                wrong_size.push(format!("{}（盘上 {} 字节，清单里 {} 字节）", f.path, meta.len(), f.size));
                continue;
            }
            if check_hashes && !f.sha1.is_empty() {
                match sha1_of(&abs) {
                    Ok(got) if got.eq_ignore_ascii_case(&f.sha1) => {}
                    Ok(got) => {
                        wrong_hash.push(format!("{}（盘上 {}，清单里 {}）", f.path, &got[..8.min(got.len())], &f.sha1[..8.min(f.sha1.len())]));
                        continue;
                    }
                    Err(e) => {
                        wrong_hash.push(format!("{}（读不了：{e}）", f.path));
                        continue;
                    }
                }
            }
            present += 1;
        }

        let complete = missing.is_empty() && wrong_size.is_empty() && wrong_hash.is_empty();
        let summary = {
            if complete {
                format!("整合包的 {} 个文件都在（{} 个校验通过）", self.files.len(), present)
            } else {
                let mut parts = Vec::new();
                if !missing.is_empty() {
                    parts.push(format!("缺 {} 个", missing.len()));
                }
                if !wrong_size.is_empty() {
                    parts.push(format!("大小不对 {} 个", wrong_size.len()));
                }
                if !wrong_hash.is_empty() {
                    parts.push(format!("内容不对 {} 个", wrong_hash.len()));
                }
                if !no_source.is_empty() {
                    parts.push(format!("其中 {} 个清单里没给下载地址（补不了）", no_source.len()));
                }
                format!(
                    "{} / {} 个文件在盘上，{}",
                    present,
                    self.files.len(),
                    parts.join("、")
                )
            }
        };
        VerifyReport {
            total: self.files.len() as u64,
            present,
            missing,
            wrong_size,
            wrong_hash,
            no_source,
            skipped_at_install: self.skipped.clone(),
            complete,
            summary,
        }
    }
}

/// 校验结果（界面据此说人话）
///
/// ★ `complete` / `summary` 是**算好一起带出去**的字段，不是只留在 Rust 侧的方法：
///   界面要说的那句话必须**与这里同一份**（措辞写两遍就一定会有一次不一致）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct VerifyReport {
    pub total: u64,
    pub present: u64,
    /// 盘上没有的（相对路径）
    pub missing: Vec<String>,
    /// 大小对不上的（带两边的大小）
    pub wrong_size: Vec<String>,
    /// SHA1 对不上的（只在要求校验时才有）
    pub wrong_hash: Vec<String>,
    /// 缺失**且**清单里没给下载地址的 —— 这些补不了，要如实说
    pub no_source: Vec<String>,
    /// 安装当时就跳过的条目（那时就说了原因）
    pub skipped_at_install: Vec<String>,
    /// 装全了吗
    pub complete: bool,
    /// 一句人话（界面直接用这个，不自己拼）
    pub summary: String,
}

impl VerifyReport {
    /// 需要重新下载的（有地址的那些缺失文件）
    pub fn repairable(&self) -> Vec<String> {
        self.missing
            .iter()
            .filter(|p| !self.no_source.contains(p))
            .cloned()
            .collect()
    }
}

/// 算一个文件的 SHA1（与下载校验用的是同一个算法）
fn sha1_of(path: &Path) -> Result<String, String> {
    use sha1::{Digest, Sha1};
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut h = Sha1::new();
    h.update(&data);
    Ok(format!("{:x}", h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ieml-packrec-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn rec(files: Vec<PackFile>) -> PackRecord {
        PackRecord {
            schema: 1,
            name: "测试包".into(),
            version: "1.0.0".into(),
            source: "modrinth".into(),
            mc_version: "1.20.1".into(),
            loader_kind: Some("fabric".into()),
            loader_version: Some("0.15.0".into()),
            installed_at: 0,
            skipped: vec![],
            files,
        }
    }

    fn file(path: &str, size: u64) -> PackFile {
        PackFile {
            path: path.into(),
            url: format!("https://example.invalid/{}", path.replace('/', "_")),
            sha1: String::new(),
            size,
        }
    }

    /// 都在 → 完整；报告要说得出"几个校验通过"
    #[test]
    fn a_complete_install_is_reported_as_complete() {
        let d = tmp("ok");
        std::fs::create_dir_all(d.join("mods")).unwrap();
        std::fs::create_dir_all(d.join("config")).unwrap();
        std::fs::write(d.join("mods/a.jar"), b"AAA").unwrap();
        std::fs::write(d.join("config/x.toml"), b"xx").unwrap();
        let r = rec(vec![file("mods/a.jar", 3), file("config/x.toml", 2)]).verify(&d, false);
        assert!(r.complete);
        assert_eq!(r.present, 2);
        assert!(r.summary.contains("都在"), "{}", r.summary);
    }

    /// 缺文件 → 报缺，**并且能说出哪些补不了**（清单里没给地址的）
    #[test]
    fn missing_files_are_listed_and_unsourced_ones_are_called_out() {
        let d = tmp("missing");
        std::fs::create_dir_all(d.join("mods")).unwrap();
        std::fs::write(d.join("mods/here.jar"), b"AAA").unwrap();
        let mut no_url = file("mods/gone.jar", 3);
        no_url.url = String::new(); // 包自己带的 overrides，没有地址
        let r = rec(vec![file("mods/here.jar", 3), no_url, file("mods/also-gone.jar", 1)])
            .verify(&d, false);

        assert!(!r.complete);
        assert_eq!(r.missing.len(), 2);
        assert_eq!(r.no_source, vec!["mods/gone.jar"], "没地址的要单独列出来");
        // ★ "能补的"只包含有地址的那些 —— 拿没地址的去重下必然又是一次失败
        assert_eq!(r.repairable(), vec!["mods/also-gone.jar"]);
        let s = r.summary;
        assert!(s.contains("缺 2 个"), "{s}");
        assert!(s.contains("补不了"), "{s}");
    }

    /// 大小对不上 → 与"缺失"分开报（一个是没下到、一个是下坏了）
    #[test]
    fn a_size_mismatch_is_not_reported_as_missing() {
        let d = tmp("size");
        std::fs::create_dir_all(d.join("mods")).unwrap();
        std::fs::write(d.join("mods/a.jar"), b"AA").unwrap(); // 盘上 2 字节，清单说 3
        let r = rec(vec![file("mods/a.jar", 3)]).verify(&d, false);
        assert!(r.missing.is_empty(), "文件在盘上，不该算缺失");
        assert_eq!(r.wrong_size.len(), 1);
        assert!(r.wrong_size[0].contains("2 字节"), "{:?}", r.wrong_size);
        assert!(!r.complete);
    }

    /// 要求校验哈希时才读内容算 SHA1；对不上要报出来
    #[test]
    fn hashes_are_only_checked_when_asked() {
        let d = tmp("hash");
        std::fs::create_dir_all(d.join("mods")).unwrap();
        std::fs::write(d.join("mods/a.jar"), b"AAA").unwrap();
        // "AAA" 的 sha1
        let good = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(b"AAA");
            format!("{:x}", h.finalize())
        };
        let mut f = file("mods/a.jar", 3);
        f.sha1 = good.clone();

        assert!(rec(vec![f.clone()]).verify(&d, true).complete, "哈希对得上");
        assert!(rec(vec![f.clone()]).verify(&d, false).complete, "不算哈希时也应当完整");

        let mut bad = f;
        bad.sha1 = "0".repeat(40);
        let r = rec(vec![bad]).verify(&d, true);
        assert_eq!(r.wrong_hash.len(), 1);
        assert!(!r.complete);
    }

    /// 空清单：完整（"什么都没要装"就是装全了）—— 但不能说成"校验通过 N 个"
    #[test]
    fn an_empty_manifest_is_complete() {
        let d = tmp("empty");
        let r = rec(vec![]).verify(&d, true);
        assert!(r.complete);
        assert_eq!(r.total, 0);
    }

    /// 记录文件落在**实例目录**（不是游戏目录）—— 这一条是 ADR-024 导出的结构保证
    #[test]
    fn the_record_lives_outside_the_game_dir() {
        let inst = PathBuf::from("/tmp/x/instances/foo");
        let p = PackRecord::path_for(&inst);
        assert_eq!(p, inst.join("pack-record.json"));
        assert!(
            !p.starts_with(inst.join("game")),
            "记录不能落在游戏目录里 —— 那正是导出会走的那棵树"
        );
    }

    /// 记录能存能读（补齐全靠它，读不回来就等于没有）
    #[test]
    fn the_record_round_trips() {
        let r = rec(vec![file("mods/a.jar", 3)]);
        let text = serde_json::to_string(&r).unwrap();
        let back: PackRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back.name, "测试包");
        assert_eq!(back.files.len(), 1);
        assert_eq!(back.files[0].path, "mods/a.jar");
    }
}
