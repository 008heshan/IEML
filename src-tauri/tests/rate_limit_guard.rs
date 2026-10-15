//! 登录链限流防护的**离线单测**（不打网络）。
//!
//! 背景（2026-10-13，用户截图：`login_with_xbox` 频繁 HTTP 429）：
//!   ① 老 `post_with_retry` 把 429 和网络抖动混在一起，只退避 1s/3s ——
//!      429 是"你太快了"，短退避等于白打，重试又吃一次 429；
//!   ② 登录链入口没有节流，用户反复点「正版登录」让整套微软接口吃重复请求。
//!
//! 这里单测两个新抽出来的纯函数，避免真打微软接口（真机部分在
//! `live_ms_login.rs`）：
//!   - `backoff_after`：429 长退避（2s → 8s）+ 尊重 `Retry-After`（封顶 30s），
//!     网络错 / 5xx / 408 维持短退避（1s → 3s）；
//!   - `login_gate_allows`：两次登录链之间的最小间隔判定。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test rate_limit_guard

use std::time::{Duration, Instant};

use ieml_lib::auth;

#[test]
fn rate_limit_backoff_is_long_and_escalating() {
    // 429 首次失败 → 2s；再次失败 → 8s：比网络抖动的 1s/3s 明显更久。
    assert_eq!(auth::backoff_after(1, 429, None), Duration::from_secs(2));
    assert_eq!(auth::backoff_after(2, 429, None), Duration::from_secs(8));
    // 第三次失败不重试，`backoff_after` 不被调用（循环在 attempt=3 时结束）。
}

#[test]
fn rate_limit_respects_retry_after_with_cap() {
    // Retry-After 比基础退避长 → 取 Retry-After（10s > 2s）。
    assert_eq!(
        auth::backoff_after(1, 429, Some(10)),
        Duration::from_secs(10)
    );
    // Retry-After 比基础退避短 → 取基础退避（1s < 2s，取 2s）。
    assert_eq!(auth::backoff_after(1, 429, Some(1)), Duration::from_secs(2));
    // Retry-After 特别长 → 封顶 30s，绝不干等几分钟。
    assert_eq!(
        auth::backoff_after(1, 429, Some(300)),
        Duration::from_secs(30)
    );
    assert_eq!(
        auth::backoff_after(2, 429, Some(300)),
        Duration::from_secs(30)
    );
}

#[test]
fn transient_backoff_stays_short() {
    // 网络错（没有响应，code=0）→ 短退避，维持原行为。
    assert_eq!(auth::backoff_after(1, 0, None), Duration::from_secs(1));
    assert_eq!(auth::backoff_after(2, 0, None), Duration::from_secs(3));
    // 5xx / 408 → 短退避（它们多半是瞬时抖动，不是"你太快了"）。
    assert_eq!(auth::backoff_after(1, 500, None), Duration::from_secs(1));
    assert_eq!(auth::backoff_after(2, 503, None), Duration::from_secs(3));
    assert_eq!(auth::backoff_after(1, 408, None), Duration::from_secs(1));
    assert_eq!(auth::backoff_after(2, 408, None), Duration::from_secs(3));
    // Retry-After 只对 429 生效；5xx 的 Retry-After 被忽略（不放大等待）。
    assert_eq!(auth::backoff_after(1, 503, Some(60)), Duration::from_secs(1));
}

#[test]
fn login_gate_first_call_always_allows() {
    assert!(
        auth::login_gate_allows(None, Instant::now(), Duration::from_secs(8)),
        "从未登录过（None）应直接放行"
    );
}

#[test]
fn login_gate_blocks_within_interval_and_allows_after() {
    let min = Duration::from_secs(8);
    let t0 = Instant::now();

    // 刚登录完 → 间隔内，拒绝。
    assert!(!auth::login_gate_allows(Some(t0), t0 + Duration::from_secs(1), min));
    assert!(!auth::login_gate_allows(Some(t0), t0 + Duration::from_secs(7), min));

    // 满 8s → 放行。
    assert!(auth::login_gate_allows(Some(t0), t0 + min, min));
    assert!(auth::login_gate_allows(Some(t0), t0 + Duration::from_secs(60), min));
}

#[test]
fn login_gate_check_records_start_time_then_blocks() {
    // 第一次必放行（并记录开始时刻）。
    auth::login_gate_check().expect("首次登录链应放行");
    // 紧接着第二次 → 间隔内，应被节流挡住。
    let err = auth::login_gate_check().expect_err("8 秒内的第二次登录链应被节流");
    let msg = err.to_string();
    assert!(
        msg.contains("登录操作太频繁"),
        "节流提示应明确说明太频繁：{msg}"
    );
    assert!(
        msg.contains("秒后再试"),
        "节流提示应给出可行动的等待时长：{msg}"
    );
}
