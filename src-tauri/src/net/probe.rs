//! 启动期源延迟探测 —— 「国内优先 + 实测延迟决定次序」里**实测**的那一半。
//!
//! ## 为什么需要它（顺序不能写死）
//!
//! 镜像表的候选顺序原本是**静态**的（谁在前写死）。但 2026-09-16 的逐项实测
//! 表明这个顺序**会翻转**，而且不是整体翻转、是逐项翻转：
//!
//! | 探测项 | 官方 | 国内镜像 | 谁快 |
//! |---|---|---|---|
//! | 原版版本清单 | 346 ms | 639 ms | **官方** |
//! | 原版库文件 asm-9.5 | 1136 ms | 157 ms | **国内** |
//! | Fabric loader jar | 1363 ms | 187 ms | **国内** |
//! | Forge installer jar | 1004 ms | 196 ms | **国内** |
//! | OptiFine 版本列表 | 失败 | 51 ms | **国内** |
//!
//! 所以写死任何一边，都会在另一边更快的时候白白变慢。
//!
//! ## 三条设计约束
//!
//! ① **探测多个端点取中位数，不能只探一个。**
//!    只探"原版版本清单"会系统性偏向官方（那是唯一官方更快的项），
//!    只探"库文件"会系统性偏向国内。取中位数才是对整体倾向的估计。
//!
//! ② **量的是 TTFB（首字节时间），不是总耗时。**
//!    总耗时受文件大小影响 —— 270 KB 的 JSON 和 3 KB 的 JSON 比"谁快"是错的。
//!    `reqwest` 的 `send()` 在**收到响应头**时返回，那一刻就是 TTFB。
//!
//! ③ **绝不阻塞启动，也绝不清空已学到的健康分。**
//!    探测拿不到结果就沿用默认序（国内优先）。探测失败只表示"这次没测到"，
//!    不能据此否定历史成功率 —— 那是 `SourceStats` 的职责，两者互不覆盖。

use super::mirror::{self, Source};
use std::time::{Duration, Instant};

/// 单次探测的超时。整轮探测 = 超时 × 端点批次，必须短到用户察觉不到。
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// 探测端点：**故意只写官方 URL**，镜像侧由 `mirror::mirror_url` 推导。
///
/// 这样有一个额外好处：探测用的正是镜像表自己声称支持的路径 ——
/// 镜像表写错了，探测就会立刻暴露（表现为那个源的中位延迟变差或全失败），
/// 而不是等到用户装游戏时才 404。
const PROBE_URLS: [&str; 3] = [
    // ① 原版元数据（官方更快的那一项，用来抵消偏向）
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    // ② 原版库文件（国内快 7 倍的那一项）
    "https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar",
    // ③ 加载器 meta（国内快、且官方经常整个超时的那一项）
    "https://meta.fabricmc.net/v2/versions/loader",
];

/// 一个源的探测结论
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct ProbeOutcome {
    pub source: Source,
    /// 中位首字节时间（毫秒）。`None` = 三个端点**全部**失败。
    pub ttfb_ms: Option<u32>,
    /// 成功的端点数（0..=3），用来区分"全挂"和"偶尔抖"
    pub ok_count: usize,
}

impl ProbeOutcome {
    /// 这个源还值不值得优先用
    pub fn usable(&self) -> bool {
        self.ttfb_ms.is_some()
    }
}

/// 探测单个源：并发打三个端点，取成功者的**中位** TTFB。
async fn probe_one(source: Source) -> ProbeOutcome {
    // 三个端点并发 —— 串行的话一轮最坏要 3×4=12 秒，启动期不可接受。
    //
    // ★ 这里不用泛型 join 辅助函数：`JoinSet::spawn` 要求输出 `Send`，
    //   写成泛型就得给关联类型加约束（编译报 E0277）。
    //   `probe_ttfb` 的输出是具体的 `Option<u32>`，直接 spawn 即可。
    let mut set = tokio::task::JoinSet::new();
    for official in PROBE_URLS {
        set.spawn(probe_ttfb(mirror::mirror_url(official, source)));
    }

    let mut ok: Vec<u32> = Vec::with_capacity(PROBE_URLS.len());
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(ms)) = joined {
            ok.push(ms);
        }
    }
    ok.sort_unstable();

    let ttfb_ms = if ok.is_empty() {
        None
    } else {
        // 取中位数：3 个取中间那个，2 个取较慢那个，1 个就是它自己
        Some(ok[ok.len() / 2])
    };
    ProbeOutcome {
        source,
        ttfb_ms,
        ok_count: ok.len(),
    }
}

/// 量一个 URL 的 TTFB。任何 HTTP 状态码都算"通了" ——
/// 我们量的是**路通不通、多快**，不是"这个地址有没有这个文件"。
/// （404/403 也证明了对端在正常应答，这跟超时/连不上是两回事。）
async fn probe_ttfb(url: String) -> Option<u32> {
    let t0 = Instant::now();
    let req = super::client().get(&url).timeout(PROBE_TIMEOUT);
    match req.send().await {
        Ok(resp) => {
            let ms = t0.elapsed().as_millis() as u32;
            // 立刻丢弃响应体：我们只要首字节时刻，不下载 270 KB 的 JSON
            drop(resp);
            Some(ms)
        }
        Err(_) => None,
    }
}

/// 并发探测所有源。
pub async fn probe_all() -> Vec<ProbeOutcome> {
    let (a, b) = tokio::join!(probe_one(Source::Bmclapi), probe_one(Source::Mojang));
    vec![a, b]
}

/// 探测一轮并把结果写进**全局源管理器**。
///
/// 调用方应当在启动后 `tokio::spawn` 它（不要 `await` 在关键路径上）：
/// 拿不到结果时 `SourceManager` 会沿用默认序（国内优先），
/// 界面不该为了这次探测多等哪怕 4 秒。
pub async fn refresh_global() -> Vec<ProbeOutcome> {
    let outcomes = probe_all().await;
    let manager = super::source::global();
    for o in &outcomes {
        manager.note_probe(o.source, o.ttfb_ms, o.ok_count);
        eprintln!(
            "[IEML/probe] {} 中位 TTFB = {}（成功 {}/{}）",
            o.source.as_str(),
            match o.ttfb_ms {
                Some(ms) => format!("{ms} ms"),
                None => "不可达".into(),
            },
            o.ok_count,
            PROBE_URLS.len()
        );
    }
    outcomes
}

/// 探测结果的**新鲜度**：超过这个时长就认为过时，需要重测。
///
/// 为什么需要过期：源的好坏是**时段性**的（实测同一天内
/// 官方 Fabric meta 可以从 4/4 成功变成 0/4 超时），
/// 一次探测的结果不能当成永久结论。
pub const PROBE_TTL: Duration = Duration::from_secs(10 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    /// 探测端点必须都是**官方**地址，且镜像侧确实改写得出不同的 URL ——
    /// 否则"探测"就变成对同一个地址打三次，中位数毫无意义。
    #[test]
    fn probe_urls_are_all_mirrorable() {
        for u in PROBE_URLS {
            let mirrored = mirror::mirror_url(u, Source::Bmclapi);
            assert_ne!(
                mirrored, u,
                "{u} 没有镜像变体，作为探测端点等于测了两次官方"
            );
            assert!(
                mirrored.contains("bmclapi"),
                "{u} 的镜像变体不像国内地址：{mirrored}"
            );
            // 官方源不改写
            assert_eq!(mirror::mirror_url(u, Source::Mojang), u);
        }
    }

    /// 端点要覆盖**两类**倾向，否则中位数会系统性偏向一边。
    /// 这条测试是防止有人"顺手精简"掉那个对官方有利的端点。
    #[test]
    fn probe_covers_both_leanings() {
        assert!(
            PROBE_URLS.iter().any(|u| u.contains("piston-meta")),
            "必须保留原版元数据端点：它是官方更快的唯一一项，\
             去掉之后探测会系统性偏向国内"
        );
        assert!(
            PROBE_URLS.iter().any(|u| u.contains("libraries.minecraft.net")),
            "必须保留库文件端点：它代表国内快 7 倍的那一类"
        );
        assert!(
            PROBE_URLS.iter().any(|u| u.contains("meta.fabricmc.net")),
            "必须保留加载器 meta 端点：官方经常整个超时"
        );
    }

    #[test]
    fn outcome_reports_usable_only_when_something_succeeded() {
        let dead = ProbeOutcome { source: Source::Mojang, ttfb_ms: None, ok_count: 0 };
        assert!(!dead.usable());
        let alive = ProbeOutcome { source: Source::Bmclapi, ttfb_ms: Some(120), ok_count: 3 };
        assert!(alive.usable());
    }
}
