//! ★ 隔离复现：把「客户端 jar」单独下一篇，专门查分片下载为什么失败
//!
//! 用户报「下载没下过的版本时，最后一个文件必定重试然后失败」。
//! 复现测试（`fresh_install`）显示最后那个文件就是**客户端 jar**，
//! 而日志里出现了三种分片失败：
//!   · `HTTP 404`（服务器不支持 Range）→ 回退单连接
//!   · `HTTP 429`（被限流）→ 回退单连接
//!   · `写入文件失败：系统找不到指定的文件 (os error 2)` → **这个不该发生**
//!
//! 这个测试把客户端 jar 从空目录单独下一篇，并列出临时目录里留下了什么
//! （`.part` / `.part.N` / `.part.chunks`），用来定位 os error 2 的来源。
//!
//! 用法：
//! ```
//! $env:IEML_TEST_VERSION='1.19.4'
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test diag_clientjar -- --ignored --nocapture
//! ```

use ieml_lib::net::download::{self, CancelToken, DownloadTask};
use ieml_lib::net::metadata::{self, VersionJson};
use ieml_lib::net::mirror::Source;

fn init_cache() {
    // ★ 走 AppPaths::resolve()，不写死 `%APPDATA%\IEML\cache` ——
    //   数据目录搬走后写死的那条会让这条诊断对着空缓存跑（见 fresh_install.rs）。
    let dir = ieml_lib::platform::AppPaths::resolve().cache;
    let _ = std::fs::create_dir_all(&dir);
    metadata::set_cache_dir(dir);
}

#[test]
#[ignore = "需要联网：会真的下载客户端 jar（约 20-40 MB）"]
fn download_client_jar_alone_and_report() {
    init_cache();
    let mc = std::env::var("IEML_TEST_VERSION").unwrap_or_else(|_| "1.19.4".into());

    let rt = tokio::runtime::Runtime::new().unwrap();

    // 取客户端 jar 的地址与大小
    let manifest = rt
        .block_on(metadata::fetch_manifest(Source::Bmclapi))
        .expect("拉清单失败");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc)
        .unwrap_or_else(|| panic!("清单里没有 {mc}"));
    let vj: VersionJson = rt
        .block_on(ieml_lib::net::get_json(&entry.url))
        .expect("拉版本 JSON 失败");
    let client = vj
        .downloads
        .as_ref()
        .and_then(|d| d.client.as_ref())
        .expect("这个版本 JSON 里没有客户端下载信息");

    println!("\n========== 单独下载客户端 {mc} ==========");
    println!("官方 URL : {}", client.url);
    println!("大小     : {} 字节（{:.1} MB）", client.size, client.size as f64 / 1048576.0);
    println!("SHA1     : {}", client.sha1);

    // ★ 空目录：确保没有任何缓存/断点干扰
    let dir = std::env::temp_dir().join("ieml-clientjar-diag");
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).ok();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(format!("{mc}.jar"));

    let task = DownloadTask::new(
        target.clone(),
        client.url.clone(),
        client.sha1.clone(),
        client.size,
        format!("客户端 {mc}.jar"),
    );

    let t0 = std::time::Instant::now();
    let res = rt.block_on(download::download_one(&task, Source::Bmclapi, &CancelToken::new()));
    let ms = t0.elapsed().as_millis();

    println!("\n结果：{res:?}");
    println!("耗时：{ms} ms");

    // 落盘情况
    if target.is_file() {
        let len = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        println!("落盘文件：{} 字节（期望 {}）", len, client.size);
        let sha = rt.block_on(download::sha1_of_file(&target)).unwrap_or_default();
        println!("实际 SHA1：{sha}");
        println!("SHA1 一致：{}", sha.eq_ignore_ascii_case(&client.sha1));
    } else {
        println!("★ 落盘文件不存在：{}", target.display());
    }

    // 临时残留 —— os error 2 的关键线索
    println!("\n目录里的残留：");
    let mut any = false;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            any = true;
            let meta = e.metadata().ok();
            println!(
                "    {:<40} {:>12} 字节",
                e.file_name().to_string_lossy(),
                meta.map(|m| m.len()).unwrap_or(0)
            );
        }
    }
    if !any {
        println!("    （空）");
    }

    res.expect("客户端 jar 下载必须成功 —— 失败就是用户报的那个 bug");
}

/// ★★ 回归：`.part` 比服务端文件还大时（HTTP 416），必须**清掉重下**而不是放弃。
///
/// 这是用户报的「最后一个文件必定重试然后失败」的真凶：
///   · 续传带 `Range: bytes=<.part 大小>-`，而那个 `.part` 是上次失败留下的、比文件还大
///   · 服务端回 **416 Range Not Satisfiable**
///   · 旧代码把它当成"这源不行"→ 换源 → 还是 416 → 补下三轮全败
///   · 全程**没有删过那个坏 .part**，所以永远好不了
///
/// 这个测试人为造出那个场景：先写一个比真实文件大的 `.part`，再下载。
#[test]
#[ignore = "需要联网：会真的下载一个小文件"]
fn stale_part_larger_than_file_recovers() {
    init_cache();
    let rt = tokio::runtime::Runtime::new().unwrap();

    // 用一个**小**文件来测（快）：从 1.19.4 的资源索引里取个小 json
    let mc = std::env::var("IEML_TEST_VERSION").unwrap_or_else(|_| "1.19.4".into());
    let manifest = rt
        .block_on(metadata::fetch_manifest(Source::Bmclapi))
        .expect("拉清单失败");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc)
        .unwrap_or_else(|| panic!("清单里没有 {mc}"));
    let vj: VersionJson = rt
        .block_on(ieml_lib::net::get_json(&entry.url))
        .expect("拉版本 JSON 失败");
    let asset_idx = vj.asset_index.as_ref().expect("这个版本没有资源索引");

    // 拉索引，挑一个 size 最小的资源对象
    let idx_text = rt
        .block_on(ieml_lib::net::get_text(&asset_idx.url))
        .expect("拉资源索引失败");
    #[derive(serde::Deserialize)]
    struct Idx {
        objects: std::collections::HashMap<String, Obj>,
    }
    #[derive(serde::Deserialize)]
    struct Obj {
        hash: String,
        size: u64,
    }
    let idx: Idx = serde_json::from_str(&idx_text).expect("解析资源索引失败");
    let (name, obj) = idx
        .objects
        .iter()
        .filter(|(_, o)| o.size > 0)
        .min_by_key(|(_, o)| o.size)
        .expect("索引里没有资源对象");

    let dir = std::env::temp_dir().join("ieml-416-diag");
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).ok();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("asset.bin");
    let part = dir.join("asset.bin.part");

    // ★ 造出"坏 .part"：比服务端的文件**大**（这就是 416 的触发条件）
    std::fs::write(&part, vec![0u8; (obj.size + 4096) as usize]).unwrap();
    println!("\n========== 416 恢复测试 ==========");
    println!("资源：{name}（{} 字节）", obj.size);
    println!("人为造的坏 .part：{} 字节（比文件大 4096）", obj.size + 4096);

    let task = DownloadTask::new(
        target.clone(),
        format!(
            "https://resources.download.minecraft.net/{}",
            ieml_lib::net::metadata::asset_rel_path(&obj.hash)
        ),
        obj.hash.clone(),
        obj.size,
        format!("资源 {name}"),
    );

    let res = rt.block_on(download::download_one(&task, Source::Bmclapi, &CancelToken::new()));
    println!("结果：{res:?}");

    match res {
        Ok(_) => {
            let len = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            println!("✅ 恢复了：落盘 {len} 字节（期望 {}）", obj.size);
            assert_eq!(len, obj.size, "文件大小要对");
        }
        Err(e) => panic!(
            "❌ 没能从 416 恢复：{e}\n这就是用户报的「必定失败」—— 坏的 .part 必须在 416 时被清掉"
        ),
    }

    std::fs::remove_dir_all(&dir).ok();
}
