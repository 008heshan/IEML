//! ★★★★ **为什么 curl 能拿到、我们的引擎拿不到**（2026-10-02）。
//!
//! ## 实测对照（同一分钟）
//!
//!   | | 20 秒拿到 |
//!   |---|---|
//!   | curl 镜像（普通 GET） | **1,588,203 字节** |
//!   | curl 镜像（带 Range） | 1,959,744 字节 |
//!   | curl 官方 | 393,216 ~ 501,568 字节 |
//!   | **我们的引擎（旧行为，单连接）** | **0 字节 / 300 秒后报"所有源都失败"** |
//!
//!   ⇒ 差别不在链路，**在我们的引擎**。这一格就是把差别找出来。
//!
//! ## 已经查清的两件事（本轮）
//!
//!   ① **镜像对未缓存的文件是 302 回源到 `cdn.modrinth.com`** ——
//!      所以"官方 + 镜像"这两条候选对**未缓存**的包**是同一个后端**，
//!      "多源同时下"在这里**没有第二个源可用**。
//!   ② 我们引擎的"依次试源 + 每轮从头开始"实测烧掉 **290 秒**
//!      （第0轮 118.1s · 第1轮 69.6s · 第2轮 53.6s · 第3轮 48.8s）
//!      而**一个字节都没留下** —— 这是与 PCL 的第二个本质差别。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_engine_vs_curl -- --ignored --nocapture

use std::time::Instant;

const OFFICIAL: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";
const MIRROR: &str =
    "https://mod.mcimirror.top/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";

#[tokio::test]
#[ignore = "真机：需要网络，最多下几十 MB"]
async fn 引擎和_curl_差在哪() {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};
    use ieml_lib::net::mirror::Source;

    let dir = std::env::temp_dir().join(format!("ieml-evc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    for (label, url, src) in [
        ("引擎·镜像", MIRROR, Source::Bmclapi),
        ("引擎·官方", OFFICIAL, Source::Mojang),
    ] {
        let p = dir.join(format!("{}.bin", if url == MIRROR { "m" } else { "o" }));
        let _ = std::fs::remove_file(&p);
        let task = DownloadTask::new(p.clone(), url.to_string(), String::new(), 0, "包体".into());

        /*
         * ★ `concurrency: 1` + 不开分片 ⇒ 就是**旧行为**那条路
         *   （单连接、依次试源）。我要看它到底有没有在写盘。
         */
        let t = Instant::now();
        let handle = tokio::spawn(async move {
            download::download_batch(vec![task], BatchOptions::new(1, src, CancelToken::new())).await
        });

        // 每 5 秒看一次盘上写了多少 —— 这是"到底有没有在下"的直接证据
        for i in 1..=6 {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let part = {
                let mut s = p.clone().into_os_string();
                s.push(".part");
                std::path::PathBuf::from(s)
            };
            let n = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            println!("  [{label}] {i:>2}×5s = {:>3}s 盘上 {n:>10} 字节", i * 5);
            if n > 0 && i >= 2 {
                break; // 已经在出数据了，够判定了
            }
        }
        let elapsed = t.elapsed().as_millis();
        println!("  [{label}] 观测 {elapsed} ms 后放弃等待（测试不做完整下载）");
        handle.abort();
    }

    let _ = std::fs::remove_dir_all(&dir);
    println!("\n★ 读法：");
    println!("   盘上一直 0 ⇒ 引擎**根本没在写盘**（连接层就卡住了）；");
    println!("   盘上有字节 ⇒ 引擎在写，只是慢 —— 那问题在「选源/重试策略」，不在传输。");
}
