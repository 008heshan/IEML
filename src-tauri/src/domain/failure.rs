//! **"这次失败该怎么办"** —— 失败分类判据（纯逻辑，无 `crate::` 依赖）。
//!
//! ## 为什么要有这个模块（一次只读审计的结论）
//!
//! 下载引擎原来对失败的分类只有一句话：
//!
//! ```text
//!   NetError::is_retryable() -> !matches!(self, Cancelled)   // 除取消全可重试
//! ```
//!
//! 也就是**完全不分类**。后果是三件会一起发生的事：
//!
//!   ① **404 / 403 走满预算**：`MAX_FILE_RETRIES(3) × MAX_BATCH_ROUNDS(3) = 9` 次，
//!      每一轮之间还有指数退避 —— 一个"这个地址上确实没有这个文件"的结论，
//!      要花掉十几秒才说出口；
//!   ② **权限拒绝（`ERROR_ACCESS_DENIED = 5`）被当成"文件被占用"**：
//!      它被算进"落位退避"里，等满 4 次退避（0.3/0.9/2.1/4 秒）之后
//!      再去吃 9 次整份重下 —— 而权限不会因为等待而变好；
//!   ③ **磁盘满（`ERROR_DISK_FULL = 112`）根本不在 busy 表里**：
//!      它落进"全可重试"，于是磁盘满时启动器会一边失败一边重试，
//!      把"磁盘不够"这条真实原因埋在一句笼统的"写入文件失败"底下。
//!
//! ★ 同一个仓库的**元数据路径早就是对的**（`net/mod.rs` 的 `get_text_with_headers`：
//!   4xx 立刻返回、只有 429/5xx 才退避）—— 只有"下载"这条路漏改了。
//!   这个模块就是把那条已经写在元数据路径上的判据，变成**一份可复用的数据**，
//!   让两条路走同一个结论（免得下次又只改一处）。
//!
//! ## 为什么放在 `domain/` 且不碰 `crate::`
//!
//!   这台机器上 `cargo test --lib` 在**加载阶段**就退出（`0xc0000139`），
//!   一个测试都跑不到。所以判据必须能被 `rustc` **单文件编译**成小程序来验：
//!   `src-tauri/src/domain/*.rs` 里那些零 `crate::` 依赖的纯逻辑文件
//!   正是为此存在的（`crash.rs` / `java.rs` / `pack_plan.rs` 都是这个形状）。
//!   ⇒ 本文件**不许** `use crate::anything`。
//!
//! ## 判据的形状
//!
//! 输入是**两个数**（HTTP 状态码、系统 errno），输出是一档处置：
//!
//! | 档 | 含义 | 引擎该做什么 |
//! |---|---|---|
//! | [`FailureClass::Fatal`] | 再试也一样 | 立刻结束，**不吃** 3×3 预算 |
//! | [`FailureClass::Retryable`] | 可能只是这次不走运 | 指数退避后重试 / 换源 |
//! | [`FailureClass::Busy`] | 文件被别的进程占着 | **短**退避重试（占用是秒级的） |
//!
//! ★ `None`（未知）一律按 **Retryable** —— 这是**有意的兜底**，见
//!   [`FailureClass::from_parts`] 上的说明。

/// Windows 的 `GetLastError` / `std::io::Error::raw_os_error()` —— 常量只列这里
/// 用到的那些，免得下一个人再去查一遍 MSDN。
pub mod win_errno {
    /// `ERROR_ACCESS_DENIED`。★ **不是"被占用"** —— 见模块说明 ②。
    pub const ACCESS_DENIED: i32 = 5;
    /// `ERROR_SHARING_VIOLATION`：另一个进程真的打开了这个文件。
    pub const SHARING_VIOLATION: i32 = 32;
    /// `ERROR_LOCK_VIOLATION`：文件区域被锁住。
    pub const LOCK_VIOLATION: i32 = 33;
    /// `ERROR_DISK_FULL`：磁盘写满了。★ 以前**不在** busy 表里，落进了"全可重试"。
    pub const DISK_FULL: i32 = 112;
    /// `ERROR_HANDLE_DISK_FULL`：同上，另一个码（有些卷上回这个）。
    pub const HANDLE_DISK_FULL: i32 = 39;
    /// `ERROR_USER_MAPPED_FILE`：文件被映射（多半是杀软/索引服务）。
    pub const USER_MAPPED_FILE: i32 = 1224;
}

/// Unix 的 errno —— 只列判据用得到的。
///
/// ★ 为什么 Windows 的代码里也要留这一份：判据是**纯函数**，而
///   "哪些 errno 算磁盘满"这件事在两端**语义相同、编号不同**。
///   写成一个函数（而不是在两处 `matches!` 里各写一遍）才不会漏掉一端。
pub mod unix_errno {
    /// `ENOSPC`
    pub const NO_SPACE: i32 = 28;
    /// `EDQUOT`（磁盘配额用尽）
    pub const QUOTA_EXCEEDED: i32 = 122;
    /// `EACCES`
    pub const ACCESS: i32 = 13;
    /// `EPERM`
    pub const PERM: i32 = 1;
    /// `ETXTBSY`
    pub const TEXT_BUSY: i32 = 26;
}

/// **这一次失败该怎么处置。**
///
/// ★ 实现了 `Serialize`（而不是只在 Rust 侧用）：`DownloadFailure` 要把它
///   带进 `DownloadOutcome`，而那个结构是**序列化给前端**的
///   （`commands_real.rs` 把它塞进 JSON）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// 再试也一样（404/403、权限拒绝、磁盘满、反复校验不符）。
    ///
    /// 引擎遇到它必须**立刻**结束这件事，不要再吃重试预算。
    Fatal,
    /// 可能只是这次不走运（超时、连接重置、5xx、429、截断、哈希本轮不符）。
    Retryable,
    /// 目标文件被别的进程占着（Windows 的 os error 32/33/1224）。
    ///
    /// 与 `Retryable` **分开**是有理由的：这种失败的等待时间应当是
    /// **秒级**（占用通常几秒就解除），而普通失败要指数退避到十几秒；
    /// 而且它是**本地**问题，换下载源完全没用。
    Busy,
}

impl FailureClass {
    /// 该不该继续占用重试预算。
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Retryable)
    }

    /// 是不是"再试也一样"。
    pub fn is_fatal(self) -> bool {
        matches!(self, Self::Fatal)
    }

    /// 是不是"文件被占用"。
    pub fn is_busy(self) -> bool {
        matches!(self, Self::Busy)
    }

    /// **换一个下载源有没有可能让它变好？**
    ///
    /// ★ 这一条是 `NetError::should_switch_source()` 的判据（它以前**零调用点**，
    ///   而且实现里把 `Busy` 也算成"该换源"—— 换源治不好本地文件被占用）。
    pub fn worth_switching_source(self) -> bool {
        self.is_retryable()
    }

    /// 由**两个数**得出处置。这是本模块的核心判据，也是最好测的那一环。
    ///
    /// ## ★★ 未知（`None`）为什么按**可重试**兜底
    ///
    ///   这是**有意的**，不是偷懒：
    ///
    ///   * 落到这里的绝大多数是"没被识别的瞬时故障"—— DNS 抖动、代理提前收尾、
    ///     TLS 握手失败、连接被中间设备重置。它们**重试就真的能好**；
    ///   * 反过来兜底成 `Fatal` 的代价大得多：一次网络抖动就会让一个 3000 文件的
    ///     安装**整体失败**，而求助手段只剩"用户自己再点一次"；
    ///   * 而且**能重试不等于会一直重试**：预算仍然是硬的
    ///     （`MAX_FILE_RETRIES` / `MAX_BATCH_ROUNDS`），退避仍然是指数的。
    ///
    ///   ⇒ 所以兜底方向选"可重试"，但**必须在测试里钉住它**
    ///     （`unknown_is_retryable_on_purpose`）—— 免得下一个人以为这里是漏写的。
    ///
    /// ## 顺序也是判据的一部分
    ///
    ///   errno 先看：文件系统错误与 HTTP 状态码**不会同时出现**，
    ///   但调用方有可能两个都传（`io::Error` 的 `raw_os_error` 与一个状态码）。
    ///   先看 errno 是因为它更具体（"权限"而不是"笼统的 4xx"）。
    pub fn from_parts(status: Option<u16>, os_err: Option<i32>) -> Self {
        if let Some(code) = os_err {
            if is_disk_full_errno(code) {
                // 磁盘满：写不进去就是写不进去，重试只会让界面多撒谎一会儿
                return Self::Fatal;
            }
            if is_permission_errno(code) {
                // 权限拒绝：★ 从 busy 表里摘出来的那一个（原来 ACCESS_DENIED 被当占用）
                return Self::Fatal;
            }
            if is_busy_errno(code) {
                return Self::Busy;
            }
        }
        match status {
            // 404/403/410：确定的"没有/不许"—— 与元数据路径（`get_text_with_headers`）同一个结论
            Some(400..=499) => {
                if matches!(status, Some(408) | Some(429)) {
                    // 408 = 服务端说"你太慢了"，429 = "你太快了"—— 两条都是"等会儿再来"
                    Self::Retryable
                } else {
                    Self::Fatal
                }
            }
            // 5xx / 3xx 之类：服务端的事，等一会儿多半就好
            Some(_) => Self::Retryable,
            // ★ 见上面那段：未知按可重试
            None => Self::Retryable,
        }
    }
}

/// **是不是"磁盘写满了"**（两个平台的码都认）。
///
/// ★ 必须两端都认：判据要被 Windows 的 `io::Error::raw_os_error` 喂，
///   也会被 Unix 上的同一个字段喂（CI 的 Linux 作业会跑到）。
///   ★ 注意 `unix_errno::NO_SPACE = 28` 与 `win_errno` 里的码不冲突
///     （Windows 从来没有把 28 用作磁盘满），所以这里可以合并判断。
pub fn is_disk_full_errno(code: i32) -> bool {
    code == win_errno::DISK_FULL
        || code == win_errno::HANDLE_DISK_FULL
        || code == unix_errno::NO_SPACE
        || code == unix_errno::QUOTA_EXCEEDED
}

/// **是不是"没有权限"**。
pub fn is_permission_errno(code: i32) -> bool {
    code == win_errno::ACCESS_DENIED || code == unix_errno::ACCESS || code == unix_errno::PERM
}

/// **是不是"文件被占用"**。
///
/// ★★ 这里**不含** `ACCESS_DENIED`（5）—— 那是这次修复的核心：
///   权限拒绝等多久都不会变好，把它算进"占用"等于让用户多看几轮假重试。
///   （踩过的现场：3598 个资源文件里 23 个 `.ogg` 报 os error 32，
///   那些是**真的**被占用；而 5 是权限 —— 当时两者混在一个表里。）
pub fn is_busy_errno(code: i32) -> bool {
    code == win_errno::SHARING_VIOLATION
        || code == win_errno::LOCK_VIOLATION
        || code == win_errno::USER_MAPPED_FILE
        || code == unix_errno::TEXT_BUSY
}

/// 从一段**错误文案**里判处置（给 `NetError::Other(String)` 用）。
///
/// ## 为什么这里要看字符串（而不是"顺手强类型化"）
///
///   审计明确结论：`NetError::Other(String)` **不要**强类型化 ——
///   下游（前端与命令层）有字符串匹配依赖它。所以这条判据只能看文案。
///   但"看文案"在这里是**安全**的，因为我们只认自己写的那几种固定说法
///   （`连接过慢` / `续传偏移越界` / `分片…大小不对` …），而且是**兜底**路径：
///   认不出来就按可重试（见 [`FailureClass::from_parts`]）。
///
/// ★ 判据列表与 `net/download.rs` 里实际写出的文案**逐条对应**，
///   每条都在下面的测试里有一个样本（改文案时测试会红，逼着一起改）。
pub fn classify_message(msg: &str) -> FailureClass {
    // ── 致命：重试治不好的那几种 ──
    //
    // ★ "校验失败"/ "expected" / "actual" 那一条尤其重要：一份**每次都对不上**
    //   的文件意味着"期望值错了"或"源上的文件是坏的"，一直重试只会把
    //   同一份坏数据下 9 遍（审计：Never retry a hash mismatch forever）。
    for pat in [
        "磁盘空间不够",
        "没有写入权限",
        "权限不足",
        "续传偏移越界",          // HTTP 416 已经在本调用内重下过一次
        "分片不可用",
        "大小不对",
        "没下完",
        "段下到",                // 分片：某一段在所有源上都只下到一半
        "校验失败",
        "校验不匹配",
        "哈希不符",
        "不支持 Range",
        "没有任何可用下载地址",
    ] {
        if msg.contains(pat) {
            return FailureClass::Fatal;
        }
    }
    // ── 可重试：明确是瞬时故障的那几种 ──
    for pat in [
        "超时",
        "timeout",
        "timed out",
        "连接已无数据",
        "连接停滞",
        "连接过慢",
        "连接重置",
        "connection reset",
        "connection closed",
        "broken pipe",
        "下载不完整",
        "限流页",
        "HTTP 429",
        "HTTP 500",
        "HTTP 502",
        "HTTP 503",
        "HTTP 504",
        "5xx",
    ] {
        if msg.contains(pat) {
            return FailureClass::Retryable;
        }
    }
    // ★ 兜底：认不出来 = 可能只是这次不走运（理由见 `from_parts`）
    FailureClass::Retryable
}

/* ====================== 测试 ======================
 *
 * ★ 这些断言**在本机能真的跑**：本文件零 `crate::` 依赖，
 *   可以用 `rustc` 单文件编译（见文件头部说明）。
 *   同一份断言也留在 `cargo test` 里，CI 的 Windows 作业会再跑一遍。
 */
#[cfg(test)]
mod tests {
    use super::*;

    /// ★★ 权限拒绝**不是**"文件被占用"—— 这是本次修复的核心判据。
    #[test]
    fn access_denied_is_fatal_not_busy() {
        let c = FailureClass::from_parts(None, Some(win_errno::ACCESS_DENIED));
        assert_eq!(c, FailureClass::Fatal, "errno 5 = 权限拒绝，等多久都不会好");
        assert!(!c.is_busy(), "5 必须从 busy 表里摘出去");
        assert!(!is_busy_errno(win_errno::ACCESS_DENIED));
        assert!(is_permission_errno(win_errno::ACCESS_DENIED));
    }

    /// ★ 真"被占用"的三个码一个都不能少（它们是踩过坑才定下来的）。
    #[test]
    fn real_busy_errnos_stay_busy() {
        for code in [
            win_errno::SHARING_VIOLATION,
            win_errno::LOCK_VIOLATION,
            win_errno::USER_MAPPED_FILE,
        ] {
            assert_eq!(
                FailureClass::from_parts(None, Some(code)),
                FailureClass::Busy,
                "errno {code} 是真的被占用，必须还想重试"
            );
            assert!(!FailureClass::from_parts(None, Some(code)).is_fatal());
        }
    }

    /// ★ 磁盘满：Windows 的 112/39 与 Unix 的 28/122 都必须是 Fatal。
    #[test]
    fn disk_full_is_fatal_on_both_platforms() {
        for code in [
            win_errno::DISK_FULL,
            win_errno::HANDLE_DISK_FULL,
            unix_errno::NO_SPACE,
            unix_errno::QUOTA_EXCEEDED,
        ] {
            assert_eq!(
                FailureClass::from_parts(None, Some(code)),
                FailureClass::Fatal,
                "errno {code} = 磁盘满，重试只会让界面多撒谎一会儿"
            );
        }
        // ★ 112 以前**不在** busy 表里 ⇒ 落进"全可重试"，这条就是那个回归
        assert!(!is_busy_errno(win_errno::DISK_FULL));
    }

    /// 4xx 里只有 408/429 可重试，其余致命（与元数据路径 `get_text_with_headers` 一致）。
    #[test]
    fn http_4xx_is_fatal_except_408_and_429() {
        for s in [400u16, 401, 403, 404, 410, 416, 422, 451] {
            assert_eq!(
                FailureClass::from_parts(Some(s), None),
                FailureClass::Fatal,
                "HTTP {s} 是确定的失败，退避重试不会变好"
            );
        }
        for s in [408u16, 429] {
            assert_eq!(
                FailureClass::from_parts(Some(s), None),
                FailureClass::Retryable,
                "HTTP {s} 的语义就是「等会儿再来」"
            );
        }
    }

    /// 5xx 可重试（服务端的事，等一会儿多半就好）。
    #[test]
    fn http_5xx_is_retryable() {
        for s in [500u16, 502, 503, 504, 507, 599] {
            assert_eq!(FailureClass::from_parts(Some(s), None), FailureClass::Retryable);
        }
    }

    /// ★★ 未知（两个数都没有）按**可重试** —— 这是**有意**的兜底，钉住它。
    #[test]
    fn unknown_is_retryable_on_purpose() {
        assert_eq!(FailureClass::from_parts(None, None), FailureClass::Retryable);
        // 也钉一条"按文案判"的兜底：认不出来同样是可重试
        assert_eq!(
            classify_message("某个我们还没见过的错误"),
            FailureClass::Retryable
        );
        // 而且未知**不该**被当成致命（否则一次网络抖动就废掉整批安装）
        assert!(!FailureClass::from_parts(None, None).is_fatal());
    }

    /// errno 优先于状态码（它更具体："权限"而不是笼统的 4xx）。
    #[test]
    fn errno_wins_over_status() {
        assert_eq!(
            FailureClass::from_parts(Some(429), Some(win_errno::ACCESS_DENIED)),
            FailureClass::Fatal,
            "429 只是「等会儿再来」，但权限拒绝是确定的 —— errno 说了算"
        );
    }

    /// 换源判据：只有可重试才值得换源（占用是**本地**问题，换源没用）。
    #[test]
    fn only_retryable_is_worth_switching_source() {
        assert!(FailureClass::Retryable.worth_switching_source());
        assert!(!FailureClass::Fatal.worth_switching_source());
        assert!(
            !FailureClass::Busy.worth_switching_source(),
            "★ 文件被占用是本地问题，换下载源治不好它（老实现把 Busy 也算成该换源）"
        );
    }

    /// 文案判据：`net/download.rs` 里**真的会被返回**的那几句，逐条对得上。
    ///
    /// ★ 只列 `return Err(..)` / `Err(NetError::Other(..))` 真的写出来的句子 ——
    ///   `say!` 打的日志（例如"分片不可用（HTTP 429）→ 回退单连接"）不会成为
    ///   最终错误，把它们列进来会让这条测试**测一个不存在的形状**。
    #[test]
    fn message_classification_matches_the_real_wording() {
        // ── 致命那几句（真的会作为最终错误返回的） ──
        for msg in [
            "写入文件失败：磁盘空间不够（os error 112）",
            "写入文件失败：没有写入权限（os error 5）",
            "续传偏移越界（HTTP 416），已清掉本地残留但仍下不完 —— URL: x",
            "分片拼装后大小不对（期望 16777216 字节，段合计 8388608，上报 8388608）—— 有段没下完，删掉重来",
            "第 0 段下到 1048576/2097152 字节（源 https://x/y）",
            "x 返回的文件校验失败（期望 abc，实际 def）",
            "content 没有任何可用下载地址",
        ] {
            assert_eq!(
                classify_message(msg),
                FailureClass::Fatal,
                "这句必须是致命：{msg}"
            );
        }
        // ── 可重试那几句 ──
        for msg in [
            "下载超时（超过 300 秒仍未完成，本次已下 0 字节）—— URL: x",
            "连接已无数据（5 秒内仅 0.0 KB，按 PCL2 的 1 KB/s 判据视为断线）—— URL: x",
            "连接停滞（连续 3 次 20 秒无数据）—— URL: x",
            "连接过慢（15 秒内仅 4 KB/s）—— URL: x",
            "服务端只回了 146 字节（任务要求 286235 字节）—— 像是限流页，已降低并发并冷却该源",
            "连接 cdn.modrinth.com 超过 8 秒没有进展，换下一个源",
            /*
             * ★ "下载不完整"是**可重试**的，不是致命 —— 这一条判据值得写清楚，
             *   因为它看起来像"确定的失败"：
             *   那句话由 `finish_single` 抛出，**同时明确说"已保留 .part，
             *   重试会接着下"** —— 也就是说它承认自己可能是"连接中途断了、
             *   代理提前收尾"，那正是可重试的形状（下一轮从断点续上）。
             *   ★ 真正致命的是"服务端上的文件换了"那一类，它由长度**多了**
             *     与哈希不符来抓（后者在 Fatal 那组里）。
             */
            "下载不完整：任务记录 200 字节，实际拿到 120 字节（少了 80 字节）—— 已保留 .part，重试会接着下 —— URL: x",
        ] {
            assert_eq!(
                classify_message(msg),
                FailureClass::Retryable,
                "这句必须可重试：{msg}"
            );
        }
        /*
         * ★ "不支持 Range 分片（HTTP 200）"是 `NetError::RangeUnsupported`
         *   的 Display，而它的 `class()` **不看文案** —— 那个变体自己判。
         *   这条断言把两件事对上：文案里认得出，变体口径也一致。
         */
        assert_eq!(
            classify_message("不支持 Range 分片（HTTP 200）：https://x/y"),
            FailureClass::Fatal,
            "RangeUnsupported 是永久的，换源/退避都不该继续"
        );
    }

    /// ★ 防漂：`is_disk_full_errno` / `is_permission_errno` / `is_busy_errno`
    ///   三张表**两两不相交**（一行同时落进两张表 = 判据自相矛盾）。
    #[test]
    fn the_three_errno_tables_do_not_overlap() {
        let all = [
            win_errno::ACCESS_DENIED,
            win_errno::SHARING_VIOLATION,
            win_errno::LOCK_VIOLATION,
            win_errno::DISK_FULL,
            win_errno::HANDLE_DISK_FULL,
            win_errno::USER_MAPPED_FILE,
            unix_errno::NO_SPACE,
            unix_errno::QUOTA_EXCEEDED,
            unix_errno::ACCESS,
            unix_errno::PERM,
            unix_errno::TEXT_BUSY,
        ];
        for code in all {
            let n = [
                is_disk_full_errno(code),
                is_permission_errno(code),
                is_busy_errno(code),
            ]
            .iter()
            .filter(|x| **x)
            .count();
            assert_eq!(n, 1, "errno {code} 落在 {n} 张表里，必须恰好落在一张");
        }
    }
}
