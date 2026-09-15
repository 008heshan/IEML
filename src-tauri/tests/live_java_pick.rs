//! 真机验证：26.2 + Forge 65.1.3 到底该选哪个 Java。
//!
//! ## 背景（用户报「Forge 版 mc 还没打开就报错崩溃了」）
//!
//!   日志只有三行：
//!   ```text
//!   Error: Could not create the Java Virtual Machine.
//!   Error: A fatal exception has occurred. Program will exit.
//!   Unrecognized VM option 'UseCompactObjectHeaders'
//!   ```
//!   游戏一行自己的日志都没写 —— JVM 在启动前就拒绝了参数。
//!
//!   链路：`26.2` 的 JSON 写着 `javaVersion.majorVersion = 25`，
//!   而 Forge 65.1.3 的 profile 带 `-XX:+UseCompactObjectHeaders`（Java 24+）。
//!   老规则表只认 `>= 1.20.5 → Java 21`，于是拿 Java 21 去启动 → 直接崩。
//!
//! 这个测试**读真实的版本 JSON**，跑真实的判定，并断言"会选到 Java 25"。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_java_pick -- --ignored --nocapture
use ieml_lib::domain::java::{pick_java, JavaConstraintInput};
use ieml_lib::net::metadata::VersionJson;
use ieml_lib::platform;

/// 从真机数据目录里读某个版本 JSON（含 Forge 那种 inheritsFrom 的）
fn read_version(id: &str) -> Option<VersionJson> {
    let paths = platform::AppPaths::resolve();
    let p = paths.shared.join("versions").join(id).join(format!("{id}.json"));
    let text = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&text).ok()
}

fn mojang_java_of(v: &VersionJson) -> (u32, Option<String>) {
    match v.java_version.as_ref() {
        Some(j) => (
            j.major_version,
            if j.component.is_empty() {
                None
            } else {
                Some(j.component.clone())
            },
        ),
        None => (0, None),
    }
}

/// ★★ 这条就是用户那个崩溃的现场复现与修复验证。
#[test]
#[ignore = "真机测试：读本机数据目录里的版本 JSON"]
fn forge_26_2_resolves_to_java_25_not_21() {
    let base = read_version("26.2").expect("本机应该有 26.2 的版本 JSON");
    let (mojang_java, component) = mojang_java_of(&base);
    println!("\n=== 26.2 的 javaVersion ===");
    println!("  Mojang 声明：Java {mojang_java}（component = {component:?}）");
    assert!(
        mojang_java >= 22,
        "26.2 应该声明一个 >= 22 的 Java 版本，实际 {mojang_java}"
    );

    // Forge 的 JSON 自己也写不写 javaVersion？两者都要考虑
    let forged = read_version("26.2-forge-65.1.3");
    let forge_java = forged
        .as_ref()
        .map(|v| mojang_java_of(v).0)
        .unwrap_or(0);
    println!("  Forge profile 自己声明的：{forge_java}（0 = 没写，继承父版本）");
    let effective = if forge_java >= 22 { forge_java } else { mojang_java };

    // 构造真实的约束输入：26.2 + Forge
    let input = JavaConstraintInput::detailed("26.2", true, 0, false, effective, false);
    let req = ieml_lib::domain::java::resolve_java_requirement(input.clone());
    println!("\n=== 判定结果 ===");
    println!("  区间：{}", req.range.format());
    println!("  理由：{}", req.reason);
    for c in &req.constraints {
        println!("    · [{}] {} → {}", c.rule, c.range.format(), c.why);
    }

    assert!(
        req.range.contains(25.0),
        "★ Java 25 必须在区间内（Mojang 就是这么要求的）"
    );
    assert!(
        !req.range.contains(21.0),
        "★★ Java 21 不能在区间内 —— 拿它启动就是用户遇到的崩溃"
    );

    // 用本机**真实扫到的** Java 列表做选择
    let paths = platform::AppPaths::resolve();
    let runtimes = platform::scan_java(&paths);
    println!("\n=== 本机 Java ===");
    for r in &runtimes {
        println!("  Java {:>3}  {:<9} {}", r.major, r.source, r.path);
    }

    let picked = pick_java("auto", &runtimes, input, None, None);
    match &picked.runtime {
        Some(rt) => {
            println!("\n选中：Java {}（{}）", rt.major, rt.path);
            println!("理由：{}", picked.reason);
            assert_eq!(
                rt.major, 25,
                "★★ 26.2 + Forge 应该选到 Java 25（本机有），而不是 {}",
                rt.major
            );
        }
        None => panic!("★ 一个都没选到：{}", picked.reason),
    }
}

/// 反面对照：纯原版 1.12.2 仍然要 Java 8，**不许**被选成 25。
///
///   用户的要求「无论什么加载器还是原版，至少都得让玩家能玩」——
///   1.12.2 配 Java 25 是"能起但随时崩"，那是不能接受的。
#[test]
#[ignore = "真机测试：读本机数据目录与 Java 列表"]
fn vanilla_1_12_2_still_resolves_to_java_8() {
    let base = read_version("1.12.2").expect("本机应该有 1.12.2");
    let (mojang_java, _) = mojang_java_of(&base);
    println!("\n=== 1.12.2 ===");
    println!("  Mojang 声明：{mojang_java}（<22 所以不采信，走版本号规则）");

    let input = JavaConstraintInput::detailed("1.12.2", false, 0, false, mojang_java, false);
    let req = ieml_lib::domain::java::resolve_java_requirement(input.clone());
    println!("  区间：{}", req.range.format());
    assert!(req.range.contains(8.0), "1.12.2 必须允许 Java 8");
    assert!(
        !req.range.contains(25.0),
        "★★ 1.12.2 不该允许 Java 25（能起但随时崩），实际区间 {}",
        req.range.format()
    );

    let paths = platform::AppPaths::resolve();
    let runtimes = platform::scan_java(&paths);
    let picked = pick_java("auto", &runtimes, input, None, None);
    let rt = picked.runtime.expect("本机有 Java 8，应该能选到");
    println!("选中：Java {}（{}）", rt.major, rt.path);
    assert_eq!(rt.major, 8, "★ 1.12.2 应该选 Java 8，而不是 {}", rt.major);
}
