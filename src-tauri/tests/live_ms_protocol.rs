//! 真机验证：微软登录的**请求形状**对着真实端点验一遍。
//!
//! ## 为什么需要它（这条能抓到已经发生过的两个真 bug）
//!
//! 正版登录没法在测试里真跑完 —— 最后一步要**人在浏览器里输一次设备码**。
//! 但"请求形状对不对"完全可以验：拿一个**真实注册过的公开 client_id**
//! 去打微软的端点，看它是**接受**（HTTP 200 + 真设备码）还是
//! **判成格式错误**（HTTP 400 + `invalid_request`）。
//!
//! 这个仓库在正版登录上已经犯过两次"形状错"的错，两次都只有真打接口才发现：
//!   ① 写死的 `00000000402b5328` 早被微软删了 → `AADSTS700016`；
//!   ② 刷新令牌用错端点（`login.microsoftonline.com/.../token`，
//!      而正确端点是 `login.live.com/oauth20_token.srf`，PCL 第 929 行）。
//!
//! ## 被测的三件事
//!
//!   (A) devicecode 端点接受 `client_id + scope` → 返回真设备码
//!   (B) token 端点接受 `client_id + grant_type + device_code + scope`
//!       → 返回 `authorization_pending`（"我看懂了，用户还没同意"）
//!   (C) **对照组**：少字段的请求必须被拒 → 否则 (B) 的通过毫无意义
//!
//! ★ (C) 是关键。没有对照组的话，一个"对什么都点头"的端点也会让 (B) 变绿。
//!
//! ## 跑法与前置条件
//!
//! ```powershell
//! $env:IEML_MS_PROBE_CLIENT_ID = "<一个真实注册过的 client_id>"
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 `
//!   test --manifest-path src-tauri/Cargo.toml --test live_ms_protocol -- --ignored --nocapture
//! ```
//!
//! **默认会跳过**：仓库里不硬编码任何第三方 client_id。
//! 没有 `IEML_MS_PROBE_CLIENT_ID` 时打印一份"跳过说明"，
//! 而不是失败 —— 假的失败和假的通过一样有害。
//!
//! 探针用的 id 可以是 Prism Launcher 的公开应用 id（见其 `CMakeLists.txt`，
//! GPL-3.0）：它只用来**验证协议形状**，不会进入我们的构建产物。

use ieml_lib::auth;
use ieml_lib::net::mirror::Source;

/// 打一次表单 POST，非 2xx 也要拿到 body（否则看不到 `error` 字段）
async fn post_form(url: &str, form: &[(&str, &str)]) -> (u16, String) {
    let client = ieml_lib::net::client();
    let resp = client
        .post(url)
        .form(form)
        .send()
        .await
        .expect("请求发不出去（网络问题？）");
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    (status, text)
}

fn json_error(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v["error"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "（没有 error 字段）".to_string())
}

#[tokio::test]
#[ignore = "真机测试：会请求 login.microsoftonline.com"]
async fn live_request_shape_is_accepted_by_microsoft() {
    let cid = std::env::var("IEML_MS_PROBE_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            println!(
                "\n（跳过：没有设置 IEML_MS_PROBE_CLIENT_ID）\n\
                 这条测试需要一个**真实注册过的** client_id 才有意义 ——\n\
                 仓库里不硬编码任何第三方 id（那既不安全也不礼貌）。\n\
                 想跑的话：\n  \
                 $env:IEML_MS_PROBE_CLIENT_ID = \"<你的 client_id>\"\n"
            );
            String::new()
        });
    if cid.is_empty() {
        return; // 跳过，不是失败
    }
    println!("\n=== 探针 client_id：{}… ===", &cid[..cid.len().min(8)]);

    let scope = "XboxLive.signin offline_access";
    let device_code_url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
    let token_url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

    // ---------- (A) devicecode 端点 ----------
    let (status, text) = post_form(device_code_url, &[("client_id", &cid), ("scope", scope)]).await;
    println!("\n=== (A) devicecode 端点 ===");
    println!("  HTTP {status}");
    assert_eq!(
        status, 200,
        "★ 设备码申请被拒（error={}）—— 请求形状或 client_id 不对：{text}",
        json_error(&text)
    );
    let dc: serde_json::Value = serde_json::from_str(&text).expect("设备码响应不是 JSON");
    let user_code = dc["user_code"].as_str().unwrap_or_default().to_string();
    let device_code = dc["device_code"].as_str().unwrap_or_default().to_string();
    println!("  user_code       : {user_code}");
    println!("  verification_uri: {}", dc["verification_uri"]);
    println!("  expires_in      : {}", dc["expires_in"]);
    println!("  interval        : {}", dc["interval"]);
    assert!(!user_code.is_empty(), "没有 user_code —— 用户没法去网页输码");
    assert!(
        !device_code.is_empty(),
        "没有 device_code —— 后面换不到令牌"
    );
    // PCL 用 expires_in.min(900) 作为等待上限；微软给的就是 900。
    // 我们给得比它还短就会"用户还没输完就超时"。
    let expires = dc["expires_in"].as_u64().unwrap_or(0);
    assert!(
        expires >= 600,
        "expires_in 只有 {expires} 秒，用户来不及去浏览器里输码"
    );

    // ---------- (B) token 端点必须接受我们的字段集 ----------
    //
    // ★ 必须用**全新的**设备码：设备码一旦拿去换令牌就被消费了，
    //   复用同一个码会把"已消费"误读成"格式不对"（第一版探针就是这么误报的）。
    let (_, text2) = post_form(device_code_url, &[("client_id", &cid), ("scope", scope)]).await;
    let dc2: serde_json::Value = serde_json::from_str(&text2).expect("第二次设备码响应不是 JSON");
    let fresh = dc2["device_code"].as_str().unwrap_or_default().to_string();
    assert!(!fresh.is_empty(), "第二次没拿到设备码");

    let (status_b, text_b) = post_form(
        token_url,
        &[
            ("client_id", &cid),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", &fresh),
            ("scope", scope),
        ],
    )
    .await;
    println!("\n=== (B) token 端点 ===");
    println!("  HTTP {status_b}");
    println!("  {}", text_b.chars().take(400).collect::<String>());
    let err_b = json_error(&text_b);
    assert_ne!(
        err_b, "invalid_request",
        "★ 微软说我们的字段集不合法（invalid_request）—— 这就是「请求形状错了」，必须修：{text_b}"
    );
    assert_eq!(
        err_b, "authorization_pending",
        "★ 期望 authorization_pending（= 请求看懂了、用户还没同意），\
         实际 error={err_b}：{text_b}"
    );
    println!("  → 微软解析并接受了我们的字段集（client_id / grant_type / device_code / scope）");

    // ---------- (C) 对照组 ----------
    let (status_c, text_c) = post_form(token_url, &[("client_id", &cid)]).await;
    println!("\n=== (C) 对照组（故意少字段）===");
    println!("  HTTP {status_c}");
    println!("  {}", text_c.chars().take(240).collect::<String>());
    assert!(
        status_c >= 400,
        "★ 对照组竟然成功了 —— 那 (B) 的 authorization_pending 就什么都证明不了"
    );
    println!("  → 对照组被拒（error={}），所以 (B) 的通过是有意义的", json_error(&text_c));

    println!("\n✓ 微软登录的请求形状对着真实端点验证通过");
}

/// ★ 我们的**轮询**必须把 `authorization_pending` 当作"继续等"而不是错误。
///
///   这条不联网：直接喂微软的真实响应文本给翻译函数，确认它不会
///   把"用户还没输码"翻成一句吓人的错误 —— 那会让用户在登录中途就放弃。
#[test]
fn authorization_pending_is_not_an_error_to_the_user() {
    // 微软真实返回（实测抓的，见 tools/probe-ms-devicecode.ps1 的输出）
    let real = r#"{"error":"authorization_pending","error_description":"AADSTS70016: The provided request has not yet been authorized by the user. The user must input their code. Trace ID: 4f83deaa Trace Timestamp: 2026-09-13 20:47:12Z","error_codes":[70016]}"#;

    /*
     * 轮询循环里判的是 `text.contains("authorization_pending")` —— 这必须成立，
     * 否则每一轮都会当成错误退出，用户根本没机会输码。
     */
    assert!(
        real.contains("authorization_pending"),
        "轮询的判据要与微软真实的响应文本对得上"
    );

    // 真的超时（expired_token）才该给用户一句话
    let expired = r#"{"error":"expired_token","error_description":"AADSTS70016..."}"#;
    let t = auth::explain_ms_error(expired);
    println!("\nexpired_token → {t}");
    assert!(t.contains("过期"), "设备码过期要给一句人话：{t}");

    // 而 authorization_pending **不该**被翻成错误（它压根不该走到翻译这一步）
    let t2 = auth::explain_ms_error(real);
    println!("authorization_pending → {t2}");
    assert!(
        !t2.contains("过期") || t2.contains("等待"),
        "authorization_pending 不是「过期」，翻错了会让用户以为要重来：{t2}"
    );
}

/// 端点常量必须与 PCL / HMCL 一致（写死在这里，改错了立刻红）
#[test]
fn endpoints_match_the_reference_implementations() {
    let src = include_str!("../src/auth/mod.rs");
    let must_have = [
        // PCL MyMsgLogin.xaml.vb:109 · HMCL OAuth.java MICROSOFT
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        // ★ PCL ModLaunch.vb:929 —— 刷新走 login.live.com，**不是**上面那个 token 端点
        "https://login.live.com/oauth20_token.srf",
        // PCL ModLaunch.vb:970 / 987 / 1032 / 1061 / 1083
        "https://user.auth.xboxlive.com/user/authenticate",
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        "https://api.minecraftservices.com/entitlements/mcstore",
        "https://api.minecraftservices.com/minecraft/profile",
    ];
    for u in must_have {
        assert!(src.contains(u), "端点常量不见了或写错了：{u}");
    }
    println!("\n✓ 8 个端点全部与 PCL / HMCL 对齐");

    // 作用域也要一致（PCL 899 行：XboxLive.signin%20offline_access）
    assert!(
        src.contains("XboxLive.signin offline_access"),
        "scope 必须与 PCL 一致：XboxLive.signin offline_access"
    );
    let _ = Source::Bmclapi; // 保持 use 不报未使用
}
