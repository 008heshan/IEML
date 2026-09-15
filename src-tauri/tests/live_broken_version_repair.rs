//! 真机验证：**"有 jar、没有版本 JSON"的半成品目录能被修好**。
//!
//! ## 现场（本机真实数据）
//!
//!   `versions/1.20.1` / `1.21.1` / `26.1.1` / `rd-132211` 这几份目录里
//!   **只有客户端 jar、没有同名 json**。这种目录：
//!     · 起不来 —— `prepare_spec` 找不到版本描述
//!     · **点"重新安装"也修不好** —— 下载器看到 jar 已经在就跳过，
//!       而 json 是在安装**末尾**才写的，中途取消就永远不会补上
//!
//! ## 修法
//!
//!   ① `install()` **一开始**就先落一份版本 JSON（失败也有描述）；
//!   ② `install()` 开始前**自检**：目录在、json 不在 → 整个删掉重来，
//!      保证"这一份一定能被修好"。
//!
//! 这个测试把两件事都验一遍。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_broken_version_repair -- --ignored --nocapture
use ieml_lib::net::installer;
use ieml_lib::platform;

/// 数一数本机有几个"只有 jar 没有 json"的版本目录
fn scan_broken(shared: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let versions = shared.join("versions");
    let Ok(rd) = std::fs::read_dir(&versions) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let has_json = dir.join(format!("{name}.json")).is_file();
        let has_jar = dir.join(format!("{name}.jar")).is_file();
        if has_jar && !has_json {
            out.push(name);
        }
    }
    out.sort();
    out
}

#[test]
#[ignore = "真机测试：会读本机数据目录"]
fn broken_version_directories_are_detected() {
    let paths = platform::AppPaths::resolve();
    let broken = scan_broken(&paths.shared);
    println!("\n=== 本机「只有 jar、没有 json」的版本目录 ===");
    if broken.is_empty() {
        println!("  （没有 —— 说明都修好了，或者本来就没有）");
    } else {
        for b in &broken {
            println!("  ✗ {b}");
        }
        println!(
            "\n这 {} 个目录**起不来**，而且点「重新安装」也修不好 —— \
             必须先删掉（`install()` 现在会自动这么做）",
            broken.len()
        );
    }
    // 这条测试**不失败** —— 它是"体检报告"，不是断言。
    // 真正要守的性质在下一条（修复行为本身）。
}

/// ★★ 修好一个**人为造出来的**半成品目录。
///
///   在自己造的沙盒里做，不动用户真实数据 ——
///   但走的**是生产代码**（`installer::install` 的自检 + 早写盘）。
#[tokio::test]
#[ignore = "真机测试：会创建临时目录并联网下载一个版本 JSON（约 30 KB）"]
async fn install_repairs_a_directory_that_has_jar_but_no_json() {
    /*
     * 造沙盒：一个空的 shared 目录。
     * 里面放一个"只有 jar 没有 json"的假版本 —— 就用一个真实存在的
     * MC 版本 id，这样安装流程能真的走通（清单里找得到它）。
     */
    let mc = "1.20.1";
    let sandbox = std::env::temp_dir().join(format!("ieml-repair-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    let shared = sandbox.join("shared");
    let instance = sandbox.join("instances").join("probe");
    std::fs::create_dir_all(&instance).unwrap();

    let vdir = shared.join("versions").join(mc);
    std::fs::create_dir_all(&vdir).unwrap();
    // 假装"上次装到一半"：jar 有了、json 没有
    std::fs::write(vdir.join(format!("{mc}.jar")), vec![0u8; 4096]).unwrap();
    let json_path = vdir.join(format!("{mc}.json"));
    assert!(!json_path.is_file(), "前置条件：json 本来就不在");
    println!("\n=== 造好半成品目录 ===");
    println!("  {}（只有 jar）", vdir.display());

    /*
     * 构造一次真实的安装输入 —— 手动拼 `PlanInput`（它是 pub 的），
     * 而不是调那个私有的 `build_plan_input`。
     * 这里只用**生产数据结构**，不自己造一份"等价物"。
     */
    let src = ieml_lib::net::mirror::Source::Bmclapi;
    let manifest = ieml_lib::net::metadata::fetch_manifest(src)
        .await
        .expect("拉版本清单失败");
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc)
        .expect("清单里应该有 1.20.1");
    let version: ieml_lib::net::metadata::VersionJson =
        ieml_lib::net::get_json(&entry.url).await.expect("拉版本 JSON 失败");
    let input = ieml_lib::net::installer::PlanInput {
        version,
        shared_root: shared.clone(),
        instance_dir: instance.clone(),
        source: src,
        download_assets: false,
    };

    let cancel = ieml_lib::net::download::CancelToken::new();
    let mut opts = installer::InstallOptions::new(2, cancel.clone());
    // ★ 不下资源文件：那个要几百 MB，而这条测试只关心版本 JSON
    opts.download_assets = false;

    // ★ 立刻取消 —— 模拟"用户装到一半点了取消"。
    //   这正是以前会留下半成品的场景。
    cancel.cancel();

    println!("\n=== 跑一次**立刻取消**的安装（模拟用户中途取消）===");
    let r = installer::install(&input, opts).await;
    println!("  安装返回：{}", if r.is_ok() { "Ok" } else { "Err" });

    /*
     * ★★ 这就是要守的性质：**即使安装被立刻取消，版本 JSON 也必须在。**
     *
     *   （自检会先把那个只有 jar 的目录删掉，然后早写盘把 json 补上。）
     */
    let repaired = json_path.is_file();
    println!(
        "\n=== 结果 ===\n  json 存在？{}",
        if repaired { "✓ 是" } else { "✗ 否" }
    );
    if repaired {
        let text = std::fs::read_to_string(&json_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).expect("写出来的必须是合法 JSON");
        println!("  id = {}", v["id"]);
        println!("  mainClass = {}", v["mainClass"]);
        println!("  libraries = {} 条", v["libraries"].as_array().map(|a| a.len()).unwrap_or(0));
    } else {
        let left: Vec<String> = std::fs::read_dir(&vdir)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        println!("  目录里剩下的东西：{left:?}");
    }

    let _ = std::fs::remove_dir_all(&sandbox);

    assert!(
        repaired,
        "★★ 安装即使被中途取消，也**必须**留下版本 JSON —— \
         否则就会产生「有 jar 没有 json」的半成品目录：\n\
         那种目录起不来，而且点「重新安装」也永远修不好（jar 在就跳过下载）。"
    );
    println!("\n✓ 半成品目录被修好了（版本 JSON 已就位）");
}
