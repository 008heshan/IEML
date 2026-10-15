/**
 * 「进入启动器的速度有点慢」那一条里量 `machine_info` 的**第一次调用**。
 * ------------------------------------------------------------------
 * 为什么要单开一个测试、而不是在应用里看日志：
 *
 *   `machine_info` 的成本几乎全在**第一次**（sysinfo 的初始化 + 逐 CPU 读计数），
 *   之后同一进程里只要 0~1ms。而"跨时段对比两次启动"不可靠 ——
 *   真机上量过一次：同样的代码，机器一忙（Defender 扫新编出来的 exe），
 *   连页面自己解析 JS 的时间都从 129ms 变成 300ms。**那不是代码的差别，是机器的差别。**
 *
 *   ⇒ 判据改成"**两个全新进程，紧挨着跑**，各只量第一次调用"：
 *     由 `IEML_BENCH_VARIANT`（`all` / `list`）选哪一种刷新方式，
 *     这样两边面对的是同一台机器的同一分钟。
 *
 * 用法（手动跑；默认被 `#[ignore]` 跳过，不进 `cargo test` 的常规集合）：
 *
 *   IEML_BENCH_VARIANT=all  cargo test --lib -- --ignored --nocapture bench_machine_info_first_call
 *   IEML_BENCH_VARIANT=list cargo test --lib -- --ignored --nocapture bench_machine_info_first_call
 *
 * 结论（2026-10-09 本机，两次各一新进程）：见下面的 `BENCH_NOTE`。
 */
#[cfg(test)]
mod bench {
    use std::time::Instant;

    /// 上一次真机量到的数（供下一个人对照，不许当判据用）
    const BENCH_NOTE: &str = "2026-10-09：见 CHANGELOG 所在的那一轮报告";

    #[test]
    #[ignore = "手动跑的耗时基准；IEML_BENCH_VARIANT=all|list"]
    fn bench_machine_info_first_call() {
        let variant = std::env::var("IEML_BENCH_VARIANT").unwrap_or_else(|_| "list".into());
        let t = Instant::now();
        let info = match variant.as_str() {
            // 老写法：逐个 CPU 读时间与频率
            "all" => {
                use sysinfo::System;
                let mut sys = System::new();
                sys.refresh_memory();
                sys.refresh_cpu_all();
                sys.cpus().len()
            }
            // 新写法：只要"有哪些 CPU"，不读计数
            _ => {
                use sysinfo::{CpuRefreshKind, System};
                let mut sys = System::new();
                sys.refresh_memory();
                sys.refresh_cpu_list(CpuRefreshKind::nothing());
                sys.cpus().len()
            }
        };
        let ms = t.elapsed().as_millis();
        println!("[bench] 变体 {variant}：第一次 machine_info = {ms}ms（{info} 个 CPU）");
        println!("[bench] {BENCH_NOTE}");
    }
}
