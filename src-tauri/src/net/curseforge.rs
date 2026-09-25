//! CurseForge API 客户端（ADR-052）
//!
//! ## 为什么这个文件里的每个常数都带着"实测"两个字
//!
//! CurseForge 的这些东西**猜不得**，而且猜错不会报错 —— 只会**静默少一半结果**
//! （用户以为"没有这个 Mod"）或者"所有 Mod 都查不到更新"：
//!
//! | 事实 | 实测结论（`tools/probe/probe-curseforge*.mjs` 跑出来的） |
//! |---|---|
//! | 每种资源的 `classId` | mod=**6** · resourcepack=**12** · shader=**6552** · datapack=**6945** · modpack=**4471** |
//! | `modLoaderType` 的数字 | forge=**1** · fabric=**4** · quilt=**5** · neoforge=**6**（**liteloader=3 查不出东西**，见 `loader_type`） |
//! | 文件列表顺序 | `/mods/{id}/files` **默认按 `fileDate` 倒序**，`data[0]` 就是最新 |
//! | 指纹端点 | **`POST /v1/fingerprints`** —— `/v1/mods/fingerprints` 是 **404**（文档不好找，只能试） |
//! | 指纹值 | 传**无符号** 32 位整数（`3227395021` 能命中，有符号那次直接连接失败） |
//! | 作者禁止分发 | `allowModDistribution=false` 的项目，其文件 `downloadUrl` 是 **null**（热门 50 个里有 1 个） |
//! | 文件哈希 | `hashes` 里 `algo=1` 是 **SHA1**（可以真的校验），`algo=2` 是 MD5 |
//! | 下载地址 | API 给的 `edge.forgecdn.net` 在**本机时好时坏**（200 / 连接失败 / 404 都见过）；`mediafilez.forgecdn.net` 与 `mod.mcimirror.top/files/…` **两次都通** → 见 `download_candidates` |
//! | API 兜底 | `api.curseforge.com` 本机**间歇性连接超时**（10s）；`mod.mcimirror.top/curseforge/v1/…` 稳定且**不需要 key** |
//!
//! ## key 从哪来
//!
//!   优先级：**设置里填的 > 环境变量 `IEML_CF_API_KEY` > 内置**。
//!   ★ 2026-09-25：**内置那把已清空**（仓库转公开，见 `BUILTIN_API_KEY` 的注释）——
//!   所以现在是"用户自备 key 才能用 CurseForge"，界面上也照实说这件事。
//!
//! ★ 一条纪律：**任何"没配 key"的判断都要基于 `api_key()`**，
//!   不要在别处再写一份"有没有 key"的逻辑（那种两份判据迟早打架）。

use super::mirror;
use super::{api_client, NetError, Result};
use crate::domain::resources::ResourceKind;
use crate::modrinth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/* ====================== key 管理 ====================== */

/// ★★ **内置 key 已于 2026-09-25 清空**（公开化清理，见 `docs/CLEANUP-PLAN-2026-09-25.md`）。
///
/// 历史：ADR-052（dev.13）按"开箱即用"的取舍内置过一把 key —— 用户提供的、
/// **只对他自己的 CurseForge 账号额度生效**。代价当时也如实写进了 ADR-052：
/// 它留在源码树里、随时可被撤销。
///
/// 现在为什么必须清掉：仓库要转公开。那把 key 从**初始提交 `f71c91c`** 起就在
/// git 历史里，而公开后任何人都能 `git log -p` 翻出来 —— 那就是一份真泄露。
/// 处置是两步，缺一不可：① 用户去 `console.curseforge.com` 吊销/轮换它；
/// ② 这个常量清空 + 重写 git 历史。
///
/// ★ 清空之后，CurseForge 相关功能**仍然可用**，只是需要用户自备 key：
/// 优先级链（设置里填的 > 环境变量 `IEML_CF_API_KEY` > 内置）**一个字都没改**，
/// 没有 key 时的提示也是一句可行动的话（见 `require_key`）。
/// ★ 另外 `api.curseforge.com` 在本机本来就**间歇性超时**，而
/// `mod.mcimirror.top/curseforge/v1/…` 稳定且**不需要 key** —— 兜底路径还在。
const BUILTIN_API_KEY: &str = "";

/// 运行期覆盖值（设置页 / 启动参数注入）
static KEY_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// 环境变量名（与内置值同义：优先级低于设置页、高于内置）
pub const KEY_ENV: &str = "IEML_CF_API_KEY";

/// 设一个 key（来自设置页）。空串 = 清掉覆盖值，回到内置/环境变量。
pub fn set_api_key(key: &str) {
    let trimmed = key.trim().to_string();
    if let Ok(mut g) = KEY_OVERRIDE.write() {
        *g = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
}

/// 当前生效的 key（`None` = 一个都没有，那就不该发请求）
pub fn api_key() -> Option<String> {
    if let Ok(g) = KEY_OVERRIDE.read() {
        if let Some(k) = g.as_ref() {
            if !k.trim().is_empty() {
                return Some(k.clone());
            }
        }
    }
    if let Ok(env) = std::env::var(KEY_ENV) {
        if !env.trim().is_empty() {
            return Some(env.trim().to_string());
        }
    }
    let builtin = BUILTIN_API_KEY.trim();
    if builtin.is_empty() {
        None
    } else {
        Some(builtin.to_string())
    }
}

/// 这个 key 是**从哪来的** —— 界面上要如实说（"内置的"与"你自己填的"不是一回事）
pub fn key_source() -> &'static str {
    if let Ok(g) = KEY_OVERRIDE.read() {
        if g.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
            return "settings";
        }
    }
    if std::env::var(KEY_ENV).map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return "env";
    }
    if BUILTIN_API_KEY.trim().is_empty() {
        "none"
    } else {
        "builtin"
    }
}

/// 只给界面看的前缀（**不泄漏完整 key**）
pub fn key_hint() -> Option<String> {
    api_key().map(|k| {
        let head: String = k.chars().take(10).collect();
        format!("{head}…（共 {} 字符）", k.chars().count())
    })
}

/// key 落盘位置：**启动器自己的家**（`own_root`，`%APPDATA%\IEML`）下的独立文件。
///
/// ★★ A-4（2026-09-24）：与 `instances.json` / `prefs.json` 一起搬出**游戏根目录** ——
///   以前它在 `paths.root` 下，用户删掉那个游戏根目录时 key 会跟着没。
///   老位置那份由 `platform::adopt_records` 在启动时收养（只复制、不删源）。
///
/// ★ 为什么不塞进 `prefs.json`：那份文件是**前端**管的（`save_prefs`
///   整份覆盖写回），而这个 key 后端随时要用 —— 放一起会出现
///   "前端用旧值覆盖掉刚写的 key"这种竞态（`ms_client_id.txt` 同理由）。
pub fn api_key_file(paths: &crate::platform::AppPaths) -> PathBuf {
    paths.own_file("cf_api_key.txt")
}

/// 启动时读一次（`lib.rs` 调用）
pub fn load_api_key_from_disk(paths: &crate::platform::AppPaths) {
    // 读：优先 own_root，那儿没有才回退到游戏根目录的老位置（A-4）
    let Some(store) = paths.own_file_for_read("cf_api_key.txt") else {
        return;
    };
    if let Ok(text) = std::fs::read_to_string(store) {
        let first = text.lines().next().unwrap_or("").trim().to_string();
        if !first.is_empty() {
            set_api_key(&first);
            say!(
                "[IEML/curseforge] 已载入你填的 CurseForge API Key（{}…）",
                &first[..first.len().min(6)]
            );
        }
    }
}

/// 保存并立即生效（设置页调用）。空串 = 删掉覆盖值，回到环境变量 / 内置
/// （★ 2026-09-25：内置已清空 ⇒ 两者都没有时就是"没有 key"，那条路走国内镜像）。
pub fn save_api_key(paths: &crate::platform::AppPaths, key: &str) -> Result<()> {
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(api_key_file(paths));
        /* ★ A-4：老位置那份也删 —— 否则下次启动会被 adopt_records 收养回来 */
        let _ = std::fs::remove_file(paths.legacy_record_file("cf_api_key.txt"));
        set_api_key("");
        return Ok(());
    }
    /*
     * 明显不是 key 的形状就**当场说**，别等一次失败的请求。
     *
     * CurseForge 的 key 长这样：`$2a$10$` 开头（bcrypt 风格的散列串）、
     * 长度 60 上下。我们不替 CurseForge 做完整校验（格式可能变），
     * 只挡两个**几乎一定是手滑**的情况：太短、或有空白字符。
     */
    if trimmed.chars().count() < 20 {
        return Err(NetError::Other(format!(
            "这看起来不是 CurseForge 的 API Key（只有 {} 个字符）。\n\
             它应该是一长串（约 60 个字符，通常以 `$2a$10$` 开头）——\n\
             到 console.curseforge.com 的「API Keys」里复制。",
            trimmed.chars().count()
        )));
    }
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err(NetError::Other(
            "这段文本里有空格或换行 —— 多半是把说明文字一起复制进来了。\n\
             只复制 key 本身（一整串、没有空格）。"
                .to_string(),
        ));
    }
    if let Some(p) = api_key_file(paths).parent() {
        std::fs::create_dir_all(p)
            .map_err(|e| NetError::Other(format!("创建数据目录失败：{e}")))?;
    }
    std::fs::write(api_key_file(paths), format!("{trimmed}\n"))
        .map_err(|e| NetError::Other(format!("保存 API Key 失败：{e}")))?;
    set_api_key(&trimmed);
    Ok(())
}

/* ====================== 常量与映射（全部实测） ====================== */

const API: &str = "https://api.curseforge.com/v1";
/// Minecraft 在 CurseForge 上的 gameId
const MC_GAME_ID: u32 = 432;

/// 每种资源对应的 `classId`（实测：见模块头部的表）
pub fn class_id(kind: ResourceKind) -> u32 {
    match kind {
        ResourceKind::Mod => 6,
        ResourceKind::ResourcePack => 12,
        ResourceKind::Shader => 6552,
        ResourceKind::Datapack => 6945,
        /*
         * ★★ 2026-09-23（用户：「PCL 的整合包可以用 curseforge 啊」）：
         *   整合包在 CurseForge 的分类 id 是 **4471**（Modpacks）。
         *   有了它，`classId=4471` 才能查到整合包那一类。
         */
        ResourceKind::Modpack => 4471,
    }
}

/// 加载器 → `modLoaderType` 的数字。
///
/// ★ **LiteLoader 返回 `None`**：实测 `modLoaderType=3` 在 1.12.2 上也是
///   **0 条**（CurseForge 的加载器分类里没有它的实际内容）。
///   返回 `None` 的意思是"**不加这个过滤条件**"，而不是"猜一个数字"——
///   猜错会让结果集为空，而界面只会说"没有结果"。
///
/// ★ 不认识的加载器同样返回 `None`（宁可不筛，也不要筛出一个空的）。
pub fn loader_type(loader: &str) -> Option<u32> {
    match loader.trim().to_ascii_lowercase().as_str() {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// CurseForge 的 `releaseType` → 我们那套版本类型字符串
/// （1=release / 2=beta / 3=alpha，实测的枚举）
pub fn release_type_name(t: u32) -> &'static str {
    match t {
        2 => "beta",
        3 => "alpha",
        _ => "release",
    }
}

/// 从 `gameVersions` 那串混合值里**挑出真正的 MC 版本号**。
///
/// ★ 实测：CF 的 `gameVersions` 长这样 —— `["Client", "1.21.1", "NeoForge"]`：
///   **环境标签（Client/Server）+ MC 版本 + 加载器名**混在一个数组里。
///   直接把它当 MC 版本列表用，界面就会显示"支持 Client 版本"这种东西。
pub fn mc_versions_of(game_versions: &[String]) -> Vec<String> {
    game_versions
        .iter()
        .filter(|s| {
            let t = s.trim();
            // 以数字开头（1.20.1 / 24w45a 都算），且不是已知的加载器/环境名
            t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// 同一串里挑出**加载器名**（小写归一：`NeoForge` → `neoforge`）
pub fn loaders_of(game_versions: &[String]) -> Vec<String> {
    game_versions
        .iter()
        .filter_map(|s| match s.trim().to_ascii_lowercase().as_str() {
            "forge" => Some("forge".to_string()),
            "fabric" => Some("fabric".to_string()),
            "quilt" => Some("quilt".to_string()),
            "neoforge" => Some("neoforge".to_string()),
            _ => None,
        })
        .collect()
}

/* ====================== 请求 ======================
 *
 * ★★ 2026-09-25（公开化清理）——**这一段的形状变了，先读懂再改**：
 *
 *   以前是"官方（带 key）为主，镜像兜底"，而 key 是**内置在源码里**的。
 *   仓库要转公开 ⇒ 内置凭据必须消失（它从初始提交起就在 git 历史里）。
 *   但"**开箱即用**"是用户明确的产品要求（"用户根本就不会填"）——
 *   所以不能简单地把 key 删掉让用户自己想办法。
 *
 *   实测得到的解法（`tools/probe/probe-cf-mirror-keyless.mjs`，5/5 通过）：
 *   `mod.mcimirror.top` 在**不带任何 key** 的前提下就能提供搜索 / 文件列表 /
 *   项目详情 / 分类 / **指纹反查**，返回形状与官方一致。而且 `mirror.rs`
 *   早就把 CurseForge 排成"**国内 mcimirror 首选、官方兜底**"了。
 *
 *   ⇒ 于是默认路径**不需要 key**：
 *     · 用户**没**自备 key → 走镜像（开箱即用，仓库里没有任何凭据）
 *     · 用户**自备**了 key（设置页 / `IEML_CF_API_KEY`）→ 走官方（更稳、更尊重他的配额），
 *       失败再退镜像
 *
 *   ★★ 一个必须记住的**形状差异**（两个方向都实测过，见下面那两条函数注释）：
 *     指纹反查的请求体在两条路上**正好相反**：
 *       · 官方：`{ "fingerprints": [ 123 ] }`（**裸整数**）
 *       · 镜像：`{ "fingerprints": [ { "fingerprint": 123 } ] }`（对象数组）
 *     发错方向两边都是 400。以前镜像兜底时直接复用官方的 body ⇒
 *     **那条兜底等于没有**（必然 400），而没有任何判据能发现。
 */

/// 一次请求走哪条路 —— 与"怎么拼 URL / 要不要带 key"绑定在一起，
/// 免得出现"URL 是镜像的、头里还带着 key"这种自相矛盾的组合。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    /// 默认：国内镜像，**不带 key**（开箱即用的那条路）
    MirrorNoKey,
    /// 用户自备了 key：走官方，带上它
    OfficialWithKey,
    /// 自备了 key 但官方不通：退回镜像（镜像不需要 key）
    MirrorWithKey,
}

impl Route {
    fn is_mirror(self) -> bool {
        matches!(self, Route::MirrorNoKey | Route::MirrorWithKey)
    }
}

impl std::fmt::Display for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Route::MirrorNoKey => "镜像(无需 key)",
            Route::OfficialWithKey => "官方(自备 key)",
            Route::MirrorWithKey => "镜像(官方不通，自备 key 未用上)",
        })
    }
}

/// 主路：有自备 key 走官方，否则走镜像。**内置 key 已清空，所以"没有 key"是常态。**
fn primary_route() -> Route {
    if api_key().is_some() {
        Route::OfficialWithKey
    } else {
        Route::MirrorNoKey
    }
}

/// 兜底路：换另一条（官方 ↔ 镜像）。已经是镜像时**没有兜底**（不来回弹）。
fn fallback_route(current: Route) -> Option<Route> {
    match current {
        Route::OfficialWithKey => Some(Route::MirrorWithKey),
        Route::MirrorNoKey | Route::MirrorWithKey => None,
    }
}

/// 主路失败之后换兜底路 —— 一次网络请求。**这是 GET 与 POST 共用的那一份**（ADR-051：
/// 判据只能有一份；以前 GET 走 `get_text_third_party`、POST 自己手写一遍，于是 POST 那半
/// 就漏掉了"镜像要裸整数"这个形状差异）。
async fn request_with_fallback(
    method: reqwest::Method,
    path_and_query: &str,
    primary_body: Option<&str>,
    fallback_body: Option<&str>,
) -> Result<String> {
    let official = format!("{API}{path_and_query}");
    let mirror = mirror::mcimirror_url(&official);

    let primary = primary_route();
    let primary_url = if primary.is_mirror() {
        mirror.clone().unwrap_or_else(|| official.clone())
    } else {
        official.clone()
    };
    let key = api_key();

    match send_once(method.clone(), &primary_url, primary_body, key.as_deref()).await {
        Ok(t) => Ok(t),
        Err(e) => {
            // ★ 兜底**永远只有镜像这一条**（镜像自己再失败就没有下一步了，不来回弹）。
            //   这里不要 `next` 那个值 —— 有它在只是为了"官方才有兜底"这个判断。
            if fallback_route(primary).is_none() {
                return Err(e);
            }
            let Some(mirror_url) = mirror else {
                return Err(NetError::Other(format!("{e}（没有可用的镜像兜底）")));
            };
            say!("[IEML/curseforge] {primary_url} 失败（{e}），换 {mirror_url} 重试");
            // ★ 换镜像时用 fallback_body —— 指纹那条路两条路的 body 形状不同
            let body = fallback_body.or(primary_body);
            send_once(method, &mirror_url, body, key.as_deref()).await
        }
    }
}

async fn send_once(
    method: reqwest::Method,
    url: &str,
    body: Option<&str>,
    key: Option<&str>,
) -> Result<String> {
    let mut req = api_client().request(method, url);
    if let Some(k) = key {
        req = req.header("x-api-key", k);
    }
    if let Some(b) = body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(b.to_string());
    }
    let resp = req.send().await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(NetError::Status {
            status: status.as_u16(),
            url: url.to_string(),
        });
    }
    Ok(text)
}

/// 不带请求体的取（搜索 / 文件列表 / 详情 / 分类都走它）。
async fn api_text(path_and_query: &str) -> Result<String> {
    request_with_fallback(reqwest::Method::GET, path_and_query, None, None).await
}

async fn api_json<T: serde::de::DeserializeOwned>(path_and_query: &str) -> Result<T> {
    let text = api_text(path_and_query).await?;
    serde_json::from_str(&text).map_err(|e| {
        NetError::Other(format!(
            "解析 CurseForge 响应失败：{e}（多半是接口形状变了，不是你的问题）"
        ))
    })
}

/// POST JSON。**主路与兜底路的请求体可以不同**（指纹那条路就是：
/// 官方要裸整数、镜像要对象数组）—— 这就是 `fallback_body` 存在的理由。
async fn api_post_json<B: serde::Serialize, FB: serde::Serialize, T: serde::de::DeserializeOwned>(
    path: &str,
    body: &B,
    fallback_body: &FB,
) -> Result<T> {
    let payload = serde_json::to_string(body)
        .map_err(|e| NetError::Other(format!("序列化请求失败：{e}")))?;
    let payload_mirror = serde_json::to_string(fallback_body)
        .map_err(|e| NetError::Other(format!("序列化请求失败：{e}")))?;
    let text = request_with_fallback(
        reqwest::Method::POST,
        path,
        Some(&payload),
        Some(&payload_mirror),
    )
    .await?;
    serde_json::from_str(&text)
        .map_err(|e| NetError::Other(format!("解析 CurseForge 响应失败：{e}")))
}

/* ====================== 响应形状（只声明用得到的字段） ====================== */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfFile {
    pub id: u32,
    pub mod_id: u32,
    #[serde(default)]
    pub is_available: bool,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub release_type: u32,
    #[serde(default)]
    pub file_date: String,
    #[serde(default)]
    pub file_length: u64,
    /// ★ 作者禁止第三方分发时这里是 `null`（实测：热门 50 个里有 1 个）
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub hashes: Vec<CfHash>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfHash {
    pub value: String,
    /// 1 = SHA1，2 = MD5（实测）
    pub algo: u32,
}

impl CfFile {
    /// SHA1（`algo=1`）。**有它就能真的校验**，不是"下完就当成功"。
    pub fn sha1(&self) -> String {
        self.hashes
            .iter()
            .find(|h| h.algo == 1)
            .map(|h| h.value.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfMod {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub download_count: u64,
    #[serde(default)]
    pub thumbs_up_count: u64,
    #[serde(default)]
    pub class_id: u32,
    /// `false` = 作者不允许第三方分发（界面要提前说，而不是等安装失败）
    #[serde(default)]
    pub allow_mod_distribution: Option<bool>,
    #[serde(default)]
    pub authors: Vec<CfAuthor>,
    #[serde(default)]
    pub categories: Vec<CfCategory>,
    #[serde(default)]
    pub logo: Option<CfLogo>,
    #[serde(default)]
    pub links: Option<CfLinks>,
    #[serde(default)]
    pub latest_files: Vec<CfFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfAuthor {
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfCategory {
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfLogo {
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfLinks {
    #[serde(default)]
    pub website_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfPagination {
    #[serde(default)]
    pub index: u64,
    #[serde(default)]
    pub page_size: u64,
    #[serde(default)]
    pub result_count: u64,
    #[serde(default)]
    pub total_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(bound(deserialize = "T: serde::Deserialize<'de>"))]
pub struct CfList<T> {
    #[serde(default)]
    pub data: Vec<T>,
    #[serde(default)]
    pub pagination: Option<CfPagination>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfOne<T> {
    pub data: T,
}

/* ====================== 搜索 ====================== */

/// 按资源种类搜索 —— 结果**映射成和 Modrinth 同一形状**，
/// 界面因此不需要为"来源"再写一套渲染（ADR-051：同一件事只实现一次）。
///
/// ## 映射里哪些是"真的"、哪些"上游没有"
///
/// | 字段 | CurseForge 的情况 |
/// |---|---|
/// | `downloads` / `follows` | 真值（`downloadCount` / `thumbsUpCount`） |
/// | `versions` | 取**最新几个文件**支持的 MC 版本（不是整个项目的历史） |
/// | `description` | 真值（`summary`） |
/// | `distribution_allowed` | 真值 —— `false` 时我们**下不了**，界面要提前说 |
/// | `page_url` | 真值（`links.websiteUrl`） |
pub async fn search(
    kind: ResourceKind,
    query: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<modrinth::SearchResponse> {
    /*
     * ★ 查询串在**一个块里**拼完就丢：`form_urlencoded::Serializer` 内部是
     *   `&mut String`，**不是 `Send`** —— 它一旦活到 await 点上，
     *   整个 future 就不是 Send，Tauri 命令直接编译不过（踩过一次）。
     */
    let qs = {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("gameId", &MC_GAME_ID.to_string());
        q.append_pair("classId", &class_id(kind).to_string());
        if !query.trim().is_empty() {
            q.append_pair("searchFilter", query.trim());
        }
        if let Some(v) = mc_version.filter(|s| !s.trim().is_empty()) {
            q.append_pair("gameVersion", v.trim());
        }
        // ★ 只有 Mod 才筛加载器（资源包/光影/数据包与加载器无关）
        if kind.needs_loader_filter() {
            if let Some(t) = loader.and_then(loader_type) {
                q.append_pair("modLoaderType", &t.to_string());
            }
        }
        // 相关度优先、其次按热度（PCL 的默认排序也是"相关度"）
        q.append_pair("sortField", "2"); // 2 = Popularity
        q.append_pair("sortOrder", "desc");
        q.append_pair("pageSize", &limit.clamp(1, 50).to_string());
        q.append_pair("index", &offset.to_string());
        q.finish()
    };

    let list: CfList<CfMod> = api_json(&format!("/mods/search?{qs}")).await?;
    let pagination = list.pagination.unwrap_or(CfPagination {
        index: offset as u64,
        page_size: limit as u64,
        result_count: 0,
        total_count: 0,
    });

    let hits: Vec<modrinth::SearchHit> = list
        .data
        .into_iter()
        .map(|m| {            let versions: Vec<String> = {
                let mut v: Vec<String> = Vec::new();
                for f in &m.latest_files {
                    for gv in mc_versions_of(&f.game_versions) {
                        if !v.contains(&gv) {
                            v.push(gv);
                        }
                    }
                }
                v
            };
            modrinth::SearchHit {
                project_id: m.id.to_string(),
                slug: m.slug.clone(),
                title: m.name.clone(),
                description: m.summary.clone(),
                categories: m.categories.iter().map(|c| c.name.clone()).collect(),
                project_type: kind.key().to_string(),
                downloads: m.download_count,
                follows: m.thumbs_up_count,
                icon_url: m
                    .logo
                    .as_ref()
                    .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
                versions,
                author: m.authors.first().map(|a| a.name.clone()).unwrap_or_default(),
                gallery: Vec::new(),
                distribution_allowed: m.allow_mod_distribution,
                page_url: m
                    .links
                    .as_ref()
                    .and_then(|l| l.website_url.clone())
                    .or_else(|| Some(format!("https://www.curseforge.com/minecraft/{}s/{}", cf_url_segment(kind), m.slug))),
            }
        })
        .collect();

    let at_least = pagination.index + (hits.len() as u64).max(pagination.result_count);
    Ok(modrinth::SearchResponse {
        /*
         * ★★ **`total_count` 在"空查询"时是 0**（实测：不带 `searchFilter`
         *   时接口回 `resultCount: 5, totalCount: 0`）。
         *
         *   直接把它当"命中总数"显示，界面就会在明明有结果时说"共 0 个结果"。
         *   所以取"接口说的总数"与"这一页至少有多少"的较大值 ——
         *   这是**下界**，不是估计值（我们不编数字）。
         */
        total_hits: pagination.total_count.max(at_least),
        hits,
        offset: pagination.index,
        limit: pagination.page_size,
        source: "curseforge".to_string(),
    })
}

/// CurseForge 项目页 URL 里的那一段（`/minecraft/mc-mods/…`）。
///
/// ★ 实测：mods 是 `mc-mods`、资源包是 `texture-packs`、光影是 `shaders`、
///   数据包是 `data-packs`。猜错的结果是一个 404 的"项目页"链接 ——
///   用户点过去只会以为项目没了，所以这几个字符串要和 `links.websiteUrl`
///   交叉验证（有 `websiteUrl` 时优先用它）。
fn cf_url_segment(kind: ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Mod => "mc-mods",
        ResourceKind::ResourcePack => "texture-packs",
        ResourceKind::Shader => "shaders",
        ResourceKind::Datapack => "data-packs",
        /*
         * ★ 2026-09-23：整合包在 curseforge.com 上的网址段是 `/minecraft/modpacks/`
         *   （其它四种分别是 mc-mods / texture-packs / shaders / data-packs）。
         *   这一段只用于拼"去项目页看看"的链接。
         */
        ResourceKind::Modpack => "modpacks",
    }
}

/* ====================== 文件列表 ====================== */

/// 取一个项目的文件，映射成与 Modrinth 相同的 `ProjectVersion` 形状。
///
/// ## 两条实测约束
///
///   ① `/mods/{id}/files` **默认按 `fileDate` 倒序**（`data[0]` 最新），
///      所以界面"取第一个当最新兼容版"是安全的；这里仍然**显式排序**，
///      免得哪天上游改了顺序而没人发现。
///   ② `downloadUrl` 可能是 **null**（作者禁止分发）。这时我们**保留这一条**
///      （用户有权在列表里看到它），但 `url` 是空串 —— 安装那条路会给出
///      **具体原因**，而不是一句"下载失败"。
pub async fn files(
    mod_id: &str,
    kind: ResourceKind,
    mc_version: Option<&str>,
    loader: Option<&str>,
    limit: u32,
) -> Result<Vec<modrinth::ProjectVersion>> {
    // ★ 同上：查询串在块里拼完就丢（`Serializer` 不是 `Send`）
    let qs = {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        if let Some(v) = mc_version.filter(|s| !s.trim().is_empty()) {
            q.append_pair("gameVersion", v.trim());
        }
        if kind.needs_loader_filter() {
            if let Some(t) = loader.and_then(loader_type) {
                q.append_pair("modLoaderType", &t.to_string());
            }
        }
        q.append_pair("pageSize", &limit.clamp(1, 50).to_string());
        q.finish()
    };

    let list: CfList<CfFile> = api_json(&format!("/mods/{mod_id}/files?{qs}")).await?;
    let mut out: Vec<modrinth::ProjectVersion> = list
        .data
        .into_iter()
        .map(|f| {
            let mut hashes = HashMap::new();
            let sha1 = f.sha1();
            if !sha1.is_empty() {
                hashes.insert("sha1".to_string(), sha1);
            }
            modrinth::ProjectVersion {
                id: f.id.to_string(),
                project_id: mod_id.to_string(),
                name: if f.display_name.trim().is_empty() {
                    f.file_name.clone()
                } else {
                    f.display_name.clone()
                },
                // ★ CF 没有独立的"版本号"字段：`displayName` 是作者写的
                //   （如 `AMI 1.8.5 (Forge 1.20.1)`），拿它当版本号展示最诚实。
                version_number: if f.display_name.trim().is_empty() {
                    f.file_name.clone()
                } else {
                    f.display_name.clone()
                },
                game_versions: mc_versions_of(&f.game_versions),
                loaders: loaders_of(&f.game_versions),
                version_type: release_type_name(f.release_type).to_string(),
                // ★ CF 不给"单个文件的下载量" —— 这里**不编数字**，如实留 0
                downloads: 0,
                date_published: f.file_date.clone(),
                files: vec![modrinth::VersionFile {
                    hashes,
                    url: f.download_url.clone().unwrap_or_default(),
                    filename: f.file_name.clone(),
                    size: f.file_length,
                    primary: true,
                }],
                // ★ 依赖要另打一次 `/mods/{id}/files/{fileId}` 才拿得到；
                //   这一轮没做（宁可空着，也不要编一份假的依赖表）
                dependencies: Vec::new(),
            }
        })
        .collect();

    // 显式按发布时间倒序（不依赖上游顺序）
    out.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    Ok(out)
}

/* ====================== 指纹（MurmurHash2） ====================== */

/// CurseForge 的指纹算法：**MurmurHash2（32 位，种子 1）**，
/// 先把 `\t \n \r 空格` **全部剔除**再算。
///
/// ★ 这个实现被**接口自己验证过**：下载真实文件算指纹，
///   `POST /v1/fingerprints` 能把那个文件原样认回来
///   （`tools/probe/probe-curseforge-deep.mjs` 第 ⑤ 节）。
///   逐条向量表在 `tests/curseforge-fingerprint.cases.json`（Rust 侧也读它）。
pub fn fingerprint(bytes: &[u8]) -> u32 {
    const M: u32 = 0x5bd1_e995;
    const R: u32 = 24;

    // ① 先剔除空白（CF 的规定）
    let data: Vec<u8> = bytes
        .iter()
        .copied()
        .filter(|b| !matches!(*b, 9 | 10 | 13 | 32))
        .collect();

    // ② MurmurHash2
    let len = data.len();
    let mut h: u32 = 1u32 ^ (len as u32); // seed = 1（CurseForge 规定）
    let mut i = 0usize;
    while len - i >= 4 {
        let mut k = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
        i += 4;
    }
    match len - i {
        3 => {
            h ^= (data[i + 2] as u32) << 16;
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        2 => {
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        1 => {
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        _ => {}
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h
}

/// 一个文件的指纹。
///
/// ★ 内存：整份读进来（Mod 通常几 MB~几十 MB），超过 [`MAX_FINGERPRINT_BYTES`]
///   就**明确拒绝**而不是硬吃内存 —— 与其 OOM，不如说"这个文件太大，不算指纹"。
pub fn fingerprint_of_file(path: &Path) -> Result<u32> {
    let meta = std::fs::metadata(path)
        .map_err(|e| NetError::Other(format!("读不到 {} 的大小：{e}", path.display())))?;
    if meta.len() > MAX_FINGERPRINT_BYTES {
        return Err(NetError::Other(format!(
            "{} 有 {} MB，超过指纹计算的 {} MB 上限（不硬吃内存）",
            path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            meta.len() / 1024 / 1024,
            MAX_FINGERPRINT_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| NetError::Other(format!("读 {} 失败：{e}", path.display())))?;
    Ok(fingerprint(&bytes))
}

/// 指纹计算的大小上限（512 MB）
pub const MAX_FINGERPRINT_BYTES: u64 = 512 * 1024 * 1024;

/// 一次指纹反查的命中
#[derive(Debug, Clone, Serialize)]
pub struct FingerprintMatch {
    /// 本地文件的指纹（**查询时用的那个数**）
    pub fingerprint: u32,
    pub mod_id: u32,
    pub file_id: u32,
    pub file_name: String,
    /// CurseForge 报的 SHA1（`algo=1`）—— 调用方拿它和本地 SHA1 交叉验证，
    /// 确保"这个指纹确实是我这个文件"（见 `match_fingerprints` 的说明）
    pub sha1: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfFingerprintData {
    #[serde(default)]
    exact_matches: Vec<CfFingerprintHit>,
    /// ★★ 命中的**指纹**列表，与 `exactMatches` **逐位对应**（实测：
    ///    把查不到的指纹夹在中间也不影响对应关系 —— 当初证明它的那个一次性探针
    ///    已经删掉了，因为这条判据现在由
    ///    `tests/live_curseforge.rs::batch_fingerprints_keep_the_position_mapping` 守着）。
    ///
    ///    为什么一定要用它：批量查 N 个 Mod 时我们手里只有指纹、
    ///    没有文件 id —— 没有这个列表就只能**猜**顺序，而猜错的后果是
    ///    "给用户装了一个别的 Mod 的更新"。
    #[serde(default)]
    exact_fingerprints: Vec<u32>,
}

#[derive(Debug, Deserialize)]
struct CfFingerprintHit {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    file: Option<CfFile>,
}

/// 官方要的形状：**裸整数数组** `{ "fingerprints": [123, …] }`。
///
/// ★★ 2026-09-25 实测（带真 key 打官方，见下方的形状测试）：
///   · `{"fingerprints":[123]}` → **HTTP 200** ✓
///   · `{"fingerprints":[{"fingerprint":123}]}` → **HTTP 400**
///     `The JSON value could not be converted to System.UInt32`
///   ⇒ 官方要的是**裸整数**。（这一条以前被注释写反过，害得我以为兜底失败是它引起的。）
#[derive(Debug, Serialize)]
struct CfFingerprintBody<'a> {
    fingerprints: &'a [u32],
}

/// ★ 镜像要的形状：**对象数组** `{ "fingerprints": [ { "fingerprint": 123 } ] }`。
///
/// ★★ 同一次实测：镜像上这两个形状**正好反过来** ——
///   裸整数 → 400 `invalid type: map, expected i64`；对象数组 → **200** ✓。
///   所以"官方不通就换镜像"这条兜底**必须换一份 body**，否则必然 400
///   （这就是 2026-09-25 修掉的那个真缺陷）。
///
/// ★★ 这里**必须显式声明那层包装**：写成 `fingerprints: &[u32]` 序列化出来还是
///   `[123]`（裸整数），与官方那份**一模一样** —— 等于没换 body。
///   第一版就是这么写的，被下面那条形状测试当场抓住。
#[derive(Debug, Serialize)]
struct CfFingerprintBodyForMirror<'a> {
    fingerprints: Vec<CfFingerprintEntry<'a>>,
}

#[derive(Debug, Serialize)]
struct CfFingerprintEntry<'a> {
    fingerprint: &'a u32,
}

impl<'a> CfFingerprintBodyForMirror<'a> {
    /// 把一批指纹包成镜像要的那种形状（每一层都是实测出来的，别省）
    fn new(chunk: &'a [u32]) -> Self {
        Self {
            fingerprints: chunk
                .iter()
                .map(|fp| CfFingerprintEntry { fingerprint: fp })
                .collect(),
        }
    }
}

/// 按指纹批量反查（**这是"Mod 有没有更新"的真实机制**，Modrinth 那边用 SHA1）。
///
/// ## 三条实测出来的规矩
///
///   ① 端点是 **`POST /v1/fingerprints`** —— `/v1/mods/fingerprints` 返回 404；
///   ② 指纹传**无符号** 32 位整数（有符号那次直接连不上）；
///   ③ `exactFingerprints[i]` 对应 `exactMatches[i]`（**逐位对应**，
///      实测把查不到的指纹夹在中间也成立）。
///
/// ## 还有一层保险（不靠"上游永远对"）
///
///   命中结果里带那个文件的 **SHA1**。调用方（`check_mod_updates`）手里
///   也有本地文件的 SHA1 —— **对不上就不采信这条命中**。
///   万一 CurseForge 哪天改了对应关系，我们最多"查不到更新"，
///   绝不会"装错更新"。
pub async fn match_fingerprints(fps: &[u32]) -> Result<HashMap<u32, FingerprintMatch>> {
    if fps.is_empty() {
        return Ok(HashMap::new());
    }
    // 接口一次最多 1000 个；按 100 一批（Mod 数量级够用，也省额度）
    let mut out = HashMap::new();
    for chunk in fps.chunks(100) {
        /*
         * ★★ 两条路的请求体**形状不同**（2026-09-25 实测，两个方向都验过）：
         *   · 官方：`{ "fingerprints": [123, …] }`（裸整数）→ 200
         *   · 镜像：`{ "fingerprints": [ { "fingerprint": 123 } ] }`（对象数组）→ 200
         *   各自发对方的形状都是 400。以前兜底时复用了官方那份 ⇒
         *   **"官方不通就换镜像"这条兜底 100% 失败**，而没有任何判据能发现。
         */
        let body = CfFingerprintBody { fingerprints: chunk };
        let body_bare = CfFingerprintBodyForMirror::new(chunk);
        let resp: CfOne<CfFingerprintData> =
            api_post_json("/fingerprints", &body, &body_bare).await?;
        for (i, hit) in resp.data.exact_matches.into_iter().enumerate() {
            let Some(file) = hit.file else { continue };
            let Some(fp) = resp.data.exact_fingerprints.get(i).copied() else {
                /*
                 * 有命中却没有对应的指纹 → 说明上游的形状变了。
                 * **不猜**：这条丢掉并说出来（总比装错更新强）。
                 */
                say!(
                    "[IEML/curseforge] 指纹反查返回了第 {i} 条命中，但没有对应的 exactFingerprints —— \
                     这条不采信（上游形状可能变了）"
                );
                continue;
            };
            out.insert(
                fp,
                FingerprintMatch {
                    fingerprint: fp,
                    mod_id: hit.id,
                    file_id: file.id,
                    file_name: file.file_name.clone(),
                    sha1: file.sha1(),
                },
            );
        }
    }
    Ok(out)
}

/* ====================== 下载候选 ====================== */

/// 一个文件的**下载候选地址**（实测定序）。
///
/// ## 为什么必须有多个（实测的现场）
///
///   API 给的 `downloadUrl` 主机是 `edge.forgecdn.net`，而在这台机器上
///   它**时好时坏**：同一 URL 一次 200（2.5 MB 全拿到）、一次连接失败、
///   一次 **404**。而同一份内容换两个主机就稳定：
///
/// | 候选 | 实测 |
/// |---|---|
/// | `mediafilez.forgecdn.net/files/<id/1000>/<id%1000>/<name>` | ✅ 206（两次都通） |
/// | `mod.mcimirror.top/files/<id/1000>/<id%1000>/<name>` | ✅ 206（两次都通） |
/// | `media.forgecdn.net/...` | ❌ 403 |
/// | `bmclapi2.bangbang93.com/files/...` | ❌ 404（BMCLAPI 不代理 CF 文件） |
///
///   所以顺序是：**API 原样 → mediafilez → mcimirror**。
///   第一个是上游的本意（别人的网络下它可能最好），后两个是我们**实测能通**的。
pub fn download_candidates(file_id: u32, file_name: &str, api_url: Option<&str>) -> Vec<String> {
    let seg = format!("{}/{}", file_id / 1000, file_id % 1000);
    let encoded: String = file_name
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();

    let mut out: Vec<String> = Vec::new();
    if let Some(u) = api_url.filter(|s| !s.trim().is_empty()) {
        out.push(u.to_string());
    }
    out.push(format!(
        "https://mediafilez.forgecdn.net/files/{seg}/{encoded}"
    ));
    out.push(format!("https://mod.mcimirror.top/files/{seg}/{encoded}"));
    out.dedup();
    out
}

/// **从一个 CurseForge 文件地址推导出同内容的其它候选**（ADR-052）。
///
/// ## 为什么需要"从 URL 推导"而不是"用文件 id 拼"
///
///   安装路径（`install_resource`）手里只有 URL（界面传来的是
///   `ProjectVersion.files[].url`），**没有文件 id**。
///   而 CF 的文件地址里恰好带着 id 的两段路径：
///
/// ```text
/// https://edge.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar
///                                  ^^^^ ^^^ = 8600126 → 8600 / 126
/// ```
///
///   于是换主机名就能得到同内容的另一条路 —— 实测这两个都通：
///     · `mediafilez.forgecdn.net`（另一个官方边缘节点）
///     · `mod.mcimirror.top/files/…`（国内镜像）
///
/// ★ **不是 CF 的地址就返回空**（Modrinth / 自制地址没有这个规律）——
///   宁可没有候选，也不要拼一个必然 404 的地址出来。
pub fn candidates_from_url(url: &str) -> Vec<String> {
    /*
     * ★ 只对**已知的 CurseForge CDN 主机**推导。
     *
     *   曾经写成"只要 URL 里有 `/files/` 就推" —— 那会给任何站点的路径
     *   编出两个 forgecdn 地址（必然 404），把失败信息搅浑。
     *   判据收紧到主机白名单：不是 CF 的地址，一条候选都不给。
     */
    const CF_HOSTS: [&str; 4] = [
        "edge.forgecdn.net",
        "mediafilez.forgecdn.net",
        "media.forgecdn.net",
        "mediafilez.forgecdn.net",
    ];
    let host = url
        .split("://")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap_or("");
    if !CF_HOSTS.contains(&host) {
        return Vec::new();
    }

    let Some(rest) = url.split("/files/").nth(1) else {
        return Vec::new();
    };
    // rest = "8600/126/ami-forge-1.20.1-1.8.5.jar"
    if rest.split('/').count() < 3 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for target in ["https://mediafilez.forgecdn.net", "https://mod.mcimirror.top"] {
        let candidate = format!("{target}/files/{rest}");
        if candidate != url {
            out.push(candidate);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 映射表（实测的数字，改错就红） ---------- */

    #[test]
    fn class_ids_match_the_measured_values() {
        assert_eq!(class_id(ResourceKind::Mod), 6);
        assert_eq!(class_id(ResourceKind::ResourcePack), 12);
        assert_eq!(class_id(ResourceKind::Shader), 6552);
        assert_eq!(class_id(ResourceKind::Datapack), 6945);
    }

    #[test]
    fn loader_types_match_the_measured_values() {
        assert_eq!(loader_type("forge"), Some(1));
        assert_eq!(loader_type("fabric"), Some(4));
        assert_eq!(loader_type("quilt"), Some(5));
        assert_eq!(loader_type("neoforge"), Some(6));
        // ★ LiteLoader 在 CF 上**查不出东西**（modLoaderType=3 → 0 条，实测），
        //   所以这里必须返回 None（= 这个条件不加），而不是猜一个数字
        assert_eq!(loader_type("liteloader"), None);
        assert_eq!(loader_type("不认识"), None);
        assert_eq!(loader_type(""), None);
        // 大小写不敏感
        assert_eq!(loader_type("NeoForge"), Some(6));
    }

    #[test]
    fn release_type_names() {
        assert_eq!(release_type_name(1), "release");
        assert_eq!(release_type_name(2), "beta");
        assert_eq!(release_type_name(3), "alpha");
        assert_eq!(release_type_name(0), "release");
    }

    /// ★ `gameVersions` 是**混合数组**：环境标签 + MC 版本 + 加载器名
    ///   （实测 `["Client", "1.21.1", "NeoForge"]`）。
    ///   直接当 MC 版本用，界面就会显示"支持 Client 版本"。
    #[test]
    fn game_versions_field_is_split_correctly() {
        let raw: Vec<String> = ["Client", "1.20.1", "NeoForge", "Server", "24w45a"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(mc_versions_of(&raw), vec!["1.20.1".to_string(), "24w45a".to_string()]);
        assert_eq!(loaders_of(&raw), vec!["neoforge".to_string()]);

        let fabric: Vec<String> = ["1.21.1", "Fabric"].iter().map(|s| s.to_string()).collect();
        assert_eq!(mc_versions_of(&fabric), vec!["1.21.1".to_string()]);
        assert_eq!(loaders_of(&fabric), vec!["fabric".to_string()]);
    }

    /* ---------- 指纹（向量表两侧共用） ---------- */

    /// 见 `tests/curseforge-fingerprint.cases.json`：
    /// 那份表由 `tools/gen-curseforge-fingerprint-cases.mjs` 生成，
    /// 而它用的算法**被 CurseForge 接口自己验证过**（真文件 → 算指纹 →
    /// `POST /v1/fingerprints` → 原样认回来）。
    #[test]
    fn fingerprint_matches_the_shared_vector_table() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            input_hex: String,
            expect_unsigned: u32,
            expect_hex: String,
        }
        #[derive(serde::Deserialize)]
        struct Table {
            cases: Vec<Case>,
        }

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/curseforge-fingerprint.cases.json"
        );
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("读不到指纹向量表 {path}：{e}"));
        let table: Table = serde_json::from_str(&text).expect("向量表不是合法 JSON");
        assert!(table.cases.len() >= 10, "向量太少：{}", table.cases.len());

        for c in &table.cases {
            let bytes: Vec<u8> = (0..c.input_hex.len() / 2)
                .map(|i| u8::from_str_radix(&c.input_hex[i * 2..i * 2 + 2], 16).expect("hex"))
                .collect();
            let got = fingerprint(&bytes);
            assert_eq!(
                got, c.expect_unsigned,
                "{}：期望 {}（{}），实际 {}（0x{got:08x}）",
                c.name, c.expect_unsigned, c.expect_hex, got
            );
        }
    }

    /// 空白剔除是**这个算法的一半**：`"a\tb"` 与 `"ab"` 必须同指纹。
    /// （CurseForge 官方就是这个规矩；不剔的话所有指纹都对不上，
    ///   而表现只是"所有 Mod 都查不到更新"——静默失败。）
    #[test]
    fn whitespace_is_stripped_before_hashing() {
        assert_eq!(fingerprint(b"a\tb\nc\rd e"), fingerprint(b"abcde"));
        assert_eq!(fingerprint(b" \t\r\n "), fingerprint(b""));
    }

    #[test]
    fn fingerprint_of_a_file_reads_bytes() {
        let dir = std::env::temp_dir().join(format!("ieml-cf-fp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.jar");
        std::fs::write(&p, b"abcde").unwrap();
        assert_eq!(fingerprint_of_file(&p).unwrap(), fingerprint(b"abcde"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---------- 下载候选 ---------- */

    /// ★ 这三个主机名**不是编的**，是实测出来的：
    ///   API 原样（edge.forgecdn.net）在本机 404，另外两个都能取到字节。
    #[test]
    fn download_candidates_are_ordered_and_complete() {
        let c = download_candidates(8600126, "ami-forge-1.20.1-1.8.5.jar", Some("https://edge.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar"));
        assert_eq!(c.len(), 3);
        assert!(c[0].starts_with("https://edge.forgecdn.net/"), "API 原样的排第一：{c:?}");
        assert_eq!(
            c[1],
            "https://mediafilez.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar"
        );
        assert_eq!(
            c[2],
            "https://mod.mcimirror.top/files/8600/126/ami-forge-1.20.1-1.8.5.jar"
        );

        // API 没给 URL（作者禁止分发）时，仍然要有两个**实测能通**的候选
        let c2 = download_candidates(1234567, "x y.jar", None);
        assert_eq!(c2.len(), 2);
        assert_eq!(c2[0], "https://mediafilez.forgecdn.net/files/1234/567/x%20y.jar");
        assert!(c2[1].starts_with("https://mod.mcimirror.top/files/1234/567/"));
    }

    #[test]
    fn cf_page_segments() {
        assert_eq!(cf_url_segment(ResourceKind::Mod), "mc-mods");
        assert_eq!(cf_url_segment(ResourceKind::ResourcePack), "texture-packs");
        assert_eq!(cf_url_segment(ResourceKind::Shader), "shaders");
        assert_eq!(cf_url_segment(ResourceKind::Datapack), "data-packs");
    }

    /// ★ 安装路径手里只有 URL，所以候选必须**能从 URL 推出来**。
    ///   实测这两个主机都能取到字节（`edge.forgecdn.net` 在本机时好时坏）。
    #[test]
    fn candidates_from_a_curseforge_url() {
        let api = "https://edge.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar";
        let c = candidates_from_url(api);
        assert_eq!(
            c,
            vec![
                "https://mediafilez.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar"
                    .to_string(),
                "https://mod.mcimirror.top/files/8600/126/ami-forge-1.20.1-1.8.5.jar".to_string(),
            ]
        );
        // 已经是 mediafilez 的地址 → 不该再推一个一模一样的自己
        let c2 = candidates_from_url(
            "https://mediafilez.forgecdn.net/files/8600/126/ami-forge-1.20.1-1.8.5.jar",
        );
        assert!(!c2.iter().any(|u| u.contains("mediafilez")), "{c2:?}");
        assert!(c2.iter().any(|u| u.contains("mcimirror")), "{c2:?}");

        // ★ 不是 CF 的地址（Modrinth / 随便什么）→ **一条都不给**
        //   （拼一个必然 404 的候选，只会让失败信息更难看）
        assert!(candidates_from_url("https://cdn.modrinth.com/data/x/versions/y/z.jar").is_empty());
        assert!(candidates_from_url("https://example.com/files/1/2/a.jar").is_empty());
        assert!(candidates_from_url("https://edge.forgecdn.net/files/12/x.jar").is_empty());
        assert!(candidates_from_url("").is_empty());
    }

    /* ---------- key 优先级 ---------- */

    #[test]
    fn key_priority_settings_over_env_over_builtin() {
        /*
         * ★ 2026-09-25（公开化清理）：内置值**已清空**，所以这条测试不再假设"一定有 key"。
         *   判据改成"跟着事实走"：内置为空 ⇒ `api_key()` 必须是 `None`（一个都没有就不该发请求）；
         *   内置非空 ⇒ 必须拿得到它。这样以后谁再决定内置一把，这条测试也不会假绿。
         */
        set_api_key("");
        let builtin = BUILTIN_API_KEY.trim();
        match api_key() {
            Some(k) => {
                assert!(!builtin.is_empty(), "没有内置 key 却拿到了一个：{k:.10}");
                assert!(k.starts_with("$2a$10$"), "拿到的不是这把 key：{k:.10}");
            }
            None => {
                assert!(builtin.is_empty(), "内置 key 非空，`api_key()` 不该返回 None");
                assert!(
                    std::env::var(KEY_ENV).map(|v| v.trim().is_empty()).unwrap_or(true),
                    "环境变量里有 key，`api_key()` 不该返回 None"
                );
                assert_eq!(key_source(), "none", "一个 key 都没有时来源必须是 none");
            }
        }

        // 设置页填的**永远优先**（这一条与内置有没有值无关）
        set_api_key("$2a$10$CUSTOMKEYCUSTOMKEYCUSTOMKEYCUSTOMKEYCUSTOMKEYCUSTOMKEY");
        assert_eq!(key_source(), "settings");
        assert!(api_key().unwrap().contains("CUSTOMKEY"));
        // 清掉覆盖 → 回到环境变量 / 内置
        set_api_key("");
        let expect = if std::env::var(KEY_ENV).map(|v| !v.trim().is_empty()).unwrap_or(false) {
            "env"
        } else if BUILTIN_API_KEY.trim().is_empty() {
            "none"
        } else {
            "builtin"
        };
        assert_eq!(key_source(), expect);
    }

    /// ★★ 指纹反查的**请求体形状**是一条实测契约，两条路**正好相反**：
    ///   官方要裸整数（`[123]`），镜像要对象数组（`[{"fingerprint":123}]`）。
    ///   今天两边的 400 报错都抓到了原文（见下面两条断言里的字样）。
    ///
    ///   为什么要测试守着一个 JSON 形状：2026-09-25 之前，兜底时复用的是官方那份
    ///   body ⇒ **"官方不通就换镜像"这条兜底 100% 返回 400**，而它
    ///   **没有任何判据能发现** —— 只有真机打接口才看得见。
    ///   契约写进测试之后，谁重构这里都会当场红。
    #[test]
    fn fingerprint_request_bodies_have_the_two_measured_shapes() {
        let fps: [u32; 2] = [1234567890, 42];

        // 官方：裸整数数组。写成对象数组会被官方拒（实测 400，报错原文见注释）。
        let official = serde_json::to_value(CfFingerprintBody { fingerprints: &fps }).unwrap();
        assert_eq!(official["fingerprints"][0], 1234567890, "官方那份必须是裸整数：{official}");
        assert_eq!(official["fingerprints"][1], 42);
        assert!(
            official["fingerprints"][0].is_number(),
            "官方不接受 {{\"fingerprint\":n}} 这种包装（400：无法转换成 System.UInt32）"
        );

        // 镜像：对象数组。发裸整数会被镜像拒（实测 400：invalid type: map, expected i64）。
        let mirror =
            serde_json::to_value(CfFingerprintBodyForMirror::new(&fps)).unwrap();
        assert_eq!(
            mirror["fingerprints"][0]["fingerprint"], 1234567890,
            "镜像那份必须是对象数组：{mirror}"
        );
        assert_eq!(mirror["fingerprints"][1]["fingerprint"], 42);

        // 两份**必须不同** —— 这是这条兜底能工作的前提
        assert_ne!(official, mirror, "两条路的 body 形状必须不同，否则兜底必 400");
    }

    #[test]
    fn key_hint_does_not_leak_the_whole_key() {
        set_api_key("$2a$10$SECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRET");
        let hint = key_hint().unwrap();
        assert!(hint.contains('…'), "{hint}");
        assert!(!hint.contains("SECRETSECRETSECRET"), "不该把整把 key 打出来：{hint}");
        set_api_key("");
    }

    #[test]
    fn save_api_key_rejects_obvious_mistakes() {
        let paths = crate::platform::AppPaths::resolve();
        // 太短：要说清"该去哪儿拿"，而不是一句"格式错误"
        let e = save_api_key(&paths, "abc").unwrap_err().to_string();
        assert!(e.contains("字符"), "要说清长度不对：{e}");
        assert!(e.contains("console.curseforge.com"), "要给出可行动的下一步：{e}");
        // 带空白（多半把说明文字一起复制了）
        let e2 = save_api_key(
            &paths,
            "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyz",
        )
        .unwrap_err()
        .to_string();
        assert!(e2.contains("空格"), "{e2}");
    }
}
