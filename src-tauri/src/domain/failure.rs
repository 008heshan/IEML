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
//! | [`FailureClass::Fatal`] | **整批都不可能好**（磁盘满 / 权限拒绝） | 立刻结束**整批**，不吃 3×3 预算 |
//! | [`FailureClass::GiveUp`] | **这一个文件**没戏（404 / 超上限 / 校验不符） | 这个文件不再重试、不换源，**但批次继续** |
//! | [`FailureClass::Retryable`] | 可能只是这次不走运 | 指数退避后重试 / 换源 |
//! | [`FailureClass::Busy`] | 文件被别的进程占着 | **短**退避重试（占用是秒级的） |
//!
//! ## ★★★★ 2026-10-17：`GiveUp` 这一档是**补上的一个真缺陷**
//!
//!   原来只有三档，而批次层把 `Fatal` 直接当成"**整批停下**"
//!   （`net/download.rs::download_batch`：本轮出现致命失败 ⇒ 剩下的任务全收进
//!   失败清单、`break`）。当时"超上限"被判成 `Fatal`（文案里那个「没下完」
//!   就是为了让它别白重试）—— **那个决定在"这个文件"这一层是对的，
//!   在"整批"这一层是错的**：
//!
//!   现场（用户装 1.20.1 的整合包）：`better-end`(92 MB) 与
//!   `the_bumblezone`(69 MB) 两个 mod 撞上 64 MiB 的 `Unknown` 档，
//!   于是**整批停下** —— 剩下几百个本来能下下来的文件连试都没试，
//!   日志却写着"因为本轮出现致命失败（磁盘满/权限/校验反复不符）"，
//!   而真正的原因是**超上限**（与磁盘、权限毫无关系）。
//!
//!   ⇒ 判据分成两问，别再挤成一档：
//!     · **这个文件**还值不值得再试？── [`FailureClass::is_hopeless`]
//!     · **要不要为它停掉整批？** ── [`FailureClass::stops_the_batch`]
//!
//!   分界线是"**这个原因能不能归到某一个文件头上**"：
//!   磁盘满 / 权限拒绝是**环境**条件（下一个文件也写不进去），所以停整批；
//!   404 / 超上限 / 校验不符是**逐文件**的结论（下一个文件跟它没关系），
//!   所以只放弃它自己。
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
    /// **整批都不可能好**：磁盘满、权限拒绝（404 曾经也算，见 `GiveUp` 的说明）。
    ///
    /// 引擎遇到它必须**立刻结束整批**，不要再吃重试预算 —— 因为换下一个文件
    /// 也是同一个下场（磁盘还是满的、目录还是不可写的）。
    ///
    /// ★ "要不要停整批"请**问 [`Self::stops_the_batch`]**，不要写
    ///   `== FailureClass::Fatal`：这一档与 [`Self::GiveUp`] 的区别只有
    ///   "影不影响别的文件"，而那个判断日后还可能细分。
    Fatal,
    /// **这一个文件**再试也一样：404/410（这个地址上没有它）、响应体超过
    /// 该类别的体积上限、校验/大小不符、Range 不支持、没有任何可用地址。
    ///
    /// 与 [`Self::Fatal`] 的**唯一**区别就在这里：
    ///   · 对它自己：不重试、不吃退避（与 `Fatal` 一样）；
    ///   · 对**别的文件**：**一点影响都没有** —— 批次照常往下跑。
    ///
    /// ★★★★ 2026-10-17 新增（用户现场：一个 92 MB 的 mod 撞上 64 MiB 的
    ///   `Unknown` 档 ⇒ 整个整合包的安装被"致命失败"停下，剩下几百个文件
    ///   连试都没试）。原来的三档里**没有地方表达"这个文件没戏但别管别人"**，
    ///   于是所有 `Fatal` 都被批次层当成了"整批停下"。
    GiveUp,
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
    ///
    /// ★ 注意它与 [`Self::is_worth_retrying`] **不是一回事**：`Busy` 也要占
    ///   预算（只是等待时长短），但按这份文档的原意 `is_retryable` 只指
    ///   "普通重试"。真正的"这个文件还要不要再试"问 `is_worth_retrying`。
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Retryable)
    }

    /// 是不是"再试也一样"。
    ///
    /// ★ 含 [`Self::GiveUp`]（对它自己而言同样是"再试也一样"），
    ///   **不含**判断"要不要停整批"—— 那一条问 [`Self::stops_the_batch`]。
    pub fn is_fatal(self) -> bool {
        matches!(self, Self::Fatal)
    }

    /// 是不是"文件被占用"。
    pub fn is_busy(self) -> bool {
        matches!(self, Self::Busy)
    }

    /// **这一个文件还要不要再吃重试预算？**（`Fatal`/`GiveUp` 都是"不要"）
    ///
    /// ★ 调用点：`net/download.rs` 里"同一份文件的 3 轮"那道闸门 ——
    ///   它以前写的是 `classify_message(..) != Fatal`，而 `GiveUp` 加进来之后
    ///   那个写法会把"超上限"重新变成可重试（正是要修掉的那件事）。
    pub fn is_worth_retrying(self) -> bool {
        matches!(self, Self::Retryable | Self::Busy)
    }

    /// **"这一个文件"是不是已经没戏了？**（不重试、也不该再为它换源等下去）
    ///
    /// ★ 这是 [`Self::is_fatal`] ∪ [`Self::GiveUp`]。用它来表达"没戏"，
    ///   用 [`Self::stops_the_batch`] 表达"整批停下" —— **两问分开问**。
    pub fn is_hopeless(self) -> bool {
        matches!(self, Self::Fatal | Self::GiveUp)
    }

    /// **该不该为它停掉整个批次？**
    ///
    /// 只有"整批都不可能好"的原因才配：磁盘满、权限拒绝（`Fatal`）。
    /// [`Self::GiveUp`] 是逐文件的结论，**不许**停批次 —— 见那一档的说明。
    pub fn stops_the_batch(self) -> bool {
        matches!(self, Self::Fatal)
    }

    /// **换一个下载源有没有可能让它变好？**
    ///
    /// ★ 这一条是 `NetError::should_switch_source()` 的判据（它以前**零调用点**，
    ///   而且实现里把 `Busy` 也算成"该换源"—— 换源治不好本地文件被占用）。
    ///
    /// ★ `GiveUp` 在这里是 `false`（"为它换源纯属白等"），但**有一条例外**，
    ///   它不在这里判：与 URL 相关的 4xx（404/410）虽然是 `GiveUp`，
    ///   候选源之间却可能是**不同的路径、甚至不同的仓库**（Mojang 库 / BMCLAPI）。
    ///   那条例外住在 `NetError::fatal_without_trying_other_sources` 里
    ///   （它把"与 URL 相关"那几种排除在外）—— 那是"换个地方找"，不是重试。
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
                    /*
                     * ★★ 2026-10-17：`Fatal` → `GiveUp`。
                     *
                     *   4xx 说的是"**这个地址上没有这个文件**"（或"不许给你"）——
                     *   它是**逐文件**的结论：同一批里的下一个文件跟它毫无关系。
                     *   判成 `Fatal` 的现场后果（用户报的）：整合包里一个 URL
                     *   失效 ⇒ 整批停下，剩下几百个文件连试都没试。
                     *
                     *   ★ "这个文件不吃重试预算"这半句**一个字都没变**
                     *     （`is_hopeless()` 对它仍然是 true）——
                     *     变的只是"它不再牵连别的文件"。
                     */
                    Self::GiveUp
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
    // ── ① **整批都不可能好**的（环境条件：磁盘、权限）──
    //
    // ★★★★ 2026-10-17：这一段原来与下面那段挤在一起、全都返回 `Fatal`，
    //   而批次层把 `Fatal` 读成"整批停下"。于是**一个文件**的问题会牵连整批。
    //   现在按"这个原因能不能归到某一个文件头上"分开：
    //   磁盘满 / 权限拒绝是**环境**（下一个文件也写不进去）⇒ 停整批；
    //   其余是**逐文件**的结论 ⇒ 只放弃它自己（`GiveUp`）。
    for pat in ["磁盘空间不够", "没有写入权限", "权限不足"] {
        if msg.contains(pat) {
            return FailureClass::Fatal;
        }
    }
    // ── ② 这一个文件没戏了：重试治不好，**但别牵连别的文件** ──
    //
    // ★ "校验失败"/"expected"/"actual"那一条尤其重要：一份**每次都对不上**
    //   的文件意味着"期望值错了"或"源上的文件是坏的"，一直重试只会把
    //   同一份坏数据下 9 遍（审计：Never retry a hash mismatch forever）。
    //   ★ "没下完"就是超上限那句（`cap_exceeded_error`）—— 它属于这一档：
    //     对**这个文件**没必要再试，但批次必须继续往下跑。
    for pat in [
        "续传偏移越界", // HTTP 416 已经在本调用内重下过一次
        "分片不可用",
        "大小不对",
        "没下完",
        "段下到", // 分片：某一段在所有源上都只下到一半
        "校验失败",
        "校验不匹配",
        "哈希不符",
        "不支持 Range",
        "没有任何可用下载地址",
    ] {
        if msg.contains(pat) {
            return FailureClass::GiveUp;
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
    ///
    /// ★★ 2026-10-17：这四条同时也是**唯一**该停整批的原因（`stops_the_batch`）。
    #[test]
    fn disk_full_is_fatal_on_both_platforms() {
        for code in [
            win_errno::DISK_FULL,
            win_errno::HANDLE_DISK_FULL,
            unix_errno::NO_SPACE,
            unix_errno::QUOTA_EXCEEDED,
        ] {
            let c = FailureClass::from_parts(None, Some(code));
            assert_eq!(
                c,
                FailureClass::Fatal,
                "errno {code} = 磁盘满，重试只会让界面多撒谎一会儿"
            );
            assert!(c.stops_the_batch(), "★ 磁盘满必须停整批（下一个文件也写不进去）");
        }
        // ★ 112 以前**不在** busy 表里 ⇒ 落进"全可重试"，这条就是那个回归
        assert!(!is_busy_errno(win_errno::DISK_FULL));
    }

    /// ★★ 权限拒绝同样是**环境**条件 ⇒ 停整批。
    #[test]
    fn permission_denied_stops_the_batch() {
        let c = FailureClass::from_parts(None, Some(win_errno::ACCESS_DENIED));
        assert_eq!(c, FailureClass::Fatal);
        assert!(c.stops_the_batch(), "★ 目录不可写是环境条件，停整批（但**换个源也没用**）");
        assert!(c.is_hopeless());
        assert!(!c.is_worth_retrying());
    }

    /// 4xx 里只有 408/429 可重试，其余**只放弃这一个文件**（不停整批）。
    ///
    /// ★★★★ 2026-10-17 判据变更：4xx 从 `Fatal` 改成 `GiveUp` ——
    ///   "这个地址上没有这个文件"是**逐文件**的结论，不许牵连整批。
    ///   现场：整合包里一个 URL 失效 ⇒ 原来整批停下，剩下几百个文件没试过。
    #[test]
    fn http_4xx_gives_up_this_file_only() {
        for s in [400u16, 401, 403, 404, 410, 416, 422, 451] {
            let c = FailureClass::from_parts(Some(s), None);
            assert_eq!(
                c,
                FailureClass::GiveUp,
                "HTTP {s} 是确定的失败，退避重试不会变好"
            );
            assert!(c.is_hopeless(), "HTTP {s}：这个文件没戏（不吃重试预算）");
            assert!(
                !c.is_worth_retrying(),
                "★ HTTP {s} 不许重试（这一半与改动前完全一致）"
            );
            assert!(
                !c.stops_the_batch(),
                "★★ HTTP {s} **不许停整批** —— 与它无关的文件必须继续下"
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

    /// ★★★★ 2026-10-17：**"超上限"必须只放弃它自己，不许停整批**。
    ///
    ///   这是用户现场那个缺陷的判据（装整合包 / 一个 92 MB 的 mod 撞上
    ///   `Unknown` 64 MiB 档 ⇒ 整批停下）。三件事要同时成立：
    ///     ① 不重试（重试/换源对它确实没意义）；
    ///     ② 不换源；
    ///     ③ **批次继续**跑别的文件。
    ///
    ///   ★ 文案来源是 `net/download.rs::cap_exceeded_error`：
    ///     「★ 响应体超过这个类别的体积上限（**没下完**）：…」
    #[test]
    fn oversize_gives_up_one_file_but_not_the_batch() {
        let msg = "★ 响应体超过这个类别的体积上限（**没下完**）：better-end-4.0.11.jar \
                   —— 已收 92544800 字节，上限 64 MiB (67108864 字节)。\
                   已丢弃临时文件；这不是网络问题，重试/换源都一样，所以直接停下。";
        let c = classify_message(msg);
        assert_eq!(c, FailureClass::GiveUp, "超上限 ⇒ GiveUp");
        assert!(!c.is_worth_retrying(), "① 超上限不许重试（原来那一半是对的）");
        assert!(!c.worth_switching_source(), "② 超上限换源没用");
        assert!(c.is_hopeless(), "对它自己：这个文件没戏了");
        assert!(
            !c.stops_the_batch(),
            "★★★ ③ 超上限**绝对不许停整批** —— 用户现场就是整批被它停下了"
        );
        assert!(
            !c.is_fatal(),
            "★ 它不再是 Fatal：`Fatal` 在新口径里专指「整批都不可能好」"
        );
    }

    /// ★★ **"停整批"这件事只有一个判据**（`stops_the_batch`），
    ///   而且只有 `Fatal` 这一档配得上 —— 把四个档一次列全，谁都别想偷偷放宽。
    #[test]
    fn only_the_environment_class_stops_the_batch() {
        use FailureClass::*;
        assert!(Fatal.stops_the_batch(), "磁盘满 / 权限：停整批");
        assert!(!GiveUp.stops_the_batch(), "★ 逐文件的结论不许停整批");
        assert!(!Retryable.stops_the_batch());
        assert!(!Busy.stops_the_batch(), "本地占用等几秒就好，更不该停整批");
        // 反过来：两问的取值必须是"没戏 ⊇ 停整批"（停整批的一定也没戏）
        for c in [Fatal, GiveUp, Retryable, Busy] {
            if c.stops_the_batch() {
                assert!(c.is_hopeless(), "{c:?} 停了整批却不认为自己没戏 —— 判据自相矛盾");
            }
            // "还要不要重试"与"没戏"必须互补（两档之间没有缝）
            assert_eq!(
                c.is_worth_retrying(),
                !c.is_hopeless(),
                "{c:?} 的 is_worth_retrying 与 is_hopeless 不互补"
            );
        }
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
        assert!(
            !FailureClass::GiveUp.worth_switching_source(),
            "★ 逐文件没戏的东西换源也是白等（例外：与 URL 相关的 4xx 仍然走完候选源列表，\
             那条判在 NetError::fatal_without_trying_other_sources 里）"
        );
    }

    /// 文案判据：`net/download.rs` 里**真的会被返回**的那几句，逐条对得上。
    ///
    /// ★ 只列 `return Err(..)` / `Err(NetError::Other(..))` 真的写出来的句子 ——
    ///   `say!` 打的日志（例如"分片不可用（HTTP 429）→ 回退单连接"）不会成为
    ///   最终错误，把它们列进来会让这条测试**测一个不存在的形状**。
    #[test]
    fn message_classification_matches_the_real_wording() {
        // ── ① 整批都不可能好的那两句（环境条件）⇒ Fatal ⇒ 停整批 ──
        for msg in [
            "写入文件失败：磁盘空间不够（os error 112）",
            "写入文件失败：没有写入权限（os error 5）",
        ] {
            let c = classify_message(msg);
            assert_eq!(c, FailureClass::Fatal, "这句是**环境**问题：{msg}");
            assert!(c.stops_the_batch(), "★ 环境问题才配停整批：{msg}");
        }
        // ── ② 逐文件没戏的那些 ⇒ GiveUp ⇒ **不停整批** ──
        for msg in [
            "续传偏移越界（HTTP 416），已清掉本地残留但仍下不完 —— URL: x",
            "分片拼装后大小不对（期望 16777216 字节，段合计 8388608，上报 8388608）—— 有段没下完，删掉重来",
            "第 0 段下到 1048576/2097152 字节（源 https://x/y）",
            "x 返回的文件校验失败（期望 abc，实际 def）",
            "content 没有任何可用下载地址",
            // ★★ 超上限那句（用户现场那一条）—— 它必须在**不停整批**这一组里
            "★ 响应体超过这个类别的体积上限（**没下完**）：a.jar —— 已收 92544800 字节，\
             上限 64 MiB (67108864 字节)。已丢弃临时文件；这不是网络问题，重试/换源都一样，所以直接停下。",
        ] {
            let c = classify_message(msg);
            assert_eq!(c, FailureClass::GiveUp, "这句是逐文件的结论：{msg}");
            assert!(!c.is_worth_retrying(), "★ 不吃重试预算：{msg}");
            assert!(!c.stops_the_batch(), "★★ 但它**不许**停下整批：{msg}");
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
         *   ★ 2026-10-17：它是**逐文件**的结论（同一个调用里还会回退单连接），
         *     所以是 `GiveUp` 而不是 `Fatal`。
         */
        assert_eq!(
            classify_message("不支持 Range 分片（HTTP 200）：https://x/y"),
            FailureClass::GiveUp,
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
