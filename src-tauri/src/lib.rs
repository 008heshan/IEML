//! IEML 启动器 —— 库入口
//!
//! 架构（与 docs/ARCHITECTURE.md 对应）：
//!   * `domain`   —— 纯规则，无 I/O。与前端 `src/domain/*.ts` 一一对应，
//!                   任何一边改了规则，另一边必须同步（有测试守着）。
//!   * `commands` —— Tauri 命令层，前端通过 invoke 调用，**不含业务规则**。
//!   * `platform` —— 平台相关：Java 探测、目录、进程管理。
//!   * `launch`   —— 启动流程与日志抓取。
//!
//! 铁律：**校验逻辑只实现一次**。前端 UI 的置灰/桥接提示/API 补全
//! 全部是本 crate 结论的呈现，前端不得自己维护一份规则。

/* ★★ 诊断输出的唯一出口（`say!`）。必须**排在最前**：`#[macro_use]` 要求宏
   在被使用的模块之前定义 —— 而这个 crate 里几乎每个模块都在打印。
   为什么不能直接用 eprintln!：它写失败会 panic，而 release 是 panic=abort，
   于是"日志管道断了"会直接崩掉启动器（2026-09-20 实测 3/3 稳定复现）。 */
#[macro_use]
pub mod logx;
pub mod auth;
pub mod commands;
pub mod commands_real;
pub mod domain;
pub mod game;
pub mod launch;
pub mod modloader;
pub mod modrinth;
pub mod net;
pub mod platform;

use std::collections::HashMap;
use std::sync::Mutex;

/// 应用全局状态
pub struct AppState {
    pub paths: platform::AppPaths,
    /*
     * ★★ 正在运行的游戏进程：**按实例 id 索引的一张表**（2026-09-15，多开实例）。
     *
     *   以前这里是 `Mutex<Option<RunningGame>>` —— 一个槽。于是"同时开两个版本"
     *   在**三个层面**都被挡住：后端拒绝、前端状态只装得下一个、
     *   界面上的按钮也只为"那一个"设计。
     *
     *   为什么用 HashMap 而不是 Vec：**同一条判据只写一遍** ——
     *   "这个实例在不在跑"是 `contains_key`，"哪几个在跑"是遍历，
     *   "停哪一个"是 `remove`。用 Vec 就得在每个调用点各写一遍查找。
     *
     *   键是 `instance_id`（不是 slug、不是目录名）：退出事件、日志文件名、
     *   前端的实例表都认它，**一处对齐处处对齐**。
     */
    pub running: Mutex<HashMap<String, launch::RunningGame>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {    /*
     * ★★ 让 Windows **认识这个程序是「IEML」**（用户要求：
     *    「我在任务管理器里找不到 IEML，但它必须像一个正常软件那样」）。
     *
     *    `SetCurrentProcessExplicitAppUserModelID` 是 Windows 用来给
     *    "一个应用"命名的官方机制。不设它的时候，任务管理器/任务栏只能靠
     *    进程名（`ieml.exe`）和 exe 里的 FileDescription 猜；
     *    设了之后，系统把它当成一个**有身份的应用**：
     *      · 任务管理器里显示的是这个 id 对应的名字，而不是进程名
     *      · 任务栏图标会正确分组（不会再和 WebView2 的子进程混在一起）
     *      · 托盘/通知的来源显示正确
     *
     *    名字必须与 `tauri.conf.json` 的 `identifier` 一致 ——
     *    那是 Tauri 为整个应用登记的标识，两处不一致等于没说。
     */
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let id: Vec<u16> = std::ffi::OsStr::new("com.ieml.launcher")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        #[link(name = "shell32")]
        extern "system" {
            fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
        }
        unsafe {
            let hr = SetCurrentProcessExplicitAppUserModelID(id.as_ptr());
            if hr < 0 {
                say!("[IEML] 设置 AppUserModelID 失败（hr={hr:#x}）—— 不影响功能");
            }
        }
    }

    let paths = platform::AppPaths::resolve();

    request_high_performance_gpu();

    /*
     * ★★ **本根目录自己的布局迁移必须排在最前**（0.1.0-beta.3 实测踩到的一个真 bug）。
     *
     *   现场：我先把"老数据根 → 新数据根"的补齐循环放在了前面，结果那次启动
     *   把 `%APPDATA%\IEML\shared`（几个月前留在 C 盘的旧数据，6754 个文件 /
     *   1079 MB）**复制**进了 `D:\IEML\.minecraft\` —— 而真正的数据还在
     *   `D:\IEML\shared\` 里没动。后一条迁移看到 `.minecraft` 已经"有东西"，
     *   按它自己的规矩跳过（那是**对的**，它不能去猜）→ 用户下次打开就会看到
     *   "我的版本都不见了"。
     *
     *   所以顺序是**硬要求**，写在这里免得以后被"整理代码"挪走：
     *     ① 本根：`shared/` → `.minecraft/`（同卷改名，秒完成，用的是真数据）
     *     ② 跨根：老根缺什么补什么（此时 `.minecraft` 已经是真数据，
     *        补齐只会填空，不会覆盖）
     */
    match platform::migrate_shared_into_game_dir(&paths.root) {
        Ok(Some(p)) => say!(
            "[IEML/paths] 游戏数据已挪到 {}（PCL 同款布局：数据目录内的 .minecraft）",
            p.display()
        ),
        Ok(None) => {}
        Err(e) => say!(
            "[IEML/paths] 游戏数据挪进 .minecraft 失败（{e}）—— \
             本次仍按原路径读写，数据没有丢；下次启动会再试一遍"
        ),
    }

    /*
     * ★★ 数据目录选址 + **一次性搬家**（用户要求"数据目录应该默认避开系统盘"）。
     *
     *   为什么必须在这里做（而不是等用户去设置页点）：
     *   老用户的数据在 `%APPDATA%\IEML`（系统盘）。如果只是把**新装**的
     *   数据放到 D:，那老用户会变成"一半在 C: 一半在 D:"——
     *   共享库与实例分家，既占双份空间，又让"这个实例的文件在哪"变成
     *   一个要查的问题。所以选址之后立刻把老数据**复制**过去。
     *
     *   为什么是复制不是移动：搬到一半断电/被杀，用户不能同时失去两边。
     *   复制成功才在记录里写新地址（见 `platform::resolve_data_root`），
     *   源目录原样留着，用户确认没问题后自己删。
     *
     *   失败不阻断启动：搬不动（磁盘满 / 权限）时继续用旧位置，
     *   但不能静默 —— 打印出来，且 `machine_info` 会显示真实的数据目录。
     */
    for old in platform::legacy_data_roots() {
        if old == paths.root {
            continue;
        }
        if !old.is_dir() {
            continue;
        }
        match platform::migrate_data_root(&old, &paths.root) {
            Ok(0) => {}
            Ok(bytes) => say!(
                "[IEML/paths] 数据目录已搬到 {}（复制了 {:.1} MB）。\
                 原目录 {} 仍然保留，确认新位置没问题后可以自己删掉。",
                paths.root.display(),
                bytes as f64 / 1024.0 / 1024.0,
                old.display()
            ),
            Err(e) => say!(
                "[IEML/paths] 数据目录搬家失败（{e}）—— 本次继续使用 {}",
                paths.root.display()
            ),
        }
    }

    if let Err(e) = paths.ensure() {
        say!("[IEML/paths] 创建数据目录失败：{e}（{}）", paths.root.display());
    }
    /*
     * ★★ 2026-09-22：启动器**自己的**目录单独一段（`ensure_own`）。
     *
     *   拆开的理由见 `AppPaths::ensure` 的说明（用户要求"根目录只创建装游戏的目录"）。
     *   ★ 现在仍然在启动时一起建 —— 因为版本、Java、缓存、日志都还住在这个根目录里，
     *     不建就会在第一次用到时报错。
     *     **把启动器数据整体搬出游戏根目录**（比如搬到 %APPDATA%）是一次数据布局迁移，
     *     会影响所有既有安装 —— 那一步需要用户明确同意后再做，不在这一轮里擅自做。
     */
    if let Err(e) = paths.ensure_own() {
        say!("[IEML/paths] 创建启动器目录失败：{e}（{}）", paths.root.display());
    }

    /*
     * ★ 把"现在用的这个目录"记进**用过的游戏文件夹**列表（PCL 那张「文件夹列表」）。
     *
     *   为什么在启动时也记一次（而不只在用户换目录时记）：老用户升级上来时
     *   列表是空的 —— 而他现在用的这个目录显然该在里面，否则那张表第一眼
     *   就是"什么都没有"。顺手也给 `%APPDATA%\IEML`（老位置）留一条，
     *   只要它还在。
     */
    platform::remember_root(&paths.root);
    for old in platform::legacy_data_roots() {
        if old.is_dir() {
            platform::remember_root(&old);
        }
    }

    // 元数据缓存目录（版本清单/加载器列表，避免每次联网重拉）
    net::metadata::set_cache_dir(paths.cache.clone());

    /*
     * ★ 载入正版登录用的 client_id（用户在设置页填过一次就该长期有效）。
     *   必须在任何登录命令被调用**之前**发生 —— 它就发生在这里。
     */
    auth::load_client_id_from_disk(&paths);

    /*
     * ★★ 载入**你填过的** CurseForge API Key（ADR-052）。
     *
     *   内置了一把（拿到 exe 就能用），这个文件是"用户自己的那把"——
     *   存在就覆盖内置值。同样必须在任何网络命令之前发生。
     */
    net::curseforge::load_api_key_from_disk(&paths);

    tauri::Builder::default()
        /*
         * ★★ 单实例（用户 2026-09-20）：「**当 IEML 正在运行时，如果再次双击快捷方式，
         *   我希望能调起正在运行的 IEML，而不是打开一个新的**」。
         *
         *   为什么必须做（不只是"体验问题"）：
         *     · 两个启动器同时写 `instances.json` 与 `prefs.json`，后写的会把先写的**整份覆盖**；
         *     · 同一份游戏目录被两个界面同时读改（Mod 管理 / 清理缓存），看着都"成功"。
         *
         *   ★ 这个插件必须**第一个注册**（它要在 setup 阶段就决定"我是第几个"）。
         *   ★ 激活那一步是插件替我们铺好的：第二个实例在退出前会先
         *     `AllowSetForegroundWindow(第一个实例的 pid)`，把"置前台"的权利交出去 ——
         *     否则第一个实例调 `set_focus()` 只会让任务栏闪一下（Windows 的抢焦点限制）。
         *
         *   ★ 顺序说明（如实记）：`run()` 里在建 Builder **之前**还有一段
         *     数据目录选址 + 一次性搬家的代码，所以第二实例会先跑完那段才退出。
         *     那些操作是幂等的（搬家用"绝不覆盖"语义），代价是几十毫秒，不值得
         *     为它把整段启动逻辑挪进 setup。
         */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                // 三步都要：可能被最小化、可能被隐藏（自绘标题栏没有托盘，但留着不亏）
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            paths,
            running: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            /* -------- 领域规则（前端只呈现结论，规则在这里） -------- */
            commands::app_info,
            commands::machine_info,
            commands::scan_java,
            commands::remove_java,
            commands::loader_capabilities,
            commands::validate_combination,
            commands::memory_targets,
            commands::auto_memory,
            commands::resolve_java,
            commands::resolve_isolation,
            commands::build_install_plan,
            commands::scan_mods,
            commands::analyze_crash,
            commands::redact_report,
            commands::list_instances,
            commands::save_instances,
            /* -------- 全局偏好与实例文件（审计补：以前设置与登录重启就丢） -------- */
            commands::load_prefs,
            commands::save_prefs,
            commands::delete_instance_files,
            /* ★ 复制实例目录（审计补：以前"创建副本"只克隆记录、不建目录） */
            commands::copy_instance_files,
            commands::installed_versions,
            /* -------- 真实网络：版本清单与加载器 -------- */
            commands_real::fetch_version_manifest,
            commands_real::fetch_version_json,
            commands_real::fetch_loaders,
            /* -------- 盘上到底装了什么（实时探测，不缓存结论） -------- */
            commands_real::detect_installed_loaders,
            /* -------- 可安装的加载器清单（五种并行拉取，含 OptiFine） -------- */
            commands_real::fetch_available_loaders,
            /* -------- Modrinth -------- */
            commands_real::modrinth_search,
            commands_real::modrinth_project,
            commands_real::modrinth_versions,
            commands_real::modrinth_versions_by_hash,
            commands_real::install_mod,
            /* ★★ 社区资源子系统：Mod / 资源包 / 光影 / 数据包共用一套抽象 */
            commands_real::resource_kinds,
            commands_real::resource_search,
            /* ★ 取"兼容当前实例的版本"（两个源共用一条命令，ADR-052） */
            commands_real::resource_versions,
            /* ★★ CurseForge 的 key（内置一把 + 设置页可覆盖，ADR-052） */
            commands_real::cf_key_status,
            commands_real::cf_set_key,
            commands_real::cf_test_key,
            commands_real::install_resource,
            /* ★ API 前置包自动安装（Fabric API / QFAPI）—— 以前只承诺、没实现 */
            commands_real::install_api_library,
            /* ★ 前置包在不在？（老实例/装失败时可以随时检查并补装） */
            commands_real::check_api_library,
            /* ★★ OptiFine 自动安装（真的跑它的 Patcher，见 net::optifine） */
            commands_real::install_optifine,
            /* ★★ LiteLoader 自动安装（写版本 JSON + 下依赖，见 net::liteloader） */
            commands_real::install_liteloader,
            /* ★★ 真正的暂停（不再等于取消）—— 见 download::PauseToken 的说明 */
            commands_real::pause_install,
            commands_real::resume_install,
            commands_real::set_mod_enabled,
            commands_real::delete_mods,
            /* ★ Mod 列表：读盘 + 哈希反查在线库（不是靠文件名猜） */
            commands_real::scan_mods_detailed,
            commands_real::check_mod_updates,
            /* -------- Java 运行时 -------- */
            commands_real::java_query,
            commands_real::java_install,
            commands_real::java_list_downloaded,
            /* -------- 真实安装（下载引擎） -------- */
            commands_real::plan_install,
            commands_real::install_version,
            commands_real::cancel_task,
            commands_real::verify_version,
            commands_real::download_sources,
            /* ★ 清理没有任何版本引用的共享库与资源（审计补：以前只弹"后续版本提供"） */
            commands_real::clean_unused_files,
            /* ★ 清理**可再生**的东西（安装器 / 元数据缓存 / 旧启动日志）——
               判据与上面那条不同（那是"没人引用的游戏文件"，这是"删了会自己回来"），
               所以是两条命令，见 `clean_caches` 的注释 */
            commands_real::clean_caches,
            /* -------- 真实启动 -------- */
            commands_real::preview_launch,
            commands_real::launch_minecraft,
            commands_real::stop_minecraft,
            commands_real::running_games,
            commands_real::read_latest_log,
            commands_real::open_instance_folder,
            /* ★ 设置页的「打开数据目录」走这条 —— 前端的 opener 插件
               因为 scope 白名单为空，调 openPath 必然被拒（见命令注释）。 */
            commands_real::open_data_dir,
            /* ★ 新建 / 切换游戏根目录（只记录选择，重启后生效；旧的目录不动） */
            commands_real::set_data_root,
            /* ★ 用过的游戏文件夹列表（PCL 那种「文件夹列表」，只读） */
            commands_real::list_data_roots,
            /* ★ 忘掉一个文件夹（只动那张列表，不碰磁盘上的东西） */
            commands_real::forget_data_root,
        commands_real::instance_health,
        commands_real::delete_data_root,
            /* -------- 账号 -------- */
            /* ★★ 正版登录的可用性（client_id 配没配）+ 配置入口 */
            commands_real::ms_login_status,
            commands_real::ms_set_client_id,
            commands_real::account_offline,
            commands_real::account_start_login,
            commands_real::account_poll_login,
            commands_real::account_load,
            commands_real::account_current,
            /* ★ 正版皮肤：照 PCL 走 Mojang 官方（不经过第三方头像站） */
            commands_real::account_skin,
        commands_real::account_upload_skin,
        commands_real::account_capes,
        commands_real::account_set_cape,
        commands_real::account_save_skin,
            commands_real::account_remove,
            commands_real::account_refresh,
            /* -------- 整合包 -------- */
            commands_real::mrpack_inspect,
            /* ★ 真正安装整合包（清单 → 本体+加载器 → Mod → overrides） */
            commands_real::modpack_install,
            /* -------- 杂项 -------- */
            commands_real::backend_capabilities,
        ])
        /*
         * ★★ 启动期源延迟探测（ADR-057「国内优先 + 实测延迟决定次序」）。
         *
         *   为什么必须**后台 spawn、绝不 await**：
         *   探测最坏要 4 秒（三个端点并发 + 4 秒超时）。如果在这里等它，
         *   用户就会看到"启动器卡了 4 秒"。而探测的价值只是**调整候选顺序** ——
         *   拿不到结果时 `SourceManager` 会沿用默认序（国内优先），
         *   所以"这次没探到"是完全可接受的退化，不值得拿启动时间来换。
         *
         *   探测结论 10 分钟后过期（`probe::PROBE_TTL`），届时自动退回
         *   纯健康分排序 —— 不会拿一次旧结论一直压着。
         */
        .setup(|_app| {
            tauri::async_runtime::spawn(async {
                net::probe::refresh_global().await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("IEML 启动失败");
}

/// 请 WebView2 用**高性能 GPU**（也就是用户那块 4G 显存的独显）。
///
/// ★ 为什么必须在**创建 WebView2 之前**做：GPU 适配器在 WebView2 起来的那一刻
///   就选定了，跑起来之后改不了（所以只能启动时定，界面上切档改不了它）。
///
/// ★ 为什么不用 Windows 的「图形性能首选项」注册表那条路：
///   它得按**带版本号的**运行时路径写
///   （`…\EdgeWebView\Application\153.0.4234.48\msedgewebview2.exe`），
///   WebView2 一升级就失效；而且那是**机器级**设置，会影响**所有** WebView2 应用。
///   本机实测（CDP 的 SystemInfo）：只写 IEML.exe 那条**没有任何效果**
///   （GPU 工作在 msedgewebview2.exe 那个进程里），而 `--force_high_performance_gpu`
///   是应用自带的开关 —— 升级不受影响，也不动别人的设置。
///
/// ★★ 2026-09-22（第五轮）：**三个档位都开**。用户原话是
///   「**3 个视效模式都应用 GPU 强制渲染吧**」——
///   上一版只在灵动档开（当时想的是省笔记本的电），既然用户要一致，就一律开。
///   没装独显的机器上这个开关是无害的（Chromium 自己会忽略；
///   核显/软渲染本来也跑不动灵动档，那条路由能力探测挡着）。
fn request_high_performance_gpu() {
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let cur = std::env::var(KEY).unwrap_or_default();
    if cur.contains("force_high_performance_gpu") {
        return; // 已经有了（例如真机测试脚本自己带上了 CDP 开关）
    }
    let next = if cur.trim().is_empty() {
        "--force_high_performance_gpu".to_string()
    } else {
        format!("{cur} --force_high_performance_gpu")
    };
    std::env::set_var(KEY, next);
    say!("[IEML/glass] 已请求高性能 GPU（独显）渲染（三个视效档一致）");
}