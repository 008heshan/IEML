//! 正版皮肤链路的**真机**验证（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_account_skin -- --ignored --nocapture
//!
//! ## 为什么必须真机跑
//!
//! 这条链有**三段**，每一段都能独立地坏，而且坏法都是"静默失败"：
//!   ① `sessionserver.mojang.com` 拿 profile  → 不存在的账号回 **204**（不是 404）
//!   ② base64 解出 `textures` → 皮肤 URL      → Mojang 给的是 **`http://`**
//!   ③ 真下那张 64×64 皮肤                     → 可能是 HTML 错误页而不是 PNG
//!
//! 尤其 ②：界面 CSP 的 `img-src` **只允许 `https:`**，原样用 `http://` 会被拦掉 ——
//! 地址看着完全正确，图就是不显示。所以这里**断言协议必须是 https**。
//!
//! ③ 同理：只断言"URL 拿到了"没有意义，得**真的把图下下来验 PNG 魔数** ——
//! 第三方头像站就是这么坑的（`mc-heads.net` 回 403 + 1KB HTML，
//! `<img>` 只是静默失败，界面上什么都不显示）。

use ieml_lib::auth::fetch_skin;

/// 用户本机的真实正版账号（2026-09-17 实测）。
const UUID: &str = "edc5ea662f6048b49d6cb8ab45592839";

#[tokio::test]
#[ignore = "需要联网"]
async fn real_account_skin_resolves_to_a_downloadable_png() {
    let info = fetch_skin(UUID).await.expect("查皮肤失败");

    println!("玩家名 = {}", info.name);
    println!("皮肤   = {:?}", info.skin_url);
    println!("披风   = {:?}", info.cape_url);

    assert_eq!(info.name, "Heshan001", "Mojang 侧的玩家名应当是 Heshan001");

    let skin = info.skin_url.expect("这个账号应当有皮肤（没有则说明解析坏了）");
    assert!(
        skin.starts_with("https://"),
        "★ 皮肤 URL 必须是 https —— 界面 CSP 的 img-src 只允许 https，\
         原样用 http 会被拦掉且**看不出原因**。实际：{skin}"
    );

    // ③ 真的把图下下来，验它确实是 PNG
    let bytes = reqwest::get(&skin)
        .await
        .expect("下载皮肤失败")
        .bytes()
        .await
        .expect("读皮肤字节失败");
    assert!(bytes.len() > 100, "皮肤太小了，多半是错误页：{} 字节", bytes.len());
    assert_eq!(
        &bytes[0..4],
        &[0x89, 0x50, 0x4E, 0x47],
        "★ 前 4 字节不是 PNG 魔数 —— 说明拿回来的是 HTML 之类的错误页，\
         而 <img>/background-image 遇到这种响应是**静默失败**的。实际前 8 字节：{:?}",
        &bytes[0..8.min(bytes.len())]
    );
    println!("皮肤图 = {} 字节，PNG 魔数正确", bytes.len());
}

/// 不存在的 UUID 要给**看得懂**的错误，而不是一句 EOF 解析失败。
#[tokio::test]
#[ignore = "需要联网"]
async fn unknown_uuid_gives_an_actionable_error() {
    let err = fetch_skin("00000000000000000000000000000000")
        .await
        .expect_err("不存在的账号不该成功");
    let msg = format!("{err}");
    println!("错误信息 = {msg}");
    assert!(
        msg.contains("查不到") || msg.contains("HTTP"),
        "错误信息必须能看懂（sessionserver 对不存在的账号回 204，要翻译成人话）：{msg}"
    );
}
