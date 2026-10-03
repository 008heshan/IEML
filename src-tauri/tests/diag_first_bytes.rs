//! ★★★★ **"起手"有多快** —— 本轮改动的验收判据（2026-10-02）。
//!
//! ## 为什么要单独量这个
//!
//!   与 PCL 最明显的差别不是"平均速度"，而是**开始那几秒**：
//!
//!     实测（`diag_engine_vs_curl`，真实引擎）：
//!       引擎·镜像   5 s: **0 字节**   10 s: 353,474
//!       引擎·官方   5 s:  48,277      10 s:  73,684
//!
//!   而 PCL 一上来就铺 3~8 条连接，**某条先出数据就赢了**。
//!   我们的旧形状是"建连 → 等 → 20 秒超时 / 15 秒判慢 → 才换"。
//!
//! ## 本轮改了三个门槛（就是要治它）
//!
//!   · `CHUNKED_THRESHOLD` 4 MB → **1 MB**（Mod 大多是几百 KB ~ 几 MB）
//!   · `CHUNK_COUNT` 8 → **16**
//!   · `MIN_CHUNK` 2 MB → **1 MB**
//!   · 且**只要有两个以上候选**就起分片（不再只看 `allow_chunked`）
//!
//! ## 这个诊断量什么
//!
//!   同一个文件，开/不开分片各跑一遍，但**只观察前 10 秒**：
//!     · **首字节出现在第几秒**（这是用户感知的"开始下载"）
//!     · **10 秒时盘上有多少字节**（这是"看起来在不在动"）
//!
//!   ★ 不做完整下载：真机上这个包 64 MB、链路只有几十 KB/s，
//!     完整跑一遍要十几分钟，而"起手"这件事 10 秒就够判定。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_first_bytes -- --ignored --nocapture

use std::time::{Duration, Instant};

/// Better MC v40（64 MB，缓存里没有 → 量的就是"装一个新包"的体验）
const URL: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";

fn mirror_of(u: &str) -> String {
    u.replace("https://cdn.modrinth.com/", "https://mod.mcimirror.top/")
}

/// 跑一次，观察 12 秒，返回 (首字节出现的秒数, 结束时盘上字节数)。
async fn watch_first_seconds(label: &str, chunked: bool) -> (Option<f64>, u64) {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};
    use ieml_lib::net::mirror::Source;

    let dir = std::env::temp_dir().join(format!("ieml-fb-{}-{chunked}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("pack.bin");
    let mut task = DownloadTask::new(p.clone(), URL.to_string(), String::new(), 0, "包体".into());
    task.allow_chunked = chunked;
    // ★ 两个候选都给（"多源"要有东西可轮转）
    task.urls = vec![mirror_of(URL)];

    let handle = tokio::spawn(async move {
        download::download_batch(
            vec![task],
            BatchOptions::new(1, Source::Bmclapi, CancelToken::new()),
        )
        .await
    });

    // 每 200 ms 看一次盘：`.part` 与分片段都算（`part_bytes` 同款判据）
    let mut first: Option<f64> = None;
    let t0 = Instant::now();
    let mut total = 0u64;
    while t0.elapsed() < Duration::from_secs(12) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut n = 0u64;
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        n += m.len();
                    }
                }
            }
        }
        if n > 0 && first.is_none() {
            first = Some(t0.elapsed().as_secs_f64());
        }
        total = n;
    }
    handle.abort();

    println!(
        "  {label:<28} 首字节 {:>5}    12 秒时盘上 {:>10} 字节",
        match first {
            Some(s) => format!("{s:.1}s"),
            None => "★ 从没出现".to_string(),
        },
        total
    );
    let _ = std::fs::remove_dir_all(&dir);
    (first, total)
}

#[tokio::test]
#[ignore = "真机：需要网络，共观察 24 秒（不做完整下载）"]
async fn 起手有多快_开与不开分片() {
    println!("\n════ Better MC v40（64 MB，未缓存）——只看前 12 秒 ════");
    println!("   首字节出现得越早、12 秒时字节越多 ⇒ 用户越觉得「在下」\n");

    let (f1, n1) = watch_first_seconds("不开分片（旧形状）", false).await;
    let (f2, n2) = watch_first_seconds("开分片（本轮改动）", true).await;

    println!("\n★ 判据：");
    println!("   · 首字节：{:?} → {:?}", f1, f2);
    println!("   · 12 秒字节：{n1} → {n2}");
    if let (Some(a), Some(b)) = (f1, f2) {
        if b < a {
            println!("   ⇒ 起手早了 {:.1} 秒", a - b);
        }
    }
    if n2 > n1 {
        println!("   ⇒ 12 秒多拿了 {} 字节（{:.1}×）", n2 - n1, n2 as f64 / n1.max(1) as f64);
    }
    println!("   对照：PCL 在 CurseForge 那条路实测 96.7 KB/s。");
}
