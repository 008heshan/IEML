//! 一次性诊断：**reqwest 到底有没有跟随镜像的 302**（2026-10-02）。
//!
//! 线索：`diag_first_bytes` 里引擎 12 秒只有 **195 字节**，
//!   而同一个 URL 用 curl 拿到 **830,464 字节**。
//!   195 字节这个数**正好是一个 302 响应的大小**（头 + 空 body）。
//!   ⇒ 强烈怀疑：**引擎停在了那个 302 上**，没有跟着跳到官方 CDN。
//!
//! 而 `cdn.modrinth.com` 的那条 302 的 `location` 里**带未转义的空格**：
//!   `location: https://cdn.modrinth.com/data/.../Better MC [FORGE] - BMC4 v40.mrpack`
//! curl 会自己转义并跟随；reqwest 遇到不合法的 Location 时**可能直接放弃**。
//!
//! 这个诊断把"发了什么、拿到了什么"打出来，不再靠推理。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_redirect -- --ignored --nocapture

use std::time::Instant;

const MIRROR: &str =
    "https://mod.mcimirror.top/data/4BV47HRn/versions/bXQ3GijP/Better%20MC%20%5BFORGE%5D%20-%20BMC4%20v40.mrpack";

#[tokio::test]
#[ignore = "真机：需要网络（只读响应头与前几 KB）"]
async fn 引擎有没有跟随镜像的302() {
    // ★ 用**生产客户端**（`net::client()`）—— 换一个自建客户端就测不到真实行为
    let c = ieml_lib::net::client();

    println!("\n════ ① 不带 Range：看它跟随到哪一步 ════");
    let t = Instant::now();
    match c.get(MIRROR).send().await {
        Ok(r) => {
            println!("  状态 = {}", r.status());
            println!("  最终 URL = {}", r.url());
            println!(
                "  content-length = {:?}",
                r.content_length()
            );
            println!("  重定向次数（响应里的 location 链我们看不到，但最终 URL 能说明）");
            // 只读前 64 KB —— 够判定"有没有真的在给数据"
            let mut got = 0usize;
            let mut stream = r.bytes_stream();
            use futures_util::StreamExt;
            while let Some(Ok(chunk)) = stream.next().await {
                got += chunk.len();
                if got >= 64 * 1024 {
                    break;
                }
            }
            println!("  读到 {got} 字节，用时 {:.2} s", t.elapsed().as_secs_f64());
        }
        Err(e) => println!("  ✗ 请求失败：{e}"),
    }

    println!("\n════ ② 带 Range（分片走的路）：看 206 是不是来自最终地址 ════");
    let t = Instant::now();
    match c
        .get(MIRROR)
        .header(reqwest::header::RANGE, "bytes=0-1048575")
        .send()
        .await
    {
        Ok(r) => {
            println!("  状态 = {}", r.status());
            println!("  最终 URL = {}", r.url());
            println!("  content-range = {:?}", r.headers().get(reqwest::header::CONTENT_RANGE));
            let mut got = 0usize;
            let mut stream = r.bytes_stream();
            use futures_util::StreamExt;
            while let Some(Ok(chunk)) = stream.next().await {
                got += chunk.len();
                if got >= 64 * 1024 {
                    break;
                }
            }
            println!("  读到 {got} 字节，用时 {:.2} s", t.elapsed().as_secs_f64());
        }
        Err(e) => println!("  ✗ 请求失败：{e}"),
    }

    println!("\n★ 判据：");
    println!("  ① 最终 URL 是 **mod.mcimirror.top** ⇒ **没有跟随 302**（这就是 195 字节的来源）；");
    println!("     最终 URL 是 cdn.modrinth.com ⇒ 跟随了，问题在别处。");
    println!("  ② 若带 Range 时最终 URL 仍是镜像、状态 302 ⇒ 分片的 8 条连接全部停在 302 上。");
}
