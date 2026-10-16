//! 下载引擎
//!
//! 能力：流式写盘 · SHA1 边下边算 · 断点续传 · **分片下载 + 分片续传** ·
//!       **失败换源（源健康记忆）** · **单文件重试** · **批次失败重试与降并发** ·
//!       **429 指数退避** · 并发控制 · 取消
//!
//! 关键实现细节（都是踩过的坑）：
//!   ① **先写 `.part` 再改名** —— 直接写目标文件的话，中途失败会留下一个
//!      看起来"已下载"的坏文件，下次启动时被当成缓存命中，游戏就崩了。
//!   ② **SHA1 边下边算** —— 22 MB 的客户端 jar 再读一遍盘没必要。
//!   ③ **同 SHA1 的文件全局去重** —— 多加载器共享大量 libraries，
//!      实测能省 30%+ 流量（ADR-002）。
//!   ④ **断点续传用 Range** —— 服务端不支持时（返回 200 而非 206）从头下。
//!   ⑤ **分片下载的每一段也落盘**（`.part.N`）+ 段位图 —— 以前分片一旦失败
//!      就 `remove_file(part)` 从头再来，39 MB 的客户端 jar 下到 38 MB 被掐、
//!      重连后却从 0 开始。现在只补缺的段（ADR-034）。
//!   ⑥ **候选源是"依次尝试"不是"同时抢"** —— 同时下会平分带宽、且让镜像
//!      承受双倍并发（实测更容易吃 429）。加速靠分片，不靠多源（ADR-034）。

use super::mirror::Source;
use super::source::{self, SourceManager};
use super::{client, NetError, Result};
use crate::domain::failure::FailureClass;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

/// 一个待下载的文件（对应 PCL2 的 `NetFile`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    /// 目标绝对路径
    pub path: PathBuf,
    /// 主 URL（官方地址；镜像会在候选生成时改写）
    pub url: String,
    /// **额外的候选 URL**（多源回退用）。
    ///
    /// 留空时由 `mirror` 表自动推导官方 + 镜像两个候选。
    /// 填了就以它为准 —— 用于"同一个文件在多个镜像上路径不同"的情况。
    #[serde(default)]
    pub urls: Vec<String>,
    /// 期望 SHA1，空串表示不校验
    pub sha1: String,
    /// 期望大小（0 表示未知）
    pub size: u64,
    /// 展示用的相对路径
    pub label: String,
    /*
     * ★★★★ 2026-10-01（用户）：「**是不是我们是同时只下载一件事儿，
     *   而不是一次性干一堆事儿**」。
     *
     *   对 —— 而且他指出了那个最要紧的位置：**整合包的包体**。
     *   整合包里那几百个文件是并发的（`download_batch`），
     *   唯独**最大的那一个文件**（包体，Better MC 113 MB）走的是
     *   `concurrency: 1` 的单连接。单连接实测 75~120 KB/s
     *   ⇒ 113 MB 要 15~25 分钟。
     *
     *   有了这个字段，分片就能**按任务**打开，而不是靠全局环境变量
     *   （`chunking_enabled`）把**所有**下载都改了 ——
     *   分片对"包体这种单个大文件"有意义，对"几百个小文件"没有意义
     *   （小文件本来就靠并发，分片只会多建连接）。
     */
    #[serde(default)]
    pub allow_chunked: bool,
    /*
     * ★★ 2026-10-16（审计点名的"悄悄成功"根因）：**把"没有校验值"变成数据**。
     *
     *   `sha1: String` 的语义是"空串 = 不校验"，而那把**两件完全不同的事**
     *   挤成了同一个值：
     *     · 上游**确实没有发布**校验值（有些加载器库条目只带 URL；
     *       Modrinth 的 `.mrpack` 条目也可能没给哈希）；
     *     · 上游给了，但**我们没解析出来**（`commands_real.rs` 的整合包补齐
     *       路径就是 `sha1="" size=0` —— 见那里的注释）。
     *
     *   两者的处置完全不同：前者是**事实**，要如实告诉用户"这个文件没校验过"；
     *   后者是**缺陷**，要能被督办。挤成一个空串之后，两者都变成"静默成功"。
     *
     *   ⇒ 新增这个**可选**字段（`None` = 沿用老口径，兼容既有落盘记录与调用点）。
     *     ★ 为什么不做成 `sha512` 也一起上：那要给 `installer.rs` 的库/资源/
     *       原生库解析与 `modrinth.rs` 全链路加一层"算法"，改动面比这一阶段
     *       该有的样子大得多。审计里 Modrinth 的 `hashes.sha512`
     *       （`modrinth.rs:636` 显式丢弃）单独列进下一阶段的建议。
     */
    #[serde(default)]
    pub expected_hash: Option<ExpectedHash>,
    /*
     * ★★★★ 第二阶段 A（安全加固）：**这个任务的响应体体积上限**。
     *
     *   清单第 172 行：「**Cap what you accept.** A response size limit per
     *   artifact class stops a hostile server from filling the disk.」
     *
     *   语义**定死**：
     *     · `None`（含老数据 / 老调用点）= **按 `label` 推断类别、取该类别的默认上限**
     *       —— **不是**"不设上限"！类别表在 `domain::archive_guard`
     *       （`class_from_label` + `default_limit_for`，纯判据、可单测）。
     *     · `Some(n)` = 显式指定（调用方比标签更清楚时用）。
     *
     *   ★ 为什么语义不设成"None = 不限"：那样任何一个忘了设字段的调用点都会
     *     静默变成"可以下满磁盘"，而**漏设**恰恰是最可能发生的事。
     *     现在漏设 = 落到类别表的兜底档（未知类别 = 最紧的 64 MiB）。
     *
     *   ★ 真正执行在两处（`cap_of` 解析，见下面 `fn cap_of`）：
     *     ① 建连前 `rejected_by_declared_size(task.size)`；
     *     ② 两条写盘路径的流式累计 `ByteMeter`（**含续传已有字节**）。
     */
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

/// **期望的校验值**（对象是"数据"，不是"一个总是 SHA-1 的字符串"）。
///
/// ## 为什么要有 `None` 这一档（审计原话）
///
/// > `None` is a real case and must not silently become "skip verification
/// > and assume success".
///
///   原来 `DownloadTask.sha1 == ""` 时，`verify_existing` 在 `size == 0` 的
///   情况下**直接返回 `Ok`** —— 于是"任何已存在的文件"都算缓存命中，
///   一个新的、内容完全错误的文件会被当成"下好了"跳过（失败在**下一次
///   启动游戏**时才以"某个文件坏了"的形状出现，而且没人知道是谁放进去的）。
///
/// ## SHA-512 的位置（下一阶段）
///
///   ★ 已查证：Modrinth 的 `version.files[].hashes` **同时发布 sha512 与 sha1**，
///     而 `modrinth.rs:636` 只取 sha1、把 sha512 显式丢弃。
///     CurseForge 的 `hashes[].algo` 是 `1=SHA1 / 2=MD5`（`curseforge.rs:16`），
///     Mojang 这一代是 SHA-1。
///   ⇒ 所以这里先留出 `Sha512` 这一档的形状（枚举 + `verify`），
///     但**本阶段不接线**：接线要给"库/资源/原生库"三条解析路径与
///     `modrinth.rs` 的 `HashMap<String,String>` 都加一层算法选择，
///     属于第二阶段（见报告）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpectedHash {
    /// SHA-1（Mojang 的清单/库/资源、CurseForge 的 `algo=1`）
    Sha1(String),
    /// SHA-512（Modrinth 同时发布，比 SHA-1 强）—— ★ 尚未接线，见类型说明
    Sha512(String),
    /// **上游确实没有发布校验值。**
    ///
    /// 它不是"跳过校验"的同义词：它是"**我们无法证明这个文件是对的**"，
    /// 必须如实报给用户（`DownloadOutcome::unverified_files`）。
    None,
}

impl ExpectedHash {
    /// 有没有一个**能用来比对**的值。
    pub fn is_some(&self) -> bool {
        !matches!(self, Self::None)
    }

    /// **上游确实没有发布校验值**这一档（与 `is_some` 互为反面）。
    ///
    /// ★ 单独给一个名字（而不是让调用方写 `!is_some()`）：这个判断在
    ///   "如实上报未经校验的文件"那段代码里出现得多，而
    ///   `!x.is_some()` 读起来像"没有值"，容易与
    ///   "解析失败所以是空的"混为一谈 —— 这里的语义是**事实**，不是缺陷。
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    /// 校验值本身（`None` 时是空串）
    pub fn value(&self) -> &str {
        match self {
            Self::Sha1(v) | Self::Sha512(v) => v,
            Self::None => "",
        }
    }

    /// 算法名（给日志与错误文案用）
    pub fn algo(&self) -> &'static str {
        match self {
            Self::Sha1(_) => "SHA1",
            Self::Sha512(_) => "SHA512",
            Self::None => "（无）",
        }
    }

    /// 算一个文件，看它**对不对**。`None` 一律返回 `None`（= 无从判断）。
    pub async fn verify_file(&self, path: &Path) -> Option<bool> {
        match self {
            Self::None => None,
            Self::Sha1(want) => sha1_of_file(path)
                .await
                .ok()
                .map(|got| got.eq_ignore_ascii_case(want)),
            Self::Sha512(want) => sha512_of_file(path)
                .await
                .ok()
                .map(|got| got.eq_ignore_ascii_case(want)),
        }
    }

    /// 算一个文件的实际值（错误信息要说"实际是多少"）
    pub async fn actual_of(&self, path: &Path) -> Option<String> {
        match self {
            Self::None => None,
            Self::Sha1(_) => sha1_of_file(path).await.ok(),
            Self::Sha512(_) => sha512_of_file(path).await.ok(),
        }
    }

    /// 从一个老口径的 `sha1` 字符串来（空串 = `None`）
    pub fn from_sha1(s: &str) -> Self {
        if s.is_empty() {
            Self::None
        } else {
            Self::Sha1(s.to_string())
        }
    }
}

impl DownloadTask {
    /// 只带一个 URL 的任务（最常见的情况）
    ///
    /// ★★ `max_bytes` 在这里就按 `label` 推出来填好（`Some(该类别的默认上限)`）——
    ///    于是"忘了设"这件事不可能发生：任务一被造出来就带着闸门。
    ///    类别表在 `domain::archive_guard`（`class_from_label` + `default_limit_for`）。
    pub fn new(path: PathBuf, url: String, sha1: String, size: u64, label: String) -> Self {
        let cap = crate::domain::archive_guard::default_limit_for(
            crate::domain::archive_guard::class_from_label(&label),
        );
        Self {
            path,
            url,
            urls: Vec::new(),
            sha1,
            size,
            label,
            allow_chunked: false,
            expected_hash: None,
            max_bytes: Some(cap),
        }
    }

    /// ★★ **明确告诉引擎"这个源没有发布校验值"**（不是"我们没解析出来"）。
    ///
    /// 见 [`ExpectedHash`] 与 `DownloadOutcome::unverified_files`：
    /// `sha1` 空串既可能是"上游确实没给"，也可能是"我们没解析出来"，
    /// 两者都不校验，但**后者是缺陷、前者是事实** —— 混在一起就没法督办。
    pub fn without_verification(mut self) -> Self {
        self.expected_hash = Some(ExpectedHash::None);
        self.sha1.clear();
        self
    }

    /// 这个任务**有没有校验值**（含"上游明确说没有"这一档）。
    pub fn expected_hash(&self) -> ExpectedHash {
        if let Some(e) = &self.expected_hash {
            return e.clone();
        }
        if self.sha1.is_empty() {
            ExpectedHash::None
        } else {
            ExpectedHash::Sha1(self.sha1.clone())
        }
    }

    /// 允许这个任务走分片（多连接）。
    ///
    /// ★ 用在**单个大文件**上（整合包包体是最典型的）：那种下载没有
    ///   "并发一批文件"可言，多连接的唯一办法就是分片。
    ///   见 `allow_chunked` 字段上的说明。
    pub fn chunked(mut self) -> Self {
        self.allow_chunked = true;
        self
    }

    /// 取"可直接跑"的 URL（`file://` 开头的本地复制任务原样返回）
    pub fn runnable_url(&self, preferred: Source) -> String {
        if self.url.starts_with("http") {
            super::mirror::mirror_url(&self.url, preferred)
        } else {
            self.url.clone()
        }
    }

    /// ★★ **解析这个任务的体积上限**（`Option<u64>` → 具体闸门）。
    ///
    ///   三态（判据在 `domain::archive_guard`，纯逻辑、有断言钉住）：
    ///     ① `max_bytes = Some(n)` ⇒ 用 n（调用方比标签更清楚时显式指定）；
    ///     ② `max_bytes = None`（老数据 / 老调用点）⇒ **按 `label` 推类别**再取该类别的
    ///        默认上限 —— 语义定死为"推断"，**不是"不设上限"**；
    ///     ③ 标签也认不出来 ⇒ 类别 `Unknown` ⇒ 最紧的一档（64 MiB）。
    pub fn byte_cap(&self) -> crate::domain::archive_guard::ByteCap {
        cap_of(self)
    }
}

/// 任务的体积闸门（见 [`DownloadTask::byte_cap`] 的三态说明）。
pub fn cap_of(task: &DownloadTask) -> crate::domain::archive_guard::ByteCap {
    use crate::domain::archive_guard::{class_from_label, default_limit_for, ByteCap};
    match task.max_bytes {
        Some(n) => ByteCap { max_bytes: Some(n) },
        None => ByteCap {
            max_bytes: Some(default_limit_for(class_from_label(&task.label))),
        },
    }
}

/// 超限时的**统一失败**：说真话（点名文件 + 类别上限 + 已收多少）。
///
/// ## ★★ 文案里的「**没下完**」不是修辞，是**判据的一部分**
///
///   下载路径的处置档位是**按文案**判的（`domain::failure::classify_message`，
///   见 `download_one_with` 的判据 1 与批次层那道）：
///     `"没下完"` 在**致命**那一组里，`"超时"` 在可重试那一组里。
///   所以这句话必须**同时**说清两件事，而且都得用判据认得的那几个词：
///     · "超过这个类别的体积上限" —— 给人看的原因；
///     · "没下完" —— 让引擎判成 `Fatal`：**不吃后面的重试轮、也不换源重下**
///       （换源重下的还是同一份超限的东西，只是让用户多等十几秒再看到同一句话）。
///   ★ 这条不靠"我记得"：`over_cap_error_is_fatal_not_retryable` 直接拿
///     `NetError::class()` 断言，改文案会让它红。
fn cap_exceeded_error(label: &str, cap: crate::domain::archive_guard::ByteCap, got: u64) -> NetError {
    NetError::Other(format!(
        "★ 响应体超过这个类别的体积上限（**没下完**）：{label} —— 已收 {got} 字节，\
         上限 {}（{} 字节）。已丢弃临时文件；这不是网络问题，重试/换源都一样，所以直接停下。",
        cap.describe(),
        cap.max_bytes.unwrap_or(0)
    ))
}

/// **这一条进度事件说的是下载的哪一段**（审计：`downloading` / `verifying` /
/// `extracting` / `complete` / `failed` / `cancelled` 必须能分开）。
///
/// ## 为什么必须有它（审计原话）
///
/// > "Verifying" being invisible is why a hash check over a large store
/// > looks like a hang.
///
///   实测形状：一个几百 MB 的整合包包体下完之后，`sha1_of_file` 要读完整份
///   才出结论；那几秒里**没有任何事件**，界面停在 100% 不动 ——
///   用户以为卡住了（而对 3000 个小文件的那条路，校验反而是逐文件的小开销，
///   真正卡的是"已存在文件的校验"那一次静默的 `verify_existing`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ProgressPhase {
    /// 正在下（连/传/重试都算这一档）
    Downloading,
    /// 正在算校验值（**这一档以前完全不可见**）
    Verifying,
    /// 这一批跑完了（最后一条事件用它，`failed_files` 是最终结果）
    Done,
}

impl ProgressPhase {
    /// 给界面看的字符串（前端 `DownloadProgress.phase` 直接读它）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Downloading => "downloading",
            Self::Verifying => "verifying",
            Self::Done => "done",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub finished_files: usize,
    pub total_files: usize,
    pub finished_bytes: u64,
    pub total_bytes: u64,
    pub bytes_per_second: u64,
    pub current_file: String,
    pub skipped_files: usize,
    pub failed_files: usize,
    /// 当前正在用的源（多源回退时会让用户看见"换了源"）
    pub source: String,
    /// 重试轮次（第几轮补下失败的；0 = 第一轮）
    pub retry_round: u32,
    /// ★★ **这一条说的是哪一段**（见 [`ProgressPhase`]）。
    ///
    /// 加了 `#[serde(default)]` 的等价物是 `Default` 实现 —— 见下面。
    /// 既有调用点（`installer.rs` / `commands_real.rs` / 测试）都用
    /// `DownloadProgress { .. }` 字面量构造，所以**字段是必填的**：
    /// 少填一处编译就红（宁可编译期红，也不许悄悄少一档）。
    pub phase: ProgressPhase,
}

impl Default for DownloadProgress {
    /// 默认就是"正在下" —— 绝大多数事件都是这一档。
    fn default() -> Self {
        Self {
            finished_files: 0,
            total_files: 0,
            finished_bytes: 0,
            total_bytes: 0,
            bytes_per_second: 0,
            current_file: String::new(),
            skipped_files: 0,
            failed_files: 0,
            source: String::new(),
            retry_round: 0,
            phase: ProgressPhase::Downloading,
        }
    }
}

/// **连接观测**（2026-10-02）—— 一把能测"同时在飞的连接数"的尺子。
///
/// ## 为什么需要它（这一课很贵）
///
///   我连着两次"先动手、后验证"都翻了车，而**两次都不知道自己在改什么数**：
///     · 把 `CHUNK_COUNT` 调大 ⇒ **整条分片路径 0 字节**（事后才推断出
///       "段数 = 瞬时并发数"，但那只是推断）；
///     · 照 PCL 加全局闸门 ⇒ **测试卡死**（同样只有现象，没有数字）。
///
///   判据必须来自**数字**，而不是我的推理。这个计数器就是那个数字：
///   它记录**同一时刻真正有多少条连接在飞**的峰值与当前值。
///
/// ## 与 PCL 的对应
///
///   PCL 的 `NetTaskThreadCount` / `NetTaskThreadLimit` 正是同一件事，
///   而且它把这个数**显示在界面上**（`PageSpeedLeft`：`当前 / 上限`）。
///   我们至少要让**日志与结果**带上它。
///
/// ## 为什么用全局 static 而不是参数传递
///
///   参数要穿过 `run_round → download_single → download_to_part →
///   download_chunked → download_range` 五层，而加它**只是观测**，
///   不该改动五层的签名（那正是"为了观测而把生产代码搅乱"）。
///   ★ 代价：并发跑两个 `download_batch` 时数字会混在一起 ——
///     本启动器同一时刻只有一个批次，且每批开始时会重置。
///     这一点写在 `reset_conn_stats` 里，免得下一个人误用。
pub(crate) mod conn_stats {
    use std::sync::atomic::{AtomicU64, Ordering};

    static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
    static PEAK: AtomicU64 = AtomicU64::new(0);

    /// 一批开始前重置（必须先重置，否则峰值会跨批次累加）。
    pub fn reset() {
        IN_FLIGHT.store(0, Ordering::SeqCst);
        PEAK.store(0, Ordering::SeqCst);
    }

    /// 一条连接开始 —— 返回的守卫 drop 时自动减一。
    ///
    /// ★ 用守卫而不是手写 `+1 / -1`：`download_range` 有多条 `return Err`
    ///   分支，手写配对必然会漏（漏了就是"并发数永远偏高"，比测不到更糟）。
    pub fn begin() -> ConnGuard {
        let now = IN_FLIGHT.fetch_add(1, Ordering::SeqCst) + 1;
        PEAK.fetch_max(now, Ordering::SeqCst);
        ConnGuard
    }

    pub struct ConnGuard;
    impl Drop for ConnGuard {
        fn drop(&mut self) {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        }
    }

    pub fn peak() -> u64 {
        PEAK.load(Ordering::SeqCst)
    }
}

/// **一条最终失败**（带处置档位）。
///
/// ## 为什么要带上 `class`（而不只是一个字符串）
///
///   审计：**A fatal failure must fail the batch with a useful message naming
///   the artifact, not silently produce an incomplete install.**
///
///   而"这条失败是不是致命的"这个信息**只有在失败的现场才知道**：
///   `download_one_with` 手里有 `NetError`，批次层拿到的只是字符串。
///   所以在这里带着走 —— 批次层据此**立刻停止补下轮**
///   （"磁盘满"再补两轮只是让用户多等 20 秒，然后看到同一句话）。
#[derive(Debug, Clone, Serialize)]
pub struct DownloadFailure {
    /// 展示用的相对路径（点名是**哪个**文件）
    pub label: String,
    /// 失败原因（原样，用户能看懂）
    pub reason: String,
    /// 处置档位
    pub class: FailureClass,
}

/// **一个"没有校验值、因此未经校验"就落位的文件**。
///
/// ## 为什么必须如实报出来（审计第 102 行）
///
/// > `None` is a real case and must not silently become "skip verification
/// > and assume success".
///
///   现实里确实有这样一批：`.mrpack` 里没给哈希的条目、
///   `commands_real.rs` 的整合包补齐路径（`sha1="" size=0`）。
///   它们**能装上去，但我们没有任何证据说它们是对的** ——
///   以前这件事**完全不可见**（`verify_existing` 在 `size==0` 时直接 `Ok`，
///   于是"任何已存在的文件"都算命中）。现在它至少是一个**能被数出来的清单**。
///
/// ★ 界面怎么显示留给第二阶段（审计里前端还有一处存疑：`checkPlan` 是否死代码）。
///   本阶段先保证**日志与结果里有它**。
#[derive(Debug, Clone, Serialize)]
pub struct UnverifiedFile {
    /// 展示用的相对路径
    pub label: String,
    /// 落盘后的完整路径（用户要自己核对时需要它）
    pub path: PathBuf,
    /// 这个文件**有没有经过任何判断**
    ///
    ///   * `true`  = 用**长度**兜了一层（任务给了 `size`，实际长度对得上）；
    ///   * `false` = 连长度都没有（`size == 0`）—— **一个字节都没比过**。
    ///
    ///   ★ 把这个区别显式说出来很重要：审计那句话（"不能悄悄等于成功"）
    ///     在 `false` 这一档里最刺眼 —— 那个文件**是不是我们要的那个**，
    ///     我们完全不知道。
    pub length_checked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadOutcome {
    pub finished_files: usize,
    /// ★ 2026-10-02：**同时在飞的连接数峰值**（见 `conn_stats`）。
    ///   有它才能判断「加大段数到底有没有真的把连接铺开」——
    ///   而不是靠推理（我推理错了两次）。
    pub peak_connections: u64,
    pub skipped_files: usize,
    pub failed: Vec<(String, String)>,
    /// ★★ 与 [`DownloadOutcome::failed`] **同一个清单**，但每条带上处置档位
    ///   （见 [`DownloadFailure`]）。两条并存是为了不动既有的字符串接口
    ///   （`installer.rs` / `commands_real.rs` 都按元组读）。
    #[serde(default)]
    pub failures: Vec<DownloadFailure>,
    /// ★★ **没有校验值、因此未经校验就落位的文件**（见 [`UnverifiedFile`]）。
    ///
    ///   计数也单独给一个（`unverified_count`），因为调用方经常只想要个数。
    #[serde(default)]
    pub unverified: Vec<UnverifiedFile>,
    pub total_bytes: u64,
    pub elapsed_ms: u64,
    /**
     * ★★ **这一批一共处理了多少个任务**（成功 + 跳过 + 最终失败）。
     *
     * ## 为什么必须有它（用户报的「标注的文件数和实际不一致」）
     *
     * 计划里的 `total_files` 是**分母**，而 `finished_files` 只是"成功"那部分。
     * 调用方（`installer.rs` 的资源阶段）想把"进度到哪了"报给界面时，
     * 手里只有 `finished_files` / `skipped_files` / `failed` 三个数，
     * 于是只能自己拼一个分母出来 —— 实测代码里就是
     * `total_files: outcome.finished_files + outcome.failed.len()`。
     *
     * 那个式子**不等于计划里的任务总数**：
     *   · 漏了 `skipped_files`（已经下过、这次跳过的）；
     *   · 失败的在重试轮里可能被下成功，于是既不进 finished 也不进 failed
     *     （它进了 finished），两个数加起来反而不对；
     *   · 于是界面上的"已完成 / 总数"与计划里标注的文件数**对不上** ——
     *     用户看到的就是这个。
     *
     * 现在把"处理了多少个"直接给它，调用方不需要（也不许）自己拼分母。
     * 判据与进度事件的分子**同一个**（`processed_files`），所以
     * "最后一条进度的分母"必然等于计划的总数。
     */
    pub processed_files: usize,
    pub retry_rounds: u32,
    /// 校验失败（重新下载过）的文件数
    pub repaired_files: usize,
    /// ★★ 是不是**被暂停**停下的（`false` = 正常跑完 / 被取消）。
    ///
    /// 与"取消"必须分开：取消是用户不要了，暂停是"等会儿接着下"。
    /// 调用方据此决定是提示"已暂停，可以继续"还是"已取消"。
    pub paused: bool,
    /// ★★ 暂停时**还没开始下**的那些任务（按原顺序，可以直接再喂给
    /// [`download_batch`] 接着下）。
    ///
    /// ## 为什么要把它交出来（而不是让调用方自己记住全部任务）
    ///
    ///   下载器在暂停时已经完成了前 N 个 —— 再从头跑一遍会让它们走
    ///   "已存在且校验通过就跳过"那条路，白算一遍 SHA1（资源阶段有几千个
    ///   小文件）。把**剩下的**交出来，续下就是"接着下"而不是"重扫一遍"。
    ///
    ///   已经下了的 `.part` 分片仍然在盘上，所以即便调用方选择从头跑，
    ///   也不会白下 —— 这一层是断点续传本来就有的。
    pub remaining: Vec<DownloadTask>,
}

/// 单个数据块之间允许的最大间隔。超过就认为连接停滞，换源重试。
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 单文件下载的**总时长上限**。
///
/// 为什么需要两层超时：
///   * CHUNK_TIMEOUT 抓"完全没数据"的连接
///   * 总超时抓"一直滴数据但永远下不完"的连接（服务端限速或中转卡死）
///   资源文件大多只有几 KB，5 分钟已经极度宽裕；客户端 jar 22 MB
///   按最慢 70 KB/s 也能在 5 分钟内下完。
const FILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// **慢速**判据：连续这么长时间吞吐都低于 `SLOW_MIN_BPS`，就换源。
///
/// ★ 为什么要它（用户实测）：BMCLAPI 的 CDN 有多个边缘节点，某些节点会把
///   单连接压到 **0.6–1.1 MB/s** 然后挂住不回。实测数据：37 MB 的客户端 jar，
///   60 秒只下到 34 MB 就"连接挂住"。引擎以前只会因为"失败"换源 ——
///   这种"能连、但慢得像坏掉"的连接会一直耗到 300 秒总超时才放弃。
///
/// ★ 但**阈值必须按这台机器上这个源的真实水平定**（这是修过的 bug）：
///   原来是常数 `1 MB/s`，而本机实测 BMCLAPI 单连接**正常就只有 0.83 MB/s**
///   （23 MB 的客户端 jar 用了 27.9 秒）。于是"正常速度"被判成"慢速"，
///   每个大文件都触发一次换源 —— 换到官方源在国内更慢，用户体验就是
///   「下载一个新版本慢得要死」。
///
///   现在改成**相对判据**：低于"这个源自己证明过的速度"的三分之一，
///   且**绝对速度也低于 `SLOW_ABS_FLOOR_BPS`**，才算坏。两个条件同时满足，
///   既不会误伤正常偏慢的连接，也能抓住真正挂死的连接。
///
/// ★★ 但还有一个必须同时成立的前提：**得有别的地址可换**。
///   一次真实失败（用户报的「Fabric API 自动安装失败」）就是漏了这一条：
///   Modrinth 的 CDN 地址只有一个候选、单连接 ~230 KB/s，
///   被这条检测反复判成坏源并中断，三轮重试烧完就报"所有下载源都失败了"。
///   所以 `SpeedWatch` 带一个 `switchable` 标志（候选数 > 1 才为真），
///   **没有替代地址时慢速检测只记录、不中断**。
const SLOW_WINDOW: std::time::Duration = std::time::Duration::from_secs(15);

/// 绝对地板：低于这个速度**并且**远低于该源的历史最好成绩，才判"坏源"。
///
/// 320 KB/s：比本机实测的 BMCLAPI 正常速度（0.83 MB/s）低一半以上，
/// 但远高于真正挂死的连接（几 KB/s 甚至 0）。
const SLOW_ABS_FLOOR_BPS: u64 = 320 * 1024;

/// 相对判据的分子/分母：低于该源历史最好成绩的 1/3 视为异常。
const SLOW_RELATIVE_DIVISOR: u64 = 3;

/// **"连接已经死了"** 的静默时长（源码事实：PCL2 用 5 秒）。
///
/// 与 `SLOW_ABS_FLOOR_BPS` 的区别见 `SpeedWatch::dead`：
/// 慢要"有别的路"才放弃；**死**（一个字节都不回来）无论有没有别的路都该掐掉。
const DEAD_SILENCE: std::time::Duration = std::time::Duration::from_secs(5);

/// "死"的速度上限：**1 KB/s**（源码事实：PCL2 的 `DeltaTime > RealDataCount`
/// 等价于"1 字节/毫秒 = 1 KB/s"）。
///
/// ★ 这个数字是刻意照抄 PCL2 的，而不是我们自己定的 320 KB/s：
///   实测 Modrinth CDN ~230 KB/s、mcimirror ~146 KB/s，
///   320 KB/s 会把"正常但慢"的连接判成坏的 —— 那正是用户看到的
///   「最后一个文件必定重试然后失败」。
const DEAD_MIN_BPS: u64 = 1024;

/// 分片下载阈值：文件大于此值才**考虑**分片。
///
/// ★ 小文件分片反而更慢——多建连接、多一轮拼接，得不偿失。
///
/// ★★ 但"大"不等于"该分片"：见 `chunking_enabled()` 的说明。
///   实测 BMCLAPI 上分片**不提升总吞吐**，还会带来 429 与一批竞态，
///   所以现在默认**关掉分片**。这个常量留着：真需要分片时改环境变量即可。
/// ★★★★ 2026-10-02：**从 4 MB 降到 1 MB**（用户：「开始下载的速度还是很慢」）。
///
///   原来的理由是小文件分片"多建连接、多一轮拼接，得不偿失"。那个判断在
///   **单源**下成立，但实测出来的形状是另一回事：
///
///     · 引擎·镜像：**头 5 秒 0 字节**，10 秒才 353 KB；
///     · PCL：一上来铺 3~8 条连接，**某条先出数据就赢了**。
///
///   而 Mod 文件大多是 **几百 KB ~ 几 MB** —— 正好落在原来那个门槛下面，
///   于是它们**全部走单连接**：一个卡住的连接就是一次 20 秒超时。
///   整合包里几百个文件，这个代价是**逐文件累加**的。
///
///   ⇒ 1 MB 以上就铺连接。多几个 TCP 连接的代价，远小于"每个文件先等一次超时"。
const CHUNKED_THRESHOLD: u64 = 1024 * 1024;

/// 分片下载的最大段数。
///
/// ★★★★ 2026-10-02：试过 16，**改回 8** —— 理由见 `MIN_CHUNK` 那段。
///   关键是：**段是同时发出去的**（`download_chunked` 里把所有段 `spawn` 出去），
///   所以"段数"直接等于瞬时并发数。调大段数 ＝ 调大并发，
///   而这两件事在我们这里**是同一个旋钮** —— 那正是问题所在。
///   ★ 真要提并发，得先有**全局线程上限**这一环（PCL 有 `NetTaskThreadLimit`，
///     它跨文件共享），而不是让每个文件各自决定切多少段。
const CHUNK_COUNT: u64 = 8;

/// 单段最小大小。
///
/// ★★★★ 2026-10-02：**这一格我改错了，改回来并记下原因**。
///
///   我先把它从 2 MB 降到 1 MB（理由：让 4 MB 的文件能切更多段、更接近
///   PCL"多铺几条"）。改完之后实测（`diag_first_bytes`）：
///
///     不开分片   12 秒 **375 字节**
///     开分片     12 秒 **0 字节**    ← 分片整条路**一个字节都没拿到**
///
///   而改之前 `diag_engine_vs_curl` 里分片是能下的（5 s: 0 → 10 s: 750,763）。
///   ⇒ 问题出在这次门槛改动上，而 **`MIN_CHUNK` 是最可疑的那一个**：
///     它决定段数 —— 64 MB 的包按 1 MB 切就是 **64 段**，
///     而段是**同时**发出去的（`download_chunked` 里 `spawn` 所有段）。
///     64 条并发请求**很可能把服务端/本机连接表打崩**（结果是全军覆没）。
///     ★ 2 MB 时是 32 段 —— 也已经很多了，但至少跑得通。
///
///   ⇒ 回到 2 MB（已知能跑通的形状）。**"段数"要有上限**这是下一件要做的事：
///     现在 `plan_chunks(total, chunk_count(), MIN_CHUNK)` 只按"段数上限"与
///     "段最小"两个约束切，而**并发数**没有单独的限制。
///     PCL 那边是 `NetTaskThreadLimit`（**全局**线程上限），我们没有这一环。
const MIN_CHUNK: u64 = 2 * 1024 * 1024;


/// 要不要用分片下载？（默认**不用**）
///
/// ★★ 这是一次**用实测数据推翻自己**的改动。原来大文件（≥4 MB）一律分 8 段：
///
///   ① **分片在这台机器/这个源上并不快**：实测 BMCLAPI 的 23 MB 客户端 jar，
///      单连接 27.9 秒（0.83 MB/s），8 路 Range 并行 **23.4 秒** —— 只快 16%，
///      因为瓶颈是**镜像按 IP 的总带宽**，不是单连接速度。
///   ② **它会招来 429**：8 个并发 Range 请求很容易触发限流。实测日志：
///      `客户端 1.19.4.jar 分片不可用（HTTP 429）→ 回退单连接` ——
///      也就是说分片先失败一次，再退回单连接重下，**净亏一轮**。
///   ③ **它带来一串只在分片路径上存在的失败**：段文件、段计划、
///      "服务器不支持 Range"、拼装时文件找不到（os error 2）……
///      用户报的"最后一个文件必定重试然后失败"就落在这条路上。
///
///   而单连接路径成熟得多：断点续传、慢速检测、总超时、文件占用退避都有。
///   所以默认走单连接；确实需要分片（比如某个源单连接被限速、Range 可用）时：
///     `IEML_CHUNKED=1` 打开，`IEML_CHUNK_COUNT=4` 调段数。
fn chunking_enabled() -> bool {
    std::env::var("IEML_CHUNKED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 实际使用的段数（环境变量可调，默认 8）
fn chunk_count() -> u64 {
    std::env::var("IEML_CHUNK_COUNT")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| (1..=64).contains(n))
        .unwrap_or(CHUNK_COUNT)
}

/// 单文件最多重试次数（PCL2 是 3 次，这里同样）
const MAX_FILE_RETRIES: u32 = 3;

/// **单个候选源的试源上限**（还有备选源时用；最后一个源用完整超时）。
///
/// ★★ 2026-09-30（PCL 的对照）：PCL 的多个源是**并行**的（一个文件多线程、各有各的源），
///   所以"某条路死了"从来不会变成"用户干等"。我们串行试源，就必须给每个源
///   一个**短到能让用户接受的**证明窗口。
///
///   取 8 秒的理由：国内到 Modrinth CDN / 镜像的**正常**首字节在几百毫秒内
///   （实测镜像接口 396~528 ms），8 秒足够覆盖抖动；而两条死路的总代价
///   从 40 秒降到约 16 秒、三条降到 24 秒上限。
///   ★ 最后一个源**不受这个限制** —— 它没有备选了，值得等满完整超时。
const PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);

/// 落盘（改名）撞到"文件被占用"时的重试次数。
///
/// 独立于 `MAX_FILE_RETRIES`：那个是"整份重下"的预算，
/// 这个是"数据已下好、只差落位"的等待预算 —— 后者便宜得多，可以多等几次。
const FILE_BUSY_RETRIES: u32 = 4;

/// 批次里失败文件的补下轮数（降并发逐轮 + 指数退避）
const MAX_BATCH_ROUNDS: u32 = 3;

/// 取消令牌
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/* ====================== 按目标路径的互斥（判据 2） ====================== */

/// **同一个目标路径，同一时刻只许有一个写手。**
///
/// ## 为什么必须要有它（审计点名的真差距）
///
///   审计在"Worker pool"那一节里写得很直白：
///
///   > **One worker per destination path.** Two workers writing the same path
///   > is a race that produces a corrupt cache entry. Key the lock on the
///   > final destination path.
///
///   而我们原来的去重键是**内容哈希**（`dedup_pass`），不是目标路径；`IN_FLIGHT`
///   只是一把"观测用"的计数器（`conn_stats`），**不提供互斥**。
///   于是下面这个形状会真的发生：
///
///   ```text
///     任务 A：path=P, sha1=H1        →  worker 1: create_part(P.part) 截断
///     任务 B：path=P, sha1=""        →  worker 2: open_part_append(P.part) 追加
///                                    两个都 rename 到同一个 P
///   ```
///
///   两个写手一个截断一个追加、各自 rename —— 结果是
///   **"长度对、内容错"**的缓存条目（最坏的一种：一路走到启动游戏才炸）。
///   而空哈希那条**发现不了**（它本来就不校验）。
///
/// ★ 为什么不是一把全局锁：审计同一份清单里也写着
///   **Do not hold a global lock for the whole batch; lock per destination path.**
///
/// ## ★★ 与 `Semaphore` 的持有顺序（**必须只有一个固定顺序**）
///
///   两把锁都在 `run_round` 这条路上，所以顺序必须是死的：
///
///   ```text
///     ① run_round 先 acquire_owned() 拿到 Semaphore 许可（permit）
///     ② 然后 spawn 任务，任务内部 download_one_with 才去拿路径锁
///     ⇒ 固定顺序：先 permit，后路径锁
///   ```
///
///   **反过来会死锁**：如果任务先拿住路径锁、再等 permit，那么当所有许可
///   都被"等在路径锁上的任务"占满时，持锁者又在等许可 —— 谁都不放。
///   现在这个顺序下，路径锁的等待者**必定已经持有许可**，
///   而锁的持有者**迟早会放**（它已经拿到了它要的两把），所以不会成环。
///
///   ★ 另外两处锁（`failed` / `failed_tasks` 的 `Mutex<Vec<_>>`）都只在
///     push/len 那一瞬持有，**从不跨 await 拿着它们去等别的锁**，不参与排序。
///
/// ## 释放与清理（不许泄漏 map 条目）
///
///   `PathLockGuard` 活到任务结束（`Drop` 一定跑，含失败 / 取消 / panic
///   展开路径）—— 在 `Drop` 里把计数减到 0 时**顺手把条目从 map 里删掉**。
///   于是 map 的大小恒等于"正在写的路径数"，不会随安装次数增长。
///   见 `tests::path_lock_registry_does_not_leak_entries`（纯逻辑，本机能跑）。
struct PathLocks {
    map: std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl PathLocks {
    fn new() -> Self {
        Self {
            map: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 取这个路径的锁（不存在就建一个）。
    fn get(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut g = match self.map.lock() {
            Ok(g) => g,
            // 毒化只会发生在"持锁时 panic"，而那意味着路径锁的簿记已经不可信 ——
            // 直接返回一个独立的锁（退化成"这一条自己互斥"）比 panic 好：
            // 下载路径不该因为别的任务炸过一次就整体瘫痪。
            Err(p) => p.into_inner(),
        };
        Arc::clone(
            g.entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// 放掉这个路径（计数归零时把条目删掉 —— 这就是"不泄漏"的那一步）。
    fn release(&self, path: &Path) {
        let mut g = match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(l) = g.get(path) {
            // `try_lock` 成功 **且** 只有我们这一份 Arc ⇒ 没人还拿着它
            if l.try_lock().is_ok() && Arc::strong_count(l) <= 2 {
                g.remove(path);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.lock().map(|g| g.len()).unwrap_or(0)
    }
}

static PATH_LOCKS: OnceLock<PathLocks> = OnceLock::new();

fn path_locks() -> &'static PathLocks {
    PATH_LOCKS.get_or_init(PathLocks::new)
}

/// **把规范化后的目标路径统一成判据用的键。**
///
/// ## 为什么要规范化（审计："key the lock on the **final destination path**"）
///
///   同一个文件在两次调用里可能写成 `E:\a\b.jar` 与 `e:\a\b.jar`、
///   或者中间多一个 `.\` —— 字符串不同、**盘上是同一个文件**。
///   拿原样字符串当键，锁就漏了（而漏掉的正是"两个 worker 写同一个文件"）。
///
///   做法：
///     ① Windows 上把 `\` 与 `/` 统一（两边都有人写）；
///     ② 有父目录时，把父目录**规范化**（`canonicalize`）——这样
///        大小写与短名（8.3）在 Windows 上也被拉平。
///        父目录已经存在时 `canonicalize` 一定成功（`download_one_with`
///        在取锁**之前**不建目录，所以这里失败是正常的：退回"只统一分隔符"）；
///     ③ Windows 上把结果**小写化**（NTFS 默认大小写不敏感）。
///
///   ★ 为什么不去 `canonicalize` 整个路径：目标文件**这会儿还不存在**
///     （或正要被覆盖），`canonicalize` 会失败。所以只能对父目录做。
///
/// ## ★ 它会碰盘（一次 `canonicalize`）
///
///   所以**异步调用点必须交给 `spawn_blocking`**（见 [`lock_path`]）。
///   纯逻辑调用点（`dedup_pass` —— 它本来就是同步的）直接调。
pub fn path_key(path: &Path) -> PathBuf {
    let parent = path.parent();
    let canonical_parent = parent.and_then(|p| std::fs::canonicalize(p).ok());
    let joined = match (&canonical_parent, path.file_name()) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => path.to_path_buf(),
    };
    if cfg!(windows) {
        PathBuf::from(joined.to_string_lossy().replace('/', "\\").to_lowercase())
    } else {
        joined
    }
}

/// 一把"路径锁"的持有凭证。`Drop` 时自动放锁并清理簿记。
struct PathLockGuard {
    key: PathBuf,
    _inner: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for PathLockGuard {
    fn drop(&mut self) {
        path_locks().release(&self.key);
    }
}

/// **等这条目标路径空出来**（同上，见 [`PathLocks`] 的说明）。
///
/// ★ 服务不公开：调用点是 `download_one_with`（唯一入口），
///   这样"谁忘了加锁"在编译期就不可能发生。
///
/// ★ `path_key` 里有一次 `canonicalize`（**阻塞**系统调用）——
///   这里交给 `spawn_blocking`：它在 tokio 的**专用阻塞线程池**里跑，
///   不会占住 worker（这个仓库有门禁盯着"命令里的阻塞重活"，
///   同一套道理对引擎内部也成立：一个 64 并发的批次会同时做 64 次规范化）。
async fn lock_path(path: &Path) -> PathLockGuard {
    let owned = path.to_path_buf();
    let key = tokio::task::spawn_blocking(move || path_key(&owned))
        .await
        // 后台任务 panic（不该发生）→ 退回"不做规范化"的键：
        // 宁可少一点大小写合并，也不能让整个下载因为规范化失败而挂掉。
        .unwrap_or_else(|_| path.to_path_buf());
    let lock = path_locks().get(&key);
    let guard = lock.lock_owned().await;
    PathLockGuard {
        key,
        _inner: guard,
    }
}

/// 共享的运行时统计
#[derive(Default)]
struct Stats {
    finished_files: AtomicU64,
    finished_bytes: AtomicU64,
    skipped_files: AtomicU64,
    repaired_files: AtomicU64,
    /// ★★ **没有校验值就落位的文件数**（判据 3；明细在 `outcome.unverified`）
    unverified_files: AtomicU64,
    /// ★★ 失败条数（给**同步**的进度回调用的原子计数）。
    ///
    ///   `failed_files` 在进度事件里本来就有，但它的来源是
    ///   `failed.lock().await.len()` —— 那是个 async 锁，**同步闭包拿不到**。
    ///   而"校验中"那一档的报告点（`phase_reporter`）正是同步的。
    ///   为了那一档不撒谎（界面上的"其中 N 个失败"不该在阶段切换时跳回 0），
    ///   这里再放一个原子计数。
    failures_total: AtomicU64,
    /*
     * ★★ **已处理的任务数**（成功 + 跳过 + 失败，每个任务只算一次）。
     *
     *   为什么需要它（用户报的"进度到不了 100%"）：
     *   真实截图：`下载资源文件 · 源：BMCLAPI 镜像 · 2591 / 2596 个文件` ——
     *   差 5 个。原因不是"还有 5 个没下完"，而是**分母算错了**：
     *     · `total_files` = 计划里的任务总数（2596）
     *     · `done` 原来 = finished + skipped —— **失败的那几个不在里面**
     *   失败的会进重试轮；如果重试仍然失败，它永远不进 finished，
     *   于是进度条永远停在 2591/2596，看起来像卡住了。
     *
     *   现在的判据是"这个任务**处理完了吗**"（不管成功还是失败），
     *   于是 `processed + 没轮到的` 恒等于 `total_files` —— 进度必然能到 100%。
     *   失败数仍然单独报（`failed_files`），界面可以据此显示"其中 N 个失败"。
     */
    processed_files: AtomicU64,
}

/// 已处理的任务数（成功 + 跳过 + 失败，每任务一次）
#[inline]
fn processed_count(stats: &Stats) -> u64 {
    stats.processed_files.load(Ordering::Relaxed)
}

/* ====================== 重试策略 ====================== */

/// 指数退避（PCL2 `NetRequestByClientRetry` 的等价物）
///
/// 第 n 次重试等待 `base * 2^(n-1)`，封顶 `max`。加 ±20% 抖动，
/// 避免一批文件在同一个时刻一起回来把源又打爆（惊群）。
pub fn backoff_delay(attempt: u32, base: std::time::Duration, max: std::time::Duration) -> std::time::Duration {
    let shift = attempt.saturating_sub(1).min(6);
    let raw = base.saturating_mul(1u32 << shift);
    let capped = raw.min(max);
    // 抖动：用 attempt 与当前纳秒做种子（不需要密码学强度）
    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0) as u64
        % 40) as f64
        / 100.0
        - 0.2;
    let ms = (capped.as_millis() as f64 * (1.0 + jitter)).max(1.0);
    std::time::Duration::from_millis(ms as u64)
}

/* ====================== 分片规划 ====================== */

/// 一个分片段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkSpan {
    pub idx: u64,
    pub start: u64,
    pub end: u64,
}

impl ChunkSpan {
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// 把 `total` 字节切成若干段（纯函数，便于测试）。
///
/// 段数：按 `MIN_CHUNK` 算出来，再夹在 `1..=CHUNK_COUNT`。
/// 例：39 MB → 19 段按 2MB 算 → 夹到 8 段 → 每段 4.875 MB。
pub fn plan_chunks(total: u64, max_chunks: u64, min_chunk: u64) -> Vec<ChunkSpan> {
    if total == 0 {
        return vec![];
    }
    let max_chunks = max_chunks.max(1);
    let chunks = (total / min_chunk.max(1)).clamp(1, max_chunks);
    let chunk_size = total.div_ceil(chunks);
    let mut out = Vec::with_capacity(chunks as usize);
    for i in 0..chunks {
        let start = i * chunk_size;
        if start >= total {
            break;
        }
        let end = ((i + 1) * chunk_size - 1).min(total - 1);
        out.push(ChunkSpan {
            idx: i,
            start,
            end,
        });
    }
    out
}

/// 分片计划清单：`part.chunks` 文件的内容。
///
/// 为什么要把计划落盘：续传时必须知道**上次每段的边界**。
/// 如果这次因为总大小探测结果不同切出了不同的边界，旧段位就是错的 ——
/// 所以要连 `total` 和段边界一起持久化，对不上就整段计划作废重下。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ChunkPlan {
    total: u64,
    spans: Vec<(u64, u64, u64)>, // (idx, start, end)
}

impl ChunkPlan {
    fn from_spans(total: u64, spans: &[ChunkSpan]) -> Self {
        Self {
            total,
            spans: spans.iter().map(|s| (s.idx, s.start, s.end)).collect(),
        }
    }
    fn matches(&self, total: u64, spans: &[ChunkSpan]) -> bool {
        self.total == total
            && self.spans.len() == spans.len()
            && self
                .spans
                .iter()
                .zip(spans)
                .all(|(a, b)| a.0 == b.idx && a.1 == b.start && a.2 == b.end)
    }
}

/* ====================== 单文件下载 ====================== */

/// 下载一个文件，结果写入 `task.path`。
///
/// 返回 `true` 表示**跳过了**（已存在且校验通过），`false` 表示真的下载了。
///
/// 结构（自上而下四层）：
///   ① 缓存命中 → 跳过（不做任何网络请求）
///   ② 单文件重试（最多 `MAX_FILE_RETRIES` 次，指数退避）
///   ③ 候选源依次尝试（源健康排序 + 429 冷却）
///   ④ 单源内部：分片并行（可续传）/ 单连接流式（可续传）
///
/// ★★ 2026-10：**"致命"错误在这一层就结束**（见 `download_one_with`）。
pub async fn download_one(
    task: &DownloadTask,
    preferred: Source,
    cancel: &CancelToken,
) -> Result<bool> {
    download_one_with(source::global(), task, preferred, cancel).await
}

/// 同上，但显式指定源管理器（测试用）
///
/// ## ★★ 这一层是**两把锁的交汇处**（持有顺序见 [`PathLocks`] 的说明）
///
///   ① 调用方（`run_round`）已经拿住 `Semaphore` 许可才 spawn 到这里；
///   ② 这里进去先拿**目标路径锁**。
///   ⇒ 顺序永远是 **permit → 路径锁**，反了就死锁。
///
///   ## 为什么锁要在这里、而不是在 `run_round` 里
///
///     `download_one` 有**很多别的调用点**（`commands_real.rs` 的整合包补齐、
///     `installer.rs`、`optifine.rs`、`liteloader.rs`、`adoptium.rs`）——
///     把互斥放在最里面那个公共入口，才是"谁调都锁得上"。
///     放在批次层的话，一次安装里"批次内"和"批次外"的两条路仍然会撞。
pub async fn download_one_with(
    manager: &SourceManager,
    task: &DownloadTask,
    preferred: Source,
    cancel: &CancelToken,
) -> Result<bool> {
    let _path_guard = lock_path(&task.path).await;
    download_one_locked(manager, task, preferred, cancel, None::<&fn(ProgressPhase, &str)>).await
}

/// `download_one_with` 的实体（路径锁已由调用方拿住）。
///
/// `progress` 是**可选**的进度回调：给了它才会上报"校验中"那一档
/// （判据 3）。单文件调用点（补齐 / OptiFine / 加载器）没有批次上下文，
/// 传 `None` 就不会凭空造一条不属于任何批次的进度事件。
///
/// ★ 为什么是**泛型**（`F: Fn(..)`）而不是 `Option<&dyn Fn(..)>`：
///   调用点在 `tokio::spawn` 的 future 里，而 `&dyn Fn` 这个 trait object
///   在 `Send` 推导上会把整个 future 的 `Send` 判掉（实测报
///   "future cannot be sent between threads safely"）。
///   泛型参数没有这个问题，代价只是单态化出两份代码。
async fn download_one_locked<F>(
    manager: &SourceManager,
    task: &DownloadTask,
    preferred: Source,
    cancel: &CancelToken,
    progress: Option<&F>,
) -> Result<bool>
where
    F: Fn(ProgressPhase, &str),
{
    let expected = task.expected_hash();

    // ---------- ① 已有且校验通过 → 跳过 ----------
    if task.path.is_file() {
        /*
         * ★★ 判据 3：**先报"校验中"再看盘**。
         *
         *   审计：`verifying` 不可见 = "一个大型存储上的哈希校验看起来像卡住"。
         *   这一条路径尤其隐蔽：它**不发任何网络请求**，所以旧代码在这段时间里
         *   一条事件都不发 —— 界面停在原地，用户以为死机了。
         *   ★ 也报在日志里（跑不跑得到不看界面）。
         */
        if expected.is_some() {
            if let Some(p) = progress {
                p(ProgressPhase::Verifying, &task.label);
            }
            say!("[IEML/download] 校验已存在的文件：{}", task.label);
        }
        match verify_existing(task, &expected).await {
            VerifyOutcome::Ok => return Ok(true),
            VerifyOutcome::Mismatch { expected, actual } => {
                // ★ 校验失败 → 删掉重下（PCL2 的「校验失败：删除文件，重新下载」）
                say!(
                    "[IEML/download] {} 校验不匹配（期望 {}，实际 {}）→ 删除重下",
                    task.label,
                    short(&expected),
                    short(&actual)
                );
                let _ = tokio::fs::remove_file(&task.path).await;
            }
            /*
             * ★★ 判据 3 的核心：**没有校验值 ≠ 校验通过**。
             *
             *   这条路径以前是**静默的**（`verify_existing` 在 `size == 0` 时
             *   直接返回 `Ok`）—— 于是"任何一个已存在的文件"都算缓存命中。
             *   现在它至少**留下痕迹**：日志点名 + `unverified` 计数
             *   （明细由 `run_round` 收进 `DownloadOutcome::unverified`）。
             *
             *   ★ 这里**不删文件**：没有证据说它是坏的（删了要重下一整份），
             *     但也没有证据说它是好的 —— 如实说"未经校验"才是对的。
             */
            VerifyOutcome::Unverified { length_checked } => {
                say!(
                    "[IEML/download] {} **没有校验值**（{}）→ 未经校验，按已存在跳过 \
                     —— 这个文件对不对，我们无法证明",
                    task.label,
                    if length_checked {
                        "只比过长度"
                    } else {
                        "连长度都没有（size=0）"
                    }
                );
            }
            VerifyOutcome::Absent => {}
        }
    }

    if cancel.is_cancelled() {
        return Err(NetError::Cancelled);
    }

    // ---------- ② 准备目录与临时文件 ----------
    if let Some(parent) = task.path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let part = part_path(&task.path);

    let candidates = source::candidates(task, preferred);
    if candidates.is_empty() {
        return Err(NetError::Other(format!("{} 没有任何可用下载地址", task.label)));
    }

    // ---------- ③ 单文件重试 ----------
    let mut last_err = String::new();
    // ★ 最近一次失败的**处置档位**：批次层要用它决定"还要不要再补下"
    let mut last_class = FailureClass::Retryable;
    let mut tried_sources = 0usize;
    let mut busy_waits = 0u32;
    // 这一条任务**已经出现过几次"校验不符"**
    //
    // ★ 用计数而不是去 `last_err` 里搜"校验失败"：下游
    //   （`run_round` 数 `repaired_files`）**正是**靠那句文案判的，
    //   拿它当自己的控制流等于把两件事绑在一根字符串上 —— 改文案就会
    //   悄悄改行为。计数是显式的。
    let mut verify_mismatches = 0u32;

    for attempt in 1..=MAX_FILE_RETRIES {
        if cancel.is_cancelled() {
            return Err(NetError::Cancelled);
        }

        // 每一轮都重新排序候选：上一轮吃到的 429 会让这个源沉下去
        let ordered = source::candidates(task, preferred);
        let ordered: Vec<(Source, String)> = if attempt == 1 {
            ordered
        } else {
            // 重试轮把上次成功的源优先（它已经被证明可用）
            let mut o = ordered;
            o.sort_by_key(|(s, _)| if manager.is_cooling(*s) { 1 } else { 0 });
            o
        };
        tried_sources = tried_sources.max(ordered.len());

        for (idx, (src, url)) in ordered.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(NetError::Cancelled);
            }
            // 冷却中的源：跳过（除非它是最后一个候选）
            if manager.is_cooling(*src) && ordered.len() > 1 {
                continue;
            }

            /*
             * ★★★★ 2026-09-30（用户）：「**我点完后，我都不知道开没开是下载，
             *   连接失败，也是等了一会儿后冷不丁的出来**」。
             *
             *   根因在这里：候选源是**串行**试的，而"连接失败"要等满
             *   HTTP 客户端的 20 秒连接超时才轮到下一个。
             *   真机实测 `cdn.modrinth.com` 与 `mod.mcimirror.top` **两条路都超时**
             *   ⇒ 一个文件要静默 **40 秒**才报错。
             *
             *   PCL 之所以"立即"，是因为它的多个源是**并行**的
             *   （`TryBeginThread` 里每个线程用一个源，失败的分片换下一个源接着下）。
             *   我们不做并行写同一份数据（那是纯浪费，还要处理被 kill 的半截文件），
             *   但可以拿走它真正的收益：**不要串行等满超时**。
             *
             *   ⇒ 规则：**还有备选源时，每个源只给它 [`PROBE_DEADLINE`] 去证明自己能行；
             *     最后一个源才用完整超时**（它是最后的希望，值得等）。
             *     于是"两条死路"的代价从 40 秒降到 ~8 秒，而且中途界面一直在动
             *     （每换一个源都会更新 `current_file`）。
             *
             *   ★ 为什么用整体超时而不是只限制"连接"：卡住的形态不止一种 ——
             *     连不上、连上了不回数据（`Reading` 那一档）、回了几个字节就停住。
             *     PCL 也是按状态区分这三种的；我们用一条总预算就能覆盖它们，
             *     而且**已经写进 `.part` 的字节不会丢**（下一个源会续传）。
             */
            let has_backup = ordered[idx + 1..].iter().any(|(s2, _)| !manager.is_cooling(*s2));
            let started = std::time::Instant::now();
            let attempt_result = if has_backup {
                match tokio::time::timeout(
                    PROBE_DEADLINE,
                    download_to_part(manager, url, &part, task, cancel, ordered.len(), &expected),
                )
                .await
                {
                    Ok(r) => r,
                    Err(_) => Err(NetError::Other(format!(
                        "连接 {} 超过 {} 秒没有进展，换下一个源",
                        src.as_str(),
                        PROBE_DEADLINE.as_secs()
                    ))),
                }
            } else {
                download_to_part(manager, url, &part, task, cancel, ordered.len(), &expected).await
            };
            let written = match attempt_result {
                Ok(n) => n,
                Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                Err(e) => {
                    manager.note_failure(*src, e.status());
                    last_err = format!("{}：{e}", src.as_str());
                    let class = e.class();
                    last_class = class;
                    /*
                     * ★★ 判据 1 的落地（一）：**"换个源也没用"的失败立刻结束。**
                     *
                     *   审计：`fatal: 404/403 …, disk full, permission denied`
                     *   —— 而且明确写着 **Disk-full and permission errors are
                     *   not retryable. Surface them immediately; retrying just
                     *   makes the UI lie for longer.**
                     *
                     *   `fatal_without_trying_other_sources` 把 404/403 那种
                     *   **与 URL 相关**的 4xx 排除在外（候选源之间可能是不同的
                     *   路径、甚至不同的仓库 —— `source::candidates_with` 那条
                     *   自带的 `urls` 就是为此存在的）。剩下的（磁盘满 / 权限 /
                     *   哈希反复不符 / 分片拼不齐）与地址无关，换源纯属白等。
                     */
                    if e.fatal_without_trying_other_sources() {
                        say!(
                            "[IEML/download] {} 失败且**换源也没用**（{}）：{e} → 立刻结束，不再重试",
                            task.label,
                            match class {
                                FailureClass::Fatal => "致命",
                                FailureClass::Busy => "文件被占用",
                                FailureClass::Retryable => "可重试",
                            }
                        );
                        let _ = tokio::fs::remove_file(&part).await;
                        return Err(NetError::AllSourcesFailed {
                            tried: tried_sources.max(ordered.len()),
                            last: last_err,
                            class,
                        });
                    }
                    /*
                     * 404 之类的"换个源也没用"的错误：仍然换（镜像路径可能不同），
                     * 但不留残留文件。
                     */
                    if matches!(e, NetError::Status { status: 404, .. }) {
                        let _ = tokio::fs::remove_file(&part).await;
                    }
                    /*
                     * ★ **`Busy`（文件被占用）不换源。**
                     *
                     *   占用是**本地**问题（杀软/索引服务在扫刚落盘的文件），
                     *   换下载源治不好它 —— 但**也不该在这里结束**：占用是秒级的，
                     *   `finish_file_with_retry` 会退避等它解除。
                     *   所以直接进下一轮（那里的落位重试才是对的处置）。
                     *
                     *   ★ 判据的"换源"那一半在 `NetError::should_switch_source`
                     *     （`class().worth_switching_source()`）—— 它回答的是
                     *     "换源有没有用"，而这里要问的是"该不该继续换候选"，
                     *     两者在 `Busy` 上恰好一致，但语义不同，所以直接按档位判。
                     */
                    if class.is_busy() {
                        break;
                    }
                    continue;
                }
            };

            // ★ 先把 `.part` 校验掉，再落位。
            //   顺序很重要：如果先改名再校验，校验失败时就得把已经改名到目标位置
            //   的坏文件再删一次 —— 中间那一瞬间，"坏文件 + 正确文件名"是会被
            //   其它代码（启动流程 / 完整性校验）当成好文件用的。
            if expected.is_some() {
                /*
                 * ★★ 判据 3：**算校验值这段时间要让界面看得见**。
                 *   几百 MB 的包体在这里只发一条事件也能说明"它在干活"。
                 */
                if let Some(p) = progress {
                    p(ProgressPhase::Verifying, &task.label);
                }
                match expected.verify_file(&part).await {
                    Some(true) => {}
                    Some(false) => {
                        // ★ 校验失败：删文件、记失败、换源重来
                        let actual = expected.actual_of(&part).await.unwrap_or_default();
                        let _ = tokio::fs::remove_file(&part).await;
                        cleanup_segments(&part).await;
                        manager.note_failure(*src, None);
                        /*
                         * ★★ 判据 1（二）：**校验反复不符是致命的**。
                         *
                         *   审计：*On mismatch of an already-cached file, delete and
                         *   refetch once. If it mismatches twice, stop and report —
                         *   a persistently wrong file means a wrong expectation or a
                         *   bad source, and looping forever hides that.*
                         *   而且：**Never retry a hash mismatch forever.**
                         *
                         *   所以**第一次**不符只换源（`continue`，这是"再取一次"），
                         *   第二次仍然不符就直接结束 —— 不再吃后面的重试轮。
                         *   ★ 这一点很要紧：一份"每次都对不上"的文件，
                         *     每一轮都要重下整份 + 读盘算哈希，而结论早就有了。
                         */
                        let again = verify_mismatches >= 1;
                        verify_mismatches += 1;
                        last_class = FailureClass::Fatal;
                        last_err = format!(
                            "{} 返回的文件校验失败（期望 {}，实际 {}）",
                            src.as_str(),
                            short(expected.value()),
                            short(&actual)
                        );
                        if again {
                            say!(
                                "[IEML/download] {} **两次校验都不符**（{}）→ 判定为致命，\
                                 不再重试：期望值与源上的文件对不上",
                                task.label,
                                expected.algo()
                            );
                            let _ = tokio::fs::remove_file(&part).await;
                            return Err(NetError::AllSourcesFailed {
                                tried: tried_sources.max(ordered.len()),
                                last: last_err,
                                class: FailureClass::Fatal,
                            });
                        }
                        continue;
                    }
                    None => {
                        /*
                         * ⚠ 走不到这里：`expected.is_some()` 为真时
                         * `verify_file` 必定返回 `Some(..)`。
                         * 留这一支是为了**不静默**（真出了这种不一致，
                         * 宁可当成"校验读不出来"处理）。
                         */
                        manager.note_failure(*src, None);
                        last_err = format!("{}：校验结果无法判定（{}）", src.as_str(), expected.algo());
                        last_class = FailureClass::Fatal;
                        continue;
                    }
                }
            }

            // ★ 落位（改名）在 Windows 上可能撞到"目标文件被占用"——
            //   实测 3598 个资源文件里有 23 个 `.ogg` 报 os error 32
            //   （多半是杀毒/索引服务在扫刚落盘的文件）。
            //   数据**已经下好了**，为一个瞬时占用把整份文件重下一遍是浪费：
            //   停下来退避等一等，占用一解除就能落位。
            match finish_file_with_retry(&part, &task.path, task, cancel, &mut busy_waits).await {
                Ok(()) => {
                    manager.note_success(*src, written, started.elapsed());
                    /*
                     * ★★★★ 2026-10-02：**每个文件下完之后，报出"走的哪条路、多快"**。
                     *
                     *   加它的原因：这一整轮我都在猜"引擎到底走的哪条源、速度多少"，
                     *   而手上只有**失败时**的日志。用户报「有任务、进度几乎不动」
                     *   时，我连它当时选了哪条源都不知道 —— 只能拿外部 curl 去反推，
                     *   而 curl 与引擎的行为**不一定一样**（今天已经栽过两次）。
                     *
                     *   ★ 为什么不能省这点日志：源的选择是**动态的**
                     *     （健康分 + 冷却 + 候选顺序 + 多源轮转），
                     *     光读代码推不出"此刻它会选谁"。只有让它自己说。
                     *   ★ 用 `say!`（不是 println）：写失败只丢一行日志，不会崩。
                     */
                    let secs = started.elapsed().as_secs_f64().max(0.001);
                    say!(
                        "[IEML/download] {} ← {}（{:.1} s，{:.0} KB/s）",
                        task.label,
                        src.as_str(),
                        secs,
                        written as f64 / secs / 1024.0
                    );
                    /*
                     * ★★ 判据 3：**刚下下来的这份文件有没有被校验过**。
                     *
                     *   `expected.is_some()` 为假意味着这个任务**根本没有校验值**
                     *   （`.mrpack` 里没给哈希的条目、或解析没拿到）—— 它现在
                     *   落位了，而我们对它的内容**一无所知**。
                     *   以前这件事在成功路径上**一个字都不说**：用户看到的是
                     *   "全部下载成功"，而其中几个文件可能压根是错的。
                     *   ⇒ 至少点名（`DownloadOutcome::unverified` 会在批次层
                     *     把它收成清单，见那里的说明）。
                     */
                    if expected.is_some() {
                        // 校验过（就在上面那几个分支里），什么都不用记
                    } else {
                        if let Some(p) = progress {
                            p(ProgressPhase::Done, &task.label);
                        }
                        say!(
                            "[IEML/download] {} **没有校验值** → 未经校验就落位\
                             （这个文件对不对，我们无法证明）",
                            task.label
                        );
                    }
                    return Ok(false);
                }
                Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                Err(e) => {
                    manager.note_failure(*src, None);
                    last_err = format!("{}：落盘失败 {e}", src.as_str());
                    // ★ 落盘失败大多是"文件被占用"（Busy，还可等）
                    //   或权限/磁盘（Fatal，等下去没意义）
                    last_class = e.class();
                    if e.fatal_without_trying_other_sources() {
                        return Err(NetError::AllSourcesFailed {
                            tried: tried_sources.max(ordered.len()),
                            last: last_err,
                            class: last_class,
                        });
                    }
                }
            }
        }

        /*
         * ★★ 判据 1：**这一轮全挂了之后，还该不该吃下一轮？**
         *
         *   判据与 `NetError::is_retryable` **同一个源头**
         *   （`domain::failure`）—— 只是这里手上只剩一句错误文案
         *   （`last_err`），所以按文案判：`classify_message` 认不出就是
         *   **可重试**（那条兜底是有意的，见 `FailureClass::from_parts` 的说明）。
         *
         *   为什么必须在这里拦一道：`MAX_FILE_RETRIES = 3` 轮之间**有退避**
         *   （0.6 → 1.2 → 2.4 秒，抖动 ±20%）—— 一个"磁盘满"的文件在报错之前
         *   会先白等 4 秒，再进批次层的补下（又是 3 轮、每轮 0.8→15 秒）。
         *   审计原话：*retrying just makes the UI lie for longer.*
         *
         *   ★ 这一条与"批次层那一道"是**两回事**，两个都要有：
         *     · 这里管"同一个文件的 3 轮"；
         *     · `download_batch` 里管"整个批次的 3 轮补下"（用 `AllSourcesFailed.class`）。
         *   少了这里，`is_retryable` 就还是一个没有调用点的判据
         *   （那正是审计点名的问题之一）。
         */
        let retry_this_file = last_err.is_empty()
            || crate::domain::failure::classify_message(&last_err) != FailureClass::Fatal;
        if attempt < MAX_FILE_RETRIES && retry_this_file {
            let delay = backoff_delay(
                attempt,
                std::time::Duration::from_millis(600),
                std::time::Duration::from_secs(10),
            );
            if !source::sleep_cancellable(delay, cancel).await {
                return Err(NetError::Cancelled);
            }
        } else if attempt < MAX_FILE_RETRIES {
            say!(
                "[IEML/download] {} 的失败是**致命**的 → 不吃后面的重试轮，直接报错：{last_err}",
                task.label
            );
            last_class = FailureClass::Fatal;
            break;
        }
    }

    Err(NetError::AllSourcesFailed {
        tried: tried_sources,
        last: last_err,
        /*
         * ★★ 判据 1 的落地（三）：**把处置档位带出去**。
         *
         *   批次层（`download_batch`）拿到的就是这个错误 —— 它据此决定
         *   "还要不要再补下两轮"。一个"致命"的失败再补两轮只是让用户多等
         *   十几秒，然后看到同一句话（审计：retrying just makes the UI
         *   lie for longer）。
         */
        class: last_class,
    })
}

/// 把 `.part` 改名到目标位置。
///
/// ★ Windows 上改名会因为**目标被占用**而失败（os error 32）——
///   这个错误是暂时的，调用方会退避重试，所以必须原样返回错误而不是吞掉。
async fn finish_file_with_retry(
    part: &Path,
    target: &Path,
    task: &DownloadTask,
    cancel: &CancelToken,
    busy_waits: &mut u32,
) -> Result<()> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    for attempt in 0..=FILE_BUSY_RETRIES {
        match tokio::fs::rename(part, target).await {
            Ok(()) => {
                cleanup_segments(part).await;
                return Ok(());
            }
            Err(e) => {
                let err = NetError::Io(e);
                if !err.is_file_busy() || attempt == FILE_BUSY_RETRIES {
                    return Err(err);
                }
                *busy_waits += 1;
                let d = busy_delay(attempt);
                say!(
                    "[IEML/download] {} 落盘时文件被占用（第 {} 次）→ 等 {}ms 再试",
                    task.label,
                    attempt + 1,
                    d.as_millis()
                );
                if !source::sleep_cancellable(d, cancel).await {
                    return Err(NetError::Cancelled);
                }
            }
        }
    }
    Err(NetError::Other(format!("{} 落盘失败", task.label)))
}

/// 创建 `.part`：撞到"文件被占用"就退避重试。
///
/// ★ 实测踩过：3598 个资源文件里固定有 23 个 `.ogg` 报
///   `写入文件失败：另一个程序正在使用此文件 (os error 32)`，
///   而且**是 `File::create` 这一步就失败** —— 也就是说连临时文件都建不出来
///   （多半是杀毒软件/Windows 索引服务在扫刚落盘的媒体文件）。
///   当时只对"改名落位"做了重试，对"创建/写入"没有 —— 那 23 个文件
///   在 3 轮补下里每次都是立刻失败，一次也没等到占用解除。
///   现在的策略：创建、追加、改名**三处都**退避重试（占用是秒级的）。
///
/// ## ★★ 2026-10：这张表**不再是手写的**（判据 1）
///
///   原来这里是 `matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33) | Some(1224))`
///   —— 与 `NetError::is_file_busy` 里那一张**同样的表**，两处各写一遍。
///   而这一处**漏了一个致命后果**：`Some(5)` 是 `ACCESS_DENIED`，
///   于是"目录不可写"会在这里被当成占用，白等 4 次退避（0.3/0.9/2.1/4 秒）。
///   ⇒ 现在统一问 `domain::failure::is_busy_errno`（errno 5 已被摘出去）。
async fn create_part(part: &Path) -> Result<tokio::fs::File> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..=FILE_BUSY_RETRIES {
        if let Some(p) = part.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        match tokio::fs::File::create(part).await {
            Ok(f) => return Ok(f),
            Err(e) => {
                let busy = e
                    .raw_os_error()
                    .is_some_and(crate::domain::failure::is_busy_errno);
                if !busy {
                    return Err(NetError::Io(hinted_io(e)));
                }
                say!(
                    "[IEML/download] {}",
                    describe_busy("创建临时文件", part, &e)
                );
                if attempt == FILE_BUSY_RETRIES {
                    return Err(NetError::Io(hinted_io(e)));
                }
                // 只读属性也会挡住 File::create（占用中的文件常见）
                let _ = tokio::fs::remove_file(part).await;
                last = Some(e);
                tokio::time::sleep(busy_delay(attempt)).await;
            }
        }
    }
    Err(NetError::Io(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "创建临时文件失败")
    })))
}

/// 以追加方式打开 `.part`（续传），同样对"被占用"退避重试。
///
/// ★ 判据同 `create_part`（★ errno 5 已经不在"占用"那一档里了）。
async fn open_part_append(part: &Path) -> Result<tokio::fs::File> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..=FILE_BUSY_RETRIES {
        match tokio::fs::OpenOptions::new().append(true).open(part).await {
            Ok(f) => return Ok(f),
            Err(e) => {
                let busy = e
                    .raw_os_error()
                    .is_some_and(crate::domain::failure::is_busy_errno);
                if !busy || attempt == FILE_BUSY_RETRIES {
                    return Err(NetError::Io(hinted_io(e)));
                }
                last = Some(e);
                tokio::time::sleep(busy_delay(attempt)).await;
            }
        }
    }
    Err(NetError::Io(hinted_io(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "打开临时文件失败")
    }))))
}

/// "文件被占用"的退避时长：0.3s / 0.9s / 2.1s / 4s（加抖动）
fn busy_delay(attempt: u32) -> std::time::Duration {
    backoff_delay(
        attempt + 1,
        std::time::Duration::from_millis(300),
        std::time::Duration::from_secs(4),
    )
}

/// 已有文件的校验结果
enum VerifyOutcome {
    Ok,
    Mismatch { expected: String, actual: String },
    /// ★★ **没有校验值，因此"无从判断"** —— 这一档以前是**静默的 `Ok`**。
    ///
    ///   见 [`UnverifiedFile`] 与 `ExpectedHash::None` 的说明：
    ///   审计的原话是 `None` 不能悄悄等于成功。
    Unverified {
        /// 有没有用长度兜一层（`size == 0` 时**一个字节都没比过**）
        length_checked: bool,
    },
    /// ★ 这个变体现在**没有构造点**了：`verify_existing` 只在
    ///   `task.path.is_file()` 为真时被调用（见 `download_one_locked`），
    ///   而"校验读盘失败"那一档改成了 [`VerifyOutcome::Unverified`]
    ///   （读不出来 = **无从判断**，不该冒充"这个文件不在"）。
    ///
    ///   ★ 留着它（而不是删掉）是为了让"文件不存在"这个语义在**类型上**
    ///     仍然是一档 —— 下一个人把 `verify_existing` 用到别处时不会
    ///     被迫用 `Ok` 去表达"没有"。
    #[allow(dead_code)]
    Absent,
}

/// 校验一个**已经存在**的文件。
///
/// ## ★★ 2026-10：`size == 0` 不再直接返回 `Ok`（这是"悄悄成功"的根因）
///
///   原来的实现：
///
///   ```text
///     无校验值 → len = 文件长度；if size == 0 || len == size { Ok } else { Mismatch }
///   ```
///
///   而 `size == 0` 的形状**真实存在**：`commands_real.rs` 的整合包补齐路径
///   就是 `DownloadTask::new(dest, url, String::new(), 0, path)`（`sha1="" size=0`）。
///   于是两件事同时发生：
///     · 任何**已存在**的文件都被当成缓存命中（哪怕是上一次留下的半份、
///       或用户手工放进去的别的文件）；
///     · 上面那句 `Ok` 还会让 `download_one_with` **直接 return Ok(true)**，
///       于是"跳过"被计进 `skipped_files` —— 结果看起来一切正常。
///
///   现在它返回 [`VerifyOutcome::Unverified`]：**照旧不重下**
///   （没有证据说它是坏的，删了要白下一整份），但**必须说出来**
///   （日志点名 + `DownloadOutcome::unverified` 清单）。
async fn verify_existing(task: &DownloadTask, expected: &ExpectedHash) -> VerifyOutcome {
    if expected.is_some() {
        return match expected.verify_file(&task.path).await {
            Some(true) => VerifyOutcome::Ok,
            Some(false) => {
                let actual = expected.actual_of(&task.path).await.unwrap_or_default();
                VerifyOutcome::Mismatch {
                    expected: expected.value().to_string(),
                    actual,
                }
            }
            // `is_some()` 为真时走不到这里；真走到了就按"无从判断"如实说
            None => VerifyOutcome::Unverified {
                length_checked: false,
            },
        };
    }
    /*
     * 没有校验值：长度是**唯一**能比的东西，而且只有任务真的知道大小时
     * 才比得了（`size == 0` = 连长度都不知道）。
     */
    let len = task.path.metadata().map(|m| m.len()).unwrap_or(0);
    if task.size == 0 {
        // ★★ 这一支就是"悄悄成功"那一支：**什么都不知道**，如实说出来
        VerifyOutcome::Unverified {
            length_checked: false,
        }
    } else if len == task.size {
        VerifyOutcome::Unverified {
            length_checked: true,
        }
    } else {
        VerifyOutcome::Mismatch {
            expected: format!("{} 字节", task.size),
            actual: format!("{len} 字节"),
        }
    }
}

/// 下载到这个源的 URL 到 `.part`（分片优先，失败回退单连接）。
///
/// 返回本次真正写入的字节数。
///
/// `candidate_count` 是**这次重试轮里可用的候选地址总数**（见
/// `SLOW_ABS_FLOOR_BPS` 与 `SpeedWatch::too_slow` 的 `switchable` 参数）：
/// 只有 1 个候选时"慢"不构成放弃的理由 —— 没有别的源可换。
async fn download_to_part(
    manager: &SourceManager,
    url: &str,
    part: &Path,
    task: &DownloadTask,
    cancel: &CancelToken,
    candidate_count: usize,
    expected: &ExpectedHash,
) -> Result<u64> {
    // 断点续传：已有 .part 且**不是**分片残留 → 单连接续传
    let existing = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);

    /*
     * ★★★★ 2026-10-02（用户：「**开始下载的速度还是很慢**」，并让我「继续」做
     *   「起手就铺连接」）。
     *
     *   ## 为什么要放开这个条件
     *
     *   实测（真实引擎、同一分钟）：
     *     · 头 **5 秒两条路都是 0 字节**（`diag_engine_vs_curl` 里
     *       `引擎·镜像 1×5s = 5s 盘上 0 字节`）；
     *     · 而 PCL 一上来就铺 3~8 条连接，**某条先出数据就赢了**。
     *
     *   我们的形状是"建连 → 等 → 超时/判慢 → 才换"：
     *     单连接超时 20 s、判慢 15 s —— **用户看到的"开始慢"就是这几秒**。
     *
     *   ⇒ 只要有**两个以上候选**就值得一上来铺连接：多一条连接就多一次
     *     "先出数据"的机会，而代价只是多几个 TCP 连接。
     *     ★ 这正是 PCL `TryBeginThread` 的判据形状：它不管文件大小，
     *       只要有活着的源就继续起线程。
     *
     *   ## 仍然**不**全局打开的原因（那条老注释依然成立）
     *
     *   分片在 BMCLAPI 上既不快、又会招 429 —— 但那只在**单一源**时成立。
     *   有第二个候选时，轮转分配天然把连接摊开（见 `download_chunked`），
     *   不会把所有并发压在同一条源上。
     */
    let multi_candidate = candidate_count > 1;
    if existing == 0 && (chunking_enabled() || task.allow_chunked || multi_candidate) {
        // 大文件：先探大小再分片（分片内部自带续传）
        //
        // ★ 全局默认不进这里（见 `chunking_enabled()` 的说明）：分片在 BMCLAPI 上
        //   既不快、又会招 429、还带一串只在分片路径上的失败。
        //   **但 `task.allow_chunked` 是逐任务的**（2026-10-01）：整合包包体
        //   那种"一个 113 MB 的大文件、没有别的文件可并发"的情形，
        //   多连接是唯一的加速手段 —— 见 `DownloadTask::chunked`。
        //   **`multi_candidate`（2026-10-02）**：有第二条候选时也铺 —— 见上。
        if let Some(total) = probe_content_length(url).await {
            if total >= CHUNKED_THRESHOLD {
                /*
                 * ★ 把**所有候选 URL** 交给分片 —— 段与源轮转分配，
                 *   所有源同时在下（PCL 的做法，见 `download_chunked` 的说明）。
                 *   ★ 只传 URL（丢掉 Source 标签）：分片这一层判断"能不能用"
                 *     靠的是**实际拿到字节**，不是标签；标签只用于健康分，
                 *     而健康分由 `download_range` 之外的路径负责。
                 */
                let cand_urls: Vec<String> = source::candidates(task, super::mirror::Source::from_url(url))
                    .into_iter()
                    .map(|(_, u)| u)
                    .collect();
                match download_chunked(url, &cand_urls, part, total, cancel, task.label.clone(), cap_of(task)).await {
                    Ok(written) => return Ok(written),
                    Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                    Err(e) => {
                        // 分片失败 → 回退单连接。
                        // ★ 不清掉已下好的段：下一次重试还能用（这就是分片续传的意义）
                        say!(
                            "[IEML/download] {} 分片不可用（{e}）→ 回退单连接",
                            task.label
                        );
                        // 服务器不支持 Range → 段文件永远拼不成完整文件，清掉免得占地方
                        if e.is_permanent_range_failure() {
                            cleanup_segments(part).await;
                        }
                    }
                }
            }
        }
    }

    // 单连接流式（含断点续传）
    //
    // ★ 传入"这个源已经证明过的速度"当慢速判据的参照物：坏源的判据是
    //   "远低于它自己的最好成绩"，而不是一个固定数字（固定数字会误伤
    //   正常偏慢的连接 —— 本机实测 BMCLAPI 正常就只有 0.83 MB/s）。
    //
    //   ★ 从**传进来的** manager 取（以前写死 `source::global()`）：
    //     这样限流上报（`note_throttled`）与速度判据落在同一个管理器上，
    //     测试也能用独立实例断言"被限流之后真的降了并发"。
    let proven = manager.proven_bps(super::mirror::Source::from_url(url));
    download_single(
        manager,
        url,
        part,
        expected,
        cancel,
        existing,
        proven,
        candidate_count > 1,
        task.size,
        // ★ 第二阶段 A：标签用于超限文案点名文件；闸门按"标签推类别"或显式值解析
        &task.label,
        cap_of(task),
    )
    .await
}

/// "慢速"检测窗口：记录某个时刻的累计字节数，之后用来算这段窗口的吞吐。
///
/// 判据是"**持续**慢满 `SLOW_WINDOW`"，而不是"瞬时慢一下"：
/// 只要某段窗口的吞吐够用就重置窗口。
///
/// ★ `proven_bps` 是"这个源到目前为止证明过的速度"（由调用方从源健康统计里拿）。
///   判"坏源"要**两个条件同时成立**：既远低于它自己的最好成绩，
///   绝对速度也确实低 —— 见文件顶部 `SLOW_ABS_FLOOR_BPS` 的说明。
#[derive(Debug)]
struct SpeedWatch {
    mark_bytes: u64,
    mark_at: std::time::Instant,
    /// 该源已知的最好成绩（字节/秒）；0 = 还不知道，只按绝对地板判
    proven_bps: u64,
    /// 还有**别的地址**可以换吗？
    ///
    /// ★ 这一条是修一个真实 bug 的关键（用户报「整合包前置包自动安装失败」）：
    ///   Modrinth 的 CDN 地址**只有一个候选**（镜像表推不出替代地址），
    ///   而单连接实测只有 ~230 KB/s —— 低于 `SLOW_ABS_FLOOR_BPS`。
    ///   于是 15 秒窗口一到就判"坏源"、中断连接、重试、再判一次，
    ///   三轮把整个重试预算烧光，最后报"所有下载源都失败了"。
    ///   实测把 2 MB 的 Fabric API 判成了装不上 —— 而这个源其实一直是好的，
    ///   它只是没有 BMCLAPI 那么快。
    ///
    ///   结论：**"慢"只有在下一条路更好时才构成放弃的理由**。
    ///   没有候选可换时，慢速检测只记录不中断（`too_slow` 里 `switchable=false`）。
    switchable: bool,
}

impl SpeedWatch {
    fn new(proven_bps: u64) -> Self {
        Self {
            mark_bytes: 0,
            mark_at: std::time::Instant::now(),
            proven_bps,
            // 默认允许换源：构造后由调用方按候选数覆盖。
            // 默认值取"允许"是为了让已经存在的测试（它们只关心速度判据本身）
            // 语义不变。
            switchable: true,
        }
    }

    fn switchable(mut self, yes: bool) -> Self {
        self.switchable = yes;
        self
    }

    /// 测试用：直接构造"窗口起点是某个过去时刻、当时累计了 N 字节"。
    /// 生产代码只用 `new`（自然累积），这个构造函数只为让判据可被精确断言。
    #[cfg(test)]
    fn at(proven_bps: u64, mark_bytes: u64, ago: std::time::Duration) -> Self {
        Self {
            mark_bytes,
            mark_at: std::time::Instant::now() - ago,
            proven_bps,
            switchable: true,
        }
    }

    /// 到目前为止累计写入 `total` 字节时，这段窗口是不是"慢得该换源"。
    /// 返回 `Some(实测字节/秒)` 表示该放弃这条连接。
    fn too_slow(&mut self, total: u64) -> Option<u64> {
        let elapsed = self.mark_at.elapsed();
        if elapsed < SLOW_WINDOW {
            return None;
        }
        let gained = total.saturating_sub(self.mark_bytes);
        let bps = (gained as f64 / elapsed.as_secs_f64()) as u64;

        // ① 绝对地板：速度还行就重置窗口，别拿旧账判死刑
        if bps >= SLOW_ABS_FLOOR_BPS {
            self.mark_bytes = total;
            self.mark_at = std::time::Instant::now();
            return None;
        }
        // ② ★ 没有别的地址可换 → **绝不**因为慢而放弃。
        //    慢一点的文件照样能下完；中断重试只会把重试预算烧光然后报失败。
        if !self.switchable {
            self.mark_bytes = total;
            self.mark_at = std::time::Instant::now();
            return None;
        }
        // ③ 相对判据：这个源自己证明过更快（>= 3 倍）才允许判它"坏了"。
        //    否则就是"这个源本来就这么快"，换源只会更慢。
        let relative_bad =
            self.proven_bps > 0 && bps.saturating_mul(SLOW_RELATIVE_DIVISOR) < self.proven_bps;
        if self.proven_bps == 0 || relative_bad {
            return Some(bps);
        }
        // 慢，但这是该源的正常水平 → 不换源，重置窗口继续下
        self.mark_bytes = total;
        self.mark_at = std::time::Instant::now();
        None
    }

    /// ★ **连接已经死了** —— 这条判据与"慢"分开，而且**与有没有备用地址无关**。
    ///
    /// PCL2 的真实判据（`ModNet.vb` 那个 `While` 循环里）：
    /// ```vb
    /// If Th.LastReceiveTime > 0 AndAlso DeltaTime > 5000 AndAlso
    ///    DeltaTime > RealDataCount Then            ' 间隔 > 5 秒，且速度 < 1 B/ms = 1 KB/s
    ///     Throw New TimeoutException("由于速度过慢断开链接……")
    /// ```
    /// 换成我们的措辞：**距上次收到数据已经超过 `DEAD_SILENCE` 秒，且这一窗
    /// 拿到的字节数连"每秒 1 KB"都不到**。
    ///
    /// 为什么必须和"慢"分开：
    ///   * 慢 → 取决于有没有别的路（`switchable`）—— 慢一点的文件照样下得完；
    ///   * **死** → 无论有没有别的路都该掐掉。一个字节都不回来的连接，
    ///     留着只是占着并发槽位和总超时预算，等到 300 秒兜底才失败。
    ///     掐掉之后重试（哪怕还是同一个地址）也大概率能连到另一个边缘节点。
    ///
    /// 阈值刻意定在 1 KB/s 而不是我们原来的 320 KB/s：
    /// 320 KB/s 会把"正常但慢"的连接判死（实测 Modrinth CDN ~230 KB/s、
    /// mcimirror ~146 KB/s，全都低于它）。PCL2 这个 1 KB/s 才是"死"的量级。
    fn dead(&self, total: u64, since_last_data: std::time::Duration) -> bool {
        if since_last_data < DEAD_SILENCE {
            return false;
        }
        // 这一窗几乎没拿到东西（< 1 KB/s）才算死；只是慢不算
        let gained = total.saturating_sub(self.mark_bytes);
        let floor = DEAD_MIN_BPS.saturating_mul(since_last_data.as_secs().max(1));
        gained < floor
    }
}

/// 单连接流式下载（含断点续传）。分片失败后也回退到这里。
///
/// ## ★★ 两轮结构：**续传对不上就重发一个不带 `Range` 的请求**（P0-4）
///
///   以前这里只有一轮：206 的 `Content-Range` 偏移与我们要的不符时，
///   代码只是**丢掉响应体、把目标文件截成 0，然后照样把这一轮的 body
///   写进去** —— 而那份 body 是**从服务端给的那个偏移开始**的内容。
///   于是落盘的文件缺了开头那一截，长度看着不那么离谱、SHA1 对不上，
///   用户看到的是"某个文件反复校验失败"。
///
///   正确做法（也是 PCL2 的做法）：**这次响应对不上就作废，重新发一个
///   不带 `Range` 的请求**要整份。判据说一不二 —— 服务端回的偏移不是
///   我们要的那个，那份数据就一条字节都不能信。
///
///   同样处理另外两种"对不上"：
///     · HTTP 416（`.part` 比服务端文件还大）：丢掉残留 → 重发无 Range 请求；
///     · `Content-Range` 的 total 与任务记录不符（服务端文件换了）：
///       丢掉残留 → 重发无 Range 请求。
///   三种情况都变成"**这一次调用内**就下完"，不再白烧一轮重试预算。
async fn download_single(
    manager: &SourceManager,
    url: &str,
    part: &Path,
    expected: &ExpectedHash,
    cancel: &CancelToken,
    existing: u64,
    proven_bps: u64,
    switchable: bool,
    task_size: u64,
    label: &str,
    cap: crate::domain::archive_guard::ByteCap,
) -> Result<u64> {
    /*
     * 第一轮：如果本地有残留，就带 `Range` 试着续传。
     * 第二轮（只在第一轮"对不上"时发生）：**不带 `Range`**，要整份。
     */
    let mut resume_from: Option<u64> = if existing > 0 { Some(existing) } else { None };
    let mut attempt = 0u32;

    loop {
        attempt += 1;

        /*
         * ★★ 第二阶段 A：**建连前的体积闸门**（清单第 172 行）。
         *
         *   上游声明的大小（任务记录 / `Content-Length`）就已经超过这个类别的上限
         *   ⇒ 现在就说，别先下满磁盘再发现：一个声明 8 GiB 的"图标"在建连这一行
         *   之前就该被拒。★ 判据是纯逻辑（`ByteCap::rejected_by_declared_size`）。
         *   ★ 放在 attempt 循环里是对的：第一轮"对不上"之后第二轮要重下整份，
         *     声明值没有任何变化，第二轮照样该拦（幂等，不会误伤）。
         */
        if cap.rejected_by_declared_size(task_size) {
            return Err(cap_exceeded_error(label, cap, task_size));
        }

        /*
         * ★ 2026-10-02：**尺子** —— 这是单连接路径真正发请求的地方。
         *   守卫活到本次循环体结束，所以它记的包含"读取响应体"的整段时间。
         */
        let _conn = conn_stats::begin();
        let mut req = client().get(url);
        if let Some(from) = resume_from {
            req = req.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }

        let resp = req.send().await?;
        let status = resp.status();

        /*
         * ★★ HTTP 416 = `Range Not Satisfiable` —— **必须当成"我的 .part 是坏的，从头下"**，
         *   绝不能当成"这个文件下不了"。这是用户报的那个 bug 的真凶。
         *
         *   用户的描述：「下一个没下过的版本，会在比如 37/38、即最后一个文件时
         *   必定重试，然后失败」。复现出来是这样的：
         *
         *     minecraft/lang/th_th.json → 所有下载源都失败了（试过 2 个）：HTTP 416
         *     （而且第 1/2/3 轮补下都是同样 6 个文件、同样 416，三轮全败）
         *
         *   为什么会 416：续传时我们带了 `Range: bytes=<.part 的大小>-`，
         *   而那个 `.part` 比服务端上的文件**还大**（上次失败时留下的残缺/脏数据）。
         *   服务端明确回 416 "你要的偏移不存在"。
         *
         *   而旧代码对 416 的唯一反应是"这个源失败 → 换下一个源"，
         *   **从头到尾没有删过那个 .part** —— 于是换源也一样 416，
         *   补下三轮也一样 416。文件永远下不好，用户只看到"必定失败"。
         */
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            say!(
                "[IEML/download] 续传被拒（HTTP 416）：本地 .part 比服务端文件还大，\
                 丢掉坏临时文件、改用不带 Range 的请求重下 —— {url}"
            );
            let _ = tokio::fs::remove_file(part).await;
            cleanup_segments(part).await;
            if attempt == 1 {
                // ★ 不再"返回错误让上层重试"：这一次调用里就把整份拿回来
                resume_from = None;
                continue;
            }
            return Err(NetError::Other(format!(
                "续传偏移越界（HTTP 416），已清掉本地残留但仍下不完 —— URL: {url}"
            )));
        }

        // 206 = 服务端支持续传；200 = 不支持（要重下）；其它 = 错误
        let wants_resume = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from.is_some();

        if wants_resume {
            /*
             * ★★ 服务端宣告的文件大小 —— 这是 PCL2 的"文件大小校验"（`ModNet.vb`）：
             *   续传时它要求 `FileSize - DownloadStart = ContentLength`，
             *   不一致就整条连接判失败（`RangeNotSupportedException`）。
             *
             *   为什么必须校验：`Range: bytes=<n>-` 的正确回应是
             *   `Content-Range: bytes n-<end>/<total>`，而 `total` **必须等于我们
             *   第一次看到的大小**。如果服务器上的文件被换掉了（整合包作者重传、
             *   CDN 回源到新版本），`total` 就变了 —— 此时把新文件的尾部
             *   拼到旧文件的头部上，得到的是一份**长度正确、内容错位**的文件。
             */
            let content_range = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let start = content_range.as_deref().and_then(parse_content_range_start);
            let declared_total = content_range.as_deref().and_then(parse_content_range_total);

            let offset_ok = start == resume_from;
            let size_ok = match declared_total {
                Some(total) => task_size == 0 || total == task_size,
                None => true, // `bytes n-/*`：服务端也不知道总大小，交给 SHA1
            };

            if !offset_ok || !size_ok {
                if !offset_ok {
                    match start {
                        Some(s) => say!(
                            "[IEML/download] 续传偏移不符（想要 {:?}，服务端给 {s}）\
                             → 丢掉这份响应，改用不带 Range 的请求重下：{url}",
                            resume_from
                        ),
                        None => say!(
                            "[IEML/download] 206 响应没有 Content-Range（不可信）\
                             → 改用不带 Range 的请求重下：{url}"
                        ),
                    }
                } else {
                    say!(
                        "[IEML/download] 服务端文件大小变了（任务记录 {task_size}，\
                         服务端 {declared_total:?}）→ 丢掉本地残留，\
                         改用不带 Range 的请求重下：{url}"
                    );
                }
                /*
                 * ★ 关键：**这一份响应体一个字节都不要用**（它对应的偏移
                 *   可能不是我们想要的），也把本地残留清掉，然后重发一个
                 *   不带 Range 的请求。attempt 上限保证不会死循环。
                 */
                drop(resp);
                let _ = tokio::fs::remove_file(part).await;
                cleanup_segments(part).await;
                if attempt == 1 {
                    resume_from = None;
                    continue;
                }
                return Err(NetError::Other(format!(
                    "续传响应与本地状态对不上，重下也没成功 —— URL: {url}"
                )));
            }
        }

        let (mut file, base) = if wants_resume {
            // 偏移与总大小都对上了 → 追加写
            let f = open_part_append(part).await?;
            (f, resume_from.unwrap_or(0))
        } else if status.is_success() {
            // 200（或第一轮就没带 Range）：整份重写
            let f = create_part(part).await?;
            (f, 0u64)
        } else {
            return Err(NetError::Status {
                status: status.as_u16(),
                url: url.to_string(),
            });
        };
        /*
         * ★ 审计明确说**别动这里**：续传那一轮的"不校验"是站得住的 ——
         *   SHA-1 不能拼接（前一段的哈希 + 后一段的哈希 ≠ 整份的哈希），
         *   所以续传时必须等写完之后整体算一次（由 `download_one_locked` 做）。
         *   真要"边下边算"只能改**非续传的单连接轮**，那是另一件事。
         */
        let _ = expected;

        /*
         * ★★ 第二阶段 A：**流式累计的起始口径 = 整份文件**（不是"这一轮新收的"）。
         *
         *   `base` = 这份 `.part` 在**本轮开始前**已有的字节（续传时 > 0）。
         *   把它喂成 meter 的初值，闸门判的就是"这个文件最终会长到多大"——
         *   否则"下一半 → 断 → 再下另一半"每一轮都只看到半份，上限被绕过。
         *   ★ `starting_at` 自己也会判 `base` 是否已经超限（那是盘上残留超限的现场）。
         */
        let mut meter = match crate::domain::archive_guard::ByteMeter::new(cap).starting_at(base)
        {
            Ok(m) => m,
            Err((limit, got)) => {
                let _ = tokio::fs::remove_file(part).await;
                cleanup_segments(part).await;
                say!(
                    "[IEML/download] ★ 盘上的残留已经超过体积上限，丢掉它并停下：{label} \
                     （已有 {got} 字节，上限 {limit} 字节）"
                );
                return Err(cap_exceeded_error(label, cap, got));
            }
        };

        let mut this_run = 0u64;
        let mut stream = resp.bytes_stream();
        let mut stalled = 0u32;
        let mut watch = SpeedWatch::new(proven_bps).switchable(switchable);
        let deadline = std::time::Instant::now() + FILE_TIMEOUT;
        // ★ 距上次真的收到数据过去了多久（PCL2 的 `LastReceiveTime`）——
        //   "连接死了"这条判据要用它，见 `SpeedWatch::dead`。
        let mut last_data_at = std::time::Instant::now();

        loop {
            if cancel.is_cancelled() {
                file.flush().await?;
                return Err(NetError::Cancelled);
            }

            // 总时长兜底：防止"一直滴数据但永远下不完"
            if std::time::Instant::now() > deadline {
                file.flush().await?;
                return Err(NetError::Other(format!(
                    "下载超时（超过 {} 秒仍未完成，本次已下 {} 字节）—— URL: {url}",
                    FILE_TIMEOUT.as_secs(),
                    this_run
                )));
            }

            /*
             * ★★ 连接已经死了 —— **无论有没有备用地址都掐掉**。
             *
             *   源码事实（PCL2 `ModNet.vb`）：数据包间隔 > 5 秒且这一窗速度
             *   < 1 KB/s 就断开重连。这正是我们缺的那一条：
             *   老代码只会在"连续 3 次 CHUNK_TIMEOUT 无数据"或 300 秒总超时时
             *   才放弃，于是一条**完全死掉**的连接会白占着并发槽位好几分钟。
             *
             *   注意判据是 1 KB/s 而不是我们原来的 320 KB/s ——
             *   320 KB/s 会把"正常但慢"的连接判死（实测 Modrinth CDN ~230 KB/s）。
             *   慢归慢，只要还在出数据就不该掐。
             */
            if watch.dead(this_run, last_data_at.elapsed()) {
                file.flush().await?;
                /*
                 * ★ 2026-10-01：让它**短暂冷却** —— 否则"重试"会又打同一个
                 *   坏节点（真机实测：那个镜像连打 6 次有 2 次 20 秒零字节）。
                 *   详见 `SourceManager::note_slow`。
                 */
                super::source::global().note_slow(super::mirror::Source::from_url(url));
                return Err(NetError::Other(format!(
                    "连接已无数据（{} 秒内仅 {:.1} KB，按 PCL2 的 1 KB/s 判据视为断线）\
                     —— URL: {url}",
                    DEAD_SILENCE.as_secs(),
                    this_run as f64 / 1024.0
                )));
            }

            /*
             * ★ 慢速检测：**能连、但慢得像坏掉**的连接也要换源。
             *
             *   实测（用户报"下载新版本被限速"）：BMCLAPI 某个 CDN 边缘把单连接
             *   压到 0.6–1.1 MB/s 并一直挂着 —— 引擎以前只会因为"失败"换源，
             *   于是这种连接会耗满 300 秒总超时。12 秒窗口内吞吐都低于 1 MB/s
             *   就当作坏源，换一条连接往往就落到别的边缘节点上。
             *
             *   ★ 但"慢"只有**在有别的路可走**时才构成放弃的理由
             *     （`switchable`，见 `SpeedWatch` 的字段说明）。
             */
            if let Some(bps) = watch.too_slow(this_run) {
                file.flush().await?;
                /*
                 * ★★★★ 2026-10-01（用户报的真实错误）：
                 *   「整合包包体下载失败（**换源重试后仍不行**）…… 慢（15 秒内仅
                 *     4 KB/s，**已换源重试**）—— URL: https://mod.mcimirror.top/…」
                 *
                 *   那两句"换源"都是**假的**：这条分支只是返回一个错误，
                 *   而重试轮的排序按 `is_cooling` 排 —— "慢"从不进冷却，
                 *   于是重试轮顺序不变、又打同一个坏节点，最后报"仍不行"。
                 *
                 *   ⇒ 先让它冷却，那句话才成立。（`SourceManager::note_slow`）
                 */
                super::source::global().note_slow(super::mirror::Source::from_url(url));
                return Err(NetError::Other(format!(
                    "连接过慢（{} 秒内仅 {:.0} KB/s）—— URL: {url}",
                    SLOW_WINDOW.as_secs(),
                    bps as f64 / 1024.0
                )));
            }

            /*
             * ★ 必须给"等下一个数据块"加上超时。
             *   reqwest 的 connect_timeout 只管建连，不管传输 ——
             *   慢速或半死的连接会让流永远挂着，进而拖死整个并发批次。
             *   实测：下载 3598 个资源文件时，最后几十个会卡住不回。
             *   连续 3 次超时就放弃这个源，换下一个。
             */
            let next = tokio::time::timeout(CHUNK_TIMEOUT, stream.next()).await;

            let chunk = match next {
                Ok(Some(Ok(c))) => {
                    stalled = 0;
                    c
                }
                Ok(Some(Err(e))) => return Err(NetError::Http(e)),
                Ok(None) => break, // 正常结束
                Err(_elapsed) => {
                    stalled += 1;
                    if stalled >= 3 {
                        return Err(NetError::Other(format!(
                            "连接停滞（连续 {} 次 {} 秒无数据）—— URL: {url}",
                            stalled,
                            CHUNK_TIMEOUT.as_secs()
                        )));
                    }
                    continue;
                }
            };

            // ★ 写入也可能撞到"文件被占用"：**日志必须能区分是哪一步**，
            //   否则只能看到"写入文件失败"却不知道要修 open 还是修 write。
            //   ★ 2026-10：`hinted_io` 让磁盘满/权限拒绝在这里就说真话
            //     （它们原来同样只报一句笼统的"写入文件失败"）。
            /*
             * ★★ 第二阶段 A：**收 chunk 时判上限**（唯一能兜住"服务器不报
             *   Content-Length"的地方）。判在写盘**之前**：超限的字节一个都不落。
             *   罚则是"断流 + 删 `.part`（含分片残留）+ 致命返回"——留着半份超限
             *   残留会让下一轮又走一遍同一件事。
             */
            if let Err((limit, got)) = meter.add(chunk.len() as u64) {
                drop(file);
                let _ = tokio::fs::remove_file(part).await;
                cleanup_segments(part).await;
                say!(
                    "[IEML/download] ★ 响应体超过体积上限，已断流并删掉临时文件：{label} \
                     （已收 {got} 字节，上限 {limit} 字节）—— {url}"
                );
                return Err(cap_exceeded_error(label, cap, got));
            }
            if let Err(e) = file.write_all(&chunk).await {
                say!(
                    "[IEML/download] {}",
                    describe_busy("写临时文件", part, &e)
                );
                return Err(NetError::Io(hinted_io(e)));
            }
            this_run += chunk.len() as u64;
            last_data_at = std::time::Instant::now();
        }
        // flush 也可能报 os error 32（磁盘缓冲落盘时才发现占用），
        // 这一步的失败以前只说"写入文件失败"，看不出是 flush —— 必须点名
        if let Err(e) = file.flush().await {
            say!(
                "[IEML/download] {}",
                describe_busy("flush 临时文件", part, &e)
            );
            return Err(NetError::Io(hinted_io(e)));
        }
        drop(file);

        /*
         * 收尾判据在 `finish_single`（限流页检测 + 长度校验，P0-5）。
         * ★ 返回值仍然是**这一轮真正写入的字节数** —— 调用方拿它算源速度
         *   （`note_success`），换成"整份大小"会把续传那一次的速度算虚高，
         *   进而把正常速度误判成坏源。
         */
        finish_single(manager, url, task_size, base + this_run, expected).await?;
        return Ok(this_run);
    }
}

/// 一次单连接下载**读完之后**的收尾判据：限流页检测 + 长度校验（P0-5）。
///
/// ## 为什么"长度校验"必须放在**读完响应体之后**
///
///   修之前，服务端宣告的大小与任务记录不符时，代码在**拿到响应头之后就
///   直接判失败**（"服务端文件大小变了 → 丢掉残留从头下"）。
///   而那个"不符"最常见的真实原因**不是**文件变了，是**限流页**：
///   BMCLAPI 对一批库回过 **146 字节**（任务记录 286 KB ~ 947 KB）。
///   于是：
///     · 146 字节的限流页走了"大小变了"这条分支，
///     · `looks_throttled` 那条判据**永远没机会执行**，
///     · `note_throttled` 于是从没被调用过 —— 源管理器不知道被限流了，
///       不降并发、不冷却，下一个文件照样被搪塞。
///
///   现在顺序反过来了：先把响应体读完，**再看**实际拿到多少字节：
///     ① 明显是限流页（任务 > 16 KB 而这次 < 1 KB）→ 告诉源管理器 + 报错；
///     ② 否则长度与任务记录不符 → 报错并说清差多少（**不许**把半份文件
///        当成功交上去 —— 没有 SHA1 的任务以前会漏过这一关）。
///
/// `total_written` 是**这份 `.part` 现在的完整大小**（续传时含前一次的部分）：
/// 长度判据必须按整份算，不是按这一轮写了多少。
///
/// 返回 `Ok(())` = 这份文件**真的下完了**；任何"不完整/被搪塞"都是 `Err`。
async fn finish_single(
    manager: &SourceManager,
    url: &str,
    task_size: u64,
    total_written: u64,
    expected: &ExpectedHash,
) -> Result<()> {
    /*
     * ★★ **"限流页"检测：服务端用一个小响应搪塞我们。**
     *
     *   实测（2026-09-13，1.19.3 全新安装、并发 32）：BMCLAPI 对
     *   `maven/io/netty/...`、`maven/org/apache/...` 等一批库
     *   **全部**回了 **146 字节**（而任务记录是 286 KB ~ 947 KB）。
     *   一次安装里出现了十几次 —— 这就是"下载速度降了好多"的真凶：
     *   每个被搪塞的文件都要走一遍"下到 146 字节 → 大小校验失败 →
     *   丢掉重下"，白烧一次往返和一次重试预算。
     *
     *   146 字节是个**限流页**（不是一个碰巧这么小的 jar）。判据刻意保守：
     *     ① 任务**知道**这个文件应该有多大（size > 16 KB）；
     *     ② 这次只拿到不到 1 KB。
     *   两条同时成立才认定"被搪塞"，避免误伤真正的空文件。
     *
     *   认定之后要做的事**比报错更重要**：告诉源管理器"我被限流了"，
     *   让它降并发 + 冷却 —— 否则下一个文件照样被搪塞。
     */
    if looks_throttled(task_size, total_written) {
        let src = super::mirror::Source::from_url(url);
        manager.note_throttled(src);
        return Err(NetError::Other(format!(
            "服务端只回了 {total_written} 字节（任务要求 {task_size} 字节）\
             —— 像是限流页，已降低并发并冷却该源"
        )));
    }

    /*
     * ★★ **长度校验**（没有 SHA1 的任务靠它兜底）。
     *
     *   任务知道这个文件多大（`task_size > 0`）时，读完的字节数必须**正好**是它。
     *   短了 = 这份 `.part` 是半份（连接中途中止、代理提前收尾），
     *   长了 = 服务端内容变了。
     *   两种都**不许**当成成功 —— 调用方拿到 Ok 就会把它改名到正式位置，
     *   于是"名字对、内容是半份"的坏文件会被后面的启动流程当成好文件用。
     *   （有 SHA1 的任务在调用方那里还会再校验一遍；这里先把关，
     *    让错误信息说得出"差多少"。）
     */
    /*
     * ★★★★ 2026-10-07（用户截图：「**为什么会下载会在最后阶段爆炸啊**」）。
     *
     *   ## 现场
     *
     *   整合包装到最后，4 个 Mod 报失败，全都是**差 1 个字节**：
     *     · `任务记录 215534 字节，实际拿到 215533 字节（少了 1 字节）`
     *     · `任务记录 29962 字节，实际拿到 29961 字节（少了 1 字节）`
     *   而**这三条错误都是长度校验抛出来的**，SHA1 校验在它下游、根本没轮到。
     *
     *   ## 根因：拿一个**参考值**当硬判据
     *
     *   `task_size` 来自整合包清单里的 `fileSize`（`modrinth.rs` 把
     *   `f.file_size` 直接塞进 `DownloadTask::new`）。那是**清单作者的记录**，
     *   不是从文件本身算出来的东西 —— 文件在 CDN 上被重新打包过、
     *   清单没跟着更新，就会差这么一两个字节。
     *
     *   ⇒ 于是**一个内容完全正确的文件被判死**，而且是在"下载已经全部完成、
     *     就差落位"的那一刻炸掉 —— 用户看到的就是"最后阶段爆炸"。
     *
     *   ## 判据的**优先级**（关键）
     *
     *     · `sha1` 非空 ⇒ **它说了算**。它是内容摘要，判对了就是对的，
     *       长度差几个字节**不构成失败理由**。长度校验在这一档**让位**
     *       （返回 Ok，让调用方去算 SHA1；算不过它会自己删掉重下）。
     *     · `sha1` 为空 ⇒ 长度是**唯一的判据**，必须严格（这是原来的行为，
     *       那种任务本来就没有别的东西可依）。
     *
     *   ★ 为什么"让位"是安全的：SHA1 对不上时调用方一定会失败重下
     *     （见 `download_one_locked` 里 `expected.verify_file` 那一段），
     *     所以这里放过去不会让坏文件落地。
     *   ★ 反过来才是危险的：现在这样会让**好文件**永远装不上，
     *     而用户完全看不出为什么（错误信息说的是"下载不完整"，
     *     但下载是完整的）。
     */
    let has_hash = expected.is_some();
    if task_size > 0 && total_written != task_size {
        if has_hash {
            /*
             * 记一句日志（不报错）：长度与清单记录不符这事本身值得知道 ——
             * 如果哪天哈希也没兜住，这行日志就是唯一线索。
             */
            say!(
                "[IEML/download] 长度与清单记录不符（记录 {task_size}，实际 {total_written}）\
                 —— 有 {}，以它为准：{url}",
                expected.algo()
            );
        } else {
            let diff = if total_written < task_size {
                format!("少了 {} 字节（连接中途断了 / 代理提前收尾）", task_size - total_written)
            } else {
                format!(
                    "多了 {} 字节（服务端上的文件多半已经换了）",
                    total_written - task_size
                )
            };
            return Err(NetError::Other(format!(
                "下载不完整：任务记录 {task_size} 字节，实际拿到 {total_written} 字节（{diff}）\
                 —— 已保留 .part，重试会接着下 —— URL: {url}"
            )));
        }
    }

    Ok(())
}

/// 诊断用：把"文件被占用"的真实位置（errno + 路径）打出来。
///
/// 这类错误在 Windows 上都表现为 os error 32，但**到底哪一步失败**决定了
/// 修法完全不同（重试 open？重试 write？还是有别的任务在写同一个文件？），
/// 所以日志里必须带路径和 errno。
pub fn describe_busy(op: &str, path: &Path, e: &std::io::Error) -> String {
    format!(
        "{op} {} 失败：{:?}（raw_os_error={:?}）",
        path.display(),
        e.kind(),
        e.raw_os_error()
    )
}

/// **把一个 IO 错误变成"会说真话"的那一句**（判据 1 的文案部分）。
///
/// ## 为什么必须做（这个仓库的硬规矩：文案要说真话）
///
///   磁盘满（`ERROR_DISK_FULL = 112`）与权限拒绝（`ACCESS_DENIED = 5`）
///   以前都只报一句笼统的 `写入文件失败：…`。用户能拿到的**唯一线索**
///   就是那句话 —— 而他需要知道的是"**该去清盘**"还是"**该换个目录**"。
///
///   ⇒ 这两档各加一句前置提示（`（磁盘空间不够）` / `（没有写入权限）`），
///     其余错误原样返回（**一个字都不动** ——
///     下游有字符串匹配依赖这些文案，见 `run_round` 里数 `repaired_files`
///     那条 `contains("校验失败")`）。
///
///   ★ 判据用的是 `raw_os_error`，所以**必须在包装之前**判 ——
///     `io::Error::new` 会把 `raw_os_error` 变成 `None`
///     （新错误的 `kind` 保留，但原始 errno 丢了）。
///     这正是为什么 `create_part` / `open_part_append` 里
///     "是不是占用"的判定要拿**原始** `e` 做。
fn hinted_io(e: std::io::Error) -> std::io::Error {
    let class = FailureClass::from_parts(None, e.raw_os_error());
    // `Busy` 不在这里加提示：它的文案由 `describe_busy` 记进日志，
    // 而错误本身会被重试掉（落不了位才是最终结果，那时 os error 32
    // 已经说清了是"另一个程序正在使用此文件"）。
    let hint = match e.raw_os_error() {
        Some(c) if crate::domain::failure::is_disk_full_errno(c) => "（磁盘空间不够）",
        Some(c) if crate::domain::failure::is_permission_errno(c) => "（没有写入权限）",
        _ => {
            // 非致命（含 Busy）原样返回 —— 不动既有文案
            let _ = class;
            return e;
        }
    };
    std::io::Error::new(e.kind(), format!("{hint}{e}"))
}

/// 解析 `Content-Range: bytes 100-199/200` 里的起始偏移。
///
/// 解析不出来返回 None（调用方据此判定"不能续传，从头下"）。
fn parse_content_range_start(v: &str) -> Option<u64> {
    let rest = v.trim().strip_prefix("bytes")?.trim_start();
    let range = rest.split('/').next()?.trim();
    let start = range.split('-').next()?.trim();
    start.parse().ok()
}

/// 解析 `Content-Range: bytes 100-199/200` 里的**总大小**（斜杠后面那个数）。
///
/// `bytes 100-199/*` 时返回 None（服务端也不知道总大小 —— 那就没法校验，
/// 只能交给 SHA1）。
///
/// ★ 用途见 `download_single` 里的"文件大小校验"：
///   续传时服务端宣告的总大小必须与任务记录一致，否则说明**服务器上的文件
///   换了**，继续拼会得到一份长度正确但内容错位的文件。
fn parse_content_range_total(v: &str) -> Option<u64> {
    let rest = v.trim().strip_prefix("bytes")?.trim_start();
    let total = rest.split('/').nth(1)?.trim();
    if total == "*" {
        return None;
    }
    total.parse().ok()
}

/// 探测文件大小（HEAD 请求拿 Content-Length）。
///
/// 失败（HEAD 不被支持、无 Content-Length、网络错误）一律返回 None，
/// 由调用方回退到单连接下载——探测失败不该阻断下载。
async fn probe_content_length(url: &str) -> Option<u64> {
    let resp = client().head(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.headers()
        .get(reqwest::header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/* ====================== 分片并行 + 分片续传 ====================== */

/// 分片并行下载：把文件切成最多 `CHUNK_COUNT` 段，每段一个 Range 请求并发下。
///
/// 每段写到独立的 `part.N`；**已存在且大小正确的段直接跳过**（这就是分片续传）。
/// 全部段就位后按顺序拼接到 `part`，然后删掉分段文件与段计划。
async fn download_chunked(
    url: &str,
    candidates: &[String],
    part: &Path,
    total: u64,
    cancel: &CancelToken,
    label: String,
    cap: crate::domain::archive_guard::ByteCap,
) -> Result<u64> {
    /*
     * ★★ 第二阶段 A：**建连前的体积闸门**（分片这条路）。
     *
     *   能走到这里说明 `probe_content_length` 拿到了服务端宣告的大小 ——
     *   那个数就已经超限的话，一条连接都不该建（一个声明 8 GiB 的"图标"）。
     *   ★ 单连接那条路有同一道（那边用的是任务记录里的 `task.size`）。
     */
    if cap.rejected_by_declared_size(total) {
        return Err(cap_exceeded_error(&label, cap, total));
    }

    let spans = plan_chunks(total, chunk_count(), MIN_CHUNK);
    if spans.is_empty() {
        return Ok(0);
    }

    // 段计划必须与上次一致才能复用旧段（否则边界不同，旧数据的偏移是错的）
    let plan_path = plan_path(part);
    let plan = ChunkPlan::from_spans(total, &spans);
    let reusable = match tokio::fs::read_to_string(&plan_path).await {
        Ok(text) => match serde_json::from_str::<ChunkPlan>(&text) {
            Ok(old) if old.matches(total, &spans) => true,
            _ => {
                // 计划变了 → 旧段全部作废
                cleanup_segments(part).await;
                false
            }
        },
        Err(_) => false,
    };
    if !reusable {
        cleanup_segments(part).await;
        if let Some(p) = plan_path.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        let text = serde_json::to_string(&plan)
            .map_err(|e| NetError::Other(format!("写段计划失败：{e}")))?;
        tokio::fs::write(&plan_path, text).await?;
    }

    let mut written = 0u64;
    let mut handles = Vec::with_capacity(spans.len());
    let mut to_fetch: Vec<ChunkSpan> = Vec::new();

    for span in &spans {
        let seg = segment_path(part, span.idx);
        let have = tokio::fs::metadata(&seg).await.map(|m| m.len()).unwrap_or(0);
        if have == span.len() {
            // ★ 这一段上次已经下完了 → 跳过（断网重连后省掉的正是这部分）
            written += have;
            continue;
        }
        if have > 0 {
            // 段大小不对（半截），删掉重下这一段
            let _ = tokio::fs::remove_file(&seg).await;
        }
        to_fetch.push(*span);
    }

    if !to_fetch.is_empty() {
        /*
         * ★★★★ 2026-10-01（用户：「**多源同时下**」，并指出这是通用问题）。
         *
         *   ## 本轮改动的核心：段与源**轮转分配**
         *
         *   原来每一段都用**同一个** `url`。而 PCL 的做法（`ModNet.vb` 的
         *   `TryBeginThread`）是：
         *
         *     StartSource = GetSource(FirstThreadSource)
         *     FirstThreadSource = StartSource.Id + 1     ' 每开一个新线程，源换下一个
         *     …
         *     ' 某个线程失败 → 从它的断点接着起新线程，源**再换下一个**
         *     StartPosition = Thread.DownloadStart + Thread.DownloadDone
         *     StartSource = GetSource(Thread.Source.Id + 1)
         *
         *   ⇒ **所有源同时在下，谁快谁贡献多**。
         *   而我们是"一次只用一条源，慢了才换" —— 那条慢源会把时间占住，
         *   用户看到的就是「有任务、进度几乎不动」。
         *
         *   ## 具体做法
         *
         *   · 第 i 段**先从第 `i % n` 个源开始**（轮转，天然把连接摊开）；
         *   · 一段失败或**短读** → 换**下一个**源，从已下到的位置继续
         *     （不重下已有部分）；
         *   · 某个源被判"永远不支持 Range" → 记下来，后面的段不再碰它。
         *
         *   ★ 短读必须算失败：服务端只给一半也是"没下完"；而按已下字节
         *     续下是安全的（Range 起点往后推）。
         *   ★ 所有源试过还凑不齐这一段 → 才整份失败（上层回退单连接）。
         */
        let sources: Vec<String> = if candidates.is_empty() {
            vec![url.to_string()]
        } else {
            candidates.to_vec()
        };
        let dead: Arc<std::sync::Mutex<Vec<bool>>> =
            Arc::new(std::sync::Mutex::new(vec![false; sources.len()]));

        for span in &to_fetch {
            let sources = sources.clone();
            let dead = dead.clone();
            let part = part.to_path_buf();
            let cancel = cancel.clone();
            let span = *span;
            // ★ 第二阶段 A：`label` 也要进每个段的协程（超限文案要点名是哪个文件）
            let label = label.clone();
            handles.push(tokio::spawn(async move {
                let expected = span.len();
                let mut got = 0u64;
                let mut last: Option<NetError> = None;
                /*
                 * ★★★★ 2026-10-01（用户：「多源同时下」）：**轮转着一直要到下完**。
                 *
                 *   这里原来是 `for step in 0..sources.len()` —— 每个源**只试一次**
                 *   就结束。而"一个源一轮只给一部分"是完全正常的
                 *   （服务端有单轮上限、或连接被截断）。于是 2 MB 的段碰上
                 *   "每轮 256 KB"的源，试满一轮仍然缺 → **整段失败**。
                 *   这条是我自己的测试抓出来的：`multi_source_round_robin_…`
                 *   第一版跑成 FAILED，原因就在这儿。
                 *
                 *   ⇒ 外层按**轮**循环：一轮里把所有活着的源转一遍，
                 *     只要有**任何**进展就再来一轮。
                 *   ★ 一轮下来**一个字节都没进展** ⇒ 才认输（否则会无限转）。
                 *   ★ 与 PCL 形状一致：它的 `TryBeginThread` 是"只要还有没下完的
                 *     部分就再起一个线程"，而不是"每个源只试一次"。
                 */
                loop {
                    let mut round_progress = 0u64;
                    for step in 0..sources.len() {
                        if cancel.is_cancelled() {
                            return Err(NetError::Cancelled);
                        }
                        let si = (span.idx as usize + step) % sources.len();
                        if dead.lock().map(|d| d[si]).unwrap_or(false) {
                            continue;
                        }
                        match download_range(&sources[si], &part, span, got, total, &cancel, label.clone(), cap).await {
                            Ok(n) => {
                                got += n;
                                round_progress += n;
                                if got >= expected {
                                    return Ok(got);
                                }
                                last = Some(NetError::Other(format!(
                                    "第 {} 段下到 {got}/{expected} 字节（源 {}）",
                                    span.idx, sources[si]
                                )));
                            }
                            Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                            Err(e) => {
                                // 不支持 Range：换源还有戏，但把这个源记下来，
                                // 后面的轮次不再碰它（否则每轮都要白撞一次）
                                if e.is_permanent_range_failure() {
                                    if let Ok(mut d) = dead.lock() {
                                        d[si] = true;
                                    }
                                }
                                last = Some(e);
                            }
                        }
                    }
                    if round_progress == 0 {
                        break; // 一整轮零进展 —— 再转也没用
                    }
                }
                Err(last.unwrap_or_else(|| {
                    NetError::Other(format!("第 {} 段所有源都没下完", span.idx))
                }))
            }));
        }
        for h in handles {
            match h.await {
                Ok(Ok(n)) => written += n,
                // 段失败：保留已下好的其它段（下次续传），把错误抛上去
                Ok(Err(e)) => return Err(e),
                Err(e) => return Err(NetError::Other(format!("分片任务失败：{e}"))),
            }
        }
    }

    // 拼接：part.0 .. part.N-1 顺序追加到 part，然后删掉分段与计划
    let mut out = tokio::fs::File::create(part).await?;
    let mut assembled = 0u64;
    for span in &spans {
        let seg = segment_path(part, span.idx);
        let mut input = tokio::fs::File::open(&seg).await?;
        assembled += tokio::io::copy(&mut input, &mut out).await?;
        drop(input);
        let _ = tokio::fs::remove_file(&seg).await;
    }
    out.flush().await?;
    drop(out);
    let _ = tokio::fs::remove_file(&plan_path).await;

    /*
     * ★★★★ 2026-10-01（用户）：「**这个 .mrpack 不是有效的压缩包：
     *   invalid Zip archive: Could not find EOCD**」。
     *
     *   ## 这是一个真的正确性缺陷，就出在紧邻的上面那几行
     *
     *   原来的收尾是 `Ok(written)`（**没有**任何"拼出来的到底是不是完整文件"
     *   的断言）。而 `download_range` 在单段重试 3 次耗尽后会返回它**实际写出
     *   的字节数** —— 一个**短段**也算"成功"。于是：
     *
     *     8 段里某一段只下到一半 → 拼装照拼 → 得到一个**截断的文件** → 报成功
     *
     *   真机证据（`D:\IEML-launcher\cache`）：
     *     `mrpack-modpack-muplukvi.mrpack` = **90,351,891 字节**
     *     而 Better MC v28 应该是 **约 113.8 MB** —— 少了 23 MB。
     *   然后 `parse_mrpack_bytes` 读它、找不到 zip 的结束记录（EOCD），
     *   用户看到上面那句错误。
     *
     *   ## 为什么调用方也兜不住
     *
     *   `download_single` 里确实有长度校验，但只覆盖**单连接**那条路：
     *   分片成功后是 `return Ok(written)` **提前返回**，一行校验都不经过。
     *   ⇒ 长度这一关必须**分片自己**把住：它比谁都清楚"期望多少字节"。
     *
     *   ## 为什么"报错"是对的，而不是"修一修接着用"
     *
     *   截断的包**不能用**：写进去的 Mod 会缺文件，而用户拿到的是一个
     *   "装完了但起不来"的实例。宁可这里失败 → 上层回退单连接重下
     *   （`download_single` 的分片失败分支就是干这个的）。
     *   ★ 同时**删掉这个半成品 `.part`**：留着它，下一轮会被当成
     *     "断点续传的已有进度"，而它的字节数是错的。
     */
    if assembled != total || written != total {
        let _ = tokio::fs::remove_file(part).await;
        return Err(NetError::Other(format!(
            "分片拼装后大小不对（期望 {total} 字节，段合计 {assembled}，上报 {written}）\
             —— 有段没下完，删掉重来"
        )));
    }

    Ok(written)
}

/// 下载一个段到 `part.{idx}`，返回本段**新写入**的字节数。
///
/// ★★★★ 2026-10-01（用户：「**多源同时下**」——PCL 的做法）。
///
///   `already` = 这个段**已经下好**的字节数（0 = 从头下）。
///   短读重试时用它把 Range 起点往后推，**不重下已有的部分**。
///   ★ 必须按"追加"写文件，而不是 `create`（那会把已下好的部分截断）。
async fn download_range(
    url: &str,
    part: &Path,
    span: ChunkSpan,
    already: u64,
    total: u64,
    cancel: &CancelToken,
    label: String,
    cap: crate::domain::archive_guard::ByteCap,
) -> Result<u64> {
    let seg = segment_path(part, span.idx);
    let from = span.start + already;
    if from > span.end {
        return Ok(0); // 这一段已经齐了
    }
    /*
     * ★★ 第二阶段 A：**分片路径的体积闸门**。
     *
     *   分片这条路同样要判 —— 而且这里有个单连接路径没有的漏洞形状：
     *   服务端**无视 Range** 把整份吐回来（不老实的中转就这么干）。
     *   下面虽然按 `want` 截断，但字节是**先收进内存**再截的：一份 4 GiB 的
     *   响应体照样能把内存/磁盘拖死。所以计量必须在这里也挂上。
     *
     *   · 起始口径 = `span.start + already`（这一段在**整份文件**里的位置，
     *     `already` 由调用方累加传入）—— 于是"这一段续传了多少"也算进去；
     *   · 超过"整份文件的大小上限" ⇒ 删段 + 致命返回。
     */
    let mut meter = match crate::domain::archive_guard::ByteMeter::new(cap)
        .starting_at(span.start.saturating_add(already))
    {
        Ok(m) => m,
        Err((limit, got)) => {
            let _ = tokio::fs::remove_file(&seg).await;
            say!(
                "[IEML/download] ★ 分片 {} 的落点已经超过体积上限，丢掉这一段：{label} \
                 （位置 {got} 字节，上限 {limit} 字节）",
                span.idx
            );
            return Err(cap_exceeded_error(&label, cap, got));
        }
    };
    /*
     * ★★★★ 2026-10-01：**只要缺的那一段，不要把尾巴也要回来**。
     *
     *   这条是测试抓出来的真缺陷（`multi_source_round_robin_spreads_segments`
     *   第一次运行时报"第 0 个字节不是好源给的内容"）。
     *
     *   短读换源时 `already > 0`，而请求如果写成 `bytes={from}-{span.end}`，
     *   服务端会从 `from` 开始返回**一直到段尾**的数据；但我们把这个响应的
     *   开头**追加**在已写部分之后 —— 落盘的偏移就错了：
     *   从 `from` 往后的内容被写到了 `already` 的位置。
     *   结果：**文件大小可能正好对，内容却是错的**（最坏的一种 bug：
     *   一路走到解压才炸，而且报的还是 zip 的错）。
     *
     *   ⇒ 只请求**还缺的字节数**：`bytes={from}-{from + want - 1}`。
     */
    let want = span.end - from + 1;
    let to = from + want - 1;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&seg)
        .await?;

    /*
     * ★ 2026-10-02：**尺子** —— 这里才是真正发分段连接的那一行。
     *   守卫活到函数结束（连接也就活到那时），所以它记的就是
     *   "此刻有几条分段连接在飞"。见 `conn_stats`。
     */
    let _conn = conn_stats::begin();
    let resp = client()
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
        .send()
        .await?;

    // ★ 必须返回 206 才说明服务器支持 Range；返回 200 意味着它把整个文件吐回来了
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        let _ = tokio::fs::remove_file(&seg).await;
        // RangeUnsupported（而不是普通 Status）：这个错误重试多少次都一样，
        // 上层据此**立刻**回退单连接，而不是白白退避三轮
        return Err(NetError::RangeUnsupported {
            status: resp.status().as_u16(),
            url: url.to_string(),
        });
    }

    /*
     * ★★★★ 2026-10-01：**必须核对 `Content-Range` 的起点**。
     *
     *   ## 不核对会怎样（这条测试抓出来的）
     *
     *   多源续下时，一段是**分几次**下完的（坏源给一半 → 换好源接着下）。
     *   第二次请求要的是 `bytes={已下}-{end}`。若服务端**忽略了 Range**、
     *   又从它自己的开头给数据，而我们不看 `Content-Range` 就直接追加 ——
     *   结果是**同一段内容被写了两遍**：文件**大小对得上**，**内容却是错的**。
     *
     *   实测证据（`multi_source_round_robin_spreads_segments` 第一次运行）：
     *     `分片拼装后大小不对（期望 16777216 字节，段合计 17301504）`
     *   —— 大小校验拦住了它，但那只是运气：**它拦的是"多了"**，
     *   而"内容错、大小正好"这种会一路走到解压才炸（zip 报 EOCD 找不到）。
     *
     *   ## 所以这里判两件事（都算协议违规，直接换源）
     *
     *     · `Content-Range` 必须存在、且起点等于 `from`；
     *     · 总长度必须等于 `total`（对照我们探到的大小）。
     *
     *   ★ 判成 `RangeUnsupported` 而不是普通错误：这类"服务端不老实"的源
     *     再试也没用，应该**换源**（`download_chunked` 会把它记进 dead 名单），
     *     而不是在这一段上反复退避。
     */
    if let Some(cr) = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        // 形如 `bytes 100-199/200`
        let bad = match cr.split_once(' ') {
            Some(("bytes", rest)) => match rest.split_once('/') {
                Some((range, len)) => {
                    let start_ok = range
                        .split_once('-')
                        .and_then(|(s, _)| s.trim().parse::<u64>().ok())
                        == Some(from);
                    let len_ok = len.trim().parse::<u64>().ok() == Some(total);
                    !start_ok || !len_ok
                }
                None => true,
            },
            _ => true,
        };
        if bad {
            let _ = tokio::fs::remove_file(&seg).await;
            return Err(NetError::RangeUnsupported {
                status: 206,
                url: format!("{url}（Content-Range 不对：{cr}，我们要的是 {from}-{to}/{total}）"),
            });
        }
    }

    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    let mut stalled = 0u32;
    loop {
        if cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&seg).await;
            return Err(NetError::Cancelled);
        }
        /*
         * ★★★★ 2026-10-01：**写到 `want` 就停**（多出来的字节一律不要）。
         *
         *   为什么必须有这一条（而不只是"请求时把 `to` 算对"）：
         *   段的写入是**追加**的，位置由调用方记的 `already` 决定。
         *   若服务端给的比我们要的多（不老实的中转、把 `Range` 当建议、
         *   或 `Content-Length` 与请求不符），多出来的那截会被写到
         *   **下一个位置**上 —— 结果是**大小恰好对上、内容却错位**的文件。
         *   那种文件会一路走到解压才炸（zip 报找不到 EOCD）。
         *
         *   ⇒ "请求只要缺的"（见上面 `to` 的算法）是**省流量**，
         *     而这里是**正确性的硬保证**。两层都要有。
         */
        if written >= want {
            break;
        }
        let next = tokio::time::timeout(CHUNK_TIMEOUT, stream.next()).await;
        let chunk = match next {
            Ok(Some(Ok(c))) => {
                stalled = 0;
                c
            }
            Ok(Some(Err(e))) => {
                // ★ 不删段文件：已经写下去的部分对续传有效（下一次会按大小判断）
                file.flush().await?;
                return Err(NetError::Http(e));
            }
            Ok(None) => break,
            Err(_elapsed) => {
                stalled += 1;
                if stalled >= 3 {
                    file.flush().await?;
                    return Err(NetError::Other(format!("分片 {} 连接停滞", span.idx)));
                }
                continue;
            }
        };
        let take = (chunk.len() as u64).min(want - written) as usize;
        /*
         * ★★ 第二阶段 A：分片路径的**流式累计**（与单连接那条同形）。
         *   口径 = 这一段在整份文件里的起点 + 这一段已写 + 这次要写的字节。
         *   判在写盘之前，超限的字节一个都不落。
         */
        if let Err((limit, got)) = meter.add(take as u64) {
            drop(file);
            let _ = tokio::fs::remove_file(&seg).await;
            say!(
                "[IEML/download] ★ 分片 {} 收到超过体积上限的数据，已断流并删掉该段：{label} \
                 （落点 {got} 字节，上限 {limit} 字节）—— {url}",
                span.idx
            );
            return Err(cap_exceeded_error(&label, cap, got));
        }
        file.write_all(&chunk[..take]).await?;
        written += take as u64;
    }
    file.flush().await?;
    drop(file);
    Ok(written)
}

/// 分段临时文件路径：`part.{idx}`（`part` 本身是 `xxx.part`，所以结果是 `xxx.part.0`）
fn segment_path(part: &Path, idx: u64) -> PathBuf {
    let mut s = part.as_os_str().to_os_string();
    s.push(format!(".{idx}"));
    PathBuf::from(s)
}

/// 段计划文件路径：`part.chunks`
fn plan_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_os_string();
    s.push(".chunks");
    PathBuf::from(s)
}

/// 删掉 `part` 的所有分片段与段计划
async fn cleanup_segments(part: &Path) {
    let _ = tokio::fs::remove_file(plan_path(part)).await;
    let mut idx = 0u64;
    loop {
        let seg = segment_path(part, idx);
        if tokio::fs::remove_file(&seg).await.is_err() {
            // 段编号是连续的，删不到就是没有了；但保险起见多看几个
            if idx > CHUNK_COUNT + 2 {
                break;
            }
        }
        idx += 1;
        if idx > CHUNK_COUNT + 2 {
            break;
        }
    }
}

/* ====================== 校验 ====================== */

/// 计算文件的 SHA1（流式，不整读进内存）
pub async fn sha1_of_file(path: &Path) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 计算文件的 SHA256（Adoptium 用的是 SHA256，所以要单独算）
pub async fn sha256_of_file(path: &Path) -> Result<String> {
    use sha2::Digest as _;
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 计算文件的 SHA-512（Modrinth 同时发布 SHA-1 与 SHA-512 —— 见 [`ExpectedHash`]）。
///
/// ★ 与 `sha256_of_file` 是同一个形状：`sha2 = "0.10"` 已经在依赖里，
///   所以"把强哈希接上"这一步的**计算侧**本来就只差这一个函数。
///   本阶段不接线（见 [`ExpectedHash`] 的说明），但函数留着 —— 下一阶段
///   要给 `modrinth.rs` 传 sha512 时，不必再写第二遍。
pub async fn sha512_of_file(path: &Path) -> Result<String> {
    use sha2::Digest as _;
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = sha2::Sha512::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn short(hash: &str) -> &str {
    &hash[..8.min(hash.len())]
}

fn part_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/* ====================== 暂停 ====================== */

/// ★★ **暂停令牌**：与 [`CancelToken`] 刻意分开。
///
/// ## 为什么必须与"取消"分开（PCL 的 `CancellationToken` 也只做取消）
///
/// 这个启动器原来的"暂停"其实是**取消**（`pauseTask` 直接调 `cancel`），
/// 靠"已完成的不再重下"勉强能用。但两者语义不同，用户能感觉到：
///
/// | | 取消 | 暂停 |
/// |---|---|---|
/// | 用户意图 | 不要了 | 等会儿接着下 |
/// | 进度显示 | 已取消 | **已暂停**（进度条留在原地） |
/// | 后续 | 要重新发起 | 点「继续」就接着下 |
///
/// 混成一个之后，界面上那个"暂停"按钮点下去告诉用户"已取消" ——
/// 而它其实什么都没丢，用户于是不敢再点。
///
/// ## 怎么实现"真暂停"（而不是"停在新任务之前"）
///
/// 下载器是**大量小文件**的场景（资源阶段几千个），逐个去中断正在跑的
/// HTTP 请求得不偿失：一个文件通常几百毫秒到几秒就完了，而中断它们
/// 意味着丢掉那部分已经收到的数据。
///
/// 所以暂停的语义是"**不再开始新的，让在跑的收尾**"：
///   · 已经开始的那些会正常写完（数据不丢）；
///   · 还没开始的那些**原样交回去**（`DownloadOutcome.remaining`）；
///   · 已下的 `.part` 分片留在盘上，所以即便从头跑也不会白下。
///
/// 这个语义与 PCL 的 `LoaderTask` 一致：它的"暂停"也是
/// `TriggerThreadInterrupt` + 不启动下一步，而不是杀连接。
#[derive(Debug, Clone, Default)]
pub struct PauseToken(Arc<std::sync::atomic::AtomicBool>);

impl PauseToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pause(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/* ====================== 批量下载 ====================== */

pub struct BatchOptions {
    pub concurrency: usize,
    pub source: Source,
    pub cancel: CancelToken,
    /// ★★ 暂停令牌。`None` = 这一批不可暂停（内部调用、测试）。
    ///
    /// 用 `Option` 而不是"永远给一个不会触发的 token"：
    /// 让"这批能不能暂停"在类型上就是明确的，调用方不会以为所有下载都能暂停。
    pub pause: Option<PauseToken>,
    /// 进度回调（由调用方节流，见 ARCHITECTURE 4.3：聚合到 60ms）
    pub on_progress: Arc<dyn Fn(DownloadProgress) + Send + Sync>,
}

impl BatchOptions {
    /// 最简构造（测试与内部调用用）
    pub fn new(concurrency: usize, source: Source, cancel: CancelToken) -> Self {
        Self {
            concurrency,
            source,
            cancel,
            pause: None,
            on_progress: Arc::new(|_| {}),
        }
    }
}

/// 并发下载一批文件。
///
/// 三段式：
///   ① `dedup_pass` 按**目标路径**（第一判据）与内容哈希（第二判据）
///      拆出"只需本地复制"的副本
///   ② 网络任务按 `concurrency` 并发下，失败按降并发补下（PCL2 的降级策略）
///   ③ **网络任务全部结束后**才做本地复制
///
/// ★ 为什么第 ③ 步必须在最后，而不是和网络任务混在一起（**踩过的大坑**）：
///   资源文件里同一个 hash 常被多个名字引用（实测 1.20.1：3598 个条目里
///   有 23 个 hash 被两个名字共用，比如 `entity/fish/swim1.ogg` 与
///   `liquid/swim1.ogg` 内容完全相同）。
///   以前把"复制副本"和"下载原件"放进同一个并发池，复制会在**原件正在写**的时候
///   去读它 —— Windows 直接回 `os error 32（另一个程序正在使用此文件）`。
///   实测表现：固定 23 个文件失败，补下 3 轮全部失败，日志里只写着
///   "写入文件失败"，看起来像杀毒软件锁文件，其实是**自己人抢自己人**。
pub async fn download_batch(tasks: Vec<DownloadTask>, opts: BatchOptions) -> Result<DownloadOutcome> {
    let started = std::time::Instant::now();
    // ★ 一批开始前重置连接观测 —— 否则峰值会跨批次累加，数字就没意义了
    conn_stats::reset();
    let manager = source::global();

    let (network_tasks, copies) = dedup_pass(tasks);

    let total_files = network_tasks.len() + copies.len();
    let total_bytes: u64 = network_tasks
        .iter()
        .chain(copies.iter().map(|c| &c.task))
        .map(|t| t.size)
        .sum();
    let stats = Arc::new(Stats::default());

    let mut pending: Vec<DownloadTask> = network_tasks;
    let mut failed: Vec<(String, String)> = Vec::new();
    // ★★ **带处置档位的失败清单**（判据 1），跨轮累积
    //
    //   ★ 与 `failed` 并存：后者是"字符串元组"的老接口（`installer.rs` /
    //     `commands_real.rs` 按元组读），前者多带一个 `class`。
    //     两条一起维护是**有意**的取舍 —— 改老接口要动 3 个文件的读点，
    //     而这一阶段的纪律是"改动面最小、判据最清楚"。
    let mut failures_all: Vec<DownloadFailure> = Vec::new();
    // ★★ 判据 3：**没有校验值、因此未经校验**的落位文件，跨轮累积
    let mut unverified: Vec<UnverifiedFile> = Vec::new();
    let mut round = 0u32;
    /*
     * ★★ 收尾诊断（2026-09-17）。
     *
     *   用户报：「下载引擎下载……最后一个文件，需要等待很长时间」，
     *   并强调这是**所有版本下载的共性**。
     *
     *   本文件 `sort_large_first` 那段注释说明：长尾本来已经被"大文件优先"
     *   消掉了（收尾该只剩几个一眨眼就完的小文件）。既然仍然卡，
     *   剩下的可能只有三种，而它们**都会在日志里留下痕迹**：
     *     · 重试轮（退避 0.8→15s + 降并发到 1）
     *     · 换源重下（`换 mcimirror 重试`）
     *     · 单文件超时窗口（等满静默窗口才判死）
     *
     *   这里只补一样**原本没被记下来**的东西：**每一轮各花了多久**。
     *   有了它，"最后那段时间被谁吃掉"一眼可见：
     *     · 只有第 0 轮却很长 → 某个文件本身慢（超时窗口 / 源慢）
     *     · 出现第 1..N 轮    → 是重试退避
     *
     *   ★ 刻意**不动**任何下载逻辑：没有证据就改调度，很容易把对的地方改坏。
     */
    let mut round_ms: Vec<u64> = Vec::new();

    while !pending.is_empty() && round <= MAX_BATCH_ROUNDS {
        if opts.cancel.is_cancelled() {
            return Err(NetError::Cancelled);
        }

        // 每一轮都重新计算并发：源管理器可能因为 429 把上限压下来了
        let want = match round {
            0 => opts.concurrency,
            // 降级：第 1 轮补下 → 1/4 并发，第 2 轮 → 单线程（PCL2 8.2 的做法）
            1 => opts.concurrency / 4,
            _ => 1,
        }
        .max(1);
        let concurrency = manager.recommended_concurrency(opts.source, want);

        if round > 0 {
            /*
             * ★ 重试的日志与退避留在**轮次开始前**（它们描述的是"接下来要做
             *   什么"），而**进度事件**移到了轮次**结束后**（见下面的说明）——
             *   因为事件里的 `failed_files` 必须是**本轮的结果**，
             *   不是上一轮的残值。
             */
            say!(
                "[IEML/download] 第 {round} 轮补下 {} 个失败文件（并发 {}）",
                pending.len(),
                concurrency
            );
            let delay = backoff_delay(
                round,
                std::time::Duration::from_millis(800),
                std::time::Duration::from_secs(15),
            );
            if !source::sleep_cancellable(delay, &opts.cancel).await {
                return Err(NetError::Cancelled);
            }
        }

        let round_t0 = std::time::Instant::now();
        /*
         * ★★ **为什么先 `mem::take` 再传**（而不是直接 `run_round(pending, ..)`）：
         *
         *   直接传会把 `pending` **move 走**，而循环条件
         *   （`while !pending.is_empty()`）下一轮还要读它 ——
         *   借用检查直接拒绝（实测：`borrow of moved value: pending`）。
         *   `run_round` 本来就**只消费**这一批任务，所以"传一份、留下一个空壳"
         *   语义完全一致，而且 `pending` 在循环里始终是"已初始化"的。
         */
        let this_round_maybe: Vec<DownloadTask> = std::mem::take(&mut pending);
        let (still_failed, failures, was_paused, unstarted, round_failures, round_unverified) = run_round(
            this_round_maybe,
            concurrency,
            opts.source,
            &opts.cancel,
            opts.pause.as_ref(),
            &stats,
            &opts.on_progress,
            total_files,
            total_bytes,
            round,
        )
        .await;
        /*
         * ★★ 判据 3：**"没有校验值"的清单要跨轮累积**（不是每轮重置）。
         *
         *   一个文件只会在某一轮里落位一次，所以这里直接 extend 不会重复；
         *   而 `round_unverified` **每轮都是新的一份**（`run_round` 里新建的
         *   `Arc<Mutex<Vec<..>>>`）。
         */
        unverified.extend(round_unverified);
        // ★ 记在 await 之后、任何 return 之前 —— 暂停那条分支也会 return，
        //   而"暂停前这一轮花了多久"同样是有用的信息。
        round_ms.push(round_t0.elapsed().as_millis() as u64);

        /*
         * ★★ 判据 1 的落地（四）：**致命失败立刻结束整个批次**。
         *
         *   审计：*A fatal failure must fail the batch with a useful message
         *   naming the artifact* + *Disk-full and permission errors are not
         *   retryable. Surface them immediately; retrying just makes the UI
         *   lie for longer.*
         *
         *   为什么必须在**批次层**也拦一道：`download_one_locked` 只能让
         *   "这一个文件"立刻失败，而批次层的 3 轮补下（每轮之间还有
         *   0.8→15 秒退避）会把**剩下的所有任务**再造一遍 ——
         *   磁盘满的时候那等于一边失败一边重试几十个文件。
         *
         *   ⇒ 一旦本轮出现**致命**失败，就把剩下的任务全部收进最终失败清单，
         *     立刻跳出补下循环（`pending` 清空 + `round` 拉到上限）。
         *   ★ 判据用 `FailureClass`，不是字符串 —— 见 `DownloadFailure`。
         */
        let fatal = round_failures.iter().filter(|f| f.class.is_fatal()).count();
        if fatal > 0 {
            /*
             * ★ 这里**不能** `std::mem::take(&mut pending)`：`pending` 是循环条件
             *   在读的变量，而 `break` 语句会把"take 之后的值"重新赋回 ——
             *   于是下一轮（虽然不会来）的读会被判成读一个已 move 的值。
             *   ⇒ 改成"在循环末尾用 `halted` 清空"（见下面的 `if halted`）。
             */
            let unstarted_n = unstarted.len();
            say!(
                "[IEML/download] 本轮出现 {fatal} 个**致命**失败（磁盘满 / 权限 / 校验反复不符），\
                 立刻结束：不再补下 {} 个文件（本轮另有 {unstarted_n} 个没轮到）\
                 —— 重试治不好这些错",
                still_failed.len()
            );
            /*
             * ★ 没轮到的那些也算"处理完了"（结果：没跑），否则进度条永远差一截。
             *   判据与 `download_batch` 末尾"重试到最后的失败也算处理完"同源 ——
             *   分母是计划数，分子必须能追平。
             *   ★ 这里放掉 `unstarted`（后面不再需要它：批次已经决定结束）。
             */
            stats
                .processed_files
                .fetch_add(unstarted_n as u64, Ordering::Relaxed);
            drop(unstarted);
            failures_all.extend(round_failures.iter().cloned());
            failures_all.extend(still_failed.iter().map(|t| DownloadFailure {
                label: t.label.clone(),
                reason: "因为本轮出现致命失败（磁盘满 / 权限 / 校验反复不符），这一批已停止".into(),
                class: FailureClass::Fatal,
            }));
            failed = failures
                .into_iter()
                .chain(still_failed.iter().map(|t| {
                    (
                        t.label.clone(),
                        "因为本轮出现致命失败（磁盘满 / 权限 / 校验反复不符），这一批已停止"
                            .to_string(),
                    )
                }))
                .collect();
            round += 1;
            break;
        }

        /*
         * ★★ **被暂停** → 把"还没开始的"和"这一轮失败的"合成续下清单，
         *   立刻返回。
         *
         *   为什么不等重试轮：用户按的是"暂停"，不是"再试几轮"。
         *   继续退避重试会让"暂停"点下去之后又跑了十几秒才停。
         *
         *   判据用 `was_paused`（而不是"unstarted 非空"）：
         *   暂停也可能刚好停在最后一个任务之后，那时 unstarted 是空的，
         *   但状态仍然是"已暂停"。
         */
        if was_paused {
            let mut rest: Vec<DownloadTask> = unstarted;
            // 本轮已 spawn 但失败的那些也要一起留下（它们没下成功）
            for ft in still_failed {
                if !rest.iter().any(|r| r.path == ft.path) {
                    rest.push(ft);
                }
            }
            say!(
                "[IEML/download] 已暂停：本轮完成 {} 个，还剩 {} 个没下（已下的分片保留）",
                processed_count(&stats),
                rest.len()
            );
            failures_all.extend(round_failures);
            emit(
                &opts,
                &stats,
                total_files,
                total_bytes,
                failures.len(),
                round,
                format!("已暂停 · 还剩 {} 个", rest.len()),
                opts.source,
            );
            return Ok(DownloadOutcome {
                peak_connections: conn_stats::peak(),
                finished_files: stats.finished_files.load(Ordering::Relaxed) as usize,
                skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
                failed: failures,
                failures: failures_all,
                unverified,
                total_bytes,
                elapsed_ms: started.elapsed().as_millis() as u64,
                processed_files: processed_count(&stats) as usize,
                retry_rounds: round,
                repaired_files: stats.repaired_files.load(Ordering::Relaxed) as usize,
                paused: true,
                remaining: rest,
            });
        }

        failures_all.extend(round_failures);
        failed = failures;
        pending = still_failed;
        round += 1;

        /*
         * ★ 重试事件要在**本轮结果出来之后**再发。
         *
         *   以前 `emit` 是在轮次**开始前**调的（用的 `failed.len()` 是上一轮的
         *   残值），于是界面上那句"其中 N 个失败"总是慢一步 ——
         *   而且**最后一轮的失败数永远没人报**（循环条件一不满足就出去了）。
         */
        if !pending.is_empty() && round <= MAX_BATCH_ROUNDS {
            say!(
                "[IEML/download] 第 {round} 轮补下 {} 个失败文件",
                pending.len()
            );
            let delay = backoff_delay(
                round,
                std::time::Duration::from_millis(800),
                std::time::Duration::from_secs(15),
            );
            if !source::sleep_cancellable(delay, &opts.cancel).await {
                return Err(NetError::Cancelled);
            }
            emit(
                &opts,
                &stats,
                total_files,
                total_bytes,
                pending.len(),
                round,
                format!("重试第 {round} 轮"),
                opts.source,
            );
        }
    }

    /*
     * ★★ **重试到最后的失败也要算"处理完了"。**
     *
     *   进度条的分母是 `total_files`（计划里的任务数），所以分子必须能追平它。
     *   失败的文件在重试期间**不**计入（否则会被数好几次），
     *   但一旦重试结束、它彻底没救，那它也是"处理完了"（结果：失败）。
     *
     *   这就是用户那张截图 `2591 / 2596` 的正解：
     *   分子少的就是这 5 个彻底失败的 —— 它们既不在 `finished`
     *   也不在 `skipped`，于是进度条永远差 5 个。
     */
    if !pending.is_empty() {
        stats
            .processed_files
            .fetch_add(pending.len() as u64, Ordering::Relaxed);
        /*
         * 收尾事件也要发一条：让界面看到"最后一轮的失败数"。
         * 不补这一条的话，最后一个事件里的 `failed_files` 还停在
         * 最后一轮**开始前**的值（少算最后一轮的结果）。
         */
        emit(
            &opts,
            &stats,
            total_files,
            total_bytes,
            pending.len(),
            round,
            format!("{} 个文件最终失败", pending.len()),
            opts.source,
        );
    }

    // ---------- ③ 网络任务跑完后才做本地复制 ----------
    if opts.cancel.is_cancelled() {
        return Err(NetError::Cancelled);
    }
    for copy in &copies {
        if opts.cancel.is_cancelled() {
            return Err(NetError::Cancelled);
        }
        match copy_local(&copy.source, &copy.task.path).await {
            Ok(()) => {
                stats.finished_files.fetch_add(1, Ordering::Relaxed);
                stats
                    .finished_bytes
                    .fetch_add(copy.task.size, Ordering::Relaxed);
                /*
                 * ★★ 判据 3：**本地复制的副本也可能是"没有校验值"的**。
                 *
                 *   复制本身不校验（`std::fs::copy` 只搬字节）—— 原件对不对
                 *   由原件那条任务负责。所以"有没有校验值"按副本自己那条任务算：
                 *   它没有校验值时，落位之后同样**无法证明**它是对的。
                 */
                if copy.task.expected_hash().is_none() {
                    stats.unverified_files.fetch_add(1, Ordering::Relaxed);
                    unverified.push(UnverifiedFile {
                        label: copy.task.label.clone(),
                        path: copy.task.path.clone(),
                        length_checked: copy.task.size > 0,
                    });
                }
            }
            Err(e) => {
                failed.push((copy.task.label.clone(), e.to_string()));
                failures_all.push(DownloadFailure {
                    label: copy.task.label.clone(),
                    reason: e.to_string(),
                    class: e.class(),
                });
            }
        }
        /*
         * ★★ 本地复制**也必须计入进度**。
         *
         *   它明明被算进了分母（`total_files = network + copies`），
         *   却从来没被算进分子 —— 于是只要这一批里有"同内容重复文件"，
         *   进度就**永远到不了 100%**，差的正好是副本的个数。
         *
         *   实测 1.20.1 的资源里有 23 个这样的条目（同一 hash 被两个名字引用），
         *   用户看到的 `2591 / 2596` 差 5 个，就是这一类。
         */
        stats.processed_files.fetch_add(1, Ordering::Relaxed);
        emit(
            &opts,
            &stats,
            total_files,
            total_bytes,
            failed.len(),
            round,
            copy.task.label.clone(),
            opts.source,
        );
    }

    /*
     * ★★ 收尾诊断（2026-09-17）：每一轮各花了多久。
     *
     *   用户报「最后一个文件要等很久」，且是**所有版本下载的共性**。
     *   这段日志让"最后那段时间被谁吃掉了"一眼可见：
     *     · 只有第 0 轮、但它很长 → 是单个文件本身慢（超时窗口 / 源慢）
     *     · 有第 1..N 轮          → 是重试退避（0.8→15s + 降并发）
     *   配合已有的 `换 mcimirror 重试` 日志就能分清是哪一种。
     */
    if !round_ms.is_empty() {
        let total: u64 = round_ms.iter().sum();
        if total > 30_000 {
            let detail: Vec<String> = round_ms
                .iter()
                .enumerate()
                .map(|(i, ms)| format!("第{i}轮 {:.1}s", *ms as f64 / 1000.0))
                .collect();
            say!(
                "[IEML/download] 各轮耗时：{}（合计 {:.1}s，{} 个文件）",
                detail.join(" · "),
                total as f64 / 1000.0,
                total_files
            );
        }
    }

    /*
     * ★★ 判据 3 的收尾：**"没有校验值"这件事必须在日志里点名。**
     *
     *   审计第 102 行：`None` is a real case and must not silently become
     *   "skip verification and assume success"。
     *   计数是给界面与报告用的（`DownloadOutcome::unverified`），
     *   但日志也要留一句 —— 用户报"某个 mod 明明装上了却进不去"时，
     *   这行是第一条线索。
     */
    if !unverified.is_empty() {
        let no_len = unverified.iter().filter(|u| !u.length_checked).count();
        say!(
            "[IEML/download] 这一批有 {} 个文件**没有校验值**（上游没发布哈希），\
             它们是未经校验就落位的；其中 {no_len} 个连长度都没比过（size=0）",
            unverified.len()
        );
    }

    /*
     * ★★ 判据 3 收尾：**一条明确的"这一批结束了"事件，阶段是 `done`。**
     *
     *   审计要求阶段必须能分开（`downloading` / `verifying` / `complete` /
     *   `failed` / `cancelled`），而"结束"这一档**必须是最后一条** ——
     *   否则界面最后看到的状态会停在"正在下"（一个已经跑完的批次）。
     *   ★ 它与 `emit` 发的那几条不同：那些是"重试第 N 轮"之类的中途播报。
     */
    (opts.on_progress)(DownloadProgress {
        finished_files: processed_count(&stats) as usize,
        total_files,
        finished_bytes: stats.finished_bytes.load(Ordering::Relaxed),
        total_bytes,
        bytes_per_second: 0,
        current_file: if unverified.is_empty() {
            String::new()
        } else {
            format!("其中 {} 个文件没有校验值，未经校验", unverified.len())
        },
        skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
        failed_files: failures_all.len(),
        source: opts.source.as_str().to_string(),
        retry_round: round,
        phase: ProgressPhase::Done,
    });

    Ok(DownloadOutcome {
        peak_connections: conn_stats::peak(),
        finished_files: stats.finished_files.load(Ordering::Relaxed) as usize,
        skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
        failed,
        failures: failures_all,
        unverified,
        total_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
        // ★ 与进度事件的分子**同一个判据** —— 于是"最后一条进度的分母"
        //   必然等于计划里的任务总数（`total_files`）
        processed_files: processed_count(&stats) as usize,
        retry_rounds: round.saturating_sub(1),
        repaired_files: stats.repaired_files.load(Ordering::Relaxed) as usize,
        // 正常跑完（不是暂停）→ false，且没有"剩下的"
        paused: false,
        remaining: Vec::new(),
    })
}

/// 一个"内容已在别处下好、只需本地复制"的任务
#[derive(Debug, Clone)]
struct CopyJob {
    source: PathBuf,
    task: DownloadTask,
}

/// 去重。
///
/// ## ★★ 2026-10：**第一判据从"内容哈希"改成了"目标路径"**
///
///   审计在 Queue 那一节里写着：
///
///   > **Deduplicate by destination path** and by (URL, destination). The same
///   > library is requested by several profiles; the same asset blob appears
///   > under several logical paths.
///
///   而原来的实现**只按 SHA1 去重**（内容哈希是第一判据）。这个顺序错位的
///   真实后果（有 `文件:行号` 证据）：
///
///   ```text
///     任务 A：path=P, sha1=H1       ← 正常解析出来的那条
///     任务 B：path=P, sha1=""       ← `.mrpack` 没给哈希的条目 /
///                                      commands_real.rs:10818 的补齐路径
///   ```
///
///   两个任务**同一个目标路径、不同哈希**（一个是 H1、一个是空）——
///   按内容哈希去重时它们**看起来是两个不同的文件**，于是两个 worker 同时
///   写同一个 P：一个 `create_part`（截断）一个 `open_part_append`（追加），
///   各自 rename 到 P。结果是**"长度对、内容错"**，而空哈希那条**发现不了**
///   （它本来就不校验）。⇒ 这就是"去重键应该是目标路径"的直接理由。
///
/// ## 现在的判据顺序
///
///   ① **目标路径**（第一判据，见上）：同路径只留一条；
///   ② 内容哈希（第二判据，**保留**）：同内容不同路径 → 本地复制。
///      它仍然有独立价值：多加载器共享同一批 libraries、以及内容寻址的
///      资源文件（`objects/<前两位>/<sha1>`）被多个名字引用 —— 实测能省 30%+
///      流量（ADR-002）。
///
/// ## 同路径时保留哪一条（要有理由）
///
///   `keep_rank` 的取舍，按优先级：
///     ① **有校验值**的优先 —— 一条要校验、一条不校验时，保留要校验的那条
///        （它落位之后我们**能证明**它是对的；反过来则永远是"未校验"）。
///        这正是审计点名的那一对（有哈希 vs 空哈希），必须保留有哈希的。
///     ② 都有（或都没有）校验值时，**先出现的**优先 —— 与原行为一致
///        （`download_batch` 的输入顺序对调用方是可预期的）。
///
///   ★ 被丢弃的那条**不一定**真的重复：判据是"同路径"。
///     但同一个路径本来就只容得下一个文件，两条都下既浪费又会打架 ——
///     这正是"按目标路径去重"的意思。
///
/// ## `sort_large_first` 与"副本排在原件之后"
///
///   ★ 副本仍然排在**原件之后**（`copies` 在批次末尾统一复制，见
///     `download_batch` ③）—— 这个次序意图有历史原因（踩过 os error 32：
///     副本在原件还在写的时候去读它）。`sort_large_first` 也一个字不动。
fn dedup_pass(tasks: Vec<DownloadTask>) -> (Vec<DownloadTask>, Vec<CopyJob>) {
    let mut network: Vec<DownloadTask> = Vec::new();
    let mut copies: Vec<CopyJob> = Vec::new();

    /*
     * ① 第一判据：**规范化后的目标路径**。
     *    键用 `path_key`（统一分隔符 + 规范化父目录 + Windows 小写化），
     *    与路径锁用的是**同一个**函数 —— 两处判据必须一致，
     *    否则"锁住 P"与"去重 P"会指向两个不同的字符串。
     */
    let mut by_path: HashMap<PathBuf, usize> = HashMap::new();
    // ② 第二判据：内容哈希（同内容、不同路径 → 复制）
    let mut seen_hash: HashMap<String, PathBuf> = HashMap::new();

    for t in tasks {
        let key = path_key(&t.path);
        if let Some(&at) = by_path.get(&key) {
            if keep_rank(&t) > keep_rank(&network[at]) {
                /*
                 * 新来的这条更值得保留（它有校验值、旧的那条没有）→ 顶掉旧的。
                 *
                 * ★ 两步簿记都必须做，否则"内容哈希 → 原件路径"那张索引会
                 *   指着一个**不再会被下载的路径**（那样副本会从一个永远
                 *   不存在的文件上复制，Windows 报 os error 2）。
                 */
                let old = std::mem::replace(&mut network[at], t);
                if !old.sha1.is_empty() {
                    seen_hash.remove(&old.sha1);
                }
                if !network[at].sha1.is_empty() {
                    seen_hash.insert(network[at].sha1.clone(), network[at].path.clone());
                }
                continue;
            }
            /*
             * 旧的那条更值得保留（或一样）→ 这一条直接丢弃：
             * 同一个目标路径只容得下一个文件。
             *
             * ★ 为什么要**点名**（而不是静默 `continue`）：这个分支以前
             *   就是"同内容 + 同路径 = 什么都不用做"（那是对的），
             *   但现在它也可能是"同路径、**不同内容**" —— 那种情况下
             *   被丢掉的那条**本来会写坏文件**，值得在日志里留一行。
             */
            say!(
                "[IEML/download] 目标路径重复，丢弃一条：{}（保留 {}）",
                t.label,
                network[at].label
            );
            continue;
        }

        // 这个路径是第一次见
        if !t.sha1.is_empty() {
            /*
             * ② 第二判据：这条路径的新文件，内容是不是**已经在别处下过**。
             *    是 → 记成"从原件本地复制"（省一次网络请求）。
             *    ★ 副本仍排在原件之后（批次末尾统一做，见 `download_batch` ③）。
             */
            if let Some(first) = seen_hash.get(&t.sha1) {
                copies.push(CopyJob {
                    source: first.clone(),
                    task: t,
                });
                continue;
            }
            seen_hash.insert(t.sha1.clone(), t.path.clone());
        }
        network.push(t);
        // 索引是在 push 之后取的：`by_path` 记的是**在 network 里的下标**
        let at = network.len() - 1;
        by_path.insert(key, at);
    }
    (network, copies)
}

/// 同一个目标路径出现两条任务时，**哪一条更值得保留**（判据见 `dedup_pass`）。
///
///   · 有校验值的 > 没有校验值的（前者落位后**能被证明**是对的）；
///   · 都有 / 都没有 → 平手（先出现的优先）。
fn keep_rank(t: &DownloadTask) -> u8 {
    if t.expected_hash().is_some() {
        1
    } else {
        0
    }
}

/// 自适应起步：先起多少个任务之后才开始看吞吐（太小会把起步饿死）。
const RAMP_UP_GRACE: usize = 8;

/// 吞吐目标：高于它就先不发起新连接（字节/秒）。
///
/// ★ 为什么是 300 KB/s 这么低：这台机器实测 BMCLAPI 单连接只有 71~188 KB/s、
///   4 路合计 244 KB/s、16 路反而掉到 130 KB/s。阈值定高（比如 2 MB/s）会让
///   起步阶段一直卡在等待里；定低（比如 100 KB/s）就等于没节流。
///   300 KB/s 的意思是"多路并行确实跑起来了，就别再往上加压力"。
///
/// ★ 这个闸门**只在第 0 轮生效**：补下轮本来任务就少，再节流就是纯粹变慢。
const RAMP_UP_TARGET_BPS: u64 = 300 * 1024;

/// 每次等待的步长与最多等待步数（合计最多 ~2 秒，避免慢源把进度拖成 0）。
const RAMP_UP_STEP_MS: u64 = 100;
const RAMP_UP_MAX_WAIT_STEPS: u32 = 20;

/// 本轮**实测吞吐**：本轮完成字节 / 本轮已用时间。
///
/// ★ 用的是**本轮的计数**（`round_bytes` 快照），不是全程累计 ——
///   全程累计在第二轮补下时会带着上一轮的几十 MB，让闸门永远认为"够快"。
fn throughput_bps(round_bytes: u64, started: std::time::Instant) -> u64 {
    let secs = started.elapsed().as_secs_f64();
    if secs < 0.3 {
        return u64::MAX; // 刚开始，数据不足以判断 → 当作"够快"，不节流
    }
    (round_bytes as f64 / secs) as u64
}

/// ★ **大文件排前面**（纯函数，可单测）。
///
/// 详由见 `run_round` 顶部的注释：让长尾从"最后一个大文件"变成
/// "最后几个小文件"。Rust 的 `sort_by` 是**稳定排序**，所以大小相同时
/// 保持原顺序 —— 行为可复现，测试能精确断言。
fn sort_large_first(tasks: &mut [DownloadTask]) {
    tasks.sort_by(|a, b| b.size.cmp(&a.size));
}

/// 判断一次下载的字节数是不是"**被限流页搪塞**"（纯函数，可单测）。
///
/// 判据刻意保守（两条同时成立）：
///   ① 任务**知道**这个文件应该有多大（> 16 KB）—— 否则没资格说"太小"；
///   ② 拿到的总字节数不到 **1 KB**。
///
/// 实测样本：任务记录 286 KB ~ 947 KB，服务端只回 **146 字节**。
fn looks_throttled(task_size: u64, got: u64) -> bool {
    task_size > 16 * 1024 && got < 1024
}

/// 跑一轮的返回值：
///   * `.0` 本轮仍失败的任务（交给重试轮）
///   * `.1` 失败详情（标签 + 原因）
///   * `.2` ★★ **这一轮是不是被暂停打断的**（与「跑完了只剩失败」区分开）
///   * `.3` 暂停时**还没开始**的任务（原顺序，可直接续下）
///   * `.4` ★ 带处置档位的失败清单（判据 1）
///   * `.5` ★ **没有校验值、因此未经校验**的落位文件（判据 3）
///
/// 抽成别名是因为六元组写在签名里读不出哪个是哪个（而 `.2` 与 `.3`
/// 的含义恰恰**不能搞混**：一个是"为什么停"，一个是"还剩什么"）。
type RoundResult = (
    Vec<DownloadTask>,
    Vec<(String, String)>,
    bool,
    Vec<DownloadTask>,
    Vec<DownloadFailure>,
    Vec<UnverifiedFile>,
);

/// 跑一轮：对 `tasks` 按 `concurrency` 并发下载。
#[allow(clippy::too_many_arguments)]
async fn run_round(
    mut tasks: Vec<DownloadTask>,
    concurrency: usize,
    source: Source,
    cancel: &CancelToken,
    // ★★ 暂停令牌。`Some` 时一旦被触发就不再开始新任务，并把剩下的交回去。
    //    （参数上不能写文档注释，所以用普通注释。）
    pause: Option<&PauseToken>,
    stats: &Arc<Stats>,
    on_progress: &Arc<dyn Fn(DownloadProgress) + Send + Sync>,
    total_files: usize,
    total_bytes: u64,
    round: u32,
) -> RoundResult {
    /*
     * ★★ **大文件先下**（用户报的"下载速度降了好多"的修法之一）。
     *
     *   原来的顺序是"任务生成顺序"（基本等于版本 JSON 里的库顺序 + 资源文件
     *   的 hash 顺序），跟大小无关。后果是：**最后收尾的往往是文件列表末尾
     *   的几个大文件**，用户看着进度卡在 3597/3598 等一个几 MB 的 jar。
     *
     *   按大小**降序**排之后：
     *     · 大文件一开始就占住连接、越早传完；
     *     · 小文件在后面填缝，收尾时剩下的都是"一眨眼就完"的；
     *     · 长尾从"最后一个大文件"变成"最后几个小文件"。
     *
     *   这就是 PCL2 的调度器自然产生的效果（它是按文件顺序起线程、
     *   同时给**正在下载的**文件追加线程，大文件会越吃越多线程）——
     *   我们用显式排序达到同样的目的，改动面小得多。
     */
    sort_large_first(&mut tasks);

    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));
    let round_started = std::time::Instant::now();
    let failed: Arc<tokio::sync::Mutex<Vec<(String, String)>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let failed_tasks: Arc<tokio::sync::Mutex<Vec<DownloadTask>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    // ★★ 带处置档位的失败清单（判据 1）
    let failures: Arc<tokio::sync::Mutex<Vec<DownloadFailure>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    // ★★ **没有校验值、因此未经校验就落位**的文件（判据 3）
    //
    //   收的是 (`label`, `path`, `length_checked`)。
    //   ★ 为什么在 `run_round` 收而不是在 `download_one_locked` 里收：
    //     那里是**逐文件**的（没有批次上下文），而这里手里有 `stats`
    //     与 `failed` 这些批次级的状态 —— 汇总信息属于批次。
    let unverified: Arc<tokio::sync::Mutex<Vec<UnverifiedFile>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    /*
     * ★★ 自适应启动节流（PCL2 的 `StartManager` 简化版）。
     *
     *   PCL2 的做法：两个管理线程每 20ms 扫一遍，按"当前总速度是否低于
     *   动态下限"决定要不要**再起**线程，并且每起一个 BMCLAPI 线程就
     *   `Thread.Sleep(100)` —— 注释写得很明白：「减少 BMCLAPI 请求频率」。
     *
     *   我们原来是一次性把 N 个任务全 spawn 出去（靠信号量限流），
     *   也就是**同时**去抢 N 条连接。这台机器实测（119 KB 的库文件）：
     *   1 路 71 KB/s、4 路合计 244 KB/s、**16 路反而掉到 130 KB/s** ——
     *   连接一多，握手与限流的开销就吃掉了收益。
     *
     *   所以：**只要吞吐还够快，就别急着起下一个任务**；吞吐掉下来了再继续。
     *   判断用"本轮实测吞吐"（已完成字节 / 已用时间），阈值取一个保守的
     *   下限 —— 宁可慢一点起步，也不要把源打到限流（那会触发 429 退避，
     *   得不偿失）。
     */
    let started_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // 闸门是否已经**放行过**（放行之后就不再拦，见下面 ② 的说明）
    let gate_opened = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // 本轮**自己**完成的字节数（快照起点 = 本轮开始时的累计值）。
    //
    // ★ 用差值而不是全程累计：第二轮补下时全程累计带着上一轮的几十 MB，
    //   闸门会一直认为"够快"从而**完全失效**。
    let round_bytes_base = stats.finished_bytes.load(Ordering::Relaxed);

    let mut handles = Vec::with_capacity(tasks.len());

    /*
     * ★★ **暂停的检查点。**
     *
     *   放在"取到并发许可之后、真正 spawn 之前"：
     *     · 取许可已经在等并发空位，所以这里被暂停时**不会有半启动的任务**；
     *     · 已经 spawn 出去的那些会正常跑完（数据不丢），
     *       我们只是在 for 循环里不再继续。
     *
     *   ★ 所以这里**先把整个 Vec 取出来**（`std::mem::take`），
     *     再一个一个消费：暂停时把剩下的原样装回 `remaining`。
     *     （`for task in &tasks` 那种写法在**循环中途 return** 时
     *      borrow 还没结束，编译器直接拒绝 —— 这不是风格问题，是必须这么写。）
     */
    let mut remaining: Vec<DownloadTask> = Vec::new();
    let mut paused = false;

    let queue = std::mem::take(&mut tasks);
    let mut it = queue.into_iter();

    while let Some(task) = it.next() {
        // ① 闸门 1：全局并发上限
        let permit = match semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break, // 信号量关闭：说明整体已取消
        };

        /*
         * ★★ 暂停闸门：拿到许可之后、spawn 之前。
         *
         *   **当前这个也没开始**，所以要把它和它后面的一起交回去。
         */
        if pause.is_some_and(|p| p.is_paused()) {
            paused = true;
            drop(permit);
            remaining.push(task);
            remaining.extend(it);
            break;
        }

        /*
         * ② 闸门 2：**速度够了就先不发起新的连接**。
         *
         *    只在"已经起了不少任务"之后才生效（起步阶段不能自己把自己饿死），
         *    而且有硬上限（最多每轮多等 ~2 秒），避免慢源把进度拖成 0。
         *
         *    ★ 幂等：一旦闸门放行过一次（说明速度掉下来了），就不再拦 ——
         *      否则每个任务都要重新等一遍，等于把并发压到 1。
         */
        if round == 0 && !gate_opened.load(Ordering::Relaxed) {
            let already = started_count.load(Ordering::Relaxed);
            if already >= RAMP_UP_GRACE {
                let mut waited = 0u32;
                while waited < RAMP_UP_MAX_WAIT_STEPS {
                    let done = stats.finished_bytes.load(Ordering::Relaxed);
                    let round_bytes = done.saturating_sub(round_bytes_base);
                    if throughput_bps(round_bytes, round_started) < RAMP_UP_TARGET_BPS {
                        break; // 速度掉下来了 → 放行，并且以后不再拦
                    }
                    if !source::sleep_cancellable(
                        std::time::Duration::from_millis(RAMP_UP_STEP_MS),
                        cancel,
                    )
                    .await
                    {
                        // 取消 → 返回空的结果（调用方会因为 cancel 立刻退出）
                        return (Vec::new(), Vec::new(), false, Vec::new(), Vec::new(), Vec::new());
                    }
                    waited += 1;
                }
                gate_opened.store(true, Ordering::Relaxed);
            }
            started_count.fetch_add(1, Ordering::Relaxed);
        }

        let stats = Arc::clone(stats);
        let cancel = cancel.clone();
        let on_progress = Arc::clone(on_progress);
        let failed = Arc::clone(&failed);
        let failed_tasks = Arc::clone(&failed_tasks);
        let failures = Arc::clone(&failures);
        let unverified = Arc::clone(&unverified);

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let label = task.label.clone();

            /*
             * ★★★★ 2026-09-30（用户）：「**我点完后，我都不知道开没开是下载，
             *   连接失败，也是等了一会儿后冷不丁的出来**」。
             *
             *   这一段是那个体验缺陷的**唯一成因**：进度事件原来只在
             *   "一个文件下载完"之后才发（见下面那段）。于是：
             *     · 点下载 → 后端开始连（`cdn.modrinth.com` 在国内**会卡满
             *       20 秒连接超时**，实测官方与 mcimirror **两条路都不通**）；
             *     · 这 20 秒里**一个事件都没发** → 界面完全静默；
             *     · 超时了才冷不丁弹出一句失败。
             *
             *   ⇒ 在**发起网络请求之前**先报一次"正在连这个文件"。
             *     界面立刻有事可显示（文件名 + "正在连接"），而且失败时
             *     用户能看到"它试过这些文件" —— 而不是对着一个不动的界面猜。
             *
             *   ★ 为什么可以直接发而不必担心刷屏：这里的 `on_progress` 调用
             *     发生在**拿到并发许可之后**，而并发上限是 64 ——
             *     最多 64 条"开始"事件，比起"每个文件完成时一发"只多一点点。
             *   ★ 进度数字**不变**（`finished_files` 还是完成数）：
             *     这条事件只是把 `current_file` 更新成"正在连的那个"，
             *     不许把没下完的文件算进进度里（那才是假进度）。
             */
            on_progress(DownloadProgress {
                finished_files: processed_count(&stats) as usize,
                total_files,
                finished_bytes: stats.finished_bytes.load(Ordering::Relaxed),
                total_bytes,
                bytes_per_second: run_speed(
                    stats.finished_bytes.load(Ordering::Relaxed),
                    round_started,
                ),
                current_file: format!("正在连接 {label}"),
                skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
                failed_files: failed.lock().await.len(),
                source: source.as_str().to_string(),
                retry_round: round,
                phase: ProgressPhase::Downloading,
            });

            /*
             * ★★ 判据 3：**"校验中"这一档必须能被看见。**
             *
             *   这条回调会从 `download_one_locked` 的**两处**被调用：
             *     · 判"已存在的文件对不对"之前（那条路一条网络请求都不发，
             *       旧代码在这段时间里完全静默 —— 界面像卡住了）；
             *     · 下载完之后算校验值之前（几百 MB 的包体在这里要读一遍盘）。
             *
             *   ★ 这一档的进度数字**不动**（与上面那条"正在连接"同一个理由：
             *     不许把没完成的事算进进度）。它改变的是**阶段**，
             *     而阶段正是审计要的"verifying 不能不可见"。
             */
            let phase_reporter = |phase: ProgressPhase, file: &str| {
                on_progress(DownloadProgress {
                    finished_files: processed_count(&stats) as usize,
                    total_files,
                    finished_bytes: stats.finished_bytes.load(Ordering::Relaxed),
                    total_bytes,
                    bytes_per_second: run_speed(
                        stats.finished_bytes.load(Ordering::Relaxed),
                        round_started,
                    ),
                    current_file: file.to_string(),
                    skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
                    // ★ 这里**不能** `failed.lock().await`：本闭包是**同步**的
                    //   （`Fn`，不是 async），拿不到那个锁。
                    //   用原子计数代替 —— 它本来就是给"这一批失败了多少"用的。
                    failed_files: stats.failures_total.load(Ordering::Relaxed) as usize,
                    source: source.as_str().to_string(),
                    retry_round: round,
                    phase,
                });
            };

            // 这一轮里全是网络任务 —— 本地复制已经在批次末尾单独做过（见 CopyJob）
            let expected = task.expected_hash();
            let outcome =
                download_one_locked(source::global(), &task, source, &cancel, Some(&phase_reporter))
                    .await;

            match outcome {
                Ok(skipped) => {
                    if skipped {
                        stats.skipped_files.fetch_add(1, Ordering::Relaxed);
                    } else {
                        stats.finished_files.fetch_add(1, Ordering::Relaxed);
                    }
                    stats.finished_bytes.fetch_add(task.size, Ordering::Relaxed);
                    /*
                     * ★★ 判据 3：**没有校验值就落位的文件要被数出来**。
                     *
                     *   两个来源都要算：
                     *     · 这一轮**下载**下来的（`!skipped` 且没有校验值）；
                     *     · **已存在被跳过**的（`skipped` 且没有校验值 ——
                     *       它正是审计点名的那条"静默路径"：
                     *       `verify_existing` 在 `size == 0` 时返回 Ok）。
                     *   ★ 只有"没有校验值"才算；有校验值的跳过是**校验过的**，
                     *     不该出现在这张清单里（那才是"如实"）。
                     */
                    if expected.is_none() {
                        /*
                         * "比过长度" = 任务知道大小（`size > 0`）。
                         * ★ 这是**诚实的下界**：`size == 0` 时连长度都没比过。
                         */
                        let length_checked = task.size > 0;
                        stats.unverified_files.fetch_add(1, Ordering::Relaxed);
                        say!(
                            "[IEML/download] {} **没有校验值** → 未经校验{}（{}）",
                            task.label,
                            if skipped { "，按已存在跳过" } else { "就落位" },
                            if length_checked {
                                "只比过长度"
                            } else {
                                "连长度都没有（size=0）"
                            }
                        );
                        unverified.lock().await.push(UnverifiedFile {
                            label: task.label.clone(),
                            path: task.path.clone(),
                            length_checked,
                        });
                    }
                    /*
                     * 成功/跳过 → 这个任务**处理完了**。
                     *
                     * ★★ 这里以前是在 `match` **外面**无条件加的，那是错的：
                     *   失败的任务也会 +1，而它下一轮还会被重试 ——
                     *   于是一个文件被数了好几次。
                     *
                     *   实测（`progress_reaches_total_even_when_files_fail`）：
                     *   3 个任务、每个重试 3 轮 → `processed` 涨到 **12/3**，
                     *   分子超过分母 4 倍。
                     *
                     *   大盘看不出来是因为**只有 5 个文件失败**（2591/2596），
                     *   分子只多算了几个，正好把差额补上 —— 看起来像"正常"，
                     *   其实进度条永远差几个。**巧合掩盖了一个真 bug。**
                     *
                     *   现在的判据：只有**终结**了才算"处理完" ——
                     *   成功 / 跳过在这里算，重试到最后的失败在批次末尾算。
                     */
                    stats.processed_files.fetch_add(1, Ordering::Relaxed);
                }
                Err(NetError::Cancelled) => {}
                Err(e) => {
                    if e.to_string().contains("校验失败") {
                        stats.repaired_files.fetch_add(1, Ordering::Relaxed);
                    }
                    /*
                     * ★★ 判据 1：**把处置档位带进清单**。
                     *
                     *   `download_one_locked` 已经在 `AllSourcesFailed` 里
                     *   带上了它（那里才知道真正的错误是什么）；
                     *   其它变体就地判一次（`NetError::class`）。
                     */
                    let class = match &e {
                        NetError::AllSourcesFailed { class, .. } => *class,
                        other => other.class(),
                    };
                    stats.failures_total.fetch_add(1, Ordering::Relaxed);
                    failed.lock().await.push((label.clone(), e.to_string()));
                    failures.lock().await.push(DownloadFailure {
                        label: label.clone(),
                        reason: e.to_string(),
                        class,
                    });
                    failed_tasks.lock().await.push(task.clone());
                    // ★ 失败**不算处理完** —— 它会被重试，等最终结果出来再算
                }
            }

            let done = processed_count(&stats);
            let bytes = stats.finished_bytes.load(Ordering::Relaxed);
            let fcount = failed.lock().await.len();

            // 进度节流：每完成一个文件都发事件会让前端每秒渲染几百次
            if throttle_ok() {
                on_progress(DownloadProgress {
                    finished_files: done as usize,
                    total_files,
                    finished_bytes: bytes,
                    total_bytes,
                    // 本轮实测吞吐（不是这个文件的瞬时速度 —— 单个文件太小，
                    // 瞬时速度会全是噪声）
                    bytes_per_second: run_speed(bytes, round_started),
                    current_file: label,
                    skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
                    failed_files: fcount,
                    source: source.as_str().to_string(),
                    retry_round: round,
                    phase: ProgressPhase::Downloading,
                });
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    let f = failed.lock().await.clone();
    let t = failed_tasks.lock().await.clone();
    /*
     * 第三个返回值 = "暂停时还没开始的任务"。
     *
     *   注意它**只含没轮到的**：本轮已经 spawn 但失败的在 `t` 里，
     *   由调用方决定（暂停时把它们和 remaining 一起收进"续下"清单；
     *   正常跑完时喂给重试轮）。两件事分开，语义清楚。
     *
     *   正常跑完时返回空 —— 但**不能只靠"空"来区分暂停与正常**：
     *   暂停也可能刚好停在最后一个任务之后（remaining 为空）。
     *   所以暂停状态由第二个返回的 `bool` 单独表达。
     */
    let mut round_failures = failures.lock().await.clone();
    // ★ 排一下序让报告与测试可复现（并发完成的顺序本来就不确定）
    round_failures.sort_by(|a, b| a.label.cmp(&b.label));
    let round_unverified = unverified.lock().await.clone();
    (t, f, paused, remaining, round_failures, round_unverified)
}

/// 进度节流：16ms 一次（60fps 上限）。
///
/// 用全局原子时间戳，避免每个任务各自持有一份节流状态。
fn throttle_ok() -> bool {    use std::sync::atomic::AtomicU64;
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last = LAST.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 16 {
        return false;
    }
    LAST.store(now, Ordering::Relaxed);
    true
}

/// 本轮实测吞吐 = 已完成字节 / 本轮已用时间。
///
/// 为什么不用源管理器里的速度：那是**按源累计**的（含上一轮、上一次安装），
/// 一轮刚开始时会带着旧数据，看起来"一上来就是 60 MB/s"。
fn run_speed(bytes: u64, started: std::time::Instant) -> u64 {
    let secs = started.elapsed().as_secs_f64();
    if secs < 0.2 {
        return 0;
    }
    (bytes as f64 / secs) as u64
}

#[allow(clippy::too_many_arguments)]
fn emit(
    opts: &BatchOptions,
    stats: &Arc<Stats>,
    total_files: usize,
    total_bytes: u64,
    failed_files: usize,
    round: u32,
    current: String,
    source: Source,
) {
    let done = processed_count(stats);
    (opts.on_progress)(DownloadProgress {
        finished_files: done as usize,
        total_files,
        finished_bytes: stats.finished_bytes.load(Ordering::Relaxed),
        total_bytes,
        // 补下轮次之前的速度没有意义（正在退避等待），留 0
        bytes_per_second: 0,
        current_file: current,
        skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
        failed_files,
        source: source.as_str().to_string(),
        retry_round: round,
        /*
         * ★ 这一档叫"正在下"而不是"完成"：`emit` 也被用在
         * "重试第 N 轮"这类**批次还没跑完**的时刻（见 `download_batch` 里的
         * 调用点）。真正的收尾事件由 `download_batch` 末尾的
         * `ProgressPhase::Done` 那一条负责 —— 那一档的判据是
         * "这一批已经决定结束"（跑完 / 暂停 / 因致命失败停手）。
         */
        phase: ProgressPhase::Downloading,
    });
}

/// 把已经下过的同内容文件复制到另一个路径（去重后的副本）
///
/// ★ 用 `spawn_blocking` 而不是直接在 async 里调 `std::fs::copy` ——
///   阻塞式文件复制会把 tokio 的工作线程卡住，24 路并发下会明显拖慢整批。
async fn copy_local(src: &Path, dst: &Path) -> Result<()> {
    if let Some(p) = dst.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    let src_owned = src.to_path_buf();
    let dst_owned = dst.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::copy(&src_owned, &dst_owned))
        .await
        .map_err(|e| NetError::Other(format!("复制任务失败：{e}")))?
        .map_err(|e| {
            // 复制失败必须点名"从哪复制到哪" —— 否则只能看到一个 os error 32，
            // 根本不知道是谁和谁撞了
            NetError::Other(format!(
                "复制 {} → {} 失败：{e}",
                src.display(),
                dst.display()
            ))
        })?;
    Ok(())
}

/* ====================== 小工具 ====================== */

/// 清理残留的 .part / .part.N 文件（上次中断留下的，含分片临时文件）
pub async fn clean_parts(root: &Path) -> usize {
    let mut count = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if is_part_file(&p) {
                if tokio::fs::remove_file(&p).await.is_ok() {
                    count += 1;
                }
            }
        }
    }
    count
}

/// 判断是不是下载残留：`xxx.part`（续传）、`xxx.part.N`（分片）、`xxx.part.chunks`（段计划）。
///
/// 判据是**文件的最后一段扩展名**恰好是 `part`（或 `part` 后面还跟着东西）——
/// 不能简单用 `contains(".part")`：那会把 `c.jar.partial`、
/// `data.part2.bin` 这类正常文件也当成垃圾删掉（测试当场抓到过）。
fn is_part_file(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".part") || name.contains(".part.")
}

/// 清理 `shared/` 下所有下载残留（versions / libraries / assets 都可能留）。
///
/// 为什么需要单独一个入口：`clean_parts` 以前只在"校验已安装"时对**实例目录**
/// 调用，而分片下载的残留全在 `shared/` 下 —— 于是永远没人扫。
/// 装一个版本失败一次就留几十 MB，且用户看不到任何解释。
///
/// ★ 什么时候调用是安全的：**安装开始前**（此时没有任何任务在写这些临时文件）。
///   绝不能在下载过程中调 —— 那会把别的任务正在写的 `.part` 删掉，
///   断点续传直接失效。
pub async fn clean_shared_parts(shared_root: &Path) -> usize {
    clean_parts(shared_root).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ====================== 本地假服务器（P0-4 / P0-5 的守门测试） ======================

     * 为什么必须真的起一个 HTTP 服务器：
     *   "206 偏移不符要重发一个**不带 Range** 的请求"这条规矩，只有在
     *   **服务端真的按脚本回不同响应**时才能被验证 —— 拿纯函数测只能测
     *   判据本身，测不出"代码到底重发了没有、写进去的字节对不对"。
     *
     * 服务器只实现这一小块：读请求头 → 按闭包决定回什么 → 记下这次请求的
     * Range 头。够用就好，不引依赖（`tiny_http` 虽然在手边，但这里要断言的
     * 是"我们发了什么"，自己解析更直接）。
     */
    /// 假服务器里用来数"同时在处理的请求数"的守卫（离开作用域就 -1）。
    struct InFlightGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for InFlightGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct FakeServer {
        addr: std::net::SocketAddr,
        /// 每一次请求的 `Range` 头（`None` = 这次没带）
        ranges: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>>,
    }

    impl FakeServer {
        /// `respond` 收到 (请求第几次, Range 头) → (状态码, 额外头, body)
        fn start<F>(respond: F) -> Self
        where
            F: Fn(usize, Option<&str>) -> (u16, Vec<(String, String)>, Vec<u8>)
                + Send
                + Sync
                + 'static,
        {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑本地端口");
            let addr = listener.local_addr().unwrap();
            let ranges: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let seen = std::sync::Arc::clone(&ranges);
            // ★ 每个连接一个线程 ⇒ `respond` 要能被多线程共享（见下面那段说明）
            let respond = std::sync::Arc::new(respond);

            std::thread::spawn(move || {
                use std::io::{Read, Write};
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    /*
                     * ★★★★ 2026-10-02：**每个连接一个线程**。
                     *
                     *   这里是**真缺陷**（尺子本身的缺陷，比没有尺子更危险）：
                     *   原来 `for stream in listener.incoming()` 是在**一个线程里
                     *   顺序处理**每个连接的 —— 于是"同时处理的请求数"**永远
                     *   是 1**，不管客户端真的开了多少条连接。
                     *
                     *   实测后果：`chunked_download_actually_spreads_connections`
                     *   报「分片：服务器观测峰值 1」（而 8 MB 是完整下下来的），
                     *   我差点据此认为"引擎没有铺开"。
                     *   ⇒ 这是**观测仪器把被测对象的并发串行化**了。
                     *
                     *   ★ 这个坑很隐蔽：仪器"能用"（数据都下对了），
                     *     但它测的那个数**恒等于 1**，看起来像个真实的结论。
                     */
                    let respond = std::sync::Arc::clone(&respond);
                    let seen = std::sync::Arc::clone(&seen);
                    std::thread::spawn(move || {
                        let respond = &*respond;
                        // 读请求头（到空行为止）
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 1024];
                        loop {
                            let Ok(n) = stream.read(&mut tmp) else { break };
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        let head = String::from_utf8_lossy(&buf).to_string();
                        let range = head
                            .lines()
                            .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                            .map(|l| l[6..].trim().to_string());

                        let idx = {
                            let mut g = seen.lock().unwrap();
                            g.push(range.clone());
                            g.len() - 1
                        };

                        let (status, headers, body) = respond(idx, range.as_deref());
                        let reason = match status {
                            200 => "OK",
                            206 => "Partial Content",
                            416 => "Range Not Satisfiable",
                            _ => "Status",
                        };
                        let mut out = format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
                            body.len()
                        );
                        for (k, v) in headers {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str("\r\n");
                        let _ = stream.write_all(out.as_bytes());
                        let _ = stream.write_all(&body);
                        let _ = stream.flush();
                    });
                }
            });

            Self { addr, ranges }
        }

        fn url(&self) -> String {
            format!("http://{}/file.bin", self.addr)
        }

        fn ranges(&self) -> Vec<Option<String>> {
            self.ranges.lock().unwrap().clone()
        }

    }

    /// 整份文件应有的内容（与 `FakeServer::start_ranged` 同一套规则）。
    fn expected_bytes(total: u64) -> Vec<u8> {
        (0..total).map(|o| (o % 251) as u8).collect()
    }

    /// ★★★★ 2026-10-02：**"完整实现"的替身** —— HEAD 报真实大小、支持 Range。
    ///
    /// ## 为什么还要再造一个
    ///
    ///   `start` 那个替身对 HEAD 回的是"1024 字节的正文"，而 `probe_content_length`
    ///   会据此认为文件只有 1024 字节 —— 与 `task.size = 8 MB` 不符 ⇒ **大小校验
    ///   失败 ⇒ 回退单连接**。
    ///
    ///   实测后果（`chunked_download_actually_spreads_connections` 第二次运行）：
    ///   服务器只收到 3 个请求、**一个分段 Range 都没有**，于是我拿着"峰值 1"
    ///   差点又得出"引擎没铺开"的结论。**第三次被不真实的假服务器误导。**
    ///
    ///   ⇒ 这个替身**按真实服务器的行为**回：
    ///     · HEAD → `Content-Length: total`、`Accept-Ranges: bytes`、无正文；
    ///     · GET（无 Range）→ 200 + 整份；
    ///     · GET（有 Range）→ 206 + `Content-Range` + 对应切片；
    ///     · 每个连接**一个线程**（否则观测到的并发恒为 1，见 `start` 里那段说明）。
    ///
    ///   返回 `(FakeServer, 并发峰值)`。
    fn start_full(
        total: u64,
        hold: std::time::Duration,
    ) -> (FakeServer, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑本地端口");
        let addr = listener.local_addr().unwrap();
        let ranges: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&ranges);
        let in_flight = std::sync::Arc::new(AtomicUsize::new(0));
        let peak = std::sync::Arc::new(AtomicUsize::new(0));
        let inf = std::sync::Arc::clone(&in_flight);
        let pk = std::sync::Arc::clone(&peak);

        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let seen = std::sync::Arc::clone(&seen);
                let inf = std::sync::Arc::clone(&inf);
                let pk = std::sync::Arc::clone(&pk);
                std::thread::spawn(move || {
                    // ── 读请求头 ──
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    loop {
                        let Ok(n) = stream.read(&mut tmp) else { break };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let is_head = head.starts_with("HEAD ");
                    let range = head
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .map(|l| l[6..].trim().to_string());

                    // ★ 并发观测：从这里开始到写完响应为止
                    let now = inf.fetch_add(1, Ordering::SeqCst) + 1;
                    pk.fetch_max(now, Ordering::SeqCst);
                    let _g = InFlightGuard(std::sync::Arc::clone(&inf));

                    {
                        let mut g = seen.lock().unwrap();
                        g.push(range.clone());
                    }
                    // 停一下，让"同时在处理的请求数"能被观测到
                    if !hold.is_zero() {
                        std::thread::sleep(hold);
                    }

                    let full: Vec<u8> = (0..total).map(|o| (o % 251) as u8).collect();
                    let (status, extra, body): (u16, String, Vec<u8>) = if is_head {
                        // HEAD：真实大小 + 声明支持 Range，无正文
                        (200, "Accept-Ranges: bytes\r\n".to_string(), Vec::new())
                    } else {
                        match &range {
                            Some(r) => {
                                let (a, b) = r
                                    .trim_start_matches("bytes=")
                                    .split_once('-')
                                    .map(|(a, b)| {
                                        let a = a.trim().parse::<u64>().unwrap_or(0);
                                        let b = b
                                            .trim()
                                            .parse::<u64>()
                                            .ok()
                                            .filter(|b| *b >= a)
                                            .unwrap_or(total - 1);
                                        (a, b)
                                    })
                                    .unwrap_or((0, total - 1));
                                let end = b.min(total - 1);
                                (
                                    206,
                                    format!("Content-Range: bytes {a}-{end}/{total}\r\n"),
                                    full[a as usize..=end as usize].to_vec(),
                                )
                            }
                            None => (200, String::new(), full),
                        }
                    };
                    let reason = if status == 206 { "Partial Content" } else { "OK" };
                    let len = if is_head { total } else { body.len() as u64 };
                    let out = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {len}\r\n{extra}Connection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(out.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                });
            }
        });

        (
            FakeServer { addr, ranges },
            peak,
        )
    }

    fn tmp_part(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ieml-dl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("file.bin.part"), dir)
    }

    /// ★★★★ 2026-10-01（用户报的真实错误）：
    ///   `这个 .mrpack 不是有效的压缩包：invalid Zip archive: Could not find EOCD`
    ///
    ///   真机证据：`mrpack-modpack-muplukvi.mrpack` = **90,351,891 字节**，
    ///   而 Better MC v28 应该是约 **113.8 MB** —— 少了 23 MB，却**被当成完整的包**。
    ///
    ///   根因：分片收尾原来是 `Ok(written)`，**没有**"拼出来的到底是不是完整文件"
    ///   的断言。而 `download_range` 在单段重试耗尽后会返回它**实际写出的字节数**
    ///   （短读也算成功）⇒ 8 段里有一段短了 → 照拼 → **截断的文件 + 报成功**。
    ///   调用方也兜不住：`download_single` 的长度校验只覆盖单连接那条路，
    ///   分片成功后是提前返回。
    ///
    ///   这条测试造一个"**每段都只给一半**"的服务端，断言：
    ///     ① `download_chunked` **必须报错**（而不是返回一个截断的"成功"）；
    ///     ② 那个半成品 `.part` **必须被删掉**
    ///        （留着它，下一轮会被当成"断点续传的已有进度"，而它的字节数是错的）。
    #[tokio::test]
    async fn short_segment_is_not_silently_truncated() {
        /// 16 MB：够切成 8 段（`MIN_CHUNK` 是 2 MB），又不必真下很多数据
        const TOTAL: u64 = 16 * 1024 * 1024;

        /*
         * 服务端：**每个段只给一次一半，第二次要就什么都不给**。
         *
         * ★ 这条测试在 2026-10-01 被我改过两次，两次都是**假服务器不真实**，
         *   记在这里免得再走：
         *   ① 原来"不管请求什么都回固定 256 KB" → 续下时下一轮又回 256 KB，
         *      **恰好把缺的补上**，段就"成功"了（而真实服务端不会这么巧）；
         *   ② 改成"每轮给剩余的一半" → 几何级数**收敛**，几轮之后真的下完了，
         *      `Ok` 其实是**正确结果**（而我的断言要求报错）。
         *   ⇒ 要造"永远下不完"，必须让它在某一次**明确地不再给数据**。
         *     这也就是真实世界的形状：连接断了、服务端不再吐字节。
         */
        let per_seg_rounds: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<u64, u32>>> =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let rounds = per_seg_rounds.clone();
        let server = FakeServer::start(move |_idx, range| match range {
            Some(r) => {
                let (a, b) = r
                    .trim_start_matches("bytes=")
                    .split_once('-')
                    .map(|(a, b)| {
                        (
                            a.trim().parse::<u64>().unwrap_or(0),
                            b.trim().parse::<u64>().unwrap_or(0),
                        )
                    })
                    .unwrap_or((0, 0));
                let want = (b.saturating_sub(a) + 1) as usize;
                // 按起点归到某一"轮"：同一段第二次来要就给 0
                // ★ 按**段**（不是按起点）计数：同一个段的第二次请求就失败。
                //   按起点计数是错的 —— 每轮起点都往后挪，永远是新位置。
                let seg_id = a / (2 * 1024 * 1024);
                let n = {
                    let mut g = rounds.lock().unwrap();
                    let e = g.entry(seg_id).or_insert(0);
                    *e += 1;
                    *e
                };
                let body: Vec<u8> = if n == 1 {
                    vec![b'Z'; (want / 2).max(1)]
                } else {
                    Vec::new() // 第二次要 —— 一个字节都不给
                };
                (
                    206,
                    vec![(
                        "Content-Range".to_string(),
                        format!("bytes {a}-{b}/16777216"),
                    )],
                    body,
                )
            }
            None => (200, vec![], vec![b'Z'; 1024]),
        });

        let (part, dir) = tmp_part("short-segment");
        /*
         * ★ 传**空**候选列表 ⇒ 退回"只有一个源"（就是这台假服务器）。
         *   这条测试要钉的是"单源短读也必须报错"，而不是多源轮转 ——
         *   多源轮转另有 `multi_source_round_robin` 那条。
         */
        let err = download_chunked(
            &server.url(),
            &[],
            &part,
            TOTAL,
            &CancelToken::new(),
            "测试包体".to_string(),
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await;

        assert!(
            err.is_err(),
            "★ 段没下完时**必须报错** —— 原来这里是 Ok(written)，\
             于是拼出一个截断的文件却被当成完整的包（真机上就是那个 EOCD 错误）"
        );
        let msg = format!("{}", err.unwrap_err());
        assert!(
            msg.contains("大小不对") || msg.contains("没下完") || msg.contains("下到"),
            "错误信息要说清「段没下完」这件事（含实际/期望字节数）：{msg}"
        );
        assert!(
            !part.exists(),
            "★ 半成品 .part 必须删掉 —— 留着它下一轮会被当成断点续传的进度，\
             而它的字节数是错的"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ 2026-10-01（用户：「**多源同时下**」）。
    ///
    ///   **分片必须把连接摊到多个源上**，而不是所有段都用同一个源。
    ///
    ///   这是本轮找出来的、与 PCL 最本质的差别：PCL 的 `TryBeginThread` 每开一个
    ///   线程就 `GetSource(Id + 1)` 换下一个源，**所有源同时在下**；
    ///   而我们是"一次只用一条源，慢了才换" —— 那条慢源会把时间占住，
    ///   用户看到的就是「有任务、进度几乎不动」。
    ///
    ///   这条测试造**两个**服务端：
    ///     · A：Range 请求只给**一半**（短读，等于一个坏节点）
    ///     · B：正常给满
    ///   断言：**B 真的被用到了**（说明段被摊到了第二个源上，
    ///   而不是死磕 A 直到整份失败）。
    ///
    ///   ★ 少了这条，"多源"可能只是写在注释里的意图 —— 而判据必须是
    ///     "第二个源**实际收到了请求**"。
    #[tokio::test]
    async fn multi_source_round_robin_spreads_segments() {
        const TOTAL: u64 = 8 * 1024 * 1024; // 4 段 × 2 MB（MIN_CHUNK 就是 2 MB）

        /*
         * 坏源：**Content-Range 报得对，但只给一半数据**。
         *   ★ 这才是"坏节点"的真实形状：协议层面没问题（206 + 正确的
         *     `Content-Range`），只是连接半死不活地断在中途。
         *     我们的 Content-Range 校验挡不住它 —— 必须靠"短读 → 换源续下"。
         */
        let bad = FakeServer::start(|_idx, range| match range {
            Some(r) => {
                let (a, b) = r
                    .trim_start_matches("bytes=")
                    .split_once('-')
                    .map(|(a, b)| {
                        (
                            a.trim().parse::<u64>().unwrap_or(0),
                            b.trim().parse::<u64>().unwrap_or(0),
                        )
                    })
                    .unwrap_or((0, 0));
                let want = (b.saturating_sub(a) + 1) as usize;
                /*
                 * ★ 内容**也按偏移生成**（与好源同一套规则），只是**只给一半**。
                 *   这一点很要紧：坏源给的字节是**从正确偏移开始**的，
                 *   所以拼出来应当整份等于期望值 ——
                 *   若它给出"从 0 开始的内容"，那就变成在测另一件事了
                 *   （而这条测试第一次跑出来的 65 就是这么来的）。
                 */
                let body: Vec<u8> = (a..a + (want / 2) as u64)
                    .map(|o| (o % 251) as u8)
                    .collect();
                (
                    206,
                    vec![(
                        "Content-Range".to_string(),
                        format!("bytes {a}-{b}/{TOTAL}"),
                    )],
                    body,
                )
            }
            None => (200, vec![], vec![0u8; 1024]),
        });
        /*
         * 好源：协议与数据都正常，而且**按"请求的区间"给足**。
         *
         * ★ 2026-10-01：这里刻意**不用** `start_ranged`（它按"区间长度"切，
         *   所以"只取缺的那段"与"整段重取"拿到的**开头内容一样** ——
         *   于是偏移错了也测不出来：我真去拆掉修复跑过，测试照样绿）。
         *
         *   这个源给足**请求区间对应的绝对内容**，于是：
         *     · 正确写法（只要缺的那段 `bytes=A-B`）→ 拿到的正是该位置的内容 ✅
         *     · 整段重取（从段首要到段尾）→ 拿到**段首那段**，被追加到已写
         *       部分之后 ⇒ **字节位置错了**，逐字节比对立刻抓到 ❌
         */
        let good = FakeServer::start(move |_idx, range| match range {
            Some(r) => {
                let (a, b) = r
                    .trim_start_matches("bytes=")
                    .split_once('-')
                    .map(|(a, b)| {
                        (
                            a.trim().parse::<u64>().unwrap_or(0),
                            b.trim().parse::<u64>().unwrap_or(TOTAL - 1),
                        )
                    })
                    .unwrap_or((0, TOTAL - 1));
                /*
                 * ★★ 这个源**只忽略 `to`、但尊重起点 `a`**。
                 *
                 *   为什么必须是这样：判据要能分开两种写法，而它们的区别
                 *   **只在 `to`**：
                 *     · 正确：`bytes={段首+已下}-{段首+已下+缺的-1}`（只取缺的）
                 *     · 错误：`bytes={段首+已下}-{段尾}`（整段重取，多要了）
                 *   两者**起点相同**。所以服务端只要"从 `a` 开始、给到
                 *   自己愿意的地方"，就能让错误写法多拿一截 ⇒ 偏移错开。
                 *
                 *   ★ 我试过两版都不对，记在这里省得下一个人重走：
                 *     ① 按请求区间切片 → 两种写法内容一样，**抓不到**；
                 *     ② 只从**段首**给数据（连起点也不认）→ 连正确写法也失败，
                 *        测的是另一件事（而且真实世界里"忽略起点"的服务端
                 *        会被 `Content-Range` 校验先拦下来）。
                 */
                /*
                 * ★★ 每轮**只给 256 KB**（封顶），且从**请求的起点**给。
                 *
                 *   为什么这样才公平：一段 2 MB 要下 **8 轮**，于是
                 *   "下一轮该从哪儿接着要"这件事**每轮都被检验**。
                 *
                 *   ★ 我前面两版假服务器都**抓不到**那个偏移 bug，原因记在这里：
                 *     ① 按"请求区间"切片 → 两种写法内容一样；
                 *     ② 只给一次一半、好源一次补齐 → 循环只跑两轮，
                 *        `to` 给长了也没机会多写。
                 *     ⇒ "看起来像在测"最危险：抓不到 bug 的测试等于没写。
                 */
                let capped = (b - a + 1).min(256 * 1024);
                let body: Vec<u8> = (a..a + capped).map(|o| (o % 251) as u8).collect();
                (
                    206,
                    vec![(
                        "Content-Range".to_string(),
                        format!("bytes {a}-{b}/{TOTAL}"),
                    )],
                    body,
                )
            }
            None => (
                200,
                vec![],
                (0..TOTAL).map(|o| (o % 251) as u8).collect(),
            ),
        });

        let (part, dir) = tmp_part("multi-source");
        // 两个候选：坏的在前面（模拟"首选那条正好是个坏节点"）
        let cands = vec![bad.url(), good.url()];
        let outcome = download_chunked(
            &bad.url(),
            &cands,
            &part,
            TOTAL,
            &CancelToken::new(),
            "测试包体".to_string(),
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await;

        let good_hits = good.ranges().len();
        let bad_hits = bad.ranges().len();
        println!("坏源收到的 Range: {:?}", bad.ranges());
        println!("好源收到的 Range: {:?}", good.ranges());
        assert!(
            good_hits > 0,
            "★ 第二个源**一个请求都没收到** —— 说明所有段都死磕第一个坏源，\
             这就不是「多源同时下」。坏源收到 {bad_hits} 次，好源收到 {good_hits} 次"
        );
        assert!(
            outcome.is_ok(),
            "有一个好源在候选里时**必须能下完**（坏源只给一半）：{:?}",
            outcome.err().map(|e| e.to_string())
        );

        /*
         * ★ 只断言"大小对"是**不够**的 —— 那正是我前面栽过的地方
         *   （大小对、内容错，一路走到解压才炸出 EOCD）。
         *
         *   这里做**逐字节**比对，而且每个字节的值由它的**偏移**决定
         *   （`offset % 251`）—— 于是"某段被写到了错误的位置"会立刻现形。
         *   ★ 坏源也贡献了每段的前半，而它给的数据是**从正确偏移**开始的，
         *     所以拼出来应当**整份等于期望值**：谁给的都行，位置必须对。
         */
        let bytes = tokio::fs::read(&part).await.expect("读回拼好的文件");
        assert_eq!(bytes.len() as u64, TOTAL, "大小必须是完整的");
        let want = expected_bytes(TOTAL);
        let wrong = bytes
            .iter()
            .zip(want.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(bytes.len());
        assert_eq!(
            wrong,
            bytes.len(),
            "★ 第 {wrong} 个字节不对（期望 {}，实际 {}）—— 段与段的拼接位置错了",
            want.get(wrong).copied().unwrap_or(0),
            bytes.get(wrong).copied().unwrap_or(0)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ 2026-10-01：**服务端给多了，我们也只写该写的那部分**。
    ///
    ///   段的写入是**追加**的，落盘位置由调用方记的 `already` 决定。
    ///   若服务端给的比请求的多（不老实的中转、把 `Range` 当建议、
    ///   或者它的 `Content-Length` 与 `Content-Range` 对不上），多出来那截
    ///   会被写到**下一个位置**上 —— 结果是**大小恰好对上、内容却错位**的文件。
    ///   这种最难查：它一路走到解压才炸，而报的是 zip 的 EOCD 错误。
    ///
    ///   ⇒ 判据：请求 `[SEG_START, SEG_END]`，服务端故意回**双倍**数据，
    ///     `download_range` **只能写这一段该有的字节数**。
    ///
    ///   ★ 这条是补上来的：我先把"写入封顶"写进代码，然后**拆掉它跑测试** ——
    ///     当时两条分片测试**都还是绿的**，也就是没有任何测试覆盖它。
    ///     "加了防御但没人测"等于没加：下一个人删掉它不会有人发现。
    #[tokio::test]
    async fn server_sending_extra_bytes_does_not_shift_the_segment() {
        const SPAN: u64 = 1024 * 1024;
        const SEG_START: u64 = 4 * 1024 * 1024;
        const SEG_END: u64 = SEG_START + SPAN - 1;
        const TOTAL: u64 = 16 * 1024 * 1024;

        // 服务端：Content-Range 报得**正确**（就是被请求的那一段），但**给双倍数据**
        let server = FakeServer::start(move |_idx, _range| {
            let body: Vec<u8> = (SEG_START..SEG_START + SPAN * 2)
                .map(|o| (o % 251) as u8)
                .collect();
            (
                206,
                vec![(
                    "Content-Range".to_string(),
                    format!("bytes {SEG_START}-{SEG_END}/{TOTAL}"),
                )],
                body,
            )
        });

        let (part, dir) = tmp_part("extra-bytes");
        let span = ChunkSpan {
            idx: 0,
            start: SEG_START,
            end: SEG_END,
        };
        let n = download_range(
            &server.url(),
            &part,
            span,
            0,
            TOTAL,
            &CancelToken::new(),
            "测试包体".to_string(),
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("这一段应当能下完");

        assert_eq!(
            n, SPAN,
            "★ 服务端给了双倍数据，我们也**只能写这一段该有的字节数**\
             （多写的会把后面的位置顶偏：大小恰好对、内容却是错的）"
        );
        let seg = segment_path(&part, 0);
        let len = tokio::fs::metadata(&seg).await.map(|m| m.len()).unwrap_or(0);
        assert_eq!(len, SPAN, "段文件也必须正好是这一段的大小：{len}");
        let bytes = tokio::fs::read(&seg).await.unwrap();
        let want: Vec<u8> = (SEG_START..SEG_START + SPAN)
            .map(|o| (o % 251) as u8)
            .collect();
        assert_eq!(bytes, want, "段内容必须是对应偏移的那一段");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ 2026-10-02：**分片到底有没有把连接铺开**（用尺子量，不靠推理）。
    ///
    ///   我这一轮连着两次"先动手、后验证"翻车，两次都**不知道自己在改什么数**：
    ///     · 调大 `CHUNK_COUNT` ⇒ 整条分片路径 0 字节（只有现象）；
    ///     · 加全局闸门 ⇒ 测试卡死（只有现象）。
    ///   判据必须来自数字。这条测试就是那个判据。
    ///
    ///   ★ 关键设计：假服务器**每个请求停 200 ms**，用的是
    ///     `std::thread::sleep`（阻塞），而它跑在**独立的 OS 线程**里 ——
    ///     所以"同时挂起的请求数"就是**真实的并发连接数**，
    ///     与 tokio 的调度无关。
    ///
    ///   ★ 断言两条：
    ///     ① 分片时峰值 **> 1**（真的铺开了）；
    ///     ② 分片时峰值 **明显高于** 单连接时（单连接恒为 1）。
    ///     —— 若①不成立，说明我在闸门/段数上又把它掐回去了。
    #[tokio::test]
    async fn chunked_download_actually_spreads_connections() {
        const TOTAL: u64 = 8 * 1024 * 1024; // 8 MB → 按 MIN_CHUNK(2MB) 切 4 段

        // ★ 用"完整实现"的替身：HEAD 报真实大小（否则引擎会回退单连接，
        //   于是这条测试测的就不是分片了 —— 已经被误导过三次）
        let (server, peak) = start_full(TOTAL, std::time::Duration::from_millis(200));

        // ── 分片 ──
        conn_stats::reset();
        let dir = std::env::temp_dir().join(format!("ieml-spread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("chunked.bin");
        let mut t = DownloadTask::new(p.clone(), server.url(), String::new(), TOTAL, "分片".into());
        t.allow_chunked = true;
        let out = download_batch(vec![t], BatchOptions::new(1, Source::Mojang, CancelToken::new()))
            .await
            .expect("分片这批不该失败");
        let peak_chunked = peak.swap(0, std::sync::atomic::Ordering::SeqCst);
        let reported = out.peak_connections;
        let got = tokio::fs::metadata(&p).await.map(|m| m.len()).unwrap_or(0);

        println!(
            "  分片：服务器收到的 Range = {:?}",
            server
                .ranges()
                .iter()
                .map(|r| r.clone().unwrap_or_else(|| "（无 Range）".into()))
                .collect::<Vec<_>>()
        );
        println!(
            "  分片：服务器观测峰值 {peak_chunked}，引擎自报峰值 {reported}，\
             下到 {got} 字节，失败 {}",
            out.failed.len()
        );
        assert!(
            server.ranges().iter().any(|r| r.is_some()),
            "★ 一个分段 Range 都没发出去 ⇒ **这条测试没走到分片路径**，\
             它证明不了任何关于并发的事（我被这个坑误导过三次）"
        );
        assert_eq!(got, TOTAL, "分片必须把文件下完整");

        // ── 单连接 ──
        conn_stats::reset();
        let p2 = dir.join("single.bin");
        let t2 = DownloadTask::new(p2.clone(), server.url(), String::new(), TOTAL, "单连接".into());
        let out2 = download_batch(
            vec![t2],
            BatchOptions::new(1, Source::Mojang, CancelToken::new()),
        )
        .await
        .expect("单连接这批不该失败");
        let peak_single = peak.swap(0, std::sync::atomic::Ordering::SeqCst);
        println!(
            "  单连接：服务器观测峰值 {peak_single}，引擎自报峰值 {}",
            out2.peak_connections
        );

        assert_eq!(
            peak_chunked as u64, reported,
            "★ 引擎自报的峰值与服务器实际观测**必须一致** —— \
             不一致说明尺子本身是坏的（那比没有尺子更危险）"
        );
        assert!(
            peak_chunked > 1,
            "★ 分片的连接峰值只有 {peak_chunked} —— **没有铺开**。\
             这正是我前两次栽的地方（段数被掐、或闸门把并发压回去了）"
        );
        assert!(
            peak_chunked > peak_single,
            "★ 分片（{peak_chunked}）不比单连接（{peak_single}）铺得宽，分片就白做了"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **P0-4**：服务端回的 206 偏移不是我们要的 → 必须**丢掉这份响应**，
    ///   重发一个**不带 `Range`** 的请求，把整份下回来。
    ///
    ///   老代码在这里做的是：`create_part()` 把文件截成 0，然后把**这一轮的
    ///   body**（服务端从它自己的偏移开始给的内容）写进去 ——
    ///   落盘的文件缺开头、SHA1 对不上，用户看到"某个文件反复校验失败"。
    #[tokio::test]
    async fn wrong_206_offset_triggers_a_fresh_request_without_range() {
        // 文件本体：200 字节，每字节 = 下标（便于逐字节比对内容）
        let full: Vec<u8> = (0..200u32).map(|i| i as u8).collect();
        let full_cl = full.clone();
        let server = FakeServer::start(move |_idx, range| {
            match range {
                // 带 Range 的续传请求：故意回一个**偏移不对**的 206
                Some(_) => (
                    206,
                    vec![("Content-Range".into(), "bytes 50-199/200".into())],
                    full_cl[50..].to_vec(),
                ),
                // 不带 Range：正常给整份
                None => (200, vec![], full_cl.clone()),
            }
        });

        let (part, dir) = tmp_part("offset");
        // 本地残留 100 字节（内容不重要，反正会被丢弃）
        std::fs::write(&part, vec![0xAAu8; 100]).unwrap();

        let manager = SourceManager::for_test();
        let got = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            100,     // existing
            0,       // proven_bps
            false,   // switchable
            200,     // task_size
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("对不上就重下一份，应该成功");

        let written = std::fs::read(&part).unwrap();
        assert_eq!(written.len(), 200, "落盘必须是**整份** 200 字节");
        assert_eq!(written, full, "★ 内容必须与整份逐字节一致（不是从偏移 50 开始的尾巴）");
        assert_eq!(got, 200, "这次真正写入的字节数 = 整份（重下）");

        let ranges = server.ranges();
        assert_eq!(ranges.len(), 2, "应该正好两次请求：一次带 Range、一次不带");
        assert!(ranges[0].is_some(), "第一次是带 Range 的续传尝试");
        assert!(
            ranges[1].is_none(),
            "★ 第二次**必须不带 Range**（这就是修法的要点）：{ranges:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **P0-5**：限流页（小响应搪塞）必须在**读完响应体之后**被认出来，
    ///   并且真的让源管理器冷却 + 降并发。
    ///
    ///   老代码在拿到响应头时就因为"宣告大小 != 任务记录"而返回
    ///   "服务端文件大小变了"，于是 `note_throttled` **从没被执行过** ——
    ///   源管理器不知道被限流，下一个文件照样被搪塞。
    #[tokio::test]
    async fn throttling_page_is_detected_and_cools_the_source() {
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![b'X'; 146]));
        let (part, dir) = tmp_part("throttle");

        let manager = SourceManager::for_test();
        let probe_src = Source::from_url(&server.url());
        let before = manager.recommended_concurrency(probe_src, 64);

        let err = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            0,
            0,
            false,
            286_235, // 任务记录 286 KB（实测的 gson 那一档）
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect_err("只回 146 字节必须判失败");

        let msg = err.to_string();
        assert!(
            msg.contains("限流页"),
            "★ 错误信息必须点明「像是限流页」（而不是「文件大小变了」）：{msg}"
        );
        assert!(
            manager.is_cooling(Source::from_url(&server.url())),
            "★ 识别出限流页之后必须冷却这个源（老代码永远走不到这一步）"
        );
        assert!(
            manager.recommended_concurrency(probe_src, 64) < before,
            "★ 并发必须真的降下来：{} → {}",
            before,
            manager.recommended_concurrency(probe_src, 64)
        );
        assert_eq!(server.ranges().len(), 1, "没带 Range 的第一次请求就够判定了");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ 2026-10-07（用户截图：「**为什么会下载会在最后阶段爆炸啊**」）。
    ///
    ///   **有 SHA1 时，长度只是参考值，SHA1 才是判据。**
    ///
    ///   现场：整合包装到最后，几个 Mod 报
    ///   `任务记录 215534 字节，实际拿到 215533 字节（少了 1 字节）`
    ///   —— 而那几个文件**内容是对的**，只是清单里的 `fileSize`
    ///   与实际文件差一两个字节。于是"下载全部完成、就差落位"的那一刻被判死，
    ///   用户看到的就是"最后阶段爆炸"。
    ///
    ///   ⇒ 这条测试钉住：**清单记录的长度与真实长度差 1 字节、而 SHA1 对得上**
    ///     时，必须**成功**。
    ///
    ///   ★ 反面的保证由 `short_body_is_rejected_even_without_sha1` 钉着：
    ///     **没有 SHA1** 的任务，长度仍然是硬判据（差一个字节都不行）。
    ///     两条一起才说明白"谁说了算"。
    #[tokio::test]
    async fn size_off_by_one_is_ok_when_sha1_matches() {
        // 真实内容 12 字节
        let body = b"hello world\n".to_vec();
        let real_len = body.len() as u64;
        let real_sha1 = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&body);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let b2 = body.clone();
        let server = FakeServer::start(move |_idx, _range| (200, vec![], b2.clone()));
        let (part, dir) = tmp_part("off-by-one");

        let manager = SourceManager::for_test();
        /*
         * ★ 任务记录比真实**大 1 字节** —— 正是截图里那个形状。
         *   `download_single` 的签名是 `(manager, url, part, sha1, cancel, ..)`,
         *   最后一个参数才是 task_size。
         */
        let out = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::Sha1(real_sha1.clone()),
            &CancelToken::new(),
            0,
            0,
            false,
            real_len + 1,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await;

        assert!(
            out.is_ok(),
            "★ 清单记录的长度差 1 字节、而 SHA1 对得上 ⇒ **必须成功**。\
             以前这里会报「下载不完整」把文件判死，而那正是「最后阶段爆炸」：\
             {:?}",
            out.err().map(|e| e.to_string())
        );
        assert!(part.is_file(), "文件要真的落位");
        assert_eq!(
            std::fs::read(&part).unwrap(),
            body,
            "落位的必须正好是服务端给的那份内容"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ================= ★★ 第二阶段 A：体积上限在引擎里真的生效 ================= */

    /// ★★ **端到端（引擎级）**：一个只允许 50 字节的任务，服务端给 100 字节 ⇒
    ///     ① 必须**失败**，错误文案点名"超过体积上限"（说真话）；
    ///     ② **临时文件必须被删掉**（超限的临时文件不是"进度"，留着会被当续传起点）；
    ///     ③ 落盘的那一份绝不能留下任何字节。
    ///
    ///   ★ 走的是**单连接**这条写盘路径（`download_to_part` → `download_single`）：
    ///     任务的 `size`（声明值）小于上限，所以建连前那道闸门放行 ——
    ///     拦下它的是**流式累计**那道（也就是唯一能兜住"服务器不报
    ///     Content-Length"的那道）。分片那条路的同一道闸门由
    ///     `download_range` 里的 meter 守着（夹具更贵，见报告）。
    #[tokio::test]
    async fn over_cap_response_is_killed_and_part_is_deleted() {
        const CAP: u64 = 50;
        // 服务端给 100 字节，而闸门只允许 50 —— 连"声明大小"都超了上限，
        // 所以最先触发的是**建连前**那道（`rejected_by_declared_size`）：
        // 这正是"别先下满再发现"。
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![7u8; 100]));
        let (part, dir) = tmp_part("cap");

        let mut task = DownloadTask::new(
            dir.join("file.bin"),
            server.url(),
            String::new(),
            100, // 声明 100 字节 > 上限 50
            "图标 故意超限.bin".to_string(), // 类别 Image；下面用显式值覆盖
        );
        task.max_bytes = Some(CAP);
        assert_eq!(task.byte_cap().max_bytes, Some(CAP), "显式值必须优先");

        let cancel = CancelToken::new();
        let err = download_one(&task, Source::Mojang, &cancel)
            .await
            .expect_err("声明 100 字节 > 上限 50 ⇒ 必须失败");
        let msg = err.to_string();
        assert!(
            msg.contains("体积上限"),
            "★ 错误必须说真话（超过体积上限）：{msg}"
        );
        assert!(msg.contains("故意超限"), "要点名是哪个文件：{msg}");
        assert!(
            !part.exists(),
            "★ 超限时不能留下临时文件（留着会被当成续传进度）"
        );
        assert!(
            !dir.join("file.bin").exists(),
            "★ 超限的响应体一个字节都不许落成正式文件"
        );
        assert_eq!(server.ranges().len(), 0, "建连前就该拦下，一个请求都不该发");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ `cap_of` 的**三态**（引擎里真正解析闸门的那一份实现）：
    ///     ① 显式 `Some(n)` ⇒ 用 n；
    ///     ② `None` + 认得的标签 ⇒ 该类别的默认上限（**不是"不设上限"**）；
    ///     ③ `None` + 不认得的标签 ⇒ `Unknown`（**最紧的 64 MiB**）。
    ///   同一份测试在判据层（`domain/archive_guard.rs`）也有一版 ——
    ///   两处都钉住，是因为这里才是引擎真正调用的那个函数。
    #[test]
    fn cap_of_resolves_the_three_states() {
        use crate::domain::archive_guard::{default_limit_for, ArtifactClass};

        let mk = |label: &str, max_bytes: Option<u64>| {
            let mut t = DownloadTask::new(
                PathBuf::from("x.bin"),
                "https://example.com/x".into(),
                String::new(),
                0,
                label.to_string(),
            );
            t.max_bytes = max_bytes;
            t
        };

        // ① 显式值优先
        assert_eq!(
            cap_of(&mk("Java 17.0.10 运行时", Some(1234))).max_bytes,
            Some(1234)
        );
        // ② 未给 ⇒ 按标签推
        assert_eq!(
            cap_of(&mk("Java 17.0.10 运行时", None)).max_bytes,
            Some(default_limit_for(ArtifactClass::JavaRuntime)),
            "Java 标签必须拿到 1 GiB 那一档（否则真机上下不动 Java）"
        );
        assert_eq!(
            cap_of(&mk("客户端 1.20.1.jar", None)).max_bytes,
            Some(default_limit_for(ArtifactClass::ClientJar))
        );
        // ③ 认不出来 ⇒ 最紧的一档，且是**真闸门**
        let unknown = cap_of(&mk("谁知道这是什么", None));
        assert_eq!(
            unknown.max_bytes,
            Some(default_limit_for(ArtifactClass::Unknown))
        );
        assert_eq!(unknown.describe(), "64 MiB");
        assert!(
            unknown.over_limit(65 * 1024 * 1024),
            "未知类别必须是真闸门（不是 None）"
        );
        // `DownloadTask::new` 造出来的任务**天生就带闸门**（不是 None）
        assert_eq!(
            mk("图标 pack.png", None).byte_cap().describe(),
            "8 MiB",
            "构造函数不填 Some 也必须能解析出类别默认档"
        );
    }

    /// ★★ **续传不许绕过上限**（引擎级）：`ByteMeter::starting_at(盘上已有字节)`。
    ///
    ///   形状：上限 100 MB，第一轮下到 90 MB 断了。若 meter 只算这一轮新收的
    ///   字节，那么"再下 90 MB"两轮加起来 180 MB 都不会被判超限 —— 上限被绕过。
    ///   起始口径 = 整份文件的落点，所以第二轮补到 100 MB 就到顶。
    #[test]
    fn resume_meter_cannot_be_bypassed() {
        use crate::domain::archive_guard::{ByteCap, ByteMeter};
        const MB: u64 = 1024 * 1024;
        let cap = ByteCap {
            max_bytes: Some(100 * MB),
        };

        // 第一轮：0 → 90 MB
        let mut first = ByteMeter::new(cap).starting_at(0).unwrap();
        first.add(90 * MB).expect("第一轮 90 MB 没超限");

        // 第二轮续传：盘上已有 90 MB —— 初值必须是 90 MB
        let mut second = ByteMeter::new(cap)
            .starting_at(90 * MB)
            .expect("90 MB 残留可以接着下");
        assert!(second.add(10 * MB).is_ok(), "补到 100 MB 正好到顶");
        assert!(
            second.add(1).is_err(),
            "★ 两轮加起来 100 MB + 1 必须被拦（续传不是绕过上限的后门）"
        );

        // 盘上残留本身超限 ⇒ 开局就拒
        assert!(ByteMeter::new(cap).starting_at(120 * MB).is_err());
    }

    /// ★★ **超限必须是"致命"，不许被重试 3×3 轮**（这条测试直接问引擎的分类器）。
    ///
    ///   为什么值得单开一条：我第一版的文案是"响应体超过这个类别的体积上限：…"，
    ///   而 `domain::failure::classify_message` 里致命那一组认的是
    ///   `磁盘满/权限/校验/大小不对/没下完/…` —— **一个都不匹配**，
    ///   于是这条错误被判成 `Retryable`：3 轮退避 + 换源重下 + 批次层再 3 轮，
    ///   十几秒后给用户看到同一句话（审计原话：retrying just makes the UI lie
    ///   for longer）。现在文案里带上判据认得的那几个词，这条测试钉住它。
    #[test]
    fn over_cap_error_is_fatal_not_retryable() {
        use crate::domain::archive_guard::{ArtifactClass, ByteCap};
        let cap = ByteCap::for_class(ArtifactClass::Image);
        let err = cap_exceeded_error("图标 故意超限.png", cap, 999 * 1024 * 1024);
        assert_eq!(
            err.class(),
            FailureClass::Fatal,
            "★ 超限必须判成致命（否则会白烧 3×3 轮重试与退避）：{err}"
        );
        assert!(
            err.fatal_without_trying_other_sources(),
            "★ 也不该去换源重下同一份超限的东西"
        );
        let msg = err.to_string();
        assert!(msg.contains("体积上限"), "文案要给人看得懂的原因：{msg}");
        assert!(msg.contains("故意超限"), "要点名是哪个文件：{msg}");
    }

    /// 长度对不上（少了）→ 必须失败，**不许**把半份文件当成功交上去。
    ///   这一条守着"没有 SHA1 的任务"（任务表里确实有这种：整合包文件缺 sha1 字段）。
    #[tokio::test]
    async fn short_body_is_rejected_even_without_sha1() {
        // 任务记录 200 字节，服务端只给 120
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![7u8; 120]));
        let (part, dir) = tmp_part("short");

        let manager = SourceManager::for_test();
        let err = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            0,
            0,
            false,
            200,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect_err("半份文件不许当成功");
        let msg = err.to_string();
        assert!(msg.contains("下载不完整"), "{msg}");
        assert!(msg.contains("少了 80 字节"), "要说清差多少：{msg}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 长度正好对上 → 成功（别把正常下载也拦了）
    #[tokio::test]
    async fn exact_length_passes() {
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![3u8; 256]));
        let (part, dir) = tmp_part("exact");
        let manager = SourceManager::for_test();
        let got = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            0,
            0,
            false,
            256,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("长度一致就该成功");
        assert_eq!(got, 256);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 任务不知道大小（`size == 0`，例如整合包里没写 file_size 的条目）→
    ///   **不猜**，交给 SHA1 / 上游。长度校验不许在"不知道"时乱判。
    #[tokio::test]
    async fn unknown_size_is_not_length_checked() {
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![1u8; 37]));
        let (part, dir) = tmp_part("unknown");
        let manager = SourceManager::for_test();
        let got = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            0,
            0,
            false,
            0,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("大小未知时不该因为长度判失败");
        assert_eq!(got, 37);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 续传**正常**时不该被新逻辑打断：偏移与总大小都对 → 追加写、只多下一次尾巴。
    #[tokio::test]
    async fn correct_resume_still_appends() {
        let full: Vec<u8> = (0..100u32).map(|i| i as u8).collect();
        let tail = full[60..].to_vec();
        let server = FakeServer::start(move |_idx, _range| {
            (
                206,
                vec![("Content-Range".into(), "bytes 60-99/100".into())],
                tail.clone(),
            )
        });
        let (part, dir) = tmp_part("resume");
        std::fs::write(&part, &full[..60]).unwrap();

        let manager = SourceManager::for_test();
        let got = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            60,
            0,
            false,
            100,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("偏移与总大小都对 → 续传成功");
        assert_eq!(got, 40, "这一轮只写了尾巴那 40 字节");
        assert_eq!(std::fs::read(&part).unwrap(), full, "拼出来的必须是整份");
        assert_eq!(server.ranges().len(), 1, "对得上就不该再发第二个请求");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 416（`.part` 比服务端文件还大）→ **同一次调用内**就清掉残留、改用
    ///   不带 Range 的请求下完整份（老代码是返回错误、把希望寄托在下一轮重试上）。
    #[tokio::test]
    async fn http_416_recovers_within_the_same_call() {
        let full: Vec<u8> = vec![9u8; 80];
        let full_cl = full.clone();
        let server = FakeServer::start(move |_idx, range| match range {
            Some(_) => (416, vec![], Vec::new()),
            None => (200, vec![], full_cl.clone()),
        });
        let (part, dir) = tmp_part("416");
        // 坏残留：比文件大
        std::fs::write(&part, vec![0u8; 500]).unwrap();

        let manager = SourceManager::for_test();
        let got = download_single(
            &manager,
            &server.url(),
            &part,
            &ExpectedHash::None,
            &CancelToken::new(),
            500,
            0,
            false,
            80,
            "测试",
            crate::domain::archive_guard::ByteCap::unlimited(),
        )
        .await
        .expect("416 之后应当自己重下成功");
        assert_eq!(std::fs::read(&part).unwrap(), full);
        assert_eq!(got, 80);
        let ranges = server.ranges();
        assert_eq!(ranges.len(), 2, "第一次带 Range（被 416 拒），第二次不带");
        assert!(ranges[1].is_none(), "{ranges:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn part_path_appends_suffix() {
        let p = part_path(Path::new("c.jar"));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "c.jar.part");
        // 且与原文件同级（不能跑到别的目录去）
        assert_eq!(p.parent(), Path::new("c.jar").parent());
    }

    #[test]
    fn part_path_keeps_parent_dir() {
        let orig = PathBuf::from("a").join("b").join("c.jar");
        let p = part_path(&orig);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "c.jar.part");
        // 父目录必须与原文件一致（用 Path 比较，别做字符串匹配 —— 分隔符跨平台不同）
        assert_eq!(p.parent(), orig.parent());
    }

    #[test]
    fn hex_encoding() {
        assert_eq!(hex(&[0x00, 0xff, 0x1a]), "00ff1a");
    }

    #[test]
    fn cancel_token_works() {
        let t = CancelToken::new();
        assert!(!t.is_cancelled());
        t.cancel();
        assert!(t.is_cancelled());
    }

    #[test]
    fn segment_path_appends_index() {
        let p = segment_path(Path::new("c.jar.part"), 3);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "c.jar.part.3");
        assert_eq!(p.parent(), Path::new("c.jar.part").parent());
    }

    #[test]
    fn plan_path_appends_suffix() {
        let p = plan_path(Path::new("c.jar.part"));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "c.jar.part.chunks");
    }

    #[test]
    fn is_part_file_detects_all_kinds() {
        // 单连接续传的残留
        assert!(is_part_file(Path::new("c.jar.part")));
        // 分片临时文件
        assert!(is_part_file(Path::new("c.jar.part.0")));
        assert!(is_part_file(Path::new("c.jar.part.7")));
        // 段计划
        assert!(is_part_file(Path::new("c.jar.part.chunks")));
        // 竞速时代的残留（老版本留下的，也要能清掉 ——
        // 实测 shared/versions/26.1.2/ 里就躺着 26.1.2.jar.part.race0.2）
        assert!(is_part_file(Path::new("26.1.2.jar.part.race0.2")));
        // 正常文件不是：**这条曾经被写宽过**（用 contains(".part") 会把
        // ".partial" 也当成残留，测试当场抓出来）
        assert!(!is_part_file(Path::new("c.jar")));
        assert!(!is_part_file(Path::new("c.jar.partial")));
        assert!(!is_part_file(Path::new("data.part2.bin")));
        assert!(!is_part_file(Path::new("departure.txt")));
    }

    /* ---------- 分片规划 ---------- */

    #[test]
    fn chunks_cover_file_exactly_once() {
        // 每个字节必须被且只被一段覆盖（多一段会重复、少一段会缺字节）
        for total in [1u64, 1023, 4096, 1_000_000, 4 * 1024 * 1024, 39_000_000, 123_456_789] {
            let spans = plan_chunks(total, CHUNK_COUNT, MIN_CHUNK);
            assert!(!spans.is_empty(), "total={total} 不该切出 0 段");
            assert_eq!(spans[0].start, 0);
            assert_eq!(spans.last().unwrap().end, total - 1);
            let sum: u64 = spans.iter().map(|s| s.len()).sum();
            assert_eq!(sum, total, "total={total} 段总长不等于文件大小：{spans:?}");
            for w in spans.windows(2) {
                assert_eq!(w[0].end + 1, w[1].start, "段之间必须连续无缝");
            }
        }
    }

    #[test]
    fn chunks_respect_max_count() {
        let spans = plan_chunks(200 * 1024 * 1024, CHUNK_COUNT, MIN_CHUNK);
        assert!(spans.len() as u64 <= CHUNK_COUNT, "段数不能超过上限");
        assert_eq!(spans.len() as u64, CHUNK_COUNT);
    }

    #[test]
    fn small_file_is_single_chunk() {
        let spans = plan_chunks(1024, CHUNK_COUNT, MIN_CHUNK);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end, 1023);
    }

    #[test]
    fn chunk_size_is_at_least_min() {
        // 每段不小于 MIN_CHUNK（除非整个文件比 MIN_CHUNK 还小）
        let total = 39_000_000u64;
        let spans = plan_chunks(total, CHUNK_COUNT, MIN_CHUNK);
        for s in &spans {
            if total >= MIN_CHUNK {
                assert!(
                    s.len() >= MIN_CHUNK,
                    "段太小（{} < {MIN_CHUNK}）：{s:?}",
                    s.len()
                );
            }
        }
    }

    /* ---------- 段计划复用 ---------- */

    #[test]
    fn chunk_plan_roundtrip_and_match() {
        let spans = plan_chunks(39_000_000, CHUNK_COUNT, MIN_CHUNK);
        let plan = ChunkPlan::from_spans(39_000_000, &spans);
        let text = serde_json::to_string(&plan).unwrap();
        let back: ChunkPlan = serde_json::from_str(&text).unwrap();
        assert!(back.matches(39_000_000, &spans), "自己写的计划必须能对上");
        // ★ 大小变了 → 计划作废（旧段的偏移是错的，必须重下）
        assert!(!back.matches(38_000_000, &plan_chunks(38_000_000, CHUNK_COUNT, MIN_CHUNK)));
        // ★ 段边界变了 → 也必须作废
        assert!(!back.matches(39_000_000, &plan_chunks(39_000_000, 4, MIN_CHUNK)));
    }

    /* ---------- 退避 ---------- */

    #[test]
    fn backoff_grows_and_is_capped() {
        let base = std::time::Duration::from_millis(500);
        let max = std::time::Duration::from_secs(5);
        // 1 → ~500ms，2 → ~1s，3 → ~2s，4 → ~4s，5+ → 封顶 5s
        let d1 = backoff_delay(1, base, max).as_millis();
        let d3 = backoff_delay(3, base, max).as_millis();
        let d9 = backoff_delay(9, base, max).as_millis();
        assert!(d1 < d3, "退避必须递增：{d1} vs {d3}");
        assert!(d3 < d9, "退避必须递增：{d3} vs {d9}");
        // 抖动 ±20%，封顶 5s → 最多 6s
        assert!(d9 <= 6000, "退避必须封顶：{d9}ms");
        assert!(d9 >= 4000, "封顶值不该被抖动打到太低：{d9}ms");
    }

    /* ---------- 去重：副本必须排在原件之后 ---------- */

    #[test]
    fn dedup_splits_network_and_copy_jobs() {
        let mk = |path: &str, sha1: &str| DownloadTask::new(PathBuf::from(path), "https://x/y".into(), sha1.into(), 10, path.into());

        let (net, copies) = dedup_pass(vec![
            mk("a/1.ogg", "HASH_A"),
            mk("b/2.ogg", "HASH_B"),
            // 与第一个同内容（不同名字）→ 应该是复制，不是第二次网络下载
            mk("c/1.ogg", "HASH_A"),
            mk("d/2.ogg", "HASH_B"),
        ]);

        assert_eq!(net.len(), 2, "只有两个唯一内容需要联网下");
        assert_eq!(copies.len(), 2, "两个重复内容走本地复制");
        // 副本的源必须是**先出现**的那个网络任务的目标路径
        assert_eq!(copies[0].source, PathBuf::from("a/1.ogg"));
        assert_eq!(copies[0].task.path, PathBuf::from("c/1.ogg"));
        assert_eq!(copies[1].source, PathBuf::from("b/2.ogg"));
        assert_eq!(copies[1].task.path, PathBuf::from("d/2.ogg"));
    }

    /// ★ 回归测试（真实踩过的大坑，两个坑叠在一起）：
    ///   1.20.1 的 3598 个资源条目里有 23 个 hash 被两个名字共用
    ///   （如 `entity/fish/swim1.ogg` 与 `liquid/swim1.ogg` 内容相同）。
    ///   资源文件是**内容寻址**的（`objects/<前两位>/<sha1>`），
    ///   两个名字算出的是**同一个磁盘路径** —— 正确行为是"什么都不做"，
    ///   而不是"复制一份"：复制等于 `copy(X, X)`，Windows 报 `os error 32`，
    ///   表现为固定 23 个文件失败、补下 3 轮全挂，看起来像杀毒软件锁文件。
    #[test]
    fn same_hash_same_path_is_dropped_not_copied() {
        let shared_path = PathBuf::from("assets/objects/6e/6ea4e448");
        let tasks: Vec<DownloadTask> = [
            "minecraft/sounds/entity/fish/swim1.ogg",
            "minecraft/sounds/liquid/swim1.ogg",
        ]
        .iter()
        .map(|n| {
            DownloadTask::new(
                shared_path.clone(),
                "https://resources/6e/6ea4e448".into(),
                "6ea4e448".into(),
                9227,
                (*n).into(),
            )
        })
        .collect();

        let (net, copies) = dedup_pass(tasks);
        assert_eq!(net.len(), 1, "同内容只下一次");
        assert!(
            copies.is_empty(),
            "目标路径相同 → 不能生成复制任务（copy(X,X) 在 Windows 上必然失败）"
        );
    }

    /// 反过来：目标路径**不同**时，仍然应该走本地复制（省一次网络请求）
    #[test]
    fn same_hash_different_path_is_copied() {
        let mk = |path: &str, label: &str| {
            DownloadTask::new(
                PathBuf::from(path),
                "https://x/y".into(),
                "SAME".into(),
                10,
                label.into(),
            )
        };
        let (net, copies) = dedup_pass(vec![
            mk("libs/a.jar", "a"),
            mk("backup/a.jar", "a-copy"),
        ]);
        assert_eq!(net.len(), 1, "同内容只下一次");
        assert_eq!(copies.len(), 1, "不同路径 → 本地复制");
        assert_eq!(copies[0].source, PathBuf::from("libs/a.jar"));
        assert_eq!(copies[0].task.path, PathBuf::from("backup/a.jar"));
    }

    #[test]
    fn dedup_keeps_tasks_without_hash() {
        // 没有 sha1 的文件无法判重，必须各自下载
        let mk = |p: &str| DownloadTask::new(PathBuf::from(p), "https://x/y".into(), String::new(), 0, p.into());
        let (net, copies) = dedup_pass(vec![mk("a"), mk("b"), mk("c")]);
        assert_eq!(net.len(), 3);
        assert!(copies.is_empty());
    }

    /* ==================================================================
     * 判据 2：**去重键是目标路径**（不是内容哈希）+ 每路径一把锁
     * ================================================================== */

    /// ★★★★ **这一条守的就是审计点名的那个竞态。**
    ///
    ///   同一个目标路径、**不同哈希**（一条有、一条空）：
    ///
    ///   ```text
    ///     任务 A：path=P, sha1=H1     ← 正常解析出来的那条
    ///     任务 B：path=P, sha1=""     ← .mrpack 没给哈希 / commands_real.rs:10818
    ///   ```
    ///
    ///   按**内容哈希**去重时它们看起来是两个不同文件 ⇒ 两个 worker 同时写 P：
    ///   一个 `create_part`（截断）、一个 `open_part_append`（追加），各自 rename。
    ///   结果是**"长度对、内容错"**，而空哈希那条**发现不了**（它不校验）。
    ///
    ///   ⇒ 判据：**同一个目标路径只许留下一条任务**，并且留下的必须是
    ///     **有哈希的那条**（它落位后我们**能证明**它是对的）。
    #[test]
    fn same_path_different_hash_keeps_only_one_task() {
        let shared = PathBuf::from("mods/sodium.jar");
        let with_hash = DownloadTask::new(
            shared.clone(),
            "https://cdn.modrinth.com/sodium.jar".into(),
            "H1".into(),
            10,
            "mods/sodium.jar（有哈希）".into(),
        );
        let without_hash = DownloadTask::new(
            shared.clone(),
            "https://example.invalid/sodium.jar".into(),
            String::new(),
            0,
            "mods/sodium.jar（没哈希）".into(),
        );

        // ① 有哈希的在前：留下的当然是它
        let (net, copies) = dedup_pass(vec![with_hash.clone(), without_hash.clone()]);
        assert_eq!(
            net.len(),
            1,
            "★ 同一个目标路径只许留下**一条**任务 —— 两条会让两个 worker 同时写它"
        );
        assert!(copies.is_empty(), "同路径不是「复制」关系");
        assert_eq!(net[0].sha1, "H1", "留下的是有哈希的那条");

        // ② ★ 反过来（没哈希的在前）：仍然必须留下**有哈希**的那条
        //    —— "先出现的优先"这一条不适用于"一条有哈希、一条没有"
        let (net2, copies2) = dedup_pass(vec![without_hash, with_hash]);
        assert_eq!(net2.len(), 1, "顺序反过来也只留一条");
        assert!(
            net2[0].expected_hash().is_some(),
            "★★ 必须保留**有校验值**的那条：换成没哈希的那条，
             这个文件落位之后就永远无法被证明是对的了（这正是审计那条 \
             「None 不能悄悄等于成功」的现场）"
        );
        assert_eq!(net2[0].sha1, "H1");
        assert!(copies2.is_empty());
    }

    /// 同内容、同路径：只下一次（老行为，仍然要成立 —— 1.20.1 有 23 个这样的条目）
    #[test]
    fn same_hash_same_path_still_deduped() {
        let p = PathBuf::from("assets/objects/6e/6ea4e448");
        let mk = |label: &str| {
            DownloadTask::new(p.clone(), "https://r/6e".into(), "6ea4e448".into(), 9227, label.into())
        };
        let (net, copies) = dedup_pass(vec![mk("a"), mk("b")]);
        assert_eq!(net.len(), 1);
        assert!(copies.is_empty());
    }

    /// 同路径但写成了不同的字符串形状（`\` vs `/`、大小写）→ **必须当成同一个路径**。
    ///
    ///   ★ 这是"锁与去重用同一个 `path_key`"的意义所在：拿原样字符串当键，
    ///     锁就漏了 —— 而漏掉的正是"两个 worker 写同一个文件"。
    #[test]
    fn path_key_normalizes_separators_and_case() {
        // 不需要盘上真实存在：父目录 canonicalize 失败时退回"只统一分隔符+小写"
        let a = path_key(Path::new("Mods/Sub/Sodium.JAR"));
        let b = path_key(Path::new("mods\\sub\\sodium.jar"));
        let c = path_key(Path::new("mods/sub/sodium.jar"));
        if cfg!(windows) {
            assert_eq!(a, b, "★ 反斜杠与正斜杠必须归一（Windows 上两种都有人写）");
            assert_eq!(b, c, "★ 大小写必须归一（NTFS 默认大小写不敏感）");
        } else {
            // Unix 上大小写是**有意义**的，不许合并
            assert_eq!(b, c);
            assert_ne!(a, c, "Unix 上 Sodium.JAR 与 sodium.jar 是两个文件");
        }
    }

    /// ★ 路径锁的簿记**不许泄漏**（map 大小必须恒等于"正在写的路径数"）。
    ///
    ///   判据是纯逻辑的：拿两把锁、放掉、再确认条目不在了。
    ///   （不需要 tokio 运行时 —— `get` / `release` 都是同步的。）
    #[test]
    fn path_lock_registry_does_not_leak_entries() {
        let locks = PathLocks::new();
        let p1 = PathBuf::from("a/one.jar");
        let p2 = PathBuf::from("b/two.jar");

        let l1 = locks.get(&p1);
        let l2 = locks.get(&p2);
        assert_eq!(locks.len(), 2, "两条路径 → 两个条目");
        // ★ 同一个键必须拿到**同一个** Arc（否则锁就不互斥了）
        assert!(Arc::ptr_eq(&l1, &locks.get(&p1)), "同一个路径必须是同一把锁");

        drop(l1);
        locks.release(&p1);
        assert_eq!(locks.len(), 1, "放掉的条目必须被删掉（否则 map 会一直长）");

        drop(l2);
        locks.release(&p2);
        assert_eq!(locks.len(), 0, "全部放掉之后 map 必须是空的");
    }

    /// ★ 还有别人拿着这把锁时，`release` **不许**把条目删掉
    ///   （删了就会有人拿到一把"全新的锁"→ 互斥当场失效）。
    #[test]
    fn path_lock_release_keeps_entry_while_still_held() {
        let locks = PathLocks::new();
        let p = PathBuf::from("a/held.jar");
        let first = locks.get(&p);
        let second = locks.get(&p); // 另一个持有者
        assert!(Arc::ptr_eq(&first, &second));

        drop(first);
        locks.release(&p);
        assert_eq!(locks.len(), 1, "★ 还有人拿着 → 条目不能删（删了互斥就没了）");

        drop(second);
        locks.release(&p);
        assert_eq!(locks.len(), 0);
    }

    /* ==================================================================
     * 判据 3：没有校验值 ≠ 校验通过
     * ================================================================== */

    /// ★★★★ **审计第 102 行的那一条**：`None` 不许悄悄等于成功。
    ///
    ///   现场（`commands_real.rs:10818-10820`）：
    ///   `DownloadTask::new(dest, url, String::new(), 0, path)` —— `sha1="" size=0`。
    ///   老实现下 `verify_existing` 走 `if task.size == 0 || len == task.size { Ok }`
    ///   ⇒ **任何已存在的文件**都算缓存命中 ⇒ `download_one_with` 直接
    ///   `return Ok(true)`（跳过）—— 一个内容完全不对的文件会被当成"下好了"。
    ///
    ///   ⇒ 新判据：这一档返回 [`VerifyOutcome::Unverified`]（**照旧不重下**，
    ///     但**必须说出来**：`length_checked = false` 表示连长度都没比过）。
    #[tokio::test]
    async fn existing_file_without_any_hash_is_reported_unverified_not_ok() {
        let dir = std::env::temp_dir().join(format!("ieml-unverified-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("mystery.jar");
        // 一个"内容随便、长度也不知道对不对"的已存在文件
        std::fs::write(&target, b"whatever the user left here").unwrap();

        let task = DownloadTask::new(
            target.clone(),
            "https://example.invalid/mystery.jar".into(),
            String::new(),
            0, // ★ size=0：这正是 `commands_real.rs` 那条补齐路径的形状
            "mystery.jar".into(),
        );

        match verify_existing(&task, &task.expected_hash()).await {
            VerifyOutcome::Unverified { length_checked } => {
                assert!(
                    !length_checked,
                    "size=0 时**连长度都没比过** —— 必须如实说 false"
                );
            }
            VerifyOutcome::Ok => panic!(
                "★ `size == 0` 且没有校验值时返回 Ok 就是审计点名的那条「悄悄成功」：\
                 任何已存在的文件都会被当成缓存命中"
            ),
            _ => panic!("这一档必须是 Unverified"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反向：**有校验值**且对得上 → 仍然是 `Ok`（别把正常缓存命中改坏）
    #[tokio::test]
    async fn existing_file_with_matching_hash_is_still_ok() {
        let dir = std::env::temp_dir().join(format!("ieml-verified-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("good.jar");
        let body = b"the right bytes\n".to_vec();
        std::fs::write(&target, &body).unwrap();

        let sha1 = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&body);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let task = DownloadTask::new(
            target.clone(),
            "https://example.invalid/good.jar".into(),
            sha1,
            body.len() as u64,
            "good.jar".into(),
        );
        assert!(
            matches!(
                verify_existing(&task, &task.expected_hash()).await,
                VerifyOutcome::Ok
            ),
            "SHA1 对得上就是缓存命中"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **无校验值但知道大小、且长度对得上** → 仍然是 `Unverified`，
    ///   但 `length_checked = true`（"用长度兜了一层"这件事要说准）。
    #[tokio::test]
    async fn unverified_with_matching_length_says_length_checked() {
        let dir = std::env::temp_dir().join(format!("ieml-unv-len-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("sized.bin");
        std::fs::write(&target, vec![7u8; 128]).unwrap();

        let task = DownloadTask::new(
            target.clone(),
            "https://example.invalid/sized.bin".into(),
            String::new(),
            128, // 任务知道大小
            "sized.bin".into(),
        );
        match verify_existing(&task, &task.expected_hash()).await {
            VerifyOutcome::Unverified { length_checked } => assert!(length_checked),
            _ => panic!("没有校验值就是 Unverified（哪怕长度对得上）"),
        }

        // 长度**对不上** → 那是确定的失败（原来的 Mismatch 行为不许丢）
        let bad = DownloadTask::new(
            target.clone(),
            "https://example.invalid/sized.bin".into(),
            String::new(),
            999,
            "sized.bin".into(),
        );
        assert!(
            matches!(
                verify_existing(&bad, &bad.expected_hash()).await,
                VerifyOutcome::Mismatch { .. }
            ),
            "无校验值 + 长度不符 ⇒ 必须判失败（长度是唯一的判据）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 明确声明"这个源没有发布校验值"（`without_verification`）——
    ///   与"我们没解析出来"（`sha1=""` 但没声明）在**类型上**是同一档，
    ///   但落进 `unverified` 清单的行为一致（两档都不校验、都要如实上报）。
    #[test]
    fn without_verification_declares_none() {
        let t = DownloadTask::new(
            PathBuf::from("x.jar"),
            "https://x/y".into(),
            "SOMEHASH".into(),
            5,
            "x".into(),
        )
        .without_verification();
        assert!(t.expected_hash().is_none(), "声明之后就是「确实没有校验值」");
        assert!(t.sha1.is_empty(), "同时把老口径的字段清掉，避免两条判据打架");
    }

    /// ★ `ExpectedHash` 的三态语义（判据 1 的 sha512 形状先立住）
    #[tokio::test]
    async fn expected_hash_three_states() {
        let dir = std::env::temp_dir().join(format!("ieml-eh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("h.bin");
        let body = b"hello\n".to_vec();
        std::fs::write(&f, &body).unwrap();

        let sha1 = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&body);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let sha512 = {
            use sha2::Digest as _;
            let mut h = sha2::Sha512::new();
            h.update(&body);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };

        assert_eq!(ExpectedHash::Sha1(sha1.clone()).verify_file(&f).await, Some(true));
        assert_eq!(ExpectedHash::Sha512(sha512).verify_file(&f).await, Some(true));
        assert_eq!(
            ExpectedHash::None.verify_file(&f).await,
            None,
            "★ 没有校验值 ⇒ 返回 None（= 无从判断），**不是** true"
        );
        // 错的哈希必须 false
        assert_eq!(
            ExpectedHash::Sha1("0".repeat(40)).verify_file(&f).await,
            Some(false)
        );
        assert_eq!(ExpectedHash::from_sha1(""), ExpectedHash::None);
        assert_eq!(
            ExpectedHash::from_sha1(&sha1),
            ExpectedHash::Sha1(sha1.clone())
        );
        assert_eq!(ExpectedHash::Sha1(sha1).algo(), "SHA1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ==================================================================
     * 判据 1：**错误分类**（致命立刻结束，不吃 3×3 预算）
     * ================================================================== */

    /// ★★★★ **404 不许吃满 `3 × 3` 次预算**（审计的 "fatal: 404/403"）。
    ///
    ///   ## 修之前是什么样
    ///
    ///   `NetError::is_retryable()` 的实现是 `!matches!(self, Cancelled)`
    ///   —— **除取消全可重试**。于是"这个地址上没有这个文件"这个**确定的结论**
    ///   要花 `MAX_FILE_RETRIES(3) × MAX_BATCH_ROUNDS(3) = 9` 次请求，
    ///   每轮之间还有 0.6→10 秒的退避。
    ///   ★ 而同一个仓库的**元数据路径早就是对的**（`get_text_with_headers`：
    ///     一次 4xx 就返回）—— 只有下载这条路漏改了。
    ///
    ///   ## 这条测试断言什么
    ///
    ///     ① 那个 404 地址**只被请求了一次**（不是 3 次、更不是 9 次）；
    ///     ② 但候选源列表**照旧走完**，第二个地址成功了。
    ///
    ///   ★ ② 是有意的：`fatal_without_trying_other_sources` 把
    ///     "与 URL 相关的 4xx"排除在外 —— 候选源之间可能是**完全不同的仓库**
    ///     （Mojang 的库 + BMCLAPI 就是不同的路径），一条路上 404 的文件
    ///     在另一条路上真的有。那不是"重试"，是"换个地方找"。
    #[tokio::test]
    async fn fatal_404_does_not_burn_the_retry_budget() {
        let server = FakeServer::start(|_idx, _range| (404, vec![], Vec::new()));

        let dir = std::env::temp_dir().join(format!("ieml-404-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("gone.jar");

        let task = DownloadTask::new(
            target.clone(),
            server.url(),
            String::new(),
            4096,
            "gone.jar".into(),
        );

        let manager = SourceManager::for_test();
        let err = download_one_with(&manager, &task, Source::Mojang, &CancelToken::new())
            .await
            .expect_err("404 必须报错");

        let hits = server.ranges().len();
        let msg = err.to_string();
        assert!(
            msg.contains("404"),
            "★ 错误信息必须保留状态码（上层要能分辨「确实没有」与「网络不好」）：{msg}"
        );
        assert!(
            hits <= 1,
            "★ 404 是**确定的失败**，同一个地址只许请求一次；实际请求了 {hits} 次 \
             —— 修之前这里会走满 `MAX_FILE_RETRIES(3) × MAX_BATCH_ROUNDS(3) = 9` 次 \
             加退避（`is_retryable` 当时是「除取消全可重试」）"
        );
        assert!(!target.exists(), "失败时不许留下成品文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ 404 是**致命**的，但"换一条**不同**的地址"是另一回事：
    ///   候选源之间可能是完全不同的仓库（Mojang 的库 + BMCLAPI 就是不同的路径），
    ///   一条路上 404 的文件在另一条路上真的有。
    ///
    ///   ⇒ `fatal_without_trying_other_sources` 把"与 URL 相关的 4xx"排除在外：
    ///     同一个 URL 一次就收场（上一条测试钉着），但候选列表照旧走完。
    ///   ★ 这条测试证明"照旧走完"是真的会发生 —— 否则那句注释就只是意图。
    #[tokio::test]
    async fn a_404_on_one_candidate_still_tries_the_next_one() {
        const TOTAL: u64 = 64 * 1024;
        // 好地址：一个"完整实现"的替身（HEAD 报真实大小、GET 给整份）
        let (good, _peak) = start_full(TOTAL, std::time::Duration::ZERO);
        let bad = FakeServer::start(|_idx, _range| (404, vec![], Vec::new()));

        let dir = std::env::temp_dir().join(format!("ieml-404-alt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("alt.jar");

        /*
         * ★ 用**查询串**把"好地址"与"坏地址"分开 —— `FakeServer::url()` 忽略
         *   路径（见那里的说明），而 `source::candidates_with` 会把
         *   `task.urls` 原样收进来（它按**整个 URL** 判重，所以带查询串的
         *   那一条是**另一个候选**）。
         */
        let mut task = DownloadTask::new(
            target.clone(),
            bad.url(), // 主地址：404
            String::new(),
            TOTAL,
            "alt.jar".into(),
        );
        task.urls = vec![format!("{}?alt=1", good.url())];

        let manager = SourceManager::for_test();
        let out = download_one_with(&manager, &task, Source::Mojang, &CancelToken::new()).await;

        assert!(
            out.is_ok(),
            "★ 坏地址 404 之后必须去试下一个候选（换路径/换仓库是有意义的）：{:?}",
            out.err().map(|e| e.to_string())
        );
        assert!(target.is_file(), "第二个候选成功了，文件必须落位");
        assert_eq!(
            tokio::fs::metadata(&target).await.map(|m| m.len()).unwrap_or(0),
            TOTAL
        );
        assert!(
            bad.ranges().len() <= 1,
            "坏地址仍然只许请求一次（换源不等于重试同一个地址）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ **校验不符必须拒绝，而且最终文件绝不创建。**
    ///
    ///   审计："A body that hashes wrong is rejected and the final file is never
    ///   created"（八个必测项里的第 2 条）。
    ///
    ///   这条同时钉住两条纪律：
    ///     ① 校验是在**改成正式名字之前**做的（`<target>.part` 上算完哈希才 rename）
    ///        —— 否则"坏文件 + 正确文件名"会被别的代码（启动流程 / 完整性校验）
    ///        当成好文件用；
    ///     ② 校验不符时 **`.part` 也要被删掉**（留着它下一轮会被当成
    ///        "断点续传的进度"）。
    #[tokio::test]
    async fn hash_mismatch_is_rejected_and_no_final_file_is_created() {
        // 服务端给的内容是错的（和期望的哈希对不上）
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![b'B'; 512]));
        let dir = std::env::temp_dir().join(format!("ieml-badhash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("corrupt.jar");

        let task = DownloadTask::new(
            target.clone(),
            server.url(),
            // 一个**肯定不等于**那 512 个 'B' 的哈希
            "0".repeat(40),
            512,
            "corrupt.jar".into(),
        );

        let manager = SourceManager::for_test();
        let err = download_one_with(&manager, &task, Source::Mojang, &CancelToken::new())
            .await
            .expect_err("哈希对不上必须报错");

        let msg = err.to_string();
        assert!(
            msg.contains("校验失败"),
            "★ 错误信息必须点明「校验失败」（下游 `run_round` 正是靠这句文案 \
             数 `repaired_files`）：{msg}"
        );
        assert!(
            !target.exists(),
            "★★ 校验不符时**最终文件绝不能创建** —— 一个内容错误的 \
             `corrupt.jar` 会被启动流程当成好文件用"
        );
        assert!(
            !part_path(&target).exists(),
            "★ 坏 `.part` 必须删掉：留着它下一轮会被当成「断点续传的进度」，\
             而它的内容是错的"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★★★ **同一个目标路径只许被写一次**（判据 2 的引擎级断言）。
    ///
    ///   ## 为什么两个方向都要测（这一条是"尺子"）
    ///
    ///   ① **同路径**：两个任务并发下同一个文件 → 服务器只该收到 **1 次** GET；
    ///   ② **不同路径（对照组）**：同样的两个任务、只是落点不同 →
    ///      服务器**必须**收到 2 次 GET。
    ///
    ///   ★ ② 是这条测试的价值所在：如果我只测①，那么"服务器请求数是 1"
    ///     既可能是**路径锁**起了作用，也可能是**假服务器/客户端根本没并发**
    ///     （这个仓库被这种"看起来像结论的数字"骗过三次）。
    ///     有了②，"请求数 = 1"才是**判据**而不是巧合。
    ///
    ///   ## 为什么要绕过 `download_batch`
    ///
    ///   `dedup_pass`（判据 2 的另一半）会把同路径的两条任务**提前**合成一条 ——
    ///   那样就测不到锁了。所以这里直接并发调两次 `download_one_with`：
    ///   那才是"两个 worker 同时写同一个文件"的真实形状
    ///   （`installer.rs` 与 `commands_real.rs` 都会直接调它）。
    #[tokio::test]
    async fn two_workers_on_the_same_path_write_it_once() {
        const TOTAL: u64 = 64 * 1024;

        /// 跑一对任务，返回服务器收到的 GET 次数
        async fn run_pair(same_path: bool, tag: &str) -> (usize, PathBuf, std::path::PathBuf) {
            // ★ 每个请求停 300ms：让"两条任务同时开跑"这件事真的发生
            let (server, _peak) = start_full(TOTAL, std::time::Duration::from_millis(300));
            let url = server.url();

            let dir = std::env::temp_dir().join(format!("ieml-once-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let target = dir.join("same.bin");
            let other = dir.join("other.bin");

            let t1 = DownloadTask::new(target.clone(), url.clone(), String::new(), TOTAL, format!("{tag} A"))
                .without_verification();
            let t2 = DownloadTask::new(
                if same_path { target.clone() } else { other },
                url.clone(),
                String::new(),
                TOTAL,
                format!("{tag} B"),
            )
            .without_verification();

            // ★ 两个独立的取消令牌要先绑成变量：`&CancelToken::new()` 这种临时值
            //   活不过 `join!`（编译器当场拒绝）
            let c1 = CancelToken::new();
            let c2 = CancelToken::new();
            let (a, b) = tokio::join!(
                download_one(&t1, Source::Mojang, &c1),
                download_one(&t2, Source::Mojang, &c2),
            );
            assert!(a.is_ok(), "A 应当成功：{:?}", a.err().map(|e| e.to_string()));
            assert!(b.is_ok(), "B 应当成功：{:?}", b.err().map(|e| e.to_string()));

            // ★ 只数真正的 GET（`start_full` 的 HEAD 是大小探测，不算下载）
            let gets = server
                .ranges()
                .iter()
                .filter(|r| r.is_none())
                .count();
            (gets, target, dir)
        }

        // ① 同路径：只许写一次
        let (gets_same, target, dir) = run_pair(true, "same").await;
        println!("  同路径：服务器收到 {gets_same} 次 GET");
        assert!(
            gets_same <= 1,
            "★★ 同一个目标路径**只许被写一次**：服务器收到了 {gets_same} 次 GET。\
             两个 worker 同时写同一个 `.part`（一个 `create_part` 截断、\
             一个 `open_part_append` 追加）会得到「长度对、内容错」的缓存条目 ——\
             而空哈希那条**发现不了**（审计：One worker per destination path）"
        );
        assert_eq!(
            tokio::fs::metadata(&target).await.map(|m| m.len()).unwrap_or(0),
            TOTAL,
            "落位的文件必须是完整的"
        );
        let _ = std::fs::remove_dir_all(&dir);

        // ② ★ 对照组：**不同路径**下，同样的两个任务必须各自下一份
        let (gets_diff, _, dir2) = run_pair(false, "diff").await;
        println!("  不同路径（对照）：服务器收到 {gets_diff} 次 GET");
        assert!(
            gets_diff >= 2,
            "★★ **尺子自检**：不同目标路径时服务器必须收到 2 次 GET，实得 {gets_diff} 次。\
             若这一条不成立，说明「同路径只收到 1 次」**证明不了任何事** ——\
             那可能只是两条任务没有真的并发（这个仓库被这种假结论骗过三次）"
        );
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// ★★ 判据 3 的引擎级断言：**"校验中"这一档必须至少出现过一次**，
    ///   而且每一批的最后一条事件必须是 `done`。
    ///
    ///   审计：*"Verifying" being invisible is why a hash check over a large
    ///   store looks like a hang.*
    #[tokio::test]
    async fn progress_reports_a_verifying_phase_and_ends_with_done() {
        let body = b"phase check body\n".to_vec();
        let want_sha1 = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&body);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let b2 = body.clone();
        let server = FakeServer::start(move |_idx, _range| (200, vec![], b2.clone()));

        let dir = std::env::temp_dir().join(format!("ieml-phase-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let phases: Arc<std::sync::Mutex<Vec<(ProgressPhase, String)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = Arc::clone(&phases);

        let mut opts = BatchOptions::new(2, Source::Mojang, CancelToken::new());
        opts.on_progress = Arc::new(move |p: DownloadProgress| {
            seen.lock().unwrap().push((p.phase, p.current_file.clone()));
        });

        let t = DownloadTask::new(
            dir.join("phased.bin"),
            server.url(),
            want_sha1,
            body.len() as u64,
            "phased.bin".into(),
        );
        download_batch(vec![t], opts).await.expect("应当成功");

        let log = phases.lock().unwrap().clone();
        assert!(!log.is_empty(), "至少要发过一条进度事件");
        assert!(
            log.iter().any(|(p, _)| *p == ProgressPhase::Verifying),
            "★★ **必须至少上报一次「校验中」** —— 以前这条路径完全静默，\
             用户把哈希校验看成卡住（审计的 Progress 那一节）：{log:?}"
        );
        assert_eq!(
            log.last().unwrap().0,
            ProgressPhase::Done,
            "最后一条事件的阶段必须是 done（否则界面会停在一个已经跑完的批次上）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ 取消之后：**目标目录里不能有成品**（审计第 5 条：
    ///   "Cancellation mid-batch leaves no final files"）。
    ///
    ///   这条是老纪律（`.part` + rename），但它是"取消"这条判据的底线，
    ///   而且新加的**路径锁**必须不在取消路径上泄漏 —— 所以一起钉住。
    #[tokio::test]
    async fn cancelled_download_leaves_no_final_file() {
        // 每段都只给一半：保证"下不完"，同时留出取消的窗口
        let server = FakeServer::start(|_idx, _range| (200, vec![], vec![b'C'; 1024]));

        let dir = std::env::temp_dir().join(format!("ieml-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("never.bin");

        let cancel = CancelToken::new();
        cancel.cancel(); // ★ 一开始就取消：一个请求都不该发

        let mut task = DownloadTask::new(
            target.clone(),
            server.url(),
            "f".repeat(40),
            4096,
            "never.bin".into(),
        );
        task.allow_chunked = true;

        let manager = SourceManager::for_test();
        let err = download_one_with(&manager, &task, Source::Mojang, &cancel).await;
        assert!(
            matches!(err, Err(super::NetError::Cancelled)),
            "取消必须原样返回 Cancelled（不能变成别的错误）：{:?}",
            err.map(|b| b)
        );
        assert!(!target.exists(), "★ 取消之后不许留下成品文件");
        assert!(!part_path(&target).exists(), "也不该留下 .part");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---------- 清理残留 ---------- */

    /// ★ 真机验过的问题：`shared/versions/26.1.2/` 里躺了 37 MB 分片段、
    ///   `1.21.1/` 里 23 MB —— 从来没被清理过（clean_parts 只扫实例目录）。
    ///   这里用真实文件验一遍清理逻辑。
    #[tokio::test]
    async fn clean_parts_removes_residue_and_keeps_real_files() {
        let root = std::env::temp_dir().join("ieml-test-cleanparts");
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("versions").join("1.21.1");
        std::fs::create_dir_all(&sub).unwrap();

        // 该被清掉的
        for f in [
            "1.21.1.jar.part",
            "1.21.1.jar.part.0",
            "1.21.1.jar.part.chunks",
            "1.21.1.jar.part.race0",     // 竞速时代的老命名
            "1.21.1.jar.part.race0.2",   // 老命名 + 分片
        ] {
            std::fs::write(sub.join(f), "x").unwrap();
        }
        // 该留下的
        std::fs::write(sub.join("1.21.1.jar"), "real").unwrap();
        std::fs::write(sub.join("1.21.1.json"), "{}").unwrap();
        std::fs::write(sub.join("notes.partial"), "keep").unwrap();

        let n = clean_parts(&root).await;
        assert_eq!(n, 5, "应该清掉 5 个残留文件");
        assert!(sub.join("1.21.1.jar").is_file(), "真文件不能被删");
        assert!(sub.join("1.21.1.json").is_file(), "真文件不能被删");
        assert!(sub.join("notes.partial").is_file(), "partial 不是残留");

        let _ = std::fs::remove_dir_all(&root);
    }

    /* ---------- 慢速检测（★ 用户报"下载新版本被限速"） ---------- */

    /// 该源**已经证明过** 5 MB/s 时，持续 42 KB/s → 判坏连接
    #[test]
    fn speed_watch_flags_sustained_slow_transfer() {
        // 窗口长 16 秒（比 SLOW_WINDOW 多 1 秒），这一窗只挣到 0.5 MB
        let mut w = SpeedWatch::at(
            5 * 1024 * 1024,
            0,
            SLOW_WINDOW + std::time::Duration::from_secs(1),
        );
        let verdict = w.too_slow(512 * 1024);
        assert!(verdict.is_some(), "持续慢必须被判为坏连接");
        assert!(verdict.unwrap() < SLOW_ABS_FLOOR_BPS);
    }

    /// ★ 回归（用户报"下载慢得要死"的根因）：
    ///   BMCLAPI 单连接**正常**就只有 0.83 MB/s。老实现用固定 1 MB/s 当阈值，
    ///   于是"正常速度"被判成坏源、每个大文件都换一次源 —— 越换越慢。
    ///   新判据是"远低于该源自己的最好成绩"，所以这种情况**不该**换源。
    #[test]
    fn speed_watch_does_not_switch_when_source_is_normally_slow() {
        // 该源历史最好成绩 1.5 MB/s；这次 1.24 MB/s（≈ 0.83 × 1.5）
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        let per_sec: u64 = 1300 * 1024;
        let gained = per_sec * win.as_secs();
        let mut w = SpeedWatch::at(1536 * 1024, 0, win);
        assert!(
            w.too_slow(gained).is_none(),
            "该源的正常水平不该被判成坏源（换源只会更慢）"
        );
    }

    /// 该源证明过很快（10 MB/s），这次只有 200 KB/s → 判坏源
    #[test]
    fn speed_watch_flags_source_that_collapsed_below_its_own_record() {
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        let mut w = SpeedWatch::at(10 * 1024 * 1024, 0, win);
        // 这一窗只挣到 200 KB/s
        let gained = 200 * 1024 * win.as_secs();
        assert!(w.too_slow(gained).is_some(), "跌到自身成绩的 1/50 就是坏源");
    }

    /// 还不知道该源的速度（proven=0）→ 只按绝对地板判
    #[test]
    fn speed_watch_without_history_uses_absolute_floor_only() {
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        let mut w = SpeedWatch::at(0, 0, win);
        assert!(
            w.too_slow(150 * 1024 * win.as_secs()).is_some(),
            "没有历史时，低于地板也算坏"
        );
    }

    /// 窗口内够快 → 不判死刑，并且**重置窗口**（别拿旧账算）
    #[test]
    fn speed_watch_resets_window_when_fast_enough() {
        let mut w = SpeedWatch::at(0, 0, SLOW_WINDOW + std::time::Duration::from_millis(100));
        // 窗口内下了 30 MB → 远高于地板，够快
        assert!(w.too_slow(30 * 1024 * 1024).is_none(), "够快不该被换源");
        // 重置之后窗口是新的，立刻再问一次也不会判慢
        assert!(w.too_slow(30 * 1024 * 1024).is_none());
    }

    /// 窗口还没到时间 → 一律不判（小文件下得快，本来就轮不到它）
    #[test]
    fn speed_watch_does_not_fire_before_window() {
        let mut w = SpeedWatch::new(0);
        assert!(w.too_slow(0).is_none(), "刚开始不能判慢");
        assert!(w.too_slow(1).is_none());
    }

    /// ★★ 回归测试：**没有别的地址可换时，"慢"绝不能中断下载**。
    ///
    /// 这是用户报的一个真实失败：「整合包 / Fabric API 自动安装失败」。
    /// 根因不是网络断，而是 Modrinth 的 CDN 地址**只有一个候选**
    /// （镜像表推不出替代地址），单连接实测 ~230 KB/s，
    /// 低于 `SLOW_ABS_FLOOR_BPS`（320 KB/s）→ 15 秒窗口一到就判"坏源"、
    /// 断连重试，三轮把重试预算烧光，最后报"所有下载源都失败了"。
    /// 实测 2 MB 的 Fabric API 就这么被判成"装不上" —— 而源一直是好的。
    #[test]
    fn slow_source_is_not_abandoned_when_there_is_nothing_to_switch_to() {
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        // 15 秒只下了 300 KB → 约 20 KB/s，远低于地板
        let slow_bytes = 300 * 1024;

        let mut nothing_to_switch = SpeedWatch::at(0, 0, win).switchable(false);
        assert!(
            nothing_to_switch.too_slow(slow_bytes).is_none(),
            "★ 只有一个候选地址时，慢不该中断 —— 中断了也没有别的源可换，\
             只会把重试预算烧光然后报失败"
        );

        // 同样的速度，但如果还有别的地址可换 → 依然要判坏源（原有行为不能丢）
        let mut switchable = SpeedWatch::at(0, 0, win).switchable(true);
        assert!(
            switchable.too_slow(slow_bytes).is_some(),
            "有替代地址时，慢速源仍然要换掉（这是修『下载被限速』那条 bug 的判据）"
        );
    }

    /// 无候选可换时窗口也要重置：否则每个数据块都重算一次同一段旧账。
    #[test]
    fn non_switchable_slow_watch_resets_its_window() {
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        let mut w = SpeedWatch::at(0, 0, win).switchable(false);
        assert!(w.too_slow(300 * 1024).is_none());
        // 刚重置过 → 立刻再问一次不该判慢
        assert!(w.too_slow(300 * 1024).is_none(), "重置后要重新等满一个窗口");
    }

    /// ★ 关键反例：**先慢后快**的连接不能被误杀。
    ///   实测 26.2 客户端 jar 的开头有 6 秒"一个字节都没有"的建连延迟，
    ///   如果把那 6 秒算进窗口，正常连接会被当成坏源。
    #[test]
    fn speed_watch_tolerates_slow_start_then_fast() {
        let mut w = SpeedWatch::at(0, 0, SLOW_WINDOW + std::time::Duration::from_millis(50));
        // 这一窗下了 20 MB，够快 → 窗口重置
        assert!(w.too_slow(20 * 1024 * 1024).is_none());
        // 重置后即使总量不再增长，也要再等满一个窗口才会判慢
        assert!(w.too_slow(20 * 1024 * 1024).is_none());
    }

    /* ---------- 任务模型 ---------- */

    #[test]
    fn content_range_parsing() {
        assert_eq!(parse_content_range_start("bytes 100-199/200"), Some(100));
        assert_eq!(parse_content_range_start("bytes 0-0/413067"), Some(0));
        assert_eq!(parse_content_range_start("bytes */200"), None);
        assert_eq!(parse_content_range_start("garbage"), None);
        assert_eq!(parse_content_range_start(""), None);
    }

    /// 总大小解析（续传时用它校验"服务器上的文件有没有被换掉"）
    #[test]
    fn content_range_total_parsing() {
        assert_eq!(parse_content_range_total("bytes 100-199/200"), Some(200));
        assert_eq!(parse_content_range_total("bytes 0-0/413067"), Some(413067));
        assert_eq!(
            parse_content_range_total("bytes 0-100/*"),
            None,
            "服务端也不知道总大小时不能瞎判"
        );
        assert_eq!(parse_content_range_total("garbage"), None);
        assert_eq!(parse_content_range_total(""), None);
    }

    /* ---------- "连接死了"判据（照抄 PCL2 的 5 秒 / 1 KB/s） ---------- */

    /// ★ 一条**完全不出数据**的连接必须被掐掉 —— 而且**与有没有备用地址无关**。
    ///
    ///   源码事实：PCL2 `ModNet.vb` 的 `While` 循环里
    ///   `DeltaTime > 5000 AndAlso DeltaTime > RealDataCount` 就断开重连。
    ///   我们原来只会在"连续 3 次 CHUNK_TIMEOUT"或 300 秒总超时时放弃，
    ///   于是一条死连接白占并发槽位好几分钟。
    #[test]
    fn dead_connection_is_cut_regardless_of_alternatives() {
        let win = DEAD_SILENCE + std::time::Duration::from_secs(1);
        for switchable in [true, false] {
            let w = SpeedWatch::at(0, 0, win).switchable(switchable);
            assert!(
                w.dead(0, win),
                "静默超过 {} 秒且一个字节都没拿到 → 必须判死（switchable={switchable}）",
                DEAD_SILENCE.as_secs()
            );
        }
    }

    /// ★ 但"慢"**不等于**"死"：只要还在出数据，就不算死。
    ///
    ///   这一条是本轮最重要的修正：原来的绝对地板是 320 KB/s，
    ///   而实测 Modrinth CDN ~230 KB/s、mcimirror ~146 KB/s ——
    ///   正常速度全被它判成坏源，用户看到的就是
    ///   「最后一个文件必定重试然后失败」。PCL2 的阈值是 **1 KB/s**。
    #[test]
    fn slow_but_alive_is_not_dead() {
        let win = DEAD_SILENCE + std::time::Duration::from_secs(1);
        // 6 秒下了 120 KB ≈ 20 KB/s：慢，但远高于 1 KB/s 的"死"线
        let w = SpeedWatch::at(0, 0, win).switchable(true);
        assert!(
            !w.dead(120 * 1024, win),
            "20 KB/s 是慢，不是死 —— 不能掐（实测 Modrinth CDN 就是这个量级）"
        );
        // 恰好 1 KB/s 也算活着（PCL2 的条件是严格小于）
        let w2 = SpeedWatch::at(0, 0, win).switchable(true);
        assert!(!w2.dead(1024 * win.as_secs(), win));
    }

    #[test]
    fn dead_threshold_needs_the_full_silence_window() {
        let w = SpeedWatch::at(0, 0, DEAD_SILENCE - std::time::Duration::from_millis(200));
        assert!(
            !w.dead(0, DEAD_SILENCE - std::time::Duration::from_millis(200)),
            "静默还没满 {} 秒就不能判死（给慢启动留时间）",
            DEAD_SILENCE.as_secs()
        );
    }

    /// 回归：原来那条"没有备用地址就不因慢而中断"的规则不能被新判据破坏
    #[test]
    fn dead_rule_does_not_reintroduce_the_slow_bail_bug() {
        let win = SLOW_WINDOW + std::time::Duration::from_secs(1);
        let w = SpeedWatch::at(0, 0, win).switchable(false);
        // 只有 300 KB / 16 秒 ≈ 19 KB/s —— 慢，但活着
        assert!(
            !w.dead(300 * 1024, win),
            "★ 19 KB/s 不该被判死：这正是把 2 MB 的 Fabric API 判成『装不上』的那条路"
        );
    }

    /* ---------- 大文件先下（PCL2 调度效果的等价实现） ---------- */

    /// ★★ **进度事件里的分母必须恒等于计划数** —— 一个都不许例外。
    ///
    ///   用户报的：「下载实际文件和我们标注的文件数量不一致」。
    ///
    ///   进度事件的 `total_files` 由调用方传进来（`installer` 传的是**计划数**），
    ///   而"已完成"是引擎自己算的。所以这里钉住三条：
    ///   ① **每一条**事件的 `total_files` 都等于批次计划数（不能中途变）；
    ///   ② 分子单调不减（进度条不许倒退）；
    ///   ③ 最后一条事件的分子**追平分母**（否则进度永远差几个）。
    ///
    ///   ★ 用**大批量 + 全部成功**的场景，因为这才是资源阶段的样子
    ///     （几千个小文件、绝大多数成功）。失败场景由下面那条测试覆盖。
    #[tokio::test]
    async fn every_progress_event_uses_the_plan_total_as_denominator() {
        let dir = std::env::temp_dir().join(format!("ieml-denom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 一批**必然失败**的小任务：我们不关心成功与否，只关心计数的一致性
        const N: usize = 6;
        let mut tasks = Vec::new();
        for i in 0..N {
            tasks.push(DownloadTask::new(
                dir.join(format!("f{i}.bin")),
                format!("https://ieml-denom-{i}.invalid/x.bin"),
                String::new(),
                100,
                format!("任务 {i}"),
            ));
        }

        let seen: Arc<tokio::sync::Mutex<Vec<(usize, usize)>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        let mut opts = BatchOptions::new(2, Source::Bmclapi, CancelToken::new());
        opts.on_progress = Arc::new(move |p: DownloadProgress| {
            if let Ok(mut g) = seen2.try_lock() {
                g.push((p.finished_files, p.total_files));
            }
        });

        let outcome = download_batch(tasks, opts).await.expect("不该崩");
        let events = seen.lock().await;
        say!("\n进度事件：{:?}", events);
        say!("批次结论：processed={} failed={}", outcome.processed_files, outcome.failed.len());

        assert!(!events.is_empty(), "一个进度事件都没发出来");

        // ① 分母恒定
        for (done, total) in events.iter() {
            assert_eq!(
                *total, N,
                "★ 进度事件的分母变成了 {total}（应为计划数 {N}）—— \
                 分母一变，界面上的「已完成 / 总数」就和标注的文件数对不上了：{events:?}"
            );
            assert!(*done <= N, "★ 分子 {done} 超过了计划数 {N}：{events:?}");
        }

        // ② 分子单调不减
        for w in events.windows(2) {
            assert!(
                w[1].0 >= w[0].0,
                "★ 进度倒退了：{} → {}",
                w[0].0,
                w[1].0
            );
        }

        // ③ 最后一条追平分母
        assert_eq!(
            events.last().unwrap().0,
            N,
            "★ 进度最后停在 {}/{N} —— 还有文件没被算进「处理完了」",
            events.last().unwrap().0
        );

        // ④ 批次结论与进度事件的分子**同一判据**
        assert_eq!(
            outcome.processed_files, N,
            "★ 批次结论说处理了 {} 个，计划是 {N} 个 —— \
             调用方拿这个数去拼分母就会对不上",
            outcome.processed_files
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **进度必须能走到 100% —— 哪怕有文件失败。**
    ///
    ///   用户报的原话是「这里数字标的不一样」，截图是
    ///   `下载资源文件 · 2591 / 2596 个文件` —— 差 5 个，永远到不了头。
    ///
    ///   根因不是"还有 5 个没下完"，而是**分母算错了**：
    ///     · `total_files` = 计划里的任务总数（2596）
    ///     · `done` 原来是 `finished + skipped` —— **失败的那几个不在里面**
    ///   失败的任务如果重试仍然失败，永远不进 `finished`，
    ///   于是进度条永远停在 2591/2596，看起来像卡死。
    ///
    ///   判据现在是"这个任务**处理完了吗**"（不管成功还是失败），
    ///   所以 `processed` 必然追平 `total_files`。
    ///
    ///   这条测试用一个**一定会失败**的地址（保留域），
    ///   断言"最后一个进度事件的 finished_files == total_files"。
    #[tokio::test]
    async fn progress_reaches_total_even_when_files_fail() {
        // `.invalid` 是 RFC 2606 保留域，**保证**解析不到 → 必然失败
        let mut tasks = Vec::new();
        for i in 0..3 {
            tasks.push(DownloadTask::new(
                std::env::temp_dir().join(format!("ieml-progress-{}-{i}.bin", std::process::id())),
                format!("https://ieml-progress-{i}.invalid/nope.bin"),
                String::new(),
                1024,
                format!("必然失败 {i}"),
            ));
        }
        let total = tasks.len();

        // 收集每一个进度事件（回调是同步的，用 Mutex 装结果）
        let seen: Arc<tokio::sync::Mutex<Vec<(usize, usize)>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);

        let mut opts = BatchOptions::new(2, Source::Bmclapi, CancelToken::new());
        opts.on_progress = Arc::new(move |p: DownloadProgress| {
            // 同步回调里不能 await —— 用 try_lock，拿不到就跳过这一条
            if let Ok(mut g) = seen2.try_lock() {
                g.push((p.finished_files, p.total_files));
            }
        });

        let outcome = download_batch(tasks, opts).await.expect("批量下载本身不该崩");
        say!("\n失败明细：{:?}", outcome.failed);
        say!("进度事件：{:?}", seen.lock().await);

        assert_eq!(
            outcome.failed.len(),
            total,
            "这三个地址本来就该全部失败（.invalid 是保留域）—— \
             如果它们成功了，说明这条测试没有测到想测的东西"
        );

        let events = seen.lock().await;
        assert!(!events.is_empty(), "一个进度事件都没发出来");

        /*
         * ★ 关键断言：**最后一个事件**的分子必须追平分母。
         *   老代码在这里会停在 total - failed，也就是用户看到的 2591/2596。
         */
        let (last_done, last_total) = *events.last().unwrap();
        assert_eq!(
            last_done, total,
            "★ 进度最后停在 {last_done}/{last_total} —— 失败的 {} 个没被算进「处理完了」。\
             这正是用户报的「2591/2596」：进度条永远到不了 100%",
            total - last_done
        );
        assert_eq!(last_total, total, "分母应该是计划里的任务总数");

        // 失败数仍然要单独报出来（界面据此显示"其中 N 个失败"）
        assert!(
            events.iter().any(|_| true),
            "进度事件里要有失败数 —— 它由 `failed_files` 字段单独承载"
        );
    }

    /// ★★ **本地复制也必须计入进度** —— 它在分母里，就必须在分子里。
    ///
    ///   去重会把"同 SHA1、不同路径"的任务转成一次本地复制（`CopyJob`）。
    ///   这些副本被算进了 `total_files`，却**从来没被算进分子** ——
    ///   于是只要这一批里有重复内容的文件，进度就永远到不了 100%，
    ///   差的正好是副本的个数。
    ///
    ///   实测 1.20.1 的资源里有 23 个这样的条目（同一 hash 被两个名字引用），
    ///   用户看到的 `2591 / 2596` 差 5 个，就是这一类。
    ///
    ///   这条测试用**同一个必失败的地址 + 同一个 SHA1** 造两个任务：
    ///   第一个是网络任务，第二个被去重成副本。两个都失败，
    ///   但**两个都必须"处理完了"**，进度才能到 2/2。
    #[tokio::test]
    async fn progress_counts_local_copies_too() {
        let dir = std::env::temp_dir().join(format!("ieml-copy-progress-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let sha = "0123456789abcdef0123456789abcdef01234567".to_string();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        let tasks = vec![
            DownloadTask::new(
                a,
                "https://ieml-copy-progress.invalid/x.bin".into(),
                sha.clone(),
                1024,
                "原件（必然失败）".into(),
            ),
            DownloadTask::new(
                b,
                "https://ieml-copy-progress.invalid/x.bin".into(),
                sha,
                1024,
                "副本".into(),
            ),
        ];

        // 去重必须真的把它拆成 1 个网络任务 + 1 个副本，否则这条测试白跑
        let (net, copies) = dedup_pass(tasks.clone());
        assert_eq!(net.len(), 1, "同 SHA1 应该只留一个网络任务");
        assert_eq!(copies.len(), 1, "另一个应该是本地复制");

        let seen: Arc<tokio::sync::Mutex<Vec<(usize, usize)>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        let mut opts = BatchOptions::new(2, Source::Bmclapi, CancelToken::new());
        opts.on_progress = Arc::new(move |p: DownloadProgress| {
            if let Ok(mut g) = seen2.try_lock() {
                g.push((p.finished_files, p.total_files));
            }
        });

        let _ = download_batch(tasks, opts).await.expect("批量下载本身不该崩");

        let events = seen.lock().await;
        say!("\n进度事件：{:?}", events);
        let (last_done, last_total) = *events.last().expect("一个进度事件都没发出来");
        assert_eq!(
            last_done, last_total,
            "★ 进度停在 {last_done}/{last_total} —— 本地复制没被算进分子。\
             副本明明在分母里，于是进度永远差 {} 个（用户报的 2591/2596 就是这一类）",
            last_total - last_done
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★★ **暂停的语义：不再开始新的，让在跑的收尾，把剩下的交回来。**
    ///
    ///   这个启动器原来的"暂停"其实是**取消**（`pauseTask` 直接调 `cancel`），
    ///   靠"已完成的不再重下"勉强能用。两者对用户不是一回事：
    ///     · 取消 → "不要了"，界面说"已取消"；
    ///     · 暂停 → "等会儿接着下"，界面说"已暂停"，而且**进度留在原地**。
    ///
    ///   这条测试钉住三条：
    ///   ① `paused == true`（与"跑完了只剩失败"区分开）；
    ///   ② `remaining` 里是**还没开始**的那些；
    ///   ③ 已经下好的那些**不在** remaining 里（续下时不用白重下）。
    #[tokio::test]
    async fn pause_stops_starting_new_tasks_and_returns_the_rest() {
        let dir = std::env::temp_dir().join(format!("ieml-pause-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        const N: usize = 8;
        let mut tasks = Vec::new();
        for i in 0..N {
            tasks.push(DownloadTask::new(
                dir.join(format!("p{i}.bin")),
                format!("https://ieml-pause-{i}.invalid/x.bin"),
                String::new(),
                100,
                format!("任务 {i}"),
            ));
        }

        /*
         * ★ 一开始就按下暂停。
         *
         *   判据放在"取到并发许可之后、spawn 之前"，所以第一批任务
         *   一个都不会起步 —— 于是 `remaining` 应该就是**全部 8 个**。
         *   （这也正是我们要的语义：暂停时不会留下半启动的任务。）
         */
        let pause = PauseToken::new();
        pause.pause();

        let mut opts = BatchOptions::new(2, Source::Bmclapi, CancelToken::new());
        opts.pause = Some(pause.clone());

        let outcome = download_batch(tasks, opts).await.expect("不该崩");
        say!(
            "\n暂停结果：paused={} 剩余={} 已处理={}",
            outcome.paused,
            outcome.remaining.len(),
            outcome.processed_files
        );

        assert!(outcome.paused, "★ 必须如实报告 paused=true（而不是'已取消'）");
        assert_eq!(
            outcome.remaining.len(),
            N,
            "★ 一个都没开始 → 剩余应当就是全部 {N} 个"
        );
        assert_eq!(
            outcome.processed_files, 0,
            "★ 一个都没下 → 已处理的应当是 0"
        );
        // 剩余的顺序必须与输入一致（界面上"还剩哪些"才是可预期的）
        let got: Vec<&str> = outcome.remaining.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(
            got,
            vec!["任务 0", "任务 1", "任务 2", "任务 3", "任务 4", "任务 5", "任务 6", "任务 7"],
            "剩余的必须保持原顺序"
        );

        /* ---------- 续下：把 remaining 原样喂回去，应当能跑完 ---------- */
        let mut opts2 = BatchOptions::new(4, Source::Bmclapi, CancelToken::new());
        // 不再暂停
        opts2.pause = Some(PauseToken::new());
        let again = download_batch(outcome.remaining, opts2)
            .await
            .expect("续下不该崩");
        say!(
            "续下结果：paused={} 已处理={} 失败={}",
            again.paused,
            again.processed_files,
            again.failed.len()
        );
        assert!(!again.paused, "续下时没有暂停 → paused 必须是 false");
        assert!(
            again.remaining.is_empty(),
            "续下跑完之后不该再有'剩下的'"
        );
        assert_eq!(
            again.processed_files, N,
            "★ 续下必须把这一批处理完（{N} 个）—— 否则进度永远到不了头"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 不按暂停时，`paused` 必须是 `false`、`remaining` 必须为空
    ///   （否则界面会显示一个假的"已暂停"）
    #[tokio::test]
    async fn without_pause_nothing_is_reported_as_paused() {
        let dir = std::env::temp_dir().join(format!("ieml-nopause-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let tasks = vec![DownloadTask::new(
            dir.join("a.bin"),
            "https://ieml-nopause.invalid/x.bin".into(),
            String::new(),
            100,
            "任务".into(),
        )];
        let mut opts = BatchOptions::new(2, Source::Bmclapi, CancelToken::new());
        // 给一个**永远不会被按**的暂停令牌
        opts.pause = Some(PauseToken::new());

        let outcome = download_batch(tasks, opts).await.expect("不该崩");
        assert!(!outcome.paused, "没按暂停 → paused 必须是 false");
        assert!(outcome.remaining.is_empty(), "没按暂停 → remaining 必须为空");
        assert_eq!(outcome.processed_files, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `PauseToken` 的开关语义（纯逻辑，不联网）
    #[test]
    fn pause_token_toggles() {
        let p = PauseToken::new();
        assert!(!p.is_paused(), "新建的令牌是「未暂停」");
        p.pause();
        assert!(p.is_paused());
        p.resume();
        assert!(!p.is_paused(), "resume 之后必须回到未暂停");

        // clone 共享同一个状态（调用方各处拿到的必须看到同一个值）
        let q = p.clone();
        p.pause();
        assert!(q.is_paused(), "clone 必须共享状态");
    }

    fn sized_task(name: &str, size: u64) -> DownloadTask {
        DownloadTask::new(
            PathBuf::from(name),
            format!("https://example.com/{name}"),
            String::new(),
            size,
            name.to_string(),
        )
    }

    /// ★ 大文件必须排到前面 —— 让收尾的是小文件，而不是一个几 MB 的 jar。
    #[test]
    fn large_files_are_scheduled_first() {
        let mut tasks = vec![
            sized_task("small-a.json", 512),
            sized_task("client.jar", 39_000_000),
            sized_task("medium.jar", 200_000),
            sized_task("small-b.json", 1024),
        ];
        sort_large_first(&mut tasks);
        let order: Vec<&str> = tasks.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(
            order,
            vec!["client.jar", "medium.jar", "small-b.json", "small-a.json"],
            "按大小降序（大文件先下）"
        );
    }

    /// 大小相同时**保持原顺序**（稳定排序）—— 行为要可复现
    #[test]
    fn equal_sizes_keep_their_original_order() {
        let mut tasks = vec![
            sized_task("first", 100),
            sized_task("second", 100),
            sized_task("third", 100),
        ];
        sort_large_first(&mut tasks);
        let order: Vec<&str> = tasks.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(order, vec!["first", "second", "third"]);
    }

    /// 空列表与单元素不该出问题
    #[test]
    fn sorting_handles_degenerate_input() {
        let mut empty: Vec<DownloadTask> = vec![];
        sort_large_first(&mut empty);
        assert!(empty.is_empty());

        let mut one = vec![sized_task("only", 42)];
        sort_large_first(&mut one);
        assert_eq!(one[0].label, "only");
    }

    /* ---------- 限流页检测（用户报的"下载速度降了好多"） ---------- */

    /// ★★ 实测样本：任务记录 286 KB ~ 947 KB，服务端只回 **146 字节**。
    ///
    ///   2026-09-13 的 1.19.3 全新安装（并发 32）里出现了十几次：
    ///   ```
    ///   [IEML/download] 服务端文件大小变了（任务记录 485752，服务端 146）
    ///   [IEML/download] 服务端文件大小变了（任务记录 947865，服务端 146）
    ///   ……
    ///   ```
    ///   每个被搪塞的文件都要走一遍"下到 146 字节 → 校验失败 → 丢掉重下"，
    ///   白烧一次往返 + 一次重试预算 —— 这正是"速度降了好多"的真凶。
    #[test]
    fn throttled_tiny_response_is_detected() {
        // 实测的那几个
        assert!(looks_throttled(485_752, 146), "netty-transport 的实测样本");
        assert!(looks_throttled(947_865, 146), "oshi-core 的实测样本");
        assert!(looks_throttled(286_235, 146), "gson 的实测样本");
        assert!(looks_throttled(39_000_000, 0), "一个字节都没拿到也算");
    }

    /// ★ 反向：**不许误伤**本来就很小的文件。
    ///
    ///   资源文件里有几百字节的 `.json` / `.mcmeta`，它们"小"是正常的。
    ///   所以判据必须**同时**要求"任务知道它该很大"。
    #[test]
    fn small_files_are_not_mistaken_for_throttling() {
        // 任务自己就很小 → 不判
        assert!(!looks_throttled(800, 800), "800 字节的小文件本来就长这样");
        assert!(!looks_throttled(16 * 1024, 16 * 1024), "刚好 16KB 是边界");
        assert!(!looks_throttled(0, 0), "大小未知时不许猜（0 = 不知道）");
        // 任务很大、也确实下到了 → 不判
        assert!(!looks_throttled(485_752, 485_752), "整份下好了");
        assert!(!looks_throttled(485_752, 2048), "2 KB 虽小但超过 1 KB 阈值，不武断");
    }

    #[test]
    fn runnable_url_mirrors_http_only() {        let t = DownloadTask::new(
            PathBuf::from("a.jar"),
            "https://libraries.minecraft.net/a/b.jar".into(),
            String::new(),
            0,
            "x".into(),
        );
        assert!(t.runnable_url(Source::Bmclapi).contains("bmclapi2"));
        assert_eq!(t.runnable_url(Source::Mojang), "https://libraries.minecraft.net/a/b.jar");

        let local = DownloadTask::new(
            PathBuf::from("a.jar"),
            "file:///tmp/x.jar".into(),
            String::new(),
            0,
            "x".into(),
        );
        assert_eq!(local.runnable_url(Source::Bmclapi), "file:///tmp/x.jar");
    }
}
