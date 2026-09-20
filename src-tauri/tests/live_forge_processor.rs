//! 真机验证：**Forge 安装器真的跑了它的 processor，产出了本地生成的 client jar**。
//!
//! ## 为什么必须验这一条
//!
//! Forge 56+ 的版本 JSON 里有这么一条（`26.1.2-64.1.3` 的真实内容）：
//!
//! ```json
//! { "name": "net.minecraftforge:forge:26.1.2-64.1.3:client",
//!   "downloads": { "artifact": {
//!       "path": "net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-client.jar",
//!       "url":  "",                    ← 空：不是下载来的
//!       "size": 77124153 } } }
//! ```
//!
//! 这个 77 MB 的 jar 是 Forge 安装器的 **processor** 拿原版 jar 打补丁
//! **本地生成**的。它跑没跑成，直接决定那个版本能不能启动：
//!
//!   · 跑成了 → 盘上有 `forge-<mc>-<fv>-client.jar`，游戏本体就在 classpath 上；
//!   · 没跑成 → 缺这个文件，**启动必然失败**，而且下载补不了（远程没有它）。
//!
//! 本机实测的对照（2026-09-14）：
//!   `26.2-65.1.3`   → 有 client jar（75.52 MB）✓
//!   `26.1.2-64.1.3` → **没有**（processor 没跑成）✗
//!
//! ## 这条测试做什么
//!
//! 对 `IEML_FORGE_TEST_MC`（默认 `26.1.2`）**重跑一次官方的 Forge 安装器**，
//! 然后断言 `forge-<mc>-<fv>-client.jar` 真的出现在盘上。
//!
//! 跑法：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test live_forge_processor -- --ignored --nocapture
//! ```
//!
//! 默认 `#[ignore]`：要下上百 MB、还要跑好几分钟的 patcher。

use std::sync::Mutex;

use ieml_lib::commands_real::run_loader_installer;
use ieml_lib::net::download::CancelToken;
use ieml_lib::net::mirror::Source;
use ieml_lib::platform::AppPaths;
use ieml_lib::AppState;

/// 从版本 JSON 里读出 Forge 的 `:client` 条目期望的磁盘路径。
fn expected_client_jar(shared: &std::path::Path, version_id: &str) -> Option<std::path::PathBuf> {
    let json = shared
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"));
    let text = std::fs::read_to_string(json).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let libs = v.get("libraries")?.as_array()?;
    for l in libs {
        let name = l.get("name")?.as_str()?;
        if !name.ends_with(":client") || !name.starts_with("net.minecraftforge:forge:") {
            continue;
        }
        let path = l
            .get("downloads")?
            .get("artifact")?
            .get("path")?
            .as_str()?;
        return Some(shared.join("libraries").join(path.replace('/', "\\")));
    }
    None
}

#[tokio::test]
#[ignore = "真机测试：要下上百 MB 并跑 Forge 的 patcher（几分钟）"]
async fn forge_installer_produces_the_generated_client_jar() {
    let paths = AppPaths::resolve();
    let shared = paths.shared.clone();

    let mc = std::env::var("IEML_FORGE_TEST_MC").unwrap_or_else(|_| "26.1.2".into());
    let fv = std::env::var("IEML_FORGE_TEST_FV").unwrap_or_else(|_| "64.1.3".into());
    let version_id = format!("{mc}-forge-{fv}");

    println!("\n=== 被试：{version_id} ===");
    println!("共享目录：{}", shared.display());

    // 原版必须在（Forge 是叠在它上面的，processors 要读它的 jar）
    let parent = shared
        .join("versions")
        .join(&mc)
        .join(format!("{mc}.json"));
    assert!(
        parent.is_file(),
        "原版 {mc} 没装好（{}），Forge 的 patcher 没原料，测不了",
        parent.display()
    );

    // 版本描述必须在（我们靠它知道 client jar 该在哪）
    let expected = expected_client_jar(&shared, &version_id).unwrap_or_else(|| {
        panic!("{version_id} 的版本描述里没有 Forge 的 `:client` 条目 —— 这个版本不是 Forge 56+ 形态？")
    });
    println!("期望的 client jar：{}", expected.display());
    let before = std::fs::metadata(&expected).map(|m| m.len()).unwrap_or(0);
    println!("跑安装器之前：{}", if before > 0 { format!("已存在（{before} 字节）") } else { "不存在".into() });

    // 重跑官方安装器 —— 它会重新执行 processors
    let state = AppState {
        paths: paths.clone(),
        /*
         * ★ 2026-09-20 补：`AppState.running` 从 `Mutex<Option<RunningGame>>`
         *   改成了**按实例 id 索引的表**（beta.6 多开实例），这个集成测试
         *   一直没跟着改 —— `cargo check --tests` 因此红着，而 `pnpm verify`
         *   只跑 `--lib`，所以谁都没看见。
         */
        running: Mutex::new(std::collections::HashMap::new()),
    };
    let cancel = CancelToken::new();
    let progress = |m: String| println!("    · {m}");
    run_loader_installer(
        &mc,
        "forge",
        &fv,
        Source::Bmclapi,
        &state,
        &cancel,
        &progress,
    )
    .await
    .expect("Forge 安装器跑失败");

    // ★ 关键断言：processor 的产物必须真的出现
    let after = std::fs::metadata(&expected).map(|m| m.len()).unwrap_or(0);
    println!("\n跑完之后：{} 字节", after);
    assert!(
        after > 1_000_000,
        "★ Forge 安装器退出码 0，但**本地生成的 client jar 没出现**（{}\n\
         现在只有 {after} 字节）。\n\
         这个文件是 patcher 拿原版 jar 生成的，缺了它这个版本启动必然失败，\n\
         而且下载补不了 —— 远程压根没有这个文件。",
        expected.display()
    );

    println!("✓ {} 的 client jar 已生成（{after} 字节）", version_id);
}
