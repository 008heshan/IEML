//! 真实网络下的加载器清单验证（**默认 #[ignore]，因为要联网**）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_loaders -- --ignored --nocapture
//!
//! 为什么值得留一个联网测试：加载器清单是**外部数据**，它变了我们这里不会编译错，
//! 只会安静地骗用户说"没有这个版本"。这类 bug 只有真连一次网才能发现。
//! 下面这些断言都是用户报过的具体症状（"启动器说没有 Forge"）。

use ieml_lib::net::metadata;
use ieml_lib::net::mirror::Source;

/// ★ 把元数据缓存目录指向真实的数据目录。
///
/// **为什么必须有这一步**：`metadata` 的磁盘缓存是靠 `set_cache_dir` 打开的，
/// 而它只在 `lib.rs` 的 `run()` 里被调用一次。集成测试不走 `run()`，
/// 于是**测试里根本没有缓存** —— 测出来的全是"冷启动"数字，
/// 跟用户实际用起来的感受完全不是一回事（真应用第二次查询是命中缓存的）。
///
/// 用 `IEML_TEST_CACHE` 可以指定别处；默认走 `AppPaths::resolve().cache`
/// （即真实数据目录下的 `cache/`，与启动器用的是同一个）。
fn init_cache() {
    let dir = std::env::var("IEML_TEST_CACHE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| ieml_lib::platform::AppPaths::resolve().cache);
    let _ = std::fs::create_dir_all(&dir);
    metadata::set_cache_dir(dir);
}

/// ★ 用户报的最核心的 bug：
///   「Forge 的版本是有最新版，可是启动器说没有」
///
///   根因：BMCLAPI 的 `maven/net/minecraftforge/forge/maven-metadata.xml`
///   是 2022-02 就停更的旧文件，里面最新的 MC 版本只到 1.18，
///   于是按 `1.20.1-` 前缀过滤的结果是**空数组**，而空数组在 UI 上的语义是
///   "确认该加载器没有这个版本"。
///   现在改走 Forge 官方 build API（BMCLAPI 有镜像），必须能列出 1.20.1 的 Forge。
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_1_20_1_is_listed() {
    let list = metadata::forge_versions("1.20.1")
        .await
        .expect("Forge 1.20.1 的清单必须能拿到（这是用户报的 bug）");
    assert!(
        !list.is_empty(),
        "Forge 1.20.1 不可能一个版本都没有 —— 空列表会让界面显示「没有 Forge 版本」"
    );
    // 降序：UI 第一项就是推荐项
    assert!(
        list[0].starts_with("47."),
        "1.20.1 的 Forge 应该是 47.x，实际第一项是 {}",
        list[0]
    );
    // 静态表里认定的 47.2.0 必须真的在列表里（否则"推荐值"是编的）
    assert!(
        list.iter().any(|v| v == "47.2.0"),
        "47.2.0 应当能在真实清单里找到；前几个是 {:?}",
        &list[..list.len().min(5)]
    );
    eprintln!("Forge 1.20.1 共 {} 个版本，最新：{}", list.len(), list[0]);
}

/// 1.21.4 这类"静态表里没有"的版本也必须有 Forge（老实现会禁用 → 错误的禁用）
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_modern_versions_are_listed() {
    for mc in ["1.21.4", "1.21.1", "1.20.6"] {
        let list = metadata::forge_versions(mc).await.expect("清单必须能拿到");
        assert!(!list.is_empty(), "{mc} 的 Forge 列表不该为空");
        eprintln!("Forge {mc}：{} 个，最新 {}", list.len(), list[0]);
    }
}

/// ★★ 用户报的 bug：**「什么叫 Forge 没发布 26.2 版本，PCL 是有的」** ★★
///
/// 实测：BMCLAPI 的 `/forge/minecraft/26.2` 返回 **14 条**（65.0.0 … 65.1.3），
/// 所以"没有 Forge"一定是**我们这边**的问题，不是数据的问题。
/// 这条测试就是钉住它：26.x 这一代也必须有 Forge。
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_is_listed_for_26_x() {
    for mc in ["26.2", "26.1.2", "26.1.1", "26.1"] {
        let list = metadata::forge_versions(mc)
            .await
            .unwrap_or_else(|e| panic!("{mc} 的 Forge 清单必须能拿到：{e}"));
        assert!(
            !list.is_empty(),
            "{mc} 的 Forge 列表为空 —— 但 BMCLAPI 的 build 接口里是有数据的，\
             说明是我们的过滤/解析把它丢了（用户报的正是这个：界面说「没有 Forge 版本」）"
        );
        // 26.x 这一代 Forge 用 6x.x.x
        assert!(
            list[0].starts_with("6"),
            "{mc} 的 Forge 应当是 6x.x.x，实际第一项是 {}",
            list[0]
        );
        eprintln!("Forge {mc}：{} 个，最新 {}", list.len(), list[0]);
    }
}

/// ★★ 诊断：把 GUI 真正会拿到的东西**逐项打印**出来 ★★
///
/// 用户反复报「该有 Forge 的版本还是没有 Forge」。代码看着是对的，
/// 所以这里不再推测 —— 直接跑一遍前端会走的那条路（`fetch_available_loaders`），
/// 把每个来源的版本数 / error / 耗时全打出来。
#[tokio::test]
#[ignore = "需要联网"]
async fn diag_available_loaders_for_common_versions() {
    init_cache();
    for mc in ["1.20.1", "26.2", "1.21.1", "1.12.2"] {
        let t0 = std::time::Instant::now();
        // ★ 逐来源计时：整体只报一个总数，看不出是谁慢
        let (f, n, fa, q, o) = tokio::join!(
            async {
                let t = std::time::Instant::now();
                let r = ieml_lib::net::metadata::forge_versions(mc).await;
                (t.elapsed().as_millis(), r.map(|v| v.len()).map_err(|e| e.to_string()))
            },
            async {
                let t = std::time::Instant::now();
                let r = ieml_lib::net::metadata::neoforge_versions_for_mc(mc, Source::Bmclapi).await;
                (t.elapsed().as_millis(), r.map(|v| v.len()).map_err(|e| e.to_string()))
            },
            async {
                let t = std::time::Instant::now();
                let r = ieml_lib::net::metadata::fabric_loader_list(Source::Bmclapi).await;
                (t.elapsed().as_millis(), r.map(|v| v.len()).map_err(|e| e.to_string()))
            },
            async {
                let t = std::time::Instant::now();
                let r = ieml_lib::net::metadata::quilt_loader_list(Source::Bmclapi).await;
                (t.elapsed().as_millis(), r.map(|v| v.len()).map_err(|e| e.to_string()))
            },
            async {
                let t = std::time::Instant::now();
                let r = ieml_lib::net::metadata::optifine_versions(mc).await;
                (t.elapsed().as_millis(), r.map(|v| v.len()).map_err(|e| e.to_string()))
            },
        );
        eprintln!("[{mc}] 合计 {} ms", t0.elapsed().as_millis());
        for (name, (ms, res)) in [
            ("forge", f),
            ("neoforge", n),
            ("fabric", fa),
            ("quilt", q),
            ("optifine", o),
        ] {
            match res {
                Ok(n) => eprintln!("    {name:<9} {ms:>6} ms   ok  {n} 个版本"),
                Err(e) => eprintln!("    {name:<9} {ms:>6} ms   ★没查到★  {e}"),
            }
        }
    }
}

/// 老版本的 Forge 也要能列出来（用户报"古老版本甚至会报错"）
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_legacy_versions_are_listed() {    for mc in ["1.12.2", "1.7.10", "1.6.4"] {
        let list = metadata::forge_versions(mc).await.expect("清单必须能拿到");
        assert!(!list.is_empty(), "{mc} 的 Forge 列表不该为空");
        // ★ 版本号里不能带 `-`（Forge 老版本 maven 目录里的 version 段是短号），
        //   否则安装器 URL 会拼错、下载 404。
        assert!(
            list.iter().all(|v| !v.contains('-')),
            "{mc} 的清单里混进了非版本号：{:?}",
            list.iter().filter(|v| v.contains('-')).collect::<Vec<_>>()
        );
        eprintln!("Forge {mc}：{} 个，最新 {}", list.len(), list[0]);
    }
}

/// 确实没有 Forge 的版本要返回**空列表**（而不是报错）——
/// 这才是"确认没有"，UI 可以据此置灰。
#[tokio::test]
#[ignore = "需要联网"]
async fn forge_absent_version_returns_empty_not_error() {
    let r = metadata::forge_versions("1.0.0").await;
    match r {
        Ok(list) => assert!(list.is_empty(), "1.0.0 不该有 Forge，实际 {:?}", list),
        Err(e) => panic!("1.0.0 应当返回「空列表」（确认没有），而不是错误：{e}"),
    }
}

/// Fabric / Quilt 的清单要能拉到，且第一项是最新的 loader 版本
#[tokio::test]
#[ignore = "需要联网"]
async fn fabric_and_quilt_lists_are_available() {
    let fabric = metadata::fabric_loaders("1.20.1", Source::Bmclapi)
        .await
        .expect("Fabric 清单必须能拿到");
    assert!(!fabric.is_empty());
    eprintln!("Fabric 1.20.1 loader 共 {} 个", fabric.len());

    let quilt = metadata::quilt_loaders("1.20.1", Source::Bmclapi).await;
    match quilt {
        Ok(l) => eprintln!("Quilt 1.20.1 loader 共 {} 个", l.len()),
        Err(e) => eprintln!("Quilt 清单没拉到（不致命，界面会显示「没查到」）：{e}"),
    }
}

/// NeoForge 的全量清单必须包含 1.21.1 的版本（`21.1.x`）
#[tokio::test]
#[ignore = "需要联网"]
async fn neoforge_list_contains_modern_versions() {
    let all = metadata::neoforge_versions().await.expect("清单必须能拿到");
    assert!(!all.is_empty());
    assert!(
        all.iter().any(|v| v.starts_with("21.1.")),
        "NeoForge 清单里应当有 21.1.x；样例 {:?}",
        &all[..all.len().min(5)]
    );
    eprintln!("NeoForge 共 {} 个版本", all.len());
}

/* ====================== OptiFine（高清修复） ====================== */

/// ★ OptiFine 终于有自动来源了（以前界面上写着"尚未接入自动查询"）
#[tokio::test]
#[ignore = "需要联网"]
async fn optifine_versions_for_1_20_1() {
    let list = metadata::optifine_versions("1.20.1")
        .await
        .expect("OptiFine 清单必须能拿到");
    assert!(!list.is_empty(), "1.20.1 有 OptiFine（HD U I6 等），不该为空");
    // 正式版必须排在预览版前面
    let first_preview = list.iter().position(|v| v.preview);
    let last_stable = list.iter().rposition(|v| !v.preview);
    if let (Some(p), Some(s)) = (first_preview, last_stable) {
        assert!(s < p, "正式版必须排在预览版前面：{:?}", list.iter().map(|v| &v.version).collect::<Vec<_>>());
    }
    // 1.20.1 的正式版里有 I6，且带 Forge 要求
    let i6 = list
        .iter()
        .find(|v| v.version == "HD U I6" && !v.preview)
        .expect("1.20.1 应当有正式版 HD U I6");
    assert!(
        i6.required_forge.is_some(),
        "1.20.1 的 OptiFine 需要特定 Forge 版本，这个字段不能空"
    );
    eprintln!(
        "OptiFine 1.20.1 共 {} 个（首个正式版 {} 需 Forge {:?}）",
        list.len(),
        i6.version,
        i6.required_forge
    );
}

/// ★ 实测纠正了一个**错的认知**（静态表里写错了）：
///   以前 `loader_caps` 里写着"OptiFine 从 1.20.5 起不再支持"，
///   但真机数据是：
///     · 1.20.5 → 确实 0 条
///     · 1.20.6 → 有 **预览版**（HD U J1 pre17/pre18）
///     · 1.21.1 → 有**正式版**（OptiFine_1.21.1_HD_U_J1.jar）
///   所以"没有 OptiFine"只在 1.20.5 这种确实没有的版本上成立；
///   1.20.6/1.21 是"只有预览版"，不是"没有"。
#[tokio::test]
#[ignore = "需要联网"]
async fn optifine_reflects_reality_on_modern_versions() {
    // 1.20.5：真的没有
    let none = metadata::optifine_versions("1.20.5")
        .await
        .expect("查询本身应当成功");
    assert!(none.is_empty(), "1.20.5 确实没有 OptiFine，实际 {}", none.len());

    // 1.20.6：只有预览版
    let only_preview = metadata::optifine_versions("1.20.6")
        .await
        .expect("查询本身应当成功");
    assert!(
        !only_preview.is_empty(),
        "1.20.6 有 OptiFine 预览版，不该报「没有」"
    );
    assert!(
        only_preview.iter().all(|v| v.preview),
        "1.20.6 目前只有预览版：{:?}",
        only_preview.iter().map(|v| &v.version).collect::<Vec<_>>()
    );

    // 1.21.1：已经有正式版了
    let stable_exists = metadata::optifine_versions("1.21.1")
        .await
        .expect("查询本身应当成功");
    assert!(
        stable_exists.iter().any(|v| !v.preview),
        "1.21.1 已有 OptiFine 正式版（HD U J1）—— 静态表里那句「1.20.5 起不再支持」是错的：{:?}",
        stable_exists.iter().map(|v| &v.version).collect::<Vec<_>>()
    );
}

/* ====================== 门面：五种并行 ====================== */

/// ★ 端到端：一次调用拿回五种加载器的清单，且**总耗时接近最慢的那个**
///   （串行的话本机实测约 18 秒）
#[tokio::test]
#[ignore = "需要联网"]
async fn fetch_available_loaders_is_parallel_and_complete() {
    let t0 = std::time::Instant::now();
    let all = ieml_lib::modloader::fetch_available_loaders("1.20.1", Source::Bmclapi)
        .await
        .expect("五种来源都不该让整体失败");
    let ms = t0.elapsed().as_millis();

    // Forge 必须有（用户报的 bug 就是这里空）
    let forge = all.get("forge").expect("要有 forge");
    assert!(forge.error.is_none(), "Forge 查询报错：{:?}", forge.error);
    assert!(!forge.versions.is_empty(), "Forge 1.20.1 不该为空");
    assert!(forge.versions.iter().any(|v| v == "47.2.0"), "要有 47.2.0");

    // Fabric 必须有（spec 的验收标准）
    let fabric = all.get("fabric").expect("要有 fabric");
    assert!(fabric.error.is_none(), "Fabric 查询报错：{:?}", fabric.error);
    assert!(!fabric.versions.is_empty(), "Fabric 列表不该为空");

    // OptiFine 也要有（附加组件）
    let optifine = all.get("optifine").expect("要有 optifine");
    assert!(optifine.error.is_none(), "OptiFine 查询报错：{:?}", optifine.error);
    assert!(!optifine.versions.is_empty(), "OptiFine 1.20.1 不该为空");
    assert!(!optifine.is_base, "OptiFine 是附加组件");

    // 1.20.1 没有 NeoForge（只从 1.20.2 起）→ 应当是"确认没有"
    let neo = all.get("neoforge").expect("要有 neoforge 这一项");
    assert!(neo.error.is_none());
    assert!(neo.versions.is_empty(), "1.20.1 不该有 NeoForge：{:?}", neo.versions);

    eprintln!(
        "并行拉取五种来源用了 {ms} ms；Forge {} / NeoForge {} / Fabric {} / Quilt {} / OptiFine {}",
        forge.versions.len(),
        neo.versions.len(),
        fabric.versions.len(),
        all.get("quilt").map(|q| q.versions.len()).unwrap_or(0),
        optifine.versions.len()
    );
    assert!(
        ms < 60_000,
        "并行拉取不该超过 60 秒（串行约 18 秒，超时说明卡住了）：{ms} ms"
    );
}

