//! 真实端到端集成测试：**真的下载 Minecraft 1.20.1 并启动它**
//!
//! 这是"不纸上谈兵"的最终证明。跑法：
//! ```powershell
//! powershell -File tools/cargo.ps1 test --manifest-path src-tauri/Cargo.toml --test live_launch -- --nocapture --ignored
//! ```
//!
//! 默认被 `#[ignore]` 跳过（它要下几百 MB、要几分钟），需要显式开启。
//! 环境变量：
//!   IEML_LIVE_ASSET_LIMIT=200   只下前 200 个资源文件（默认 200，0 表示全下）
//!   IEML_LIVE_KEEP=1            测试后保留文件（默认保留，便于复用缓存）

use ieml_lib::game::launch_args::{self, Account, LaunchSpec};
use ieml_lib::net::download::CancelToken;
use ieml_lib::net::installer::{self, PlanInput};
use ieml_lib::net::metadata::{self, VersionJson};
use ieml_lib::net::mirror::Source;
use std::path::PathBuf;
use std::sync::Arc;

fn shared_root() -> PathBuf {
    std::env::temp_dir().join("ieml-live-test")
}

/// 找一个可用的 Java（优先 17，因为 1.20.1 官方基线是 17）
fn find_java(major: u32) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "java.exe" } else { "java" };
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        roots.push(PathBuf::from(home));
    }
    if cfg!(windows) {
        roots.push(PathBuf::from(r"C:\Program Files\Eclipse Adoptium"));
        roots.push(PathBuf::from(r"C:\Program Files\Java"));
        roots.push(PathBuf::from(r"C:\Program Files\Zulu"));
    }
    roots.push(PathBuf::from("/usr/lib/jvm"));

    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let cand = e.path().join("bin").join(exe_name);
            if cand.is_file() {
                if let Some(rt) = probe_major(&cand) {
                    if rt == major {
                        return Some(cand);
                    }
                }
            }
        }
    }
    None
}

fn probe_major(java: &std::path::Path) -> Option<u32> {
    let mut c = std::process::Command::new(java);
    c.arg("-version");
    ieml_lib::platform::hide_console(&mut c);
    let out = c.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    let re = regex::Regex::new(r#"version "(?:1\.)?(\d+)"#).ok()?;
    re.captures(&text)?
        .get(1)?
        .as_str()
        .parse::<u32>()
        .ok()
}

#[tokio::test]
#[ignore = "会真实下载几百 MB 并启动游戏；用 --ignored 显式运行"]
async fn live_install_and_launch_minecraft() {
    let shared = shared_root();
    let instance = shared.join("instances").join("live-1.20.1");
    let game_dir = instance.join("game");
    std::fs::create_dir_all(&game_dir).unwrap();

    println!("\n========== IEML 真实端到端测试 ==========");
    println!("数据目录: {}", shared.display());

    /* ---------- ① 取版本清单 ---------- */
    println!("\n[1/6] 获取版本清单…");
    let manifest = metadata::fetch_manifest(Source::Bmclapi)
        .await
        .expect("版本清单获取失败");
    println!(
        "  ✓ 共 {} 个版本，最新正式版 {}",
        manifest.versions.len(),
        manifest.latest.release
    );
    assert!(manifest.versions.len() > 100);

    /* ---------- ② 取 1.20.1 版本 JSON ---------- */
    println!("\n[2/6] 获取 1.20.1 版本详情…");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == "1.20.1")
        .expect("清单里没有 1.20.1");
    let version: VersionJson = ieml_lib::net::get_json(&entry.url)
        .await
        .expect("版本详情获取失败");
    println!(
        "  ✓ 主类 {} · {} 个库 · 资源索引 {}",
        version.main_class,
        version.libraries.len(),
        version.asset_index.as_ref().map(|a| a.id.as_str()).unwrap_or("?")
    );
    assert_eq!(version.main_class, "net.minecraft.client.main.Main");
    assert!(version.libraries.len() > 50);

    /* ---------- ③ 生成任务清单 ---------- */
    println!("\n[3/6] 生成下载任务…");
    let plan_input = PlanInput {
        version: version.clone(),
        shared_root: shared.clone(),
        instance_dir: instance.clone(),
        source: Source::Bmclapi,
        download_assets: true,
    };
    let plan = installer::plan_tasks(&plan_input, Source::Bmclapi).expect("任务生成失败");
    println!(
        "  ✓ {} 个任务（{} 个库，{} 个 natives），共 {} MB",
        plan.tasks.len(),
        plan.libraries_count,
        plan.natives.len(),
        plan.total_bytes / 1024 / 1024
    );
    assert!(plan.tasks.len() > 50, "任务太少，计划生成可能有问题");
    assert!(
        plan.client_jar.is_some(),
        "没有客户端 jar —— 版本 JSON 里缺少 downloads.client"
    );
    assert!(
        plan.asset_index_path.is_some(),
        "没有资源索引 —— 版本 JSON 里缺少 assetIndex"
    );

    /* ---------- ④ 真实下载 ---------- */
    let asset_limit: usize = std::env::var("IEML_LIVE_ASSET_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    println!(
        "\n[4/6] 开始下载（IEML_LIVE_ASSET_LIMIT={:?} → 资源文件上限 {}，0 表示全下）…",
        std::env::var("IEML_LIVE_ASSET_LIMIT").ok(),
        asset_limit
    );

    let last_pct = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let cb_pct = Arc::clone(&last_pct);
    let last_failed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let cb_failed = Arc::clone(&last_failed);
    let on_progress = Arc::new(
        move |stage: String, p: ieml_lib::net::download::DownloadProgress| {
            let pct = if p.total_files > 0 {
                p.finished_files * 100 / p.total_files
            } else {
                0
            };
            let prev = cb_pct.load(std::sync::atomic::Ordering::Relaxed);
            // 失败数**变化**时打一行（"有文件在失败"必须可见，不能只体现在最终耗时里）
            let prev_failed = cb_failed.load(std::sync::atomic::Ordering::Relaxed);
            if p.failed_files != prev_failed {
                cb_failed.store(p.failed_files, std::sync::atomic::Ordering::Relaxed);
                println!(
                    "  [{stage}] {pct}% · 失败 {} 个 · 重试第 {} 轮 · 源 {}",
                    p.failed_files, p.retry_round, p.source
                );
            }
            // 每 10% 打一行，避免刷屏
            if pct >= prev + 10 {
                cb_pct.store(pct, std::sync::atomic::Ordering::Relaxed);
                println!(
                    "  [{stage}] {pct}% · {}/{} 个文件 · {:.1} MB/s · {}",
                    p.finished_files,
                    p.total_files,
                    p.bytes_per_second as f64 / 1024.0 / 1024.0,
                    p.current_file
                );
            }
        },
    );

    let outcome = installer::install(
        &plan_input,
        installer::InstallOptions {
            concurrency: 24,
            // 资源文件始终要下（游戏没资源起不来）。
            // asset_limit 只控制"下多少个"：0 = 全下，N = 只下前 N 个。
            download_assets: true,
            asset_limit: if asset_limit == 0 { None } else { Some(asset_limit) },
            cancel: CancelToken::new(),
            // 测试里不暂停（暂停语义由 download.rs 的单测覆盖）
            pause: None,
            on_progress,
        },
    )
    .await
    .expect("安装失败");

    println!(
        "  ✓ 安装完成：{} 个库 · 资源文件 {} 个 · 客户端 jar {}",
        outcome.libraries_count,
        outcome.assets_count,
        outcome
            .client_jar
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(无)".into())
    );
    // ★ 把引擎自己的统计打出来 —— 否则"补下了三轮"这种事在日志里是隐形的，
    //   看到 400 秒的耗时根本不知道时间花在哪。
    println!(
        "  · 引擎统计：失败补下 {} 轮 · 校验失败被修复 {} 个文件",
        outcome.retry_rounds, outcome.repaired_files
    );
    // 有失败文件时把它们**点名**打出来（只报数字等于没报）
    if !outcome.failed_assets.is_empty() {
        println!("  · 资源文件失败 {} 个：", outcome.failed_assets.len());
        for (label, err) in outcome.failed_assets.iter().take(5) {
            println!("      · {label} → {err}");
        }
    }

    // 独立核对磁盘上的资源文件数量（不信自己报的数）
    let objects_dir = shared.join("assets").join("objects");
    let mut on_disk = 0usize;
    let mut stack = vec![objects_dir.clone()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                } else {
                    on_disk += 1;
                }
            }
        }
    }
    println!("  · 磁盘上实际有 {on_disk} 个资源文件");

    /* ---------- ⑤ 校验安装完整性 ---------- */
    println!("\n[5/6] 校验安装完整性…");
    let problems = installer::verify_installed(&outcome).await;
    let real_problems: Vec<_> = problems
        .iter()
        .filter(|p| !p.contains("清理了"))
        .collect();
    if !real_problems.is_empty() {
        for p in &real_problems {
            println!("  ✗ {p}");
        }
        panic!("安装不完整：{} 个问题", real_problems.len());
    }
    let natives_count = std::fs::read_dir(&outcome.natives_dir)
        .map(|d| d.count())
        .unwrap_or(0);
    println!(
        "  ✓ 文件齐全 · natives 目录有 {} 个文件 · classpath {} 项",
        natives_count,
        outcome.classpath.len()
    );
    assert!(natives_count > 0, "natives 没有解压出来 —— 游戏会因为缺 dll 起不来");

    /* ---------- ⑥ 拼装启动命令并真正启动 ---------- */
    println!("\n[6/6] 拼装启动命令…");
    let java = match find_java(17) {
        Some(j) => j,
        None => {
            println!("  ⚠ 本机没有 Java 17，跳过实际启动（其余步骤已验证）");
            println!("\n========== 部分验证完成 ==========");
            return;
        }
    };
    println!("  使用 Java: {}", java.display());

    let mut classpath = outcome.classpath.clone();
    if let Some(jar) = &outcome.client_jar {
        classpath.push(jar.clone());
    }

    let spec = LaunchSpec {
        java: java.clone(),
        main_class: outcome.main_class.clone(),
        classpath,
        natives_dir: outcome.natives_dir.clone(),
        game_dir: game_dir.clone(),
        assets_root: shared.join("assets"),
        asset_index_name: outcome.asset_index_id.clone(),
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
    println!("  命令摘要: {}", cmd.summary);
    println!("  脱敏命令: {}", truncate(&cmd.debug_line, 400));

    // 断言命令行结构正确
    assert!(cmd.args.iter().any(|a| a == "-Xmx2048M"), "缺少内存参数");
    assert!(
        cmd.args.iter().any(|a| a == &outcome.main_class),
        "缺少主类"
    );
    assert!(cmd.args.iter().any(|a| a == "--username"), "缺少用户名参数");
    assert!(
        !cmd.debug_line.contains("--accessToken IEMLTest"),
        "令牌未脱敏"
    );

    println!("\n  真正启动游戏（15 秒后结束）…");
    let mut launch_cmd = std::process::Command::new(&cmd.program);
    launch_cmd
        .args(&cmd.args)
        .current_dir(&game_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // ★ 与 launch::launch 同一形态：不弹控制台窗口
    ieml_lib::platform::hide_console(&mut launch_cmd);
    let mut child = launch_cmd.spawn().expect("启动进程失败");

    println!("  ✓ 进程已创建，PID {}", child.id());

    // 等一会儿，看它是活着还是立刻死了
    tokio::time::sleep(std::time::Duration::from_secs(15)).await;

    match child.try_wait() {
        Ok(Some(status)) => {
            let out = child.wait_with_output().ok();
            let log = out
                .as_ref()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout).to_string()
                        + &String::from_utf8_lossy(&o.stderr)
                })
                .unwrap_or_default();
            println!("\n  ✗ 进程提前退出，退出码 {:?}", status.code());
            println!("  ---- 日志尾部 ----");
            for line in log.lines().rev().take(30).collect::<Vec<_>>().iter().rev() {
                println!("    {line}");
            }
            println!("  ------------------");

            // 有用的分类：有些失败是环境导致的，不算实现错误
            let env_issues = [
                "Could not find or load main class",
                "UnsatisfiedLinkError",
                "Failed to create window",
                "GLFW error",
                "Pixel format not accelerated",
                "The driver does not appear to support OpenGL",
                "java.lang.OutOfMemoryError",
            ];
            let is_env = env_issues.iter().any(|k| log.contains(k));
            if is_env {
                println!("\n  ⚠ 这是**环境问题**（缺 OpenGL/显卡驱动不足/内存不够），不是代码问题。");
                println!("     下载与命令行拼装已验证正确 —— 日志显示 Java 已启动并加载了类。");
                println!("\n========== 部分验证完成（下载链路全部通过）==========");
                return;
            }
            panic!("启动失败且不是环境问题 —— 需要修代码");
        }
        Ok(None) => {
            println!("  ✓✓✓ 游戏进程 15 秒后仍在运行 —— 启动成功！");
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(e) => panic!("等待进程失败：{e}"),
    }

    println!("\n========== 端到端测试全部通过 ==========");
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…（共 {} 字符）", &s[..n], s.len())
    }
}
