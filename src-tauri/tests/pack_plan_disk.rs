//! 集成验证：**整合包"缺了哪几个文件"真的被记在盘上**（2026-10-16 事故修复）。
//!
//! ## 为什么需要它（这一条是那次真机事故的直接对策）
//!
//! 用户报：整合包 `Better MC [FABRIC] - BMC2` 装完之后进游戏，包**自带的**
//! 「Missing Mods」窗口弹出，点名 `Balm` / `FallingTree` / `FTB Teams` /
//! `Fabrication` / `Paintings ++` —— 而启动器这边报「安装完成」。
//!
//! 盘上查证：`mods/` 里 333 个 jar，这 5 个确实不在；实例目录 `.ieml/` 里
//! **只有 `natives/` 与 `instance.json`** —— 连"这个包本来该装什么"都查不出来，
//! 所以事后既没法复查、也没法只重下缺的那几个。
//!
//! 根因不在下载器（它有重试、有失败清单），而在**解析地址**那一段：
//! CurseForge 的每个文件要先问一次接口换下载地址，查不到的条目从计划里彻底消失。
//!
//! ## 这条测试钉住的三件事
//!
//!   ① 清单里"没弄到手"的条目**真的写进了** `<实例>/.ieml/pack-files.json`
//!      （含路径、CF 的 project_id / file_id，以及失败原因）；
//!   ② 安装记录（`pack-record.json`）里也留下这份缺失清单；
//!   ③ 于是 `verify()` **不再说"文件都在"** —— 这正是"我们说的和游戏说的一样"。
//!
//! 跑法（临时数据根）：
//! ```powershell
//! $env:IEML_DATA_DIR = "$env:TEMP\ieml-packplan-probe"
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test pack_plan_disk -- --ignored --nocapture
//! ```
//! 不设 `IEML_DATA_DIR` 时它**只写临时目录**，绝不碰用户真实数据目录。

use ieml_lib::commands_real::{read_pack_plan_manifest, write_pack_plan_manifest};
use ieml_lib::domain::pack_plan::{build_manifest, PackPlanFile};
use ieml_lib::domain::pack_record::{PackRecord, VerifyReport};
use ieml_lib::platform::AppPaths;
use std::path::PathBuf;

/// 一次真机事故的形状：清单 338 项，其中 5 个的下载地址没解析出来。
///
/// ★ 名字照抄用户截图里包自带弹窗点的那几个 mod（**包自己显示的名字**）。
fn bmc2_missing() -> Vec<PackPlanFile> {
    [
        ("mods/balm-fabric-7.2.1.jar", 531761u32, 4741360u32),
        ("mods/FallingTree-1.20.1-4.3.4.jar", 349559, 4665132),
        ("mods/ftb-teams-fabric-1.20.1-11.1.6.jar", 404468, 4711037),
        ("mods/fabrication-3.1.4+1.20.jar", 391596, 4605118),
        ("mods/ftb-library-fabric-2001.2.4.jar", 404465, 4741595),
    ]
    .into_iter()
    .map(|(path, project_id, file_id)| PackPlanFile {
        path: path.to_string(),
        // 空地址 = "该装、但地址没解析出来"（事故里就是这一种）
        url: String::new(),
        sha1: String::new(),
        size: 0,
        project_id,
        file_id,
        reason: "文件的信息查不到：连接超时（已试 3 次）".to_string(),
    })
    .collect()
}

#[test]
#[ignore = "真机/临时目录验证：会写盘"]
fn missing_entries_are_recorded_on_disk_and_verify_notices() {
    /*
     * ---------- 临时数据根（**绝不碰用户真实目录**）----------
     *
     * 用 `IEML_DATA_DIR` 加"进程 id + 时刻"做隔离：同一台机器上并行跑两次
     * 也不会互相踩（这个仓库有大量 `ieml-*-own` 的临时根用法，同一思路）。
     */
    let root: PathBuf = std::env::temp_dir().join(format!(
        "ieml-packplan-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::env::set_var("IEML_DATA_DIR", &root);
    let _ = std::fs::remove_dir_all(&root);
    let paths = AppPaths::resolve();
    println!("临时数据根：{}", paths.root.display());
    assert!(
        paths.root.starts_with(&root) || paths.root == root,
        "★ 数据根必须落在临时目录里，绝不能是用户的真实目录：{}",
        paths.root.display()
    );

    let slug = "pack-probe";
    // 游戏目录（隔离实例就是版本目录本身）—— 建出来，好让"文件都在盘上"是真的
    let game = paths.game_dir_of(slug);
    std::fs::create_dir_all(game.join("mods")).unwrap();
    // 造 333 个"下好了的" jar：这样 `verify` 的"缺 N 个"只能是那 5 个没解析出来的
    for i in 0..333 {
        std::fs::write(game.join("mods").join(format!("ok-{i}.jar")), b"x").unwrap();
    }

    /*
     * ---------- ① 组装"这一次的完整清单"并落盘 ----------
     *
     * 清单 = 333 条下好的（有地址）+ 5 条没解析出来的（空地址）。
     * 这一步在真实流程里发生在**下载之前**（见 `install_pack_plan` 的 ③′）。
     */
    let mut files: Vec<PackPlanFile> = (0..333)
        .map(|i| {
            let mut f = PackPlanFile::new(
                format!("mods/ok-{i}.jar"),
                format!("https://example.invalid/ok-{i}.jar"),
            );
            f.size = 1;
            f
        })
        .collect();
    files.extend(bmc2_missing());
    let manifest = build_manifest("Better MC [FABRIC] - BMC2", "1.20.1", "curseforge", files, 1);

    assert_eq!(manifest.total, 338, "清单里一共 338 项");
    assert_eq!(manifest.missing.len(), 5, "其中 5 项没解析出地址");
    assert_eq!(
        manifest
            .missing
            .iter()
            .filter(|m| m.retryable)
            .count(),
        5,
        "有 CF 身份 ⇒ 这 5 个以后能重新要地址"
    );

    write_pack_plan_manifest(&paths, slug, &manifest).expect("清单必须写得下");

    // ★ 落盘位置：**实例目录**下的 `.ieml/pack-files.json`（启动器自己的东西）
    let plan_path = PackRecord::manifest_path_for(&paths.instance_dir(slug));
    println!("清单落盘：{}", plan_path.display());
    assert!(
        plan_path.is_file(),
        "★ 清单没落盘 —— 这正是事故里「事后什么都查不到」的根因：{}",
        plan_path.display()
    );
    let raw = std::fs::read_to_string(&plan_path).unwrap();
    for name in ["balm", "FallingTree", "ftb-teams", "fabrication", "ftb-library"] {
        assert!(
            raw.contains(name),
            "★ 缺的那个 mod 必须写在清单里（{name}）—— 否则用户无从查起"
        );
    }
    assert!(
        raw.contains("4741360"),
        "★ CF 的 file_id 也要留下：以后「只重下缺的那几个」全靠它"
    );

    // 读回来必须一致（"补齐"要靠它）
    let back = read_pack_plan_manifest(&paths, slug).expect("清单必须读得回来");
    assert_eq!(back.total, 338);
    assert_eq!(back.missing.len(), 5);

    /*
     * ---------- ② 安装记录里也留一份 ----------
     *
     * 真实流程里这一步由 `build_pack_record(... , record_missing)` 做；
     * 这里直接拼一份同形状的记录，验的是**判定**（那 5 条会让 complete 变 false）。
     */
    let mut record = PackRecord {
        schema: 1,
        name: "Better MC [FABRIC] - BMC2".into(),
        version: "1.20.1".into(),
        source: "curseforge".into(),
        mc_version: "1.20.1".into(),
        loader_kind: Some("fabric".into()),
        loader_version: Some("0.19.3".into()),
        installed_at: 1,
        skipped: vec![],
        project_id: Some("12345".into()),
        version_id: Some("999".into()),
        missing: back
            .missing
            .iter()
            .map(|m| ieml_lib::domain::pack_record::MissingEntry {
                path: m.path.clone(),
                name: m.name.clone(),
                reason: m.reason.clone(),
                attempts: 3,
                retryable: m.retryable,
            })
            .collect(),
        files: back
            .files
            .iter()
            .filter(|f| f.has_url())
            .map(|f| ieml_lib::domain::pack_record::PackFile {
                path: f.path.clone(),
                url: f.url.clone(),
                sha1: f.sha1.clone(),
                size: f.size,
            })
            .collect(),
    };

    /*
     * ---------- ③ 校验：**不许再说"文件都在"** ----------
     *
     * 这是整条链最要紧的一句：事故里 333 个文件都在盘上、校验说 complete
     * ⇒ 界面报"安装完成"，而游戏里弹「Missing Mods」。
     */
    let report: VerifyReport = record.verify(&game, false);
    println!("装完校验：{}", report.summary);
    assert!(
        333 == report.present,
        "盘上 333 个文件应当都在：{} 个",
        report.present
    );
    assert!(
        report.missing.is_empty(),
        "磁盘对账没有缺口（缺的是「从来没下过的那些」）：{:?}",
        report.missing
    );
    assert!(
        !report.complete,
        "★★ 有 5 条没解析出来却说「装全了」 —— 这正是那次事故的形状"
    );
    assert_eq!(report.missing_at_install.len(), 5);
    assert!(
        report.summary.contains("5 个当时没解析出下载地址"),
        "总结要说清这一类：{}",
        report.summary
    );

    /*
     * ---------- ④ 幂等 + 数据形态 ----------
     *
     * 再写一次不该坏（补装/升级都会再写一遍），而且**缺失的条目仍在**。
     */
    write_pack_plan_manifest(&paths, slug, &manifest).expect("再写一次也要成功");
    let again = read_pack_plan_manifest(&paths, slug).expect("仍然读得回来");
    assert_eq!(again.missing.len(), 5, "再写一次不许把缺失清单写没");

    // 补上那 5 个（模拟"重新下载缺失的"成功）⇒ 校验必须转绿
    for m in &again.missing {
        let p = game.join(m.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"repaired").unwrap();
    }
    record.missing.clear();
    for f in &again.files {
        if f.has_url() {
            continue;
        }
        record.files.push(ieml_lib::domain::pack_record::PackFile {
            path: f.path.clone(),
            url: "https://example.invalid/fixed.jar".into(),
            sha1: String::new(),
            size: 0,
        });
    }
    let fixed = record.verify(&game, false);
    println!("补齐之后：{}", fixed.summary);
    assert!(fixed.complete, "5 个都补上了还说没装全：{}", fixed.summary);

    let _ = std::fs::remove_dir_all(&root);
    println!("\n✓ 缺失清单真的落盘、校验真的会报");
}
