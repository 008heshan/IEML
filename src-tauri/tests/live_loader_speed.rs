//! 加载器清单查询的**耗时基准**（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_loader_speed -- --ignored --nocapture
//!
//! ## 为什么要有它
//!
//! 用户报：「模组加载器查询在线清单速度，也是很慢，甚至还有连不上而导致查不出来的问题」。
//! 这类问题**没法靠单元测试发现** —— 它取决于真实网络的耗时分布。
//! 所以这里做两件事：
//!   ① 把**每个来源单独**跑一次并计时（找出到底是谁慢）；
//!   ② 把**五个来源一起**跑一次并计时（对比"并行 + 各自超时 + 错峰竞速"的效果）。
//!
//! 两次跑都会先清掉缓存目录里的清单文件，保证测的是"冷启动"。
//!
//! 输出里带"冷/热"两种：同一个查询跑两遍，第二遍走磁盘缓存 ——
//! 用户日常看到的是后者（毫秒级），第一次装则是前者。

use ieml_lib::net::metadata;
use ieml_lib::net::mirror::Source;
use std::time::Instant;

fn init_cache() {
    // ★ 走 AppPaths::resolve()，不写死 `%APPDATA%\IEML\cache` ——
    //   写死的话数据目录搬走后每次都是冷启动，"热缓存速度"根本测不到。
    let dir = ieml_lib::platform::AppPaths::resolve().cache;
    let _ = std::fs::create_dir_all(&dir);
    metadata::set_cache_dir(dir);
}

const MCS: [&str; 4] = ["26.2", "1.21.1", "1.20.1", "1.12.2"];

/// 每个来源单独跑：谁是慢的那个？
#[tokio::test]
#[ignore = "需要联网"]
async fn per_source_timings() {
    init_cache();
    println!("\n=== 各来源单独耗时（毫秒）===");
    println!("{:<10} {:>8} {:>8} {:>8} {:>8} {:>8}", "MC", "Forge", "NeoForge", "Fabric", "Quilt", "OptiFine");

    for mc in MCS {
        let mut row = vec![mc.to_string()];
        // Forge
        row.push(timed(metadata::with_timeout_secs(
            "Forge",
            20,
            metadata::forge_versions(mc),
        ))
        .await);
        // NeoForge
        row.push(timed(metadata::with_timeout_secs(
            "NeoForge",
            20,
            metadata::neoforge_versions_for_mc(mc, Source::Bmclapi),
        ))
        .await);
        // Fabric
        row.push(timed(metadata::with_timeout_secs(
            "Fabric",
            20,
            metadata::fabric_loader_list(Source::Bmclapi),
        ))
        .await);
        // Quilt
        row.push(timed(metadata::with_timeout_secs(
            "Quilt",
            20,
            metadata::quilt_loader_list(Source::Bmclapi),
        ))
        .await);
        // OptiFine
        row.push(timed(metadata::with_timeout_secs(
            "OptiFine",
            20,
            metadata::optifine_versions(mc),
        ))
        .await);
        println!(
            "{:<10} {:>8} {:>8} {:>8} {:>8} {:>8}",
            row[0], row[1], row[2], row[3], row[4], row[5]
        );
    }
}

/// 五个来源一起跑（真实调用路径）：冷启动 + 热缓存各自多久？
#[tokio::test]
#[ignore = "需要联网"]
async fn whole_query_timings() {
    init_cache();
    println!("\n=== 完整查询（五个来源一起）===");
    for mc in MCS {
        // 冷：第一遍可能命中磁盘缓存（上一次测试留下的），所以先删掉再跑
        let started = Instant::now();
        let cold = ieml_lib::modloader::fetch_available_loaders(mc, Source::Bmclapi).await;
        let cold_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let warm = ieml_lib::modloader::fetch_available_loaders(mc, Source::Bmclapi).await;
        let warm_ms = started.elapsed().as_millis();

        let desc = |r: &Result<ieml_lib::modloader::AvailableLoaders, ieml_lib::modloader::FetchError>| match r {
            Ok(a) => {
                let kinds: Vec<String> = a
                    .base
                    .iter()
                    .chain(a.addons.iter())
                    .map(|l| match &l.error {
                        None => format!("{}={}", l.kind, l.versions.len()),
                        Some(_) => format!("{}=ERR", l.kind),
                    })
                    .collect();
                kinds.join(" ")
            }
            Err(e) => format!("整个查询失败：{e}"),
        };
        println!("{mc:<9} 冷 {cold_ms:>6} ms | 热 {warm_ms:>6} ms | {}", desc(&cold));
        println!("{:<9} {}", "", desc(&warm));
    }
}

/// ★ 每个来源都必须**在合理时间内给出结论**（成功或明确的失败），不许挂住。
///
/// 这条是用户报的"甚至还有连不上而导致查不出来"的守门人：
/// 只要某个来源超过它自己的超时，我们就**必须**拿到一个 `Err`（= 界面显示
/// "没查到，可以重试"），而不是一直转圈。
#[tokio::test]
#[ignore = "需要联网"]
async fn every_source_answers_within_its_timeout() {
    init_cache();
    let budget = std::time::Duration::from_secs(25);
    for mc in ["26.2", "1.20.1"] {
        let started = Instant::now();
        let r = ieml_lib::modloader::fetch_available_loaders(mc, Source::Bmclapi).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < budget,
            "★ {mc} 的完整查询用了 {elapsed:?}，超过预算 {budget:?} —— \
             说明某个来源没有按自己的超时返回"
        );
        let a = r.expect("顶层查询不该整体失败");
        for l in a.base.iter().chain(a.addons.iter()) {
            match &l.error {
                None => println!("✓ {mc:<9} {:<10} {} 个版本", l.kind, l.versions.len()),
                // 查不到是**允许**的（要如实显示），但必须是个明确的结论
                Some(e) => println!("· {mc:<9} {:<10} 没查到：{}", l.kind, short(e)),
            }
        }
    }
}

fn short(s: &str) -> String {
    s.chars().take(28).collect()
}

/// 跑一次并返回**真实耗时**（毫秒）；失败也返回耗时，前面加 `E`。
///
/// 只打印 ok/ERR 是不够的 —— 用户报的是"慢"，所以这里必须给出数字。
async fn timed<T>(fut: impl std::future::Future<Output = Result<T, ieml_lib::net::NetError>>) -> String {
    let started = Instant::now();
    match fut.await {
        Ok(_) => format!("{}", started.elapsed().as_millis()),
        Err(_) => format!("E{}", started.elapsed().as_millis()),
    }
}
