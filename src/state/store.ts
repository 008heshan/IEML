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
import type { RunningGameInfo } from '../bridge/tauri';
import { DEFAULT_THEME, type ThemeId } from '../ui/theme';
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
  bytesPerSecond: number;
  currentFile: string;
  etaSeconds: number;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

export interface ToastItem {
  id: string;
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
export type PageId = 'launch' | 'versions' | 'download' | 'settings';

/** 二级页面（进入某个版本之后） */
export type SubPageId = 'overview' | 'setup' | 'mods' | 'logs';

/**
 * 下载页的页签
 * ★ 原来的「游戏版本」「加载器」两个页签已合并成一个「安装游戏」页 ——
 *   选版本与选加载器本来就该在**同一页**完成（用户在那一页里同时做这两个选择），
 *   拆成两个页签会导致加载器页签不知道要装到哪个版本上。
 *
 * ★★ 0.1.0-beta.1 扩成六个（用户要求）：Mod / 资源包 / 光影 / 数据包
 *   **一字排开**，而且每一格都是"能装什么"的资源中心。
 *   旧的 `mods` 那一格列的是"每个版本各装了什么 Mod"（**已有**的东西）——
 *   玩家点「下载」想要的是"有什么能装"，所以它被替换掉，
 *   "本机装了什么"回到 Mod 管理页（那一页本来就是干这个的）。
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

  /* --- 弹窗 --- */
  createOpen: boolean;
  /** 崩溃/日志弹窗内容（null = 关闭） */
  crashReport: string | null;

  /* --- 全局偏好 --- */
  prefs: {
    globalIsolation: 'isolated' | 'shared';
    globalMemoryMb: number;
    downloadSource: 'bmclapi' | 'mojang';
    concurrentDownloads: number;
    modSource: 'modrinth' | 'both';
    particleEffects: boolean;
    reducedMotion: boolean;
    offlineUsername: string;
    accountUuid: string | null;
    windowWidth: number;
    windowHeight: number;
    globalJvmArgs: string;
    globalGameArgs: string;
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
  openInstanceId: null,
  subPage: 'overview',
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

  tasks: [],
  toasts: [],
  running: {},

  createOpen: false,
  crashReport: null,

  prefs: {
    globalIsolation: 'isolated',
    globalMemoryMb: 4096,
    downloadSource: 'bmclapi',
    concurrentDownloads: 64,
    modSource: 'modrinth',
    particleEffects: true,
    reducedMotion: false,
    offlineUsername: 'Player',
    accountUuid: null,
    windowWidth: 1280,
    windowHeight: 720,
    globalJvmArgs: '',
    globalGameArgs: '',
  },
};

/* ====================== 动作 ====================== */

export type Action =
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
  | { type: 'toast/remove'; id: string }
  /* 弹窗 */
  | { type: 'create/open' }
  | { type: 'create/close' }
  | { type: 'crash/show'; report: string }
  | { type: 'crash/hide' }
  /* 偏好 */
  | { type: 'prefs/patch'; patch: Partial<AppState['prefs']> };

/* ====================== Reducer ====================== */

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
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
      return { ...state, tasks: [...state.tasks, action.task] };

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

    case 'toast/remove':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    /* ---------- 弹窗 ---------- */
    case 'create/open':
      return { ...state, createOpen: true };

    case 'create/close':
      return { ...state, createOpen: false };

    case 'crash/show':
      return { ...state, crashReport: action.report };

    case 'crash/hide':
      return { ...state, crashReport: null };

    /* ---------- 偏好 ---------- */
    case 'prefs/patch':
      return { ...state, prefs: { ...state.prefs, ...action.patch } };

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

export function hasAddon(instance: Instance | null, kind: AddonKind): boolean {
  return instance?.addons.some((a) => a.kind === kind) ?? false;
}

export function canInstallBase(
  caps: { baseLoaders: Array<{ kind: BaseLoaderKind; available: boolean }> },
  kind: BaseLoaderKind,
): boolean {
  return caps.baseLoaders.find((b) => b.kind === kind)?.available ?? false;
}
