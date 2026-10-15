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

/*
 * ★★ 2026-10-09（用户：「**进入启动器的速度有点慢**」）：启动那批命令**各自的耗时**
 *   要看得见。
 *
 *   前端只能量到"哪条**最后**落定"（`window.__boot.invokes`），而同步命令是
 *   在主线程上排队的 —— 落定时刻全挤在一起，看不出是谁占的时间（实测六条
 *   都落在 199~201ms，连几乎不干活的 `app_info` 也一样）。
 *   ⇒ 在 Rust 这一侧**各量各的**：一条 `say!` 一行，成本一次 `Instant::now()`。
 */
#[tauri::command]
pub fn machine_info(state: State<'_, AppState>) -> platform::MachineInfo {
    let t = std::time::Instant::now();
    let info = platform::machine_info(&state.paths());
    say!("[IEML/boot] machine_info = {}ms", t.elapsed().as_millis());
    info
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
    /* ★ 启动耗时打点（见 `machine_info` 上面那段说明）：这条是启动批次里最长的一条 */
    let t = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || platform::scan_java_with_extra(&paths, &manual))
        .await
        .map_err(|e| format!("Java 扫描失败：{e}"));
    say!("[IEML/boot] scan_java = {}ms", t.elapsed().as_millis());
    out
}

/// ★ 删除 IEML 自己下载的 Java。
///
/// **默认进系统回收站**（`permanent = false`）：一个 JDK 几百 MB，
/// 用户往往在"这个 Java 是哪个实例在用的"没想清楚时就点了删除。
#[tauri::command]
pub async fn remove_java(
    state: State<'_, AppState>,
    path: String,
    permanent: Option<bool>,
) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    // 只允许删除位于 IEML 数据目录里的 Java，避免误删系统安装的
    let java_root = state.paths().java.clone();
    if !p.starts_with(&java_root) {
        return Err(format!(
            "只能删除 IEML 自己下载的 Java（位于 {}）。系统安装的 Java 请用系统的方式卸载。",
            java_root.to_string_lossy()
        ));
    }
    /*
     * ★★★★ 2026-10-08：这条命令被新加的门禁 `check-blocking-commands.mjs`
     *   **抓出来了** —— 它和 `delete_instance_files` 是同一个形状：
     *   同步命令 + `trash::delete` / `remove_dir_all`（一个 JDK 几百 MB、
     *   几万个文件）。用户只报了"删除版本卡顿"，但**这一条一样会卡**，
     *   只是他还没点到那儿。
     *
     *   ⇒ 同样交给 `spawn_blocking`。
     */
    let home = p
        .ancestors()
        .nth(2)
        .map(|h| h.to_path_buf())
        .unwrap_or(p);
    let permanent = permanent.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if !home.exists() {
            return Ok(()); // 本来就不在 —— 不算错误
        }
        if permanent {
            return std::fs::remove_dir_all(&home).map_err(|e| format!("永久删除失败：{e}"));
        }
        trash::delete(&home).map_err(|e| {
            format!(
                "移到回收站失败（{e}）—— 这个位置可能没有回收站；\
                 确认要永久删除的话，按住 Shift 再点一次删除"
            )
        })
    })
    .await
    .map_err(|e| format!("删除任务没能启动：{e}"))?
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
///
/// ★★ 2026-09-27：这条命令以前**自己实现了一份**判定，而前端一次都没调过它 ——
///   规则于是有三份（这里、`src/domain/isolation.ts`、以及真正决定游戏目录的
///   `prepare_spec` 里那一行**两份都不看**）。
///   现在它只是 `domain::isolation::resolve` 的一层壳（ADR-006：规则只写一次）；
///   界面要的数据走 `isolation_verdicts` / `isolation_of`（那两条读的是真账本）。
#[tauri::command]
pub fn resolve_isolation(
    mode: String,
    has_content: bool,
    global_default: String,
) -> IsolationVerdict {
    let v = crate::domain::isolation::resolve(
        match mode.as_str() {
            "on" => crate::domain::types::IsolationMode::On,
            "off" => crate::domain::types::IsolationMode::Off,
            _ => crate::domain::types::IsolationMode::Auto,
        },
        has_content,
        &global_default,
        true,
    );
    IsolationVerdict {
        isolated: v.isolated,
        source: v.source_str().to_string(),
        reason: v.reason,
        warning: v.warning,
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
    // ★ 必须和游戏读到的是同一个目录（实例的游戏目录下的 mods/）
    let dir = state.paths().instance_mods_dir(&instance_id);
    let mut files: Vec<mods::ModFile> = Vec::new();

    let Ok(entries) = std::fs::read_dir(&dir) else {
        /*
         * ★★ 2026-09-30：用户报「Mod 列表不显示」而**目录里明明有 jar**。
         *
         *   这条命令原来是**静默返回空**（"目录不存在 = 还没有 Mod，不是错误"）——
         *   于是"目录不存在"与"目录里有文件但被过滤掉了"在界面上长得**一模一样**
         *   （都是 0 个）。排查时没有任何线索。
         *
         *   ⇒ `IEML_DIAG_MODS=1` 时把**实际读的路径与结果**写到一个文件里。
         *     这是"读不到 ≠ 没有"（ADR-037）在**排查工具**上的落实：
         *     两种结论必须能被分开看见。
         */
        diag_mods(&format!(
            "scan_mods(instance_id={instance_id:?}, loader_kind={loader_kind:?}, mc_version={mc_version:?})\n\
             实际读的目录：{}\n\
             结果：目录**不存在或读不出来**（read_dir 失败）\n",
            dir.display()
        ));
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

    let out = mods::scan_mods(&files, loader_kind.as_deref(), &mc_version);
    diag_mods(&format!(
        "scan_mods(instance_id={instance_id:?}, loader_kind={loader_kind:?}, mc_version={mc_version:?})\n\
         实际读的目录：{}\n\
         目录里读到的文件（{} 个）：{:?}\n\
         扫描后的条目（{} 个）：{:?}\n",
        dir.display(),
        files.len(),
        files.iter().map(|f| f.file_name.clone()).collect::<Vec<_>>(),
        out.len(),
        out.iter().map(|e| e.file_name.clone()).collect::<Vec<_>>(),
    ));
    Ok(out)
}

/// 把 `scan_mods` 的诊断写进 `<own_root>/mods-diag.txt`。
///
///   ★★ 2026-09-30：**默认就写**（每次覆盖，几十字节）。
///
///   原来我用 `IEML_DIAG_MODS=1` 当开关，但那要求用户"用带环境变量的方式启动
///   这个 exe" —— 而他双击的是桌面快捷方式，**这个开关他根本开不到**。
///   一个用户碰不到的诊断开关，等于没有诊断。
///
///   代价是每次列 Mod 多写一个几十字节的文件。而它换来的是：
///   "Mod 列表为什么是空的"这个问题**能在用户自己的机器上被回答** ——
///   因为这条命令原来的两种结论（"目录不存在"与"目录里有文件但被过滤掉"）
///   在界面上长得一模一样（都是 0 个）。
fn diag_mods(text: &str) {
    let paths = crate::platform::AppPaths::resolve();
    let _ = std::fs::create_dir_all(&paths.own_root);
    let _ = std::fs::write(paths.own_root.join("mods-diag.txt"), text);
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
    /* ★ 启动耗时打点（见 `machine_info` 上面那段说明） */
    let t = std::time::Instant::now();
    let out = list_instances_inner(&state);
    say!("[IEML/boot] list_instances = {}ms", t.elapsed().as_millis());
    out
}

fn list_instances_inner(state: &AppState) -> Result<InstanceStore, String> {
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
     *
     * ★★★★ 2026-09-30（用户）：「**删除版本后，重启浏览器，删除的版本又会回来**」。
     *
     *   现在那个问题有答案了，而且当年那条"拿 slug 拼目录名"的错**也不再成立**：
     *   布局规范化之后，**目录名就是 `config.slug`**（一个版本一个文件夹）。
     *
     *   所以这里加了一条**有明确证据的**过滤 —— 但判据不是"目录在不在"，
     *   而是**墓碑**（`prefs.deletedVersions`：用户删过的版本目录名）。
     *   真机上的现状就是这条判据要治的病：
     *     · `prefs.json` 里躺着 `26.3-fabric-0.19.5-2` / `-3`（用户确实删过它们）；
     *     · `instances.json` 里那两条记录**还在** —— 于是列表照旧显示它们，
     *       角标也是按账本算的（所以"数字与实际不符"）。
     *
     *   ★ 为什么是墓碑、不是"目录不存在"：
     *     墓碑是**用户意图的记录**（他删过），而"目录不在"只是一时的事实
     *     （盘没挂上、权限、正在搬）。用前者删记录是"照用户说的做"，
     *     用后者删记录就是 2026-09-23 那次事故的复发。
     *   ★ 所以：**只滤墓碑**。它在 `prefs.json` 里，读它不需要任何猜测。
     */
    let mut store: InstanceStore =
        serde_json::from_str(&text).map_err(|e| format!("实例列表损坏：{e}（文件在 {}）", path.display()))?;
    let buried: std::collections::HashSet<String> = state
        .paths()
        .own_json("prefs.json")
        .and_then(|p| {
            p.get("deletedVersions")?
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.to_lowercase())
                        .collect()
                })
        })
        .unwrap_or_default();
    if !buried.is_empty() {
        let before = store.instances.len();
        // ★ 大小写无关：Windows 上 `Fabric-1` 与 `fabric-1` 是同一个目录
        store
            .instances
            .retain(|i| !buried.contains(&i.config.slug.to_lowercase()));
        if store.instances.len() != before {
            say!(
                "[IEML/instances] 按墓碑滤掉 {} 条已删除版本的记录（{} → {}）",
                before - store.instances.len(),
                before,
                store.instances.len()
            );
            // 指向被删实例的 active_id 也要清掉
            if let Some(active) = &store.active_id {
                if !store.instances.iter().any(|i| i.id == *active) {
                    store.active_id = None;
                }
            }
            /*
             * ★★ **把过滤后的结果写回文件**（2026-09-30）。
             *
             *   只过滤不落盘的话，`instances.json` 里那两条死人记录**永远在**：
             *   · 每次启动都要再滤一遍（白做功）；
             *   · 更要紧的是**任何"按账本算数"的地方都会算错** ——
             *     用户实测到的那条"版本列表的数字和实际数量不一样"就是它。
             *
             *   ★ 写回是安全的：这一步**只删墓碑里点名的那些**，
             *     判据来自用户自己的删除动作，不是我们的推测。
             *   ★ 用同一个原子写（临时文件 + 改名），与 `save_instances` 一致。
             */
            let path = state.paths().instances_file();
            if let Ok(text) = serde_json::to_string_pretty(&store) {
                let tmp = path.with_extension("json.tmp");
                match std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &path)) {
                    Ok(()) => say!("[IEML/instances] 已把清理后的账本写回 {}", path.display()),
                    Err(e) => say!("[IEML/instances] 清理后的账本写回失败（本次仅内存生效）：{e}"),
                }
            }
        }
    }
    Ok(store)
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

/// ★★ 删除一个版本的**整个目录**（版本 JSON / jar / 存档 / Mod / 配置 / natives 全在里面）。
///
/// 审计发现：`removeInstance` 以前只从内存列表里删掉记录，
/// 而三处确认框都写着「存档与配置会一起删除」—— **磁盘上什么都没删**，
/// 用户以为删干净了。现在给出真实能力，由前端在删除时调用。
///
/// ## ★★★★ 2026-09-30 修的严重缺陷：删的目标错了
///
///   这里原来是 `state.paths().instance_dir(&slug)` —— 那个函数返回的是
///   **`<版本目录>/.ieml/`**（启动器自己那层：natives、打包记录）。
///   于是"删除这个版本"实际删的是：
///     · `.ieml/` 里面那点启动器文件**没了**；
///     · **版本目录本身、连同存档与 Mod，一个都没删。**
///
///   用户报的正是它：「**删掉启动器的版本，资源管理器里的文件夹不会删除，
///   这个目录结构太奇怪了**」。而"删掉的版本又会回来"也与它同源：
///   目录一直在盘上，补认/合并就能再次把它变成一条记录。
///
///   ⇒ 目标改成 [`AppPaths::instance_root_dir`]（= `<版本目录>` 本身）。
///
///   ★ 为什么这个错在改造前不明显：老布局里游戏数据在 `<实例目录>/game/`，
///     而 `instance_dir` 至少还指在同一个实例目录底下（只差一层）。
///     改造后"游戏目录 = 版本目录"，而 `.ieml/` 只是它里面的一个子目录 ——
///     同一个调用点的语义**悄悄变了**，编译器一个字都不会说。
///
/// 安全：目录名来自实例的 slug，必须校验它落在版本目录下面
/// （挡住 `../` 之类的越界删除请求）。
///
/// ★ **默认进系统回收站**（`permanent = false`）。版本目录里有存档，
///   这是最不该"删错了就没了"的东西；确认要永久删除时前端按住 Shift 调用。
#[tauri::command]
pub async fn delete_instance_files(
    slug: String,
    permanent: Option<bool>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if slug.is_empty() {
        return Err("实例 slug 为空".into());
    }
    // ★ 校验留在命令这一层（同步、极快）；重活进后台线程
    let dir = checked_version_dir(&state, &slug)?;
    let permanent = permanent.unwrap_or(false);
    /*
     * ★ 整个"统计 + 删除"放进 `spawn_blocking`（见上面那一大段说明）。
     *   `.await` 会等它做完，但**主线程与 tokio worker 都不被占住** ——
     *   删除期间界面照样能响应（这正是用户要的"不卡顿"）。
     */
    let display = dir.display().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        delete_dir_blocking(&dir, permanent, "实例目录").map_err(|e| format!("{e}（{display}）"))
    })
    .await
    .map_err(|e| format!("删除任务没能启动：{e}"))?
}

/// ★★★★ **按版本目录名删除**（2026-09-30，用户：「**这个不可用版本无法删除**」）。
///
/// ## 为什么需要单独一条
///
///   原来的删除入口是 `removeInstance(inst.id)` —— 它要一条**账本记录**：
///   删的是"这个实例的目录"，还要把记录一起去掉。
///   而版本列表改成"盘上每个文件夹都列出来"（学 PCL）之后，出现了**没有记录**的行：
///   手动放进 `versions/` 的、装到一半失败的、账本记录被删过而目录还在的。
///   那些行**没有任何删除入口** —— 菜单里的动作全都挂在 `inst` 上。
///
///   ⇒ 这条命令只认**目录名**（`versions/<slug>`），不碰账本：
///     它就是"把这一坨文件处理掉"，与"这个版本有没有实例记录"无关。
///
///   ★ 为什么不让前端拼一条假记录再调 `removeInstance`：
///     那等于**为了删除先创建数据** —— 这个项目已经在"补记录"上栽过两次
///     （删掉的版本又回来、诈尸）。删除是一条只读不了的写操作，但它**不该先建东西**。
///
/// 安全：与 `delete_instance_files` 同一套越界校验（必须以 `versions/` 开头、
/// 且不能等于它本身）。
///
/// ★ **默认进系统回收站**：这些目录里可能有存档，而它们恰恰是"用户没怎么管过"的那些。
#[tauri::command]
pub async fn delete_version_dir(
    slug: String,
    permanent: Option<bool>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if slug.trim().is_empty() {
        return Err("版本目录名为空".into());
    }
    // ★ 与 `delete_instance_files` **同一份**越界校验（见 `checked_version_dir`）
    let dir = checked_version_dir(&state, &slug)?;
    let permanent = permanent.unwrap_or(false);
    /*
     * 与 `delete_instance_files` 同一个形状：重活进 `spawn_blocking`。
     * 用户报的"删除会让启动器卡顿"两条路径都走这里 —— 只修一条等于没修。
     */
    tauri::async_runtime::spawn_blocking(move || {
        delete_dir_blocking(&dir, permanent, "版本目录")
    })
    .await
    .map_err(|e| format!("删除任务没能启动：{e}"))?
}

/*
 * ★★★★ 2026-10-08（用户：「**删除版本的操作会使启动器变卡顿**」）。
 *
 *   ## 根因：同步命令 + 两件重活，全都压在主线程上
 *
 *   `delete_instance_files` / `delete_version_dir` 原来是 `pub fn`（**同步命令**），
 *   Tauri 的同步命令**跑在主线程**上。而它们各干两件重活：
 *
 *     ① `dir_size(&dir)` —— **递归遍历整棵目录树**，每个文件一次 `metadata`。
 *        整合包目录实测有几千个文件（mods + config + saves + 几千个资源），
 *        这一步就是**几万次系统调用**。
 *     ② `trash::delete` / `remove_dir_all` —— 真的把那几千个文件搬走/删掉，
 *        不是回收站还好，进回收站还要跨卷搬运。
 *
 *   ⇒ 这几秒里主线程被占住，界面**完全不动** —— 用户看到的就是"删除会让启动器卡顿"。
 *
 *   ## 为什么改成 `async` 就够了（而不是自己开线程）
 *
 *   Tauri 2 里 `pub async fn` 标记的命令**不在主线程执行**，而是交给异步运行时
 *   的线程池。所以"把 `pub fn` 改成 `pub async fn`"本身就解开了主线程。
 *   ★ 但还不够：`dir_size` 与 `trash::delete` 都是**阻塞**调用，
 *     直接在 async 里调会占住 tokio 的 worker（worker 数量有限，
 *     几个大删除就能把整个异步运行时堵住 —— 那时别的命令**也会一起卡**）。
 *   ⇒ 真正该做的是把阻塞那一段扔进 `spawn_blocking`：
 *     它给的是**专用于阻塞任务的线程池**，堵住它不影响别的命令。
 *
 *   ## 顺带：为什么返回值仍然要"删了多少字节"
 *
 *   那个数只为了给用户看一句"磁盘上释放了 X"。它**不值得**让界面卡 3 秒 ——
 *   所以统计与删除一起放进 blocking 段（同一次遍历的开销远小于两次）。
 */

/// 删除的**阻塞部分**：统计大小 → 删除。返回释放的字节数。
///
/// ★ 抽成一个纯函数是为了让 `spawn_blocking` 能整段搬走，
///   也为了"越界校验"留在命令那一层（那是**参数校验**，不该进后台线程）。
fn delete_dir_blocking(dir: &std::path::Path, permanent: bool, what: &str) -> Result<u64, String> {
    if !dir.is_dir() {
        return Ok(0); // 目录本来就不在 —— 不算错误
    }
    // 统计一下删了多少字节，让前端能如实报告
    let bytes = dir_size(dir);
    if permanent {
        std::fs::remove_dir_all(dir).map_err(|e| format!("永久删除{what}失败：{e}"))?;
    } else {
        // ★ 进回收站：存档还能捞回来
        trash::delete(dir).map_err(|e| {
            format!(
                "移到回收站失败（{e}）—— 这个位置可能没有回收站；\
                 确认要永久删除的话，按住 Shift 再点一次删除"
            )
        })?;
    }
    Ok(bytes)
}

/// 版本目录的越界校验（两条删除命令共用一份实现）。
///
/// ★ 必须**只有一份**：这个判据一旦两处不一致，就有一条路会删到 `versions/`
///   之外 —— 而那是不可逆的。返回解析后的目标路径。
fn checked_version_dir(
    state: &AppState,
    slug: &str,
) -> Result<std::path::PathBuf, String> {
    let root = state.paths().instances.clone();
    let dir = state.paths().instance_root_dir(slug);
    // 越界校验：解析后的路径必须以 versions/ 开头，且不等于它本身
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canon_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if canon_dir == canon_root || !canon_dir.starts_with(&canon_root) {
        return Err(format!(
            "拒绝删除：{} 不在版本目录下（versions/）",
            dir.display()
        ));
    }
    Ok(dir)
}

/// 递归统计目录大小（**阻塞**，只在 `spawn_blocking` 里调）。
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

    /*
     * ★★ 2026-09-30（布局改成"一个版本一个文件夹"）：**启动器自己那层不复制**。
     *
     *   它现在整个是 `<版本目录>/.ieml/`（natives / 打包记录 / 包内被移除文件的
     *   回收区）。理由与原来那句"natives 不复制"一样，而且更强：
     *     · `natives` 会在启动时按当前架构重新解压 —— 复制过来多半是错的；
     *     · `pack-record.json` 是**那个实例**的整合包身份，复制过来会让副本
     *       自称是同一个整合包，于是"检查更新"会拿错的清单去比。
     *   所以整层跳过，副本从一个干净的 `.ieml/` 开始。
     *
     * ★ 兼容那一行老名字：万一还有老布局的实例目录（顶层 `natives/`），也别复制。
     */
    let skip = [platform::LAUNCHER_SUBDIR, "natives"];
    for entry in std::fs::read_dir(&src).map_err(|e| format!("读取源目录失败：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if skip.contains(&name.as_str()) {
            continue;
        }
        /*
         * ★ 老布局的 `game/`：新布局里**没有这一层**（游戏数据直接在版本目录里），
         *   所以正常情况下走不到这里。留着是为了万一遇到尚未迁移的目录时
         *   行为不乱（`copy_game_dir=false` 时不再凭空造一个空 `game/` ——
         *   那会让副本看起来"有游戏目录、里面什么都没有"）。
         */
        if name == "game" && !copy_game_dir {
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

/* ====================== 实例备份与回滚（ADR-014） ====================== */

/*
 * 这一组命令**很薄**：真正的规则（备份范围、jar 不进备份、回滚前先备份、
 * 滚动保留、越界拒绝）都在 `crate::backup` 里，那里有 8 条单测钉着。
 * 这里只做三件事：取路径、拿当前时间、把结果原样交给前端。
 */

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 这个实例有哪些备份（新的在前）
#[tauri::command]
pub fn backup_list(
    slug: String,
    state: State<'_, AppState>,
) -> Vec<crate::backup::BackupManifest> {
    crate::backup::list(&state.paths(), &slug)
}

/// 手动做一份备份，并按保留份数滚动清理。
///
/// `reason` 会原样显示给用户（`手动` / `启动前自动` / `回滚前自动`）——
/// 界面上要能看出"这一份是谁触发的"，否则时间线里五份备份长得一模一样。
#[tauri::command]
pub async fn backup_create(
    slug: String,
    name: String,
    mc_version: Option<String>,
    reason: Option<String>,
    keep: Option<usize>,
    state: State<'_, AppState>,
) -> Result<crate::backup::BackupManifest, String> {
    if slug.trim().is_empty() {
        return Err("实例 slug 为空".into());
    }
    // ★ 先克隆一份路径（`paths()` 返回 Arc 的克隆）——**不跨 await 持任何锁**
    let paths = state.paths();
    let m = crate::backup::create(
        &paths,
        &slug,
        &name,
        mc_version.as_deref().unwrap_or(""),
        reason.as_deref().unwrap_or("手动"),
        now_secs(),
    )
    .await?;
    // ★ 保留份数的规矩在 `crate::backup::prune` 里；这里把**刚做的那一份**钉住，
    //   免得保留数被设成 0 时"做完就删"。
    let keep = keep.unwrap_or(crate::backup::DEFAULT_KEEP);
    let removed = crate::backup::prune(&paths, &slug, keep.max(1), &[m.id.clone()]);
    if !removed.is_empty() {
        crate::say!(
            "[IEML/backup] 滚动保留：清掉 {} 份旧备份 {:?}",
            removed.len(),
            removed
        );
    }
    Ok(m)
}

/// 从一份备份回滚（**先自动备份当前状态**，见 `crate::backup::restore`）
#[tauri::command]
pub async fn backup_restore(
    slug: String,
    name: String,
    mc_version: Option<String>,
    id: String,
    keep: Option<usize>,
    state: State<'_, AppState>,
) -> Result<crate::backup::RestoreReport, String> {
    if slug.trim().is_empty() {
        return Err("实例 slug 为空".into());
    }
    let paths = state.paths();
    crate::backup::restore(
        &paths,
        &slug,
        &name,
        mc_version.as_deref().unwrap_or(""),
        &id,
        keep.unwrap_or(crate::backup::DEFAULT_KEEP),
        now_secs(),
    )
    .await
}

/// ★★ **回滚之前先算差异**（ADR-014 的 UI 要求：预览差异，再确认回滚）。
///
/// 只读：不动任何文件。界面拿它把"会覆盖多少、会新增多少、保留多少、
/// 哪些 Mod 会移走、哪些 Mod 不在盘上"如实说给用户，再让他决定。
#[tauri::command]
pub fn backup_preview(
    slug: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<crate::backup::RestorePreview, String> {
    crate::backup::preview_restore(&state.paths(), &slug, &id)
}

/// 删掉一份备份（只删自己认得的那种目录，见 `crate::backup::remove`）
#[tauri::command]
pub fn backup_remove(slug: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    crate::backup::remove(&state.paths(), &slug, &id)
}

/// 打开备份目录（没有传 `id` 就打开这个实例的备份总目录）
#[tauri::command]
pub fn backup_open_folder(
    slug: String,
    id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let base = crate::backup::backups_root(&state.paths(), &slug);
    let dir = match id.filter(|s| !s.trim().is_empty()) {
        Some(id) => {
            // ★ 越界防护与 `crate::backup::remove` 同一套：id 只允许是单层目录名
            if id.contains('/') || id.contains('\\') || id.contains("..") || id.contains(':') {
                return Err("备份 id 不合法".into());
            }
            base.join(id)
        }
        None => base.clone(),
    };
    std::fs::create_dir_all(&dir).ok();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开目录：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
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
