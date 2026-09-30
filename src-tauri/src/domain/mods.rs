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

/* ====================== 哈希缓存（2026-09-30） ====================== */

/// 一个文件的 SHA1 与 CurseForge 指纹。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModHash {
    pub sha1: String,
    pub fingerprint: u32,
}

/// ★★ **Mod 文件的哈希缓存**（用户：「加载、刷新 mod 列表的速度有些慢」）。
///
/// ## 为什么可以放心复用
///
///   SHA1 与指纹都是**文件字节的纯函数**。而 key 是
///   [`hash_cache_key`]（文件名 + mtime + 大小）：
///
///     · 文件被改过 / 被换掉 → mtime 或大小必变 → **算出一个新 key**，
///       旧条目读不到（不会拿到过期哈希）；
///     · 内容一样 → 哈希一样 → 复用完全正确。
///
///   ⇒ 这个缓存**不可能**给出错的答案，最坏情况只是"多留了一条没人再读的记录"。
///     所以不需要 TTL，只需要一个上限（见 [`MOD_HASH_CACHE_MAX`]）。
///
/// ## 它的代价（真机实测）
///
///   2.5 MB 的 Mod 哈希一次约 **100 ms**（debug 构建；release 更快）。
///   一个整合包几十上百个 Mod 就是**每次刷新几秒** —— 而每次都在重算同一个值。
///   缓存命中时这一段是零：只做一次 `read_dir` 比对，**不读文件内容**。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ModHashCache {
    /// `hash_cache_key` → 哈希
    entries: std::collections::HashMap<String, ModHash>,
    /// 这次运行里新增/命中过的条目数（决定要不要回写）
    #[serde(skip)]
    dirty: bool,
}

/// 缓存条目上限。超过就按插入顺序砍掉最早的（`HashMap` 没有顺序，
/// 所以用"整份清空"这种最笨但绝不会出错的策略 —— 见 `trim`）。
pub const MOD_HASH_CACHE_MAX: usize = 4096;

impl ModHashCache {
    /// 从启动器缓存目录读一份。读不到 / 读坏了都当空缓存（**不是错误**：
    /// 缓存丢了最多慢一次，绝不该因此让 Mod 列表读不出来）。
    pub fn new() -> Self {
        let Some(dir) = crate::net::metadata::cache_dir() else {
            return Self::default();
        };
        let path = dir.join("mod-hashes.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn get(&self, key: &str) -> Option<&ModHash> {
        self.entries.get(key)
    }

    pub fn put(&mut self, key: String, value: ModHash) {
        self.entries.insert(key, value);
        self.dirty = true;
        if self.entries.len() > MOD_HASH_CACHE_MAX {
            /*
             * 超上限就**整份丢掉重建**，不做 LRU。
             *
             * ★ 为什么不做精细淘汰：代价不对称 —— 丢了最多下一次重算
             *   （几秒），而一个写错的淘汰逻辑会**悄悄留下过期条目**（那才会给出错的答案）。
             *   4096 条远远够用（一个整合包几百个 Mod），正常永远走不到这里。
             */
            self.entries.clear();
            say!("[IEML/mods] 哈希缓存超过 {MOD_HASH_CACHE_MAX} 条，整份重建（下一次刷新会重算一遍）");
        }
    }

    /// 回写。**只有在缓存目录已配置时才写**（否则会写到一个莫名其妙的地方）。
    pub fn save(&self) {
        if !self.dirty {
            return;
        }
        let Some(dir) = crate::net::metadata::cache_dir() else {
            return;
        };
        let path = dir.join("mod-hashes.json");
        if let Ok(text) = serde_json::to_string(self) {
            if std::fs::create_dir_all(&dir).is_ok() {
                let _ = std::fs::write(&path, text);
            }
        }
    }
}

/* ====================== Mod 图标（从 jar 里解） ====================== */

/// ★★ 2026-09-30（用户）：「**我还要 mod 的图标**」，并选定"**从 jar 里解（本地）**"。
///
/// ## 去哪里找图标（三种加载器的真实位置，实测确认过）
///
/// | 加载器 | 元数据文件 | 图标字段 |
/// |---|---|---|
/// | Fabric / Quilt | `fabric.mod.json` | `icon`（一个路径，实测 `assets/fabric/icon.png`） |
/// | Forge / NeoForge（新） | `META-INF/mods.toml` | `logoFile` |
/// | 老版本 / LiteLoader | `mcmod.info` | `logoFile` |
///
///   ★ 找不到就 `None` —— 界面用**文件名首字母**做占位块（用户选的方案）。
///     **绝不联网取图标**：用户明确要求"不联网读 Mod 列表"，图标同属列表。
///
/// ## 缓存
///
///   与哈希缓存同一套 key（文件名 + mtime + 大小）。图标是 jar 内容的纯函数，
///   所以按 mtime/size 复用不会给出错的答案；而"解一次 jar"的代价
///   （读中央目录 + 解压一张 png）没必要每次进页面都付。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModIconEntry {
    /// `data:image/png;base64,…` 形式，前端直接塞进 `<img src>`。
    /// `None` = 这个 jar 里真的没有图标（**与"还没查过"不同** —— 见下面的说明）。
    pub uri: Option<String>,
}

/// 图标缓存。与 [`ModHashCache`] 同一套纪律（key 含 mtime+size、纯函数可复用）。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ModIconCache {
    entries: std::collections::HashMap<String, ModIconEntry>,
    #[serde(skip)]
    dirty: bool,
}

impl ModIconCache {
    pub fn new() -> Self {
        let Some(dir) = crate::net::metadata::cache_dir() else {
            return Self::default();
        };
        let Ok(text) = std::fs::read_to_string(dir.join("mod-icons.json")) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn get(&self, key: &str) -> Option<&ModIconEntry> {
        self.entries.get(key)
    }

    /// ★ **"确认没有图标"也要缓存**（存 `uri: None`）。
    ///
    ///   否则每次进页面都会把那些没有图标的 jar 重新解一遍 ——
    ///   而"没有图标"恰恰是最常见的（大多数 Mod 不打包图标）。
    pub fn put(&mut self, key: String, value: ModIconEntry) {
        self.entries.insert(key, value);
        self.dirty = true;
        if self.entries.len() > MOD_HASH_CACHE_MAX {
            self.entries.clear();
        }
    }

    pub fn save(&self) {
        if !self.dirty {
            return;
        }
        let Some(dir) = crate::net::metadata::cache_dir() else {
            return;
        };
        if let Ok(text) = serde_json::to_string(self) {
            if std::fs::create_dir_all(&dir).is_ok() {
                let _ = std::fs::write(dir.join("mod-icons.json"), text);
            }
        }
    }
}

/// 从 jar 里**抽一张图标**，返回 `data:` URI。没有图标就 `None`（不是错误）。
///
/// ★ 只解压**一张**图片：先从元数据里拿到路径，再按那个路径找条目 ——
///   不遍历全包（整合包里一个 jar 可能几千个条目）。
/// ★ 大小上限 [`MOD_ICON_MAX_BYTES`]：图标是给人看的小图，
///   万一某个包把一张 10 MB 的截图写进 `logoFile`，不能让它进内存与 IPC。
pub const MOD_ICON_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn read_mod_icon(jar: &std::path::Path) -> Option<String> {
    use base64::Engine as _;
    use std::io::Read;

    let file = std::fs::File::open(jar).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    // ① 找元数据里写的图标路径
    let candidates: Vec<String> = [
        "fabric.mod.json",
        "META-INF/mods.toml",
        "mcmod.info",
        "META-INF/neoforge.mods.toml",
    ]
    .iter()
    .filter_map(|name| {
        let mut entry = archive.by_name(name).ok()?;
        let mut text = String::new();
        entry.read_to_string(&mut text).ok()?;
        icon_path_from_metadata(name, &text)
    })
    .collect();

    // ② 按路径取图；取不到再退到"常见位置"猜一次
    let mut paths = candidates;
    for guess in ["icon.png", "logo.png", "assets/icon.png", "pack.png"] {
        paths.push(guess.to_string());
    }

    for path in paths {
        let wanted = path.trim_start_matches('/').to_string();
        let Ok(mut entry) = archive.by_name(&wanted) else {
            continue;
        };
        if entry.size() == 0 || entry.size() > MOD_ICON_MAX_BYTES {
            continue;
        }
        let mime = mime_of(&wanted)?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if entry.read_to_end(&mut bytes).is_err() || bytes.is_empty() {
            continue;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{mime};base64,{b64}"));
    }
    None
}

/// 从元数据文本里抠出图标路径（三种格式各一个字段名）。
fn icon_path_from_metadata(file_name: &str, text: &str) -> Option<String> {
    // Fabric / Quilt：JSON，字段 `icon`（可能是字符串，也可能是个 map）
    if file_name.ends_with(".json") {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        if let Some(s) = v.get("icon").and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
        if let Some(map) = v.get("icon").and_then(|x| x.as_object()) {
            // 老一些的写法：`{"icon": {"512": "assets/x/icon.png"}}` —— 挑最大的那张
            let mut best: Option<(u64, String)> = None;
            for (k, val) in map {
                let size: u64 = k.parse().unwrap_or(0);
                if let Some(p) = val.as_str() {
                    if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                        best = Some((size, p.to_string()));
                    }
                }
            }
            return best.map(|(_, p)| p);
        }
        // 老式 `mcmod.info` 是数组，里面每项有 `logoFile`
        if let Some(arr) = v.as_array() {
            for item in arr {
                if let Some(p) = item.get("logoFile").and_then(|x| x.as_str()) {
                    if !p.is_empty() {
                        return Some(p.to_string());
                    }
                }
            }
        }
        return None;
    }
    // Forge / NeoForge：TOML，字段 `logoFile = "..."`（不是正经 TOML 解析 ——
    // 只为拿一个字符串，为此引一个 TOML 解析器不值得）
    for key in ["logoFile", "logo_file", "logo"] {
        if let Some(v) = toml_string_value(text, key) {
            return Some(v);
        }
    }
    None
}

/// 在 TOML 文本里找 `key = "值"`（含单引号形式）。找不到返回 `None`。
fn toml_string_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with(key) {
            continue;
        }
        let rest = line[key.len()..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let inner: String = rest[1..].chars().take_while(|c| *c != quote).collect();
        if !inner.is_empty() {
            return Some(inner);
        }
    }
    None
}

/// 按扩展名给 MIME（**只认图片**；别的一律不要，免得把一个 .txt 塞进 `<img>`）。
fn mime_of(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
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
