//! Forge / NeoForge 版本清单的**真实联网**诊断（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_forge_diag -- --ignored --nocapture
//!
//! ## 为什么要有它
//!
//! 用户报「**有 Forge 和 NeoForge 的版本，说没有这些**」。
//! 而 BMCLAPI 的接口实测是有数据的（26.2 有 14 条 Forge、88 条 NeoForge）。
//! 也就是说：**接口对、我们错**。这类"接口有数据但我们返回空"的 bug
//! 只有把整条链的每一步都打印出来才能定位 —— 光看一个空数组永远不知道
//! 是超时、是字段名变了、还是过滤条件写错了。
//!
//! 所以这里逐版本打印：条数 / 第一条 / 最后一条 / 归一化后的结果。

use ieml_lib::net::metadata;
use ieml_lib::net::mirror::Source;

/// 用户会实际去点的那些版本（含最新版与经典版）
const MCS: [&str; 12] = [
    "26.2", "26.1.2", "26.1", "1.21.11", "1.21.9", "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1",
    "1.12.2", "1.7.10",
];

/// ★ 每一个"BMCLAPI 上有 Forge"的版本，我们都必须列出来。
///
///   判据不是"我们内部觉得该有多少条"，而是**接口自己说有**：
///   只要 `/forge/minecraft/{mc}` 返回了非空数组，`forge_versions` 就不许返回空。
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_is_listed_whenever_bmclapi_has_builds() {
    let mut bad: Vec<String> = Vec::new();
    for mc in MCS {
        // ① 原始接口到底给了什么
        let raw = metadata::bmcl_forge_builds(mc).await;
        let raw_desc = match &raw {
            Ok(v) => format!("{} 条", v.len()),
            Err(e) => format!("ERR {e}"),
        };
        // ② 我们的函数给出什么
        let ours = metadata::forge_versions(mc).await;
        let ours_desc = match &ours {
            Ok(v) => format!("{} 条，最新 {}", v.len(), v.first().cloned().unwrap_or_default()),
            Err(e) => format!("ERR {e}"),
        };
        println!("Forge   {mc:<9} 接口 {raw_desc:<12} → 我们 {ours_desc}");

        if let Ok(v) = &raw {
            if !v.is_empty() {
                match &ours {
                    Ok(out) if out.is_empty() => {
                        bad.push(format!("{mc}：接口有 {} 条，我们返回空", v.len()));
                    }
                    Err(e) => bad.push(format!("{mc}：接口有 {} 条，我们报错 {e}", v.len())),
                    _ => {}
                }
            }
        }
    }
    assert!(
        bad.is_empty(),
        "★ 接口有数据、我们却说没有（用户报的就是这个）：\n  {}",
        bad.join("\n  ")
    );
}

/// ★ NeoForge 同理：BMCLAPI 的 `/neoforge/list/{mc}` 有数据就必须列出来。
#[tokio::test]
#[ignore = "需要联网"]
async fn neoforge_is_listed_whenever_bmclapi_has_builds() {
    let mut bad: Vec<String> = Vec::new();
    for mc in MCS {
        let raw = metadata::neoforge_builds_for_mc(mc).await;
        let raw_desc = match &raw {
            Ok(v) => format!("{} 条", v.len()),
            Err(e) => format!("ERR {e}"),
        };
        let ours = metadata::neoforge_versions_for_mc(mc, Source::Bmclapi).await;
        let ours_desc = match &ours {
            Ok(v) => format!("{} 条，最新 {}", v.len(), v.first().cloned().unwrap_or_default()),
            Err(e) => format!("ERR {e}"),
        };
        println!("NeoForge {mc:<9} 接口 {raw_desc:<12} → 我们 {ours_desc}");

        if let Ok(v) = &raw {
            if !v.is_empty() {
                match &ours {
                    Ok(out) if out.is_empty() => {
                        bad.push(format!("{mc}：接口有 {} 条，我们返回空", v.len()));
                    }
                    Err(e) => bad.push(format!("{mc}：接口有 {} 条，我们报错 {e}", v.len())),
                    _ => {}
                }
            }
        }
    }
    assert!(bad.is_empty(), "★ NeoForge 同样：\n  {}", bad.join("\n  "));
}

/// ★ 列表里的版本必须**真的能下载安装器** —— 否则用户选了也是"安装失败"。
///
/// 这条抓到过一个真 bug：1.7.10 的产物名要带分支后缀
/// （`forge-1.7.10-10.13.4.1614-1.7.10-installer.jar`），
/// 我们以前只用 `10.13.4.1614` 去拼 URL → **404**。
#[tokio::test]
#[ignore = "需要联网"]
async fn listed_versions_have_downloadable_installers() {
    let mut bad: Vec<String> = Vec::new();
    // 覆盖新版本、经典版本与"产物名带分支"的 1.7.10
    let mcs = ["26.2", "1.21.11", "1.21.4", "1.20.6", "1.20.1", "1.12.2", "1.7.10"];
    for mc in mcs {
        if let Ok(list) = metadata::forge_versions(mc).await {
            if list.is_empty() {
                println!("· Forge   {mc:<9} 列表为空（接口也空？检查上面的诊断）");
            }
            for v in list.iter().take(2) {
                let url = ieml_lib::net::mirror::forge_installer_url(mc, v, Source::Bmclapi);
                match ieml_lib::net::client().head(&url).send().await {
                    Ok(r) if r.status().is_success() => {
                        println!("✓ Forge   {mc:<9} {v:<22} → HTTP {}", r.status());
                    }
                    Ok(r) => {
                        println!("✗ Forge   {mc:<9} {v:<22} → HTTP {}", r.status());
                        bad.push(format!("Forge {mc} {v}：HTTP {}（{url}）", r.status()));
                    }
                    Err(e) => {
                        println!("✗ Forge   {mc:<9} {v:<22} → {e}");
                        bad.push(format!("Forge {mc} {v}：{e}"));
                    }
                }
            }
        }
        if let Ok(list) = metadata::neoforge_versions_for_mc(mc, Source::Bmclapi).await {
            if let Some(v) = list.first() {
                // 优先走"服务端给的 installerPath"（安装时也是这条）
                let url = metadata::neoforge_builds_for_mc(mc)
                    .await
                    .ok()
                    .and_then(|bs| {
                        bs.iter()
                            .find(|b| b.normalized_version(mc) == *v)
                            .and_then(|b| b.installer_url())
                    })
                    .unwrap_or_else(|| {
                        ieml_lib::net::mirror::neoforge_installer_url_with_mc(mc, v, Source::Bmclapi)
                    });
                match ieml_lib::net::client().head(&url).send().await {
                    Ok(r) if r.status().is_success() => {
                        println!("✓ NeoForge {mc:<9} {v:<22} → HTTP {}", r.status());
                    }
                    Ok(r) => {
                        println!("✗ NeoForge {mc:<9} {v:<22} → HTTP {}", r.status());
                        bad.push(format!("NeoForge {mc} {v}：HTTP {}（{url}）", r.status()));
                    }
                    Err(e) => {
                        println!("✗ NeoForge {mc:<9} {v:<22} → {e}");
                        bad.push(format!("NeoForge {mc} {v}：{e}"));
                    }
                }
            }
        }
    }
    assert!(
        bad.is_empty(),
        "★ 列出来的版本装不上（列表骗了用户）：\n  {}",
        bad.join("\n  ")
    );
}

/// ★ 1.7.10 的产物名必须带分支后缀（实测 maven 里就是这么存的）。
///
///   实测（2026-09-13）：
///     `1.7.10-10.13.4.1614-1.7.10` → HTTP 200 ✅
///     `1.7.10-10.13.4.1614`        → HTTP 404 ❌
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_1_7_10_artifact_names_match_maven() {
    let list = metadata::forge_versions("1.7.10")
        .await
        .expect("1.7.10 的 Forge 清单必须能拿到");
    println!("✓ 1.7.10 共 {} 个版本，前三个：{:?}", list.len(), &list[..3.min(list.len())]);
    assert!(
        list.iter().any(|v| v.contains("-1.7.10")),
        "★ 1.7.10 的产物名要带分支后缀（否则下载 404）：{:?}",
        &list[..5.min(list.len())]
    );
    for v in list.iter().take(3) {
        let url = ieml_lib::net::mirror::forge_installer_url("1.7.10", v, Source::Bmclapi);
        let r = ieml_lib::net::client().head(&url).send().await.unwrap();
        assert!(
            r.status().is_success(),
            "★ 1.7.10 的 {v} 装不上（HTTP {}）：{url}",
            r.status()
        );
        println!("✓ 1.7.10 {v} → HTTP {}", r.status());
    }
}

/// ★ 预发布 MC 版本要能用 `_` 段查到（PCL2 的 #4057 修复）。
///
///   `/forge/minecraft/1.7.10-pre4` → 0 条（错）
///   `/forge/minecraft/1.7.10_pre4` → 10 条（对）
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_prerelease_mc_version_uses_underscore_segment() {
    let list = metadata::forge_versions("1.7.10-pre4")
        .await
        .expect("1.7.10-pre4 的清单必须能拿到");
    assert!(
        !list.is_empty(),
        "★ 1.7.10-pre4 有 Forge（10 条）—— 空列表会让界面说「没有 Forge」"
    );
    println!("✓ 1.7.10-pre4 共 {} 个版本：{:?}", list.len(), &list[..3.min(list.len())]);
}

/// ★★ 回归（用户报的「1.12.2 装不下来」）：老版本 JSON 里的
///    **natives-only 库不许产生任何下载任务**。
///
///    1.12.2 的原版 JSON 有这条（实测从 BMCLAPI 拉的真实数据）：
///    ```json
///    { "name": "net.java.jinput:jinput-platform:2.0.5",
///      "downloads": { "classifiers": { "natives-windows": {…}, … } },
///      "natives": { "windows": "natives-windows" } }
///    ```
///    —— 没有 `downloads.artifact`。而我们的老兜底会拿 maven 坐标拼出
///    `…/jinput-platform-2.0.5.jar`，那个文件**在世界上不存在**
///    （Mojang / BMCLAPI / Forge maven / Maven Central 全 404）。
///    用户看到的就是那条红色报错：
///    「有 1 个文件下载失败（已自动重试 3 轮），例如：库 jinput-platform-2.0.5」
#[tokio::test]
#[ignore = "需要联网"]
async fn legacy_natives_only_library_produces_no_download() {
    let manifest = metadata::fetch_manifest(Source::Bmclapi)
        .await
        .expect("拉版本清单失败");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == "1.12.2")
        .expect("清单里要有 1.12.2");
    let vj: metadata::VersionJson = ieml_lib::net::get_json(&entry.url)
        .await
        .expect("拉 1.12.2 的 JSON 失败");

    let jinput = vj
        .libraries
        .iter()
        .find(|l| l.name.contains("jinput-platform"))
        .expect("1.12.2 的 JSON 里应当有这条 natives-only 库");

    println!(
        "✓ 找到 {}：has_artifact={} natives={:?}",
        jinput.name,
        jinput.has_artifact(),
        jinput.natives
    );
    assert!(
        !jinput.has_artifact(),
        "★ 这条库没有主 jar —— 不许为它生成下载任务（那个文件全网 404）"
    );

    // 它的 natives 仍然必须能拿到（走 downloads.classifiers）
    let c =
        metadata::legacy_natives_classifier(&jinput.natives).expect("应能解出本平台的 classifier");
    assert!(
        jinput
            .downloads
            .as_ref()
            .map(|d| d.classifiers.contains_key(&c))
            .unwrap_or(false),
        "natives {c} 必须能在 classifiers 里找到"
    );
    println!("✓ natives {c} 有对应的 classifier 下载项");
}