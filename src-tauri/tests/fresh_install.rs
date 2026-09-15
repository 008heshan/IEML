//! ★ 复现「下载一个没下过的版本时，最后一个文件必定重试然后失败」
//!
//! 用户的描述里最关键的两个字是「**必定**」—— 网络失败是随机的，
//! 每次都卡在最后一个文件说明是**确定性**的代码问题。
//! 所以这里不再推测，直接在**全新的目录**里完整装一遍，
//! 把每个失败文件的**标签 + 真实错误**打出来。
//!
//! 用法（联网，约几分钟）：
//! ```
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test fresh_install -- --ignored --nocapture
//! ```
//! 用 `IEML_TEST_VERSION` 换版本；用 `IEML_TEST_ASSETS=1` 连资源文件一起下（慢，但最接近首次安装）。
//!
//! **不碰用户真实数据**：共享目录与实例目录都在系统临时目录下，且开跑前清空、
//! 跑完可选保留（`IEML_TEST_KEEP=1`）供事后检查。

use ieml_lib::net::download::{CancelToken, DownloadProgress};
use ieml_lib::net::installer::{self, InstallOptions, PlanInput};
use ieml_lib::net::metadata::{self, VersionJson};
use ieml_lib::net::mirror::Source;
use std::sync::{Arc, Mutex};

/// 把元数据缓存指向真实目录（否则每次都是冷启动，测不出"重复下载"的问题）
fn init_cache() {
    /*
     * ★ 走 `AppPaths::resolve()`，不要写死 `%APPDATA%\IEML\cache`。
     *   数据目录搬到 `D:\IEML` 之后，写死的那条路径下什么都没有 ——
     *   于是每次都是冷启动，"重复下载"这类问题**永远测不出来**，
     *   而测试照样是绿的。
     */
    let dir = ieml_lib::platform::AppPaths::resolve().cache;
    let _ = std::fs::create_dir_all(&dir);
    metadata::set_cache_dir(dir);
}

async fn fetch_version_json(mc: &str) -> VersionJson {
    let manifest = metadata::fetch_manifest(Source::Bmclapi)
        .await
        .expect("拉版本清单失败");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc)
        .unwrap_or_else(|| panic!("清单里没有 {mc}"));
    ieml_lib::net::get_json::<VersionJson>(&entry.url)
        .await
        .expect("拉版本 JSON 失败")
}

#[test]
#[ignore = "需要联网：会真的下载一个完整版本"]
fn fresh_install_records_every_failure() {
    init_cache();
    let mc = std::env::var("IEML_TEST_VERSION").unwrap_or_else(|_| "1.19.4".into());
    let with_assets = std::env::var("IEML_TEST_ASSETS").map(|v| v == "1").unwrap_or(false);
    let keep = std::env::var("IEML_TEST_KEEP").map(|v| v == "1").unwrap_or(false);

    let root = std::env::temp_dir().join("ieml-fresh-install");
    if root.is_dir() {
        std::fs::remove_dir_all(&root).ok();
    }
    // ★ 共享目录全新 = 库和资源一个都没有 = 真正等同"下一个没下过的版本"
    let shared = root.join("shared");
    let instance = root.join("instance");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::create_dir_all(&instance).unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let version = rt.block_on(fetch_version_json(&mc));
    let lib_count = version.libraries.len();

    println!("\n========== 全新安装 {mc} ==========");
    println!("版本 JSON 的库条目：{lib_count}");
    println!("下载资源文件：{with_assets}");
    println!("共享目录：{}\n", shared.display());

    let input = PlanInput {
        version,
        shared_root: shared.clone(),
        instance_dir: instance.clone(),
        source: Source::Bmclapi,
        download_assets: with_assets,
    };

    // 记录进度里"最后一个文件"的名字，便于和失败对账
    let last_seen: Arc<Mutex<(usize, usize, String)>> = Arc::new(Mutex::new((0, 0, String::new())));
    let sink = Arc::clone(&last_seen);
    let on_progress = Arc::new(move |stage: String, p: DownloadProgress| {
        if p.finished_files > 0 {
            let mut g = sink.lock().unwrap();
            *g = (p.finished_files, p.total_files, format!("[{stage}] {}", p.current_file));
        }
    });

    let opts = InstallOptions {
        concurrency: 32,
        download_assets: with_assets,
        asset_limit: None,
        cancel: CancelToken::new(),
        // 测试里不暂停（暂停由 live 测试单独覆盖）
        pause: None,
        on_progress,
    };

    let started = std::time::Instant::now();
    let outcome = rt.block_on(installer::install(&input, opts));
    let elapsed = started.elapsed();
    let (done, total, last) = last_seen.lock().unwrap().clone();
    println!("进度最后停在：{done}/{total}，最后一个文件：{last}");

    match outcome {
        Ok(v) => {
            println!(
                "✅ 安装成功：库 {} 个、资源 {} 个、重试 {} 轮、修复 {} 个",
                v.libraries_count, v.assets_count, v.retry_rounds, v.repaired_files
            );
            /*
             * ★ 把**耗时与吞吐**打出来。
             *
             * 为什么要它：用户报的是「mc 下载速度降了好多」—— 那是一句
             * **相对**的话，没有基线就没法判断"降了"还是"其实一样"。
             * 这里给出可比较的数字：同一个版本、同一台机器、同一张网，
             * 改引擎前后各跑一次就能看出差别。
             */
            let secs = elapsed.as_secs_f64();
            let mb = v.total_bytes as f64 / (1024.0 * 1024.0);
            println!(
                "⏱ 总耗时 {:.1} 秒 · 传输 {:.1} MB · 平均 {:.2} MB/s",
                secs,
                mb,
                if secs > 0.0 { mb / secs } else { 0.0 }
            );
            if !v.failed_assets.is_empty() {
                println!("⚠️ 有 {} 个资源文件失败：", v.failed_assets.len());
                for (name, why) in v.failed_assets.iter().take(10) {
                    println!("    {name} → {why}");
                }
            }
        }
        Err(e) => {
            // ★ 这就是用户看到的现象：报错。把原始信息完整打出来
            panic!("❌ 安装失败：{e}\n（最后一个文件：{last}，进度 {done}/{total}）");
        }
    }

    if !keep {
        std::fs::remove_dir_all(&root).ok();
    } else {
        println!("（保留目录供检查：{}）", root.display());
    }
}
