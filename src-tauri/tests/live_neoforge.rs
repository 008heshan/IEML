//! NeoForge 版本清单与安装器地址的**真实联网**验证（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_neoforge -- --ignored --nocapture
//!
//! ## 为什么值得单独留一个
//!
//! 读 PCL 源码时发现（`ModDownload.vb:831`）：
//! **1.20.1 及更早的 NeoForge 发布在 `net/neoforged/forge` 名下**，
//! 1.20.2 起才改成 `net/neoforged/neoforge`。
//! 我们原来一律拼 `neoforge` —— 于是 1.20.1 上点 NeoForge 会 404。
//!
//! 这类坐标错误**编译期发现不了、单元测试也测不出**（除非真去打一次接口），
//! 而用户的感受就是"启动器说没有这个版本"。

use ieml_lib::net::metadata;
use ieml_lib::net::mirror::Source;

/// ★ 1.20.1 必须能列出 NeoForge —— 它确实有（60 条左右）。
///
/// 这条以前会失败：我们只查 `net/neoforged/neoforge`，
/// 而 1.20.1 段的产物在 `net/neoforged/forge`。
#[tokio::test]
#[ignore = "需要联网"]
async fn neoforge_1_20_1_is_listed() {
    let list = metadata::neoforge_versions_for_mc("1.20.1", Source::Bmclapi)
        .await
        .expect("NeoForge 1.20.1 的清单必须能拿到");
    assert!(
        !list.is_empty(),
        "1.20.1 的 NeoForge 是有的（BMCLAPI 实测约 60 条）—— 空列表会让界面说「没查到」"
    );
    println!("✓ 1.20.1 共 {} 个 NeoForge 版本，最新是 {}", list.len(), list[0]);
    // 归一化必须把 `1.20.1-47.1.105` 变成 `47.1.105`（两种格式混在同一个列表里）
    assert!(
        !list.iter().any(|v| v.starts_with("1.20.1-")),
        "★ 版本号必须已剥掉 MC 前缀，否则排序会错（47.1.5 会被排到 47.1.105 后面）：{list:?}"
    );
    assert!(
        list.iter().all(|v| v.starts_with("47.")),
        "1.20.1 的 NeoForge 都是 47.x：{list:?}"
    );
}

/// ★★ 服务端给的 `installerPath` 必须能被我们解析成可下载地址，
///    且**坐标与实测一致**（1.20.1 是 `net/neoforged/forge`）。
#[tokio::test]
#[ignore = "需要联网"]
async fn neoforge_installer_path_is_the_legacy_forge_coordinate() {
    let list = metadata::neoforge_builds_for_mc("1.20.1")
        .await
        .expect("构列表必须能拿到");
    let b = list
        .iter()
        .find(|b| !b.installer_path.is_empty())
        .expect("1.20.1 的记录里应当带 installerPath");
    let url = b.installer_url().expect("installerPath 应当能转成 URL");
    println!("✓ 实测 installerPath：{}", b.installer_path);
    println!("  → {url}");
    assert!(
        url.contains("/net/neoforged/forge/"),
        "★ 1.20.1 的 NeoForge 在旧坐标 net/neoforged/forge 下，实际是 {url}"
    );
    assert!(url.ends_with("-installer.jar"), "必须是安装器 jar：{url}");

    // 而且它对得起"能下载"这三个字
    let resp = ieml_lib::net::client()
        .head(&url)
        .send()
        .await
        .unwrap_or_else(|e| panic!("HEAD {url} 失败：{e}"));
    assert!(
        resp.status().is_success(),
        "★ 服务端给的地址下不了（HTTP {}）：{url}",
        resp.status()
    );
    let len = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    assert!(len > 100_000, "安装器不可能只有 {len} 字节：{url}");
    println!("✓ 安装器大小 {len} 字节");
}

/// 兜底路径（自己拼坐标）也要对 —— 它是在"列表拿不到"时才用的。
/// ★ 这条测试抓到过一个真实的错误：我第一版只把**目录**改成了 `forge/`，
///   文件名仍写 `neoforge-…`，实测 **404**。服务端给的真实路径是
///   `/maven/net/neoforged/forge/1.20.1-47.1.85/forge-1.20.1-47.1.85-installer.jar`
///   —— 目录与文件名**都是** `forge`。
#[tokio::test]
#[ignore = "需要联网"]
async fn fallback_installer_url_coordinate_is_downloadable() {
    // 用列表里真实存在的那一条（写死一个不存在的 build 号会得到"地址对但文件不在"的假失败）
    let list = metadata::neoforge_builds_for_mc("1.20.1")
        .await
        .expect("构列表必须能拿到");
    let b = list
        .iter()
        .find(|b| !b.installer_path.is_empty())
        .expect("应当至少有一条带 installerPath");
    let version = b.version.clone();

    let url =
        ieml_lib::net::mirror::neoforge_installer_url_with_mc("1.20.1", &version, Source::Bmclapi);
    println!("✓ 兜底（1.20.1 / {version}）：{url}");
    let resp = ieml_lib::net::client().head(&url).send().await.unwrap();
    assert!(
        resp.status().is_success(),
        "★ 兜底地址下不了（HTTP {}）：{url}",
        resp.status()
    );

    // 21.x 的新坐标同样要能下载（换一个真实版本号）
    let newer = metadata::neoforge_versions_for_mc("1.21.1", Source::Bmclapi)
        .await
        .expect("1.21.1 的清单必须能拿到");
    let nv = newer.first().expect("1.21.1 应当有 NeoForge 版本");
    let nurl = ieml_lib::net::mirror::neoforge_installer_url_with_mc("1.21.1", nv, Source::Bmclapi);
    println!("✓ 兜底（1.21.1 / {nv}）：{nurl}");
    let nresp = ieml_lib::net::client().head(&nurl).send().await.unwrap();
    assert!(
        nresp.status().is_success(),
        "★ 新坐标地址下不了（HTTP {}）：{nurl}",
        nresp.status()
    );
}
