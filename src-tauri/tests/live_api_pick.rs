//! 真机验证：**Fabric API 的默认版本真的挑到"推荐的那一档"**。
//!
//! ## 背景
//!
//! 用户的要求：「Fabric 的 API 也是有版本的，如果玩家不自己选，
//! 那就走默认推荐」。
//!
//! 老代码直接 `versions.first()` —— 拿 Modrinth 返回顺序的第一个。
//! 那个顺序既不是"最新正式版"也不是"最稳的"，而 Fabric API 大量发 beta，
//! 所以玩家很可能被装到一个 beta 上，还很难查为什么。
//!
//! 这条测试打**真实的 Modrinth API**，检查：
//!   ① 挑出来的那一条在这个 MC 版本 + 加载器下确实存在；
//!   ② 如果列表里有 `release`，挑中的**必须**是 `release`；
//!   ③ 挑中的不是列表第一个时，要能说清为什么（打印出来给人看）。
//!
//! 跑法：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test live_api_pick -- --ignored --nocapture
//! ```
//! 默认 `#[ignore]`：要联网打 Modrinth。

use ieml_lib::modrinth;

#[tokio::test]
#[ignore = "真机测试：会请求 api.modrinth.com"]
async fn fabric_api_default_pick_is_a_release_when_one_exists() {
    // 挑几个真实存在的组合（MC 版本 + 加载器）
    let cases: [(&str, &str, &str); 4] = [
        ("fabric-api", "1.20.1", "fabric"),
        ("fabric-api", "1.21.1", "fabric"),
        ("fabric-api", "1.16.5", "fabric"),
        ("qsl", "1.20.1", "quilt"),
    ];

    let mut checked = 0usize;
    for (project, mc, loader) in cases {
        println!("\n=== {project} @ {mc} + {loader} ===");
        let list = match modrinth::project_versions(project, Some(mc), Some(loader)).await {
            Ok(l) => l,
            Err(e) => {
                println!("  （跳过：拉清单失败 {e}）");
                continue;
            }
        };
        if list.is_empty() {
            println!("  （跳过：Modrinth 上没有这个组合）");
            continue;
        }

        // 先看看列表里都有哪些稳定度
        let mut kinds: Vec<&str> = list.iter().map(|v| v.version_type.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        println!(
            "  拉到 {} 条；稳定度有：{}",
            list.len(),
            kinds.join(" / ")
        );
        println!(
            "  列表第一条：{}（{}，{} 次下载）",
            list[0].version_number, list[0].version_type, list[0].downloads
        );

        let picked = modrinth::pick_default_version(&list).expect("非空列表必须挑得出");
        println!(
            "  ★ 挑中的：{}（{}，{} 次下载）",
            picked.version_number, picked.version_type, picked.downloads
        );

        // ② 有 release 就必须挑 release
        let has_release = list.iter().any(|v| v.version_type == "release");
        if has_release {
            assert_eq!(
                picked.version_type, "release",
                "★ {project} @ {mc} 有正式版，却挑到了 {}（{}）",
                picked.version_type, picked.version_number
            );
        } else {
            println!("  （这个组合没有正式版，退到 {} —— 这是设计好的降级）", picked.version_type);
        }

        // ① 挑中的必须真的支持这个 MC 版本 + 加载器
        assert!(
            picked.game_versions.iter().any(|g| g == mc),
            "★ 挑中的 {} 不支持 {mc}：{:?}",
            picked.version_number,
            picked.game_versions
        );
        assert!(
            picked.loaders.iter().any(|l| l == loader),
            "★ 挑中的 {} 不支持 {loader}：{:?}",
            picked.version_number,
            picked.loaders
        );
        assert!(
            !picked.files.is_empty(),
            "★ 挑中的 {} 没有可下载文件",
            picked.version_number
        );

        checked += 1;
    }

    assert!(checked > 0, "一个组合都没验到（网络问题？）");
    println!("\n✓ 验了 {checked} 个组合：默认挑的都是稳的那一档");
}
