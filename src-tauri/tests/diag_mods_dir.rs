//! 排查：「Mod 列表不显示」——**每个 slug 实际解析到哪个目录**。
//!
//! 用户截图：`D:\IEML\.minecraft\versions\26.3-fabric-0.19.5\mods\` 里有 jar，
//! 而界面显示「0 / 0 个」。
//!
//! 所以要看的是**路径解析**（而不是"文件在不在"）：
//!   `instance_mods_dir(slug)` → `game_dir_of(slug)/mods`，
//!   而 `game_dir_of` 会先做 ADR-005 的隔离判定 ——
//!   **判定为"不隔离"时会指向共享的 `.minecraft`**，于是实例自己的 `mods/` 就看不见了。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_mods_dir -- --ignored --nocapture
use ieml_lib::platform::AppPaths;

#[test]
#[ignore = "诊断：读用户数据目录"]
fn which_dir_does_each_slug_resolve_to() {
    let p = AppPaths::resolve();
    println!("\n数据根 root      = {}", p.root.display());
    println!("游戏目录 .minecraft = {}", p.game_dir().display());
    println!("版本目录 versions   = {}", p.instances.display());
    println!("游匣目录 own_root   = {}", p.own_root.display());

    let Some(ledger) = p.own_json("instances.json") else {
        println!("\n★ 读不到账本（{}）", p.instances_file().display());
        return;
    };
    let empty = Vec::new();
    let list = ledger
        .get("instances")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    println!("\n=== 每个 slug 解析到哪里 ===");
    for inst in list {
        let Some(slug) = inst
            .get("config")
            .and_then(|c| c.get("slug"))
            .and_then(|s| s.as_str())
        else {
            continue;
        };
        let name = inst
            .get("config")
            .and_then(|c| c.get("name"))
            .and_then(|s| s.as_str())
            .unwrap_or("?");
        let verdict = p.isolation_verdict(slug);
        let game = p.game_dir_of(slug);
        let mods = p.instance_mods_dir(slug);
        let n = std::fs::read_dir(&mods)
            .map(|it| it.flatten().filter(|e| e.path().is_file()).count())
            .unwrap_or(0);
        println!(
            "  {slug:<28} 【{name}】\n      隔离={} ({})  来源={}\n      游戏目录={}\n      mods    ={}  ← {n} 个文件{}",
            verdict.isolated,
            verdict.reason,
            verdict.source_str(),
            game.display(),
            mods.display(),
            if n == 0 { "   ★ 空的！" } else { "" },
        );
    }

    // 共享的 mods 目录里有什么（"不隔离"时游戏会读它）
    let shared_mods = p.shared.join("mods");
    let n = std::fs::read_dir(&shared_mods)
        .map(|it| it.flatten().count())
        .unwrap_or(0);
    println!(
        "\n共享 .minecraft/mods = {}（{n} 项，存在={}）",
        shared_mods.display(),
        shared_mods.is_dir()
    );
}
