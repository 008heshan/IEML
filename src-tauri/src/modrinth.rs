//! Modrinth 集成：模组搜索、版本查询、整合包（.mrpack）清单
//!
//! Modrinth 的 API 无需 Key（CurseForge 需要申请，本机实测 403），
//! 所以先做 Modrinth 这条完整链路。

use crate::net::{get_text, NetError, Result};

/// ★ 所有 Modrinth / CurseForge 的接口都走"官方优先、失败换 mcimirror"
///   （见 `net::get_text_third_party` 的说明）。
///
///   为什么统一包一层而不是在每个调用点写：接口有六七处（搜索、项目、
///   版本列表、哈希反查……），漏掉任何一处就等于那一个功能在官方不通时
///   彻底没有退路 —— 而"漏掉一处"是无法从代码外观上看出来的。
async fn api_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    let text = crate::net::get_text_third_party(url).await?;
    serde_json::from_str(&text)
        .map_err(|e| NetError::Other(format!("解析 {url} 的 JSON 失败：{e}")))
}
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const API: &str = "https://api.modrinth.com/v2";

/* ====================== 搜索 ====================== */

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    #[serde(default)]
    pub total_hits: u64,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub limit: u64,
    /// ★★ 这批结果**从哪个源来的**（`modrinth` / `curseforge`）。
    ///
    /// 为什么必须带上（ADR-052）：两个源的结果现在长得一样，界面若不知道
    /// 来源就没法说清"为什么这个 Mod 装不了"（CurseForge 上作者可以
    /// **禁止第三方分发**，那是 Modrinth 没有的概念）。
    /// 也让"搜索结果页"能把来源如实写在标题旁边，而不是含糊其辞。
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchHit {
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub follows: u64,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub versions: Vec<String>,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub gallery: Vec<String>,
    /// ★ CurseForge 专有：`false` = **作者不允许第三方分发**，我们下不了。
    ///
    /// Modrinth 没有这个概念，所以那边永远是 `None`（"不适用"），
    /// 不是 `false`（"不允许"）—— 界面据此区分"不适用"与"被作者拒绝"。
    #[serde(default)]
    pub distribution_allowed: Option<bool>,
    /// 项目页地址（让用户能去原站看一眼）。两个源都给真值。
    #[serde(default)]
    pub page_url: Option<String>,
}

/// 搜索 Mod / 整合包 / 资源包 / 光影包
///
/// ★ 这是**没有额外分类**的简版（等价于 `search_with_facets(..., None)`）。
///   要按"资源种类"搜（尤其是数据包）请用 [`search_with_facets`] ——
///   见它的说明。
pub async fn search(
    query: &str,
    project_type: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<SearchResponse> {
    search_with_facets(query, project_type, mc_version, loader, None, limit, offset).await
}

/// ★★ 带**额外分类**的搜索。
///
/// ## 为什么需要 `extra_category`（实测抓到的 bug）
///
/// Modrinth **没有 `datapack` 这个 `project_type`** —— 实测查过去
/// 返回的是 `mod`：
///
/// ```text
/// --- datapack: 3 条 ---
///     [mod] VeinMiner (82553959 次下载)
/// ```
///
/// 数据包是靠**分类**区分的：`categories:datapack`
/// （`categories:datapacks` 是 0 条 —— 单数才对）。
///
/// ★ 我第一版把 `extra_category()` 写在了 `ResourceKind` 上、
///   却**忘了在搜索里用它** —— 于是数据包页搜出来的是普通 Mod。
///   真机测试（`tools/live-resource-check.mjs`）一眼抓到：「datapack」0 条
///   （因为下游的二次过滤把普通 Mod 全滤掉了）。
///   规则定义了却没人用，是这个仓库里最难发现的一类半成品。
pub async fn search_with_facets(
    query: &str,
    project_type: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
    extra_category: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<SearchResponse> {
    // facets 是双层数组：[[ "categories:fabric" ], [ "versions:1.20.1" ]]
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{project_type}")]];
    if let Some(v) = mc_version {
        facets.push(vec![format!("versions:{v}")]);
    }
    if let Some(l) = loader {
        facets.push(vec![format!("categories:{l}")]);
    }
    /*
     * ★ 额外分类是**单独一层**。
     *
     *   Modrinth 的 facets 语义：外层是 AND，内层是 OR。
     *   所以把 `categories:datapack` 单独放一层 = "必须带这个分类"，
     *   而不是和加载器二选一（那样会把结果放大到不相关的项目）。
     */
    if let Some(c) = extra_category.filter(|c| !c.is_empty()) {
        facets.push(vec![format!("categories:{c}")]);
    }

    let mut url = format!(
        "{API}/search?query={}&limit={}&offset={}&index=relevance",
        urlencode(query),
        limit,
        offset
    );
    if !facets.is_empty() {
        url.push_str(&format!("&facets={}", urlencode(&serde_json::to_string(&facets).unwrap())));
    }

    /*
     * ★ 来源与项目页地址**由我们补齐**（Modrinth 的响应里没有这两个字段，
     *   但界面需要知道"这批结果从哪来"，见 `SearchResponse::source`）。
     *   `distribution_allowed` 留 `None` = "Modrinth 没有这个概念"，
     *   与 CurseForge 的 `false`（作者不允许分发）严格区分。
     */
    let mut resp: SearchResponse = api_json(&url).await?;
    resp.source = "modrinth".to_string();
    let kind_segment = |t: &str| match t {
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        "modpack" => "modpack",
        _ => "mod",
    };
    let seg = kind_segment(project_type);
    for h in resp.hits.iter_mut() {
        h.distribution_allowed = None;
        if h.page_url.is_none() && !h.slug.is_empty() {
            h.page_url = Some(format!("https://modrinth.com/{seg}/{}", h.slug));
        }
    }
    Ok(resp)
}

/* ====================== 项目与版本 ====================== */

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Project {
    pub id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub project_type: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub license: Option<serde_json::Value>,
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectVersion {
    pub id: String,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub name: String,
    #[serde(rename = "version_number")]
    pub version_number: String,
    #[serde(rename = "game_versions")]
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    #[serde(rename = "version_type")]
    pub version_type: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(rename = "date_published", default)]
    pub date_published: String,
    pub files: Vec<VersionFile>,
    #[serde(default)]
    pub dependencies: Vec<VersionDependency>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionFile {
    #[serde(default)]
    pub hashes: HashMap<String, String>,
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionDependency {
    #[serde(rename = "version_id", default)]
    pub version_id: Option<String>,
    #[serde(rename = "project_id", default)]
    pub project_id: Option<String>,
    #[serde(rename = "dependency_type", default)]
    pub dependency_type: String,
}

pub async fn project(id_or_slug: &str) -> Result<Project> {
    api_json(&format!("{API}/project/{id_or_slug}")).await
}

/// 批量取项目信息（一次最多 100 个 id）。
///
/// 用途：已安装 Mod 的清单要显示**项目标题与简介**，而不是文件名。
/// 逐个 `GET /project/{id}` 在几十个 Mod 时就是几十个请求，所以用批量接口。
pub async fn projects_by_ids(ids: &[String]) -> Result<HashMap<String, Project>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    // Modrinth 的批量接口是 GET /projects?ids=["a","b"]（JSON 数组放在查询串里）
    let ids_json = serde_json::to_string(ids)
        .map_err(|e| NetError::Other(format!("序列化项目 id 失败：{e}")))?;
    let resp = crate::net::client()
        .get(format!("{API}/projects"))
        .query(&[("ids", ids_json.as_str())])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(NetError::Other(format!(
            "批量取项目信息失败：HTTP {}",
            resp.status()
        )));
    }
    let list: Vec<Project> = resp
        .json()
        .await
        .map_err(|e| NetError::Other(format!("解析项目信息失败：{e}")))?;
    Ok(list.into_iter().map(|p| (p.id.clone(), p)).collect())
}

/// 取一个项目的版本列表（可按 MC 版本与加载器过滤）
pub async fn project_versions(
    id_or_slug: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
) -> Result<Vec<ProjectVersion>> {
    let mut url = format!("{API}/project/{id_or_slug}/version");
    let mut qs: Vec<String> = Vec::new();
    if let Some(v) = mc_version {
        qs.push(format!("game_versions={}", urlencode(&format!("[\"{v}\"]"))));
    }
    if let Some(l) = loader {
        qs.push(format!("loaders={}", urlencode(&format!("[\"{l}\"]"))));
    }
    if !qs.is_empty() {
        url.push('?');
        url.push_str(&qs.join("&"));
    }
    api_json(&url).await
}

/// ★★ **从一堆版本里挑出"该默认装哪个"** —— 纯函数，可单测。
///
/// ## 为什么要挑，而不是拿第一个
///
/// 用户的要求：「Fabric 的 API 也是有版本的，如果玩家不自己选，
/// 那就走**默认推荐**」。
///
/// 原来 `install_api_library_for` 直接 `versions.first()` —— 那是
/// **Modrinth 返回顺序的第一个**，而它既不是"最新正式版"也不是"最稳的"：
///   · 列表里混着 `beta` / `alpha`（Fabric API 大量发 beta）；
///   · 同一个 MC 版本可能有好几条（不同构建号）。
/// 拿第一个 = 让 API 的返回顺序决定玩家装到什么，出问题还很难查。
///
/// ## 挑法（按优先级）
///
///   ① `version_type == "release"`（正式版），没有就退到 beta，再没有 alpha；
///   ② 同一档里取**最新发布的**（`date_published` 降序）。
///
/// ## ★ 为什么第二级不是"下载量最高的"（实测推翻了第一版）
///
///   第一版按下载量降序，真机跑出来是这样（`live_api_pick.rs` 的输出）：
///   ```text
///   fabric-api @ 1.20.1：列表第一条 0.92.12+1.20.1（release，412967 次下载）
///                        ★ 挑中的   0.92.2+1.20.1（release，9745980 次下载）
///   ```
///   下载量最大的是 **0.92.2**，而它比 0.92.12 **更旧** —— 因为老版本
///   挂在那里时间更长，累计下载自然更高。**用累计下载量当"推荐度"
///   永远会挑到最老的那一个**，等于把玩家按在一个旧版本上。
///
///   所以第二级改成**发布时间降序**："最新正式版"才是用户对"推荐"
///   的预期，也是修 bug 的正常方向。
///
///   （日期是 ISO 8601 串 `2024-06-13T…`，**字典序 = 时间序**，
///   直接字符串比较即可 —— 不需要引入日期库。）
pub fn pick_default_version(versions: &[ProjectVersion]) -> Option<&ProjectVersion> {
    /// 稳定度排序权重：数字越小越优先
    fn stability(v: &ProjectVersion) -> u8 {
        match v.version_type.as_str() {
            "release" => 0,
            "beta" => 1,
            "alpha" => 2,
            // 认不出来的类型排在最后 —— **不猜**它是不是稳定版
            _ => 3,
        }
    }

    versions.iter().min_by(|a, b| {
        stability(a)
            .cmp(&stability(b))
            // 同稳定度 → **新的优先**（见上面那段：不能用下载量）
            .then_with(|| b.date_published.cmp(&a.date_published))
            // 日期也完全相同时给一个确定的次序，避免"结果随输入顺序漂移"
            .then_with(|| a.id.cmp(&b.id))
    })
}

/// ★ 按文件哈希反查（这是 PCL2 判定"可更新"的真实机制，ADR-019）
///
/// Modrinth 用 **SHA1**；CurseForge 用 **MurmurHash2（种子 1）**。
///
/// ★ 这里**故意不用镜像兜底**：哈希反查的语义是"这个文件在不在库里"，
///   而 `Err(_) => Ok(None)` 把它当成"不在库里"。如果先走官方、超时后再
///   走镜像，一次网络抖动会被记成"这个 Mod 库里没有" —— 于是界面上
///   那一行 Mod 永远没有更新提示。宁可让它如实失败。
pub async fn version_from_hash(sha1: &str) -> Result<Option<ProjectVersion>> {
    let url = format!("{API}/version_file/{sha1}");
    match get_text(&url).await {
        Ok(text) => {
            let v: ProjectVersion = serde_json::from_str(&text)
                .map_err(|e| NetError::Other(format!("解析哈希反查结果失败：{e}")))?;
            Ok(Some(v))
        }
        Err(_) => Ok(None), // 库里没有这个文件
    }
}

/// 批量哈希反查（PCL2 也是批量做的：`POST /v2/version_files`）
pub async fn versions_from_hashes(hashes: &[String]) -> Result<HashMap<String, ProjectVersion>> {
    if hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let body = serde_json::json!({
        "hashes": hashes,
        "algorithm": "sha1"
    });
    let resp = crate::net::client()
        .post(format!("{API}/version_files"))
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(NetError::Other(format!("哈希反查失败：HTTP {}", resp.status())));
    }
    let map: HashMap<String, ProjectVersion> = resp
        .json()
        .await
        .map_err(|e| NetError::Other(format!("解析批量反查结果失败：{e}")))?;
    Ok(map)
}

/* ====================== 整合包（.mrpack） ====================== */

/*
 * ★★ 整合包清单是 **camelCase**，和 Modrinth 的 API 不一样 ★★
 *
 *   这是「整合包无法安装」的根因（2026-09-17 用户报，live_modpack 实测抓到）：
 *
 *       #[serde(rename = "version_id")]     // ← 字段本来就叫 version_id
 *       pub version_id: String,             //    这行 rename 是**空操作**
 *
 *   作者显然想写 `versionId`（规范里就是这个名字），但写成了下划线版本 ——
 *   等于什么都没改。于是 serde 去找 `version_id`、真实清单里只有 `versionId`、
 *   直接报 `missing field version_id`，整合包**一个都装不上**。
 *
 *   同一个错误还有两处**不报错但读到错数据**的：
 *     * `format_version` 拿不到 `formatVersion` → `default` 成 0
 *     * `MrpackFile::file_size` 拿不到 `fileSize` → `default` 成 0
 *       （后者会让"要下多少字节"永远是 0，进度条与调度都失去依据）
 *
 *   修法是给整个结构体加 `rename_all = "camelCase"` —— 一次盖住所有字段，
 *   而不是再逐个写 `rename`（逐个写正是当初漏掉的那个形态）。
 *
 *   ★ 为什么单测没抓到：下面那些测试是**直接用 Rust 结构体字面量**构造
 *     `MrpackIndex` 的，从来没走过反序列化 —— serde 的字段名一条都没被验证过。
 *     所以这次同时补了一条**按真实 JSON 形状**解析的测试（见 `mrpack_json_*`）。
 */
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackIndex {
    #[serde(default)]
    pub format_version: u32,
    pub game: String,
    /// 规范里 `formatVersion: 2` 起这个字段是**可选**的，所以给 default；
    /// 它只用于界面显示，缺失不该让整个安装失败。
    #[serde(default)]
    pub version_id: String,
    pub name: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub files: Vec<MrpackFile>,
    #[serde(default)]
    pub dependencies: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackFile {
    pub path: String,
    pub hashes: HashMap<String, String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    pub downloads: Vec<String>,
    #[serde(default)]
    pub file_size: u64,
}

impl MrpackIndex {
    /// 加载器类型（`dependencies` 里形如 `fabric-loader: "0.15.7"`）
    pub fn loader(&self) -> Option<(&str, &str)> {
        for key in ["fabric-loader", "quilt-loader", "forge", "neoforge"] {
            if let Some(v) = self.dependencies.get(key) {
                return Some((key, v.as_str()));
            }
        }
        None
    }

    /// 该文件是否只用于服务端（client 环境为 unsupported 时跳过）
    pub fn is_client_relevant(file: &MrpackFile) -> bool {
        match file.env.as_ref().and_then(|e| e.get("client")) {
            Some(v) => v != "unsupported",
            None => true,
        }
    }

    /// ★ 这个整合包**自己**带没带 Fabric API / Quilted Fabric API 前置包。
    ///
    /// 为什么要问这一句：Fabric API 是"几乎每个 Fabric 整合包都要"的前置包，
    /// 但 mrpack 的作者**可能已经把它列进清单**（那就什么都不用做），
    /// 也可能依赖玩家自己装（PCL 就是靠内置下载补上的）。
    /// 我们不去猜作者意图 —— 只检查清单里有没有对应的 jar：
    ///   有 → 用户会拿到作者指定的那个版本，**不要覆盖**；
    ///   没有 → 补一个，否则进游戏就是"缺少前置 fabric-api"。
    ///
    /// ## 文件名前缀为什么要列这么多
    ///
    /// 实测（2026-09-13，`live_apilib` 跑出来的真实文件名）：
    ///   * Fabric API → `fabric-api-0.92.12+1.20.1.jar`
    ///   * Quilt 的  → `qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar`
    ///     —— 注意它**不叫** quilted-fabric-api，而是 `qfapi-…`。
    ///   只认 `fabric-api` 前缀的话，Quilt 整合包会被误判成"没带 API"，
    ///   于是我们又下一个 QFAPI 进去，同一个实例里出现两个 API 实现。
    ///
    /// 判定只看**末段文件名**（清单里的路径就是最终落盘路径
    /// `mods/<文件名>`），并且必须落在 `mods/` 下。
    pub fn has_fabric_api(&self) -> bool {
        self.files.iter().any(|f| {
            let lower = f.path.to_ascii_lowercase();
            if !lower.starts_with("mods/") {
                return false;
            }
            let name = lower.rsplit('/').next().unwrap_or("");
            if !name.ends_with(".jar") {
                return false;
            }
            const PREFIXES: [&str; 4] = [
                "fabric-api",         // Fabric API 官方发布名
                "quilted-fabric-api", // 旧发布名 / 部分镜像改名
                "qfapi",              // Quilt 现在的发布名：qfapi-7.7.0_…
                "qsl",                // Quilt Standard Libraries 单独发布时
            ];
            PREFIXES.iter().any(|p| name.starts_with(p))
        })
    }
}

/// 下载并解析一个 .mrpack（本质是个 zip，里面有 `modrinth.index.json`）
pub async fn fetch_mrpack_index(url: &str) -> Result<MrpackIndex> {
    let bytes = crate::net::client()
        .get(url)
        .send()
        .await?
        .bytes()
        .await?;

    let reader = std::io::Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| NetError::Other(format!("这个 .mrpack 不是有效的压缩包：{e}")))?;

    let mut index_text = None;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NetError::Other(format!("读取压缩包失败：{e}")))?;
        if entry.name() == "modrinth.index.json" {
            use std::io::Read;
            let mut s = String::new();
            entry
                .read_to_string(&mut s)
                .map_err(|e| NetError::Other(format!("读取清单失败：{e}")))?;
            index_text = Some(s);
            break;
        }
    }

    let text = index_text.ok_or_else(|| {
        NetError::Other("这个压缩包里没有 modrinth.index.json —— 不是 Modrinth 整合包".into())
    })?;
    serde_json::from_str(&text)
        .map_err(|e| NetError::Other(format!("整合包清单格式不对：{e}")))
}

/// 整合包清单里的一条路径**能不能安全地落到游戏目录里**。
///
/// ## 为什么必须有这一道闸门（P0-2）
///
/// `.mrpack` 的 `files[].path` 是**整合包作者写的一个字符串**，我们直接
/// `game_dir.join(path)` 就落盘、下载。而它是个不可信输入：
///
///   * `../../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/
///     Startup/x.jar` —— 目录穿越，写到游戏目录**外面**（自启动目录都能写）；
///   * `C:/Windows/System32/x.dll` / `\\server\share\x` —— 绝对路径，
///     `join` 在 Windows 上会**整个替换**成绝对路径（Rust 的 `Path::join`
///     语义就是"绝对路径替换前缀"），于是写到系统目录；
///   * `mods/../../x` —— 前半段看着合法，退回上层。
///
/// `extract_overrides` 一直有这道校验（用的是 zip crate 的
/// `enclosed_name()`，它专门处理 zip 条目里的 `..` 与绝对路径），
/// 但**按清单下载**那条路完全没有 —— 同一份不可信输入，一条路拦、一条路不拦。
/// 现在两条路共用这**同一个**判据（不再各写一份）。
///
/// 返回 `None` = 这条路径不安全（调用方必须**说出来**，不许静默丢弃）。
pub fn safe_relative_path(raw: &str) -> Option<std::path::PathBuf> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    // Windows 上 `\` 也是分隔符（zip 里的条目两种都见过）—— 统一成 `/` 再判，
    // 否则 `..\..\x` 会被当成一个"名字里带反斜杠"的普通文件放过去。
    let unified = text.replace('\\', "/");
    // 绝对路径：POSIX 的 `/x`、Windows 的 `C:/x`、UNC 的 `//server/share`
    if unified.starts_with('/') {
        return None;
    }
    let mut out = std::path::PathBuf::new();
    for part in unified.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None; // 只要出现一次向上走，整条路径作废
        }
        // 盘符 / ADS（`C:`、`x:y`）：任何一段里带冒号都不是普通文件名
        if part.contains(':') {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

/// 从整合包索引生成下载任务（**纯函数，可单测**）
///
/// ★ 返回 `(任务, 被跳过的路径)` —— 跳过的**必须**交回调用方去说，
///   静默丢文件会让"整合包装完了但少东西"变成一个查不出来的谜。
pub fn mrpack_download_tasks(
    index: &MrpackIndex,
    game_dir: &std::path::Path,
) -> (Vec<crate::net::download::DownloadTask>, Vec<String>) {
    let mut tasks = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for f in index.files.iter().filter(|f| MrpackIndex::is_client_relevant(f)) {
        // ① 路径必须先过闸门，再谈下载
        let Some(rel) = safe_relative_path(&f.path) else {
            skipped.push(f.path.clone());
            continue;
        };
        // ② 下载地址为空 = 清单让我们下、却没给地址 —— 也是"下不了"，要说出来
        let Some(url) = f.downloads.first().cloned() else {
            skipped.push(f.path.clone());
            continue;
        };
        // SHA1 优先，其次 SHA512（我们用不上，但保留哈希用于校验）
        let sha1 = f.hashes.get("sha1").cloned().unwrap_or_default();
        // 整合包可能给出多个镜像下载地址（CurseForge / Modrinth CDN 都在里面）
        let extras: Vec<String> = f.downloads.iter().skip(1).cloned().collect();
        let mut task = crate::net::download::DownloadTask::new(
            game_dir.join(&rel),
            url,
            sha1,
            f.file_size,
            f.path.clone(),
        );
        task.urls = extras;
        tasks.push(task);
    }

    (tasks, skipped)
}

impl MrpackIndex {
    /// 这个整合包要哪个 MC 版本（清单的 `dependencies.minecraft`）
    pub fn mc_version(&self) -> Option<&str> {
        self.dependencies.get("minecraft").map(|s| s.as_str())
    }
}

/// 从**内存里的字节**解析 .mrpack（已经下载好的那份用这个，省一次下载）。
pub fn parse_mrpack_bytes(bytes: &[u8]) -> Result<MrpackIndex> {
    let reader = std::io::Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| NetError::Other(format!("这个 .mrpack 不是有效的压缩包：{e}")))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| NetError::Other(format!("读取压缩包失败：{e}")))?;
        if entry.name() == "modrinth.index.json" {
            use std::io::Read;
            let mut s = String::new();
            entry
                .read_to_string(&mut s)
                .map_err(|e| NetError::Other(format!("读取清单失败：{e}")))?;
            return serde_json::from_str(&s)
                .map_err(|e| NetError::Other(format!("整合包清单格式不对：{e}")));
        }
    }
    Err(NetError::Other(
        "这个压缩包里没有 modrinth.index.json —— 不是 Modrinth 整合包".into(),
    ))
}

/// 解压整合包里的 `overrides/` 到游戏目录。
///
/// 官方规范里 `overrides/` 是**逐字覆盖**到游戏目录的（作者的 config、
/// 存档、光影配置、资源包都在这里）。不做这一步，整合包装完是"能进游戏但
/// 没有任何作者设置"——看起来像坏了。
///
/// ★ 安全：zip 里可能带 `../` 目录穿越（恶意包）；每个条目都做前缀校验，
///   一旦解析出的路径逃出目标根就跳过并计数，绝不写出去。
///   这道闸门与**按清单下载**那条路共用 [`safe_relative_path`]（P0-2：
///   同一份不可信输入不许一条路拦、一条路不拦）。
pub fn extract_overrides(bytes: &[u8], game_dir: &std::path::Path) -> Result<usize> {
    let reader = std::io::Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| NetError::Other(format!("打开整合包失败：{e}")))?;
    let mut written = 0usize;
    let mut skipped = 0usize;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let Some(rel) = entry.enclosed_name() else {
            // `enclosed_name()` 返回 None = 路径逃出了压缩包根（`..` 或绝对路径）
            skipped += 1;
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let Some(rest) = rel_str.strip_prefix("overrides/") else {
            continue; // 只解 overrides/，其余（如 client-overrides/）另行处理
        };
        // 第二道闸门（与 mrpack_download_tasks 同一个函数）：`enclosed_name()`
        // 已经挡了 `..`，这里再挡一次盘符/绝对路径，代价是几次字符串比较
        let Some(safe) = safe_relative_path(rest) else {
            skipped += 1;
            continue;
        };
        let dest = game_dir.join(&safe);
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&dest);
            continue;
        }
        if let Some(parent) = dest.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                skipped += 1;
                continue;
            }
        }
        match std::fs::File::create(&dest) {
            Ok(mut f) => {
                if std::io::copy(&mut entry, &mut f).is_ok() {
                    written += 1;
                } else {
                    skipped += 1;
                }
            }
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        say!("[IEML/modpack] overrides 里有 {skipped} 个条目被跳过（目录穿越或写入失败）");
    }
    Ok(written)
}

/* ====================== 工具 ====================== */

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes_specials() {
        assert_eq!(urlencode("sodium"), "sodium");
        assert_eq!(urlencode(r#"["fabric"]"#), "%5B%22fabric%22%5D");
        assert_eq!(urlencode("a b"), "a%20b");
    }

    /* ---------- 默认推荐版本的选择（用户要求「不自己选就走推荐」） ---------- */

    fn pv(id: &str, kind: &str, date: &str) -> ProjectVersion {
        ProjectVersion {
            id: id.into(),
            project_id: "P7dR8mSH".into(),
            name: id.into(),
            version_number: id.into(),
            game_versions: vec!["1.20.1".into()],
            loaders: vec!["fabric".into()],
            version_type: kind.into(),
            // ★ 故意把下载量与"新旧"设成**反相关**（老版本下载更多），
            //   这样一旦有人把挑法改回"按下载量"，测试立刻红。
            downloads: if date < "2024-06-01" { 9_000_000 } else { 1_000 },
            date_published: date.into(),
            files: vec![],
            dependencies: vec![],
        }
    }

    /// ★★ **正式版优先**，哪怕它在列表里排在 beta 后面、日期更新。
    ///
    ///   这是用户那条要求的核心：「Fabric 的 API 也是有版本的，
    ///   如果玩家不自己选，那就走默认推荐」。
    ///   老代码直接取 `versions.first()` —— 让 Modrinth 的返回顺序决定
    ///   玩家装到什么，那是碰运气。
    #[test]
    fn default_version_prefers_release_over_beta() {
        let list = vec![
            // beta 排在第一个、而且更新 —— 但仍然必须让给正式版
            pv("0.93.0-beta.1", "beta", "2024-09-01"),
            pv("0.92.12", "release", "2024-05-01"),
        ];
        assert_eq!(
            pick_default_version(&list).map(|v| v.version_number.as_str()),
            Some("0.92.12"),
            "★ 有正式版就必须挑正式版，不许被「列表顺序」或「日期更新」带走"
        );
    }

    /// ★★ **同一档里挑新的，不是挑下载量大的**（实测推翻过第一版）
    ///
    ///   真机输出（`live_api_pick.rs`）：
    ///   ```text
    ///   fabric-api @ 1.20.1：列表第一条 0.92.12+1.20.1（release，412967 次）
    ///                        ★ 挑中的   0.92.2+1.20.1（release，9745980 次）
    ///   ```
    ///   下载量最大的是 **0.92.2**，比 0.92.12 **更旧** —— 老版本挂得久，
    ///   累计下载自然更高。**按下载量挑 = 永远挑到最老的那个。**
    #[test]
    fn default_version_picks_newest_not_most_downloaded() {
        let list = vec![
            // 老版本：下载量高得离谱
            pv("0.92.2", "release", "2023-06-01"),
            // 新版本：下载量低（发布得晚）
            pv("0.92.12", "release", "2024-05-01"),
        ];
        assert_eq!(
            pick_default_version(&list).map(|v| v.version_number.as_str()),
            Some("0.92.12"),
            "★ 同一稳定度里要挑**最新**的；按累计下载量挑会永远挑到最老的那个"
        );
    }

    /// 没有正式版 → 退到 beta；再没有才 alpha
    #[test]
    fn default_version_falls_back_by_stability() {
        let beta_only = vec![
            pv("b1", "beta", "2024-01-01"),
            pv("a1", "alpha", "2024-09-01"), // 更新，但不如 beta 稳
        ];
        assert_eq!(
            pick_default_version(&beta_only).map(|v| v.version_type.as_str()),
            Some("beta"),
            "beta 比 alpha 稳 —— 稳定度优先于日期"
        );

        let alpha_only = vec![
            pv("a1", "alpha", "2024-01-01"),
            pv("a2", "alpha", "2024-08-01"),
        ];
        assert_eq!(
            pick_default_version(&alpha_only).map(|v| v.version_number.as_str()),
            Some("a2"),
            "同一档内按发布日期降序"
        );
    }

    /// ★ 认不出的类型**不猜**它是稳定版 —— 排在最后
    #[test]
    fn unknown_version_type_ranks_last() {
        let list = vec![
            pv("weird", "unknown-type", "2025-01-01"),
            pv("r", "release", "2020-01-01"),
        ];
        assert_eq!(
            pick_default_version(&list).map(|v| v.version_number.as_str()),
            Some("r"),
            "认不出的类型不许排到正式版前面"
        );
    }

    /// 日期完全相同时结果必须**确定**（不随输入顺序漂移）
    #[test]
    fn default_version_is_deterministic_on_identical_dates() {
        let a = vec![pv("aaa", "release", "2024-01-01"), pv("bbb", "release", "2024-01-01")];
        let b = vec![pv("bbb", "release", "2024-01-01"), pv("aaa", "release", "2024-01-01")];
        assert_eq!(
            pick_default_version(&a).map(|v| v.id.as_str()),
            pick_default_version(&b).map(|v| v.id.as_str()),
            "同样的输入换顺序不该挑出不同的版本"
        );
    }

    #[test]
    fn empty_version_list_picks_nothing() {
        assert!(pick_default_version(&[]).is_none());
    }

    #[test]
    fn mrpack_loader_detection() {
        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        deps.insert("fabric-loader".to_string(), "0.15.7".to_string());
        let idx = MrpackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: "1".into(),
            name: "Test".into(),
            summary: None,
            files: vec![],
            dependencies: deps,
        };
        assert_eq!(idx.loader(), Some(("fabric-loader", "0.15.7")));
    }

    /*
     * ★★ 这两条是 2026-09-17「整合包无法安装」的防复发断言 ★★
     *
     *   上面那些测试全都是**直接构造 Rust 结构体**的 —— 它们能验证业务逻辑，
     *   却**完全绕过了 serde**：字段名叫什么、JSON 里是 camelCase 还是
     *   snake_case，一条都没被检查过。
     *
     *   于是 `#[serde(rename = "version_id")]`（字段本来就叫这个名，等于没写）
     *   一路活到了线上：真实清单里是 `versionId`，serde 找不到 `version_id`，
     *   直接 `missing field version_id` —— **所有整合包都装不上**。
     *
     *   下面的 JSON **逐字取自真实 .mrpack**（Fabulously Optimized，
     *   实测用 Expand-Archive 解出来的 modrinth.index.json），
     *   只把 files 截短。这样 serde 的字段名就被真正钉住了。
     */
    const REAL_INDEX_JSON: &str = r#"{
      "formatVersion": 1,
      "game": "minecraft",
      "versionId": "15.0.0-alpha.2",
      "name": "Fabulously Optimized",
      "files": [
        {
          "path": "mods/sodium.jar",
          "hashes": { "sha1": "abc123", "sha512": "def456" },
          "env": { "client": "required", "server": "unsupported" },
          "downloads": ["https://cdn.modrinth.com/data/AANobbMI/versions/abc/sodium.jar"],
          "fileSize": 123456
        },
        {
          "path": "mods/server-only.jar",
          "hashes": { "sha1": "999999" },
          "env": { "client": "unsupported", "server": "required" },
          "downloads": ["https://cdn.modrinth.com/data/XXXX/versions/def/server-only.jar"],
          "fileSize": 500
        }
      ],
      "dependencies": { "fabric-loader": "0.19.5", "minecraft": "26.3" }
    }"#;

    #[test]
    fn mrpack_json_uses_camel_case_and_parses() {
        let idx: MrpackIndex =
            serde_json::from_str(REAL_INDEX_JSON).expect("真实形状的清单必须能解析");

        // 曾经致命的那一个字段
        assert_eq!(idx.version_id, "15.0.0-alpha.2", "versionId 没读进来");
        // 曾经静默变成 0 的那两个
        assert_eq!(idx.format_version, 1, "formatVersion 没读进来（会静默变成 0）");
        assert_eq!(idx.files.len(), 2);
        assert_eq!(
            idx.files[0].file_size, 123456,
            "fileSize 没读进来（会静默变成 0，进度与调度都失去依据）"
        );
        // 业务字段
        assert_eq!(idx.mc_version(), Some("26.3"));
        assert_eq!(idx.loader(), Some(("fabric-loader", "0.19.5")));
        assert_eq!(idx.files[0].hashes.get("sha1").map(|s| s.as_str()), Some("abc123"));
        // 客户端筛选的两个方向都要对（`env.client` 才是判据，不是 server）
        assert!(
            MrpackIndex::is_client_relevant(&idx.files[0]),
            "client=required 的文件必须下给客户端"
        );
        assert!(
            !MrpackIndex::is_client_relevant(&idx.files[1]),
            "client=unsupported 的文件不该下给客户端"
        );
    }

    /// 规范里 `formatVersion: 2` 起 `versionId` 是**可选**的 —— 缺了不该让安装失败。
    #[test]
    fn mrpack_json_without_version_id_still_parses() {
        let json = r#"{
          "formatVersion": 2,
          "game": "minecraft",
          "name": "No VersionId Pack",
          "files": [],
          "dependencies": { "minecraft": "1.20.1" }
        }"#;
        let idx: MrpackIndex =
            serde_json::from_str(json).expect("formatVersion 2 没有 versionId 也要能解析");
        assert_eq!(idx.format_version, 2);
        assert_eq!(idx.version_id, "");
    }

    #[test]
    fn mrpack_loader_none_when_vanilla() {
        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        let idx = MrpackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: "1".into(),
            name: "Vanilla".into(),
            summary: None,
            files: vec![],
            dependencies: deps,
        };
        assert_eq!(idx.loader(), None);
    }

    #[test]
    fn mrpack_server_only_files_are_skipped() {
        let mut env = HashMap::new();
        env.insert("client".to_string(), "unsupported".to_string());
        let f = MrpackFile {
            path: "mods/serveronly.jar".into(),
            hashes: HashMap::new(),
            env: Some(env),
            downloads: vec!["https://example/x.jar".into()],
            file_size: 1,
        };
        assert!(!MrpackIndex::is_client_relevant(&f));

        let f2 = MrpackFile {
            path: "mods/ok.jar".into(),
            hashes: HashMap::new(),
            env: None,
            downloads: vec!["https://example/y.jar".into()],
            file_size: 1,
        };
        assert!(MrpackIndex::is_client_relevant(&f2));
    }

    fn idx_with_files(paths: &[&str]) -> MrpackIndex {
        MrpackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: "1".into(),
            name: "Pack".into(),
            summary: None,
            files: paths
                .iter()
                .map(|p| MrpackFile {
                    path: (*p).to_string(),
                    hashes: HashMap::new(),
                    env: None,
                    downloads: vec!["https://example/x.jar".into()],
                    file_size: 1,
                })
                .collect(),
            dependencies: HashMap::new(),
        }
    }

    /// ★ 整合包里已经带了 Fabric API 就必须认出来 —— 认错会**覆盖作者的版本**，
    ///   而那个版本是配着他那堆 Mod 选的，换掉就可能把整合包搞坏。
    #[test]
    fn mrpack_detects_bundled_fabric_api() {
        assert!(idx_with_files(&["mods/fabric-api-0.92.2+1.20.1.jar"]).has_fabric_api());
        // Quilt 整合包带的是 quilted-fabric-api，同样要认出来
        assert!(idx_with_files(&["mods/quilted-fabric-api-7.3.0.jar"]).has_fabric_api());
        // ★ 实测的真名字：Quilt 现在的发布名是 qfapi-…，不是 quilted-fabric-api
        assert!(
            idx_with_files(&["mods/qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar"])
                .has_fabric_api(),
            "认不出 qfapi-… 的话，Quilt 整合包里会被塞进第二个 API 实现"
        );
        assert!(idx_with_files(&["mods/qsl-6.3.0.jar"]).has_fabric_api());
        // 大小写不该影响判定（清单是人写的，路径不保证规范）
        assert!(idx_with_files(&["mods/Fabric-API-0.92.2.jar"]).has_fabric_api());
        assert!(idx_with_files(&["mods/QFAPI-7.7.0.jar"]).has_fabric_api());
    }

    #[test]
    fn mrpack_without_fabric_api_is_detected_as_missing() {
        // 只有别的前置包 —— 这时才该自动补一个 Fabric API
        assert!(!idx_with_files(&["mods/sodium-0.5.8.jar", "mods/lithium.jar"]).has_fabric_api());
        assert!(!idx_with_files(&[]).has_fabric_api());
    }

    /// 只认 `mods/` 下的 jar：别的目录里出现同名文件不是前置包
    /// （例如作者把 API 源码或压缩备份放在别处）。
    #[test]
    fn fabric_api_detection_is_scoped_to_mods_dir() {
        assert!(!idx_with_files(&["resourcepacks/fabric-api-pack.zip"]).has_fabric_api());
        assert!(!idx_with_files(&["fabric-api-notes.txt"]).has_fabric_api());
        // 名字像但后缀不是 jar 的也不算
        assert!(!idx_with_files(&["mods/fabric-api.jar.bak"]).has_fabric_api());
        // 末段路径才算（深层子目录里的同名文件按文件名判定）
        assert!(idx_with_files(&["mods/1.20/fabric-api-0.92.2.jar"]).has_fabric_api());
    }

    /* ---------- ★★ P0-2：清单里的路径必须过闸门 ---------- */

    /// 正常的相对路径：原样通过（并且反斜杠被归一成 `/`）
    #[test]
    fn safe_relative_path_accepts_normal_entries() {
        assert_eq!(
            safe_relative_path("mods/sodium.jar"),
            Some(std::path::PathBuf::from("mods/sodium.jar"))
        );
        // 深层目录、点号开头的隐藏文件（`.connector` 之类的整合包真的会有）
        assert_eq!(
            safe_relative_path("config/deep/nested/a.toml"),
            Some(std::path::PathBuf::from("config/deep/nested/a.toml"))
        );
        // zip 里两种分隔符都见过
        assert_eq!(
            safe_relative_path("mods\\sodium.jar"),
            Some(std::path::PathBuf::from("mods/sodium.jar"))
        );
        // 收尾多余的分隔符不当成"目录穿越"
        assert_eq!(
            safe_relative_path("mods//a.jar"),
            Some(std::path::PathBuf::from("mods/a.jar"))
        );
    }

    /// ★★ 目录穿越：只要出现一次 `..`，整条路径作废。
    ///
    ///   这是这条闸门存在的理由 —— `.mrpack` 的 `path` 是包作者写的字符串，
    ///   而我们直接 `game_dir.join(path)` 就落盘。`../..` 能写到游戏目录外面。
    #[test]
    fn safe_relative_path_rejects_traversal() {
        for bad in [
            "../evil.jar",
            "../../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.jar",
            "mods/../../evil.jar",
            "..\\..\\evil.jar",
            "mods/..",
            "..",
        ] {
            assert_eq!(safe_relative_path(bad), None, "必须拒绝：{bad}");
        }
    }

    /// ★★ 绝对路径与盘符：Windows 上 `Path::join` 遇到绝对路径会**整个替换**
    ///    前缀，于是 `C:/Windows/…` 就真的写到系统目录去了。
    #[test]
    fn safe_relative_path_rejects_absolute_and_drive_paths() {
        for bad in [
            "/etc/cron.d/x",
            "C:/Windows/System32/x.dll",
            "c:/windows/x",
            "\\\\server\\share\\x.jar",
            "//server/share/x.jar",
            "C:evil.jar", // 盘符相对路径（Windows 上也指到别处）
            "mods/a:b.jar",
        ] {
            assert_eq!(safe_relative_path(bad), None, "必须拒绝：{bad}");
        }
    }

    #[test]
    fn safe_relative_path_rejects_empty() {
        for bad in ["", "   ", ".", "./", "/"] {
            assert_eq!(safe_relative_path(bad), None, "必须拒绝：{bad:?}");
        }
    }

    /// 闸门接在**任务生成**这一层：坏路径不进任务表，而且**被记下来**
    /// （调用方要把它说出来，不许静默丢文件）。
    #[test]
    fn mrpack_tasks_skip_unsafe_paths_and_report_them() {
        let idx = idx_with_files(&[
            "mods/ok.jar",
            "../../escape.jar",
            "C:/Windows/System32/evil.dll",
        ]);
        let game = std::path::Path::new("C:/instances/pack/game");
        let (tasks, skipped) = mrpack_download_tasks(&idx, game);

        assert_eq!(tasks.len(), 1, "只有那条合法路径能变成任务");
        assert_eq!(tasks[0].path, game.join("mods/ok.jar"));
        assert_eq!(skipped.len(), 2, "被拒绝的路径必须交回调用方去说：{skipped:?}");
        assert!(skipped.iter().any(|p| p.contains("escape.jar")));
        assert!(skipped.iter().any(|p| p.contains("evil.dll")));
    }

    /// 清单说"要下这个文件"却没给下载地址 —— 也是下不了，同样要报出来
    #[test]
    fn mrpack_tasks_report_entries_without_url() {
        let mut idx = idx_with_files(&["mods/a.jar"]);
        idx.files[0].downloads.clear();
        let (tasks, skipped) = mrpack_download_tasks(&idx, std::path::Path::new("C:/inst"));
        assert!(tasks.is_empty());
        assert_eq!(skipped, vec!["mods/a.jar".to_string()]);
    }
}
