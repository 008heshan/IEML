//! Mod 状态判定（对应前端 `src/domain/mods.ts`，ADR-018 / ADR-019）
//!
//! ★ 最重要的一条源码事实：**「已启用」靠文件扩展名判定，不读任何元数据。**
//!   PCL2 的 `LocalResourceLoaders.vb`：
//!       Return {".jar", ".zip", ".litemod"}.Contains(File.Extension.Lower)
//!   禁用 = 文件重命名加 `.disabled` 后缀。
//!
//! ★ 第二条：更新判定靠文件哈希反查在线库，不读本地元数据。
//!   缓存 key 必须带 mtime + size，否则用户替换同名文件后会拿到过期结果。
//!
//! ★ 第三条（ADR-021）：**不做静态兼容性判定**，标"可能不兼容"而不是"不匹配"。

use serde::{Deserialize, Serialize};

/// 被承认的 Mod 扩展名 —— 注意认 .zip（很多 Mod 打包成 zip）
const ENABLED_EXTS: [&str; 3] = [".jar", ".zip", ".litemod"];
/// 禁用后缀：主用 .disabled，兼容遗留的 .old
const DISABLED_SUFFIXES: [&str; 2] = [".disabled", ".old"];

/// 剥掉禁用后缀，得到"假如它启用"时的名字
pub fn strip_disabled_suffix(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    for suffix in DISABLED_SUFFIXES {
        if lower.ends_with(suffix) {
            return file_name[..file_name.len() - suffix.len()].to_string();
        }
    }
    file_name.to_string()
}

/// 判定是否启用：**只看扩展名，不读元数据**
pub fn is_enabled(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    if DISABLED_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return false;
    }
    ENABLED_EXTS.iter().any(|ext| lower.ends_with(ext))
}

pub fn is_mod_file(file_name: &str) -> bool {
    let base = strip_disabled_suffix(file_name);
    let lower = base.to_lowercase();
    ENABLED_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// 生成启用 / 禁用后的文件名
pub fn toggled_name(file_name: &str, enable: bool) -> String {
    let base = strip_disabled_suffix(file_name);
    if enable {
        base
    } else {
        format!("{base}.disabled")
    }
}

/// 显示名：剥掉扩展名与禁用后缀
pub fn display_name_of(file_name: &str) -> String {
    let base = strip_disabled_suffix(file_name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[..i].to_string(),
        _ => base,
    }
}

/// ★★ 这个文件名**提供的是哪个 API 前置包**？（`None` = 它不是 API 前置包）
///
/// 返回值就是内部的 kind 名：`"fabric-api"` / `"quilted-fabric-api"`。
///
/// ## 为什么要抽成一处（C-6 修复，2026-09-24）
///
/// 同一件事原来有**两套判据**，而且在同一件事上给出不同答案：
///
/// | 位置 | 名单 | 匹配方式 |
/// |---|---|---|
/// | `commands_real.rs::check_api_library` | `qfapi` / `quilted-fabric-api` / `qsl` · `fabric-api` / `fabric_api` | `contains` |
/// | `modrinth.rs::MrpackIndex::has_fabric_api` | 上面四个的**并集** | `starts_with` |
///
/// 真机后果（`probe-bug-repro-9.mjs`）：Quilt 实例的 `mods/` 里放着
/// `fabric-api-0.92.2+1.20.1.jar`，Mod 管理页报「**缺 Quilted Fabric API**」+
/// 一键补装 —— 而 `modrinth.rs` 那边认为这就算"有 API"。
/// 两套判据打架时，用户被引导去装**第二个 API 实现**，
/// 而 `modrinth.rs` 的注释里恰好警告过这件事（"同一个实例里出现两个 API 实现"）。
///
/// ## 判据（都来自实测的真实发行文件名）
///
/// * Fabric API → `fabric-api-0.92.12+1.20.1.jar`、`fabric_api-…`
/// * Quilt 的   → `qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar`
///   —— 注意它**不叫** `quilted-fabric-api`（那是旧发布名），
///   只认后者的实现会被**误判成"没装"**。
///
/// ★ 只判"这个文件名属于哪一类"，**不判"该不该装"** ——
///   `api_for_base` 管后者（Quilt 不自动装，见那边的说明）。
pub fn api_library_from_filename(file_name: &str) -> Option<&'static str> {
    let n = file_name.to_ascii_lowercase();
    /*
     * 前缀之后必须紧跟 `-`（带版本号，实测全是这样）或 `.`（`fabric-api.jar` 这种没写版本的）
     * —— 用 `strip_prefix` 判，不分配字符串。
     */
    let hit = |p: &str| match n.strip_prefix(p) {
        Some(rest) => rest.starts_with('-') || rest.starts_with('.'),
        None => false,
    };
    const QUILT: [&str; 3] = ["qfapi", "quilted-fabric-api", "qsl"];
    const FABRIC: [&str; 2] = ["fabric-api", "fabric_api"];
    if QUILT.iter().any(|p| hit(p)) {
        return Some("quilted-fabric-api");
    }
    if FABRIC.iter().any(|p| hit(p)) {
        return Some("fabric-api");
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModFile {
    pub file_name: String,
    pub path: String,
    pub bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModEntry {
    pub display_name: String,
    pub file_name: String,
    pub path: String,
    pub enabled: bool,
    pub bytes: u64,
    pub mtime_ms: u64,
}

/// 扫描 Mod 目录生成条目列表。
/// ★ 默认**不递归子目录**；唯一例外是 Forge 且 MC < 1.13 且目录名恰为版本号
///   （如 mods/1.12.2/）—— 这是 PCL2 的行为，直接抄。
pub fn scan_mods(files: &[ModFile], loader_kind: Option<&str>, mc_version: &str) -> Vec<ModEntry> {
    let for_version_dir = should_scan_version_dir(loader_kind, mc_version);
    let mut out = Vec::new();

    for f in files {
        let rel = f.file_name.replace('\\', "/");
        let (base, in_matching_dir) = match rel.find('/') {
            Some(i) => {
                let dir = &rel[..i];
                (rel[i + 1..].to_string(), for_version_dir && dir == mc_version)
            }
            None => (rel.clone(), true),
        };
        if !in_matching_dir {
            continue;
        }
        if !is_mod_file(&base) {
            continue;
        }
        out.push(ModEntry {
            display_name: display_name_of(&base),
            file_name: base.clone(),
            path: f.path.clone(),
            enabled: is_enabled(&base),
            bytes: f.bytes,
            mtime_ms: f.mtime_ms,
        });
    }

    // 固定按文件名排序 —— PCL2 完全没有排序功能，我们也不做（ADR-019）
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    out
}

fn should_scan_version_dir(loader_kind: Option<&str>, mc_version: &str) -> bool {
    let is_forge_like = matches!(loader_kind, Some("forge") | Some("neoforge"));
    if !is_forge_like {
        return false;
    }
    let segs: Vec<u32> = mc_version.split('.').filter_map(|s| s.parse().ok()).collect();
    let major = segs.first().copied().unwrap_or(0);
    let minor = segs.get(1).copied().unwrap_or(0);
    major == 1 && minor < 13
}

/// 哈希缓存 key：必须带 mtime + size，否则用户替换同名文件后会拿到过期结果
pub fn hash_cache_key(file_name: &str, mtime_ms: u64, bytes: u64) -> String {
    format!("{file_name}-{mtime_ms}-{bytes}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_is_decided_by_extension_only() {
        assert!(is_enabled("sodium.jar"));
        assert!(is_enabled("pack.zip"));
        assert!(is_enabled("old.litemod"));
        assert!(!is_enabled("sodium.jar.disabled"));
        assert!(!is_enabled("mod.jar.old"));
        assert!(!is_enabled("notes.txt"));
    }

    #[test]
    fn toggle_roundtrip() {
        assert_eq!(toggled_name("sodium.jar", false), "sodium.jar.disabled");
        assert_eq!(toggled_name("sodium.jar.disabled", true), "sodium.jar");
        assert_eq!(toggled_name("mod.jar.old", true), "mod.jar");
    }

    #[test]
    fn display_name_strips_both() {
        assert_eq!(display_name_of("sodium.jar.disabled"), "sodium");
        assert_eq!(display_name_of("JEI 物品管理器.jar"), "JEI 物品管理器");
    }

    #[test]
    fn scan_does_not_recurse_by_default() {
        let files = vec![
            ModFile {
                file_name: "a.jar".into(),
                path: "/mods/a.jar".into(),
                bytes: 1,
                mtime_ms: 1,
            },
            ModFile {
                file_name: "sub/b.jar".into(),
                path: "/mods/sub/b.jar".into(),
                bytes: 1,
                mtime_ms: 1,
            },
        ];
        let out = scan_mods(&files, Some("fabric"), "1.20.1");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn scan_allows_version_dir_only_for_legacy_forge() {
        let files = vec![
            ModFile {
                file_name: "1.12.2/a.jar".into(),
                path: "/mods/1.12.2/a.jar".into(),
                bytes: 1,
                mtime_ms: 1,
            },
            ModFile {
                file_name: "other/a.jar".into(),
                path: "/mods/other/a.jar".into(),
                bytes: 1,
                mtime_ms: 1,
            },
        ];
        let out = scan_mods(&files, Some("forge"), "1.12.2");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].file_name, "a.jar");
    }

    #[test]
    fn hash_key_changes_when_file_replaced() {
        let a = hash_cache_key("a.jar", 100, 10);
        let b = hash_cache_key("a.jar", 200, 10);
        assert_ne!(a, b);
    }

    /* ============ ★★ C-6：API 前置包的文件名判据（只有这一处） ============ */

    /// 实测的真实发行文件名，逐个钉住（见函数的文档注释）。
    #[test]
    fn api_library_filenames_are_recognised() {
        // Fabric API（官方发布名 + 下划线变体）
        assert_eq!(
            api_library_from_filename("fabric-api-0.92.12+1.20.1.jar"),
            Some("fabric-api")
        );
        assert_eq!(
            api_library_from_filename("fabric_api-0.92.12+1.20.1.jar"),
            Some("fabric-api")
        );
        // Quilt 的真实发布名：qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar
        assert_eq!(
            api_library_from_filename("qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar"),
            Some("quilted-fabric-api")
        );
        // 旧发布名与单独发布的 QSL
        assert_eq!(
            api_library_from_filename("Quilted-Fabric-API-7.4.0.jar"),
            Some("quilted-fabric-api"),
            "大小写不敏感"
        );
        assert_eq!(
            api_library_from_filename("qsl-6.3.0.jar"),
            Some("quilted-fabric-api")
        );
        // 不相关的东西不许被认成 API 前置包
        for other in [
            "sodium-fabric-0.5.8.jar",
            "fabric-api-extra-1.0.jar", // ★ 前缀匹配的已知误差（见下）
            "my-fabric-api-fork.jar",
            "fabric-language-kotlin-1.10.jar",
        ] {
            let got = api_library_from_filename(other);
            if other == "fabric-api-extra-1.0.jar" {
                // ★ 诚实记一笔：`fabric-api-extra-…` **会**被认成 fabric-api
                //   （前缀就是 `fabric-api-`）。这是"文件名判据"的固有误差，
                //   两个旧实现同样如此；宁可多认（少一次误报"缺前置"）也不漏认。
                assert_eq!(got, Some("fabric-api"), "前缀匹配的已知误差");
            } else {
                assert_eq!(got, None, "{other} 不该被当成 API 前置包");
            }
        }
    }

    /// 禁用状态（`.disabled`）不影响识别 —— 判据是文件名，不是扩展名
    #[test]
    fn api_library_filename_ignores_disabled_suffix() {
        assert_eq!(
            api_library_from_filename("fabric-api-0.92.2.jar.disabled"),
            Some("fabric-api")
        );
    }
}
