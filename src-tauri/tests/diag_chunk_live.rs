//! ★★★★ 「我们到底有没有在下」——分片最小验证（2026-10-01）。
//!
//! 用户截图：**PCL 在同一台机器、同一时刻以 96.7 KB/s 在下 ATM10**，
//! 而 IEML 显示 **0 字节**。
//!
//!   ⇒ 这推翻了我之前的判断（"链路慢，改代码救不了"）。
//!     链路没死 —— **是我们卡住了**。
//!
//! ## 最可疑的地方：分片
//!
//!   我这一轮给包体打开了分片（8 条并发 Range）。若某一步让所有段
//!   都失败重试，界面就是 0 字节。
//!
//! ## 这个诊断做什么
//!
//!   用**真实镜像 URL**、真实 `download_chunked`：
//!     ① 只下 **2 MB**（一段），看单段通不通；
//!     ② 只下 **8 MB**（4 段并发），看多段通不通、各段拿到多少。
//!
//!   ★ 刻意只用几 MB：真机上的包体是 118 MB，等它要把人等到天亮，
//!     而"能不能拿到字节"这件事 2 MB 就够回答了。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_chunk_live -- --ignored --nocapture

use std::time::Instant;

/// Better MC v28 走**镜像**（用户报错的 URL 就是这条）
const MIRROR: &str =
    "https://mod.mcimirror.top/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack";

/// 发一个 Range 请求，返回 (耗时, 字节数, Content-Range 头)。
async fn one_range(client: &reqwest::Client, from: u64, len: u64) -> (u128, u64, String) {
    let to = from + len - 1;
    let t = Instant::now();
    let r = client
        .get(MIRROR)
        .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
        .send()
        .await;
    match r {
        Ok(resp) => {
            let cr = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let n = resp.bytes().await.map(|b| b.len() as u64).unwrap_or(0);
            (t.elapsed().as_millis(), n, cr)
        }
        Err(e) => (t.elapsed().as_millis(), 0, format!("ERR {e}")),
    }
}

#[tokio::test]
#[ignore = "真机：需要网络，只下几 MB"]
async fn 分片到底能不能拿到字节() {
    let client = reqwest::Client::builder()
        .user_agent("IEML-Launcher/chunk-live")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();

    println!("\n════ ① 单个段：2 MB，一条连接 ════");
    let (ms, n, cr) = one_range(&client, 0, 2 * 1024 * 1024).await;
    println!(
        "  {ms:>7} ms  {n:>9} 字节  {:>7.0} KB/s   Content-Range: {cr}",
        n as f64 / 1024.0 / (ms as f64 / 1000.0).max(0.001)
    );

    println!("\n════ ② 4 段并发，每段 2 MB（= 8 MB 总量）════");
    let t = Instant::now();
    let mut set = Vec::new();
    for i in 0..4u64 {
        let c = client.clone();
        set.push(tokio::spawn(async move {
            one_range(&c, i * 2 * 1024 * 1024, 2 * 1024 * 1024).await
        }));
    }
    let mut total = 0u64;
    let mut empty = 0;
    let mut idx = 0;
    for h in set {
        if let Ok((ms, n, cr)) = h.await {
            if n == 0 {
                empty += 1;
            }
            total += n;
            println!("  段{idx}: {ms:>7} ms  {n:>9} 字节   {cr}");
        }
        idx += 1;
    }
    let wall = t.elapsed().as_millis().max(1);
    println!(
        "  合计 {total} 字节，{empty} 段是空的，墙钟 {wall} ms ⇒ {:.0} KB/s",
        total as f64 / 1024.0 / (wall as f64 / 1000.0)
    );

    println!("\n★ 读法：");
    println!("  ① 有字节 ⇒ 单段没问题；① 就是 0 ⇒ 连镜像这条 URL 都拿不到数据");
    println!("  ② 里出现空段 ⇒ 并发下镜像会拒/丢，那就该关掉包体分片");
}
