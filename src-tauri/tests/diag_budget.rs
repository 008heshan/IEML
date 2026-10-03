//! 最小验证：**全局连接闸门会不会把自己卡死**（2026-10-02）。
//!
//! 背景：给 `download_range` 加了"发连接前先拿 `CONN_BUDGET` 名额"（64 个），
//! 结果一条并发测试跑了 10 分钟不返回。**先分清是闸门卡死、还是那条测试
//! 自己的场景有问题** —— 用最小的、带硬超时的场景来判。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_budget -- --ignored --nocapture

use std::time::Duration;

#[tokio::test]
#[ignore = "真机：起本地假服务器，不需要外网"]
async fn 闸门在单文件分片下会不会卡死() {
    use ieml_lib::net::download::{self, BatchOptions, CancelToken, DownloadTask};
    use ieml_lib::net::mirror::Source;

    // 极小的假服务器：任何请求都回固定 1 KB、带正确 Content-Range
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let Ok(n) = s.read(&mut tmp) else { break };
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            let range = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                .map(|l| l[6..].trim().to_string());
            let (status, cr, body): (u16, String, Vec<u8>) = match &range {
                Some(r) => {
                    let (a, b) = r
                        .trim_start_matches("bytes=")
                        .split_once('-')
                        .map(|(a, b)| {
                            (
                                a.trim().parse::<u64>().unwrap_or(0),
                                b.trim().parse::<u64>().unwrap_or(0),
                            )
                        })
                        .unwrap_or((0, 0));
                    (
                        206,
                        format!("Content-Range: bytes {a}-{b}/8388608\r\n"),
                        vec![7u8; (b - a + 1) as usize],
                    )
                }
                None => (200, String::new(), vec![7u8; 1024]),
            };
            let reason = if status == 206 { "Partial Content" } else { "OK" };
            let out = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n{cr}Connection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(out.as_bytes());
            let _ = s.write_all(&body);
            let _ = s.flush();
        }
    });

    let dir = std::env::temp_dir().join(format!("ieml-budget-diag-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("big.bin");

    let url = format!("http://{addr}/file.bin");
    // 8 MB：按 MIN_CHUNK(2MB) 会切 4 段 —— 正好试试"多段同时拿名额"
    let task = DownloadTask::new(p.clone(), url, String::new(), 0, "大文件".into()).chunked();

    println!("\n════ 单文件分片 + 全局闸门：8 秒硬超时 ════");
    let work = download::download_batch(
        vec![task],
        BatchOptions::new(1, Source::Mojang, CancelToken::new()),
    );
    match tokio::time::timeout(Duration::from_secs(8), work).await {
        Ok(Ok(out)) => {
            let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            println!(
                "  ✓ 没卡死：下到 {len} 字节，失败 {} 个",
                out.failed.len()
            );
            for (l, w) in out.failed.iter().take(3) {
                println!("      失败：{l} —— {w}");
            }
        }
        Ok(Err(e)) => println!("  ✓ 没卡死，但整体失败：{e}"),
        Err(_) => {
            println!("  ✗ **8 秒没返回 —— 疑似卡死**");
            println!("     （分片路径 + 全局闸门；下一步该查「谁拿了名额没还」）");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
