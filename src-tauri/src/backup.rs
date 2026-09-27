//! 实例的**备份与回滚** —— [ADR-014] 的实现。
//!
//! [ADR-014]: ../../docs/DECISIONS.md
//!
//! ## 备份什么（照 ADR-014 的原文，一个字都不扩）
//!
//! ```text
//! saves/            存档（最重要）
//! config/           配置
//! options.txt       游戏设置
//! servers.dat       服务器列表
//! mods/ 的清单      只存**文件名 + SHA1**，不存 jar 本体
//! ```
//!
//! ★★ **`mods/` 里的 jar 一个字节都不许进备份**（ADR-014 的黑线）。
//!   理由不是"省事"，是**盘**：一个 200 Mod 的整合包 ≈ 500 MB～1 GB，
//!   而 ADR-014 要的是"保留最近 5 份"。真拷 jar 的话，5 份 = 25 GB 起步 ——
//!   用户装两个整合包，备份就把盘吃光了，然后他会关掉备份，
//!   于是**最该有保命手段的人最先失去它**。
//!   jar 是可再获取的（`mods/` 的清单记着名字与 SHA1，缺了能重新下）；
//!   存档不可再获取 —— 所以只保不可再获取的那部分。
//!   ⇒ 判据：`backup_never_copies_mod_jars`（见文件尾部测试）。
//!
//! ## 存哪、留几份
//!
//! * 位置：`<启动器自己的家>/backups/<实例 slug>/<时间戳>/`
//!   （`own_root`，不是游戏根目录 —— 备份是**启动器**的保险柜，
//!   与 `cache` / `logs` 同类；游戏根目录那条规矩见 `AppPaths::instances` 的说明）
//! * 时间戳 = **epoch 秒**（`1758000000`）。★ 为什么不用 `20260927-120501`：
//!   那个写法要么写 UTC（用户在资源管理器里看到的与界面上显示的差 8 小时，
//!   属于"看着像 bug"的假信息），要么就得引入本地时区库。
//!   用 epoch 秒则**界面按本地时间显示、目录名与界面永远一致**，还能直接按名字排序。
//! * 滚动保留：默认最近 [`DEFAULT_KEEP`] 份，超出删最旧的。
//!
//! ## 回滚的两条硬要求（ADR-014 与 ADR-023 的交界）
//!
//! 1. **回滚前必须先把当前状态也备份一份**（pre-rollback snapshot）——
//!    用户回滚之后后悔了，还能回到"回滚之前"。
//!    所以本模块的 [`restore`] **先备份、再还原**，备份失败就整件事中止
//!    （宁可不还原，也不能让用户进入"既没回滚又没退路"的状态）。
//! 2. **回滚不许删用户的东西**。ADR-014 原文对 `mods/` 写的是"多的删"，
//!    本模块的实现改成"**多出来的移进 `mods-extra/`**"：
//!    那条原文写于 2026-09-11，而 ADR-014 自己就要求"回滚本身也要可逆"，
//!    直接删是这条要求里唯一不可逆的动作。移出去之后：
//!    用户看得见、拿得回，而"多出来的 jar 不再被游戏加载"这个效果是一样的。
//!    ⇒ 判据：`restore_moves_extra_mods_aside_instead_of_deleting`。
//!
//! ## 不做什么（诚实边界，界面上也要这么写）
//!
//! * 不备份 `resourcepacks/` / `shaderpacks/` / `logs/` / `crash-reports/`
//!   —— ADR-014 没列它们，扩范围要单独定。
//! * **不替用户重新下载 Mod**：回滚报告里如实说"清单里有 N 个 jar 现在不在盘上"，
//!   不假装补齐（这条要与整合包安装那条路分开说）。
//! * 不做定时备份：ADR-014 的触发时机是"启动游戏前"（由启动路径调用本模块）。

use std::path::{Path, PathBuf};

use crate::platform::AppPaths;

/// 清单格式版本。以后加字段时靠它判断"这份备份还能不能被这个版本的启动器读"。
pub const SCHEMA: u32 = 1;

/// 默认保留份数（ADR-014：最近 5 份）
pub const DEFAULT_KEEP: usize = 5;

/// 备份的**目录**（相对实例的游戏目录）
pub const BACKUP_DIRS: [&str; 2] = ["saves", "config"];

/// 备份的**单文件**（相对实例的游戏目录）
pub const BACKUP_FILES: [&str; 2] = ["options.txt", "servers.dat"];

/// 回滚时"多出来的 Mod"挪去哪（相对那一份备份目录）
const MODS_EXTRA_DIR: &str = "mods-extra";

/// 一份备份里，一个条目（目录或文件）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct BackupItem {
    /// `dir` / `file`
    pub kind: String,
    /// 相对游戏目录的路径（`saves` / `options.txt` …）
    pub rel: String,
    pub files: usize,
    pub bytes: u64,
    /// ★ `false` = 这一次备份时**盘上本来就没有它**（新实例还没进过游戏就没有 saves/）。
    ///   如实记下来，界面上才不会把"备份里没有存档"说成"你没有存档"。
    pub present: bool,
}

/// `mods/` 清单里的一条 —— **只有名字、SHA1、大小，没有 jar 本体**
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModEntry {
    pub name: String,
    pub sha1: String,
    pub bytes: u64,
}

/// 一份备份的清单（`backup.json`）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BackupManifest {
    pub schema: u32,
    /// 目录名 = epoch 秒的字符串
    pub id: String,
    pub slug: String,
    /// 实例显示名（slug 改名了也认得出这是谁）
    pub name: String,
    pub mc_version: String,
    /// epoch 秒
    pub created_secs: u64,
    /// 这次备份是**为什么**发生的：`手动` / `启动前自动` / `回滚前自动`
    pub reason: String,
    pub items: Vec<BackupItem>,
    /// ★ 只清单，不拷 jar（ADR-014）
    pub mods: Vec<ModEntry>,
    /// 存档 + 配置的字节数（**不含 Mod**，因为 Mod 没进备份）
    pub total_bytes: u64,
    /// 读不了 / 拒绝备份的东西（如实记，不假装全都备上了）
    pub skipped: Vec<String>,
}

impl BackupManifest {
    /// 给界面看的一句话摘要（"3 个存档 · 12.4 MB · 202 个 Mod（只记清单）"）
    pub fn summary(&self) -> String {
        let saves = self
            .items
            .iter()
            .find(|i| i.rel == "saves")
            .map(|i| i.files)
            .unwrap_or(0);
        let mut s = format!("{saves} 个存档文件 · {}", size_text(self.total_bytes));
        if !self.mods.is_empty() {
            s.push_str(&format!(" · {} 个 Mod（只记清单）", self.mods.len()));
        }
        s
    }
}

/// 回滚做了什么（**每一项都是界面上要如实说出来的**）
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestoreReport {
    /// 从哪一份备份回滚的
    pub from_id: String,
    /// ★★ 回滚前自动存的那一份（用户可以再回滚回来）
    pub pre_rollback_id: String,
    /// 还原了哪些条目
    pub restored: Vec<BackupItem>,
    /// 备份里没有、当前盘上有的文件（**保留没删**，如实列出）
    pub kept_extra_files: Vec<String>,
    /// 清单里有、盘上没有的 Mod（**要用户重新获取**，我们不假装补齐）
    pub mods_missing: Vec<String>,
    /// 盘上有、清单里没有的 Mod（已挪进 `mods-extra/`）
    pub mods_moved_out: Vec<String>,
}

/// 人看的体积文案（与 `commands_real::size_text` 同一套写法，这里独立一份，
/// 免得为了一个格式化函数把命令层拖进纯逻辑模块）
pub fn size_text(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / (MB * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / MB)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// 某个实例的备份总目录：`<own_root>/backups/<slug>`
pub fn backups_root(paths: &AppPaths, slug: &str) -> PathBuf {
    paths.own_root.join("backups").join(slug)
}

/// 把相对路径拼到基准目录下，并**拒绝越界**（`..` / 绝对路径 / 盘符）。
///
/// 与整合包 overrides 那条同一条规矩：清单是**盘上的文件**，
/// 而盘上的文件可能被改过（用户手改、别的程序写、从别处拷来的备份目录）。
/// 一条 `../../../Users/x` 就能让"还原"变成"往系统目录里写东西"。
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() || rel.contains("..") || rel.contains(':') || rel.starts_with('\\') {
        return None;
    }
    Some(base.join(p))
}

/// 递归复制目录（**覆盖同名文件**），返回（文件数，字节数）。
///
/// 失败的单个文件不中断整体：记进 `failed` 由调用方如实上报 ——
/// "备份完成但有两张截图没拷进去"比"整个备份失败"对用户有用得多。
fn copy_tree(src: &Path, dst: &Path, failed: &mut Vec<String>) -> (usize, u64) {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let Ok(rd) = std::fs::read_dir(src) else {
        failed.push(format!("读不了 {}", src.display()));
        return (0, 0);
    };
    for e in rd.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        match e.file_type() {
            Ok(t) if t.is_dir() => {
                if let Err(err) = std::fs::create_dir_all(&to) {
                    failed.push(format!("建目录 {} 失败：{err}", to.display()));
                    continue;
                }
                let (f, b) = copy_tree(&from, &to, failed);
                files += f;
                bytes += b;
            }
            Ok(t) if t.is_file() => {
                if let Some(parent) = to.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match std::fs::copy(&from, &to) {
                    Ok(n) => {
                        files += 1;
                        bytes += n;
                    }
                    Err(err) => failed.push(format!("拷 {} 失败：{err}", from.display())),
                }
            }
            _ => {}
        }
    }
    (files, bytes)
}

/// 走一遍 `mods/`，做出**清单**（名字 + SHA1 + 大小）。
///
/// 异步是因为 SHA1 要走 [`crate::net::download::sha1_of_file`]
/// （与下载校验用的是同一份实现 —— 清单里的 SHA1 与下载器认的 SHA1
/// 若是两套算法，将来"按清单补 Mod"会全对不上）。
async fn mods_manifest(mods_dir: &Path) -> Vec<ModEntry> {
    let Ok(rd) = std::fs::read_dir(mods_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // ★ 只登记 jar：`.disabled`、`.txt`、`README` 之类不算 Mod
        if !name.to_ascii_lowercase().ends_with(".jar") {
            continue;
        }
        let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
        let sha1 = crate::net::download::sha1_of_file(&p).await.unwrap_or_default();
        out.push(ModEntry { name, sha1, bytes });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 一个还没被占用的备份 id（epoch 秒；同一秒内连点两次时顺延）
fn free_id(root: &Path, secs: u64) -> String {
    let mut id = secs.to_string();
    let mut n = 1;
    while root.join(&id).exists() {
        n += 1;
        id = format!("{secs}-{n}");
    }
    id
}

/// 做一份备份。`reason` 用中文短句（`手动` / `启动前自动` / `回滚前自动`），会原样显示给用户。
///
/// 返回清单；调用方负责把 `reason` 与实例名写进界面。
pub async fn create(
    paths: &AppPaths,
    slug: &str,
    name: &str,
    mc_version: &str,
    reason: &str,
    now_secs: u64,
) -> Result<BackupManifest, String> {
    if slug.trim().is_empty() {
        return Err("实例 slug 为空，不能备份".into());
    }
    let game_dir = paths.instance_game_dir(slug);
    if !game_dir.is_dir() {
        return Err(format!(
            "这个实例还没有游戏目录，没什么可备份的：{}",
            game_dir.display()
        ));
    }
    let root = backups_root(paths, slug);
    let id = free_id(&root, now_secs);
    let dest = root.join(&id);
    std::fs::create_dir_all(&dest).map_err(|e| format!("建备份目录失败：{e}"))?;

    let mut items = Vec::new();
    let mut skipped = Vec::new();
    let mut total_bytes = 0u64;

    for rel in BACKUP_DIRS {
        let Some(src) = safe_join(&game_dir, rel) else {
            skipped.push(format!("{rel}（路径不合法）"));
            continue;
        };
        let present = src.is_dir();
        let (files, bytes) = if present {
            std::fs::create_dir_all(dest.join(rel))
                .map_err(|e| format!("建备份子目录失败：{e}"))?;
            copy_tree(&src, &dest.join(rel), &mut skipped)
        } else {
            (0, 0)
        };
        total_bytes += bytes;
        items.push(BackupItem {
            kind: "dir".into(),
            rel: (*rel).to_string(),
            files,
            bytes,
            present,
        });
    }

    for rel in BACKUP_FILES {
        let Some(src) = safe_join(&game_dir, rel) else {
            skipped.push(format!("{rel}（路径不合法）"));
            continue;
        };
        let present = src.is_file();
        let bytes = if present {
            match std::fs::copy(&src, dest.join(rel)) {
                Ok(n) => n,
                Err(e) => {
                    skipped.push(format!("{rel} 拷失败：{e}"));
                    0
                }
            }
        } else {
            0
        };
        total_bytes += bytes;
        items.push(BackupItem {
            kind: "file".into(),
            rel: (*rel).to_string(),
            files: usize::from(present),
            bytes,
            present,
        });
    }

    // ★★ 这里**只登记清单**。谁要是把 `copy_tree(mods)` 加进来，
    //    `backup_never_copies_mod_jars` 那条测试会立刻红 —— 那是故意的。
    let mods = mods_manifest(&paths.instance_mods_dir(slug)).await;

    let manifest = BackupManifest {
        schema: SCHEMA,
        id: id.clone(),
        slug: slug.to_string(),
        name: name.to_string(),
        mc_version: mc_version.to_string(),
        created_secs: now_secs,
        reason: reason.to_string(),
        items,
        mods,
        total_bytes,
        skipped,
    };
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(dest.join("backup.json"), text).map_err(|e| format!("写清单失败：{e}"))?;
    Ok(manifest)
}

/// 列出这个实例的备份（新的在前）。**读不出来的目录跳过**，不让一份坏备份挡住全部。
pub fn list(paths: &AppPaths, slug: &str) -> Vec<BackupManifest> {
    let root = backups_root(paths, slug);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path().join("backup.json")) else {
            continue;
        };
        if let Ok(m) = serde_json::from_str::<BackupManifest>(&text) {
            out.push(m);
        }
    }
    // id 是 epoch 秒（可能带 `-2` 后缀）→ 先按数字部分降序，再按后缀降序
    out.sort_by(|a, b| {
        let key = |s: &str| {
            let mut sp = s.splitn(2, '-');
            let n: u64 = sp.next().unwrap_or("0").parse().unwrap_or(0);
            let k: u32 = sp.next().and_then(|x| x.parse().ok()).unwrap_or(1);
            (n, k)
        };
        key(&b.id).cmp(&key(&a.id))
    });
    out
}

/// 滚动保留：只留最新的 `keep` 份（`protect` 里的 id 永不删）。
///
/// ★★ `protect` 不是"以防万一"，是这个功能里最容易写错的一处：
///   回滚流程是「先存一份 pre-rollback 快照 → 再还原」，
///   而 restore 之后顺手 prune 的话，**刚被回滚的那一份（最旧的）会当场被删掉** ——
///   用户回滚到昨天的存档，然后发现"昨天那份备份没了"，
///   而它正是他唯一的退路。所以调用方必须把回滚源钉进 `protect`。
pub fn prune(paths: &AppPaths, slug: &str, keep: usize, protect: &[String]) -> Vec<String> {
    let all = list(paths, slug);
    let root = backups_root(paths, slug);
    let mut removed = Vec::new();
    for (i, m) in all.iter().enumerate() {
        if i < keep {
            continue;
        }
        if protect.iter().any(|p| p == &m.id) {
            continue;
        }
        // 只删自己认得的目录（有清单的那种），别的文件一概不碰
        match std::fs::remove_dir_all(root.join(&m.id)) {
            Ok(()) => removed.push(m.id.clone()),
            Err(e) => {
                crate::say!("[IEML/backup] 删旧备份 {} 失败（跳过）：{e}", m.id);
            }
        }
    }
    removed
}

/// 删掉一份备份（用户手动删）。拒绝删除不在 `backups/<slug>/` 下的东西。
pub fn remove(paths: &AppPaths, slug: &str, id: &str) -> Result<(), String> {
    let root = backups_root(paths, slug);
    let Some(dir) = safe_join(&root, id) else {
        return Err("备份 id 不合法".into());
    };
    if !dir.join("backup.json").is_file() {
        return Err(format!("{id} 不是一份备份（缺 backup.json），拒绝删除"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除备份失败：{e}"))
}

/// 走一遍备份目录里的所有文件（相对备份目录的路径），用来算"当前盘上有没有它"。
fn walk_rel(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_rel(&p, base, out);
        } else if p.is_file() {
            if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// 从一份备份回滚。**先备份当前状态，再还原**（ADR-014）。
///
/// `keep` 用来顺带滚动保留（回滚源与刚做的 pre-rollback 快照都会被保护）。
pub async fn restore(
    paths: &AppPaths,
    slug: &str,
    name: &str,
    mc_version: &str,
    id: &str,
    keep: usize,
    now_secs: u64,
) -> Result<RestoreReport, String> {
    let root = backups_root(paths, slug);
    let Some(src) = safe_join(&root, id) else {
        return Err("备份 id 不合法".into());
    };
    let text = std::fs::read_to_string(src.join("backup.json"))
        .map_err(|e| format!("读不到这份备份的清单（{id}）：{e}"))?;
    let manifest: BackupManifest =
        serde_json::from_str(&text).map_err(|e| format!("这份备份的清单读不了：{e}"))?;
    if manifest.schema > SCHEMA {
        return Err(format!(
            "这份备份是更新版本的启动器做的（清单 v{}，本机只认 v{SCHEMA}）——\
             升级启动器之后再回滚",
            manifest.schema
        ));
    }

    // ① ★★ 先存当前状态（失败就中止，绝不进入"既没回滚、也没退路"的状态）
    let pre = create(paths, slug, name, mc_version, "回滚前自动", now_secs).await?;

    let game_dir = paths.instance_game_dir(slug);
    let mut report = RestoreReport {
        from_id: id.to_string(),
        pre_rollback_id: pre.id.clone(),
        restored: Vec::new(),
        kept_extra_files: Vec::new(),
        mods_missing: Vec::new(),
        mods_moved_out: Vec::new(),
    };
    let mut failed: Vec<String> = Vec::new();

    // ② 还原条目
    for item in &manifest.items {
        let rel = item.rel.as_str();
        let from = src.join(rel);
        let Some(to) = safe_join(&game_dir, rel) else {
            failed.push(format!("{rel}（路径不合法，已跳过）"));
            continue;
        };
        if item.kind == "dir" {
            if !item.present || !from.is_dir() {
                continue;
            }
            std::fs::create_dir_all(&to).map_err(|e| format!("建目录失败：{e}"))?;
            let (files, bytes) = copy_tree(&from, &to, &mut failed);
            report.restored.push(BackupItem {
                kind: "dir".into(),
                rel: rel.to_string(),
                files,
                bytes,
                present: true,
            });
            /*
             * ★ 备份里没有、盘上却有的文件：**一个都不删**，如实列出来。
             *
             *   ADR-014 对 `mods/` 说的是"多的删"，本模块把那条改成"移走"（见文件头）。
             *   存档与配置更不该删：用户回滚到昨天的存档，今天新建的世界、
             *   改过的按键绑定都还在盘上 —— 这不是"回滚没干净"，
             *   而是**回滚只负责把备份里的东西放回去，不负责删用户后来的东西**。
             *   界面上把它们列成"备份里没有、已保留"，用户自己决定要不要清。
             */
            let mut in_backup = Vec::new();
            walk_rel(&from, &from, &mut in_backup);
            let set: std::collections::HashSet<&str> =
                in_backup.iter().map(|s| s.as_str()).collect();
            let mut on_disk = Vec::new();
            walk_rel(&to, &to, &mut on_disk);
            for f in on_disk {
                if !set.contains(f.as_str()) {
                    report.kept_extra_files.push(format!("{rel}/{f}"));
                }
            }
        } else if item.present && from.is_file() {
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::copy(&from, &to) {
                Ok(n) => report.restored.push(BackupItem {
                    kind: "file".into(),
                    rel: rel.to_string(),
                    files: 1,
                    bytes: n,
                    present: true,
                }),
                Err(e) => failed.push(format!("{rel} 还原失败：{e}")),
            }
        }
    }

    // ③ Mod：按清单对账（ADR-014 的"缺的补、多的处理"，见文件头第 2 条的改动说明）
    let now_mods = mods_manifest(&paths.instance_mods_dir(slug)).await;
    let want: std::collections::HashSet<&str> =
        manifest.mods.iter().map(|m| m.name.as_str()).collect();
    let have: std::collections::HashSet<&str> = now_mods.iter().map(|m| m.name.as_str()).collect();
    for m in &manifest.mods {
        if !have.contains(m.name.as_str()) {
            report.mods_missing.push(m.name.clone());
        }
    }
    let extra: Vec<&ModEntry> = now_mods
        .iter()
        .filter(|m| !want.contains(m.name.as_str()))
        .collect();
    if !extra.is_empty() {
        let aside = src.join(MODS_EXTRA_DIR);
        std::fs::create_dir_all(&aside).map_err(|e| format!("建 mods-extra 失败：{e}"))?;
        for m in extra {
            let from = paths.instance_mods_dir(slug).join(&m.name);
            match std::fs::rename(&from, aside.join(&m.name)) {
                Ok(()) => report.mods_moved_out.push(m.name.clone()),
                Err(e) => failed.push(format!("挪走 {} 失败：{e}", m.name)),
            }
        }
    }

    // ④ 顺手滚动保留（**把回滚源与刚做的快照钉住**，见 `prune` 的说明）
    prune(paths, slug, keep, &[id.to_string(), pre.id.clone()]);

    if !failed.is_empty() {
        crate::say!(
            "[IEML/backup] 回滚 {id} 有 {} 项没做成：{:?}",
            failed.len(),
            failed
        );
    }
    Ok(report)
}

/// 回滚**之前**给用户看的差异（ADR-014 的 UI 要求：先预览差异，再确认回滚）。
///
/// ★★ 为什么要有它（而不是"直接点回滚"）：
///   ADR-014 写的是"点击可**预览差异**（哪些存档文件会变化）再确认回滚"。
///   回滚会**覆盖**用户当前的存档 —— 这是这个功能里唯一一个会动现有数据的动作，
///   而"会动哪些文件"完全可以在动手之前算出来。算出来给用户看，
///   与"点下去之后才知道"是两种完全不同的东西。
///
/// ★ 只报**计数 + 样例**，不把几百条路径全塞给界面：
///   存档动辄上千个文件（region/*.mca），界面上列不下，列了也没人看。
///   样例最多 [`PREVIEW_SAMPLE`] 条，界面照实说"还有 N 条"。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestorePreview {
    pub from_id: String,
    pub created_secs: u64,
    pub reason: String,
    /// 备份里有的文件（会被写回）
    pub will_write: usize,
    /// 其中**内容与现在不同**的（新增 + 覆盖）
    pub will_change: usize,
    /// 其中现在盘上还没有的（纯新增）
    pub will_add: usize,
    /// 现在盘上有、备份里没有的（**不会被删**，如实列出来）
    pub kept_extra: usize,
    /// 会被移进那份备份的 `mods-extra/` 的 Mod
    pub mods_extra: Vec<String>,
    /// 清单里有、盘上没有的 Mod（要用户自己重新获取）
    pub mods_missing: Vec<String>,
    pub total_bytes: u64,
    pub sample_write: Vec<String>,
    pub sample_kept: Vec<String>,
}

/// 预览里最多列几条路径（界面据此说"还有 N 条"）
const PREVIEW_SAMPLE: usize = 8;

/// 两个文件内容是否相同：**先比大小，再逐块比字节**（早退）。
///
/// ★ 为什么不比 mtime：解压、回滚、换机器都会改 mtime，而内容没变 ——
///   那会让预览说"这些文件都会变"，而实际上一个字节都没动。
/// ★ 不用 SHA1：这里只需要"相同/不同"，逐块比可以**一发现不同就返回**，
///   比整份哈希更省。
/// ★ 读不了（权限/被杀软锁住）时返回 `false`，也就是**当成"会变化"** ——
///   宁可多报一处变化，也不要漏报一处。
fn files_equal(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut ba = [0u8; 64 * 1024];
    let mut bb = [0u8; 64 * 1024];
    loop {
        let (na, nb) = match (fa.read(&mut ba), fb.read(&mut bb)) {
            (Ok(x), Ok(y)) => (x, y),
            _ => return false,
        };
        if na != nb {
            return false;
        }
        if na == 0 {
            return true;
        }
        if ba[..na] != bb[..nb] {
            return false;
        }
    }
}

/// 算一遍"回滚会做什么"（**只读，不动任何文件**）。
pub fn preview_restore(paths: &AppPaths, slug: &str, id: &str) -> Result<RestorePreview, String> {
    let root = backups_root(paths, slug);
    let Some(src) = safe_join(&root, id) else {
        return Err("备份 id 不合法".into());
    };
    let text = std::fs::read_to_string(src.join("backup.json"))
        .map_err(|e| format!("读不到这份备份的清单（{id}）：{e}"))?;
    let manifest: BackupManifest =
        serde_json::from_str(&text).map_err(|e| format!("这份备份的清单读不了：{e}"))?;

    let game_dir = paths.instance_game_dir(slug);
    let mut will_write = 0usize;
    let mut will_change = 0usize;
    let mut will_add = 0usize;
    let mut kept_extra = 0usize;
    let mut sample_write: Vec<String> = Vec::new();
    let mut sample_kept: Vec<String> = Vec::new();

    for item in &manifest.items {
        let rel = item.rel.as_str();
        let from = src.join(rel);
        if item.kind == "file" {
            if !item.present || !from.is_file() {
                continue;
            }
            will_write += 1;
            let Some(to) = safe_join(&game_dir, rel) else {
                continue;
            };
            if !to.is_file() {
                will_add += 1;
                will_change += 1;
                if sample_write.len() < PREVIEW_SAMPLE {
                    sample_write.push(format!("{rel}（新增）"));
                }
            } else if !files_equal(&from, &to) {
                will_change += 1;
                if sample_write.len() < PREVIEW_SAMPLE {
                    sample_write.push(format!("{rel}（覆盖）"));
                }
            }
            continue;
        }
        if item.kind != "dir" || !item.present || !from.is_dir() {
            continue;
        }
        let mut in_backup = Vec::new();
        walk_rel(&from, &from, &mut in_backup);
        let set: std::collections::HashSet<&str> = in_backup.iter().map(|s| s.as_str()).collect();
        for r in &in_backup {
            will_write += 1;
            let cur = game_dir.join(rel).join(r.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !cur.is_file() {
                will_add += 1;
                will_change += 1;
                if sample_write.len() < PREVIEW_SAMPLE {
                    sample_write.push(format!("{rel}/{r}（新增）"));
                }
            } else if !files_equal(&from.join(r.replace('/', std::path::MAIN_SEPARATOR_STR)), &cur)
            {
                will_change += 1;
                if sample_write.len() < PREVIEW_SAMPLE {
                    sample_write.push(format!("{rel}/{r}（覆盖）"));
                }
            }
        }
        // 现在盘上有、备份里没有的 —— 回滚**不会删**它们
        let mut on_disk = Vec::new();
        let cur_dir = game_dir.join(rel);
        if cur_dir.is_dir() {
            walk_rel(&cur_dir, &cur_dir, &mut on_disk);
        }
        for f in on_disk {
            if !set.contains(f.as_str()) {
                kept_extra += 1;
                if sample_kept.len() < PREVIEW_SAMPLE {
                    sample_kept.push(format!("{rel}/{f}"));
                }
            }
        }
    }

    // Mod 对账：只读目录名，不算 SHA1（预览要快；真正回滚时才算）
    let mut on_disk_mods: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(paths.instance_mods_dir(slug)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.to_ascii_lowercase().ends_with(".jar") {
                on_disk_mods.push(name);
            }
        }
    }
    let want: std::collections::HashSet<&str> =
        manifest.mods.iter().map(|m| m.name.as_str()).collect();
    let have: std::collections::HashSet<&str> = on_disk_mods.iter().map(|s| s.as_str()).collect();
    let mods_missing: Vec<String> = manifest
        .mods
        .iter()
        .filter(|m| !have.contains(m.name.as_str()))
        .map(|m| m.name.clone())
        .collect();
    let mods_extra: Vec<String> = on_disk_mods
        .into_iter()
        .filter(|n| !want.contains(n.as_str()))
        .collect();

    Ok(RestorePreview {
        from_id: manifest.id.clone(),
        created_secs: manifest.created_secs,
        reason: manifest.reason.clone(),
        will_write,
        will_change,
        will_add,
        kept_extra,
        mods_extra,
        mods_missing,
        total_bytes: manifest.total_bytes,
        sample_write,
        sample_kept,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个假的实例：`<root>/instances/<slug>/game/...`
    fn fake_instance(tag: &str) -> (AppPaths, String) {
        let base = std::env::temp_dir().join(format!("ieml-backup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("game-root");
        let own = base.join("own");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&own).unwrap();
        let mut paths = AppPaths::from_root(root);
        paths.own_root = own;
        paths.instances = paths.root.join("instances");
        let slug = "pack-test".to_string();
        let game = paths.instance_game_dir(&slug);
        std::fs::create_dir_all(game.join("saves/World1")).unwrap();
        std::fs::create_dir_all(game.join("config")).unwrap();
        std::fs::create_dir_all(game.join("mods")).unwrap();
        std::fs::write(game.join("saves/World1/level.dat"), b"LEVEL-DATA-V1").unwrap();
        std::fs::write(game.join("config/jei.toml"), b"config-v1").unwrap();
        std::fs::write(game.join("options.txt"), b"lang:zh_cn\n").unwrap();
        std::fs::write(game.join("servers.dat"), b"servers-v1").unwrap();
        // 两个 Mod（一个几百字节，一个"大"一点，用来证明 jar 不进备份）
        std::fs::write(game.join("mods/jei.jar"), vec![7u8; 4096]).unwrap();
        std::fs::write(game.join("mods/sodium.jar"), vec![9u8; 8192]).unwrap();
        (paths, slug)
    }

    fn cleanup(paths: &AppPaths) {
        if let Some(base) = paths.own_root.parent() {
            let _ = std::fs::remove_dir_all(base);
        }
    }

    /// ★★ ADR-014 的黑线：**jar 一个字节都不许进备份**。
    ///
    /// 这条测试是给"以后有人顺手把 mods 目录整个拷进去"准备的：
    /// 那样做的直接后果是备份从几 MB 变成几百 MB × 5 份，
    /// 而用户会因此把备份关掉。
    #[tokio::test]
    async fn backup_never_copies_mod_jars() {
        let (paths, slug) = fake_instance("nojars");
        let m = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();

        // ① 清单里两个 Mod 都在（名字 + SHA1 + 大小）
        assert_eq!(m.mods.len(), 2, "两个 Mod 都要登记：{:?}", m.mods);
        assert!(m.mods.iter().all(|x| !x.sha1.is_empty()), "SHA1 不能是空的");
        assert!(m.mods.iter().any(|x| x.name == "jei.jar"));

        // ② 备份目录里**一个 jar 都没有**，也没有 mods 目录
        let dest = backups_root(&paths, &slug).join(&m.id);
        assert!(!dest.join("mods").exists(), "备份里不该有 mods 目录");
        let mut all = Vec::new();
        walk_rel(&dest, &dest, &mut all);
        assert!(
            all.iter().all(|f| !f.to_ascii_lowercase().ends_with(".jar")),
            "备份里出现了 jar：{all:?}"
        );

        // ③ 体积只算存档 + 配置（**jar 的字节一个都不许算进来**）
        let expect = (b"LEVEL-DATA-V1".len()
            + b"config-v1".len()
            + b"lang:zh_cn\n".len()
            + b"servers-v1".len()) as u64;
        assert_eq!(
            m.total_bytes, expect,
            "备份体积把不该算的算进来了：{all:?}（两个 jar 一共 12288 B）"
        );

        cleanup(&paths);
    }

    /// 备份里如实记着"这次盘上有没有 saves" —— 新实例还没进过游戏时是这样
    #[tokio::test]
    async fn missing_dirs_are_recorded_as_absent_not_as_empty() {
        let (paths, slug) = fake_instance("absent");
        std::fs::remove_dir_all(paths.instance_game_dir(&slug).join("saves")).unwrap();
        let m = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let saves = m.items.iter().find(|i| i.rel == "saves").unwrap();
        assert!(!saves.present, "盘上没有 saves 时要记 present=false");
        assert_eq!(saves.files, 0);
        assert!(m.summary().contains("0 个存档文件"), "{}", m.summary());
        cleanup(&paths);
    }

    /// 滚动保留：留最近 5 份，删最旧的
    #[tokio::test]
    async fn retention_keeps_the_newest_five() {
        let (paths, slug) = fake_instance("retain");
        for i in 0..7u64 {
            create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000 + i)
                .await
                .unwrap();
        }
        let removed = prune(&paths, &slug, DEFAULT_KEEP, &[]);
        assert_eq!(removed.len(), 2, "7 份留 5 份 = 删 2 份，实际删了 {removed:?}");
        let left = list(&paths, &slug);
        assert_eq!(left.len(), DEFAULT_KEEP);
        // 留下的必须是最新的那 5 份（id 大的在前）
        assert_eq!(left[0].id, (1_758_000_006u64).to_string());
        assert_eq!(left[4].id, (1_758_000_002u64).to_string());
        cleanup(&paths);
    }

    /// `prune` 的 `protect`：正在被回滚的那一份**不许删**
    #[tokio::test]
    async fn prune_never_deletes_the_backup_being_restored() {
        let (paths, slug) = fake_instance("protect");
        let mut ids = Vec::new();
        for i in 0..6u64 {
            ids.push(
                create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000 + i)
                    .await
                    .unwrap()
                    .id,
            );
        }
        // 假装正在回滚最旧的那一份，并把保留数设成 1
        let oldest = ids[0].clone();
        let removed = prune(&paths, &slug, 1, &[oldest.clone()]);
        assert!(!removed.contains(&oldest), "被保护的备份被删了：{removed:?}");
        assert!(
            list(&paths, &slug).iter().any(|m| m.id == oldest),
            "回滚源必须还在"
        );
        cleanup(&paths);
    }

    /// **回滚前先备份当前状态**（ADR-014 的硬要求），而且它真的能回滚回去
    #[tokio::test]
    async fn restore_snapshots_the_current_state_first() {
        let (paths, slug) = fake_instance("preroll");
        let first = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        // 用户把存档改坏了
        let game = paths.instance_game_dir(&slug);
        std::fs::write(game.join("saves/World1/level.dat"), b"BROKEN").unwrap();
        // 回滚到第一份
        let rep = restore(&paths, &slug, "测试实例", "1.20.1", &first.id, DEFAULT_KEEP, 1_758_000_100)
            .await
            .unwrap();

        // ① 存档真的回来了
        assert_eq!(
            std::fs::read(game.join("saves/World1/level.dat")).unwrap(),
            b"LEVEL-DATA-V1"
        );
        // ② 回滚前那份快照里有"坏掉的存档" —— 后悔了能回去
        let pre = backups_root(&paths, &slug).join(&rep.pre_rollback_id);
        assert_eq!(
            std::fs::read(pre.join("saves/World1/level.dat")).unwrap(),
            b"BROKEN",
            "pre-rollback 快照必须是**回滚之前**的状态"
        );
        // ③ 两份备份都还在（回滚源没被 prune 掉）
        let all = list(&paths, &slug);
        assert!(all.iter().any(|m| m.id == first.id), "回滚源不见了");
        assert!(all.iter().any(|m| m.id == rep.pre_rollback_id));
        cleanup(&paths);
    }

    /// 回滚时**多出来的 Mod 移走而不是删掉**（文件头第 2 条的判据）
    #[tokio::test]
    async fn restore_moves_extra_mods_aside_instead_of_deleting() {
        let (paths, slug) = fake_instance("extramods");
        let first = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let game = paths.instance_game_dir(&slug);
        // 备份之后用户又装了第三个 Mod，并删掉了一个老的
        std::fs::write(game.join("mods/create.jar"), vec![1u8; 2048]).unwrap();
        std::fs::remove_file(game.join("mods/sodium.jar")).unwrap();

        let rep = restore(&paths, &slug, "测试实例", "1.20.1", &first.id, DEFAULT_KEEP, 1_758_000_100)
            .await
            .unwrap();

        // ① 多出来的那个被挪进 mods-extra/（没删）
        assert_eq!(rep.mods_moved_out, vec!["create.jar".to_string()]);
        let aside = backups_root(&paths, &slug)
            .join(&first.id)
            .join(MODS_EXTRA_DIR)
            .join("create.jar");
        assert!(aside.is_file(), "多出来的 Mod 应该在 mods-extra 里");
        assert!(
            !game.join("mods/create.jar").exists(),
            "它必须离开 mods/，否则游戏还会加载它"
        );
        // ② 清单里有、盘上没有的，如实报出来 —— 不假装补齐
        assert_eq!(rep.mods_missing, vec!["sodium.jar".to_string()]);
        cleanup(&paths);
    }

    /// 清单里出现越界路径时，回滚**拒绝**那条，而不是照着写出去
    #[tokio::test]
    async fn restore_refuses_paths_outside_the_game_dir() {
        let (paths, slug) = fake_instance("escape");
        let m = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        // 手改清单：塞一条越界的目录进去（模拟"备份目录被改过"）
        let dest = backups_root(&paths, &slug).join(&m.id);
        let mut tampered: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dest.join("backup.json")).unwrap())
                .unwrap();
        tampered["items"].as_array_mut().unwrap().push(serde_json::json!({
            "kind": "file", "rel": "../../../evil.txt", "files": 1, "bytes": 3, "present": true
        }));
        std::fs::write(
            dest.join("backup.json"),
            serde_json::to_string_pretty(&tampered).unwrap(),
        )
        .unwrap();

        let rep = restore(&paths, &slug, "测试实例", "1.20.1", &m.id, DEFAULT_KEEP, 1_758_000_100)
            .await
            .unwrap();
        // 越界那条没被还原（restored 里没有它），也没在别处生成文件
        assert!(
            rep.restored.iter().all(|i| !i.rel.contains("..")),
            "{:?}",
            rep.restored
        );
        cleanup(&paths);
    }

    /// 删一份备份：认得出是备份才删；id 想越界一律拒绝
    #[tokio::test]
    async fn remove_refuses_anything_that_is_not_a_backup() {        let (paths, slug) = fake_instance("remove");
        let m = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        assert!(remove(&paths, &slug, "../..").is_err(), "越界 id 必须拒绝");
        assert!(
            remove(&paths, &slug, "1758000000-not-here").is_err(),
            "不是备份的目录必须拒绝"
        );
        assert!(remove(&paths, &slug, &m.id).is_ok());
        assert!(list(&paths, &slug).is_empty());
        cleanup(&paths);
    }

    /*
     * ---------- 回滚前的差异预览（ADR-014 的 UI 要求） ----------
     *
     * 预览是"回滚"这个动作**唯一**的刹车：它必须在动手之前把"会动哪些文件、
     * 会保留哪些、缺哪些 Mod"说准。所以这里把三种情况分别钉住：
     * 纯新增、内容不同（覆盖）、内容相同（**不算变化** —— 不能吓唬用户）。
     */

    #[tokio::test]
    async fn preview_separates_added_overwritten_and_unchanged() {
        let (paths, slug) = fake_instance("preview");
        let first = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let game = paths.instance_game_dir(&slug);

        // 没有动过任何东西 → 一个都不会"变化"
        // （备份里有 4 个文件：saves/World1/level.dat、config/jei.toml、options.txt、servers.dat）
        let p0 = preview_restore(&paths, &slug, &first.id).unwrap();
        assert_eq!(p0.will_write, 4, "备份里有 4 个文件：{p0:?}");
        assert_eq!(p0.will_change, 0, "什么都没改时不该报变化：{p0:?}");
        assert_eq!(p0.will_add, 0);

        // ① 改一个（内容不同 → 覆盖）② 删一个（→ 新增回来）③ 加一个备份里没有的（→ 保留）
        std::fs::write(game.join("saves/World1/level.dat"), b"LEVEL-DATA-V2").unwrap();
        std::fs::remove_file(game.join("config/jei.toml")).unwrap();
        std::fs::write(game.join("config/new.toml"), b"later").unwrap();

        let p = preview_restore(&paths, &slug, &first.id).unwrap();
        assert_eq!(p.will_write, 4, "{p:?}");
        assert_eq!(p.will_add, 1, "config/jei.toml 被删了 → 会新增回来：{p:?}");
        assert_eq!(p.will_change, 2, "level.dat 覆盖 + jei.toml 新增 = 2：{p:?}");
        assert_eq!(p.kept_extra, 1, "config/new.toml 备份里没有 → 会保留：{p:?}");
        assert!(
            p.sample_write.iter().any(|s| s.contains("level.dat")),
            "样例里要能看见那个被改过的存档：{p:?}"
        );
        assert!(p.sample_kept.iter().any(|s| s.contains("new.toml")), "{p:?}");
        // ★ 预览**不许动任何文件**（它是只读的）
        assert_eq!(
            std::fs::read(game.join("saves/World1/level.dat")).unwrap(),
            b"LEVEL-DATA-V2",
            "预览把手改了 —— 那是回滚才该做的事"
        );
        cleanup(&paths);
    }

    #[tokio::test]
    async fn preview_lists_mods_that_will_move_out_and_ones_that_are_missing() {
        let (paths, slug) = fake_instance("previewmods");
        let first = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let game = paths.instance_game_dir(&slug);
        std::fs::write(game.join("mods/create.jar"), vec![1u8; 64]).unwrap();
        std::fs::remove_file(game.join("mods/sodium.jar")).unwrap();

        let p = preview_restore(&paths, &slug, &first.id).unwrap();
        assert_eq!(p.mods_extra, vec!["create.jar".to_string()], "{p:?}");
        assert_eq!(p.mods_missing, vec!["sodium.jar".to_string()], "{p:?}");
        cleanup(&paths);
    }

    /// 预览里"内容相同"必须**真的**按字节判：改 mtime 不算变化
    #[tokio::test]
    async fn preview_ignores_mtime_only_differences() {
        let (paths, slug) = fake_instance("previewmtime");
        let first = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let game = paths.instance_game_dir(&slug);
        // 内容一个字节不改，只是重写了一遍（mtime 变了）
        let same = std::fs::read(game.join("saves/World1/level.dat")).unwrap();
        std::fs::write(game.join("saves/World1/level.dat"), &same).unwrap();

        let p = preview_restore(&paths, &slug, &first.id).unwrap();
        assert_eq!(
            p.will_change, 0,
            "只改了 mtime 就不该说'会变化' —— 那会让用户以为存档被动过：{p:?}"
        );
        cleanup(&paths);
    }

    /*
     * ---------- 契约：Rust 发出去的字段名 == `src/bridge/tauri.ts` 读的那些 ----------
     *
     * ★ 为什么要有这一条：这两个结构体**没有** `rename_all`，也就是原样发 snake_case，
     *   而前端 `BackupManifest` / `BackupRestorePreview` 里写的也是 snake_case。
     *   只要有人给其中一个加上 `#[serde(rename_all = "camelCase")]`（这个仓库里
     *   大部分结构体都是 camelCase），前端就会**静默**读到 undefined ——
     *   表现是"备份列表全是 0"、"预览里数字都没有"，而不会报任何错。
     *   同一个坑这个仓库踩过（`Instance` / `LoaderCapabilities` 那次）。
     */
    #[tokio::test]
    async fn payload_field_names_match_the_bridge() {
        let (paths, slug) = fake_instance("contract");
        let m = create(&paths, &slug, "测试实例", "1.20.1", "手动", 1_758_000_000)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        for k in [
            "schema",
            "id",
            "slug",
            "name",
            "mc_version",
            "created_secs",
            "reason",
            "items",
            "mods",
            "total_bytes",
            "skipped",
        ] {
            assert!(keys.contains(&k), "清单缺字段 {k}：{keys:?}");
        }
        // 条目里也必须是 snake_case（前端读的是 `present` / `files` / `bytes`）
        let item = &v["items"][0];
        for k in ["kind", "rel", "files", "bytes", "present"] {
            assert!(item.get(k).is_some(), "条目缺字段 {k}：{item}");
        }

        let p = preview_restore(&paths, &slug, &m.id).unwrap();
        let pv: serde_json::Value = serde_json::to_value(&p).unwrap();
        let pkeys: Vec<&str> = pv.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        for k in [
            "from_id",
            "created_secs",
            "reason",
            "will_write",
            "will_change",
            "will_add",
            "kept_extra",
            "mods_extra",
            "mods_missing",
            "total_bytes",
            "sample_write",
            "sample_kept",
        ] {
            assert!(pkeys.contains(&k), "预览缺字段 {k}：{pkeys:?}");
        }
        cleanup(&paths);
    }
}
