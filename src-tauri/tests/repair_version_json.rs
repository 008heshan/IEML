//! 一次性修复：把本机**"只有 jar、没有版本 JSON"**的版本目录补齐。
//!
//! ## 背景
//!
//!   实测本机有 4 个这样的目录：`1.20.1` / `1.21.1` / `26.1.1` / `rd-132211`。
//!   它们**起不来** —— 启动时找不到版本描述；而且点"重新安装"也修不好
//!   （下载器看到 jar 已经在就跳过，而 json 原来是安装末尾才写的）。
//!
//!   生产代码已经修了（`installer::install` 的自检 + 早写盘），
//!   这个测试负责**把用户现有的那几份补回来** —— 只补 json，
//!   不动已经下好的 jar 与资源文件。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test repair_version_json -- --ignored --nocapture
use ieml_lib::net::metadata::{self, VersionJson};
use ieml_lib::platform;

#[tokio::test]
#[ignore = "真机测试：会联网并把版本 JSON 写进用户的数据目录"]
async fn repair_versions_that_have_jar_but_no_json() {
    let paths = platform::AppPaths::resolve();
    let versions_dir = paths.shared.join("versions");

    // ① 找出所有"只有 jar、没有 json"的目录
    let mut broken: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&versions_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let has_json = dir.join(format!("{name}.json")).is_file();
            let has_jar = dir.join(format!("{name}.jar")).is_file();
            if has_jar && !has_json {
                broken.push(name);
            }
        }
    }
    broken.sort();

    println!("\n=== 体检：只有 jar、没有版本 JSON 的目录 ===");
    if broken.is_empty() {
        println!("  ✓ 没有 —— 都是完整的");
        return;
    }
    for b in &broken {
        println!("  ✗ {b}");
    }

    // ② 拉一次清单，用它把 json 补回来
    println!("\n=== 开始补齐（只补 json，不动已下好的文件）===");
    let manifest = metadata::fetch_manifest(ieml_lib::net::mirror::Source::Bmclapi)
        .await
        .expect("拉版本清单失败");

    let mut fixed = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for name in &broken {
        let Some(entry) = manifest.versions.iter().find(|v| &v.id == name) else {
            // 清单里没有这个 id（例如 rd-132211 这种远古版本可能不在正式清单里）
            println!("  · {name}：版本清单里没有这个 id，跳过（但目录保留）");
            failed.push(format!("{name}（清单里没有这个 id）"));
            continue;
        };
        match ieml_lib::net::get_json::<VersionJson>(&entry.url).await {
            Ok(v) => {
                let dir = versions_dir.join(name);
                let text = serde_json::to_string_pretty(&v).expect("序列化失败");
                match std::fs::write(dir.join(format!("{name}.json")), text) {
                    Ok(()) => {
                        println!(
                            "  ✓ {name}：版本描述已补回（{} 个库，mainClass {}）",
                            v.libraries.len(),
                            v.main_class
                        );
                        fixed += 1;
                    }
                    Err(e) => {
                        println!("  ✗ {name}：写盘失败 {e}");
                        failed.push(format!("{name}（写盘失败：{e}）"));
                    }
                }
            }
            Err(e) => {
                println!("  ✗ {name}：拉版本 JSON 失败 {e}");
                failed.push(format!("{name}（拉取失败：{e}）"));
            }
        }
    }

    // ③ 复查
    println!("\n=== 复查 ===");
    let mut still: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&versions_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            if dir.join(format!("{name}.jar")).is_file()
                && !dir.join(format!("{name}.json")).is_file()
            {
                still.push(name);
            }
        }
    }
    still.sort();
    println!("  修好 {fixed} 个，仍缺 {}", still.len());
    for s in &still {
        println!("    ✗ {s}");
    }

    assert!(
        still.is_empty(),
        "★ 还有 {} 个版本目录缺 json：{still:?}\n\
         （它们起不来；如果清单里没有对应的 id，需要单独处理）",
        still.len()
    );
    println!("\n✓ 所有版本目录都有版本描述了");
}
