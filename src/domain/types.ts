/**
 * IEML 领域模型
 * ------------------------------------------------------------------
 * 设计原则（与 docs/ARCHITECTURE.md、docs/DECISIONS.md 对应）：
 *   1. 规则只实现一次。本文件是唯一的规则来源，UI 只呈现结论。
 *   2. 三个实体严格分离：
 *        GameVersion  —— 磁盘上的一份原版游戏（共享，可被多个实例复用）
 *        LoaderInstall—— 叠加在某个 GameVersion 上的加载器（Forge/Fabric/...）
 *        Instance     —— 用户看到的"一套独立游戏环境"，引用上面两者 + 自己的配置
 *      原设计稿把三者混为一谈，才出现"已装版本"与"实例"互相打架。
 *   3. 一切可序列化：InstallPlan / Draft 都是纯数据，可预览、可续传、可测试。
 */

/* ============================ 基础枚举 ============================ */

/** 基础加载器：严格互斥，四选一（不含"纯原版"，那是"没有加载器"） */
export type BaseLoaderKind = 'forge' | 'neoforge' | 'fabric' | 'quilt';

/** 附加组件：可叠加，但受基础加载器约束 */
export type AddonKind = 'optifine' | 'liteloader';

/** 桥接包：让附加组件能在某个基础加载器上工作 */
export type BridgeKind = 'optifabric' | 'optifabric-origins';

/** API 前置包：由基础加载器自动决定，用户不可选 */
export type ApiLibKind = 'fabric-api' | 'quilted-fabric-api';

/** 游戏版本类型 */
export type ReleaseType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha';

/**
 * 实例隔离策略（ADR-005 三段判定）
 *   auto   —— 启动器按目录内容判定
 *   on/off —— 用户显式指定，优先级最高
 */
export type IsolationMode = 'auto' | 'on' | 'off';

/** 隔离判定的依据，用于向用户解释"为什么是这个结果" */
export type IsolationSource = 'user' | 'content' | 'global';

/** Mod 六态（ADR-019；"可能不兼容"刻意用"可能"，见 ADR-021） */
export type ModState =
  | 'fine'
  | 'disabled'
  | 'can-update'
  | 'maybe-incompatible'
  | 'errored'
  | 'library';

/* ============================ 实体 ============================ */

/** 磁盘上的一份原版游戏（全局共享） */
export interface GameVersion {
  /** MC 版本号，如 "1.20.1" / "24w45a" */
  id: string;
  releaseType: ReleaseType;
  /** 发布时间，ISO 8601 */
  releasedAt: string;
  /** 该版本所需的 Java 主版本（13 条规则的结果，见 java.ts） */
  javaMajor: number;
  /** 原版文件总字节数（jar + libraries + assets） */
  bytes: number;
  /** 是否已下载到本机 */
  installed: boolean;
}

/** 叠加在某个 GameVersion 上的加载器 */
export interface LoaderInstall {
  kind: BaseLoaderKind;
  /** 加载器自身版本，如 Forge "47.2.0" */
  version: string;
  /** 它叠在哪个 MC 版本上 */
  mcVersion: string;
}

/** 附加组件安装记录 */
export interface AddonInstall {
  kind: AddonKind;
  version: string;
  /** 若该附加组件需要桥接包，这里记下实际装的桥接包 */
  bridge?: { kind: BridgeKind; version: string };
}

/** 实例运行时配置（这些是"属性"，会长期存在，见 ADR-031） */
export interface InstanceConfig {
  /** 显示名，可随时改 */
  name: string;
  /** 显示名生成的安全目录名，重命名不改它（ADR-007） */
  slug: string;
  isolation: IsolationMode;
  /** 内存分配（MB） */
  memoryMb: number;
  /** 内存来源 */
  memorySource: 'global' | 'auto' | 'custom';
  /** Java 选择模式（ADR-030 四模式） */
  javaMode: JavaMode;
  /** javaMode === 'range' 时的闭区间（ADR-022） */
  javaRange?: JavaRange;
  /** javaMode === 'path' 时指定的 java 可执行文件 */
  javaPath?: string;
  /** 窗口标题覆盖，undefined = 跟随全局 */
  windowTitle?: string;
  /**
   * 启动后自动进入的服务器地址（PCL2 的实例设置里有这一项）。
   *
   * 存用户输入的原样；清洗（全角→半角）由 `domain/server-address.ts`
   * 与 Rust 侧 `launch_args::parse_server_address` 各自在用时做（同一套规则）。
   */
  joinServer?: string;
  /** 自定义信息覆盖 */
  customInfo?: string;
  /** JVM 参数覆盖 */
  jvmArgs?: string;
  /** 游戏参数覆盖 */
  gameArgs?: string;
}

/** Java 选择四模式（ADR-030） */
export type JavaMode =
  | 'auto'
  | 'range'
  | 'instance-folder'
  | 'path';

/**
 * Java 版本区间（ADR-022 闭区间模型）
 * [17.0, 22.0) 表示 >=17.0 且 <22.0；min/max 为 null 表示该侧不限制
 */
export interface JavaRange {
  min: number | null;
  /** inclusive: min 侧是否含等号 */
  minInclusive: boolean;
  max: number | null;
  /** inclusive: max 侧是否含等号 */
  maxInclusive: boolean;
}

/** 一个实例 = 引用游戏版本 + 可选加载器 + 自己的配置 */
export interface Instance {
  id: string;
  /** 引用哪个原版游戏 */
  mcVersion: string;
  /** 叠加的加载器，null = 纯原版 */
  loader: LoaderInstall | null;
  /** 附加组件 */
  addons: AddonInstall[];
  config: InstanceConfig;
  createdAt: string;
  lastPlayedAt: string | null;
  /** 累计游玩秒数 */
  totalPlaySeconds: number;
}

/* ============================ 加载器能力 ============================ */

/** 某个 MC 版本上可用的加载器能力（由 Rust 侧 get_loader_capabilities 提供） */
export interface LoaderCapabilities {
  mcVersion: string;
  /** 可选的基础加载器及各自可用版本 */
  baseLoaders: LoaderOption[];
  /** 可选的附加组件（含不可用原因） */
  addons: AddonOption[];
  /** 基础加载器确定后会自动补齐的 API 包 */
  apiLibraries: ApiLibraryOption[];
  /** 该 MC 版本所需的 Java 主版本 */
  javaMajor: number;
}

export interface LoaderOption {
  kind: BaseLoaderKind;
  name: string;
  /** 可选版本，第一项为推荐项 */
  versions: string[];
  /** 不可用时给出**具体理由**（禁止"不支持"三个字，见 ADR-004） */
  unavailableReason?: string;
  /** 是否被当前 MC 版本支持 */
  available: boolean;
  /**
   * 这个结论是**确认**出来的，还是**推断/未知**？
   *
   * ★ 存在的理由（用户报的 bug）：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」——
   *   内置表只有 10 个版本，没有 26.2；在线清单没拿到时，代码把"我不知道"
   *   写成了"尚未发布"。有了这个标记，UI 与 `validateCombination` 就能区分
   *   「确认没有」（可以置灰并说"未发布"）与「没查到」（只能说"没查到，可重试"），
   *   见 ADR-037。
   */
  confirmed?: boolean;
}

export interface AddonOption {
  kind: AddonKind;
  name: string;
  versions: string[];
  /** 是否需要桥接包，以及是哪种 */
  requiresBridge?: BridgeKind;
  /** 需要用户手动准备桥接包（无自动方案） */
  bridgeIsManual?: boolean;
  /** **最终结论**：能勾选吗？等价于 `exists && implemented` */
  available: boolean;
  /**
   * ★ 上游**存在**这个组件的这个 MC 版本吗？
   *
   * 与 `implemented` 分开的理由（用户原话「能装就是能装，不能装就是不能装」）：
   * 把"上游没有"和"我们没做"混成一句含糊的"不可用"，用户就不知道该等发布
   * 还是该换个启动器 —— 而这正是他唯一需要知道的事。
   */
  exists?: boolean;
  /**
   * ★ **IEML 自己实现安装了吗**？
   *
   * 现状：OptiFine 有，LiteLoader **没有**（只有磁盘识别）。
   * 所以「1.12.2 有 LiteLoader」≠「IEML 能给你装 LiteLoader」。
   */
  implemented?: boolean;
  /** 不可用原因，必须具体；纯原版下 OptiFine 可用时这里给说明文案 */
  unavailableReason?: string;
  /** 可用时的补充说明（如"将对原版 jar 打补丁安装"） */
  note?: string;
}

export interface ApiLibraryOption {
  kind: ApiLibKind;
  name: string;
  /** 与 MC 版本绑定的版本号，形如 0.92.2+1.20.1 */
  version: string;
  description: string;
  bytes: number;
  /** 必需 / 推荐 */
  required: boolean;
}

/* ============================ 组合校验 ============================ */

/** 用户选出来的一套组合（提交校验的输入） */
export interface LoaderSelection {
  mcVersion: string;
  base: BaseLoaderKind | null;
  addons: AddonKind[];
  /** 用户为各组件选定的版本 */
  baseVersion?: string;
  addonVersions?: Partial<Record<AddonKind, string>>;
}

/** 校验结果：valid + 被移除的 + 自动补的 + 警告（ADR 里约定的四段结构） */
export interface CombinationVerdict {
  valid: boolean;
  /**
   * 因不兼容而**不能装**的组件及原因。
   *
   * ★★ 这个数组非空时 `valid` **一定是 `false`**（2026-09-14 改）。
   *
   *   用户的要求：「当我们选择 Fabic 时如果有版本的 Fabic 与高清修复不兼容，
   *   应提示玩家不兼容」。
   *
   *   改之前的行为是"静默移除 + 照装不误"：用户勾了高清修复、
   *   点安装、装完了 —— 但**高清修复根本不在里面**。
   *   界面只在结果里列一句原因，看起来像"顺手帮你处理了"，
   *   而用户的预期是"我要它，它现在装不了，我得知道"。
   *
   *   所以现在：**勾了就必须装上**；装不上就是阻断性错误，
   *   要用户自己把那个勾去掉才能继续。不替他做决定。
   */
  removed: Array<{ kind: AddonKind; reason: string }>;
  /** 将自动安装的桥接包 */
  autoBridges: Array<{ kind: BridgeKind; name: string; after: AddonKind }>;
  /** 将自动安装的 API 前置包 */
  autoApis: ApiLibraryOption[];
  /** 不阻断但需要告知用户的事情 */
  warnings: string[];
  /** 阻断性错误 */
  errors: string[];
}

/* ============================ 安装计划 ============================ */

/** 安装步骤的语义阶段（面向用户的文案见 PHASE_LABELS） */
export type InstallPhase =
  | 'resolve'
  | 'download-installer'
  | 'run-installer'
  | 'collect-libraries'
  | 'apply-addons'
  | 'install-bridge'
  | 'install-apis'
  | 'write-manifest'
  | 'verify';

/** 单个待下载的远程文件 */
export interface DownloadItem {
  /** 目标相对路径（相对实例或共享库根） */
  path: string;
  url: string;
  /** 期望的 SHA1，用于去重与校验 */
  sha1: string;
  bytes: number;
  /** 下载到哪里 */
  target: 'shared' | 'instance' | 'java';
  /** 来源标注，用于 UI 展示与多源竞速 */
  source: 'mojang' | 'bmclapi' | 'forge' | 'fabric' | 'neoforge' | 'quilt' | 'optifine' | 'modrinth' | 'adoptium';
}

export interface InstallStep {
  phase: InstallPhase;
  /** 面向用户的说明，禁止出现技术黑话（文案规范第 13 章） */
  label: string;
  downloads: DownloadItem[];
  /** 本地要执行的动作（如运行安装器、打补丁） */
  actions: LocalAction[];
  /** 该步骤是否必须等前一步完全结束 */
  serial: boolean;
}

export type LocalAction =
  | { kind: 'run-installer'; jarPath: string; args: string[] }
  | { kind: 'apply-optifine-patch'; inputJar: string; outputDir: string }
  | { kind: 'write-json'; path: string; content: string }
  | { kind: 'verify-hashes'; paths: string[] };

/**
 * 安装计划：**纯数据，下载前可完全算出来**
 * 好处：可预览、可显示准确体积、可序列化续传、可单元测试（ADR-002）
 */
export interface InstallPlan {
  mcVersion: string;
  instanceName: string;
  slug: string;
  loader: LoaderInstall | null;
  addons: AddonInstall[];
  apiLibraries: ApiLibraryOption[];
  javaMajor: number;
  /** 去重后的全部下载项 */
  downloads: DownloadItem[];
  steps: InstallStep[];
  /** 汇总指标 */
  summary: {
    /** 需要真正下载的字节数（已扣除缓存命中） */
    downloadBytes: number;
    /** 可从本地缓存复用的字节数 */
    reusedBytes: number;
    /** 落盘总字节数 */
    installBytes: number;
    /** 预估耗时（秒） */
    estimatedSeconds: number;
    fileCount: number;
    /** 去重省下的字节数 */
    dedupedBytes: number;
  };
  /** 需要用户额外知道的事情（如"将自动安装 Fabric API"） */
  notes: string[];
}

/** 进度上报（Rust → 前端，高频，由前端节流聚合到 60ms） */
export interface InstallProgress {
  planId: string;
  phase: InstallPhase;
  /** 0–100 */
  percent: number;
  finishedFiles: number;
  totalFiles: number;
  bytesPerSecond: number;
  /** 当前正在处理的文件，用于展示 */
  currentFile: string;
  /** 剩余秒数估计 */
  etaSeconds: number;
}
