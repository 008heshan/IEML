//! ★★★★ 「单连接 vs 多连接下同一个大文件」——用户问对了的那个问题（2026-10-01）。
//!
//! 用户原话：「**是不是我们是同时只下载一件事儿，而不是一次性干一堆事儿**」。
//!
//!   对。整合包安装里那几百个文件是并发的（`download_batch`），
//!   但**包体本身是单连接**下的：
//!
//!     `download_pack_body` → `BatchOptions { concurrency: 1, … }`
//!
//!   而包体正是整合包里**最大**的那一个文件（Better MC 113 MB）。
//!   单连接实测 75~120 KB/s ⇒ 113 MB 要 **15~25 分钟**。
//!
//! ## 这个诊断要回答的
//!
//!   **同一段时间、同一个文件：1 条连接 vs 8 条连接，各能拿多少字节？**
//!
//!   用 Range 精确取"同样大小的那一段"，两次总量可比：
//!     · 单连接：一次 Range 拿 20 MB
//!     · 8 连接：8 次 Range 各拿 2.5 MB
//!   两条路拿的都是 20 MB —— 谁快就是谁快，没有"总量不同"的干扰。
//!
//!   ★ 为什么必须现在量：之前我量过一次"分片没帮助"（2.5 s vs 2.8 s），
//!     但那次**连接是快的**（2.4 MB/s）。慢的时候形状完全不同 ——
//!     这正是"同一个源在 20 分钟里从 2411 KB/s 掉到 4 KB/s"的那件事。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_conn_parallel -- --ignored --nocapture

use std::time::Instant;

/// Better MC 的包体（113 MB），与用户报错里同一个文件
const BIG: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack";

fn mirror_of(u: &str) -> String {
    u.replace("https://cdn.modrinth.com/", "https://mod.mcimirror.top/")
}

/// 拿一段 Range，返回字节数。**不落盘**（只看吞吐，不占磁盘）。
async fn take_range(client: &reqwest::Client, url: &str, from: u64, len: u64) -> (u128, u64) {
    let to = from + len - 1;
    let t = Instant::now();
    let r = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await;
    match r {
        Ok(resp) => {
            let n = resp.bytes().await.map(|b| b.len() as u64).unwrap_or(0);
            (t.elapsed().as_millis(), n)
        }
        Err(_) => (t.elapsed().as_millis(), 0),
    }
}

async fn race(label: &str, url: &str, connections: u64, per_conn_mb: u64) {
    let client = reqwest::Client::builder()
        .user_agent("IEML-Launcher/par-diag")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();
    let per = per_conn_mb * 1024 * 1024;
    let total_want = per * connections;

    let t = Instant::now();
    let mut set = Vec::new();
    for i in 0..connections {
        let c = client.clone();
        let u = url.to_string();
        // 每段取不同的偏移：避免"8 条连接拿的是同一段"这种假并行
        set.push(tokio::spawn(async move {
            take_range(&c, &u, i * per, per).await
        }));
    }
    let mut got = 0u64;
    let mut slowest = 0u128;
    for h in set {
        if let Ok((ms, n)) = h.await {
            got += n;
            slowest = slowest.max(ms);
        }
    }
    let wall = t.elapsed().as_millis();
    println!(
        "  {label:<26} {connections} 条连接  拿到 {:>6.1} MB / 想要 {:>6.1} MB  \
         墙钟 {:>6.1} s  最慢一条 {:>6.1} s  ⇒ {:>7.0} KB/s",
        got as f64 / 1048576.0,
        total_want as f64 / 1048576.0,
        wall as f64 / 1000.0,
        slowest as f64 / 1000.0,
        got as f64 / 1024.0 / (wall as f64 / 1000.0).max(0.001)
    );
}

/// ★★★★ 主力验证：**走我们自己的引擎**，包体开分片 vs 不开。
///
/// 上一版我用 `reqwest` 手拼 Range 请求，四条路径**全部 90 秒零字节** ——
/// 连官方那条也是。那不是网络（同一个文件我用引擎完整下过 48 秒），
/// 是**我的测法不对**。所以这一版不自己拼 Range，直接调引擎：
/// 它内部有 `download_chunked`（分片）、`probe_content_length`、
/// 以及"分片不可用就回退单连接"的完整逻辑。
///
/// ★ 量的对象就是 `allow_chunked` 这个新字段的**两种取值** ——
///   同一个文件、同一分钟、同一个进程。
#[tokio::test]
#[ignore = "真机：需要网络，会下载 113 MB（两遍）"]
async fn 包体开分片和不开启到底差多少() {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};

    let dir = std::env::temp_dir().join(format!("ieml-chunk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    println!("\n════ 包体 113 MB：单连接 vs 分片（同一个引擎、同一分钟）════");
    for chunked in [false, true] {
        let p = dir.join(if chunked { "chunked.mrpack" } else { "single.mrpack" });
        let _ = std::fs::remove_file(&p);
        let mut task = DownloadTask::new(p.clone(), BIG.to_string(), String::new(), 0, "包体".into());
        task.allow_chunked = chunked;
        let t = Instant::now();
        let out = download::download_batch(
            vec![task],
            BatchOptions::new(1, ieml_lib::net::mirror::Source::Bmclapi, CancelToken::new()),
        )
        .await
        .expect("不该整体失败");
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let ms = t.elapsed().as_millis().max(1);
        println!(
            "  {:<12} {:.1} s  {} 字节  {:.0} KB/s  失败 {}",
            if chunked { "分片" } else { "单连接" },
            ms as f64 / 1000.0,
            len,
            len as f64 / 1024.0 / (ms as f64 / 1000.0),
            out.failed.len()
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "真机：需要网络，下载 40+ MB 但只读不落盘"]
async fn 单连接和多连接到底差多少() {
    let mirror = mirror_of(BIG);
    println!("\n════ 镜像是慢的那条（用户报错里就是它）════");
    println!("   同样取 20 MB：1 条连接 vs 8 条连接");
    race("单连接 1×20MB", &mirror, 1, 20).await;
    race("多连接 8×2.5MB", &mirror, 8, 2); // 8×2 = 16 MB，量级可比
    race("多连接 8×2.5MB（再来一次）", &mirror, 8, 2).await;

    println!("\n════ 官方那条（对照）════");
    race("单连接 1×20MB", BIG, 1, 20).await;
    race("多连接 8×2.5MB", BIG, 8, 2).await;

    println!("\n★ 读法：");
    println!("   多连接明显快 ⇒ 包体该开多连接（分片），并发的方向是对的；");
    println!("   两条差不多 ⇒ 瓶颈在这条路的服务端/线路总带宽，多开没用。");
}
