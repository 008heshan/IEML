/**
 * 真机验证：Java 探测能不能扫到用户的 Java 21 / 8。
 * ------------------------------------------------------------------
 * 为什么值得一个独立脚本（而不是只跑单元测试）：
 *
 *   用户报的原话是「IEML 管我要 java21，但我的电脑里确实有 java21，还有 25，
 *   也就是说它根本不知道去哪里找 java」。这句话只有**在这台机器上**
 *   才验得了 —— 单元测试里没有 `%APPDATA%\.minecraft\runtime`
 *   这两个真实的运行时目录。
 *
 * 用法：
 *   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
 *     test --manifest-path src-tauri/Cargo.toml --test live_java_scan -- --ignored --nocapture
 */
use ieml_lib::platform;

#[test]
#[ignore = "真机测试：需要本机装过 Java"]
fn scan_finds_java_that_actually_exists_on_this_machine() {
    let paths = platform::AppPaths::resolve();
    let found = platform::scan_java(&paths);

    println!("\n=== 扫描结果（{} 份） ===", found.len());
    for r in &found {
        println!(
            "  Java {:>3}  {:<10} {:<12} {}",
            r.major,
            r.source,
            r.vendor,
            r.path
        );
    }

    let majors: Vec<u32> = {
        let mut m: Vec<u32> = found.iter().map(|r| r.major).collect();
        m.sort_unstable();
        m.dedup();
        m
    };
    println!("扫到的主版本：{majors:?}\n");

    /*
     * ★ 判据是"用户说他有 Java 21 和 25，那就必须都扫得到"。
     *   本机事实（2026-09-14 采集）：
     *     · Java 21.0.7 —— `%APPDATA%\.minecraft\runtime\java-runtime-delta`
     *       （**Minecraft 官方启动器**下的，老实现完全没扫这个位置）
     *     · Java 25     —— `C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot`
     *     · Java 8      —— `%APPDATA%\.minecraft\runtime\jre-legacy`
     */
    assert!(
        majors.contains(&21),
        "★ 必须扫到 Java 21（它在 .minecraft\\runtime 下）—— 实际只扫到 {majors:?}"
    );
    assert!(
        majors.contains(&25),
        "★ 必须扫到 Java 25（Adoptium）—— 实际只扫到 {majors:?}"
    );
    assert!(
        majors.contains(&8),
        "★ 必须扫到 Java 8（官方启动器的 jre-legacy）—— 实际只扫到 {majors:?}"
    );

    // 来源必须如实标注（界面靠它告诉用户"这份 Java 是哪来的"）
    let j21 = found.iter().find(|r| r.major == 21).unwrap();
    println!("Java 21 的来源标注：{}", j21.source);
    assert!(
        ["mojang", "registry", "launcher", "system", "downloaded", "manual", "scan"]
            .contains(&j21.source.as_str()),
        "来源必须是已知的那几种之一，实际：{}",
        j21.source
    );

    // 每一条都必须是真的能跑的（probe_java 跑过 `java -version` 才会出现在这里）
    for r in &found {
        assert!(
            std::path::Path::new(&r.path).is_file(),
            "报告了却不存在：{}",
            r.path
        );
        assert!(r.major > 0, "版本号必须是探测出来的，不是猜的：{}", r.path);
    }
}

/// 数据目录选址：**默认不该落在系统盘上**
#[test]
#[ignore = "真机测试：会读写磁盘"]
fn data_root_avoids_the_system_drive_on_this_machine() {
    let legacy = platform::legacy_data_roots()[0].clone();
    println!("\n老位置：{}", legacy.display());
    println!("系统盘？{}", platform::is_on_system_drive(&legacy));

    let chosen = platform::resolve_data_root();
    println!("现在选的位置：{}", chosen.display());
    println!("选址记录：{}", platform::AppPaths::location_file().display());

    assert!(
        !chosen.as_os_str().is_empty(),
        "必须选出一个位置（哪怕退回老位置）"
    );
    /*
     * ★ 本机有三个盘（C: 系统盘、D: 541 GB 空闲、E: 109 GB 空闲），
     *   所以选址**必须**避开 C:。单盘机器不适用这条。
     */
    let has_other_drive = ['D', 'E', 'F']
        .iter()
        .any(|d| std::path::Path::new(&format!("{d}:\\")).is_dir());
    if has_other_drive {
        assert!(
            !platform::is_on_system_drive(&chosen),
            "★ 有别的盘却把数据放在系统盘上（{}）—— 用户明确要求避开系统盘",
            chosen.display()
        );
    }
}
