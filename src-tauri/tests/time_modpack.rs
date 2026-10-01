//! ★★★★ 整合包下载端到端计时（2026-10-01，用户：「整合包，你试试这个，这个比较小」）。
//!
//! 用的是用户指定的 **Fabulously Optimized**（Modrinth，MC 26.3 / Fabric）。
//! 它小得刚好：包体约 7 MB、清单里 **22 个文件**（都是有头有尾的中小文件）。
//!
//! ## 为什么要写这个（以及它和之前那次测速的区别）
//!
//!   之前我用 `curl.exe` **一个文件一个进程**量，得到"每个文件约 2 秒"——
//!   那是**进程启动 + TLS 握手**，不是下载。后来又用 `reqwest` 单客户端量，
//!   87 KB 只要 457 ms。两次结论差了 5 倍，说明**测法本身**在决定答案。
//!
//!   所以这一次：**走 `download_batch`**（生产那条路），
//!   量三件事，每一件都对应界面上一段用户能看见的等待：
//!
//!     ① 包体：0 → 第一个字节、以及整包多久   （界面："读取整合包清单"）
//!     ② 清单里的 22 个文件：并发/串行各多久   （界面："下载整合包文件 N/22"）
//!     ③ 官方 vs 镜像各跑一遍同一批文件        （决定候选表该怎么排）
//!
//!   用法：
//!     powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!       test --manifest-path src-tauri/Cargo.toml --test time_modpack -- --ignored --nocapture

use std::time::Instant;

/// 用户给的那个包（Modrinth / Fabulously Optimized）
const PACK_URL: &str =
    "https://cdn.modrinth.com/data/1KVo5zza/versions/gbioSm0H/Fabulously.Optimized-v15.0.0-alpha.1.mrpack";

/// 清单里的文件（从包内 `modrinth.index.json` 抄下来 —— **每个都要有自己的 URL**）。
///
/// ★ 第一版这里偷懒让 6 个任务下**同一个 URL**，结果它们互相抢同一个上游连接：
///   耗时 80~91 秒且与并发无关，还稳定失败 1 个。那不是"引擎不并发"，
///   是**我的测法错了**。这一版用真清单，逐条 URL 各不相同。
const FILES: &[(&str, &str)] = &[
    (
        "BetterGrassify-1.8.7+fabric.26.2.jar",
        "https://cdn.modrinth.com/data/m5T5xmUy/versions/r4yqxYQl/BetterGrassify-1.8.7%2Bfabric.26.2.jar",
    ),
    (
        "ConfigManager-fabric-26.1_26.2-1.1.3.jar",
        "https://cdn.modrinth.com/data/jlNms3Jp/versions/W4C08wBC/ConfigManager-fabric-26.1_26.2-1.1.3.jar",
    ),
    (
        "CrashAssistant-fabric-26.2-1.11.10.jar",
        "https://cdn.modrinth.com/data/ix1qq8Ux/versions/ty1I3NCt/CrashAssistant-fabric-26.2-1.11.10.jar",
    ),
    (
        "ForgeConfigAPIPort-v26.2.0-mc26.2.x-Fabric.jar",
        "https://cdn.modrinth.com/data/ohNO6lps/versions/86ROVP2H/ForgeConfigAPIPort-v26.2.0-mc26.2.x-Fabric.jar",
    ),
    (
        "Ixeris-4.5.0+26.2-fabric.jar",
        "https://cdn.modrinth.com/data/p8RJPJIC/versions/hb4Jejhw/Ixeris-4.5.0%2B26.2-fabric.jar",
    ),
    (
        "bbe-fabric-1.3.6+mc26.2.jar",
        "https://cdn.modrinth.com/data/ONZm0H7Y/versions/27YINEUL/bbe-fabric-1.3.6%2Bmc26.2.jar",
    ),
    (
        "cloth-config-26.1.154.jar",
        "https://cdn.modrinth.com/data/9s6osm5g/versions/GFM8zh9J/cloth-config-26.1.154.jar",
    ),
    (
        "continuity-3.0.1+26.2.jar",
        "https://cdn.modrinth.com/data/1IjD5062/versions/mgUN5Xz2/continuity-3.0.1%2B26.2.jar",
    ),
    (
        "dynamic-fps-3.11.9+minecraft-26.2.0-fabric.jar",
        "https://cdn.modrinth.com/data/LQ3K71Q1/versions/pC2JjFw1/dynamic-fps-3.11.9%2Bminecraft-26.2.0-fabric.jar",
    ),
    (
        "fabric-api-0.152.1+26.2.jar",
        "https://cdn.modrinth.com/data/P7dR8mSH/versions/3kB7XVBv/fabric-api-0.152.1%2B26.2.jar",
    ),
    (
        "fabric-language-kotlin-1.13.12+kotlin.2.4.0.jar",
        "https://cdn.modrinth.com/data/Ha28R6CL/versions/Pd0xrHCw/fabric-language-kotlin-1.13.12%2Bkotlin.2.4.0.jar",
    ),
    (
        "iris-fabric-1.11.1+mc26.2.jar",
        "https://cdn.modrinth.com/data/YL57xq9U/versions/3uIIps8q/iris-fabric-1.11.1%2Bmc26.2.jar",
    ),
    (
        "isxander-main-menu-credits-1.3.0.jar",
        "https://cdn.modrinth.com/data/qJDfP7WN/versions/YlrQhKgF/isxander-main-menu-credits-1.3.0.jar",
    ),
    (
        "lithium-fabric-0.25.0+mc26.2.jar",
        "https://cdn.modrinth.com/data/gvQqBUqZ/versions/x1OEDMlF/lithium-fabric-0.25.0%2Bmc26.2.jar",
    ),
    (
        "morechathistory-2.0.0.jar",
        "https://cdn.modrinth.com/data/8qkXwOnk/versions/qpDhYv1Y/morechathistory-2.0.0.jar",
    ),
    (
        "reeses-sodium-options-fabric-2.0.5+mc26.2.jar",
        "https://cdn.modrinth.com/data/Bh37bMuy/versions/iB6Zl5QS/reeses-sodium-options-fabric-2.0.5%2Bmc26.2.jar",
    ),
    (
        "skyboxify-3.0+26.2-fabric.jar",
        "https://cdn.modrinth.com/data/DWuwk8aA/versions/dpMMsXD7/skyboxify-3.0%2B26.2-fabric.jar",
    ),
    (
        "sodium-fabric-0.9.0+mc26.2.jar",
        "https://cdn.modrinth.com/data/AANobbMI/versions/3QgJXuSK/sodium-fabric-0.9.0%2Bmc26.2.jar",
    ),
    (
        "sodium-shadowy-path-blocks-fabric-7.0.0.jar",
        "https://cdn.modrinth.com/data/EIa1eiMm/versions/ygm51jhU/sodium-shadowy-path-blocks-fabric-7.0.0.jar",
    ),
    (
        "yet_another_config_lib_v3-3.9.4+26.2-fabric.jar",
        "https://cdn.modrinth.com/data/1eAoo2KR/versions/Sq2GH95j/yet_another_config_lib_v3-3.9.4%2B26.2-fabric.jar",
    ),
    (
        "Chat Reporting Helper.zip",
        "https://cdn.modrinth.com/data/tN4E9NfV/versions/tL0Uk6bl/Chat%20Reporting%20Helper.zip",
    ),
    (
        "SodiumTranslations.zip",
        "https://cdn.modrinth.com/data/yfDziwn1/versions/krBxUB2j/SodiumTranslations.zip",
    ),

];

#[tokio::test]
#[ignore = "真机：需要网络，会往系统临时目录写几十 MB"]
async fn 用户给的那个整合包到底慢在哪一步() {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};
    use ieml_lib::net::mirror::Source;

    let dir = std::env::temp_dir().join(format!("ieml-pack-time-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    println!("\n════ ① 包体：整包下载（界面上的「读取整合包清单」）════");
    for src in [Source::Mojang, Source::Bmclapi] {
        let path = dir.join(format!("pack-{}.mrpack", src.as_str()));
        let task = DownloadTask::new(
            path.clone(),
            PACK_URL.to_string(),
            String::new(),
            0,
            "整合包".to_string(),
        );
        let t = Instant::now();
        let out = download::download_batch(vec![task], BatchOptions::new(8, src, CancelToken::new()))
            .await
            .expect("批量下载不该整体失败");
        let ms = t.elapsed().as_millis();
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        println!(
            "  {:<10} {:.1} s  {} 字节  {:.0} KB/s  失败 {} 个",
            src.as_str(),
            ms as f64 / 1000.0,
            len,
            len as f64 / 1024.0 / (ms as f64 / 1000.0).max(0.001),
            out.failed.len()
        );
        for (label, why) in out.failed.iter().take(3) {
            println!("      失败：{label} —— {why}");
        }
    }

    println!("\n════ ② 清单里那些文件：并发 4 / 16 / 48 各多久（界面上的 N/22）════");
    /*
     * 用**同一批真实 URL**，只是并发不同 —— 用户等的是这一个数。
     * ★ 这一格才是"整合包下载慢"的主战场：包体只下 1 个，里面要下几百个。
     */
    for conc in [4usize, 16, 48] {
        let round = dir.join(format!("c{conc}"));
        std::fs::create_dir_all(&round).unwrap();
        let tasks: Vec<DownloadTask> = FILES
            .iter()
            .map(|(name, url)| {
                DownloadTask::new(
                    round.join(format!("{conc}-{name}")),
                    (*url).to_string(),
                    String::new(),
                    0,
                    (*name).to_string(),
                )
            })
            .collect();
        let n = tasks.len();
        let t = Instant::now();
        let out = download::download_batch(
            tasks,
            BatchOptions::new(conc, Source::Bmclapi, CancelToken::new()),
        )
        .await
        .expect("批量下载不该整体失败");
        println!(
            "  并发 {conc:<3} {n} 个文件 {:.1} s（每文件 {:.0} ms）失败 {}",
            t.elapsed().as_secs_f64(),
            t.elapsed().as_millis() as f64 / n as f64,
            out.failed.len()
        );
    }

    println!("\n════ ③ 并发到底有没有用：单个 7 MB 走两条源 ════");
    /*
     * ★ 这一段回答的是"改并发有没有意义"：
     *   小文件多的时候，**并发就是唯一的手段**（每个文件的固定开销在那里摆着）；
     *   单个大文件时，并发靠的是**分片**（`plan_chunks`），不是多连接。
     */
    for src in [Source::Mojang, Source::Bmclapi] {
        let p = dir.join(format!("one-{}.bin", src.as_str()));
        let task = DownloadTask::new(p.clone(), PACK_URL.to_string(), String::new(), 0, "单文件".into());
        let t = Instant::now();
        let _ = download::download_batch(vec![task], BatchOptions::new(8, src, CancelToken::new())).await;
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let ms = t.elapsed().as_millis().max(1);
        println!(
            "  {:<10} {:.1} s  {} 字节  {:.0} KB/s",
            src.as_str(),
            ms as f64 / 1000.0,
            len,
            len as f64 / 1024.0 / (ms as f64 / 1000.0)
        );
    }

    println!("\n════ ④ 分片对 cdn.modrinth.com 到底有没有用（本次调查的核心）════");
    /*
     * ★★★★ 2026-10-01（用户：「整合包，你试试这个，这个比较小」）。
     *
     *   `chunking_enabled()` 默认**关掉分片**，理由写在它上面：
     *   实测 BMCLAPI 上单连接 27.9 s vs 8 路并行 23.4 s（只快 16%）——
     *   因为瓶颈是**按 IP 的总带宽**，不是单连接速度，而且分片会招 429。
     *
     *   但 ② 那一格量到的是**相反的形状**：同一个 CDN 上
     *   并发 4 → 226.8 s、16 → 55.8 s、48 → 23.4 s（**快 10 倍**）。
     *   ⇒ 这条 CDN 很可能是**按连接限速**：多开连接就多一份带宽。
     *
     *   若成立，那"包体单连接慢慢下"就是整合包真正的瓶颈 ——
     *   几百 MB 的包按 30 KB/s 下就是几小时，而**里面那些文件反而是并发的**。
     *
     *   ★ 量法：同一个大文件、同一个进程内切换 `IEML_CHUNKED` 各跑一次。
     *     环境变量是每次读的，所以同一个测试里连着跑才有可比性
     *     （跨进程比会被 CDN 的瞬时波动淹没 —— 这一点我在 ① 里已经见识过：
     *      同一个 URL 量到过 4 / 28 / 136 / 194 KB/s）。
     */
        /*
     * ★★★★ 2026-10-01（用户给了这个包）：「**这个大**」。
     *
     *   Better MC [FORGE] - BMC4 v28：**包体 113 MB**（Modrinth / Forge / 1.20.1）。
     *   它比上面那个 162 KB 的包大 **700 倍** —— 而"包体"这一格是**单连接**下的
     *   （`download_pack_body` 用 `concurrency: 1`，且分片已被实测否掉）。
     *
     *   所以这一个文件就能决定"整合包下载"是 40 秒还是 8 小时：
     *     按实测的 4 KB/s   → 约 **8 小时**
     *     按实测的 2865 KB/s → 约 **40 秒**
     *   两条都在同一条 CDN 上量到过。
     */
    const BIG: &str =
        "https://cdn.modrinth.com/data/4BV47HRn/versions/IGwlsu0n/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v28.mrpack";
    for (tag, chunked) in [("默认（单连接）", false), ("分片 8 段", true)] {
        if chunked {
            std::env::set_var("IEML_CHUNKED", "1");
        } else {
            std::env::remove_var("IEML_CHUNKED");
        }
        let p = dir.join(format!("big-{}", if chunked { "chunked" } else { "single" }));
        let _ = std::fs::remove_file(&p);
        let task = DownloadTask::new(p.clone(), BIG.to_string(), String::new(), 0, "大包".into());
        let t = Instant::now();
        let out = download::download_batch(
            vec![task],
            BatchOptions::new(8, Source::Bmclapi, CancelToken::new()),
        )
        .await
        .expect("不该整体失败");
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let ms = t.elapsed().as_millis().max(1);
        println!(
            "  {tag:<16} {:.1} s  {} 字节  {:.0} KB/s  失败 {}",
            ms as f64 / 1000.0,
            len,
            len as f64 / 1024.0 / (ms as f64 / 1000.0),
            out.failed.len()
        );
    }
    std::env::remove_var("IEML_CHUNKED");

    let _ = std::fs::remove_dir_all(&dir);
    println!("\n★ 读法：① 慢 ⇒ 包体那条源要换；② 并发加上去不变快 ⇒ 瓶颈在服务端限流；③ 差很多 ⇒ 并发就是解药。");
}
