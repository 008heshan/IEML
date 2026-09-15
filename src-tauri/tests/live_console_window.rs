//! 真机验证：子进程的**窗口抑制**到底做到了哪一步。
//!
//! ## 这一轮踩的坑（写在这里，因为下次还会有人想重复它）
//!
//! 用户报：「安装 Forge 调出来个啥也没有的 cmd 是何意味」。
//! 根因很清楚：Windows 上，**GUI 子系统进程**（Tauri 的 `ieml.exe` 没有控制台）
//! 启动一个**控制台子系统程序**（`java.exe`）时，系统必须新建一个控制台；
//! 不传 `CREATE_NO_WINDOW` 就会弹出那个窗口。
//! 我们又是用 `java -jar forge-installer.jar --installClient <dir>` 装的 Forge
//! （Forge 官方唯一的无人值守接口），so 这个窗口就是"啥也没有的 cmd"。
//!
//! ## 为什么这里**测不到**那个窗口
//!
//! 试过两条路，都不行，原因值得记下来：
//!
//!   ① 从 `cargo test` 里启动 `ping`，对照组量可见窗口 —— **量到 0**。
//!      因为 `cargo test` 自己跑在一个控制台里，
//!      "控制台进程启动控制台子进程"会**继承**父控制台、不新建窗口，
//!      所以抑不抑制都看不到差别。实验环境不对，不是代码错。
//!   ② 换成 GUI 子系统的 `notepad` 当被试 —— 更不对：
//!      `CREATE_NO_WINDOW` 管的是**控制台**窗口，notepad 本来就没有控制台，
//!      它那个窗口是应用自己的，抑制组照样会显示。
//!      拿它当被试等于在测一个跟我们无关的东西。
//!
//!   **要真的复现，需要一个没有控制台的父进程（也就是 ieml.exe 自己）。**
//!   那属于端到端人工/半自动验证，不是单元测试能覆盖的。
//!
//! ## 所以这里测**确实能测的那一半**，并把边界写清楚
//!
//!   · 标志真的被写进了命令对象（不是"我调了个空函数"）；
//!   · 没有任何地方绕过统一入口手写魔数
//!     （手写 `0x0800_0000` 抄错一位就是一个新黑框，且不会有任何报错）；
//!   · 统一入口在非 Windows 上是空操作（不会因为 `cfg` 写错而在别的平台炸）。
//!
//! 真正的"黑框没了"由三件事共同保证：这三条 + `pnpm verify` 里的
//! `tools/audit-spawn-windows.mjs`（逐处审计）+ 人工双击安装一次 Forge。

use std::process::Command;

/// ★ 统一入口确实**改了命令对象**，不是个空函数。
///
///   判据用"带标志与不带标志的命令对象行为不同"来间接证明 ——
///   直接读 `creation_flags` 在 std 里没有公开 API。
///   这里用最直接可观测的差别：`Command` 的 debug 表示里
///   Windows 会带上扩展信息吗？不会。
///
///   所以退一步：用**进程实际行为**验证。带 `CREATE_NO_WINDOW` 启动的
///   控制台子进程，其**控制台窗口句柄**为空（`GetConsoleWindow` 返回 0）；
///   不带的会拿到一个句柄。
///
///   ★ 但上面刚说过：在我们的测试宿主里两者都会拿到**继承来的**控制台，
///     所以这里也不能用这个判据。
///
///   剩下唯一诚实的做法：**调用它，并断言它返回了同一个命令对象**
///   （即链式调用没被破坏），同时把"标志真的生效"交给静态审计。
///   这条测试的价值不在"证明了抑制生效"，而在"防止有人把
///   `hide_console` 改成空实现而没人发现" —— 见下一条测试。
#[test]
fn hide_console_is_a_noop_that_keeps_the_command_usable() {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "exit", "0"]);
    let ret = ieml_lib::platform::hide_console(&mut cmd);
    // 链式调用必须还能用（很多调用点写成 cmd.arg(..) 之后紧接着调它）
    ret.arg("/dummy-not-run");
    // 能正常构造、能正常跑（真的 spawn 一次，证明没有被标记破坏）
    let mut verify = Command::new("cmd");
    verify.args(["/c", "exit", "0"]);
    ieml_lib::platform::hide_console(&mut verify);
    let status = verify.status().expect("命令对象被 hide_console 弄坏了");
    assert!(status.success(), "cmd 应该正常退出");
}

/// ★★ 统一入口不能被改成空实现。
///
///   这条是**负向**检查：读源码，确认 `platform.rs` 里真的调用了
///   `creation_flags`，而且常量值是 `CREATE_NO_WINDOW`。
///
///   为什么要这么测：这个函数"什么都不做"也能通过上面所有行为测试
///   （在测试宿主里量不出差别，见文件头）。所以只能看源码。
///   这不是优雅的测法，但它是这个约束在测试环境里**唯一**能被抓住的方式。
#[test]
fn platform_hide_console_really_sets_create_no_window() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("platform.rs");
    let text = std::fs::read_to_string(&path).expect("读 platform.rs 失败");

    assert!(
        text.contains("pub const CREATE_NO_WINDOW: u32 = 0x0800_0000"),
        "CREATE_NO_WINDOW 的值必须是 0x0800_0000（这是 Windows 的定义，抄错就没有窗口抑制）"
    );
    assert!(
        text.contains("cmd.creation_flags(CREATE_NO_WINDOW)"),
        "hide_console / hide_console_async 必须真的调用 creation_flags —— \
         否则它们就是两个空函数，黑框照样弹"
    );
    // 两个入口各一次
    let hits = text.matches("creation_flags(CREATE_NO_WINDOW)").count();
    assert!(
        hits >= 2,
        "应该有 std 与 tokio 两个入口各调一次，实际 {hits} 次"
    );
    assert!(
        text.contains("pub fn hide_console_async"),
        "Forge 安装器走的是 tokio 那一条，这个入口不能少"
    );
}

/// ★ 没有任何地方绕过统一入口手写窗口标志。
///
///   手写 `0x0800_0000` 抄错一位就是一个新黑框，而且不会有任何报错 ——
///   所以统一入口是硬要求。`platform.rs` 是它自己的宿主，豁免。
#[test]
fn no_hand_rolled_window_flags_outside_platform() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().map(|x| x != "rs").unwrap_or(true) {
                continue;
            }
            if p.file_name().map(|n| n == "platform.rs").unwrap_or(false) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            if text.contains("creation_flags") || text.contains("0x0800_0000") {
                offenders.push(p.display().to_string());
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "这些文件绕过了 platform::hide_console 手写窗口标志：{offenders:#?}\n\
         请改用 crate::platform::hide_console / hide_console_async"
    );
    println!("\n✓ 没有绕过统一入口的手写标志");
}
