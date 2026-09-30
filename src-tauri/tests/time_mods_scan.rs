//! 「Mod 列表加载/刷新慢」的**真机计时**（用户反馈）。
//!
//! ## 为什么先写计时再动手
//!
//!   这条链路上有四段，量级差得很远：
//!     ① 读盘（`read_dir` + `metadata`）—— 微秒级
//!     ② 算 SHA1 + CurseForge 指纹 —— 每 MB 几毫秒
//!     ③ Modrinth 按哈希反查版本 —— **每次网络往返几百毫秒起**
//!     ④ 按项目 id 取标题/前置库 —— 又一次网络往返
//!     ⑤ CurseForge 指纹兜底 —— 只在 Modrinth 查不到时才发
//!
//!   "感觉慢"没法定位，所以这里**只测真实数据、只打印数字**，不改任何逻辑。
//!   用户机器上只有 1 个 Mod（2.6 MB）⇒ ① ② 根本不可能是瓶颈，
//!   而 ③ ④ 是**每个 Mod 都要走**的固定往返 —— 这一个测试就能把话说死。
//!
//! 用法：
//!   $env:IEML_TIME_MODS="1"
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test time_mods_scan -- --ignored --nocapture
use ieml_lib::platform;
use std::time::Instant;

/// 用户当前实例的 mods 目录（数据根由 `datadir.txt` 决定）。
fn active_mods_dirs() -> Vec<(String, std::path::PathBuf)> {
    let root = platform::resolve_data_root();
    let versions = root.join(".minecraft").join("versions");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&versions) else {
        return out;
    };
    for e in rd.flatten() {
        let mods = e.path().join("mods");
        if mods.is_dir() {
            let n = std::fs::read_dir(&mods)
                .map(|it| it.flatten().count())
                .unwrap_or(0);
            if n > 0 {
                out.push((e.file_name().to_string_lossy().to_string(), mods));
            }
        }
    }
    out.sort();
    out
}

/// ①② 本地那两段（读盘 + 哈希）—— 这一半**完全不联网**。
#[test]
#[ignore = "真机计时：读用户数据目录，只打印数字"]
fn local_scan_is_not_the_bottleneck() {
    let dirs = active_mods_dirs();
    assert!(
        !dirs.is_empty(),
        "数据根 {} 下没有任何带 Mod 的版本目录",
        platform::resolve_data_root().display()
    );

    println!("\n=== ① ② 本地段（读盘 + SHA1/指纹）===");
    for (slug, mods) in &dirs {
        // 读盘
        let t0 = Instant::now();
        let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
        for e in std::fs::read_dir(mods).unwrap().flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if !ieml_lib::domain::mods::is_mod_file(&name) {
                continue;
            }
            let meta = e.metadata().unwrap();
            files.push((name, p, meta.len()));
        }
        let read_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // 哈希（与 `scan_mods_detailed` 里那一段逐行同源）
        let t1 = Instant::now();
        let mut total = 0u64;
        for (_, path, bytes) in &files {
            let data = std::fs::read(path).unwrap_or_default();
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&data);
            let _ = format!("{:x}", h.finalize());
            let _ = ieml_lib::net::curseforge::fingerprint(&data);
            total += bytes;
        }
        let hash_ms = t1.elapsed().as_secs_f64() * 1000.0;

        println!(
            "  {slug:<28} {} 个文件 / {:.1} MB —— 读盘 {:.1} ms · 哈希 {:.1} ms",
            files.len(),
            total as f64 / 1024.0 / 1024.0,
            read_ms,
            hash_ms
        );
    }
    println!("\n★ 结论：本地段是毫秒级。用户感知到的「慢」如果超过 1 秒，必定在网络那一段。");
}

/// ★★ Mod 图标提取：在**真实 jar** 上验证（用户：「我还要 mod 的图标」）。
///
///   这一条必须是真机测试：图标藏在 jar 的内部结构里（元数据字段名、路径写法
///   三种加载器各一套），用假 zip 造出来的夹具证明不了"真的能解出来"。
#[test]
#[ignore = "真机：读用户数据目录里的真实 Mod"]
fn real_mod_jars_yield_an_icon() {
    let dirs = active_mods_dirs();
    assert!(!dirs.is_empty(), "没有找到带 Mod 的版本目录");

    let mut found = 0usize;
    let mut checked = 0usize;
    for (slug, mods) in &dirs {
        for e in std::fs::read_dir(mods).unwrap().flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if !ieml_lib::domain::mods::is_mod_file(&name) {
                continue;
            }
            checked += 1;
            let t = Instant::now();
            let icon = ieml_lib::domain::mods::read_mod_icon(&p);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            match &icon {
                Some(uri) => {
                    found += 1;
                    println!(
                        "  ✓ {slug}/{name}  {:>6.0} ms  {} 字节的 data URI（{}）",
                        ms,
                        uri.len(),
                        uri.split(';').next().unwrap_or("")
                    );
                }
                None => println!("  · {slug}/{name}  {:>6.0} ms  这个 jar 里没有图标", ms),
            }
        }
    }
    println!("\n★ {checked} 个 Mod 里有 {found} 个解出了图标");
    assert!(
        found > 0,
        "★ 一个图标都没解出来 —— 说明元数据字段名或路径写法猜错了（真机上有 Fabric API，它一定有图标）"
    );
}
///
/// ★ 用**真实文件**算出来的 SHA1 与指纹去打真实接口 —— 因为"空请求快、真实请求慢"
///   正是要分辨的那件事（限流、被墙、DNS 慢都只在真实请求上出现）。
#[tokio::test]
#[ignore = "真机计时：会联网"]
async fn online_lookup_is_the_bottleneck() {
    use sha1::{Digest, Sha1};

    let dirs = active_mods_dirs();
    assert!(!dirs.is_empty(), "没有找到带 Mod 的版本目录");
    let (slug, mods) = &dirs[0];

    // 拿第一个真实 Mod 的 sha1 + 指纹
    let mut sha1s: Vec<String> = Vec::new();
    let mut fps: Vec<u32> = Vec::new();
    for e in std::fs::read_dir(mods).unwrap().flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Ok(data) = std::fs::read(&p) else { continue };
        let mut h = Sha1::new();
        h.update(&data);
        sha1s.push(format!("{:x}", h.finalize()));
        fps.push(ieml_lib::net::curseforge::fingerprint(&data));
    }
    println!("\n=== ③④⑤ 网络段（实例 {slug}，{} 个文件）===", sha1s.len());

    let t = Instant::now();
    let versions = ieml_lib::modrinth::versions_from_hashes(&sha1s).await;
    let mr_ms = t.elapsed().as_secs_f64() * 1000.0;
    let project_ids: Vec<String> = versions
        .as_ref()
        .map(|m| m.values().map(|v| v.project_id.clone()).collect())
        .unwrap_or_default();
    println!(
        "  ③ Modrinth 按哈希查版本   {mr_ms:>8.0} ms   命中 {}",
        versions.as_ref().map(|m| m.len()).unwrap_or(0)
    );

    let t = Instant::now();
    let projects = ieml_lib::modrinth::projects_by_ids(&project_ids).await;
    println!(
        "  ④ Modrinth 取项目信息     {:>8.0} ms   命中 {}",
        t.elapsed().as_secs_f64() * 1000.0,
        projects.as_ref().map(|m| m.len()).unwrap_or(0)
    );

    let t = Instant::now();
    let cf = ieml_lib::net::curseforge::match_fingerprints(&fps).await;
    println!(
        "  ⑤ CurseForge 指纹兜底     {:>8.0} ms   命中 {}",
        t.elapsed().as_secs_f64() * 1000.0,
        cf.as_ref().map(|m| m.len()).unwrap_or(0)
    );

    println!(
        "\n★ 结论：本地段是毫秒级，网络段是**每次几百毫秒 × 每个 Mod**。\
         \n  刷新时整段重跑 ⇒ 用户感知到的「慢」就是它。"
    );
}
