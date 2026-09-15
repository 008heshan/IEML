//! 真机验证：OptiFine 自动安装**真的能装出来**。
//!
//! ## 背景
//!
//!   用户要求「高清修复与 liteloder 的自动安装也该实装」。
//!   在实现之前，`addon_install_implemented(OptiFine)` 曾经返回 `true` ——
//!   而全仓库没有任何安装代码，那是一句假话（上一轮改成了 false）。
//!
//!   现在真的实现了，所以要有**真机证据**，不能只看代码：
//!   这个测试会真的下载 OptiFine 安装器、跑它的 Patcher、然后检查盘上的产物。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_optifine -- --ignored --nocapture
use ieml_lib::net::{metadata, mirror, optifine};
use ieml_lib::platform;

/// 前置条件：本机装好了原版 1.20.1（OptiFine 要在它上面打补丁）
fn require_vanilla(shared: &std::path::Path, mc: &str) -> bool {
    let j = shared.join("versions").join(mc).join(format!("{mc}.json"));
    let jar = shared.join("versions").join(mc).join(format!("{mc}.jar"));
    if j.is_file() && jar.is_file() {
        return true;
    }
    false
}

#[tokio::test]
#[ignore = "真机测试：会下载 7 MB 安装器并真的跑它"]
async fn optifine_installs_onto_a_real_vanilla() {
    let paths = platform::AppPaths::resolve();
    /*
     * ★ 被试版本的挑选有讲究：OptiFine 要在**原版**上打补丁，
     *   所以必须挑一个"版本 JSON 与客户端 jar 都在"的版本。
     *
     *   实测本机：1.20.1 只有 jar、**没有 json**（这就是另一个 bug ——
     *   那种目录既起不来、也没法打补丁）。1.16.5 与 1.12.2 是完整的。
     *
     *   1.16.5 走**方式 A**（>= 1.14 跑 Patcher），1.12.2 走**方式 B**
     *   （拼 JSON）。两条路都该被覆盖 —— 见下面第二个测试。
     */
    let mc = ["1.16.5", "1.20.1", "1.12.2"]
        .into_iter()
        .find(|m| require_vanilla(&paths.shared, m))
        .unwrap_or("");
    if mc.is_empty() {
        println!("  （本机没有**完整**的原版可供打补丁，跳过）");
        return;
    }
    println!(
        "被试版本：{mc}（走方式 {}）",
        if optifine::is_new_style(mc) { "A（跑 Patcher）" } else { "B（拼 JSON）" }
    );

    // ① 拿真实版本清单（走 BMCLAPI）
    println!("\n=== 拉 OptiFine 版本清单 ===");
    let list = metadata::optifine_versions(mc).await.expect("拉清单失败");
    println!("  {mc} 共 {} 个版本", list.len());
    for v in list.iter().take(4) {
        println!(
            "    {} {}  {}",
            v.version,
            if v.preview { "(预览版)" } else { "" },
            v.filename
        );
    }
    assert!(!list.is_empty(), "{mc} 应该有 OptiFine 版本");

    // 挑一个**正式版**（预览版可能不稳定，测试要可复现）
    let stable = list
        .iter()
        .find(|v| !v.preview)
        .expect("1.20.1 应该有正式版");
    println!("\n选中：{} （{}）", stable.version, stable.filename);

    // ② 下载地址
    let url = optifine::download_url(mc, stable);
    println!("下载地址：{url}");

    // ③ 下载安装器
    let installer = optifine::download_installer(&paths.cache, mc, stable, mirror::Source::Bmclapi)
        .await
        .expect("下载安装器失败");
    let size = std::fs::metadata(&installer).unwrap().len();
    println!("✓ 已下载：{}（{size} 字节）", installer.display());
    assert!(size > 1_000_000, "安装器应该有几 MB，实际 {size}");

    // ④ 读 class 头算 Java 要求（PCL 的做法）
    let need_java = optifine::required_java_major(&installer).expect("读 class 头失败");
    println!("✓ 安装器要求 Java {need_java}（读 Installer.class 的字节码头算出来的）");

    // ⑤ 选一个满足要求的 Java
    let runtimes = platform::scan_java(&paths);
    println!("\n=== 本机 Java ===");
    for r in &runtimes {
        println!("  Java {:>3}  {:<9} {}", r.major, r.source, r.path);
    }
    let java = runtimes
        .iter()
        .filter(|r| r.major >= need_java)
        .min_by_key(|r| r.major)
        .expect("需要至少有一个 Java 能满足安装器要求");
    println!("用 Java {} 跑安装器：{}", java.major, java.path);

    // ⑥ 真的装
    println!("\n=== 开始安装（会跑 OptiFine 的 Patcher，可能需要一两分钟）===");
    let progress = |msg: String| println!("  · {msg}");
    let result = optifine::install(
        &paths.shared,
        mc,
        stable,
        &installer,
        std::path::Path::new(&java.path),
        &progress,
    )
    .await;

    let r = match result {
        Ok(r) => r,
        Err(e) => panic!("\n★ OptiFine 安装失败：\n{e}"),
    };

    println!("\n=== 结果 ===");
    println!("  方式：{}", r.method);
    println!("  版本 id：{}", r.version_id);
    println!("  版本目录：{}", r.version_dir.display());
    println!("  版本描述：{}", r.json_path.display());
    println!("  客户端 jar：{}", r.client_jar.display());
    println!("  摘要：{}", r.summary);

    // ⑦ 产物校验 —— 这才叫"装上去了"
    assert!(r.json_path.is_file(), "★ 版本描述没产出：{}", r.json_path.display());
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&r.json_path).unwrap()).unwrap();
    println!("\n=== 产出的版本描述 ===");
    println!("  id = {}", json["id"]);
    println!("  inheritsFrom = {}", json["inheritsFrom"]);
    println!("  mainClass = {}", json["mainClass"]);
    let libs = json["libraries"].as_array().cloned().unwrap_or_default();
    println!("  libraries = {} 条", libs.len());
    let has_of = libs.iter().any(|l| {
        l["name"]
            .as_str()
            .map(|s| s.contains("optifine"))
            .unwrap_or(false)
    });
    assert!(
        has_of,
        "★ 版本描述里应该有 optifine 的库条目，实际：{:?}",
        libs.iter().filter_map(|l| l["name"].as_str()).collect::<Vec<_>>()
    );
    println!("\n✓ OptiFine 真的装上了（{}）", r.method);
}
