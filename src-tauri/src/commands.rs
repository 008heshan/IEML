//! Tauri 命令层（前端通过 invoke 调用）
//!
//! 原则：**本层不含业务规则**，只做参数转换与 I/O。
//! 所有判定都调用 `crate::domain::*`，保证前端与后端用的是同一套规则。

use crate::AppState;
use crate::domain::{
    combination, java, loader_caps, memory, mods, types::*, version,
};
use crate::platform;
use tauri::State;

/* ====================== 应用与机器 ====================== */

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub data_dir: String,
    pub backend: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: "IEML".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.paths().root.to_string_lossy().to_string(),
        backend: "rust".into(),
    }
}

#[tauri::command]
pub fn machine_info(state: State<'_, AppState>) -> platform::MachineInfo {
    platform::machine_info(&state.paths())
}

/* ====================== Java ====================== */

/// 扫描本机的 Java 运行时。
///
/// ★ 必须是 `async` + `spawn_blocking`（用户报"界面卡住"的同类原因）：
///   扫描要向 8 类来源收集候选，并且**真的把每一个 `java -version` 跑一遍**
///   （每个 50~300 ms）。即使并行探测，整体也是百毫秒级到秒级 ——
///   同步命令会把这期间的事件循环一起占住，界面就是"点了没反应"。
#[tauri::command]
pub async fn scan_java(
    state: State<'_, AppState>,
    manual: Option<Vec<String>>,
) -> Result<Vec<java::JavaRuntime>, String> {
    let paths = state.paths().clone();
    let manual = manual.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || platform::scan_java_with_extra(&paths, &manual))
        .await
        .map_err(|e| format!("Java 扫描失败：{e}"))
}

/// ★ 删除 IEML 自己下载的 Java。
///
/// **默认进系统回收站**（`permanent = false`）：一个 JDK 几百 MB，
/// 用户往往在"这个 Java 是哪个实例在用的"没想清楚时就点了删除。
#[tauri::command]
pub fn remove_java(
    state: State<'_, AppState>,
    path: String,
    permanent: Option<bool>,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    // 只允许删除位于 IEML 数据目录里的 Java，避免误删系统安装的
    let java_root = &state.paths().java;
    if !p.starts_with(java_root) {
        return Err(format!(
            "只能删除 IEML 自己下载的 Java（位于 {}）。系统安装的 Java 请用系统的方式卸载。",
            java_root.to_string_lossy()
        ));
    }
    let home = p.ancestors().nth(2).unwrap_or(p);
    if !home.exists() {
        return Ok(()); // 本来就不在 —— 不算错误
    }
    if permanent.unwrap_or(false) {
        return std::fs::remove_dir_all(home).map_err(|e| format!("永久删除失败：{e}"));
    }
    trash::delete(home).map_err(|e| {
        format!(
            "移到回收站失败（{e}）—— 这个位置可能没有回收站；\
             确认要永久删除的话，按住 Shift 再点一次删除"
        )
    })
}

#[tauri::command]
pub fn resolve_java(
    mc_version: String,
    has_forge_like: bool,
    mod_count: u32,
    has_optifine: bool,
    mode: String,
    runtimes: Vec<java::JavaRuntime>,
    range_text: Option<String>,
    path: Option<String>,
) -> Result<java::JavaPickResult, String> {
    let input = java::JavaConstraintInput::from(&mc_version, has_forge_like, mod_count, has_optifine);
    let range = match range_text {
        Some(t) if !t.trim().is_empty() => Some(version::parse_range(&t)?),
        _ => None,
    };
    Ok(java::pick_java(
        &mode,
        &runtimes,
        input,
        range,
        path.as_deref(),
    ))
}

/* ====================== 加载器与组合 ====================== */

#[tauri::command]
pub fn loader_capabilities(mc_version: String) -> LoaderCapabilities {
    loader_caps::capabilities(&mc_version)
}

#[tauri::command]
pub fn validate_combination(selection: LoaderSelection) -> CombinationVerdict {
    combination::validate_combination(&selection)
}

/* ====================== 内存 ====================== */

#[tauri::command]
pub fn memory_targets(mod_count: u32, kind: String) -> memory::MemoryTargets {
    memory::memory_targets(mod_count, parse_mem_kind(&kind))
}

#[derive(serde::Serialize)]
pub struct AutoMemoryPayload {
    pub result: memory::AutoMemoryResult,
    pub reasoning: String,
    pub suggested_gear: u32,
    pub snapped_gb: f64,
    pub max_gear: u32,
}

#[tauri::command]
pub fn auto_memory(
    mod_count: u32,
    kind: String,
    total_gb: f64,
    available_gb: f64,
) -> AutoMemoryPayload {
    let k = parse_mem_kind(&kind);
    let result = memory::auto_memory(mod_count, k, total_gb, available_gb);
    let reasoning = memory::memory_reasoning(mod_count, &result);
    let gear = memory::gb_to_gear(result.gb, total_gb);
    AutoMemoryPayload {
        reasoning,
        suggested_gear: gear,
        snapped_gb: memory::gear_to_gb(gear),
        max_gear: memory::max_gear(total_gb),
        result,
    }
}

fn parse_mem_kind(kind: &str) -> memory::InstanceMemoryType {
    match kind {
        "modded" => memory::InstanceMemoryType::Modded,
        "optifine" => memory::InstanceMemoryType::OptiFine,
        _ => memory::InstanceMemoryType::Vanilla,
    }
}

/* ====================== 版本隔离 ====================== */

#[derive(serde::Serialize)]
pub struct IsolationVerdict {
    pub isolated: bool,
    pub source: String,
    pub reason: String,
    pub warning: Option<String>,
}

/// 三段判定：用户显式设置 > 目录内容 > 全局默认（ADR-005）
#[tauri::command]
pub fn resolve_isolation(
    mode: String,
    has_content: bool,
    global_default: String,
    from_modpack: bool,
) -> IsolationVerdict {
    // ① 整合包实例一律隔离
    if from_modpack && mode != "off" {
        return IsolationVerdict {
            isolated: true,
            source: "content".into(),
            reason: "这是整合包导入的实例，包内的 Mod 与配置必须独占，因此启用隔离".into(),
            warning: None,
        };
    }
    // ② 用户显式指定
    if mode == "on" {
        return IsolationVerdict {
            isolated: true,
            source: "user".into(),
            reason: "你已强制启用隔离，该实例的 mods / saves / config 独立存放".into(),
            warning: None,
        };
    }
    if mode == "off" {
        return IsolationVerdict {
            isolated: false,
            source: "user".into(),
            reason: "你已强制关闭隔离，将与其他实例共用 mods / saves / config".into(),
            warning: Some(
                "多个版本的 Mod 会互相污染 —— 1.20.1 的 Mod 放进 1.21.1 的实例会直接导致游戏无法启动。仅建议纯原版实例这样做。".into(),
            ),
        };
    }
    // ③ 按目录内容
    if has_content {
        return IsolationVerdict {
            isolated: true,
            source: "content".into(),
            reason: "已检测到该实例目录下的 mods/ 与 saves/，自动启用隔离以避免多版本互相污染".into(),
            warning: None,
        };
    }
    // ④ 跟随全局默认
    let isolated = global_default == "isolated";
    IsolationVerdict {
        isolated,
        source: "global".into(),
        reason: if isolated {
            "实例目录还是空的，按全局默认启用隔离".into()
        } else {
            "实例目录还是空的，按全局默认与其他实例共用目录".into()
        },
        warning: None,
    }
}

/* ====================== 安装计划 ====================== */

#[derive(serde::Serialize)]
pub struct PlanStep {
    pub phase: String,
    pub label: String,
    pub serial: bool,
}

#[derive(serde::Serialize)]
pub struct InstallPlanSummary {
    pub download_bytes: u64,
    pub reused_bytes: u64,
    pub install_bytes: u64,
    pub estimated_seconds: u64,
    pub file_count: usize,
    pub deduped_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct InstallPlan {
    pub mc_version: String,
    pub instance_name: String,
    pub slug: String,
    pub loader: Option<LoaderRecord>,
    pub addons: Vec<AddonRecord>,
    pub java_major: u32,
    pub steps: Vec<PlanStep>,
    pub summary: InstallPlanSummary,
    pub notes: Vec<String>,
}

/// 生成安装计划。
/// ★ 必须是**纯数据**：下载前可完全算出来，可预览、可序列化续传、可测试（ADR-002）。
#[tauri::command]
pub fn build_install_plan(
    selection: LoaderSelection,
    instance_name: String,
    slug: String,
    cached_hashes: Vec<String>,
) -> InstallPlan {
    let verdict = combination::validate_combination(&selection);
    let caps = loader_caps::capabilities(&selection.mc_version);

    let mut notes = verdict.warnings.clone();
    for r in &verdict.removed {
        notes.push(format!("已移除 {}：{}", r.name, r.reason));
    }

    // 原版体积
    let vanilla = loader_caps::profile(&selection.mc_version)
        .map(|p| p.vanilla_bytes)
        .unwrap_or(300 * 1024 * 1024);

    // 组件体积
    let mut component_bytes = 0u64;
    if let Some(base) = selection.base {
        if verdict.valid {
            component_bytes += match base {
                BaseLoaderKind::Forge => 120 * 1024 * 1024,
                BaseLoaderKind::NeoForge => 135 * 1024 * 1024,
                BaseLoaderKind::Fabric => 12 * 1024 * 1024,
                BaseLoaderKind::Quilt => 14 * 1024 * 1024,
            };
        }
    }
    for a in &selection.addons {
        if !verdict.removed.iter().any(|r| r.kind == *a) {
            component_bytes += match a {
                AddonKind::OptiFine => 38 * 1024 * 1024,
                AddonKind::LiteLoader => 6 * 1024 * 1024,
            };
        }
    }
    /*
     * ★ 桥接包体积**只算我们能自动下的那些**。
     *   1.14 ~ 1.20.4 的 OptiFabric 是我们不下、用户自己下的（manual），
     *   算进"将下载"就是虚报。见 `domain::bridge_range`。
     */
    for _ in &verdict.auto_bridges {
        component_bytes += (1.2 * 1024.0 * 1024.0) as u64;
    }
    for lib in &verdict.auto_apis {
        component_bytes += lib.bytes;
    }

    // 缓存命中：用传入的哈希集合估算（真实实现里逐个文件比对 SHA1）
    let cache_hit_ratio = if cached_hashes.is_empty() { 0.0 } else { 0.75 };
    let reused = ((vanilla as f64 * 0.9) + (component_bytes as f64 * cache_hit_ratio)) as u64;
    let install_bytes = vanilla + component_bytes;
    let download_bytes = install_bytes.saturating_sub(reused);
    let estimated_seconds = (download_bytes / (12 * 1024 * 1024)).max(5);

    let steps = vec![
        PlanStep {
            phase: "download-installer".into(),
            label: "下载安装器".into(),
            serial: true,
        },
        PlanStep {
            phase: "run-installer".into(),
            label: "释放库文件".into(),
            serial: true,
        },
        PlanStep {
            phase: "collect-libraries".into(),
            label: "整理依赖".into(),
            serial: false,
        },
        PlanStep {
            phase: "apply-addons".into(),
            label: "应用附加组件".into(),
            serial: true,
        },
        PlanStep {
            phase: "install-apis".into(),
            label: "安装 API 前置包".into(),
            serial: true,
        },
        PlanStep {
            phase: "write-manifest".into(),
            label: "生成版本描述".into(),
            serial: true,
        },
    ];

    InstallPlan {
        mc_version: selection.mc_version.clone(),
        instance_name,
        slug,
        loader: selection.base.map(|kind| LoaderRecord {
            kind,
            version: selection.base_version.clone().unwrap_or_default(),
            mc_version: selection.mc_version.clone(),
        }),
        addons: selection
            .addons
            .iter()
            .filter(|a| !verdict.removed.iter().any(|r| r.kind == **a))
            .map(|a| AddonRecord {
                kind: *a,
                version: String::new(),
                bridge: verdict
                    .auto_bridges
                    .iter()
                    .find(|b| b.after == *a)
                    .map(|b| BridgeRecord {
                        kind: b.kind,
                        version: "latest".into(),
                    }),
            })
            .collect(),
        java_major: caps.java_major,
        steps,
        summary: InstallPlanSummary {
            download_bytes,
            reused_bytes: reused,
            install_bytes,
            estimated_seconds,
            file_count: 0,
            deduped_bytes: 0,
        },
        notes,
    }
}

/* ====================== Mod ====================== */

#[tauri::command]
pub fn scan_mods(
    instance_id: String,
    loader_kind: Option<String>,
    mc_version: String,
    state: State<'_, AppState>,
) -> Result<Vec<mods::ModEntry>, String> {
    // ★ 必须和游戏读到的是同一个目录（instances/{slug}/game/mods）
    let dir = state.paths().instance_mods_dir(&instance_id);
    let mut files: Vec<mods::ModFile> = Vec::new();

    let Ok(entries) = std::fs::read_dir(&dir) else {
        // 目录不存在 = 还没有 Mod，不是错误
        return Ok(vec![]);
    };
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(mods::ModFile {
            file_name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            bytes: meta.len(),
            mtime_ms,
        });
    }

    Ok(mods::scan_mods(
        &files,
        loader_kind.as_deref(),
        &mc_version,
    ))
}

/* ====================== 崩溃分析 ====================== */

/*
 * ★ 2026-09-24（死代码清理）：这里原来有两条命令
 *   `analyze_crash` / `redact_report`，它们**全仓库 0 处调用**
 *   （`bridge/tauri.ts` 里那个 `rust` 对象是唯一调用方，也一起删了）。
 *   活的两条路都在前端：崩溃分析 `src/domain/crash.ts::analyzeCrashLog`（同步、无需 IPC），
 *   脱敏 `src/domain/crash.ts::redactReport`（日志页与崩溃弹窗用）。
 *   ★ 留着它们就有两份规则表（Rust 35 条 vs TS 36 条，曾经漂移过 —— 见 C-8），
 *     所以这里删掉，规则只留一处。
 */

/* ====================== 实例持久化 ====================== */

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct InstanceStore {
    pub instances: Vec<Instance>,
    pub active_id: Option<String>,
}

/// ★★ A-4（2026-09-24）：清单文件住在**启动器自己的家**（`own_root`），
///   不再写在游戏根目录里 —— 用户在「候选盘」那页删掉游戏根目录时，
///   实例清单与全部设置不会再跟着一起没（老位置那份由 `platform::adopt_records` 收养）。
fn instances_file(state: &AppState) -> std::path::PathBuf {
    state.paths().instances_file()
}

#[tauri::command]
pub fn list_instances(state: State<'_, AppState>) -> Result<InstanceStore, String> {
    // 读：优先 own_root，那儿没有才回退到游戏根目录的老位置（老用户升级上来的那一份）
    let Some(path) = state.paths().own_file_for_read("instances.json") else {
        return Ok(InstanceStore::default());
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取实例列表失败：{e}"))?;
    /*
     * ★★ 2026-09-23：**回退**（第 3 条"删目录要同步"的第一版实现有严重错误）
     *
     *   我原来在这里加了 `retain(|i| paths.instance_dir(&i.config.slug).is_dir())` ——
     *   本意是"目录没了的条目别列出来"，结果**把所有实例都滤掉了**：
     *   **清单里的 `config.slug` 并不等于磁盘上的目录名**（真机上一眼可见：
     *   清单里是 `vanilla-262` 这类，而目录名是 `26.3-fabric-0.19.5`）。
     *   于是启动页变成"还没有可启动的版本"。
     *
     *   ★ 更糟的是：**我当时那条"同步成功（1 → 0）"的验证是假的** ——
     *     它证明的不是"同步生效"，而是"过滤把一切都滤掉了"。
     *     **一个把功能全关掉的改动，会让"同步"这条判据显得特别成功。**
     *
     *   所以先**退回原样**（读清单、不动它），第 3 条换个正确做法：
     *   先搞清楚"一个实例在磁盘上到底由哪个路径唯一标识"，再谈"目录没了"。
     *   ——**在搞清楚这件事之前，任何"顺手对一遍磁盘"的代码都是猜。**
     */
    serde_json::from_str(&text).map_err(|e| format!("实例列表损坏：{e}（文件在 {}）", path.display()))
}

#[tauri::command]
pub fn save_instances(state: State<'_, AppState>, store: InstanceStore) -> Result<(), String> {
    /* ★ A-4：写到**启动器自己的家**（`own_root`），不再写游戏根目录 */
    std::fs::create_dir_all(&state.paths().own_root)
        .map_err(|e| format!("无法创建数据目录（{}）：{e}", state.paths().own_root.display()))?;
    let path = instances_file(&state);
    let text = serde_json::to_string_pretty(&store).map_err(|e| format!("序列化失败：{e}"))?;
    // 先写临时文件再改名，避免写到一半断电导致列表损坏
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存失败：{e}"))
}

/* ====================== 全局偏好持久化 ====================== */

/// ★★ A-4（2026-09-24）：与 `instances_file` 同理 —— 全局偏好也住在 `own_root`。
fn prefs_file(state: &AppState) -> std::path::PathBuf {
    state.paths().prefs_file()
}

/// 读全局偏好（主题 / 下载源 / 并发数 / 窗口尺寸 / 离线用户名 / 账号 uuid …）。
///
/// ★ 为什么必须有它（审计发现的严重缺陷）：偏好**只存在内存里**，
///   每次重启全部丢失 —— 主题回到默认、下载源回到 BMCLAPI、并发数回到 64，
///   **连正版登录的 accountUuid 都没了**，于是"登录过"的用户第二天启动游戏
///   变成离线 "Player"。用户会以为登录/设置是坏的。
///
/// 返回值刻意用「字符串 → JSON」的宽松形式：偏好字段以后还会增加，
/// 后端不该因为前端多了/少了一个字段就整体失败（那会连带把登录也弄丢）。
#[tauri::command]
pub fn load_prefs(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // 读：优先 own_root，那儿没有才回退到游戏根目录的老位置（A-4）
    let Some(path) = state.paths().own_file_for_read("prefs.json") else {
        return Ok(serde_json::json!({}));
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取设置失败：{e}"))?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => Ok(v),
        // 文件坏了不能连累启动：备份一份再从默认值开始
        Err(e) => {
            let bak = path.with_extension("json.bad");
            let _ = std::fs::rename(&path, &bak);
            say!(
                "[IEML/prefs] 设置文件损坏（{e}），已备份到 {}，本次用默认设置",
                bak.display()
            );
            Ok(serde_json::json!({}))
        }
    }
}

/// 写全局偏好（原子写：先临时文件再改名，断电不会写坏）。
#[tauri::command]
pub fn save_prefs(state: State<'_, AppState>, prefs: serde_json::Value) -> Result<(), String> {
    /* ★ A-4：写到**启动器自己的家**（`own_root`），不再写游戏根目录 */
    std::fs::create_dir_all(&state.paths().own_root)
        .map_err(|e| format!("无法创建数据目录（{}）：{e}", state.paths().own_root.display()))?;
    let path = prefs_file(&state);
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| format!("序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存失败：{e}"))
}

/// ★ 删除一个实例的目录（存档 / Mod / 配置 / natives 全在里面）。
///
/// 审计发现：`removeInstance` 以前只从内存列表里删掉记录，
/// 而三处确认框都写着「存档与配置会一起删除」—— **磁盘上什么都没删**，
/// 用户以为删干净了。现在给出真实能力，由前端在删除时调用。
///
/// 安全：目录名来自实例的 slug，必须校验它落在 `instances/` 下面
/// （挡住 `../` 之类的越界删除请求）。
///
/// ★ **默认进系统回收站**（`permanent = false`）。实例目录里有存档，
///   这是最不该"删错了就没了"的东西；确认要永久删除时前端按住 Shift 调用。
#[tauri::command]
pub fn delete_instance_files(
    slug: String,
    permanent: Option<bool>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if slug.is_empty() {
        return Err("实例 slug 为空".into());
    }
    let root = state.paths().instances.clone();
    let dir = state.paths().instance_dir(&slug);
    // 越界校验：解析后的路径必须以 instances/ 开头，且不等于它本身
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canon_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if canon_dir == canon_root || !canon_dir.starts_with(&canon_root) {
        return Err(format!(
            "拒绝删除：{} 不在实例目录下（instances/）",
            dir.display()
        ));
    }
    if !dir.is_dir() {
        return Ok(0); // 目录本来就不在 —— 不算错误
    }
    // 统计一下删了多少字节，让前端能如实报告
    let bytes = dir_size(&dir);
    if permanent.unwrap_or(false) {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("永久删除实例目录失败：{e}"))?;
    } else {
        // ★ 进回收站：存档还能捞回来
        trash::delete(&dir).map_err(|e| {
            format!(
                "移到回收站失败（{e}）—— 这个位置可能没有回收站；\
                 确认要永久删除的话，按住 Shift 再点一次删除"
            )
        })?;
    }
    Ok(bytes)
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&e.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// ★ 复制一个实例的**磁盘目录**（存档 / Mod / 配置 / natives）。
///
/// 审计发现：前端的"创建副本 / 复制"只克隆了实例记录，目录从没建过 ——
/// 副本指向一个不存在的目录，于是它是一个"没有存档、没有 Mod、没有配置"的空壳，
/// 而界面写着"配置照搬一份"。
///
/// `copy_saves=false` 时可以只复制配置与 Mod（存档很大时有用）。
/// 返回复制出来的字节数。
#[tauri::command]
pub fn copy_instance_files(
    from_slug: String,
    to_slug: String,
    copy_game_dir: bool,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if from_slug.is_empty() || to_slug.is_empty() {
        return Err("实例 slug 不能为空".into());
    }
    if from_slug == to_slug {
        return Err("源和目标不能是同一个实例".into());
    }
    let root = state.paths().instances.clone();
    let src = state.paths().instance_dir(&from_slug);
    let dst = state.paths().instance_dir(&to_slug);

    // 越界校验（与 delete_instance_files 同一套规则）
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canon_dst = dst.canonicalize().unwrap_or_else(|_| dst.clone());
    if canon_dst == canon_root || !canon_dst.starts_with(&canon_root) {
        return Err(format!("拒绝写入：{} 不在实例目录下", dst.display()));
    }
    if dst.exists() {
        return Err(format!("目标目录已存在：{}", dst.display()));
    }
    if !src.is_dir() {
        // 源目录不存在（没启动过/没装过）—— 建一个空目录，副本至少能用
        std::fs::create_dir_all(&dst).map_err(|e| format!("创建副本目录失败：{e}"))?;
        return Ok(0);
    }

    std::fs::create_dir_all(&dst).map_err(|e| format!("创建副本目录失败：{e}"))?;
    let mut copied = 0u64;

    // natives 不复制（启动时会按当前架构重新解压，复制反而可能带错版本的 dll）
    let skip = ["natives"];
    for entry in std::fs::read_dir(&src).map_err(|e| format!("读取源目录失败：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if skip.contains(&name.as_str()) {
            continue;
        }
        // `game` 目录按参数决定要不要复制（存档通常在里面，可能很大）
        if name == "game" && !copy_game_dir {
            std::fs::create_dir_all(dst.join("game")).map_err(|e| e.to_string())?;
            continue;
        }
        copied += copy_tree(&entry.path(), &dst.join(&name))?;
    }
    Ok(copied)
}

/// 递归复制（文件 → 文件，目录 → 目录）。返回复制的字节数。
fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<u64, String> {
    if src.is_file() {
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, dst).map_err(|e| format!("复制 {} 失败：{e}", src.display()))?;
        return Ok(src.metadata().map(|m| m.len()).unwrap_or(0));
    }
    if !src.is_dir() {
        return Ok(0);
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        total += copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(total)
}

/* ====================== 启动与停止 ====================== */

/*
 * ★★ 这两个命令**已经删掉了**（P0-6 / 这一轮的"剔除假标识"）。
 *
 *   它们是真实启动/停止路径的**第二份实现**，而且：
 *     · `launch_game` 与 `commands_real::launch_minecraft` 重复 ——
 *       连 `lib.rs` 的 `invoke_handler` 里都**没有登记**它，
 *       也就是说前端永远调不到（死代码，但注释写得像在用）；
 *     · `stop_game` 返回 `exit_code: Some(0)` —— 一个**编出来的数字**：
 *       它走的是 taskkill 路径，压根没读过子进程的退出码。
 *       任何读到这个值的地方（日志、界面、报告）都会被它骗。
 *
 *   真相只有一份：`commands_real::{launch_minecraft, stop_minecraft}`，
 *   停止判据见 `domain::crash::judge_crash`。留着两份实现，
 *   下一轮改其中一份时另一份就会变成"看起来还在用"的谎话。
 */

/// 已安装的游戏版本（扫 shared/versions 目录）
#[tauri::command]
pub fn installed_versions(state: State<'_, AppState>) -> Vec<String> {
    let dir = state.paths().shared.join("versions");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect()
}
