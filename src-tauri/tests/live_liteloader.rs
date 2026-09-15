//! 真机验证：LiteLoader 自动安装**真的能装出来、而且能玩**。
//!
//! ## 背景
//!
//!   `addon_install_implemented(LiteLoader)` 长期是 `false`（诚实：没做）。
//!   这一轮照 PCL 的 `McDownloadLiteLoaderLoader`（`ModDownloadLib.vb` 787-822）
//!   实现出来了，所以要有真机证据，不能只看代码。
//!
//!   LiteLoader 与 OptiFine 不同：**不需要跑任何安装器**，
//!   只要写一个带 tweaker 的 `inheritsFrom` 版本 JSON，库由正常下载流程补。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_liteloader -- --ignored --nocapture
use ieml_lib::net::{installer, liteloader, metadata::VersionJson};
use ieml_lib::platform;
use std::process::Stdio;

fn read_version(shared: &std::path::Path, id: &str) -> Option<VersionJson> {
    let p = shared.join("versions").join(id).join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// 找一个"原版 json + jar 都在"的 MC 版本（LiteLoader 支持 1.7.10 ~ 1.12.2）
fn pick_mc(shared: &std::path::Path) -> Option<String> {
    for mc in ["1.12.2", "1.7.10", "1.11.2", "1.10.2", "1.8.9", "1.8"] {
        let j = shared.join("versions").join(mc).join(format!("{mc}.json"));
        let jar = shared.join("versions").join(mc).join(format!("{mc}.jar"));
        if j.is_file() && jar.is_file() {
            return Some(mc.to_string());
        }
    }
    None
}

#[tokio::test]
#[ignore = "真机测试：会联网拉清单并写盘"]
async fn liteloader_install_writes_a_working_version_json() {
    let paths = platform::AppPaths::resolve();
    let shared = &paths.shared;
    let Some(mc) = pick_mc(shared) else {
        println!("（跳过：本机没有完整的原版可供挂 LiteLoader）");
        return;
    };
    println!("\n=== 被试版本：{mc} ===");

    // ① 真实清单
    let v = liteloader::available_for(&mc)
        .await
        .expect("拉清单失败")
        .unwrap_or_else(|| panic!("上游应该有 {mc} 的 LiteLoader"));
    println!("  LiteLoader 版本：{}（{}）", v.version, if v.stable { "正式版" } else { "快照" });
    println!("  tweakClass：{}", v.tweak_class);
    println!("  自带前置库 {} 个：", v.libraries.len());
    for l in &v.libraries {
        println!("    · {}{}", l.name, l.url.as_deref().unwrap_or(""));
    }
    println!("  主 jar 地址：{}", liteloader::jar_url(&v.version));

    // ② 装（写版本 JSON + 把依赖下下来）
    //    ★ 第 4 个参数 = 挂载点。`None` → 挂原版。
    //      （Forge 作基座的情形由下面 `liteloader_chains_onto_forge` 覆盖。）
    let progress = |m: String| println!("    · {m}");
    let r = liteloader::install(shared, &mc, &v, None, &progress)
        .await
        .expect("安装失败");
    println!("\n=== 结果 ===");
    println!("  版本 id：{}", r.version_id);
    println!("  版本描述：{}", r.json_path.display());
    println!("  摘要：{}", r.summary);
    assert!(r.json_path.is_file(), "版本描述没写出来");

    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&r.json_path).unwrap()).unwrap();
    assert_eq!(json["inheritsFrom"], mc);
    assert_eq!(json["mainClass"], "net.minecraft.launchwrapper.Launch");
    assert_eq!(json["arguments"]["game"][1], v.tweak_class);
    let lib_names: Vec<&str> = json["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["name"].as_str())
        .collect();
    assert!(
        lib_names.iter().any(|n| n.contains("mumfrey")),
        "liteloader 本体必须在 libraries 里：{lib_names:?}"
    );
    println!("  ✓ 版本描述字段齐全");

    // ③ 主 jar 应该已经由 install 下好了（不再需要测试里手动下）
    let size = std::fs::metadata(&r.jar_path).map(|m| m.len()).unwrap_or(0);
    println!("  ✓ 主 jar 已落盘：{}（{size} 字节）", r.jar_path.display());
    assert!(
        size > 500_000,
        "★ install 应该把主 jar 也下下来（实际 {size} 字节）—— \
         只写 JSON 不下载，启动时必然报缺库"
    );

    // ④ ★ 真的启动，看它能不能进游戏
    //
    //    与 live_optifine_launch 同一条路子：用**生产代码**合并父版本
    //    （`installer::merge_versions`）与求值游戏参数
    //    （`launch_args::eval_args`），不手写等价物。
    println!("\n=== 启动验证（观察 30 秒）===");
    let raw = read_version(shared, &r.version_id).expect("读不到刚装的版本");
    let parent = read_version(shared, &mc).expect("读不到父版本");
    let merged = installer::merge_versions(&raw, &parent);

    let scan = installer::scan_classpath(&merged, shared);
    println!("  classpath {} 条，natives {} 个，缺库 {} 个", 
        scan.classpath.len(), scan.natives.len(), scan.missing.len());
    assert!(scan.missing.is_empty(), "缺库，肯定起不来：{:?}", scan.missing);

    let natives_dir = std::env::temp_dir().join(format!("ieml-ll-natives-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&natives_dir);
    std::fs::create_dir_all(&natives_dir).unwrap();
    let mut n = 0;
    for (jar, exclude) in &scan.natives {
        n += installer::extract_natives(jar, &natives_dir, exclude).unwrap_or(0);
    }
    println!("  natives 解压 {n} 个");
    assert!(n > 0, "natives 一个都没解出来");

    let client_jar = shared.join("versions").join(&mc).join(format!("{mc}.jar"));
    let mut cp: Vec<String> = scan
        .classpath
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    cp.push(client_jar.to_string_lossy().to_string());
    let cp_str = cp.join(";");

    // 1.12.2 要 Java 8
    let runtimes = platform::scan_java(&paths);
    let java = runtimes
        .iter()
        .find(|x| x.major == 8)
        .expect("1.12.2 需要 Java 8");
    println!("  用 Java {}：{}", java.major, java.path);

    let game_dir = paths.instance_game_dir("vanilla-1122");
    let _ = std::fs::create_dir_all(&game_dir);

    let mut args = vec![
        "-XX:+IgnoreUnrecognizedVMOptions".to_string(),
        "-Xmx2G".to_string(),
        "-Xms1G".to_string(),
        format!("-Djava.library.path={}", natives_dir.display()),
        "-Dfile.encoding=UTF-8".to_string(),
        "-cp".to_string(),
        cp_str,
        merged.main_class.clone(),
    ];
    let subst = |s: &str| -> String {
        s.replace("${auth_player_name}", "IEMLTest")
            .replace("${version_name}", &r.version_id)
            .replace("${game_directory}", &game_dir.to_string_lossy())
            .replace("${assets_root}", &shared.join("assets").to_string_lossy())
            .replace("${assets_index_name}", "1.12")
            .replace("${auth_uuid}", "00000000000000000000000000000000")
            .replace("${auth_access_token}", "0")
            .replace("${user_type}", "legacy")
            .replace("${version_type}", "release")
            .replace("${resolution_width}", "854")
            .replace("${resolution_height}", "480")
    };
    let mut game_args: Vec<String> = Vec::new();
    if let Some(a) = &merged.arguments {
        let features: std::collections::HashMap<String, bool> = std::collections::HashMap::from([
            ("is_demo_user".to_string(), false),
            ("has_custom_resolution".to_string(), true),
            ("has_quick_plays_support".to_string(), false),
            ("is_quick_play_singleplayer".to_string(), false),
            ("is_quick_play_multiplayer".to_string(), false),
            ("is_quick_play_realms".to_string(), false),
        ]);
        game_args = ieml_lib::game::launch_args::eval_args(&a.game, &features)
            .iter()
            .map(|s| subst(s))
            .collect();
    }
    /*
     * ★★ 老格式（1.12.2 就是）的游戏参数在 `minecraftArguments` 里，
     *   而 LiteLoader 的版本 JSON 只写了 `arguments.game = [--tweakClass …]`。
     *   所以合并后**两个字段都要用上**：
     *     · `arguments.game` 提供 tweakClass
     *     · `minecraftArguments` 提供 --username / --gameDir / --assetsDir 等
     *   只取一边就会启动即崩（实测：只取 arguments 时游戏参数只有 2 个）。
     *   这与生产代码 `launch_args.rs` 的处理必须一致。
     */
    if let Some(legacy) = &merged.minecraft_arguments {
        for part in legacy.split_whitespace() {
            game_args.push(subst(part));
        }
    }
    println!("  游戏参数 {} 个（含 minecraftArguments）", game_args.len());
    assert!(
        game_args.len() > 10,
        "★ 游戏参数太少了（{} 个）—— 老版本的 minecraftArguments 没被继承下来：{game_args:?}",
        game_args.len()
    );
    let tweak = game_args
        .iter()
        .position(|a| a == "--tweakClass")
        .map(|i| game_args.get(i + 1).cloned().unwrap_or_default());
    println!("  tweakClass = {tweak:?}（游戏参数 {} 个）", game_args.len());
    assert_eq!(
        tweak.as_deref(),
        Some(v.tweak_class.as_str()),
        "★ 合并后必须有 LiteLoader 的 tweakClass —— 少了它 launchwrapper 不知道要加载它"
    );
    args.extend(game_args);

    let mut cmd = std::process::Command::new(&java.path);
    cmd.args(&args)
        .current_dir(&game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::hide_console(&mut cmd);
    let mut child = cmd.spawn().expect("启动 JVM 失败");
    println!("  PID {}", child.id());
    let se = child.stderr.take().unwrap();
    let so = child.stdout.take().unwrap();
    let h1 = std::thread::spawn(move || {
        use std::io::BufRead;
        std::io::BufReader::new(se).lines().map_while(Result::ok).collect::<Vec<_>>()
    });
    let h2 = std::thread::spawn(move || {
        use std::io::BufRead;
        std::io::BufReader::new(so).lines().map_while(Result::ok).collect::<Vec<_>>()
    });

    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let alive = child.try_wait().ok().flatten().is_none();
    if alive {
        println!("  ✓ 30 秒后仍然活着");
        let _ = child.kill();
    } else {
        println!("  ✗ 进程已退出");
    }
    let _ = child.wait();
    let err = h1.join().unwrap_or_default();
    let out = h2.join().unwrap_or_default();

    println!("\n--- stderr（前 10 行）---");
    for l in err.iter().take(10) {
        println!("    {l}");
    }
    println!("--- stdout（前 30 行）---");
    for l in out.iter().take(30) {
        println!("    {l}");
    }
    let all = format!("{}\n{}", err.join("\n"), out.join("\n"));
    println!("\n日志里出现 LiteLoader 字样：{}", all.contains("LiteLoader") || all.contains("liteloader"));

    assert!(
        alive,
        "★★ LiteLoader 版本应该在 30 秒后仍然活着（真的进游戏了）—— 实际已退出。\n\
         上面的输出是现场。"
    );

    let _ = std::fs::remove_dir_all(&natives_dir);
    println!("\n✓ LiteLoader {} 能真的启动", r.version_id);
}
