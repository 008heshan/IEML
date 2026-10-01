//! ★★★★ 「删除后重启又复活」的现场诊断（2026-10-01，用户：「这些不可用版本，
//! 删除后，在重启启动器后会复活」）。
//!
//! ## 已经确认的事实（真机 `D:\IEML\.minecraft\versions`）
//!
//!   | 目录 | 盘上 | 账本 | 墓碑 |
//!   |---|---|---|---|
//!   | `26.3-fabric-0.19.5` | **在（2 个 json）** | 无 | **在**（删过） |
//!   | `vanilla-1122` | **在（1.8 MB）** | **在** | 无 |
//!   | `vanilla-262` | **在（30 MB）** | **在** | 无 |
//!
//!   ⇒ **墓碑写下了、目录却一个都没少**。而 `removeInstance` 的顺序是
//!     "先删磁盘、成功才写墓碑" —— 所以后端当时一定**返回了成功**。
//!     另：`vanilla-1122/262` 连墓碑都没有，说明那两个走的是**另一条路**
//!     （`deleteVersionDir`，没有记录的行）**而且根本没删成**。
//!
//! ## 这个诊断要回答的唯一问题
//!
//!   **`trash::delete` 在我们这个路径上到底成不成？**
//!   它失败时前端会看到错误（然后不写墓碑）—— 但墓碑在，所以它没报错。
//!   那就有两种可能，诊断要分开它们：
//!     ① 它**真的把目录移走了**，之后又被什么东西建回来；
//!     ② 它**什么都没做却返回了 Ok**。
//!
//!   做法：**造一个与真实目标同卷、同层级的替身目录**，调真正的删除逻辑，
//!   然后看它（a）还在不在、（b）回收站里有没有。用替身是因为**不能拿用户的
//!   存档做实验**。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test diag_delete -- --ignored --nocapture

use std::path::Path;

/// 与 `commands::dir_size` 同义：递归求和，用来判断"到底删掉了没有"。
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            total += dir_size(&p);
        } else if let Ok(m) = e.metadata() {
            total += m.len();
        }
    }
    total
}

#[test]
#[ignore = "真机：会在 D:\\IEML\\.minecraft\\versions 下造一个替身目录再删掉"]
fn 删除到底是成功了还是什么都没做() {
    // 与真实目标**同卷同层级**：真机上游戏数据在 D 盘
    let base = Path::new(r"D:\IEML\.minecraft\versions");
    assert!(base.is_dir(), "这个诊断要在真机上跑：{} 不存在", base.display());

    let probe = base.join("__ieml-delete-probe__");
    let _ = std::fs::remove_dir_all(&probe);
    std::fs::create_dir_all(probe.join("nested")).unwrap();
    std::fs::write(probe.join("a.json"), b"{\"id\":\"probe\"}").unwrap();
    std::fs::write(probe.join("nested").join("blob.bin"), vec![7u8; 64 * 1024]).unwrap();

    let before = dir_size(&probe);
    println!("\n替身目录：{}", probe.display());
    println!("  删前：存在={} 大小={before} 字节", probe.exists());

    print!("  调用 trash::delete ... ");
    let outcome = trash::delete(&probe);
    println!("{:?}", outcome.map(|_| "Ok"));

    println!("  删后：存在={}", probe.exists());
    if probe.exists() {
        println!("  删后大小={} 字节", dir_size(&probe));
        println!(
            "\n  ⇒ ★★ **trash::delete 返回了 Ok，目录却还在** —— 这就是「删了又复活」的成因：\n\
             \x20    前端拿到 Ok 就写了墓碑、删了记录，而磁盘**一个字节都没动**；\n\
             \x20    下一轮启动扫盘又把它读出来显示（看起来就是「复活」）。\n"
        );
    } else {
        println!("\n  ⇒ trash::delete 真的移走了目录（在这个路径上工作正常）\n");
    }

    // 收尾：不管成没成，都别把替身留在用户盘上
    if probe.exists() {
        let _ = std::fs::remove_dir_all(&probe);
        println!("  已清理替身目录（用的是永久删除，确认它能删掉）");
    }

    // 附加信息：回收站里能不能看到（只看不点）
    println!("\n★ 如果上面是「返回 Ok 却还在」，那要查的是：");
    println!("   ① 这个盘（D:）有没有回收站；");
    println!("   ② Windows 的「不将文件移到回收站」策略是否开着。");
}
