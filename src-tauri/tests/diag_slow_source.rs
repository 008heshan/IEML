//! ★★★★ 「慢源重试后仍失败」到底是什么形状（2026-10-01）。
//!
//! 用户截图里的真实错误：
//!   `整合包包体下载失败（换源重试后仍不行）…… 慢（15 秒内仅 4 KB/s，已换源重试）
//!    —— URL: https://mod.mcimirror.top/data/4BV47HRn/versions/bdRJRgs8/…`
//!
//! ## 要回答的两个问题
//!
//!   ① **是"这个节点坏"还是"整个镜像坏"？**
//!      —— 单个连接连打 N 次：若有时快有时慢 ⇒ 是**节点/连接级**的问题，
//!         换一条连接（而不是换一个源）就能救。
//!      —— 若次次都慢 ⇒ 是**整条镜像**的问题，只能换源。
//!
//!   ② **多开连接能不能救？**
//!      8 条连接同时下同一个文件：若总吞吐远高于单连接 ⇒ 那就是解药
//!      （每条约到不同的边缘节点）。
//!
//!   ★ 这两条都没法靠读代码回答 —— 同一个 URL 我在 20 分钟里量到过
//!     4 KB/s / 28 KB/s / 136 KB/s / 194 KB/s / 2411 KB/s，波动 3 个数量级。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_slow_source -- --ignored --nocapture

use std::time::Instant;

fn url_official() -> &'static str {
    "https://cdn.modrinth.com/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack"
}
/// 与用户报错里**同一个版本**（`bdRJRgs8`）走镜像的形状。
/// ★ 用户的 URL 是 `mod.mcimirror.top/data/...`，官方是 `cdn.modrinth.com/data/...`
///   —— 镜像就是官方地址换掉域名，所以这样拼出来的就是用户当时那条。
fn url_mirror() -> String {
    url_official().replace("https://cdn.modrinth.com/", "https://mod.mcimirror.top/")
}

/// 量一次「拿前 1 MB 要多久」——用 Range 请求，**不下载整包**。
///
/// ★ 为什么只拿 1 MB：我要的是"这条连接一开始给不给数据"，
///   而不是"整包多久"。用户报的也是这个形状（15 秒只给 4 KB）。
///   拿整包会把测试拖到几十分钟，而且 113 MB × 多次 = 白烧带宽。
async fn first_megabyte(client: &reqwest::Client, url: &str) -> (u128, usize) {
    let t = Instant::now();
    let r = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-1048575")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    match r {
        Ok(resp) => {
            let n = resp.bytes().await.map(|b| b.len()).unwrap_or(0);
            (t.elapsed().as_millis(), n)
        }
        Err(_) => (t.elapsed().as_millis(), 0),
    }
}

#[tokio::test]
#[ignore = "真机：需要网络"]
async fn 慢源是节点坏还是整条坏() {
    let client = reqwest::Client::builder()
        .user_agent("IEML-Launcher/slow-diag")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();

    println!("\n════ ① 同一条连接序列：连打 6 次「前 1 MB」（镜像）════");
    println!("   （若速度忽快忽慢 ⇒ 是节点/连接级；次次都慢 ⇒ 整条镜像坏）");
    let mirror = url_mirror();
    let mut ok = 0;
    for i in 1..=6 {
        let (ms, n) = first_megabyte(&client, &mirror).await;
        let kbps = n as f64 / 1024.0 / (ms as f64 / 1000.0).max(0.001);
        if n > 100_000 {
            ok += 1;
        }
        println!("   第 {i} 次：{ms:>6} ms  {n:>9} 字节  {kbps:>8.0} KB/s");
    }
    println!("   ⇒ 6 次里 {ok} 次拿到了完整 1 MB");

    println!("\n════ ② 官方那条同样打 3 次（对照）════");
    for i in 1..=3 {
        let (ms, n) = first_megabyte(&client, url_official()).await;
        let kbps = n as f64 / 1024.0 / (ms as f64 / 1000.0).max(0.001);
        println!("   第 {i} 次：{ms:>6} ms  {n:>9} 字节  {kbps:>8.0} KB/s");
    }

    println!("\n════ ③ 8 条连接同时各拿 1 MB（镜像）—— 多连接是不是解药 ════");
    let t = Instant::now();
    let mut set = Vec::new();
    for _ in 0..8 {
        let c = client.clone();
        let u = mirror.clone();
        set.push(tokio::spawn(async move { first_megabyte(&c, &u).await }));
    }
    let mut total = 0usize;
    let mut good = 0usize;
    for h in set {
        if let Ok((_, n)) = h.await {
            total += n;
            if n > 100_000 {
                good += 1;
            }
        }
    }
    let ms = t.elapsed().as_millis().max(1);
    println!(
        "   8 条连接合计 {} 字节（{} 条拿到完整 1 MB），墙钟 {} ms ⇒ {:.0} KB/s",
        total,
        good,
        ms,
        total as f64 / 1024.0 / (ms as f64 / 1000.0)
    );
    println!("   ⇒ 若远高于 ① 的单条速度：**多连接就是解药**（每条落到不同边缘节点）");

    println!("\n★ 读法：");
    println!("   ① 忽快忽慢 + ③ 总量高 ⇒ 改成「慢就换连接/分片」，而不是「慢就换源」；");
    println!("   ① 次次都慢 + ③ 也一样 ⇒ 整条镜像此刻不可用，只能靠官方兜底。");
}
