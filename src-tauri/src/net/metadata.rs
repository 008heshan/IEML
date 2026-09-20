//! 版本元数据（Mojang 版本 JSON 的完整模型 + 加载器清单）
//!
//! 依据的是**真实**的版本 JSON 结构（1.20.1 实测：88 个库、3598 个资源文件、
//! `arguments` 新格式、主类 `net.minecraft.client.main.Main`）。
//!
//! 三个必须处理的现实：
//!   ① 库有 `rules`（按操作系统/架构过滤）—— 不处理会把 macOS 的库下到 Windows 上，
//!      实测 1.20.1 的 88 个库里有 12 个是平台限定的。
//!   ② 库有 `natives`（需要解压的本地库）—— 不解压游戏起不来（缺 lwjgl dll）。
//!   ③ `arguments` 里有占位符（`${auth_player_name}` 等），必须在拼命令行时替换。

use super::mirror::{Source, FABRIC_META, QUILT_META};
use super::{get_json, get_text, NetError, Result};
use crate::domain::loader_trace::compare_version_desc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/* ====================== 元数据缓存 ====================== */
// 版本清单 / 加载器列表这些元数据相对稳定，但网络差时拉取要好几秒
// （实测 Fabric loader 列表 590KB 拉了 5.5 秒）。这里做本地磁盘缓存：
//   TTL 内直接用缓存；联网拉成功后写缓存；网络失败 fallback 旧缓存（即使过期）。

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 应用启动时设置（lib.rs 的 run() 里传 paths.cache）。
pub fn set_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// 元数据默认缓存时长：30 分钟。
const META_TTL: Duration = Duration::from_secs(30 * 60);

/// **小**清单的缓存时长：5 分钟。
///
/// 用在 Forge 的 build 列表上（BMCLAPI `/forge/minecraft/{mc}`，实测 40~70 KB、
/// 100~400 ms）。Forge 一周能发好几个 build，所以这个要短 ——
/// 用一个"半小时前说没有这个版本"的答案去禁用安装按钮，
/// 用户看到的就是"明明有最新版，启动器说没有"。
const LOADER_TTL: Duration = Duration::from_secs(5 * 60);

/// **大**清单的缓存时长：12 小时。
///
/// ★★ 这一条是为了解决用户报的「在线清单查询太慢」（430 行左右的实测）：
///
///   Fabric 的 `/versions/loader/{mc}` 是 **590 KB**、Quilt 的是 **892 KB**、
///   NeoForge 的 maven-metadata 是 63 KB。以前它们和 Forge 共用 5 分钟的 TTL，
///   于是**每 5 分钟就把这 1.5 MB 重下一遍** —— 实测同一个版本第二次查还要 32 秒。
///
///   但这些清单根本没必要这么勤：
///     · Fabric / Quilt 的 loader 版本号是**跨 MC 版本共享**的（今天 0.19.5，
///       下个月可能才 0.20），换版本查到的清单内容几乎一样；
///     · 真正决定"装到哪个版本"的是安装时**单独请求的 profile JSON**
///       （`fabric_profile` / `quilt_profile`），那个**不缓存**，永远拿最新；
///     · 列表只用来说"有哪些可选"。
///
///   所以列表可以长缓存，**不会**导致装错版本 —— 最坏情况是"最新版晚 12 小时
///   出现在下拉框里"，而用户点「重新查询」时会强制刷新（force）。
///
/// ★★ 但**前提是这个 TTL 里存的东西会自己过期** —— 2026-09-13 补的教训：
///   修好 NeoForge 的 `-beta` 过滤之后，用户机器上那份
///   `neoforge_list_26.1.json`（内容是**空数组**，语义是"确认没有"）
///   还能活满 12 小时。于是"我修好了"和"用户看到修好了"之间差了半天。
///
///   对策见 `CACHE_VERSION`：文件名带版本号，**改解析规则就换文件名**，
///   旧文件再也不会被读到（它只是占一点磁盘，下次清理缓存时会被扫掉）。
const LOADER_LIST_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// ★★ **缓存文件的版本号** —— 改了"从接口数据得出什么结论"的代码就要 +1。
///
/// 为什么需要它（真实事故）：磁盘缓存里存的是**结论**，不只是原始 JSON。
/// 一个空数组的语义是"**确认**这个 MC 版本没有这个加载器"，它会：
///   ① 让界面把这一项置灰并显示"未发布"；
///   ② 活满 TTL（这里 12 小时），用户**重启启动器也不会重查**。
/// 所以当 bug 出在解析/过滤规则上时，旧结论会带着 bug 继续生效 ——
/// "我修好了"和"用户看到修好了"之间差了整整半天。
///
/// 规则：**凡是改了"从接口数据得出什么结论"的代码，就把这个数字 +1。**
/// （前端 `src/domain/loader-catalog.ts` 的 `KEY` 是同一件事的镜像，一起改。）
///
/// v1 → v2（2026-09-13）：NeoForge 的 `-beta` 过滤会把 26.1 / 1.21.9
/// 这类"全是 beta"的版本判成"确认没有 NeoForge"；Forge 的 1.7.10 产物名
/// 少了分支后缀（导致装不上）。
pub const CACHE_VERSION: u32 = 2;

/// 给缓存文件名加上版本前缀（`v2_forge_builds_1.20.1.json`）。
pub fn versioned_cache_name(name: &str) -> String {
    format!("v{CACHE_VERSION}_{name}")
}

#[cfg(test)]
mod cache_version_tests {
    use super::*;

    /// ★ 缓存文件名必须带版本号（改解析规则 → 换文件名 → 旧结论读不到）
    #[test]
    fn cache_names_carry_the_version() {
        assert_eq!(versioned_cache_name("forge_builds_1.20.1.json"), "v2_forge_builds_1.20.1.json");
        assert!(versioned_cache_name("x").starts_with(&format!("v{CACHE_VERSION}_")));
    }
}

/// 单个加载器清单请求的总时长上限。
///
/// ★ 为什么需要它：`get_text` 的重试与 `reqwest` 都只管"能不能连上"
///   （connect_timeout），不管"连上之后会不会一直挂着"。
///   实测 BMCLAPI 的边缘节点能做到"TCP 通、TLS 完成、然后一个字节都不回" ——
///   没有这层超时，界面上就是"正在查在线清单…"转到天荒地老（用户报过）。
///
/// ★ 为什么是 75 秒（实测调出来的）：一次查询内部其实有**两轮**尝试
///   （镜像源 3 次重试 + 官方源 3 次重试，每次带指数退避），
///   国内网络抖动时单轮就可能十秒级。设 30 秒会在"并行拉五个来源"时误杀
///   Fabric（实测：单独跑 4.5 秒成功，五个并行时连接池竞争导致超 30 秒被砍）。
///   用 `IEML_LOADER_TIMEOUT_SECS` 可以在网络特别差时再放宽。
pub fn loader_fetch_timeout() -> Duration {
    let secs = std::env::var("IEML_LOADER_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n >= 5 && *n <= 600)
        .unwrap_or(75);
    Duration::from_secs(secs)
}

/// 给一个 future 套上总超时，超时转成明确的错误文案（而不是笼统的"网络错误"）。
pub async fn with_timeout<T>(
    what: &str,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    with_timeout_secs(what, loader_fetch_timeout().as_secs(), fut).await
}

/// 同上，但**显式指定秒数**。
///
/// ★ 为什么需要"每个来源用自己的超时"（用户报的"清单查得慢、还连不上"）：
///   原来五个来源共用 75 秒。而它们的真实耗时差三个数量级 ——
///   NeoForge 的按版本接口实测 **87~632 ms**，却可以和"整片挂住的 BMCLAPI"
///   一样享受 75 秒的宽限。于是一条挂住的连接就能把总时长拖到 75 秒，
///   而其余四条路早就成功了。
///
///   按来源给超时（数字见 `modloader::fetch_available_loaders` 的表格）之后，
///   最坏情况从 75 秒降到 20 秒，而实测耗时离这些上限还有 20~100 倍余量。
pub async fn with_timeout_secs<T>(
    what: &str,
    secs: u64,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let limit = Duration::from_secs(secs.max(1));
    match tokio::time::timeout(limit, fut).await {
        Ok(r) => r,
        Err(_) => Err(NetError::Other(format!(
            "拉取{what}超过 {} 秒仍未完成（连接建立后没有数据回来）；\
             可以直接重试，或用环境变量 IEML_LOADER_TIMEOUT_SECS 放宽超时",
            limit.as_secs()
        ))),
    }
}

/// 取文本：**先试用户选的源，再试另一个**。
///
/// ★ 为什么元数据也要多源：这些清单只有几 KB 到几百 KB，但它们是**一切的前提**
///   —— 清单拉不到，整个"下载"页就是空白。实测 BMCLAPI 的 CDN 边缘节点偶尔会
///   整片挂住（连接建立、迟迟不回数据），这时另一条路（官方源）往往立刻就通。
///
/// 顺序由 `preferred` 决定；`mirror_url` 负责把官方 URL 改写成镜像 URL。
/// 两个 URL 相同时只试一次（没有镜像的域，如 meta.fabricmc.net）。
///
/// ★★ 两条路之间**错峰竞速**（PCL2 的 `DlSourceLoader` 做法）。
///
///   原来是**串行**：第一条路失败（或挂到超时）之后才试第二条。这意味着
///   一条挂住的连接会把总时长拖到"第一条的超时 + 第二条的耗时"——
///   而第二条其实早就可以开始。实测里那个"清单查得慢、甚至查不出来"
///   就是这么来的：BMCLAPI 挂住 → 等满超时 → 官方源又慢 → 用户看到报错。
///
///   现在备路在 `MIRROR_STAGGER` 之后**自动起步**，谁先成功用谁，另一条立刻取消：
///     · 快源不受影响（它在 stagger 之前就成功了，备路那次请求根本不会发出）；
///     · 慢源/挂住的源最多让用户多等 `MIRROR_STAGGER`。
///
/// ★ 为什么不是在 `fetch_available_loaders` 里对五个来源统一错峰：
///   那五个来源的"备路"内容各不相同（镜像地址就在 `mirror_url` 里），
///   而错峰只有对"同一份数据的两个地址"才有意义 —— 放这里刚好。
pub async fn get_text_via(url: &str, preferred: Source) -> Result<String> {
    let official = url.to_string();
    let mirrored = super::mirror::mirror_url(url, Source::Bmclapi);
    let (first, second) = match preferred {
        Source::Bmclapi => (mirrored, official),
        Source::Mojang => (official, mirrored),
    };

    // 没有镜像变体（两个 URL 相同）→ 只有一条路，直接走，不需要竞速
    if second == first {
        return get_text(&first).await;
    }

    let what = first.clone();
    let f1 = first.clone();
    let f2 = second.clone();
    let raced = super::race_with_stagger(
        &format!("清单 {first}"),
        async move { get_text(&f1).await },
        async move { get_text(&f2).await },
        Some(MIRROR_STAGGER),
    )
    .await;

    match raced {
        Ok(t) => Ok(t),
        Err(e) => {
            say!("[IEML/meta] {what} 两条路都失败：{e}");
            Err(e)
        }
    }
}

/// 主路与备路之间的错峰时长。
///
/// ★ 1.5 秒的依据：实测这些清单接口正常都在 **0.1~0.9 秒**返回，
///   1.5 秒之后主路还没回来，基本可以断定它今天不行了 ——
///   而备路这时候起步，总时长最多是"备路的耗时 + 1.5 秒"，
///   远好于串行的"主路超时 + 备路耗时"。
///
/// ★ 不能太短：太快就等于两个请求一起发，那又回到了"同时开多条连接
///   互相饿死"的老问题（实测并行 5 个请求会让本可 4.5 秒完成的查询超 30 秒）。
const MIRROR_STAGGER: Duration = Duration::from_millis(1500);

/// 读缓存；存在且满足 `accept(age)` 时返回。
async fn read_cache_if<T>(file: &Path, accept: impl Fn(Duration) -> bool) -> Result<Option<T>>
where
    T: serde::de::DeserializeOwned,
{
    let meta = match tokio::fs::metadata(file).await {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let age = meta
        .modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .unwrap_or(Duration::MAX);
    if !accept(age) {
        return Ok(None);
    }
    let bytes = match tokio::fs::read(file).await {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

/// 拉 maven-metadata.xml 并解析版本列表，带缓存（缓存解析后的 Vec<String>）。
///
/// ★ 空清单不写缓存：一个"镜像抽风返回了空 XML"的响应如果被缓存住，
///   接下来 5 分钟里所有查询都会拿到空 —— 这正是"启动器说没有加载器"的来源之一。
async fn cached_maven_versions(key: &str, url: &str, ttl: Duration) -> Result<Vec<String>> {
    let Some(dir) = CACHE_DIR.get() else {
        let xml = get_text(url).await?;
        let versions = parse_maven_metadata_versions(&xml);
        if versions.is_empty() {
            return Err(NetError::Other(format!("{url} 里没有任何 <version>")));
        }
        return Ok(versions);
    };
    let cache_file = dir.join(key);

    if let Ok(Some(v)) =
        read_cache_if::<Vec<String>>(&cache_file, |age| age < ttl).await
    {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    match get_text(url).await {
        Ok(xml) => {
            let versions = parse_maven_metadata_versions(&xml);
            if versions.is_empty() {
                return Err(NetError::Other(format!("{url} 里没有任何 <version>")));
            }
            if let Ok(bytes) = serde_json::to_vec(&versions) {
                let _ = tokio::fs::write(&cache_file, bytes).await;
            }
            Ok(versions)
        }
        Err(e) => {
            if let Ok(Some(v)) = read_cache_if::<Vec<String>>(&cache_file, |_| true).await {
                if !v.is_empty() {
                    return Ok(v);
                }
            }
            Err(e)
        }
    }
}

/// 带缓存的**文本**列表（Fabric / Quilt 的 loader 清单是 590KB 的 JSON 数组）。
///
/// 与 `cached_list` 的分工：这个走 `get_text_via`（**两源回退**），
/// 适合"拉不到就没有替代品"的清单；`cached_list` 走单 URL，适合有多个候选
/// API 的场景（Forge 就是那样，候选由调用方按可靠性排序）。
async fn cached_text_list<T>(key: &str, url: &str, preferred: Source) -> Result<T>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let Some(dir) = CACHE_DIR.get() else {
        let text = get_text_via(url, preferred).await?;
        return serde_json::from_str(&text)
            .map_err(|e| NetError::Other(format!("解析 {url} 失败：{e}")));
    };
    // ★ 文件名带 `CACHE_VERSION`：解析规则一改，旧结论就再也读不到
    let cache_file = dir.join(versioned_cache_name(key));
    // ★ 大清单用 12 小时的 TTL（见 LOADER_LIST_TTL 的说明）：
    //   这些接口是 590 KB / 892 KB 级别的，5 分钟一刷就是"查询太慢"的来源。
    if let Ok(Some(v)) = read_cache_if::<T>(&cache_file, |age| age < LOADER_LIST_TTL).await {
        return Ok(v);
    }
    match get_text_via(url, preferred).await {
        Ok(text) => {
            let v: T = serde_json::from_str(&text)
                .map_err(|e| NetError::Other(format!("解析 {url} 失败：{e}")))?;
            if let Ok(bytes) = serde_json::to_vec(&v) {
                let _ = tokio::fs::write(&cache_file, bytes).await;
            }
            Ok(v)
        }
        Err(e) => {
            if let Ok(Some(v)) = read_cache_if::<T>(&cache_file, |_| true).await {
                return Ok(v);
            }
            Err(e)
        }
    }
}

/// 拉一份 JSON 列表并缓存 —— **带内容校验**。
///
/// ★ 与 `cached_json` 的关键差别：**校验不过的内容永不写缓存**。
///   曾经把 BMCLAPI 那份"停更于 2022-02、最新只到 1.18"的 Forge
///   maven-metadata 当成有效结果缓存 30 分钟，于是"明明有 Forge 最新版，
///   启动器说没有"。这类"HTTP 成功但内容没用"的响应只能靠**内容校验**发现
///   （见 `forge_versions`），一旦判定无效就绝不落盘。
///
/// `validate` 返回 false 时：新鲜缓存会被删掉重拉；网络结果会被当成错误，
/// 从而触发调用方的下一候选源。
/// 取一份带缓存的 JSON（公开版，给 `net::liteloader` 用）。
///
/// 抽出来是因为 `cached_list` 是私有的，而 LiteLoader 的版本清单
/// 需要**完全相同的**"带缓存 + 内容校验 + 无效不落盘"语义 ——
/// 那套语义是踩过坑（BMCLAPI 的 Forge maven-metadata 停更）才写出来的，
/// 不能在别处再写一份。
pub async fn fetch_cached_json(
    key: &str,
    url: &str,
    ttl: Duration,
) -> Result<serde_json::Value> {
    cached_list::<serde_json::Value>(key, url, ttl, |v| {
        // 有效判据：必须是对象，而且有 `versions` 这个键
        // （LiteLoader 的清单就是这个形状；空对象/错误页面会被挡下）
        v.get("versions").map(|x| x.is_object()).unwrap_or(false)
    })
    .await
}

async fn cached_list<T>(
    key: &str,
    url: &str,
    ttl: Duration,
    validate: impl Fn(&T) -> bool,
) -> Result<T>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let Some(dir) = CACHE_DIR.get() else {
        let v: T = get_json(url).await?;
        if !validate(&v) {
            return Err(NetError::Other(format!("{url} 返回的内容不可用")));
        }
        return Ok(v);
    };
    // ★ 同样带 `CACHE_VERSION`（见 `versioned_cache_name` 的说明）
    let cache_file = dir.join(versioned_cache_name(key));

    if let Ok(Some(v)) = read_cache_if::<T>(&cache_file, |age| age < ttl).await {
        if validate(&v) {
            return Ok(v);
        }
        // 旧缓存本身可疑（比如上次就存了一份截断的清单）→ 删掉重拉
        let _ = tokio::fs::remove_file(&cache_file).await;
    }
    match get_json::<T>(url).await {
        Ok(v) if validate(&v) => {
            if let Ok(bytes) = serde_json::to_vec(&v) {
                if let Some(p) = cache_file.parent() {
                    let _ = tokio::fs::create_dir_all(p).await;
                }
                let _ = tokio::fs::write(&cache_file, bytes).await;
            }
            Ok(v)
        }
        Ok(_) => Err(NetError::Other(format!(
            "{url} 返回的清单不完整（可能被镜像截断）"
        ))),
        Err(e) => {
            if let Ok(Some(v)) = read_cache_if::<T>(&cache_file, |_| true).await {
                if validate(&v) {
                    return Ok(v);
                }
            }
            Err(e)
        }
    }
}

/* ====================== 版本清单 ====================== */

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub release_type: String,
    pub url: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub release_time: String,
    #[serde(default)]
    pub sha1: String,
}

pub async fn fetch_manifest(source: Source) -> Result<VersionManifest> {
    let url = super::mirror::version_manifest_url(source);
    // ★ 清单是"一切的前提"：拉不到，下载页就是空白。
    //   所以这里用**两源**拉取（先用户选的，再另一个），成功后再缓存。
    //
    // ★★ 缓存 key 必须带源。踩过的同类坑：只按固定文件名缓存的话，
    //   用户先用了 BMCLAPI、再切到 Mojang，30 分钟内拿到的仍然是第一份 ——
    //   "换了源却没换数据"，与"选了源却不起作用"是同一种错。
    let key = format!("version_manifest_{}.json", source.as_str());
    let Some(dir) = CACHE_DIR.get() else {
        let text = get_text_via(&url, source).await?;
        return serde_json::from_str(&text)
            .map_err(|e| NetError::Other(format!("解析版本清单失败：{e}")));
    };
    let cache_file = dir.join(&key);
    if let Ok(Some(v)) = read_cache_if::<VersionManifest>(&cache_file, |age| age < META_TTL).await {
        return Ok(v);
    }
    match get_text_via(&url, source).await {
        Ok(text) => {
            let v: VersionManifest = serde_json::from_str(&text)
                .map_err(|e| NetError::Other(format!("解析版本清单失败：{e}")))?;
            if let Ok(bytes) = serde_json::to_vec(&v) {
                let _ = tokio::fs::write(&cache_file, bytes).await;
            }
            Ok(v)
        }
        Err(e) => {
            // 两个源都失败 → 用旧缓存，总比一片空白好
            if let Ok(Some(v)) = read_cache_if::<VersionManifest>(&cache_file, |_| true).await {
                say!("[IEML/meta] 两个源都拉不到版本清单，用旧缓存（可能是过期的）");
                return Ok(v);
            }
            Err(e)
        }
    }
}

/* ====================== 版本详情 ====================== */

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionJson {
    pub id: String,
    #[serde(default)]
    pub inherits_from: Option<String>,
    #[serde(rename = "type", default)]
    pub release_type: String,
    #[serde(default)]
    pub main_class: String,
    #[serde(default)]
    pub assets: String,
    #[serde(default)]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default)]
    pub downloads: Option<VersionDownloads>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    /// 新版参数格式
    #[serde(default)]
    pub arguments: Option<GameArguments>,
    /// 旧版参数格式（1.12 及以前）
    #[serde(default)]
    pub minecraft_arguments: Option<String>,
    #[serde(default)]
    pub java_version: Option<JavaVersionReq>,
    #[serde(default)]
    pub logging: Option<serde_json::Value>,
    #[serde(default)]
    pub compliance_level: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIndexRef {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub sha1: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub total_size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionDownloads {
    #[serde(default)]
    pub client: Option<DownloadRef>,
    #[serde(default)]
    pub server: Option<DownloadRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DownloadRef {
    pub url: String,
    #[serde(default)]
    pub sha1: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersionReq {
    #[serde(default)]
    pub component: String,
    #[serde(default)]
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<LibraryDownloads>,
    /// **maven 风格的下载基址**（Fabric / Quilt 的 profile JSON 用这个）。
    ///
    /// ★ 实测踩过：Fabric 的 profile 里，`net.fabricmc:fabric-loader:0.19.5`
    ///   这一条**没有 `downloads` 字段**，只有
    ///   `"url": "https://maven.fabricmc.net/"` + `name` 坐标。
    ///   而我们的下载规划只认 `downloads.artifact`，整条被跳过 →
    ///   Fabric 的库一个都没下 → 启动时报
    ///   `ClassNotFoundException: net.fabricmc.loader.impl.launch.knot.KnotClient`。
    ///
    ///   真正的地址是 `<url><maven_path>`（maven 布局），见 `library_url`。
    #[serde(default)]
    pub url: Option<String>,
    /// 平台规则；为空表示全平台可用
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// 需要解压的本地库
    #[serde(default)]
    pub natives: HashMap<String, String>,
    /// 老版本用的服务端专用库标记
    #[serde(default)]
    pub clientreq: Option<bool>,
    #[serde(default)]
    pub extract: Option<ExtractRule>,
}

impl Library {
    /// 这条库该从哪个 URL 下。
    ///
    /// 三种写法都要认（现实里三种都存在），但**第四种必须拒绝**：
    ///   ① `downloads.artifact.url` 非空 —— Mojang 的新格式，直接用
    ///   ② 库上有 `url` 基址 —— Fabric / Quilt / 部分 Forge，拼 maven 布局
    ///   ③ 两者都没有 —— 老版本 JSON 常见，用 `libraries.minecraft.net` 兜底
    ///   ④ **`downloads.artifact` 在、但 `url` 是空串 → 返回 `None`（不可下载）**
    ///
    /// ## ④ 是实测抓到的一个真故障
    ///
    ///   Forge 56+ 的版本 JSON 里有这么一条（26.1.2-64.1.3 的真实内容）：
    ///   ```json
    ///   { "name": "net.minecraftforge:forge:26.1.2-64.1.3:client",
    ///     "downloads": { "artifact": {
    ///         "path": "net/minecraftforge/forge/26.1.2-64.1.3/forge-26.1.2-64.1.3-client.jar",
    ///         "url":  "",                       ← 空！
    ///         "sha1": "2c0a98a0…", "size": 77124153 } } }
    ///   ```
    ///   这个 77 MB 的 client jar **不是下载来的** —— 它是 Forge 安装器的
    ///   processor 拿原版 jar 打补丁**本地生成**的。所以它没有 URL。
    ///
    ///   而原来的代码在 `url` 为空时会拿着 maven 坐标**拼一个地址出来**
    ///   （`https://libraries.minecraft.net/net/minecraftforge/forge/…-client.jar`）
    ///   —— 那个地址**不存在**（实测全 404）。
    ///   后果有两层：
    ///     · 启动检查把这条算成"缺失的库"，于是**一个装好的 Forge 版本永远
    ///       被拦在启动之前**，报"缺 1 个库文件"，用户重装几次都消不掉；
    ///     · "缺什么补什么"的自愈会一次次去下那个 404，永远补不上。
    ///
    ///   `downloads` 存在 = 这份元数据**自带下载信息**，那就以它为准：
    ///   `url` 为空就是"没有远程地址"，不要替它编一个。
    pub fn download_url(&self) -> Option<String> {
        if let Some(u) = self
            .downloads
            .as_ref()
            .and_then(|d| d.artifact.as_ref())
            .map(|a| a.url.clone())
            .filter(|u| !u.is_empty())
        {
            return Some(u);
        }
        // ★ 自带 downloads 却没有 url → 本地产物（Forge processor 生成的），编不出来
        if self
            .downloads
            .as_ref()
            .and_then(|d| d.artifact.as_ref())
            .is_some()
        {
            return None;
        }
        let rel = maven_path(&self.name)?;
        match self.url.as_deref().filter(|u| !u.is_empty()) {
            // maven 基址不一定带结尾斜杠，统一补上再拼
            Some(base) => Some(format!("{}/{rel}", base.trim_end_matches('/'))),
            None => Some(format!("https://libraries.minecraft.net/{rel}")),
        }
    }

    /// ★★ **这条库真的有一个"主 jar"要下载吗？**
    ///
    /// 这是用户报「1.12.2 装不下来」的真凶。
    ///
    /// ## 问题出在哪
    ///
    /// 1.12.2 的原版 JSON 里有这么一条（实测从 BMCLAPI 拉的真实数据）：
    /// ```json
    /// { "name": "net.java.jinput:jinput-platform:2.0.5",
    ///   "downloads": { "classifiers": { "natives-windows": { … },
    ///                                  "natives-linux":   { … },
    ///                                  "natives-osx":     { … } } },
    ///   "natives": { "windows": "natives-windows", … },
    ///   "extract": { "exclude": ["META-INF/"] } }
    /// ```
    /// —— 它**没有 `downloads.artifact`**，只有 `classifiers`（三个平台的 natives）。
    /// 也就是说 `net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5.jar`
    /// **这个文件在世界上根本不存在**（实测：Mojang 官方、BMCLAPI、
    /// Forge maven、Maven Central **全部 404**；存在的只有
    /// `…-natives-windows.jar`）。
    ///
    /// 而 `download_url()` 的第 ③ 条兜底会拿 maven 坐标**拼一个出来**：
    /// `https://libraries.minecraft.net/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5.jar`
    /// → 404 → 三轮重试 → 整个安装失败。
    ///
    /// 更糟的是：这条路径还会把它**塞进 classpath**（虽然那个文件不存在），
    /// 于是即使忽略下载错误，启动时也会因为 classpath 里有个不存在的 jar 而炸。
    ///
    /// ## 判据
    ///
    /// 有 `downloads` 字段、且 `artifact` 是 `None`
    /// → 这条库**没有主 jar**，不该把它当普通库下载（也不该进 classpath）。
    ///
    /// ★ 为什么**不**看 `classifiers` 是否为空：
    ///   1.12.2 的 jinput-platform 恰好有 classifiers（三个平台的 natives），
    ///   但"有 natives"和"有主 jar"是两件互不相干的事 ——
    ///   参考 Minecraft 官方启动器的做法（classpath 与 natives 是两条独立的列表），
    ///   只要 `artifact` 为空就不该进 classpath。
    ///   而"只有 classifiers、连 natives 字段都没有"的条目极少，
    ///   真遇到时下面那条 `lib.natives.is_empty() → continue` 会兜住。
    ///
    /// ★ 反过来，`downloads` 字段**整个缺失**（Fabric 的写法）时要返回 true ——
    ///   那不是"没有主 jar"，而是"用另一种方式写地址"（`url` 基址 + 坐标）。
    pub fn has_artifact(&self) -> bool {
        match &self.downloads {
            None => true,
            Some(d) => d.artifact.is_some(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<DownloadRef>,
    #[serde(default)]
    pub classifiers: HashMap<String, DownloadRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExtractRule {
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GameArguments {
    #[serde(default)]
    pub game: Vec<serde_json::Value>,
    #[serde(default)]
    pub jvm: Vec<serde_json::Value>,
}

/* ====================== natives 布局 ====================== */

/// natives 解压到 `<natives>` 的哪一层？返回子目录名（`None` = 直接放根目录）。
///
/// ★ 这是一个**整个世代的变化**，踩过一次真机崩溃：
///
///   老版本（到 1.20.x 那批）的 JVM 参数里通常**没有** natives 相关项，
///   启动器自己补 `-Djava.library.path=<natives>` —— dll 平铺在 natives 根目录即可。
///
///   新版本（实测 26.2 / LWJGL 3.4.1）的版本 JSON 自带：
///   ```text
///   -Djava.library.path=${natives_directory}/java
///   -Djna.tmpdir=${natives_directory}/jna
///   -Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl
///   -Dio.netty.native.workdir=${natives_directory}/netty
///   ```
///   注意指向的是 **`<natives>/java` 这个子目录**。
///   如果仍把 dll 平铺在 natives 根目录，JVM 就不会去那里找 ——
///   实测表现为游戏刚起就崩：
///   `java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。
///
/// 所以：**解压目标必须从版本 JSON 自己声明的位置推导**，不能写死。
///
/// 实现上只看 `java.library.path` 这一条 —— jna / lwjgl / netty 那几条是
/// **库自己的临时目录**（由库自己解压填充），不是 JVM 找 dll 的地方。
pub fn natives_java_subdir(version: &VersionJson) -> Option<String> {
    const PLACEHOLDER: &str = "${natives_directory}";
    const WANT: &str = "-Djava.library.path=";

    let jvm = version.arguments.as_ref()?.jvm.iter().filter_map(|v| v.as_str());
    for raw in jvm {
        // 只看带 java.library.path 的那条；同时要求它用了 natives 占位符，
        // 否则这个路径与我们的 natives 目录无关（可能是别的绝对路径）。
        let Some(rest) = raw.split_once(WANT).map(|(_, r)| r) else {
            continue;
        };
        let Some(after) = rest.strip_prefix(PLACEHOLDER) else {
            continue;
        };
        let after = after.trim_start_matches(['/', '\\']);
        let name = after.split(['/', '\\']).next().unwrap_or("");
        if name.is_empty() {
            return None; // 就是 ${natives_directory} 本身 → 平铺
        }
        return Some(name.to_string());
    }
    None
}

/* ====================== 规则判定 ====================== */

/// 当前平台名（Mojang 用的命名）
pub fn current_os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// 当前架构（Mojang 用的命名）
pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => "x86_64",
    }
}

/// Mojang 在 natives classifier 里用的架构名。
/// 注意：x86_64 在 classifier 里**不带后缀**（就是 `natives-windows`），
/// 所以这里返回空串表示"默认 64 位变体"。
fn arch_token() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => "",
    }
}

/// 这个库坐标是不是 natives（本地库）？
///
/// ★ 现代格式（1.14+）把 natives 做成**独立的库条目**，坐标形如：
///     `org.lwjgl:lwjgl-glfw:3.3.1:natives-windows`
///   而不是老格式那样挂在 `natives` 字段里。1.20.1 实测：`natives` 字段共 0 个，
///   但带 `natives-*` classifier 的库共 12 个。
/// ★★ 这条件**只从坐标**判断它是不是 natives。
///
/// ## 为什么必须有一个"看整个 Library"的版本
///
///   老格式（1.13 及以前）的 natives **坐标里根本看不出来**：
///     `org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209`
///   它没有任何 `natives-` 字样，natives 声明在**字段**上
///   （`natives: {windows: "natives-windows"}` + `downloads.classifiers`）。
///
///   实测踩过（用户报"1.12.2 打不开，崩溃了"）：只按坐标判 →
///     · 那个 22 字节的占位 jar 被塞进 **classpath**；
///     · 真正装着 `lwjgl64.dll` 的 `…-natives-windows.jar`（613 KB）
///       **没有**被登记为"要解压的东西"。
///   于是 natives 目录空着，游戏一启动就死在：
///     `java.lang.UnsatisfiedLinkError: no lwjgl64 in java.library.path`
///
/// ## 所以判定入口请用 `is_native_lib(lib)`，不要直接用这一个
///
///   两个判据（坐标 + 字段）**必须一起问**，否则又会漏掉老格式。
///   为了不让人再漏，这里改名为 `name_looks_native` 并把它标成
///   "只认坐标的那一半"，见下面 `is_native_lib`。
pub fn name_looks_native(coordinate: &str) -> bool {
    let parts: Vec<&str> = coordinate.split(':').collect();
    // ① 现代格式（1.14+）：独立的 natives 库条目，第 4 段是分类器
    if matches!(parts.get(3), Some(c) if c.starts_with("natives-")) {
        return true;
    }
    // ② 有第 4 段时按它判；没有第 4 段时**只有版本段**能提供线索
    //    （例如 `…:lwjgl-platform:2.9.4-nightly-20150209-natives-windows`）
    let tail = parts.get(3).or_else(|| parts.get(2)).copied().unwrap_or("");
    is_native_version_token(tail)
}

/// ★★ **判断一个库条目是不是 natives —— 唯一入口。**
///
/// 两个判据**必须一起问**（任一个单独都不够）：
///   · 坐标：现代格式的 `natives-*` 分类器，或老格式里带分类器的版本段；
///   · 字段：老格式的 `natives: {windows: "natives-windows"}`。
///
/// `net.java.jinput:jinput-platform:2.0.5` 只有第二条成立；
/// `org.lwjgl:lwjgl:3.3.1:natives-windows` 只有第一条成立。
pub fn is_native_lib(lib: &Library) -> bool {
    declares_natives(lib) || name_looks_native(&lib.name)
}

/// 版本段本身是不是 natives 分类器。
///
/// 两种写法都出现过：
///   · 版本段**就是**分类器：`…:lwjgl-platform:2.9.4-nightly-20150209-natives-windows`
///   · 版本段里**含有**分类器（Forge 安装器拼出来的形态）
///
/// 所以用 `contains("natives-")` 而不是 `ends_with` —— 判据是
/// "这一段在声明一个本地库变体"，而不是"它以某个后缀结尾"。
fn is_native_version_token(version: &str) -> bool {
    version.to_lowercase().contains("natives-")
}

/// ★ 这个库条目是不是**声明了 natives**（老格式的 `natives` 字段）。
///
/// 与 `is_native_library`（只看坐标）互补：判"要不要解压"时两个都要问。
/// `net.java.jinput:jinput-platform:2.0.5` 坐标里看不出任何 natives 痕迹，
/// 但它有 `natives: {windows: "natives-windows"}` —— 它的 dll 全靠这一条。
pub fn declares_natives(lib: &Library) -> bool {
    !lib.natives.is_empty()
}

/// 老格式 natives 在磁盘上的相对路径（走 `downloads.classifiers`）。
///
/// `None` = 这个库的 natives 没有当前平台的分类器（**不该**被算成缺失）。
pub fn legacy_natives_relative(lib: &Library) -> Option<String> {
    if lib.natives.is_empty() {
        return None;
    }
    let classifier = legacy_natives_classifier(&lib.natives)?;
    let dl = lib.downloads.as_ref()?;
    // ① 优先用清单里给的 path（最可靠）
    if let Some(c) = dl.classifiers.get(&classifier) {
        if let Some(p) = c.path.as_ref().filter(|p| !p.trim().is_empty()) {
            return Some(p.clone());
        }
    }
    // ② 清单没给 path（Fabric profile 那种）→ 自己按 maven 布局拼
    let base = maven_path(&lib.name)?;
    let stem = base.strip_suffix(".jar")?;
    Some(format!("{stem}-{classifier}.jar"))
}

/// natives 库是否匹配当前平台与**架构**。
///
/// ★ 这里必须精确匹配架构，否则 `natives-windows`、`natives-windows-arm64`、
///   `natives-windows-x86` 会同时被选中 —— 三个变体互相冲突，游戏起不来。
///   （1.20.1 实测：Windows 上这三个变体的 rules 都是 allow windows。）
pub fn native_matches_current_platform(coordinate: &str) -> bool {
    let parts: Vec<&str> = coordinate.split(':').collect();
    let Some(classifier) = parts.get(3) else {
        return false;
    };
    let c = classifier.to_lowercase();

    // ① 操作系统必须匹配
    let os_ok = if c.contains("windows") {
        current_os_name() == "windows"
    } else if c.contains("linux") {
        current_os_name() == "linux"
    } else if c.contains("macos") || c.contains("osx") {
        current_os_name() == "osx"
    } else {
        // 没写平台的（极少见）交给 rules 判定
        true
    };
    if !os_ok {
        return false;
    }

    // ② 架构必须匹配 —— 这是老实现漏掉的一步
    let want = arch_token();
    if c.contains("arm64") {
        // 只有 arm64 机器才用 arm64 变体
        return want == "arm64";
    }
    if c.contains("-x86") {
        // `natives-windows-x86` 是 32 位变体
        return want == "x86";
    }
    // 无架构后缀 = 默认 64 位变体（x86_64 与 arm64 都不该拿它）
    want == ""
}

/// 老格式（1.13 及以前）：natives 挂在 `natives` 字段里，值是 classifier 模板。
/// 这个函数把模板解析成当前平台的 classifier 名字。
///
/// ★★ **没有当前平台的分类器就必须返回 `None`**，绝不能退回到别的平台。
///
///   老实现最后一步是 `.or_else(|| natives.values().next())` ——
///   "随便拿一个"。后果：`ca.weblite:java-objc-bridge` 只有 `natives-osx`，
///   在 Windows 上会被解析成 `natives-osx`，
///   于是启动器去下/去找一个 **macOS 的 dylib 包**，
///   找不到就报"库文件缺失"，用户重装一百次也修不好。
///
///   调用方（`library_is_wanted`）已经先按 `natives.contains_key(当前系统)`
///   过滤过一遍，所以这里的 `None` 是**双保险**：判据可以重复，
///   但"别的平台的东西"绝不能漏进来。
pub fn legacy_natives_classifier(
    natives: &std::collections::HashMap<String, String>,
) -> Option<String> {
    // `current_os_name()` 在 macOS 上返回 "osx"（Mojang 的写法），
    // 与 natives 字段的键一致；老 JSON 里也出现过 "macos"，一并认。
    let base = natives.get(current_os_name()).or_else(|| {
        if current_os_name() == "osx" {
            natives.get("macos")
        } else {
            None
        }
    })?;
    Some(resolve_natives_classifier(base))
}

/// 判定一组 rules 是否允许当前平台。
///
/// Mojang 的语义（**容易搞反**）：
///   * rules 为空 → 允许
///   * 有 rules 时，**最后一条匹配的规则决定结果**（而不是"任一 allow 即允许"）
///   * 没有规则匹配 → **不允许**（默认拒绝）
pub fn rules_allow(rules: &[Rule], features: &HashMap<String, bool>) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    let mut matched_any = false;

    for rule in rules {
        if !rule_matches(rule, features) {
            continue;
        }
        matched_any = true;
        allowed = rule.action == "allow";
    }

    if !matched_any {
        return false;
    }
    allowed
}

fn rule_matches(rule: &Rule, features: &HashMap<String, bool>) -> bool {
    // features 条件：全部要满足
    if let Some(req) = &rule.features {
        for (k, v) in req {
            let actual = features.get(k).copied().unwrap_or(false);
            if actual != *v {
                return false;
            }
        }
    }

    // os 条件
    if let Some(os) = &rule.os {
        if let Some(name) = &os.name {
            if name != current_os_name() {
                return false;
            }
        }
        if let Some(arch) = &os.arch {
            // Mojang 的 "x86" 表示 32 位，但实际值可能是 "x86" 或 "x86_64"
            let arch_matches = match arch.as_str() {
                "x86" => current_arch() == "x86" || current_arch() == "x86_64",
                other => other == current_arch(),
            };
            if !arch_matches {
                return false;
            }
        }
        if let Some(ver) = &os.version {
            // Windows 版本正则；本机是 Win11，用简化匹配
            if current_os_name() == "windows" && ver.contains("^10") {
                // 允许（Win10/11 都匹配）
            }
        }
    }

    true
}

/* ====================== 库路径推导 ====================== */

/// 从 Maven 坐标推导文件名，如
/// `org.ow2.asm:asm:9.5` → `asm-9.5.jar`
/// `net.fabricmc:intermediary:1.20.1` → `intermediary-1.20.1.jar`
pub fn maven_filename(coordinate: &str) -> Option<String> {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let artifact = parts[1];
    let version = parts[2];
    // 有些坐标带 classifier（第 4 段）
    let classifier = parts.get(3).copied();
    // 有些带 @ext 后缀
    let (version, ext) = match version.split_once('@') {
        Some((v, e)) => (v, e),
        None => (version, "jar"),
    };
    Some(match classifier {
        Some(c) => format!("{artifact}-{version}-{c}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    })
}

/// 从 Maven 坐标推导仓库相对路径，如
/// `org.ow2.asm:asm:9.5` → `org/ow2/asm/asm/9.5/asm-9.5.jar`
pub fn maven_path(coordinate: &str) -> Option<String> {
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version_raw = parts[2];
    let (version, _) = match version_raw.split_once('@') {
        Some((v, e)) => (v, e),
        None => (version_raw, "jar"),
    };
    let filename = maven_filename(coordinate)?;
    Some(format!("{group}/{artifact}/{version}/{filename}"))
}

/// natives 的 classifier 键名替换，如 `natives-windows-${arch}`
pub fn resolve_natives_classifier(pattern: &str) -> String {
    pattern
        .replace("${arch}", if current_arch() == "x86" { "32" } else { "64" })
}

/* ====================== 资源索引 ====================== */

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndex {
    #[serde(default)]
    pub objects: HashMap<String, AssetObject>,
    /// ★ 老版本（1.7.10 及以前）的索引里带这个字段：`"virtual": true` 或
    ///   `"map_to_resources": true`，意思是**资源必须按原名铺到游戏目录**，
    ///   而不是只躺在内容寻址的 `objects/<前两位>/<hash>` 里。
    ///   漏掉它的后果：游戏能起来，但**所有贴图与声音全丢**（材质变成紫黑格）。
    ///
    /// `virtual` 是 Rust 关键字，所以用 raw identifier 接住它。
    #[serde(default, rename = "virtual")]
    pub r#virtual: Option<bool>,
    #[serde(default)]
    pub map_to_resources: Option<bool>,
}

impl AssetIndex {
    /// 这份索引要不要"虚拟化"（按原名铺开）？
    ///
    /// `virtual` 与 `map_to_resources` 两个字段在历史版本里都出现过，
    /// 任一个为 true 就必须铺开（PCL2 同样两个都认）。
    pub fn needs_virtual_assets(&self) -> bool {
        self.r#virtual.unwrap_or(false) || self.map_to_resources.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetObject {
    pub hash: String,
    #[serde(default)]
    pub size: u64,
}

/// 资源文件的相对路径：`<前两位>/<完整 hash>`
pub fn asset_rel_path(hash: &str) -> String {
    format!("{}/{}", &hash[..2], hash)
}

/// 虚拟资源目录名：`assets/virtual/<名字>/`。
///
/// ★ 为什么名字要算而不是写死 `legacy`：Mojang 官方启动器与 PCL2 用的规则是
///   **资源索引的 id**（1.6.4 是 `"legacy"`、1.7.10 是 `"1.7.10"`），
///   而 `--assetsIndex` 传的就是同一串。两边必须一致，否则游戏去
///   `assets/virtual/legacy/` 找、我们铺在 `assets/virtual/1.7.10/`，
///   结果还是"没有贴图"。
pub fn virtual_assets_dir_name(index_id: &str) -> String {
    if index_id.is_empty() {
        "legacy".to_string()
    } else {
        index_id.to_string()
    }
}

/* ====================== 加载器清单 ====================== */

/// `/{...}/versions/loader`（**不分 MC 版本**）返回的条目。
///
/// ★ 为什么需要这个形状：`/versions/loader/{mc}` 那份是 **Fabric 397 KB /
///   Quilt 892 KB**（实测 Quilt 要 25~28 秒！），而"不分 MC"的那份只有
///   **30 KB / 144 KB**、0.1~0.9 秒。
///
///   加载器的版本号是**跨 MC 版本共享**的（Quilt 0.31.0-beta.4 对哪个 MC 都是
///   同一个 loader 版本），所以"有哪些加载器版本可选"根本不需要按 MC 各下一份。
///   真正决定"这个 MC 能用哪个"的是**安装时单独请求的 profile JSON** ——
///   那个不缓存、永远现取，所以短列表不会让我们装错东西。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoaderOnlyEntry {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub stable: bool,
}

/// 取 Fabric 可用的 loader 版本（**不分 MC**，小请求）。
///
/// 返回降序（最新在前）。失败时回落到按 MC 的全量接口。
pub async fn fabric_loader_list(source: Source) -> Result<Vec<String>> {
    let url = format!("{FABRIC_META}/versions/loader");
    let key = "fabric_loader_versions.json";
    match cached_text_list::<Vec<LoaderOnlyEntry>>(key, &url, source).await {
        Ok(list) => {
            let mut out: Vec<String> = list
                .into_iter()
                .map(|e| e.version)
                .filter(|v| !v.is_empty())
                .collect();
            out.sort_by(|a, b| crate::domain::loader_trace::compare_version_desc(a, b));
            out.dedup();
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

/// 取 Quilt 可用的 loader 版本（**不分 MC**，小请求）。
pub async fn quilt_loader_list(source: Source) -> Result<Vec<String>> {
    let url = format!("{QUILT_META}/versions/loader");
    let key = "quilt_loader_versions.json";
    match cached_text_list::<Vec<LoaderOnlyEntry>>(key, &url, source).await {
        Ok(list) => {
            let mut out: Vec<String> = list
                .into_iter()
                .map(|e| e.version)
                .filter(|v| !v.is_empty())
                .collect();
            out.sort_by(|a, b| crate::domain::loader_trace::compare_version_desc(a, b));
            out.dedup();
            Ok(out)
        }
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricLoaderEntry {
    pub loader: FabricLoaderVersion,
    #[serde(default)]
    pub intermediary: Option<FabricMavenItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricLoaderVersion {
    pub version: String,
    #[serde(default)]
    pub stable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricMavenItem {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub maven: String,
}

/// 取 Fabric 某个 MC 版本可用的 loader 列表（第一项通常是最新）
pub async fn fabric_loaders(mc_version: &str, source: Source) -> Result<Vec<FabricLoaderEntry>> {
    let url = super::mirror::mirror_url(
        &format!("{FABRIC_META}/versions/loader/{mc_version}"),
        Source::Bmclapi,
    );
    // ★ 实测这个接口返回 590KB、网络差时拉 5.5 秒，必须缓存。
    //   但**不能**因为"上次拉到过"就一直用缓存：加载器清单用 LOADER_TTL。
    //
    // ★★ 缓存 key 必须带 mc_version **和 source**：
    //   老实现只有 `fabric_loaders.json` 一个槽位，任何两个请求都会互相覆盖 ——
    //   用户切一下版本就可能拿到上一个版本的清单（"该有 Forge 的版本没有 Forge"
    //   那类串台就是这么来的）。加 mc 只会让文件多一点，代价可忽略。
    // ★ BMCLAPI 不镜像 Fabric 的全部版本（实测部分老版本回 404），
    //   所以镜像失败时回官方地址再试一次。
    match cached_text_list(&format!("fabric_loaders_{mc_version}.json"), &url, source).await {
        Ok(v) => Ok(v),
        Err(_) => {
            let official = format!("{FABRIC_META}/versions/loader/{mc_version}");
            cached_text_list(
                &format!("fabric_loaders_official_{mc_version}.json"),
                &official,
                Source::Mojang,
            )
            .await
        }
    }
}

/// ★ 关键：Fabric 不自带 installer jar 的运行逻辑，而是给出**一份 profile JSON**，
///   里面已经写好了 mainClass / libraries / arguments。直接用它可以省掉跑安装器。
pub async fn fabric_profile(mc_version: &str, loader_version: &str) -> Result<VersionJson> {
    let url = format!("{FABRIC_META}/versions/loader/{mc_version}/{loader_version}/profile/json");
    get_json(&url).await
}

/// Quilt 的 profile JSON（Quilt Meta 可达，maven 不可达，所以必须用 profile 方式）
pub async fn quilt_profile(mc_version: &str, loader_version: &str) -> Result<VersionJson> {
    let url = format!("{QUILT_META}/versions/loader/{mc_version}/{loader_version}/profile/json");
    get_json(&url).await
}

pub async fn quilt_loaders(mc_version: &str, source: Source) -> Result<Vec<FabricLoaderEntry>> {
    let url = super::mirror::mirror_url(
        &format!("{QUILT_META}/versions/loader/{mc_version}"),
        Source::Bmclapi,
    );
    // ★ BMCLAPI 不镜像 Quilt（实测 `/quilt-meta/...` 一律 404），所以镜像注定失败。
    //   先试镜像（万一以后加了）再回官方 —— 否则每次都要白等退避重试。
    match cached_text_list(&format!("quilt_loaders_{mc_version}.json"), &url, source).await {
        Ok(v) => Ok(v),
        Err(_) => {
            let official = format!("{QUILT_META}/versions/loader/{mc_version}");
            cached_text_list(
                &format!("quilt_loaders_official_{mc_version}.json"),
                &official,
                Source::Mojang,
            )
            .await
        }
    }
}

/// Forge 的推荐版本（promotions_slim.json 里形如
/// `"1.20.1-latest": "47.2.0"`, `"1.20.1-recommended": "47.2.0"`）
pub async fn forge_promotions() -> Result<HashMap<String, String>> {
    let text = get_text(super::mirror::FORGE_PROMOTIONS).await?;
    #[derive(Deserialize)]
    struct P {
        promos: HashMap<String, String>,
    }
    let p: P = serde_json::from_str(&text)
        .map_err(|e| NetError::Other(format!("解析 Forge promotions 失败：{e}")))?;
    Ok(p.promos)
}

/* ====================== OptiFine 版本清单（高清修复） ====================== */

/// BMCLAPI 的 OptiFine 列表接口。
///
/// ★ 为什么不按"官方 downloads 页 + 正则抓 HTML"（那是 PCL2 的老办法）：
///   实测 `https://optifine.net/downloads` 返回 203 KB 的 HTML，结构随页面
///   改版就会失效；而 BMCLAPI 提供的是**结构化 JSON**（78 KB、497 条、
///   覆盖 56 个 MC 版本），并且带 `forge` 字段直接给出兼容的 Forge 要求。
///   少一个 HTML 解析器、少一类维护成本，得到的信息还更多。
const OPTIFINE_LIST: &str = "https://bmclapi2.bangbang93.com/optifine/versionList";

/// OptiFine 列表里的一条原始记录。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OptifineEntry {
    #[serde(default)]
    pub mcversion: String,
    /// 补丁号：正式版如 `I6`、预览版如 `pre4`
    #[serde(default)]
    pub patch: String,
    /// 类型，如 `HD_U`（高清通用版）；老版本可能没有
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub filename: String,
    /// 兼容的 Forge 要求，如 `"Forge 47.2.18"` / `"Forge #2795"` / `"Forge N/A"`
    #[serde(default)]
    pub forge: String,
}

/// 一个可安装的 OptiFine 版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OptifineVersion {
    /// 面向用户的版本号，如 `HD U I6`（预览版 `HD U I6 pre4`）
    pub version: String,
    /// 安装包文件名，如 `OptiFine_1.20.1_HD_U_I6.jar`
    pub filename: String,
    /// 是不是预览版（`pre*`）
    pub preview: bool,
    /// 兼容的 Forge 版本要求（`None` = 无要求 / 不适用）
    pub required_forge: Option<String>,
}

/// 把一条原始记录变成面向用户的版本号（**纯函数，可单测**）。
///
/// 三处要小心（都是实测数据教出来的）：
///   · `patch` 是**裸补丁号**（`I6`），真正可读的版本号在 `filename` 里
///     （`OptiFine_1.20.1_HD_U_I6.jar`）→ 优先用文件名解析，更可靠；
///   · 预览版的 `patch` 是 `pre4`，但文件名是 `preview_OptiFine_1.20.1_HD_U_I6_pre4.jar`
///     → 拼成 `HD U I6 pre4`，用户一眼能看出是哪个正式版的分支；
///   · 老版本（1.12.2 那批）的 `patch` 是 `E3` 这种，类型同样是 `HD_U`。
pub fn optifine_version_of(e: &OptifineEntry) -> Option<OptifineVersion> {
    let file_stem = e
        .filename
        .trim_end_matches(".jar")
        .trim_start_matches("preview_")
        .to_string();
    // `OptiFine_1.20.1_HD_U_I6` → ["OptiFine","1.20.1","HD","U","I6"]
    let parts: Vec<&str> = file_stem.split('_').collect();
    let patch = e.patch.trim();
    let preview = patch.starts_with("pre");

    // 版本号的"类型段"：文件名里 `OptiFine` 与 MC 版本之后的那几段
    let type_and_patch: Vec<&str> = if parts.len() >= 5 && parts[0].eq_ignore_ascii_case("optifine")
    {
        parts[2..].to_vec()
    } else if !e.r#type.is_empty() && !patch.is_empty() {
        vec![e.r#type.as_str(), patch]
    } else {
        Vec::new()
    };

    if type_and_patch.is_empty() {
        return None;
    }

    // `HD_U_I6` → `HD U I6`；末尾若是 `pre4` 则单独摆到后面
    let mut segs: Vec<String> = type_and_patch
        .iter()
        .map(|s| s.replace('_', " "))
        .collect();
    let mut tail = String::new();
    if preview {
        if let Some(last) = segs.last() {
            if last.starts_with("pre") {
                tail = format!(" {last}");
                segs.pop();
            }
        }
    }
    let version = format!("{}{}", segs.join(" "), tail).trim().to_string();
    if version.is_empty() {
        return None;
    }

    Some(OptifineVersion {
        version,
        filename: e.filename.clone(),
        preview,
        required_forge: parse_forge_requirement(&e.forge),
    })
}

/// 解析 `forge` 字段：`"Forge 47.2.18"` → `Some("47.2.18")`；
/// `"Forge #2795"` → `Some("2795")`（老版本用 build 号）；`"Forge N/A"` → `None`。
pub fn parse_forge_requirement(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("Forge").unwrap_or(raw).trim();
    if rest.is_empty() || rest.eq_ignore_ascii_case("n/a") || rest.eq_ignore_ascii_case("na") {
        return None;
    }
    let cleaned = rest.trim_start_matches('#').trim();
    if cleaned.is_empty() || cleaned.eq_ignore_ascii_case("n/a") {
        return None;
    }
    Some(cleaned.to_string())
}

/// 取某个 MC 版本可安装的 OptiFine 版本（**正式版在前，预览版在后**）。
///
/// 返回空列表 = **确认**这个 MC 版本没有 OptiFine（例如 1.20.5+）。
/// 拉取失败返回 `Err` —— 两者在界面上必须分开（ADR-037）。
pub async fn optifine_versions(mc_version: &str) -> Result<Vec<OptifineVersion>> {
    let all = cached_list::<Vec<OptifineEntry>>(
        "optifine_version_list.json",
        OPTIFINE_LIST,
        // 列表变动很慢（OptiFine 更新节奏以月计），但也不能永久缓存
        Duration::from_secs(6 * 60 * 60),
        |v| !v.is_empty() && v.iter().all(|e| !e.mcversion.is_empty()),
    )
    .await?;

    let mut stable: Vec<OptifineVersion> = Vec::new();
    let mut preview: Vec<OptifineVersion> = Vec::new();
    for e in all.iter().filter(|e| e.mcversion == mc_version) {
        let Some(v) = optifine_version_of(e) else {
            continue;
        };
        if v.preview {
            preview.push(v);
        } else {
            stable.push(v);
        }
    }
    // 正式版按补丁号倒序（I6 > I5 > I1），预览版同理
    stable.sort_by(|a, b| optifine_patch_cmp(&b.version, &a.version));
    preview.sort_by(|a, b| optifine_patch_cmp(&b.version, &a.version));
    stable.extend(preview);
    Ok(stable)
}

/// OptiFine 版本号比较：字母段 + 数字段混合（`HD U I10` > `HD U I9`）。
///
/// 直接按字符串比会得到 `I9 > I10`（错的），所以数字段要按数值比。
fn optifine_patch_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| -> Vec<(u8, u64)> {
        s.split_whitespace()
            .map(|seg| {
                if let Ok(n) = seg.parse::<u64>() {
                    (1u8, n)
                } else {
                    // 字母段：取字母的字节值当排序键（A < B < … < Z）
                    (0u8, seg.bytes().fold(0u64, |acc, c| acc * 31 + c as u64))
                }
            })
            .collect()
    };
    key(a).cmp(&key(b))
}

/* ====================== Forge / NeoForge 版本清单 ====================== */

/// 一条 Forge build 记录的原始形态（BMCLAPI 的 `/forge/minecraft/{mc}`）。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BmclForgeBuild {
    /// Forge 自身的版本号，如 `47.4.23`（**不含** MC 前缀，与安装器 URL 一致）
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mcversion: String,
    /// 构建分支。老版本会用它当**产物名的后缀**（见 `forge_artifact_version`）。
    #[serde(default)]
    pub branch: Option<String>,
    /// 这个 build 提供的文件（`category` = `installer` / `universal` / `client` …）。
    ///
    /// ★ 用途：判断"这个 build 到底能不能装"。PCL2 正是靠它分类的
    ///   （`ModDownload.vb:753-778`）：1.6.1 部分版本只有 `universal.zip`，
    ///   1.3.2 只有 `client.zip`，更早的甚至什么都没有（PCL 直接 `Continue For` 跳过）。
    ///   我们以前不看这个字段 —— 于是会把"只有源码包"的 build 也列出来给用户选。
    #[serde(default)]
    pub files: Vec<BmclForgeFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BmclForgeFile {
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub format: String,
}

impl BmclForgeBuild {
    /// ★★ 这个 build 的**产物版本名**（= maven 目录名 = 安装器文件名里那一段）。
    ///
    /// 源码事实（PCL2 `DlForgeVersionEntry.New`，`ModDownload.vb:630-640`）：
    /// ```vb
    /// If Branch Is Nothing AndAlso Inherit = "1.7.10" AndAlso Version.Split(".")(3) >= 1300 Then Branch = "1.7.10"
    /// FileVersion = Version & If(Branch Is Nothing, "", "-" & Branch)
    /// ```
    ///
    /// 也就是说 **1.7.10 的产物名要带分支后缀**：
    ///   maven 里的目录叫 `1.7.10-10.13.4.1614-1.7.10`，
    ///   文件叫 `forge-1.7.10-10.13.4.1614-1.7.10-installer.jar`。
    /// 我们以前只用 `version`（`10.13.4.1614`）去拼 URL —— 实测 **404**，
    /// 于是 1.7.10 上"列得出来、装不上"，用户看到的就是"安装失败"。
    ///
    /// 实测（2026-09-13，maven-metadata.xml 3839 条）：
    ///   * `1.7.10-10.13.4.1614-1.7.10` → HTTP 200 ✅
    ///   * `1.7.10-10.13.4.1614`        → HTTP 404 ❌（目录不存在）
    ///   * `1.12.2-14.23.5.2864`        → HTTP 200 ✅（这里 branch 就是 `1.12.2`，
    ///     但产物名**不带**它 —— 所以不能无脑拼 branch）
    ///
    /// 判据就照 PCL2 的：只有 **1.7.10 且 build ≥ 1300** 这一批需要后缀。
    pub fn artifact_version(&self) -> String {
        let v = self.version.trim();
        let branch = self.branch.as_deref().map(str::trim).unwrap_or("");
        // 分支已经在版本号里了（`10.13.3.1401-1710ls`）→ 不要重复拼
        if !branch.is_empty() && !v.contains('-') {
            // PCL2 的规则：1.7.10 且第 4 段 ≥ 1300 时产物名带 `-1.7.10`
            //
            // ★ 比对也要归一：接口把预发布版本的 `mcversion` 回成
            //   `1.7.10_pre4`（下划线），而展示用的是 `1.7.10-pre4`。
            if self.mcversion == "1.7.10" || self.mcversion == "1.7.10_pre4" {
                let build: u64 = v.split('.').nth(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                if build >= 1300 {
                    return format!("{v}-{branch}");
                }
            }
        }
        v.to_string()
    }

    /// 这个 build 有可安装的产物吗（安装器 jar / universal zip / client zip 任一）？
    ///
    /// ★ 空 `files` 也要放行（接口没给这个字段时不能因此把整批判死）。
    pub fn is_installable(&self) -> bool {
        if self.files.is_empty() {
            return true;
        }
        self.files.iter().any(|f| {
            matches!(f.category.as_str(), "installer" | "universal" | "client")
                && matches!(f.format.as_str(), "jar" | "zip")
        })
    }
}

/// 这个版本号能不能拿来装？
///
/// ★ 为什么不能只判"以数字开头"（实测数据教会我们的事）：
///   Forge 老版本的 build API 里混着一堆**非版本尾巴**，例如
///   `1710ls`、`srg`、`universal` 之类的构建变体。判据取"**至少含一个 `.`**"：
///     · `47.4.23` / `10.13.4.1614` / `9.11.1.965`  → 通过
///     · `1710ls` / `srg` / `universal`            → 丢掉（没有点）
///
/// ★★ 含 `-` 的**不再丢掉** —— 这是修的一个真 bug：
///   1.7.10 的真实产物名是 `10.13.4.1614-1.7.10`（`-1.7.10` 是构建分支）。
///   后缀由 `artifact_version()` 决定，这里只做"像不像版本号"的粗筛，
///   真正的"能不能下"由安装时确认（`fetch_or_probe`）。
fn is_installable_forge_version(v: &str) -> bool {
    v.contains('.') && !v.contains('+') && !v.contains(' ')
}

/// 从 BMCLAPI 的 Forge build 列表里挑出可安装的版本号（**纯函数，可单测**）。
///
/// ★ 为什么不能直接用 maven-metadata.xml 过滤前缀（这是用户报的 bug 根因）：
///   BMCLAPI 的 `maven/net/minecraftforge/forge/maven-metadata.xml` 是
///   **2022 年 2 月就停更的旧文件**（实测 `lastUpdated=20220221144517`），
///   里面最新的 MC 版本只到 1.18。于是查询 1.20.1 / 1.21.4 时过滤结果是
///   **空数组**，而空数组在 UI 上的语义是"**确认**该加载器没有这个版本" ——
///   启动器据此把 Forge 置灰并说"没有 Forge 版本"，而 Forge 其实早就有。
///   只有 Forge 官方的 build API（BMCLAPI 有镜像）才带 1.20.1-47.4.x 这些新版本。
///
/// ★ 返回的是**产物版本名**（`artifact_version()`），不是原始 `version` ——
///   1.7.10 那批必须带 `-1.7.10` 后缀才能下载（见 `artifact_version` 的说明）。
///
/// ★ 返回**降序**（最新在前）：UI 的第一项就是推荐项，不需要再排一次。
///
/// 关于 `branch` 字段：Forge 的 build API 会给早期 NeoForge（1.20.1 时代的
/// `1.20.1-47.1.x`）打上 `branch`。当下不据此过滤 —— 那批 build 仍可从 Forge
/// 的 maven 安装，而"加载器种类"的判定归 `domain::loader_trace::LoaderFlavor` 管
/// （按库坐标判，不看版本号猜）。
pub fn forge_build_versions(
    builds: &[BmclForgeBuild],
    mc_version: &str,
    limit: usize,
) -> Vec<String> {
    let mut out: Vec<String> = builds
        .iter()
        // ★ 比对也要用**接口侧的写法**：接口把 `mcversion` 回成 `1.7.10_pre4`，
        //   而用户选的是 `1.7.10-pre4`（版本清单里的正式写法）。
        //   不归一侧就会"接口有 10 条、我们返回空"。
        .filter(|b| {
            b.mcversion.is_empty() || b.mcversion == mc_version
                || b.mcversion == forge_api_mc_segment(mc_version)
        })
        // 只看接口说"有产物"的 build（1.6.1 及更早有一批什么都没有）
        .filter(|b| b.is_installable())
        .map(|b| b.artifact_version())
        .filter(|v| is_installable_forge_version(v))
        .collect();
    out.sort_by(|a, b| compare_version_desc(a, b));
    out.dedup();
    if limit > 0 {
        out.truncate(limit);
    }
    out
}

/// 取 BMCLAPI 的 Forge build 列表（带缓存）。
///
/// 抽出来是给诊断测试用的：`forge_versions` 里有三层兜底，
/// 直接看它返回什么**无法区分**"接口返回空"与"接口有数据但被我们过滤掉了"——
/// 而这两种情况的修法完全不同。`tests/live_forge_diag.rs` 会把两者并排打印。
pub async fn bmcl_forge_builds(mc_version: &str) -> Result<Vec<BmclForgeBuild>> {
    let api_url = format!(
        "{}/forge/minecraft/{}",
        super::mirror::BMCLAPI_BASE,
        forge_api_mc_segment(mc_version)
    );
    let key = format!("forge_builds_{mc_version}.json");
    cached_list::<Vec<BmclForgeBuild>>(&key, &api_url, LOADER_TTL, |v| {
        // 空列表是**合法**结果：老版本（1.0.0 及更早）确实没有 Forge
        v.iter().all(|b| !b.version.is_empty())
    })
    .await
}

/// BMCLAPI 的 Forge / NeoForge 接口里，MC 版本段怎么写。
///
/// ★★ 源码事实（PCL2 `ModDownload.vb:746`，注释点名了 issue #4057）：
/// ```vb
/// NetRequestByClientRetry("https://bmclapi2.bangbang93.com/forge/minecraft/" &
///     Loader.Input.Replace("-", "_"), RequireJson:=True) '兼容 Forge 1.7.10-pre4，#4057
/// ```
///   预发布版本的 MC 版本号形如 `1.7.10-pre4`，而接口认的是 `1.7.10_pre4`。
///
/// 实测（2026-09-13）：
///   * `/forge/minecraft/1.7.10-pre4` → **0 条**
///   * `/forge/minecraft/1.7.10_pre4` → **10 条**  ✅
///
///   不替换就查不到 —— 界面上就是"这个版本没有 Forge"，而它明明有。
///   官方源的 `index_<mc>.html` 也是同样的替换（`index_1.7.10_pre4.html`）。
///
/// NeoForge 那边实测带 `-` 能通（`26.1-snapshot-1` → 4 条），
/// 但统一走这个函数没有副作用：`-` 只出现在预发布版本号里，
/// 而那些版本的 NeoForge 本来就不存在。
fn forge_api_mc_segment(mc_version: &str) -> String {
    mc_version.replace('-', "_")
}

/// Forge 某个 MC 版本可安装的版本号（降序，最新在前）。
///
/// 候选源按可靠性排序，**任何一个成功就返回**：
///   ① BMCLAPI 的 Forge build API（国内可达，且内容是真的新）
///   ② Forge 官方 maven 的 maven-metadata.xml（直连可能慢，但内容权威）
///   ③ BMCLAPI 的 maven-metadata.xml（内容旧，**只作为最后兜底**）
///
/// 三者全失败才返回 Err —— 而 Err 在 UI 上的语义是"没查到"，
/// 不是"没有这个版本"（见 `commands_real::LoaderList` 的 status 字段）。
pub async fn forge_versions(mc_version: &str) -> Result<Vec<String>> {
    let mut errors: Vec<String> = Vec::new();

    // ① BMCLAPI Forge build API
    match bmcl_forge_builds(mc_version).await {
        Ok(list) => {
            let versions = forge_build_versions(&list, mc_version, 0);
            /*
             * ★ 要分清两种"空"：
             *   · `list.is_empty()` → 接口**明确说**这个 MC 版本没有 Forge
             *                         （1.0.0 这种真没有的版本），可以返回空
             *   · 有数据但过滤后为空 → 接口里有 build、我们却一个都没认出来
             *                         （字段变了 / 解析出问题）—— 这**不能**当成
             *                         "确认没有"，否则界面又会说"Forge 没发布"。
             *                         继续走别的来源，让更有依据的候选说话。
             */
            if !versions.is_empty() || list.is_empty() {
                return Ok(versions);
            }
            errors.push(format!(
                "BMCLAPI 的 Forge 接口返回了 {} 条 build，但没有一条能匹配 {mc_version}（接口字段可能变了）",
                list.len()
            ));
        }
        Err(e) => errors.push(format!("BMCLAPI Forge API：{e}")),
    }

    // ② Forge 官方 maven
    match maven_versions_of(
        &format!("forge_maven_{mc_version}.json"),
        "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
        LOADER_TTL,
    )
    .await
    {
        Ok(all) => {
            let prefix = format!("{mc_version}-");
            let mut out: Vec<String> = all
                .into_iter()
                .filter_map(|v| v.strip_prefix(&prefix).map(|s| s.to_string()))
                .collect();
            out.sort_by(|a, b| compare_version_desc(a, b));
            out.dedup();
            if !out.is_empty() {
                return Ok(out);
            }
            errors.push(format!("Forge 官方 maven 里没有 {mc_version}"));
        }
        Err(e) => errors.push(format!("Forge 官方 maven：{e}")),
    }

    /*
     * ★ 这里原来还有"③ BMCLAPI 的 maven-metadata.xml 兜底"，**已经删掉**。
     *
     *   删的理由是实测的：那个文件 2022-02 就停更（只到 1.18），而 BMCLAPI
     *   对它的响应是**超时**（3 次全部失败，每次要等满 40 秒连接超时）。
     *   留着它的唯一效果是：当 ①② 都不巧失败时，用户要多等 40 秒才看到报错，
     *   而它本来也提供不了 ①② 给不出的信息 —— 一个"兜底"如果从不成功，
     *   就只是纯粹的超时负担。
     *
     *   现在的两个候选已经覆盖了两种情况：
     *     ① BMCLAPI build API（国内快、内容新）—— 正常路径
     *     ② Forge 官方 maven（权威、慢一点）—— 兜底
     */
    Err(NetError::Other(errors.join("；")))
}

/// NeoForge 某个 MC 版本可安装的版本号（降序，最新在前）。
///
/// ★ 走 BMCLAPI 的**按版本接口** `/neoforge/list/{mc}`（实测 87~632 ms、50 KB），
///   而不是把官方 maven 的 63 KB 全量清单（1706 条）下回来再本地过滤 ——
///   后者要 1.7 s 起，而且过滤规则得自己维护（两种世代的前缀）。
///
/// ★★ 归一化很关键（实测踩到的坑）：同一个 MC 版本的列表里会**混着两种格式**：
///   `47.1.5` 与 `1.20.1-47.1.103` —— 后者是同一个 build 但**带 MC 前缀**，
///   而且它其实**更旧**（47.1.5 > 47.1.103 是错的，真实顺序是
///   47.1.5 < 47.1.8 < … < 47.1.103）。直接按字符串数字排序会把
///   `1.20.1-47.1.105` 排到 `47.1.5` 前面 —— 推荐版本就推荐错了。
///   所以先把 MC 前缀剥掉（`1.20.1-47.1.103` → `47.1.103`）再排序、去重。
///
/// 过滤掉 `-beta` / `-alpha` 结尾的（不是可发布的稳定 build）。
pub async fn neoforge_versions_for_mc(mc_version: &str, source: Source) -> Result<Vec<String>> {
    let list = neoforge_builds_for_mc(mc_version).await?;
    let _ = source;
    Ok(neoforge_normalize(
        list.iter().map(|b| b.version.as_str()),
        mc_version,
    ))
}

/// BMCLAPI `/neoforge/list/{mc}` 的一条记录。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BmclNeoforgeBuild {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mcversion: String,
    /// 形如 `neoforge-21.1.1`：NeoForge 自家 maven 的 artifact id
    #[serde(rename = "rawVersion", default)]
    pub raw_version: String,
    /// ★ **服务端自己给的安装器路径**（实测 2026-09-13）。
    ///
    /// 1.20.1 的记录长这样：
    ///   `"/maven/net/neoforged/forge/1.20.1-47.1.105/forge-1.20.1-47.1.105-installer.jar"`
    ///
    /// 这条字段比我们自己拼坐标可靠得多 —— NeoForge 在 1.20.1 段的
    /// 包名是 `forge`（不是 `neoforge`），靠版本号猜总有一天会猜错。
    #[serde(rename = "installerPath", default)]
    pub installer_path: String,
}

impl BmclNeoforgeBuild {
    /// 这个 build 的版本号**归一化后**（剥掉 MC 前缀）的样子。
    pub fn normalized_version(&self, mc_version: &str) -> String {
        let prefix = format!("{mc_version}-");
        self.version
            .trim()
            .strip_prefix(&prefix)
            .unwrap_or(self.version.trim())
            .to_string()
    }

    /// 服务端给的安装器路径 → 完整的 BMCLAPI 下载地址。
    pub fn installer_url(&self) -> Option<String> {
        let p = self.installer_path.trim();
        if p.is_empty() {
            return None;
        }
        if p.starts_with("http://") || p.starts_with("https://") {
            return Some(p.to_string());
        }
        Some(format!(
            "{}{}",
            super::mirror::BMCLAPI_BASE,
            if p.starts_with('/') { p.to_string() } else { format!("/{p}") }
        ))
    }
}

/// 取 BMCLAPI 的 NeoForge 构建列表（带缓存）。
///
/// 抽出来是因为有两个调用方：**列版本**（`neoforge_versions_for_mc`）
/// 和**取安装器地址**（`commands_real::neoforge_installer_url_for`）——
/// 后者要用服务端给的 `installerPath`，不能让两处各写一遍 URL。
pub async fn neoforge_builds_for_mc(mc_version: &str) -> Result<Vec<BmclNeoforgeBuild>> {
    let url = format!(
        "{}/neoforge/list/{}",
        super::mirror::BMCLAPI_BASE,
        forge_api_mc_segment(mc_version)
    );
    let key = format!("neoforge_list_{mc_version}.json");
    cached_list::<Vec<BmclNeoforgeBuild>>(&key, &url, LOADER_LIST_TTL, |v| {
        // 空列表是合法结果：1.20.1 及以前没有 NeoForge 的正式版
        v.iter().all(|b| !b.version.is_empty())
    })
    .await
}

/// 把 NeoForge 版本号列表归一化：剥 MC 前缀 → 去重 → 降序（纯函数，可单测）。
///
/// ★★ **绝对不许过滤 `-beta` / `-alpha`** —— 这是用户报的
///   「有 neoforge 的版本，说没有」的真凶。
///
///   实测（2026-09-13，BMCLAPI `/neoforge/list/{mc}`）：
///   | MC 版本 | 接口条数 | 其中 `-beta` | 我们（旧逻辑）返回 |
///   |---|---|---|---|
///   | 26.2 | 88 | 57 | 31（丢了一大半） |
///   | 26.1 | 18 | **18** | **0 ← 界面说"没有 NeoForge"** |
///   | 1.21.9 | 17 | **17** | **0 ← 同上** |
///   | 1.21.11 | 45 | 42 | 3（只剩 3 个正式版） |
///   | 1.20.6 | 125 | 100 | 25 |
///
///   而 NeoForge 对新 MC 版本的**正常发布流程就是先发 `-beta`**
///   （它长期停留在 beta 阶段，玩家用的就是这些）——
///   把它们丢掉等于"新版本永远没有 NeoForge"。
///
///   所以现在**原样保留**后缀：它既是真实产物名的一部分
///   （`neoforge-26.2.0.87-beta-installer.jar`），也是用户需要知道的信息
///   （"这个版本还是 beta"）。排序时正式版排在预发布前面（见 `compare_version_desc`）。
pub fn neoforge_normalize<'a>(
    versions: impl Iterator<Item = &'a str>,
    mc_version: &str,
) -> Vec<String> {
    let prefix = format!("{mc_version}-");
    let mut out: Vec<String> = versions
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        // ★ 先剥 MC 前缀**再**去重：列表里可能同时有 `26.2.0.87` 与
        //   `1.20.1-47.1.105` 两种写法，不先剥就会留下重复项
        .map(|v| v.strip_prefix(&prefix).unwrap_or(v).to_string())
        .collect();
    out.sort_by(|a, b| compare_version_desc(a, b));
    out.dedup();
    out
}

/// NeoForge 可用版本（**全部** MC 版本混在一起，调用方按前缀过滤）。
///
/// ★ 官方 maven 优先：实测官方与 BMCLAPI 的 maven-metadata.xml 都是 63169 字节、
///   1705 条，内容一致；但 BMCLAPI 多一跳中转，慢的时候要 3.5 秒。
pub async fn neoforge_versions() -> Result<Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    for (key, url) in [
        (
            "neoforge_versions.json",
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
        ),
        (
            "neoforge_versions_bmcl.json",
            "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml",
        ),
    ] {
        match maven_versions_of(key, url, LOADER_LIST_TTL).await {
            Ok(v) if !v.is_empty() => return Ok(v),
            Ok(_) => errors.push(format!("{url} 返回空清单")),
            Err(e) => errors.push(format!("{url}：{e}")),
        }
    }
    Err(NetError::Other(errors.join("；")))
}

/// 带缓存的 maven-metadata.xml 版本列表。
///
/// `ttl` 由调用方给：Forge 传 5 分钟（小清单、更新勤），
/// NeoForge 传 12 小时（63 KB 的大清单、更新慢）。
async fn maven_versions_of(key: &str, url: &str, ttl: Duration) -> Result<Vec<String>> {
    match cached_list::<Vec<String>>(key, url, ttl, |v| !v.is_empty()).await {
        Ok(v) => Ok(v),
        // cached_list 对"内容不可用"（比如小 maven 镜像把 XML 截断了）会报错；
        // 这时再自己拉一次文本解析，能救回被截断但前缀可用的清单。
        Err(_) => cached_maven_versions(&format!("{key}.fallback"), url, ttl).await,
    }
}

/// 从 maven-metadata.xml 里抽出 <version> 列表
pub fn parse_maven_metadata_versions(xml: &str) -> Vec<String> {
    let re = regex::Regex::new(r"<version>([^<]+)</version>").unwrap();
    re.captures_iter(xml)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/* ====================== 路径工具 ====================== */

/// 库文件在共享目录里的存放路径
pub fn library_disk_path(shared_root: &Path, coordinate: &str) -> Option<PathBuf> {
    maven_path(coordinate).map(|rel| shared_root.join("libraries").join(rel))
}

/// 资源文件在共享目录里的存放路径
pub fn asset_disk_path(shared_root: &Path, hash: &str) -> PathBuf {
    shared_root.join("assets").join("objects").join(asset_rel_path(hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_path_from_coordinate() {
        assert_eq!(
            maven_path("org.ow2.asm:asm:9.5").unwrap(),
            "org/ow2/asm/asm/9.5/asm-9.5.jar"
        );
    }

    /* ---------- natives 布局（★ 真机崩溃的回归测试） ---------- */

    fn vj_with_jvm(args: Vec<serde_json::Value>) -> VersionJson {
        VersionJson {
            id: "t".into(),
            inherits_from: None,
            release_type: "release".into(),
            main_class: "net.minecraft.client.main.Main".into(),
            assets: String::new(),
            asset_index: None,
            downloads: None,
            libraries: vec![],
            arguments: Some(GameArguments {
                game: vec![],
                jvm: args,
            }),
            minecraft_arguments: None,
            java_version: None,
            logging: None,
            compliance_level: None,
        }
    }

    /// ★ 回归测试（真实崩溃）：26.2 的版本 JSON 自带
    ///   `-Djava.library.path=${natives_directory}/java` ——
    ///   曾经忽略它、把 dll 平铺在 natives 根目录，结果游戏刚起就崩：
    ///   `UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。
    #[test]
    fn detects_natives_java_subdir_on_modern_versions() {
        let v = vj_with_jvm(vec![
            serde_json::json!("-Djava.library.path=${natives_directory}/java"),
            serde_json::json!("-Djna.tmpdir=${natives_directory}/jna"),
            serde_json::json!("-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl"),
            serde_json::json!("-Dio.netty.native.workdir=${natives_directory}/netty"),
        ]);
        assert_eq!(natives_java_subdir(&v).as_deref(), Some("java"));
    }

    /// 老版本：JVM 参数里没有 natives 项 → 平铺在 natives 根目录（行为不变）
    #[test]
    fn old_versions_have_no_natives_subdir() {
        let v = vj_with_jvm(vec![serde_json::json!("-cp"), serde_json::json!("${classpath}")]);
        assert_eq!(natives_java_subdir(&v), None);

        // 连 arguments 都没有的老格式
        let mut v2 = v;
        v2.arguments = None;
        assert_eq!(natives_java_subdir(&v2), None);
    }

    /// 反斜杠路径（Windows 风格）与"就是 natives 根目录"两种情况都要认
    #[test]
    fn natives_subdir_handles_backslash_and_root() {
        let back = vj_with_jvm(vec![serde_json::json!(
            "-Djava.library.path=${natives_directory}\\java"
        )]);
        assert_eq!(natives_java_subdir(&back).as_deref(), Some("java"));

        let root = vj_with_jvm(vec![serde_json::json!(
            "-Djava.library.path=${natives_directory}"
        )]);
        assert_eq!(natives_java_subdir(&root), None);
    }

    /// 与 natives 无关的绝对路径不能被误当成子目录
    #[test]
    fn ignores_java_library_path_without_placeholder() {
        let v = vj_with_jvm(vec![serde_json::json!("-Djava.library.path=C:\\other\\dir")]);
        assert_eq!(natives_java_subdir(&v), None);
    }

    #[test]
    fn maven_path_with_classifier() {
        assert_eq!(
            maven_path("org.lwjgl:lwjgl:3.3.1:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar"
        );
    }

    #[test]
    fn maven_path_with_extension() {
        assert_eq!(
            maven_path("net.minecraft:client:1.20.1@jar").unwrap(),
            "net/minecraft/client/1.20.1/client-1.20.1.jar"
        );
    }

    #[test]
    fn asset_path_uses_first_two_chars() {
        assert_eq!(
            asset_rel_path("b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356"),
            "b6/b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356"
        );
    }

    #[test]
    fn rules_empty_allows() {
        assert!(rules_allow(&[], &HashMap::new()));
    }

    #[test]
    fn rules_last_match_wins() {
        // allow windows 然后 deny windows → 最终拒绝
        let rules = vec![
            Rule {
                action: "allow".into(),
                os: Some(OsRule {
                    name: Some("windows".into()),
                    arch: None,
                    version: None,
                }),
                features: None,
            },
            Rule {
                action: "disallow".into(),
                os: Some(OsRule {
                    name: Some("windows".into()),
                    arch: None,
                    version: None,
                }),
                features: None,
            },
        ];
        // 注意 Mojang 用 "disallow" 而不是 "deny"
        assert!(!rules_allow(&rules, &HashMap::new()));
    }

    #[test]
    fn rules_no_match_denies() {
        // 只允许 osx 的规则，在 windows 上应该不匹配 → 默认拒绝
        let rules = vec![Rule {
            action: "allow".into(),
            os: Some(OsRule {
                name: Some("osx".into()),
                arch: None,
                version: None,
            }),
            features: None,
        }];
        if cfg!(target_os = "windows") {
            assert!(!rules_allow(&rules, &HashMap::new()));
        }
    }

    #[test]
    fn rules_other_os_allows_on_windows() {
        // 只允许 windows 的规则在 windows 上应该通过
        let rules = vec![Rule {
            action: "allow".into(),
            os: Some(OsRule {
                name: Some("windows".into()),
                arch: None,
                version: None,
            }),
            features: None,
        }];
        if cfg!(target_os = "windows") {
            assert!(rules_allow(&rules, &HashMap::new()));
        }
    }

    #[test]
    fn natives_classifier_arch_replacement() {
        let s = resolve_natives_classifier("natives-windows-${arch}");
        assert!(s.starts_with("natives-windows-"), "{s}");
        assert!(!s.contains("${arch}"));
    }

    #[test]
    fn parse_maven_metadata() {
        let xml = r#"<metadata><versioning><versions>
            <version>21.1.72</version><version>21.1.65</version>
        </versions></versioning></metadata>"#;
        let v = parse_maven_metadata_versions(xml);
        assert_eq!(v, vec!["21.1.72", "21.1.65"]);
    }

    #[test]
    fn detects_native_library_by_classifier() {
        // 现代格式：natives 是独立库条目，第 4 段是分类器
        assert!(name_looks_native("org.lwjgl:lwjgl-glfw:3.3.1:natives-windows"));
        assert!(name_looks_native("org.lwjgl:lwjgl:3.3.1:natives-linux"));
        assert!(name_looks_native(
            "org.lwjgl:lwjgl:3.3.1:natives-macos-arm64"
        ));
        // 没有第 4 段时，版本段自己带分类器也算（Forge 合并出来的形态）
        assert!(name_looks_native(
            "org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209-natives-windows"
        ));
        // 普通库不是
        assert!(!name_looks_native("org.lwjgl:lwjgl-glfw:3.3.1"));
        assert!(!name_looks_native("com.google.guava:guava:31.1-jre"));
    }

    #[test]
    fn native_platform_filter_rejects_other_oses() {
        // 在 Windows 上，linux / macos 的 natives 必须被排除
        if current_os_name() == "windows" {
            assert!(!native_matches_current_platform(
                "org.lwjgl:lwjgl:3.3.1:natives-linux"
            ));
            assert!(!native_matches_current_platform(
                "org.lwjgl:lwjgl:3.3.1:natives-macos"
            ));
            assert!(native_matches_current_platform(
                "org.lwjgl:lwjgl:3.3.1:natives-windows"
            ));
        }
    }

    #[test]
    fn native_arch_filter_picks_exactly_one_variant() {
        // ★ 关键回归测试：Windows 上三个变体只能选中一个。
        //   否则 natives-windows / -arm64 / -x86 会同时被下载解压，dll 冲突。
        let variants = [
            "org.lwjgl:lwjgl:3.3.1:natives-windows",
            "org.lwjgl:lwjgl:3.3.1:natives-windows-arm64",
            "org.lwjgl:lwjgl:3.3.1:natives-windows-x86",
        ];
        let matched: Vec<&&str> = variants
            .iter()
            .filter(|c| native_matches_current_platform(c))
            .collect();
        assert_eq!(
            matched.len(),
            1,
            "在 {} / {} 上应当只选中 1 个变体，实际选中 {} 个：{:?}",
            current_os_name(),
            current_arch(),
            matched.len(),
            matched
        );
    }

    #[test]
    fn legacy_natives_classifier_resolution() {
        let mut natives = std::collections::HashMap::new();
        natives.insert("windows".to_string(), "natives-windows-${arch}".to_string());
        natives.insert("linux".to_string(), "natives-linux".to_string());
        let c = legacy_natives_classifier(&natives).unwrap();
        assert!(!c.contains("${arch}"), "占位符必须被替换：{c}");
        if current_os_name() == "windows" {
            assert!(c.starts_with("natives-windows-"), "{c}");
        }
    }

    /* ---------- 老版本的虚拟资源（★ 用户报的"古老版本会报错"） ---------- */

    /// 索引里写了 virtual / map_to_resources 就必须铺开资源
    #[test]
    fn asset_index_detects_virtual_flag() {
        let v: AssetIndex = serde_json::from_str(r#"{"virtual":true,"objects":{}}"#).unwrap();
        assert!(v.needs_virtual_assets());

        let m: AssetIndex =
            serde_json::from_str(r#"{"map_to_resources":true,"objects":{}}"#).unwrap();
        assert!(m.needs_virtual_assets());

        let modern: AssetIndex = serde_json::from_str(r#"{"objects":{}}"#).unwrap();
        assert!(!modern.needs_virtual_assets());
    }

    /// 虚拟目录名必须与索引 id 一致（否则游戏找不到贴图）
    #[test]
    fn virtual_dir_name_follows_index_id() {
        assert_eq!(virtual_assets_dir_name("legacy"), "legacy");
        assert_eq!(virtual_assets_dir_name("1.7.10"), "1.7.10");
        assert_eq!(virtual_assets_dir_name(""), "legacy");
    }

    /* ---------- natives 识别（1.12.2 真机崩溃的根因） ---------- */

    /// ★★ 老格式（1.13 及以前）的 natives **必须**被认出来。
    ///
    ///   用户报的「1.12.2 打不开，崩溃了」，崩溃日志只有一句：
    ///     `java.lang.UnsatisfiedLinkError: no lwjgl64 in java.library.path:
    ///      …\instances\vanilla-1122\natives`
    ///   而那个目录是**空的**。
    ///
    ///   根因就是下面这个坐标：`org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209`
    ///   坐标里**没有** `natives-` classifier（老格式的 natives 挂在
    ///   `natives` 字段 + `downloads.classifiers` 上），
    ///   所以 `is_native_library` 判它"不是 natives"：
    ///     · 那个 22 字节的占位 jar 被塞进了 **classpath**；
    ///     · 真正装着 `lwjgl64.dll` 的 `…-natives-windows.jar`（613 KB）
    ///       从来没有被登记为"要解压的东西"。
    ///   于是 natives 目录空着，游戏一定崩。
    #[test]
    fn legacy_natives_coordinates_are_recognized() {
        // ① 老格式：坐标里只有 artifact，natives 在字段上 —— 靠 `natives` 字段认
        let legacy: Library = serde_json::from_str(
            r#"{
                "name": "org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209",
                "downloads": {
                    "artifact": {
                        "url": "https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209.jar",
                        "path": "org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209.jar",
                        "size": 22
                    },
                    "classifiers": {
                        "natives-windows": {
                            "url": "https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar",
                            "path": "org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar",
                            "size": 613748
                        }
                    }
                },
                "natives": { "windows": "natives-windows", "linux": "natives-linux", "osx": "natives-osx" }
            }"#,
        )
        .unwrap();
        assert!(declares_natives(&legacy), "有 natives 字段就必须认出来");
        /*
         * ★ 判据必须**看整个 Library**，不能只看坐标。
         *   这个老格式坐标里完全没有 `natives-` 字样 ——
         *   只看坐标必然判成"普通库"，这正是 1.12.2 崩溃的根因。
         */
        assert!(
            is_native_lib(&legacy),
            "老格式的 natives 条目（natives 挂在字段上）必须被认出来"
        );
        assert!(
            !name_looks_native(&legacy.name),
            "这个坐标本身确实看不出来 —— 所以判定必须走 is_native_lib"
        );
        assert!(
            name_looks_native("org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209-natives-windows"),
            "带平台分类器的版本段同样要认（Forge 合并出来的 JSON 是这种形态）"
        );

        // ② 老格式真正要下的那一个 —— **不是** 那个 22 字节的占位 jar
        let rel = legacy_natives_relative(&legacy).expect("windows 上必须能定位到 natives jar");
        assert!(
            rel.ends_with("-natives-windows.jar"),
            "必须指向 natives jar，实际是 {rel}"
        );
        assert!(
            !rel.ends_with("-20150209.jar"),
            "绝不能指向那个 22 字节的占位 artifact"
        );

        // ③ 只有别的平台分类器 → 本平台不该要它（也不该报缺失）
        let osx_only: Library = serde_json::from_str(
            r#"{
                "name": "ca.weblite:java-objc-bridge:1.0.0",
                "downloads": {
                    "artifact": {
                        "url": "https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.0.0/java-objc-bridge-1.0.0.jar",
                        "path": "ca/weblite/java-objc-bridge/1.0.0/java-objc-bridge-1.0.0.jar"
                    },
                    "classifiers": {
                        "natives-osx": {
                            "url": "https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.0.0/java-objc-bridge-1.0.0-natives-osx.jar",
                            "path": "ca/weblite/java-objc-bridge/1.0.0/java-objc-bridge-1.0.0-natives-osx.jar"
                        }
                    }
                },
                "natives": { "osx": "natives-osx" }
            }"#,
        )
        .unwrap();
        assert!(declares_natives(&osx_only));
        if current_os_name() != "osx" {
            assert_eq!(
                legacy_natives_relative(&osx_only),
                None,
                "别的平台的 natives 不该被当成'我们要下的文件'"
            );
        }

        // ④ 现代格式（1.14+）的独立 natives 条目仍然要认
        assert!(name_looks_native("org.lwjgl:lwjgl-glfw:3.3.1:natives-windows"));
        assert!(name_looks_native("org.lwjgl:lwjgl:3.3.1:natives-windows-arm64"));
        // ⑤ 普通库绝不能被误判成 natives（否则它会从 classpath 里消失）
        assert!(!name_looks_native("org.lwjgl:lwjgl:3.3.1"));
        assert!(!name_looks_native("net.minecraft:client:1.12.2"));
        assert!(!name_looks_native("com.mojang:text2speech:1.10.3"));
        // 尤其：`lwjgl-platform` 这种"名字里有 platform 但没有 natives 字样"
        // 的老坐标，坐标判据必须**返回 false**（它靠 natives 字段认）——
        // 否则 `text2speech` 之类会被误杀。
        assert!(!name_looks_native(
            "org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209"
        ));
        assert!(!name_looks_native("ca.weblite:java-objc-bridge:1.0.0"));
    }

    /* ---------- OptiFine（高清修复）版本清单 ---------- */
    fn of(mc: &str, patch: &str, ty: &str, file: &str, forge: &str) -> OptifineEntry {
        OptifineEntry {
            mcversion: mc.into(),
            patch: patch.into(),
            r#type: ty.into(),
            filename: file.into(),
            forge: forge.into(),
        }
    }

    /// 正式版：`OptiFine_1.20.1_HD_U_I6.jar` → `HD U I6`，并且带上 Forge 要求
    #[test]
    fn optifine_parses_stable_release() {
        let e = of(
            "1.20.1",
            "I6",
            "HD_U",
            "OptiFine_1.20.1_HD_U_I6.jar",
            "Forge 47.2.18",
        );
        let v = optifine_version_of(&e).expect("正式版必须能解析");
        assert_eq!(v.version, "HD U I6");
        assert!(!v.preview);
        assert_eq!(v.required_forge.as_deref(), Some("47.2.18"));
    }

    /// 预览版：`preview_OptiFine_1.20.1_HD_U_I6_pre4.jar` → `HD U I6 pre4`
    #[test]
    fn optifine_parses_preview_release() {
        let e = of(
            "1.20.1",
            "pre4",
            "HD_U",
            "preview_OptiFine_1.20.1_HD_U_I6_pre4.jar",
            "Forge 47.1.0",
        );
        let v = optifine_version_of(&e).expect("预览版必须能解析");
        assert_eq!(v.version, "HD U I6 pre4");
        assert!(v.preview, "预览版必须被标出来（用户要知道它不是正式版）");
        assert_eq!(v.required_forge.as_deref(), Some("47.1.0"));
    }

    /// 老版本用 build 号：`Forge #2795` → `2795`
    #[test]
    fn optifine_parses_legacy_forge_build_number() {
        assert_eq!(parse_forge_requirement("Forge #2795").as_deref(), Some("2795"));
        assert_eq!(parse_forge_requirement("Forge 47.2.18").as_deref(), Some("47.2.18"));
        // "不适用" 与空串都是"无要求"
        assert_eq!(parse_forge_requirement("Forge N/A"), None);
        assert_eq!(parse_forge_requirement(""), None);
        assert_eq!(parse_forge_requirement("Forge"), None);
    }

    /// 补丁号排序必须按**数值**：I10 要排在 I9 之后（字符串比会搞反）
    #[test]
    fn optifine_patch_sort_is_numeric_not_lexicographic() {
        let mut v = vec!["HD U I9", "HD U I10", "HD U I1"];
        v.sort_by(|a, b| optifine_patch_cmp(b, a));
        assert_eq!(v, vec!["HD U I10", "HD U I9", "HD U I1"]);
    }

    /// 文件名解析不出来时退回 `type` + `patch`（老版本可能没有标准文件名）
    #[test]
    fn optifine_falls_back_to_type_and_patch() {
        let e = of("1.7.10", "E7", "HD_U", "", "Forge N/A");
        let v = optifine_version_of(&e).expect("有 type+patch 就该能拼出来");
        assert_eq!(v.version, "HD U E7");
    }

    /// 什么都没有 → None（不编造一个版本号）
    #[test]
    fn optifine_gives_up_when_nothing_to_parse() {
        let e = of("1.7.10", "", "", "", "");
        assert_eq!(optifine_version_of(&e), None);
    }

    /* ---------- Forge 版本清单（★ 用户报的"启动器说没有 Forge"） ---------- */
    fn build(v: &str, mc: &str) -> BmclForgeBuild {
        BmclForgeBuild {
            version: v.into(),
            mcversion: mc.into(),
            branch: None,
            // 默认给一个 installer —— 接口真实返回里每条都有产物
            files: vec![BmclForgeFile {
                category: "installer".into(),
                format: "jar".into(),
            }],
        }
    }

    /// 同 `build`，但可以指定分支（1.7.10 的产物名要用它）
    fn build_branch(v: &str, mc: &str, branch: &str) -> BmclForgeBuild {
        BmclForgeBuild {
            version: v.into(),
            mcversion: mc.into(),
            branch: Some(branch.into()),
            files: vec![BmclForgeFile {
                category: "installer".into(),
                format: "jar".into(),
            }],
        }
    }

    /// 没有任何可安装产物的 build 不该列出来
    fn build_only_changelog(v: &str, mc: &str) -> BmclForgeBuild {
        BmclForgeBuild {
            version: v.into(),
            mcversion: mc.into(),
            branch: None,
            files: vec![BmclForgeFile {
                category: "changelog".into(),
                format: "txt".into(),
            }],
        }
    }

    /// ★★ 回归：1.7.10 的产物名**必须带分支后缀**。
    ///
    ///   实测（maven-metadata.xml 3839 条）：
    ///     `1.7.10-10.13.4.1614-1.7.10` → HTTP 200 ✅
    ///     `1.7.10-10.13.4.1614`        → HTTP 404 ❌
    ///   我们以前只输出 `10.13.4.1614`，于是 1.7.10 "列得出来、装不上"。
    ///   PCL2 的对应处理：`DlForgeVersionEntry.New` 里
    ///   `If Branch Is Nothing AndAlso Inherit = "1.7.10" AndAlso Version.Split(".")(3) >= 1300
    ///        Then Branch = "1.7.10"`，再 `FileVersion = Version & "-" & Branch`。
    #[test]
    fn forge_1_7_10_artifact_name_carries_the_branch() {
        let builds = vec![
            build_branch("10.13.4.1614", "1.7.10", "1.7.10"),
            build_branch("10.13.4.1558", "1.7.10", "1.7.10"),
            // 低于 1300 的不加后缀（PCL2 的门槛）
            build_branch("10.13.0.1200", "1.7.10", "1.7.10"),
        ];
        let v = forge_build_versions(&builds, "1.7.10", 0);
        assert!(
            v.contains(&"10.13.4.1614-1.7.10".to_string()),
            "★ 1.7.10 的产物名要带分支后缀，否则下载 404：{v:?}"
        );
        assert!(
            v.contains(&"10.13.0.1200".to_string()),
            "build < 1300 的不加后缀：{v:?}"
        );
        // 排序仍然正确（1614 > 1558 > 1200），后缀不能把顺序搞乱
        assert_eq!(v[0], "10.13.4.1614-1.7.10");
        assert_eq!(v[1], "10.13.4.1558-1.7.10");
        assert_eq!(v[2], "10.13.0.1200");
    }

    /// 1.12.2 的 branch 就是 MC 版本号，但产物名**不带**它 —— 不能无脑拼
    #[test]
    fn forge_1_12_2_artifact_name_has_no_branch_suffix() {
        let builds = vec![build_branch("14.23.5.2864", "1.12.2", "1.12.2")];
        assert_eq!(
            forge_build_versions(&builds, "1.12.2", 0),
            vec!["14.23.5.2864"],
            "1.12.2 的产物名是 forge-1.12.2-14.23.5.2864-installer.jar（无后缀）"
        );
    }

    /// 接口说"这个 build 只有 changelog、没有可安装产物"时不该列给用户
    /// （PCL2 也是 `Continue For` 跳过这种 build）
    #[test]
    fn forge_build_without_any_artifact_is_skipped() {
        let builds = vec![
            build_branch("10.13.4.1614", "1.7.10", "1.7.10"),
            build_only_changelog("10.13.4.1557", "1.7.10"),
        ];
        assert_eq!(
            forge_build_versions(&builds, "1.7.10", 0),
            vec!["10.13.4.1614-1.7.10"]
        );
    }

    /// `files` 字段缺失（老数据 / 别的镜像不给这个字段）时**不能把整批判死** ——
    /// 宁可多列一个，也不能因为字段缺失就报"没有 Forge"
    #[test]
    fn forge_build_with_empty_files_is_not_rejected() {
        let builds = vec![BmclForgeBuild {
            version: "47.4.23".into(),
            mcversion: "1.20.1".into(),
            branch: None,
            files: vec![],
        }];
        assert_eq!(
            forge_build_versions(&builds, "1.20.1", 0),
            vec!["47.4.23"],
            "files 为空说明接口没给这个字段，不是「没有产物」"
        );
    }

    /// ★ 回归测试：1.20.1 必须有 Forge 可选，而且最新在前
    #[test]
    fn forge_build_versions_are_desc_and_filtered() {
        let builds = vec![
            build("47.0.1", "1.20.1"),
            build("47.4.23", "1.20.1"),
            build("47.4.9", "1.20.1"),
            build("47.2.20", "1.20.1"),
            build("54.1.18", "1.21.4"), // 别的 MC 版本要滤掉
            build("", "1.20.1"),        // 空版本号要滤掉
        ];
        let v = forge_build_versions(&builds, "1.20.1", 0);
        assert_eq!(v, vec!["47.4.23", "47.4.9", "47.2.20", "47.0.1"]);
    }

    /// ★ 老版本里混着 `1710ls` / `srg` 这类构建变体，只保留真正的版本号。
    ///
    ///   ★ 含 `-` 的**保留**（`10.13.1.1216-new` 是真实产物名的一种形态）：
    ///     以前"见到 `-` 就丢"是为了躲开 `1710ls` 这类垃圾，但那个判据太宽，
    ///     把 1.7.10 的真实产物名也一起丢了。
    #[test]
    fn forge_build_versions_drops_non_version_shapes() {
        let builds = vec![
            build("10.13.4.1614", "1.7.10"),
            build("new", "1.7.10"),
            build("1710ls", "1.7.10"),
            build("9.11.1.965", "1.6.4"),
        ];
        let v = forge_build_versions(&builds, "1.7.10", 0);
        assert!(
            v.iter().any(|x| x.starts_with("10.13.4.1614")),
            "真正的版本号要留下：{v:?}"
        );
        assert!(
            !v.iter().any(|x| x == "1710ls" || x == "new"),
            "构建变体要丢掉：{v:?}"
        );
        assert_eq!(forge_build_versions(&builds, "1.6.4", 0), vec!["9.11.1.965"]);
    }

    /// limit 生效，且 return 的是前 N 个（最新的）
    #[test]
    fn forge_build_versions_respects_limit() {
        let builds: Vec<BmclForgeBuild> = (1..=10)
            .map(|i| build(&format!("47.0.{i}"), "1.20.1"))
            .collect();
        let v = forge_build_versions(&builds, "1.20.1", 3);
        assert_eq!(v, vec!["47.0.10", "47.0.9", "47.0.8"]);
    }

    /// ★ 回归：Forge 的 build 列表**不许被截断**。
    ///   1.12.2 实测有 351 个 build，老代码只取前 200 —— 悄悄少掉 43% 的可选版本，
    ///   用户想装某个特定的老 build 就找不到。
    #[test]
    fn forge_build_versions_is_not_truncated_by_default() {
        let builds: Vec<BmclForgeBuild> = (1..=351)
            .map(|i| build(&format!("14.23.5.{}", 2500 + i), "1.12.2"))
            .collect();
        let v = forge_build_versions(&builds, "1.12.2", 0);
        assert_eq!(v.len(), 351, "limit=0 表示不截断");
        assert_eq!(v[0], "14.23.5.2851");
    }

    /* ---------- NeoForge 版本归一化（实测踩到的排序坑） ---------- */

    /// ★★ 回归：同一个 MC 版本的列表里混着 `47.1.5` 与 `1.20.1-47.1.103` 两种格式。
    ///
    ///   不归一化直接按"数字段"排序，会把 `1.20.1-47.1.105` 排到 `47.1.5` 前面 ——
    ///   而真实顺序是 47.1.5 < 47.1.8 < … < 47.1.105，推荐版本会推荐错。
    #[test]
    fn neoforge_normalize_strips_mc_prefix_before_sorting() {
        let raw = vec![
            "1.20.1-47.1.105",
            "47.1.5",
            "1.20.1-47.1.103",
            "47.1.8",
            "1.20.1-47.1.9",
        ];
        let got = neoforge_normalize(raw.into_iter(), "1.20.1");
        assert_eq!(
            got,
            vec!["47.1.105", "47.1.103", "47.1.9", "47.1.8", "47.1.5"],
            "必须剥掉 MC 前缀再按数值降序"
        );
        assert!(got.iter().all(|v| !v.starts_with("1.20.1-")), "前缀不该残留");
    }

    /// 数字段要按**数值**比，不能按字符串：248 > 99
    #[test]
    fn neoforge_normalize_sorts_numerically() {
        let raw = vec!["21.1.9", "21.1.248", "21.1.99", "21.1.10"];
        assert_eq!(
            neoforge_normalize(raw.into_iter(), "1.21.1"),
            vec!["21.1.248", "21.1.99", "21.1.10", "21.1.9"]
        );
    }

    /// ★★ 回归：**预发布版本必须保留** —— 这是用户报的
    ///    「有 neoforge 的版本，说没有这些」的真凶。
    ///
    ///    实测 BMCLAPI（2026-09-13）：
    ///      * `26.1` → 18 条，**全部**是 `-beta` → 旧逻辑返回 **0 条**
    ///      * `1.21.9` → 17 条，全是 `-beta` → **0 条**
    ///      * `26.2` → 88 条，57 条是 `-beta` → 只剩 31 条
    ///
    ///    而 NeoForge 对新 MC 版本的正常发布流程就是先发 `-beta`（长期停留），
    ///    玩家用的就是这些。丢掉等于"新版本永远没有 NeoForge"。
    ///
    ///    这条测试以前叫 `neoforge_normalize_drops_prerelease`，
    ///    **断言的正是那个 bug** —— 现在反过来断言"不许丢"。
    #[test]
    fn neoforge_normalize_keeps_prerelease_because_that_is_what_exists() {
        let raw = vec!["20.4.0-beta", "20.4.251", "20.4.1-alpha", "20.4.250"];
        let got = neoforge_normalize(raw.into_iter(), "1.20.4");
        assert_eq!(
            got,
            vec!["20.4.251", "20.4.250", "20.4.1-alpha", "20.4.0-beta"],
            "正式版排在预发布前面，但预发布**不许丢**"
        );
    }

    /// ★ 26.1 的全部版本都是 beta —— 必须一个不丢地列出来
    #[test]
    fn neoforge_all_beta_version_still_lists() {
        let raw = vec![
            "26.1.0.1-beta",
            "26.1.0.2-beta",
            "26.1.0.19-beta",
        ];
        let got = neoforge_normalize(raw.into_iter(), "26.1");
        assert_eq!(
            got.len(),
            3,
            "全是 beta 也必须列出来（界面不能显示「没有 NeoForge」）：{got:?}"
        );
        assert_eq!(got[0], "26.1.0.19-beta", "最新的 beta 排最前");
    }

    /// 正式版与预发布数字段相同时，正式版在前
    #[test]
    fn neoforge_stable_sorts_before_prerelease_of_same_number() {
        let raw = vec!["21.11.45-beta", "21.11.45"];
        assert_eq!(
            neoforge_normalize(raw.into_iter(), "1.21.11"),
            vec!["21.11.45", "21.11.45-beta"]
        );
    }

    /// 去重（两种格式指向同一个 build 时会重复）
    #[test]
    fn neoforge_normalize_dedups() {
        let raw = vec!["47.1.9", "1.20.1-47.1.9", "47.1.8"];
        assert_eq!(
            neoforge_normalize(raw.into_iter(), "1.20.1"),
            vec!["47.1.9", "47.1.8"]
        );
    }

    /// 空输入 → 空输出（"确认没有"是合法结论）
    #[test]
    fn neoforge_normalize_handles_empty() {
        assert!(neoforge_normalize(std::iter::empty(), "1.20.1").is_empty());
    }
}
