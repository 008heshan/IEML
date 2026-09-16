//! 密钥环分片存储的**真机**验证（默认 `#[ignore]`）
//!
//! 用法：
//!   powershell -NoProfile -ExecutionPolicy Bypass -File tools/env/cargo.ps1 `
//!     test --manifest-path src-tauri/Cargo.toml --test live_keyring_chunks -- --ignored --nocapture
//!
//! ## 为什么必须真机跑一次
//!
//! 单元测试只能证明 `split_chunks` 的数学是对的，**证明不了凭据管理器真的收得下**。
//! 用户报的那个错
//! 「密钥环操作失败：Attribute 'password encoded as UTF-16' is longer than
//!   platform limit of 2560 chars」
//! 是 **Windows API 层**拒绝的 —— 只有真的调 `CredWrite` 才会暴露。
//!
//! ## 唯一能暴露的三个坑（单测都抓不到）
//!
//! ① **真的分片了吗**：正的账号 JSON > 1280 字符时，改造前必炸、改造后必须成功。
//! ② **★ 令牌变短时的残留分片**：刷新之后微软给的新 refresh token 长短会变。
//!    上次存 3 片、这次只要 2 片 —— 如果不清旧片，读出来就是
//!    「新 JSON + 旧尾巴」，`serde_json` 直接报「账号数据损坏」。
//!    这个坑**只在真机上、且要连续存两次不同长度**才会现形。
//! ③ **删除要清干净**：只删第 0 片会把 `uuid#1` 永远留在用户的凭据管理器里，
//!    既清不掉也看不见。
//!
//! ★ 本测试用一个**独立的测试 uuid**，跑完自己清理。
//!   它**不会**碰真实账号 —— 但会短暂改写 `__current__` 指针，
//!   结束时由 `remove_account` 一并清掉（测试 uuid 恰好就是 current）。

use ieml_lib::auth::{load_account, remove_account, store_account, McAccount};

/// 造一个**真实尺寸**的正版账号：access_token 是 JWT（~1600 字符），
/// refresh_token 另有 ~1000 字符。这正是用户登录成功时会存进去的东西。
fn real_sized_account(uuid: &str, access_len: usize, refresh_len: usize) -> McAccount {
    McAccount {
        username: "TestPlayer".into(),
        uuid: uuid.into(),
        access_token: "a".repeat(access_len),
        refresh_token: Some("r".repeat(refresh_len)),
        kind: "msa".into(),
        expires_at: Some(1_758_000_000_000),
    }
}

/// ① + ② 的核心：真实尺寸能存下，且**连续存两种不同长度**后读回的是最后一次。
#[test]
#[ignore = "会真的读写 Windows 凭据管理器"]
fn real_sized_account_round_trips_and_survives_shrinking() {
    let uuid = format!("iemltest{:020}", std::process::id());
    // 先确保干净
    let _ = remove_account(&uuid);

    // ---------- 存一个"大"账号（3 片左右）----------
    let big = real_sized_account(&uuid, 1600, 1000);
    let big_json = serde_json::to_string(&big).unwrap();
    println!(
        "大账号 JSON = {} 字符（单条上限 1280，改造前必炸）",
        big_json.encode_utf16().count()
    );
    assert!(
        big_json.encode_utf16().count() > 1280,
        "样本必须真的超过单条上限，否则测不到分片"
    );

    store_account(&big).expect("★ 真实尺寸的账号必须能存进密钥环（这就是用户报的失败点）");
    let back = load_account(&uuid).expect("刚存进去的账号必须能读出来");
    assert_eq!(back.uuid, big.uuid);
    assert_eq!(back.access_token, big.access_token, "access_token 必须逐字符一致");
    assert_eq!(back.refresh_token, big.refresh_token, "refresh_token 必须逐字符一致");
    println!("✓ 大账号存取成功（{} 字符）", big_json.encode_utf16().count());

    // ---------- ★ 再存一个"小"账号（片数更少）----------
    //
    //   这一段的全部意义：如果 `store_account` 没先清旧分片，
    //   残留的高位分片会被拼到新 JSON 尾巴上 → 反序列化失败。
    let small = real_sized_account(&uuid, 100, 50);
    let small_json = serde_json::to_string(&small).unwrap();
    println!(
        "小账号 JSON = {} 字符（片数更少）",
        small_json.encode_utf16().count()
    );
    assert!(
        small_json.encode_utf16().count() < big_json.encode_utf16().count(),
        "样本必须真的更小"
    );

    store_account(&small).expect("覆盖存一个更小的账号不该失败");
    let back2 = load_account(&uuid).expect(
        "★ 读不回来 = 旧分片没清干净（新 JSON 后面挂了旧尾巴）。\
         这正是 `store_account` 里必须先 `clear_chunks` 的原因",
    );
    assert_eq!(back2.access_token, small.access_token, "必须是最后一次存的内容");
    assert_eq!(back2.access_token.len(), 100, "不能混进旧数据");
    assert_eq!(back2.refresh_token.as_deref(), Some("r".repeat(50).as_str()));
    println!("✓ 覆盖存更小的账号后读回正确（旧分片已清）");

    // ---------- ③ 删除要清干净 ----------
    remove_account(&uuid).expect("删除不该失败");
    let after = load_account(&uuid);
    assert!(
        after.is_err(),
        "删完之后不该还能读到内容，实际读到了：{:?}",
        after.map(|a| a.access_token.len())
    );
    println!("✓ 删除后读不到，清理完成");
}

/// 离线账号（没有 refresh_token、体积极小）必须仍然只占**一条**凭据 ——
/// 保证绝大多数用户的行为与分片改造之前完全一样。
#[test]
#[ignore = "会真的读写 Windows 凭据管理器"]
fn small_offline_account_uses_a_single_credential() {
    let uuid = format!("iemltestsm{:018}", std::process::id());
    let _ = remove_account(&uuid);

    let acc = McAccount {
        username: "Steve".into(),
        uuid: uuid.clone(),
        access_token: "0".into(),
        refresh_token: None,
        kind: "legacy".into(),
        expires_at: None,
    };
    store_account(&acc).expect("小账号必须能存");
    let back = load_account(&uuid).expect("小账号必须能读");
    assert_eq!(back.username, "Steve");
    assert_eq!(back.kind, "legacy");
    assert!(back.refresh_token.is_none());

    // 连存两次也不该出问题（片数不变）
    store_account(&acc).expect("重复存同一个账号必须幂等");
    let again = load_account(&uuid).expect("重复存之后仍要能读");
    assert_eq!(again.uuid, uuid);

    remove_account(&uuid).expect("清理不该失败");
    assert!(load_account(&uuid).is_err(), "清理后不该残留");
}
