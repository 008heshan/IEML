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
}
