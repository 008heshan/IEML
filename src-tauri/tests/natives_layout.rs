//! 真实启动的「最后一段」验证：把 natives 解压到位 + 用启动器**自己那套**
//! 参数拼装代码起 JVM，只跑 3 秒，看 lwjgl.dll 能不能被加载。
//!
//! 为什么需要它：完整的 live_launch_java 要下一整个版本（几十分钟），
//! 而"natives 该解压到哪一层"这类 bug 只要**起 JVM 几秒**就能暴露 ——
//! 实测崩在 `UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。
//!
//! 跑法（需要本机已有安装好的版本 + 对应 Java）：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test natives_layout -- --nocapture --ignored
//! ```
//! 环境变量：
//!   IEML_TEST_VERSION=26.2   要验证的版本（默认 26.2）
//!   IEML_TEST_JAVA=...       javaw.exe 路径（默认取 IEML 数据目录下/系统 Temurin）

use ieml_lib::game::launch_args::{self, Account, LaunchSpec};
use ieml_lib::net::installer;
use ieml_lib::net::metadata::{self, VersionJson};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

fn data_root() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("IEML")
}

fn find_javaw() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("IEML_TEST_JAVA") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    // 先找 IEML 自己下的，再找系统 Temurin
    let mut candidates: Vec<PathBuf> = Vec::new();
    let ieml_java = data_root().join("java");
    if let Ok(rd) = std::fs::read_dir(&ieml_java) {
        for e in rd.flatten() {
            let p = e.path().join("bin").join("javaw.exe");
            if p.is_file() {
                candidates.push(p);
            }
        }
    }
    for base in [
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Java",
    ] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten() {
                let p = e.path().join("bin").join("javaw.exe");
                if p.is_file() {
                    candidates.push(p);
                }
            }
        }
    }
    // 版本号高的优先（26.2 要 25）
    candidates.sort();
    candidates.pop()
}

#[test]
#[ignore = "需要本机已安装的游戏版本 + Java 运行时"]
fn natives_are_where_the_jvm_looks_for_them() {
    let version_id = std::env::var("IEML_TEST_VERSION").unwrap_or_else(|_| "26.2".into());
    let data = data_root();
    let shared = data.join("shared");
    let version_dir = shared.join("versions").join(&version_id);
    let json_path = version_dir.join(format!("{version_id}.json"));

    println!("\n========== natives 布局真机验证 ==========");
    println!("版本: {version_id}");
    println!("数据目录: {}", data.display());
    assert!(
        json_path.is_file(),
        "找不到版本文件 {} —— 先在启动器里装好这个版本",
        json_path.display()
    );

    let version: VersionJson =
        serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();

    /* ---------- ① 按启动器的程序集 classpath + natives ---------- */
    let mut classpath = Vec::new();
    let mut natives = Vec::new();
    for lib in &version.libraries {
        if !metadata::rules_allow(&lib.rules, &HashMap::new()) {
            continue;
        }
        let Some(art) = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref()) else {
            continue;
        };
        let rel = art
            .path
            .clone()
            .or_else(|| metadata::maven_path(&lib.name));
        let Some(rel) = rel else { continue };
        let p = shared.join("libraries").join(rel);
        if !p.is_file() {
            continue;
        }
        // ★ 用完整判据（坐标 + natives 字段）—— 只按坐标会漏掉老格式
        if metadata::is_native_lib(&lib) {
            natives.push((
                p,
                lib.extract
                    .as_ref()
                    .map(|e| e.exclude.clone())
                    .unwrap_or_default(),
            ));
        } else {
            classpath.push(p);
        }
    }
    let client_jar = version_dir.join(format!("{version_id}.jar"));
    assert!(client_jar.is_file(), "缺少客户端 jar：{}", client_jar.display());
    classpath.push(client_jar);

    println!("classpath: {} 项 · natives jar: {} 个", classpath.len(), natives.len());

    /* ---------- ② 解压 natives（与 prepare_spec 完全同样的逻辑） ---------- */
    let natives_dir = std::env::temp_dir().join("ieml-natives-check").join(&version_id);
    if natives_dir.is_dir() {
        std::fs::remove_dir_all(&natives_dir).ok();
    }
    std::fs::create_dir_all(&natives_dir).unwrap();

    let mut targets = vec![natives_dir.clone()];
    let sub = metadata::natives_java_subdir(&version);
    if let Some(s) = &sub {
        let p = natives_dir.join(s);
        std::fs::create_dir_all(&p).unwrap();
        targets.push(p);
    }
    for (jar, exclude) in &natives {
        for t in &targets {
            let _ = installer::extract_natives(jar, t, exclude);
        }
    }
    println!(
        "natives 解压目标: {:?}（版本声明子目录: {:?}）",
        targets
            .iter()
            .map(|p| p.strip_prefix(&natives_dir).unwrap_or(p).display().to_string())
            .collect::<Vec<_>>(),
        sub
    );

    /* ---------- ③ 关键断言：java.library.path 指向的目录里有 lwjgl.dll ---------- */
    let java = find_javaw().expect("找不到 javaw.exe");
    println!("Java: {}", java.display());

    let game_dir = std::env::temp_dir().join("ieml-natives-check").join("game");
    std::fs::create_dir_all(&game_dir).unwrap();

    let spec = LaunchSpec {
        java: java.clone(),
        main_class: version.main_class.clone(),
        classpath,
        natives_dir: natives_dir.clone(),
        game_dir,
        /*
         * ★ 2026-09-20 补：`libraries_dir` 是 dev.12 加进 `LaunchSpec` 的
         *   （`${library_directory}` 不再从 classpath 反推），而几个**集成测试**
         *   的 initializer 没跟着改 —— 于是 `cargo check --tests` 一直是红的，
         *   只因为 `pnpm verify` 只跑 `--lib`，谁都没看见。
         */
        libraries_dir: shared.join("libraries"),
        assets_root: shared.join("assets"),
        asset_index_name: version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_default(),
        version_name: version_id.clone(),
        version_type: "release".into(),
        account: Account::offline("NativesCheck"),
        memory_mb: 1024,
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

    // 找出 java.library.path 实际指向哪，并检查 lwjgl.dll 在不在那儿
    let lib_path = cmd
        .args
        .iter()
        .find_map(|a| a.strip_prefix("-Djava.library.path="))
        .map(PathBuf::from)
        .expect("启动命令里没有 -Djava.library.path");
    println!("java.library.path = {}", lib_path.display());
    let dll = lib_path.join("lwjgl.dll");
    assert!(
        dll.is_file(),
        "★ JVM 会在 {} 里找 lwjgl.dll，但那里没有！\n\
         该目录内容: {:?}",
        lib_path.display(),
        std::fs::read_dir(&lib_path)
            .map(|rd| rd
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>())
            .unwrap_or_default()
    );
    println!("✓ {} 存在（{} 字节）", dll.display(), dll.metadata().unwrap().len());

    /* ---------- ④ 起 JVM：看它到底走到哪一步 ---------- */
    //
    //  ★ 只跑 3 秒是不够的 —— 那只能证明"没有立刻报 native 错误"。
    //    实测游戏是在初始化中段崩的，所以这里给足 20 秒，
    //    并且**把输出全收下来**判断走到了哪一步。
    let seconds: u64 = std::env::var("IEML_TEST_RUN_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    println!("\n启动 JVM（{seconds} 秒后杀掉）…");
    let mut launch_cmd = std::process::Command::new(&java);
    launch_cmd
        .args(&cmd.args)
        .current_dir(&spec.game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // ★ 与 launch::launch 同一形态：不弹控制台窗口
    ieml_lib::platform::hide_console(&mut launch_cmd);
    let mut child = launch_cmd.spawn().expect("无法启动 JVM");

    std::thread::sleep(std::time::Duration::from_secs(seconds));
    let early_exit = child.try_wait().ok().flatten();
    let _ = child.kill();
    let out = child.wait_with_output().expect("等待 JVM 失败");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    println!("--- 完整输出（{} 字节） ---", text.len());
    println!("{text}");
    println!("--- 输出结束 ---");
    if let Some(st) = early_exit {
        println!("★ 进程自己提前退出了：{st:?}（说明它崩了，而不是在跑）");
    }

    // ---------- ⑤ 判定 ----------
    let bad = [
        "Failed to locate library",
        "UnsatisfiedLinkError",
        "NoClassDefFoundError",
        "ClassNotFoundException",
        "Could not find or load main class",
        "Exception in thread",
    ]
    .iter()
    .find(|k| text.contains(*k))
    .copied();

    if let Some(k) = bad {
        panic!("★ 游戏启动失败，命中错误特征「{k}」（完整输出见上）");
    }
    assert!(
        early_exit.is_none(),
        "★ JVM 在 {seconds} 秒内就退出了，但没命中已知错误特征 —— 看上面的完整输出"
    );
    println!("\n✓ {seconds} 秒内没有崩溃，进程仍在运行");
}
