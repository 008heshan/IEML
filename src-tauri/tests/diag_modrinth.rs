//! 真机诊断：**Modrinth 按哈希反查到底通不通**（2026-09-30）。
//!
//! 起因：用户报「modr 的下载更是烂」「整合包下载奇慢无比」。
//! 我需要分清两件事，因为修法完全不同：
//!   · **请求形状不对**（镜像/官方拒绝我们的 body）⇒ 改代码就能修；
//!   · **网络不通**（那两条路都被挡）⇒ 换代码没用，只能换源或等。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_modrinth -- --ignored --nocapture

/// 你机器上真实存在的那个 Mod（`fabric-api-0.161.0+26.3.jar`）的 SHA1
const REAL_SHA1: &str = "53f9ee02c3702734d90520aa8c9719bf0e1c8d4f";

#[tokio::test]
#[ignore = "真机：需要网络"]
async fn hash_lookup_over_both_paths() {
    use std::time::Instant;

    println!("\n=== ① 走我们自己的实现（`post_json_third_party`：官方优先 → 错峰换镜像） ===");
    let t = Instant::now();
    match ieml_lib::modrinth::versions_from_hashes(&[REAL_SHA1.to_string()]).await {
        Ok(map) => {
            println!(
                "  ✓ 成功 {:.0} ms —— 命中 {} 个",
                t.elapsed().as_secs_f64() * 1000.0,
                map.len()
            );
            for (sha, v) in &map {
                println!(
                    "      {sha} → {} {}（项目 {}）",
                    v.name, v.version_number, v.project_id
                );
            }
            if map.is_empty() {
                println!(
                    "  ★ 注意：**请求成功但一个都没命中** —— 这不是网络问题，\n\
                     \x20    而是「请求形状被接受、内容没被认出」（或那个文件确实不在库里）。"
                );
            }
        }
        Err(e) => println!(
            "  ✗ 失败 {:.0} ms：{e}\n  ★ 这说明**两条路都没成**",
            t.elapsed().as_secs_f64() * 1000.0
        ),
    }

    println!("\n=== ② 只走镜像那一条（绕开我们那条错峰逻辑） ===");
    let url = "https://mod.mcimirror.top/modrinth/v2/version_files";
    let body = format!(r#"{{"hashes":["{REAL_SHA1}"],"algorithm":"sha1"}}"#);
    let t = Instant::now();
    match ieml_lib::net::post_json_third_party(url, &body).await {
        Ok(text) => println!(
            "  ✓ HTTP OK {:.0} ms，{} 字节：{}",
            t.elapsed().as_secs_f64() * 1000.0,
            text.len(),
            text.chars().take(200).collect::<String>()
        ),
        Err(e) => println!("  ✗ {:.0} ms：{e}", t.elapsed().as_secs_f64() * 1000.0),
    }
}
