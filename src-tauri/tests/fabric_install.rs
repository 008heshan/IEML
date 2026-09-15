//! 真机验证：**装一次 Fabric 并确认它的库真的被下载了**。
//!
//! 为什么需要它（用户实测踩到）：
//!   Fabric 的 profile JSON 里，`net.fabricmc:fabric-loader` 与它带的
//!   `org.ow2.asm:*` 走的是**老式 maven 写法**（只有 `name` + `url`，
//!   **没有 `downloads` 字段**）。下载规划只认 `downloads.artifact`，
//!   于是这些库一个都没下 —— 启动时报
//!   `错误: 找不到或无法加载主类 net.fabricmc.loader.impl.launch.knot.KnotClient`
//!   （日志只有 164 字节，看不出原因）。
//!
//! 跑法：
//! ```powershell
//! $env:IEML_FABRIC_TEST=1
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test fabric_install -- --nocapture --ignored
//! ```
//! 默认 `#[ignore]`（要下几十 MB）。数据目录走 `AppPaths::resolve()`，
//! 这样搬迁过数据目录的机器也能复用已缓存的 26.2。

use ieml_lib::net::download::CancelToken;
use ieml_lib::net::installer::{self, InstallOptions, PlanInput};
use ieml_lib::net::metadata::{self, VersionJson};
use ieml_lib::net::mirror::Source;

#[tokio::test]
#[ignore = "要真实下载 Fabric 的库（几十 MB）"]
async fn fabric_libraries_are_actually_downloaded() {
    // ① 拿 Fabric 的 loader 版本与 profile（老式 maven 写法的来源）
    //    ★ 数据目录走 `AppPaths::resolve()`，不要写死 `%APPDATA%\IEML`
    //      —— 数据目录搬走之后，写死的那份会让测试对着一个空目录跑。
    let shared = ieml_lib::platform::AppPaths::resolve().shared;
    let mc = std::env::var("IEML_FABRIC_MC").unwrap_or_else(|_| "26.2".into());

    println!("\n========== Fabric 安装真机验证（MC {mc}）==========");

    let loaders = metadata::fabric_loaders(&mc, Source::Bmclapi)
        .await
        .expect("拉 Fabric loader 列表失败");
    let loader_version = loaders
        .first()
        .map(|e| e.loader.version.clone())
        .expect("没有可用的 Fabric loader");
    println!("  Fabric loader 版本：{loader_version}");

    let profile = metadata::fabric_profile(&mc, &loader_version)
        .await
        .expect("拉 Fabric profile 失败");
    let no_downloads: Vec<String> = profile
        .libraries
        .iter()
        .filter(|l| l.downloads.is_none())
        .map(|l| l.name.clone())
        .collect();
    println!("  profile 里没有 downloads 字段的库：{} 个", no_downloads.len());
    for n in no_downloads.iter().take(5) {
        println!("    · {n}");
    }
    assert!(
        !no_downloads.is_empty(),
        "这个 Fabric profile 居然都有 downloads —— 那本测试就没意义了，请换版本"
    );
    // ★ 关键：这些库必须能被推出下载地址（以前直接跳过）
    for l in profile.libraries.iter().filter(|l| l.downloads.is_none()) {
        assert!(
            l.download_url().is_some(),
            "★ 没有 downloads 的库必须能推出 maven 地址：{}",
            l.name
        );
    }

    // ② 原版 JSON + 合并
    let vanilla_path = shared.join("versions").join(&mc).join(format!("{mc}.json"));
    assert!(vanilla_path.is_file(), "请先在启动器里装好 {mc}");
    let vanilla: VersionJson =
        serde_json::from_str(&std::fs::read_to_string(&vanilla_path).unwrap()).unwrap();
    let merged = installer::merge_versions(&profile, &vanilla);
    println!("  合并后：{} 个库", merged.libraries.len());

    // ③ 真跑一次安装（库都已缓存的话会跳过下载，只补缺的）
    let instance = std::env::temp_dir().join("ieml-fabric-check").join(&mc);
    if instance.is_dir() {
        std::fs::remove_dir_all(&instance).ok();
    }
    std::fs::create_dir_all(&instance).unwrap();

    let input = PlanInput {
        version: merged.clone(),
        shared_root: shared.clone(),
        instance_dir: instance,
        source: Source::Bmclapi,
        download_assets: false,
    };
    let outcome = installer::install(
        &input,
        InstallOptions {
            concurrency: 16,
            download_assets: false,
            asset_limit: Some(0),
            cancel: CancelToken::new(),
            // 测试里不暂停（暂停语义由 download.rs 的单测覆盖）
            pause: None,
            on_progress: std::sync::Arc::new(|_s, _p| {}),
        },
    )
    .await
    .expect("Fabric 安装失败");

    println!(
        "  ✓ 安装完成：{} 个库 · 补下 {} 轮 · 修复 {} 个",
        outcome.libraries_count, outcome.retry_rounds, outcome.repaired_files
    );

    // ④ 独立核对：用**启动侧同一份判据**扫一遍，确认没有本平台该有的库缺失。
    //
    //    ★ 别自己写循环判缺失 —— 我第一版就是这么写的，
    //      于是把 `natives-linux` / `osx-aarch_64` / `java-objc-bridge`
    //      这些**别的平台**的库也算成缺失（正是用户遇到的那个假警报的同款错误）。
    //      判据必须只有一份：`installer::scan_classpath`。
    let scan = installer::scan_classpath(&merged, &shared);
    for n in &scan.missing {
        println!("    ✗ 本平台缺失：{n}");
    }
    assert!(
        scan.missing.is_empty(),
        "★ 装完了还有 {} 个**本平台**的库不在磁盘上（Fabric 起来一定会 ClassNotFoundException）：{:?}",
        scan.missing.len(),
        scan.missing
    );
    println!(
        "  ✓ 启动侧判据扫过：classpath {} 项 · natives {} 个 · 缺失 0 个",
        scan.classpath.len(),
        scan.natives.len()
    );

    // ⑤ 版本 JSON 必须**两个名字都在**（安装侧 / 启动侧的命名约定不同）
    let vdir = shared.join("versions").join(&merged.id);
    for name in [format!("{}.json", merged.id), format!("{mc}.json")] {
        assert!(
            vdir.join(&name).is_file(),
            "★ 缺少 {}（安装/启动两侧会各找一个名字）",
            vdir.join(&name).display()
        );
    }
    println!(
        "  ✓ 版本 JSON 两个名字都在：{}/ 下 {:?}",
        merged.id,
        std::fs::read_dir(&vdir)
            .map(|rd| rd
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>())
            .unwrap_or_default()
    );
    println!("\n✓ Fabric 的库与版本 JSON 都就位");
}
