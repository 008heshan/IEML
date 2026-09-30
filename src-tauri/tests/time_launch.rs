//! 量"启动前启动器自己花了多久"（2026-09-30，用户：「我们的启动器有什么东西
//! 拖累游戏的启动速度了」）。
//!
//! 判据必须来自真机：这些成本全是**磁盘**上的，用假夹具量不出来。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test time_launch -- --ignored --nocapture
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 数据根（真机）
fn data_root() -> PathBuf {
    PathBuf::from("D:\\IEML")
}

/// 每个版本目录里的 natives 解压成本（这是启动路径上最重的一段）
fn time_natives(root: &Path) {
    let versions = root.join(".minecraft").join("versions");
    let Ok(rd) = std::fs::read_dir(&versions) else {
        println!("读不到 {}", versions.display());
        return;
    };
    println!("\n=== ① natives 目录现状（启动时会被 remove_dir_all 再重解一份） ===");
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for d in &dirs {
        let candidates = [
            ("新布局 .ieml/natives", d.join(".ieml").join("natives")),
            ("老布局 natives", d.join("natives")),
        ];
        for (tag, n) in &candidates {
            if !n.is_dir() {
                continue;
            }
            let t = Instant::now();
            let (files, bytes) = walk(n);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            println!(
                "  {:<28} {:<20} {:>5} 个文件 {:>8.1} MB   遍历 {:.1} ms",
                d.file_name().unwrap().to_string_lossy(),
                tag,
                files,
                bytes as f64 / 1_048_576.0,
                ms
            );
        }
    }

    // 真的走一遍"删掉 + 重新解压"，就是 `prepare_spec` 每次都做的事
    println!("\n=== ② 复现「删掉再解压一遍」的真实成本 ===");
    for d in &dirs {
        let natives = d.join(".ieml").join("natives");
        if !natives.is_dir() {
            continue;
        }
        // 只测"复制"这一段：把现有 dll 复制到临时目录（等价于从 jar 解出来的落盘成本）
        let tmp = std::env::temp_dir().join("ieml-natives-bench");
        let _ = std::fs::remove_dir_all(&tmp);
        let t = Instant::now();
        let n = copy_tree(&natives, &tmp);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "  {:<28} 复制 {n} 个文件（= 解压落盘的成本量级）：{:.0} ms",
            d.file_name().unwrap().to_string_lossy(),
            ms
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

/// 版本 JSON 与客户端 jar 的解析成本（启动前必读）
fn time_meta(root: &Path) {
    let versions = root.join(".minecraft").join("versions");
    println!("\n=== ③ 版本 JSON / 客户端 jar 的读取成本 ===");
    let Ok(rd) = std::fs::read_dir(&versions) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let dir = e.file_name().to_string_lossy().to_string();
        let json = p.join(format!("{dir}.json"));
        if json.is_file() {
            let t = Instant::now();
            let text = std::fs::read_to_string(&json).unwrap_or_default();
            let len = text.len();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            println!("  {dir:<28} JSON {len:>7} 字节   读取 {ms:.2} ms");
        }
        // 客户端 jar 大小（启动时 JVM 要打开它；我们不该在启动前碰它）
        let jar = p.join(format!("{dir}.jar"));
        if let Ok(m) = std::fs::metadata(&jar) {
            println!(
                "  {dir:<28} 客户端 jar {:>7.1} MB（启动器读它吗？—— 不该）",
                m.len() as f64 / 1_048_576.0
            );
        }
    }
}

fn walk(dir: &Path) -> (usize, u64) {
    let mut files = 0;
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_dir() {
                    let (f, b) = walk(&e.path());
                    files += f;
                    bytes += b;
                } else {
                    files += 1;
                    bytes += m.len();
                }
            }
        }
    }
    (files, bytes)
}

fn copy_tree(from: &Path, to: &Path) -> usize {
    let mut n = 0;
    if std::fs::create_dir_all(to).is_err() {
        return 0;
    }
    if let Ok(rd) = std::fs::read_dir(from) {
        for e in rd.flatten() {
            let dst = to.join(e.file_name());
            if e.path().is_dir() {
                n += copy_tree(&e.path(), &dst);
            } else if std::fs::copy(e.path(), &dst).is_ok() {
                n += 1;
            }
        }
    }
    n
}

#[test]
#[ignore = "真机：读用户数据目录，量启动成本"]
fn what_does_the_launcher_cost_before_java_starts() {
    let root = data_root();
    println!("\n数据根 = {}", root.display());
    println!("★ 下面量的都是「Java 还没起来之前，启动器自己花掉的时间」");
    time_meta(&root);
    time_natives(&root);
    println!("\n★ 结论：见上面每一段的毫秒数");
}
