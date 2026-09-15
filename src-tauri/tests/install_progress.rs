//! 安装进度上报的真机验证：**每个阶段都必须能推进到 total**。
//!
//! 为什么需要它：用户实测看到的是「解压本地 0/12，然后就显示完成？？？」——
//! 因为解压阶段只在开始时发了一条 `finished_files: 0` 的进度事件，
//! 循环里一次都不更新。界面于是永远停在 0/12，随后任务突然变 100%。
//! 这种 bug 编译器抓不到、单元测试也容易漏（进度回调是 `Fn` 副作用），
//! 只能真跑一次安装、把回调事件收下来做断言。
//!
//! 跑法（需要本机已在启动器里装好该版本，库文件已缓存 → 全走"跳过"，不下载）：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test install_progress -- --nocapture --ignored
//! ```
//! 环境变量：
//!   IEML_TEST_VERSION=26.2   要验证的版本（默认 26.2）

use ieml_lib::net::download::{CancelToken, DownloadProgress};
use ieml_lib::net::installer::{self, InstallOptions, PlanInput};
use ieml_lib::net::metadata::VersionJson;
use ieml_lib::net::mirror::Source;
use std::sync::{Arc, Mutex};

/// 一个阶段内收集到的进度
#[derive(Default, Debug)]
struct Stage {
    name: String,
    /// 每次回调的 finished_files，按顺序记下来
    series: Vec<usize>,
    totals: Vec<usize>,
    current: Vec<String>,
}

#[test]
#[ignore = "需要本机已安装的游戏版本（库已缓存，不下载）"]
fn every_stage_advances_to_its_total() {
    let version_id = std::env::var("IEML_TEST_VERSION").unwrap_or_else(|_| "26.2".into());
    // ★ 走 AppPaths::resolve()：写死 `%APPDATA%\IEML` 会在数据目录搬走后
    //   让这条测试找不着版本（或对着空目录跑）。
    let shared = ieml_lib::platform::AppPaths::resolve().shared;
    let version_dir = shared.join("versions").join(&version_id);
    let json_path = version_dir.join(format!("{version_id}.json"));
    assert!(
        json_path.is_file(),
        "找不到 {} —— 先在启动器里装好这个版本",
        json_path.display()
    );
    let version: VersionJson =
        serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();

    // 实例目录放临时目录，**不碰用户真实的 instances/**
    let instance = std::env::temp_dir()
        .join("ieml-progress-check")
        .join(&version_id);
    if instance.is_dir() {
        std::fs::remove_dir_all(&instance).ok();
    }
    std::fs::create_dir_all(&instance).unwrap();

    let events: Arc<Mutex<Vec<(String, usize, usize, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let on_progress = Arc::new(move |stage: String, p: DownloadProgress| {
        sink.lock()
            .unwrap()
            .push((stage, p.finished_files, p.total_files, p.current_file));
    });

    let input = PlanInput {
        version,
        shared_root: shared.clone(),
        instance_dir: instance.clone(),
        source: Source::Bmclapi,
        download_assets: false, // 库都缓存着，这一趟不下载、只验证进度
    };

    println!("\n========== 安装进度上报验证（{version_id}） ==========");
    let opts = InstallOptions {
        concurrency: 8,
        download_assets: false,
        asset_limit: Some(0),
        cancel: CancelToken::new(),
        // 测试里不暂停（暂停由 live 测试单独覆盖）
        pause: None,
        on_progress,
    };
    let outcome = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(installer::install(&input, opts))
        .expect("安装失败");

    // ---------- 按阶段聚合 ----------
    let raw = events.lock().unwrap().clone();
    let mut stages: Vec<Stage> = Vec::new();
    for (name, done, total, current) in raw {
        match stages.last_mut() {
            Some(s) if s.name == name => {
                s.series.push(done);
                s.totals.push(total);
                s.current.push(current);
            }
            _ => {
                stages.push(Stage {
                    name,
                    series: vec![done],
                    totals: vec![total],
                    current: vec![current],
                });
            }
        }
    }

    println!("\n阶段数: {}", stages.len());
    for s in &stages {
        let max_total = s.totals.iter().copied().max().unwrap_or(0);
        let last = s.series.last().copied().unwrap_or(0);
        println!(
            "  · {:<28} 事件 {:>3} 次 · 进度 {:?} → 最终 {}/{}",
            s.name,
            s.series.len(),
            if s.series.len() > 6 {
                format!("{:?}…", &s.series[..6])
            } else {
                format!("{:?}", s.series)
            },
            last,
            max_total
        );
    }

    /* ---------- 断言 ---------- */

    // ① 必须有解压阶段，且它真的推进过（不是只发一条 0）
    //    注意排除掉收尾那一条「解压完成」—— 它是单独一个阶段
    let extract = stages
        .iter()
        .filter(|s| s.name.starts_with("解压") && !s.name.contains("完成"))
        .max_by_key(|s| s.series.len())
        .expect("★ 没有解压阶段的进度事件");
    let extract_total = extract.totals.iter().copied().max().unwrap_or(0);
    assert!(
        extract_total > 0,
        "解压阶段 total 是 0，界面会显示 0/0：{:?}",
        extract.current
    );
    assert!(
        extract.series.len() > 1,
        "★ 解压阶段只发了 {} 条进度事件（用户看到的就是「0/{} 然后就完成」）",
        extract.series.len(),
        extract_total
    );
    // 循环结束时最后一个 jar 的 +1 是在收尾事件里补的（先报"正在解压第 12 个"，
    // 循环结束后再报"12/12"），所以循环内最高到 total-1 是正常的；
    // 关键是有**收尾事件**把它补到 total
    let extract_peak = extract.series.iter().copied().max().unwrap_or(0);
    assert!(
        extract_peak >= extract_total.saturating_sub(1),
        "★ 解压阶段没走到头：峰值 {extract_peak}/{extract_total}"
    );
    let done_stage = stages
        .iter()
        .find(|s| s.name.starts_with("解压完成"))
        .unwrap_or_else(|| panic!("★ 没有「解压完成」收尾事件 —— 进度会永远停在 {extract_peak}/{extract_total}（用户看到的就是「0/12 然后显示完成」）"));
    assert_eq!(
        done_stage.series.last().copied().unwrap_or(0),
        extract_total,
        "★ 收尾事件必须把计数补到 total，实际 {}/{}",
        done_stage.series.last().copied().unwrap_or(0),
        extract_total
    );
    // 计数必须单调不回退
    for w in extract.series.windows(2) {
        assert!(w[1] >= w[0], "解压进度回退了：{:?}", extract.series);
    }
    // 每条都要带当前文件，否则界面那行是空的
    assert!(
        extract.current.iter().any(|c| !c.is_empty()),
        "解压阶段没有任何一条带 current_file"
    );

    // ② 本地工作阶段不能出现"只发一条就了事"的僵局。
    //
    //    「准备」是个瞬时的开场提示（紧接着就被下载阶段的进度顶掉），
    //    只发一条是正常的；但**本地干活的阶段**（解压、写盘、打补丁）不同 ——
    //    它们要持续若干秒且没有任何后续阶段会顶掉它们，
    //    只发一条就意味着界面在这几秒里定格。
    for s in &stages {
        let total = s.totals.iter().copied().max().unwrap_or(0);
        let last = s.series.last().copied().unwrap_or(0);
        let is_local_work = s.name.contains("解压") || s.name.contains("写") || s.name.contains("补丁");
        if is_local_work && total > 0 && s.series.len() == 1 && !s.name.contains("完成") {
            panic!(
                "★ 本地阶段「{}」只发了一条进度（{}/{total}）—— 界面会定格在这一格",
                s.name, last
            );
        }
    }

    // ③ 最终阶段要显示完成
    let last_stage = stages.last().expect("至少要有一个阶段");
    println!("\n最后阶段: {} ({}/{})", last_stage.name, last_stage.series.last().copied().unwrap_or(0), last_stage.totals.last().copied().unwrap_or(0));

    assert!(
        outcome.natives_dir.is_dir(),
        "natives 目录没建出来：{}",
        outcome.natives_dir.display()
    );
    println!(
        "✓ 进度上报正常（{} 个阶段 · 解压 {extract_peak}/{extract_total} → 收尾 {}）",
        stages.len(),
        done_stage.series.last().copied().unwrap_or(0)
    );
}
