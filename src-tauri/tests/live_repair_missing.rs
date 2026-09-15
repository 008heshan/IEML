//! 真机验证：**启动前的自愈能把"已安装但缺文件"的版本补好**。
//!
//! ## 为什么需要它
//!
//! 实测（本机真实数据，2026-09-14）：`versions/1.20.1/` 里躺着
//! 23 MB 的客户端 jar 与 62 KB 的版本描述，界面上写着"已安装"，
//! 但 **43 个库里有 35 个根本不在盘上**。
//!
//! 点启动 → `scan_classpath` 报"这个版本有 35 个库文件缺失，启动必然失败 /
//! 请回下载页重新安装一次"。
//!
//! 这句话把**我们该干的活推给了用户**：用户凭什么知道"已安装"是假的？
//! 缺什么、从哪来，下载规划完全清楚 —— 那就该自己补。
//!
//! ## 两条测试，各管一半
//!
//!   · `repair_missing_fills_a_deliberately_damaged_copy` —— **确定性**：
//!     把一份真实版本 JSON 复制到临时共享目录，**故意删掉几个库**，
//!     自愈后必须以磁盘为准重扫到 0 缺失。走真网络（要下真文件）。
//!
//!   · `every_real_version_is_launchable` —— 对**用户真实装过的每个版本**
//!     跑一遍 `scan_classpath`：有没有"界面上写着已安装、其实起不来"的。
//!     这条守的是"启动前自愈真的接上了"，也是当初抓到 1.20.1 的那条。
//!
//! 跑法：
//! ```powershell
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test live_repair_missing -- --ignored --nocapture
//! ```
//!
//! 默认 `#[ignore]`：会真的联网下文件。

use ieml_lib::net::download::CancelToken;
use ieml_lib::net::installer::{self, InstallOptions, PlanInput};
use ieml_lib::net::metadata::VersionJson;
use ieml_lib::net::mirror::Source;
use ieml_lib::platform::AppPaths;
use std::path::{Path, PathBuf};

/// 挑一个**盘上有版本 JSON、且库最全**的真实版本 —— 拿它当夹具原料，
/// 这样"缺的那几个"就是真库、真地址，能真的下回来。
fn pick_donor(shared: &Path) -> Option<(String, VersionJson)> {
    let versions = shared.join("versions");
    let rd = std::fs::read_dir(&versions).ok()?;
    let mut best: Option<(String, VersionJson, usize)> = None;
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        let json = e.path().join(format!("{id}.json"));
        let Ok(text) = std::fs::read_to_string(&json) else {
            continue;
        };
        let Ok(version) = serde_json::from_str::<VersionJson>(&text) else {
            continue;
        };
        let n = installer::scan_classpath(&version, shared).classpath.len();
        // 客户端 jar 也要在，否则自愈会去下 20+ MB 的原版 jar
        let has_jar = e.path().join(format!("{id}.jar")).is_file();
        if n > 0 && has_jar && best.as_ref().map(|b| n > b.2).unwrap_or(true) {
            best = Some((id, version, n));
        }
    }
    best.map(|(id, v, _)| (id, v))
}

#[tokio::test]
#[ignore = "真机测试：会联网补文件"]
async fn repair_missing_fills_a_deliberately_damaged_copy() {
    let paths = AppPaths::resolve();
    let real_shared = &paths.shared;

    let Some((id, version)) = pick_donor(real_shared) else {
        println!("（跳过：本机没有装过带 jar 的版本，没有夹具原料）");
        panic!("本机必须至少装过一个版本，否则这条测试无从验证");
    };
    println!("\n夹具原料：{id}（classpath {} 项）", version.libraries.len());

    /*
     * ---------- 搭临时共享目录 ----------
     *
     * ★ 绝对**不删用户真实目录里的库** —— 那是他的游戏。
     *   夹具的库用**硬链接**指回真文件：零拷贝、零流量，
     *   删掉链接不会动到原件（`remove_file` 只摘链接）。
     *   客户端 jar 同理。
     */
    let root = std::env::temp_dir().join(format!("ieml-repair-fixture-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let fixture_shared = root.join("shared");
    let vdir = fixture_shared.join("versions").join(&id);
    std::fs::create_dir_all(&vdir).unwrap();

    let scan_real = installer::scan_classpath(&version, real_shared);
    let mut linked = 0usize;
    for p in &scan_real.classpath {
        let Ok(rel) = p.strip_prefix(real_shared.join("libraries")) else {
            continue;
        };
        let dest = fixture_shared.join("libraries").join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        if std::fs::hard_link(p, &dest).is_ok() {
            linked += 1;
        } else {
            std::fs::copy(p, &dest).unwrap();
            linked += 1;
        }
    }
    // natives jar 也要摆好，否则自愈会去下它们（不大，但没必要）
    for (jar, _) in &scan_real.natives {
        let Ok(rel) = jar.strip_prefix(real_shared.join("libraries")) else {
            continue;
        };
        let dest = fixture_shared.join("libraries").join(rel);
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        let _ = std::fs::hard_link(jar, &dest).or_else(|_| std::fs::copy(jar, &dest).map(|_| ()));
    }
    let real_jar = real_shared.join("versions").join(&id).join(format!("{id}.jar"));
    if real_jar.is_file() {
        let _ = std::fs::hard_link(&real_jar, vdir.join(format!("{id}.jar")))
            .or_else(|_| std::fs::copy(&real_jar, vdir.join(format!("{id}.jar"))).map(|_| ()));
    }

    let input = PlanInput {
        version: version.clone(),
        shared_root: fixture_shared.clone(),
        instance_dir: root.join("inst"),
        source: Source::Bmclapi,
        download_assets: false,
    };

    // 先确认夹具本身是齐的（否则后面"制造缺口"就说不清缺了几个）
    let before = installer::scan_classpath(&version, &fixture_shared);
    println!("夹具就位：硬链接 {linked} 个库 · 缺失 {} 个", before.missing.len());
    assert!(
        before.missing.is_empty(),
        "夹具没搭好，先修夹具再谈自愈：{:?}",
        before.missing
    );
    assert!(
        before.classpath.len() >= 3,
        "夹具 classpath 只有 {} 项，太少，测不出东西",
        before.classpath.len()
    );

    /* ---------- 故意制造缺口：删掉 3 个库 ---------- */
    let victims: Vec<PathBuf> = before.classpath.iter().take(3).cloned().collect();
    for v in &victims {
        std::fs::remove_file(v).expect("删夹具里的库文件失败");
        println!("  已删除：{}", v.file_name().unwrap().to_string_lossy());
    }
    let damaged = installer::scan_classpath(&version, &fixture_shared);
    assert_eq!(
        damaged.missing.len(),
        3,
        "应该正好缺 3 个：{:?}",
        damaged.missing
    );

    /* ---------- 自愈 ---------- */
    let report = installer::repair_missing(&input, InstallOptions::new(16, CancelToken::new()))
        .await
        .expect("自愈过程本身不该失败");
    println!("\n=== 自愈结果 ===\n{}", report.summary);
    for (label, err) in report.failed.iter().take(5) {
        println!("    ✗ {label} → {err}");
    }

    assert!(report.missing > 0, "刚删了 3 个，自愈却说一个都不缺");
    assert!(
        report.failed.is_empty(),
        "自愈失败 {} 个：{:?}",
        report.failed.len(),
        report.failed
    );

    /* ---------- ★ 以磁盘为准重扫 ---------- */
    let after = installer::scan_classpath(&version, &fixture_shared);
    println!(
        "重扫：classpath {} 项 · 缺失 {} 个",
        after.classpath.len(),
        after.missing.len()
    );
    assert!(
        after.missing.is_empty(),
        "★ 自愈完仍然缺 {} 个 —— 这个版本还是起不来：{:?}",
        after.missing.len(),
        after.missing
    );
    // 被删的那 3 个必须真的回来了（而且是真文件，不是 0 字节占位）
    for v in &victims {
        let size = std::fs::metadata(v).map(|m| m.len()).unwrap_or(0);
        assert!(
            size > 1024,
            "{} 补回来了但只有 {size} 字节，明显是错误页面",
            v.display()
        );
    }

    /* ---------- 幂等：再跑一次不该下东西 ---------- */
    let again = installer::repair_missing(&input, InstallOptions::new(16, CancelToken::new()))
        .await
        .expect("第二次自愈不该失败");
    println!("第二次自愈：{}", again.summary);
    assert_eq!(again.missing, 0, "文件已经齐了，不该再报缺口");
    assert_eq!(again.repaired, 0, "文件已经齐了，不该再下东西");

    let _ = std::fs::remove_dir_all(&root);
    println!("\n✓ 自愈有效且幂等");
}

/// 对**用户真实装过的每个版本**检查：有没有"界面上写着已安装、其实起不来"的。
///
/// ★ 这条测试是当初抓到 `1.20.1` 缺 35 个库的那条。
///   它以前写死 `%APPDATA%\IEML\shared`（旧数据目录），数据目录搬走之后
///   就变成"每次都跳过"——**假绿**，比红更危险。路径修正后它立刻变红。
#[test]
#[ignore = "真机测试：读用户真实数据目录"]
fn every_real_version_is_launchable() {
    let shared = AppPaths::resolve().shared;
    let versions = shared.join("versions");
    let Ok(rd) = std::fs::read_dir(&versions) else {
        println!("（跳过：没装过任何版本）");
        return;
    };

    let mut broken: Vec<(String, usize, Vec<String>)> = Vec::new();
    let mut generated: Vec<(String, Vec<String>)> = Vec::new();
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        let json = e.path().join(format!("{id}.json"));
        let Ok(text) = std::fs::read_to_string(&json) else {
            continue; // 没有版本 JSON 的目录（半成品下载）跳过
        };
        let Ok(version) = serde_json::from_str::<VersionJson>(&text) else {
            continue;
        };
        let scan = installer::scan_classpath(&version, &shared);
        println!(
            "{id}: classpath {} 项 · natives {} 个 · 缺失 {} 个 {:?}{}",
            scan.classpath.len(),
            scan.natives.len(),
            scan.missing.len(),
            scan.missing.iter().take(3).collect::<Vec<_>>(),
            if scan.missing_generated.is_empty() {
                String::new()
            } else {
                format!(" · 本地生成缺失 {:?}", scan.missing_generated)
            }
        );
        /*
         * ★ 两类缺口分开查，因为**修法完全不同**：
         *   · `missing`            → 下载能补（启动前自愈就是干这个的）
         *   · `missing_generated`  → 下载补不了（远程没这个文件），
         *                            只能重装加载器让 processor 再跑一遍
         *   混在一起报"请重新下载"会把用户引到一条修不好的路上。
         */
        if !scan.missing.is_empty() {
            broken.push((
                id.clone(),
                scan.missing.len(),
                scan.missing.iter().take(5).cloned().collect(),
            ));
        }
        if !scan.missing_generated.is_empty() {
            generated.push((id, scan.missing_generated.clone()));
        }
    }
    assert!(
        broken.is_empty(),
        "★ 这些真实版本起不来（界面上却写着已安装）—— \
         它们必须能被启动前的自愈补好：{broken:#?}"
    );
    assert!(
        generated.is_empty(),
        "★ 这些版本的加载器本地产物缺失（processor 没跑成），\
         必须重装加载器才能修：{generated:#?}"
    );
}
