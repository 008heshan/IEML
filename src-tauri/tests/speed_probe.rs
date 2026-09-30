//! ★★★★ 真机测速（2026-09-30，用户：「curseforge 和 modrinth 的整合包下载真是无敌了，
//! 前者反应快下载慢，后者一点反应也没有」）。
//!
//! 目的只有一个：**把"慢"变成数字**，分清下列三件事，因为修法完全不同：
//!   ① **接口慢**（拿清单/地址的阶段）—— 改并发、改批处理能救；
//!   ② **文件慢**（真下字节的阶段）—— 只能换源，改代码没用；
//!   ③ **源不通**（连不上、超时）—— 需要的是别的候选地址，不是调并发。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test speed_probe -- --ignored --nocapture

use std::time::Instant;

/// 量一次 GET：返回 (状态, 字节数, 毫秒)。失败返回 None。
async fn time_get(client: &reqwest::Client, url: &str, limit_secs: u64) -> Option<(u16, usize, u128)> {
    let t = Instant::now();
    let r = client
        .get(url)
        .timeout(std::time::Duration::from_secs(limit_secs))
        .send()
        .await
        .ok()?;
    let status = r.status().as_u16();
    let body = r.bytes().await.ok()?;
    Some((status, body.len(), t.elapsed().as_millis()))
}

/// 量一次 POST JSON：返回 (状态, 字节数, 毫秒)
async fn time_post(
    client: &reqwest::Client,
    url: &str,
    body: &str,
    limit_secs: u64,
) -> Option<(u16, usize, u128)> {
    let t = Instant::now();
    let r = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .timeout(std::time::Duration::from_secs(limit_secs))
        .send()
        .await
        .ok()?;
    let status = r.status().as_u16();
    let body = r.bytes().await.ok()?;
    Some((status, body.len(), t.elapsed().as_millis()))
}

fn show(tag: &str, r: Option<(u16, usize, u128)>) {
    match r {
        Some((code, len, ms)) => println!(
            "  {tag:<44} HTTP {code:<4} {len:>9} 字节 {ms:>6} ms  {:>8.1} KB/s",
            if ms > 0 { len as f64 / 1024.0 / (ms as f64 / 1000.0) } else { 0.0 }
        ),
        None => println!("  {tag:<44} ✗ 失败/超时"),
    }
}

#[tokio::test]
#[ignore = "真机：需要网络"]
async fn where_does_the_time_actually_go() {
    let client = reqwest::Client::builder()
        .user_agent("IEML-Launcher/speed-probe")
        // 与生产同一个连接超时，量出来的才可比
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();

    println!("\n════ ① 接口层：拿「清单 / 文件地址」要多久 ════");

    // Modrinth 搜"整合包"（列表接口）
    show(
        "Modrinth 官方 搜索整合包",
        time_get(&client, "https://api.modrinth.com/v2/search?query=sodium&limit=5", 20).await,
    );
    show(
        "Modrinth 镜像 搜索整合包",
        time_get(&client, "https://mod.mcimirror.top/modrinth/v2/search?query=sodium&limit=5", 20).await,
    );
    // Modrinth 取"这个项目的所有版本"（装包前必做）
    show(
        "Modrinth 官方 取版本列表",
        time_get(&client, "https://api.modrinth.com/v2/project/sodium/version", 20).await,
    );
    show(
        "Modrinth 镜像 取版本列表",
        time_get(&client, "https://mod.mcimirror.top/modrinth/v2/project/sodium/version", 20).await,
    );

    // CurseForge：搜索与"逐个文件信息"
    show(
        "CF 镜像 搜索整合包",
        time_get(
            &client,
            "https://mod.mcimirror.top/curseforge/v1/mods/search?gameId=432&classId=4471&pageSize=5",
            20,
        )
        .await,
    );
    show(
        "CF 镜像 文件信息（逐个问的那个）",
        time_get(&client, "https://mod.mcimirror.top/curseforge/v1/mods/32274/files/4620310", 20).await,
    );
    show(
        "CF 官方 文件信息",
        time_get(&client, "https://api.curseforge.com/v1/mods/32274/files/4620310", 20).await,
    );

    println!("\n════ ② 文件层：真下字节有多快（这才是「下载慢」的地方）════");

    // Modrinth CDN：一个真实存在的 Mod 文件（约 2.5 MB）
    const MCDN: &str =
        "https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar";
    const MMIR: &str =
        "https://mod.mcimirror.top/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar";
    show("Modrinth 官方 CDN 文件", time_get(&client, MCDN, 25).await);
    show("Modrinth 镜像文件", time_get(&client, MMIR, 25).await);

    // CurseForge 文件：三条实测过的候选
    const CFF: &str = "https://edge.forgecdn.net/files/4620/310/jei-1.20.1-forge-15.2.0.27.jar";
    const CFM: &str = "https://mediafilez.forgecdn.net/files/4620/310/jei-1.20.1-forge-15.2.0.27.jar";
    const CFC: &str = "https://mod.mcimirror.top/files/4620/310/jei-1.20.1-forge-15.2.0.27.jar";
    show("CF 官方 edge.forgecdn", time_get(&client, CFF, 25).await);
    show("CF mediafilez", time_get(&client, CFM, 25).await);
    show("CF mcimirror", time_get(&client, CFC, 25).await);

    println!("\n════ ③ 对照：Mojang 官方与 BMCLAPI（启动时要下的那两类）════");
    show(
        "Mojang libraries",
        time_get(
            &client,
            "https://libraries.minecraft.net/at/yawk/lz4/lz4-java/1.10.1/lz4-java-1.10.1.jar",
            25,
        )
        .await,
    );
    show(
        "BMCLAPI maven",
        time_get(
            &client,
            "https://bmclapi2.bangbang93.com/maven/at/yawk/lz4/lz4-java/1.10.1/lz4-java-1.10.1.jar",
            25,
        )
        .await,
    );
    let _ = time_post(&client, "https://example.invalid/", "{}", 1).await; // 占位，避免 unused 警告

    println!("\n════ ④ 走我们自己的实现：改成镜像优先之后快了多少 ════");
    /*
     * ★★ 这一段是这次改动的**验收判据**。
     *   同一个搜索，走 `get_text_third_party`（镜像优先、官方兜底）要多久 ——
     *   改之前实测**官方那条是 10822 ms**，而镜像只要 908 ms。
     *   改动后应当落在 1 秒上下（先发镜像），而不是十秒。
     */
    for (tag, u) in [
        ("搜索", "https://api.modrinth.com/v2/search?query=sodium&limit=5"),
        ("取版本列表", "https://api.modrinth.com/v2/project/sodium/version"),
    ] {
        let t = Instant::now();
        match ieml_lib::net::get_text_third_party(u).await {
            Ok(txt) => println!(
                "  {tag:<14} ✓ {:.0} ms，{} 字节（镜像优先那条路）",
                t.elapsed().as_secs_f64() * 1000.0,
                txt.len()
            ),
            Err(e) => println!(
                "  {tag:<14} ✗ {:.0} ms：{e}",
                t.elapsed().as_secs_f64() * 1000.0
            ),
        }
    }

    println!("\n★ 读法：① 慢 ⇒ 改并发/批处理；② 慢或失败 ⇒ 只能换源；③ 是启动那条路。");
}
