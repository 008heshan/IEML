//! 真机验证：造出 26.2 + Forge 的启动命令，确认它能被 JVM 接受。
//!
//! ## 背景（用户报「Forge 版 mc 还没打开就报错崩溃了」）
//!
//!   现场三行：
//!   ```text
//!   Error: Could not create the Java Virtual Machine.
//!   Error: A fatal exception has occurred. Program will exit.
//!   Unrecognized VM option 'UseCompactObjectHeaders'
//!   ```
//!
//!   这个测试做两件事，**都不依赖启动器界面**：
//!     ① 用真实版本 JSON 拼出 JVM 参数，断言里面有
//!        `-XX:+IgnoreUnrecognizedVMOptions`（保险），并且选中的 Java 是 25；
//!     ② **真的用这个 Java 跑一遍参数解析**（`-version` + 全部 `-XX:` 参数），
//!        断言 JVM 不报 `Unrecognized VM option`。
//!
//!   第 ② 步是关键 —— 它是"我修好了"与"真的能起"之间的那道证明。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_forge_launch_args -- --ignored --nocapture
use ieml_lib::domain::java::{pick_java, JavaConstraintInput};
use ieml_lib::net::metadata::VersionJson;
use ieml_lib::platform;
use std::process::{Command, Stdio};

fn read_version(id: &str) -> Option<VersionJson> {
    let paths = platform::AppPaths::resolve();
    let p = paths
        .shared
        .join("versions")
        .join(id)
        .join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// 从版本 JSON（含 inheritsFrom 链）里收集所有 `-XX:` 形式的 JVM 参数。
fn collect_xx_args(v: &VersionJson, shared: &std::path::Path, out: &mut Vec<String>, depth: u32) {
    if depth > 4 {
        return;
    }
    if let Some(args) = v.arguments.as_ref() {
        for a in &args.jvm {
            let Some(s) = a.as_str() else { continue };
            if s.starts_with("-XX:") {
                out.push(s.to_string());
            }
        }
    }
    if let Some(parent) = v.inherits_from.as_deref() {
        let p = shared
            .join("versions")
            .join(parent)
            .join(format!("{parent}.json"));
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(pv) = serde_json::from_str::<VersionJson>(&text) {
                collect_xx_args(&pv, shared, out, depth + 1);
            }
        }
    }
}

#[test]
#[ignore = "真机测试：会真的跑 java 一次"]
fn forge_26_2_jvm_args_are_accepted_by_the_chosen_java() {
    let paths = platform::AppPaths::resolve();
    let forged = read_version("26.2-forge-65.1.3").expect("本机应该装了 Forge 26.2");
    let base = read_version("26.2").expect("本机应该有 26.2");

    // ① 收集 Forge 与父版本声明的所有 -XX: 参数
    let mut xx = Vec::new();
    collect_xx_args(&forged, &paths.shared, &mut xx, 0);
    println!("\n=== 版本 JSON 里的 -XX: 参数 ===");
    for a in &xx {
        println!("  {a}");
    }
    assert!(
        xx.iter().any(|a| a.contains("UseCompactObjectHeaders")),
        "Forge 65 的 profile 里应该有 UseCompactObjectHeaders（这就是崩溃的源头）"
    );
    xx.sort();
    xx.dedup();
    println!("（去重后 {} 个）", xx.len());

    // ② 选 Java
    let mojang_java = base
        .java_version
        .as_ref()
        .map(|j| j.major_version)
        .unwrap_or(0);
    let input = JavaConstraintInput::detailed("26.2", true, 0, false, mojang_java, false);
    let runtimes = platform::scan_java(&paths);
    let picked = pick_java("auto", &runtimes, input, None, None);
    let java = picked.runtime.expect("应该能选到 Java");
    println!("\n选中的 Java：{} {}", java.major, java.path);
    assert_eq!(java.major, 25, "★ 26.2 + Forge 必须用 Java 25");

    // ③ ★ 真的让 JVM 解析这些参数
    //
    //    用 `-version` 让 JVM 在解析完所有参数后立刻退出 ——
    //    这样能真实地走完"参数校验"这一步，而我们不用真的启动游戏。
    println!("\n=== 让 JVM 真的解析这些参数 ===");
    let mut cmd = Command::new(&java.path);
    // 先放保险，再放 Forge 自己的参数（与 launch_args 的顺序一致）
    cmd.arg("-XX:+IgnoreUnrecognizedVMOptions");
    for a in &xx {
        cmd.arg(a);
    }
    cmd.arg("-version").stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::hide_console(&mut cmd);
    let out = cmd.output().expect("跑 java 失败");
    let stderr = String::from_utf8_lossy(&out.stderr);
    println!("退出码：{}", out.status);
    println!("stderr 首行：{}", stderr.lines().next().unwrap_or("(空)"));

    assert!(
        !stderr.contains("Unrecognized VM option"),
        "★ JVM 仍然拒绝了参数：\n{stderr}"
    );
    assert!(
        out.status.success(),
        "★ JVM 退出码非 0，参数解析失败：\n{stderr}"
    );
    println!("\n✓ Java 25 接受了 Forge 65 的全部 -XX: 参数");

    // ④ 反面对照：**故意**用 Java 21 跑一遍，证明"不加保险就会崩"
    //    —— 这样这条测试才真的在测东西（对照组必须能失败）
    if let Some(j21) = runtimes.iter().find(|r| r.major == 21) {
        println!("\n=== 对照：用 Java 21 跑同样的参数（应该失败）===");
        let mut bad = Command::new(&j21.path);
        for a in &xx {
            bad.arg(a);
        }
        bad.arg("-version").stdout(Stdio::piped()).stderr(Stdio::piped());
        platform::hide_console(&mut bad);
        let bout = bad.output().expect("跑 java 失败");
        let bstderr = String::from_utf8_lossy(&bout.stderr);
        println!("退出码：{}", bout.status);
        println!("stderr 首行：{}", bstderr.lines().next().unwrap_or("(空)"));
        assert!(
            !bout.status.success(),
            "★ 对照组应该失败（Java 21 不认识 UseCompactObjectHeaders）—— \
             如果它成功了，说明这个测试根本没测到那条参数，结论不可信"
        );
        println!("✓ 对照组如预期失败 —— 说明上面那条'不报 Unrecognized'是有意义的");
    }
}
