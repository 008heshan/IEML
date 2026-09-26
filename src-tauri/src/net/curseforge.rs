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
//! ## ★★★★ CurseForge **只走国内镜像，启动器里没有 key 这回事**
//!
//!   用户 2026-09-26 两句话定的调子（第二句是最终态）：
//!     ·「要不然 cf 直接用镜像吧，国内镜像，**不要 key 的**」
//!     ·「**cf 只用镜像，我的那把 key 永远移除启动器**」
//!
//!   ⇒ 所以：
//!     · 所有 CurseForge 请求都走 `mod.mcimirror.top`（实测 5/5 可用、
//!       不需要任何凭据，见 `tools/probe/probe-cf-mirror-keyless.mjs`）；
//!     · **不再有 key 管理** —— 内置常量、环境变量、设置页、落盘文件全部删除
//!       （`api_key()` / `cf_key_status` / `cf_set_api_key` 这些都不存在了）。
//!       看到任何"有 key 就怎样"的旧叙述，一律是**过时的读法**。
//!     · 老版本在 `%APPDATA%\IEML\cf_api_key.txt` 里留下的那份，
//!       由 [`purge_legacy_key_files`] 在启动时删掉（人已经把话说到"永远移除"）。
//!
//!   ★ 代价如实说：镜像挂了 = CurseForge 这一路就等它回来（Modrinth 不受影响），
//!     而且请求经第三方转发。README 的「已知限制」里写着这件事。

use super::mirror;
use super::{api_client, NetError, Result};
use crate::domain::resources::ResourceKind;
use crate::modrinth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/* ====================== 老 key 的清理（没有 key 管理，只有"把它删掉"） ====================== */

/// 启动时把**旧版本留下的 key 文件**从盘上删掉（用户：「我的那把 key 永远移除启动器」）。
///
/// ★ 为什么要主动删而不是"不再读它就行"：文件留在盘上就是一份**长期凭据**，
///   而启动器已经永远不会用它 —— 留着只有风险没有用处。
///   两个位置都清：启动器自己的家（`own_root`）与旧布局的游戏根目录（A-4 之前的位置）。
/// ★ 删不掉（只读 / 被占用）**不拦启动**：这只影响"盘上少一份文件"，
///   不该让用户连启动器都打不开（与 `known-roots.json` 同一条纪律）。
pub fn purge_legacy_key_files(paths: &crate::platform::AppPaths) {
    for p in [
        paths.own_file("cf_api_key.txt"),
        paths.legacy_record_file("cf_api_key.txt"),
    ] {
        if p.is_file() {
            match std::fs::remove_file(&p) {
                Ok(()) => say!("[IEML/curseforge] 已删除旧版本留下的 API Key 文件：{}", p.display()),
                Err(e) => say!(
                    "[IEML/curseforge] 想删掉旧 Key 文件但删不动（{}）：{}（不影响使用）",
                    p.display(),
                    e
                ),
            }
        }
    }
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
 * ## 为什么只剩镜像这一条路（三次演进的终点，别再往回改）
 *
 *   ① 最早：**官方（内置 key）为主、镜像兜底** —— key 内置在源码里（ADR-052
 *      的取舍："拿到 exe 就能用"）。
 *   ② 2026-09-25 公开化清理：仓库要转公开 ⇒ 内置凭据必须消失（它从初始提交
 *      `f71c91c` 起就在 git 历史里）。但"**开箱即用**"是硬要求（用户：
 *      "用户根本就不会填"），所以不能删了 key 让用户自己申请 ⇒
 *      改成"没 key 走镜像、自备 key 走官方"。
 *   ③ ★★★★ 2026-09-26（用户："**cf 只用镜像，我的那把 key 永远移除启动器**"）：
 *      **官方那条路整条删掉，key 管理整块删掉**。
 *
 *   为什么"自备 key 走官方"这段该消失（它一直是问题最多的一段）：
 *     · `api.curseforge.com` 在本机**间歇性连接超时**（实测 10s 量级）；
 *     · 那把 key 出现过"能过鉴权、但读不到 mod 数据"（`categories` 200 /
 *       `mods/search` 403）—— 而"有 key 就先走官方"会**把搜索整条路打死**；
 *     · 为它专门加过两条特例（401/403 也换镜像、换镜像时不带 key），
 *       特例越多越难说清。
 *   而镜像那条路**不需要任何凭据、实测 5/5 可用**
 *   （`tools/probe/probe-cf-mirror-keyless.mjs`）。
 *
 *   ⇒ 现在的形状最简单：**一个地址、不带凭据、没有兜底**。
 *     镜像挂了就如实报错（界面把原因显示出来）—— 这是第三方镜像的代价，
 *     README 的「已知限制」里写着，不假装没有。
 *
 *   ★★ 一个必须记住的**形状差异**（两个方向都实测过，见下面那两条函数注释）：
 *     指纹反查的请求体在两条路上**正好相反**：
 *       · 官方：`{ "fingerprints": [ 123 ] }`（**裸整数**）
 *       · 镜像：`{ "fingerprints": [ { "fingerprint": 123 } ] }`（对象数组）
 *     发错方向两边都是 400。现在只走镜像 ⇒ **用对象数组那一份**；
 *     官方那份形状保留在类型与测试里（万一以后要加回官方，别又从 400 开始查）。
 */

/*
 * ★ 镜像**挂了**怎么办：如实报错（`NetError`），界面把原因显示出来 ——
 *   这正是第三方镜像的代价，README 的「已知限制」里写着，不能假装没有。
 */

/// 一次请求走哪条路 —— 现在**只有镜像这一条**。
///
/// ★ 以前这里有 `OfficialWithKey` / `MirrorWithKey` 两个取值
///   （"自备 key 走官方"、"官方不通退镜像"），2026-09-26 连 key 一起删了。
///   保留这个枚举而不是直接写死镜像，是为了让"路径"这个概念有个**一个**住处：
///   将来真要加第二条路，改的是这里，而不是散在各处的 URL 拼接。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    /// 国内镜像，**不带凭据**（唯一的一条路）
    MirrorNoKey,
}

impl Route {
    fn is_mirror(self) -> bool {
        matches!(self, Route::MirrorNoKey)
    }
}

impl std::fmt::Display for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Route::MirrorNoKey => "镜像(无需 key)",
        })
    }
}

/// 唯一的路径：**永远是镜像**（2026-09-26 起不再看有没有 key）。
fn route() -> Route {
    Route::MirrorNoKey
}

/// 主路失败之后换兜底路 —— 一次网络请求。**这是 GET 与 POST 共用的那一份**（ADR-051：
/// 判据只能有一份；以前 GET 走 `get_text_third_party`、POST 自己手写一遍，于是 POST 那半
/// 就漏掉了"镜像要裸整数"这个形状差异）。
/// 一次 API 请求（GET / POST 共用这一份）。
///
/// ★★ 2026-09-26：**只走国内镜像、不带 key、不兜底**（见文件里那段 `Route` 的说明）。
///   `body` 用**镜像那一份形状**（调用方给的 `fallback_body`）。
async fn request_with_fallback(
    method: reqwest::Method,
    path_and_query: &str,
    primary_body: Option<&str>,
    fallback_body: Option<&str>,
) -> Result<String> {
    let official = format!("{API}{path_and_query}");
    let route = route();
    debug_assert!(route.is_mirror(), "现在只剩镜像这一条路");
    /*
     * ★ 镜像地址由 `mirror::mcimirror_url` 从官方地址改写而来（**唯一的一份映射表**，
     *   不在别处再拼一遍）。它返回 `None` = 这条地址镜像不管 ⇒ 如实报错，
     *   不要偷偷改走官方：那会让"国内镜像"这条产品决定在某些路径上静默失效。
     */
    let Some(url) = mirror::mcimirror_url(&official) else {
        return Err(NetError::Other(format!(
            "CurseForge 这条地址没有国内镜像可用：{official}"
        )));
    };
    // ★ 镜像那一份 body（指纹反查的两条路形状不同；官方那份保留在类型里备用）。
    let body = fallback_body.or(primary_body);
    say!("[IEML/curseforge] {route} → {url}");
    send_once(method, &url, body).await
}

async fn send_once(
    method: reqwest::Method,
    url: &str,
    body: Option<&str>,
) -> Result<String> {
    let mut req = api_client().request(method, url);
    /*
     * ★★ 这里原来会给请求带上凭据（`x-api-key`）—— 2026-09-26 删掉了：
     *   用户要求"cf 只用镜像、key 永远移除启动器"，镜像是**不需要任何凭据**的。
     *   少一个头 = 少一个"镜像哪天开始校验它"的失败点。
     */
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

    /* ---------- key：**已经不存在了** ---------- */

    /// ★★★★ 2026-09-26 用户：「**cf 只用镜像，我的那把 key 永远移除启动器**」。
    ///
    ///   这条测试守的就是"移除"这件事本身 —— 它**故意不测 key 的优先级**
    ///   （那套逻辑已经删掉了），而是断言**它不会再回来**。
    ///
    ///   ★★ 两个自指陷阱（都踩过，写在这里免得下次重踩）：
    ///     ① 判据里写**完整的关键词** ⇒ 判据自己的源码就把判据顶红；
    ///     ② 自己写"剥注释"的解析器 ⇒ 文档注释里含 `://`（URL），
    ///        按行截 `//` 会把注释当成代码，又假红一次。
    ///   ⇒ 现在：关键词**拼出来**（源码里不出现完整词），扫描**整个文件**
    ///     （注释里出现这些词是**允许的** —— 那些注释正是在解释"它为什么被删掉了"）。
    #[test]
    fn the_api_key_is_gone_from_the_launcher_for_good() {
        let src = include_str!("curseforge.rs");
        /*
         * ★ 只查**声明与调用的形状**，不查裸词：
         *   · 裸词 `api_key` 会命中**要保留的文件名**（清理老 key 文件用得到）；
         *   · 注释里也必须能解释"它为什么被删掉了"。
         *   ⇒ 判据与注释都写"形状"，两边不会互相顶。
         */
        let shapes = [
            format!("const {}{}", "BUILTIN", "_API_KEY"),
            format!("const {}{}", "KEY", "_ENV"),
            format!("static {}{}", "KEY", "_OVERRIDE"),
            format!("fn {}{}", "api", "_key"),
            format!("fn {}{}", "set_api", "_key"),
            format!("fn {}{}", "key", "_hint"),
            format!("header({}{}", "\"x-api", "-key\""),
        ];
        for shape in shapes {
            assert!(
                !src.contains(&shape),
                "源码里又出现了「{shape}」这种形状 —— 用户明确要求 key 永远从启动器里移除（只用镜像）"
            );
        }
        // 而"清理老 key 文件"这件事必须还在（用户那把 key 不能留在盘上）
        assert!(
            src.contains(&format!("fn purge_legacy{}", "_key_files")),
            "旧 key 文件的清理不能一起删掉 —— 那是用户数据里的一份长期凭据"
        );
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

        // 两份**必须不同** —— 这是"以后要加回官方那条路"能工作的前提
        assert_ne!(official, mirror, "两条路的 body 形状必须不同，否则换路必 400");
    }
}
