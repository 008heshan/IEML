//! 一次性诊断：**引擎为这个包体拿到哪些候选 URL、按什么顺序**。
//!
//! 加它的原因：本轮实测出现一个无法解释的差距 ——
//!   curl 镜像 20 秒 **830,464 字节**，而引擎 12 秒只有 **375 字节**。
//!   差 2000 倍，不可能是链路波动。**必须是引擎走了别的路。**
//!   而"走了哪条路"光读代码推不出来（候选顺序由 `candidate_urls` 决定）——
//!   所以直接把它打出来。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_candidates -- --ignored --nocapture

use ieml_lib::net::download::DownloadTask;
use ieml_lib::net::mirror::Source;

const OFFICIAL: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";
const MIRROR: &str =
    "https://mod.mcimirror.top/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";

#[test]
#[ignore = "不需要网络，只是把候选列表打出来"]
fn 这个包体的候选顺序是什么() {
    println!("\n════ 只给官方 URL（`candidate_urls` 应当补上镜像）════");
    for pref in [Source::Bmclapi, Source::Mojang] {
        let task = DownloadTask::new(
            std::path::PathBuf::from("/tmp/x"),
            OFFICIAL.to_string(),
            String::new(),
            0,
            "包体".into(),
        );
        println!("  preferred = {:?}", pref);
        for (i, (s, u)) in ieml_lib::net::source::candidates(&task, pref)
            .iter()
            .enumerate()
        {
            println!("    {i}. [{}] {}", s.as_str(), u);
        }
    }

    println!("\n════ 只给镜像 URL（启动器实际会传的形状？）════");
    for pref in [Source::Bmclapi, Source::Mojang] {
        let task = DownloadTask::new(
            std::path::PathBuf::from("/tmp/x"),
            MIRROR.to_string(),
            String::new(),
            0,
            "包体".into(),
        );
        println!("  preferred = {:?}", pref);
        for (i, (s, u)) in ieml_lib::net::source::candidates(&task, pref)
            .iter()
            .enumerate()
        {
            println!("    {i}. [{}] {}", s.as_str(), u);
        }
    }

    println!("\n★ 关键：**第一条**就是引擎先打的那条。curl 量的 830 KB 走的是镜像。");
    println!("   若第一条不是镜像 ⇒ 起手就打错了路（而它可能要等 20 秒超时才换）。");
}
