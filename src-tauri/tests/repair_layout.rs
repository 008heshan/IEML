//! 规范化迁移的**真数据彩排**：把真实的布局形状复制到一个临时目录，
//! 跑一遍真正的迁移代码，看结果对不对。
//!
//! ## 为什么要有它（而不是只靠单测）
//!
//!   `platform.rs` 里的单测用的是**我自己造的夹具**。本轮已经栽过一次：
//!   夹具造错了形状（目标写成"新布局"），于是"提平"这条判据正确地拒绝了，
//!   而测试却以为提平坏了 —— 白查了很久。
//!
//!   所以再加一层：**照真机的形状**（两步：老 `<root>/instances/<slug>/game/`
//!   与新 `<root>/.minecraft/versions/<名字>/` 各来一份）复制到临时目录，
//!   跑真代码，断言"用户会看到的那些事"。
//!
//! ## 它**不碰**用户的真数据
//!
//!   只读 `D:\IEML` 的形状（存在什么、叫什么），把**空目录骨架**造到临时目录里
//!   （不复制 1.4 GB 的 assets / libraries，只复制版本目录结构 + 几个小文件），
//!   然后在临时目录上跑迁移。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test repair_layout -- --ignored --nocapture
use ieml_lib::platform::{self, AppPaths};
use std::path::{Path, PathBuf};

/// 造一份"真机形状"的副本，返回 `(临时根, 有没有造成功)`。
///
/// 形状照抄本机 `D:\IEML`（2026-09-30）：
///   ```
///   <root>/instances/26.3-fabric-0.19.5/game/mods/fabric-api.jar   ← 空壳那一份
///   <root>/instances/26.3-fabric-0.19.5-2/game/options.txt         ← 真数据那一份
///   <root>/instances/fabric-loader-0.16.10-1.21.1/                 ← 空目录
///   <root>/.minecraft/versions/fabric-loader-0.19.5-26.3/
///            26.3.json + fabric-loader-0.19.5-26.3.json            ← 两份一样的 json
///   <root>/.minecraft/versions/26.3/26.3.jar                       ← 只有 jar、没有 json
///   ```
fn seed_real_shaped_copy(dst: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_dir_all(dst);
    let inst = dst.join("instances");
    let versions = dst.join(".minecraft").join("versions");

    // ① 空壳那一份（真机上只有 1 个 mod）
    let a = inst.join("26.3-fabric-0.19.5");
    std::fs::create_dir_all(a.join("game").join("mods"))?;
    std::fs::write(a.join("game").join("mods").join("fabric-api-0.161.0+26.3.jar"), vec![1u8; 64])?;

    // ② 真数据那一份（options.txt + 一个存档）
    let b = inst.join("26.3-fabric-0.19.5-2");
    std::fs::create_dir_all(b.join("game").join("saves").join("World1"))?;
    std::fs::write(b.join("game").join("options.txt"), b"lang:zh_cn\n")?;
    std::fs::write(
        b.join("game").join("saves").join("World1").join("level.dat"),
        b"LEVEL-DATA",
    )?;
    // natives 是启动器自己的东西 —— 迁移后它该在 `.ieml/` 下
    std::fs::create_dir_all(b.join("natives"))?;
    std::fs::write(b.join("natives").join("lwjgl.dll"), vec![2u8; 32])?;

    // ③ 空目录
    std::fs::create_dir_all(inst.join("fabric-loader-0.16.10-1.21.1"))?;

    // ④ PCL 那种目录名 + 两份内容一样的 json
    let c = versions.join("fabric-loader-0.19.5-26.3");
    std::fs::create_dir_all(&c)?;
    let json = serde_json::json!({
        "id": "fabric-loader-0.19.5-26.3",
        "inheritsFrom": "26.3",
        "type": "release",
        "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
    })
    .to_string();
    std::fs::write(c.join("26.3.json"), &json)?;
    std::fs::write(c.join("fabric-loader-0.19.5-26.3.json"), &json)?;

    // ⑤ 只有 jar、没有 json 的半成品
    let d = versions.join("26.3");
    std::fs::create_dir_all(&d)?;
    std::fs::write(d.join("26.3.jar"), vec![3u8; 128])?;

    /*
     * ⑥ 账本：slug 与磁盘目录名**对不上**（真机现状），外加一条目录根本没了的记录。
     *    这正是"删了的又回来"要吃的那种数据。
     */
    let ledger = serde_json::json!({
        "instances": [
            { "id": "inst-a", "mcVersion": "26.3", "loader": { "kind": "fabric", "version": "0.19.5", "mcVersion": "26.3" },
              "addons": [], "config": { "name": "空壳那份", "slug": "26.3-fabric-0.19.5" } },
            { "id": "inst-b", "mcVersion": "26.3", "loader": { "kind": "fabric", "version": "0.19.5", "mcVersion": "26.3" },
              "addons": [], "config": { "name": "真数据那份", "slug": "26.3-fabric-0.19.5-2" } },
            { "id": "inst-gone", "mcVersion": "1.12.2", "loader": null, "addons": [],
              "config": { "name": "早就删掉的版本", "slug": "vanilla-1122" } }
        ],
        "active_id": "inst-gone"
    });
    let own = dst.join("launcher");
    std::fs::create_dir_all(&own)?;
    std::fs::write(
        own.join("instances.json"),
        serde_json::to_string_pretty(&ledger).unwrap(),
    )?;
    Ok(())
}

fn list_dir(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(p)
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

#[test]
#[ignore = "真数据彩排：在临时目录里照真机形状造一份，跑真迁移代码"]
fn the_real_layout_normalizes_into_one_folder_per_version() {
    let tmp = std::env::temp_dir().join(format!("ieml-repair-layout-{}", std::process::id()));
    seed_real_shaped_copy(&tmp).expect("造副本失败");

    let mut paths = AppPaths::from_root(tmp.clone());
    paths.own_root = tmp.join("launcher");

    println!("\n=== 迁移前 ===");
    println!("instances/          {:?}", list_dir(&paths.legacy_instances_dir()));
    println!(".minecraft/versions {:?}", list_dir(&paths.instances));
    println!("账本 slug           {:?}", ledger_slugs(&paths));

    let report = platform::instance_catalog_repair(&paths);

    println!("\n=== 迁移做了什么 ===");
    println!("{report:#?}");
    println!("\n=== 迁移后 ===");
    println!(".minecraft/versions {:?}", list_dir(&paths.instances));
    println!("账本 slug           {:?}", ledger_slugs(&paths));

    /* ---------- ① 目录名规范化：`fabric-loader-0.19.5-26.3` → `26.3-fabric-*` ---------- */
    assert!(
        !paths.instances.join("fabric-loader-0.19.5-26.3").exists(),
        "PCL 那种目录名不该还在"
    );
    /*
     * ★ 名字可能带去重后缀：盘上本来就有 `26.3-fabric-0.19.5` 与 `-2`
     *   （两个 Fabric 26.3 实例，这是真机现状），所以规范名会落到 `-3`。
     *   **断言不写死后缀**，只认"规范前缀 + 里面有同名版本 JSON"那一份。
     */
    let renamed = list_dir(&paths.instances)
        .into_iter()
        .find(|d| {
            d.starts_with("26.3-fabric-0.19.5")
                && paths.instances.join(d).join(format!("{d}.json")).is_file()
        })
        .expect("应当有一个带同名 JSON 的规范名目录");
    println!("\n规范化后的目录名：{renamed}");

    /* ---------- ①b 每个像样的版本目录都要有同名 JSON ---------- */
    for dir in list_dir(&paths.instances) {
        let root = paths.instances.join(&dir);
        let has_json = root.join(format!("{dir}.json")).is_file();
        let has_game = root.join("saves").is_dir()
            || root.join("mods").is_dir()
            || root.join("options.txt").is_file();
        if has_game {
            assert!(
                has_json,
                "★ {dir} 里有游戏数据却没有同名版本 JSON —— 这个版本启动不了"
            );
        }
    }

    /* ---------- ② 游戏数据在版本目录那一层，不再套 game/ ---------- */

    /*
     * ★ 有两个同规格的目录（`26.3-fabric-0.19.5` 与 `…-2`），真数据在 `-2`
     *   那一份里。**按内容找**，别按名字猜。
     */
    let v = paths.instances.join(&renamed);
    let with_options = list_dir(&paths.instances)
        .into_iter()
        .map(|d| paths.instances.join(d))
        .find(|d| d.join("options.txt").is_file())
        .expect("应当有一个版本目录那一层有 options.txt");
    let mut t = Vec::new();
    walk(&with_options, 0, &mut t);
    println!("\n{} 的树：\n{}", with_options.display(), t.join("\n"));
    assert!(
        with_options.join("options.txt").is_file(),
        "选项文件应当在版本目录那一层"
    );
    assert!(
        !with_options.join("game").join("options.txt").exists(),
        "不该再套一层 game/"
    );
    assert!(
        !with_options.join("game").is_dir(),
        "提平之后不该留下 game/ 那层（{}）",
        with_options.display()
    );
    let _ = &v;

    /* ---------- ③ 存档一个都不能丢 ---------- */
    let saves = find_file(&paths.instances, "level.dat");
    assert!(
        !saves.is_empty(),
        "★ 存档 level.dat 必须还在某个版本目录里 —— 找不到就是丢用户数据"
    );

    /* ---------- ④ 启动器自己的东西进 `.ieml/`，与游戏目录分开 ---------- */
    for dir in list_dir(&paths.instances) {
        let root = paths.instances.join(&dir);
        if !root.join(format!("{dir}.json")).is_file() {
            continue; // 不是能启动的版本
        }
        assert_ne!(
            paths.instance_dir(&dir),
            paths.instance_game_dir(&dir),
            "★ 启动器目录不许与游戏目录重合（{dir}）"
        );
        assert!(
            paths.instance_dir(&dir).starts_with(&root),
            "启动器目录要在版本目录里面（{dir}）"
        );
    }

    /* ---------- ⑤ 账本按磁盘对齐：幽灵记录清掉、slug 改正 ---------- */
    let slugs = ledger_slugs(&paths);
    println!("\n最终账本 slug：{slugs:?}");
    assert!(
        !slugs.iter().any(|s| s == "vanilla-1122"),
        "★ 目录早就不在了的记录必须清掉（'删了的又回来'就是这么来的）"
    );
    assert!(
        slugs.iter().any(|s| s == &renamed),
        "改名之后账本要么跟着改、要么把新目录补进来（实际：{slugs:?}）"
    );

    /* ---------- ⑥ 幂等：再跑一遍什么都不做 ---------- */
    let after_first = list_dir(&paths.instances);
    println!("\n第一遍之后的目录：{after_first:?}");
    /*
     * ★ 空目录**不搬**（`copy_tree_rule` 只在真要写文件时才建目录）：
     *   盘上那个 `fabric-loader-0.16.10-1.21.1` 是个**空壳**（没有版本 JSON、
     *   也没有任何游戏数据），所以它不会出现在版本目录里 —— 这是对的，
     *   少一个"点进去什么都没有"的假版本。
     */
    assert!(
        !after_first.iter().any(|d| d == "fabric-loader-0.16.10-1.21.1"),
        "PCL 那种目录名不该出现在版本目录里（实际：{after_first:?}）"
    );
    let second = platform::instance_catalog_repair(&paths);
    let after_second = list_dir(&paths.instances);
    let legacy_names = list_dir(&paths.legacy_instances_dir());
    let legacy_detail: Vec<String> = legacy_names
        .iter()
        .map(|d| {
            format!(
                "{d} → {:?}",
                list_dir(&paths.legacy_instances_dir().join(d))
            )
        })
        .collect();
    assert!(
        second.is_empty(),
        "第二遍应当无事可做：{second:?}\n第一遍后 versions：{after_first:?}\n第二遍后 versions：{after_second:?}\n老 instances：{legacy_detail:?}",
    );

    /* ---------- ⑦ 老目录**不删**（用户想退回旧版还能用） ---------- */
    assert!(
        paths.legacy_instances_dir().is_dir(),
        "旧的 instances/ 不该被删掉（只复制、绝不删源）"
    );

    println!("\n✓ 真机形状的副本跑通了：目录名规范了、游戏数据一层、存档在、幽灵记录清了、幂等");
    let _ = std::fs::remove_dir_all(&tmp);
}

fn ledger_slugs(paths: &AppPaths) -> Vec<String> {
    paths
        .own_json("instances.json")
        .and_then(|v| {
            v.get("instances")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|i| i.get("config")?.get("slug")?.as_str().map(String::from))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn find_file(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        if e.path().is_dir() {
            out.extend(find_file(&e.path(), name));
        } else if e.file_name().to_string_lossy() == name {
            out.push(e.path());
        }
    }
    out
}

fn walk(p: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(p) else {
        return;
    };
    for e in rd.flatten() {
        out.push(format!(
            "{}{}",
            "  ".repeat(depth),
            e.file_name().to_string_lossy()
        ));
        if e.path().is_dir() && depth < 3 {
            walk(&e.path(), depth + 1, out);
        }
    }
}
