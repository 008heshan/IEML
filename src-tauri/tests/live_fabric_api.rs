//! 真机验证：Fabric API（前置包）到底能不能自动装上。
//!
//! ## 背景（用户报「Fabic 版本不会自动安装 API 这个 mod」）
//!
//!   界面上一直写着「将自动安装 Fabric API」，`combination.ts` 也会把它列出来，
//!   但用户实测 Fabric 26.2 实例的 `mods/` 目录**是空的**。
//!
//!   三种可能，必须分清（不能猜）：
//!     ① Modrinth 上**真的没有**支持这个 MC 版本的 Fabric API
//!        （26.2 是未来的版本号，很可能确实没有）；
//!     ② 有，但我们查的方式不对（版本过滤条件写错）；
//!     ③ 有、查到了，但下载/落盘失败了。
//!
//!   这个测试把三者逐个问清楚。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_fabric_api -- --ignored --nocapture
use ieml_lib::modrinth;

#[tokio::test]
#[ignore = "真机测试：会联网查 Modrinth"]
async fn fabric_api_lookup_is_diagnosed_per_mc_version() {
    /*
     * 逐版本查，把"有没有"这件事问清楚。
     *
     * ★ 26.2 单独拎出来 —— 用户的实例就是它。如果 Modrinth 确实没有，
     *   那么"装不上"就是**上游的事实**，界面必须如实说
     *   「Modrinth 上还没有支持 26.2 的 Fabric API」，
     *   而不是含糊地报一句"自动安装失败"让用户自己去猜。
     */
    let cases = [
        ("1.20.1", "fabric"),
        ("1.21.1", "fabric"),
        ("26.1.2", "fabric"),
        ("26.2", "fabric"),
        ("1.20.1", "quilt"),
    ];

    println!("\n=== Fabric API / QFAPI 在 Modrinth 上的可用性 ===");
    for (mc, base) in cases {
        let project = if base == "quilt" { "qsl" } else { "fabric-api" };
        match modrinth::project_versions(project, Some(mc), Some(base)).await {
            Ok(v) => {
                if v.is_empty() {
                    println!("  ✗ {project:<12} {mc:<8} +{base:<7} → 查到了，但**没有**匹配的版本");
                } else {
                    let first = &v[0];
                    let file = first
                        .files
                        .iter()
                        .find(|f| f.primary)
                        .or_else(|| first.files.first());
                    println!(
                        "  ✓ {project:<12} {mc:<8} +{base:<7} → {} 个版本，最新 {} 文件 {}",
                        v.len(),
                        first.version_number,
                        file.map(|f| f.filename.clone()).unwrap_or_else(|| "(无文件)".into())
                    );
                }
            }
            Err(e) => println!("  ✗ {project:<12} {mc:<8} +{base:<7} → 请求失败：{e}"),
        }
    }

    // 不限定 MC 版本，看这个 project 一共有哪些版本（判断是我们过滤错了还是真没有）
    println!("\n=== 不带版本过滤（看上游到底有多少版本）===");
    match modrinth::project_versions("fabric-api", None, None).await {
        Ok(all) => {
            println!("  fabric-api 共 {} 个版本", all.len());
            let mut games: Vec<String> = all
                .iter()
                .flat_map(|v| v.game_versions.clone())
                .collect();
            games.sort();
            games.dedup();
            println!("  覆盖的 MC 版本共 {} 个", games.len());
            let tail: Vec<&String> = games.iter().rev().take(12).collect();
            println!("    尾部：{}", tail.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "));

            let has_262 = games.iter().any(|g| g == "26.2");
            println!(
                "\n  → Modrinth 上{}支持 26.2 的 Fabric API",
                if has_262 { "**有**" } else { "**没有**" }
            );
            assert!(
                has_262,
                "★ Modrinth 上应该有支持 26.2 的 Fabric API —— \
                 如果没有，界面就必须如实说'上游还没有'，而不是报一句含糊的失败"
            );
        }
        Err(e) => panic!("查询失败：{e}"),
    }
}

/// ★★ 真的**下载**一遍，证明整条链路通（不只是"查得到"）。
///
///   "查到了"和"装上了"是两件事。用户报的是**装不上**，
///   所以必须把下载与落盘也跑一遍。
#[tokio::test]
#[ignore = "真机测试：会真的下载 Fabric API（约 2 MB）"]
async fn fabric_api_really_installs_into_a_mods_dir() {
    use ieml_lib::net::mirror::Source;

    for (mc, base) in [("26.2", "fabric"), ("1.20.1", "fabric")] {
        let dir = std::env::temp_dir().join(format!("ieml-api-{mc}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        println!("\n=== 真装一次：{mc} + {base} ===");
        let r = ieml_lib::commands_real::install_api_library_for(&dir, mc, base, Source::Bmclapi)
            .await
            .expect("不应该返回 Err（装不成是 Ok(installed=false) + note）");

        println!("  installed = {}", r.installed);
        println!("  version   = {:?}", r.version);
        println!("  filename  = {:?}", r.filename);
        println!("  note      = {:?}", r.note);

        assert!(
            r.installed,
            "★★ {mc} 的 {base} 前置包应该能装上，实际上是：installed=false，原因 {:?}",
            r.note
        );
        let path = r.path.expect("装上了就该有路径");
        let p = std::path::Path::new(&path);
        assert!(p.is_file(), "★ 报告装好了，但磁盘上没有这个文件：{path}");
        let size = std::fs::metadata(p).unwrap().len();
        assert!(size > 100_000, "★ 文件太小（{size} B），可能是错误页面而不是 jar");
        println!("  ✓ 落盘：{path}（{size} 字节）");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
