//! MC 新闻（游戏版本动态）—— 把网站那份数据同步进**数据目录**，再读回来给界面。
//!
//! ## 为什么是"下载到数据目录"（用户 2026-10-15）
//!
//!   这份数据原来是**构建时抓进仓库、打进安装包**的（`tools/build-mc-news.mjs`
//!   + `src/data/mc-news/`）。网站加了「版本大图」之后，用户给了新口径：
//!
//!   > 网站更新了版本大图功能，启动器同步一下
//!   > 其实这些东西应该保存在启动器的数据文件夹里的
//!
//!   于是它不再进安装包，而是像游戏文件 / Mod 一样**下载到玩家自己的数据目录**：
//!
//!   ```text
//!   <数据目录>/news/
//!   ├─ index.json            站点那份清单（原样存下）
//!   ├─ versions/<版本>.json  中文正文
//!   ├─ img/<版本>.jpg        版本大图
//!   └─ synced.json           上一次同步的时刻 + 大图的文件名
//!   ```
//!
//!   `<数据目录>` 就是「设置 → 存储」里显示、并且能一键打开的那一个
//!   （`AppPaths::root`，与 `.minecraft` 同级）—— 用户能自己看见、也能自己删。
//!
//! ## 这一层**不改数据的形状**（原样存、原样读回）
//!
//!   解析与校验只有一份实现：前端的 `src/domain/mc-news.ts`
//!   （它能进 `node --test`，改判据时有单测钉着）。Rust 这一层只做
//!   **下载 / 落盘 / 读回来** —— 与 `fetch_version_manifest` 的分工一模一样。
//!   ★ 这不是洁癖：这个仓库为"同一个判据写两遍、有一处忘了改"栽过两次
//!     （见 `docs/ARCHITECTURE.md` 里那几条加注）。
//!
//! ## 半份数据不算数据
//!
//!   清单 / 正文 / 大图**全部抓进内存之后才落盘**，而且 `index.json` **最后**写 ——
//!   中途断网时目录里要么是上一次完整的那份、要么是新的一份，
//!   不会出现"清单是新的、正文还是旧的"这种只有点开某一版才发现的错位。
//!
//! ## 界面拿到的图是 `data:` URI，不是文件路径
//!
//!   与 Mod 图标同一套做法（`commands_real::mod_icons`）：图**确实存在数据目录里**
//!   （用户要的就是这个），但送给界面时转成 `data:` URI ——
//!   这样不必给 WebView 开一条"能读任意路径"的资产协议口子。

use crate::net;
use crate::platform::AppPaths;
use crate::AppState;
use base64::Engine as _;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::State;

/// 站点地址（用户自己的网站）。换站只改这一行。
///
/// ★ 与 `Cargo.toml` 里那个 API 地址不同，这里是**内容站**：
///   页面与数据都是用户自己烘的，启动器只是把它搬下来。
pub const BASE: &str = "https://hexshane.top/mcnews";

/// 一次同步最多认几个版本（清单里就两个：最新正式版 + 最新快照，留点余量）
const MAX_ENTRIES: usize = 4;

/// 同步结果 / 读回来的缓存（**线格式 camelCase**，与 `domain/types.rs` 的口径一致）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsCache {
    /// 数据目录里那个 news 文件夹（界面把它显示出来，并提供「打开」）
    pub dir: String,
    /// 上一次同步的时刻（毫秒；0 = 没有记录）
    pub synced_at_ms: u64,
    /// 站点那份清单里的烘焙日期（`2026-10-15`）—— 界面据此说"数据旧了"
    pub baked: String,
    /// `index.json` 的原文
    pub manifest: String,
    /// 版本 → 正文原文。**键是清单里的版本号**（不是文件名）—— 前端不必猜文件名
    pub docs: HashMap<String, String>,
    /// 版本 → 大图的 `data:` URI（只含真的读到的那几个）
    pub images: HashMap<String, String>,
}

/* ====================== 纯函数（可单测，不碰网络与磁盘） ====================== */

/// JSON 里取一个字符串（缺失 / 类型不对 / 只有空白 ⇒ 空串）
fn str_of(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// 版本号 → 盘上的文件名（只留 `[A-Za-z0-9._-]`，其余换成 `-`）。
///
/// ★ 版本号将来可能出现别的字符（`26.4-pre/1` 这种），而它是**远端给的字**——
///   直接拼进路径就可能跑到别的目录去。所以这里一律先过一遍。
fn key(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 一个版本的下载计划（清单里能读出来的那几样）
#[derive(Debug, PartialEq)]
struct Plan {
    version: String,
    /// 中文正文在站点上的相对路径（`wiki/26.3.json`）；没有中文条目时为 None
    doc: Option<String>,
    /// 版本大图在站点上的相对路径（`img/26.3.jpg`）；没有图时为 None
    image: Option<String>,
}

/// 从站点清单里读出"要下哪几样"。
///
/// ★ 判据：`wiki.has` 为真才认 `wiki.file`（清单里可能留着文件名而条目还没建好）；
///   `image` 只看 `file`（`url` 是 Mojang 那边的原始地址，我们存的是站点烘好的那份）。
fn plan_from_manifest(v: &serde_json::Value) -> Result<Vec<Plan>, String> {
    let mut out = Vec::new();
    for slot in ["latest", "snapshot"] {
        let Some(entry) = v.get(slot).filter(|x| !x.is_null()) else {
            continue;
        };
        let version = str_of(entry, "version");
        if version.is_empty() {
            continue;
        }
        let doc = entry
            .get("wiki")
            .filter(|w| w.get("has").and_then(|h| h.as_bool()).unwrap_or(false))
            .map(|w| str_of(w, "file"))
            .filter(|f| !f.is_empty());
        let image = entry
            .get("image")
            .map(|i| str_of(i, "file"))
            .filter(|f| !f.is_empty());
        out.push(Plan {
            version,
            doc,
            image,
        });
        if out.len() >= MAX_ENTRIES {
            break;
        }
    }
    if out.is_empty() {
        return Err("清单里一个版本都没读出来 —— 拿到的可能不是那份清单".to_string());
    }
    Ok(out)
}

/// 文件名 → 小写扩展名（没有扩展名时按 `jpg` 算）
fn ext_of(file: &str) -> String {
    file.rsplit_once('.')
        .map(|(_, e)| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5)
        .unwrap_or_else(|| "jpg".to_string())
}

/// 扩展名 → MIME（认不出来的一律按 `image/jpeg`）
fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}

/// 站点上的相对路径 → 完整 URL（清单里给的是 `wiki/26.3.json` 这种）
fn url_for(file: &str) -> String {
    format!("{BASE}/{}", file.trim_start_matches('/'))
}

/// 数据目录里的那个 `news/`
fn dir_of(paths: &AppPaths) -> PathBuf {
    paths.root.join("news")
}

/// 现在（毫秒）—— 与 `net::source::now_ms` 同一个口径，但那个是私有的
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ====================== 落盘与读回 ====================== */

/// 写一个文件（父目录已建好）
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("写不了 {}：{e}", path.display()))
}

/// `synced.json` 的形状（自己给自己看的记账本，不进线格式）
#[derive(Default)]
struct Synced {
    at_ms: u64,
    baked: String,
    /// 版本 → 盘上的图片文件名（读取时据此找文件，不用猜扩展名）
    images: HashMap<String, String>,
}

fn read_synced(dir: &Path) -> Synced {
    let mut s = Synced::default();
    let Ok(text) = std::fs::read_to_string(dir.join("synced.json")) else {
        return s;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return s;
    };
    s.at_ms = v.get("atMs").and_then(|x| x.as_u64()).unwrap_or(0);
    s.baked = str_of(&v, "baked");
    if let Some(map) = v.get("images").and_then(|x| x.as_object()) {
        for (k, val) in map {
            if let Some(name) = val.as_str() {
                s.images.insert(k.clone(), name.to_string());
            }
        }
    }
    s
}

/// 把数据目录里那份读成一份完整的缓存。
///
/// ★ 没同步过 ⇒ `Ok(None)`（界面据此说"还没同步过"，而不是报错）；
///   清单在、但读坏了 ⇒ `Err`（那种情况界面要说"本地那份坏了，重新同步"，
///   静默当成"没有数据"会让用户以为网站空了）。
fn read_cache(dir: &Path) -> Result<Option<NewsCache>, String> {
    let index = dir.join("index.json");
    let manifest = match std::fs::read_to_string(&index) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不到 {}：{e}", index.display())),
    };
    let parsed: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|e| format!("本地那份清单不是合法的 JSON：{e}（重新同步一次）"))?;
    let plan = plan_from_manifest(&parsed)?;
    let synced = read_synced(dir);

    let mut docs = HashMap::new();
    let mut images = HashMap::new();
    for p in &plan {
        if p.doc.is_some() {
            let file = dir.join("versions").join(format!("{}.json", key(&p.version)));
            /* 正文缺失不算错误：界面会说"这一版还没同步到正文"，比整页报错好 */
            if let Ok(text) = std::fs::read_to_string(&file) {
                docs.insert(p.version.clone(), text);
            }
        }
        if let Some(name) = synced.images.get(&p.version) {
            /* ★ 只用文件名，不拼用户/远端给的路径（`synced.json` 也是文件，可能被人改过） */
            let safe = Path::new(name)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if safe.is_empty() {
                continue;
            }
            let file = dir.join("img").join(&safe);
            if let Ok(bytes) = std::fs::read(&file) {
                let ext = ext_of(&safe);
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                images.insert(p.version.clone(), format!("data:{};base64,{b64}", mime_of(&ext)));
            }
        }
    }

    Ok(Some(NewsCache {
        dir: dir.to_string_lossy().to_string(),
        synced_at_ms: synced.at_ms,
        baked: synced.baked,
        manifest,
        docs,
        images,
    }))
}

/* ====================== 命令 ====================== */

/// 读数据目录里那份（**不联网**）。没同步过时返回 `null`。
#[tauri::command]
pub async fn news_load(state: State<'_, AppState>) -> Result<Option<NewsCache>, String> {
    read_cache(&dir_of(&state.paths()))
}

/// 从网站同步到数据目录，并把同步好的那份**读回来**返回。
///
/// 失败时**一个字节都不写**（见文件头"半份数据不算数据"）。
#[tauri::command]
pub async fn news_sync(state: State<'_, AppState>) -> Result<NewsCache, String> {
    sync_into(&dir_of(&state.paths())).await
}

/// 同步的**主体**（命令只是它的薄壳）。
///
/// ★ 抽出来是为了能被真机测试直接调用（`live_*` 那一条）：
///   命令签名里有 `State<AppState>`，测试里造不出来 —— 而"这条链路到底通不通"
///   只有真跑一次才算数（这条规矩在这个仓库里写过很多次了）。
pub async fn sync_into(dir: &Path) -> Result<NewsCache, String> {
    /* ① 抓：清单先来（后面全靠它决定下什么） */
    let manifest = net::get_text(&url_for("latest.json"))
        .await
        .map_err(|e| format!("取不到版本清单：{e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("清单不是合法的 JSON：{e}"))?;
    let plan = plan_from_manifest(&parsed)?;
    let baked = str_of(&parsed, "baked");

    /* ② 抓：正文与大图（全部进内存，一个失败就整体放弃） */
    let mut docs: Vec<(String, String)> = Vec::new();
    let mut images: Vec<(String, String, Vec<u8>)> = Vec::new();
    for p in &plan {
        if let Some(file) = &p.doc {
            let text = net::get_text(&url_for(file))
                .await
                .map_err(|e| format!("取不到 {} 的中文正文：{e}", p.version))?;
            docs.push((p.version.clone(), text));
        }
        if let Some(file) = &p.image {
            let bytes = net::get_bytes(&url_for(file))
                .await
                .map_err(|e| format!("取不到 {} 的版本大图：{e}", p.version))?;
            images.push((p.version.clone(), format!("{}.{}", key(&p.version), ext_of(file)), bytes));
        }
    }

    /* ③ 落盘：正文与大图先写，index.json 最后 */
    let versions_dir = dir.join("versions");
    let img_dir = dir.join("img");
    std::fs::create_dir_all(&versions_dir)
        .map_err(|e| format!("建不了 {}：{e}", versions_dir.display()))?;
    std::fs::create_dir_all(&img_dir).map_err(|e| format!("建不了 {}：{e}", img_dir.display()))?;

    for (version, text) in &docs {
        write_file(
            &versions_dir.join(format!("{}.json", key(version))),
            text.as_bytes(),
        )?;
    }
    let mut image_names = HashMap::new();
    for (version, name, bytes) in &images {
        write_file(&img_dir.join(name), bytes)?;
        image_names.insert(version.clone(), name.clone());
    }
    let synced = serde_json::json!({
        "atMs": now_ms(),
        "baked": baked,
        "images": image_names,
    });
    write_file(&dir.join("synced.json"), synced.to_string().as_bytes())?;
    write_file(&dir.join("index.json"), manifest.as_bytes())?;

    /* ④ 返回**盘上那份**（不是内存里那份）：
     *    这样"界面看到的"与"数据目录里的"永远是同一份 —— 落盘写坏了会当场暴露，
     *    而不是界面好看、目录里是坏的。 */
    read_cache(dir)?.ok_or_else(|| "同步完成，但读不回刚写下的那份".to_string())
}

/* ====================== 判据 ====================== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 站点清单的真实形状（节选：只留下判据用得到的字段）
    fn real_manifest() -> serde_json::Value {
        json!({
            "baked": "2026-10-15",
            "bakedAt": "2026-10-15T10:37:15.010Z",
            "latest": {
                "version": "26.3",
                "type": "release",
                "wiki": { "has": true, "file": "wiki/26.3.json", "revid": 1509437 },
                "image": {
                    "file": "img/26.3.jpg",
                    "url": "https://launchercontent.mojang.com/v2/images/dappledcamp540x540.jpg",
                    "bytes": 86086
                }
            },
            "snapshot": {
                "version": "26.4-snapshot-4",
                "type": "snapshot",
                "wiki": { "has": false, "file": "wiki/26.4-snapshot-4.json" },
                "image": {
                    "file": "img/26.4-snapshot-4.jpg",
                    "url": "https://launchercontent.mojang.com/v2/images/2026101313.44.02540x540.jpg",
                    "bytes": 52920
                }
            }
        })
    }

    #[test]
    fn plan_reads_both_slots_with_doc_and_image() {
        let plan = plan_from_manifest(&real_manifest()).unwrap();
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].version, "26.3");
        assert_eq!(plan[0].doc.as_deref(), Some("wiki/26.3.json"));
        assert_eq!(plan[0].image.as_deref(), Some("img/26.3.jpg"));
        assert_eq!(plan[1].version, "26.4-snapshot-4");
    }

    /// ★ `wiki.has = false` 时**不许**去看那个文件名 ——
    ///   清单里可能留着一个"还没建好的条目"的文件名，照着下必然 404。
    #[test]
    fn doc_is_skipped_when_wiki_has_is_false() {
        let plan = plan_from_manifest(&real_manifest()).unwrap();
        assert_eq!(plan[1].doc, None);
        assert_eq!(plan[1].image.as_deref(), Some("img/26.4-snapshot-4.jpg"));
    }

    #[test]
    fn missing_image_and_missing_wiki_do_not_blow_up() {
        let v = json!({ "latest": { "version": "1.0" } });
        let plan = plan_from_manifest(&v).unwrap();
        assert_eq!(plan[0].doc, None);
        assert_eq!(plan[0].image, None);
    }

    #[test]
    fn nothing_readable_is_an_error_not_an_empty_sync() {
        assert!(plan_from_manifest(&json!({})).is_err());
        assert!(plan_from_manifest(&json!({ "latest": { "version": "  " } })).is_err());
    }

    /// 远端给的版本号会**直接变成文件名**，所以必须过一遍白名单。
    #[test]
    fn version_key_stays_inside_the_folder() {
        assert_eq!(key("26.4-snapshot-4"), "26.4-snapshot-4");
        assert_eq!(key("../../evil"), "..-..-evil");
        assert_eq!(key("26.4 pre/1"), "26.4-pre-1");
        assert!(!key("a/b\\c").contains(['/', '\\']));
    }

    #[test]
    fn ext_and_mime_are_paired() {
        assert_eq!(ext_of("img/26.3.jpg"), "jpg");
        assert_eq!(ext_of("img/x.PNG"), "png");
        assert_eq!(ext_of("img/noext"), "jpg");
        assert_eq!(mime_of("png"), "image/png");
        assert_eq!(mime_of("webp"), "image/webp");
        assert_eq!(mime_of("jpg"), "image/jpeg");
        assert_eq!(mime_of("jpeg"), "image/jpeg");
        assert_eq!(mime_of("somethingelse"), "image/jpeg");
    }

    #[test]
    fn urls_are_joined_without_double_slashes() {
        assert_eq!(url_for("wiki/26.3.json"), format!("{BASE}/wiki/26.3.json"));
        assert_eq!(url_for("/img/26.3.jpg"), format!("{BASE}/img/26.3.jpg"));
    }

    /// 临时目录（每个用例一个，结束时删掉）
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-news-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 没同步过 ⇒ `Ok(None)`，不是错误、也不是一份空缓存
    #[test]
    fn empty_dir_is_none_not_an_error() {
        let d = tmp_dir("empty");
        assert!(read_cache(&d).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 落盘 / 读回一整圈：正文按**版本号**索引，图变成 `data:` URI
    #[test]
    fn cache_round_trips_docs_and_images() {
        let d = tmp_dir("round");
        std::fs::create_dir_all(d.join("versions")).unwrap();
        std::fs::create_dir_all(d.join("img")).unwrap();
        std::fs::write(d.join("index.json"), real_manifest().to_string()).unwrap();
        std::fs::write(d.join("versions").join("26.3.json"), r#"{"version":"26.3"}"#).unwrap();
        /* 一个最小的 JPEG 头就够了 —— 这一层不解图，只看字节有没有原样出来 */
        std::fs::write(d.join("img").join("26.3.jpg"), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
        std::fs::write(
            d.join("synced.json"),
            json!({ "atMs": 1760535000000u64, "baked": "2026-10-15",
                    "images": { "26.3": "26.3.jpg" } })
            .to_string(),
        )
        .unwrap();

        let cache = read_cache(&d).unwrap().unwrap();
        assert_eq!(cache.baked, "2026-10-15");
        assert_eq!(cache.synced_at_ms, 1760535000000);
        assert!(cache.manifest.contains("26.3"));
        assert!(cache.docs.contains_key("26.3"), "正文要按版本号索引");
        assert!(
            !cache.docs.contains_key("26.4-snapshot-4"),
            "没写正文的那一版不该凭空出现"
        );
        let img = cache.images.get("26.3").expect("大图应当读出来");
        assert!(img.starts_with("data:image/jpeg;base64,"), "图要给 data URI：{img}");
        assert!(cache.images.get("26.4-snapshot-4").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// ★ `synced.json` 是**盘上的文件**（可能被人改过），里面的文件名不许带路径
    #[test]
    fn image_name_from_disk_cannot_escape_the_folder() {
        let d = tmp_dir("escape");
        std::fs::create_dir_all(d.join("versions")).unwrap();
        std::fs::create_dir_all(d.join("img")).unwrap();
        std::fs::write(d.join("index.json"), real_manifest().to_string()).unwrap();
        /* 放一个"合法"的图，再让 synced.json 指向一个目录穿越的名字 */
        std::fs::write(d.join("img").join("26.3.jpg"), [0xFF, 0xD8]).unwrap();
        std::fs::write(
            d.join("synced.json"),
            json!({ "atMs": 1u64, "baked": "x",
                    "images": { "26.3": "../../../../Windows/win.ini" } })
            .to_string(),
        )
        .unwrap();
        let cache = read_cache(&d).unwrap().unwrap();
        assert!(
            cache.images.is_empty(),
            "带路径的名字不该被当成图片文件读：{:?}",
            cache.images.keys().collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 清单坏了要说出来（`Err`），不能静默当成"没有数据"
    #[test]
    fn broken_manifest_is_an_error() {
        let d = tmp_dir("broken");
        std::fs::write(d.join("index.json"), "不是 JSON").unwrap();
        assert!(read_cache(&d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 线格式：字段名必须是 camelCase（前端契约见 `src/bridge/types.ts`）
    #[test]
    fn wire_fields_are_camel_case() {
        let cache = NewsCache {
            dir: "D:\\IEML\\news".into(),
            synced_at_ms: 1,
            baked: "2026-10-15".into(),
            manifest: "{}".into(),
            docs: HashMap::new(),
            images: HashMap::new(),
        };
        let text = serde_json::to_string(&cache).unwrap();
        for want in ["\"syncedAtMs\"", "\"manifest\"", "\"docs\"", "\"images\"", "\"dir\"", "\"baked\""] {
            assert!(text.contains(want), "缺字段 {want}：{text}");
        }
        assert!(!text.contains("synced_at_ms"), "snake_case 漏出去了：{text}");
    }

    /// ★★ **真机**：真的去用户的网站同步一次，落到一个临时目录里，再读回来。
    ///
    /// 默认不跑（要联网、也要用户那个站是通的），手动跑：
    ///
    /// ```text
    /// powershell -File tools/env/cargo.ps1 test --manifest-path src-tauri/Cargo.toml \
    ///     --lib news::tests::live_sync -- --ignored --nocapture
    /// ```
    ///
    /// ★ 为什么这条必须有：上面那 12 条判据全是**喂进去的样本**，
    ///   它们证明不了"站点现在真的会回那三样东西"、"大图真的是二进制"、
    ///   "清单里的相对路径拼出来的 URL 真的能取到" —— 这三件事只有真跑一次才知道。
    #[tokio::test]
    #[ignore = "真机：要联网到用户网站"]
    async fn live_sync_writes_a_usable_cache() {
        let dir = std::env::temp_dir().join(format!("ieml-news-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let cache = sync_into(&dir).await.expect("同步失败（站点不通？看上面的原因）");
        println!("目录      : {}", cache.dir);
        println!("烘焙日期  : {}", cache.baked);
        println!("清单      : {} 字节", cache.manifest.len());
        for (v, text) in &cache.docs {
            println!("正文      : {v} → {} 字节", text.len());
        }
        for (v, uri) in &cache.images {
            println!("大图      : {v} → data URI {} 字符", uri.len());
        }

        /* ① 盘上真的有了那三样 */
        assert!(dir.join("index.json").is_file(), "index.json 没落盘");
        assert!(dir.join("synced.json").is_file(), "synced.json 没落盘");
        assert!(cache.synced_at_ms > 0, "同步时刻没记下来");

        /* ② 清单能解析（形状没变） */
        let parsed: serde_json::Value = serde_json::from_str(&cache.manifest).unwrap();
        assert!(parsed.get("latest").is_some(), "清单里没有 latest");

        /* ③ 正文是真 JSON、且真的有「新内容 / 更改」那两节之一 */
        let latest_version = str_of(parsed.get("latest").unwrap(), "version");
        let doc = cache
            .docs
            .get(&latest_version)
            .unwrap_or_else(|| panic!("最新正式版 {latest_version} 的正文没同步下来"));
        let doc_json: serde_json::Value = serde_json::from_str(doc).expect("正文不是合法 JSON");
        let sections = doc_json
            .get("sections")
            .and_then(|s| s.as_array())
            .expect("正文里没有 sections");
        assert!(!sections.is_empty(), "正文一节都没有");

        /* ④ 大图是**图片字节**、而且解码回来的头和它在盘上的一致 */
        let uri = cache
            .images
            .get(&latest_version)
            .unwrap_or_else(|| panic!("最新正式版 {latest_version} 的大图没同步下来"));
        let b64 = uri.split_once("base64,").expect("大图不是 data URI").1;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("大图不是合法 base64");
        assert!(bytes.len() > 5_000, "大图只有 {} 字节，太小了", bytes.len());
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "看起来不是一张 JPEG");

        let _ = std::fs::remove_dir_all(&dir);
        println!("✓ 真机同步一轮通过：三样东西都在，形状与上面那 12 条判据一致");
    }
}
