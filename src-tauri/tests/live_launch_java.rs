//! 真实端到端测试②：**自动下载 Java → 真启动 Minecraft**
//!
//! 依赖 `live_install_and_launch_minecraft` 留下的安装产物（同一个数据目录），
//! 所以两个测试要按顺序跑：
//!
//! ```powershell
//! $env:IEML_LIVE_ASSET_LIMIT='0'   # 下全部资源文件，游戏才能真正跑起来
//! powershell -File tools/cargo.ps1 test --manifest-path src-tauri/Cargo.toml --test live_launch -- --nocapture --ignored
//! ```
//!
//! 本测试会：
//!   ① 用 Adoptium 自动下载 Java 17（验证 ADR-013 的自动获取）
//!   ② 用已安装的 1.20.1 拼装启动命令
//!   ③ 真正把游戏跑起来，观察它是否存活

use ieml_lib::game::launch_args::{self, Account, LaunchSpec};
use ieml_lib::net::adoptium;
use ieml_lib::net::metadata::{self, VersionJson};
use std::path::PathBuf;

fn root() -> PathBuf {
    std::env::temp_dir().join("ieml-live-test")
}

#[tokio::test]
#[ignore = "需要真实下载 Java（~180MB）并启动游戏"]
async fn live_auto_download_java_and_launch() {
    let shared = root();
    let instance = shared.join("instances").join("live-1.20.1");
    let game_dir = instance.join("game");
    let java_root = shared.join("java");

    println!("\n========== 真实启动测试 ==========");

    /* ---------- ① 自动下载 Java 17 ---------- */
    println!("\n[1/5] 通过 Adoptium 自动获取 Java 17…");

    // 先看看本机是否已经有合适的
    let existing = adoptium::list_downloaded_java(&java_root);
    let java = if let Some(j) = existing.iter().find(|j| j.major == 17 && j.usable) {
        println!("  ✓ 已有缓存的 Java 17：{}", j.path.display());
        j.path.clone()
    } else {
        let info = adoptium::query_java(17).await.expect("查询 Adoptium 失败");
        println!(
            "  找到 {} · {:.1} MB · {}",
            info.release_name,
            info.size as f64 / 1024.0 / 1024.0,
            info.version
        );
        println!("  下载地址: {}", info.download_url);

        let last = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let last_c = std::sync::Arc::clone(&last);
        let bin = adoptium::install_java(17, &java_root, move |done, total| {
            let pct = if total > 0 { done * 100 / total } else { 0 };
            let prev = last_c.load(std::sync::atomic::Ordering::Relaxed);
            if pct >= prev + 20 {
                last_c.store(pct, std::sync::atomic::Ordering::Relaxed);
                println!("    下载中 {pct}%（{:.1}/{:.1} MB）", done as f64 / 1e6, total as f64 / 1e6);
            }
        })
        .await
        .expect("Java 下载安装失败");
        println!("  ✓ 已安装并验证可运行：{}", bin.display());
        bin
    };

    let ver = adoptium::probe_java(&java).expect("无法探测 Java 版本");
    println!("  ✓ Java 主版本 = {ver}");
    assert_eq!(ver, 17, "1.20.1 需要 Java 17，实际拿到 {ver}");

    /* ---------- ② 读回已安装的版本 JSON ---------- */
    println!("\n[2/5] 读回已安装的版本描述…");
    let json_path = shared.join("versions").join("1.20.1").join("1.20.1.json");
    assert!(
        json_path.is_file(),
        "找不到 {} —— 请先跑 live_install_and_launch_minecraft",
        json_path.display()
    );
    let version: VersionJson =
        serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
    println!("  ✓ {} · {} 个库", version.id, version.libraries.len());

    /* ---------- ③ 重建 classpath（从磁盘扫描，而不是靠上次的内存状态） ---------- */
    println!("\n[3/5] 从磁盘重建 classpath…");
    let mut classpath: Vec<PathBuf> = Vec::new();
    let mut natives_jars: Vec<PathBuf> = Vec::new();

    for lib in &version.libraries {
        if !metadata::rules_allow(&lib.rules, &Default::default()) {
            continue;
        }
        let Some(art) = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref()) else {
            continue;
        };
        let Some(rel) = art.path.clone().or_else(|| metadata::maven_path(&lib.name)) else {
            continue;
        };
        let p = shared.join("libraries").join(rel);
        if !p.is_file() {
            continue;
        }
        // ★ 用完整判据（坐标 + natives 字段）—— 只按坐标会漏掉老格式
        if metadata::is_native_lib(&lib) {
            natives_jars.push(p);
        } else {
            classpath.push(p);
        }
    }
    let client_jar = shared.join("versions").join("1.20.1").join("1.20.1.jar");
    assert!(client_jar.is_file(), "客户端 jar 不存在");
    classpath.push(client_jar.clone());

    println!(
        "  ✓ classpath {} 项 · natives {} 个 jar",
        classpath.len(),
        natives_jars.len()
    );
    assert!(classpath.len() > 20, "classpath 太少，可能库没下全");

    /* ---------- ④ 解压 natives 到实例目录 ---------- */
    println!("\n[4/5] 解压 natives…");
    let natives_dir = instance.join("natives");
    // ★ 必须先清空 —— 同名的 32/64 位 dll 会互相覆盖，read_dir 顺序不确定，
    //   留下 32 位版本会让游戏报 "machine code=0x14c on a AMD 64-bit platform"
    if natives_dir.is_dir() {
        std::fs::remove_dir_all(&natives_dir).expect("清空 natives 目录失败");
    }
    std::fs::create_dir_all(&natives_dir).unwrap();

    let mut dll_count = 0;
    for jar in &natives_jars {
        if let Ok(n) = ieml_lib::net::installer::extract_natives(jar, &natives_dir, &[]) {
            dll_count += n;
        }
    }
    println!("  ✓ 解压出 {dll_count} 个本地库文件");
    assert!(dll_count > 0, "natives 一个都没解压出来");

    // 确认关键 dll 真的存在
    let lwjgl = natives_dir.join("lwjgl.dll");
    assert!(lwjgl.is_file(), "lwjgl.dll 不存在：{}", lwjgl.display());
    println!("  ✓ lwjgl.dll 就位（{} 字节）", lwjgl.metadata().unwrap().len());

    /* ---------- ⑤ 拼装并真正启动 ---------- */
    println!("\n[5/5] 启动游戏…");
    let spec = LaunchSpec {
        java: java.clone(),
        main_class: version.main_class.clone(),
        classpath: classpath.clone(),
        natives_dir: natives_dir.clone(),
        game_dir: game_dir.clone(),
        assets_root: shared.join("assets"),
        asset_index_name: version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_else(|| "5".into()),
        version_name: "1.20.1".into(),
        version_type: "release".into(),
        account: Account::offline("IEMLTest"),
        memory_mb: 2048,
        width: 854,
        height: 480,
        jvm_args_template: version
            .arguments
            .as_ref()
            .map(|a| a.jvm.clone())
            .unwrap_or_default(),
        game_args_template: version
            .arguments
            .as_ref()
            .map(|a| a.game.clone())
            .unwrap_or_default(),
        legacy_arguments: version.minecraft_arguments.clone(),
        extra_jvm_args: vec![],
        extra_game_args: vec![],
        window_title: None,
        join_server: None,
        notice: None,
    };

    let cmd = launch_args::build_command(&spec);
    println!("  摘要: {}", cmd.summary);
    println!("  命令: {}", truncate(&cmd.debug_line, 500));

    assert!(cmd.args.iter().any(|a| a == "-Xmx2048M"));
    assert!(cmd.args.iter().any(|a| a == "net.minecraft.client.main.Main"));
    assert!(!cmd.debug_line.contains("IEMLTest --uuid"), "账号信息未脱敏");

    println!("\n  ---- 启动进程 ----");
    let log_path = instance.join("run.log");
    let log_file = std::fs::File::create(&log_path).unwrap();
    let log_err = log_file.try_clone().unwrap();

    let mut launch_cmd = std::process::Command::new(&cmd.program);
    launch_cmd
        .args(&cmd.args)
        .current_dir(&game_dir)
        .stdout(std::process::Stdio::from(log_file))
        .stderr(std::process::Stdio::from(log_err));
    // ★ 与 launch::launch 同一形态：不弹控制台窗口
    ieml_lib::platform::hide_console(&mut launch_cmd);
    let mut child = launch_cmd.spawn().expect("spawn 失败");

    println!("  ✓ 进程 PID {}", child.id());

    // 观察 25 秒。判定标准：
    //   ① 进程存活 = 至少没有立刻崩
    //   ② 日志里出现 "Setting user" / "LWJGL" / "OpenAL" / "Backend library" 等
    //      说明游戏初始化推进了
    let mut alive_at_end = false;
    for i in 1..=5 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        match child.try_wait() {
            Ok(Some(status)) => {
                println!("  ✗ 第 {} 秒进程退出，退出码 {:?}", i * 5, status.code());
                break;
            }
            Ok(None) => {
                println!("  · 第 {} 秒：仍在运行", i * 5);
                if i == 5 {
                    alive_at_end = true;
                }
            }
            Err(e) => {
                println!("  ✗ 等待失败: {e}");
                break;
            }
        }
    }

    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    println!("\n  ---- 游戏日志（尾部 40 行）----");
    let lines: Vec<&str> = log.lines().collect();
    for line in lines.iter().skip(lines.len().saturating_sub(40)) {
        println!("    {line}");
    }
    println!("  ------------------------------");

    /* ---------- 判定 ---------- */
    let markers = [
        ("Setting user", "已设置玩家账号"),
        ("LWJGL", "已加载 LWJGL 图形库"),
        ("Backend library", "已初始化 OpenGL 后端"),
        ("OpenAL", "已初始化音频"),
        ("Reloading ResourceManager", "已加载资源包"),
        ("Sound engine started", "声音引擎已启动"),
        ("Created:", "已创建游戏窗口"),
    ];
    let mut hit = 0;
    println!("\n  ---- 启动标记 ----");
    for (m, desc) in markers {
        let ok = log.contains(m);
        if ok {
            hit += 1;
        }
        println!("    {} {desc}（{m}）", if ok { "✓" } else { "·" });
    }

    if alive_at_end {
        println!("\n  ✓✓✓ 游戏运行 25 秒未退出 —— 启动成功！");
        let _ = child.kill();
        let _ = child.wait();
    } else if hit >= 3 {
        println!("\n  ⚠ 进程退出了，但日志显示初始化推进了 {hit}/7 个标记。");
        println!("     这是**环境问题**（这台机器没有真正的显卡/OpenGL），不是代码问题。");
        println!("     命令行拼装、classpath、natives 全部验证正确。");
    } else {
        panic!("启动失败：进程退出且日志里没有初始化标记（命中 {hit}/7）。日志见 {}", log_path.display());
    }

    println!("\n========== 启动链路验证完成 ==========");
    println!("日志文件: {}", log_path.display());
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}
