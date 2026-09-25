//! Tauri 命令：真实网络与启动链路
//!
//! 这些命令把 `net` / `auth` / `modrinth` / `game` 模块暴露给前端。
//! 本层仍然**不含业务规则** —— 规则在 `domain`，这里只做参数转换与 I/O。

use crate::AppState;
use crate::auth::{self, McAccount};
use crate::domain;
use crate::domain::loader_trace::{
    detect_flavors, detect_installed_modloaders, loader_version_from_id, loader_versions_in_json,
    LoaderFlavor,
};
use crate::game::launch_args::{self, LaunchSpec};
use crate::modrinth;
use crate::net::adoptium;
use crate::net::download::{self, CancelToken, DownloadProgress};
use crate::net::installer::{self, PlanInput};
use crate::net::metadata::{self, VersionJson};
use crate::net::mirror::{self, Source};
use crate::net::{self, NetError};
use crate::platform;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, State};

/* ====================== 正在运行的任务取消表 ====================== */

static CANCEL_TOKENS: OnceLock<Mutex<HashMap<String, CancelToken>>> = OnceLock::new();

/*
 * ★★ **暂停令牌表**（与取消表分开）。
 *
 *   为什么必须分开：两者语义不同，而且**可以同时存在** ——
 *   用户按下"暂停"之后再按"取消"，那一批下载要立刻从"等会儿接着下"
 *   变成"不要了"。共用一个标志位就表达不了这件事。
 */
static PAUSE_TOKENS: OnceLock<Mutex<HashMap<String, download::PauseToken>>> = OnceLock::new();

fn tokens() -> &'static Mutex<HashMap<String, CancelToken>> {
    CANCEL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pause_tokens() -> &'static Mutex<HashMap<String, download::PauseToken>> {
    PAUSE_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_task(id: &str) -> CancelToken {
    let t = CancelToken::new();
    tokens().lock().unwrap().insert(id.to_string(), t.clone());
    // 顺手把一个"未暂停"的令牌也放进去 —— 调用方只需要知道 taskId
    let p = download::PauseToken::new();
    pause_tokens().lock().unwrap().insert(id.to_string(), p);
    t
}

fn register_pause(id: &str) -> download::PauseToken {
    let p = download::PauseToken::new();
    pause_tokens().lock().unwrap().insert(id.to_string(), p.clone());
    p
}

fn drop_task(id: &str) {
    tokens().lock().unwrap().remove(id);
    pause_tokens().lock().unwrap().remove(id);
}

/// ★★ **暂停一个正在跑的任务**（不是取消）。
///
/// 语义：**不再开始新的下载，让在跑的收尾**，然后把"还剩哪些"记下来。
/// 已下载的 `.part` 分片全部保留，所以「继续」时会从断点接上。
///
/// 返回当前是不是处于暂停态（`true` = 已暂停）。
#[tauri::command]
pub fn pause_install(task_id: String) -> Result<bool, String> {
    let table = pause_tokens().lock().map_err(|_| "状态锁失败")?;
    let Some(p) = table.get(&task_id) else {
        /*
         * ★ 找不到任务时**如实报错**，不要返回"已暂停" ——
         *   那会让界面显示一个假的暂停状态，而下载还在跑。
         */
        return Err(format!(
            "找不到正在运行的任务 {task_id}（可能已经结束）—— 暂停没生效"
        ));
    };
    p.pause();
    say!("[IEML/install] 已请求暂停 {task_id}");
    Ok(true)
}

/// 取消暂停（「继续」用）。真正的"接着下"由调用方按原参数重新发起，
/// 已下载的文件与 `.part` 分片都会被复用。
#[tauri::command]
pub fn resume_install(task_id: String) -> Result<bool, String> {
    let table = pause_tokens().lock().map_err(|_| "状态锁失败")?;
    let Some(p) = table.get(&task_id) else {
        return Err(format!("找不到任务 {task_id}（可能已经结束）"));
    };
    p.resume();
    Ok(false)
}

/* ====================== 版本与清单 ====================== */

fn parse_source(s: &str) -> Source {
    /*
     * ★★ 2026-09-22（用户：「去掉镜像还是官方这个，默认就先使用官方源，
     *   官方源加载缓慢时再选择镜像」）。
     *
     *   「自动」= **期望官方源**。这不是"只走官方"：下载时
     *   `net::source::candidates_with` 会把镜像与官方都列成候选，并按
     *   「期望源 + 健康度」排序 —— 官方慢 / 失败 / 被限速时会自动降到镜像。
     *   期望源只决定**谁先试**。
     *
     *   `"bmclapi"` 仍然认（老配置、内部调用会传），但界面上已经没有这个选择了。
     */
    match s {
        "bmclapi" => Source::Bmclapi,
        // "mojang" / "auto" / 其它：一律按**官方优先**
        _ => Source::Mojang,
    }
}

#[derive(serde::Serialize)]
pub struct ManifestSummary {
    pub latest_release: String,
    pub latest_snapshot: String,
    pub count: usize,
    pub versions: Vec<ManifestRow>,
}

#[derive(serde::Serialize)]
pub struct ManifestRow {
    pub id: String,
    pub release_type: String,
    pub released_at: String,
    /// 本机是否已安装（原版文件在盘上）
    pub installed: bool,
    /// ★★ **还有没有版本（实例）在用它**。
    ///
    /// `installed` 说的是"盘上有文件"，`in_use` 说的是"有版本在用"——
    /// 删掉实例之后**前者仍为真、后者变假**：共享的游戏文件被故意留着
    /// （别的实例可能还在用），于是下载页继续显示"已装"，
    /// 而用户看到的是一个**没有任何版本在用**的空壳（用户报的正是这个）。
    ///
    /// 两句话都对，但界面必须说清是哪一句 —— 只说"已装"就是在骗人。
    pub in_use: bool,
    /// ★ 这一行版本在盘上**实际**装了哪些加载器与附加组件。
    ///
    /// 为什么必须有它（用户原话：「这个对应关系应该是你得实时监测他有没有
    /// 包括其他加载器和高清修复」）：版本列表过去只有一个 `installed` 布尔值，
    /// 于是"装了 Forge 的 1.20.1"和"纯原版 1.20.1"在界面上长得一模一样，
    /// 用户只能自己记。现在每一行都带上**当场从版本 JSON 里读出来的**事实。
    #[serde(default)]
    pub loaders: Vec<InstalledLoader>,
}

/// 盘上真实存在的一个加载器/附加组件。
///
/// ★ 直接复用领域层的 `InstalledModLoader`（这里只是别名）——
///   以前这里另立了一个结构体、字段名还和领域层不一样，
///   于是"检测加载器"这件事有了两份形状。现在只有一份。
pub type InstalledLoader = crate::domain::loader_trace::InstalledModLoader;

/// 在盘上按 id 找一份版本 JSON 的原文（递归检测父版本时用）。
fn read_version_json_by_id(shared: &std::path::Path, id: &str) -> Option<String> {
    let dir = shared.join("versions").join(id);
    let direct = dir.join(format!("{id}.json"));
    if let Ok(t) = std::fs::read_to_string(&direct) {
        return Some(t);
    }
    // 目录里唯一的那个 json（Fabric 那种 id 与文件名不一致的情况）
    let rd = std::fs::read_dir(&dir).ok()?;
    let mut jsons: Vec<std::path::PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    jsons.sort();
    jsons.first().and_then(|p| std::fs::read_to_string(p).ok())
}

/// 盘上某个版本目录的加载器痕迹（内部用）
struct VersionTrace {
    /// 目录名（`versions/<这个>`）
    dir: String,
    /// 这份 JSON 里声明的父版本（`inheritsFrom`），没有则为空
    inherits: String,
    /// 这份 JSON 自己的 id
    id: String,
    /// 检测到的加载器（**含沿 `inheritsFrom` 合并进来的父版本部分**）
    loaders: Vec<InstalledLoader>,
}

/// 扫一遍 `versions/`，把每个版本目录的加载器痕迹读出来。
///
/// ★ **每次调用都真读盘**（用户原话：「能装就是能装，不能装就是不能装」）。
///   这个函数不做任何缓存：一份 20 MB 的版本目录读一遍 JSON 只要毫秒级，
///   而缓存的代价是"界面上的结论可能不是盘上的事实"——那正是 bug 的来源。
fn scan_version_dir(shared: &std::path::Path) -> Vec<VersionTrace> {
    let versions = shared.join("versions");
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let dir = e.file_name().to_string_lossy().to_string();
        // 只读这个目录里的 JSON（不递归：版本 JSON 就在版本目录根下）
        let Ok(files) = std::fs::read_dir(e.path()) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            let flavors = detect_flavors(&text);
            if flavors.is_empty() {
                continue;
            }
            let parsed: Option<VersionJson> = serde_json::from_str(&text).ok();
            let inherits = parsed
                .as_ref()
                .and_then(|v| v.inherits_from.clone())
                .unwrap_or_default();
            let id = parsed
                .as_ref()
                .map(|v| v.id.clone())
                .unwrap_or_else(|| dir.clone());

            let mut versions = HashMap::new();
            for fl in &flavors {
                // 优先从库坐标读（权威），读不到再从目录名推（兜底）
                let v = loader_versions_in_json(&text, *fl)
                    .or_else(|| loader_version_from_id(&dir))
                    .unwrap_or_default();
                versions.insert(*fl, v);
            }
            let _ = versions;
            // ★ 真正的检测走领域层，且**含 inheritsFrom 递归** ——
            //   只读自己那一份会漏报（附加组件常常只写在父版本里）。
            let mut loaders = detect_installed_modloaders(&text, &|pid: &str| {
                read_version_json_by_id(shared, pid)
            })
            .unwrap_or_default();
            if loaders.is_empty() {
                // 理论上不会发生（痕迹非空必有结果）；真发生就按版本号兜底，如实报 unknown
                for fl in &flavors {
                    loaders.push(InstalledLoader {
                        loader_type: fl.key().to_string(),
                        name: fl.display().to_string(),
                        version: loader_versions_in_json(&text, *fl)
                            .or_else(|| loader_version_from_id(&dir))
                            .unwrap_or_else(|| "unknown".to_string()),
                        is_base: fl.is_base(),
                        // 扫盘时还不知道有没有实例在用 —— 由 `fetch_version_manifest`
                        // / `detect_installed_loaders` 之后调 `annotate_usage` 补上
                        in_use: None,
                    });
                }
            } else {
                // 库坐标读不出版本号时（`unknown`），从目录名兜一次
                for l in loaders.iter_mut() {
                    if l.version == "unknown" {
                        if let Some(v) = loader_version_from_id(&dir) {
                            l.version = v;
                        }
                    }
                }
            }
            out.push(VersionTrace {
                dir: dir.clone(),
                inherits,
                id,
                loaders,
            });
            break; // 一个版本目录只认第一份带痕迹的 JSON
        }
    }
    out
}

/// 某个 MC 版本在盘上装了哪些加载器（按 kind 去重，保留版本最高的那条）。
///
/// 归属判据：目录名或 `id` 里含这个 MC 版本，**或者** `inheritsFrom` 指向它。
/// 三种都要认 —— Forge 安装器产出的目录名是 `1.20.1-forge-47.4.23`，
/// Fabric 的是 `fabric-loader-0.19.5-26.2`（名字里没有 "26.2" 的前缀却在末尾），
/// 手装的甚至只有 `inheritsFrom`。
fn installed_loaders_for(traces: &[VersionTrace], mc_version: &str) -> Vec<InstalledLoader> {
    let mut best: HashMap<String, InstalledLoader> = HashMap::new();
    for t in traces {
        let belongs = t.inherits == mc_version
            || t.dir.contains(mc_version)
            || t.id.contains(mc_version);
        if !belongs {
            continue;
        }
        // 排掉"名字里恰好含这个版本号但其实是别的版本"的情况：
        // `1.20.1` 会命中 `1.20.10` / `1.20.11` 这种目录名，必须排除。
        if !t.inherits.is_empty() && t.inherits != mc_version {
            continue;
        }
        for cand in t.loaders.iter() {
            match best.get(&cand.loader_type) {
                Some(prev) if prev.version != "unknown" && !prev.version.is_empty() => continue,
                _ => {
                    best.insert(cand.loader_type.clone(), cand.clone());
                }
            }
        }
    }
    let mut out: Vec<InstalledLoader> = best.into_values().collect();
    // 基础加载器排在附加组件前面，同类按名字稳定排序（UI 不需要再排）
    out.sort_by(|a, b| {
        b.is_base
            .cmp(&a.is_base)
            .then_with(|| a.loader_type.cmp(&b.loader_type))
    });
    out
}

/// ★★ **哪些 MC 版本 / 加载器"还有版本在用"** —— 从 `instances.json` 读。
///
/// ## 为什么需要它（用户报的 bug）
///
/// 「版本列表删除有模组加载器的版本之后，下载列表的对应版本有模组加载器的
/// 版本，**还显示已装**」。
///
/// 根因：两张表读的是**两个不同的东西** ——
///   · 「版本列表」= `instances.json`（用户建的版本）
///   · 「下载」页   = 直接扫 `shared/versions/`（盘上有什么）
///
/// 删实例只删 `instances/{slug}/`（存档 / Mod / 配置），
/// **共享的游戏文件**（`shared/versions/`、`libraries/`）故意留着 ——
/// 多个实例可能共用同一份，删了会把别人的游戏弄坏。
/// 于是下载页照旧扫到那个加载器目录，继续显示"已装" ——
/// **两句话都对，合在一起就是界面在骗人**：它让人以为那个版本可以用，
/// 而实际上没有任何版本在用它。
///
/// 返回：`mc_version -> 这个版本下实例用到的加载器种类（小写）`。
/// **某个 mc_version 不在 map 里 = 一份实例都没有**（区别于"有实例但没加载器"）。
///
/// ★ 读不出来（文件不在 / 坏了）时返回**空 map**，也就是"都没人在用" ——
///   这个方向的错更安全：界面最多把"在用"说成"闲置"，用户只会多想一下；
///   反过来会让用户去删一份**正在用**的游戏。
fn instance_usage(state: &AppState) -> HashMap<String, std::collections::HashSet<String>> {
    use std::collections::HashSet;
    /*
     * ★★ 2026-09-24：位置改走 `own_file_for_read` —— 原来这里写的是
     *   `state.paths().root.join("instances.json")`，也就是**A-4 之前**的老位置。
     *   真机上那个文件从 2026-09-24 01:25 起就再没被写过（清单早就搬到
     *   `%APPDATA%\IEML`），于是这张"哪些版本还在用"的表是**陈旧数据**算出来的：
     *   新建的实例在下载页一律显示"没人在用"。
     *   `own_file_for_read` 的语义正是"优先启动器自己的家，那儿没有才回退老位置"
     *   （老用户升级当次启动仍读得到）。
     */
    let Some(path) = state.paths().own_file_for_read("instances.json") else {
        return HashMap::new();
    };
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return out;
    };
    #[derive(serde::Deserialize)]
    struct Store {
        #[serde(default)]
        instances: Vec<crate::domain::types::Instance>,
    }
    let Ok(store) = serde_json::from_str::<Store>(&text) else {
        say!("[IEML/manifest] instances.json 解析失败，本次不标注「有没有版本在用」");
        return out;
    };
    for inst in store.instances {
        let entry = out.entry(inst.mc_version.clone()).or_default();
        if let Some(l) = &inst.loader {
            entry.insert(l.kind.as_str().to_string());
        }
        for a in &inst.addons {
            entry.insert(a.kind.as_str().to_string());
        }
    }
    out
}

/// 取版本清单（真实联网）
#[tauri::command]
pub async fn fetch_version_manifest(
    source: String,
    state: State<'_, AppState>,
) -> Result<ManifestSummary, String> {
    let m = metadata::fetch_manifest(parse_source(&source))
        .await
        .map_err(err)?;

    let versions_dir = state.paths().shared.join("versions");
    // ★ 一次扫盘，之后给每一行按需归档（900 个版本 × 一次 read_dir 太贵）
    let traces = scan_version_dir(&state.paths().shared);
    // ★ 一次读实例列表，标注"盘上有"与"有版本在用"的区别
    let usage = instance_usage(&state);
    let rows = m
        .versions
        .iter()
        .map(|v| {
            let mut loaders = installed_loaders_for(&traces, &v.id);
            match usage.get(&v.id) {
                Some(kinds) => {
                    crate::domain::loader_trace::annotate_usage(&mut loaders, kinds);
                }
                None => {
                    // 这个 MC 版本一份实例都没有 → 盘上这些加载器全是闲置的
                    crate::domain::loader_trace::annotate_usage(
                        &mut loaders,
                        &std::collections::HashSet::new(),
                    );
                }
            }
            ManifestRow {
                id: v.id.clone(),
                release_type: v.release_type.clone(),
                released_at: v.release_time.clone(),
                installed: versions_dir.join(&v.id).join(format!("{}.json", v.id)).is_file(),
                loaders,
                in_use: usage.contains_key(&v.id),
            }
        })
        .collect();

    Ok(ManifestSummary {
        latest_release: m.latest.release,
        latest_snapshot: m.latest.snapshot,
        count: m.versions.len(),
        versions: rows,
    })
}

/// ★ 实时问一句：盘上这个 MC 版本到底装了哪些加载器 / 附加组件？
///
/// 这是「能装就是能装」的服务端一半：不依赖任何历史结论，
/// 打开界面时现读盘。前端在切版本、装完东西之后都会调它。
#[tauri::command]
pub fn detect_installed_loaders(
    mc_version: String,
    state: State<'_, AppState>,
) -> Vec<InstalledLoader> {
    let traces = scan_version_dir(&state.paths().shared);
    let mut loaders = installed_loaders_for(&traces, &mc_version);
    /*
     * ★ 同样要标注"有没有版本在用"。
     *
     *   这个命令是界面在切版本、装完东西之后调的，它给出的结论会直接
     *   显示成"已装 Forge 65.1.3"。如果这里不标注，用户删掉实例之后
     *   切换一下版本又会看到"已装"—— 那就等于这个 bug 从另一个门回来了。
     */
    let usage = instance_usage(&state);
    match usage.get(&mc_version) {
        Some(kinds) => crate::domain::loader_trace::annotate_usage(&mut loaders, kinds),
        None => crate::domain::loader_trace::annotate_usage(
            &mut loaders,
            &std::collections::HashSet::new(),
        ),
    }
    loaders
}

/// ★ 一次问清"这个 MC 版本能装哪些加载器"：**五种并行拉取**。
///
/// 以前前端要为 4 种加载器各发一次 IPC，而且 OptiFine **根本没有来源**
/// （界面上写着"版本清单尚未接入自动查询"）。现在：
///   · 并行（本机实测串行合计约 18 秒 → 并行由最慢的一个决定）
///   · 多了 OptiFine（走 BMCLAPI 的结构化 JSON，带 Forge 兼容要求）
///   · 单个来源失败只影响它自己，其余照常返回
#[tauri::command]
pub async fn fetch_available_loaders(
    mc_version: String,
    source: Option<String>,
) -> Result<crate::modloader::AvailableLoaders, String> {
    let src = parse_source(source.as_deref().unwrap_or("bmclapi"));
    crate::modloader::fetch_available_loaders(&mc_version, src)
        .await
        .map_err(err)
}

/// 取某个版本的完整 JSON（供 UI 展示库数量、Java 要求等）
#[tauri::command]
pub async fn fetch_version_json(
    mc_version: String,
    source: String,
) -> Result<VersionDetail, String> {
    let src = parse_source(&source);
    let manifest = metadata::fetch_manifest(src).await.map_err(err)?;
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc_version)
        .ok_or_else(|| format!("清单里没有版本 {mc_version}"))?;

    let v: VersionJson = net::get_json(&entry.url).await.map_err(err)?;

    Ok(VersionDetail {
        id: v.id.clone(),
        release_type: v.release_type.clone(),
        main_class: v.main_class.clone(),
        libraries: v.libraries.len(),
        asset_index: v.asset_index.as_ref().map(|a| a.id.clone()),
        java_major: v.java_version.as_ref().map(|j| j.major_version),
        client_bytes: v.downloads.as_ref().and_then(|d| d.client.as_ref()).map(|c| c.size),
        has_arguments: v.arguments.is_some(),
        legacy_arguments: v.minecraft_arguments.is_some(),
    })
}

#[derive(serde::Serialize)]
pub struct VersionDetail {
    pub id: String,
    pub release_type: String,
    pub main_class: String,
    pub libraries: usize,
    pub asset_index: Option<String>,
    pub java_major: Option<u32>,
    pub client_bytes: Option<u64>,
    pub has_arguments: bool,
    pub legacy_arguments: bool,
}

/// 加载器清单：Fabric / Quilt 走各自的 Meta API；Forge / NeoForge 走各自的 build API
/// （Forge 走 BMCLAPI 的 build 接口 + 官方 maven 兜底，见 `metadata::forge_versions`）。
///
/// ★ 返回结构里带 `status` 是**故意的**（用户报的 bug 的核心）：
///   过去这里返回一个裸数组，于是"查不到"和"确认没有"在前端长得一模一样 ——
///   两种情况都是空数组。前端只好把空数组当成"这个版本没有 Forge"，
///   在 Forge 明明有 47.4.23 的时候把 Forge 置灰并说"没有 Forge 版本"。
///   现在两种情况分开表达：
///     · `status = "ok"`      → 清单可信，`versions` 为空才真的表示"没有"
///     · `status = "error"`   → **没查到**，前端必须说"查询失败，可重试"，
///                              绝不能显示成"没有这个加载器"
#[tauri::command]
pub async fn fetch_loaders(
    mc_version: String,
    kind: String,
    source: Option<String>,
) -> Result<LoaderList, String> {
    let flavor = LoaderFlavor::parse(&kind).ok_or_else(|| format!("不认识的加载器：{kind}"))?;
    // 用户选的下载源对**元数据**同样生效（以前这里写死了 BMCLAPI）
    let src = parse_source(source.as_deref().unwrap_or("bmclapi"));

    // 查清单本身不该因为"加载器种类不认识"而失败，只有网络/解析问题才算 error
    let (versions, err_text): (Vec<String>, Option<String>) = match flavor {
        LoaderFlavor::Forge => match metadata::forge_versions(&mc_version).await {
            Ok(v) => (v, None),
            Err(e) => (Vec::new(), Some(err(e))),
        },
        LoaderFlavor::NeoForge => match metadata::neoforge_versions().await {
            Ok(all) => {
                if neoforge_prefix(&mc_version).is_empty() {
                    (
                        Vec::new(),
                        Some(format!("无法从 {mc_version} 推出 NeoForge 版本前缀")),
                    )
                } else {
                    let mut out: Vec<String> = all
                        .into_iter()
                        .filter(|v| neoforge_version_matches(v, &mc_version))
                        .collect();
                    out.sort_by(|a, b| {
                        crate::domain::loader_trace::compare_version_desc(a, b)
                    });
                    out.truncate(60);
                    (out, None)
                }
            }
            Err(e) => (Vec::new(), Some(err(e))),
        },
        LoaderFlavor::Fabric => match metadata::fabric_loaders(&mc_version, src).await {
            Ok(list) => (
                list.into_iter().take(60).map(|e| e.loader.version).collect(),
                None,
            ),
            Err(e) => (Vec::new(), Some(err(e))),
        },
        LoaderFlavor::Quilt => match metadata::quilt_loaders(&mc_version, src).await {
            Ok(list) => (
                list.into_iter().take(60).map(|e| e.loader.version).collect(),
                None,
            ),
            Err(e) => (Vec::new(), Some(err(e))),
        },
        other => (
            Vec::new(),
            Some(format!("{} 的版本清单不由这个接口提供", other.display())),
        ),
    };

    let status = if err_text.is_some() { "error" } else { "ok" };
    Ok(LoaderList {
        kind: flavor.key().to_string(),
        name: flavor.display().to_string(),
        mc_version,
        status: status.to_string(),
        versions,
        error: err_text,
        // UI 的推荐项：有静态表里的推荐版本就用它（用户看到的默认值和
        // 安装脚本实际会装的版本必须一致），否则用最新的。
        recommended: None,
    })
}

/// 加载器清单的返回结构（见 `fetch_loaders` 的说明）
#[derive(serde::Serialize)]
pub struct LoaderList {
    pub kind: String,
    pub name: String,
    pub mc_version: String,
    /// `ok` = 清单可信；`error` = 没查到（**不等于**没有这个版本）
    pub status: String,
    /// 降序（最新在前）
    pub versions: Vec<String>,
    /// `status == "error"` 时的原因
    pub error: Option<String>,
    /// 推荐版本（有就排在 UI 第一位）
    pub recommended: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LoaderRow {
    pub version: String,
    pub stable: bool,
}

/// NeoForge 用 MC 版本推出自己的版本前缀：1.21.1 → "21.1."
///
/// NeoForge 的版本号有两种世代：
///   · 新世代（1.21 起）：`21.1.72`，前两段 = MC 版本去掉 `1.` 前缀
///   · 旧世代（1.20.2 ~ 1.20.6）：`20.4.237`，同样是前两段
///   · 更早的过渡期（1.20.1）：版本号形如 `1.20.1-47.1.76`，**带 MC 前缀**，
///     这时用 `{mc}-` 当前缀才对
///
/// ★ 这里必须返回"能同时匹配两种世代"的前缀集合，否则 1.20.1 的 NeoForge
///   会被漏掉，界面上就说"没有 NeoForge 版本"（又是一次错误的禁用）。
fn neoforge_prefix(mc_version: &str) -> String {
    let parts: Vec<&str> = mc_version.split('.').collect();
    // 1.21.1 → 21.1   1.20.4 → 20.4
    match (parts.get(1), parts.get(2)) {
        (Some(a), Some(b)) => format!("{a}.{b}."),
        (Some(a), None) => format!("{a}."),
        _ => String::new(),
    }
}

/// 某条 NeoForge 版本号是否属于这个 MC 版本（两种世代都认）
fn neoforge_version_matches(v: &str, mc_version: &str) -> bool {
    let prefix = neoforge_prefix(mc_version);
    if !prefix.is_empty() && v.starts_with(&prefix) {
        return true;
    }
    // 过渡期形态：`1.20.1-47.1.76`
    v.starts_with(&format!("{mc_version}-"))
}

/* ====================== Modrinth / 社区资源 ====================== */

/// ★★ **四种社区资源的描述**（Mod / 资源包 / 光影 / 数据包）。
///
/// 界面启动时取一次就够了 —— 四种资源"到哪查、装到哪、认哪些扩展名、
/// 要不要挑加载器"这四件事**只有一份描述**（`domain::resources`）。
///
/// 为什么要有这条命令（而不是前端自己写一张表）：
///   这个仓库已经因为"同一张表两边各写一份"栽过两次
///   （`forgespi` 的版本号、`26.2` 的 Java 要求）。
///   资源的安装目录尤其危险 —— 写错一个字母，文件就装到游戏看不见的地方，
///   而界面还会说"装好了"。
#[tauri::command]
pub fn resource_kinds() -> Vec<crate::domain::resources::ResourceKindInfo> {
    crate::domain::resources::all_kinds()
}

/// 搜索社区资源（Mod / 资源包 / 光影 / 数据包）。
///
/// ★ `kind` 用我们自己的键名（`mod` / `resourcepack` / `shader` / `datapack`），
///   由 `domain::resources` 翻译成 Modrinth 的项目类型 + 分类 facet。
///
///   实测踩过的坑：我原以为 Modrinth 有 `datapack` 这个项目类型，
///   真机查过去**返回的是 mod**；正确做法是 `project_type=mod` +
///   `categories:datapack`。这一条写在 `ResourceKind` 的说明里。
#[tauri::command]
pub async fn modrinth_search(
    query: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<modrinth::SearchResponse, String> {
    modrinth::search(
        &query,
        &project_type,
        mc_version.as_deref(),
        loader.as_deref(),
        limit.unwrap_or(20),
        offset.unwrap_or(0),
    )
    .await
    .map_err(err)
}

/// ★★ 按**资源种类**搜索（界面走这条；上面那条留给内部/兼容调用）。
///
/// 与 `modrinth_search` 的差别就是"那张表"：
///   · 数据包自动用 `mod` + `categories:datapack`；
///   · 只有 Mod 会带上 `categories:<loader>` ——
///     资源包/光影/数据包带加载器会让结果集被砍到几乎没有，
///     而用户会以为"没有这个资源"（把"查不到"说成"没有"是这个仓库的老毛病）。
///
/// ## `source`：两个源，一套形状（ADR-052）
///
///   `modrinth`（默认）与 `curseforge` 的结果**映射成同一个响应形状**
///   （见 `net::curseforge::search` 的字段对照表），所以界面不需要为来源
///   再写一套渲染。`:source` 字段会如实告诉我们这批结果从哪来 ——
///   界面据此说清"为什么这个 Mod 装不了"（CurseForge 上作者可以禁止分发）。
#[tauri::command]
pub async fn resource_search(
    kind: String,
    query: String,
    mc_version: Option<String>,
    loader: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    source: Option<String>,
) -> Result<modrinth::SearchResponse, String> {
    let k = crate::domain::resources::parse_kind(&kind)
        .ok_or_else(|| format!("不认识的资源种类「{kind}」（只支持 mod / resourcepack / shader / datapack）"))?;
    let wanted = parse_resource_source(source.as_deref())?;

    let loader_for_query = if k.needs_loader_filter() {
        loader.as_deref()
    } else {
        None
    };

    if wanted == ResourceSource::CurseForge {
        return crate::net::curseforge::search(
            k,
            &query,
            mc_version.as_deref(),
            loader_for_query,
            limit.unwrap_or(20),
            offset.unwrap_or(0),
        )
        .await
        .map_err(err);
    }

    let mut resp = modrinth::search_with_facets(
        &query,
        k.modrinth_project_type(),
        mc_version.as_deref(),
        loader_for_query,
        // ★★ 数据包靠这个分类区分（Modrinth 没有 datapack 这个项目类型）
        k.extra_category(),
        limit.unwrap_or(20),
        offset.unwrap_or(0),
    )
    .await
    .map_err(err)?;

    /*
     * ★ 数据包要做**二次过滤**：`categories:datapack` 是 Modrinth 给的
     *   服务端筛选，但它的分类是作者自己打的，可能不准。
     *   再把"分类里确实带 datapack"的留下 —— 宁可靠一点。
     *
     *   （不做这一步的后果：数据包页里混进普通 Mod，
     *    用户装进 `datapacks/` 之后游戏根本读不到。）
     */
    if k == crate::domain::resources::ResourceKind::Datapack {
        resp.hits.retain(|h| {
            h.categories
                .iter()
                .any(|c| c.eq_ignore_ascii_case("datapack"))
        });
    }
    Ok(resp)
}

/// 社区资源的两个来源。**只在这一处解析字符串**（界面传 `modrinth` / `curseforge`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceSource {
    Modrinth,
    CurseForge,
}

/// 解析来源；不认识的**报错**而不是默默退回 Modrinth
/// （默默退回会让"我明明选了 CurseForge"变成一个查不出的谜）。
pub fn parse_resource_source(s: Option<&str>) -> Result<ResourceSource, String> {
    match s.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("modrinth") => Ok(ResourceSource::Modrinth),
        Some("curseforge") | Some("cf") => Ok(ResourceSource::CurseForge),
        Some(other) => Err(format!(
            "不认识的资源来源「{other}」（只支持 modrinth / curseforge）"
        )),
    }
}

/// ★★ 取一个项目**兼容当前实例**的版本（两个源共用一条命令）。
///
/// 为什么合并：界面在"安装"时只关心"给我一个能装的版本"，
/// 至于它来自 Modrinth 还是 CurseForge 是**后端的事**。
/// 两条命令会让界面出现 `if (source === 'curseforge')` 这种分支 ——
/// 而那正是 ADR-051 说的"同一判据写两遍"。
#[tauri::command]
pub async fn resource_versions(
    kind: String,
    project_id: String,
    mc_version: Option<String>,
    loader: Option<String>,
    source: Option<String>,
) -> Result<Vec<modrinth::ProjectVersion>, String> {
    let k = crate::domain::resources::parse_kind(&kind)
        .ok_or_else(|| format!("不认识的资源种类「{kind}」"))?;
    let wanted = parse_resource_source(source.as_deref())?;
    let loader_for_query = if k.needs_loader_filter() {
        loader.as_deref()
    } else {
        None
    };

    if wanted == ResourceSource::CurseForge {
        return crate::net::curseforge::files(
            &project_id,
            k,
            mc_version.as_deref(),
            loader_for_query,
            50,
        )
        .await
        .map_err(err);
    }

    modrinth::project_versions(&project_id, mc_version.as_deref(), loader_for_query)
        .await
        .map_err(err)
}

/* ====================== CurseForge 的 key 管理（ADR-052） ====================== */

/// 当前 CurseForge key 的状态（**界面上要如实说它从哪来**）
#[derive(serde::Serialize)]
pub struct CfKeyStatus {
    /// 有没有可用的 key（内置的也算有）
    pub configured: bool,
    /// `settings`（你填的）/ `env`（环境变量）/ `builtin`（随程序内置）/ `none`
    pub source: String,
    /// 只显示前缀，**不泄漏整把 key**
    pub hint: Option<String>,
}

#[tauri::command]
pub fn cf_key_status() -> CfKeyStatus {
    let src = crate::net::curseforge::key_source();
    CfKeyStatus {
        configured: crate::net::curseforge::api_key().is_some(),
        source: src.to_string(),
        hint: crate::net::curseforge::key_hint(),
    }
}

/// 保存一把自己的 key（空串 = 删掉覆盖值）。
///
/// ★ 2026-09-25：**"回到内置的那把"这句话不再成立** —— 内置 key 已为公开化清空
///   （见 `net/curseforge.rs` 的 `BUILTIN_API_KEY`）。现在清空覆盖值 = 回到
///   "没有 key"那条路，也就是**走国内镜像**（照样开箱即用）。
#[tauri::command]
pub fn cf_set_key(key: String, state: State<'_, AppState>) -> Result<CfKeyStatus, String> {
    crate::net::curseforge::save_api_key(&state.paths(), &key)
        .map_err(|e| e.to_string())?;
    Ok(cf_key_status())
}

/// ★ 真打一次接口验证 key 是否可用（**不是"看起来对"**）。
///
/// 返回一句人话结论：成功时说清"能查到多少个 Mod"，
/// 失败时区分"key 不对(403)"与"网络不通"（两者修法完全不同）。
#[tauri::command]
pub async fn cf_test_key() -> Result<String, String> {
    use crate::domain::resources::ResourceKind;
    match crate::net::curseforge::search(ResourceKind::Mod, "jei", None, None, 1, 0).await {
        Ok(r) => Ok(format!(
            "连接成功：能查到 CurseForge 上的 Mod（这次命中 {} 条，来源 {}）",
            r.total_hits,
            if r.source.is_empty() { "未知" } else { &r.source }
        )),
        Err(crate::net::NetError::Status { status: 403, .. }) => Err(
            "CurseForge 拒绝了这把 key（HTTP 403）。\n\
             可能的原因：key 复制不全、或者它已经被撤销。\n\
             到 console.curseforge.com 的「API Keys」里重新复制一次。"
                .to_string(),
        ),
        Err(e) => Err(format!(
            "没连上 CurseForge：{e}\n\
             （这可能是网络问题，不一定是 key 的问题 —— 我们也走了国内镜像兜底）"
        )),
    }
}

#[tauri::command]
pub async fn modrinth_project(id: String) -> Result<modrinth::Project, String> {
    modrinth::project(&id).await.map_err(err)
}

#[tauri::command]
pub async fn modrinth_versions(
    id: String,
    mc_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<modrinth::ProjectVersion>, String> {
    modrinth::project_versions(&id, mc_version.as_deref(), loader.as_deref())
        .await
        .map_err(err)
}

/// 按哈希反查版本（判定"可更新"的真实机制）
#[tauri::command]
pub async fn modrinth_versions_by_hash(
    hashes: Vec<String>,
) -> Result<HashMap<String, modrinth::ProjectVersion>, String> {
    modrinth::versions_from_hashes(&hashes).await.map_err(err)
}

/// ★ 清理没有任何已装版本引用的共享库与资源文件。
///
/// 审计发现：设置页那句「删除没有任何版本引用的共享库与资源文件」下面
/// 挂的按钮只弹一句"将在后续版本提供" —— 承诺了却没有实现。
///
/// **安全性是这个功能的第一要求**（删错一次用户就得重下几个 GB）：
///   ① 只清 `libraries/` 与 `assets/objects/` 两棵树，别的一律不碰；
///   ② 引用关系从**磁盘上每个版本 JSON** 现读（含 `inheritsFrom` 链）：
///      版本 JSON 里出现的库坐标、以及 `assetIndex` 指向的索引文件里出现的
///      每个 hash，都进保留集；
///   ③ 另外保留：`assets/indexes/` 全部、`assets/virtual/` 全部、
///      以及**所有** `.part`（断点续传的残留不能当垃圾清掉）；
///   ④ `dry_run=true` 时只统计不删除 —— 前端先用它把"能释放多少"告诉用户，
///      用户确认后再真删。
///   ⑤ 返回清单里带上被删的样例，让用户看得见删了什么。
#[tauri::command]
pub fn clean_unused_files(
    dry_run: bool,
    state: State<'_, AppState>,
) -> Result<CleanReport, String> {
    let shared = &state.paths().shared;

    // ---------- ① 收集保留集 ----------
    // 库坐标 → 磁盘相对路径
    let mut keep_libraries: std::collections::HashSet<std::path::PathBuf> =
        std::collections::HashSet::new();
    // 资源 hash
    let mut keep_assets: std::collections::HashSet<String> = std::collections::HashSet::new();

    let versions_dir = shared.join("versions");
    let mut version_jsons = 0usize;
    if let Ok(rd) = std::fs::read_dir(&versions_dir) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(e.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().map(|x| x != "json").unwrap_or(true) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&p) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<VersionJson>(&text) else {
                    continue;
                };
                version_jsons += 1;
                // 这个版本引用的库（含 natives 变体）
                for lib in &v.libraries {
                    if let Some(rel) = metadata::maven_path(&lib.name) {
                        keep_libraries.insert(std::path::PathBuf::from(rel));
                    }
                    // 老格式 natives：classifier 模板展开后的 jar 也要保留
                    for classifier in lib.natives.values() {
                        let expanded = metadata::resolve_natives_classifier(classifier);
                        if let Some(rel) = metadata::maven_path(&format!(
                            "{}:{}",
                            lib.name,
                            expanded
                        )) {
                            keep_libraries.insert(std::path::PathBuf::from(rel));
                        }
                    }
                    // 有的库用 downloads.classifiers 指定路径
                    if let Some(d) = &lib.downloads {
                        for c in d.classifiers.values() {
                            if let Some(path) = &c.path {
                                keep_libraries.insert(std::path::PathBuf::from(path));
                            }
                        }
                    }
                }
                // 这个版本的资源索引里的每个 hash
                if let Some(idx) = &v.asset_index {
                    let idx_path = shared
                        .join("assets")
                        .join("indexes")
                        .join(format!("{}.json", idx.id));
                    if let Ok(itext) = std::fs::read_to_string(&idx_path) {
                        if let Ok(index) = serde_json::from_str::<metadata::AssetIndex>(&itext) {
                            for obj in index.objects.values() {
                                keep_assets.insert(obj.hash.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // ---------- ② 扫两棵树，找出没人引用的文件 ----------
    let mut candidates: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut total_bytes = 0u64;

    // libraries/
    let lib_root = shared.join("libraries");
    collect_files(&lib_root, &mut |p, len| {
        let Ok(rel) = p.strip_prefix(&lib_root) else {
            return;
        };
        // `.part` / `.part.N` 是断点续传残留 —— 绝不能当垃圾清理
        if is_part_file(p) {
            return;
        }
        if !keep_libraries.contains(rel) {
            candidates.push((p.to_path_buf(), len));
            total_bytes += len;
        }
    });

    // assets/objects/
    let obj_root = shared.join("assets").join("objects");
    collect_files(&obj_root, &mut |p, len| {
        if is_part_file(p) {
            return;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !keep_assets.contains(&name) {
            candidates.push((p.to_path_buf(), len));
            total_bytes += len;
        }
    });

    // ---------- ③ 真删（或只报告）----------
    let mut removed = 0usize;
    let mut sample: Vec<String> = Vec::new();
    if !dry_run {
        for (p, _) in &candidates {
            if std::fs::remove_file(p).is_ok() {
                removed += 1;
                if sample.len() < 5 {
                    sample.push(
                        p.strip_prefix(shared)
                            .unwrap_or(p)
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
        }
        // 顺手清掉空目录（不然 libraries/ 下会留一堆空壳）
        prune_empty_dirs(&lib_root);
        prune_empty_dirs(&obj_root);
    }

    Ok(CleanReport {
        version_jsons_scanned: version_jsons,
        kept_libraries: keep_libraries.len(),
        kept_assets: keep_assets.len(),
        candidates: candidates.len(),
        removed,
        total_bytes,
        dry_run,
        sample,
    })
}

#[derive(serde::Serialize)]
pub struct CleanReport {
    /// 扫了多少份版本 JSON（保留集就是它们算出来的）
    pub version_jsons_scanned: usize,
    pub kept_libraries: usize,
    pub kept_assets: usize,
    /// 没有被任何版本引用的文件数
    pub candidates: usize,
    /// 实际删掉的文件数（dry_run 时为 0）
    pub removed: usize,
    /// 这些文件的总字节数
    pub total_bytes: u64,
    pub dry_run: bool,
    /// 被删文件的样例（让用户看得见删了什么）
    pub sample: Vec<String>,
}

/// 断点续传的临时文件：`xxx.part` / `xxx.part.3` / `xxx.part.chunks`
fn is_part_file(p: &std::path::Path) -> bool {
    p.to_string_lossy().contains(".part")
}

/* ==================================================================
   ★★ 清理"可再生的东西"（0.1.0-beta.3）

   用户的原话：「启动器数据也很大，应该优化一下启动器数据的大小」。

   先量了一遍（实测 D:\IEML = 1.73 GB），构成是这样的：
     assets 816 MB + libraries 587 MB  ← **真正的游戏文件**，删了就得重下
     versions 269 MB                   ← 已装的版本本体
     instances 74 MB                   ← 存档 / Mod / 配置（用户的）
     cache 27 MB                       ← 安装器与元数据缓存（**可再生**）
     logs ~0 MB                        ← 每次启动一份的日志（**可再生**）

   也就是说：**大头是游戏文件，不是垃圾**。真正能安全回收的只有 cache/ 与 logs/。
   所以这一条命令的判据刻意收得很窄 —— 只碰这两棵树，别的一律不碰：

     · `cache/`：Forge / OptiFine 安装器（几十 MB，用完就没用，要时重下）
       与元数据 JSON 缓存（版本清单、加载器列表，联网即可重建）
     · `logs/`：**每次启动一份**的启动日志，只保留最近 N 份
       （崩溃分析读的是最近那份，所以不能全删）

   ★ 为什么不做成一个"一键清 1.4 GB"的按钮：那 1.4 GB 是**用户的游戏**。
     `clean_unused_files` 负责的是"没有任何版本引用的库与资源"（那才是真的多余），
     两者判据不同，所以是两条命令 —— 混在一起迟早会误删。
   ================================================================== */

/// 启动日志保留多少份（崩溃分析只需要最近那一份，留几份是给人翻的）
const KEEP_LAUNCH_LOGS: usize = 5;

#[derive(serde::Serialize)]
pub struct CacheCleanReport {
    /// 缓存的安装器（Forge / OptiFine 等）文件数
    pub installer_files: usize,
    /// 元数据 JSON 缓存数（版本清单 / 加载器列表 / 各类 v2_*.json）
    pub metadata_files: usize,
    /// 启动日志：可删的份数
    pub log_files: usize,
    /// 保留的启动日志份数（最近 N 份）
    pub logs_kept: usize,
    /// 以上三类合计字节数
    pub total_bytes: u64,
    /// 实际删掉的字节数（dry_run 时为 0）
    pub removed_bytes: u64,
    pub dry_run: bool,
    /// 删掉的东西的样例（让用户看得见删了什么）
    pub sample: Vec<String>,
}

/// 清理可再生数据：安装器缓存 + 元数据缓存 + 旧的启动日志。
///
/// `dry_run = true` 时只统计 —— 前端先用它把"能释放多少"告诉用户，
/// 用户确认后再真删（与 `clean_unused_files` 同一套两段式流程）。
#[tauri::command]
pub fn clean_caches(
    dry_run: bool,
    state: State<'_, AppState>,
) -> Result<CacheCleanReport, String> {
    let cache = state.paths().cache.clone();
    let logs = state.paths().logs.clone();

    let mut installer_files = 0usize;
    let mut installer_bytes = 0u64;
    let mut metadata_files = 0usize;
    let mut metadata_bytes = 0u64;
    let mut sample: Vec<String> = Vec::new();

    // ---------- ① cache/：安装器与元数据 ----------
    if let Ok(rd) = std::fs::read_dir(&cache) {
        for e in rd.flatten() {
            let p = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                continue; // 缓存目录下有子目录的话不猜，先不动
            }
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let is_installer = name.ends_with("-installer.jar")
                || name.ends_with("_installer.jar")
                || name.starts_with("forge-") && name.ends_with(".jar")
                || name.starts_with("OptiFine_") && name.ends_with(".jar");
            if is_installer {
                installer_files += 1;
                installer_bytes += meta.len();
            } else {
                metadata_files += 1;
                metadata_bytes += meta.len();
            }
            if sample.len() < 8 {
                sample.push(name);
            }
            if !dry_run {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // ---------- ② logs/：只保留最近 N 份 ----------
    let mut log_files = 0usize;
    let mut log_bytes = 0u64;
    let mut logs_kept = 0usize;
    if let Ok(rd) = std::fs::read_dir(&logs) {
        // 按修改时间倒序，前 N 份留下
        let mut entries: Vec<(std::time::SystemTime, std::path::PathBuf, u64)> = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            entries.push((
                meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                p,
                meta.len(),
            ));
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        for (i, (_, p, len)) in entries.into_iter().enumerate() {
            if i < KEEP_LAUNCH_LOGS {
                logs_kept += 1;
                continue;
            }
            log_files += 1;
            log_bytes += len;
            if sample.len() < 12 {
                sample.push(format!(
                    "logs/{}",
                    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
                ));
            }
            if !dry_run {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    let total_bytes = installer_bytes + metadata_bytes + log_bytes;
    Ok(CacheCleanReport {
        installer_files,
        metadata_files,
        log_files,
        logs_kept,
        total_bytes,
        removed_bytes: if dry_run { 0 } else { total_bytes },
        dry_run,
        sample,
    })
}

/// 递归遍历文件（目录不回调）
fn collect_files(dir: &std::path::Path, f: &mut impl FnMut(&std::path::Path, u64)) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_files(&p, f);
        } else {
            f(&p, meta.len());
        }
    }
}

/// 自底向上删掉空目录（只删空的，绝不递归删有内容的）
fn prune_empty_dirs(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut has_child = false;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            prune_empty_dirs(&p);
            // 子目录清理完再看它是不是空了
            if std::fs::read_dir(&p).map(|mut r| r.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(&p);
            } else {
                has_child = true;
            }
        } else {
            has_child = true;
        }
    }
    let _ = has_child;
}

/* ====================== 已安装 Mod 清单 ====================== */

/// 磁盘上的一个 Mod 文件 + （可选）在线库反查到的信息。
#[derive(serde::Serialize)]
pub struct ModScanEntry {
    pub file_name: String,
    pub display_name: String,
    pub path: String,
    pub enabled: bool,
    pub bytes: u64,
    pub mtime_ms: u64,
    /// 文件 SHA1（只在 `remote == true` 时算过；前端要用于反向定位）
    pub sha1: Option<String>,
    /// ★★ **CurseForge 指纹**（MurmurHash2，十进制字符串）——
    ///    只在"这个文件真的在 CurseForge 上被认出来了"时给（ADR-052）。
    ///
    ///    为什么不无条件下发：指纹本身说明不了任何事（它只是一串数），
    ///    只有**反查命中**才有意义 —— 给一个查不到的指纹只会让界面
    ///    多显示一个没用的字段。
    pub fingerprint: Option<String>,
    /// 在线库信息（没反查到就是 None —— **不编造**）
    pub remote: Option<ModRemote>,
}

#[derive(serde::Serialize)]
pub struct ModRemote {
    /// `modrinth`
    pub source: String,
    pub project_id: String,
    /// 版本号（`version_number`）
    pub version: String,
    /// ★ 项目标题（不是文件里的名字）。这是"Mod 列表"最该显示的东西 ——
    ///   文件名常常是 `sodium-fabric-mc1.20.1-0.5.11.jar` 这种，用户认不出来。
    pub title: String,
    /// 项目简介（一句话）
    pub description: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    /// 是不是"前置库"（别的 Mod 依赖它）
    pub is_library: bool,
    /// 下载量（用于排序与判断"这是不是主流库"）
    pub downloads: u64,
    pub icon_url: Option<String>,
}

/// 扫描实例的 mods 目录，并**按 SHA1 去 Modrinth 反查真实信息**。
///
/// 这是「mod 列表」这个功能的实质：只读文件名只能给出一串 `xxx-1.2.3.jar`，
/// 而用户想知道的是"这是什么 Mod、什么版本、支不支持我现在这个版本、
/// 有没有更新"。这些信息只有一个来源 —— **文件哈希反查在线库**（ADR-019）。
///
/// 流程：
///   ① 扫目录（含 `.disabled` 后缀的禁用文件）
///   ② 并行为每个文件算 SHA1（大文件也不卡 UI，全在 Rust 侧）
///   ③ 分批 `POST /v2/version_files` 反查（一批 100 个，减少请求数）
///   ④ 项目标题/简介/前置库标记来自 `/v2/projects`（**批量**，只问反查到的那些）
///
/// 任何一步失败都**只降级不报错**：反查不到就是 `remote: null`，
/// 界面显示文件名 —— 有信息就显示信息，没信息就说没信息，不编。
#[tauri::command]
pub async fn scan_mods_detailed(
    slug: String,
    mc_version: String,
    loader_kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ModScanEntry>, String> {
    let dir = state.paths().instance_mods_dir(&slug);
    let mut files: Vec<(String, std::path::PathBuf, u64, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if !crate::domain::mods::is_mod_file(&name) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            files.push((name, p, meta.len(), mtime_ms));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));

    // ② 算 SHA1（cpu 密集但文件小；百来个 Mod 加起来也就几百 MB）
    //
    // ★ 顺带算 **CurseForge 指纹（MurmurHash2）**：那是"这个 Mod 在
    //   CurseForge 上是谁"的唯一钥匙（ADR-052）。两次读盘没必要合成一次，
    //   因为 SHA1 与指纹的**输入预处理不同**（指纹要先剔除空白字符），
    //   合在一起写只会让两边都难读 —— 这里读一次、算两个值。
    let mut hashed: Vec<ModHashedFile> = Vec::new();
    for (name, path, bytes, mtime) in files {
        let data = std::fs::read(&path).ok();
        let sha1 = data
            .as_ref()
            .map(|d| {
                use sha1::{Digest, Sha1};
                let mut h = Sha1::new();
                h.update(d);
                format!("{:x}", h.finalize())
            })
            .unwrap_or_default();
        let fingerprint = data
            .as_ref()
            .map(|d| crate::net::curseforge::fingerprint(d))
            .unwrap_or(0);
        hashed.push(ModHashedFile {
            name,
            path,
            bytes,
            mtime,
            sha1,
            fingerprint,
        });
    }

    // ③ 批量反查（只在有 sha1 时）
    let all_hashes: Vec<String> = hashed
        .iter()
        .map(|h| h.sha1.clone())
        .filter(|s| !s.is_empty())
        .collect();
    let mut versions: HashMap<String, modrinth::ProjectVersion> = HashMap::new();
    for chunk in all_hashes.chunks(100) {
        if let Ok(m) = modrinth::versions_from_hashes(chunk).await {
            versions.extend(m);
        }
    }

    /*
     * ③b ★★ **CurseForge 反查**（ADR-052）：Modrinth 查不到的那些，
     *     很可能只在 CurseForge 上发布（OptiFabric 就是活例子，见 ADR-050）。
     *     指纹是唯一能查的钥匙，一次请求最多 100 个。
     *
     *     ★ 用 SHA1 **交叉验证**：命中结果里带该文件的 SHA1，与本地 SHA1
     *       对不上就**不采信**（万一对应关系变了，最多"查不到更新"，
     *       绝不会"给用户装错 Mod 的更新"）。
     */
    let mut cf_remote: HashMap<u32, (crate::net::curseforge::FingerprintMatch, u32)> = HashMap::new();
    {
        let fps: Vec<u32> = hashed
            .iter()
            .filter(|h| !h.sha1.is_empty() && !versions.contains_key(&h.sha1))
            .map(|h| h.fingerprint)
            .filter(|f| *f != 0)
            .collect();
        for chunk in fps.chunks(100) {
            let Ok(hits) = crate::net::curseforge::match_fingerprints(chunk).await else {
                // 查不到就降级（与 Modrinth 那条一样：不报错，只是没有远端信息）
                continue;
            };
            for (fp, hit) in hits {
                let local = hashed.iter().find(|h| h.fingerprint == fp);
                match local {
                    Some(l) if l.sha1.eq_ignore_ascii_case(&hit.sha1) => {
                        cf_remote.insert(fp, (hit, l.fingerprint));
                    }
                    Some(l) => say!(
                        "[IEML/curseforge] 指纹 {} 命中了 {}，但它报的 SHA1（{}）与本地（{}）不一致 —— 不采信",
                        fp,
                        hit.file_name,
                        short_hash(&hit.sha1),
                        short_hash(&l.sha1)
                    ),
                    None => { /* 我们没查过这个指纹（不该发生，忽略） */ }
                }
            }
        }
    }

    // ④ 批量取项目信息（标题/简介/前置库）
    let project_ids: Vec<String> = versions
        .values()
        .map(|v| v.project_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let mut projects: HashMap<String, modrinth::Project> = HashMap::new();
    for chunk in project_ids.chunks(80) {
        if let Ok(m) = modrinth::projects_by_ids(chunk).await {
            projects.extend(m);
        }
    }

    let _ = (&mc_version, &loader_kind); // 过滤交给前端 domain（规则只有一份）

    Ok(hashed
        .into_iter()
        .map(|h| {
            let ModHashedFile {
                name: file_name,
                path,
                bytes,
                mtime: mtime_ms,
                sha1,
                fingerprint,
            } = h;

            // Modrinth 优先；查不到再看 CurseForge 的命中
            let remote = versions
                .get(&sha1)
                .map(|v| {
                    let p = projects.get(&v.project_id);
                    ModRemote {
                        source: "modrinth".to_string(),
                        project_id: v.project_id.clone(),
                        version: v.version_number.clone(),
                        title: p
                            .map(|x| x.title.clone())
                            .unwrap_or_else(|| v.name.clone()),
                        description: p.map(|x| x.description.clone()).unwrap_or_default(),
                        game_versions: v.game_versions.clone(),
                        loaders: v.loaders.clone(),
                        is_library: p
                            .map(|x| {
                                x.project_type != "mod"
                                    || x.categories.iter().any(|c| {
                                        c.eq_ignore_ascii_case("library")
                                            || c.eq_ignore_ascii_case("lib")
                                    })
                            })
                            .unwrap_or(false),
                        downloads: p.map(|x| x.downloads).unwrap_or(v.downloads),
                        icon_url: p.and_then(|x| x.icon_url.clone()),
                    }
                })
                .or_else(|| {
                    cf_remote.get(&fingerprint).map(|(hit, _)| ModRemote {
                        source: "curseforge".to_string(),
                        project_id: hit.mod_id.to_string(),
                        // ★ 指纹只告诉我们"是哪个文件"，项目标题要另取 ——
                        //   这里先如实给文件名，界面显示的就是真值（不是猜的标题）
                        version: hit.file_name.clone(),
                        title: hit.file_name.clone(),
                        description: String::new(),
                        game_versions: Vec::new(),
                        loaders: Vec::new(),
                        is_library: false,
                        downloads: 0,
                        icon_url: None,
                    })
                });

            ModScanEntry {
                display_name: crate::domain::mods::display_name_of(&file_name),
                enabled: crate::domain::mods::is_enabled(&file_name),
                file_name,
                path: path.to_string_lossy().to_string(),
                bytes,
                mtime_ms,
                sha1: (!sha1.is_empty()).then_some(sha1),
                fingerprint: (fingerprint != 0 && cf_remote.contains_key(&fingerprint))
                    .then(|| fingerprint.to_string()),
                remote,
            }
        })
        .collect())
}

/// 扫 Mod 时每个文件的中间结果（读过一次盘，后面都用它）
struct ModHashedFile {
    name: String,
    path: std::path::PathBuf,
    bytes: u64,
    mtime: u64,
    sha1: String,
    /// CurseForge 指纹（MurmurHash2）
    fingerprint: u32,
}

/// 哈希串只显示前 8 位（日志里够分辨，又不至于刷屏）
fn short_hash(s: &str) -> String {
    s.chars().take(8).collect()
}

/// 检查一批 Mod 有没有更新：返回 `hash → 该项目兼容当前实例的最新版本`。
///
/// ★ 为什么在 Rust 侧做：每个 Mod 一次 HTTP 请求，放在前端做就是几十个
///   并发请求 + 各自的错误处理；在这里做能统一限流、统一超时，也不会卡 UI。
///   `limit` 限制最多检查多少个（默认 40），用户点一次不会打出上百个请求。
///
/// ## `fingerprints`：CurseForge 那一路（ADR-052）
///
///   Modrinth 用 SHA1 反查；CurseForge **只认 MurmurHash2 指纹**。
///   两个列表都传进来，逐个文件按"先 Modrinth、查不到再 CurseForge"走 ——
///   这样一个只发布在 CurseForge 的 Mod 也能被认出"有更新"。
#[tauri::command]
pub async fn check_mod_updates(
    hashes: Vec<String>,
    fingerprints: Option<Vec<String>>,
    mc_version: String,
    loader_kind: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ModUpdateCandidate>, String> {
    let max = limit.unwrap_or(40).clamp(1, 200);
    let mut out = Vec::new();

    /* ---------- ① CurseForge 那一路：一次请求查一批（省额度） ---------- */
    /*
     * ★★ 两个列表**按位置一一对应**（第 i 个指纹属于第 i 个 hash）。
     *
     *   所以这里用 `Vec<Option<u32>>` **保持位置**：没有指纹的文件传空串，
     *   解析成 `None` 但**不塌缩数组** —— 塌缩会让后面所有文件都错位一格，
     *   而表现是"给某个 Mod 装了另一个 Mod 的更新"。
     */
    let fps: Vec<Option<u32>> = fingerprints
        .unwrap_or_default()
        .iter()
        .map(|s| s.trim().parse::<u32>().ok())
        .collect();
    let known: Vec<u32> = fps.iter().flatten().copied().collect();
    let mut cf_hits: HashMap<u32, crate::net::curseforge::FingerprintMatch> = HashMap::new();
    if !known.is_empty() {
        for chunk in known.chunks(100) {
            match crate::net::curseforge::match_fingerprints(chunk).await {
                Ok(m) => cf_hits.extend(m),
                Err(e) => {
                    /*
                     * ★ 降级但不装死：CurseForge 查不到时说清"这一路没工作"，
                     *   而不是让用户以为"所有 Mod 都没有更新"。
                     */
                    say!("[IEML/curseforge] 指纹反查失败（{e}）—— 这一轮只查 Modrinth");
                    break;
                }
            }
        }
    }

    for (i, sha1) in hashes.into_iter().take(max).enumerate() {
        /* ---------- ② Modrinth 优先 ---------- */
        if let Ok(Some(current)) = modrinth::version_from_hash(&sha1).await {
            let Ok(list) = modrinth::project_versions(
                &current.project_id,
                Some(&mc_version),
                loader_kind.as_deref(),
            )
            .await
            else {
                continue;
            };
            let Some(latest) = list.first() else { continue };
            if latest.id == current.id {
                continue;
            }
            out.push(ModUpdateCandidate {
                sha1,
                fingerprint: None,
                source: "modrinth".to_string(),
                project_id: current.project_id.clone(),
                current_version: current.version_number.clone(),
                latest_version: latest.version_number.clone(),
                latest_version_id: latest.id.clone(),
                download_url: latest
                    .files
                    .iter()
                    .find(|f| f.primary)
                    .or_else(|| latest.files.first())
                    .map(|f| f.url.clone())
                    .unwrap_or_default(),
                file_name: latest
                    .files
                    .iter()
                    .find(|f| f.primary)
                    .or_else(|| latest.files.first())
                    .map(|f| f.filename.clone())
                    .unwrap_or_default(),
            });
            continue;
        }

        /* ---------- ③ 再试 CurseForge（按指纹） ---------- */
        let Some(fp) = fps.get(i).copied().flatten() else { continue };
        let Some(hit) = cf_hits.get(&fp) else { continue };
        let Ok(list) = crate::net::curseforge::files(
            &hit.mod_id.to_string(),
            crate::domain::resources::ResourceKind::Mod,
            Some(&mc_version),
            loader_kind.as_deref(),
            50,
        )
        .await
        else {
            continue;
        };
        let Some(latest) = list.first() else { continue };
        if latest.id == hit.file_id.to_string() {
            continue;
        }
        let file = latest.files.first();
        out.push(ModUpdateCandidate {
            sha1,
            fingerprint: Some(fp.to_string()),
            source: "curseforge".to_string(),
            project_id: hit.mod_id.to_string(),
            current_version: hit.file_name.clone(),
            latest_version: latest.version_number.clone(),
            latest_version_id: latest.id.clone(),
            // ★ CurseForge 下载要走**多候选**（官方 CDN 在本机时好时坏）
            download_url: file.map(|f| f.url.clone()).unwrap_or_default(),
            file_name: file.map(|f| f.filename.clone()).unwrap_or_default(),
        });
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct ModUpdateCandidate {
    /// 当前文件的 SHA1（前端用它定位是列表里的哪一个）
    pub sha1: String,
    /// 当前文件的 CurseForge 指纹（走 CurseForge 那一路时有值）
    pub fingerprint: Option<String>,
    /// 这次是从哪个源查到的（`modrinth` / `curseforge`）
    pub source: String,
    pub project_id: String,
    pub current_version: String,
    pub latest_version: String,
    pub latest_version_id: String,
    pub download_url: String,
    pub file_name: String,
}

/// 下载并安装**任意一种社区资源**到实例里（Mod / 资源包 / 光影 / 数据包）。
///
/// ## 为什么要有这一条（而不是继续只用 `install_mod`）
///
/// 用户要的是"社区资源子系统"（照 PCL 的 `Modules/Resource/*`）。
/// PCL 那边 Mod / 整合包 / 资源包 / 光影 / 数据包**共用同一套抽象**，
/// 差别只有三个字段：到哪查、装到哪、认哪些扩展名。
/// 我们原来只做了 Mod 一种，而且安装目录是**写死**在 `install_mod` 里的。
///
/// 现在目录由 `domain::resources::ResourceKind::install_dir()` 给 ——
/// 四种资源的落盘位置**只有一份描述**。写错一个字母，文件就装到
/// 游戏看不见的地方，而界面还会说"装好了"（这类 bug 这个仓库修过一次：
/// 曾经把 Mod 下到 `instances/{slug}/mods`，而游戏只读 `game/mods`）。
///
/// ## 落盘位置必须是 `<gameDir>/<资源目录>`
///
/// 游戏进程的工作目录是 `instances/{slug}/game`（`--gameDir`），
/// 它只会在 `game/resourcepacks`、`game/shaderpacks`、`game/datapacks`
/// 里找东西。所以四条路径**全部**挂在 `instance_game_dir` 下面。
#[tauri::command]
pub async fn install_resource(
    kind: String,
    url: String,
    filename: String,
    slug: String,
    sha1: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let k = crate::domain::resources::parse_kind(&kind)
        .ok_or_else(|| format!("不认识的资源种类「{kind}」"))?;

    /*
     * ★ 文件名要过一遍判据（扩展名 + 不许是临时/禁用文件）。
     *
     *   为什么不能直接把 Modrinth 给的 filename 拼进路径：
     *   那个字符串来自**外部**。虽然 Modrinth 不会给 `../../x`，
     *   但"外部输入直接当路径用"是这个项目明确要避免的一类问题
     *   （slug 那套越界校验就是为它加的）。
     */
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("文件名不合法：{filename}"))?;
    if !crate::domain::resources::filename_matches(k, &safe_name) {
        return Err(format!(
            "「{safe_name}」不像一个{}——它应当是 {} 结尾。\n\
             （不猜：装一个扩展名不对的文件，游戏一定读不到它）",
            k.display(),
            k.extensions().join(" / ")
        ));
    }

    let dir = state.paths().instance_resource_dir(&slug, k);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);

    let task = download::DownloadTask::new(
        path.clone(),
        url.clone(),
        // 上游给的 sha1 直接用来校验；没有就退化为不校验（不假装校验过）
        sha1.unwrap_or_default(),
        0,
        safe_name.clone(),
    );
    /*
     * ★★ **同一份内容要有多条下载路**（ADR-052）。
     *
     *   CurseForge 的官方 CDN（`edge.forgecdn.net`）在本机**时好时坏**：
     *   同一个地址一次 200（2.5 MB 全拿到）、一次连接失败、一次 404 ——
     *   而同一份内容换 `mediafilez.forgecdn.net` 或 mcimirror 就稳定。
     *   所以按 URL 推导出候选（不额外请求、也不需要知道文件 id 之外的任何东西）。
     *
     *   Modrinth 的地址推导不出候选（没有这个规律），函数会原样返回空 ——
     *   于是它的行为和以前完全一样。
     */
    let mut task = task;
    task.urls = crate::net::curseforge::candidates_from_url(&url);
    let cancel = CancelToken::new();
    download::download_one(&task, Source::Bmclapi, &cancel)
        .await
        .map_err(err)?;

    say!(
        "[IEML/resource] 已装{}「{safe_name}」→ {}",
        k.display(),
        path.display()
    );
    Ok(path.to_string_lossy().to_string())
}

/// 下载一个 Mod 文件到实例的 mods 目录（slug 是实例的目录 slug）
///
/// ★ 落盘位置必须是 `instances/{slug}/game/mods`：
///   游戏进程的工作目录是 `instances/{slug}/game`，Forge/Fabric 只会在
///   `<gameDir>/mods` 里找 Mod。写到 `instances/{slug}/mods` 的话，
///    Mod 管理页看得到、游戏里却永远加载不到 —— 这个 bug 已经修过一次。
#[tauri::command]
pub async fn install_mod(
    url: String,
    filename: String,
    slug: String,
    sha1: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mods_dir = state.paths().instance_mods_dir(&slug);
    std::fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;
    let path = mods_dir.join(&filename);

    let task = download::DownloadTask::new(
        path.clone(),
        url,
        // Modrinth 给的 sha1 直接用来校验；没有就退化为不校验（不假装校验过）
        sha1.unwrap_or_default(),
        0,
        filename.clone(),
    );
    let cancel = CancelToken::new();
    download::download_one(&task, Source::Bmclapi, &cancel)
        .await
        .map_err(err)?;

    Ok(path.to_string_lossy().to_string())
}

/// ★★ 自动安装 API 前置包（Fabric API / Quilted Fabric API）★★
///
/// ## 为什么必须有这一步
///
/// 界面上一直写着「将自动安装 Fabric API」，`combination.ts` 会把它列出来、
/// 体积也计入了估算 —— 但**安装流程里从来没有这一步**。
/// 后果是最要命的一类：用户装完 Fabric、把 Mod 丢进 mods 目录，
/// 启动就崩，日志里只有一句 `requires fabric-api`。
/// 而启动器的崩溃分析还得"猜"出这是缺前置包。
///
/// ## 版本号必须**动态查询**，不能硬编码
///
/// 内置表里那个 `0.92.2+1.20.1` 是手抄的：Fabric API 的版本号与 MC 版本**强绑定**
/// （`0.92.2+1.20.1`、`0.92.2+1.20.4` 是不同 artifact），而且几乎每个 MC 版本
/// 都有自己的一条。硬编码的结果就是"换个版本就装不上"。
/// 所以这里走 Modrinth 的正式查询（ADR-009：API 前置包版本动态查询，禁止硬编码）：
///   `/project/{slug}/version?game_versions=["1.20.1"]&loaders=["fabric"]`
///
/// ## 装不上不算失败
///
/// Modrinth 挂了、或者这个 MC 版本确实没有对应的 API 包 —— 都不该让**整个安装**失败。
/// 这一条是"锦上添花"的准备动作：装不上就如实告诉用户，游戏本体照样装好。
///
/// ## 这里是薄壳
///
/// 真正的逻辑在 `install_api_library_for` —— 整合包安装路径（`modpack_install`）
/// 也要用同一份规则，而那个函数拿不到 Tauri 注入的 `State`。
/// **规则只有一份**（ADR-001）：命令负责注入依赖，函数负责做事。
#[tauri::command]
pub async fn install_api_library(
    slug: String,
    mc_version: String,
    base: String,
    state: State<'_, AppState>,
) -> Result<ApiLibInstall, String> {
    install_api_library_for(
        &state.paths().instance_mods_dir(&slug),
        &mc_version,
        &base,
        Source::Bmclapi,
    )
    .await
}

/// ★★ **自动安装 OptiFine**（用户要求「高清修复的自动安装也该实装」）。
///
/// 实现走 `net::optifine`（照 PCL 的 `McDownloadOptiFineInstall` 写的），
/// 这里只做四件事：找版本 → 选 Java → 下载 → 装。
///
/// 选 Java 的判据是**读安装器自己的 class 头**（PCL 的做法）：
/// 不同年代的 OptiFine 安装器用不同 Java 编译，拿太老的 Java 跑它会
/// `UnsupportedClassVersionError`。读盘比任何版本表都准。
#[tauri::command]
pub async fn install_optifine(
    mc_version: String,
    optifine_version: String,
    state: State<'_, AppState>,
) -> Result<crate::net::optifine::OptiFineInstall, String> {
    // ① 拿真实清单，找到用户选的那一条
    let list = crate::net::metadata::optifine_versions(&mc_version)
        .await
        .map_err(err)?;
    let v = list
        .iter()
        .find(|x| x.version == optifine_version)
        .ok_or_else(|| {
            format!(
                "OptiFine 清单里没有「{optifine_version}」这个版本（{mc_version} 共有 {} 个版本）",
                list.len()
            )
        })?
        .clone();

    // ② 下载安装器
    let installer = crate::net::optifine::download_installer(
        &state.paths().cache,
        &mc_version,
        &v,
        Source::Bmclapi,
    )
    .await?;

    // ③ 安装器要哪个 Java —— 读它自己的 class 头
    let need = crate::net::optifine::required_java_major(&installer)
        .map_err(|e| format!("读不出 OptiFine 安装器需要的 Java 版本：{e}"))?;

    // ④ 从本机挑一个满足要求的（优先 IEML 自己下的，其次系统扫到的）
    let runtimes = crate::platform::scan_java(&state.paths());
    let java = runtimes
        .iter()
        .filter(|r| r.major >= need && !r.disabled_by_default)
        .min_by_key(|r| r.major)
        .ok_or_else(|| {
            format!(
                "OptiFine 的安装器需要 Java {need} 或更高，但本机没有。\n\
                 本机扫到的 Java：{}\n\n\
                 请到「设置 → Java 运行环境」下载一个。",
                if runtimes.is_empty() {
                    "（一个都没有）".to_string()
                } else {
                    runtimes
                        .iter()
                        .map(|r| format!("{} {}", r.major, r.vendor))
                        .collect::<Vec<_>>()
                        .join("、")
                }
            )
        })?;

    let progress = |_msg: String| {};
    crate::net::optifine::install(
        &state.paths().shared,
        &mc_version,
        &v,
        &installer,
        std::path::Path::new(&java.path),
        &progress,
    )
    .await
}

/// ★★ **自动安装 LiteLoader**（用户要求「liteloader 的自动安装也该实装」）。
///
/// 与 OptiFine 不同：LiteLoader **没有安装器**，就是"挂一个 tweaker + 几个库"。
/// 所以这里做三件事：拉清单 → 定挂载点 → 写版本 JSON + **把三个 jar 真的下下来**。
/// 实现见 `net::liteloader`（照 PCL 的 `McDownloadLiteLoaderLoader` 写的）。
///
/// ## 挂载点（这一版新修的）
///
/// 界面的组合规则写着「LiteLoader 必须有 Forge 作基座」，但版本描述里
/// `inheritsFrom` 原先**写死成 mc_version**。两边对不上：
/// 用户勾了 Forge + LiteLoader，装出来的却是挂在原版上的 LiteLoader ——
/// Forge 的库一个都不在 classpath 里，启动就缺库。
/// （安装时不报错，所以纯靠"看装没装成"是发现不了的。）
///
/// 现在按**基座加载器**决定挂载点：
///   · `base_loader_kind` = `forge`  → 找到本机那个 Forge 版本目录（`{mc}-forge-{ver}`）
///   · 其它 / 没给                → 挂原版
/// 找不到就**报错**，不偷偷退化（见 `net::liteloader::install` 里的说明）。
#[tauri::command]
pub async fn install_liteloader(
    mc_version: String,
    base_loader_kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::net::liteloader::LiteLoaderInstall, String> {
    let v = crate::net::liteloader::available_for(&mc_version)
        .await?
        .ok_or_else(|| {
            format!(
                "上游没有 {mc_version} 的 LiteLoader。\n\
                 LiteLoader 只支持 1.7.10 ~ 1.12.2 这一段（它已经停止维护了）。\n\
                 实测支持的版本：1.5.2 / 1.6.2 / 1.6.4 / 1.7.2 / 1.7.10 / 1.8 / 1.8.9 / \
                 1.9 / 1.9.4 / 1.10 / 1.10.2 / 1.11 / 1.11.2 / 1.12 / 1.12.1 / 1.12.2"
            )
        })?;

    // ★ 定挂载点：只有基座是 Forge 系列时才去找 Forge 版本目录
    let mount = liteloader_mount_point(
        &state.paths().shared,
        &mc_version,
        base_loader_kind.as_deref(),
    );
    if let Some(m) = &mount {
        if m != &mc_version && !state
            .paths()
            .shared
            .join("versions")
            .join(m)
            .join(format!("{m}.json"))
            .is_file()
        {
            return Err(format!(
                "「{}」要求的 LiteLoader 要挂在 {m} 上，但版本目录里没有它。\n\n\
                 请先在本页把这个版本的 Forge 装好，再回来装 LiteLoader。",
                mc_version
            ));
        }
    }

    let progress = |_m: String| {};
    crate::net::liteloader::install(
        &state.paths().shared,
        &mc_version,
        &v,
        mount.as_deref(),
        &progress,
    )
    .await
}

/// ★ LiteLoader 该挂在哪个版本目录上（纯函数，可单测）。
///
/// 返回 `None` = 挂原版（等于 `Some(mc_version)`，但语义更清楚）。
///
/// 判据：
///   ① 基座**不是** Forge 系列 → 挂原版（NeoForge/Fabric 上本来就不让装，
///      真到这一步也只会是原版）
///   ② 基座是 Forge → 在 `versions/` 里找「属于这个 MC 版本、带 forge 痕迹、
///      且有版本描述文件」的目录。找到就用它
///   ③ 找不到 → 返回 `None`（挂原版）。**为什么不在这里报错**：
///      调用方要给出"请先装 Forge"的提示，而"没找到"这个事实本身在
///      纯函数里说不清楚；所以把判断留给调用方，这里只负责事实。
fn liteloader_mount_point(
    shared: &std::path::Path,
    mc_version: &str,
    base_loader_kind: Option<&str>,
) -> Option<String> {
    let kind = base_loader_kind.filter(|k| !k.is_empty())?;
    if !kind.eq_ignore_ascii_case("forge") {
        return None;
    }
    resolve_loader_version_id(shared, mc_version, Some("forge"), None)
}

/// 一个实例的 mods 目录（与 `scan_mods` / `install_mod` 同一来源）
#[derive(serde::Serialize, Debug)]
pub struct ApiLibInstall {
    /// 我们内部的 kind 名：`fabric-api` / `quilted-fabric-api`
    pub kind: String,
    /// Modrinth 上真正的 project slug（Quilt 的是 `qsl`，见 `api_library_project`）
    pub project: String,
    pub installed: bool,
    pub version: Option<String>,
    pub filename: Option<String>,
    pub path: Option<String>,
    /// 没装成时的**具体原因**（不阻断安装，但要如实说）
    pub note: Option<String>,
}

/// ★★ 这个版本的**前置包**装了没有？（Fabric API / Quilted Fabric API）
///
/// ## 为什么要单独一条命令（用户报「Fabic 版本不会自动安装 API 这个 mod」）
///
///   自动安装只发生在**创建实例**的那条路径上（`InstallComposer`）。
///   于是一个真实存在、而且一定会发生的情况是：
///     · 用户的 Fabric 实例是**在自动安装做出来之前**建的 → 一直没有 API；
///     · 或者创建那一步失败了（网络抖动），事后**没有任何地方能补**。
///   结果就是他说的那个现象：装的是 Fabric，但 mods 目录里空空如也，
///   之后装的每个依赖 Fabric API 的 Mod 都会在启动时崩（`requires fabric-api`）。
///
///   "创建时帮你装好"是好意，但**只有创建那一次机会**就不够了 ——
///   状态会漂移（用户手动删了、装失败、老实例），所以必须能**随时检查、随时补**。
///
/// ## 判据
///
///   看 mods 目录里的文件名。Fabric API 的发行文件名一律带 `fabric-api`，
///   QFAPI 带 `qfapi`（实测 `qfapi-7.7.0_qsl-6.3.0_fapi-0.92.2_mc-1.20.1.jar`）。
///   这是**文件名判据**，不联网 —— 它只用来决定"要不要提示用户"，
///   提示文案里会说清判据是什么，不冒充精确结论。
#[tauri::command]
pub fn check_api_library(
    slug: String,
    loader_kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let kind = loader_kind.unwrap_or_default();
    if kind != "fabric" && kind != "quilt" {
        return Ok(serde_json::json!({
            "needed": false,
            "present": true,
            "name": serde_json::Value::Null,
            "reason": "只有 Fabric / Quilt 需要额外的 API 前置包",
        }));
    }
    let (project, our_kind) = api_library_project(&kind)?;
    let name = if kind == "quilt" {
        "Quilted Fabric API"
    } else {
        "Fabric API"
    };

    /*
     * ★★ 2026-09-24（C-6 修复）：判据改成**唯一那一份**
     *   （`domain::mods::api_library_from_filename`）。
     *
     *   原来这里自带一张名单（`contains` 匹配），而 `modrinth.rs` 的
     *   `MrpackIndex::has_fabric_api` 另有一张（`starts_with` 匹配四个前缀）——
     *   两套判据在同一件事上给出不同答案，真机后果是：
     *   Quilt 实例的 mods/ 里放着 `fabric-api-….jar` 时，这一页报
     *   「缺 Quilted Fabric API」+ 一键补装，而整合包那边认为已经有 API 了
     *   ⇒ 用户被引导去装**第二个 API 实现**（重复加载）。
     *
     *   ★ 判据放宽成"**只要有一个 API 实现就算有**"是有意的：
     *     QFAPI 已内含 Fabric API，两者都能满足依赖它的 Mod；
     *     真正该提醒的是"一个都没有"，那时才谈得上"缺前置"。
     */
    let dir = state.paths().instance_mods_dir(&slug);
    let mut found: Option<(String, &'static str)> = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if !crate::domain::mods::is_mod_file(&n) {
                continue;
            }
            if let Some(k) = crate::domain::mods::api_library_from_filename(&n) {
                found = Some((n, k));
                break;
            }
        }
    }
    let found_name = found.as_ref().map(|(f, _)| f.clone());
    let found_kind = found.as_ref().map(|(_, k)| *k);

    Ok(serde_json::json!({
        "needed": true,
        "present": found_name.is_some(),
        "name": name,
        "project": project,
        "kind": our_kind,
        "filename": found_name,
        /* ★ 找到的那个**实际是哪个 API**（界面对 Quilt 实例要能说清"你装的是 Fabric API 本体"） */
        "foundKind": found_kind,
        "modsDir": dir.to_string_lossy(),
        "reason": match found_kind {
            Some(k) if k == our_kind => format!("{name} 已经在 mods 目录里"),
            Some("fabric-api") => format!(
                "mods 目录里的 Fabric API（{}）已经能满足依赖前置的 Mod —— \
                 不必再装一份 {name}（两份 API 实现会让 Mod 重复加载）",
                found_name.clone().unwrap_or_default()
            ),
            Some(_) => format!("{name} 已经在 mods 目录里"),
            None => format!("{name} 不在 mods 目录里 —— 依赖它的 Mod 启动时会报 requires fabric-api"),
        },
    }))
}

/// 启用 / 禁用一批 Mod。
///
/// ★ 真实机制（源码事实，见 LAUNCHER_SOURCE_STUDY 第 12 章）：
///   **状态由文件扩展名决定**，禁用 = 文件名加 `.disabled` 后缀，没有任何清单文件。
///   所以这里做的是真的重命名，而不是只改前端的列表状态。
#[tauri::command]
pub async fn set_mod_enabled(
    slug: String,
    paths: Vec<String>,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mods_dir = state.paths().instance_mods_dir(&slug);
    let mut done = 0usize;
    for p in paths {
        let src = std::path::PathBuf::from(&p);
        // 只允许操作本实例 mods 目录里的文件（不给越界重命名的机会）
        if !src.starts_with(&mods_dir) {
            continue;
        }
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let (from, to) = if enabled {
            if !name.ends_with(".disabled") {
                continue;
            }
            let stripped = name.trim_end_matches(".disabled").to_string();
            (src.clone(), src.with_file_name(stripped))
        } else {
            if name.ends_with(".disabled") {
                continue;
            }
            (src.clone(), src.with_file_name(format!("{name}.disabled")))
        };
        if !from.is_file() {
            continue;
        }
        let _ = tokio::fs::rename(&from, &to).await;
        done += 1;
    }
    Ok(done)
}

/// ★ 删除一个文件或目录：**默认进系统回收站**，`permanent = true` 才直接删。
///
/// ## 为什么默认进回收站（PCL 的 Shift 语义，LAUNCHER_SOURCE_STUDY 第 14 章第 37 条）
///
/// 启动器删的东西**都是用户自己攒的**：存档、Mod、配置、整合包。
/// 直接删是不可逆的，而误删的原因往往很蠢 —— 手滑多选了一个、
/// 没看清是哪个实例。回收站把这些都变成"可以捞回来"。
///
/// `permanent` 是留给明确的意图（用户按住 Shift 点删除），那时他已经
/// 表达过"我知道自己在干什么"。
///
/// ## 回收站失败不能变成"没删"
///
/// 有些环境没有回收站（精简版 Windows、某些容器、网络盘）。
/// 这时 `trash` 会报错 —— 我们**不静默退化成直接删**（那等于偷偷把
/// 用户的文件永久删了），而是把错误抛给上层，由它去问用户。
fn delete_path(path: &std::path::Path, permanent: bool) -> Result<(), String> {
    if permanent {
        return if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| format!("永久删除失败：{e}"))
        } else {
            std::fs::remove_file(path).map_err(|e| format!("永久删除失败：{e}"))
        };
    }
    trash::delete(path).map_err(|e| {
        format!(
            "移到回收站失败（{e}）—— 这个位置可能没有回收站；\
             确认要永久删除的话，按住 Shift 再点一次删除"
        )
    })
}

/// 删除一批 Mod。
///
/// ★ **默认进系统回收站**（PCL 的语义），`permanent = true` 才是真删。
///   以前这里是"直接删" —— 手滑多选一个就没救了。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn delete_mods(
    slug: String,
    paths: Vec<String>,
    permanent: Option<bool>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mods_dir = state.paths().instance_mods_dir(&slug);
    let perm = permanent.unwrap_or(false);
    let mut done = 0usize;
    let mut first_err: Option<String> = None;
    for p in paths {
        let f = std::path::PathBuf::from(&p);
        if !f.starts_with(&mods_dir) || !f.is_file() {
            continue;
        }
        match delete_path(&f, perm) {
            Ok(()) => done += 1,
            // 记下第一个错误（比如"没有回收站"），但继续处理其余 ——
            // 一个失败不该让用户重来一遍
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if done == 0 {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(done)
}

/* ====================== Java ====================== */

#[derive(serde::Serialize)]
pub struct JavaAssetInfo {
    pub major: u32,
    pub version: String,
    pub release_name: String,
    pub size: u64,
    pub download_url: String,
}

#[tauri::command]
pub async fn java_query(major: u32) -> Result<JavaAssetInfo, String> {
    let i = adoptium::query_java(major).await.map_err(err)?;
    Ok(JavaAssetInfo {
        major: i.major,
        version: i.version,
        release_name: i.release_name,
        size: i.size,
        download_url: i.download_url,
    })
}

/// 下载并安装 Java（会通过 `java-progress` 事件上报进度）
#[tauri::command]
pub async fn java_install(
    major: u32,
    task_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = state.paths().java.clone();
    let app2 = app.clone();
    let tid = task_id.clone();

    let bin = adoptium::install_java(major, &root, move |done, total| {
        let pct = if total > 0 { done * 100 / total } else { 0 };
        let _ = app2.emit(
            "java-progress",
            serde_json::json!({ "taskId": tid, "percent": pct, "downloaded": done, "total": total }),
        );
    })
    .await
    .map_err(err)?;

    Ok(bin.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct InstalledJavaRow {
    pub major: u32,
    pub path: String,
    pub bytes: u64,
    pub usable: bool,
}

/// 列出 IEML 下载过的 Java（设置页展示 + 删除）
#[tauri::command]
pub fn java_list_downloaded(state: State<'_, AppState>) -> Vec<InstalledJavaRow> {
    adoptium::list_downloaded_java(&state.paths().java)
        .into_iter()
        .map(|j| InstalledJavaRow {
            major: j.major,
            path: j.path.to_string_lossy().to_string(),
            bytes: j.bytes,
            usable: j.usable,
        })
        .collect()
}

/* ====================== 安装（真实下载） ====================== */

#[derive(serde::Serialize)]
pub struct PlanPreview {
    pub total_files: usize,
    pub libraries: usize,
    pub natives: usize,
    pub client_bytes: u64,
    pub total_bytes: u64,
    pub asset_index: Option<String>,
    pub classpath_entries: usize,
}

/// 生成安装计划预览（不下载，只算）
#[tauri::command]
pub async fn plan_install(
    mc_version: String,
    loader_kind: Option<String>,
    loader_version: Option<String>,
    source: String,
    state: State<'_, AppState>,
) -> Result<PlanPreview, String> {
    let src = parse_source(&source);
    let instance_dir = state.paths().instances.join(format!("preview-{mc_version}"));
    let input = build_plan_input(&mc_version, loader_kind.as_deref(), loader_version.as_deref(), src, &state, &instance_dir).await?;
    let plan = installer::plan_tasks(&input, src).map_err(err)?;

    Ok(PlanPreview {
        total_files: plan.tasks.len(),
        libraries: plan.libraries_count,
        natives: plan.natives.len(),
        client_bytes: plan
            .client_jar
            .as_ref()
            .map(|_| 0)
            .unwrap_or(0),
        total_bytes: plan.total_bytes,
        asset_index: input.version.asset_index.as_ref().map(|a| a.id.clone()),
        classpath_entries: plan.classpath.len(),
    })
}

/// 跑 Forge / NeoForge 官方安装器：
///   ① 下载 installer jar（BMCLAPI 镜像）
///   ② 探测本机 Java 并挑一个能用的
///   ③ 执行 `java -jar installer.jar --installClient <shared> --mirror <url>`
///
/// ★ 三个踩过的坑（都是实机验证出来的，别改回去）：
///   ① `--installClient` 后面**必须跟目标目录**（joptsimple 的 [File] 参数），
///      目标目录必须指向 `shared`（版本 JSON 和 libraries 都落在它下面的
///      `versions/`、`libraries/`，与启动时读的目录一致）。以前写的是
///      `--installClient --mirror <url> <root>`，目录被 `--mirror` 吃掉、
///      又指向了 `root`（启动器根本不去那里读）—— 装了等于白装。
///   ② 安装器**硬性要求目标目录里有 `launcher_profiles.json`**，
///      没有就直接报 "you need to run the launcher first"。所以要补一个最小的。
///   ③ 安装器产出的版本目录名是 `{mc}-forge-{ver}`（不是 `forge-{mc}`），
///      启动时用 `resolve_loader_version_id` 去**找**，而不是猜名字。
/// 跑一次加载器官方安装器（Forge / NeoForge）。
///
/// ★ 公开是为了能被集成测试直接调用（`tests/live_forge_processor.rs`）——
///   这条路径**必须**能被真机验证：Forge 56+ 有一个 77 MB 的客户端 jar
///   是安装器的 processor **本地生成**的（`url` 为空），它跑没跑成
///   决定了那个版本能不能启动，而这件事只能靠真的跑一遍才知道。
#[doc(hidden)]
pub async fn run_loader_installer(
    mc_version: &str,
    kind: &str,
    version: &str,
    source: Source,
    state: &AppState,
    cancel: &CancelToken,
    on_progress: &(dyn Fn(String) + Send + Sync),
) -> Result<(), String> {
    // ① 下载 installer jar
    let url = match kind {
        "forge" => mirror::forge_installer_url(mc_version, version, source),
        /*
         * ★★ NeoForge 的下载地址**必须按 MC 版本区分坐标**（PCL2 源码事实，
         *   `ModDownload.vb:831`）：
         *
         *     Dim PackageName As String = If(Inherit = "1.20.1", "forge", "neoforge")
         *
         *   1.20.1 及更早的 NeoForge 发布在 **`net/neoforged/forge`** 名下
         *   （版本号形如 `1.20.1-47.1.105`），而 1.20.4 之后才改成
         *   `net/neoforged/neoforge`。我们原来一律拼 `neoforge` ——
         *   于是 1.20.1 上点 NeoForge 会 404，界面显示"安装失败"。
         *
         *   实测（2026-09-13）BMCLAPI 的 1.20.1 列表里每条记录**自带**
         *   `installerPath`：`/maven/net/neoforged/forge/1.20.1-47.1.105/…-installer.jar`
         *   —— 那就直接用它的，比我们自己猜坐标可靠。
         */
        "neoforge" => neoforge_installer_url_for(mc_version, version, source).await,
        other => return Err(format!("不认识的加载器：{other}")),
    };
    let jar = state
        .paths()
        .cache
        .join(format!("{kind}-{mc_version}-{version}-installer.jar"));

    on_progress(format!("下载 {kind} 安装器"));
    let task = download::DownloadTask::new(
        jar.clone(),
        url,
        String::new(),
        0,
        format!("{kind} 安装器"),
    );
    download::download_one(&task, source, cancel)
        .await
        .map_err(err)?;

    // ② 找 Java
    on_progress("查找 Java 运行时".into());
    let runtimes = platform::scan_java(&state.paths());
    let input = domain::java::JavaConstraintInput::from(mc_version, true, 0, false);
    let picked = domain::java::pick_java("auto", &runtimes, input, None, None);
    let java = picked
        .runtime
        .ok_or_else(|| format!("没有可用的 Java：{}", picked.reason))?;

    // ③ 目标目录 = shared（versions/ 与 libraries/ 都落在这里，和启动读的一致）
    let target_dir = &state.paths().shared;
    std::fs::create_dir_all(target_dir).map_err(|e| e.to_string())?;
    // 安装器硬性要求 launcher_profiles.json，给一个最小的（不覆盖用户已有的）
    let profiles = target_dir.join("launcher_profiles.json");
    if !profiles.is_file() {
        let minimal = serde_json::json!({
            "profiles": { "(Default)": { "name": "(Default)", "lastVersionId": mc_version } }
        });
        let _ = std::fs::write(&profiles, minimal.to_string());
    }

    // ④ 跑 installer（走 BMCLAPI 镜像，避免官方 maven 直连）
    on_progress(format!("运行 {kind} 安装器（会联网下载库，可能需要几分钟）"));
    let mirror_maven = format!("{}/maven", mirror::BMCLAPI_BASE);
    /*
     * ★★ **不弹黑框**（用户报："安装 Forge 调出来个啥也没有的 cmd 是何意味"）。
     *
     *   这一处是**唯一**会真的弹窗的地方，而它恰好是用户天天要点的
     *   「安装 Forge」—— 因为它是唯一用 `tokio::process::Command` 创建
     *   Java 子进程的地方，而之前只有 `std::process::Command` 那几处加了
     *   `CREATE_NO_WINDOW`。
     *
     *   为什么必须用命令行跑：Forge 官方只提供 installer jar 这一个
     *   无人值守接口（`java -jar forge-installer.jar --installClient <dir>`），
     *   没有 API、没有库。所以"用命令行"是对的 ——
     *   错的是**让那个窗口露出来**。
     *
     *   用户的输出照样全拿到（stdout/stderr 都被 `.output()` 接走用于
     *   判断成功失败与展示进度），只是不再挂一个空壳在屏幕上。
     */
    let mut installer_cmd = tokio::process::Command::new(&java.path);
    installer_cmd
        .arg("-jar")
        .arg(&jar)
        .arg("--installClient")
        .arg(target_dir)
        .arg("--mirror")
        .arg(&mirror_maven);
    crate::platform::hide_console_async(&mut installer_cmd);
    let output = installer_cmd
        .output()
        .await
        .map_err(|e| format!("运行 {kind} 安装器失败：{e}"))?;

    if !output.status.success() {
        return Err(format!(
            "{kind} 安装器退出码 {}：{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    /*
     * ⑤ **装完必须校验"父版本"在不在** —— 否则装了也起不来。
     *
     *   实测（Forge 1.20.1）：安装器退出码 0、产出
     *   `versions/1.20.1-forge-47.2.0/`、29 个库全在磁盘上 —— 一切看起来都对。
     *   但那个版本 JSON 里写着 `inheritsFrom: "1.20.1"`，而**原版 1.20.1 没装**：
     *     · 启动时 `merge_with_parents` 找不到父版本 → 直接跳过合并；
     *     · 结果 classpath 里只有 Forge 的 29 个库，**核心 LWJGL 与客户端全缺**；
     *     · 游戏起来就是一个看不懂的 NoClassDefFoundError。
     *
     *   安装器不会替我们下原版（它只下自己的库 + 客户端 jar），
     *   所以这个前置条件必须由启动器保证。宁可在这里明确报错，
     *   也不要让用户拿到一个"装好了但一定起不来"的版本。
     */
    let produced = target_dir
        .join("versions")
        .join(format!("{mc_version}-{kind}-{version}"));
    let parent_json = target_dir
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.json"));
    if produced.is_dir() && !parent_json.is_file() {
        return Err(format!(
            "{kind} 装好了，但**原版 {mc_version} 还没装** —— {kind} 是叠在原版之上的，\
             没有原版它起不来。\n\n\
             请先在「下载」页安装一次原版 {mc_version}，再重装 {kind}（已下载的会跳过，很快）。\n\
             （原版文件位置：{}）",
            parent_json.display()
        ));
    }

    Ok(())
}

/// 执行真实安装。进度通过 `install-progress` 事件上报。
#[tauri::command]
pub async fn install_version(
    mc_version: String,
    loader_kind: Option<String>,
    loader_version: Option<String>,
    source: String,
    task_id: String,
    download_assets: bool,
    concurrency: Option<usize>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledSummary, String> {
    let src = parse_source(&source);
    let instance_dir = state
        .paths()
        .instances
        .join(format!("install-{mc_version}"));
    let input = build_plan_input(
        &mc_version,
        loader_kind.as_deref(),
        loader_version.as_deref(),
        src,
        &state,
        &instance_dir,
    )
    .await?;

    let cancel = register_task(&task_id);
    // ★ 暂停令牌也登记进表 —— 与 cancel 同一张表（按 taskId 找）
    let pause = register_pause(&task_id);
    let app2 = app.clone();
    let tid = task_id.clone();

    let result = installer::install(
        &input,
        installer::InstallOptions {
            concurrency: concurrency.unwrap_or(64).clamp(4, 128),
            download_assets,
            asset_limit: None,
            cancel: cancel.clone(),
            pause: Some(pause.clone()),
            on_progress: Arc::new(move |stage: String, p: DownloadProgress| {
                let _ = app2.emit(
                    "install-progress",
                    serde_json::json!({
                        "taskId": tid,
                        "stage": stage,
                        "percent": if p.total_files > 0 { p.finished_files * 100 / p.total_files } else { 0 },
                        "finishedFiles": p.finished_files,
                        "totalFiles": p.total_files,
                        "bytesPerSecond": p.bytes_per_second,
                        "currentFile": p.current_file,
                        "skippedFiles": p.skipped_files,
                        "failedFiles": p.failed_files,
                        // 多源回退时让用户看见"换了源"；重试轮次让"卡住"可解释
                        "source": p.source,
                        "retryRound": p.retry_round,
                        "totalBytes": p.total_bytes,
                    }),
                );
            }),
        },
    )
    .await;

    let installed = result.map_err(err)?;

    /*
     * ★★ **被暂停就不许往下走**（P0-3）。
     *
     *   以前这里无条件继续：跑 Forge/NeoForge 安装器（几分钟）、
     *   然后返回 `InstalledSummary`。用户按的是"暂停"，收到的却是
     *   "安装完成 + 又下了几 MB"，而盘上一半文件都没有。
     *
     *   现在把暂停**如实带回界面**（`paused: true` + 还剩几个文件），
     *   并且**立刻释放任务槽**：用户点「继续」时会用同一套参数重新发起，
     *   已下好的文件会走"校验通过 → 跳过"，`.part` 分片也会接着用。
     */
    if installed.paused {
        say!(
            "[IEML/install] {mc_version} 安装被暂停：还剩 {} 个文件没下\
             （点「继续」会从断点接着下）",
            installed.remaining_files
        );
        drop_task(&task_id);
        return Ok(InstalledSummary {
            id: installed.id.clone(),
            libraries: installed.libraries_count,
            assets: installed.assets_count,
            total_bytes: installed.total_bytes,
            version_json: installed.json_path.to_string_lossy().to_string(),
            natives_dir: installed.natives_dir.to_string_lossy().to_string(),
            paused: true,
            remaining_files: installed.remaining_files,
            paused_stage: installed.paused_stage.clone(),
        });
    }

    /*
     * Forge / NeoForge：装完原版后跑官方安装器（一步到位，不再要求用户手动二次操作）
     *
     * ★★ 这一步**也要看暂停**（P0-3）。
     *
     *   Forge / NeoForge 安装器是一个外部 `java -jar` 子进程，它**没有**
     *   "暂停"这个概念 —— 中途掐掉只会留下一个改了一半的版本目录。
     *   所以诚实的做法是：在启动它**之前**看一次令牌，已暂停就**不启动**，
     *   并如实告诉界面"这一步还没做"。
     *   （此时 `remaining_files` 是 0，所以必须带上 `paused_stage`，
     *    否则界面会把"文件下完了"当成"装完了"。）
     */
    if let Some(kind) = loader_kind.as_deref() {
        if kind == "forge" || kind == "neoforge" {
            if pause.is_paused() {
                say!("[IEML/install] {mc_version}：用户已暂停，跳过 {kind} 安装器那一步");
                drop_task(&task_id);
                return Ok(InstalledSummary {
                    id: installed.id.clone(),
                    libraries: installed.libraries_count,
                    assets: installed.assets_count,
                    total_bytes: installed.total_bytes,
                    version_json: installed.json_path.to_string_lossy().to_string(),
                    natives_dir: installed.natives_dir.to_string_lossy().to_string(),
                    paused: true,
                    remaining_files: 0,
                    paused_stage: Some(format!("运行 {kind} 安装器")),
                });
            }
            let ver = loader_version.as_deref().unwrap_or("").to_string();
            if ver.is_empty() {
                drop_task(&task_id);
                return Err(format!("{kind} 需要指定版本号"));
            }
            let app3 = app.clone();
            let tid2 = task_id.clone();
            let progress = move |msg: String| {
                let _ = app3.emit(
                    "install-progress",
                    serde_json::json!({
                        "taskId": tid2,
                        "stage": msg,
                        "percent": 100,
                        "finishedFiles": 0,
                        "totalFiles": 0,
                        "bytesPerSecond": 0,
                        "currentFile": "",
                    }),
                );
            };
            if let Err(e) =
                run_loader_installer(&mc_version, kind, &ver, src, &state, &cancel, &progress).await
            {
                drop_task(&task_id);
                return Err(e);
            }
        }
    }

    drop_task(&task_id);

    Ok(InstalledSummary {
        id: installed.id.clone(),
        libraries: installed.libraries_count,
        assets: installed.assets_count,
        total_bytes: installed.total_bytes,
        version_json: installed.json_path.to_string_lossy().to_string(),
        natives_dir: installed.natives_dir.to_string_lossy().to_string(),
        paused: false,
        remaining_files: 0,
        paused_stage: None,
    })
}

#[derive(serde::Serialize)]
pub struct InstalledSummary {
    pub id: String,
    pub libraries: usize,
    pub assets: usize,
    pub total_bytes: u64,
    pub version_json: String,
    pub natives_dir: String,
    /// ★★ 这次是**被暂停**停下的（不是"装好了"）—— 见 `InstalledVersion::paused`。
    ///
    /// 前端据此把任务标成「已暂停」并保留「继续」入口。
    /// **不许**在它为 `true` 时显示"安装完成"。
    pub paused: bool,
    /// 暂停时还没下的文件数（界面显示"还剩 N 个"）
    pub remaining_files: usize,
    /// 暂停发生在哪一步（`paused = true` 时才有值）
    pub paused_stage: Option<String>,
}

/// 组装安装输入：原版 JSON + 加载器 JSON 的合并
async fn build_plan_input(
    mc_version: &str,
    loader_kind: Option<&str>,
    loader_version: Option<&str>,
    source: Source,
    state: &AppState,
    instance_dir: &std::path::Path,
) -> Result<PlanInput, String> {
    // 原版 JSON
    let manifest = metadata::fetch_manifest(source).await.map_err(err)?;
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc_version)
        .ok_or_else(|| format!("清单里没有版本 {mc_version}"))?;
    let vanilla: VersionJson = net::get_json(&entry.url).await.map_err(err)?;

    // 加载器：Fabric / Quilt 用 profile JSON 直接合并；Forge / NeoForge 只能跑安装器
    let merged = match loader_kind {
        None | Some("") => vanilla,
        Some("fabric") => {
            let lv = match loader_version {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => metadata::fabric_loaders(mc_version, source)
                    .await
                    .map_err(err)?
                    .first()
                    .map(|e| e.loader.version.clone())
                    .ok_or_else(|| format!("Fabric 没有 {mc_version} 的 loader"))?,
            };
            let profile = metadata::fabric_profile(mc_version, &lv).await.map_err(err)?;
            installer::merge_versions(&profile, &vanilla)
        }
        Some("quilt") => {
            let lv = match loader_version {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => metadata::quilt_loaders(mc_version, source)
                    .await
                    .map_err(err)?
                    .first()
                    .map(|e| e.loader.version.clone())
                    .ok_or_else(|| format!("Quilt 没有 {mc_version} 的 loader"))?,
            };
            let profile = metadata::quilt_profile(mc_version, &lv).await.map_err(err)?;
            installer::merge_versions(&profile, &vanilla)
        }
        Some("forge") | Some("neoforge") => {
            // Forge 系不能靠 profile JSON，必须跑官方 installer。
            // 这里先返回原版 JSON（装原版），installer 在 install_version 里
            // 装完原版后执行（run_loader_installer）。
            vanilla
        }
        Some(other) => return Err(format!("不认识的加载器：{other}")),
    };

    Ok(PlanInput {
        version: merged,
        shared_root: state.paths().shared.clone(),
        instance_dir: instance_dir.to_path_buf(),
        source,
        download_assets: true,
    })
}

#[tauri::command]
pub async fn cancel_task(task_id: String) -> Result<(), String> {
    let map = tokens().lock().unwrap();
    if let Some(t) = map.get(&task_id) {
        t.cancel();
        Ok(())
    } else {
        Err("没有这个任务（可能已经结束）".into())
    }
}

/* ====================== 启动 ====================== */

#[derive(serde::Deserialize)]
pub struct LaunchRequest {
    pub mc_version: String,
    pub loader_kind: Option<String>,
    /// 加载器版本（如 Forge "47.2.0"）—— 用来定位安装器产出的版本目录
    #[serde(default)]
    pub loader_version: Option<String>,
    /// 离线用户名；有正版账号时由前端传 account_uuid
    pub username: String,
    pub account_uuid: Option<String>,
    pub memory_mb: u64,
    pub width: u32,
    pub height: u32,
    pub instance_slug: String,
    /*
     * ★★ 2026-09-15（多开实例）：这里以前只有 `instance_slug`（磁盘目录名）。
     *   "正在运行"这张表现在按 **instance_id** 索引，因为：
     *     · 退出事件 `game-exit` 报的是 id；
     *     · slug 是**可以被用户改名**的显示/目录名（重命名只改显示名，
     *       但目录名变了这条记录就对不上了）；
     *     · 前端的实例表也是按 id 找的。
     *   一句 `#[serde(default)]` 是为了兼容老前端：缺这个字段时按空串处理，
     *   那样多开判据会退化成"任何实例都不同名"，不会误拦。
     */
    #[serde(default)]
    pub instance_id: String,
    pub extra_jvm_args: Vec<String>,
    pub extra_game_args: Vec<String>,
    /// 自定义窗口标题（`None` = 跟随全局/游戏默认）
    #[serde(default)]
    pub window_title: Option<String>,
    /// 启动后自动进入的服务器地址（`None` = 不自动进服）
    #[serde(default)]
    pub join_server: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LaunchPreview {
    pub command: String,
    pub summary: String,
    pub java: String,
    pub classpath_entries: usize,
    pub natives_dir: String,
    /// ★ 同 `LaunchStarted.notice` —— 预览时也要能看到账号告警，
    ///   否则"点前就知道会发生什么"这句承诺对账号那一层不成立。
    #[serde(default)]
    pub notice: Option<String>,
}

/// ★★ 启动失败的**结构化**错误（P0-7）。
///
/// ## 为什么错误不能只是一句散文
///
///   启动最常见的失败是"本机没有这个版本需要的 Java"。以前它只是一句话
///   （`这个版本需要 Java [25, )。…`），于是界面要**从这句话里抠数字**：
///   ```ts
///   const need = /Java (\d+)/.exec(msg);   // 启动页里真的这么写过
///   ```
///   抠散文的下场是可预见的：改了文案就失效（正则匹配不到 → 界面不再提供
///   「自动下载 Java」的按钮，用户只看到一句报错）；而文案里只要出现第二个
///   数字（比如示例里的 `Java 24`），抠出来的就是**另一个数**。
///
///   现在后端把机器可读的部分单独给出（`code` + `required_major` +
///   `required_range`），界面按字段走，不解析人类语言。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LaunchError {
    /// 机器可读的错误码：`java-missing` / `prepare-failed`
    pub code: String,
    /// 面向用户的完整说明（界面可以直接显示）
    pub message: String,
    /// `code == "java-missing"` 时有值：这个版本需要的 Java **主版本**
    pub required_major: Option<u32>,
    /// 需要区间的可读形式，如 `[25, )`
    pub required_range: Option<String>,
}

impl LaunchError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            required_major: None,
            required_range: None,
        }
    }
}

/// 启动路径上绝大多数错误仍然是"一句话"（文件缺失、版本 JSON 坏了、网络……）。
/// `?` 会自动走这条转换（`From<String>`），只有需要结构化字段的地方才手工构造。
impl From<String> for LaunchError {
    fn from(message: String) -> Self {
        Self::new("prepare-failed", message)
    }
}

impl From<&str> for LaunchError {
    fn from(message: &str) -> Self {
        Self::new("prepare-failed", message)
    }
}

/// 只拼装并预览启动命令（不启动）—— 让用户"点前就知道会发生什么"
#[tauri::command]
pub async fn preview_launch(
    req: LaunchRequest,
    state: State<'_, AppState>,
) -> Result<LaunchPreview, LaunchError> {
    /*
     * ★★ 预览**不做补齐**（2026-09-22，用户："图八预览命令这个打开的太慢了"）。
     *
     *   真机实测：预览带上补齐时 **14.5 秒**（它在下缺失的库），
     *   而预览只需要拼一条命令行 —— 不带补齐是**毫秒级**。
     *   缺什么会在 `notice` 里如实说（见 prepare_spec），不影响命令本身。
     */
    let spec = prepare_spec(&req, &state, false).await?;
    let cmd = launch_args::build_command(&spec);
    Ok(LaunchPreview {
        command: cmd.debug_line,
        summary: cmd.summary,
        java: cmd.program,
        classpath_entries: spec.classpath.len(),
        natives_dir: spec.natives_dir.to_string_lossy().to_string(),
        notice: spec.notice.clone(),
    })
}

/// 真正启动游戏
#[tauri::command]
pub async fn launch_minecraft(
    req: LaunchRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LaunchStarted, LaunchError> {
    {
        /*
         * ★★ 与 `running_games` 同样的修法（2026-09-17）：**不要持注册表锁去抢子进程锁**。
         *
         *   这里是**启动路径** —— 一旦这句被堵住，用户就**彻底开不了游戏**
         *   （启动命令自己挂在锁上），比"UI 显示错"更严重。
         *   完整的因果见 `running_games` 上方那段注释。
         */
        // ① 持锁只取快照
        let snapshot: Vec<(String, std::sync::Arc<std::sync::Mutex<std::process::Child>>)> = {
            let guard = state.running.lock().map_err(|_| "状态锁失败")?;
            guard
                .iter()
                .map(|(id, r)| (id.clone(), std::sync::Arc::clone(&r.child)))
                .collect()
        }; // ← 放锁
        // ② 无锁判活（慢也只慢自己）
        let dead: Vec<String> = snapshot
            .into_iter()
            .filter(|(_, child)| !crate::launch::is_child_alive(child))
            .map(|(id, _)| id)
            .collect();
        // ③ 再拿锁：清死条目 + 判"这一个实例"在不在跑
        let mut guard = state.running.lock().map_err(|_| "状态锁失败")?;
        for id in &dead {
            guard.remove(id);
        }
        if let Some(running) = guard.get(&req.instance_id) {
            let _ = running; // 只是为了让"取到了就说明在跑"这件事写在明面上
            return Err(LaunchError::new(
                "already-running",
                "这个版本已经在运行了。同一个版本同时开两份会抢同一个存档目录，\
                 想多开请启动**另一个**版本。",
            ));
        }
    }

    // ★ 真的要启动：允许启动前自愈（缺什么补什么，补不齐才拦下）
    let spec = prepare_spec(&req, &state, true).await?;
    let cmd = launch_args::build_command(&spec);

    let game_dir = spec.game_dir.clone();
    std::fs::create_dir_all(&game_dir).map_err(|e| format!("创建游戏目录失败：{e}"))?;

    /*
     * ★★ 首次启动把游戏语言设成中文（用户 2026-09-15：
     *   "我希望在玩家首次启动游戏时，游戏语言默认是中文"）。
     *
     *   原版**永远**默认英文（它不跟随系统语言），新玩家进去看到的是
     *   Singleplayer / Multiplayer —— PCL 也是启动器替玩家写好这一项。
     *
     *   ★ 判据全在 `game::locale` 里（那边有 5 条测试），这里只负责调用：
     *     · **只在玩家还没选过语言时写**（`options.txt` 里已有 `lang:` → 一个字节不动）；
     *     · 语言代码跟着版本走（1.11 起是 `zh_cn`，之前是 `zh_CN`）。
     *   写失败**不拦启动** —— 这是锦上添花，不该因为它启动不了游戏；
     *   但要说出来（日志与 stderr），否则"语言没变成中文"就成了查不到原因的现象。
     */
    match crate::game::locale::ensure_chinese_language(&game_dir, &req.mc_version) {
        Ok(crate::game::locale::LocaleAction::Created) => {
            say!("[IEML/launch] 首次启动：已写入 options.txt（语言=中文）");
        }
        Ok(crate::game::locale::LocaleAction::Appended) => {
            say!("[IEML/launch] options.txt 里没有语言设置，已补上中文");
        }
        // 玩家已经选过语言 —— 这是最常见的情况，不需要任何输出
        Ok(crate::game::locale::LocaleAction::LeftAlone) => {}
        Err(e) => {
            say!("[IEML/launch] 写 options.txt（中文语言）失败，不影响启动：{e}");
        }
    }

    let log_path = state
        .paths()
        .logs
        .join(format!("{}-{}.log", req.instance_slug, now_secs()));
    std::fs::create_dir_all(&state.paths().logs).map_err(|e| format!("创建日志目录失败：{e}"))?;
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("创建日志失败：{e}"))?;
    let log_err = log_file.try_clone().map_err(|e| e.to_string())?;

    let mut command = std::process::Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .current_dir(&game_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log_file))
        .stderr(std::process::Stdio::from(log_err));
    // ★ 不弹控制台窗口（唯一入口，见 platform::hide_console）
    crate::platform::hide_console(&mut command);

    let child = command.spawn().map_err(|e| {
        format!("启动失败：{e}\n\n常见原因：Java 路径不对、内存设置过大、或游戏文件不完整。\n可以点「校验文件」修复。")
    })?;
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));

    /*
     * ★ 别急着报"已启动"。
     *   踩过的坑：native 库加载失败时游戏 1 秒内就退出、日志 0 字节，
     *   而前端弹的是「游戏已启动 · PID xxxx」—— 用户以为启动成功了，
     *   实际什么都没发生，只能过来说"游戏启动不起来"。
     *   这里停一下、确认进程还活着，再决定是报成功还是报失败。
     */
    crate::launch::settle_before_reporting();
    if let Some(reason) = crate::launch::detect_instant_failure(&child, &log_path) {
        // 进程已经死了 —— 不要把它登记成"正在运行"
        // （结构化错误码 `game-exited-immediately`：界面据此知道"不是配置问题"）
        return Err(LaunchError::new("game-exited-immediately", reason));
    }

    /*
     * ★★ 离线身份要**记在这次会话上**（P0-6）。
     *
     *   判据只有一处（`Account::is_offline`）。它决定崩溃判据会不会把
     *   日志里那句必然出现的 `401 Unauthorized` 当成故障 —— 见
     *   `domain::crash::judge_crash`。
     */
    let offline = spec.account.is_offline();
    if offline {
        say!("[IEML/launch] 这次是离线身份启动（日志里的 401 是必然的，不会当成崩溃原因）");
    }

    let running = crate::launch::RunningGame {
        instance_id: req.instance_slug.clone(),
        pid,
        started_at: now_secs(),
        log_path: log_path.clone(),
        offline,
        child,
    };
    /*
     * ★ 登记之后必须**立刻挂上退出监测**（用户报"游戏关闭后启动器依然显示在运行"）。
     *   以前这条路径压根没有监测：游戏自己退出后
     *   ① 界面一直显示运行中；② 再点启动被"已经有一个游戏在运行了"挡住。
     */
    crate::launch::watch_game_exit(
        Arc::clone(&running.child),
        running.log_path.clone(),
        running.instance_id.clone(),
        running.started_at,
        offline,
        Some(app.clone()),
    );
    /*
     * ★★ 登记进**表**（多开实例）：键是实例 id，所以"谁在跑"这件事
     *   从这一刻起是**按实例**记的，而不是"整个启动器只有一个"。
     */
    state
        .running
        .lock()
        .map_err(|_| "状态锁失败")?
        .insert(req.instance_id.clone(), running);

    Ok(LaunchStarted {
        pid,
        summary: cmd.summary,
        log_path: log_path.to_string_lossy().to_string(),
        // ★ 账号告警必须带出去（写在日志里用户看不到）
        notice: spec.notice.clone(),
    })
}

#[derive(serde::Serialize)]
pub struct LaunchStarted {
    pub pid: u32,
    pub summary: String,
    pub log_path: String,
    /// ★★ 需要用户知道的告警（`None` = 一切正常）。
    ///
    /// 目前唯一的来源是**账号**：正版 access token 过期、`refresh_token`
    /// 续期又失败时，仍然会用离线身份启动（单机不受影响），但用户必须知道 ——
    /// 否则他拿着离线身份去连正版服务器只会被拒，而界面一个字都不说。
    #[serde(default)]
    pub notice: Option<String>,
}

/// 从请求组装 LaunchSpec（读取已安装的版本 JSON、扫 classpath、解压 natives）
/// 在 `shared/versions/` 里定位加载器版本目录（纯函数，可单测）。
///
/// 安装器产出的目录名不统一，所以不能拼名字，只能按规则找：
///   ① 没加载器 → 原版 id = mc_version
///   ② Forge/NeoForge 且给了加载器版本 → 优先精确命中 `{mc}-forge-{ver}` /
///      `{mc}-neoforge-{ver}`，再兜底扫描
///   ③ 其余（Fabric/Quilt 或没给版本）→ 扫描 `versions/` 下所有「引用同一 MC 版本、
///      且名字带该加载器特征、且带版本 JSON」的目录，取其一
///
/// 特征判定顺序很关键：`neoforge` 里包含子串 `forge`，所以查 forge 时必须排除 neoforge。
fn resolve_loader_version_id(
    shared: &std::path::Path,
    mc_version: &str,
    loader_kind: Option<&str>,
    loader_version: Option<&str>,
) -> Option<String> {
    let kind = match loader_kind {
        Some(k) if !k.is_empty() => k,
        _ => return Some(mc_version.to_string()),
    };
    let versions = shared.join("versions");

    // ★ ⓪ 先看请求里给的加载器版本在不在盘上 —— **用加载器自己的版本号拼目录名**。
    //
    //   这里修的是一个真实的数据事故：实例记录里的 `loader.version` 曾经被写成
    //   "47.2.0"，而磁盘上的目录是 `1.20.1-forge-47.4.23`（安装时用了当时最新的
    //   build）。老逻辑只认 `{mc}-forge-{ver}` 这一种写法，于是**找不到就退化成
    //   原版**，再被后面的"加载器痕迹"守卫拦下，报"没有 Forge 痕迹"。
    //   用户看到的就是"装了 Forge 却说起不来"。
    //
    //   兜底逻辑（③ 扫描）本来就能找到它，所以这里只是把"名字里带这个加载器版本"
    //   的目录也纳入精确命中，让命中率更高、更少走扫描。
    if let Some(v) = loader_version.filter(|v| !v.is_empty()) {
        let exact: Vec<String> = match kind {
            "forge" => vec![format!("{mc_version}-forge-{v}")],
            "neoforge" => vec![
                format!("{mc_version}-neoforge-{v}"),
                format!("neoforge-{mc_version}-{v}"),
                format!("neoforge-{v}"),
            ],
            "fabric" => vec![format!("fabric-loader-{v}-{mc_version}")],
            "quilt" => vec![format!("quilt-loader-{v}-{mc_version}")],
            _ => vec![],
        };
        for id in exact {
            if versions.join(&id).join(format!("{id}.json")).is_file() {
                return Some(id);
            }
        }
    }

    // ① 加载器版本没给（或名字不标准）→ 按**磁盘上的加载器痕迹**挑一个
    //
    //   判据来自 domain::loader_trace（与界面上"已装 Forge 47.4.23"用的是同一份
    //   事实），所以界面上显示什么、启动时就装什么，不会再出现两边不一致。
    let want = LoaderFlavor::parse(kind);
    if let Some(want) = want {
        let mut candidates: Vec<(String, String)> = Vec::new(); // (目录名, 版本号)
        for t in scan_version_dir(shared) {
            let Some(found) = t.loaders.iter().find(|l| l.loader_type == want.key()) else {
                continue;
            };
            let belongs = t.inherits == mc_version
                || t.dir.contains(mc_version)
                || t.id.contains(mc_version);
            if !belongs {
                continue;
            }
            candidates.push((t.dir, found.version.clone()));
        }
        // 给定了加载器版本就优先命中它；否则取版本号最高的那个
        if let Some(v) = loader_version.filter(|v| !v.is_empty()) {
            if let Some((dir, _)) = candidates.iter().find(|(_, lv)| lv == v) {
                return Some(dir.clone());
            }
        }
        candidates.sort_by(|a, b| {
            crate::domain::loader_trace::compare_version_desc(&a.1, &b.1)
        });
        if let Some((dir, _)) = candidates.into_iter().next() {
            return Some(dir);
        }
    }

    // ② 目录名兜底扫描（加载器痕迹读不出来时的最后手段）
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return None;
    };
    let mut matches: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if !e.path().is_dir() || n == mc_version || !n.contains(mc_version) {
                return None;
            }
            if !versions.join(&n).join(format!("{n}.json")).is_file() {
                return None;
            }
            let is_match = match kind {
                "neoforge" => n.contains("neoforge"),
                "forge" => n.contains("forge") && !n.contains("neoforge"),
                "fabric" => n.contains("fabric"),
                "quilt" => n.contains("quilt"),
                _ => false,
            };
            if is_match {
                Some(n)
            } else {
                None
            }
        })
        .collect();

    // 优先挑名字里带加载器版本的；没有就取第一个
    if let Some(v) = loader_version {
        if let Some(found) = matches.iter().find(|n| n.contains(v)) {
            return Some(found.clone());
        }
    }
    matches.sort();
    matches.into_iter().next()
}

/* ====================== classpath 归集（纯函数，可单测） ====================== */

/* ====================== classpath 归集 ====================== */

// 实现在 `net::installer::scan_classpath` / `ClasspathScan` —— 放在那里是为了能共用
// （库的筛选规则只允许有一份实现，见 ADR-011），并且集成测试也够得着。
use crate::net::installer::{scan_classpath, ClasspathScan};

/* ====================== 版本 JSON 定位（纯函数，可单测） ====================== */

/// 找到某个版本的 JSON 文件路径 —— **按内容找，不按文件名猜**。
///
/// ★ 为什么按内容找（踩过的坑）：
///   安装侧与启动侧对"这个文件叫什么"的约定曾经不一致 ——
///   Fabric profile 的 `id` 是 `fabric-loader-0.19.5-26.2`，安装写的是
///   `<id>.json`；而启动拼的是 `<mc_version>.json`。找不到就**静默落回原版**，
///   表现是游戏起不来、日志只有一句 `ClassNotFoundException: …KnotClient`。
///
///   只要按"目录里任何一个 .json 的 `id` 字段"来找，这类命名约定分歧就消失了。
///   这个函数把顺序写死，覆盖三种现实命名：
///     ① `<id>.json`                     —— 安装器现在的写法
///     ② `<mc_version>.json`             —— 启动侧历史写法 / 手装的版本
///     ③ 目录里唯一的那个 .json           —— 兜底（Fabric 的 id 里不含 mc 的怪情况）
///
///   `loader_kind` 给了的话，**优先挑真的带这个加载器痕迹的 JSON**
///   （不然可能挑到同目录下的原版 JSON）。
pub fn find_version_json(
    shared: &std::path::Path,
    version_id: &str,
    mc_version: &str,
    loader_kind: Option<&str>,
) -> Option<std::path::PathBuf> {
    let dir = shared.join("versions").join(version_id);
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    for name in [format!("{version_id}.json"), format!("{mc_version}.json")] {
        let p = dir.join(name);
        if p.is_file() {
            candidates.push(p);
        }
    }
    // 兜底：目录里所有 .json
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "json").unwrap_or(false) && !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }
    if candidates.is_empty() {
        // 最后兜底：versions/{mc_version}/{mc_version}.json（没有加载器目录时）
        let p = shared
            .join("versions")
            .join(mc_version)
            .join(format!("{mc_version}.json"));
        return p.is_file().then_some(p);
    }

    // 有加载器要求时，优先挑带该加载器痕迹的
    //
    // ★ 判据必须按**库坐标**（`domain::loader_trace`），不能按名字包含：
    //   老实现是 `text.contains("forge")`，而 `net.neoforged:neoforge` 里
    //   也含子串 `forge` —— 于是查 Forge 时会挑中 NeoForge 的 JSON，
    //   主类、库全对不上，游戏起不来还查不出原因。
    if let Some(kind) = loader_kind.filter(|k| !k.is_empty()) {
        if let Some(want) = LoaderFlavor::parse(kind) {
            if let Some(hit) = candidates.iter().find(|p| {
                std::fs::read_to_string(p)
                    .map(|t| detect_flavors(&t).contains(&want))
                    .unwrap_or(false)
            }) {
                return Some(hit.clone());
            }
        }
    }
    candidates.into_iter().next()
}

/// 读取 `versions/{id}/` 下这个版本自己那份 JSON（不递归）。
///
/// 与 `find_version_json` 的区别：这个**只按 id 找这个版本自身**的 JSON，
/// 用于沿 `inheritsFrom` 往上走时逐层取父版本。
pub fn load_version_json(shared: &std::path::Path, id: &str) -> Option<VersionJson> {
    let dir = shared.join("versions").join(id);
    let mut names = vec![format!("{id}.json")];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".json") && !names.contains(&n) {
                names.push(n);
            }
        }
    }
    for n in names {
        let p = dir.join(&n);
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        if let Ok(v) = serde_json::from_str::<VersionJson>(&text) {
            // 只认"确实是这个 id"的那份（同目录可能放着两份不同内容的 JSON）
            if v.id == id {
                return Some(v);
            }
        }
    }
    None
}

/// 沿 `inheritsFrom` 递归把父版本合并进来（最多 4 层，防成环）。
///
/// ★ 为什么必须在**启动时**做（而不是只在安装时做一次并写盘）：
///   新版 Mojang 版本 JSON 是**增量的** —— 实测 26.2 自己那份里**没有**
///   `org.lwjgl:lwjgl:3.4.1`（核心 LWJGL，含 `org.lwjgl.system.CallbackI`），
///   它只列了 natives 变体与 unsafe 变体；Fabric 的 profile 声明
///   `inheritsFrom: 26.2`，同样不含核心 lwjgl。不合并就必然
///   `NoClassDefFoundError: org/lwjgl/system/CallbackI`（实测）。
///
///   只在安装时合并写盘的坏处：① 那份文件可能是**旧规则**写的（缺库）；
///   ② 父版本后来被重装/更新，它不会跟着变。
/// 放在启动时合并，两个问题一起消失，还能**自动修好已装坏的版本**。
pub fn merge_with_parents(
    shared: &std::path::Path,
    mut version: VersionJson,
    mc_version: &str,
    loader_kind: Option<&str>,
) -> VersionJson {
    let mut parent_id = version.inherits_from.clone();
    let mut hops = 0;
    while let Some(pid) = parent_id {
        if hops >= 4 {
            break;
        }
        let Some(parent) = load_version_json(shared, &pid) else {
            say!("[IEML/launch] 找不到父版本 {pid} 的 JSON，停止向上合并");
            break;
        };
        let before = version.libraries.len();
        version = installer::merge_versions(&version, &parent);
        say!(
            "[IEML/launch] 合并父版本 {pid}：库 {before} → {}",
            version.libraries.len()
        );
        parent_id = parent.inherits_from.clone();
        hops += 1;
        let _ = (mc_version, loader_kind);
    }
    version
}

async fn prepare_spec(
    req: &LaunchRequest,
    state: &AppState,
    /*
     * ★★ 要不要在拼装时**顺便补齐缺失文件**（2026-09-22 加）。
     *
     *   补齐全流程是**安装级**的活（会真的发请求下载），
     *   所以只有"真的要启动"时才做：
     *     · `launch_minecraft` → true（原行为：缺什么补什么，补不齐才拦下）；
     *     · `preview_launch`   → false（只是拼命令行，**一个字节都不该下**）。
     *
     *   实测：预览带上补齐时，真机上要 **14.5 秒**（它在下东西）；
     *   不带时是毫秒级 —— 这才是"预览"该有的成本。
     */
    repair: bool,
) -> Result<LaunchSpec, LaunchError> {    let shared = &state.paths().shared;
    let instance_dir = state.paths().instance_dir(&req.instance_slug);
    // 游戏工作目录：saves / mods / config 都在这里（与 scan_mods / install_mod 同一来源）
    let game_dir = state.paths().instance_game_dir(&req.instance_slug);
    let natives_dir = instance_dir.join("natives");

    // 读版本 JSON（加载器版本优先）
    // ★ 不能靠 `{kind}-{mc}` 猜名字 —— 安装器产出的目录名各不相同：
    //   Forge  → `{mc}-forge-{ver}`（实测 1.20.1 → "1.20.1-forge-47.2.0"）
    //   Fabric → `fabric-loader-{ver}-{mc}`（profile 自带 id）
    //   所以按「加载器种类 + MC 版本 + 加载器版本」去 `versions/` 里**找**。
    let version_id = resolve_loader_version_id(
        shared,
        &req.mc_version,
        req.loader_kind.as_deref(),
        req.loader_version.as_deref(),
    )
    .unwrap_or_else(|| req.mc_version.clone());
    let json_path = find_version_json(shared, &version_id, &req.mc_version, req.loader_kind.as_deref())
        .ok_or_else(|| {
            format!(
                "找不到版本文件：versions/{version_id}/ 或 versions/{0}/{0}.json。\n\
                 请先在下载中心安装这个版本。",
                req.mc_version
            )
        })?;

    let version: VersionJson = serde_json::from_str(
        &std::fs::read_to_string(&json_path).map_err(|e| format!("读取版本文件失败：{e}"))?,
    )
    .map_err(|e| format!("版本文件损坏：{e}"))?;

    /*
     * ★★ 纯原版实例**不许偷偷启动成带加载器的版本** ★★
     *
     *   这是"启动侧没做实时判定"留下的一个洞（用户的诉求正是"每个版本都要监测"）：
     *   实例记录说这是纯原版（`loader_kind == None`），于是
     *   `resolve_loader_version_id` 返回的 id 就是 `mc_version` 本身；
     *   而 `find_version_json` 在 `versions/{mc_version}/` 不存在时会**兜底扫描**
     *   整个 `versions/` 目录，而扫描结果里可能只有 `1.20.1-forge-47.4.23`
     *   这一份 JSON —— 于是**纯原版实例启动起来其实是 Forge**。
     *   用户看到的现象是"我明明建的是原版，怎么进游戏一堆 Mod 生效了"，
     *   或者反过来"原版起不来，报缺这个缺那个"。
     *
     *   判据同样来自 `domain::loader_trace`（按库坐标，不看名字猜）。
     *   注意这里**只拦静默的错配**：如果读到的 JSON 里确实有加载器痕迹，
     *   就明确告诉用户盘上有什么、该怎么办，而不是硬着头皮启动。
     */
    let wants_loader = req
        .loader_kind
        .as_deref()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    if !wants_loader {
        let raw = std::fs::read_to_string(&json_path).unwrap_or_default();
        let found = detect_flavors(&raw);
        // 附加组件（OptiFine / LiteLoader）单独判：纯原版 + OptiFine 是**合法**用法
        let offending: Vec<LoaderFlavor> = found
            .into_iter()
            .filter(|f| f.is_base())
            .collect();
        if !offending.is_empty() {
            return Err(format!(
                "这个实例是「{}」的纯原版，但盘上只有一份带加载器的版本描述（{}）。\n\
                 读到的加载器：{}\n\
                 版本文件：{}\n\n\
                 两个选择：\n\
                 ① 双击这个版本，把它改成一个带加载器的实例（推荐，会立即生效）；\n\
                 ② 或者去「下载」页装一份纯原版 {}（已下载的文件会跳过，很快）。",
                req.mc_version,
                version.id,
                offending
                    .iter()
                    .map(|f| f.display())
                    .collect::<Vec<_>>()
                    .join("、"),
                json_path.display(),
                req.mc_version,
            ).into());
        }
    }

    /*
     * ★ 装了加载器却读到了原版 JSON → 必须报错，不能硬着头皮启动。
     *
     *   实测踩过（Fabric 26.2）：安装把 JSON 写成
     *   `versions/fabric-loader-0.19.5-26.2/fabric-loader-0.19.5-26.2.json`，
     *   而启动拼的是同目录下的 `26.2.json` —— 找不到就**静默落回原版**。
     *   于是主类是 Fabric 的 `…KnotClient`，classpath 里却没有 Fabric 库，
     *   游戏只留下一句 164 字节的日志：
     *   `错误: 找不到或无法加载主类 net.fabricmc.loader.impl.launch.knot.KnotClient`。
     *   这种"读到错的 JSON"比"读不到 JSON"难查得多，所以这里显式拦住。
     *
     * ★ 判据用 `domain::loader_trace`（按库坐标看，不看名字猜），而且
     *   **错误信息里要说清盘上到底有什么** —— 用户看到"没有 Forge"时最需要知道
     *   的是"那盘上有什么"，否则只能靠猜。
     */
    if let Some(kind) = req.loader_kind.as_deref().filter(|k| !k.is_empty()) {
        let raw = std::fs::read_to_string(&json_path).unwrap_or_default();
        let found = detect_flavors(&raw);
        let want = LoaderFlavor::parse(kind);
        let ok = match want {
            Some(w) => found.contains(&w),
            None => false,
        };
        if !ok {
            let installed = installed_loaders_for(&scan_version_dir(shared), &req.mc_version);
            let have = if installed.is_empty() {
                "本机这个版本一份加载器都没装".to_string()
            } else {
                format!(
                    "本机 {} 上装的是：{}",
                    req.mc_version,
                    installed
                        .iter()
                        .map(|l| if l.version.is_empty() {
                            l.name.clone()
                        } else {
                            format!("{} {}", l.name, l.version)
                        })
                        .collect::<Vec<_>>()
                        .join("、")
                )
            };
            return Err(format!(
                "这个实例要求用 {kind} 启动，但读到的版本描述（{}）里没有 {} 的痕迹。\n\
                 {have}\n\
                 版本文件：{}\n\n\
                 如果是刚装的，回「下载」页重新装一次这条加载器即可\n\
                 （已下载的文件会跳过，很快）。",
                version.id,
                want.map(|w| w.display()).unwrap_or(kind),
                json_path.display()
            ).into());
        }
    }

    /*
     * ★ 启动时**递归合并父版本** —— 这是让加载器版本完整的关键一步。
     *
     *   实测（Fabric 26.2 起不来）：新版 Mojang 版本 JSON 是**增量的** ——
     *   26.2 自己那份里**没有** `org.lwjgl:lwjgl:3.4.1`（核心 LWJGL，
     *   含 `org.lwjgl.system.CallbackI`），它只列 natives 变体与 unsafe 变体。
     *   Fabric 的 profile 声明 `inheritsFrom: 26.2`，也**不含**核心 lwjgl。
     *   于是不管读哪一份，classpath 里都没有核心 LWJGL →
     *   `NoClassDefFoundError: org/lwjgl/system/CallbackI`。
     *
     *   官方启动器就是在这时候沿 inheritsFrom 把父版本合进来的（这正是
     *   `inheritsFrom` 的语义）。我们以前只在**安装时**合并并写盘，
     *   于是：① 磁盘上那份文件可能由旧规则写出（缺库）；
     *         ② 父版本后来被更新/重装时，那份合并结果不会跟着更新。
     *   放在启动时合并，两个问题一起消失，而且**自动修复已装坏的版本**。
     */
    let version = merge_with_parents(shared, version, &req.mc_version, req.loader_kind.as_deref());

    // 扫 classpath + natives（纯函数 `scan_classpath`，见上）
    let ClasspathScan {
        mut classpath,
        natives,
        missing,
        // ★ 本地产物缺失（Forge processor 生成的 client jar）——
        //   这个**下载补不了**，只能重装加载器，所以单独一条错误信息。
        missing_generated,
    } = scan_classpath(&version, shared);

    /*
     * ★★ **缺文件就自动补，而不是拦下来让用户自己去点"重新安装"** ★★
     *
     *   实测（本机真实数据）：`versions/1.20.1/` 有 23 MB 的客户端 jar、
     *   62 KB 的版本描述，但 43 个库里 **35 个不在盘上**。
     *   这种版本在界面上写着"已安装"，点启动却只会报
     *   「这个版本有 35 个库文件缺失，启动必然失败 / 请回下载页重新安装一次」。
     *
     *   那句话本身没错，但它把**我们该干的活推给了用户**：
     *     · 用户凭什么知道"已安装"是假的？
     *     · "重新安装"藏在下拉菜单里，找得到的人不多；
     *     · 而缺什么、从哪来，我们的下载规划**完全清楚**。
     *
     *   所以改成先自愈：缺什么补什么，补完**重新扫一遍**，
     *   只有补不齐（网络 / 上游 404）才拦下 —— 那时候用户是真的没别的办法。
     *
     *   ★ 幂等：文件齐了 `repair_missing` 提前返回，一个请求都不发。
     */
    let mut missing = missing;
    /*
     * ★★ 2026-09-22：这一段只在**真的要启动**时跑（`repair`）。
     *
     *   它是**安装级**的活（会发请求下载缺失的库），而 `preview_launch` 只是拼一条
     *   命令行 —— 之前预览把它一并跑了，真机上量出 **14.5 秒**（它在下载）。
     *   预览要的是"命令长什么样"，不是"顺手把东西装好"。
     */
    if repair && !missing.is_empty() {
        let repair_input = crate::net::installer::PlanInput {
            version: version.clone(),
            shared_root: shared.clone(),
            instance_dir: instance_dir.clone(),
            source: Source::Bmclapi,
            download_assets: false,
        };
        let opts =
            crate::net::installer::InstallOptions::new(32, crate::net::download::CancelToken::new());
        match crate::net::installer::repair_missing(&repair_input, opts).await {
            Ok(r) => {
                say!(
                    "[IEML/launch] 启动前自愈：缺 {}，补回 {}，失败 {}",
                    r.missing,
                    r.repaired,
                    r.failed.len()
                );
                for (label, err) in r.failed.iter().take(5) {
                    say!("[IEML/launch]   补不上：{label} → {err}");
                }
                if r.failed.is_empty() {
                    // 真相以磁盘为准，不以"我们说补好了"为准
                    let rescan = scan_classpath(&version, shared);
                    classpath = rescan.classpath;
                    missing = rescan.missing;
                } else {
                    return Err(format!(
                        "这个版本缺 {} 个文件，自动补回了 {} 个，还有 {} 个没补上：\n  {}\n\n\
                         多半是网络或上游镜像的问题，可以稍后重试；\n\
                         也可以到「下载」页重新安装一次这个版本（已下载的会跳过）。",
                        r.missing,
                        r.repaired,
                        r.failed.len(),
                        r.failed
                            .iter()
                            .take(5)
                            .map(|(n, e)| format!("{n}：{e}"))
                            .collect::<Vec<_>>()
                            .join("\n  ")
                    ).into());
                }
            }
            Err(e) => {
                // 自愈失败不拦住启动 —— 让下面原有的"缺库"检查给出完整清单
                say!("[IEML/launch] 启动前自愈失败：{e}");
            }
        }
    }

    /*
     * ★★ **加载器本地产物缺失** —— 这一类**下载补不了**。
     *
     *   Forge 56+ 的 `net.minecraftforge:forge:<ver>:client` 是一个 77 MB 的
     *   客户端 jar，由 Forge 安装器的 processor **拿原版 jar 打补丁本地生成**
     *   （`url` 是空串，远程没有这个文件）。
     *
     *   所以这类缺口的修法**只有一个**：让安装器再跑一遍。
     *   报"缺文件、请重新下载"是错的方向 —— 用户会去点"补全文件"，
     *   而那个操作补不了它，只会白跑一趟还修不好。
     *
     *   实测：`26.1.2-forge-64.1.3` 的 processor 没跑成（缺这个 jar），
     *   而 `26.2-65.1.3` 有（75.52 MB）—— 两个版本一比就知道是安装的问题。
     */
    if !missing_generated.is_empty() && repair {
        return Err(format!(
            "这个 Forge 版本少了 {} 个**由安装器本地生成**的文件，启动必然失败：\n  {}\n\n\
             它们不是下载来的 —— Forge 的安装器要拿原版 jar 打补丁生成，\n\
             所以「补全文件」补不了它们。\n\n\
             修法：到「下载」页对这个版本**重新安装一次 Forge**\n\
             （安装器会重新跑一遍补丁步骤；已下载的库会跳过）。",
            missing_generated.len(),
            missing_generated.join("\n  ")
        ).into());
    }

    /*
     * ★ 预览（`repair == false`）时**不把"缺文件"当错误拦下**：
     *   命令行照样拼得出来，缺什么会写进 `notice` 如实告诉用户；
     *   用户点「就这样启动」时才会真的去补齐。
     */
    if !missing.is_empty() && repair {
        let sample: Vec<String> = missing.iter().take(5).cloned().collect();
        return Err(format!(
            "这个版本有 {} 个库文件缺失，启动必然失败：\n  {}{}\n\n\
             已经试过自动补下但没成功。请检查网络后回到「下载」页重新安装一次\n\
             （已下载的文件会跳过，很快）。",
            missing.len(),
            sample.join("\n  "),
            if missing.len() > sample.len() {
                format!("\n  …等共 {} 个", missing.len())
            } else {
                String::new()
            }
        ).into());
    }

    // 客户端 jar
    //
    // ★ 加载器版本要**沿 inheritsFrom 一路把原版 jar 也加进来**。
    //   实测踩过（Fabric 26.2）：加载器版本的 JSON 里仓库 jar 是 Fabric 自己的
    //   （`versions/fabric-loader-0.19.5-26.2/fabric-loader-0.19.5-26.2.jar`），
    //   而**原版客户端 jar 在 `versions/26.2/26.2.jar`** —— 不加进去的话
    //   FabricLoader 会报：
    //   `Minecraft game provider couldn't locate the game!
    //    The game may be absent from the class path …`
    //   然后以退出码 0 退出（所以连"崩溃"都算不上，只是游戏没起来）。
    let mut jar_ids: Vec<String> = vec![version_id.clone()];
    {
        // 最多跟 4 层，防 JSON 里 inheritsFrom 成环
        let mut cur = version.inherits_from.clone();
        let mut hops = 0;
        while let Some(parent) = cur {
            if hops >= 4 || jar_ids.contains(&parent) {
                break;
            }
            jar_ids.push(parent.clone());
            let p = shared
                .join("versions")
                .join(&parent)
                .join(format!("{parent}.json"));
            cur = std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str::<VersionJson>(&t).ok())
                .and_then(|v| v.inherits_from);
            hops += 1;
        }
    }
    for id in &jar_ids {
        let jar = shared
            .join("versions")
            .join(id)
            .join(format!("{id}.jar"));
        if jar.is_file() && !classpath.contains(&jar) {
            classpath.push(jar);
        }
    }

    /*
     * 解压 natives —— **这里是唯一的解压点**（每次启动都重解压，
     * 保证与上次的架构一致：同名的 32 位与 64 位 dll 会互相覆盖）。
     *
     * ★ 解压到哪一层**必须跟着版本 JSON 走**（踩过一次真机崩溃）。
     *
     * 老版本：JVM 参数里没有 natives 项，我们自己补
     *         `-Djava.library.path=<natives>` → dll 平铺在 natives 根目录。
     * 新版本（实测 26.2 / LWJGL 3.4.1）：版本 JSON 自带
     *         `-Djava.library.path=${natives_directory}/java`
     *         → 必须解压到 `<natives>/java`，否则游戏一起就崩：
     *         `UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。
     *
     * 两个目录都解一份：成本只是几个 MB 的复制，换来的是
     * **同一套代码同时兼容两种布局**，不必按版本号猜。
     *
     * ★ 安装阶段**不**再解压一份（以前会，见 installer::install 末尾）：
     *   那份没人读，纯占 15 MB。
     */
    if natives_dir.is_dir() {
        std::fs::remove_dir_all(&natives_dir).ok();
    }
    std::fs::create_dir_all(&natives_dir).map_err(|e| format!("创建 natives 目录失败：{e}"))?;

    let mut native_targets = vec![natives_dir.clone()];
    if let Some(sub) = metadata::natives_java_subdir(&version) {
        let p = natives_dir.join(&sub);
        std::fs::create_dir_all(&p).map_err(|e| format!("创建 natives/{sub} 失败：{e}"))?;
        native_targets.push(p);
    }
    let mut extracted = 0usize;
    let mut extract_failures: Vec<String> = Vec::new();
    for (jar, exclude) in &natives {
        let label = jar
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| jar.display().to_string());
        for target in &native_targets {
            match installer::extract_natives(jar, target, exclude) {
                Ok(n) => {
                    // 根目录那一份计入总数（子目录那份是同内容的副本，不重复计）
                    if target == &natives_dir {
                        extracted += n;
                    }
                }
                Err(e) => {
                    let msg = format!("{label} → {e}");
                    if !extract_failures.contains(&msg) {
                        extract_failures.push(msg);
                    }
                }
            }
        }
    }
    if !extract_failures.is_empty() {
        // 解压失败不直接终止（缺的可能是别的平台的库），但必须让人看见
        say!(
            "[IEML/launch] natives 解压失败 {} 个：{}",
            extract_failures.len(),
            extract_failures.join("；")
        );
    }
    say!(
        "[IEML/launch] natives 解压完成：{} 个文件 → {}",
        extracted,
        native_targets
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" + ")
    );

    /*
     * ★★ 启动前的**硬闸门**：natives 目录里必须真的有 dll。
     *
     *   用户报的「1.12.2 打不开，崩溃了」，日志只有一句话：
     *     `java.lang.UnsatisfiedLinkError: no lwjgl64 in java.library.path:
     *      …\instances\vanilla-1122\natives`
     *   而那个目录**是空的** —— 目录被创建了，dll 一个都没有。
     *
     *   以前这里"解压完就往下走"，不看结果：解压出了 0 个文件也照样拼命令行
     *   把游戏拉起来，于是崩溃现场离真正的原因（natives 空）隔了整整一层
     *   JVM。用户只能看到一句 UnsatisfiedLinkError，根本不知道该修什么。
     *
     *   现在的立场（与全项目一致）：**能提前判定必然失败，就不要让它失败。**
     *   宁可在这里拦住并说清"natives 是空的、怎么办"，
     *   也不要把一个注定崩溃的进程拉起来。
     *
     *   判据是"**有 dll/so/dylib**"而不是"文件数 > 0"：
     *   natives jar 里也有 `META-INF/` 之类的非库文件，只数个数会放过
     *   "解出来一个 README" 这种假成功。
     */
    let native_lib_count = count_native_binaries(&natives_dir);
    if native_lib_count == 0 {
        let detail = if natives.is_empty() {
            "这个版本的描述里一个 natives 库都没有".to_string()
        } else {
            format!(
                "应该解压 {} 个 natives 包，但一个 dll 都没解出来（{}）",
                natives.len(),
                if extract_failures.is_empty() {
                    "包本身可能损坏，重新安装一次通常能修好".to_string()
                } else {
                    format!("失败原因：{}", extract_failures.join("；"))
                }
            )
        };
        return Err(format!(
            "启动被拦下：本地库（natives）目录是空的，游戏一定会崩在\n\
             \x20 java.lang.UnsatisfiedLinkError: no lwjgl64 in java.library.path\n\n\
             \x20 目录：{}\n\
             \x20 原因：{}\n\n\
             处理办法：回「下载」页对这个版本重新安装一次（已下载的文件会跳过，很快），\
             或者在「版本列表」里删掉这个版本重新装一份。",
            natives_dir.display(),
            detail
        ).into());
    }

    /*
     * Java
     *
     * ★★ 这里的**判据必须来自版本 JSON**，不能只看前端传的 `java_major`。
     *
     *   用户报的「Forge 版 mc 还没打开就报错崩溃」根因就在这：
     *     26.2 的版本 JSON 写着 `"javaVersion": {"majorVersion": 25}`，
     *     而前端那张写死的规则表只认到 `>= 1.20.5 → Java 21`，
     *     于是传下来 `java_major = 21`。而 Forge 65.1.3 的 profile 里有
     *     `-XX:+UseCompactObjectHeaders`（Java 24 才有），Java 21 直接拒绝：
     *       `Unrecognized VM option 'UseCompactObjectHeaders'`
     *       `Error: Could not create the Java Virtual Machine.`
     *     游戏连一行自己的日志都没写出来。
     *
     *   现在：**版本 JSON 里 Mojang 写的 javaVersion 优先**，
     *   前端传的值只作为它缺失时的兜底。
     *   判据算法与 PCL 的 `GetJavaRequirement` 一致（多条约束求交集）。
     */
    /*
     * 这个版本有没有 OptiFine —— **从磁盘上的痕迹判**，不靠前端传。
     *
     * ★ OptiFine 的 Java 要求很特殊（1.16.5 及更早必须 Java 8，
     *   否则它的图形补丁挂不上）。而 `LaunchRequest` 里没有 addons 字段
     *   （实例记录里那份 addons 是"当初说要装什么"，磁盘才是"现在有什么"）。
     *   判据用 `loader_trace` 的同一套实现，与"盘上装了什么"那一页一致。
     */
    let has_optifine = {
        let raw = std::fs::read_to_string(&json_path).unwrap_or_default();
        detect_flavors(&raw).contains(&LoaderFlavor::OptiFine)
    };
    let mojang_java = version
        .java_version
        .as_ref()
        .map(|v| v.major_version)
        .unwrap_or(0);
    /*
     * ★★ 请求里**没有** `java_major` 这个字段了（以前有）。
     *
     *   前端那张写死的规则表（`1.20.5+ → 21 / 1.17+ → 17 / 其余 → 8`）只取
     *   `split('.')[0]` 当 major，于是 `26.2` 的 major 是 26 而不是 1 →
     *   落到 `return 8`，传下来一个**错的兜底值**。
     *   （用户看到的就是「26.2 需要 Java 8」。）
     *
     *   启动之所以没坏，是因为这里的判据以版本 JSON 的 `javaVersion` 为准 ——
     *   但**错的兜底值不该存在于接口上**：哪天 JSON 缺那个字段，错的数就会
     *   真的被用上。所以整个字段删掉，规则只剩一处：
     *   `domain::java::resolve_java_requirement`。
     */
    let is_loader = req
        .loader_kind
        .as_deref()
        .map(|k| k == "forge" || k == "neoforge")
        .unwrap_or(false);
    let mut java_input = crate::domain::java::JavaConstraintInput::detailed(
        &req.mc_version,
        is_loader,
        0,
        has_optifine,
        mojang_java,
        false,
    );
    /*
     * ★★ **加载器自身的版本号也要喂给规则引擎**（P0-7）。
     *
     *   判据同前端 `javaRequirementFor({ …, forgeVersion, fabricVersion })`：
     *     · Forge：34.0.0~36.2.25 最高 Java 8 / 36.2.26+ 最高 23 /
     *       37.0.0~37.0.79 最高 16 / 45.0.21~45.0.65 最高 19 /
     *       45.0.66~47.4.8 最高 21 —— **只看游戏版本号推不出来**；
     *     · Fabric Loader < 0.17.0：Mixin/ASM 不兼容 Java 25，要设上限。
     *
     *   以前这里只传了 `is_loader` 与"是不是 NeoForge"，于是
     *   **界面（TS）算出来的 Java 与启动时（Rust）算出来的不是同一个**。
     */
    java_input = java_input.with_loader(
        req.loader_kind.as_deref().unwrap_or(""),
        req.loader_version.as_deref(),
    );
    let java = find_java_by_requirement(state, &java_input, &req.mc_version)?;

    /*
     * ★★ 账号：**先看令牌过没过期，过期就静默续期**，续不上才退回离线。
     *
     *   ## 这里原来有一个"静默降级"的坑
     *
     *   老代码只有一句：
     *   ```ignore
     *   auth::load_account(uuid).map(|a| a.to_launch_account())
     *       .unwrap_or_else(|_| Account::offline(&req.username))
     *   ```
     *   也就是**任何**失败都悄悄变成离线账号。而 `is_expired()` 从来没在
     *   启动路径上被调用过 —— 于是正版 access token 一过期（约 24 小时），
     *   用户第二天启动就变成离线 "Player"：
     *     · 进不了正版服务器（服务端报验证失败）；
     *     · 皮肤没了；
     *     · 而界面上一切正常，**一个字都没说**。
     *     （`auth/store_account` 的注释里也记着用户报过"第二天变成离线 Player"。）
     *
     *   ## PCL 是怎么做的（`ModLaunch.vb` 552-582，逐条对照）
     *
     *   ```text
     *   557  '检查是否已经登录完成
     *   558  Dim ExpiresAt = Settings.Get(Of Long)("CacheMsV2Expires")
     *   559  If Not Data.IsForceRestarting AndAlso
     *   560     ExpiresAt > 0 AndAlso ExpiresAt > GetUnixTimestampUtc() AndAlso
     *   561     Input.UserName = Settings.Get(Of String)("CacheMsV2Name") Then
     *   570      GoTo SkipLogin          ← 没过期就直接复用，不打网络
     *   571  End If
     *   574  If Input.OAuthRefreshToken = "" Then
     *   577      OAuthTokens = MsLoginStep1New(Data)        ← 没有 refresh token → 走设备码
     *   579  Else
     *   580      OAuthTokens = MsLoginStep1Refresh(...)     ← 有 → **先续期**
     *   581      If ...OAuthAccessToken = "Relogin" Then GoTo Relogin  ← 续不上 → 回设备码
     *   582  End If
     *   ```
     *
     *   三个要点，我们这次都补上：
     *     ① **没过期就复用**（不打网络）—— 我们本来就是；
     *     ② **过期先用 refresh_token 续**（`login.live.com/oauth20_token.srf`，
     *        PCL 第 929 行）—— 原来完全没有；
     *     ③ **续不上要区分**"要重新登录"和"网络问题"，前者提示用户重登，
     *        后者不该把他的账号踢下线。
     *
     *   ## 为什么失败时不直接报错拦住启动
     *
     *   离线照样能玩单机（PCL 也是这个立场：登录失败只是结果里的一个状态）。
     *   但**必须说出来** —— 否则用户拿着一个离线身份去连正版服务器，
     *   只会看到服务端一句看不懂的验证失败。
     */
    let mut account_note: Option<String> = None;
    let account = match &req.account_uuid {
        Some(uuid) if !uuid.is_empty() => match auth::load_account(uuid) {
            Ok(mut acc) => {
                if acc.kind == "msa" && acc.is_expired() {
                    // ② 过期 → 先续期（PCL 第 580 行）
                    match acc.refresh_token.clone() {
                        Some(rt) if !rt.trim().is_empty() => {
                            match auth::refresh_msa(&rt).await {
                                Ok(fresh) => {
                                    say!(
                                        "[IEML/launch] 正版令牌已过期，已静默续期（{}）",
                                        fresh.username
                                    );
                                    acc = fresh;
                                }
                                Err(e) => {
                                    // ③ 续不上 —— 说清是哪一种
                                    let why = e.to_string();
                                    say!("[IEML/launch] 正版令牌续期失败：{why}");
                                    account_note = Some(format!(
                                        "正版登录已过期，自动续期没成功（{why}）。\n\
                                         这次会用离线身份启动 —— 单机不受影响，\
                                         但连正版服务器会因为验证失败被拒。\n\
                                         到「设置 → 账号」重新点一次「正版登录」即可。"
                                    ));
                                }
                            }
                        }
                        _ => {
                            account_note = Some(
                                "这个正版账号没有可用的续期凭据，这次用离线身份启动。\n\
                                 到「设置 → 账号」重新登录一次即可。"
                                    .to_string(),
                            );
                        }
                    }
                }
                acc.to_launch_account()
            }
            Err(e) => {
                account_note = Some(format!(
                    "读不到这个正版账号的凭据（{e}），这次用离线身份启动。\n\
                     到「设置 → 账号」重新登录一次即可。"
                ));
                launch_args::Account::offline(&req.username)
            }
        },
        _ => launch_args::Account::offline(&req.username),
    };
    if let Some(note) = &account_note {
        say!("[IEML/launch] {note}");
    }

    /*
     * ★ 老版本（1.6.4 及以前）的资源根目录**不是** `assets/`，而是
     *   `assets/virtual/<索引名>/` —— 那批游戏不认识内容寻址的 objects。
     *
     *   判据看盘上的事实：安装阶段已经按索引的 `virtual` 字段铺过一份。
     *   这里只需要"那个目录存在就用它"，存在即说明这个版本需要虚拟资源。
     *   （`--assetsIndex` / `game_assets` 两边都指向同一个目录名，
     *    与 installer 里 materialize 用的名字必须一致。）
     */
    let assets_root = {
        let assets = shared.join("assets");
        let name = version.assets.trim();
        let base = if name.is_empty() {
            version
                .asset_index
                .as_ref()
                .map(|a| a.id.clone())
                .unwrap_or_default()
        } else {
            name.to_string()
        };
        let virtual_dir = assets
            .join("virtual")
            .join(metadata::virtual_assets_dir_name(&base));
        if virtual_dir.is_dir() {
            virtual_dir
        } else {
            assets
        }
    };

    Ok(LaunchSpec {
        java,
        main_class: version.main_class.clone(),
        classpath,
        natives_dir,
        /*
         * ★★ `${library_directory}` 用**共享库根目录本身**。
         *
         *   以前 `build_command` 是拿 classpath 第一项往上数四层反推的 ——
         *   而 classpath 的第一项并不保证是"标准四层布局的库"（客户端 jar
         *   也在这里被 push 进来）。Forge 的 profile 里有
         *   `-DlibraryDirectory=${library_directory}`，推错就等于把库根指到
         *   别处，游戏只会报"找不到某个库"。
         *   这里直接给它真值：`shared/libraries`。
         */
        libraries_dir: shared.join("libraries"),
        game_dir,
        assets_root,
        asset_index_name: version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_else(|| "5".into()),
        version_name: req.mc_version.clone(),
        version_type: ver_type(&version.release_type),
        account,
        memory_mb: req.memory_mb,
        width: req.width,
        height: req.height,
        jvm_args_template: version.arguments.as_ref().map(|a| a.jvm.clone()).unwrap_or_default(),
        game_args_template: version.arguments.as_ref().map(|a| a.game.clone()).unwrap_or_default(),
        legacy_arguments: version.minecraft_arguments.clone(),
        extra_jvm_args: req.extra_jvm_args.clone(),
        extra_game_args: req.extra_game_args.clone(),
        // ★ 自定义窗口标题：前端一直在传，以前后端直接丢掉（功能等于没有）
        window_title: req.window_title.clone(),
        // ★ 启动后自动进服（PCL2 的实例设置里有这一项；全角标点由
        //   `launch_args::parse_server_address` 统一清洗）
        join_server: req.join_server.clone(),
        // ★ 账号告警要**带给界面**：写进日志等于没写（用户不会去看日志）
        notice: account_note,
    })
}

fn ver_type(t: &str) -> String {
    if t.is_empty() {
        "release".into()
    } else {
        t.to_string()
    }
}

/// natives 目录里**真正的本地库**有几个（dll / so / dylib）。
///
/// 刻意不数"文件总数"：natives jar 里常带 `META-INF/MANIFEST.MF`、
/// `LICENSE` 之类的非库文件，只数个数会把"解出来一个说明文件"当成成功。
fn count_native_binaries(dir: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && e.path()
                    .extension()
                    .map(|x| {
                        let x = x.to_string_lossy().to_lowercase();
                        x == "dll" || x == "so" || x == "dylib"
                    })
                    .unwrap_or(false)
        })
        .count()
}

/// 找可用的 Java（按**约束区间**找，不是按单个主版本号）。
///
/// ## ★★ 这里改的是用户报的「Forge 版 mc 还没打开就报错崩溃」的根因
///
///   老签名是 `find_java(state, major, mc_version)` —— 按**一个数字**找。
///   而 26.2 + Forge 65.1.3 的真实要求是"Java **25 及以上**"：
///     · 前端那张写死的表说 21（`>= 1.20.5 → Java 21`）；
///     · Mojang 的版本 JSON 说 25；
///     · Forge 65 的 profile 有 `-XX:+UseCompactObjectHeaders`（Java 24+）。
///   按"21"去找 → 拿到 Java 21 → JVM 拒绝参数 → 游戏连日志都没写就没了。
///
///   现在按**区间**找，而且区间由 `resolve_java_requirement`（照 PCL 的
///   `GetJavaRequirement` 写的）求交集得出：
///     `[21, ∞) ∩ [25, ∞) = [25, ∞)` → 挑区间内最高可用 → Java 25 → 能起。
///
/// ## 三道闸门（用户的两条诉求都在这）
///
///   ① 区间内有 Java → 挑**最高的**那个（最高版本最可能是 Forge/Mojang
///      真正期望的，也最不容易踩到"某个 flag 不存在"的坑）；
///   ② 区间内没有 → **绝不偷偷换一个**，直接报错；
///   ③ 报错要**可行动**：本机有哪些 Java、该装哪个、去哪装，一次说清。
fn find_java_by_requirement(
    state: &AppState,
    input: &crate::domain::java::JavaConstraintInput,
    mc_version: &str,
) -> Result<std::path::PathBuf, LaunchError> {
    let requirement = crate::domain::java::resolve_java_requirement(input.clone());
    let scanned = crate::platform::scan_java(&state.paths());

    // ① IEML 自己下的优先（来源最明确、版本最可控）
    let downloaded = adoptium::list_downloaded_java(&state.paths().java);
    let in_range = |major: u32| requirement.range.contains(major as f64);

    if let Some(j) = downloaded
        .iter()
        .filter(|j| j.usable && in_range(j.major))
        .max_by_key(|j| j.major)
    {
        return Ok(j.path.clone());
    }

    // ② 系统/官方启动器里扫到的
    if let Some(rt) = scanned
        .iter()
        .filter(|r| !r.disabled_by_default && in_range(r.major))
        .max_by_key(|r| r.major)
    {
        say!(
            "[IEML/launch] {mc_version}：区间 {} 内选到最高的 Java {}（{}）",
            requirement.range.format(),
            rt.major,
            rt.path
        );
        return Ok(std::path::PathBuf::from(&rt.path));
    }

    // ③ 一个都不满足 → 拒绝启动，并把该说的都说了
    let have = if scanned.is_empty() {
        "本机一个 Java 运行时都没扫到".to_string()
    } else {
        format!(
            "本机扫到的 Java：{}",
            scanned
                .iter()
                .map(|r| format!("{} {}", r.major, r.vendor))
                .collect::<Vec<_>>()
                .join("、")
        )
    };
    let want = requirement.range.format();
    Err(LaunchError {
        code: "java-missing".to_string(),
        message: format!(
            "这个版本需要 Java {want}，但本机没有落在该范围内的 Java。\n\
             {have}\n\n\
             为什么是这个范围：{}\n\n\
             为什么不能凑合：Java 版本不对时，游戏常常**连日志都来不及写**就退出\n\
             （例如 Forge 的启动参数里有只有新 Java 才认识的选项，JVM 会直接拒绝：\n\
             \x20 `Unrecognized VM option 'UseCompactObjectHeaders'`）。\n\n\
             两个办法：\n\
             ① 打开「设置 → Java 运行环境」，点「下载 Java」（推荐，会自动装好）；\n\
             ② 已经装过就把路径填进「手动指定 Java」——\n\
             如果 Java 在官方启动器或 PCL 那边，IEML 现在会自动扫到 %APPDATA%\\.minecraft\\runtime\\。",
            requirement.reason
        ),
        /*
         * ★★ 真正需要的是**机器可读的两个字段**（P0-7）：
         *   界面的「自动下载 Java」按钮只缺一个数字，而它以前是从
         *   `message` 里用正则抠出来的（`/Java (\d+)/`）——
         *   文案一改就失效，文案里多一个数字就抠错。
         */
        required_major: Some(requirement.major),
        required_range: Some(want),
    })
}

/// 停止游戏（先温和，超时强杀）并返回本次游玩信息
///
/// ★ 必须 `async` + `spawn_blocking`（用户报"点关闭游戏时启动器会未响应一下"）：
///   以前它是**同步命令**，而 `launch::stop` 会 `taskkill /PID … /T` 并**等它返回**
///   —— 游戏要花几秒关闭，这几秒里 Tauri 一直占着主线程，
///   窗口就变成"未响应"。同步命令跑在命令线程上，但阻塞式 `Command::status()`
///   会把事件循环一起卡住。丢到阻塞线程池里，界面就不会僵。
///
/// ★★ 2026-09-15（多开实例）：加了 `instance_id` 参数。
///   以前没有参数、只能停"那一个"；现在同时可能有好几个在跑，
///   **"停哪个"必须由调用方说清楚** —— 让后端自己猜（比如"停最早那个"）
///   是那种平时看不出来、一多开就停错游戏的错。
///   传 `None` 表示"全停"（启动器退出时的收尾会用）。
#[tauri::command]
pub async fn stop_minecraft(
    instance_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<StopInfo>, String> {
    let running = {
        let mut guard = state.running.lock().map_err(|_| "状态锁失败")?;
        match instance_id {
            Some(id) => match guard.remove(&id) {
                Some(r) => r,
                None => return Ok(None), // 这个实例本来就没在跑
            },
            /*
             * 全停：只返回**一个** StopInfo（命令的返回类型如此），
             * 其余几局的收尾照做、退出事件照推（前端按事件记账），
             * 但这一条命令只把这一个的结论报回去。
             */
            None => match guard.keys().next().cloned() {
                Some(first) => {
                    let rest: Vec<String> = guard.keys().filter(|k| **k != first).cloned().collect();
                    for id in rest {
                        if let Some(other) = guard.remove(&id) {
                            let _ = crate::launch::stop(&other);
                        }
                    }
                    guard.remove(&first).expect("刚看过还在")
                }
                None => return Ok(None),
            },
        }
    };

    /*
     * ★★ **进程在我们动手之前是不是已经死了**（P0-6）。
     *
     *   这件事决定"这次算不算崩溃"：
     *     · 已经死了 → 游戏是**自己退出的**，按"游戏自己退出"判；
     *     · 还活着   → 是我们 taskkill 掉的，**退出码不代表出了什么事**，
     *                  不许拿它当崩溃证据。
     *   以前这里不分这两种情况，只看日志规则 —— 于是离线启动的日志里
     *   必然有 `401 Unauthorized`，用户点一下「停止游戏」就弹
     *   「游戏异常退出 · 登录状态已失效」。那是我们自己造成的现象。
     */
    let already_dead = !crate::launch::is_still_running(&running);
    let dead_exit_code = if already_dead {
        crate::launch::exit_code_of(&running)
    } else {
        None
    };

    // 阻塞部分（taskkill + 读日志 + 崩溃分析）全部放到阻塞线程池
    let played_hint = running.started_at;
    let log_path = running.log_path.clone();
    let offline = running.offline;
    let info = tauri::async_runtime::spawn_blocking(move || {
        let warn = crate::launch::stop(&running).err();
        let tail = crate::launch::read_log_tail(&log_path, 256 * 1024);
        let log_bytes = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        let played = now_secs().saturating_sub(played_hint);

        /*
         * ★ 判据只有一份：`domain::crash::judge_crash`（P0-6）。
         *   退出码 + 是不是用户按的停止 + 离线身份 + 秒退，
         *   全部交给它 —— 界面不再自己拼结论。
         */
        let verdict = crate::domain::crash::judge_crash(
            dead_exit_code,
            !already_dead, // 我们动手时它还活着 = 用户主动停止
            offline,
            played,
            log_bytes,
            &tail,
        );
        if !verdict.evidence.is_empty() {
            say!("[IEML/launch] 停止判定：crashed={}", verdict.crashed);
            for e in &verdict.evidence {
                say!("[IEML/launch]   依据：{e}");
            }
        }

        StopInfo {
            played_seconds: played,
            crashed: verdict.crashed,
            crash_reason: verdict.reason.clone(),
            crash_category: verdict.rule_id.clone(),
            log_path: log_path.to_string_lossy().to_string(),
            warning: warn,
            benign_notes: verdict
                .benign
                .iter()
                .map(|m| m.conclusion.clone())
                .collect(),
            evidence: verdict.evidence.clone(),
        }
    })
    .await
    .map_err(|e| format!("停止游戏的任务失败：{e}"))?;

    Ok(Some(info))
}

/// 现在有哪些实例在跑（多开实例）
///
/// ★ 为什么需要它：前端的状态是**自己攒**起来的（启动成功 / 收到 `game-exit` 事件）。
///   但界面可能被重新加载（WebView 刷新、以后可能的"重开界面"），
///   那时前端的表是空的、而后端的进程还活着 —— 界面就会说"没有游戏在运行"，
///   用户再点启动，游戏又开一份。
///   ★ 判据不复制：这里**顺手把已经死掉的条目清掉**，与启动那条路径同一个判据
///   （`launch::is_still_running`），所以返回的就是"真的还在跑的那些"。
#[tauri::command]
pub fn running_games(state: State<'_, AppState>) -> Result<Vec<RunningGameInfo>, String> {
    /*
     * ★★ 分三步：**取快照 → 放锁判活 → 再拿锁删**（2026-09-17 用户：
     *   "游戏关闭后，启动器的 UI 还是不正常，还会一直认为游戏在运行"）。
     *
     *   以前是一句话：持着**注册表锁**，在 `retain` 里对每一项调
     *   `is_still_running` —— 那要抢**子进程锁**。而退出监测线程当时
     *   正持着子进程锁做全套收尾（读 256 KB 日志 / 判崩溃 / 写文件 / 发事件）。
     *
     *   后果是**没有备用出口的死等**：这条轮询是前端唯一的兜底自愈路径
     *   （注册表别处不会自己清，见 `is_still_running` 的注释），它一挂，
     *   前端 `await` 就永远不返回 —— 注意是**挂住不是抛错**，
     *   所以前端那个 `catch` 捕不到，本地表永远不会被后端的事实覆盖，
     *   UI 就永久停在"游戏在运行"。
     *
     *   两处都改了：监测线程把锁缩到只包 `try_wait()`（见 `launch.rs`），
     *   这里则**不再持着注册表锁去抢子进程锁** —— 两步之间一把锁都不持，
     *   慢也只慢自己，不会把别人堵死。
     */
    // ① 持注册表锁**只取快照**，越短越好
    let snapshot: Vec<(String, u32, u64, std::sync::Arc<std::sync::Mutex<std::process::Child>>)> = {
        let guard = state.running.lock().map_err(|_| "状态锁失败")?;
        guard
            .iter()
            .map(|(id, r)| (id.clone(), r.pid, r.started_at, std::sync::Arc::clone(&r.child)))
            .collect()
    }; // ← 注册表锁在这里就放掉了

    // ② **无锁**逐个判活（这一步可能慢，但不再挡着任何人）
    let mut alive: Vec<RunningGameInfo> = Vec::new();
    let mut dead: Vec<String> = Vec::new();
    for (instance_id, pid, started_at, child) in snapshot {
        if crate::launch::is_child_alive(&child) {
            alive.push(RunningGameInfo { instance_id, pid, started_at });
        } else {
            dead.push(instance_id);
        }
    }

    // ③ 只为"删"再拿一次锁
    if !dead.is_empty() {
        if let Ok(mut guard) = state.running.lock() {
            for id in &dead {
                guard.remove(id);
            }
        }
    }

    Ok(alive)
}

#[derive(serde::Serialize)]
pub struct RunningGameInfo {
    pub instance_id: String,
    pub pid: u32,
    /// 启动时刻（Unix 秒）—— 前端据此算"已经玩了多久"
    pub started_at: u64,
}

#[derive(serde::Serialize)]
pub struct StopInfo {
    pub played_seconds: u64,
    pub crashed: bool,
    pub crash_reason: Option<String>,
    pub crash_category: Option<String>,
    pub log_path: String,
    pub warning: Option<String>,
    /// ★ 这次日志里**必然出现、已排除**的条目（离线启动的 401 等）。
    ///
    /// 交给界面是为了"能解释"：用户滑日志看到那几行时，
    /// 界面得能说"这行我们看到了，它不是原因，因为……"。
    pub benign_notes: Vec<String>,
    /// 判定依据（一条一条），排障时能看出"它凭什么这么说"
    pub evidence: Vec<String>,
}

/// 读某个实例的最新日志尾部（供崩溃分析弹窗）
#[tauri::command]
pub fn read_latest_log(slug: String, state: State<'_, AppState>) -> Result<String, String> {
    let dir = &state.paths().logs;
    let mut newest: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(&slug) || !name.ends_with(".log") {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                if let Ok(t) = meta.modified() {
                    if newest.as_ref().map(|(_, nt)| t > *nt).unwrap_or(true) {
                        newest = Some((e.path(), t));
                    }
                }
            }
        }
    }
    match newest {
        Some((p, _)) => Ok(crate::launch::read_log_tail(&p, 512 * 1024)),
        None => Ok(String::new()),
    }
}

/// 打开某个目录（供「打开实例目录」按钮）
#[tauri::command]
pub fn open_instance_folder(
    slug: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dir = if slug.is_empty() {
        state.paths().root.clone()
    } else {
        state.paths().instance_dir(&slug)
    };
    std::fs::create_dir_all(&dir).ok();
    // ★ 真正调起资源管理器打开目录（之前只返回路径，等于没反应）
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开目录：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// `which` → 目录（**纯函数**：不碰资源管理器，这样每个分支都能被单测钉住）。
///
/// ★★ 2026-09-24（C-2）：抽出来的理由是——用户报「'mods 目录'按钮打开的是实例根目录」，
///   而这条命令本身做的事（打开哪个目录）**没法在单测里验**（它会真的弹资源管理器）。
///   把"路径怎么算"与"打开"分开之后，路径这一半就能钉住了（见 `wire_tests::open_dir_*`）。
pub(crate) fn resolve_open_dir(
    paths: &crate::platform::AppPaths,
    which: Option<&str>,
    slug: Option<&str>,
) -> std::path::PathBuf {
    match which.unwrap_or("data") {
        "shared" | "game" => paths.shared.clone(),
        "logs" => paths.logs.clone(),
        "java" => paths.java.clone(),
        "cache" => paths.cache.clone(),
        "instance" => paths.instance_dir(slug.unwrap_or("")),
        "mods" => paths.instance_mods_dir(slug.unwrap_or("")),
        "game-dir" => paths.instance_game_dir(slug.unwrap_or("")),
        _ => paths.root.clone(),
    }
}

/// ★ 打开数据目录（供设置页「打开」按钮）。
///
/// **为什么必须走 Rust 命令，而不是前端直接调 `openPath`**（用户报的
/// 「设置里打开数据目录还是打不开」的根因）：
///   Tauri 的 opener 插件在前端调用时会先过一遍 **scope 检查**，
///   而 `opener:allow-open-path` 只是"允许调用这个命令"，**不含任何路径白名单**。
///   于是 `openPath('C:\\Users\\…\\AppData\\Roaming\\IEML')` 必然返回
///   `forbidden path`，而前端那句 `catch {}` 把它吞掉、只弹一条 toast ——
///   用户看到的就是"点了没反应"。
///   从 Rust 侧调 `app.opener().open_path(...)` **不经过插件命令的 scope**，
///   所以这是最可靠的路径（实例目录那个按钮就是这么写的，一直是好的）。
///
/// `which` 决定开哪个目录：`data` = 数据根目录，其余按 slug 当成实例目录。
#[tauri::command]
pub fn open_data_dir(
    which: Option<String>,
    slug: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dir = resolve_open_dir(&state.paths(), which.as_deref(), slug.as_deref());
    std::fs::create_dir_all(&dir).ok();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开目录 {}：{e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 「用过的游戏文件夹」列表（设置页「新建/切换…」里那张表）。
///
/// ★★ 用户 2026-09-20（给了 PCL 的截图）：「**这个切换列表我想要 PCL 这样的**」。
///   所以列的是**文件夹**（名字 + 路径），而不是我上一版那种"机器上有哪些盘"。
///
/// ★ 这条命令**只读**：它只把候选摆出来。真正落盘的是 `set_data_root`
///   （校验、建目录、写记录文件都在那儿，且只有那一处）。
#[tauri::command]
pub fn list_data_roots(state: State<'_, AppState>) -> Vec<crate::platform::KnownRoot> {
    crate::platform::list_known_roots(&state.paths().root)
}

/* ============ 当前游戏文件夹里有哪些版本（PCL 的"换个文件夹读版本"） ============ */

/// 当前游戏文件夹里的**一个版本目录**（真读盘；不看账本、不看网络清单）。
///
/// ★★ 2026-09-25（用户给了两张 PCL 截图）：
///   「你看 PCL，就是像换了个文件夹去读游戏版本，可以无缝切换」。
///
///   PCL 的版本列表**就是这个文件夹里的版本**：换文件夹 = 换一份游戏数据，
///   列表跟着变（正常的在上、坏掉的折叠）。IEML 原来列的是**账本里的实例** ——
///   账本住在启动器自己的家里，与文件夹无关，所以"换到 E 盘却还显示 D 盘那几条"。
///   这个命令把"文件夹里到底有什么"如实读出来，界面据此列版本。
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderVersion {
    /// `versions/<这个>`：目录名（PCL 列表里显示的就是它）
    pub dir: String,
    /// 版本 JSON 里声明的 `id`（读不到 JSON 时与 `dir` 相同）
    pub id: String,
    /// 这份版本继承的父版本（加载器版本才有：`fabric-loader-0.19.5-26.2` → `26.2`）
    pub inherits: String,
    /// 实际算出来的 Minecraft 版本（有 `inherits` 用它，否则用 `id`）
    pub mc_version: String,
    /// 加载器目录的判定（**只看命名**：`…-forge-…` / `fabric-loader-…` / `quilt-loader-…`）。
    ///
    /// ★ 为什么不用 `detect_installed_loaders`：那个是按 **MC 版本**汇总的，
    ///   分不清"是哪一份版本目录贡献的" —— 而这里要的正是"这一个目录是不是加载器版本"。
    pub loader_name: Option<String>,
    /// 版本 JSON 在不在（`false` = 这个目录是空的/坏的）
    pub has_json: bool,
}

/// 按目录名认加载器（顺序有意：`neoforge` 里也含 `forge`，必须先判它）。
fn loader_from_dir_name(dir: &str) -> Option<String> {
    let d = dir.to_ascii_lowercase();
    for (needle, name) in [
        ("neoforge", "neoforge"),
        ("forge", "forge"),
        ("fabric", "fabric"),
        ("quilt", "quilt"),
        ("optifine", "optifine"),
        ("liteloader", "liteloader"),
    ] {
        if d.contains(needle) {
            return Some(name.to_string());
        }
    }
    None
}

/// 扫一遍 `<shared>/versions`：**每次都真读盘**（与 `scan_version_dir` 同一条纪律）。
pub fn scan_folder_versions(shared: &std::path::Path) -> Vec<FolderVersion> {
    let versions = shared.join("versions");
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let dir = e.file_name().to_string_lossy().to_string();
        // 版本 JSON：`versions/<dir>/<dir>.json` 优先；找不到就取这个目录里第一个 .json
        let primary = e.path().join(format!("{dir}.json"));
        let json_path = if primary.is_file() {
            Some(primary)
        } else {
            std::fs::read_dir(e.path()).ok().and_then(|it| {
                it.flatten()
                    .map(|f| f.path())
                    .find(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            })
        };
        let text = json_path.and_then(|p| std::fs::read_to_string(p).ok());
        let parsed: Option<VersionJson> = text.as_ref().and_then(|t| serde_json::from_str(t).ok());
        let id = parsed
            .as_ref()
            .map(|v| v.id.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dir.clone());
        let inherits = parsed
            .as_ref()
            .and_then(|v| v.inherits_from.clone())
            .unwrap_or_default();
        let mc_version = if inherits.is_empty() {
            id.clone()
        } else {
            inherits.clone()
        };
        out.push(FolderVersion {
            dir,
            id,
            inherits,
            mc_version,
            loader_name: loader_from_dir_name(&e.file_name().to_string_lossy()),
            has_json: text.is_some(),
        });
    }
    out.sort_by(|a, b| a.dir.to_lowercase().cmp(&b.dir.to_lowercase()));
    out
}

/// 当前游戏文件夹里有哪些版本（界面「版本列表」的数据源）。
#[tauri::command]
pub fn folder_versions(state: State<'_, AppState>) -> Vec<FolderVersion> {
    scan_folder_versions(&state.paths().shared)
}

/// 把用户选的目录**规整成"根目录"**：他要是选了 `.minecraft` 本身，就用它的上一级。
///
/// 返回 `(根目录, 被提级的原路径)` —— 第二个用于在界面上如实说一句。
/// ★ 抽成纯函数是为了能单测（`set_data_root` 带 `State`，测不了）。
pub fn normalize_root_target(raw: &std::path::Path) -> (std::path::PathBuf, Option<String>) {
    match raw.file_name() {
        Some(n) if n.to_string_lossy().eq_ignore_ascii_case(".minecraft") => match raw.parent() {
            Some(p) if !p.as_os_str().is_empty() => {
                (p.to_path_buf(), Some(raw.to_string_lossy().to_string()))
            }
            _ => (raw.to_path_buf(), None),
        },
        _ => (raw.to_path_buf(), None),
    }
}

/// 一个实例的"健康"状况（只读，不改任何东西）。
#[derive(serde::Serialize)]
pub struct InstanceHealth {
    /// 实例 id（前端用它对上条目）
    pub id: String,
    /// 它引用的**版本文件**已经不在了（`versions/<id>/` 找不到）
    pub version_missing: bool,
}

/// 查一遍"哪些实例的版本文件已经不在磁盘上了"。
///
/// ★★ 2026-09-23（用户第 3 条：「资源管理器里删除版本，启动器不会同步删除」）：
///   判据是**版本文件还在不在**，不是"实例目录在不在" ——
///   后者是**懒建**的（`remove_instance` 里就写着"目录本来就不在，不算错误"），
///   拿它当判据会把所有实例都判成已删除（我上一轮就是这么错的，已回退）。
///
/// ★ 这条命令**只读**：不删条目、不改清单。失联的实例由用户自己决定是移除还是修好 ——
///   他可能只是临时把版本目录搬走（换盘 / 备份），自动删条目是在替他做决定。
/// ★ 版本 id 的解析与**启动时同一套**（`resolve_loader_version_id` + `find_version_json`），
///   不在这里另写一份"怎么找版本"的规则 —— 否则会出现
///   "健康检查说没事、一点启动却说找不到版本"。
#[tauri::command]
pub fn instance_health(state: State<'_, AppState>) -> Vec<InstanceHealth> {
    /*
     * ★★ 2026-09-24：与 `instance_usage` 同一个坑 —— 这里原来读的也是
     *   `state.paths().root.join("instances.json")`（A-4 之前的老位置）。
     *   清单现在住在启动器自己的家，读老位置会得到陈旧清单（甚至读不到而
     *   静默返回空 vec，界面上就是"一个失联的版本都没有"）。
     */
    let Some(path) = state.paths().own_file_for_read("instances.json") else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(store) = serde_json::from_str::<crate::commands::InstanceStore>(&text) else {
        return Vec::new();
    };
    let shared = &state.paths().shared;
    store
        .instances
        .into_iter()
        .map(|i| {
            let kind = i.loader.as_ref().map(|l| l.kind.as_str());
            let ver = i.loader.as_ref().map(|l| l.version.as_str());
            let vid = resolve_loader_version_id(shared, &i.mc_version, kind, ver)
                .unwrap_or_else(|| i.mc_version.clone());
            let found = find_version_json(shared, &vid, &i.mc_version, kind).is_some();
            InstanceHealth {
                id: i.id,
                version_missing: !found,
            }
        })
        .collect()
}

/// **删除一个游戏根目录**（连目录一起删）—— 用户在图二那一页要求的能力。
///
/// ## 这不是"从列表移除"，是**真删磁盘**
///
///   所以有四道闸（见函数体），任何一道过不去都直接拒绝并说清原因 ——
///   **危险操作宁可拒绝，也不要"尽力而为"**。
///
/// 返回：删掉的字节数（界面用它说清"释放了多少"）。
#[tauri::command]
pub async fn delete_data_root(path: String, state: State<'_, AppState>) -> Result<u64, String> {
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("要删除的是一个空路径".into());
    }
    if !target.is_absolute() {
        return Err(format!("要一个完整路径，现在是相对路径：{}", target.display()));
    }

    // ① 当前正在用的根目录：**先切走再删**（否则下一次启动就没家了）
    if crate::platform::same_path(&target, &state.paths().root) {
        return Err(
            "这是**现在正在用**的游戏根目录 —— 先在上面选另一个目录切换过去，再删这个。".into(),
        );
    }

    /*
     * ② 启动器自己的数据目录：**不许删目录**。
     *   实例清单、自动下载的 Java、缓存、日志都住在里面 ——
     *   删它等于把用户的实例全删掉。列表里可以从候选里移除，但目录得留着。
     */
    if crate::platform::same_path(&target, &state.paths().own_root) {
        return Err(format!(
            "这是**启动器自己的数据目录**（{}）：实例、Java、缓存、日志都在里面，\n\
             删它会连你的实例一起删掉。想让它不出现在这张列表里，用「移除」就好。",
            state.paths().own_root.display()
        ));
    }

    // ③ 盘符根 / 家目录 / 系统盘根：一次手滑会删掉整块盘
    if crate::platform::is_dangerous_root(&target) {
        return Err(format!(
            "{} 是盘符根目录（或你的用户目录）—— 删它会删掉整块盘里的东西，这里不做。\n\
             如果你确实想清掉它，请到资源管理器里自己操作。",
            target.display()
        ));
    }

    // ④ 必须真的存在、而且是个目录
    let meta = std::fs::symlink_metadata(&target)
        .map_err(|e| format!("读不到这个目录：{e}"))?;
    if !meta.is_dir() {
        return Err(format!("{} 不是一个目录。", target.display()));
    }

    // 删除前**先量一下**（删完就量不到了）—— 这个数字要写进结果里
    let bytes = crate::platform::dir_size(&target);

    tokio::fs::remove_dir_all(&target)
        .await
        .map_err(|e| format!("删不掉 {}：{e}", target.display()))?;

    // 删完把它从"用过的列表"里也去掉（否则会留下一条指向不存在目录的记录）
    crate::platform::forget_root(&target);

    say!(
        "[IEML/paths] 用户删除了游戏根目录 {}（释放 {} 字节）",
        target.display(),
        bytes
    );
    Ok(bytes)
}

/// 忘记一个文件夹（目录已经没了时用户会点"移除"）。
///
/// ★ 只动"用过的列表"，**不碰磁盘上任何东西** —— 移除了还能再选回来。
#[tauri::command]
pub fn forget_data_root(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("要移除的是一个空路径".into());
    }
    crate::platform::forget_root(&p);
    Ok(())
}

/* ====================== 新建游戏根目录 ====================== */

/// 换数据根目录的结果。
///
/// 之所以要把 `previous` 也返回去：界面必须能明确说出
/// **旧目录在哪、它没被动过** —— 否则用户会以为东西被搬走了/删了。
#[derive(serde::Serialize)]
pub struct DataRootChange {
    /// 新的根目录（已建好、已记录）
    pub path: String,
    /// 换之前用的那个（**原样保留，未搬未删**）
    pub previous: String,
    /// 目标在系统盘上 —— 提示，不是错误（默认选址刻意躲开系统盘）
    pub on_system_drive: bool,
    /// 需要重启启动器才生效（`AppPaths` 是启动时解析一次并放进 AppState 的）
    pub restart_required: bool,
    /// 新目录里有没有已经存在的游戏数据（有 = 用户可能选到了老目录）
    pub has_existing_data: bool,
    /// 用户选的是 `.minecraft` 目录本身、被我们**往上提了一级**时，这里是原路径。
    ///
    /// ★★ 2026-09-25（PCL 的「添加已有文件夹」）：PCL 的"文件夹"就是 `.minecraft`，
    ///   而 IEML 的根目录是它的上一级。界面据此说一句"你选的是 .minecraft，
    ///   已按它的上级目录当根目录"，免得用户以为自己选错了。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_from: Option<String>,
}

/// 新建/切换游戏根目录（2026-09-17 用户：「单独建一个根目录，源目录不删」）。
///
/// ★ **不迁移**：新目录是空的，旧的**一个字节都不动**。语义与理由见
///   `platform::set_data_root` 的文档注释。
///
/// ★★ 2026-09-25（用户：「我不想要重启才生效，切换游戏数据应该是实时的」）：
///   以前这里只**记录**选择、返回 `restart_required: true`（`AppPaths` 在启动时定死）。
///   现在 `AppState` 里的路径是**可整体替换的句柄**（`RwLock<Arc<AppPaths>>`），
///   所以校验 + 落盘之后**当场换掉**：此后所有命令（版本扫描、启动、装 Mod、
///   打开目录…）读到的都是新根目录，**同一个进程、不重启**。
///   ★ 正在跑的游戏不受影响：它的工作目录与日志都在已经打开的句柄/`own_root` 里，
///     换根目录不会去动它们（停止、退出、日志照旧）。
#[tauri::command]
pub async fn set_data_root(
    path: String,
    state: State<'_, AppState>,
) -> Result<DataRootChange, String> {
    let raw = std::path::PathBuf::from(path.trim());
    /*
     * ★★ 2026-09-25（用户给的 PCL 截图里那一栏叫「添加已有文件夹」）：
     *
     *   PCL 的"文件夹"就是 **`.minecraft` 目录本身**（截图里写的是
     *   `D:\Minecraft\.minecraft\`），而 IEML 的根目录是**它的上一级**
     *   （根里放 `.minecraft` 与 `instances`）。
     *
     *   所以用户从资源管理器里直接选 `.minecraft` 时不能照字面用 ——
     *   否则会在 `D:\Minecraft\.minecraft\` 下面**再建一层** `.minecraft`，
     *   那个文件夹里永远读不到版本（这正是"添加已有文件夹"最容易踩空的地方）。
     *   规整逻辑是纯函数 `normalize_root_target`，有单测。
     */
    let (target, normalized_from) = normalize_root_target(&raw);
    let current = state.paths();
    let previous = current.root.clone();

    // 它的错误本来就是给用户看的中文 String，直接透传（不再过 `err` 那层转换）
    crate::platform::set_data_root(&target, &previous)?;

    /*
     * ★ 换成功就**记进"用过的文件夹"列表**（PCL 那张「文件夹列表」就是这么攒出来的）：
     *   换过去、又换回来，是这类功能最常见的用法 —— 列表里没有它，
     *   用户就得再去系统对话框里翻一遍。
     */
    crate::platform::remember_root(&target);

    /*
     * ★★ 实时切换本体：
     *   ① 先把新根目录建出来（游戏那一边 `.minecraft` + `instances`，
     *      启动器那一边 java/cache/logs）—— 建不出来只是记一条日志，不拦切换；
     *   ② 再换句柄 —— 这一步之后所有命令读到的都是新根目录；
     *   ③ `own_root` 不变（账本 / Java / 缓存 / 日志仍住在启动器自己的家里），
     *      所以切换不需要搬任何启动器数据。
     */
    let next = crate::platform::AppPaths::from_root(target.clone());
    if let Err(e) = next.ensure().and_then(|_| next.ensure_own()) {
        say!("[IEML/paths] 新根目录建目录失败（不影响切换）：{e}");
    }
    state.set_paths(next.clone());
    say!(
        "[IEML/paths] 已实时切换到 {}（同一个进程，无需重启）",
        next.root.display()
    );

    // 目标里是不是已经有游戏数据 —— 有的话用户可能选到了某个老目录，
    // 值得在界面上说一句（不是错误：他可能就是要用那份）
    let has_existing_data = target.join("instances.json").is_file()
        || target.join(".minecraft").is_dir()
        || target.join("versions").is_dir();

    Ok(DataRootChange {
        path: target.to_string_lossy().to_string(),
        previous: previous.to_string_lossy().to_string(),
        on_system_drive: crate::platform::is_on_system_drive(&target),
        restart_required: false,
        has_existing_data,
        normalized_from,
    })
}

/* ====================== 校验文件完整性 ====================== */

#[derive(serde::Serialize)]
pub struct VerifyReport {
    pub checked: usize,
    pub missing: Vec<String>,
    pub missing_count: usize,
}

/// 校验已安装版本的文件完整性（缺哪些、坏哪些）
#[tauri::command]
pub async fn verify_version(
    mc_version: String,
    slugs: Vec<String>,
    state: State<'_, AppState>,
) -> Result<VerifyReport, String> {
    let shared = &state.paths().shared;
    let json_path = shared
        .join("versions")
        .join(&mc_version)
        .join(format!("{mc_version}.json"));
    if !json_path.is_file() {
        return Err(format!("找不到版本文件：{}", json_path.display()));
    }
    let version: VersionJson = serde_json::from_str(
        &std::fs::read_to_string(&json_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("版本文件损坏：{e}"))?;

    let mut checked = 0usize;
    let mut missing = Vec::new();

    // 客户端 jar
    let jar = shared
        .join("versions")
        .join(&mc_version)
        .join(format!("{mc_version}.jar"));
    checked += 1;
    if !jar.is_file() {
        missing.push(format!("客户端 {mc_version}.jar"));
    }

    // 库
    for lib in &version.libraries {
        if !metadata::rules_allow(&lib.rules, &HashMap::new()) {
            continue;
        }
        let Some(rel) = lib
            .downloads
            .as_ref()
            .and_then(|d| d.artifact.as_ref())
            .and_then(|a| a.path.clone().or_else(|| metadata::maven_path(&lib.name)))
        else {
            continue;
        };
        checked += 1;
        if !shared.join("libraries").join(&rel).is_file() {
            missing.push(format!("库 {}", lib.name));
        }
    }

    /*
     * natives 是否解压 —— ★ 审计发现这里会**误报**，必须改。
     *
     *   安装阶段**故意**不解压 natives（见 installer::install 的说明：
     *   解压必须跟着实例目录走，而安装命令不知道实例 slug）。
     *   解压只发生在**启动时**（prepare_spec）。
     *
     *   所以"刚装完、还没启动过"的实例，`natives/` 目录本来就是空的 ——
     *   老代码据此报「实例 X 的本地库未解压」，用户看到一条**假警报**，
     *   而这恰恰是本文件别处反复强调"宁可不报也不能报错"的那类错误。
     *
     *   现在的判据：**只有启动过（存在 natives 目录）却内容不全**才算问题；
     *   从来没启动过就不提这一项（启动时会自动解压）。
     */
    for slug in &slugs {
        let nd = state.paths().instance_dir(slug).join("natives");
        if !nd.is_dir() {
            continue; // 还没启动过 → 启动时自动解压，不是问题
        }
        checked += 1;
        if !crate::game::launch_args::natives_ready(&nd) {
            missing.push(format!(
                "实例 {slug} 的本地库解压不完整（启动一次会自动重新解压，也可以先手动启动一次）"
            ));
        }
    }

    Ok(VerifyReport {
        checked,
        missing_count: missing.len(),
        missing,
    })
}

/* ====================== 账号 ====================== */

#[tauri::command]
pub fn account_offline(username: String) -> McAccount {
    auth::offline_account(&username)
}

#[derive(serde::Serialize)]
pub struct DeviceCodeReply {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

/// ★★ 正版登录的**可用性状态**（设置页据此如实显示，而不是让用户白试一次）。
///
/// 背景：实测发现老代码写死的 client_id（`00000000402b5328`）已被微软删除，
/// 直接打接口得到 `AADSTS700016` —— 也就是说正版登录**从来没有成功过**。
/// 现在 client_id 由用户提供，所以界面必须能回答"现在能不能用、为什么不能"。
#[derive(serde::Serialize)]
pub struct MsLoginStatus {
    /// 现在能不能发起正版登录
    pub available: bool,
    /// 当前生效的 client_id（**只回显前 8 位**，其余打码 —— 它不是密码，
    /// 但也没必要整个显示在界面上）
    pub client_id_preview: Option<String>,
    /// ★ 这把 id **从哪来**：`settings`（用户自己填）/ `env`（环境变量）/
    ///   `builtin`（随程序附带）/ `none`。
    ///
    ///   为什么必须给：用户在微软授权页看到的名字是**这个 ID 所属应用**的名字。
    ///   实测（2026-09-15）：内置的是 Prism Launcher 的公开 id，
    ///   授权页就写着「大功告成！你现在已登录到 Prism Launcher」。
    ///   界面得说清"现在用的是哪一把、是谁的"，否则用户只会觉得莫名其妙。
    pub source: String,
    /// `available = false` 时，这句话是给用户看的完整说明（含怎么申请）
    pub reason: Option<String>,
    /// 说明正版登录与离线模式的关系（界面要写清楚"不登也能玩"）
    pub offline_note: String,
}

#[tauri::command]
pub fn ms_login_status() -> MsLoginStatus {
    let resolved = auth::client_id_with_source();
    let cid = resolved.as_ref().map(|(id, _)| id.clone());
    MsLoginStatus {
        available: cid.is_some(),
        client_id_preview: cid.as_ref().map(|s| {
            if s.len() > 10 {
                format!("{}…{}", &s[..8], &s[s.len() - 2..])
            } else {
                format!("{s}…")
            }
        }),
        source: resolved
            .as_ref()
            .map(|(_, src)| (*src).to_string())
            .unwrap_or_else(|| "none".to_string()),
        reason: if cid.is_none() {
            Some(auth::missing_client_id_message())
        } else {
            None
        },
        offline_note: "不想折腾的话用离线模式就行 —— 单机、局域网联机都不受影响，\
                       只是进不了正版验证的服务器。"
            .into(),
    }
}

/// 保存正版登录用的 client_id（设置页调用）。
#[tauri::command]
pub fn ms_set_client_id(
    client_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    auth::save_client_id(&state.paths(), &client_id).map_err(err_auth)
}

/// 第一步：申请设备代码，前端把它展示给用户
#[tauri::command]
pub async fn account_start_login() -> Result<DeviceCodeReply, String> {
    let info = auth::request_device_code().await.map_err(err_auth)?;
    Ok(DeviceCodeReply {
        user_code: info.user_code,
        verification_uri: info.verification_uri,
        device_code: info.device_code,
        expires_in: info.expires_in,
        interval: info.interval,
        message: info.message,
    })
}

/// 第二步：轮询等待用户在浏览器完成授权
#[tauri::command]
pub async fn account_poll_login(
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<McAccount, String> {
    auth::poll_for_token(&device_code, interval, expires_in)
        .await
        .map_err(err_auth)
}

#[tauri::command]
pub fn account_load(uuid: String) -> Result<McAccount, String> {
    auth::load_account(&uuid).map_err(err_auth)
}

#[tauri::command]
pub fn account_current() -> Option<String> {
    auth::current_account_uuid()
}

#[tauri::command]
pub fn account_remove(uuid: String) -> Result<(), String> {
    auth::remove_account(&uuid).map_err(err_auth)
}

/// 正版账号的皮肤（照 PCL 的做法走 Mojang 官方，不经过第三方头像站）。
///
/// ★ 为什么必须走**后端**而不是前端直接 `<img src="mc-heads...">`：
///   ① `sessionserver.mojang.com` 不保证跨域，前端 fetch 拿不到；
///   ② 第三方头像站实测会回 403（`<img>` 静默失败，界面上什么都不显示）；
///   ③ 顺带能拿到**权威玩家名**与披风。
///   详见 `auth::fetch_skin` 的注释。
#[tauri::command]
pub async fn account_skin(uuid: String) -> Result<auth::SkinInfo, String> {
    auth::fetch_skin(&uuid).await.map_err(err_auth)
}

/* ====================== 改皮肤 / 改披风 / 存皮肤（2026-09-22） ======================
 *
 * 全是用户那张账号菜单要的：修改皮肤 / 修改披风 / 保存皮肤文件 / 刷新披风列表。
 * 实现在 `auth` 里（见那边关于"令牌过期就静默续期"的说明），
 * 这里只做**参数校验 + 错误翻译**。
 */

/// 上传皮肤。`variant`：classic / slim；`path` 是本地 PNG 的绝对路径。
#[tauri::command]
pub async fn account_upload_skin(
    uuid: String,
    path: String,
    variant: Option<String>,
) -> Result<auth::SkinEntry, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到这个文件：{e}"))?;
    /*
     * 只挡"明显不是 PNG"的：真正的尺寸校验交给 Mojang（见 auth::upload_skin 的注释）。
     * ★ 用**文件头签名**而不是扩展名 —— 用户可能把 jpg 改名成 png。
     */
    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 8 || bytes[..8] != PNG_SIG {
        return Err("这个文件不是 PNG。皮肤必须是 PNG 图片（64×64，或旧版 64×32）。".into());
    }
    auth::upload_skin(&uuid, bytes, variant.as_deref().unwrap_or("classic"))
        .await
        .map_err(err_auth)
}

/// 拥有的披风列表
#[tauri::command]
pub async fn account_capes(uuid: String) -> Result<Vec<auth::CapeEntry>, String> {
    auth::list_capes(&uuid).await.map_err(err_auth)
}

/// 换披风（`cape_id` 传空 = 不显示披风）
#[tauri::command]
pub async fn account_set_cape(uuid: String, cape_id: Option<String>) -> Result<(), String> {
    let id = cape_id.as_deref().filter(|s| !s.trim().is_empty());
    auth::set_active_cape(&uuid, id).await.map_err(err_auth)
}

/// 把当前皮肤存成文件。`dest` 是完整目标路径（前端负责选目录）。
#[tauri::command]
pub async fn account_save_skin(skin_url: String, dest: String) -> Result<u64, String> {
    if skin_url.trim().is_empty() {
        return Err("这个账号现在没有皮肤可保存（用的是默认皮肤）".into());
    }
    auth::save_skin_png(&skin_url, std::path::Path::new(&dest))
        .await
        .map_err(err_auth)
}


#[tauri::command]
pub async fn account_refresh(refresh_token: String) -> Result<McAccount, String> {
    auth::refresh_msa(&refresh_token).await.map_err(err_auth)
}

/* ====================== 整合包 ====================== */

#[derive(serde::Serialize)]
pub struct MrpackInfo {
    pub name: String,
    pub version_id: String,
    pub summary: Option<String>,
    /// 清单里写死的 MC 版本（`dependencies.minecraft`）
    pub mc_version: Option<String>,
    pub loader_kind: Option<String>,
    pub loader_version: Option<String>,
    pub file_count: usize,
    pub client_file_count: usize,
    /// 客户端文件总字节数（用来告诉用户"要下多少"）
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn mrpack_inspect(url: String) -> Result<MrpackInfo, String> {
    let idx = modrinth::fetch_mrpack_index(&url).await.map_err(err)?;
    let client_files = idx
        .files
        .iter()
        .filter(|f| modrinth::MrpackIndex::is_client_relevant(f))
        .count();
    Ok(MrpackInfo {
        name: idx.name.clone(),
        version_id: idx.version_id.clone(),
        summary: idx.summary.clone(),
        mc_version: idx.mc_version().map(|s| s.to_string()),
        loader_kind: idx.loader().map(|(k, _)| k.to_string()),
        loader_version: idx.loader().map(|(_, v)| v.to_string()),
        file_count: idx.files.len(),
        client_file_count: client_files,
        total_bytes: idx
            .files
            .iter()
            .filter(|f| modrinth::MrpackIndex::is_client_relevant(f))
            .map(|f| f.file_size)
            .sum(),
    })
}

/// ★★ 真正安装一个整合包 ★★
///
/// 以前这里只做到 `mrpack_inspect`（读清单、报个数），界面上写着
/// "按清单逐个下载并覆盖文件这一步即将接通" —— 也就是**做了一半的功能**。
/// 现在补齐整条链：
///
///   ① 读 `modrinth.index.json` → 游戏版本 + 加载器（由包的作者定死）
///   ② 装游戏本体 + 加载器（复用 `install_version` 那条已经验证过的路）
///   ③ 按清单逐个下载 Mod / 资源包到 `instances/{slug}/game/`（带 SHA1 校验）
///   ④ 解压包里的 `overrides/`（作者的配置、存档、光影配置都在这）
///
/// 进度全部通过 `modpack-progress` 事件上报（阶段 + 文件计数 + 字节数），
/// 所以任务中心里能看到"在下第 37/120 个文件"这种真实进度。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn modpack_install(
    url: String,
    name: String,
    slug: String,
    task_id: String,
    instance_name: String,
    source: String,
    concurrency: Option<usize>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ModpackInstallResult, String> {
    let src = parse_source(&source);
    let cancel = register_task(&task_id);
    // ★ 整合包安装同样可暂停
    let pause = register_pause(&task_id);
    let app2 = app.clone();
    let tid = task_id.clone();
    let emit = move |stage: &str, done: usize, total: usize, bytes: u64, current: &str| {
        let _ = app2.emit(
            "modpack-progress",
            serde_json::json!({
                "taskId": tid,
                "stage": stage,
                "finishedFiles": done,
                "totalFiles": total,
                "bytes": bytes,
                "currentFile": current,
                "percent": if total > 0 { done * 100 / total } else { 0 },
            }),
        );
    };

    // ---------- ① 读清单 ----------
    emit("读取整合包清单", 0, 1, 0, &name);
    let downloaded = download::DownloadTask::new(
        state.paths().cache.join(format!("mrpack-{task_id}.mrpack")),
        url.clone(),
        String::new(),
        0,
        format!("整合包 {name}"),
    );
    download::download_one(&downloaded, src, &cancel)
        .await
        .map_err(err)?;
    let bytes = tokio::fs::read(&downloaded.path)
        .await
        .map_err(|e| format!("读取整合包失败：{e}"))?;

    let idx = modrinth::parse_mrpack_bytes(&bytes).map_err(err)?;
    let mc_version = idx
        .mc_version()
        .ok_or_else(|| "这个整合包的清单里没写游戏版本（minecraft 依赖）".to_string())?
        .to_string();
    let (loader_kind, loader_version) = match idx.loader() {
        Some((k, v)) => {
            // `fabric-loader` → `fabric`（我们内部的 kind 名）
            let kind = k.trim_end_matches("-loader").to_string();
            (Some(kind), Some(v.to_string()))
        }
        None => (None, None),
    };

    // ---------- ② 装游戏本体 + 加载器 ----------
    emit("安装游戏本体与加载器", 0, 1, 0, &mc_version);
    let plan_input = build_plan_input(
        &mc_version,
        loader_kind.as_deref(),
        loader_version.as_deref(),
        src,
        &state,
        &state.paths().instance_dir(&slug),
    )
    .await?;

    let app3 = app.clone();
    let tid3 = task_id.clone();
    let installed = installer::install(
        &plan_input,
        installer::InstallOptions {
            concurrency: concurrency.unwrap_or(64).clamp(4, 128),
            download_assets: true,
            asset_limit: None,
            cancel: cancel.clone(),
            // ★ 整合包安装同样可暂停（进度上报走 modpack-progress）
            pause: Some(pause.clone()),
            on_progress: Arc::new(move |stage: String, p: DownloadProgress| {
                let _ = app3.emit(
                    "modpack-progress",
                    serde_json::json!({
                        "taskId": tid3,
                        "stage": stage,
                        "finishedFiles": p.finished_files,
                        "totalFiles": p.total_files,
                        "bytes": p.finished_bytes,
                        "currentFile": p.current_file,
                        "percent": if p.total_files > 0 { p.finished_files * 100 / p.total_files } else { 0 },
                    }),
                );
            }),
        },
    )
    .await
    .map_err(err)?;

    /*
     * ★★ 整合包路径同样**暂停即停**（P0-3）。
     *
     *   以前暂停只停住了下载引擎，这条函数照样往下走：跑 Forge 安装器、
     *   下上百个 Mod、解压 overrides，最后报"整合包安装完成"。
     *   现在在这里就返回，并把 `paused` 交给界面。
     */
    if installed.paused {
        drop_task(&task_id);
        let _ = tokio::fs::remove_file(&downloaded.path).await;
        say!(
            "[IEML/modpack] 整合包安装被暂停：还剩 {} 个文件没下",
            installed.remaining_files
        );
        return Ok(ModpackInstallResult {
            mc_version: mc_version.clone(),
            loader_kind,
            loader_version,
            mod_files: 0,
            override_files: 0,
            total_bytes: installed.total_bytes,
            instance_name,
            api_library: None,
            paused: true,
            remaining_files: installed.remaining_files,
            paused_stage: installed.paused_stage.clone(),
        });
    }

    // Forge / NeoForge 还要跑官方安装器（和 install_version 一致）
    if let Some(kind) = loader_kind.as_deref() {
        if kind == "forge" || kind == "neoforge" {
            /*
             * ★ 与 `install_version` 同一条规矩：外部安装器**开始之前**看暂停，
             *   已暂停就不启动它（见那边的说明）。
             */
            if pause.is_paused() {
                drop_task(&task_id);
                let _ = tokio::fs::remove_file(&downloaded.path).await;
                let stage = format!("运行 {kind} 安装器");
                say!("[IEML/modpack] 用户已暂停，跳过 {kind} 安装器那一步");
                return Ok(ModpackInstallResult {
                    mc_version: mc_version.clone(),
                    loader_kind: loader_kind.clone(),
                    loader_version: loader_version.clone(),
                    mod_files: 0,
                    override_files: 0,
                    total_bytes: installed.total_bytes,
                    instance_name,
                    api_library: None,
                    paused: true,
                    remaining_files: 0,
                    paused_stage: Some(stage),
                });
            }
            let ver = loader_version.clone().unwrap_or_default();
            if ver.is_empty() {
                drop_task(&task_id);
                return Err(format!("{kind} 需要指定版本号"));
            }
            let progress = |msg: String| {
                let _ = app.emit(
                    "modpack-progress",
                    serde_json::json!({
                        "taskId": task_id,
                        "stage": msg,
                        "finishedFiles": 0,
                        "totalFiles": 0,
                        "bytes": 0,
                        "currentFile": "",
                        "percent": 100,
                    }),
                );
            };
            run_loader_installer(&mc_version, kind, &ver, src, &state, &cancel, &progress).await?;
        }
    }

    // ---------- ③ 按清单下载 Mod / 资源包 ----------
    let game_dir = state.paths().instance_game_dir(&slug);
    let (tasks, unsafe_paths) = modrinth::mrpack_download_tasks(&idx, &game_dir);
    /*
     * ★★ 清单里指到游戏目录**外面**的路径必须**说出来**，不许静默丢掉。
     *
     *   它们是整合包作者写的字符串（`../..`、绝对路径、盘符），
     *   我们拒绝写出去，但用户有权知道"这个包要求往别处写东西、我没照做" ——
     *   否则他只会看到"装完了但少了几个文件"。
     */
    if !unsafe_paths.is_empty() {
        let sample: Vec<String> = unsafe_paths.iter().take(3).cloned().collect();
        say!(
            "[IEML/modpack] 清单里有 {} 条路径指向游戏目录之外，已拒绝：{}",
            unsafe_paths.len(),
            sample.join("、")
        );
        let _ = app.emit(
            "modpack-progress",
            serde_json::json!({
                "taskId": task_id,
                "stage": format!(
                    "清单里有 {} 条路径指向游戏目录之外，已跳过\
                     （这多半不是你的问题，是包本身写坏了）",
                    unsafe_paths.len()
                ),
                "finishedFiles": 0,
                "totalFiles": unsafe_paths.len(),
                "bytes": 0,
                "currentFile": sample.join("、"),
                "percent": 0,
            }),
        );
    }    let total_files = tasks.len();
    let total_bytes: u64 = tasks.iter().map(|t| t.size).sum();
    emit(
        "下载整合包文件",
        0,
        total_files,
        total_bytes,
        "准备中",
    );

    let outcome = download::download_batch(
        tasks,
        download::BatchOptions {
            concurrency: concurrency.unwrap_or(64).clamp(4, 128),
            source: src,
            cancel: cancel.clone(),
            // ★ 这一批（整合包的额外文件）同样可暂停
            pause: Some(pause.clone()),
            on_progress: {
                let app4 = app.clone();
                let tid4 = task_id.clone();
                Arc::new(move |p: DownloadProgress| {
                    let _ = app4.emit(
                        "modpack-progress",
                        serde_json::json!({
                            "taskId": tid4,
                            "stage": "下载整合包文件",
                            "finishedFiles": p.finished_files,
                            "totalFiles": p.total_files,
                            "bytes": p.finished_bytes,
                            "currentFile": p.current_file,
                            "percent": if p.total_files > 0 { p.finished_files * 100 / p.total_files } else { 0 },
                            "failedFiles": p.failed_files,
                        }),
                    );
                })
            },
        },
    )
    .await
    .map_err(err)?;

    if !outcome.failed.is_empty() {
        let sample: Vec<String> = outcome
            .failed
            .iter()
            .take(3)
            .map(|(n, e)| format!("{n}：{e}"))
            .collect();
        drop_task(&task_id);
        return Err(format!(
            "整合包有 {} 个文件下载失败（重试 {} 轮后仍失败）：{}",
            outcome.failed.len(),
            outcome.retry_rounds,
            sample.join("；")
        ));
    }

    // ---------- ④ 解压 overrides ----------
    emit("解压整合包配置", 0, 1, 0, "overrides/");
    let mut override_files = 0usize;
    match modrinth::extract_overrides(&bytes, &game_dir) {
        Ok(n) => override_files = n,
        Err(e) => {
            // overrides 里是作者的配置，缺了游戏仍能起（只是少了他的设置）——
            // 如实报告但不阻断，用户至少能玩。
            say!("[IEML/modpack] overrides 解压失败：{e}");
        }
    }

    let _ = tokio::fs::remove_file(&downloaded.path).await;

    // ---------- ⑤ Fabric API 前置包（只在作者没带的时候补） ----------
    //
    // ★ 为什么整合包路径也要做这件事：装完 1.20.1 Fabric 整合包，
    //   进游戏第一眼就是 "Missing or unsupported fabric-api"，
    //   而普通安装路径（InstallComposer）已经会自动装 —— 两条路必须一致，
    //   不能"手动装的有、装整合包的没有"（ADR-041：界面/行为一致性）。
    //
    // ★ 作者带了就**绝不动**：他指定的版本是配着他那堆 Mod 的，
    //   我们换个更新的 API 版本反而可能把包搞坏。`has_fabric_api` 就是问这个。
    let mut note: Option<String> = None;
    if let Some(kind) = loader_kind.as_deref() {
        if kind == "fabric" || kind == "quilt" {
            if idx.has_fabric_api() {
                note = Some(format!(
                    "整合包自带 Fabric API（{}），没有重复安装。",
                    if kind == "quilt" { "Quilted Fabric API" } else { "Fabric API" }
                ));
            } else {
                emit("安装 API 前置包", 0, 1, 0, kind);
                match install_api_library_for(
                    &state.paths().instance_mods_dir(&slug),
                    &mc_version,
                    kind,
                    src,
                )
                .await
                {
                    Ok(lib) if lib.installed => {
                        note = Some(format!(
                            "整合包清单里没有 API 前置包，已自动补上 {} {}。",
                            lib.project,
                            lib.version.clone().unwrap_or_default()
                        ));
                    }
                    // ★ 补不上不算安装失败：游戏本体已经好了，如实说明就行
                    Ok(lib) => {
                        note = Some(lib.note.unwrap_or_else(|| {
                            format!("{} 没能自动安装", lib.project)
                        }));
                    }
                    Err(e) => {
                        say!("[IEML/modpack] API 前置包安装失败：{e}");
                        note = Some(format!(
                            "整合包里没有 API 前置包，自动补装也失败了（{e}）—— \
                             进游戏若提示缺少前置，请手动去 Modrinth 下载。"
                        ));
                    }
                }
            }
        }
    }

    drop_task(&task_id);
    emit("完成", total_files, total_files, total_bytes, "");

    Ok(ModpackInstallResult {
        mc_version: mc_version.clone(),
        loader_kind,
        loader_version,
        mod_files: total_files,
        override_files,
        total_bytes: installed.total_bytes + total_bytes,
        instance_name,
        api_library: note,
        paused: false,
        remaining_files: 0,
        paused_stage: None,
    })
}

/// ★★ 加载器 → API 前置包的 Modrinth slug 映射（**唯一来源**）★★
///
/// ## 为什么这一句必须联网验证（`tests/live_apilib.rs`）
///
/// 抄错 slug 不会编译错、也不会报错 —— Modrinth 只会回 **404**，
/// 而 404 在我们的代码里被当成"网络不好"重试，最后变成一句
/// "自动安装失败"，用户看到的就是"Quilt 整合包永远缺前置包"。
///
/// 实测（2026-09-13）：`quilted-fabric-api` 是 **404**，
/// 真正的 slug 是 **`qsl`**（Quilted Fabric API / Quilt Standard Libraries，
/// project id `qvIfYCYJ`）。原表里的名字是照着"包名"猜的，猜错了。
///
/// 返回 `(Modrinth slug, 我们内部的 kind 名)`。
pub fn api_library_project(base: &str) -> Result<(&'static str, &'static str), String> {
    match base {
        "fabric" => Ok(("fabric-api", "fabric-api")),
        "quilt" => Ok(("qsl", "quilted-fabric-api")),
        other => Err(format!(
            "{other} 不需要 API 前置包（只有 Fabric / Quilt 需要）"
        )),
    }
}

/// 与 `install_api_library` 同一份逻辑，但**直接调用**而不是绕一趟 IPC。
///
/// ★ 为什么不复用那个 `#[tauri::command]`：它的 `State<'_, AppState>` 是
///   Tauri 注入的，在普通函数里拿不到（必须从 `app_handle.state()` 借，
///   而那个 `State` 的生命周期绑在 `AppHandle` 上，在异步函数里很难活得够久）。
///   所以把"查版本 + 下载"抽成这个不依赖 Tauri 的函数，命令只是它的薄壳 ——
///   **规则只有一份**（ADR-001）。
///
/// 参数是 `mods_dir` 而不是 `slug` + `State`：这样它连"实例"这个概念都不需要，
/// 于是**能被集成测试直接调用**（`tests/live_apilib.rs` 联网跑一次，
/// 验证真的下到了正确文件名 —— 这条链以前只在 UI 上"看起来有"）。
pub async fn install_api_library_for(
    mods_dir: &std::path::Path,
    mc_version: &str,
    base: &str,
    src: crate::net::mirror::Source,
) -> Result<ApiLibInstall, String> {
    let (project, our_kind) = api_library_project(base)?;
    let versions = modrinth::project_versions(project, Some(mc_version), Some(base))
        .await
        .map_err(err)?;
    /*
     * ★★ 不拿"列表第一个"，而是**挑一个默认推荐版**。
     *
     *   用户的要求：「Fabric 的 API 也是有版本的，如果玩家不自己选，
     *   那就走默认推荐」。
     *
     *   Modrinth 返回的列表顺序既不是"最新正式版"也不是"最稳的" ——
     *   里面混着 beta / alpha（Fabric API 大量发 beta），
     *   同一个 MC 版本还可能有好几条构建。直接 `first()` 等于让
     *   Modrinth 的返回顺序决定玩家装到什么。
     *
     *   `pick_default_version` 的挑法：正式版 > beta > alpha，
     *   同级按下载量降序（该项目的社区事实推荐）。
     */
    let Some(v) = modrinth::pick_default_version(&versions) else {
        return Ok(ApiLibInstall {
            kind: our_kind.to_string(),
            project: project.to_string(),
            installed: false,
            version: None,
            filename: None,
            path: None,
            note: Some(format!(
                "Modrinth 上 {project} 没有标注支持 {mc_version}（+ {base}）的版本"
            )),
        });
    };
    // 挑中的这条是不是最稳的那一档？不是的话要**如实说**
    let picked_note = if v.version_type == "release" {
        None
    } else {
        Some(format!(
            "挑中的是{}（{}）—— Modrinth 上 {project} 对 {mc_version} 没有正式版，\
             这是现有版本里最稳的一档",
            v.version_number,
            if v.version_type == "beta" {
                "测试版"
            } else {
                v.version_type.as_str()
            },
        ))
    };
    let Some(file) = v.files.iter().find(|f| f.primary).or_else(|| v.files.first()) else {
        return Ok(ApiLibInstall {
            kind: our_kind.to_string(),
            project: project.to_string(),
            installed: false,
            version: Some(v.version_number.clone()),
            filename: None,
            path: None,
            note: Some(format!("{project} {} 没有可下载文件", v.version_number)),
        });
    };
    std::fs::create_dir_all(mods_dir).map_err(|e| format!("创建 mods 目录失败：{e}"))?;
    let dest = mods_dir.join(&file.filename);
    let task = download::DownloadTask::new(
        dest.clone(),
        file.url.clone(),
        file.hashes.get("sha1").cloned().unwrap_or_default(),
        file.size,
        format!("API 前置包 {project}"),
    );
    let cancel = CancelToken::new();
    download::download_one(&task, src, &cancel)
        .await
        .map_err(err)?;
    Ok(ApiLibInstall {
        kind: our_kind.to_string(),
        project: project.to_string(),
        installed: true,
        version: Some(v.version_number.clone()),
        filename: Some(file.filename.clone()),
        path: Some(dest.to_string_lossy().to_string()),
        note: picked_note,
    })
}

/// ★★ NeoForge 安装器地址：**优先用服务端给的 `installerPath`**。
///
/// ## 为什么不能自己拼坐标（用户会直接撞上的坑）
///
/// NeoForge 在 1.20.1 段发布在 **`net/neoforged/forge`** 名下，
/// 1.20.4 之后才改成 `net/neoforged/neoforge`（PCL2 的写法见
/// `ModDownload.vb:831`：`If(Inherit = "1.20.1", "forge", "neoforge")`）。
/// 我们原来一律拼 `neoforge` —— 于是 1.20.1 上点 NeoForge 会 404，
/// 界面只说"安装失败"，用户完全不知道为什么。
///
/// 实测（2026-09-13）BMCLAPI 的 `/neoforge/list/1.20.1` 每条记录自带
/// `installerPath`：
///   `/maven/net/neoforged/forge/1.20.1-47.1.105/forge-1.20.1-47.1.105-installer.jar`
/// —— 服务端知道自己的坐标，**别猜**。
///
/// 兜底顺序：
///   ① 列表里能找到这一条且带 `installerPath` → 用它（最可靠）；
///   ② 找不到（网络失败 / 版本对不上）→ 退回按老规则拼，
///      并按版本号判断该用 `forge` 还是 `neoforge`（1.21 之前一律 `forge`）。
async fn neoforge_installer_url_for(mc_version: &str, version: &str, source: Source) -> String {
    // ① 服务端给的路径
    if let Ok(list) = metadata::neoforge_builds_for_mc(mc_version).await {
        if let Some(b) = list
            .iter()
            .find(|b| b.normalized_version(mc_version) == version)
        {
            if let Some(u) = b.installer_url() {
                say!("[IEML/loader] NeoForge {mc_version}-{version} 用服务端给的安装器路径");
                return u;
            }
        } else {
            say!(
                "[IEML/loader] NeoForge 列表里没有 {mc_version}-{version}（共 {} 条），按规则拼地址",
                list.len()
            );
        }
    }
    // ② 兜底：按 MC 版本段判断包名（1.20.2 及以前是 `forge` 坐标）
    mirror::neoforge_installer_url_with_mc(mc_version, version, source)
}

#[derive(serde::Serialize)]
pub struct ModpackInstallResult {
    pub mc_version: String,
    pub loader_kind: Option<String>,
    pub loader_version: Option<String>,
    /// 按清单下载的文件数
    pub mod_files: usize,
    /// 解压出来的 overrides 文件数
    pub override_files: usize,
    pub total_bytes: u64,
    pub instance_name: String,
    /// ★ API 前置包那一步的结果（没做或不适用时为 None）。
    ///   **不是错误**：游戏本体已经装好了，这里只是如实交代补装情况。
    pub api_library: Option<String>,
    /// ★★ 这次安装**被暂停**停下了（`mod_files` / `override_files` 于是
    ///   反映的是"还没做"，不是"做完了是 0"）。前端据此显示「已暂停」。
    pub paused: bool,
    /// 暂停时还没下的文件数
    pub remaining_files: usize,
    /// 暂停发生在哪一步（`paused = true` 时才有值）
    pub paused_stage: Option<String>,
}

/* ====================== 工具 ====================== */

fn err(e: NetError) -> String {
    e.to_string()
}

/// 账号相关的错误单独映射 —— AuthError 的文案已经面向用户了
/// （例如"这个微软账号还没有创建 Xbox 档案，请先去 xbox.com 登录一次"）
fn err_auth(e: auth::AuthError) -> String {
    e.to_string()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 供前端查询后端能力（决定显示哪些按钮）
#[tauri::command]
pub fn backend_capabilities() -> serde_json::Value {
    serde_json::json!({
        "realMetadata": true,
        "realDownload": true,
        "realLaunch": true,
        "msaLogin": true,
        "keyring": true,
        "modrinth": true,
        "curseforge": false,
        "sources": ["mojang", "bmclapi"],
        "note": "CurseForge 需要 API Key，本机未配置"
    })
}

/// 下载源状态：每个源的成功/失败、限流次数、实测速度、冷却剩余秒数。
///
/// 对应 PCL2 的 `DlSourceLoader` —— 用户能看见"为什么这次慢"：
/// 是被限流了（冷却中）、还是源本身慢（速度低）、还是刚失败过（成功率低）。
///
/// ★ 这里**手工拼 camelCase**，不直接 `json!({ "sources": manager.snapshot() })`。
///   原因：`SourceReport` 的字段是 snake_case（`rate_limited` / `bytes_per_second`
///   / `cooling_seconds`），而前端 `DownloadSourceReport` 读的是 camelCase ——
///   直接透传会让那三个值全是 `undefined`，设置页显示成空白
///   （这类跨 IPC 字段名不一致的 bug 编译器抓不到，见 ADR-036）。
#[tauri::command]
pub fn download_sources() -> serde_json::Value {
    download_sources_payload()
}

/// 真正的实现（与命令分开，便于单测校验线格式 —— IPc 边界没法在单测里跑）
pub fn download_sources_payload() -> serde_json::Value {
    let manager = net::source::global();
    let sources: Vec<serde_json::Value> = manager
        .snapshot()
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "source": r.source,
                "attempts": r.attempts,
                "successes": r.successes,
                "failures": r.failures,
                "rateLimited": r.rate_limited,
                "bytesPerSecond": r.bytes_per_second,
                "coolingSeconds": r.cooling_seconds,
                "score": r.score,
                // ★ ADR-057：把**实测值**也给前端。用户该看到的不只是
                //   "算出来的分"，还有"实测多少毫秒、几个端点通、多久前测的" ——
                //   两者对不上时（比如分高但实测不可达）才有得判断。
                "probeTtfbMs": r.probe_ttfb_ms,
                "probeOk": r.probe_ok,
                "probedSecondsAgo": r.probed_seconds_ago,
            })
        })
        .collect();
    serde_json::json!({
        "sources": sources,
        "preferred": manager.preferred().as_str(),
        "concurrencyHint": manager.recommended_concurrency(64),
        "uptimeSeconds": manager.uptime().as_secs(),
    })
}

/* ====================== 更新说明（实时） ====================== */

/// 更新通道的清单地址（**编在 exe 里的那个**）。
///
/// ★★ 它必须与 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints[0]` **逐字相同**，
///   而那条一致性由 `tools/gates/check-update-endpoint.mjs` 守着（它现在比**四处**）。
///   ⇒ 改端点时**四处一起改**，别只改这里或者只改 conf。
const UPDATER_MANIFEST_URL: &str =
    "https://cnb.cool/IEML_Official/IEML/-/releases/download/latest/latest.json";

/// 更新说明（来自更新通道的清单）。
///
/// ★★ 2026-09-26 用户：「**这个版本更新列表可以改成实时获取吗，点进去就刷新**」。
///
///   为什么需要它：Tauri 的 updater 插件在**版本相同时返回 `null`**
///   （`check()` 里 `should_update == false` ⇒ 连 `body` 都不给你），
///   所以"我已经是最新版了，这一版改了什么"在客户端里**根本拿不到** ——
///   只能靠构建时打进包里的那份（`src/data/release-notes.ts`）。
///   现在多一条实时的路：直接读清单，**不改版本也能看到说明**。
///
/// ★ 它不是"权威"：清单可能拿不到（断网 / DNS / 上游挂了），
///   那时界面照旧显示构建时那份 —— 所以这个命令**失败不报错**，由调用方决定怎么说。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotes {
    /// 清单里写的版本号
    pub version: String,
    /// 更新说明正文（可能为空 —— 清单没写 notes 时）
    pub notes: String,
    /// 发布时刻（清单里的 `pub_date`，原样透传；没有就是空串）
    pub pub_date: String,
}

/// JSON 里取一个字符串字段（没有 / 不是字符串 / 只有空白 ⇒ 空串）。
///
/// ★ 一律走它而不是 `"{}".to_string()`：清单是**远端**给的，
///   字段可能缺失（`#[serde(default)]` 那条守的是反序列化，这条守的是"缺字段"）。
fn json_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// 实时读更新说明（只读那一份公开清单，不需要任何凭据）。
///
/// ★ 走 [`net::api_client`]：25 秒整体超时 —— 这个请求是用户点了才发的，
///   不能让界面无限转圈（"卡住比报错更难查"，见 `net::api_client` 的注释）。
#[tauri::command]
pub async fn fetch_update_notes() -> Result<UpdateNotes, String> {
    let v: serde_json::Value = net::get_json(UPDATER_MANIFEST_URL).await.map_err(err)?;
    let version = json_str(&v, "version");
    if version.is_empty() {
        return Err("更新清单里没有版本号 —— 拿到的可能不是清单".to_string());
    }
    Ok(UpdateNotes {
        version,
        notes: json_str(&v, "notes"),
        pub_date: json_str(&v, "pub_date"),
    })
}

#[cfg(test)]
mod wire_tests {
    //! 跨 IPC 边界的字段名回归（前端契约见 `src/bridge/tauri.ts`）。
    //!
    //! 实测踩过：`Instance` / `LoaderCapabilities` 被**原样透传**，
    //! Rust 发 snake_case、前端读 camelCase ——
    //! 实例一个都存不下来（`missing field memory_mb`，用户看到"安装失败"），
    //! 字段名不一致编译器完全抓不到，只能这样守。

    use super::*;

    /*
     * ---------- 启动侧的实时判定（用户诉求："每个版本都要监测"） ----------
     *
     * 这两个测试守的是**启动路径**上的同一类错误：实例记录说的和盘上实际有的
     * 不一致时，绝不能"静默地按其中一边来"。以前的表现分别是
     *   · 纯原版实例启动成了 Forge（find_version_json 的兜底扫描扫到了 Forge 目录）
     *   · 带 Forge 的实例报"没有 Forge 痕迹"
     */

    /// 纯原版实例只允许落在**没有任何基础加载器**的版本描述上；
    /// 附加组件（OptiFine）不算 —— 纯原版 + OptiFine 是合法用法。
    #[test]
    fn vanilla_instance_must_not_land_on_a_loader_json() {
        let vanilla = r#"{"id":"1.20.1","mainClass":"net.minecraft.client.main.Main",
            "libraries":[{"name":"org.ow2.asm:asm:9.5"}]}"#;
        assert!(
            detect_flavors(vanilla).iter().all(|f| !f.is_base()),
            "纯原版 JSON 不该被判出基础加载器"
        );

        let optifine_only = r#"{"id":"1.20.1-OptiFine_HD_U_I6",
            "libraries":[{"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#;
        let offending: Vec<_> = detect_flavors(optifine_only)
            .into_iter()
            .filter(|f| f.is_base())
            .collect();
        assert!(
            offending.is_empty(),
            "纯原版 + OptiFine 是合法组合，不该被拦下：{offending:?}"
        );

        let forge = r#"{"id":"1.20.1-forge-47.4.23",
            "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.4.23"}]}"#;
        let offending: Vec<_> = detect_flavors(forge)
            .into_iter()
            .filter(|f| f.is_base())
            .collect();
        assert_eq!(
            offending,
            vec![LoaderFlavor::Forge],
            "纯原版实例读到 Forge 的 JSON 时必须被拦下（否则原版实例其实是以 Forge 启动的）"
        );
    }

    /// 带加载器的实例，判定必须认出**它自己那一种**（NeoForge 不能被当成 Forge）
    #[test]
    fn loader_instance_guard_matches_the_right_flavor() {
        let neo = r#"{"id":"1.20.4-neoforge-20.4.237",
            "libraries":[{"name":"net.neoforged:neoforge:20.4.237"}]}"#;
        let found = detect_flavors(neo);
        assert!(found.contains(&LoaderFlavor::NeoForge));
        assert!(!found.contains(&LoaderFlavor::Forge));

        // 实例要 Forge、盘上是 NeoForge → 守卫必须判"不匹配"
        assert!(!found.contains(&LoaderFlavor::Forge));
    }

    /// 前端 `DownloadSourceReport` 读的是 camelCase 的这几个字段
    #[test]
    fn download_sources_payload_is_camel_case() {
        let v = download_sources_payload();
        let sources = v.get("sources").and_then(|s| s.as_array()).expect("要有 sources");
        assert!(!sources.is_empty(), "至少要有 bmclapi / mojang 两个源");
        for s in sources {
            for k in ["source", "attempts", "successes", "failures", "score"] {
                assert!(s.get(k).is_some(), "缺少字段 {k}：{s}");
            }
            for k in [
                "rateLimited",
                "bytesPerSecond",
                "coolingSeconds",
                // ★ ADR-057 新增的三个实测字段（同样只能手工映射）
                "probeTtfbMs",
                "probeOk",
                "probedSecondsAgo",
            ] {
                assert!(s.get(k).is_some(), "★ 前端读的是 {k}，缺了会显示 undefined：{s}");
            }
            // 顺手确认没有混进 snake_case（混进来就说明有人改回了直接透传）
            for bad in [
                "rate_limited",
                "bytes_per_second",
                "cooling_seconds",
                "probe_ttfb_ms",
                "probe_ok",
                "probed_seconds_ago",
            ] {
                assert!(s.get(bad).is_none(), "不该出现 snake_case 字段 {bad}：{s}");
            }
        }
        for k in ["preferred", "concurrencyHint", "uptimeSeconds"] {
            assert!(v.get(k).is_some(), "缺少字段 {k}：{v}");
        }
    }

    /* ---------- 缺库判定：别的平台的库不算缺 ★ 用户报过的假警报 ---------- */

    /// 构造一个"只有本平台 natives 齐全"的版本 JSON。
    fn version_with_natives() -> VersionJson {
        let mk_native = |name: &str| -> serde_json::Value {
            serde_json::json!({
                "name": name,
                "downloads": {
                    "artifact": {
                        "path": metadata::maven_path(name).unwrap(),
                        "url": "https://example.invalid/x.jar",
                        "sha1": "",
                        "size": 0
                    }
                }
            })
        };
        serde_json::from_value(serde_json::json!({
            "id": "t",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-windows"),
                // 下面这些**不该**被算成缺失（别的架构 / 别的系统）
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-windows-arm64"),
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-windows-x86"),
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-linux"),
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-macos"),
                mk_native("org.lwjgl:lwjgl:3.4.1:natives-macos-arm64"),
                // 一个普通的库（classpath 用）
                serde_json::json!({
                    "name": "org.ow2.asm:asm:9.5",
                    "downloads": {
                        "artifact": {
                            "path": "org/ow2/asm/asm/9.5/asm-9.5.jar",
                            "url": "https://example.invalid/a.jar",
                            "sha1": "", "size": 0
                        }
                    }
                })
            ]
        }))
        .unwrap()
    }

    /// ★ 用户报的真实假警报：装完版本点启动，弹出
    ///   「这个版本有 22 个库文件缺失，启动必然失败：org.lwjgl:lwjgl-freetype:3.4.1:natives-windows-arm64 …」
    ///   —— 那些库是别的架构/别的系统的，本来就不该下载。
    ///   一个把正常状态说成致命错误的提示，比没有提示更糟。
    #[test]
    fn other_platform_natives_are_not_counted_as_missing() {
        let dir = std::env::temp_dir().join("ieml-test-scan-classpath");
        let _ = std::fs::remove_dir_all(&dir);
        // 只把本平台的 natives + 那个普通库放上去
        for rel in [
            "org/lwjgl/lwjgl/3.4.1/lwjgl-3.4.1-natives-windows.jar",
            "org/ow2/asm/asm/9.5/asm-9.5.jar",
        ] {
            let p = dir.join("libraries").join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
        }

        let scan = scan_classpath(&version_with_natives(), &dir);
        assert!(
            scan.missing.is_empty(),
            "★ 别的平台/架构的 natives 不该算缺失，实际报了：{:?}",
            scan.missing
        );
        assert_eq!(scan.natives.len(), 1, "只有本平台的 natives 该被解压");
        assert_eq!(scan.classpath.len(), 1, "普通库进 classpath");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反过来：**本平台**的普通库真的缺了，必须报出来（别把真问题也修没了）
    ///
    /// ★ 2026-09-14 更正：这条原来断言`missing.len() == 2`
    ///   （「本平台 natives」+「普通库」）。
    ///   natives jar 缺失**不再由这条路径上报** ——
    ///   它有一个更准的判据：启动前的 `count_native_binaries` 闸门
    ///   （看"解压出来的 dll 有几个"，那才是游戏真正需要的东西）。
    ///   两处都报会让"刚装完还没启动过"的实例收到假警报。
    ///   所以这里只断言**普通库**必须被报出来 —— 这才是这条测试的本意：
    ///   "别把真问题也修没了"。
    #[test]
    fn genuinely_missing_current_platform_library_is_reported() {
        let dir = std::env::temp_dir().join("ieml-test-scan-classpath2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 什么都不放 → 普通库必须被报缺失
        let scan = scan_classpath(&version_with_natives(), &dir);
        assert!(
            scan.missing.iter().any(|m| m.contains("asm")),
            "本平台的普通库缺了就必须报出来，实际：{:?}",
            scan.missing
        );
        // natives jar 缺失走启动闸门（见 prepare_spec 里的 count_native_binaries），
        // 这里**故意不报** —— 说明写在 scan_classpath 的注释里
        assert!(
            !scan.missing.iter().any(|m| m.ends_with("natives-windows")),
            "natives jar 的缺失归启动闸门管，这条路径不该报：{:?}",
            scan.missing
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---------- 版本 JSON 定位 ★ 用户报过的 Fabric 起不来 ---------- */

    /// ★ 实测踩过：Fabric profile 的 id 是 `fabric-loader-0.19.5-26.2`，
    ///   安装写的是 `<id>.json`，启动拼的是 `<mc_version>.json` ——
    ///   两边对不上就**静默落回原版**，游戏只留一句
    ///   `ClassNotFoundException: …KnotClient`（164 字节日志）。
    #[test]
    fn finds_version_json_under_either_naming_convention() {
        let dir = std::env::temp_dir().join("ieml-test-findjson");
        let _ = std::fs::remove_dir_all(&dir);
        let vdir = dir.join("versions").join("fabric-loader-0.19.5-26.2");
        std::fs::create_dir_all(&vdir).unwrap();

        let content = r#"{"id":"fabric-loader-0.19.5-26.2","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","inheritsFrom":"26.2","libraries":[{"name":"net.fabricmc:fabric-loader:0.19.5"}]}"#;

        // ① 只有安装侧的命名
        std::fs::write(vdir.join("fabric-loader-0.19.5-26.2.json"), content).unwrap();
        let got = find_version_json(&dir, "fabric-loader-0.19.5-26.2", "26.2", Some("fabric"));
        assert_eq!(
            got.as_deref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()),
            Some("fabric-loader-0.19.5-26.2.json".to_string()),
            "只有 <id>.json 时也必须找到"
        );

        // ② 只有启动侧的命名（原版那种写法）
        std::fs::remove_file(vdir.join("fabric-loader-0.19.5-26.2.json")).unwrap();
        std::fs::write(vdir.join("26.2.json"), content).unwrap();
        let got = find_version_json(&dir, "fabric-loader-0.19.5-26.2", "26.2", Some("fabric"));
        assert_eq!(
            got.as_deref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()),
            Some("26.2.json".to_string()),
            "只有 <mc>.json 时也必须找到"
        );

        // ③ 两个都在时，**带加载器痕迹的那个优先**
        std::fs::write(
            vdir.join("fabric-loader-0.19.5-26.2.json"),
            r#"{"id":"fabric-loader-0.19.5-26.2","mainClass":"KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.19.5"}]}"#,
        )
        .unwrap();
        std::fs::write(
            vdir.join("26.2.json"),
            r#"{"id":"26.2","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#,
        )
        .unwrap();
        let got = find_version_json(&dir, "fabric-loader-0.19.5-26.2", "26.2", Some("fabric"))
            .expect("必须能找到");
        let text = std::fs::read_to_string(&got).unwrap();
        assert!(
            text.contains("KnotClient"),
            "★ 有加载器要求时必须挑带加载器的那个 JSON，实际挑了 {}",
            got.display()
        );

        // ④ 目录里啥都没有 → 落回 versions/{mc}/{mc}.json
        let _ = std::fs::remove_dir_all(&vdir);
        let vanilla = dir.join("versions").join("26.2");
        std::fs::create_dir_all(&vanilla).unwrap();
        std::fs::write(vanilla.join("26.2.json"), r#"{"id":"26.2","libraries":[]}"#).unwrap();
        let got = find_version_json(&dir, "fabric-loader-0.19.5-26.2", "26.2", Some("fabric"));
        assert!(got.is_some(), "找不到加载器目录时该落回原版目录");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 装了加载器却读到"没有该加载器痕迹"的 JSON → `prepare_spec` 里的守卫要拦。
    /// 这里只测判据本身（`prepare_spec` 需要 AppState，跑不了）。
    #[test]
    fn loader_trace_detection() {
        let looks = |id: &str, libs: &[&str], kind: &str| -> bool {
            id.to_lowercase().contains(kind)
                || libs.iter().any(|l| l.to_lowercase().contains(kind))
        };
        // Fabric profile：id 里有 fabric，库里有 net.fabricmc
        assert!(looks("fabric-loader-0.19.5-26.2", &["net.fabricmc:fabric-loader:0.19.5"], "fabric"));
        // 原版 JSON 被误读成加载器版本 → 拦
        assert!(!looks("26.2", &["org.ow2.asm:asm:9.5"], "fabric"));
        assert!(!looks("26.2", &["org.ow2.asm:asm:9.5"], "forge"));
    }

    /// 用**磁盘上真实的版本 JSON** 复现用户那个场景。
    ///
    /// 这条测试需要本机装过那个版本才跑得起来（否则跳过），
    /// 但它正是"假警报"唯一能被确认修好的方式 —— 构造的 JSON 永远不如真的。
    ///
    /// ★ 数据目录**必须**走 `AppPaths::resolve()`：
    ///   以前这里写的是 `%APPDATA%\IEML\shared` —— 那是旧数据目录。
    ///   数据目录搬走之后，这条测试就变成"每次都跳过"，
    ///   绿得毫无意义（假绿比红更危险：它让人以为守住了）。
    ///   改成正确路径之后它立刻变红，抓到了 `versions/1.20.1/` 缺 35 个库 ——
    ///   一个"界面上写着已安装、点启动却报缺库"的真故障。
    #[test]
    fn real_installed_version_has_no_missing_libraries() {
        let shared = platform::AppPaths::resolve().shared;
        let versions = shared.join("versions");
        let Ok(rd) = std::fs::read_dir(&versions) else {
            return; // 没装过任何版本 → 跳过
        };

        let mut broken: Vec<(String, usize, Vec<String>)> = Vec::new();
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            let json = e.path().join(format!("{id}.json"));
            let Ok(text) = std::fs::read_to_string(&json) else {
                continue; // 没有版本 JSON 的目录（半成品下载）跳过
            };
            let Ok(version) = serde_json::from_str::<VersionJson>(&text) else {
                continue;
            };
            let scan = scan_classpath(&version, &shared);
            say!(
                "{id}: classpath {} 项 · natives {} 个 · 缺失 {} 个 {:?}",
                scan.classpath.len(),
                scan.natives.len(),
                scan.missing.len(),
                scan.missing.iter().take(3).collect::<Vec<_>>()
            );
            if !scan.missing.is_empty() {
                broken.push((
                    id,
                    scan.missing.len(),
                    scan.missing.iter().take(5).cloned().collect(),
                ));
            }
        }
        assert!(
            broken.is_empty(),
            "★ 这些真实版本起不来（界面上却写着已安装）—— \
             它们必须能被启动前的自愈补好，或者被明确标成损坏：{broken:#?}"
        );
    }

    /*
     * ---------- LiteLoader 的挂载点 ----------
     *
     * 界面的组合规则说「LiteLoader 必须有 Forge 作基座」，
     * 而版本描述里的 `inheritsFrom` 曾经**写死成 mc_version**。
     * 两边不一致时用户勾了 Forge + LiteLoader，装出来的却是挂原版的那份 ——
     * Forge 的库一个都不进 classpath，安装时毫无提示，启动才缺库。
     */
    #[test]
    fn liteloader_mounts_on_forge_when_base_is_forge() {
        let root = std::env::temp_dir().join(format!("ieml-ll-mount-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("versions").join("1.12.2")).unwrap();
        std::fs::write(root.join("versions/1.12.2/1.12.2.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("versions").join("1.12.2-forge-14.23.5.2860")).unwrap();
        std::fs::write(
            root.join("versions/1.12.2-forge-14.23.5.2860/1.12.2-forge-14.23.5.2860.json"),
            r#"{"id":"1.12.2-forge-14.23.5.2860",
                "inheritsFrom":"1.12.2",
                "libraries":[{"name":"net.minecraftforge:forge:1.12.2-14.23.5.2860"}]}"#,
        )
        .unwrap();

        // 基座是 Forge → 必须落在 Forge 目录上
        let got = liteloader_mount_point(&root, "1.12.2", Some("forge"));
        assert_eq!(
            got.as_deref(),
            Some("1.12.2-forge-14.23.5.2860"),
            "选了 Forge 作基座，挂载点就得是 Forge 的版本目录"
        );

        // 大小写不该影响判定（前端写 `'forge'`，别处可能出现 `'Forge'`）
        assert_eq!(
            liteloader_mount_point(&root, "1.12.2", Some("Forge")).as_deref(),
            Some("1.12.2-forge-14.23.5.2860")
        );

        // 没有基座 / 基座不是 Forge 系 → 挂原版（返回 None）
        assert_eq!(liteloader_mount_point(&root, "1.12.2", None), None);
        assert_eq!(liteloader_mount_point(&root, "1.12.2", Some("")), None);
        assert_eq!(
            liteloader_mount_point(&root, "1.12.2", Some("fabric")),
            None,
            "Fabric 上不让装 LiteLoader；真到这一步也只能挂原版"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 挂载点不存在时，`install` 必须**报错**而不是偷偷退化成挂原版
    /// （退化会丢掉基座加载器的全部库，制造"装好了却打不开"这种最难查的故障）。
    #[test]
    fn liteloader_refuses_a_missing_mount_point() {
        let root = std::env::temp_dir().join(format!("ieml-ll-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert_eq!(liteloader_mount_point(&root, "1.12.2", Some("forge")), None);

        // 调 async 的 install 需要一个运行时
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let v = crate::net::liteloader::LiteLoaderVersion {
            version: "1.12.2-SNAPSHOT".into(),
            file: "liteloader-1.12.2-SNAPSHOT.jar".into(),
            stable: false,
            tweak_class: "com.mumfrey.liteloader.launch.LiteLoaderTweaker".into(),
            libraries: Vec::new(),
            timestamp: 0,
        };
        let err = rt
            .block_on(crate::net::liteloader::install(
                &root,
                "1.12.2",
                &v,
                Some("1.12.2-forge-14.23.5.2860"),
                &|_m: String| {},
            ))
            .expect_err("挂载点不存在时必须报错");
        assert!(
            err.contains("1.12.2-forge-14.23.5.2860"),
            "报错里要写清挂载点，否则用户不知道该先装什么：{err}"
        );
        say!("拒绝安装的理由：{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 挂载点存在但**版本目录里没有版本 JSON** 时也必须报错（半成品目录）
    #[test]
    fn liteloader_refuses_a_mount_without_json() {
        let root = std::env::temp_dir().join(format!("ieml-ll-nojson-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("versions").join("1.12.2-forge-14.23.5.2860")).unwrap();
        std::fs::write(
            root.join("versions/1.12.2-forge-14.23.5.2860/leftover.txt"),
            "半成品",
        )
        .unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let v = crate::net::liteloader::LiteLoaderVersion {
            version: "1.12.2-SNAPSHOT".into(),
            file: "liteloader-1.12.2-SNAPSHOT.jar".into(),
            stable: false,
            tweak_class: "com.mumfrey.liteloader.launch.LiteLoaderTweaker".into(),
            libraries: Vec::new(),
            timestamp: 0,
        };
        let err = rt
            .block_on(crate::net::liteloader::install(
                &root,
                "1.12.2",
                &v,
                Some("1.12.2-forge-14.23.5.2860"),
                &|_m: String| {},
            ))
            .expect_err("没有版本描述文件的挂载点必须报错");
        assert!(err.contains(".json"), "报错要点明缺的是版本描述：{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /*
     * ---------- ★★ C-2：`open_data_dir` 的每个分支指向哪里 ----------
     *
     * 用户报：「'mods 目录'按钮打开的是实例根目录」——
     * 按钮写着 mods、title 写着 `game\mods`，点下去开的是实例根目录。
     * 前端那一处传错了参数（已改成 `'mods'`），而**后端这一半**也要能被钉住：
     * 这条命令会真的弹资源管理器，所以把"路径怎么算"抽成纯函数再断言。
     */
    fn probe_paths(tag: &str) -> crate::platform::AppPaths {
        let base = std::env::temp_dir().join(format!("ieml-opendir-{tag}-{}", std::process::id()));
        crate::platform::AppPaths {
            root: base.join("root"),
            own_root: base.join("own"),
            shared: base.join("root").join(".minecraft"),
            /*
             * ★★ 2026-09-24：实例目录回到**游戏根目录**下（存档/Mod 是游戏数据）。
             *   这条夹具原来写的是 `own/instances`（2026-09-23 的错布局）——
             *   夹具的形状必须跟着真布局走，否则下面的"落在实例目录下"断言
             *   会在一个现实里不存在的布局上通过。
             */
            instances: base.join("root").join("instances"),
            java: base.join("own").join("java"),
            cache: base.join("own").join("cache"),
            logs: base.join("own").join("logs"),
        }
    }

    /// ★★ 2026-09-24（用户：「版本列表的版本给我定位到
    /// `C:\…\AppData\Roaming\IEML\instances` 了」）：
    ///   `open_data_dir` 的实例那几个分支必须落在**游戏根目录**下 ——
    ///   这正是用户点「打开目录」时资源管理器会去的地方。
    ///   启动器自己的三样（logs/java/cache）则必须留在 `own_root`。
    #[test]
    fn open_dir_instance_paths_live_in_the_game_root() {
        let p = probe_paths("instroot");
        for which in ["instance", "game-dir", "mods"] {
            let dir = resolve_open_dir(&p, Some(which), Some("s1"));
            assert!(
                dir.starts_with(&p.root),
                "{which} 必须落在游戏根目录（{}）下：{}",
                p.root.display(),
                dir.display()
            );
            assert!(
                !dir.starts_with(&p.own_root),
                "{which} 不该落在启动器目录里：{}",
                dir.display()
            );
        }
        // 反过来：启动器自己的目录不该跟着游戏盘走
        for (which, want) in [("logs", &p.logs), ("java", &p.java), ("cache", &p.cache)] {
            let dir = resolve_open_dir(&p, Some(which), None);
            assert_eq!(&dir, want);
            assert!(dir.starts_with(&p.own_root) && !dir.starts_with(&p.root));
        }
    }

    #[test]
    fn open_dir_mods_points_at_the_mods_dir_not_the_instance_dir() {
        let p = probe_paths("mods");
        let mods = resolve_open_dir(&p, Some("mods"), Some("s1"));
        assert_eq!(mods, p.instance_game_dir("s1").join("mods"));
        assert_ne!(mods, p.instance_dir("s1"), "★ 不许再开成实例根目录");
        assert!(
            mods.starts_with(&p.instances),
            "mods 目录必须落在实例目录下：{}",
            mods.display()
        );
        // 与前端按钮的 title（`game\mods`）逐段对齐
        assert!(mods.ends_with(std::path::Path::new("game").join("mods")));
    }

    #[test]
    fn open_dir_other_branches_are_distinct_and_sane() {
        let p = probe_paths("branches");
        let inst = resolve_open_dir(&p, Some("instance"), Some("s1"));
        let game = resolve_open_dir(&p, Some("game-dir"), Some("s1"));
        let mods = resolve_open_dir(&p, Some("mods"), Some("s1"));
        // 三者互不相同（这正是 C-2 的关键：instance ≠ mods）
        assert_ne!(inst, game);
        assert_ne!(inst, mods);
        assert_ne!(game, mods);
        assert_eq!(game, inst.join("game"));
        // 其余分支各归各位
        assert_eq!(resolve_open_dir(&p, Some("logs"), None), p.logs);
        assert_eq!(resolve_open_dir(&p, Some("java"), None), p.java);
        assert_eq!(resolve_open_dir(&p, Some("cache"), None), p.cache);
        assert_eq!(resolve_open_dir(&p, Some("shared"), None), p.shared);
        // 认不出的（含 None）= 数据根目录
        assert_eq!(resolve_open_dir(&p, Some("what"), None), p.root);
        assert_eq!(resolve_open_dir(&p, None, None), p.root);
    }

    /// ★★ 2026-09-25（PCL 的「添加已有文件夹」那栏）：
    ///   用户从资源管理器里指到 `.minecraft` **本身**时，根目录要取它的上一级 ——
    ///   否则会在它下面再建一层 `.minecraft`，版本永远是空的。
    #[test]
    fn dot_minecraft_target_is_lifted_one_level() {
        // Windows 盘符与大小写都要认（`.Minecraft` 也是同一个文件夹）
        let (root, lift) = normalize_root_target(std::path::Path::new(r"D:\Minecraft\.minecraft"));
        assert_eq!(root, std::path::PathBuf::from(r"D:\Minecraft"));
        assert_eq!(lift.as_deref(), Some(r"D:\Minecraft\.minecraft"));

        let (root2, lift2) = normalize_root_target(std::path::Path::new(r"D:\Games\.MINECRAFT"));
        assert_eq!(root2, std::path::PathBuf::from(r"D:\Games"));
        assert_eq!(lift2.as_deref(), Some(r"D:\Games\.MINECRAFT"));

        // 普通目录**不许动**
        let (root3, lift3) = normalize_root_target(std::path::Path::new(r"D:\IEML"));
        assert_eq!(root3, std::path::PathBuf::from(r"D:\IEML"));
        assert_eq!(lift3, None);

        // 盘符根下的 `D:\.minecraft`：上级就是 `D:\` —— 照提（用户选的就是盘根那份）
        let (root4, lift4) = normalize_root_target(std::path::Path::new(r"D:\.minecraft"));
        assert_eq!(root4, std::path::PathBuf::from(r"D:\"));
        assert_eq!(lift4.as_deref(), Some(r"D:\.minecraft"));

        // 相对路径 `.minecraft`（上级是空串）**不提** —— 提了会得到空路径
        let (root5, lift5) = normalize_root_target(std::path::Path::new(".minecraft"));
        assert_eq!(root5, std::path::PathBuf::from(".minecraft"));
        assert_eq!(lift5, None);
    }

    /// ★★ 2026-09-25：`folder_versions` 的判据 —— **看这个文件夹里有什么**。
    ///   用户：「PCL 就是像换了个文件夹去读游戏版本，可以无缝切换」。
    #[test]
    fn folder_versions_reads_the_folder_not_the_ledger() {
        let base = std::env::temp_dir().join(format!("ieml-folderver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let shared = base.join(".minecraft");
        let versions = shared.join("versions");

        // ① 原版：目录名 = id，没有 inheritsFrom
        let v1 = versions.join("26.2");
        std::fs::create_dir_all(&v1).unwrap();
        std::fs::write(
            v1.join("26.2.json"),
            r#"{"id":"26.2","mainClass":"net.minecraft.client.main.Main"}"#,
        )
        .unwrap();

        // ② 加载器版本：id 与目录名不同、靠 inheritsFrom 指回 26.2
        let v2 = versions.join("fabric-loader-0.19.5-26.2");
        std::fs::create_dir_all(&v2).unwrap();
        std::fs::write(
            v2.join("fabric-loader-0.19.5-26.2.json"),
            r#"{"id":"fabric-loader-0.19.5-26.2","inheritsFrom":"26.2","mainClass":"KnotClient"}"#,
        )
        .unwrap();

        // ③ 空壳目录（没有 JSON）—— 也要出现在结果里，只是 `has_json = false`
        std::fs::create_dir_all(versions.join("broken-one")).unwrap();

        let got = scan_folder_versions(&shared);
        assert_eq!(got.len(), 3, "三个目录都要读出来：{got:?}");

        let vanilla = got.iter().find(|v| v.dir == "26.2").expect("原版那条");
        assert_eq!(vanilla.id, "26.2");
        assert_eq!(vanilla.mc_version, "26.2");
        assert_eq!(vanilla.loader_name, None, "原版目录不该被认成加载器");
        assert!(vanilla.has_json);

        let fabric = got
            .iter()
            .find(|v| v.dir == "fabric-loader-0.19.5-26.2")
            .expect("fabric 那条");
        assert_eq!(fabric.inherits, "26.2");
        assert_eq!(fabric.mc_version, "26.2", "MC 版本要取 inheritsFrom");
        assert_eq!(fabric.loader_name.as_deref(), Some("fabric"));

        let broken = got.iter().find(|v| v.dir == "broken-one").expect("空壳那条");
        assert!(!broken.has_json);
        assert_eq!(broken.id, "broken-one", "没有 JSON 时 id 落回目录名");

        // 排序稳定（按目录名，忽略大小写）——界面顺序不该每次都不一样
        let mut names: Vec<String> = got.iter().map(|v| v.dir.clone()).collect();
        names.sort_by_key(|s| s.to_lowercase());
        assert_eq!(
            got.iter().map(|v| v.dir.clone()).collect::<Vec<_>>(),
            names,
            "结果要按目录名排好序"
        );

        // neoforge 不能被认成 forge（顺序错了会少一个 NeoForge 徽标）
        assert_eq!(loader_from_dir_name("neoforge-21.1.0").as_deref(), Some("neoforge"));
        assert_eq!(loader_from_dir_name("1.20.1-forge-47.2.0").as_deref(), Some("forge"));
        assert_eq!(loader_from_dir_name("1.20.1").as_deref(), None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
