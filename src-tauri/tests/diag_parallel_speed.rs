//! ★★★★ 「官方 CDN 靠多连接能不能变快」——决定要不要找镜像（2026-10-01）。
//!
//! 用户选了 B：「加一个真正可用的第三方源」。
//!
//!   ★ 但在加源之前有一个更值钱的问题必须先答：
//!     **官方 `cdn.modrinth.com` 能不能靠多连接把速度顶上去？**
//!
//!   如果能 —— 根本不需要镜像，我们自己的分片就能解决。
//!   如果不能（服务端按 IP 限总带宽）—— 那就只能换源，而换源必须
//!   先有一个**验证过能用**的域名（我拒绝猜地址）。
//!
//! ## 为什么这个判断只能靠量
//!
//!   两条 CDN 的限速模型完全相反，而这一点无法从文档看出来：
//!     · **按连接限速** → 多开连接 = 多份带宽（分片就是解药）
//!     · **按 IP 限总带宽** → 多开连接 = 每份更小，总量不变（分片白搭）
//!
//!   本轮早些时候量到过两种相反的形状：
//!     · 4 并发 → 226.8 s，48 并发 → 23.4 s（**快 10 倍** ⇒ 像按连接限速）
//!     · 单连接 2.5 s 下完 7.3 MB，8 段 2.8 s（分片没用 ⇒ 像按 IP 限速）
//!   两次结论相反，说明**速度状态本身在变** —— 所以这次在同一分钟内
//!   做"1 条 vs 8 条"的**同时对照**，而不是跨时间比较。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_parallel_speed -- --ignored --nocapture

use std::time::Instant;

/// 官方 CDN 上一个**确定存在**的大文件（Better MC v28，118 MB）
const OFFICIAL: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack";
/// 同一个文件走镜像
const MIRROR: &str =
    "https://mod.mcimirror.top/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack";

/// 量一段，返回实际拿到的字节数。**超时短**（25 秒）——慢的源不该把测试拖住。
async fn take(client: &reqwest::Client, url: &str, from: u64, len: u64) -> u64 {
    let to = from + len - 1;
    let r = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await;
    match r {
        Ok(resp) => resp.bytes().await.map(|b| b.len() as u64).unwrap_or(0),
        Err(_) => 0,
    }
}

/// 拿 `n` 段、每段 `per` 字节，返回 (总字节, 墙钟毫秒)。**段同时启动**。
async fn measure(label: &str, url: &str, n: u64, per: u64) -> u64 {
    let client = reqwest::Client::builder()
        .user_agent("IEML-Launcher/par-speed")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();
    let t = Instant::now();
    let mut set = Vec::new();
    for i in 0..n {
        let c = client.clone();
        let u = url.to_string();
        set.push(tokio::spawn(async move { take(&c, &u, i * per, per).await }));
    }
    let mut total = 0u64;
    let mut zero = 0u64;
    for h in set {
        match h.await {
            Ok(n) if n > 0 => total += n,
            _ => zero += 1,
        }
    }
    let ms = t.elapsed().as_millis().max(1);
    println!(
        "  {label:<30} {n} 条连接 × {:>4} MB = 想拿 {:>4} MB | 实得 {:>6.1} MB | 空响应 {zero} 条 | \
         {:>5.1} s ⇒ {:>7.0} KB/s",
        per / 1048576,
        n * per / 1048576,
        total as f64 / 1048576.0,
        ms as f64 / 1000.0,
        total as f64 / 1024.0 / (ms as f64 / 1000.0)
    );
    total
}

#[tokio::test]
#[ignore = "真机：需要网络，最多下 ~20 MB"]
async fn http1还是http2的问题() {
    /*
     * ★★★★ 2026-10-01：**这一格是本次调查的转折点。**
     *
     *   同一分钟、同一台机器：
     *     curl（默认 HTTP/1.1）  → 官方 359 KB / 镜像 295 KB / 带我们的 UA 828 KB ✅
     *     reqwest（默认协商 h2） → 官方 0 字节、镜像 0 字节，整齐 20.0 秒超时 ❌
     *
     *   ⇒ 差别不在网络、不在 UA，而在**协议**。
     *     若这条成立，用户看到的"根本不下"就是**我们的 HTTP 客户端**
     *     在这条链路上协商 h2 之后拿不到数据 —— 与源快慢无关。
     *
     *   ★ 这个判据必须用**同一个客户端配置**做对照，只有 `http1_only` 一个变量不同。
     */
    let url = OFFICIAL;
    /*
     * ★ 第二轮：拿到状态码之后体拿不到 ⇒ 嫌疑转向**响应体**这一步。
     *   这一轮把 `gzip` 作为唯一变量（我上面那次开着 `.gzip(true)`，
     *   而 curl 没带 `Accept-Encoding`）。
     */
    for (label, gzip, http1) in [
        ("gzip 开", true, false),
        ("gzip 关", false, false),
        ("gzip 关 + HTTP/1.1", false, true),
    ] {
        let mut b = reqwest::Client::builder()
            .user_agent("IEML-Launcher/http-version-probe")
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(20))
            .gzip(gzip);
        if http1 {
            b = b.http1_only();
        }
        let client = b.build().unwrap();

        let t = Instant::now();
        let got = match client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-1048575")
            .send()
            .await
        {
            Ok(resp) => {
                let ver = resp.version();
                let ce = resp
                    .headers()
                    .get(reqwest::header::CONTENT_ENCODING)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-")
                    .to_string();
                let cl = resp.content_length();
                match resp.bytes().await {
                    Ok(b) => format!(
                        "HTTP {ver:?} / {} 字节 / encoding={ce} / cl={cl:?}",
                        b.len()
                    ),
                    Err(e) => format!("体读取失败：{e}（encoding={ce} cl={cl:?}）"),
                }
            }
            Err(e) => format!("失败：{e}"),
        };
        println!("  {label:<22} {got:<44} {:.1} s", t.elapsed().as_secs_f64());
    }

    for (label, http1_only) in [("默认（可能协商 h2）", false), ("强制 HTTP/1.1", true)] {
        let mut b = reqwest::Client::builder()
            .user_agent("IEML-Launcher/http-version-probe")
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(20))
            .gzip(true);
        if http1_only {
            b = b.http1_only();
        }
        let client = b.build().unwrap();

        let t = Instant::now();
        let got = match client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-1048575")
            .send()
            .await
        {
            Ok(resp) => {
                let ver = resp.version();
                let n = resp.bytes().await.map(|b| b.len() as u64).unwrap_or(0);
                format!("HTTP {ver:?} / {n} 字节")
            }
            Err(e) => format!("失败：{e}"),
        };
        println!(
            "  {label:<22} {got:<34} {:.1} s",
            t.elapsed().as_secs_f64()
        );
    }

    println!("\n★ 读法：强制 HTTP/1.1 能拿到字节、默认拿不到 ⇒ **找到根因了**：");
    println!("   我们的 reqwest 客户端在这条链路上走 h2 拿不到数据。");
    println!("   修法是给下载客户端加 `.http1_only()`（或至少对第三方 CDN 加）。");
}

#[tokio::test]
#[ignore = "真机：需要网络，最多下 ~50 MB"]
async fn 官方多连接能不能变快() {
    const MB: u64 = 1048576;

    println!("\n════ 官方 cdn.modrinth.com：1 条 vs 4 条 vs 8 条（同一分钟内）════");
    let one = measure("官方 1 条 × 6 MB", OFFICIAL, 1, 6 * MB).await;
    let four = measure("官方 4 条 × 1.5 MB", OFFICIAL, 4, 3 * MB / 2).await;
    let eight = measure("官方 8 条 × 0.75 MB", OFFICIAL, 8, 3 * MB / 4).await;

    println!("\n════ 镜像 mcimirror 同样三档 ════");
    let m1 = measure("镜像 1 条 × 6 MB", MIRROR, 1, 6 * MB).await;
    let m4 = measure("镜像 4 条 × 1.5 MB", MIRROR, 4, 3 * MB / 2).await;
    let m8 = measure("镜像 8 条 × 0.75 MB", MIRROR, 8, 3 * MB / 4).await;

    println!("\n★ 读法（这是决定「要不要找镜像」的那一步）：");
    println!("  官方 8 条 ≫ 官方 1 条 ⇒ **按连接限速** ⇒ 我们自己的分片就是解药，不必找镜像");
    println!("  官方 8 条 ≈ 官方 1 条 ⇒ **按 IP 限总带宽** ⇒ 分片没用，只能换源");
    println!("  镜像若明显更快 ⇒ 换源的收益是实的（本轮早些时候量到 1.15 MB/s）");
    println!("\n  本次实得：官方 1/4/8 = {one}/{four}/{eight} 字节");
    println!("           镜像 1/4/8 = {m1}/{m4}/{m8} 字节");
}
