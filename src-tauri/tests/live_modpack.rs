//! 整合包安装链路的**真实联网**验证（默认 `#[ignore]`）。
//!
//! ## 为什么值得单独跑一次真的
//!
//! 用户报「整合包无法安装」，而这条链路的每一段都在**不同层**：
//!
//!   ① Modrinth 搜索 / 取版本        —— 网络 + API 参数
//!   ② 下载 .mrpack                  —— 镜像候选 + 断点
//!   ③ `parse_mrpack_bytes`          —— zip 结构 + JSON 形状
//!   ④ `mrpack_download_tasks`       —— 清单语义（哪些文件属于客户端）
//!   ⑤ 按清单下载                    —— 又是网络
//!   ⑥ `extract_overrides`           —— 解压 + 路径安全闸门
//!
//! 单测能盖住 ③④⑥ 的**纯逻辑**，但盖不住"真实清单长什么样" ——
//! 而这一步恰恰最容易出问题：写错一个字段名（`downloads` / `fileSize` /
//! `client` 的大小写），单测照样全绿，联网一跑就是空列表。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_modpack -- --ignored --nocapture
use ieml_lib::modrinth;
use ieml_lib::net::download::{download_batch, download_one, BatchOptions, CancelToken, DownloadTask};
use ieml_lib::net::mirror::Source;

/// Fabulously Optimized：体积小（0.16 MB）、下载量大、结构标准，适合当探针
const PROBE_PROJECT: &str = "1KVo5zza";

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ieml-modpack-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    dir
}

/// ★ 核心断言：从**真实** Modrinth 拿到一个 .mrpack，完整走完 ②③④ 三步。
///
/// 这一段就是「整合包无法安装」最可能的断面 —— 它一旦失败，
/// 界面上看到的就是"点了确认没反应 / 报一句看不懂的错"。
#[tokio::test]
#[ignore = "需要联网"]
async fn real_mrpack_parses_and_yields_download_tasks() {
    let dir = temp_dir("parse");

    // ---------- ① 取版本 ----------
    let versions = modrinth::project_versions(PROBE_PROJECT, None, None)
        .await
        .expect("取版本列表不该报错");
    assert!(!versions.is_empty(), "版本列表不该为空");
    println!("  版本数：{}", versions.len());

    let first = &versions[0];
    println!(
        "  最新版本：{}  loaders={:?}  game={:?}",
        first.version_number, first.loaders, first.game_versions
    );

    // 界面上就是这么挑文件的：优先 primary，没有才退回第一个
    let file = first
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| first.files.first())
        .expect("必须有一个可下载的文件");
    println!("  选中文件：{}（{} 字节）", file.filename, file.size);

    // ---------- ② 下载 .mrpack ----------
    let mrpack_path = dir.join("probe.mrpack");
    let task = DownloadTask::new(
        mrpack_path.clone(),
        file.url.clone(),
        String::new(),
        file.size,
        "探测整合包".to_string(),
    );
    download_one(&task, Source::Bmclapi, &CancelToken::new())
        .await
        .expect("下载 .mrpack 不该失败");

    let bytes = std::fs::read(&mrpack_path).expect("读回落盘的 .mrpack");
    println!("  落盘 {} 字节", bytes.len());
    assert_eq!(bytes[0], 0x50, "前两个字节应是 PK（zip）");
    assert_eq!(bytes[1], 0x4b, "前两个字节应是 PK（zip）");

    // ---------- ③ 解析清单 ----------
    let idx = modrinth::parse_mrpack_bytes(&bytes).expect("必须能解析 modrinth.index.json");
    let mc = idx.mc_version().expect("真实整合包一定写了 minecraft 依赖");
    println!("  清单：MC {mc}  loader={:?}", idx.loader());
    println!("  清单声明文件数：{}", idx.files.len());
    assert!(
        !idx.files.is_empty(),
        "真实整合包的 files 不该为空 —— 为空说明字段名对不上（serde 静默忽略）"
    );

    // ---------- ④ 生成下载任务 ----------
    let game_dir = dir.join("game");
    std::fs::create_dir_all(&game_dir).unwrap();
    let (tasks, skipped) = modrinth::mrpack_download_tasks(&idx, &game_dir);
    println!("  生成任务 {} 个，跳过 {} 个", tasks.len(), skipped.len());

    /*
     * ★ 这条断言是本次排查的重点。
     *
     *   `files` 非空但 `tasks` 为空 = 清单解析到了、却一个都不认 ——
     *   只可能是 `is_client_relevant`（`env.client` 判定）把整包都筛掉了。
     *   那种情况下界面会说"装完了"，而 mods 目录里一个文件都没有。
     */
    assert!(
        !tasks.is_empty(),
        "清单有 {} 个文件，却生成了 0 个下载任务 —— 判定逻辑把整包筛掉了。\
         跳过样例：{:?}",
        idx.files.len(),
        skipped.iter().take(5).collect::<Vec<_>>()
    );

    // 任务路径必须在游戏目录内（安全闸门真的生效了）
    for t in &tasks {
        assert!(
            t.path.starts_with(&game_dir),
            "任务路径逃出了游戏目录：{:?}",
            t.path
        );
    }
}

/// ★ 真下几个文件：验证"清单里的 URL 真的能下"。
///
/// 只取前几个 —— 整包的 Mod 有上百个，全下会把测试跑成一次完整安装。
/// 这里要回答的是"能不能下"，不是"下得完"。
#[tokio::test]
#[ignore = "需要联网"]
async fn real_mrpack_files_actually_download() {
    let dir = temp_dir("dl");

    let versions = modrinth::project_versions(PROBE_PROJECT, None, None)
        .await
        .expect("取版本列表");
    let file = versions[0]
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| versions[0].files.first())
        .expect("有可下载文件");

    let mrpack_path = dir.join("probe.mrpack");
    let task = DownloadTask::new(
        mrpack_path.clone(),
        file.url.clone(),
        String::new(),
        file.size,
        "探测整合包".to_string(),
    );
    download_one(&task, Source::Bmclapi, &CancelToken::new())
        .await
        .expect("下载 .mrpack");
    let bytes = std::fs::read(&mrpack_path).unwrap();
    let idx = modrinth::parse_mrpack_bytes(&bytes).expect("解析清单");

    let game_dir = dir.join("game");
    std::fs::create_dir_all(&game_dir).unwrap();
    let (mut tasks, _) = modrinth::mrpack_download_tasks(&idx, &game_dir);
    tasks.truncate(5);
    println!("  只下前 {} 个文件", tasks.len());

    let outcome = download_batch(
        tasks,
        BatchOptions::new(8, Source::Bmclapi, CancelToken::new()),
    )
    .await
    .expect("批量下载本身不该报错");

    println!(
        "  成功 {}，失败 {}，重试 {} 轮",
        outcome.finished_files,
        outcome.failed.len(),
        outcome.retry_rounds
    );
    for (name, why) in outcome.failed.iter().take(5) {
        println!("    ✗ {name}：{why}");
    }
    assert!(
        outcome.failed.is_empty(),
        "清单里的下载地址必须真的能下 —— 失败 {} 个。\
         这正是界面报「整合包有 N 个文件下载失败」的来源。",
        outcome.failed.len()
    );
}

/// ★ 解压 overrides：验证清单里那个 `overrides/` 真的落在游戏目录里。
#[tokio::test]
#[ignore = "需要联网"]
async fn real_mrpack_overrides_extract() {
    let dir = temp_dir("ov");

    let versions = modrinth::project_versions(PROBE_PROJECT, None, None)
        .await
        .expect("取版本列表");
    let file = versions[0]
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| versions[0].files.first())
        .expect("有可下载文件");

    let mrpack_path = dir.join("probe.mrpack");
    let task = DownloadTask::new(
        mrpack_path.clone(),
        file.url.clone(),
        String::new(),
        file.size,
        "探测整合包".to_string(),
    );
    download_one(&task, Source::Bmclapi, &CancelToken::new())
        .await
        .expect("下载 .mrpack");
    let bytes = std::fs::read(&mrpack_path).unwrap();

    let game_dir = dir.join("game");
    std::fs::create_dir_all(&game_dir).unwrap();
    let n = modrinth::extract_overrides(&bytes, &game_dir).expect("解压 overrides");
    println!("  解压出 {n} 个文件");

    // 这个包有 overrides（作者的配置），解不出东西说明前缀判定写错了
    assert!(
        n > 0,
        "Fabulously Optimized 带 overrides/，解压出 0 个文件说明前缀匹配有问题"
    );

    // 落盘的东西必须真的在游戏目录里
    let mut found = Vec::new();
    fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    walk(&game_dir, &mut found);
    println!("  实际落盘 {} 个文件，例如：", found.len());
    for p in found.iter().take(5) {
        println!("    {}", p.strip_prefix(&game_dir).unwrap_or(p).display());
    }
    assert_eq!(found.len(), n, "报告的数量与实际落盘数量必须一致");
}
