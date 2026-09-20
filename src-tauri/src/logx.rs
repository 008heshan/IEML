//! 诊断输出的**唯一出口**：说一句话，但**不许因为说这句话而死**。
//!
//! ★★ 2026-09-20 实测的一起真事故（两次"查不出来的启动崩溃"的真因）：
//!
//!   `eprintln!` / `println!` 在**写失败时会 panic**（Rust 的标准行为：
//!   "failed printing to stdout: The pipe is being closed"），
//!   而 release 用的是 `panic = "abort"` —— 于是**日志管道断了会直接干掉启动器**。
//!
//!   复现（3/3 稳定）：起进程后立刻关掉 stdout/stderr 的读端，
//!   `IEML.exe` 约两秒后崩在 `0xc0000409`（BEX64）—— 那正是
//!   `net::probe` 的后台线程打印 `[IEML/probe] 中位 TTFB = …` 的时刻。
//!   两次真实崩溃（beta.51 20:43:45、beta.52 21:44:28）都出自这个形状：
//!   **从别的进程/脚本里启动、对方不读输出**的时候。
//!
//!   所以：所有给开发者看的输出都走 [`say`] / `say!`。写失败就当没说 ——
//!   **一条日志不值一条命**。
//!
//! ★ 为什么不去改 `panic = "abort"`：那是体积与"崩得干净"的选择，
//!   而这里的问题根本不是 panic 策略，是**我们用了一个会 panic 的打印宏**。
//!   把出口收成一个，才不会再有人顺手写回 `eprintln!`（有条测试守着，见文件末尾）。

use std::io::Write;

/// 往 stderr 说一句话。**写失败就静默放弃**（见模块头部的说明）。
pub fn say(line: &str) {
    let mut err = std::io::stderr();
    let _ = writeln!(err, "{line}");
    // flush 失败同样不算错：管道断了、控制台关了，都不是程序该管的事
    let _ = err.flush();
}

/// `say!("[IEML/x] {}", v)` —— 与 `eprintln!` 同形，但**不会 panic**。
#[macro_export]
macro_rules! say {
    ($($arg:tt)*) => {
        $crate::logx::say(&format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    /// ★ 防漂断言：**非测试代码里不许再出现 `eprintln!` / `println!`**。
    ///
    ///   这一条是这轮事故的直接产物：只要有人再顺手写一个 `eprintln!`，
    ///   "管道断了崩启动器"就回来了，而且**只在别人的机器上、只在别人
    ///   不读输出的时候**才现形（我们自己的开发机上永远看不到）。
    ///   所以用一条静态断言把它钉住，而不是靠记性。
    #[test]
    fn production_code_never_prints_with_panicking_macros() {
        fn walk(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, usize, String)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let Ok(text) = std::fs::read_to_string(&p) else {
                        continue;
                    };
                    // 这个文件自己就是定义处，跳过
                    if p.file_name().is_some_and(|n| n == "logx.rs") {
                        continue;
                    }
                    let mut in_tests = false;
                    let mut depth_at_tests = 0usize;
                    for (i, line) in text.lines().enumerate() {
                        let t = line.trim_start();
                        // 粗判"进了 #[cfg(test)] 模块"：测试里打印是安全的（cargo 自己管管道）
                        if t.starts_with("#[cfg(test)]") {
                            in_tests = true;
                            depth_at_tests = 0;
                        }
                        if in_tests {
                            depth_at_tests += t.matches('{').count();
                            depth_at_tests = depth_at_tests.saturating_sub(t.matches('}').count());
                            if depth_at_tests == 0 && t.starts_with('}') {
                                in_tests = false;
                            }
                            continue;
                        }
                        if t.starts_with("eprintln!") || t.starts_with("println!") {
                            out.push((p.clone(), i + 1, t.chars().take(60).collect()));
                        }
                    }
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert!(
            found.is_empty(),
            "非测试代码里不许用会 panic 的打印宏（请改用 say!）—— 日志管道断了会崩掉启动器：\n{}",
            found
                .iter()
                .map(|(p, l, t)| format!("  {}:{l}  {t}", p.display()))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
