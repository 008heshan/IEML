//! 真机验证：**Forge / NeoForge 到底能不能装上**。
//!
//! 为什么需要它：代码里 `run_loader_installer` 早就接好了
//! （`--installClient <shared> --mirror <bmclapi>`，并补 `launcher_profiles.json`），
//! 但 README 一直写着"未实现"，**没有任何测试跑过它**。
//! 这种"写了但从没跑过"的路径最容易在用户那里炸。
//!
//! 这个测试绕过 Tauri 命令层（那需要 AppState），直接复刻命令里的每一步：
//!   ① 下载 installer jar（BMCLAPI 镜像）
//!   ② 准备 shared/launcher_profiles.json
//!   ③ java -jar installer.jar --installClient <shared> --mirror <...>
//!   ④ 断言：产出 `versions/{mc}-forge-{ver}/`，且里面有版本 JSON 和库
//!
//! 跑法：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test forge_install -- --nocapture --ignored
//! ```
//! 环境变量：IEML_FORGE_MC=1.20.1 · IEML_FORGE_VER=47.2.0 · IEML_FORGE_KIND=forge

use ieml_lib::net::download::{download_one, CancelToken, DownloadTask};
use ieml_lib::net::mirror::{self, Source};
use std::path::PathBuf;
use std::process::Stdio;

fn data_root() -> PathBuf {
    // ★ 走 AppPaths::resolve()：写死 `%APPDATA%\IEML` 会在数据目录搬走后
    //   让这条测试对着空目录跑（详见 launch_smoke.rs 里的说明）。
    ieml_lib::platform::AppPaths::resolve().root
}

#[tokio::test]
#[ignore = "要下载并运行 Forge 官方安装器（几十 MB）"]
async fn forge_installer_actually_installs() {
    let mc = std::env::var("IEML_FORGE_MC").unwrap_or_else(|_| "1.20.1".into());
    let ver = std::env::var("IEML_FORGE_VER").unwrap_or_else(|_| "47.2.0".into());
    let kind = std::env::var("IEML_FORGE_KIND").unwrap_or_else(|_| "forge".into());
    let data = data_root();
    let shared = data.join("shared");

    println!("\n========== {kind} 安装真机验证（MC {mc} · {ver}）==========");

    // ① installer jar
    let url = match kind.as_str() {
        "forge" => mirror::forge_installer_url(&mc, &ver, Source::Bmclapi),
        "neoforge" => mirror::neoforge_installer_url(&ver, Source::Bmclapi),
        other => panic!("不认识的加载器 {other}"),
    };
    println!("  安装器 URL：{url}");
    let jar = std::env::temp_dir()
        .join("ieml-forge-check")
        .join(format!("{kind}-{mc}-{ver}-installer.jar"));
    std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
    let task = DownloadTask::new(
        jar.clone(),
        url.clone(),
        String::new(),
        0,
        format!("{kind} 安装器"),
    );
    match download_one(&task, Source::Bmclapi, &CancelToken::new()).await {
        Ok(_) => println!("  ✓ 安装器已下载：{} B", jar.metadata().unwrap().len()),
        Err(e) => {
            // **这条很重要**：如果连安装器都下不下来，那 Forge 就是装不了的，
            // 不能报"已实现"。让测试失败，把真相留在日志里。
            panic!("★ 连 {kind} 安装器都下载失败：{e}\n  URL: {url}");
        }
    }

    // ② launcher_profiles.json（安装器的硬性要求）
    std::fs::create_dir_all(&shared).unwrap();
    let profiles = shared.join("launcher_profiles.json");
    if !profiles.is_file() {
        std::fs::write(
            &profiles,
            serde_json::json!({
                "profiles": { "(Default)": { "name": "(Default)", "lastVersionId": mc } }
            })
            .to_string(),
        )
        .unwrap();
        println!("  ✓ 补了最小的 launcher_profiles.json（安装器硬性要求）");
    }

    // ③ 找 Java（Forge 1.20.1 要 17；这里直接用系统里最新的）
    let mut candidates: Vec<(u32, PathBuf)> = Vec::new();
    for base in [r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\Java"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let v: Option<u32> = name
                    .split(['-', '.'])
                    .find_map(|t| t.parse::<u32>().ok().filter(|n| *n >= 8 && *n <= 40));
                let p = e.path().join("bin").join("java.exe");
                if p.is_file() {
                    candidates.push((v.unwrap_or(0), p));
                }
            }
        }
    }
    candidates.sort_by_key(|(v, _)| *v);
    let java = candidates
        .iter()
        .find(|(v, _)| *v >= 17)
        .or_else(|| candidates.first())
        .map(|(_, p)| p.clone())
        .expect("找不到 java.exe");
    println!("  Java：{}", java.display());

    // ④ 跑安装器
    let mirror_maven = format!("{}/maven", mirror::BMCLAPI_BASE);
    println!("  运行安装器（--installClient {} --mirror {}）…", shared.display(), mirror_maven);
    // ★ 不弹黑框 —— 与 install_version 走**同一条**调用形态，
    //   否则这个测试就覆盖不到真实路径（用户报的"弹出空 cmd"正出在这里）
    let mut installer = tokio::process::Command::new(&java);
    installer
        .arg("-jar")
        .arg(&jar)
        .arg("--installClient")
        .arg(&shared)
        .arg("--mirror")
        .arg(&mirror_maven)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ieml_lib::platform::hide_console_async(&mut installer);
    let out = installer.output().await.expect("无法运行安装器");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    println!("  退出码：{}", out.status);
    if !out.status.success() {
        println!("--- stdout 尾部 ---");
        for l in stdout.lines().rev().take(20).collect::<Vec<_>>().iter().rev() {
            println!("    {l}");
        }
        println!("--- stderr 尾部 ---");
        for l in stderr.lines().rev().take(20).collect::<Vec<_>>().iter().rev() {
            println!("    {l}");
        }
        panic!("★ {kind} 安装器失败（退出码 {}）", out.status);
    }

    // ⑤ 断言产出
    let expect_dir = shared.join("versions").join(format!("{mc}-{kind}-{ver}"));
    println!("  期望版本目录：{}", expect_dir.display());
    assert!(
        expect_dir.is_dir(),
        "★ 安装器成功了，但没产出 {}（启动时找不到版本）",
        expect_dir.display()
    );
    let json = expect_dir.join(format!("{mc}-{kind}-{ver}.json"));
    assert!(json.is_file(), "★ 缺少版本 JSON：{}", json.display());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
    let libs = v["libraries"].as_array().map(|a| a.len()).unwrap_or(0);
    println!(
        "  ✓ 版本 JSON：id={} · mainClass={} · 库 {} 个",
        v["id"].as_str().unwrap_or("?"),
        v["mainClass"].as_str().unwrap_or("?"),
        libs
    );
    assert!(libs > 0, "★ 版本 JSON 里一个库都没有");
    /*
     * ★ 别把 mainClass 写死成 `net.minecraft.launchwrapper.Launcher`。
     *   现代 Forge（1.17+）改用 **BootstrapLauncher**：
     *     `cpw.mods.bootstraplauncher.BootstrapLauncher`
     *   我第一版就是按老印象写死的，结果测试误报失败
     *   —— 而实际上安装**完全成功**（退出码 0、库 29 个）。
     */
    let main = v["mainClass"].as_str().unwrap_or("");
    assert!(
        main.contains("forge") || main.contains("BootstrapLauncher") || main.contains("launchwrapper"),
        "★ mainClass 不像 Forge 的：{main}"
    );

    // 库是否真的落在磁盘上 —— 用**启动侧同一份判据**扫，别自己写循环
    // （自己写循环会把别的平台的库也算成缺失，这个坑踩过两次）
    let version_json: ieml_lib::net::metadata::VersionJson =
        serde_json::from_value(v.clone()).expect("版本 JSON 解析失败");
    let scan = ieml_lib::net::installer::scan_classpath(&version_json, &shared);
    for m in &scan.missing {
        println!("    ✗ 本平台缺失：{m}");
    }
    println!(
        "  启动侧判据：classpath {} 项 · natives {} 个 · 缺失 {} 个",
        scan.classpath.len(),
        scan.natives.len(),
        scan.missing.len()
    );

    let mc_json = shared.join("versions").join(&mc).join(format!("{mc}.json"));
    /*
     * ★ 这条不是"顺便看看"，而是一个**真实的前置条件**（实测踩到）。
     *
     *   Forge 版本的 JSON 里写着 `inheritsFrom: "<原版>"`，而安装器
     *   **不会**替你下原版。原版没装的话：
     *     · 启动时合并父版本找不到 → 跳过；
     *     · classpath 里只剩 Forge 自己的 29 个库，核心 LWJGL 与客户端全缺；
     *     · 游戏报一个看不懂的 NoClassDefFoundError。
     *   所以 `run_loader_installer` 现在会在装完后检查这个，缺了就明确报错。
     *   测试里同样断言，避免"测试通过但用户拿到一个起不来的版本"。
     */
    assert!(
        mc_json.is_file(),
        "★ 原版 {mc} 的版本 JSON 不在（{}）——\n  \
         Forge 版本 inheritsFrom 它，启动时合并不到父版本，必然起不来。\n  \
         先在「下载」页装一次原版 {mc} 再装 {kind}。",
        mc_json.display()
    );

    println!(
        "\n✓ {kind} {ver} 安装成功（mainClass={main} · {libs} 个库 · 本平台缺失 {} 个）",
        scan.missing.len()
    );
}
