//! Fabric API 自动安装的**真实联网**验证（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_apilib -- --ignored --nocapture
//!
//! ## 为什么值得单独跑一次真的
//!
//! 「自动安装 Fabric API」这条链以前是**界面上写着、代码里没有**（ADR-041 的第一类缺陷）。
//! 补上以后仍有两个只有联网才能暴露的坑：
//!
//!   ① 版本号必须**按 MC 版本动态查**。内置表里那句 `0.92.2+1.20.1` 是手抄的，
//!      换个 MC 版本就是错的 artifact —— 所以这里拿两个不同 MC 版本各查一次，
//!      断言查出来的文件名里带的是各自的 MC 版本。
//!   ② Modrinth 的参数写错（loader 名、game_versions 过滤）不会编译错，
//!      只会安静地返回空列表，界面于是显示"这个版本没有 API 包"。
//!
//! 文件名形如 `fabric-api-0.92.2+1.20.1.jar` —— `+` 后面就是它绑定的 MC 版本。

use ieml_lib::commands_real::install_api_library_for;
use ieml_lib::net::mirror::Source;

fn temp_mods_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ieml-apilib-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// 带耗时与完整错误链的包装。
///
/// ★ 为什么每个测试都要它：`error sending request for url` 是个**外壳**，
///   真正的原因（DNS / TLS / 连接重置 / 超时）藏在 `source()` 链里 ——
///   而处理方式完全不同。另外耗时也是证据：180 秒说明是超时，
///   0.3 秒说明是被立刻拒掉。
async fn timed<T>(
    what: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let started = std::time::Instant::now();
    match fut.await {
        Ok(v) => {
            println!("  ⏱ {what}：成功（{:.1}s）", started.elapsed().as_secs_f64());
            Ok(v)
        }
        Err(e) => Err(format!("{what} 失败（{:.1}s）：{e}", started.elapsed().as_secs_f64())),
    }
}

/// ★ 用户的真实症状：装完 Fabric + Mod，进游戏崩，日志只有 `requires fabric-api`。
///   这里验证 1.20.1 真的能自动装上，而且下下来的 jar 真的在 mods 目录里。
#[tokio::test]
#[ignore = "需要联网"]
async fn fabric_api_installs_for_1_20_1() {
    let mods = temp_mods_dir("1201");
    let r = timed(
        "安装 1.20.1 的 Fabric API",
        install_api_library_for(&mods, "1.20.1", "fabric", Source::Bmclapi),
    )
    .await
    .expect("查询/下载本身不该报错");

    assert!(
        r.installed,
        "1.20.1 + fabric 必须有 Fabric API；note = {:?}",
        r.note
    );
    let filename = r.filename.clone().expect("装上了就一定有文件名");
    assert!(
        filename.starts_with("fabric-api"),
        "文件名应当以 fabric-api 开头，实际是 {filename}"
    );
    assert!(
        filename.ends_with(".jar"),
        "必须是 jar（放个 zip 进去游戏不认），实际是 {filename}"
    );
    // ★ 关键断言：版本号必须绑定到 1.20.1，而不是别的 MC 版本
    assert!(
        filename.contains("1.20.1"),
        "★ 下错 MC 版本了：{filename} 里没有 1.20.1 —— \
         这正是「硬编码版本号」会造成的后果"
    );

    let path = std::path::PathBuf::from(r.path.clone().unwrap());
    assert!(path.is_file(), "文件必须真的落盘：{}", path.display());
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    assert!(
        len > 100_000,
        "Fabric API 不可能只有 {len} 字节 —— 多半下到的是一个错误页面"
    );
    println!(
        "✓ 1.20.1 Fabric API：{} ({len} 字节) → {}",
        r.version.unwrap_or_default(),
        path.display()
    );

    let _ = std::fs::remove_dir_all(&mods);
}

/// ★ 换一个 MC 版本必须查到**另一条** artifact。
///   这条断言专门盯"手抄版本号"：如果哪天有人把版本写死回去，
///   两个 MC 版本会拿到同一个文件名，这里立刻红。
#[tokio::test]
#[ignore = "需要联网"]
async fn api_version_follows_mc_version() {
    let mut seen: Vec<(String, String)> = Vec::new();
    for mc in ["1.20.1", "1.21.1"] {
        let mods = temp_mods_dir(&mc.replace('.', "_"));
        let r = timed(
            &format!("{mc} + fabric 的 API 前置包"),
            install_api_library_for(&mods, mc, "fabric", Source::Bmclapi),
        )
        .await
            .expect("查询/下载本身不该报错");
        assert!(r.installed, "{mc} 应当有 Fabric API；note = {:?}", r.note);
        let f = r.filename.clone().unwrap_or_default();
        assert!(f.contains(mc), "{mc} 的包名里必须带 {mc}，实际是 {f}");
        seen.push((mc.to_string(), f));
        let _ = std::fs::remove_dir_all(&mods);
    }
    assert_ne!(
        seen[0].1, seen[1].1,
        "★ 两个 MC 版本拿到了同一个文件名（{}）—— 版本号被写死了",
        seen[0].1
    );
    for (mc, f) in &seen {
        println!("✓ {mc} → {f}");
    }
}

/// Quilt 用的是 QSL 项目（Quilted Fabric API / Quilt Standard Libraries）。
///
/// ★ 这里踩过一次真实的坑：slug 写成 `quilted-fabric-api` 时 Modrinth 回 **404**，
///   而 404 在下载层被当成"网络不好"重试，最后只说一句"自动安装失败"——
///   用户看到的就是"Quilt 整合包永远缺前置包"。**正确的 slug 是 `qsl`**。
#[tokio::test]
#[ignore = "需要联网"]
async fn quilted_fabric_api_installs() {
    let mods = temp_mods_dir("quilt");
    let r = install_api_library_for(&mods, "1.20.1", "quilt", Source::Bmclapi)
        .await
        .expect("查询/下载本身不该报错");
    assert!(
        r.installed,
        "1.20.1 + quilt 必须有 Quilted Fabric API；note = {:?}",
        r.note
    );
    assert_eq!(
        r.project, "qsl",
        "★ Modrinth 上这个项目的 slug 是 qsl —— 写成 quilted-fabric-api 会 404"
    );
    let filename = r.filename.clone().unwrap_or_default();
    assert!(
        filename.contains("1.20.1"),
        "Quilt 的 API 包也要绑定 MC 版本，实际是 {filename}"
    );
    assert!(std::path::Path::new(r.path.as_deref().unwrap()).is_file());
    println!("✓ Quilt：{} → {filename}", r.version.unwrap_or_default());
    let _ = std::fs::remove_dir_all(&mods);
}

/// ★ 钉住 slug 映射本身：两个 slug 都必须**在 Modrinth 上真的存在**。
///
/// 这条测试的价值不在"现在能跑通"，而在"以后 slug 被改错时立刻红"——
/// 上面那两个测试各自只覆盖一个加载器，而这里直接对映射表逐条打接口，
/// 失败信息里会明确写出"这个 slug 在 Modrinth 上是 404"。
#[tokio::test]
#[ignore = "需要联网"]
async fn api_library_slugs_all_resolve() {
    for base in ["fabric", "quilt"] {
        let (slug, kind) = ieml_lib::commands_real::api_library_project(base)
            .unwrap_or_else(|e| panic!("{base} 应当有 API 前置包：{e}"));
        let url = format!("https://api.modrinth.com/v2/project/{slug}");
        let resp = ieml_lib::net::client()
            .get(&url)
            .send()
            .await
            .unwrap_or_else(|e| panic!("{base} → {slug}：请求失败 {e}"));
        assert!(
            resp.status().is_success(),
            "★ {base} 的 API 前置包 slug「{slug}」在 Modrinth 上是 HTTP {} —— \
             slug 写错了，用户会看到「自动安装失败」而不是「这个包不存在」",
            resp.status()
        );
        println!("✓ {base} → {slug}（内部 kind：{kind}）");
    }
    // Forge / NeoForge 明确没有 API 前置包 —— 必须报错，不能返回一个假 slug
    assert!(ieml_lib::commands_real::api_library_project("forge").is_err());
    assert!(ieml_lib::commands_real::api_library_project("neoforge").is_err());
}

/// 不支持的加载器（Forge / NeoForge）要**明确报错**，而不是假装装了个空文件。
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_has_no_api_library() {
    let mods = temp_mods_dir("forge");
    let err = install_api_library_for(&mods, "1.20.1", "forge", Source::Bmclapi)
        .await
        .expect_err("Forge 不需要 API 前置包，这里必须报错而不是静默成功");
    assert!(
        err.contains("不需要"),
        "错误文案要说清原因，实际是：{err}"
    );
    println!("✓ Forge：{err}");
}

/// ★ 先把"这个网络到底能不能连 Modrinth"单独测出来。
///
/// 为什么单独一条：Modrinth 不通和"我们代码写错了"在失败信息里长得一样
/// （都是 `error sending request for url`）—— 不分开的话，
/// 一次网络抖动会让人去改本来正确的代码。
/// 这条只回答一个问题：**这个进程能不能用共享客户端连上 Modrinth**。
///
/// 四个主机各探一次（API / CDN / 两个 mcimirror 前缀），并把 reqwest 的
/// **完整错误链**打出来（`error sending request` 只是个外壳，真正的原因
/// 在 `source()` 里：DNS / TLS / 连接重置，处理方式完全不同）。
#[tokio::test]
#[ignore = "需要联网"]
async fn modrinth_endpoints_reachability_report() {
    let probes = [
        ("官方 API", "https://api.modrinth.com/v2/project/fabric-api"),
        (
            "官方 CDN",
            "https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar",
        ),
        (
            "mcimirror API",
            "https://mod.mcimirror.top/modrinth/v2/project/fabric-api",
        ),
        (
            "mcimirror CDN",
            "https://mod.mcimirror.top/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar",
        ),
    ];
    let mut ok = 0;
    for (name, url) in probes {
        let started = std::time::Instant::now();
        match ieml_lib::net::client().get(url).send().await {
            Ok(r) => {
                ok += 1;
                println!(
                    "✓ {name}：HTTP {} （{:.2}s）",
                    r.status(),
                    started.elapsed().as_secs_f64()
                );
            }
            Err(e) => {
                // ★ 把完整错误链打出来 —— 只看第一层永远是"error sending request"
                let mut chain = format!("{e}");
                let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
                while let Some(s) = src {
                    chain.push_str(&format!(" ← {s}"));
                    src = std::error::Error::source(s);
                }
                println!(
                    "✗ {name}：{chain} （{:.2}s）url={url}",
                    started.elapsed().as_secs_f64()
                );
            }
        }
    }
    assert!(
        ok > 0,
        "★ 四个端点一个都连不上 —— 先排查网络（代理 / 防火墙 / 限流），\
         不要先去改查询代码"
    );
}

/// ★ 单条端点的旧版可达性测试（保留：它是 CI/本地最快的"是不是网络问题"判据）
#[tokio::test]
#[ignore = "需要联网"]
async fn modrinth_api_is_reachable_from_this_process() {
    let url = "https://api.modrinth.com/v2/project/fabric-api/version\
               ?game_versions=%5B%221.20.1%22%5D&loaders=%5B%22fabric%22%5D";
    let r = ieml_lib::net::client().get(url).send().await;
    match r {
        Ok(resp) => {
            let status = resp.status();
            println!("✓ Modrinth 可达：HTTP {status}");
            assert!(status.is_success(), "Modrinth 返回了 HTTP {status}");
        }
        Err(e) => panic!(
            "★ 这个测试进程连不上 api.modrinth.com：{e}\n\
             —— 请先确认是网络问题（代理 / 防火墙 / 限流），\
             而不是 Fabric API 的查询代码有问题。"
        ),
    }
}
