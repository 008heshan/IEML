//! **真机**验证 CurseForge 集成（默认 `#[ignore]`，要显式 `-- --ignored` 才跑）。
//!
//! ## 为什么非要有这一条
//!
//! CurseForge 的这些东西**只能靠真接口证明**，猜错了也不会报错：
//!   · 每种资源的 `classId`（猜错 → 结果集为空 → 用户以为"没有这个 Mod"）；
//!   · `modLoaderType` 的数字（猜错 → Fabric 的 Mod 搜不出来）；
//!   · 指纹算法（算错 → **所有 Mod 都查不到更新**，而且静默）；
//!   · `downloadUrl` 的主机（API 给的 `edge.forgecdn.net` 在本机时好时坏）。
//!
//! 这一组测试把整条链走一遍：**搜索 → 文件 → 下载 → 指纹反查 → 更新**。
//!
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test live_curseforge -- --ignored --nocapture --test-threads=1
//! ```
//!
//! ★ 需要网络。key 用**内置的那把**（`net::curseforge::api_key()`），
//!   所以不用设环境变量；想用自己的就设 `IEML_CF_API_KEY`。

use ieml_lib::domain::resources::ResourceKind;
use ieml_lib::net::curseforge;

/// 一个真实存在、体积小、长期稳定的项目：Automated Materials Index（1.20.1 / Forge）。
/// （实测：文件 #8600126，2.5 MB —— 它的指纹 3227395021 是被接口自己验证过的那个。）
const KNOWN_MOD_ID: u32 = 1558643;
const KNOWN_FILE_ID: u32 = 8600126;

#[test]
#[ignore = "需要联网：真的打 CurseForge 接口"]
fn search_works_for_all_four_kinds() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let cases = [
        (ResourceKind::Mod, Some("1.20.1"), Some("forge")),
        (ResourceKind::ResourcePack, None, None),
        (ResourceKind::Shader, None, None),
        (ResourceKind::Datapack, None, None),
    ];
    for (kind, mc, loader) in cases {
        let r = rt.block_on(curseforge::search(kind, "", mc, loader, 5, 0));
        match r {
            Ok(resp) => {
                println!(
                    "\n=== {} === 命中 {} 条，取回 {} 条（source={}）",
                    kind.display(),
                    resp.total_hits,
                    resp.hits.len(),
                    resp.source
                );
                for h in resp.hits.iter().take(3) {
                    println!(
                        "   · #{} {}（{}）下载 {} · 允许分发={:?}",
                        h.project_id, h.title, h.slug, h.downloads, h.distribution_allowed
                    );
                }
                assert_eq!(resp.source, "curseforge", "来源必须如实标出来");
                assert!(
                    !resp.hits.is_empty(),
                    "★ {} 一条都没搜到 —— classId 猜错就是这样（静默少一半结果）",
                    kind.display()
                );
            }
            Err(e) => panic!("★ {} 搜索失败：{e}", kind.display()),
        }
    }
}

#[test]
#[ignore = "需要联网：真的打 CurseForge 接口"]
fn files_are_newest_first_and_carry_a_real_url() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let list = rt
        .block_on(curseforge::files(
            &KNOWN_MOD_ID.to_string(),
            ResourceKind::Mod,
            Some("1.20.1"),
            Some("forge"),
            10,
        ))
        .expect("取文件列表失败");
    assert!(!list.is_empty(), "这个项目在 1.20.1 + Forge 上应当有文件");

    // ★ 界面取 [0] 当"最新兼容版"，所以顺序必须是新的在前
    let dates: Vec<&str> = list.iter().map(|v| v.date_published.as_str()).collect();
    let mut sorted = dates.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(dates, sorted, "★ 必须按发布时间倒序：界面取第一个当最新");
    println!("\n最新一个：{}（{}）", list[0].version_number, list[0].id);

    // ★ 文件要带 SHA1（能真的校验），也要带下载地址
    let f = &list[0].files[0];
    assert!(!f.url.is_empty(), "★ 这个文件没有下载地址（作者禁止分发？）");
    assert_eq!(f.hashes.get("sha1").map(|s| s.len()), Some(40), "SHA1 应当是 40 位");
    println!("  下载地址：{}", f.url);
    println!("  SHA1：{}", f.hashes.get("sha1").cloned().unwrap_or_default());
}

#[test]
#[ignore = "需要联网：真的下载一个文件并算指纹"]
fn fingerprint_round_trip_is_accepted_by_the_api() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let dir = std::env::temp_dir().join("ieml-cf-live");
    std::fs::create_dir_all(&dir).unwrap();

    // ① 拿文件信息
    let list = rt
        .block_on(curseforge::files(
            &KNOWN_MOD_ID.to_string(),
            ResourceKind::Mod,
            Some("1.20.1"),
            Some("forge"),
            10,
        ))
        .expect("取文件列表失败");
    let target = list
        .iter()
        .find(|v| v.id == KNOWN_FILE_ID.to_string())
        .unwrap_or(&list[0]);
    let file = &target.files[0];
    println!("\n目标文件：{} → {}", target.id, file.filename);

    // ② 走**我们自己的下载引擎**（多候选、SHA1 校验全在这条路上）
    let path = dir.join(&file.filename);
    let _ = std::fs::remove_file(&path);
    let mut task = ieml_lib::net::download::DownloadTask::new(
        path.clone(),
        file.url.clone(),
        file.hashes.get("sha1").cloned().unwrap_or_default(),
        0,
        file.filename.clone(),
    );
    task.urls = curseforge::candidates_from_url(&file.url);
    println!("候选地址 {} 条：{:?}", task.urls.len(), task.urls);
    let cancel = ieml_lib::net::download::CancelToken::new();
    rt.block_on(ieml_lib::net::download::download_one(
        &task,
        ieml_lib::net::mirror::Source::Bmclapi,
        &cancel,
    ))
    .expect("★ 下载失败 —— 多候选没兜住？");
    let len = std::fs::metadata(&path).unwrap().len();
    println!("已下载 {len} 字节（SHA1 已由引擎校验）");

    // ③ 算指纹，④ 用接口验证（**这是唯一能证明算法对的方式**）
    let fp = curseforge::fingerprint_of_file(&path).expect("算指纹失败");
    println!("自己算的指纹：{fp}");
    let hits = rt
        .block_on(curseforge::match_fingerprints(&[fp]))
        .expect("指纹反查失败");
    let hit = hits.get(&fp).unwrap_or_else(|| {
        panic!("★ 接口没认出我们自己算的指纹（{fp}）—— 算法或端点错了")
    });
    println!("接口认回来了：项目 #{} 文件 #{} {}", hit.mod_id, hit.file_id, hit.file_name);
    assert_eq!(hit.mod_id, KNOWN_MOD_ID, "应当命中同一个项目");
    assert_eq!(hit.file_id, KNOWN_FILE_ID, "应当命中同一个文件");
    // ★ 交叉验证：接口报的 SHA1 与本地一致（配对没错）
    assert_eq!(
        hit.sha1.to_lowercase(),
        file.hashes.get("sha1").cloned().unwrap_or_default().to_lowercase(),
        "接口报的 SHA1 必须与本地一致"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// ★ 批量指纹里**夹着查不到的指纹**时，对应关系不能错位。
///
/// 这条守着"给某个 Mod 装了另一个 Mod 的更新"这种最糟的错法。
#[test]
#[ignore = "需要联网：真的打 CurseForge 接口"]
fn batch_fingerprints_keep_the_position_mapping() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let known = 3227395021u32; // 实测过的那个文件（AMI 1.8.5）
    let known2 = 566564172u32; // 同一个项目的上一版（AMI 1.8.4）
    let bogus = 1234567u32;
    let hits = rt
        .block_on(curseforge::match_fingerprints(&[
            bogus, known, bogus.wrapping_add(1), known2,
        ]))
        .expect("批量指纹反查失败");

    println!("\n批量命中 {} 条：{:?}", hits.len(), hits.keys().collect::<Vec<_>>());
    assert!(hits.contains_key(&known), "★ 夹在中间的真实指纹必须被认出来");
    assert!(!hits.contains_key(&bogus), "查不到的指纹不该出现在结果里");
    if let (Some(a), Some(b)) = (hits.get(&known), hits.get(&known2)) {
        assert_ne!(a.file_id, b.file_id, "★ 两个不同指纹不能被对成同一个文件");
        println!("  {known} → #{}", a.file_id);
        println!("  {known2} → #{}", b.file_id);
    }
}
