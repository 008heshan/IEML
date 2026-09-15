//! 真机验证 + **一次性修复**：把被写空的 `instances.json` 从老位置补回来。
//!
//! ## 背景（实测事故）
//!
//!   这一轮开发中出现了**真的丢用户数据**的 bug，两端合起来造成的：
//!     · 前端：`boot` 的 `Promise.all` 里任何一条失败 → 整体 catch →
//!       实例列表留在 `[]`，而"实例变更时落盘"只判 `state.ready`
//!       （fail 也置真）→ 250ms 后把**空列表写回磁盘**；
//!     · 后端：迁移只按"目标存在就跳过"处理，于是被写空的那份**永远修不回来**。
//!
//!   结局：`instances.json` 变成 `{"instances":[],"active_id":null}`，
//!   用户建的版本从界面上消失（游戏文件还在）。
//!
//!   两端都已修好。这个测试用**用户自己的真实目录**跑一遍修复流程，
//!   把记录补回来 —— 顺带证明"补齐"这条路径在真实数据上确实有效。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test repair_instances -- --ignored --nocapture
use ieml_lib::platform;

#[test]
#[ignore = "真机测试：会读写用户的数据目录"]
fn repair_emptied_instance_list_from_legacy_location() {
    let root = platform::resolve_data_root();
    let legacy = &platform::legacy_data_roots()[0];
    println!("\n当前数据目录：{}", root.display());
    println!("老位置：      {}", legacy.display());

    let live = root.join("instances.json");
    let backup = legacy.join("instances.json");

    let read_count = |p: &std::path::Path| -> Option<usize> {
        let t = std::fs::read_to_string(p).ok()?;
        let v: serde_json::Value = serde_json::from_str(&t).ok()?;
        v.get("instances")?.as_array().map(|a| a.len())
    };

    println!("\n修复前：");
    println!(
        "  当前位置 {} 条  {}",
        read_count(&live).unwrap_or(0),
        live.display()
    );
    println!(
        "  老位置   {} 条  {}",
        read_count(&backup).unwrap_or(0),
        backup.display()
    );

    if root == *legacy {
        println!("\n（数据目录就是老位置，不需要迁移 —— 跳过）");
        return;
    }

    // ★ 走**真实**的迁移路径（与启动时同一份实现）
    let copied = platform::migrate_data_root(legacy, &root).expect("迁移失败");
    println!("\n迁移补齐字节数：{copied}");

    let now = read_count(&live).unwrap_or(0);
    println!("\n修复后：");
    println!("  当前位置 {now} 条");

    assert!(
        now > 0,
        "★ 老位置有 {} 条记录，却没有补齐到当前位置 —— \
         被写空的 instances.json 必须能被修回来",
        read_count(&backup).unwrap_or(0)
    );

    // 逐条打印，让人一眼看清恢复了哪些版本
    let text = std::fs::read_to_string(&live).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    println!("\n恢复的版本：");
    for i in v["instances"].as_array().unwrap() {
        let name = i["config"]["name"].as_str().unwrap_or("?");
        let mc = i["mcVersion"].as_str().unwrap_or("?");
        let slug = i["config"]["slug"].as_str().unwrap_or("?");
        let loader = if i["loader"].is_null() {
            "原版".to_string()
        } else {
            format!(
                "{} {}",
                i["loader"]["kind"].as_str().unwrap_or("?"),
                i["loader"]["version"].as_str().unwrap_or("?")
            )
        };
        // 实例目录还在不在？记录恢复了但目录没了的话要能看出来
        let dir_ok = root.join("instances").join(slug).is_dir();
        println!(
            "  · {name}  ({mc} · {loader})  目录{}",
            if dir_ok { "在" } else { "**不在**" }
        );
    }
    println!("\n✓ 实例记录已从老位置补齐");
}
