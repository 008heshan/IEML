//! 真机验证：**用某个实例的启动参数真起一次游戏**，看它是否活着。
//!
//! 这个测试补上了"最后一米"：前面的测试各自验证了 natives 布局、库完整性、
//! 版本 JSON 命名，但没有一个**把游戏真的跑起来**。用户报的
//! 「等待一分钟游戏未启动」正是卡在这一步。
//!
//! 跑法：
//! ```powershell
//! $env:IEML_TEST_SLUG='fabric-262'; $env:IEML_TEST_RUN_SECONDS='20'
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test launch_smoke -- --nocapture --ignored
//! ```
//! 它**不**复用启动器的 prepare_spec（那需要 AppState），而是照它的规则重放一遍：
//! 按 slug 取实例、定位版本 JSON（两个名字都试）、扫 classpath、解压 natives、
//! 拼参数、起进程、读输出。规则若漂移，这个测试就会露出来。

use ieml_lib::game::launch_args::{self, Account, LaunchSpec};
use ieml_lib::net::installer;
use ieml_lib::net::metadata::{self, VersionJson};
use std::path::PathBuf;
use std::process::Stdio;

fn data_root() -> PathBuf {
    /*
     * ★ 数据目录**必须**走 `AppPaths::resolve()`，不要写死 `%APPDATA%\IEML`。
     *
     *   写死的后果不是报错，是**这条测试悄悄地什么都不测**：
     *   数据目录搬到 `D:\IEML` 之后，写死的那条路径下什么都没有，
     *   测试要么早退、要么对着空目录跑出一堆"通过"。
     *   同一轮里已经因为这个抓出过一次假绿（`1.20.1` 缺 35 个库没人管）。
     */
    ieml_lib::platform::AppPaths::resolve().root
}

fn find_javaw(major: u32) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("IEML_TEST_JAVA") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<(u32, PathBuf)> = Vec::new();
    for base in [r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\Java"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let ver: Option<u32> = name
                    .split(['-', '.'])
                    .find_map(|t| t.parse::<u32>().ok().filter(|n| *n >= 8 && *n <= 40));
                let p = e.path().join("bin").join("javaw.exe");
                if p.is_file() {
                    candidates.push((ver.unwrap_or(0), p));
                }
            }
        }
    }
    candidates.sort_by_key(|(v, _)| *v);
    // 优先刚好大等于要求的版本
    if let Some((_, p)) = candidates.iter().find(|(v, _)| *v >= major) {
        return Some(p.clone());
    }
    candidates.pop().map(|(_, p)| p)
}

#[derive(serde::Deserialize)]
struct StoredInstance {
    #[serde(rename = "mcVersion")]
    mc_version: String,
    loader: Option<StoredLoader>,
    config: StoredConfig,
}

#[derive(serde::Deserialize)]
struct StoredLoader {
    kind: String,
    version: String,
}

#[derive(serde::Deserialize)]
struct StoredConfig {
    slug: String,
    #[serde(rename = "memoryMb")]
    memory_mb: u64,
}

#[test]
#[ignore = "会真的启动游戏进程（20 秒后杀掉）"]
fn instance_actually_launches() {
    let slug = std::env::var("IEML_TEST_SLUG").unwrap_or_else(|_| "fabric-262".into());
    let seconds: u64 = std::env::var("IEML_TEST_RUN_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let data = data_root();
    let shared = data.join("shared");

    println!("\n========== 实例启动真机验证（slug={slug}）==========");

    // ① 从 instances.json 读这个实例
    let store: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(data.join("instances.json")).expect("读 instances.json 失败"),
    )
    .expect("instances.json 不是合法 JSON");
    let inst: StoredInstance = store["instances"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|i| i["config"]["slug"].as_str() == Some(slug.as_str()))
        })
        .map(|v| serde_json::from_value(v.clone()).expect("实例结构不对"))
        .unwrap_or_else(|| panic!("instances.json 里没有 slug={slug} 的实例"));
    println!(
        "  实例：MC {} · 加载器 {:?} · 内存 {} MB",
        inst.mc_version,
        inst.loader.as_ref().map(|l| format!("{} {}", l.kind, l.version)),
        inst.config.memory_mb
    );

    // ② 定位版本 JSON（照启动器的规则：两个名字都试，优先带加载器痕迹的）
    let vdir = shared.join("versions");
    let mut candidate: Option<(PathBuf, VersionJson)> = None;
    if let Ok(rd) = std::fs::read_dir(&vdir) {
        for e in rd.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            for name in [format!("{}.json", e.file_name().to_string_lossy()), format!("{}.json", inst.mc_version)] {
                let p = dir.join(&name);
                let Ok(text) = std::fs::read_to_string(&p) else { continue };
                let Ok(v) = serde_json::from_str::<VersionJson>(&text) else { continue };
                let matches_mc = v.id.contains(&inst.mc_version)
                    || v.inherits_from.as_deref() == Some(inst.mc_version.as_str());
                if !matches_mc {
                    continue;
                }
                let matches_loader = match inst.loader.as_ref() {
                    Some(l) => {
                        v.id.to_lowercase().contains(&l.kind)
                            || v.libraries.iter().any(|x| x.name.to_lowercase().contains(&l.kind))
                    }
                    None => !v.id.to_lowercase().contains("fabric")
                        && !v.id.to_lowercase().contains("forge"),
                };
                if matches_loader {
                    candidate = Some((p, v));
                    break;
                }
            }
            if candidate.is_some() {
                break;
            }
        }
    }
    let (json_path, version) = candidate.unwrap_or_else(|| {
        panic!(
            "在 {} 下找不到匹配 MC {} + 加载器 {:?} 的版本 JSON",
            vdir.display(),
            inst.mc_version,
            inst.loader.as_ref().map(|l| l.kind.clone())
        )
    });
    println!("  版本 JSON：{}", json_path.display());
    println!("    id={} · mainClass={}", version.id, version.main_class);

    /*
     * ★ 加载器版本必须**再跟原版合并一次**才完整 —— 直接调用**启动器自己那套**
     *   （`merge_with_parents`），不在这里另写一份逻辑（那正是 bug 的来源）。
     *
     *   实测踩过（Fabric 26.2 起不来）：
     *     ① 新版 Mojang 版本 JSON 是**增量的** —— 26.2 自己那份里没有
     *        `org.lwjgl:lwjgl:3.4.1`（核心 LWJGL，含 CallbackI），
     *        Fabric 的 profile 也没有 → `NoClassDefFoundError: …CallbackI`；
     *     ② 磁盘上那份合并 JSON 还可能是**旧去重规则**写的（丢了库）。
     *   两点都指向同一个修法：**启动时按当前规则递归合并**。
     */
    let version = ieml_lib::commands_real::merge_with_parents(
        &shared,
        version,
        &inst.mc_version,
        inst.loader.as_ref().map(|l| l.kind.as_str()),
    );
    println!(
        "    合并原版后：{} 个库 · mainClass={}",
        version.libraries.len(),
        version.main_class
    );
    if let Some(l) = inst.loader.as_ref() {
        assert!(
            version.main_class.to_lowercase().contains(&l.kind)
                || version.libraries.iter().any(|x| x.name.to_lowercase().contains(&l.kind)),
            "★ 合并后没有 {} 的痕迹 —— 加载器不会被加载，游戏必然起不来",
            l.kind
        );
        assert!(
            version.libraries.iter().any(|x| x.name.to_lowercase().contains(&l.kind)),
            "★ 这个版本 JSON 里没有 {} 的库 —— 主类会 ClassNotFoundException",
            l.kind
        );
    }

    // ③ 库完整性（用与启动器同一份判据）
    let scan = installer::scan_classpath(&version, &shared);
    assert!(
        scan.missing.is_empty(),
        "★ 本平台还有库缺失，游戏起不来：{:?}",
        scan.missing
    );
    println!(
        "  classpath {} 项 · natives {} 个 · 缺失 0 个",
        scan.classpath.len(),
        scan.natives.len()
    );

    // ③' 客户端 jar：**沿 inheritsFrom 把每一层的 jar 都加进来**。
    //    实测踩过（Fabric 26.2）：加载器版本目录里的 jar 是 Fabric 自己的，
    //    原版 jar 在 `versions/26.2/26.2.jar` —— 不加进去 FabricLoader 会报
    //    `Minecraft game provider couldn't locate the game!` 而且**以 0 退出**。
    let mut classpath = scan.classpath.clone();
    let mut jar_ids = vec![version.id.clone()];
    let mut cur = version.inherits_from.clone();
    let mut hops = 0;
    while let Some(parent) = cur {
        if hops >= 4 || jar_ids.contains(&parent) {
            break;
        }
        jar_ids.push(parent.clone());
        let p = shared
            .join("versions")
            .join(&parent)
            .join(format!("{parent}.json"));
        cur = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str::<VersionJson>(&t).ok())
            .and_then(|v| v.inherits_from);
        hops += 1;
    }
    for id in &jar_ids {
        let jar = shared.join("versions").join(id).join(format!("{id}.jar"));
        if jar.is_file() && !classpath.contains(&jar) {
            classpath.push(jar);
        }
    }
    println!("  客户端 jar 链：{:?}", jar_ids);
    assert!(
        classpath.iter().any(|p| p.file_name().map(|n| n.to_string_lossy().contains(&inst.mc_version)).unwrap_or(false)),
        "★ classpath 里没有原版 {} 的客户端 jar —— FabricLoader 会找不到游戏",
        inst.mc_version
    );

    // ④ 解压 natives（与启动器同一套逻辑：根目录 + 版本声明的子目录）
    let natives_dir = data.join("instances").join(&slug).join("natives");
    if natives_dir.is_dir() {
        std::fs::remove_dir_all(&natives_dir).ok();
    }
    std::fs::create_dir_all(&natives_dir).unwrap();
    let mut targets = vec![natives_dir.clone()];
    if let Some(sub) = metadata::natives_java_subdir(&version) {
        let p = natives_dir.join(&sub);
        std::fs::create_dir_all(&p).unwrap();
        targets.push(p);
    }
    for (jar, exclude) in &scan.natives {
        for t in &targets {
            let _ = installer::extract_natives(jar, t, exclude);
        }
    }
    println!("  natives 解压到 {:?}", targets);

    // ⑤ 拼参数 + 起进程
    let java = find_javaw(25).expect("找不到 javaw.exe");
    println!("  Java：{}", java.display());
    let game_dir = data.join("instances").join(&slug).join("game");
    std::fs::create_dir_all(&game_dir).unwrap();

    let spec = LaunchSpec {
        java: java.clone(),
        main_class: version.main_class.clone(),
        classpath: classpath.clone(),
        natives_dir: natives_dir.clone(),
        game_dir: game_dir.clone(),
        // ★ 2026-09-20 补：集成测试漏了这个字段 → `cargo check --tests` 一直是红的
        libraries_dir: shared.join("libraries"),
        assets_root: shared.join("assets"),
        asset_index_name: version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_else(|| "5".into()),
        version_name: version.id.clone(),
        version_type: "release".into(),
        account: Account::offline("IEMLSmoke"),
        memory_mb: inst.config.memory_mb.min(2048),
        width: 854,
        height: 480,
        jvm_args_template: version.arguments.as_ref().map(|a| a.jvm.clone()).unwrap_or_default(),
        game_args_template: version.arguments.as_ref().map(|a| a.game.clone()).unwrap_or_default(),
        legacy_arguments: version.minecraft_arguments.clone(),
        extra_jvm_args: vec![],
        extra_game_args: vec![],
        window_title: None,
        join_server: None,
        notice: None,
    };
    let cmd = launch_args::build_command(&spec);

    println!("\n  启动游戏（{seconds} 秒后杀掉）…");
    let mut launch_cmd = std::process::Command::new(&java);
    launch_cmd
        .args(&cmd.args)
        .current_dir(&game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // ★ 与 launch::launch 同一形态：不弹控制台窗口
    ieml_lib::platform::hide_console(&mut launch_cmd);
    let mut child = launch_cmd.spawn().expect("无法启动 JVM");

    std::thread::sleep(std::time::Duration::from_secs(seconds));
    let early = child.try_wait().ok().flatten();
    let _ = child.kill();
    let out = child.wait_with_output().expect("等待失败");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    println!("--- 输出 ---\n{text}\n--- 结束 ---");

    if let Some(st) = early {
        panic!("★ 进程提前退出（{st:?}）—— 看上面的输出");
    }
    // ★ 退出码 0 不算成功：FabricLoader 加载不到游戏时会**以 0 退出**，
    //   只留一行 ERROR。只看退出码会把"游戏根本没起来"判成通过。
    for bad in [
        "ClassNotFoundException",
        "NoClassDefFoundError",
        "Failed to locate library",
        "UnsatisfiedLinkError",
        "Could not find or load main class",
        "couldn't locate the game",
        "Uncaught exception in thread",
        "[ERROR]",
        "Exception in thread",
    ] {
        assert!(!text.contains(bad), "★ 命中错误特征「{bad}」—— 游戏没起来");
    }
    // 正面证据：至少要看到原版初始化过的痕迹
    let started = ["Backend library", "Setting user", "Reloading ResourceManager", "Sound engine"]
        .iter()
        .any(|k| text.contains(k));
    assert!(
        started,
        "★ 20 秒内没有任何「游戏已初始化」的痕迹（Backend library / Setting user …）—— 它没真的跑起来"
    );
    println!("\n✓ {seconds} 秒内没有崩溃，实例 {slug} 启动正常");
}
