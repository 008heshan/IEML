//! 下载源管理（对应 PCL2 的 `DlSourceLoader`）
//!
//! 职责：
//!   ① **候选源生成** —— 一个文件在不同源上的 URL 列表（镜像 + 官方）
//!   ② **动态源优先级** —— 按连通性 / 历史成败 / 429 冷却决定先试谁
//!   ③ **源健康统计** —— 每个源的成功率、限流次数、实测速度
//!   ④ **429 指数退避** —— 被限流就冷却，冷却期内不再派活给它
//!
//! ★ 与 ADR-026「多源竞速」的关系（**这是一次修正，见 ADR-034**）：
//!   实测把同一文件的官方源与镜像源**同时**下，总吞吐并不更快 ——
//!   两个连接平分同一条出口带宽，谁都不快；而且镜像源被并发翻倍后
//!   更容易回 429。真正的加速来自**单文件内部的分片并行**（见 download.rs），
//!   多源的价值在于**兜底**：首选源失败/被限流时立刻换一个能用的。
//!   所以这里采用 PCL2 的实际策略：**单源尝试 + 失败换源 + 健康记忆**。

use super::mirror::{self, Source};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/* ====================== 候选源 ====================== */

/// 一个文件的候选源列表（已按「期望源 + 健康度」排序）
///
/// 候选来自两处：
///   ① `mirror::candidate_urls`（镜像表推导：镜像 + 官方，加载器 maven 只给镜像）
///   ② 任务自带的 `urls`（多源回退：同一个文件在多个镜像上路径不同时用；`file://` 表示本地复制）
pub fn candidates(task: &super::download::DownloadTask, preferred: Source) -> Vec<(Source, String)> {
    candidates_with(global(), task, preferred)
}

/// 同上，但显式指定源管理器。
///
/// ★ 为什么要把管理器当参数：健康状态是**进程级共享**的，
///   测试里如果只能改全局状态，一个测试的 429 冷却会污染另一个测试的排序 ——
///   "测试各自独立"这条前提必须能被满足。
pub fn candidates_with(
    manager: &SourceManager,
    task: &super::download::DownloadTask,
    preferred: Source,
) -> Vec<(Source, String)> {
    let mut out = mirror::candidate_urls(&task.url, preferred);
    for u in &task.urls {
        if u.trim().is_empty() {
            continue;
        }
        if u.starts_with("file://") {
            // 本地复制：没有网络候选可言
            out.clear();
            out.push((preferred, u.clone()));
            continue;
        }
        let mirrored = mirror::mirror_url(u, Source::Bmclapi);
        for (s, v) in [(Source::Bmclapi, mirrored), (Source::Mojang, u.clone())] {
            if !out.iter().any(|(_, x)| *x == v) {
                out.push((s, v));
            }
        }
    }
    sort_by_health(manager, out, preferred)
}

/// 按「期望的源优先 + 源健康度」排序候选。
fn sort_by_health(
    manager: &SourceManager,
    list: Vec<(Source, String)>,
    preferred: Source,
) -> Vec<(Source, String)> {
    let mut scored: Vec<(i64, usize, (Source, String))> = list
        .into_iter()
        .enumerate()
        .map(|(i, item)| {
            // 期望源 +1000 分；健康分越低（成功率低/刚被限流）排得越后
            let base = if item.0 == preferred { 1000 } else { 0 };
            let score = base + manager.score(item.0);
            // 冷却中的源排到最后（score 里已经体现，这里再加一道保险）
            let cooldown = if manager.is_cooling(item.0) { -10_000 } else { 0 };
            (score + cooldown, i, item)
        })
        .collect();
    // 稳定排序：分数相同时保持原顺序（保证测试可复现）
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, x)| x).collect()
}

/* ====================== 健康统计 ====================== */

/// 单个源的累计统计
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SourceStats {
    pub attempts: u64,
    pub successes: u64,
    pub failures: u64,
    /// 被限流的次数（HTTP 429）
    pub rate_limited: u64,
    /// 累计拉到的字节数（用于算实测速度）
    pub bytes: u64,
    /// 累计耗时（毫秒）
    pub elapsed_ms: u64,
    /// 冷却到什么时候（epoch 毫秒，0 = 不在冷却）
    pub cooldown_until_ms: u64,
    /// 最近一次**启动探测**的中位 TTFB（毫秒）。`None` = 那次探测三个端点全失败。
    ///
    /// ★ 与 `bytes/elapsed_ms` 那套是**两回事**，别混：
    ///   - 这里量的是"路通不通、多快"（主动探测，含失败信息）
    ///   - 那里量的是"实际下载跑出过多少速度"（被动统计，只有成功才有数据）
    ///   一个源可以"探测很快但没下过东西"（新装的启动器）或
    ///   "探测失败但历史上一直很快"（这次只是抽风）——
    ///   两者互不覆盖，评分时会一起看。
    pub probe_ttfb_ms: Option<u32>,
    /// 那次探测有几个端点成功（0..=3）
    pub probe_ok: u8,
    /// 探测时刻（epoch 毫秒，0 = 从未探测）
    pub probed_at_ms: u64,
}

impl SourceStats {
    /// 实测平均速度（字节/秒），没数据时为 0
    pub fn bytes_per_second(&self) -> u64 {
        if self.elapsed_ms == 0 {
            return 0;
        }
        self.bytes.saturating_mul(1000) / self.elapsed_ms
    }
}

/// 源管理器：全局单例，跨文件共享同一个源的健康状态。
///
/// 为什么必须是全局的：429 是**对源的整体限流**，不是针对某个文件。
/// 如果每个文件各自记，同一批 3000 个文件会各自撞一次 429。
pub struct SourceManager {
    stats: Mutex<HashMap<Source, SourceStats>>,
    /// 并发上限的当前建议值（源被限流时下调，见 `note_rate_limited`）
    concurrency_hint: AtomicU64,
    started: Instant,
}

/// 降到什么程度算"被限流后该收敛"
pub const MIN_CONCURRENCY: usize = 4;
/// 默认并发上限
pub const DEFAULT_CONCURRENCY: usize = 64;

/* ====================== 排序策略（国内优先 + 实测延迟） ====================== */

/// 国内源的**策略加成**：落实「国内有的就用国内」。
///
/// 取值经过校准，不是随手写的：它必须
///   ① 大到能压过"一次探测里官方略快"的差异（实测原版清单官方快约 300ms，
///      折算成分数约 15 分），
///   ② 又小到"国内源真的慢一大截"时能被翻盘（实测 2000ms vs 200ms 差约 50 分）。
///
/// 25 分正好落在这个区间里：国内优先是**默认倾向**，不是**绝对强制**。
const DOMESTIC_BONUS: i64 = 25;

/// 探测发现某源**完全不可达**时的惩罚。
///
/// 比 `DOMESTIC_BONUS` 大得多：国内优先的前提是"国内有得用"，
/// 三个端点全超时就说明这一次它没得用，此时再讲策略就是自欺欺人。
const PROBE_DEAD_PENALTY: i64 = 120;

/// 探测结论的新鲜度窗口。与 `probe::PROBE_TTL` 保持一致。
///
/// 为什么必须过期：源的好坏是**时段性**的 —— 实测同一天内官方 Fabric meta
/// 可以从 4/4 成功变成 0/4 超时。一次探测不能当永久结论。
const PROBE_TTL_MS: u64 = 10 * 60 * 1000;

/// 由实测 TTFB 折算的加成：越快分越高，1200ms 以上不再加分。
fn probe_bonus(ttfb_ms: u32) -> i64 {
    if ttfb_ms >= 1200 {
        return 0;
    }
    ((1200 - ttfb_ms) / 20) as i64
}

impl SourceManager {
    fn new() -> Self {
        Self {
            stats: Mutex::new(HashMap::new()),
            concurrency_hint: AtomicU64::new(DEFAULT_CONCURRENCY as u64),
            started: Instant::now(),
        }
    }

    /// 测试专用：一个**与全局实例互不干扰**的管理器。
    ///
    /// 为什么需要它：`download` 那边的测试要断言"识别出限流页之后，
    /// 这个源真的被冷却了、并发真的降了"，而全局实例是进程级的单例 ——
    /// 往它上面写状态会污染同一进程里其它测试（并行跑时结果随机）。
    /// 只有一个测试入口拿得到独立实例，那些断言才立得住。
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self::new()
    }

    fn with<R>(&self, source: Source, f: impl FnOnce(&mut SourceStats) -> R) -> R {
        let mut guard = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.entry(source).or_default())
    }

    /// **优先分**：越高越优先。
    ///
    /// 由三部分构成：
    ///   ① **健康分** —— 历史成功率 + 实测下载速度 − 限流次数（被动学到的）
    ///   ② **策略加成** —— 国内源 +25，落实「国内有的就用国内」
    ///   ③ **探测加成** —— 启动期实测的 TTFB，越快加得越多；
    ///      三个端点全失败则 −120（这次它真的不可达，此时不该再讲策略）
    ///
    /// 刚被限流（429 冷却中）的源直接掉到 −5000，压过全部三项 ——
    /// 限流是"现在别用它"，比任何长期倾向都更紧急。
    pub fn score(&self, source: Source) -> i64 {
        // ★ 先把探测结论读出来、**放掉锁**，再进 `with` 算分。
        //   `with` 自己也要拿同一把锁 —— 在持锁期间调它就是自死锁。
        //   （这个坑本项目踩过一次：`snapshot()` 里持锁调 `score()`，
        //     表现为测试挂住 60 秒不返回、进程 CPU 为 0。）
        let probe = self.fresh_probe(source);
        self.with(source, |s| {
            if now_ms() < s.cooldown_until_ms {
                return -5_000;
            }
            let attempts = s.attempts.max(1) as i64;
            let successes = s.successes as i64;
            // 成功率 0~100 为主项，速度做微调（每 MB/s 加 1 分，最多 50 分）
            let rate = successes * 100 / attempts;
            let speed_bonus = (s.bytes_per_second() / (1024 * 1024)).min(50) as i64;
            let mut score = rate + speed_bonus - (s.rate_limited.min(20) as i64) * 2;

            // ② 策略：国内优先
            if source == Source::Bmclapi {
                score += DOMESTIC_BONUS;
            }

            // ③ 实测：新鲜的话才作数
            if let Some(ttfb) = probe {
                score += match ttfb {
                    Some(ms) => probe_bonus(ms),
                    None => -PROBE_DEAD_PENALTY,
                };
            }
            score
        })
    }

    /// 新鲜的探测结论。
    ///
    /// 外层 `None` = 从没探过 / 已过期（此时**不参与**评分，退回纯健康分 + 策略）；
    /// 内层 `None` = 探过了，但三个端点全失败。
    fn fresh_probe(&self, source: Source) -> Option<Option<u32>> {
        self.with(source, |s| {
            if s.probed_at_ms == 0 {
                return None;
            }
            if now_ms().saturating_sub(s.probed_at_ms) > PROBE_TTL_MS {
                return None;
            }
            Some(s.probe_ttfb_ms)
        })
    }

    /// 记录一次启动探测的结论（由 `net::probe` 调用）。
    ///
    /// ★ 只写探测字段，**不碰** `attempts/successes/bytes` ——
    ///   探测失败不等于"这个源坏过"，那是真实传输才有的结论。
    pub fn note_probe(&self, source: Source, ttfb_ms: Option<u32>, ok_count: usize) {
        self.with(source, |s| {
            s.probe_ttfb_ms = ttfb_ms;
            s.probe_ok = ok_count.min(u8::MAX as usize) as u8;
            s.probed_at_ms = now_ms();
        });
    }

    /// 测试专用：把探测时间戳倒推 `age_ms` 毫秒，用来验证"探测会过期"。
    ///
    /// 为什么不直接改常量：`PROBE_TTL_MS` 是 `const`，测试里改不动它；
    /// 而等 10 分钟显然不现实。倒推时间戳是唯一能在毫秒级验证过期逻辑的办法。
    #[cfg(test)]
    fn set_probe_age_ms(&self, source: Source, age_ms: u64) {
        self.with(source, |s| {
            s.probed_at_ms = now_ms().saturating_sub(age_ms);
        });
    }

    /// 是否在 429 冷却期内
    pub fn is_cooling(&self, source: Source) -> bool {
        self.with(source, |s| now_ms() < s.cooldown_until_ms)
    }

    /// 这个源**已经证明过**的速度（字节/秒）；还没有足够数据时为 0。
    ///
    /// 用途：判"这条连接是不是坏源"时的参照物。
    /// 用固定的 1 MB/s 当阈值会误伤正常偏慢的连接（实测 BMCLAPI 单连接
    /// 正常就只有 0.83 MB/s），而用"它自己跑出来过的成绩"当参照才对：
    /// 同一个源以前能跑 5 MB/s、这次只有 200 KB/s，那才是真的坏了。
    ///
    /// 需要至少 2 次成功、累计 1 MB 以上才算"证明过" —— 否则几个小文件的
    /// 偶然高速会让之后的正常速度显得"很慢"。
    pub fn proven_bps(&self, source: Source) -> u64 {
        self.with(source, |s| {
            if s.successes < 2 || s.bytes < 1024 * 1024 {
                return 0;
            }
            s.bytes_per_second()
        })
    }

    /// 一次成功的传输
    pub fn note_success(&self, source: Source, bytes: u64, elapsed: Duration) {
        self.with(source, |s| {
            s.attempts += 1;
            s.successes += 1;
            s.bytes = s.bytes.saturating_add(bytes);
            s.elapsed_ms = s.elapsed_ms.saturating_add(elapsed.as_millis() as u64);
            // 用别的源成功不该继续踩着这个源的冷却，但也不主动清 ——
            // 冷却到期自己会失效（is_cooling 用时间判断）。
        });
        self.recover_concurrency();
    }

    /// 一次失败的传输。`status` 是 HTTP 状态码（None = 网络层错误/超时）。
    pub fn note_failure(&self, source: Source, status: Option<u16>) {
        self.with(source, |s| {
            s.attempts += 1;
            s.failures += 1;
            if status == Some(429) {
                s.rate_limited += 1;
            }
        });
        if status == Some(429) {
            self.note_rate_limited(source);
        }
    }

    /// 被限流：指数退避 + 下调并发建议值。
    ///
    /// 冷却时长 = `2^(限流次数-1)` 秒，封顶 60 秒（次数多说明源真的在掐我们）。
    pub fn note_rate_limited(&self, source: Source) {
        let (times, delay) = self.with(source, |s| {
            let times = s.rate_limited.max(1);
            let secs = 1u64 << (times.min(6) - 1); // 1,2,4,8,16,32,64
            (times, Duration::from_secs(secs.min(60)))
        });
        let until = now_ms() + delay.as_millis() as u64;
        self.with(source, |s| s.cooldown_until_ms = until);
        // 并发减半（不低于下限）—— PCL2 的做法：429 之后降并发 + 延迟重试
        let cur = self.concurrency_hint.load(Ordering::Relaxed).max(1) as usize;
        let next = (cur / 2).max(MIN_CONCURRENCY);
        self.concurrency_hint.store(next as u64, Ordering::Relaxed);
        eprintln!(
            "[IEML/source] {} 被限流（第 {} 次），冷却 {}s，并发上限降到 {}",
            source.as_str(),
            times,
            delay.as_secs(),
            next
        );
    }

    /// 冷却结束后慢慢把并发放回去（一次 +25%）。
    pub fn recover_concurrency(&self) {
        let cur = self.concurrency_hint.load(Ordering::Relaxed) as usize;
        if cur >= DEFAULT_CONCURRENCY {
            return;
        }
        let next = (cur + cur / 4 + 1).min(DEFAULT_CONCURRENCY);
        self.concurrency_hint.store(next as u64, Ordering::Relaxed);
    }

    /// ★★ **被"限流页"搪塞了** —— 比 429 更隐蔽，但处理方式一样。
    ///
    /// 背景（实测 2026-09-13，1.19.3 全新安装、并发 32）：
    /// BMCLAPI 对一批库**全部**回了 **146 字节**（任务记录是 286 KB ~ 947 KB）。
    /// 一个 146 字节的响应不是 HTTP 错误，所以我们的 429 逻辑完全看不见它 ——
    /// 它要等到"大小校验失败"才暴露，而那时已经白烧了一次往返 + 一次重试。
    ///
    /// 一次安装里出现十几次 → 每次都要重下 → 用户感觉"下载速度降了好多"。
    ///
    /// 所以调用方（`download_single`）一旦识别出这种响应，就调这里：
    /// 冷却该源 + **把并发砍半**。并发降下来之后 BMCLAPI 就不搪塞了，
    /// 总吞吐反而更高 —— 这正是 PCL2 每起一个 BMCLAPI 线程就
    /// `Thread.Sleep(100)` 想达到的效果，只是我们用实测信号驱动。
    pub fn note_throttled(&self, source: Source) {
        self.with(source, |s| {
            s.rate_limited = s.rate_limited.saturating_add(1);
        });
        // 冷却 5 秒（比 429 的指数退避短：它不是明确的限流码，证据弱一些）
        let until = now_ms() + 5_000;
        self.with(source, |s| s.cooldown_until_ms = until);

        let cur = self.concurrency_hint.load(Ordering::Relaxed).max(1) as usize;
        let next = (cur / 2).max(MIN_CONCURRENCY);
        self.concurrency_hint.store(next as u64, Ordering::Relaxed);
        eprintln!(
            "[IEML/source] {} 回了一个明显过小的响应（限流页），冷却 5s，并发上限降到 {}",
            source.as_str(),
            next
        );
    }

    /// 给批次用的并发建议值（与调用方想要的并发取小）
    pub fn recommended_concurrency(&self, want: usize) -> usize {
        let hint = self.concurrency_hint.load(Ordering::Relaxed) as usize;
        want.min(hint.max(MIN_CONCURRENCY)).max(1)
    }

    /// 当前应该优先用哪个源（健康分高的）。
    ///
    /// 启动阶段调用一次，结果当作整批任务的「期望源」—— 相当于把 PCL2 的
    /// 「官方连得上就优先官方，否则优先镜像」做成了**按历史成败动态决定**，
    /// 而不是每次都花 4 秒去试探。
    pub fn preferred(&self) -> Source {
        if self.score(Source::Mojang) > self.score(Source::Bmclapi) {
            Source::Mojang
        } else {
            Source::Bmclapi
        }
    }

    /// 快照（给前端展示「下载源状态」）
    pub fn snapshot(&self) -> Vec<SourceReport> {
        // ★ 先把统计拷出来、**放掉锁**，再算健康分。
        //   `score()` 自己也要拿同一把锁 —— 在持锁期间调用它就是自死锁
        //   （踩过一次：测试直接挂住 60 秒不返回，进程 CPU 为 0）。
        let stats: HashMap<Source, SourceStats> = {
            let guard = self.stats.lock().unwrap_or_else(|e| e.into_inner());
            guard.clone()
        };
        [Source::Bmclapi, Source::Mojang]
            .into_iter()
            .map(|s| {
                let st = stats.get(&s).cloned().unwrap_or_default();
                SourceReport {
                    source: s.as_str().to_string(),
                    attempts: st.attempts,
                    successes: st.successes,
                    failures: st.failures,
                    rate_limited: st.rate_limited,
                    bytes_per_second: st.bytes_per_second(),
                    cooling_seconds: if now_ms() < st.cooldown_until_ms {
                        ((st.cooldown_until_ms - now_ms()) as f64 / 1000.0).ceil() as u64
                    } else {
                        0
                    },
                    score: self.score(s),
                    // 探测结果也给前端一份：用户看到的不该只是"猜"出来的分，
                    // 还要能看到"实测多少毫秒"，两者对不上时才好判断。
                    probe_ttfb_ms: st.probe_ttfb_ms,
                    probe_ok: st.probe_ok,
                    probed_seconds_ago: if st.probed_at_ms == 0 {
                        None
                    } else {
                        Some(now_ms().saturating_sub(st.probed_at_ms) / 1000)
                    },
                }
            })
            .collect()
    }

    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceReport {
    pub source: String,
    pub attempts: u64,
    pub successes: u64,
    pub failures: u64,
    pub rate_limited: u64,
    pub bytes_per_second: u64,
    pub cooling_seconds: u64,
    pub score: i64,
    /// 启动探测的中位 TTFB（毫秒）；`None` = 没探过，或那次探测该源不可达
    pub probe_ttfb_ms: Option<u32>,
    /// 那次探测成功的端点数（0..=3）
    pub probe_ok: u8,
    /// 距上次探测过了多少秒；`None` = 从未探测
    pub probed_seconds_ago: Option<u64>,
}

static MANAGER: OnceLock<SourceManager> = OnceLock::new();

/// 全局源管理器
pub fn global() -> &'static SourceManager {
    MANAGER.get_or_init(SourceManager::new)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ====================== 等待（可取消） ====================== */

/// 可取消的等待。返回 `false` 表示等待期间被取消。
pub async fn sleep_cancellable(d: Duration, cancel: &super::download::CancelToken) -> bool {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return false;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        tokio::time::sleep(left.min(Duration::from_millis(100))).await;
    }
    !cancel.is_cancelled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn task(url: &str) -> super::super::download::DownloadTask {
        super::super::download::DownloadTask {
            path: PathBuf::from("x.jar"),
            url: url.to_string(),
            urls: vec![],
            sha1: String::new(),
            size: 0,
            label: "x".into(),
        }
    }

    #[test]
    fn candidates_from_single_url_include_mirror_and_official() {
        let m = SourceManager::new();
        let t = task("https://libraries.minecraft.net/a/b.jar");
        let c = candidates_with(&m, &t, Source::Bmclapi);
        assert!(c.len() >= 2);
        // 两个候选必须都能用
        let urls: Vec<&str> = c.iter().map(|(_, u)| u.as_str()).collect();
        assert!(urls.iter().any(|u| u.contains("bmclapi2")));
        assert!(urls.iter().any(|u| u.contains("libraries.minecraft.net")));
    }

    #[test]
    fn candidates_from_explicit_urls_are_deduped() {
        let m = SourceManager::new();
        let mut t = task("https://libraries.minecraft.net/a/b.jar");
        t.urls = vec![
            "https://libraries.minecraft.net/a/b.jar".into(),
            // 同一条镜像地址重复给两次，不该产生重复候选
            "https://libraries.minecraft.net/a/b.jar".into(),
        ];
        let c = candidates_with(&m, &t, Source::Bmclapi);
        let mut seen: Vec<String> = c.iter().map(|(_, u)| u.clone()).collect();
        let before = seen.len();
        seen.sort();
        seen.dedup();
        assert_eq!(before, seen.len(), "候选不能重复：{c:?}");
    }

    #[test]
    fn local_file_task_has_no_http_candidates() {
        let m = SourceManager::new();
        let t = task("file:///tmp/a.jar");
        let c = candidates_with(&m, &t, Source::Bmclapi);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].1, "file:///tmp/a.jar");
    }

    #[test]
    fn concurrency_hint_drops_on_rate_limit_and_recovers() {
        let m = SourceManager::new();
        assert_eq!(m.recommended_concurrency(128), DEFAULT_CONCURRENCY);
        m.note_rate_limited(Source::Bmclapi);
        let after = m.recommended_concurrency(128);
        assert!(after < DEFAULT_CONCURRENCY, "429 之后并发必须下调");
        assert!(after >= MIN_CONCURRENCY);
        // 冷却已生效
        assert!(m.is_cooling(Source::Bmclapi), "429 之后必须处于冷却");
        assert!(m.score(Source::Bmclapi) < 0, "冷却中的源健康分必须为负");
        // 反复恢复正常
        for _ in 0..50 {
            m.recover_concurrency();
        }
        assert_eq!(m.recommended_concurrency(128), DEFAULT_CONCURRENCY);
    }

    #[test]
    fn cooldown_is_per_source() {
        let m = SourceManager::new();
        m.note_rate_limited(Source::Bmclapi);
        assert!(m.is_cooling(Source::Bmclapi));
        // 另一个源不受影响（限流是针对源的，不是全局的）
        assert!(!m.is_cooling(Source::Mojang));
    }

    #[test]
    fn cooling_source_sorts_last() {
        let m = SourceManager::new();
        // 让 bmclapi 有一次成功记录、mojang 刚被限流
        m.note_success(Source::Bmclapi, 10_000_000, Duration::from_millis(500));
        m.note_rate_limited(Source::Mojang);
        let t = task("https://libraries.minecraft.net/a/b.jar");
        let c = candidates_with(&m, &t, Source::Mojang); // 用户"想要"官方源
        // 官方源在冷却 → 必须排到镜像后面去，否则每个文件都先吃一次 429
        assert_eq!(c[0].0, Source::Bmclapi, "{c:?}");
        assert_eq!(c.len(), 2, "排序不该丢掉候选：{c:?}");
    }

    #[test]
    fn preferred_follows_health() {
        let m = SourceManager::new();
        // 初始：两者都是 0 分（成功率按 0/1 算 → 0）→ 默认镜像
        assert_eq!(m.preferred(), Source::Bmclapi);
        // 官方连续成功、镜像被限流 → 应该改成优先官方
        for _ in 0..3 {
            m.note_success(Source::Mojang, 1_000_000, Duration::from_millis(200));
        }
        m.note_rate_limited(Source::Bmclapi);
        assert_eq!(m.preferred(), Source::Mojang);
    }

    #[test]
    fn speed_is_measured() {
        let m = SourceManager::new();
        m.note_success(Source::Bmclapi, 8_000_000, Duration::from_secs(2));
        let snap = m.snapshot();
        let b = snap.iter().find(|r| r.source == "bmclapi").unwrap();
        assert_eq!(b.successes, 1);
        // 8MB / 2s ≈ 4MB/s
        assert!(
            b.bytes_per_second > 3_000_000 && b.bytes_per_second < 5_000_000,
            "实测速度不对：{}",
            b.bytes_per_second
        );
    }

    /// 回归测试（★ 真实踩过）：`snapshot()` 持锁期间调用 `score()`（也要拿同一把锁）
    /// → 自死锁。表现是测试挂住 60 秒不返回、进程 CPU 为 0，非常难查。
    #[test]
    fn snapshot_does_not_self_deadlock() {
        let m = SourceManager::new();
        m.note_failure(Source::Bmclapi, Some(429));
        m.note_success(Source::Mojang, 1_000, Duration::from_millis(10));
        // 还要保证 snapshot 里的 score 与直接调用 score 一致
        let snap = m.snapshot();
        for r in &snap {
            let src = if r.source == "bmclapi" {
                Source::Bmclapi
            } else {
                Source::Mojang
            };
            assert_eq!(r.score, m.score(src), "快照分数必须与实际健康分一致");
        }
        // 快照之后锁必须已经释放：再调一次不该挂
        let _ = m.snapshot();
    }

    /* ---------- 排序策略：国内优先 + 实测延迟 ---------- */

    /// 还没探测过时，默认就得是国内源（落实「国内有的就用国内」）。
    #[test]
    fn domestic_is_preferred_before_any_probe() {
        let m = SourceManager::new();
        assert_eq!(m.preferred(), Source::Bmclapi, "未探测时的默认序必须是国内优先");
    }

    /// ★ 探测发现国内源**三个端点全挂** → 必须让位给官方。
    ///   国内优先的前提是"国内有得用"，没得用时再讲策略就是自欺欺人。
    #[test]
    fn dead_domestic_source_yields_to_official() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, None, 0); // 三端点全失败
        m.note_probe(Source::Mojang, Some(300), 3);
        assert_eq!(
            m.preferred(),
            Source::Mojang,
            "国内源实测不可达时必须改用官方源（国内优先不等于无条件国内）"
        );
        assert!(
            m.score(Source::Mojang) > m.score(Source::Bmclapi),
            "官方的分数必须真的更高：mojang={} bmclapi={}",
            m.score(Source::Mojang),
            m.score(Source::Bmclapi)
        );
    }

    /// ★★ 两边都通、但国内**慢一大截**时，实测必须能翻盘。
    ///   这是「国内优先」和「用延迟低的节点」这两条要求的交界处：
    ///   策略给国内一个**倾向**，不是一张**免死金牌**。
    #[test]
    fn much_slower_domestic_loses_to_official() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, Some(2000), 3); // 通，但很慢
        m.note_probe(Source::Mojang, Some(150), 3); // 快得多
        assert_eq!(
            m.preferred(),
            Source::Mojang,
            "国内 2000ms vs 官方 150ms 时必须选官方（策略加成不该盖过 13 倍差距）"
        );
    }

    /// 但**轻微**落后时仍应保持国内优先 —— 否则策略就形同虚设。
    /// （实测原版版本清单官方快约 300ms，属于这一档。）
    #[test]
    fn slightly_slower_domestic_still_wins() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, Some(640), 3);
        m.note_probe(Source::Mojang, Some(346), 3);
        assert_eq!(
            m.preferred(),
            Source::Bmclapi,
            "国内只慢 300ms 时应当保持国内优先（这是策略，不是缺陷）"
        );
    }

    /// ★ 探测结论**会过期**：源的好坏是时段性的，一次探测不能当永久结论。
    #[test]
    fn stale_probe_is_ignored() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, None, 0); // 探测说国内挂了
        m.note_probe(Source::Mojang, Some(100), 3);
        assert_eq!(m.preferred(), Source::Mojang, "新鲜探测应当生效");

        // 把探测时间戳推到过期之前
        m.set_probe_age_ms(Source::Bmclapi, PROBE_TTL_MS + 1000);
        m.set_probe_age_ms(Source::Mojang, PROBE_TTL_MS + 1000);
        assert_eq!(
            m.preferred(),
            Source::Bmclapi,
            "探测过期后必须退回默认序（国内优先），不能拿旧结论一直压着"
        );
    }

    /// ★ 探测**不得**污染真实传输统计 —— 探测失败 ≠ 这个源坏过。
    ///   两者混在一起会让"健康分"变成一笔糊涂账。
    #[test]
    fn probe_does_not_touch_transfer_stats() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, None, 0);
        m.note_probe(Source::Bmclapi, None, 0);
        let st = {
            let g = m.stats.lock().unwrap();
            g.get(&Source::Bmclapi).cloned().unwrap_or_default()
        };
        assert_eq!(st.attempts, 0, "探测不该算作一次传输尝试");
        assert_eq!(st.failures, 0, "探测失败不该记成传输失败");
        assert_eq!(st.rate_limited, 0, "探测不该被当成限流");
        assert_eq!(st.bytes, 0);
    }

    /// 探测加成必须**单调**：越快分越高，且 1200ms 以上封顶不再加分。
    #[test]
    fn probe_bonus_is_monotonic_and_capped() {
        assert!(probe_bonus(50) > probe_bonus(300), "50ms 必须比 300ms 分高");
        assert!(probe_bonus(300) > probe_bonus(800));
        assert!(probe_bonus(800) > probe_bonus(1199));
        assert_eq!(probe_bonus(1200), 0, "1200ms 及以上不再加分");
        assert_eq!(probe_bonus(9999), 0, "极慢不能变成负分（那是 PROBE_DEAD 的活）");
    }

    /// 限流冷却必须**压过**策略与探测加成 —— 它是"现在别用它"，
    /// 比任何长期倾向都紧急。
    #[test]
    fn cooldown_outranks_domestic_bonus() {
        let m = SourceManager::new();
        m.note_probe(Source::Bmclapi, Some(20), 3); // 探测极快
        m.note_rate_limited(Source::Bmclapi); // 但刚被 429
        assert!(m.score(Source::Bmclapi) < 0, "冷却中的源必须是负分");
        assert_eq!(
            m.preferred(),
            Source::Mojang,
            "国内源被限流时必须立刻改用官方源，哪怕它探测更快"
        );
    }
}
