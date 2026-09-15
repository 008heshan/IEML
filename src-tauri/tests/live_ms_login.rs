//! 真机验证：微软正版登录的**每一步**到底能不能走通。
//!
//! ## 为什么必须有一条真机测试
//!
//!   README 里那句「微软设备码登录 ✅ 已实现，未实测」掩盖过一个事实：
//!   **它从来没有被打通过一次**。老代码写死的 client_id
//!   `00000000402b5328` 早就被微软删了，直接打接口会得到：
//!   ```text
//!   400 {"error":"unauthorized_client",
//!         "error_description":"AADSTS700016: Application with identifier
//!         '00000000402b5328' was not found in the directory ..."}
//!   ```
//!   "已实现"和"能用"之间的距离，只有真跑一次能量出来。
//!
//! 这个测试做四件事：
//!   ① 真打微软的 devicecode 端点，确认**没配 client_id 时我们不会去请求**
//!      （而是给一句可行动的说明）；
//!   ② 用一个**已知不存在**的 client_id，确认微软真的拒绝，
//!      并且**我们的翻译**把它变成人话（而不是丢一段英文 JSON 给用户）；
//!   ③ 用环境变量注入一个 client_id，确认它被采纳；
//!   ④ 确认各个错误码的翻译表都在（XSTS 那五个码是用户最容易卡住的）。
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo-novcvars.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_ms_login -- --ignored --nocapture

use ieml_lib::auth;

#[test]
fn client_id_resolution_follows_the_documented_priority() {
    // 清掉可能存在的环境变量干扰
    std::env::remove_var("IEML_MS_CLIENT_ID");

    // ① 什么都没配 → 没有 client_id，且能给出可行动的说明
    auth::set_client_id("");
    assert!(
        auth::client_id().is_none(),
        "没有任何配置时，client_id 应该是 None"
    );
    assert!(
        !auth::ms_login_available(),
        "没有 client_id 时，正版登录应该被判定为「用不了」—— 界面据此如实提示"
    );

    let msg = auth::missing_client_id_message();
    println!("\n=== 没配 client_id 时的提示 ===\n{msg}\n");
    assert!(msg.contains("client_id"), "提示里要说清缺的是什么");
    assert!(msg.contains("IEML_MS_CLIENT_ID"), "要给出环境变量这条办法");
    assert!(msg.contains("离线"), "要给出「用离线模式」这条退路");
    assert!(
        msg.contains("portal.azure.com"),
        "要给出申请入口 —— 只说「缺一个 id」用户不知道去哪拿"
    );

    // ② 运行期注入 > 环境变量
    std::env::set_var("IEML_MS_CLIENT_ID", "from-env");
    assert_eq!(auth::client_id().as_deref(), Some("from-env"));

    auth::set_client_id("from-settings");
    assert_eq!(
        auth::client_id().as_deref(),
        Some("from-settings"),
        "★ 用户在设置页显式填的应该压过环境变量"
    );

    // ③ 设回空 → 退回环境变量
    auth::set_client_id("   ");
    assert_eq!(
        auth::client_id().as_deref(),
        Some("from-env"),
        "清空设置后应该退回环境变量，而不是变成「没有」"
    );

    std::env::remove_var("IEML_MS_CLIENT_ID");
    auth::set_client_id("");
    assert!(auth::client_id().is_none());
}

#[test]
fn error_translation_covers_the_codes_pcl_maps() {
    println!("\n=== 错误翻译表 ===");

    // ① client_id 不对 —— 必须翻成「怎么办」，而不是把英文 JSON 丢给用户
    let raw = r#"{"error":"unauthorized_client","error_description":"AADSTS700016: Application with identifier '00000000402b5328' was not found in the directory '9188040d-...'"}"#;
    let t = auth::explain_ms_error(raw);
    assert!(
        t.contains("AADSTS700016") && t.contains("client_id"),
        "client_id 不对时必须点明这一点：{t}"
    );
    assert!(
        !t.contains("error_description"),
        "不能把微软的原始 JSON 原样丢给用户：{t}"
    );
    println!("  AADSTS700016 → {}", t.lines().next().unwrap_or(""));

    // ② 其余几条（来源：PCL 的逐条映射）
    let cases: [(&str, &str); 6] = [
        ("authorization_declined", "拒绝"),
        ("expired_token", "过期"),
        ("Account security interrupt", "安全"),
        ("service abuse", "封禁"),
        ("AADSTS70000", "重新登录"),
        ("password expired", "重新登录"),
    ];
    for (raw, want) in cases {
        let t = auth::explain_ms_error(raw);
        assert!(t.contains(want), "{raw} 的翻译里应该有「{want}」，实际：{t}");
        println!("  {raw:<32} → {t}");
    }

    // ③ XSTS 的五个码（PCL ModLaunch.vb 991-1016）
    let xsts: [(&str, &str); 5] = [
        ("2148916227", "封禁"),
        ("2148916233", "Xbox"),
        ("2148916235", "国家或地区"),
        ("2148916236", "年龄"),
        ("2148916238", "家庭组"),
    ];
    for (code, want) in xsts {
        let t = auth::explain_xsts_error(code).unwrap_or_else(|| panic!("{code} 应该有翻译"));
        assert!(t.contains(want), "{code} 的翻译里应该有「{want}」，实际：{t}");
        println!("  XSTS {code} → {t}");
    }
    assert!(
        auth::explain_xsts_error("9999999999").is_none(),
        "不认识的码要返回 None（让调用方走兜底），不能瞎猜"
    );
}

/// ★★ 真的去打微软的接口 —— 证明"我们不会在没配 client_id 时白跑一趟"，
///   以及"配了一个不存在的 id 时，我们能把原因翻译成人话"。
#[tokio::test]
#[ignore = "真机测试：会真的请求 login.microsoftonline.com"]
async fn live_device_code_flow_is_diagnosed_honestly() {
    std::env::remove_var("IEML_MS_CLIENT_ID");

    // ① 没配 client_id → 立刻返回可行动的说明，**不发请求**
    auth::set_client_id("");
    let t0 = std::time::Instant::now();
    let r = auth::request_device_code().await;
    let dt = t0.elapsed();
    let e = r.err().expect("没配 client_id 时应该直接报错");
    let msg = e.to_string();
    println!("\n=== ① 没配 client_id ===");
    println!("  耗时 {dt:?}");
    println!("  {}", msg.lines().next().unwrap_or(""));
    assert!(msg.contains("client_id"), "要说清缺什么：{msg}");
    assert!(
        dt.as_millis() < 1500,
        "★ 没配 client_id 时应该**不发请求**就返回（实测耗时 {dt:?}）—— \
         让用户等一轮网络再收到报错是没必要的"
    );

    // ② 配一个**已知不存在**的 id → 微软真的拒绝，我们翻成人话
    auth::set_client_id("00000000-0000-0000-0000-000000000000");
    let r2 = auth::request_device_code().await;
    match r2 {
        Ok(info) => {
            // 极端情况：微软居然接受了（不可能，但不让它静默通过）
            panic!("★ 一个不存在的 client_id 竟然申请到了设备代码？user_code={}", info.user_code);
        }
        Err(e) => {
            let msg = e.to_string();
            println!("\n=== ② 用一个不存在的 client_id ===");
            println!("  {}", msg.lines().next().unwrap_or(""));
            assert!(
                msg.contains("AADSTS700016") || msg.contains("client_id"),
                "★ 必须点明是 client_id 的问题（用户据此才知道去填一个）：{msg}"
            );
            assert!(
                msg.contains("IEML_MS_CLIENT_ID") || msg.contains("设置"),
                "★ 光说「不认识这个 id」不够，要告诉他**去哪填**：{msg}"
            );
        }
    }

    auth::set_client_id("");
    println!("\n✓ 诊断链路的每一步都有人说人话的结论");
}
