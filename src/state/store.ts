/**
 * 应用状态（单一真相源）
 * ------------------------------------------------------------------
 * ★ 导航层级参照 PCL2 的「正副级页面」：
 *
 *   一级（侧边栏 4 项）
 *     启动 / 版本列表 / 下载 / 设置
 *
 *   二级（进入某个版本后）
 *     概览 / 设置 / Mod 管理 / 日志
 *
 *   为什么不做成 7 个平级入口：
 *     「实例设置」与「Mod 管理」在语义上属于**某个版本**，把它们做成全局页
 *     就必须再补一个"实例切换器"来告诉页面"在改哪个实例"——
 *     那个切换器是多出来的点击，根源是页面结构错了。
 *     放进二级导航后，上下文由"你从哪个版本进来的"天然决定。
 */
import type {
  AddonKind,
  BaseLoaderKind,
  Instance,
  InstanceConfig,
  JavaRuntime,
  ModEntry,
  ModStateResult,
  ReleaseType,
} from '../domain';
import type { RunningGameInfo, IsolationInfo } from '../bridge/tauri';
import { applyPresenceBeat, type FriendNotes, type PresenceBeat, type PresenceMap } from '../domain/friends.ts';
import type { FriendsSettings, FriendsSnapshot } from '../bridge/tauri';
/*
 * ★ 2026-09-30：这里原来写的是 `'../ui/theme'`（**没有扩展名**）。
 *   Vite 能解析它，所以界面一直正常 —— 但 Node 的 ESM 解析器不能，
 *   于是 `node --test tests/multi-instance.test.mjs`（它 `await import('../src/state/store.ts')`）
 *   在 `ERR_MODULE_NOT_FOUND: src/ui/theme` 上直接挂掉：
 *   **整个测试文件 0 通过**，而它在 `pnpm test` 的名单里 —— 也就是说这条回归测试
 *   已经有一段时间没真正跑过了（`tools/verify.mjs` 用的是另一份名单，所以没露出来）。
 *
 *   加上扩展名之后两边都能解析。仓库里其余跨模块导入早就带 `.ts` 了。
 */
import { DEFAULT_THEME, type ThemeId } from '../ui/theme.ts';
import type { ModFilter } from '../domain/mods.ts';

/* ====================== 领域侧的数据形状 ====================== */

export interface GameVersionRow {
  id: string;
  releaseType: ReleaseType;
  releasedAt: string;
  javaMajor: number;
  bytes: number;
  installed: boolean;
  instanceCount: number;
}

export interface TaskItem {
  id: string;
  title: string;
  detail: string;
  phase: string;
  percent: number;
  finishedFiles: number;
  totalFiles: number;
  /*
   * ★★★★ 2026-10-07（用户截图：「**这个下载显示，有bug啊，信息不全**」）：
   *   `finishedBytes` / `totalBytes` 是**新加的**。
   *
   *   在这之前任务卡片只有"第 N/M 个文件"和"X /s"两行，
   *   而**一个 66 MB 的整合包体**几乎全花在**单个文件**上 ——
   *   "第 1/380 个文件"这个数字在那几分钟里**根本不动**，
   *   用户看到的就是"信息不全、像卡住了"。
   *
   *   字节数才是那个阶段唯一在动的量：
   *     · `finishedBytes / totalBytes` 能回答"还有多少"（文件数回答不了）；
   *     · 剩余时间要用**字节**算才准（用文件数算是拿"剩余文件数×平均"瞎估）。
   */
  finishedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  currentFile: string;
  etaSeconds: number;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  error?: string;
  /**
   * ★★★★ 2026-10-17（用户：「装完了但缺 N 个文件」）：**这一次还缺几个**。
   *
   *   `partial`（装上了但有缺）**也算成功**（实例照建、任务照旧结束），
   *   所以任务状态仍然是 `done` —— 但那种卡片上写一个笼统的「完成」
   *   就是那句假话的另一个出口。有它时角标写「缺 N 个」。
   *
   *   `0` / 缺省 = 没有缺件这件事（照旧显示「完成」）。
   */
  missingCount?: number;
}

export interface ToastItem {
  id: string;
  /** 正在退场（CSS 用这个类走淡出动画，动画完再真删） */
  leaving?: boolean;
  kind: 'ok' | 'err' | 'info' | 'warning';
  title: string;
  desc?: string;
  sticky: boolean;
}

export interface MachineInfo {
  totalMemoryGb: number;
  availableMemoryGb: number;
  cpuCount: number;
  os: string;
  arch: string;
  dataDir: string;
  /**
   * 当前游戏根目录里装了几个版本（读盘得到的磁盘事实）。
   *
   * ★★ 2026-09-25：`versionCount === 0` = "你选的这个目录里还没有版本" ——
   *   版本列表据此在换目录之后把话说明白（见 `VersionsPage` 顶部那条提示）。
   */
  versionCount: number;
}

export interface JavaState {
  runtimes: JavaRuntime[];
  scanning: boolean;
}

export interface ModsState {
  entries: ModEntry[];
  states: Map<string, ModStateResult['state']>;
  filter: ModFilter;
  query: string;
  selected: Set<string>;
  loading: boolean;
}

/* ====================== 导航 ====================== */

/** 一级页面（侧边栏） */
export type PageId =
  | 'launch'
  | 'versions'
  | 'download'
  | 'settings'
  /** ★★ 2026-10-09：好友页（左侧主导航第五项，只有一个入口） */
  | 'friends'
  | 'changelog'
  /**
   * ★★ MC 新闻页（游戏本体的版本动态）。
   *
   *   入口在**侧栏下半部分**（`side-links` 里、「更新日志」上面），不是左侧主导航 ——
   *   用户选的位置。理由：主导航那五项是"启动器的主流程"（启动 / 版本 / 下载 / 设置 / 好友），
   *   而"看游戏出了什么新版本"与「更新日志」「关于」一样是**看内容**的入口，
   *   挂在下面不抢主流程，也和「更新日志」挨在一起（一个是启动器的日志、一个是游戏的）。
   */
  | 'news'
  | 'about'
  /** ★★ 2026-09-23（C5）：资源的**独立安装页** —— 点「安装」从这里进，不再内联展开 */
  | 'resource';

/** 二级页面（进入某个版本之后） */
export type SubPageId = 'overview' | 'setup' | 'mods' | 'logs';

/**
 * 下载页的页签
 * ★ 0.1.0-beta.1 扩成六个（用户要求）：Mod / 资源包 / 光影 / 数据包
 *   **一字排开**，而且每一格都是"能装什么"的资源中心。
 *   旧的 `mods` 那一格列的是"每个版本各装了什么 Mod"（**已有**的东西）——
 *   玩家点「下载」想要的是"有什么能装"，所以它被替换掉，
 *   "本机装了什么"回到 Mod 管理页（那一页本来就是干这个的）。
 *
 * ★★ 2026-09-23 晚（用户）：「**把安装版本合并到下载里**」——
 *   「安装游戏」从独立页（`PageId` 里那个 `'install'`）**搬回下载页的第一个页签**。
 *
 *   ★ 与当天早些时候那条（"单开一页以解放视觉繁乱"）关系是：**分开的东西要合并，
 *     但"繁乱"要治**。所以合并回去的不是原来那个一屏两层导航的安装器，而是
 *     **两步向导**（第 1 步选版本 / 第 2 步选加载器）—— 每一屏仍然只回答一个问题，
 *     而侧栏少一个和「下载」平级的入口（用户的原话是"合并到下载里"）。
 *
 *   ★ 为什么这次把 `'game'` 写回联合类型：它是**真的**又有一个页签在渲染它了
 *     （上一轮删掉它的理由就是"不许出现没人渲染的页签"）。
 */
export type DownloadTab = 'game' | 'modpack' | 'mod' | 'resourcepack' | 'shader' | 'datapack';

export interface AppState {
  /* --- 导航 --- */
  page: PageId;
  /**
   * 当前打开的版本（二级页面的上下文）。
   * null = 还没进入任何版本 → 侧边栏显示一级导航。
   */
  openInstanceId: string | null;
  /** 二级页面当前项 */
  subPage: SubPageId;
  /** 下载页当前页签 */
  downloadTab: DownloadTab;
  /**
   * 下载页要**装进哪个实例**（由别的页面带过来）。
   *
   * ★ 2026-09-17 新增。在此之前这件事靠 `ieml:download-target` **事件**传递，
   *   而 `DownloadPage` 的监听器是在它**挂载之后**的 effect 里注册的 ——
   *   从"版本列表 / 概览页"点「安装 Mod」时下载页还没挂载，事件当场丢掉，
   *   于是玩家以为自己选的版本生效了，其实装到了"最近玩过的那个"上，
   *   **而且界面上看不出来**。
   *
   *   这与 `goDownloadTab` 当初解决的问题是**同一个**（见 AppContext 里那段注释：
   *   "事件在目标页挂载前被丢掉"）。所以修法也一样：放进 state，一次派发定下来，
   *   不依赖任何事件时序。
   *
   * null = 没指定 → 下载页沿用原来的"最近玩过的那个"。
   */
  downloadTargetId: string | null;

  /**
   * ★★ 2026-09-23（C5）：独立安装页要装的那个资源。
   *
   *   为什么放在 state 而不是组件里：切到安装页之后，**列表组件会卸载**，
   *   目标必须活在页面之外（与 `downloadTargetId` 上面那条教训同一个道理 ——
   *   "事件在目标页挂载前被丢掉"）。
   *
   *   `hit` 保持 unknown：store 这一层不解析 Modrinth 的字段（那是界面的活）。
   */
  resourceTarget: { hit: unknown; kind: string; source?: string } | null;

  /* --- 全局 --- */
  theme: ThemeId;
  ready: boolean;
  bootError: string | null;

  /* --- 数据 --- */
  machine: MachineInfo | null;
  /**
   * 后端版本号（`app_info` 的 `version`）。
   *
   * ★ 与 `domain/version-info.ts` 的 `APP_VERSION` **不是**同一个来源：
   *   这个是编译进 exe 的 `env!("CARGO_PKG_VERSION")`，那个是前端常量。
   *   两个都显示出来，"改了版本号没重新构建"就一眼可见。
   */
  backendVersion: string;
  versions: GameVersionRow[];
  instances: Instance[];
  /** 上次启动用的实例（"启动"页默认选它） */
  lastInstanceId: string | null;

  java: JavaState;
  mods: ModsState;

  /**
   * ★★ **每个实例的隔离判定**（ADR-005）—— 按 slug 索引，**结论来自后端**。
   *
   *   为什么不让前端自己算：ADR-006（规则只写一次，写在 Rust 侧）。
   *   以前 `domain/isolation.ts` 有一份、`commands.rs::resolve_isolation` 有另一份、
   *   而真正决定游戏目录的 `prepare_spec` **两份都不看** —— 于是「不隔离」
   *   选了等于没选（界面写着会共享，游戏其实还在自己的目录里）。
   *   现在：判定在 `domain::isolation`，界面只负责显示 `reason` / `warning` / `game_dir`。
   */
  isolation: Record<string, IsolationInfo>;

  /* --- 运行时 --- */
  tasks: TaskItem[];
  toasts: ToastItem[];
  /*
   * ★★ 正在运行的游戏：**按实例 id 索引的一张表**（2026-09-15，多开实例）。
   *
   *   以前是 `{instanceId, startedAt, pid} | null` —— 一个槽。于是"同一个时刻
   *   只能有一个在跑"这件事被**写死在状态模型里**：界面即便想显示两个也装不下。
   *
   *   判据只有一处（`isInstanceRunning`），下面所有地方都从它取结论，
   *   不许各自写 `running?.instanceId === x`（那正是"两套判据迟早打架"的老路）。
   */
  running: Record<string, { startedAt: number; pid: number | null }>;

  /* --- 好友（正版专用，2026-10-12）----------------------------------------
   *
   * 名单来自服务端（`GET /friends`），在线状态来自心跳（`POST /presence`）。
   * 两者都可能"还没拿到" ⇒ 每个字段都能是 null，界面据此写"未知"而**不编**
   * （"离线"与"不知道"是两件事，这个仓库在这上面栽过好几次）。
   */
  friends: {
    /** 服务端给的名单（好友 + 收到/发出的请求）；null = 还没取到 */
    snapshot: FriendsSnapshot | null;
    /**
     * profileId（小写）→ 在线状态。取值只有服务端报过的那几个；
     * `null` = **他在服务端的在场名单里，但那一行没带 status** ⇒ 在线（见 `resolvePresence`）。
     */
    presence: PresenceMap;
    /**
     * ★★ 上一次**成功**拿到在场列表的时刻（null = 从没成功过）。
     *
     *   它决定"不在列表里的人"怎么解释 —— 见 `domain/friends.ts` 的
     *   `resolvePresence`：成功拿到过 ⇒ 缺席就是**离线**（与游戏客户端一致，
     *   用户 2026-10-12 的截图是判据）；从没拿到过 ⇒ 才是「未知」。
     *
     *   ★ 失败时**不许**动它（2026-10-17）：把"未知"盖成"已知"就是用户看到的
     *     "十个好友全离线"。判据在 `applyPresenceBeat`。
     */
    presenceAt: number | null;
    /**
     * ★★ 最近一次**在场状态**没拿到的原因（2026-10-17，null = 没失败）。
     *
     *   为什么要单独一个字段、而不是并进 `error`：名单与在场是**两件事** ——
     *   名单拿到了、状态没拿到时，页面必须能说清"这几行状态可能过时"，
     *   而不是把整个好友页判成失败。见 `domain/friends.ts::applyPresenceBeat`。
     */
    presenceError: string | null;
    /** 谁能加我 / 谁能邀请我 */
    settings: FriendsSettings | null;
    /** 正在取（界面显示骨架/转圈） */
    loading: boolean;
    /** 上一次失败的原因（**留在界面上**，不跟着 toast 消失） */
    error: string | null;
    /** 上一次成功拿到名单的时刻 */
    updatedAt: number | null;
    /**
     * ★★ **好友页现在开着吗**（2026-10-12，用户给的设计图要它）。
     *
     *   名单的检查频率按它切换：开着**每分钟**、关着**每 5 分钟**
     *   （规则与常量在 `domain/friends.ts` 的 `friendsPollIntervalMs`，有用例）。
     *   页面在挂载/卸载时置它。
     */
    pageOpen: boolean;
  };


  /* --- 弹窗 --- */  /*
   * ★★ 2026-09-28：这里原来有一个 `createOpen` 字段与 `create/open` / `create/close`
   *   两个 action —— **全仓库没有任何地方读它**（`CreateInstanceModal` 用的是它自己的
   *   `useState`，入口走 `ieml:create` 事件）。
   *   一份没人读的状态比没有状态更糟：它会让人以为"弹窗开着"这件事在 store 里。
   *   ⇒ 删掉。弹窗的开合只由它自己和那个事件决定。
   */
  /** 崩溃/日志弹窗内容（null = 关闭） */
  crashReport: string | null;

  /* --- 全局偏好 --- */
  prefs: {
    globalIsolation: 'isolated' | 'shared';
    globalMemoryMb: number;
    /** ★ 2026-09-22：只剩「自动」（官方优先、慢则镜像）—— 那个选择器已经删掉 */
  downloadSource: 'auto' | 'bmclapi' | 'mojang';
    concurrentDownloads: number;
    modSource: 'modrinth' | 'both';
    particleEffects: boolean;
    reducedMotion: boolean;
    /** ★ 启动游戏前自动备份（ADR-014，默认开）。Rust 侧也读它，见下面的说明 */
    autoBackup: boolean;
    offlineUsername: string;
    accountUuid: string | null;
    /**
     * ★★★★ **上一次那个正版账号是谁**（2026-10-09 修 bug 时加的）。
     *
     *   用户报：「切换到离线登录，再切回正版登录**要重新登录**」。
     *   根因就是这件事原来只记在 `AccountMenu` 的一个 `useRef` 里 ——
     *   而那个组件一进版本二级页就被卸载（侧栏整体换掉），重启更不用说；
     *   切离线时又把 `accountUuid` 写成了 `null` 并落盘，
     *   于是"切回正版"只找到"没有可切回的正版账号"→ 弹登录面板。
     *
     *   ★ 两件事必须**分开记**（判断在 `domain/account.ts`，那边有用例）：
     *     `accountUuid`     = 现在用哪个（切离线会改它）
     *     `lastPremiumUuid` = 上一个正版号是谁（**切离线时不许清**）
     *   正版凭据一直在系统凭据管理器里，所以有这个 uuid 就能直接切回去、不用重登。
     */
    lastPremiumUuid: string | null;
    windowWidth: number;
    windowHeight: number;
    globalJvmArgs: string;
    globalGameArgs: string;
    /**
     * ★★ **被用户删掉过的版本目录名**（墓碑，2026-09-30）。
     *
     * ## 为什么需要它
     *
     *   用户报过一条很气人的现象：「删除实例时，你根本不知道删的是哪里的，
     *   有时还会**诈尸**，删了的又回来」。
     *
     *   根因是**账本被当成了"这个版本存在"的证据**，而盘上那个版本目录还在：
     *     · 启动时 `platform::adopt_records` 会把老位置那份**陈旧账本**补进来
     *       （`should_take_record` 只看"目标是不是空列表"，不看目录还在不在）；
     *     · 前端「账本是空的、而文件夹里有版本 → 自动认领一个」（`pickAutoAdopt`）
     *       也会把它重新建成一个实例。
     *
     *   现在删实例会连**版本目录**一起删（那就彻底没了，诈尸不了）；
     *   但"只从列表里移除、文件留着"是允许的（用户可能只想让它别再出现）。
     *   那种情况下只有这份墓碑能挡住自动认领。
     */
    deletedVersions: string[];
    /**
     * ★★★★ **好友备注**（2026-10-12 接上真服务之后改的）。
     *
     *   原来这里存的是一份**本机自己攒的好友名单**（胚子阶段的产物）。
     *   现在名单以**服务端为准**（`GET /friends`，正版令牌），
     *   本机只留"这个人是我的谁"这种只有用户知道的信息：
     *   `profileId → 备注`。
     *
     *   ★ 它**绝不参与"谁是好友"的判断** —— 判断只有服务端那一份。
     *     所以换台机器、重装启动器，好友自动都在；备注没了也只是少了括号里那句。
     *   ★ 解析/写入的规则在 `domain/friends.ts`（那边有 10 条用例）。
     */
    friendNotes: FriendNotes;
  };
}

/* ====================== 初始状态 ====================== */

/**
 * ★ Mod 列表是「当前打开的版本」的派生数据，不是全局数据。
 *
 * 为什么单独提出来：第 13 轮之前，Mod 列表只在「Mod 管理」页被载入，
 * 而概览页与侧栏徽标都会读它 —— 于是从概览页看是「0 个 Mod」，
 * 点进 Mod 管理才变成 25 个，同一个版本两个数字。现在在切换版本时
 * 清空，保证「看到的数字要么是 0（还没载入）要么是真的」，
 * 不允许出现"别的版本的残留值"。
 */
const EMPTY_MODS = {
  entries: [] as ModEntry[],
  states: new Map<string, ModStateResult['state']>(),
  filter: 'all' as ModFilter,
  query: '',
  selected: new Set<string>(),
  loading: false,
};

export const initialState: AppState = {
  page: 'launch',
  /**
   * 独立安装页要装的那个资源。
   *
   * ★ 为什么放在 state 里：切页之后列表组件会**卸载**，目标必须活在页面之外
   *   （与 `openVersion` 那套同一个道理）。
   * ★ 类型用 unknown 收窄：store 不想依赖 bridge 的类型（那一层是"壳"，不是领域）。
   */
  resourceTarget: null as { hit: unknown; kind: string } | null,
  openInstanceId: null,
  subPage: 'overview',
  /* ★ 2026-09-23 晚：安装游戏合并回下载页 → 默认页签回到第一格「安装游戏」 */
  downloadTab: 'game',
  downloadTargetId: null,

  theme: DEFAULT_THEME,
  ready: false,
  bootError: null,

  machine: null,
  backendVersion: '',
  versions: [],
  instances: [],
  lastInstanceId: null,

  java: { runtimes: [], scanning: false },
  mods: { ...EMPTY_MODS },

  /* 隔离判定：启动时由 AppContext 拉一次（空表 = 还没拉到，界面显示"读取中"而不是猜） */
  isolation: {},

  tasks: [],
  toasts: [],
  running: {},
  /* ★ 好友：初始全是"没拿到"。它由 AppContext 在拿到 uuid 之后去取。 */
  friends: {
    snapshot: null,
    presence: {},
    presenceAt: null,
    presenceError: null,
    settings: null,
    loading: false,
    error: null,
    updatedAt: null,
    pageOpen: false,
  },

  crashReport: null,

  prefs: {
    globalIsolation: 'isolated',
    globalMemoryMb: 4096,
    downloadSource: 'auto',
    concurrentDownloads: 64,
    modSource: 'modrinth',
    particleEffects: true,
    reducedMotion: false,
    /**
     * ★★ 启动游戏前自动备份（ADR-014：**默认开启**，"触发时机为启动游戏前"）。
     *
     *   这个字段**Rust 侧也要读**（启动命令在 Rust 里跑，那一刻前端可能还没起来），
     *   所以它必须落在 `prefs.json` 里，而不是只活在内存或 localStorage。
     *   读取处：`commands_real::auto_backup_enabled`。
     */
    autoBackup: true,
    offlineUsername: 'Player',
    accountUuid: null,
    /* ★ 上一个正版号是谁（切离线时不清它 —— 见类型那一段说明） */
    lastPremiumUuid: null,
    windowWidth: 1280,
    windowHeight: 720,
    globalJvmArgs: '',
    globalGameArgs: '',
    // ★ 墓碑列表（见字段说明）：默认空，"删了又回来"这条缺陷靠它挡住
    deletedVersions: [],
    friendNotes: {},
  },
};

/* ====================== 动作 ====================== */

export type Action =
  /**
   * ★★ C5：打开 / 关闭独立安装页的目标。
   *   `hit` 是 Modrinth 的项目信息（界面原样用，store 不解析它）。
   */
  /**
   * ★★ 2026-09-23：**重新对了一遍磁盘之后的实例列表**（用户第 3 条）。
   *   只换 instances —— 别的一律不动（刷新不该顺手改选中、改页面）。
   */
  | { type: 'instances/refresh'; instances: AppState['instances'] }
  /*
   * ★★ 2026-09-25：只换"机器信息"这一项。
   *   起因：换游戏根目录现在**即时生效**（用户：「切换游戏数据应该是实时的」），
   *   换完要立刻把 `machine.dataDir` 换成新的 —— 而那时**其它启动数据都不该动**
   *   （实例清单、Java、偏好各自有各自的刷新路径）。用 `boot/ok` 顶一遍会把
   *   整份启动结果重写，等于把别的数据也当成刚启动。
   */
  | { type: 'machine/set'; machine: MachineInfo }
  /*
   * ★★ 2026-09-25（用户：「版本列表的计数不是实时更新的」）：
   *
   *   只更新「当前文件夹里有几个版本」这一个数。
   *
   *   为什么需要它：这个数现在**决定**版本列表页头、侧栏角标与筛选里的"全部 N" ——
   *   而它们必须是同一个数。`machine_info` 只在启动与换目录时刷新，
   *   所以**版本列表页每次真读盘扫完**就把结果推回来（那是唯一知道最新值的地方）。
   *   ★ 这样一来"装完一个版本，角标还停在旧数"不会发生：装完回到这一页就会刷新。
   */
  | { type: 'machine/versionCount'; count: number }
  | { type: 'resource/open'; hit: unknown; kind: string; source?: string }
  | { type: 'resource/close' }
  | {
      type: 'boot/ok';
      machine: MachineInfo;
      /** 后端版本号（`app_info` 的 `version`）；拿不到就给空串 */
      backendVersion?: string;
      versions: GameVersionRow[];
      instances: Instance[];
      java: JavaRuntime[];
      lastInstanceId: string | null;
      /**
       * 从磁盘恢复的全局偏好（可选）。
       *
       * ★ 以前没有这个字段 —— 偏好只活在内存里，重启全部丢失，
       *   连正版登录的 accountUuid 都没了（用户第二天变成离线 "Player"）。
       *   审计发现并修复，见 `AppContext` 里的 prefs 落盘 effect。
       */
      prefs?: Partial<AppState['prefs']>;
      /** 主题是顶层字段（不在 prefs 里），但同样要持久化 */
      theme?: ThemeId;
    }
  | { type: 'boot/fail'; error: string }
  /* 导航 */
  | { type: 'nav'; page: PageId }
  | { type: 'nav/open-instance'; id: string }
  /** ★ 打开某个版本并**直接落在指定页签**（一次 dispatch，无顺序契约） */
  | { type: 'nav/open-instance-sub'; id: string; sub: SubPageId }
  | { type: 'nav/close-instance' }
  | { type: 'nav/sub'; sub: SubPageId }
  | { type: 'nav/download-tab'; tab: DownloadTab }
  /** 指定下载页要装进哪个实例；`id: null` = 交回给"最近玩过的那个" */
  | { type: 'nav/download-target'; id: string | null }
  | { type: 'theme'; theme: ThemeId }
  /* 实例 */
  | { type: 'instances/set'; instances: Instance[] }
  | { type: 'instances/add'; instance: Instance }
  | { type: 'instances/update'; id: string; patch: Partial<Instance> }
  | { type: 'instances/config'; id: string; patch: Partial<InstanceConfig> }
  | { type: 'instances/remove'; id: string }
  | { type: 'instances/last'; id: string | null }
  /* 版本 */
  | { type: 'versions/set'; versions: GameVersionRow[] }
  | { type: 'versions/installed'; id: string; installed: boolean }
  /* Java */
  | { type: 'java/scanning'; scanning: boolean }
  | { type: 'java/set'; runtimes: JavaRuntime[] }
  | { type: 'java/remove'; path: string }
  /* Mod */
  | { type: 'mods/loading'; loading: boolean }
  | { type: 'mods/set'; entries: ModEntry[]; states: Map<string, ModStateResult['state']> }
  | { type: 'mods/filter'; filter: ModFilter }
  | { type: 'mods/query'; query: string }
  | { type: 'mods/toggle-select'; path: string }
  | { type: 'mods/select-all'; paths: string[] }
  | { type: 'mods/clear-select' }
  | { type: 'mods/toggle-enabled'; path: string }
  /* 任务 */
  | { type: 'task/add'; task: TaskItem }
  | { type: 'task/patch'; id: string; patch: Partial<TaskItem> }
  | { type: 'task/remove'; id: string }
  /* 运行态（多开实例：都带实例 id） */
  | { type: 'game/start'; instanceId: string; pid: number | null; startedAt?: number }
  | { type: 'game/stop'; instanceId: string }
  | { type: 'game/stop-all' }
  | { type: 'game/sync'; list: RunningGameInfo[] }
  /* Toast */
  | { type: 'toast/add'; toast: ToastItem }
  | { type: 'toast/leaving'; id: string }
  | { type: 'toast/remove'; id: string }
  /* 弹窗 */
  | { type: 'crash/show'; report: string }
  | { type: 'crash/hide' }
  /* 偏好 */
  | { type: 'prefs/patch'; patch: Partial<AppState['prefs']> }
  /* ★ 好友切片：每一样都可以单独更新（心跳只更新 presence，列表只更新 snapshot） */
  | { type: 'friends/patch'; patch: Partial<AppState['friends']> }
  /*
   * ★★ 一次**在场心跳**的结论（2026-10-17）。
   *
   *   为什么不直接 dispatch 一个算好的 patch：算"这次心跳该得出什么"需要
   *   **当前**那份 presence（失败要保住它、304 要沿用它）—— 而调用它的
   *   `useEffect` 只在 `[ready, uuid, pageOpen]` 变化时重建，闭包里那份 state
   *   是**旧的**。交给 reducer 算就没有这个坑（它拿到的永远是当前 state）。
   *   判据本身（纯函数）在 `domain/friends.ts::applyPresenceBeat`，那边有用例。
   */
  | { type: 'friends/presence'; beat: PresenceBeat; now: number }
  /* ★★ 隔离判定（ADR-005）：整批换掉 —— 它是后端算的结论，前端不许自己拼 */
  | { type: 'isolation/set'; list: IsolationInfo[] };

/* ====================== Reducer ====================== */

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    /* ★ 只换机器信息（换游戏根目录之后要立刻反映新路径），别的一概不动 */
    case 'machine/set':
      return { ...state, machine: action.machine };
    /* ★ 只换"当前文件夹里有几个版本"（版本列表页扫完推回来；machine 还没到时不动） */
    case 'machine/versionCount':
      return state.machine
        ? { ...state, machine: { ...state.machine, versionCount: action.count } }
        : state;
    case 'boot/ok':
      return {
        ...state,
        ready: true,
        bootError: null,
        machine: action.machine,
        backendVersion: action.backendVersion ?? state.backendVersion,
        versions: action.versions,
        instances: action.instances,
        java: { ...state.java, runtimes: action.java },
        // ★ 恢复磁盘上的全局偏好（下载源 / 并发 / 窗口 / 离线名 / 账号 …）
        prefs: action.prefs ? { ...state.prefs, ...action.prefs } : state.prefs,
        theme: action.theme ?? state.theme,
        // 上次启动的实例没了就退回第一个
        lastInstanceId:
          action.lastInstanceId && action.instances.some((i) => i.id === action.lastInstanceId)
            ? action.lastInstanceId
            : (action.instances[0]?.id ?? null),
      };

    case 'boot/fail':
      return { ...state, ready: true, bootError: action.error };

    /* ---------- 导航 ---------- */
    case 'instances/refresh':
      return { ...state, instances: action.instances };
    case 'resource/open':
      /*
       * ★★ 2026-09-24（C-18 修复）：把**来源**一起带过去。
       *   安装页原来在信息卡上写死「来自 Modrinth」—— 从 CurseForge 搜出来的包
       *   也这么写，等于告诉用户一个假事实（他刚从 CF 那一栏点进来的）。
       */
      return {
        ...state,
        resourceTarget: { hit: action.hit, kind: action.kind, source: action.source },
      };
    case 'resource/close':
      return { ...state, resourceTarget: null };
    case 'nav':
      // 切换一级页面时退出二级页面（避免"看起来还在那个版本里"）
      return { ...state, page: action.page, openInstanceId: null, mods: { ...EMPTY_MODS } };

    case 'nav/open-instance':
      // 双击版本 → 进入它的二级页，默认落在「概览」；Mod 列表清空等待重新载入
      return {
        ...state,
        openInstanceId: action.id,
        subPage: 'overview',
        mods: { ...EMPTY_MODS },
      };

    /*
     * ★★ 「打开某个版本，并且**直接落在指定页签**」。
     *
     *   为什么需要单独一个 action（而不是 `setSubPage` + `openVersion` 两次 dispatch）：
     *   `nav/open-instance` 会把 `subPage` **归零成 overview**，
     *   所以"先切页签再打开版本"会被覆盖，"先打开版本再切页签"又依赖
     *   两次 dispatch 的先后语义 —— 那是**隐式契约**，改一次就悄悄坏掉。
     *
     *   用户报的「根本没这个功能键，我怎么装 mod 嘛」促成的入口
     *   （版本列表 ⋯ → 安装 Mod）需要"打开这个版本并直接进 Mod 页"，
     *   所以把意图放进**一次** action 里，没有顺序问题。
     */
    case 'nav/open-instance-sub':
      return {
        ...state,
        openInstanceId: action.id,
        subPage: action.sub,
        mods: { ...EMPTY_MODS },
      };

    case 'nav/close-instance':
      return { ...state, openInstanceId: null, mods: { ...EMPTY_MODS } };

    case 'nav/sub':
      return { ...state, subPage: action.sub };

    case 'nav/download-tab':
      return { ...state, downloadTab: action.tab };

    case 'nav/download-target':
      return { ...state, downloadTargetId: action.id };

    case 'theme':
      return { ...state, theme: action.theme };

    /* ---------- 实例 ---------- */
    case 'instances/set':
      return { ...state, instances: action.instances };

    case 'instances/add':
      return { ...state, instances: [...state.instances, action.instance] };

    case 'instances/update':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id ? { ...i, ...action.patch } : i,
        ),
      };

    case 'instances/config':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id ? { ...i, config: { ...i.config, ...action.patch } } : i,
        ),
      };

    case 'instances/remove': {
      const rest = state.instances.filter((i) => i.id !== action.id);
      return {
        ...state,
        instances: rest,
        openInstanceId: state.openInstanceId === action.id ? null : state.openInstanceId,
        lastInstanceId:
          state.lastInstanceId === action.id ? (rest[0]?.id ?? null) : state.lastInstanceId,
      };
    }

    case 'instances/last':
      return { ...state, lastInstanceId: action.id };

    /* ---------- 版本 ---------- */
    case 'versions/set':
      return { ...state, versions: action.versions };

    case 'versions/installed':
      return {
        ...state,
        versions: state.versions.map((v) =>
          v.id === action.id ? { ...v, installed: action.installed } : v,
        ),
      };

    /* ---------- Java ---------- */
    case 'java/scanning':
      return { ...state, java: { ...state.java, scanning: action.scanning } };

    case 'java/set':
      return { ...state, java: { ...state.java, runtimes: action.runtimes, scanning: false } };

    case 'java/remove':
      return {
        ...state,
        java: {
          ...state.java,
          runtimes: state.java.runtimes.filter((r) => r.path !== action.path),
        },
      };

    /* ---------- Mod ---------- */
    case 'mods/loading':
      return { ...state, mods: { ...state.mods, loading: action.loading } };

    case 'mods/set':
      return {
        ...state,
        mods: { ...state.mods, entries: action.entries, states: action.states, loading: false },
      };

    case 'mods/filter':
      return { ...state, mods: { ...state.mods, filter: action.filter } };

    case 'mods/query':
      return { ...state, mods: { ...state.mods, query: action.query } };

    case 'mods/toggle-select': {
      const next = new Set(state.mods.selected);
      if (next.has(action.path)) next.delete(action.path);
      else next.add(action.path);
      return { ...state, mods: { ...state.mods, selected: next } };
    }

    case 'mods/select-all':
      return { ...state, mods: { ...state.mods, selected: new Set(action.paths) } };

    case 'mods/clear-select':
      return { ...state, mods: { ...state.mods, selected: new Set() } };

    case 'mods/toggle-enabled': {
      // ★ 启用/禁用 = 改文件名后缀，状态由扩展名决定（源码事实）
      const entries = state.mods.entries.map((e) => {
        if (e.path !== action.path) return e;
        const nextEnabled = !e.enabled;
        const fileName = e.fileName.endsWith('.disabled')
          ? e.fileName.slice(0, -'.disabled'.length)
          : `${e.fileName}.disabled`;
        return { ...e, enabled: nextEnabled, fileName };
      });
      const states = new Map(state.mods.states);
      const target = entries.find((e) => e.path === action.path);
      if (target) states.set(action.path, target.enabled ? 'fine' : 'disabled');
      return { ...state, mods: { ...state.mods, entries, states } };
    }

    /* ---------- 任务 ---------- */
    case 'task/add':
      /*
       * ★★★★ 2026-10-07（用户截图：「这个下载显示，有bug啊，信息不全」）。
       *
       *   **默认值必须补在这里，不能只靠调用方。**
       *
       *   任务是通过 `window.dispatchEvent(new CustomEvent('ieml:task-add', …))`
       *   建的，而接收端用的是 `(e as CustomEvent<TaskItem>).detail` ——
       *   一个**强制转型**。于是：
       *     · 事件里少写一个字段，TypeScript **不会报错**（这是断言，不是检查）；
       *     · 这个对象又被原样存进 state；
       *     · 界面上那个字段就是 `undefined`，而渲染处写的是 `t.totalBytes > 0`
       *       —— `undefined > 0` 是 false，于是整块**静默不显示**。
       *
       *   实测就是这样：我加了 `finishedBytes` / `totalBytes` 之后跑 `tsc`，
       *   **零报错**，而三处创建点里有两处根本没带这两个字段。
       *
       *   ⇒ 收口在这一处补齐：谁忘了带都不会让界面缺一块。
       *     ★ 与 `patchTask` 的分工：这里管"建的时候就有个合理的零"，
       *       进度事件负责往后填真值。
       */
      return {
        ...state,
        tasks: [
          ...state.tasks,
          {
            ...action.task,
            /*
             * ★ 显式 `?? 0`，而且**放在展开之后**。
             *   写成 `{ finishedBytes: 0, ...action.task }` 是错的 ——
             *   后展开的会覆盖默认值，字段仍然是 `undefined`
             *   （TypeScript 会报 TS2783，这一条就是它替我挡下来的）。
             */
            finishedBytes: action.task.finishedBytes ?? 0,
            totalBytes: action.task.totalBytes ?? 0,
          },
        ],
      };

    case 'task/patch':
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)),
      };

    case 'task/remove':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== action.id) };

    /* ---------- 运行态（多开实例：一张表，按实例 id 增删） ---------- */
    case 'game/start':
      return {
        ...state,
        running: {
          ...state.running,
          [action.instanceId]: {
            // ★ 传了 startedAt 就用它（后端知道真实的启动时刻，界面重新加载后靠它对表）
            startedAt: action.startedAt ?? Date.now(),
            pid: action.pid,
          },
        },
        lastInstanceId: action.instanceId,
      };

    case 'game/stop': {
      const { [action.instanceId]: _gone, ...rest } = state.running;
      return { ...state, running: rest };
    }

    /** 全停：后端退出收尾用（例如"停止全部"按钮 / 界面重新加载后对不上表） */
    case 'game/stop-all':
      return { ...state, running: {} };

    /** 用后端的事实**覆盖**本地的表（重新加载后对表；判据不猜，以后端为准） */
    case 'game/sync':
      return {
        ...state,
        running: Object.fromEntries(
          action.list.map((g) => [g.instance_id, { startedAt: g.started_at * 1000, pid: g.pid }]),
        ),
      };

    /* ---------- Toast ---------- */
    case 'toast/add':
      if (state.toasts.some((t) => t.kind === action.toast.kind && t.title === action.toast.title)) {
        return state;
      }
      return { ...state, toasts: [...state.toasts, action.toast].slice(-4) };

    /*
     * ★ 两段式移除的第一步：只打标记，**不删**。
     *   组件据此挂上 .leaving → 跑退场动画；动画完再 dispatch toast/remove。
     */
    case 'toast/leaving':
      return {
        ...state,
        toasts: state.toasts.map((t) => (t.id === action.id ? { ...t, leaving: true } : t)),
      };

    case 'toast/remove':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    /* ---------- 弹窗 ---------- */
    /* ★ `create/open` 与 `create/close` 已删（没人读那份状态，见字段那段的说明） */

    case 'crash/show':
      return { ...state, crashReport: action.report };

    case 'crash/hide':
      return { ...state, crashReport: null };

    /* ---------- 偏好 ---------- */
    case 'prefs/patch':
      return { ...state, prefs: { ...state.prefs, ...action.patch } };

    /* ★ 好友切片：每一样都能单独更新（心跳只动 presence，列表只动 snapshot） */
    case 'friends/patch':
      return { ...state, friends: { ...state.friends, ...action.patch } };

    /*
     * ★★ 在场心跳：**失败不许产出"没人在线"这个假事实**（2026-10-17，用户：
     *   「我的朋友游戏在线，但启动器读不到」）。三种结果各自的含义只写在
     *   `applyPresenceBeat` 一处（那边有判据）；这里只负责把它接到 state 上。
     */
    case 'friends/presence': {
      const next = applyPresenceBeat(
        {
          presence: state.friends.presence,
          presenceAt: state.friends.presenceAt,
          presenceError: state.friends.presenceError,
        },
        action.beat,
        action.now,
      );
      return { ...state, friends: { ...state.friends, ...next } };
    }

    /* ★★ 隔离判定整批换（后端算的结论；空列表也是有效结论，不是"没读到"） */
    case 'isolation/set':
      return {
        ...state,
        isolation: Object.fromEntries(action.list.map((i) => [i.slug, i])),
      };

    default:
      return state;
  }
}

/* ====================== 派生选择器 ====================== */

/** 当前打开的版本（二级页面的上下文） */
export function openInstance(state: AppState): Instance | null {
  if (!state.openInstanceId) return null;
  return state.instances.find((i) => i.id === state.openInstanceId) ?? null;
}

/** "启动"页默认选中的实例 */
export function launchTarget(state: AppState): Instance | null {
  if (state.instances.length === 0) return null;
  if (state.lastInstanceId) {
    const found = state.instances.find((i) => i.id === state.lastInstanceId);
    if (found) return found;
  }
  return state.instances[0] ?? null;
}

/*
 * ====================== 运行态（多开实例）======================
 *
 * ★★ **判据只有这一处**（ADR-050 的老规矩）。界面里任何"这个版本在不在跑"
 *   都必须问 `isInstanceRunning`，不许再写
 *   `state.running?.instanceId === inst.id` —— 那种写法在单槽时代是对的，
 *   改成表之后每一处都得跟着改，漏一处就是"这个页面说在跑、那个页面说没跑"。
 */

/** 这个实例**现在**在不在跑 */
export function isInstanceRunning(state: AppState, instanceId: string | null | undefined): boolean {
  return !!instanceId && instanceId in state.running;
}

/** 这个实例的运行信息（不在跑 = null） */
export function runningInfo(
  state: AppState,
  instanceId: string | null | undefined,
): { startedAt: number; pid: number | null } | null {
  if (!instanceId) return null;
  return state.running[instanceId] ?? null;
}

/** 一共几个在跑（顶栏的"运行中"角标用） */
export function runningCount(state: AppState): number {
  return Object.keys(state.running).length;
}

/**
 * 正在跑的那些实例（按启动时间排序，早的在前）。
 *
 * ★ 为什么要它：顶栏只说"3 个在运行"是不够的 —— 用户得能点开看到**是哪几个**、
 *   并且**逐个**停。这条返回的就是那个列表（实例对象 + 运行信息）。
 */
export function runningInstances(
  state: AppState,
): { inst: Instance; startedAt: number; pid: number | null }[] {
  return Object.entries(state.running)
    .map(([id, info]) => {
      const inst = state.instances.find((i) => i.id === id);
      return inst ? { inst, startedAt: info.startedAt, pid: info.pid } : null;
    })
    .filter((x): x is { inst: Instance; startedAt: number; pid: number | null } => x !== null)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function isForgeLike(instance: Instance | null): boolean {
  return instance?.loader?.kind === 'forge' || instance?.loader?.kind === 'neoforge';
}

/**
 * **有没有任务还在跑**（安装/下载）。
 *
 * ★★★★ 2026-10-08（用户）：「下载一个带模组加载器的版本时，会提示出现了一个
 *   不可用的原版和一个模组加载器（单独建立的文件夹）……**甚至模组加载器被识别为了
 *   可启动游戏版本**」。
 *
 *   安装是**一步一步往盘上写**的（先写版本描述、再下 jar 与库），所以在装的过程中
 *   版本列表看到的那些目录**本来就是半成品**。而自动认领（`pickAutoAdopt`）看的是
 *   同一份盘上事实，那一刻它就会把半成品认领成"用户唯一的版本"。
 *
 *   ⇒ 这条判据给调用方一个"现在别下结论"的闸门：**有任务在跑 = 盘上还在变**。
 *     只有 `pending` / `running` 算"在跑"：暂停/失败/取消/完成的任务都已经停在
 *     一个确定的形状上，那时认领是安全的。
 *
 * ★ 放这里而不是各自写 `state.tasks.some(...)`：这张任务表有**四个**写入方
 *   （`flows/install`、整合包两条路、实例概览的"一键补齐"），
 *   判据写两遍就一定会有一处忘了带上 `pending`。
 */
export function hasRunningTask(tasks: readonly TaskItem[]): boolean {
  return tasks.some((t) => t.status === 'pending' || t.status === 'running');
}

export function hasAddon(instance: Instance | null, kind: AddonKind): boolean {
  return instance?.addons.some((a) => a.kind === kind) ?? false;
}

export function canInstallBase(
  caps: { baseLoaders: Array<{ kind: BaseLoaderKind; available: boolean }> },
  kind: BaseLoaderKind,
): boolean {
  return caps.baseLoaders.find((b) => b.kind === kind)?.available ?? false;
}
