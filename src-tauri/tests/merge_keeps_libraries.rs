//! ★★ 合并 `inheritsFrom` 时**不能丢库** —— 这条 bug 让每个加载器版本都起不来。
//!
//! ## 现场
//!
//!   装完 OptiFine（或任何带 `inheritsFrom` 的版本）后启动，游戏崩在：
//!   ```text
//!   Caused by: java.lang.NoClassDefFoundError: org/lwjgl/BufferUtils
//!   ```
//!   而 `BufferUtils` 是 LWJGL 3 的类，原版 1.16.5 的 json 里明明列着 lwjgl 3.2.2。
//!
//! ## 根因
//!
//!   `merge_versions` 原来按 `lib_key`（**`group:artifact`，不含版本**）去重。
//!   而 1.16.5 的 json 里 lwjgl 出现了**两代**：
//!     · `org.lwjgl:lwjgl:3.2.1` —— rules 只允许 osx（在 Windows 上会被过滤）
//!     · `org.lwjgl:lwjgl:3.2.2` —— rules 允许 windows（真正要用的那个）
//!   合并**不看 rules**，只看键 → 先遇到的 3.2.1 赢、3.2.2 被丢 →
//!   classpath 上是 3.2.1，而它里面没有 `BufferUtils`。
//!
//!   同一个粗键还造成第二个后果：`natives: {}` 与
//!   `natives: {windows:"natives-windows"}` 是**两条**（一条进 classpath、
//!   一条要解压 dll），也被当成重复丢掉 → natives 从 8 个变 0 个。
//!
//!   这两个后果**只在合并时出现**（不合并时两条都留着，`scan_classpath`
//!   按各自 rules 过滤，自然选对）。所以 OptiFine / Forge / Fabric 全都中招。
//!
//! 这条测试用**真实的 1.16.5 版本 JSON**（如果本机有）加合成的用例双重锁住。
use ieml_lib::net::installer::{merge_versions, scan_classpath};
use ieml_lib::net::metadata::{Library, VersionJson};
use ieml_lib::platform;

fn lib(json: &str) -> Library {
    serde_json::from_str(json).unwrap()
}

/// 合成用例：同一个 artifact 的两个版本 + 一个 natives 变体，合并后**都要在**。
#[test]
fn merge_keeps_both_versions_and_natives_variants() {
    let child: VersionJson = serde_json::from_str(
        r#"{
            "id": "child",
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "libraries": [
                {"name": "optifine:OptiFine:1.16.5_HD_U_G8"},
                {"name": "optifine:launchwrapper-of:2.2"}
            ]
        }"#,
    )
    .unwrap();

    let parent: VersionJson = serde_json::from_str(
        r#"{
            "id": "1.16.5",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [
                {"name": "org.lwjgl:lwjgl:3.2.1",
                 "rules": [{"action":"allow","os":{"name":"osx"}}]},
                {"name": "org.lwjgl:lwjgl:3.2.2",
                 "rules": [{"action":"allow","os":{"name":"windows"}}]},
                {"name": "org.lwjgl:lwjgl:3.2.2",
                 "rules": [{"action":"allow","os":{"name":"windows"}}],
                 "natives": {"windows": "natives-windows"},
                 "extract": {"exclude": ["META-INF/"]}}
            ]
        }"#,
    )
    .unwrap();

    let merged = merge_versions(&child, &parent);
    let names: Vec<&str> = merged.libraries.iter().map(|l| l.name.as_str()).collect();
    println!("合并后 {} 条：{names:?}", merged.libraries.len());

    assert!(
        names.contains(&"org.lwjgl:lwjgl:3.2.2"),
        "★★ 父版本的 lwjgl 3.2.2 被丢掉了 —— 这正是 NoClassDefFoundError: \
         org/lwjgl/BufferUtils 的原因。合并后的库：{names:?}"
    );
    assert!(
        names.contains(&"org.lwjgl:lwjgl:3.2.1"),
        "3.2.1 与 3.2.2 是**不同版本**，不是同一个东西，不能互相顶掉"
    );
    // natives 变体必须留下
    let natives_count = merged.libraries.iter().filter(|l| !l.natives.is_empty()).count();
    assert_eq!(
        natives_count, 1,
        "★ natives 变体被当成重复丢掉了（实测会让 natives 从 8 个变 0 个，\
         游戏死在 UnsatisfiedLinkError）"
    );
    // 子版本的两条也要在
    assert!(names.iter().any(|n| n.contains("OptiFine")));
    assert!(names.iter().any(|n| n.contains("launchwrapper-of")));
}

/// 真东西才行：拿本机真实的 1.16.5（或任一完整版本）跑
/// `merge_versions` + `scan_classpath`，要求**natives 不为空**。
#[test]
#[ignore = "真机测试：读本机数据目录里的真实版本 JSON"]
fn real_version_keeps_natives_after_merge() {
    let paths = platform::AppPaths::resolve();
    let versions_dir = paths.shared.join("versions");

    // 找一个有子版本的加载器/附加组件版本（它会走合并）
    let mut checked = 0;
    let entries: Vec<String> = std::fs::read_dir(&versions_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();

    for name in &entries {
        let p = versions_dir.join(name).join(format!("{name}.json"));
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(child) = serde_json::from_str::<VersionJson>(&text) else { continue };
        let Some(parent_id) = child.inherits_from.clone() else { continue };

        let pp = versions_dir.join(&parent_id).join(format!("{parent_id}.json"));
        let Ok(ptext) = std::fs::read_to_string(&pp) else { continue };
        let Ok(parent) = serde_json::from_str::<VersionJson>(&ptext) else { continue };

        let before = scan_classpath(&parent, &paths.shared).natives.len();
        let merged = merge_versions(&child, &parent);
        let scan = scan_classpath(&merged, &paths.shared);

        println!(
            "\n{name}（父 {parent_id}）\n  合并前 natives={before}，合并后 natives={}\n  缺库 {} 个",
            scan.natives.len(),
            scan.missing.len()
        );

        assert!(
            !scan.natives.is_empty(),
            "★★ {name}：合并后 natives 变空了（合并前是 {before}）—— \
             这就是「加载器版本起不来」的根因"
        );
        assert!(
            scan.classpath.iter().any(|p| p.to_string_lossy().contains("lwjgl")),
            "★ {name}：合并后 classpath 里一个 lwjgl 都没有，游戏必然 \
             NoClassDefFoundError"
        );
        checked += 1;
    }

    assert!(checked > 0, "本机没有带 inheritsFrom 的版本可供检查");
    println!("\n✓ 检查了 {checked} 个带父版本的版本，natives 都没丢");
}
