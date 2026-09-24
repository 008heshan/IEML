/**
 * Tauri 真实后端
 * ------------------------------------------------------------------
 * 与 web.ts 实现同一个 Backend 接口，但所有 I/O 都走 Rust：
 *   * 真实的版本清单（Mojang / BMCLAPI）
 *   * 真实的下载引擎（流式 + SHA1 + 断点续传 + 多源兜底）
 *   * 真实的启动（拼 classpath / JVM 参数 / 解压 natives）
 *   * 真实的 Java 自动获取（Adoptium）
 *   * 真实的微软登录（设备代码流 + 系统密钥环）
 *
 * 与旧版 `tauri.ts` 的区别：那个版本很多命令在 Rust 侧还不存在，
 * 靠前端 domain 回退；现在 Rust 侧全部实现了，直接调用、不再回退。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Instance, JavaRuntime } from '../domain';
import type { Backend, BackendInfo, LaunchResult } from './types.ts';

/* ====================== 类型 ====================== */

/**
 * 盘上真实存在的一个加载器 / 附加组件。
 *
 * 由 Rust 侧每次读盘得出（`detect_installed_loaders`），**不做任何缓存** ——
 * 界面上显示的"装了 Forge 47.4.23"必须就是磁盘上的事实。
 *
 * ★ 字段名与 `domain::loader_trace::InstalledModLoader` 一致（ADR-036：透传契约
 *   必须两侧同名）。检测逻辑**含 `inheritsFrom` 递归**：只读自己那一份会漏报。
 */
export interface InstalledLoader {
  /** `forge` / `neoforge` / `fabric` / `quilt` / `optifine` / `liteloader` */
  loader_type: string;
  /** 面向用户的名字（Forge / OptiFine …） */
  name: string;
  /** 加载器自身版本；**读不出来时是 `"unknown"`**（不是空串，也不编造） */
  version: string;
  /** 是不是基础加载器（附加组件为 false） */
  is_base: boolean;
  /**
   * ★★ **还有没有版本（实例）在用它**。
   *
   * `undefined` = 调用方没做这项标注（检测逻辑本身不知道实例，那要读 I/O）。
   *
   * ## 为什么必须有这个字段（用户报的 bug）
   *
   * 用户原话：「版本列表删除有模组加载器的版本之后，下载列表的对应版本
   * 有模组加载器的版本，**还显示已装**」。
   *
   * 因为两张表读的是**两个不同的东西**：
   *   · 「版本列表」= `instances.json`（用户建的版本）
   *   · 「下载」页   = 直接扫 `shared/versions/`（盘上有什么）
   *
   * 删实例只删 `instances/{slug}/`（存档 / Mod / 配置），
   * **共享的游戏文件**（`shared/versions/`、`libraries/`）故意留着 ——
   * 多个实例可能共用同一份，删了会把别人的游戏弄坏。
   * 于是下载页照旧扫到那个加载器目录，继续显示"已装"。
   *
   * 两句话都对，但合在一起就是界面在骗人：
   * 「已装」让人以为**可以用**，而它其实没有任何版本在用。
   */
  in_use?: boolean;
}

/** 一个可安装的 OptiFine 版本（含它的 Forge 兼容要求） */
export interface OptifineVersion {
  /** 面向用户的版本号，如 `HD U I6` / `HD U I6 pre4` */
  version: string;
  filename: string;
  /** 预览版（`pre*`）—— 界面要标出来，用户得知道它不是正式版 */
  preview: boolean;
  /** 兼容的 Forge 要求；null = 无要求 / 不适用 */
  required_forge: string | null;
}

/**
 * 一种加载器的可安装版本清单。
 *
 * ★ `error` 字段是这套结构存在的理由（ADR-037）：
 *   「没查到」与「确认没有」必须分开。`error` 有值 = 这次没查到，
 *   界面只能说"可重试"；`error` 为空且 `versions` 为空 = 确认这个 MC 版本没有它。
 */
export interface LoaderVersions {
  kind: string;
  name: string;
  /** 降序（最新在前） */
  versions: string[];
  /** 没查到的原因；null = 这次查询成功了 */
  error: string | null;
  /** 是不是基础加载器（OptiFine 是附加组件） */
  is_base: boolean;
  /** 仅 OptiFine：每个版本的文件名与 Forge 兼容要求 */
  optifine?: OptifineVersion[];
}

/** 一个 MC 版本可安装的全部加载器与附加组件（五种来源**并行**拉取） */
export interface AvailableLoaders {
  mc_version: string;
  base: LoaderVersions[];
  addons: LoaderVersions[];
}

/* ==================== ★★ 社区资源子系统 ==================== */

/**
 * 社区资源的种类。
 *
 * ★ 与 Rust 侧 `domain::resources::ResourceKind` **一一对应**。
 *   数据包在 Modrinth 上不是一种 `project_type`（实测：查 `datapack`
 *   返回的是 mod），它靠 `categories:datapack` 区分 —— 那一层由后端做，
 *   前端只需要说"我要数据包"。
 */
export type ResourceKindName = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

/**
 * ★★ 社区资源的两个来源（ADR-052）。
 *
 * | 源 | 查到什么 | 能不能装 |
 * |---|---|---|
 * | `modrinth` | 项目 + 版本 + SHA1 | 能（有官方 CDN） |
 * | `curseforge` | 项目 + 文件 + SHA1 + 指纹 | 能，除非**作者禁止第三方分发**（`distribution_allowed === false`） |
 *
 * 两个源的结果在**后端映射成同一个形状**，所以界面不需要为来源写两套渲染。
 */
export type ResourceSourceName = 'modrinth' | 'curseforge';

/** CurseForge API Key 的状态（`source` 说明它从哪来，不许含糊） */
export interface CfKeyStatus {
  configured: boolean;
  /** `settings`（你填的）/ `env`（环境变量）/ `builtin`（随程序内置）/ `none` */
  source: 'settings' | 'env' | 'builtin' | 'none' | string;
  /** 只显示前缀，不泄漏整把 key */
  hint: string | null;
}

/** 一种资源的描述（后端给，界面**不要**自己再写一张表） */
export interface ResourceKindInfo {
  key: ResourceKindName;
  /** 面向用户的名字（Mod / 资源包 / 光影 / 数据包） */
  display: string;
  /** 装到实例的哪个子目录（相对**游戏目录**，不是实例目录） */
  install_dir: string;
  extensions: string[];
  /** 要不要挑加载器（决定界面显不显示加载器筛选） */
  needs_loader_filter: boolean;
  /** 装完要额外说的话（数据包要拖进世界、光影需要 Iris/OptiFine） */
  install_note: string | null;
}

export interface ManifestRow {  id: string;
  release_type: string;
  released_at: string;
  /** 盘上有这个版本的游戏文件（**不等于**"有版本在用"） */
  installed: boolean;
  /**
   * ★★ **还有没有版本（实例）在用这个 MC 版本**。
   *
   * 与 `installed` 是两件事：删掉实例之后 `installed` 仍为真
   * （共享的游戏文件被故意留着，别的实例可能还在用），而这里变假。
   * 界面必须把两句话说清 —— 只说"已装"就是在骗人。
   */
  in_use?: boolean;
  /** ★ 这一行版本在盘上实际装了哪些加载器（实时读盘的事实） */
  loaders?: InstalledLoader[];
}

export interface ManifestSummary {
  latest_release: string;
  latest_snapshot: string;
  count: number;
  versions: ManifestRow[];
}

export interface VersionDetail {
  id: string;
  release_type: string;
  main_class: string;
  libraries: number;
  asset_index: string | null;
  java_major: number | null;
  client_bytes: number | null;
  has_arguments: boolean;
  legacy_arguments: boolean;
}

/**
 * 加载器版本清单。
 *
 * ★ `status` 是这套数据结构存在的理由（用户报的 bug）：
 *   过去后端返回裸数组，"查不到"与"确认没有"都表现为空数组，
 *   前端只能把空数组当成"这个 MC 版本没有 Forge"，于是 Forge 明明有最新版，
 *   界面却把 Forge 置灰并写"没有 Forge 版本"。
 *   现在两种情况分开：
 *     · `status === 'ok'`    → 清单可信，`versions` 为空才是真的"没有"
 *     · `status === 'error'` → **没查到**，界面只能说"查询失败，可重试"
 */
export interface LoaderList {
  kind: string;
  name: string;
  mc_version: string;
  status: 'ok' | 'error';
  /** 降序（最新在前） */
  versions: string[];
  error: string | null;
  recommended: string | null;
}

export interface LoaderRow {
  version: string;
  stable: boolean;
}

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  project_type: string;
  downloads: number;
  icon_url: string | null;
  versions: string[];
  author: string;
  /**
   * ★ CurseForge 专有：`false` = **作者不允许第三方分发**，我们下不了。
   *
   * `null` / `undefined` = 不适用（Modrinth 没有这个概念）——
   * 界面必须把"不适用"与"被作者拒绝"分开说，否则会把 Modrinth 的
   * 正常结果说成"作者不允许"。
   */
  distribution_allowed?: boolean | null;
  /** 项目页地址（去原站看一眼） */
  page_url?: string | null;
}

export interface ModrinthSearch {
  hits: ModrinthHit[];
  total_hits: number;
  offset: number;
  limit: number;
  /** 这批结果从哪来：`modrinth` / `curseforge` */
  source?: string;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  date_published: string;
  files: Array<{
    hashes: Record<string, string>;
    url: string;
    filename: string;
    size: number;
    primary: boolean;
  }>;
  dependencies: Array<{
    version_id: string | null;
    project_id: string | null;
    dependency_type: string;
  }>;
}

/** 在线库（Modrinth）反查到的 Mod 信息 —— 全都来自真实接口，没有就是 null */
export interface ModRemote {
  source: string;
  project_id: string;
  /** 版本号（version_number） */
  version: string;
  /** ★ 项目标题。文件名常常是 `sodium-fabric-mc1.20.1-0.5.11.jar`，用户认不出来 */
  title: string;
  description: string;
  game_versions: string[];
  loaders: string[];
  is_library: boolean;
  downloads: number;
  icon_url: string | null;
}

/** 磁盘上的一个 Mod 文件（+ 可选的反查信息） */
export interface ModScanEntry {
  file_name: string;
  display_name: string;
  path: string;
  enabled: boolean;
  bytes: number;
  mtime_ms: number;
  sha1: string | null;
  /**
   * ★★ CurseForge 指纹（MurmurHash2，十进制字符串）—— ADR-052。
   *
   * 只在"这个文件真的在 CurseForge 上被认出来了"时才有值：
   * 指纹本身说明不了任何事，**反查命中**才有意义。
   * 「检查更新」时要把它一起传给后端（CurseForge 只认指纹，不认 SHA1）。
   */
  fingerprint?: string | null;
  remote: ModRemote | null;
}

/** API 前置包（Fabric API / QFAPI）的自动安装结果 */
export interface ApiLibInstall {
  /** `fabric-api` / `quilted-fabric-api` */
  kind: string;
  project: string;
  installed: boolean;
  version: string | null;
  filename: string | null;
  path: string | null;
  /** 没装成时的**具体原因**（不阻断安装，但要如实说） */
  note: string | null;
}

/**
 * ★★ 正版登录的可用性（`ms_login_status` 的返回）。
 *
 *   为什么需要它：微软登录必须用一个**在 Azure 注册过的 client_id**，
 *   而这个 id 不能随启动器分发（PCL 的开源版同样把它留空、由环境变量注入）。
 *   所以界面必须能如实回答"现在能不能用、为什么不能、怎么才能用" ——
 *   而不是让用户点一下、等半天、收到一句看不懂的 `AADSTS700016`。
 */
export interface MsLoginStatus {
  available: boolean;
  /** 打码后的 client_id（如 `12345678…ab`） */
  client_id_preview: string | null;
  /**
   * ★ 这把 id 从哪来：`settings` / `env` / `builtin` / `none`。
   *
   *   为什么界面需要它：微软授权页显示的是**这个 ID 所属应用的名字** ——
   *   内置的是 Prism Launcher 的公开 id，所以页面上会写「已登录到 Prism Launcher」。
   *   界面必须能如实说清"现在用的是哪一把、是谁的"。
   */
  source: 'settings' | 'env' | 'builtin' | 'none';
  /** 不能用的完整说明（含申请步骤） */
  reason: string | null;
  /** 关于离线模式的说明（"不登也能玩"） */
  offline_note: string;
}

/** OptiFine 安装结果（`install_optifine` 的返回，与 Rust 侧一一对应） */export interface OptifineInstallResult {
  /** 装出来的版本 id，如 `1.16.5-OptiFine_HD_U_G8` */
  version_id: string;
  version_dir: string;
  json_path: string;
  client_jar: string;
  /** 用的是哪种方式：A = 跑官方 Patcher，B = 拼版本描述（老版本） */
  method: string;
  /** 安装器要求的 Java 主版本（读它的 class 头算出来的） */
  required_java: number;
  /** 人话总结，可以直接显示给用户 */
  summary: string;
}

/** LiteLoader 安装结果（`install_liteloader` 的返回，与 Rust 侧一一对应） */
export interface LiteLoaderInstallResult {
  version_id: string;
  version_dir: string;
  json_path: string;
  jar_path: string;
  tweak_class: string;
  /** 真的下下来（或本来就有）的库个数 */
  libraries: number;
  summary: string;
}

/**
 * 前置包在不在（`check_api_library` 的返回）
 * ★ `needed=false` 表示这个加载器**根本不需要**前置包（原版 / Forge / NeoForge）——
 *   与"需要但没装"必须分开，否则界面上会出现对 Forge 实例的假警报。
 */
export interface ApiLibStatus {
  /** 这个加载器需不需要前置包 */
  needed: boolean;
  /** 需要的话，它在不在 */
  present: boolean;
  /** 显示名，如 `Fabric API` */
  name: string | null;
  project?: string;
  kind?: string;
  /** 找到的那个文件名（present=true 时才有） */
  filename?: string | null;
  modsDir?: string;
  /** 一句话说明（可以直接显示给用户） */
  reason: string;
}

/** 一个"可更新"的候选 */
export interface ModUpdateCandidate {
  sha1: string;
  /** 走 CurseForge 那一路时有值（那条路只认指纹） */
  fingerprint?: string | null;
  /** 这次是从哪个源查到的：`modrinth` / `curseforge` */
  source?: string;
  project_id: string;
  current_version: string;
  latest_version: string;
  latest_version_id: string;
  download_url: string;
  file_name: string;
}

export interface JavaAssetInfo {
  major: number;
  version: string;
  release_name: string;
  size: number;
  download_url: string;
}

export interface InstalledJavaRow {
  major: number;
  path: string;
  bytes: number;
  usable: boolean;
}

export interface PlanPreview {
  total_files: number;
  libraries: number;
  natives: number;
  client_bytes: number;
  total_bytes: number;
  asset_index: string | null;
  classpath_entries: number;
}

export interface InstalledSummary {
  id: string;
  libraries: number;
  assets: number;
  total_bytes: number;
  version_json: string;
  natives_dir: string;
  /**
   * ★★ 这次是**被暂停**停下的，不是"装好了"。
   *
   * 与 Rust 侧 `InstalledSummary::paused` 同名同义（透传契约，ADR-036）。
   * 调用方**不许**在它为 `true` 时写"安装完成"—— 那正是 P0-3 修掉的那句假话：
   * 老代码把下载引擎的 `paused` 扔掉、照常返回成功，界面写"完成 100%"，
   * 而盘上一半文件都没有。
   */
  paused: boolean;
  /** 暂停时还没下的文件数（显示"还剩 N 个"） */
  remaining_files: number;
  /**
   * 暂停发生在**哪一步**（`paused` 为 `true` 时才有值）。
   *
   * ★ 光有 `remaining_files` 不够：加载器安装器（Forge/NeoForge 的
   *   `java -jar installer`）那一步是"一个文件都不剩、但活没干完"，
   *   界面必须能说出"停在哪儿"，不能把 0 当成"做完了"。
   */
  paused_stage: string | null;
}

export interface LaunchRequest {
  mc_version: string;
  loader_kind: string | null;
  /** 加载器版本（定位安装器产出的版本目录用，如 Forge "47.2.0"） */
  loader_version?: string | null;
  username: string;
  account_uuid: string | null;
  memory_mb: number;
  width: number;
  height: number;
  instance_slug: string;
  /**
   * 实例 id（多开实例用）。
   *
   * ★ 为什么必须传：后端"谁在跑"那张表按 **id** 索引 ——
   *   slug 是磁盘目录名（可改名、可重复的显示名），只有 id 是稳定的。
   */
  instance_id: string;
  extra_jvm_args: string[];
  extra_game_args: string[];
  /** 自定义窗口标题（null = 游戏默认） */
  window_title?: string | null;
  /**
   * 启动后自动进入的服务器地址（null = 不自动进服）。
   *
   * 传**用户输入的原样**即可：全角标点等清洗由 Rust 侧
   * `launch_args::parse_server_address` 统一处理（规则只有一份）。
   */
  join_server?: string | null;
}

export interface LaunchPreview {
  command: string;
  summary: string;
  java: string;
  classpath_entries: number;
  natives_dir: string;
  /** ★ 账号告警（null = 正常）；例如"令牌过期、续期失败、这次用离线身份" */
  notice?: string | null;
}

export interface LaunchStarted {
  pid: number;
  summary: string;
  log_path: string;
  /**
   * ★★ 需要用户知道的告警（null = 一切正常）。
   *
   * 目前唯一的来源是**账号**：正版 access token 过期、`refresh_token`
   * 续期又失败时，仍然会用离线身份启动（单机不受影响），但用户必须知道 ——
   * 否则他拿着离线身份去连正版服务器只会被拒，而界面一个字都不说。
   */
  notice?: string | null;
}

/** ★ 多开实例：后端"谁在跑"那张表里的一条（界面重新加载后靠它恢复状态） */
export interface RunningGameInfo {
  instance_id: string;
  pid: number;
  /** 启动时刻（Unix 秒） */
  started_at: number;
}

export interface StopInfo {
  played_seconds: number;
  crashed: boolean;
  crash_reason: string | null;
  crash_category: string | null;
  log_path: string;
  warning: string | null;
}

export interface McAccount {
  username: string;
  uuid: string;
  access_token: string;
  refresh_token: string | null;
  kind: string;
  expires_at: number | null;
}

export interface DeviceCodeReply {
  user_code: string;
  verification_uri: string;
  device_code: string;
  expires_in: number;
  interval: number;
  message: string;
}

export interface VerifyReport {
  checked: number;
  missing: string[];
  missing_count: number;
}

export interface MrpackInfo {
  name: string;
  version_id: string;
  summary: string | null;
  /** 清单里写死的 MC 版本（`dependencies.minecraft`） */
  mc_version: string | null;
  loader_kind: string | null;
  loader_version: string | null;
  file_count: number;
  client_file_count: number;
  /** 客户端文件总字节数 */
  total_bytes: number;
}

export interface BackendCapabilities {
  realMetadata: boolean;
  realDownload: boolean;
  realLaunch: boolean;
  msaLogin: boolean;
  keyring: boolean;
  modrinth: boolean;
  curseforge: boolean;
  sources: string[];
  note: string;
}

export interface InstallProgressEvent {
  taskId: string;
  stage: string;
  percent: number;
  finishedFiles: number;
  totalFiles: number;
  bytesPerSecond: number;
  currentFile: string;
  skippedFiles: number;
  failedFiles: number;
  /** 当前实际在用的下载源（多源回退时会变） */
  source?: 'auto' | 'mojang' | 'bmclapi' | '';
  /** 失败补下轮次：0 = 第一轮，>0 = 正在重试第 N 轮 */
  retryRound?: number;
  totalBytes?: number;
}

/** 单个下载源的健康状态（对应后端 `download_sources`） */
export interface DownloadSourceReport {
  source: 'auto' | 'mojang' | 'bmclapi';
  attempts: number;
  successes: number;
  failures: number;
  rateLimited: number;
  bytesPerSecond: number;
  /** 429 冷却剩余秒数（0 = 不在冷却） */
  coolingSeconds: number;
  score: number;
  /**
   * 启动探测的中位 TTFB（毫秒）。
   * `null` = 没探过，**或**那次探测该源三个端点全失败（不可达）。
   * 与 `probedSecondsAgo` 一起看才能区分这两种情况。
   */
  probeTtfbMs: number | null;
  /** 那次探测成功的端点数（0..=3） */
  probeOk: number;
  /** 距上次探测过了多少秒；`null` = 从未探测 */
  probedSecondsAgo: number | null;
}

export interface DownloadSourcesPayload {
  sources: DownloadSourceReport[];
  /** ★ 2026-09-22：现在是「自动」（官方优先）—— 见 Rust `parse_source` */
  preferred: 'auto' | 'mojang' | 'bmclapi';
  concurrencyHint: number;
  uptimeSeconds: number;
}

export interface JavaProgressEvent {
  taskId: string;
  percent: number;
  downloaded: number;
  total: number;
}

/* ====================== 调用封装 ====================== */

/** 统一调用入口；错误统一整理成人话 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Rust 侧返回的已经是 String，直接透出
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
  }
}

/* ====================== 真实元数据 ====================== */

export const metadata = {
  manifest: (source: 'auto' | 'mojang' | 'bmclapi' = 'bmclapi') =>
    call<ManifestSummary>('fetch_version_manifest', { source }),

  version: (mcVersion: string, source: 'auto' | 'mojang' | 'bmclapi' = 'bmclapi') =>
    call<VersionDetail>('fetch_version_json', { mcVersion, source }),

  loaders: (mcVersion: string, kind: string, source: 'auto' | 'mojang' | 'bmclapi' = 'bmclapi') =>
    call<LoaderList>('fetch_loaders', { mcVersion, kind, source }),

  /**
   * ★ 一次问清"这个 MC 版本能装哪些加载器"：**五种来源并行**。
   *
   * 比逐个调 `loaders()` 好在两处：
   *   ① 并行（本机实测串行合计约 18 秒 → 并行由最慢的一个决定）；
   *   ② **包含 OptiFine**（高清修复），它以前根本没有自动来源。
   */
  availableLoaders: (mcVersion: string, source: 'auto' | 'mojang' | 'bmclapi' = 'bmclapi') =>
    call<AvailableLoaders>('fetch_available_loaders', { mcVersion, source }),

  /** ★ 实时读盘：这个 MC 版本上到底装了哪些加载器与附加组件 */
  installedLoaders: (mcVersion: string) =>
    call<InstalledLoader[]>('detect_installed_loaders', { mcVersion }),
};

/* ====================== Modrinth ====================== */

export const modrinth = {
  search: (opts: {
    query: string;
    projectType: string;
    mcVersion?: string;
    loader?: string;
    limit?: number;
    offset?: number;
  }) =>
    call<ModrinthSearch>('modrinth_search', {
      query: opts.query,
      projectType: opts.projectType,
      mcVersion: opts.mcVersion ?? null,
      loader: opts.loader ?? null,
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
    }),

  project: (id: string) => call<Record<string, unknown>>('modrinth_project', { id }),

  versions: (id: string, mcVersion?: string, loader?: string) =>
    call<ModrinthVersion[]>('modrinth_versions', {
      id,
      mcVersion: mcVersion ?? null,
      loader: loader ?? null,
    }),

  /** 按哈希反查（判定"可更新"的真实机制） */
  byHash: (hashes: string[]) =>
    call<Record<string, ModrinthVersion>>('modrinth_versions_by_hash', { hashes }),

  /** 下载一个 Mod 文件到实例 mods 目录，返回落盘路径 */
  installMod: (url: string, filename: string, slug: string, sha1?: string) =>
    call<string>('install_mod', { url, filename, slug, sha1: sha1 ?? null }),

  /* ==================== ★★ 社区资源子系统 ==================== */

  /**
   * 四种社区资源的描述（Mod / 资源包 / 光影 / 数据包）。
   *
   * ★ **不要在界面上再写一张表**：装到哪个目录、认哪些扩展名、
   *   要不要挑加载器 —— 这四件事只有 Rust 侧那一份
   *   （`domain/resources.rs`）。写错一个字母，文件就装到游戏看不见的地方，
   *   而界面还会说"装好了"。
   */
  resourceKinds: () => call<ResourceKindInfo[]>('resource_kinds'),

  /**
   * 按**资源种类**搜索。
   *
   * 与 `search()` 的差别就是那张表：数据包走 `mod` + `categories:datapack`；
   * 只有 Mod 会带上加载器 facet（资源包/光影/数据包带上会把结果砍到几乎没有）。
   */
  resourceSearch: (opts: {
    kind: ResourceKindName;
    query: string;
    mcVersion?: string;
    loader?: string;
    limit?: number;
    offset?: number;
    /** ★ 从哪个源搜（`modrinth` 默认 / `curseforge`，ADR-052） */
    source?: ResourceSourceName;
  }) =>
    call<ModrinthSearch>('resource_search', {
      kind: opts.kind,
      query: opts.query,
      mcVersion: opts.mcVersion ?? null,
      loader: opts.loader ?? null,
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
      source: opts.source ?? 'modrinth',
    }),

  /**
   * ★★ 取一个项目**兼容当前实例**的版本（两个源共用这条命令）。
   *
   * 界面不该出现 `if (source === 'curseforge')` 这种分支 ——
   * 那是 ADR-051 说的"同一判据写两遍"。来源只作为参数传下去。
   */
  resourceVersions: (opts: {
    kind: ResourceKindName;
    projectId: string;
    mcVersion?: string;
    loader?: string;
    source?: ResourceSourceName;
  }) =>
    call<ModrinthVersion[]>('resource_versions', {
      kind: opts.kind,
      projectId: opts.projectId,
      mcVersion: opts.mcVersion ?? null,
      loader: opts.loader ?? null,
      source: opts.source ?? 'modrinth',
    }),

  /* ---------- CurseForge 的 key（内置一把） ---------- */

  /**
   * 当前 key 的状态（**它从哪来的**会如实说明）。
   *
   * ★★ 2026-09-20 更正一句**与界面不符的承诺**：这里原来写着"内置一把 + 设置页可覆盖"，
   *   而**界面上根本没有填写入口**（当初按用户要求把那一栏删掉了，见 beta.2 与
   *   MEMORY 里那条"假承诺"的账）。这几个命令仍然可用、也仍然注册着
   *   （留着是给"以后要把入口加回来"用的），但**现在没有任何 tsx 调它们** ——
   *   全仓库 grep `cfKeyStatus` / `cfSetKey` / `cfTestKey` 在 `.tsx` 里是 0 命中。
   *   写注释就得写当下的事实，不然下一个人会照着一个不存在的入口去改。
   */
  cfKeyStatus: () => call<CfKeyStatus>('cf_key_status'),

  /** 保存一把自己的 key（空串 = 删除，回到内置的那把）—— 界面暂无入口，见上 */
  cfSetKey: (key: string) => call<CfKeyStatus>('cf_set_key', { key }),

  /** ★ 真打一次接口验证（不是"看起来对"）—— 界面暂无入口，见上 */
  cfTestKey: () => call<string>('cf_test_key'),

  /** 下载并安装任意一种社区资源到实例里，返回落盘路径 */
  installResource: (
    kind: ResourceKindName,
    url: string,
    filename: string,
    slug: string,
    sha1?: string,
  ) =>
    call<string>('install_resource', {
      kind,
      url,
      filename,
      slug,
      sha1: sha1 ?? null,
    }),

  /**
   * ★ 自动安装 API 前置包（Fabric API / Quilted Fabric API）。
   *
   * 版本号**动态查 Modrinth**（不硬编码：Fabric API 的版本号与 MC 版本强绑定，
   * 抄一个值换个版本就失效 —— 见 LAUNCHER_SOURCE_STUDY 第 14 章第 9 条）。
   * `installed: false` 表示这个 MC 版本确实没有对应 API 包 —— **不是错误**，
   * 原因在 `note` 里。
   */
  installApiLibrary: (slug: string, mcVersion: string, base: 'fabric' | 'quilt') =>
    call<ApiLibInstall>('install_api_library', { slug, mcVersion, base }),

  /**
   * ★★ 这个实例的**前置包**装了没有？（Fabric API / Quilted Fabric API）
   *
   *   为什么需要它：自动安装只发生在**创建实例**那一次。
   *   老实例（建在这功能之前）、或者创建时网络抖动装失败的实例，
   *   事后**没有任何地方能补** —— 用户就会看到"装的是 Fabric，但 mods 空空"，
   *   之后每个依赖它的 Mod 启动都崩在 `requires fabric-api`。
   *   有了这个检查，Mod 管理页就能常驻显示"缺前置包 + 一键补装"。
   */
  checkApiLibrary: (slug: string, loaderKind: string | null) =>
    call<ApiLibStatus>('check_api_library', { slug, loaderKind }),

  /**
   * ★★ **自动安装 OptiFine**（真的跑它的 Patcher）。
   *
   *   实现在 Rust 的 `net::optifine`，照 PCL 的 `McDownloadOptiFineInstall`：
   *   下载安装器 → 读 `optifine/Installer.class` 的 class 头决定要哪个 Java →
   *   在临时 `.minecraft` 里跑 `optifine.Installer` → 把产物拷回共享目录。
   *
   *   前置条件：**原版必须先装好**（OptiFine 是在原版 jar 上打补丁）。
   *   不满足时返回的 Err 里会写清这一点。
   */
  installOptifine: (mcVersion: string, optifineVersion: string) =>
    call<OptifineInstallResult>('install_optifine', { mcVersion, optifineVersion }),

  /**
   * 启用 / 禁用一批 Mod。
   *
   * ★ 真实机制：禁用 = 文件名加 `.disabled` 后缀（没有任何清单文件），
   *   所以这里做的是**真的重命名**，返回实际改动的文件数。
   */
  setModEnabled: (slug: string, paths: string[], enabled: boolean) =>
    call<number>('set_mod_enabled', { slug, paths, enabled }),

  /**
   * 删除一批 Mod 文件，返回真正删掉的个数。
   *
   * ★ 默认进**系统回收站**（`permanent` 省略 = false）：手滑多选一个还能捞回来。
   *   `permanent: true` 才是真删 —— 界面上是"按住 Shift 点删除"的语义。
   */
  deleteMods: (slug: string, paths: string[], permanent?: boolean) =>
    call<number>('delete_mods', { slug, paths, permanent: permanent ?? false }),

  /**
   * ★ Mod 列表：读盘 + **按 SHA1 反查在线库**。
   *
   * 返回的是"这是什么 Mod、什么版本、支不支持当前版本"这些用户真正要看的信息，
   * 而不是一串文件名。反查不到的条目 `remote` 为 null —— 界面显示文件名，
   * **绝不编造**。
   */
  scanMods: (slug: string, mcVersion: string, loaderKind?: string | null) =>
    call<ModScanEntry[]>('scan_mods_detailed', {
      slug,
      mcVersion,
      loaderKind: loaderKind ?? null,
    }),

  /**
   * 检查一批 Mod 有没有兼容当前实例的新版本（每个 Mod 一次请求，有上限）。
   *
   * ★ `fingerprints` 与 `hashes` **按位置一一对应**（没有指纹的位置传空串）——
   *   后端要按位置把两个列表对起来。塌缩掉空位会让后面全部错位一格，
   *   而表现是"给某个 Mod 装了另一个 Mod 的更新"（ADR-052）。
   */
  checkUpdates: (
    hashes: string[],
    fingerprints: string[],
    mcVersion: string,
    loaderKind?: string | null,
    limit?: number,
  ) =>
    call<ModUpdateCandidate[]>('check_mod_updates', {
      hashes,
      fingerprints,
      mcVersion,
      loaderKind: loaderKind ?? null,
      limit: limit ?? 40,
    }),
};

/* ====================== Java ====================== */

export const java = {
  query: (major: number) => call<JavaAssetInfo>('java_query', { major }),

  /** 下载并安装 Java；通过 `java-progress` 事件上报进度 */
  install: async (
    major: number,
    taskId: string,
    onProgress?: (e: JavaProgressEvent) => void,
  ): Promise<string> => {
    let unlisten: UnlistenFn | null = null;
    if (onProgress) {
      unlisten = await listen<JavaProgressEvent>('java-progress', (ev) => {
        if (ev.payload.taskId === taskId) onProgress(ev.payload);
      });
    }
    try {
      return await call<string>('java_install', { major, taskId });
    } finally {
      unlisten?.();
    }
  },

  listDownloaded: () => call<InstalledJavaRow[]>('java_list_downloaded'),
};

/* ====================== 安装 ====================== */

export const installer = {
  plan: (opts: {
    mcVersion: string;
    loaderKind?: string | null;
    loaderVersion?: string | null;
    source?: 'auto' | 'mojang' | 'bmclapi';
  }) =>
    call<PlanPreview>('plan_install', {
      mcVersion: opts.mcVersion,
      loaderKind: opts.loaderKind ?? null,
      loaderVersion: opts.loaderVersion ?? null,
      source: opts.source ?? 'bmclapi',
    }),

  /** 执行安装；通过 `install-progress` 事件上报进度 */
  install: async (
    opts: {
      mcVersion: string;
      loaderKind?: string | null;
      loaderVersion?: string | null;
      source?: 'auto' | 'mojang' | 'bmclapi';
      taskId: string;
      downloadAssets?: boolean;
      concurrency?: number;
    },
    onProgress?: (e: InstallProgressEvent) => void,
  ): Promise<InstalledSummary> => {
    let unlisten: UnlistenFn | null = null;
    if (onProgress) {
      unlisten = await listen<InstallProgressEvent>('install-progress', (ev) => {
        if (ev.payload.taskId === opts.taskId) onProgress(ev.payload);
      });
    }
    try {
      return await call<InstalledSummary>('install_version', {
        mcVersion: opts.mcVersion,
        loaderKind: opts.loaderKind ?? null,
        loaderVersion: opts.loaderVersion ?? null,
        source: opts.source ?? 'bmclapi',
        taskId: opts.taskId,
        downloadAssets: opts.downloadAssets ?? true,
        concurrency: opts.concurrency ?? 16,
      });
    } finally {
      unlisten?.();
    }
  },

  cancel: (taskId: string) => call<void>('cancel_task', { taskId }),

  verify: (mcVersion: string, slugs: string[]) =>
    call<VerifyReport>('verify_version', { mcVersion, slugs }),

  /**
   * 下载源健康状态（成功率 / 限流次数 / 实测速度 / 冷却剩余）。
   *
   * 用途：用户问「为什么这次这么慢」时能直接看到答案 ——
   * 是被 429 限流了（coolingSeconds > 0）、还是这个源本来就慢。
   */
  sources: () => call<DownloadSourcesPayload>('download_sources'),

  /**
   * ★ 清理没有任何已装版本引用的共享库与资源文件。
   *
   * `dryRun=true` 只统计（先把"能释放多少"告诉用户），确认后再真删。
   * 保留集从磁盘上每个版本 JSON 现算（含 inheritsFrom 与 natives classifier），
   * 并且**不动**任何 `.part`（断点续传的残留）。
   */
  cleanUnused: (dryRun: boolean) => call<CleanReport>('clean_unused_files', { dryRun }),

  /**
   * ★★ 清理**可再生**的东西：安装器缓存 + 元数据缓存 + 旧的启动日志（0.1.0-beta.3）。
   *
   * 与 `cleanUnused` 的判据**不同**，所以是两条命令：
   *   · `cleanUnused`  —— "没有任何版本引用的**游戏文件**"（删了要重下，所以判据很窄）
   *   · `cleanCaches`  —— "删了会自己回来的东西"（安装器 / 清单缓存 / 每次启动的日志）
   * 混在一起迟早误删用户的游戏文件，所以分开。
   *
   * 启动日志只保留最近 5 份 —— 崩溃分析读的是最近那份，不能全删。
   */
  cleanCaches: (dryRun: boolean) => call<CacheCleanReport>('clean_caches', { dryRun }),

  /**
   * ★★ **自动安装 OptiFine**（真的跑它的 Patcher）。
   *
   *   实现在 Rust 的 `net::optifine`，照 PCL 的 `McDownloadOptiFineInstall`：
   *   下载安装器 → 读 `optifine/Installer.class` 的 class 头决定要哪个 Java →
   *   在临时 `.minecraft` 里跑 `optifine.Installer` → 把产物拷回共享目录。
   *
   *   前置条件：**原版必须先装好**（OptiFine 是在原版 jar 上打补丁）。
   *   不满足时返回的 Err 里会写清这一点。
   */
  installOptifine: (mcVersion: string, optifineVersion: string) =>
    call<OptifineInstallResult>('install_optifine', { mcVersion, optifineVersion }),

  /**
   * ★★ **自动安装 LiteLoader**。
   *
   *   与 OptiFine 不同：LiteLoader **没有安装器**，就是"挂一个 tweaker + 几个库"。
   *   后端会写一个带 `--tweakClass` 的 `inheritsFrom` 版本描述，
   *   并把 launchwrapper / asm-all / liteloader 本体三个 jar 真的下下来。
   *   （照 PCL 的 `McDownloadLiteLoaderLoader`，见 `net::liteloader`。）
   *
   *   ★ `baseLoaderKind` **必须**是界面上真正选中的基座加载器：
   *     组合规则要求 LiteLoader 搭配 Forge，而后端就是靠这个参数
   *     把 `inheritsFrom` 指到 **Forge 的版本目录**上。
   *     传错 / 不传 → 装成"挂原版的 LiteLoader"，Forge 的库全丢，
   *     启动时才缺库（安装时不报错，最难查）。
   *
   *   前置条件：基座（原版或 Forge）要先装好。
   */
  installLiteLoader: (mcVersion: string, baseLoaderKind?: string | null) =>
    call<LiteLoaderInstallResult>('install_liteloader', {
      mcVersion,
      baseLoaderKind: baseLoaderKind ?? null,
    }),
};

export interface CleanReport {
  version_jsons_scanned: number;
  kept_libraries: number;
  kept_assets: number;
  candidates: number;
  removed: number;
  total_bytes: number;
  dry_run: boolean;
  sample: string[];
}

/** `clean_caches` 的返回：可再生的数据清掉了多少 */
export interface CacheCleanReport {
  installer_files: number;
  metadata_files: number;
  log_files: number;
  logs_kept: number;
  total_bytes: number;
  removed_bytes: number;
  dry_run: boolean;
  sample: string[];
}

/* ====================== 启动 ====================== */

/**
 * ★★ 启动失败的**结构化**信息（与 Rust 侧 `LaunchError` 同名同义，P0-7）。
 *
 * ## 为什么不再从文案里抠数字
 *
 *   启动页原来这么写：
 *   ```ts
 *   const need = /Java (\d+)/.exec(msg);      // 从散文里抠"需要 Java 几"
 *   if (need) setJavaMissing(Number(need[1]));
 *   ```
 *   于是只要后端文案变一个字（比如把示例里的 `Java 24` 挪到前面），
 *   抠出来的就是**另一个数字**；文案彻底改写则连按钮都不再出现。
 *   现在后端把机器可读的字段单独给出（`code` / `required_major` /
 *   `required_range`），界面按字段走。
 */
export interface LaunchFailure {
  /** `java-missing` / `game-exited-immediately` / `prepare-failed` */
  code: string;
  /** 面向用户的完整说明 */
  message: string;
  /** `java-missing` 时：需要的 Java 主版本 */
  requiredMajor: number | null;
  /** `java-missing` 时：需要区间的可读形式，如 `[25, )` */
  requiredRange: string | null;
}

/** 把一个 `invoke` 抛出的错误认成结构化启动失败（不是就返回 `null`） */
export function launchFailureOf(e: unknown): LaunchFailure | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.code !== 'string' || typeof o.message !== 'string') return null;
  return {
    code: o.code,
    message: o.message,
    requiredMajor: typeof o.required_major === 'number' ? o.required_major : null,
    requiredRange: typeof o.required_range === 'string' ? o.required_range : null,
  };
}

/**
 * 调用一个**返回结构化错误**的命令。
 *
 * 抛出的 `Error` 上挂 `launchFailure` 字段（用 `launchFailureOf` 读），
 * `message` 仍然是给用户看的那句话 —— 两层都要有：
 *   · 文字给用户（`toast` 直接显示）
 *   · 字段给代码（按钮、引导、自动下载都靠它）
 */
async function callLaunch<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const failure = launchFailureOf(e);
    if (failure) {
      const err = new Error(failure.message) as Error & { launchFailure?: LaunchFailure };
      err.launchFailure = failure;
      throw err;
    }
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
  }
}

export const launcher = {
  preview: (req: LaunchRequest) => callLaunch<LaunchPreview>('preview_launch', { req }),

  launch: (req: LaunchRequest) => callLaunch<LaunchStarted>('launch_minecraft', { req }),

  /**
   * 停止游戏。
   *
   * ★★ 多开实例（2026-09-15）：以前没有参数 —— 因为以前**只有一个**能停。
   *   现在同时可能有好几个在跑，"停哪个"必须说清楚，
   *   让后端猜（"停最早那个"）是那种平时看不出来、一多开就停错游戏的错。
   *   传 `undefined` = 全停。
   */
  stop: (instanceId?: string) =>
    call<StopInfo | null>('stop_minecraft', { instanceId: instanceId ?? null }),

  /** ★ 现在有哪些实例在跑（界面重新加载后靠它把状态捡回来） */
  runningGames: () => call<RunningGameInfo[]>('running_games'),

  readLog: (slug: string) => call<string>('read_latest_log', { slug }),

  openFolder: (slug: string) => call<string>('open_instance_folder', { slug }),

  /**
   * ★ 打开一个目录（设置页 / 版本列表用）。
   *
   * **必须走 Rust 命令**，不能在前端调 `@tauri-apps/plugin-opener` 的
   * `openPath` —— 那个命令会先过 opener 插件的 **scope 白名单**，
   * 而 `opener:allow-open-path` 只授权"可以调用"，不含任何路径；
   * 于是 `openPath(数据目录)` 一定返回 `forbidden path`。
   * 前端以前用 `catch {}` 把它吞了，用户看到的只是"点了没反应"。
   */
  openDir: (which: string, slug?: string) =>
    call<string>('open_data_dir', { which, slug: slug ?? null }),

  /**
   * 新建 / 切换游戏根目录（2026-09-17 用户要求）。
   *
   * ★ 语义是**只切换、不迁移**：新目录是空的，旧的**一个字节都不动**。
   *   界面必须把这件事说清楚，否则用户会以为东西被搬走了。
   *
   * ★ 返回里带 `restartRequired` —— `AppPaths` 是启动时解析一次的，
   *   所以这个函数只**记录**选择，界面要如实告诉用户"重启后生效"。
   */
  setDataRoot: (path: string) =>
    call<{
      path: string;
      previous: string;
      onSystemDrive: boolean;
      restartRequired: boolean;
      hasExistingData: boolean;
    }>('set_data_root', { path }),

  /**
   * ★★ 用过的游戏文件夹（设置页「新建/切换…」里那张表）。
   *
   * ★ 用户 2026-09-20（给了 PCL 的截图）：「**这个切换列表我想要 PCL 这样的**」——
   *   列的是**你用过的文件夹**（名字 + 路径），不是"机器上有哪些盘"。
   *   盘的列表每次都要你重新想"放哪"；这张表是"回到你去过的那个地方"。
   *
   * ★ `suggested` 那类路径由 Rust 拼（目录名来自 `DATA_DIR_NAME`）——
   *   **前端不许自己拼 `<盘>\IEML`**：拼错的话界面说的位置和文件真正落下的位置
   *   就不是同一个地方，而且一点报错都没有。
   */
  dataRoots: () => call<DataRoot[]>('list_data_roots'),

  /** 忘掉一个文件夹（目录已经没了时用）—— 只动那张列表，不碰磁盘 */
  forgetDataRoot: (path: string) => call<void>('forget_data_root', { path }),
  /**
   * ★★ 2026-09-23：**连目录一起删**（用户定的 B）。返回释放的字节数。
   *   ★ 后端有四道闸（当前根目录 / 启动器数据目录 / 盘符根 / 必须真是目录），
   *     任何一道过不去都会带**原因**拒绝 —— 界面直接把那句话显示出来。
   */
  deleteDataRoot: (path: string) => call<number>('delete_data_root', { path }),
  /** 查哪些实例的版本文件已不在磁盘上（只读，不删条目） */
  instanceHealth: () => call<Array<{ id: string; version_missing: boolean }>>('instance_health'),
};

/**
 * 「用过的游戏文件夹」列表的一行（与 Rust 侧 `platform::KnownRoot` 一一对应）。
 *
 * ★ 字段名是后端 `rename_all = "camelCase"` 透传过来的（跨 IPC 契约）。
 */
export interface DataRoot {
  /** 数据根目录（游戏数据在它下面的 `.minecraft`） */
  path: string;
  /** 显示名：路径最后一段（`D:\测试目录` → `测试目录`） */
  name: string;
  /** 目录还在不在。不在的照样列出来，但只能「移除」 */
  exists: boolean;
  /** ★ 就是现在正在用的那个（**精确到路径**，不是"同一块盘"） */
  isCurrent: boolean;
  /** 在系统盘上 —— 提示，不是错误 */
  onSystemDrive: boolean;
  /** `known` = 记录里用过；`found` = 在盘上扫到的同款目录 */
  source: 'known' | 'found';
}

/* ====================== 账号 ====================== */

export const account = {
  offline: (username: string) => call<McAccount>('account_offline', { username }),

  /*
   * ★★ 2026-09-22（用户那张账号菜单）：改皮肤 / 披风 / 存皮肤文件。
   *   全是**写**操作，必须带已登录的 MC 令牌；令牌过期由 Rust 侧静默续期
   *   （见 auth::fresh_account），所以这里不需要先查登录状态。
   */
  uploadSkin: (uuid: string, path: string, variant: 'classic' | 'slim' = 'classic') =>
    call<{ id: string; state: string; url: string; variant: string }>('account_upload_skin', {
      uuid,
      path,
      variant,
    }),
  /** 拥有的披风（正版且确实拥有时才有内容） */
  capes: (uuid: string) =>
    call<Array<{ id: string; name: string; url: string | null; active: boolean }>>('account_capes', {
      uuid,
    }),
  /** 换披风；传 null = 不显示披风 */
  setCape: (uuid: string, capeId: string | null) =>
    call<void>('account_set_cape', { uuid, capeId }),
  /** 把当前皮肤存成文件，返回写入的字节数 */
  saveSkin: (skinUrl: string, dest: string) =>
    call<number>('account_save_skin', { skinUrl, dest }),

  /**
   * ★★ 正版登录现在能不能用（缺不缺 client_id）。
   *   设置页据此决定是显示「正版登录已就绪」还是「缺一个应用 ID + 输入框」。
   */
  msStatus: () => call<MsLoginStatus>('ms_login_status'),

  /** ★ 保存正版登录用的 client_id（一次填好，长期有效 —— 会落盘） */
  setClientId: (clientId: string) => call<void>('ms_set_client_id', { clientId }),

  startLogin: () => call<DeviceCodeReply>('account_start_login'),

  /** 轮询等待用户在浏览器完成授权 */
  pollLogin: (deviceCode: string, interval: number, expiresIn: number) =>
    call<McAccount>('account_poll_login', { deviceCode, interval, expiresIn }),

  load: (uuid: string) => call<McAccount>('account_load', { uuid }),

  current: () => call<string | null>('account_current'),

  remove: (uuid: string) => call<void>('account_remove', { uuid }),

  refresh: (refreshToken: string) => call<McAccount>('account_refresh', { refreshToken }),

  /**
   * 正版账号的皮肤（走 Mojang 官方，照 PCL 的做法）。
   *
   * 返回 64×64 皮肤原图的 URL —— 头部在 (8,8)、帽子层在 (40,8)，
   * **裁剪在界面里用 CSS 做**（见 `AccountPanel` 的 `.acct-head`）。
   */
  skin: (uuid: string) => call<AccountSkin>('account_skin', { uuid }),
};

/** 见后端 `auth::SkinInfo` */
export interface AccountSkin {
  /** Mojang 侧的玩家名（比本地记的那个权威） */
  name: string;
  /** 皮肤原图 URL（64×64 PNG）；没设皮肤时为 null */
  skinUrl: string | null;
  /** 披风图 URL；没有披风时为 null */
  capeUrl: string | null;
}

/* ====================== 整合包 ====================== */

export const modpack = {
  inspect: (url: string) => call<MrpackInfo>('mrpack_inspect', { url }),

  /**
   * ★ 真正安装一个整合包。
   *
   * 四步：读清单 → 装本体+加载器 → 按清单下 Mod → 解压 overrides。
   * 进度通过 `modpack-progress` 事件上报（阶段 + 文件计数 + 字节）。
   */
  install: async (
    opts: {
      url: string;
      name: string;
      slug: string;
      taskId: string;
      instanceName: string;
      source?: 'auto' | 'mojang' | 'bmclapi';
      concurrency?: number;
    },
    onProgress?: (e: ModpackProgressEvent) => void,
  ): Promise<ModpackInstallResult> => {
    let unlisten: UnlistenFn | null = null;
    if (onProgress) {
      unlisten = await listen<ModpackProgressEvent>('modpack-progress', (ev) => {
        if (ev.payload.taskId === opts.taskId) onProgress(ev.payload);
      });
    }
    try {
      return await call<ModpackInstallResult>('modpack_install', {
        url: opts.url,
        name: opts.name,
        slug: opts.slug,
        taskId: opts.taskId,
        instanceName: opts.instanceName,
        source: opts.source ?? 'bmclapi',
        concurrency: opts.concurrency ?? null,
      });
    } finally {
      unlisten?.();
    }
  },
};

/** 整合包进度事件（`modpack-progress`） */
export interface ModpackProgressEvent {
  taskId: string;
  stage: string;
  finishedFiles: number;
  totalFiles: number;
  bytes: number;
  currentFile: string;
  percent: number;
  failedFiles?: number;
}

export interface ModpackInstallResult {
  mc_version: string;
  loader_kind: string | null;
  loader_version: string | null;
  mod_files: number;
  override_files: number;
  total_bytes: number;
  instance_name: string;
  /**
   * ★★ 被暂停停下（与 Rust 侧同名，见 `InstalledSummary::paused`）。
   *   为 `true` 时 `mod_files` / `override_files` 是"还没做"，**不是** "做完了是 0"。
   */
  paused: boolean;
  /** 暂停时还没下的文件数 */
  remaining_files: number;
  /** 暂停发生在哪一步（`paused` 为 `true` 时才有值） */
  paused_stage: string | null;
}

/* ====================== Backend 接口实现 ====================== */

export function createTauriBackend(): Backend {
  return {
    async info(): Promise<BackendInfo> {
      const r = await call<{ data_dir: string; version: string }>('app_info');
      return { kind: 'tauri', dataDir: r.data_dir, version: r.version };
    },

    async machineInfo() {
      const r = await call<{
        total_memory_gb: number;
        available_memory_gb: number;
        cpu_count: number;
        os: string;
        arch: string;
        data_dir: string;
      }>('machine_info');
      return {
        totalMemoryGb: r.total_memory_gb,
        availableMemoryGb: r.available_memory_gb,
        cpuCount: r.cpu_count,
        os: r.os,
        arch: r.arch,
        dataDir: r.data_dir,
      };
    },

    async scanJava(): Promise<JavaRuntime[]> {
      const [system, downloaded] = await Promise.all([
        call<
          Array<{
            path: string;
            major: number;
            version: string;
            vendor: string;
            arch: string;
            source: string;
            disabled_by_default: boolean;
            bytes: number;
          }>
        >('scan_java'),
        java.listDownloaded().catch(() => [] as InstalledJavaRow[]),
      ]);

      const out: JavaRuntime[] = system.map((r) => ({
        path: r.path,
        major: r.major,
        version: r.version,
        vendor: r.vendor,
        arch: r.arch as JavaRuntime['arch'],
        source: r.source as JavaRuntime['source'],
        disabledByDefault: r.disabled_by_default,
        bytes: r.bytes,
      }));

      // 把 IEML 下载的 Java 也并进去（按路径去重）
      for (const d of downloaded) {
        if (out.some((x) => x.path === d.path)) continue;
        out.push({
          path: d.path,
          major: d.major,
          version: String(d.major),
          vendor: 'Temurin',
          arch: 'x64',
          source: 'downloaded',
          disabledByDefault: false,
          bytes: d.bytes,
        });
      }
      return out;
    },

    async downloadJava(major, onProgress) {
      const taskId = `java-${major}-${Date.now()}`;
      const path = await java.install(major, taskId, (e) => {
        onProgress(e.percent, e.downloaded, e.total);
      });
      return {
        path,
        major,
        version: String(major),
        vendor: 'Temurin',
        arch: 'x64',
        source: 'downloaded',
        bytes: 0,
      };
    },

    async removeJava(path, permanent) {
      await call<void>('remove_java', { path, permanent: permanent ?? false });
    },

    async loadInstances() {
      const store = await call<{ instances: Instance[]; active_id: string | null }>(
        'list_instances',
      );
      return { instances: store.instances ?? [], activeId: store.active_id ?? null };
    },

    async saveInstances(instances, activeId) {
      await call<void>('save_instances', {
        store: { instances, active_id: activeId },
      });
    },

    /** ★ 删除实例的磁盘目录，返回删掉的字节数（默认进回收站） */
    async deleteInstanceFiles(slug, permanent) {
      return call<number>('delete_instance_files', {
        slug,
        permanent: permanent ?? false,
      });
    },

    /** ★ 复制实例的磁盘目录（存档/Mod/配置），返回复制的字节数 */
    async copyInstanceFiles(fromSlug, toSlug, copyGameDir) {
      return call<number>('copy_instance_files', {
        fromSlug,
        toSlug,
        copyGameDir,
      });
    },

    /** ★ 全局偏好：读（启动时恢复设置与登录） */
    async loadPrefs() {
      return call<Record<string, unknown>>('load_prefs');
    },

    /** ★ 全局偏好：写（原子写，断电不会写坏） */
    async savePrefs(prefs) {
      await call<void>('save_prefs', { prefs });
    },

    async install(planId, planRaw, onProgress) {
      const p = planRaw as {
        mcVersion?: string;
        loaderKind?: string | null;
        loaderVersion?: string | null;
        source?: 'auto' | 'mojang' | 'bmclapi';
      };
      try {
        await installer.install(
          {
            mcVersion: p.mcVersion ?? '1.20.1',
            loaderKind: p.loaderKind ?? null,
            loaderVersion: p.loaderVersion ?? null,
            source: p.source ?? 'bmclapi',
            taskId: planId,
            downloadAssets: true,
          },
          (e) =>
            onProgress({
              percent: e.percent,
              finishedFiles: e.finishedFiles,
              totalFiles: e.totalFiles,
              bytesPerSecond: e.bytesPerSecond,
              currentFile: e.currentFile,
              etaSeconds:
                e.bytesPerSecond > 0
                  ? Math.round((e.totalFiles - e.finishedFiles) * 0 + 30)
                  : 0,
              phase: e.stage,
            }),
        );
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },

    /**
     * ★★ **暂停**（不再等于取消）。
     *
     * ## 这里原来是把取消伪装成暂停
     *
     * 老实现只有一句 `await installer.cancel(taskId)`，注释里写着"引擎目前
     * 没有暂停原语，只有取消"。问题是**两者对用户不是一回事**：
     *
     * | | 取消 | 暂停 |
     * |---|---|---|
     * | 用户意图 | 不要了 | 等会儿接着下 |
     * | 界面该说 | 已取消 | **已暂停**（进度留在原地） |
     * | 后续 | 要重新发起 | 点「继续」就接着下 |
     *
     * 混成一个之后，那个"暂停"按钮点下去告诉用户"已取消"——
     * 而它其实什么都没丢，用户于是不敢再点。
     *
     * ## 现在引擎真的有暂停了
     *
     * Rust 侧 `download::PauseToken`：**不再开始新的下载，让在跑的收尾**，
     * 然后把"还剩哪些"记在 `DownloadOutcome.remaining` 里。
     * 已下载的 `.part` 分片全部保留，所以「继续」接得上。
     *
     * 为什么不去中断正在跑的 HTTP 请求：资源阶段是几千个小文件，
     * 一个通常几百毫秒就完了，中断它们只会丢掉已经收到的数据。
     * PCL 的 `LoaderTask` 也是这个语义（`TriggerThreadInterrupt` +
     * 不启动下一步，而不是杀连接）。
     */
    async pauseTask(taskId) {
      await call<boolean>('pause_install', { taskId });
    },

    /**
     * 取消暂停（引擎层的开关）。
     *
     * ★ 注意"接着下"**不是**这个方法的职责：引擎已经把没下的那些
     *   交回给了 `flows/install.ts`，由它按原参数重新发起
     *   （已下载的文件与 `.part` 分片都会被复用）。
     *   这里只负责把开关复位，这样万一调用方选择原地继续，状态也是对的。
     */
    async resumeTask(taskId) {
      await call<boolean>('resume_install', { taskId });
    },

    async cancelTask(taskId) {
      await installer.cancel(taskId);
    },

    /**
     * 启动一个实例（Backend 契约方法）。
     *
     * ★ 审计发现这里原来读 `window.__iemlLaunchRequest` —— 那个全局变量
     *   **全仓库没有任何地方写过**，所以这个方法永远抛「启动参数缺失」。
     *   真正的启动页走的是 `api.launcher.launch(req)`（自己拼 req），
     *   所以这个契约方法一直是个陷阱：谁按契约调它谁失败。
     *
     *   现在它自己把 req 拼出来：从实例列表里找到这个 id，按实例配置组装。
     *   参数口径与 `LaunchPage` 的 `req` 保持一致（否则同一个实例两条路
     *   启动出来的东西会不一样）。
     */
    async launch(instanceId): Promise<LaunchResult> {
      const store = await call<{ instances: Instance[] }>('list_instances');
      const inst = store.instances?.find((i) => i.id === instanceId);
      if (!inst) {
        throw new Error(`找不到实例 ${instanceId}（可能已被删除）`);
      }
      const prefs: Record<string, unknown> = await call<Record<string, unknown>>('load_prefs').catch(
        () => ({}) as Record<string, unknown>,
      );
      const req: LaunchRequest = {
        mc_version: inst.mcVersion,
        loader_kind: inst.loader?.kind ?? null,
        loader_version: inst.loader?.version ?? null,
        username: (prefs.offlineUsername as string) || 'Player',
        account_uuid: (prefs.accountUuid as string) ?? null,
        memory_mb: inst.config.memoryMb,
        width: (prefs.windowWidth as number) ?? 854,
        height: (prefs.windowHeight as number) ?? 480,
        instance_slug: inst.config.slug,
        // ★ 多开实例：后端按 id 认"谁在跑"（slug 是可改的目录名，不能当身份）
        instance_id: inst.id,
        extra_jvm_args: inst.config.jvmArgs
          ? inst.config.jvmArgs.split(/\s+/).filter(Boolean)
          : [],
        extra_game_args: inst.config.gameArgs
          ? inst.config.gameArgs.split(/\s+/).filter(Boolean)
          : [],
        window_title: inst.config.windowTitle ?? null,
        // ★ 启动后自动进服（清洗由 Rust 侧统一做，前端不维护第二套规则）
        join_server: inst.config.joinServer ?? null,
        /*
         * ★ 这里原来还有一个 `java_major` 字段，**已经删掉了**。
         *
         *   前端那张写死的规则表（`1.20.5+ → 21 / 1.17+ → 17 / 其余 → 8`）
         *   只取 `split('.')[0]` 当 major，于是 `26.2` 的 major 是 26 而不是 1
         *   → 落到 `return 8`，传下去一个**错的兜底值**
         *   （用户看到的就是「26.2 需要 Java 8」）。
         *
         *   启动没坏只是因为 Rust 以版本 JSON 的 `javaVersion` 为准。
         *   现在把这个字段整个去掉：**错的兜底值不该存在于接口上**。
         *   规则只有一处 —— Rust 的 `domain::java::resolve_java_requirement`。
         */
      };
      const r = await launcher.launch(req);
      return { pid: r.pid, command: r.summary };
    },

    /**
     * 停止游戏（Backend 契约）。
     *
     * ★★ 多开实例（2026-09-15）：`instanceId` **必传**。
     *   以前后端只有一个槽、这个参数写了也没处用；现在同时可能有好几个在跑，
     *   "停哪个"必须由调用方说清楚 —— 让后端猜就是"一多开就停错游戏"。
     */
    async stopGame(instanceId) {
      await launcher.stop(instanceId);
    },

    /** ★ 现在有哪些实例在跑（界面重新加载后把状态捡回来） */
    async runningGames() {
      return launcher.runningGames();
    },

    /**
     * 打开一个目录（Backend 契约方法）。
     *
     * ★ 走 Rust 命令，**不要**用前端 opener 插件的 `openPath` ——
     *   审计发现这里原来就是 `openPath(path)`，而
     *   `opener:allow-open-path` 在 capabilities 里没有配任何 scope 白名单，
     *   于是它**必然**返回 `forbidden path`。任何调用方都会静默失败。
     *   现在统一委托给 `launcher.openDir`（Rust 侧直接调 opener，不过插件 scope）。
     */
    async openFolder(path) {
      const slug = String(path ?? '').trim();
      await launcher.openDir(slug ? 'instance' : 'data', slug || undefined);
    },

    async listMods(instanceId) {
      const raw = await call<
        Array<{ file_name: string; path: string; bytes: number; mtime_ms: number }>
      >('scan_mods', { instanceId, loaderKind: null, mcVersion: '' });
      return raw.map((r) => ({
        fileName: r.file_name,
        path: r.path,
        bytes: r.bytes,
        mtimeMs: r.mtime_ms,
      }));
    },
  };
}

export const capabilities = () => call<BackendCapabilities>('backend_capabilities');
