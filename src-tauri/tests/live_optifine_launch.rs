//! 真机验证：装完 OptiFine 之后，那个版本**能不能真的启动**。
//!
//!   "装上了"和"能玩"是两件事。用户的要求是
//!   「无论什么加载器还是原版，你至少都得让玩家能玩」，
//!   所以这里真的把那套参数拼出来、跑起来、看它有没有进到渲染。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_optifine_launch -- --ignored --nocapture
use ieml_lib::net::installer::scan_classpath;
use ieml_lib::net::metadata::VersionJson;
use ieml_lib::platform;
use std::process::Stdio;

fn read_version(shared: &std::path::Path, id: &str) -> Option<VersionJson> {
    let p = shared.join("versions").join(id).join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// 把 `inheritsFrom` 链合起来。
///
/// ★★ **调真正的那份实现**（`net::installer::merge_versions`），不要手写。
///
///   我第一版手写了一个"只拼 libraries、不管 arguments"的简化版 ——
///   于是 `arguments.game` 只剩 OptiFine 自己声明的
///   `["--tweakClass","optifine.OptiFineTweaker"]` 两项，
///   原版那 20 项（`--username` / `--version` / `--gameDir` / `--width` …）
///   全丢了。OptiFineTweaker 在 `acceptOptions` 里读不到它要的项，
///   直接抛 NullPointerException。
///
///   这与"启动器真的会这么拼吗"是同一个问题 ——
///   测试必须走**生产代码**，手写一份"等价物"就是在测自己。
fn merge(shared: &std::path::Path, v: VersionJson) -> VersionJson {
    use ieml_lib::net::installer::merge_versions;
    let mut cur = v;
    let mut hops = 0;
    while let Some(parent) = cur.inherits_from.clone() {
        if hops >= 4 {
            break;
        }
        let Some(pv) = read_version(shared, &parent) else { break };
        cur = merge_versions(&cur, &pv);
        // merge_versions 会保留 child 的 inheritsFrom；往上走一层
        cur.inherits_from = pv.inherits_from.clone();
        hops += 1;
    }
    cur
}

#[tokio::test]
#[ignore = "真机测试：会真的启动游戏并观察 30 秒"]
async fn optifine_version_actually_launches() {
    let paths = platform::AppPaths::resolve();
    let shared = &paths.shared;

    // 找刚才装出来的 OptiFine 版本
    /*
     * 被试版本可以从环境变量覆盖 —— 这样同一条命令既能测 OptiFine，
     * 也能测**纯原版**。有对照组才能分清"是 OptiFine 的问题"还是
     * "我这条测试命令本来就拼错了"（第一版就栽在这上面）。
     */
    let of_id = std::env::var("IEML_TEST_VERSION").ok().unwrap_or_else(|| {
        std::fs::read_dir(shared.join("versions"))
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| n.contains("-OptiFine_"))
            .expect("应该已经装过一个 OptiFine 版本（先跑 live_optifine）")
    });
    println!("\n=== 被试版本：{of_id} ===");

    let raw = read_version(shared, &of_id).expect("读版本 JSON 失败");
    let _mc = raw.inherits_from.clone();
    let version = merge(shared, raw);

    // ① classpath + natives
    let scan = scan_classpath(&version, shared);
    println!("库：classpath {} 条，natives {} 个", scan.classpath.len(), scan.natives.len());
    if !scan.missing.is_empty() {
        panic!("★ 缺库，肯定起不来：{:?}", scan.missing);
    }

    // ② natives 解压
    let natives_dir = std::env::temp_dir().join(format!("ieml-of-natives-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&natives_dir);
    std::fs::create_dir_all(&natives_dir).unwrap();
    let mut n = 0;
    for (jar, exclude) in &scan.natives {
        n += ieml_lib::net::installer::extract_natives(jar, &natives_dir, exclude).unwrap_or(0);
    }
    println!("natives 解压 {n} 个文件");
    assert!(n > 0, "★ natives 一个都没解出来");

    // ③ 客户端 jar（合并链里找）
    let client_jar = {
        let mut cur = Some(of_id.clone());
        let mut found = None;
        let mut guard = 0;
        while let Some(id) = cur {
            if guard > 4 {
                break;
            }
            let p = shared.join("versions").join(&id).join(format!("{id}.jar"));
            if p.is_file() {
                found = Some(p);
                break;
            }
            cur = read_version(shared, &id).and_then(|v| v.inherits_from);
            guard += 1;
        }
        found.expect("找不到客户端 jar")
    };

    let mut cp: Vec<String> = scan
        .classpath
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    cp.push(client_jar.to_string_lossy().to_string());
    let cp_str = cp.join(";");

    // ④ 游戏目录（用真实实例的 game 目录，这样 options/saves 都在）
    let game_dir = paths.instance_game_dir("vanilla-1122");
    let _ = std::fs::create_dir_all(&game_dir);

    // ⑤ 选 Java：1.16.5 要 Java 8
    let runtimes = platform::scan_java(&paths);
    let java = runtimes
        .iter()
        .find(|r| r.major == 8)
        .expect("1.16.5 需要 Java 8");
    println!("用 Java {}：{}", java.major, java.path);

    // ⑥ 拼参数并**真的跑**
    //
    //    ★ 游戏参数的正确来源：新版版本 JSON 用 `arguments.game`，
    //      老版（1.12.2 及更早）才用 `minecraftArguments`。
    //      1.16.5 属于前者 —— 我第一版只读了 `minecraftArguments`（它是空的），
    //      于是 `--tweakClass optifine.OptiFineTweaker` 根本没传进去，
    //      launchwrapper 找不到 tweaker，报 `ClassNotFoundException:
    //      net.minecraft.launchwrapper.VanillaTweaker`。
    //      **那次失败是测试拼错了命令，不是 OptiFine 装错了。**
    let mut args = vec![
        "-XX:+IgnoreUnrecognizedVMOptions".to_string(),
        "-Xmx2G".to_string(),
        "-Xms1G".to_string(),
        format!("-Djava.library.path={}", natives_dir.display()),
        "-Dfile.encoding=UTF-8".to_string(),
        "-cp".to_string(),
        cp_str,
        version.main_class.clone(),
    ];
    let subst = |s: &str| -> String {
        s.replace("${auth_player_name}", "IEMLTest")
            .replace("${version_name}", &of_id)
            .replace("${game_directory}", &game_dir.to_string_lossy())
            .replace("${assets_root}", &shared.join("assets").to_string_lossy())
            .replace("${assets_index_name}", "1.16")
            .replace("${auth_uuid}", "00000000000000000000000000000000")
            .replace("${auth_access_token}", "0")
            .replace("${user_type}", "legacy")
            .replace("${version_type}", "release")
            .replace("${resolution_width}", "854")
            .replace("${resolution_height}", "480")
    };
    let mut game_args: Vec<String> = Vec::new();
    if let Some(a) = &version.arguments {
        /*
         * ★★ 必须用**真正的求值器**（`launch_args::eval_args`），不能自己挑。
         *
         *   第一版我手写了一个"跳过带 rules 的项"的循环 —— 于是
         *   `{"rules":[{...has_custom_resolution...}],"value":["--width",...]}`
         *   被整条丢掉，游戏参数从 18 个变成 2 个（只剩 --tweakClass）。
         *   结果 OptiFineTweaker 在 `acceptOptions` 里读不到它要的项，
         *   抛 NullPointerException。
         *
         *   而**纯原版**用同一条测试跑是好的（对照组活了 30 秒、
         *   进了渲染线程、`Setting user` 都打出来了）—— 这正好证明
         *   失败是"我的测试拼错了命令"，不是 OptiFine 装错了。
         *   （这就是对照组存在的意义。）
         */
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
    if game_args.is_empty() {
        if let Some(legacy) = &version.minecraft_arguments {
            for part in legacy.split_whitespace() {
                game_args.push(subst(part));
            }
        }
    }
    println!("游戏参数 {} 个", game_args.len());
    let tweak = game_args
        .iter()
        .position(|a| a == "--tweakClass")
        .map(|i| game_args.get(i + 1).cloned().unwrap_or_default());
    println!("tweakClass = {tweak:?}");
    if of_id.contains("OptiFine") {
        assert_eq!(
            tweak.as_deref(),
            Some("optifine.OptiFineTweaker"),
            "★ 合并后的游戏参数里必须有 --tweakClass optifine.OptiFineTweaker"
        );
    }
    args.extend(game_args);

    println!("\n=== 启动（观察 30 秒）===");
    let mut cmd = std::process::Command::new(&java.path);
    cmd.args(&args)
        .current_dir(&game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::hide_console(&mut cmd);
    let mut child = cmd.spawn().expect("启动 JVM 失败");
    println!("PID {}", child.id());

    // 一边等一边收输出
    let stderr = child.stderr.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let h1 = std::thread::spawn(move || {
        use std::io::BufRead;
        std::io::BufReader::new(stderr).lines().map_while(Result::ok).collect::<Vec<_>>()
    });
    let h2 = std::thread::spawn(move || {
        use std::io::BufRead;
        std::io::BufReader::new(stdout).lines().map_while(Result::ok).collect::<Vec<_>>()
    });

    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let alive = child.try_wait().ok().flatten().is_none();
    if alive {
        println!("✓ 30 秒后进程仍然活着");
        let _ = child.kill();
    } else {
        println!("✗ 进程已经退出：{:?}", child.try_wait());
    }
    let _ = child.wait();
    let err_lines = h1.join().unwrap_or_default();
    let out_lines = h2.join().unwrap_or_default();

    println!("\n--- stderr（前 15 行）---");
    for l in err_lines.iter().take(15) {
        println!("  {l}");
    }
    println!("\n--- stdout（全部，共 {} 行）---", out_lines.len());
    for l in out_lines.iter() {
        println!("  {l}");
    }

    let all = format!("{}\n{}", err_lines.join("\n"), out_lines.join("\n"));
    let of_loaded = all.contains("OptiFine") || all.contains("optifine");
    println!("\n日志里出现 OptiFine 字样：{of_loaded}");

    assert!(
        alive,
        "★★ OptiFine 版本应该在 30 秒后仍然活着（真的进游戏了）—— 实际已经退出。\n\
         上面 stderr/stdout 是现场，请据此修。"
    );

    let _ = std::fs::remove_dir_all(&natives_dir);
    println!("\n✓ OptiFine {} 能真的启动", of_id);
}
