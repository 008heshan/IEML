//! **一次操作的原子性**：Draft 事务（ADR-023）。
//!
//! ## 它解决什么（与备份的分工）
//!
//! ```text
//!   Draft 事务   保证**单次操作**的原子性（搬到一半失败 → 自动还原）   自动、用户无感
//!   备份快照     保证**跨操作**的历史（想退回昨天 → 用户主动恢复）     用户显式操作
//! ```
//!
//!   备份管不了"搬到一半"：用户在设置页拨一下隔离方式、或者导入另一个启动器的数据，
//!   我们可能要写几千个文件。中途失败（磁盘满、权限、目标里有个同名的**文件**挡路）
//!   会留下一个**半成品**：一半内容过去了、一半没过去 —— 而界面上刚才说了"已复制 N 个"。
//!
//! ## 照抄 ADR-023 的四个安全设计
//!
//!   ① **回滚目录隔离**：`<base>/.ieml/drafts/<id>/{removed,backups}`；成功即删、失败即恢复；
//!   ② **原子移动优先**：先 `rename`（同盘即原子），失败退化为 copy+remove；
//!   ③ **路径越界防护**：一切路径都必须是**相对**且不含 `..`（与 zip-slip 同类）；
//!   ④ **严格逆序回滚**：后做的先撤，撤到与动手之前**一模一样**。
//!
//!   ★ ADR-023 还有一条精神：**先在内存里把最终状态推演完整，再动盘**
//!     （HMCL 的 `buildCommittedSnapshot()`）。这里体现在 [`Draft::commit`] 的
//!     第一步：**先校验**所有计划（越界？目标父目录建得出来吗？），一条不合格就
//!     整体拒绝、磁盘一个字节都不动。
//!
//! ## 它**不**管什么
//!
//!   * 跨进程/断电的持久事务（没有 WAL，也不打算有）；
//!   * 共享的 `libraries/` `assets/` 缓存 —— ADR-023 明说"在回滚边界之外"；
//!   * 跨网络的长流程（整合包安装那种"一边下载一边写"的，见下面的待办）。

use std::io::Write;
use std::path::{Path, PathBuf};

/// 事务状态（ADR-023 的状态机）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Open,
    Committing,
    Committed,
    Failed,
    Aborted,
}

/// 计划里的一步
#[derive(Debug, Clone)]
pub enum Op {
    /// 建目录（相对路径）
    CreateDir(String),
    /// 写文件（相对路径 + 内容）
    WriteFile { rel: String, bytes: Vec<u8> },
    /// 移除（文件或目录）—— 先**移到回滚目录**，不是直接删
    Remove(String),
    /// 把 `from` 下的东西复制进 `to`（相对路径；**源不动**）
    ///
    /// ★ 这是"导入 / 迁移"用得最多的那一步：源在别处（用户的旧启动器目录），
    ///   我们只往目标写。`skip_existing` = 目标里已有同名文件就跳过（ADR-024 的同一条纪律）。
    CopyTree {
        from: PathBuf,
        to: String,
        skip_existing: bool,
    },
}

impl Op {
    fn label(&self) -> String {
        match self {
            Op::CreateDir(rel) => format!("建目录 {rel}"),
            Op::WriteFile { rel, .. } => format!("写文件 {rel}"),
            Op::Remove(rel) => format!("移除 {rel}"),
            Op::CopyTree { to, .. } => format!("复制到 {to}"),
        }
    }
}

/// 一处失败
#[derive(Debug, Clone)]
pub struct Failure {
    pub what: String,
    pub why: String,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} 失败：{}", self.what, self.why)
    }
}

/// 提交结果（供界面如实汇报）
#[derive(Debug, Default, Clone)]
pub struct Report {
    pub files_written: u64,
    pub bytes_written: u64,
    /// 因为"目标里已经有了"而跳过的（每条是相对路径）
    pub skipped_existing: Vec<String>,
    /// ★ **按步骤**的明细（相对路径 → 写了几个文件 / 多少字节）。
    ///   界面要按"存档 / Mod / 配置"分别报，而不是只报一个总数。
    pub per_op: Vec<(String, u64, u64)>,
}

/// 已经动过的盘（回滚就靠它，**逆序**走）
enum Applied {
    /// 新建的目录（回滚时删掉）
    CreatedDir(PathBuf),
    /// 写过的文件：记下它**原来**有没有、内容是什么（回滚时还原/删除）
    WrittenFile { path: PathBuf, backup: Option<PathBuf> },
    /// 移到回滚目录里的东西（回滚时移回去）
    Removed { original: PathBuf, saved: PathBuf },
    /// 复制进去的文件（回滚时删掉）
    Copied(PathBuf),
}

/// 一个草稿事务
pub struct Draft {
    /// 一切相对路径的基准（实例的游戏目录 / 某个数据目录）
    base: PathBuf,
    /// 回滚区（成功即删）
    rollback_root: PathBuf,
    ops: Vec<Op>,
    applied: Vec<Applied>,
    state: State,
}

/// 事务失败（带"为什么"，并且**已经回滚完了**）
#[derive(Debug, Clone)]
pub struct DraftError {
    pub failure: Failure,
    /// 回滚过程中的问题（正常情况下为空 —— 不为空说明回滚本身也不干净，必须让人看见）
    pub rollback_problems: Vec<String>,
}

impl std::fmt::Display for DraftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.failure)?;
        if !self.rollback_problems.is_empty() {
            write!(f, "（回滚时还有问题：{}）", self.rollback_problems.join("；"))?;
        }
        Ok(())
    }
}

impl std::error::Error for DraftError {}

/// 路径越界 / 形状不合法 —— 在**动盘之前**就该拒绝
fn resolve(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() {
        return Err("路径是空的".to_string());
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("「{rel}」是绝对路径（只收相对路径）"));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(_) => {}
            std::path::Component::CurDir => {}
            _ => return Err(format!("「{rel}」里有 .. 或盘符 —— 不许跳出目标目录")),
        }
    }
    Ok(base.join(p))
}

impl Draft {
    /// 开一个草稿。
    ///
    /// ★ `base` 是**一切相对路径的基准**，也就是回滚区放的地方：
    ///   `<base>/.ieml/drafts/draft-<pid>-<counter>/`。
    pub fn open(base: impl Into<PathBuf>) -> Result<Draft, String> {
        let base = base.into();
        std::fs::create_dir_all(&base).map_err(|e| format!("建目标目录失败：{e}"))?;
        let n = next_id();
        let rollback_root = base.join(".ieml").join("drafts").join(format!("draft-{n}"));
        Ok(Draft {
            base,
            rollback_root,
            ops: Vec::new(),
            applied: Vec::new(),
            state: State::Open,
        })
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn base(&self) -> &Path {
        &self.base
    }

    /// 排一步（只在 `Open` 状态允许）
    ///
    /// ★ 这里就做**越界校验**：不合格的计划根本进不来，而不是等到动盘时才炸。
    pub fn plan(&mut self, op: Op) -> Result<(), String> {
        if self.state != State::Open {
            return Err(format!("事务已经是 {:?}，不能再排新的步骤", self.state));
        }
        match &op {
            Op::CreateDir(rel) => {
                resolve(&self.base, rel)?;
            }
            Op::WriteFile { rel, .. } => {
                resolve(&self.base, rel)?;
            }
            Op::Remove(rel) => {
                resolve(&self.base, rel)?;
            }
            Op::CopyTree { to, .. } => {
                resolve(&self.base, to)?;
            }
        }
        self.ops.push(op);
        Ok(())
    }

    /// 提交：**先整体推演、再动盘**（ADR-023 的第 4 步）
    ///
    /// 返回 `Err` 时保证：**磁盘与调用前一致**（要么没动，要么已经按逆序回滚干净）。
    pub fn commit(&mut self) -> Result<Report, DraftError> {
        let fail = |what: String, why: String| DraftError {
            failure: Failure { what, why },
            rollback_problems: Vec::new(),
        };
        if self.state != State::Open {
            return Err(fail(
                "提交".to_string(),
                format!("事务已经是 {:?}", self.state),
            ));
        }

        /* ---------- 第一步：推演（只读校验，不碰盘） ---------- */
        let ops = std::mem::take(&mut self.ops);
        for op in &ops {
            let check = match op {
                Op::CreateDir(rel) => resolve(&self.base, rel).map(|p| {
                    // 目标位置**已经有文件**（不是目录）→ 这一步注定失败，提前拒绝
                    if p.is_file() {
                        Err(format!("{rel} 那里已经有一个文件了，建不了目录"))
                    } else {
                        Ok(())
                    }
                }),
                Op::WriteFile { rel, .. } => resolve(&self.base, rel).map(|p| {
                    if p.is_dir() {
                        Err(format!("{rel} 那里已经有一个目录了，写不了文件"))
                    } else {
                        Ok(())
                    }
                }),
                Op::Remove(rel) => resolve(&self.base, rel).map(|_| Ok(())),
                Op::CopyTree { from, to, .. } => resolve(&self.base, to).map(|p| {
                    if p.is_file() {
                        Err(format!("{to} 那里已经有一个文件了，没法往里放东西"))
                    } else if !from.exists() {
                        Err(format!("源目录不存在：{}", from.display()))
                    } else {
                        Ok(())
                    }
                }),
            };
            match check {
                Err(e) => {
                    self.state = State::Aborted;
                    return Err(fail(op.label(), e));
                }
                Ok(Err(shape)) => {
                    self.state = State::Aborted;
                    return Err(fail(op.label(), shape));
                }
                Ok(Ok(())) => {}
            }
        }

        self.state = State::Committing;
        let mut report = Report::default();

        /* ---------- 第二步：按计划动盘（失败即逆序回滚） ---------- */
        for op in &ops {
            let before_files = report.files_written;
            let before_bytes = report.bytes_written;
            let rel = match op {
                Op::CreateDir(rel) | Op::Remove(rel) => rel.clone(),
                Op::WriteFile { rel, .. } => rel.clone(),
                Op::CopyTree { to, .. } => to.clone(),
            };
            let r = self.apply(op, &mut report);
            if let Err(why) = r {
                let label = op.label();
                let problems = self.rollback();
                self.state = State::Failed;
                return Err(DraftError {
                    failure: Failure { what: label, why },
                    rollback_problems: problems,
                });
            }
            report.per_op.push((
                rel,
                report.files_written - before_files,
                report.bytes_written - before_bytes,
            ));
        }

        /* ---------- 第三步：成功 → 收尾（回滚区删掉） ---------- */
        let _ = std::fs::remove_dir_all(&self.rollback_root);
        self.state = State::Committed;
        Ok(report)
    }

    fn apply(&mut self, op: &Op, report: &mut Report) -> Result<(), String> {
        match op {
            Op::CreateDir(rel) => {
                let p = resolve(&self.base, rel)?;
                if p.is_dir() {
                    return Ok(()); // 已经有了，不算"我们建的"（回滚时也不该删）
                }
                std::fs::create_dir_all(&p).map_err(|e| format!("{e}"))?;
                self.applied.push(Applied::CreatedDir(p));
                Ok(())
            }
            Op::WriteFile { rel, bytes } => {
                let p = resolve(&self.base, rel)?;
                if let Some(parent) = p.parent() {
                    if !parent.is_dir() {
                        std::fs::create_dir_all(parent).map_err(|e| format!("建父目录失败：{e}"))?;
                        self.applied.push(Applied::CreatedDir(parent.to_path_buf()));
                    }
                }
                // 旧内容先存进回滚区（**不是删掉**）
                let backup = if p.is_file() {
                    let dest = self.backup_slot(rel)?;
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| format!("{e}"))?;
                    }
                    move_replacing(&p, &dest).map_err(|e| format!("备份旧文件失败：{e}"))?;
                    Some(dest)
                } else {
                    None
                };
                let mut f = std::fs::File::create(&p).map_err(|e| format!("{e}"))?;
                f.write_all(bytes).map_err(|e| format!("{e}"))?;
                report.files_written += 1;
                report.bytes_written += bytes.len() as u64;
                self.applied.push(Applied::WrittenFile { path: p, backup });
                Ok(())
            }
            Op::Remove(rel) => {
                let p = resolve(&self.base, rel)?;
                if !p.exists() {
                    return Ok(());
                }
                let dest = self
                    .rollback_root
                    .join("removed")
                    .join(rel.trim_end_matches('/'));
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("{e}"))?;
                }
                move_replacing(&p, &dest).map_err(|e| format!("移进回滚区失败：{e}"))?;
                self.applied.push(Applied::Removed { original: p, saved: dest });
                Ok(())
            }
            Op::CopyTree { from, to, skip_existing } => {
                let dst_root = resolve(&self.base, to)?;
                self.copy_into(from, &dst_root, report, *skip_existing)
            }
        }
    }

    /// 把一个目录（或单文件）复制进 `dst_root`，**每个写下去的文件都记一笔**
    fn copy_into(
        &mut self,
        src: &Path,
        dst: &Path,
        report: &mut Report,
        skip_existing: bool,
    ) -> Result<(), String> {
        if src.is_file() {
            if dst.exists() && skip_existing {
                report
                    .skipped_existing
                    .push(dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                return Ok(());
            }
            if let Some(parent) = dst.parent() {
                if !parent.is_dir() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
                    self.applied.push(Applied::CreatedDir(parent.to_path_buf()));
                }
            }
            if dst.is_dir() {
                return Err(format!("{} 那里是个目录，写不进文件", dst.display()));
            }
            let n = std::fs::copy(src, dst).map_err(|e| format!("{}：{e}", src.display()))?;
            report.files_written += 1;
            report.bytes_written += n;
            self.applied.push(Applied::Copied(dst.to_path_buf()));
            return Ok(());
        }
        let rd = std::fs::read_dir(src).map_err(|e| format!("读不了 {}：{e}", src.display()))?;
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        if !dst.is_dir() {
            std::fs::create_dir_all(dst).map_err(|e| format!("建目录失败：{e}"))?;
            self.applied.push(Applied::CreatedDir(dst.to_path_buf()));
        }
        for e in entries {
            let child = dst.join(e.file_name());
            self.copy_into(&e.path(), &child, report, skip_existing)?;
        }
        Ok(())
    }

    fn backup_slot(&self, rel: &str) -> Result<PathBuf, String> {
        Ok(self
            .rollback_root
            .join("backups")
            .join(rel.trim_end_matches('/')))
    }

    /// **严格逆序**回滚（ADR-023：后做的先撤）
    ///
    /// 返回回滚过程中遇到的问题（正常应当为空）。
    fn rollback(&mut self) -> Vec<String> {
        let mut problems = Vec::new();
        while let Some(a) = self.applied.pop() {
            let r = match a {
                Applied::CreatedDir(p) => std::fs::remove_dir_all(&p).map_err(|e| e.to_string()),
                Applied::WrittenFile { path, backup } => match backup {
                    Some(b) => move_replacing(&b, &path).map_err(|e| e.to_string()),
                    None => match std::fs::remove_file(&path) {
                        Ok(()) => Ok(()),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        Err(e) => Err(e.to_string()),
                    },
                },
                Applied::Removed { original, saved } => {
                    if let Some(parent) = original.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    move_replacing(&saved, &original).map_err(|e| e.to_string())
                }
                Applied::Copied(p) => match std::fs::remove_file(&p) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.to_string()),
                },
            };
            if let Err(e) = r {
                problems.push(e);
            }
        }
        // 回滚区里没搬回去的东西**留着**（比删掉更安全：那是用户的文件）
        if self.rollback_root.exists() && problems.is_empty() {
            let _ = std::fs::remove_dir_all(&self.rollback_root);
        }
        problems
    }

    /// 放弃（还没提交时用）：什么都不动
    pub fn abort(&mut self) {
        if self.state == State::Open {
            self.ops.clear();
            self.state = State::Aborted;
        }
    }
}

impl Drop for Draft {
    fn drop(&mut self) {
        // ★ 没提交就 drop：把回滚区里剩下的东西**留着**并留痕，
        //   而不是偷偷删掉 —— 那里面可能是用户原来的文件。
        if self.state == State::Committing {
            self.rollback();
            self.state = State::Failed;
        }
    }
}

/// 原子移动优先，失败退化为 copy+remove（ADR-023 的安全设计②）
fn move_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // 跨盘 / 目标已存在：退化为复制 + 删源
    if src.is_dir() {
        copy_dir_all(src, dst)?;
        std::fs::remove_dir_all(src)?;
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _ = std::fs::remove_file(dst);
        std::fs::copy(src, dst)?;
        std::fs::remove_file(src)?;
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)?.flatten() {
        let to = dst.join(e.file_name());
        if e.path().is_dir() {
            copy_dir_all(&e.path(), &to)?;
        } else {
            std::fs::copy(e.path(), &to)?;
        }
    }
    Ok(())
}

/// 回滚区的编号（同进程内递增；跨进程用 pid 区分）
fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    (std::process::id() as u64) * 1000 + n
}

/// 把一个目录树读成"相对路径 → 内容"的快照（判据用：回滚后必须与之前**一模一样**）
#[cfg(test)]
fn snapshot(root: &Path) -> std::collections::HashMap<String, Vec<u8>> {
    use std::collections::HashMap;
    let mut out = HashMap::new();
    fn walk(root: &Path, dir: &Path, out: &mut HashMap<String, Vec<u8>>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    walk(root, root, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ieml-draft-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 顺利提交：文件真的写下去了，回滚区**没留下垃圾**
    #[test]
    fn a_clean_commit_writes_everything_and_leaves_no_debris() {
        let base = tmp("ok");
        std::fs::write(base.join("keep.txt"), b"KEEP").unwrap();

        let mut d = Draft::open(&base).unwrap();
        d.plan(Op::CreateDir("mods".into())).unwrap();
        d.plan(Op::WriteFile {
            rel: "mods/a.jar".into(),
            bytes: b"AAA".to_vec(),
        })
        .unwrap();
        d.plan(Op::WriteFile {
            rel: "options.txt".into(),
            bytes: b"lang:zh_cn".to_vec(),
        })
        .unwrap();
        let rep = d.commit().expect("应当提交成功");
        assert_eq!(rep.files_written, 2);
        assert_eq!(d.state(), State::Committed);
        assert_eq!(std::fs::read(base.join("mods/a.jar")).unwrap(), b"AAA");
        assert_eq!(std::fs::read(base.join("keep.txt")).unwrap(), b"KEEP");
        // ★ 回滚区必须清干净（它是仓库/用户目录里的垃圾）
        assert!(!base.join(".ieml").join("drafts").exists(), "回滚区没删掉");
    }

    /// ★★ 中途失败 → 逆序回滚 → **磁盘与动手之前一模一样**
    #[test]
    fn a_midway_failure_rolls_back_to_the_exact_previous_state() {
        let base = tmp("rollback");
        std::fs::create_dir_all(base.join("saves")).unwrap();
        std::fs::write(base.join("saves/level.dat"), b"OLD-SAVE").unwrap();
        std::fs::write(base.join("options.txt"), b"OLD-OPTIONS").unwrap();
        // ★ 制造一个必然失败的步骤：往一个**文件**里面写东西
        std::fs::write(base.join("blocked"), b"i am a file").unwrap();
        let before = snapshot(&base);

        let mut d = Draft::open(&base).unwrap();
        d.plan(Op::WriteFile {
            rel: "options.txt".into(),
            bytes: b"NEW-OPTIONS".to_vec(),
        })
        .unwrap();
        d.plan(Op::WriteFile {
            rel: "mods/new.jar".into(),
            bytes: b"NEW".to_vec(),
        })
        .unwrap();
        d.plan(Op::WriteFile {
            rel: "blocked/child.txt".into(),
            bytes: b"NOPE".to_vec(),
        })
        .unwrap();
        let err = d.commit().expect_err("第三步注定失败");
        assert!(err.to_string().contains("blocked"), "{err}");
        assert_eq!(d.state(), State::Failed);
        assert!(err.rollback_problems.is_empty(), "回滚本身必须干净：{err}");

        // ★ 回到原样：内容一样、且**没有多出任何文件**
        let after = snapshot(&base);
        assert_eq!(before, after, "回滚后必须与动手之前完全一致");
        assert_eq!(std::fs::read(base.join("options.txt")).unwrap(), b"OLD-OPTIONS");
        assert!(!base.join("mods").exists(), "半路建出来的目录也要撤掉");
    }

    /// 被移除的东西是**移进回滚区**（不是删掉），回滚时移回来
    #[test]
    fn removal_is_reversible() {
        let base = tmp("remove");
        std::fs::write(base.join("old.jar"), b"OLD").unwrap();
        std::fs::write(base.join("blocked"), b"file").unwrap();

        let mut d = Draft::open(&base).unwrap();
        d.plan(Op::Remove("old.jar".into())).unwrap();
        d.plan(Op::WriteFile {
            rel: "blocked/x".into(),
            bytes: b"x".to_vec(),
        })
        .unwrap();
        let err = d.commit().expect_err("第二步失败");
        assert!(err.rollback_problems.is_empty(), "{err}");
        assert_eq!(std::fs::read(base.join("old.jar")).unwrap(), b"OLD", "被移除的文件要回来");
    }

    /// ★ 路径越界在**排计划时**就被拒绝（不是等动盘）
    #[test]
    fn path_escapes_are_refused_before_touching_the_disk() {
        let base = tmp("escape");
        let mut d = Draft::open(&base).unwrap();
        for bad in ["../outside.txt", "a/../../b", "/etc/passwd", ""] {
            let r = d.plan(Op::WriteFile {
                rel: bad.to_string(),
                bytes: b"x".to_vec(),
            });
            assert!(r.is_err(), "「{bad}」应当被拒绝");
        }
        // 一条都没进计划 → 提交时什么都不会发生
        let rep = d.commit().unwrap();
        assert_eq!(rep.files_written, 0);
        assert!(!std::env::temp_dir().join("outside.txt").exists());
    }

    /// 复制一整棵树：新文件写下去、**已有同名的不覆盖**（ADR-024 的同一条纪律）
    #[test]
    fn copying_a_tree_skips_existing_files_and_is_reversible() {
        let base = tmp("copy");
        let src = tmp("copy-src");
        std::fs::create_dir_all(src.join("saves/World")).unwrap();
        std::fs::write(src.join("saves/World/level.dat"), b"FROM-SRC").unwrap();
        std::fs::write(src.join("options.txt"), b"SRC-OPTIONS").unwrap();
        std::fs::create_dir_all(base.join("saves/World")).unwrap();
        std::fs::write(base.join("saves/World/level.dat"), b"MINE").unwrap();

        let mut d = Draft::open(&base).unwrap();
        // ★ 空串会被 `resolve` 拒掉（它是"没有路径"）——真正"倒进根目录"用 `.`
        assert!(d
            .plan(Op::CopyTree {
                from: src.clone(),
                to: String::new(),
                skip_existing: true,
            })
            .is_err());
        d.plan(Op::CopyTree {
            from: src.clone(),
            to: ".".into(),
            skip_existing: true,
        })
        .unwrap();
        let rep = d.commit().unwrap();
        assert_eq!(rep.files_written, 1, "只该写 options.txt（level.dat 已存在）");
        assert!(rep.skipped_existing.iter().any(|s| s.contains("level.dat")), "{:?}", rep.skipped_existing);
        assert_eq!(std::fs::read(base.join("saves/World/level.dat")).unwrap(), b"MINE", "不许覆盖");
        assert_eq!(std::fs::read(base.join("options.txt")).unwrap(), b"SRC-OPTIONS");
    }

    /// 提交过一次就不能再提交（状态机），abort 之后也不能再排计划
    #[test]
    fn the_state_machine_is_enforced() {
        let base = tmp("state");
        let mut d = Draft::open(&base).unwrap();
        d.plan(Op::WriteFile {
            rel: "a.txt".into(),
            bytes: b"a".to_vec(),
        })
        .unwrap();
        d.commit().unwrap();
        assert!(d.commit().is_err(), "提交两次应当被拒绝");
        assert!(d
            .plan(Op::WriteFile {
                rel: "b.txt".into(),
                bytes: b"b".to_vec()
            })
            .is_err());

        let mut d2 = Draft::open(&base).unwrap();
        d2.abort();
        assert_eq!(d2.state(), State::Aborted);
        assert!(d2
            .plan(Op::WriteFile {
                rel: "c.txt".into(),
                bytes: b"c".to_vec()
            })
            .is_err());
    }

    /// ★★ 推演阶段的拒绝：**磁盘一个字节都不动**
    #[test]
    fn a_plan_rejected_up_front_does_not_touch_the_disk() {
        let base = tmp("dryrun");
        std::fs::write(base.join("blocked"), b"file").unwrap();
        let before = snapshot(&base);

        let mut d = Draft::open(&base).unwrap();
        d.plan(Op::WriteFile {
            rel: "fine.txt".into(),
            bytes: b"ok".to_vec(),
        })
        .unwrap();
        // 这一步注定失败，但它在**后面**：推演阶段就该拦住整份计划
        d.plan(Op::CreateDir("blocked".into())).unwrap();
        let err = d.commit().expect_err("推演就该拒绝");
        assert!(err.to_string().contains("已经有一个文件"), "{err}");
        assert_eq!(snapshot(&base), before, "推演失败时磁盘必须原样");
        assert!(!base.join("fine.txt").exists(), "前一步也不许写下去");
    }
}
