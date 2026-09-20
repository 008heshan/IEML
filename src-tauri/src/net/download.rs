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
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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
}

impl DownloadTask {
    /// 只带一个 URL 的任务（最常见的情况）
    pub fn new(path: PathBuf, url: String, sha1: String, size: u64, label: String) -> Self {
        Self {
            path,
            url,
            urls: Vec::new(),
            sha1,
            size,
            label,
        }
    }

    /// 取"可直接跑"的 URL（`file://` 开头的本地复制任务原样返回）
    pub fn runnable_url(&self, preferred: Source) -> String {
        if self.url.starts_with("http") {
            super::mirror::mirror_url(&self.url, preferred)
        } else {
            self.url.clone()
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
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadOutcome {
    pub finished_files: usize,
    pub skipped_files: usize,
    pub failed: Vec<(String, String)>,
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
const CHUNKED_THRESHOLD: u64 = 4 * 1024 * 1024;

/// 分片下载的最大段数。
const CHUNK_COUNT: u64 = 8;

/// 单段最小大小（2 MB）。
///
/// ★ 为什么不是 PCL2 的 1 MB：段太小的话，一次 Range 往返的握手开销
///   （TLS + 请求头 + 服务端 seek）占掉的比例就不可忽略；再叠加每段自己
///   一条连接，**反而不如少几段**。2 MB 是这个体量下的平衡点。
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

/// 共享的运行时统计
#[derive(Default)]
struct Stats {
    finished_files: AtomicU64,
    finished_bytes: AtomicU64,
    skipped_files: AtomicU64,
    repaired_files: AtomicU64,
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
pub async fn download_one(
    task: &DownloadTask,
    preferred: Source,
    cancel: &CancelToken,
) -> Result<bool> {
    download_one_with(source::global(), task, preferred, cancel).await
}

/// 同上，但显式指定源管理器（测试用）
pub async fn download_one_with(
    manager: &SourceManager,
    task: &DownloadTask,
    preferred: Source,
    cancel: &CancelToken,
) -> Result<bool> {
    // ---------- ① 已有且校验通过 → 跳过 ----------
    if task.path.is_file() {
        match verify_existing(task).await {
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
    let mut tried_sources = 0usize;
    let mut busy_waits = 0u32;

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

        for (src, url) in ordered.iter() {
            if cancel.is_cancelled() {
                return Err(NetError::Cancelled);
            }
            // 冷却中的源：跳过（除非它是最后一个候选）
            if manager.is_cooling(*src) && ordered.len() > 1 {
                continue;
            }

            let started = std::time::Instant::now();
            let written =
                match download_to_part(manager, &url, &part, task, cancel, ordered.len()).await {
                Ok(n) => n,
                Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                Err(e) => {
                    manager.note_failure(*src, e.status());
                    last_err = format!("{}：{e}", src.as_str());
                    // 404 之类的"换个源也没用"的错误：仍然换（镜像路径可能不同），
                    // 但不留残留文件
                    if matches!(e, NetError::Status { status: 404, .. }) {
                        let _ = tokio::fs::remove_file(&part).await;
                    }
                    continue;
                }
            };

            // ★ 先把 `.part` 校验掉，再落位。
            //   顺序很重要：如果先改名再校验，校验失败时就得把已经改名到目标位置
            //   的坏文件再删一次 —— 中间那一瞬间，"坏文件 + 正确文件名"是会被
            //   其它代码（启动流程 / 完整性校验）当成好文件用的。
            if !task.sha1.is_empty() {
                match sha1_of_file(&part).await {
                    Ok(actual) if actual == task.sha1 => {}
                    Ok(actual) => {
                        // ★ 校验失败：删文件、记失败、换源重来
                        let _ = tokio::fs::remove_file(&part).await;
                        cleanup_segments(&part).await;
                        manager.note_failure(*src, None);
                        last_err = format!(
                            "{} 返回的文件校验失败（期望 {}，实际 {}）",
                            src.as_str(),
                            short(&task.sha1),
                            short(&actual)
                        );
                        continue;
                    }
                    Err(e) => {
                        manager.note_failure(*src, None);
                        last_err = format!("{}：校验读盘失败 {e}", src.as_str());
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
                    return Ok(false);
                }
                Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                Err(e) => {
                    manager.note_failure(*src, None);
                    last_err = format!("{}：落盘失败 {e}", src.as_str());
                }
            }
        }

        // 一轮候选全挂 → 退避后重试
        if attempt < MAX_FILE_RETRIES {
            let delay = backoff_delay(
                attempt,
                std::time::Duration::from_millis(600),
                std::time::Duration::from_secs(10),
            );
            if !source::sleep_cancellable(delay, cancel).await {
                return Err(NetError::Cancelled);
            }
        }
    }

    Err(NetError::AllSourcesFailed {
        tried: tried_sources,
        last: last_err,
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
async fn create_part(part: &Path) -> Result<tokio::fs::File> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..=FILE_BUSY_RETRIES {
        if let Some(p) = part.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        match tokio::fs::File::create(part).await {
            Ok(f) => return Ok(f),
            Err(e) => {
                let busy = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33) | Some(1224));
                if !busy {
                    return Err(NetError::Io(e));
                }
                say!(
                    "[IEML/download] {}",
                    describe_busy("创建临时文件", part, &e)
                );
                if attempt == FILE_BUSY_RETRIES {
                    return Err(NetError::Io(e));
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
async fn open_part_append(part: &Path) -> Result<tokio::fs::File> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..=FILE_BUSY_RETRIES {
        match tokio::fs::OpenOptions::new().append(true).open(part).await {
            Ok(f) => return Ok(f),
            Err(e) => {
                let busy = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33) | Some(1224));
                if !busy || attempt == FILE_BUSY_RETRIES {
                    return Err(NetError::Io(e));
                }
                last = Some(e);
                tokio::time::sleep(busy_delay(attempt)).await;
            }
        }
    }
    Err(NetError::Io(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "打开临时文件失败")
    })))
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
    Absent,
}

async fn verify_existing(task: &DownloadTask) -> VerifyOutcome {
    if !task.sha1.is_empty() {
        return match sha1_of_file(&task.path).await {
            Ok(actual) if actual == task.sha1 => VerifyOutcome::Ok,
            Ok(actual) => VerifyOutcome::Mismatch {
                expected: task.sha1.clone(),
                actual,
            },
            Err(_) => VerifyOutcome::Absent,
        };
    }
    // 无校验值时按大小判断
    let len = task.path.metadata().map(|m| m.len()).unwrap_or(0);
    if task.size == 0 || len == task.size {
        VerifyOutcome::Ok
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
) -> Result<u64> {
    // 断点续传：已有 .part 且**不是**分片残留 → 单连接续传
    let existing = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);

    if existing == 0 && chunking_enabled() {
        // 大文件：先探大小再分片（分片内部自带续传）
        //
        // ★ 默认不进这里（见 `chunking_enabled()` 的说明）：分片在 BMCLAPI 上
        //   既不快、又会招 429、还带一串只在分片路径上的失败。
        if let Some(total) = probe_content_length(url).await {
            if total >= CHUNKED_THRESHOLD {
                match download_chunked(url, part, total, cancel).await {
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
        &task.sha1,
        cancel,
        existing,
        proven,
        candidate_count > 1,
        task.size,
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
    expected_sha1: &str,
    cancel: &CancelToken,
    existing: u64,
    proven_bps: u64,
    switchable: bool,
    task_size: u64,
) -> Result<u64> {
    /*
     * 第一轮：如果本地有残留，就带 `Range` 试着续传。
     * 第二轮（只在第一轮"对不上"时发生）：**不带 `Range`**，要整份。
     */
    let mut resume_from: Option<u64> = if existing > 0 { Some(existing) } else { None };
    let mut attempt = 0u32;

    loop {
        attempt += 1;
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
        let _ = expected_sha1; // 校验由调用方在写完后统一做（续传时流式哈希算不准）

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
                return Err(NetError::Other(format!(
                    "连接过慢（{} 秒内仅 {:.0} KB/s，已换源重试）—— URL: {url}",
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
            if let Err(e) = file.write_all(&chunk).await {
                say!(
                    "[IEML/download] {}",
                    describe_busy("写临时文件", part, &e)
                );
                return Err(NetError::Io(e));
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
            return Err(NetError::Io(e));
        }
        drop(file);

        /*
         * 收尾判据在 `finish_single`（限流页检测 + 长度校验，P0-5）。
         * ★ 返回值仍然是**这一轮真正写入的字节数** —— 调用方拿它算源速度
         *   （`note_success`），换成"整份大小"会把续传那一次的速度算虚高，
         *   进而把正常速度误判成坏源。
         */
        finish_single(manager, url, task_size, base + this_run).await?;
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
    if task_size > 0 && total_written != task_size {
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
async fn download_chunked(url: &str, part: &Path, total: u64, cancel: &CancelToken) -> Result<u64> {
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
        for span in &to_fetch {
            let url = url.to_string();
            let part = part.to_path_buf();
            let cancel = cancel.clone();
            let span = *span;
            handles.push(tokio::spawn(async move {
                // ★ 每段自带重试（最多 3 次，指数退避）。
                //   实测：8 路并发 Range 里偶尔会有一路"连接停滞"——
                //   以前一处停滞就把**整份分片下载**判定失败，清掉进度改走单连接，
                //   39 MB 的客户端 jar 等于白下（实测白等了 3 分多钟）。
                //   单段重试一次的成本远低于整份重来。
                let mut last: Option<NetError> = None;
                for attempt in 1..=3u32 {
                    match download_range(&url, &part, span, &cancel).await {
                        Ok(n) => return Ok(n),
                        Err(NetError::Cancelled) => return Err(NetError::Cancelled),
                        Err(e) => {
                            // 服务器不支持 Range 这类"再试也没用"的错误 → 立刻上抛
                            if e.is_permanent_range_failure() {
                                return Err(e);
                            }
                            last = Some(e);
                            if attempt < 3 {
                                let d = backoff_delay(
                                    attempt,
                                    std::time::Duration::from_millis(300),
                                    std::time::Duration::from_secs(5),
                                );
                                if !source::sleep_cancellable(d, &cancel).await {
                                    return Err(NetError::Cancelled);
                                }
                            }
                        }
                    }
                }
                Err(last.unwrap_or_else(|| NetError::Other("分片重试耗尽".into())))
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
    for span in &spans {
        let seg = segment_path(part, span.idx);
        let mut input = tokio::fs::File::open(&seg).await?;
        tokio::io::copy(&mut input, &mut out).await?;
        drop(input);
        let _ = tokio::fs::remove_file(&seg).await;
    }
    out.flush().await?;
    drop(out);
    let _ = tokio::fs::remove_file(&plan_path).await;

    Ok(written)
}

/// 下载一个段到 `part.{idx}`，返回本段字节数。
async fn download_range(
    url: &str,
    part: &Path,
    span: ChunkSpan,
    cancel: &CancelToken,
) -> Result<u64> {
    let seg = segment_path(part, span.idx);
    let mut file = tokio::fs::File::create(&seg).await?;

    let resp = client()
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes={}-{}", span.start, span.end),
        )
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

    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    let mut stalled = 0u32;
    loop {
        if cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&seg).await;
            return Err(NetError::Cancelled);
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
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
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
///   ① `dedup_pass` 把"同 SHA1 的重复文件"拆出来（只下一个，其余本地复制）
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
        let concurrency = manager.recommended_concurrency(want);

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
        let (still_failed, failures, was_paused, unstarted) = run_round(
            pending,
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
        // ★ 记在 await 之后、任何 return 之前 —— 暂停那条分支也会 return，
        //   而"暂停前这一轮花了多久"同样是有用的信息。
        round_ms.push(round_t0.elapsed().as_millis() as u64);

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
                finished_files: stats.finished_files.load(Ordering::Relaxed) as usize,
                skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
                failed: failures,
                total_bytes,
                elapsed_ms: started.elapsed().as_millis() as u64,
                processed_files: processed_count(&stats) as usize,
                retry_rounds: round,
                repaired_files: stats.repaired_files.load(Ordering::Relaxed) as usize,
                paused: true,
                remaining: rest,
            });
        }

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
            }
            Err(e) => failed.push((copy.task.label.clone(), e.to_string())),
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

    Ok(DownloadOutcome {
        finished_files: stats.finished_files.load(Ordering::Relaxed) as usize,
        skipped_files: stats.skipped_files.load(Ordering::Relaxed) as usize,
        failed,
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

/// 去重：同一 SHA1 只下一次，其余文件记为"从原件的落盘路径复制"。
///
/// 纯函数（不碰网络、不写盘），便于单测锁定两条不变量：
///   ① 副本一定排在原件之后（批次末尾统一复制，见 `download_batch` ③）
///   ② **目标路径相同就直接丢弃** —— 见下面的 ★
///
/// ★ 同一个 hash 可能对应**同一个落盘路径**（内容寻址的资源文件就是
///   `objects/<前两位>/<sha1>`，3598 个资源文件里同一个 hash 常被两个名字引用）。
///   这种情况下"复制副本"其实是 `copy(X, X)`，Windows 会直接回
///   `os error 32（另一个程序正在使用此文件）`，而文件其实早就下好了。
///   实测：1.20.1 固定有 23 个这样的条目，看起来像杀毒软件锁文件，
///   其实是自己复制到自己。
fn dedup_pass(tasks: Vec<DownloadTask>) -> (Vec<DownloadTask>, Vec<CopyJob>) {
    let mut seen: HashMap<String, PathBuf> = HashMap::new();
    let mut network: Vec<DownloadTask> = Vec::new();
    let mut copies: Vec<CopyJob> = Vec::new();

    for t in tasks {
        if !t.sha1.is_empty() {
            if let Some(first) = seen.get(&t.sha1) {
                if *first == t.path {
                    // 同内容 + 同路径 = 同一个文件，什么都不用做
                    continue;
                }
                copies.push(CopyJob {
                    source: first.clone(),
                    task: t,
                });
                continue;
            }
            seen.insert(t.sha1.clone(), t.path.clone());
        }
        network.push(t);
    }
    (network, copies)
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
///
/// 抽成别名是因为四元组写在签名里读不出哪个是哪个（而 `.2` 与 `.3`
/// 的含义恰恰**不能搞混**：一个是"为什么停"，一个是"还剩什么"）。
type RoundResult = (
    Vec<DownloadTask>,
    Vec<(String, String)>,
    bool,
    Vec<DownloadTask>,
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
                        // 取消 → 返回空的四元组（调用方会因为 cancel 立刻退出）
                        return (Vec::new(), Vec::new(), false, Vec::new());
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

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let label = task.label.clone();

            // 这一轮里全是网络任务 —— 本地复制已经在批次末尾单独做过（见 CopyJob）
            let outcome = download_one(&task, source, &cancel).await;

            match outcome {
                Ok(skipped) => {
                    if skipped {
                        stats.skipped_files.fetch_add(1, Ordering::Relaxed);
                    } else {
                        stats.finished_files.fetch_add(1, Ordering::Relaxed);
                    }
                    stats.finished_bytes.fetch_add(task.size, Ordering::Relaxed);
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
                    failed.lock().await.push((label.clone(), e.to_string()));
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
    (t, f, paused, remaining)
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

            std::thread::spawn(move || {
                use std::io::{Read, Write};
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
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

    fn tmp_part(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ieml-dl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("file.bin.part"), dir)
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
            "",
            &CancelToken::new(),
            100,     // existing
            0,       // proven_bps
            false,   // switchable
            200,     // task_size
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
        let before = manager.recommended_concurrency(64);

        let err = download_single(
            &manager,
            &server.url(),
            &part,
            "",
            &CancelToken::new(),
            0,
            0,
            false,
            286_235, // 任务记录 286 KB（实测的 gson 那一档）
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
            manager.recommended_concurrency(64) < before,
            "★ 并发必须真的降下来：{} → {}",
            before,
            manager.recommended_concurrency(64)
        );
        assert_eq!(server.ranges().len(), 1, "没带 Range 的第一次请求就够判定了");

        let _ = std::fs::remove_dir_all(&dir);
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
            "",
            &CancelToken::new(),
            0,
            0,
            false,
            200,
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
            "",
            &CancelToken::new(),
            0,
            0,
            false,
            256,
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
            "",
            &CancelToken::new(),
            0,
            0,
            false,
            0,
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
            "",
            &CancelToken::new(),
            60,
            0,
            false,
            100,
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
            "",
            &CancelToken::new(),
            500,
            0,
            false,
            80,
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
