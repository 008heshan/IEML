//! 网络层：HTTP 客户端 + 下载引擎 + 镜像表 + 源管理
//!
//! 设计要点：
//!   * 单一 `reqwest::Client` 复用连接池（每次新建客户端会丢掉 keep-alive，
//!     下载 3000+ 个资源文件时差别很大）
//!   * 下载**流式写盘**，不在内存里攒整个文件（客户端 jar 22 MB、
//!     整合包资源更大）
//!   * SHA1 **边下边算**，避免二次读盘
//!   * 支持断点续传（`.part` 临时文件 + Range 请求）
//!   * **分片下载也能续传**：每段独立落盘（`.part.N`）+ 段位图，断网重来只补缺的段
//!   * **源管理**（`source.rs`）：候选源生成、动态优先级、健康统计、429 指数退避

pub mod adoptium;
/// ★★ CurseForge API 客户端（ADR-052）：搜索 / 文件 / 指纹 / 下载候选
pub mod curseforge;
pub mod download;
pub mod installer;
pub mod liteloader;
pub mod metadata;
pub mod mirror;
pub mod optifine;
/// ★★ 启动期源延迟探测：给「国内优先」的静态序补上**实测**依据
pub mod probe;
pub mod source;

use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 全局 HTTP 客户端。首次调用时初始化。
/// 给**接口/元数据**请求用的客户端：**带整体超时**。
///
/// ★★ 2026-09-22 真机踩到：Modrinth 那次"连得上但不回数据"，
///   而 `client()` **只有连接超时、没有整体超时**（下载故意不设 —— 大文件要很久）——
///   于是资源列表**永远停在骨架屏**：没有报错、没有重试按钮，
///   用户只会以为是我们坏了。**卡住比报错更难查**，所以接口类请求必须有整体超时。
///
/// ★ 25 秒的取法：正常接口响应在 1 秒内，25 秒足够容忍上游抖动，
///   又不至于让用户对着转圈等到放弃。
pub fn api_client() -> &'static reqwest::Client {
    API_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("IEML-Launcher/0.1 (+https://github.com/ieml)")
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(25))
            .pool_max_idle_per_host(8)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .gzip(true)
            .build()
            .expect("无法创建 HTTP 客户端")
    })
}

static API_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("IEML-Launcher/0.1 (+https://github.com/ieml)")
            .connect_timeout(Duration::from_secs(20))
            // 不设整体超时：大文件下载需要很久
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .gzip(true)
            .build()
            .expect("无法创建 HTTP 客户端")
    })
}

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("网络请求失败：{0}")]
    Http(#[from] reqwest::Error),
    #[error("写入文件失败：{0}")]
    Io(#[from] std::io::Error),
    /// HTTP 状态码错误（**必须带上状态码**，否则上层无法区分
    /// 429 限流 / 503 服务不可用 / 404 不存在 —— 三者的处理方式完全不同）
    #[error("HTTP {status}：{url}")]
    Status { status: u16, url: String },
    /// 服务器不支持 Range 分片（对 Range 请求回了非 206）。
    ///
    /// 独立成一个变体是为了让上层**立刻**回退单连接 ——
    /// 这不是"重试就会好"的错误，退避三轮只是白等。
    #[error("服务器不支持 Range 分片（HTTP {status}）：{url}")]
    RangeUnsupported { status: u16, url: String },
    #[error("所有下载源都失败了（试过 {tried} 个）：{last}")]
    AllSourcesFailed { tried: usize, last: String },
    #[error("校验失败：期望 SHA1 {expected}，实际 {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("任务被取消")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

impl NetError {
    /// HTTP 状态码（网络层错误为 None）
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            Self::RangeUnsupported { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// 是不是"再重试也没用"的分片错误（服务器根本不支持 Range）
    pub fn is_permanent_range_failure(&self) -> bool {
        matches!(self, Self::RangeUnsupported { .. })
    }

    /// 本地文件被别的进程占着（Windows 的 os error 32 等），等一会儿就能好。
    ///
    /// ★ 实测踩过：3598 个资源文件里有 23 个 `.ogg` 报
    ///   `写入文件失败：另一个程序正在使用此文件，进程无法访问。(os error 32)` ——
    ///   几乎可以肯定是杀毒软件/索引服务在扫刚落盘的文件。
    ///   这种错误**重试同样的动作、但间隔足够长**就能过；
    ///   当时按"普通 IO 错误"处理，3 轮补下没留等待时间，23 个文件一直失败。
    ///
    /// Windows 上把这几个码都算进来：
    ///   5 = ACCESS_DENIED · 32 = SHARING_VIOLATION ·
    ///   33 = LOCK_VIOLATION · 1224 = USER_MAPPED_FILE
    pub fn is_file_busy(&self) -> bool {
        match self {
            Self::Io(e) => matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33) | Some(1224)),
            _ => false,
        }
    }

    /// 是否需要换源（限流 / 服务不可用 / 5xx / 网络层错误 / 超时都要换）
    pub fn should_switch_source(&self) -> bool {
        match self.status() {
            // 404 / 403 这种换源也没用（除非是不同源上路径确实不同，那由候选列表兜）
            Some(s) => s == 429 || s == 503 || s == 502 || s == 504 || s >= 500,
            None => !matches!(self, Self::Cancelled),
        }
    }

    /// 是否是"重试有意义"的错误（取消不算）
    pub fn is_retryable(&self) -> bool {
        !matches!(self, Self::Cancelled)
    }
}

pub type Result<T> = std::result::Result<T, NetError>;

/// 带重试的 GET（返回文本）。用于元数据接口 —— 它们小且必须成功。
///
/// ★ 每次返回状态码错误时**先看是不是 429**：限流要退避，不能立刻重试
///   （立刻重试只会再吃一次 429，把冷却时间越推越长）。
///
/// ★★ 4xx **立即返回 `NetError::Status`，不再退避重试**（用户报"查询太慢"的根因之一）：
///   `404 / 400 / 410` 的语义是"这个资源不存在"，重试同一个 URL 永远不会变好。
///   实测：给不存在的版本（1.12.2 的 Fabric / Quilt）各退避重试三轮，
///   一个 MC 版本要多等 20~30 秒 —— 而结论其实第一轮就拿到了。
///   现在一次 4xx 就返回，并且**带上状态码**，调用方据此分辨
///   「确认没有」与「没查到」—— 这正是 ADR-037 要的区分。
pub async fn get_text(url: &str) -> Result<String> {
    get_text_with_headers(url, &[]).await
}

/// 同上，但可以带请求头（CurseForge 要 `x-api-key`）。
///
/// ★ 只保留**一份**实现：`get_text` 就是"没有额外头"的那次调用。
///   三段式超时、429 退避、4xx 立刻返回这套判据写在两处必然漂移（ADR-051）。
pub async fn get_text_with_headers(url: &str, headers: &[(&str, &str)]) -> Result<String> {
    let mut last_err: String = String::new();
    for attempt in 0..3u32 {
        /*
         * ★★ 三段式超时（源码事实：PCL2 的 `NetRequestByClientRetry`）。
         *
         * PCL2 第 1 次用 **10 秒**、第 2 次用 **30 秒**、第 3 次用 **4 秒**
         * （且第 3 次只在"前两次合计超过 5.5 秒"时才做）：
         * 思路是**快速失败**——不行的源 10 秒就让位，行的源第二次给足 30 秒。
         *
         * 我们原来没有任何单次超时（靠外层 20~75 秒兜），于是一个挂住的源
         * 会把**每一次**尝试都拖满。这里按同样的思路给单次请求加超时：
         *   第 1 次 10 秒（快速失败）→ 第 2 次 30 秒（给慢源机会）→ 第 3 次 10 秒。
         *
         * ★ 这三段**只包住"拿到响应体"**，不长于外层的 `with_timeout_secs`
         *   （20 秒），所以外层仍然是最坏情况的兜底。
         */
        let per_try_secs = match attempt {
            0 => 10u64,
            1 => 30,
            _ => 10,
        };
        let send = tokio::time::timeout(Duration::from_secs(per_try_secs), async {
            let mut req = client().get(url);
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let resp = req.send().await?;
            let status = resp.status();
            if !status.is_success() {
                return Ok::<_, NetError>(Err((status, String::new())));
            }
            match resp.text().await {
                Ok(t) => Ok(Ok(t)),
                Err(e) => Ok(Err((status, e.to_string()))),
            }
        })
        .await;

        match send {
            // 单次超时 → 退避后重试（下一轮超时更长）
            Err(_) => {
                last_err = format!("请求 {url} 超过 {per_try_secs} 秒没有回应");
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))).await;
                }
            }
            Ok(Err(e)) => {
                last_err = e.to_string();
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                }
            }
            Ok(Ok(Ok(text))) => return Ok(text),
            Ok(Ok(Err((status, body_err)))) => {
                let code = status.as_u16();
                if !body_err.is_empty() {
                    last_err = body_err;
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                    }
                    continue;
                }
                // 429 与 5xx：等服务端缓过来再试（指数退避）
                let retryable = code == 429 || status.is_server_error();
                if !retryable {
                    // 4xx（404/400/403/410）：确定的失败，立刻返回**带状态码**
                    return Err(NetError::Status {
                        status: code,
                        url: url.to_string(),
                    });
                }
                last_err = format!("HTTP {status} 来自 {url}");
                let wait = if code == 429 {
                    /*
                     * ★★ 429 要**等久一点**（源码事实：PCL2 `NetRequestByClientRetry`
                     *   里对 429 是 `Thread.Sleep(10000)`）。
                     *
                     *   我们原来只等 0.5s / 1s —— 而 429 的语义是
                     *   "你请求太快了"，立刻重试只会再吃一次 429，
                     *   把冷却时间越推越长（服务端会记着你）。
                     *   10 秒是 PCL2 实测过的值。
                     */
                    Duration::from_secs(10)
                } else {
                    Duration::from_millis(300 * (1 << attempt))
                };
                tokio::time::sleep(wait).await;
            }
        }
    }
    Err(NetError::Other(last_err))
}

/// 这个错误是不是"**服务端明确说这个资源不存在**"？
///
/// 用来把 `404 / 400 / 410` 与"没查到"分开（ADR-037）：
///   前者是**确定的结论**（该版本没有这个加载器），后者只能说"重试"。
///
/// 为什么把 400 也算进来：Fabric 的 meta 对不支持的 MC 版本返回的是
/// **400 Bad Request**（实测 1.12.2），语义同样是"这个组合不存在"。
pub fn is_definitely_absent(e: &NetError) -> bool {
    matches!(e.status(), Some(400) | Some(404) | Some(410) | Some(422))
}

/// ★ Modrinth / CurseForge 的 API：**官方不通时换 mcimirror**。
///
/// ## 为什么需要它（实测的痛点）
///
/// 这两个域（`api.modrinth.com` / `api.curseforge.com`）在镜像表里改写不出
/// 任何东西，于是**只有一条路**：Modrinth 抽风或被限流时，
/// "资源中心"整页就是空白 + 一条"没查到"，用户除了重试没有任何办法。
///
/// PCL2 的做法（`ModDownload.vb` 的 `DlSourceModGet`）是把 Modrinth 与
/// CurseForge 的域名整批改写到 mcimirror —— 它**默认就走镜像**。
/// 我们没有直接跟：本机实测镜像比官方慢（146 KB/s vs 230 KB/s），
/// 对大多数人来说官方直连才是最优解。
///
/// 所以这里采取"**官方优先、失败换镜像**"：
///   * 官方成功 → 完全不多花一次请求（绝大多数情况）；
///   * 官方失败（超时 / 限流 / 被墙）→ 换镜像再试一次，而不是直接报"没查到"。
///
/// ★ 只对 **4xx 之外的失败**换源：404 换到镜像上同样是 404
///   （镜像就是同一个 API 的反代），白白多等一轮 —— 而 404 的语义是
///   "这个资源确实不存在"，必须原样上抛给 `is_definitely_absent`（ADR-037）。
pub async fn get_text_third_party(url: &str) -> Result<String> {
    get_text_third_party_with_headers(url, &[]).await
}

/// 同上，但可以带请求头（CurseForge 的 `x-api-key`）。
///
/// ★ 镜像（mcimirror）**带不带 key 都能用**（实测），所以兜底那一路
///   原样带上同样的头 —— 不为镜像单写一条分支，也就不会出现
///   "官方和镜像的行为悄悄不一样"这种问题。
pub async fn get_text_third_party_with_headers(
    url: &str,
    headers: &[(&str, &str)],
) -> Result<String> {
    match get_text_with_headers(url, headers).await {
        Ok(t) => Ok(t),
        Err(e) if is_definitely_absent(&e) => Err(e),
        Err(e) => {
            let Some(mirror) = crate::net::mirror::mcimirror_url(url) else {
                return Err(e);
            };
            say!("[IEML/net] {url} 失败（{e}），换 mcimirror 重试：{mirror}");
            match get_text_with_headers(&mirror, headers).await {
                Ok(t) => Ok(t),
                Err(e2) => Err(NetError::Other(format!(
                    "{e}；换 mcimirror 镜像后仍然失败：{e2}"
                ))),
            }
        }
    }
}

/// 带重试的 GET（解析 JSON）
pub async fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    let text = get_text(url).await?;
    serde_json::from_str(&text)
        .map_err(|e| NetError::Other(format!("解析 {url} 的 JSON 失败：{e}")))
}

/* ====================== 两路竞速（PCL2 的错峰启动） ====================== */

/// ★★ **第一路先跑，第二路等 `stagger` 再上；谁先成功用谁。**
///
/// ## 为什么不是 `tokio::join!` 全并行（用户报的"清单查得慢、还连不上"）
///
/// 我们原来对加载器清单是"5 个来源**同时**发，然后等**全部**返回"。
/// 后果有两个，都很糟：
///   ① **总时长 = 最慢那条**。BMCLAPI 偶尔整片挂住（TCP 通、TLS 完成、
///      一个字节不回），它一挂，整次查询就要等满 75 秒的总超时 ——
///      而另外四条路其实早就拿到答案了。
///   ② **同时开 5 条连接会互相饿死**。实测这台机器上并行 5 个请求时，
///      连接池竞争会让本来 4.5 秒成功的 Fabric 查询超过 30 秒被砍。
///
/// PCL2 的做法（`ModDownload.vb` 的 `DlSourceLoader`）是**错峰**：
/// 列表写成 `[(源A, 0), (源B, 30), (源C, 60)]`（单位 100ms），
/// 第一个 3 秒启动，第二个 6 秒启动，任何一个成功就**立刻取消其余全部**。
///
/// 这里同构地实现成两路：
///   * 主路立刻开始；
///   * 备路等 `stagger` 再开始 —— 快源不受影响（它在 stagger 之前就成功了，
///     备路的任务根本不会启动）；
///   * 慢源（或挂住的源）最多让用户多等 `stagger`，而不是等满 75 秒。
///
/// ★ 两个 future 都必须 `Send + 'static`；`stagger` 传 `None` 时退化成
///   "只用主路"（与原来的单路行为一致）。
pub async fn race_with_stagger<T, F1, F2>(
    what: &str,
    primary: F1,
    fallback: F2,
    stagger: Option<Duration>,
) -> Result<T>
where
    T: Send + 'static,
    F1: std::future::Future<Output = Result<T>> + Send + 'static,
    F2: std::future::Future<Output = Result<T>> + Send + 'static,
{
    let Some(stagger) = stagger else {
        return primary.await;
    };

    let what = what.to_string();
    // 主路 spawn 出来：这样主路先成功时，备路的定时器也能被一并丢弃
    let primary_handle = tokio::spawn(async move { primary.await });

    // 备路：先睡 stagger，再跑（被 abort 时它们一起被丢掉）
    let fallback_handle = {
        let what = what.clone();
        tokio::spawn(async move {
            tokio::time::sleep(stagger).await;
            say!("[IEML/net] {what}：主路 {stagger:?} 还没回来，启动备路");
            fallback.await
        })
    };

    let mut primary_handle = primary_handle;
    let mut fallback_handle = fallback_handle;

    tokio::select! {
        joined = &mut primary_handle => match joined {
            Ok(Ok(v)) => {
                fallback_handle.abort();
                Ok(v)
            }
            Ok(Err(e1)) => {
                // 主路失败 → 等备路（它可能已经开始，也可能还要等一会儿）
                match fallback_handle.await {
                    Ok(Ok(v)) => {
                        say!("[IEML/net] {what}：主路失败（{e1}），备路成功");
                        Ok(v)
                    }
                    Ok(Err(e2)) => Err(NetError::Other(format!("{e1}；备路也失败：{e2}"))),
                    Err(_) => Err(e1),
                }
            }
            // 主路 panic（不该发生）→ 交给备路
            Err(_) => match fallback_handle.await {
                Ok(r) => r,
                Err(e) => Err(NetError::Other(format!("{what}：两路都异常结束（{e}）"))),
            },
        },
        joined = &mut fallback_handle => match joined {
            Ok(Ok(v)) => {
                primary_handle.abort();
                Ok(v)
            }
            Ok(Err(e2)) => {
                // 备路先失败（少见：它起步更晚）→ 继续等主路
                match primary_handle.await {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err(e1)) => Err(NetError::Other(format!("{e2}；主路也失败：{e1}"))),
                    Err(e) => Err(NetError::Other(format!("{what}：主路异常结束（{e}）"))),
                }
            }
            Err(_) => match primary_handle.await {
                Ok(r) => r,
                Err(e) => Err(NetError::Other(format!("{what}：两路都异常结束（{e}）"))),
            },
        },
    }
}

/// 只取响应头，用于探测文件大小与是否存在
pub async fn head_len(url: &str) -> Result<Option<u64>> {
    let resp = client().head(url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    Ok(resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// ★ 快的那一路先成功 → 立刻返回，**不等慢的那一路**。
    ///
    ///   这是"清单查得慢"的核心修法：原来的串行逻辑必须等主路失败（可能 75 秒）
    ///   才试备路，而备路其实早就通了。
    #[tokio::test]
    async fn stagger_race_returns_the_fast_lane() {
        let started = std::time::Instant::now();
        let got: Result<&str> = race_with_stagger(
            "test",
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok("primary")
            },
            async {
                tokio::time::sleep(Duration::from_millis(5000)).await;
                Ok("fallback")
            },
            Some(Duration::from_millis(200)),
        )
        .await;
        assert_eq!(got.unwrap(), "primary");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "主路 50ms 就成功了，不该等备路：{:?}",
            started.elapsed()
        );
    }

    /// ★★ 主路**挂住**时，备路等 stagger 之后自己起步并救场。
    ///
    ///   这条就是用户报的场景：BMCLAPI 连接建立、一个字节不回。
    ///   总时长应当是 `stagger + 备路耗时`，而不是"主路超时 + 备路耗时"。
    #[tokio::test]
    async fn staggered_fallback_rescues_a_hung_primary() {
        let started = std::time::Instant::now();
        let got: Result<&str> = race_with_stagger(
            "test",
            async {
                // 模拟"挂住"：远远超过备路的起步时间
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok("primary")
            },
            async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok("fallback")
            },
            Some(Duration::from_millis(300)),
        )
        .await;
        let elapsed = started.elapsed();
        assert_eq!(got.unwrap(), "fallback", "挂住的主路必须被备路救回来");
        assert!(
            elapsed < Duration::from_secs(3),
            "总时长应当是 stagger + 备路耗时（约 0.4 秒），实际 {elapsed:?}"
        );
    }

    /// 主路**报错**（不是挂住）→ 备路照常接手
    #[tokio::test]
    async fn failed_primary_falls_through_to_the_backup() {
        let got: Result<&str> = race_with_stagger(
            "test",
            async { Err(NetError::Other("主路 404".into())) },
            async { Ok("fallback") },
            Some(Duration::from_millis(100)),
        )
        .await;
        assert_eq!(got.unwrap(), "fallback");
    }

    /// 两条路都失败 → 错误里要能看到**两边的**原因（否则没法排查）
    #[tokio::test]
    async fn both_lanes_failing_reports_both_reasons() {
        let got: Result<()> = race_with_stagger(
            "test",
            async { Err(NetError::Other("主路超时".into())) },
            async { Err(NetError::Other("备路 500".into())) },
            Some(Duration::from_millis(100)),
        )
        .await;
        let msg = got.unwrap_err().to_string();
        assert!(msg.contains("主路超时"), "错误里要有主路的原因：{msg}");
        assert!(msg.contains("备路 500"), "错误里要有备路的原因：{msg}");
    }

    /// `stagger = None` → 退化成"只用主路"（备路一次请求都不该发出）
    #[tokio::test]
    async fn no_stagger_means_primary_only() {
        let got: Result<&str> = race_with_stagger(
            "test",
            async { Ok("primary") },
            async { Ok("fallback") },
            None,
        )
        .await;
        assert_eq!(got.unwrap(), "primary");
    }

    /// 两条路都是**立刻成功**时不能死锁、也不能等对方
    #[tokio::test]
    async fn both_instant_still_returns() {
        let got: Result<u8> =
            race_with_stagger("test", async { Ok(1u8) }, async { Ok(2u8) }, Some(Duration::from_millis(50)))
                .await;
        assert!(got.is_ok());
    }
}
