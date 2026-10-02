//! ★★★★ **用真实引擎实测包体下载**（2026-10-02，用户：「你来测」）。
//!
//! ## 这一格回答的问题
//!
//!   上一轮把分片改成"**多源同时下**"（PCL 的 `TryBeginThread` 形状）。
//!   改完之后，**真实链路上到底快了多少**？
//!
//! ## 为什么这次的结果可信（前面几轮不可信的教训）
//!
//!   ① **不用我手写的 reqwest 请求**，而是走 `download_batch` —— 就是启动器
//!      自己调的那个函数（同样的客户端、同样的候选表、同样的重试/冷却）。
//!   ② **换一个缓存里没有的文件**：镜像对已缓存的文件极快（实测 1.15 MB/s），
//!      那不能代表用户装新包时的体验。用 Better MC 的另一个版本（v40）。
//!   ③ **两种配置各跑一遍、同一分钟**：`allow_chunked=false`（旧行为：
//!      单连接、依次试源）vs `true`（新行为：分片 + 多源轮转）。
//!      这是唯一能把"链路波动"和"代码改动"分开的办法。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_pack_speed -- --ignored --nocapture

use std::time::Instant;

/// Better MC v40（**缓存里没有**，所以量的就是"装一个新包"的体验）
///
/// ★ URL 是**从接口查出来的**（`/v2/project/better-mc-forge-bmc4/version` 里
///   `version_number == "v40"` 那一条），不是照着记忆拼的 ——
///   我第一版就写错了一个 version id，正是"先验证再用"救回来的。
const URL: &str =
    "https://cdn.modrinth.com/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";

fn mirror_of(u: &str) -> String {
    u.replace("https://cdn.modrinth.com/", "https://mod.mcimirror.top/")
}

#[tokio::test]
#[ignore = "真机：需要网络，会真下 64 MB × 2 遍"]
async fn 包体下载_旧行为_vs_多源同时下() {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};
    use ieml_lib::net::mirror::Source;

    let dir = std::env::temp_dir().join(format!("ieml-live-pack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    println!("\n════ Better MC v40（64 MB，缓存里没有）════");
    println!("   同一分钟、同一台机器，只改 `allow_chunked` 一个变量\n");

    for (label, chunked) in [("旧行为：单连接、依次试源", false), ("新行为：分片 + 多源轮转", true)] {
        let p = dir.join(if chunked { "chunked.mrpack" } else { "single.mrpack" });
        let _ = std::fs::remove_file(&p);
        let mut task = DownloadTask::new(p.clone(), URL.to_string(), String::new(), 0, "包体".into());
        task.allow_chunked = chunked;

        // ★ 关键：候选 URL **两条都给**（官方 + 镜像）—— 这正是"多源"要用的东西
        task.urls = vec![mirror_of(URL)];

        let t = Instant::now();
        let out = download::download_batch(
            vec![task],
            BatchOptions::new(1, Source::Bmclapi, CancelToken::new()),
        )
        .await
        .expect("不该整体失败");
        let ms = t.elapsed().as_millis().max(1);
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);

        println!(
            "  {label:<26} {:>6.1} s  {:>10} 字节  {:>8.0} KB/s  失败 {}",
            ms as f64 / 1000.0,
            len,
            len as f64 / 1024.0 / (ms as f64 / 1000.0),
            out.failed.len()
        );
        for (l, why) in out.failed.iter().take(3) {
            println!("      失败：{l} —— {why}");
        }
    }

    let _ = std::fs::remove_dir_all(&dir);
    println!("\n★ 读法：新行为若明显快 ⇒ 多源轮转真的起作用了；");
    println!("   两者相近 ⇒ 瓶颈在这条路的服务端总带宽，多开连接无益。");
    println!("   对照：PCL 在 CurseForge 那条路上实测 96.7 KB/s。");
}
