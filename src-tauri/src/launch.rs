//! 启动与日志抓取
//!
//! 架构文档要求：「stdout/stderr 重定向到日志文件，实时抓取崩溃信息」
//! 以及「退出检测：子进程结束 → 通知前端 → 自动计算本次游玩时长」。
//!
//! 这一块就是原设计稿**完全缺失**的"装完之后那一半"。

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub struct RunningGame {
    pub instance_id: String,
    pub pid: u32,
    pub started_at: u64,
    pub log_path: PathBuf,
    /// ★★ 这次启动用的是不是**离线身份**。
    ///
    /// 为什么要记住它（P0-6）：离线时游戏连不上 Mojang 验证服务，
    /// 日志里**必然**出现 `401 Unauthorized` 一类记录。崩溃判据必须知道
    /// 这件事，否则会把"我们自己造成的现象"报成故障
    /// （用户点一下「停止游戏」，界面弹「游戏异常退出 · 登录状态已失效」）。
    pub offline: bool,
    pub child: Arc<Mutex<Child>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub pid: u32,
    /// 给用户看的启动摘要（不暴露完整命令行里的敏感参数）
    pub summary: String,
    pub log_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GameExit {
    pub exit_code: Option<i32>,
    pub played_seconds: u64,
    pub crashed: bool,
    /// 崩溃原因（`crashed = false` 时为 `None`）—— 判据见
    /// `domain::crash::judge_crash`。**前端不要再自己拼一句原因**。
    #[serde(default)]
    pub crash_reason: Option<String>,
    /// 命中的规则 id（便于排查"它凭什么这么说"）
    #[serde(default)]
    pub crash_rule_id: Option<String>,
}

/// 启动参数（由前端算好传进来 —— 规则在 domain，这里只执行）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LaunchSpec {
    pub instance_id: String,
    pub java_path: String,
    pub jvm_args: Vec<String>,
    pub game_args: Vec<String>,
    pub working_dir: String,
    /// 用户可见的摘要，例如 "Forge 1.20.1 · 6 GB"
    pub summary: String,
    /// ★ 这次启动是不是离线身份（见 `RunningGame::offline` 的说明）。
    #[serde(default)]
    pub offline: bool,
}

/// 启动游戏，并把 stdout/stderr 实时写入日志文件。
///
/// ★ 三个关键点：
///   ① 用 `CREATE_NO_WINDOW` 避免 Windows 下闪黑框
///   ② stdout/stderr 都重定向到日志文件，**同时**在内存里保留尾部若干行
///      以便退出后立刻做崩溃分析（不用再读盘）
///   ③ 返回的 child 放在 Arc<Mutex<>> 里，供 stop_game 使用
///
/// `app` 用于**把"游戏退出了"这个事实推给前端**（见下面退出监测线程的注释）。
/// 老调用点可以传 `None`（那样就只能靠前端轮询标记文件，现在已经不推荐）。
pub fn launch(
    spec: &LaunchSpec,
    logs_dir: &PathBuf,
    app: Option<tauri::AppHandle>,
) -> Result<(RunningGame, LaunchResult), String> {
    std::fs::create_dir_all(logs_dir).map_err(|e| format!("无法创建日志目录：{e}"))?;

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let log_path = logs_dir.join(format!("{}-{started_at}.log", spec.instance_id));
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("无法创建日志文件：{e}"))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("无法复制日志句柄：{e}"))?;

    if !std::path::Path::new(&spec.java_path).is_file() {
        return Err(format!(
            "找不到 Java：{} —— 去实例设置里换一个可用的 Java",
            spec.java_path
        ));
    }

    let mut cmd = Command::new(&spec.java_path);
    cmd.args(&spec.jvm_args)
        .args(&spec.game_args)
        .current_dir(&spec.working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    // ★ 游戏本身也不弹控制台窗口（唯一入口，见 platform::hide_console）
    crate::platform::hide_console(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        format!(
            "启动失败：{e} —— 常见原因是 Java 路径不对、内存设置过大、或游戏文件不完整"
        )
    })?;

    let pid = child.id();
    let child = Arc::new(Mutex::new(child));

    // 退出监测：算游玩时长、写标记文件、并把 `game-exit` 事件推给前端。
    // 实现是唯一一份（见 `watch_game_exit`），两条启动路径共用。
    watch_game_exit(
        Arc::clone(&child),
        log_path.clone(),
        spec.instance_id.clone(),
        started_at,
        spec.offline,
        app,
    );

    Ok((
        RunningGame {
            instance_id: spec.instance_id.clone(),
            pid,
            started_at,
            log_path: log_path.clone(),
            offline: spec.offline,
            child,
        },
        LaunchResult {
            pid,
            summary: spec.summary.clone(),
            log_path: log_path.to_string_lossy().to_string(),
        },
    ))
}

/*
 * 秒退判定的阈值**只有一份**（P0-6）：在 `domain::crash` 里，
 * 由 `judge_crash` 与这里的 `detect_instant_failure` 共用。
 * 以前它们只写在这个文件里，于是"点停止游戏"那条路径压根没有这条判据 ——
 * 同一局游戏在两条路径上能得到两个结论。
 */
use crate::domain::crash::INSTANT_FAIL_LOG_BYTES;

/// 启动后**立刻**检查是不是"秒退"（进程已经死了、日志却是空的）。
///
/// 为什么需要这个（真机踩到）：游戏因为 native 库加载失败而瞬间退出时，
/// 我们给用户弹的是「游戏已启动 · PID xxxx」，日志文件 0 字节，
/// 而真正的错误在游戏**自己**的 crash-report 里 —— 用户完全不知道发生了什么，
/// 只能过来说"游戏启动不起来"。
///
/// 返回 `Some(说明)` 表示秒退。
pub fn detect_instant_failure(child: &Arc<Mutex<std::process::Child>>, log_path: &Path) -> Option<String> {
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let exited = {
        let mut guard = child.lock().ok()?;
        match guard.try_wait() {
            Ok(Some(status)) => Some(status),
            _ => None,
        }
    }?;

    let log_len = std::fs::metadata(log_path).map(|m| m.len()).unwrap_or(0);
    // 写了不少日志却退出了 → 是真崩溃，交给崩溃分析（不要在这里抢答）
    if log_len > INSTANT_FAIL_LOG_BYTES {
        return None;
    }
    let code = exited
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "未知（被信号终止）".into());
    Some(format!(
        "游戏进程刚启动就退出了（退出码 {code}），而且没有产生任何日志。\n\
         常见原因：本地库（natives）不完整、Java 版本不对、或游戏文件缺失。\n\
         可以点「校验文件」检查，或看游戏目录 crash-reports 里的崩溃报告。"
    ))
}

/// 等到启动后第一次可能失败的时刻（前台命令用，别让 UI 立刻说"已启动"）
pub fn settle_before_reporting() {
    std::thread::sleep(std::time::Duration::from_millis(900));
}

/// 读日志尾部若干行（崩溃分析用）。
/// 大日志文件只读尾部，避免把几百 MB 的日志整个读进内存。
pub fn read_log_tail(log_path: &PathBuf, max_bytes: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut f) = std::fs::File::open(log_path) else {
        return String::new();
    };
    let Ok(meta) = f.metadata() else {
        return String::new();
    };
    let len = meta.len();
    let start = len.saturating_sub(max_bytes as u64);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

/// 数一下日志里有多少行（进度展示用）
pub fn count_log_lines(log_path: &PathBuf) -> usize {
    let Ok(f) = std::fs::File::open(log_path) else {
        return 0;
    };
    BufReader::new(f).lines().count()
}

/// 盯着一个游戏进程直到它结束，然后：
///   ① 算出游玩时长与是否崩溃；② 写退出标记文件；③ **把事件推给前端**。
///
/// ★ 第三步是必须的（用户报"游戏关闭后启动器依然显示游戏在运行"）：
///   以前只做了前两步，而前端从来不读那个标记文件 ——
///   `running` 状态只有点"停止游戏"那条路径会被清掉。
///   用户自己关掉游戏窗口后，界面就永远停在"运行中"，
///   再点启动还会被"已经有一个游戏在运行了"挡住。
///
/// 抽成独立函数是为了**只有一份实现**：进程可以由
/// `launch()`（走 LaunchSpec）或 `commands_real::launch_minecraft`
/// （自己拼参数）拉起，两条路都必须有同样的退出处理。
pub fn watch_game_exit(
    child: Arc<Mutex<Child>>,
    log_path: PathBuf,
    instance_id: String,
    started_at: u64,
    offline: bool,
    app: Option<tauri::AppHandle>,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(800));

        /*
         * ★★ 锁**只围住 `try_wait()`**（2026-09-17 用户：
         *   "游戏关闭后，启动器的 UI 还是不正常，还会一直认为游戏在运行"）。
         *
         *   以前这里从 `child.lock()` 一路持锁到线程 `return` ——
         *   中间夹着：读 256 KB 日志 → `judge_crash` → 写标记文件 → 发 Tauri 事件。
         *   而 `running_games`（前端每 4 秒的兜底轮询）是**持注册表锁来抢这把锁**的，
         *   于是它得排队等整套收尾做完。
         *
         *   更要命的是**注册表没有别的清理点**：这条线程从不删自己
         *   （见 `is_still_running` 上面那段注释——"只有点停止游戏才会被清"），
         *   清理全靠 `running_games` 里那句 `retain(is_still_running)`。
         *   所以只要收尾那几步里**任何一步卡住**（`emit` 阻塞、日志读取慢、
         *   主线程忙），这把锁就放不掉 →
         *     `running_games` 永不返回 → 前端 `await` **挂住**（不抛错，`catch` 捕不到）
         *     → 本地表永远不会被后端的事实覆盖
         *     → **UI 永久显示"游戏在运行"**，再点启动还会被"已经有一个在跑"挡住。
         *
         *   根因是**锁的范围**：收尾那几步（读日志、判崩溃、写文件、发事件）
         *   一个都不需要子进程句柄，让锁一直握着纯属顺手。
         *   把锁缩到只包住 `try_wait()`，这条链就断了。
         */
        let status = {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.try_wait() {
                Ok(Some(s)) => s,
                Ok(None) => continue,
                Err(_) => return,
            }
        }; // ← 锁在这一行就放掉了；下面全是**无锁**的收尾

        let code = status.code();
        let played = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_sub(started_at);
        let log_len = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

        /*
         * ★★ 崩溃判据**只有一份**（`domain::crash::judge_crash`，P0-6）。
         *
         *   这里以前只写了一句 `code != 0 || instant_fail`：
         *     · native 库加载失败时 JVM 的退出码是 **0** → 报"正常退出"，
         *       用户看到"游戏启动了然后关了"，没有任何解释；
         *     · 而"点停止游戏"那条路径用的是**另一套**判据（只看日志规则），
         *       同一局游戏在两条路径上能得到两个相反的结论。
         *
         *   现在：退出码 + 游戏自己的崩溃声明 + 秒退，三者合一；
         *   离线身份传进去，日志里那句必然出现的 401 会被排除掉。
         */
        let tail = read_log_tail(&log_path, 256 * 1024);
        let verdict = crate::domain::crash::judge_crash(
            code,
            false, // 这条路径都是"游戏自己退出的"；用户点停止走 stop_minecraft
            offline,
            played,
            log_len,
            &tail,
        );
        let crashed = verdict.crashed;
        if let Some(reason) = &verdict.reason {
            eprintln!(
                "[IEML/launch] {instance_id} 判定为异常退出：{reason}（退出码 {code:?}，玩了 {played} 秒）"
            );
            for e in &verdict.evidence {
                eprintln!("[IEML/launch]   依据：{e}");
            }
        }
        let payload = GameExit {
            exit_code: code,
            played_seconds: played,
            crashed,
            crash_reason: verdict.reason.clone(),
            crash_rule_id: verdict.rule_id.clone(),
        };

        // 标记文件：让**重启启动器之后**也能知道上次的结果
        let marker = log_path.with_extension("exit.json");
        let _ = std::fs::write(
            marker,
            serde_json::to_string(&payload).unwrap_or_default(),
        );

        // 事件：让**当次**界面立刻更新（两件事都要做，缺一个就有 bug）
        if let Some(app) = &app {
            use tauri::Emitter;
            let _ = app.emit(
                "game-exit",
                serde_json::json!({
                    "instanceId": instance_id,
                    "exitCode": payload.exit_code,
                    "playedSeconds": payload.played_seconds,
                    "crashed": payload.crashed,
                    "logPath": log_path.to_string_lossy().to_string(),
                }),
            );
        }
        return;
    });
}

/// 这个"正在运行"的游戏**是不是真的还在跑**？
///
/// ★ 为什么需要它（用户报"游戏关闭后启动器依然显示游戏在运行"）：
///   退出监测线程会写标记文件、现在也会推事件，但后端 `AppState.running`
///   这个槽**只有点"停止游戏"才会被清**。用户自己关掉游戏窗口后，
///   槽里还留着一个已经死掉的 child —— 于是：
///     · 界面一直显示运行中；
///     · 再点启动会被"已经有一个游戏在运行了"挡住。
///   所以每次要用这个槽之前，都先问一句"它还活着吗"，
///   死了就当成没有（顺手把槽清掉）。
pub fn is_still_running(running: &RunningGame) -> bool {
    is_child_alive(&running.child)
}

/// 只判"这个子进程句柄还活着吗" —— 不需要整个 `RunningGame`。
///
/// ★ 存在的理由（2026-09-17）：`running_games` 需要**在放掉注册表锁之后**
///   逐个判活（它以前是持着注册表锁去抢子进程锁，见那里的注释）。
///   把判据抽出来，两处共用同一份实现 —— 判据仍然只有一处。
pub fn is_child_alive(child: &Arc<Mutex<Child>>) -> bool {
    let Ok(mut guard) = child.lock() else {
        return false; // 拿不到句柄 → 当作已结束，别把用户卡死
    };
    matches!(guard.try_wait(), Ok(None))
}

/// 进程**已经结束**时的退出码（还没结束或拿不到时返回 `None`）。
///
/// ★ 用途（P0-6）：用户点「停止游戏」时，得先分清"游戏自己退了"还是
///   "我们把它杀了" —— 后者那个退出码是 taskkill 造成的，
///   拿它当崩溃证据就是伪造因果。
pub fn exit_code_of(running: &RunningGame) -> Option<i32> {
    let mut guard = running.child.lock().ok()?;
    match guard.try_wait() {
        Ok(Some(status)) => status.code(),
        _ => None,
    }
}

/// 停止游戏：先温和结束，超时再强杀。
/// ★ 直接 kill 会让游戏来不及保存存档，所以先试正常关闭。
pub fn stop(running: &RunningGame) -> Result<(), String> {
    // Windows 分支需要 guard.id()，非 Windows 分支需要 guard.kill()，
    // 两边都需要 mut —— 所以这里不能用 cfg 条件化 mut 本身
    #[allow(unused_mut)]
    let mut guard = running
        .child
        .lock()
        .map_err(|_| "无法获取游戏进程句柄".to_string())?;

    #[cfg(windows)]
    {
        // 用 taskkill 先发关闭信号（不带 /F），给游戏时间保存
        // ★ 不弹黑框：taskkill 也是控制台程序，不抑制会闪一个窗口
        let pid = guard.id().to_string();
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid, "/T"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut kill);
        let ok = kill.status().map(|s| s.success()).unwrap_or(false);

        if !ok {
            // 温和方式失败 → 强杀，但告诉调用方这是强杀
            let mut force = Command::new("taskkill");
            force
                .args(["/PID", &pid, "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            crate::platform::hide_console(&mut force);
            let _ = force.status();
            return Err("游戏没有响应正常关闭请求，已强制结束。存档可能没有保存。".into());
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let mut guard = running
            .child
            .lock()
            .map_err(|_| "无法获取游戏进程句柄".to_string())?;
        guard
            .kill()
            .map_err(|e| format!("结束游戏进程失败：{e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_tail_reads_last_bytes() {
        let dir = std::env::temp_dir().join("ieml-test-logtail");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("t.log");
        std::fs::write(&p, "AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n").unwrap();
        let tail = read_log_tail(&p, 12);
        assert!(tail.ends_with("CCCCCCCCCC\n"), "{tail}");
        assert!(!tail.contains("AAAAAAAAAA"), "{tail}");
    }

    #[test]
    fn log_tail_handles_missing_file() {
        let p = std::env::temp_dir().join("definitely-not-here.log");
        assert_eq!(read_log_tail(&p, 100), "");
    }

    /* ---------- 秒退检测（★ 真机踩过：游戏死了却报"已启动"） ---------- */

    /// 进程已经死了、日志 0 字节 → 必须判定为启动失败。
    /// 这是用户实际遇到的形态：native 库加载失败时 JVM 1 秒内退出、退出码还是 0。
    #[cfg(windows)]
    #[test]
    fn instant_failure_is_detected_when_process_dies_silently() {
        let dir = std::env::temp_dir().join("ieml-test-instant");
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("empty.log");
        std::fs::write(&log, "").unwrap();

        // 测试里也不弹黑框：否则每跑一次 cargo test 就闪三个控制台窗口
        let mut c = Command::new("cmd");
        c.args(["/c", "exit", "0"]) // 立刻退出、不写任何东西
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut c);
        let child = c.spawn().expect("spawn cmd");
        let child = Arc::new(Mutex::new(child));

        let reason = detect_instant_failure(&child, &log);
        assert!(
            reason.is_some(),
            "★ 进程秒退且日志为空时必须报启动失败（否则用户看到的是「已启动」）"
        );
        let msg = reason.unwrap();
        assert!(msg.contains("退出码"), "说明里要带退出码：{msg}");
        assert!(msg.contains("校验文件"), "说明里要给可操作的下一步：{msg}");
    }

    /// 进程还活着 → 绝不能误报。
    #[cfg(windows)]
    #[test]
    fn running_process_is_not_reported_as_failure() {
        let dir = std::env::temp_dir().join("ieml-test-instant");
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("empty2.log");
        std::fs::write(&log, "").unwrap();

        // ping 自己 5 次 ≈ 5 秒，足够活过检测窗口
        let mut c = Command::new("cmd");
        c.args(["/c", "ping", "-n", "5", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut c);
        let child = c.spawn().expect("spawn ping");
        let child = Arc::new(Mutex::new(child));

        let reason = detect_instant_failure(&child, &log);
        assert!(reason.is_none(), "进程还在跑就不该报失败：{reason:?}");

        let _ = child.lock().map(|mut c| c.kill());
    }

    /// 写了不少日志才退出 → 是真崩溃，交给崩溃分析，秒退检测不要抢答。
    #[cfg(windows)]
    #[test]
    fn process_with_real_output_is_left_to_crash_analysis() {
        let dir = std::env::temp_dir().join("ieml-test-instant");
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("chatty.log");
        std::fs::write(&log, "x".repeat(500)).unwrap();

        let mut c = Command::new("cmd");
        c.args(["/c", "exit", "1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut c);
        let child = c.spawn().expect("spawn cmd");
        let child = Arc::new(Mutex::new(child));

        let reason = detect_instant_failure(&child, &log);
        assert!(
            reason.is_none(),
            "已经有日志了就不该判成「秒退」，应交给崩溃分析：{reason:?}"
        );
    }

    /* ==================== 多开实例（2026-09-15） ====================
     *
     * ★ 这些测试**用真进程**（`ping` 冒充两个"游戏"），不碰 Minecraft：
     *   多开改的是"谁在跑"这张表的语义，而那张表装的全是**子进程句柄** ——
     *   拿假对象测出来的"两个能共存"没有意义，真出问题的地方恰恰是
     *   `try_wait` / `taskkill` 这些真调用。
     *
     *   一条 `ping -n 6 127.0.0.1` ≈ 5 秒，够跑完断言；测试结束时全部杀掉。
     */

    /// 造一个"正在跑的游戏"：真进程 + 最小字段。
    #[cfg(windows)]
    fn fake_running(instance_id: &str) -> RunningGame {
        let mut c = Command::new("cmd");
        c.args(["/c", "ping", "-n", "6", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut c);
        let child = c.spawn().expect("spawn ping");
        let pid = child.id();
        RunningGame {
            instance_id: instance_id.to_string(),
            pid,
            started_at: now_secs_for_test(),
            log_path: std::env::temp_dir().join(format!("ieml-test-multi-{instance_id}.log")),
            offline: true,
            child: Arc::new(Mutex::new(child)),
        }
    }

    #[cfg(windows)]
    fn now_secs_for_test() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// ★★ **两个实例可以同时在跑**：这是"多开"的定义。
    ///
    ///   旧模型是一张 `Option<RunningGame>`（单槽），第二个 `insert` 会把第一个
    ///   顶掉 —— 那正是"开了新的，旧的失联"这类事故的来源。
    #[cfg(windows)]
    #[test]
    fn two_instances_can_run_at_the_same_time() {
        let mut table: std::collections::HashMap<String, RunningGame> =
            std::collections::HashMap::new();
        let a = fake_running("inst-a");
        let b = fake_running("inst-b");
        let pid_a = a.pid;
        let pid_b = b.pid;
        assert_ne!(pid_a, pid_b, "两个进程必须真的不同");

        table.insert("inst-a".into(), a);
        table.insert("inst-b".into(), b);

        assert_eq!(table.len(), 2, "两个实例都要在表里");
        assert!(is_still_running(table.get("inst-a").unwrap()));
        assert!(is_still_running(table.get("inst-b").unwrap()));

        // 收尾
        for (_, r) in table.drain() {
            let _ = stop(&r);
        }
    }

    /// ★★ **停一个不许连坐另一个**（多开之后最危险的错：停错游戏）。
    #[cfg(windows)]
    #[test]
    fn stopping_one_instance_leaves_the_other_running() {
        let mut table: std::collections::HashMap<String, RunningGame> =
            std::collections::HashMap::new();
        table.insert("inst-a".into(), fake_running("inst-a"));
        table.insert("inst-b".into(), fake_running("inst-b"));

        // 点名停 a（就是 `stop_minecraft(Some("inst-a"))` 干的事）
        let a = table.remove("inst-a").expect("a 应该在表里");
        /*
         * ★ `stop` 的返回契约是"**警告**"而不是"失败"：
         *   进程不肯优雅关闭（`ping` 当然不肯）时它会 taskkill，并把
         *   "已强制结束、存档可能没保存"作为 Err 报出来 —— 调用方
         *   （`stop_minecraft`）就是把它当 `warning` 用的（`.err()`）。
         *   所以这里**不能** `.expect()`：要断言的是"进程真的没了"。
         */
        let warn = stop(&a).err();

        assert!(!is_still_running(&a), "a 应该已经被停掉（强杀也算停掉）");
        if let Some(w) = &warn {
            assert!(w.contains("强制结束"), "非优雅关闭时应当如实说明：{w}");
        }
        assert_eq!(table.len(), 1, "b 必须还在表里");
        assert!(is_still_running(table.get("inst-b").unwrap()), "b 必须还在跑");

        let _ = stop(table.get("inst-b").unwrap());
    }

    /// 表里混进一个**已经死掉**的进程时：`retain` 只清它，活的照旧。
    ///
    ///   这条对应启动路径上那句 `guard.retain(...)`：死掉的进程不该占着位置
    ///   （老 bug 就是"用户自己关掉游戏后，界面永远卡在运行中"）。
    #[cfg(windows)]
    #[test]
    fn retain_drops_only_the_dead_entry() {
        let mut table: std::collections::HashMap<String, RunningGame> =
            std::collections::HashMap::new();

        // 一个立刻退出的进程 = 已经死掉的游戏
        let mut c = Command::new("cmd");
        c.args(["/c", "exit", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut c);
        let dead = RunningGame {
            instance_id: "inst-dead".into(),
            pid: 0,
            started_at: now_secs_for_test(),
            log_path: std::env::temp_dir().join("ieml-test-multi-dead.log"),
            offline: true,
            child: Arc::new(Mutex::new(c.spawn().expect("spawn cmd"))),
        };
        table.insert("inst-dead".into(), dead);
        table.insert("inst-alive".into(), fake_running("inst-alive"));

        // 等那个进程真的退出（try_wait 才看得到）
        std::thread::sleep(std::time::Duration::from_millis(600));
        table.retain(|_, r| is_still_running(r));

        assert_eq!(table.len(), 1, "死掉的那个要被清掉，活的要留下");
        assert!(table.contains_key("inst-alive"), "留下的必须是活着那个");

        let _ = stop(table.get("inst-alive").unwrap());
    }
}
