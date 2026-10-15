/**
 * 应用上下文
 * ------------------------------------------------------------------
 * 把 store、backend、以及一批跨页共用的动作集中在这里。
 *
 * ★ 导航模型（参照 PCL2 的正副级页面）：
 *   * `launchTarget` —— "启动"页要启动的那个实例（上次启动的，或第一个）
 *   * `openInstance` —— 二级页面的上下文（双击某个版本后才有）
 *   两者刻意分开：启动页的选中项不该影响你正在编辑哪个版本。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Instance, InstanceConfig, JavaRuntime } from '../domain';
import { burySlug, unburySlugs, instanceFromFolderVersion, matchFolderVersions, pickAutoAdopt } from '../domain/folder-versions.ts';
/*
 * ★ 好友的**纯逻辑**在 domain 里（那边能被 `node --test` 直接跑，有 10 条用例）。
 *   这里重命名导入，免得与上下文方法（`addFriend` / `removeFriend`）同名。
 */
import {
  friendsPollIntervalMs,
  parseFriendNotes,
  presenceBeatIntervalMs,
  setFriendNote as setFriendNoteIn,
} from '../domain/friends.ts';
/* ★ 账号切换的判断（`planSwitchBack` / `looksLikeUuid`）在 domain 里 —— 那边有用例 */
import { looksLikeUuid } from '../domain/account.ts';
/* ★ 2026-10-12：好友服务（正版专用）—— 端点与协议见 src-tauri/src/friends.rs 头部 */
import { friendsApi } from '../bridge/tauri';
import type { PresenceStatus, Toggle } from '../bridge/tauri';
// ★ 目录名规范只有一份（Rust `domain::naming` 的镜像）—— 见那个模块的说明
import { sanitizeDirName, uniqueDirName } from '../domain/naming.ts';
import type { FolderVersion } from '../bridge/tauri';
import { MC_PROFILES } from '../domain/loader-caps.ts';
import type { ModEntry, ModFilter, ModStateResult } from '../domain/mods.ts';
// ★ 输入校验只有一份规则（与 Rust 侧逐条一致，见 domain/validate.rs）
import { instanceNameRules, validate } from '../domain/validate.ts';
import { getBackend } from '../bridge';
import type { Backend } from '../bridge';
import { applyMotion, MOTION_KEY, readMotion, setMotion } from '../ui/motion';
import { applyTheme, isThemeId, type ThemeId } from '../ui/theme';
import {
  applyVfx,
  currentVfx,
  decideVfx,
  setVfx as persistVfx,
  storedVfx,
  vfxCapability,
  type VfxCapability,
  type VfxLevel,
} from '../ui/vfx';
import { createGlassController } from '../ui/glass';
import { useLauncherUpdate } from '../hooks/useLauncherUpdate';
import type { UpdateState } from '../hooks/useLauncherUpdate';

/** 启动器更新的三件事（见 `AppContextValue.update` 的说明） */
export interface LauncherUpdate {
  state: UpdateState;
  checkNow: (opts?: { silent?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  /**
   * ★★ 实时读「更新说明」（2026-09-26，更新日志页"点进去就刷新"用）。
   *
   *   与 `checkNow` 不是一回事：`checkNow` 问"**有没有新版本**"（走 updater 插件，
   *   版本相同时它什么都不返回），这个只读更新通道的清单里的说明文字 ——
   *   所以**已经是最新版**时它照样有东西可显示。
   */
  refreshNotes: () => Promise<void>;
}
import {
  initialState,
  hasRunningTask,
  isForgeLike,
  launchTarget as selectLaunchTarget,
  openInstance as selectOpenInstance,
  reducer,
  type AppState,
  type DownloadTab,
  type PageId,
  type SubPageId,
  type TaskItem,
  type ToastItem,
} from './store';
import { syncWindowTitle } from '../bridge/web';

/* ====================== Toast 的存活策略 ====================== */

/**
 * 这条提示要不要**一直留着直到用户手动关**？
 *
 * ★ 曾经的策略是「错误和警告一律 sticky」，结果是：一次启动失败之后，
 *   那条错误横幅**永远挂在右下角**，用户报"提示不会自动消失"。
 *   反思：错误恰恰是最该被看一眼就走的 —— 需要细看的内容应该进日志页 /
 *   崩溃弹窗，而不是把提示条当成常驻状态栏。
 *
 * 现在：**只有真正需要用户做决定/去别处查看的提示才是 sticky**，
 * 由调用方显式声明（`toast(..., {sticky:true})`）—— 默认一律自动消失。
 * 详见 `armToastDismiss` 里的时长。
 */
/**
 * 退场动画时长（毫秒）。
 * ★ 必须与 CSS 里 `.toast.leaving` 的 `animation-duration` 一致 ——
 *   短了会截断动画，长了会留一条"已经该没了"的空壳。
 */
/*
 * ★★ 2026-09-23：从 200 改成 260 —— **必须 ≥ CSS 里退场动画的时长**。
 *   原来动画 200ms、这里也 200ms，等于"动画刚开始跑就把元素删了"，
 *   用户看到的就是"啪地不见"（用户原话：「我的滑走在哪里？？？」）。
 */
const TOAST_EXIT_MS = 260;

function toastSticky(_kind: ToastItem['kind']): boolean {
  return false;
}

/** 各类提示停留多久（毫秒） */
function toastLifetime(kind: ToastItem['kind']): number {
  switch (kind) {
    case 'ok':
      return 3200;
    case 'info':
      return 4500;
    case 'warning':
      return 6000;
    case 'err':
      // 错误要留够读完的时间，但**不该永久占位**。
      // 长文本在提示条里是可展开的（见 AppShell 的 toast-more），
      // 所以 9 秒足够；真要细看有日志页与崩溃弹窗。
      return 9000;
  }
}

/* ====================== 全局偏好的恢复与落盘 ====================== */

/**
 * 把磁盘上读到的偏好**逐字段校验**后合并。
 *
 * ★ 为什么不能直接 spread：`prefs.json` 是纯文本，用户可能手改过、
 *   也可能是旧版本写的（字段语义变了）。一个非法值（比如
 *   `concurrentDownloads: "abc"`）会让 `clamp` 之类的地方算出 NaN，
 *   进而把并发数传给后端 —— 那是一次莫名其妙的安装失败。
 *   所以：**只认认识的键，且类型必须对**；不认识的直接丢掉。
 */
function sanitizePrefs(raw: unknown): Partial<AppState['prefs']> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<AppState['prefs']> = {};
  const str = (k: string, allow: string[]) => {
    const v = r[k];
    if (typeof v === 'string' && allow.includes(v)) {
      (out as Record<string, unknown>)[k] = v;
    }
  };
  const num = (k: string, min: number, max: number) => {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) {
      (out as Record<string, unknown>)[k] = Math.round(v);
    }
  };
  const bool = (k: string) => {
    const v = r[k];
    if (typeof v === 'boolean') (out as Record<string, unknown>)[k] = v;
  };

  str('globalIsolation', ['isolated', 'shared']);
  /*
   * ★ 2026-09-28（0.18.2）：白名单里原来少了 `'auto'` —— 而「自动」正是**默认值**
   *   （设置页三个选项：自动 / 只用 Mojang / 只用 BMCLAPI）。少了它的后果是
   *   "用户选了自动，读回来时被丢掉"，只是恰好与默认值相同才没露出来。
   */
  str('downloadSource', ['auto', 'bmclapi', 'mojang']);
  str('modSource', ['modrinth', 'both']);
  num('globalMemoryMb', 512, 262144);
  num('concurrentDownloads', 1, 512);
  num('windowWidth', 320, 7680);
  num('windowHeight', 240, 4320);
  bool('particleEffects');
  bool('reducedMotion');
  // ★ 启动前自动备份（ADR-014）。缺省 = 开：没写过这个字段的用户也要有保险
  bool('autoBackup');
  if (typeof r.offlineUsername === 'string' && r.offlineUsername.trim()) {
    out.offlineUsername = r.offlineUsername.trim().slice(0, 32);
  }
  // 账号 uuid：只有形态合法才认（挡住手改出来的垃圾值）
  /*
   * ★★ 2026-10-09：`lastPremiumUuid` 是**切回正版**唯一的依据（见 `store.ts` 里那段说明）。
   *   形态检查与 `planSwitchBack` 共用一处（`domain/account.ts` 的 `looksLikeUuid`），
   *   别在这里再抄一条正则 —— 两条迟早会不一致。
   */
  if (looksLikeUuid(r.accountUuid)) {
    out.accountUuid = r.accountUuid;
  }
  if (looksLikeUuid(r.lastPremiumUuid)) {
    out.lastPremiumUuid = r.lastPremiumUuid;
  }
  if (typeof r.globalJvmArgs === 'string') out.globalJvmArgs = r.globalJvmArgs;
  if (typeof r.globalGameArgs === 'string') out.globalGameArgs = r.globalGameArgs;
  /*
   * ★★ 2026-09-30：**墓碑**（用户删掉过的版本目录名）。
   *
   *   读的时候要当心两件事：它是个数组（不是字符串），而且里面的值会被
   *   直接当**目录名**用 —— 所以只收"看起来像目录名"的短字符串，
   *   别把历史遗留的垃圾值（`../`、空串、超长串）带进来。
   */
  if (Array.isArray(r.deletedVersions)) {
    const list = r.deletedVersions
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v !== '' && v.length <= 96 && !/[\\/]/.test(v))
      .slice(-200);
    out.deletedVersions = list;
  }
  /*
   * ★★ **好友备注**（2026-10-12：名单已经以服务端为准，本机只留备注）。
   *   清洗规则全在 `domain/friends.ts`（uuid 键、短字符串、空值丢掉）——
   *   那边有 10 条用例，这里只负责"捞出来"。
   */
  out.friendNotes = parseFriendNotes(r.friendNotes);
  return out;
}

/**
 * 把某个版本目录名**记进墓碑** / **从墓碑里撤掉** —— 两个判据都搬到了
 * `domain/folder-versions.ts`（那边是 `.ts`，能进 `node --test`；
 * 这一对函数是"删了又回来"与"重装却收藏不了"两条缺陷的分界线，必须有测试）。
 * 这里只留 import：**别在 `.tsx` 里再抄一份**。
 */

interface AppContextValue {  state: AppState;
  backend: Backend;

  /**
   * ★★★★ **把一个版本目录名记进墓碑**（2026-10-01）。
   *
   *   存在的理由：删除有**两条路**（有账本记录 → `removeInstance`；
   *   没有记录 → 版本列表直接删目录）。原来只有前者写墓碑，
   *   于是后者删掉的目录**下次启动会被 `migrate_data_root` 从老数据根合并回来**
   *   —— 用户看到的就是「这些不可用版本，删除后，在重启启动器后会复活」。
   *
   *   ⇒ 把"记墓碑"这件事暴露出来，让两条路留下**同一个后果**。
   *     谁删版本目录谁就得调它 —— 判据只有一份（`burySlug`）。
   */
  buryVersion: (slug: string) => void;

  /* --- 导航 --- */
  go: (page: PageId) => void;
  /** 进入某个版本的二级页（版本列表里双击） */
  openVersion: (id: string, sub?: SubPageId) => void;
  /** 退出二级页，回到版本列表 */
  closeVersion: () => void;
  setSubPage: (sub: SubPageId) => void;
  setDownloadTab: (tab: DownloadTab) => void;
  /** ★ 切到下载页并指定页签（一次派发，不依赖事件时序） */
  goDownloadTab: (tab: DownloadTab) => void;
  /**
   * 切到下载页的某个页签，并**指定装到哪个实例**。
   *
   * 存在的理由与 `goDownloadTab` 相同（事件在目标页挂载前会被丢掉），
   * 只是多带一个"装给谁"。详见实现处的注释。
   */
  goDownloadFor: (tab: DownloadTab, instanceId: string | null) => void;
  /**
   * 单独设置"下载页装到哪个实例"（下载页里那个「装到」选择器用它）。
   *
   * 与 `goDownloadFor` 写的是**同一个字段** —— 这是刻意的：
   * 跳转过来的目标和玩家自己选的目标只留**一处真相**，
   * 否则"跳过来之后又手动改选"会出现两个值互相打架。
   */
  setDownloadTarget: (instanceId: string | null) => void;
  setTheme: (t: ThemeId) => void;

  /* --- 实例 --- */
  /** "启动"页的目标实例 */
  target: Instance | null;
  /** 二级页面正在编辑的实例 */
  open: Instance | null;
  setLaunchTarget: (id: string | null) => void;
  /** ★★ C5：进资源的**独立安装页**（`kind` 决定装到哪个目录）；
   *  `source` 是这一批结果来自哪个源（安装页要如实写「来自 …」，见 C-18） */
  openResource: (hit: unknown, kind: string, source?: string) => void;
  /** ★★ C5：从安装页返回下载页 */
  closeResource: () => void;
  createInstance: (inst: Instance) => Promise<void>;
  updateConfig: (id: string, patch: Partial<InstanceConfig>) => void;
  /**
   * 删除实例（含磁盘目录）。
   *
   * `permanent = false`（默认）进系统回收站；true 才是永久删除。
   */
  removeInstance: (id: string, permanent?: boolean) => Promise<number>;
  /**
   * 改显示名。**返回 `null` = 成功**，否则是给用户看的原因（校验在这里做，
   * 三个调用点不需要各写一遍）。见实现处的说明。
   */
  renameInstance: (id: string, name: string) => string | null;
  /**
   * 收藏 / 取消收藏一个版本（版本列表左侧那颗星）。
   * ★ 会**当场落盘**，不只是改内存 —— 见实现里那段说明。
   */
  setFavorite: (id: string, favorite: boolean) => Promise<void>;

  /* --- 好友（2026-10-09 的胚子；边界见 domain/friends.ts 文件头） --- */

  /* --- 好友（正版专用，2026-10-12；端点与协议见 src-tauri/src/friends.rs 头部）--- */

  /** 重新取名单（并顺带上报一次"我在线"） */
  refreshFriends: () => Promise<void>;
  /** 加好友：按正版名查 uuid 再发请求（查不到会如实报错） */
  addFriendByName: (name: string) => Promise<boolean>;
  /** 删好友 */
  removeFriend: (profileId: string, name: string) => Promise<boolean>;
  /** 同意别人的请求 */
  acceptFriend: (profileId: string, name: string) => Promise<boolean>;
  /** 拒绝别人的请求 */
  declineFriend: (profileId: string, name: string) => Promise<boolean>;
  /** 撤销自己发出的请求 */
  revokeFriendRequest: (profileId: string, name: string) => Promise<boolean>;
  /** 读好友隐私设置（谁能加我 / 谁能邀请我） */
  loadFriendSettings: () => Promise<void>;
  saveFriendSettings: (friends: Toggle, acceptInvites: Toggle) => Promise<void>;
  /** 本机备注（只进 prefs，不碰服务端） */
  setFriendNote: (profileId: string, note: string) => void;
  /**
   * ★ 好友页挂载/卸载时报告"这一页开着"——名单轮询频率按它切
   *   （打开每分钟、关着每 5 分钟，见 `domain/friends.ts`）。
   */
  setFriendsPageOpen: (open: boolean) => void;
  duplicateInstance: (id: string) => Promise<number>;

  /* --- Java --- */
  rescanJava: () => Promise<void>;
  refreshJava: (list: JavaRuntime[]) => void;

  /**
   * ★★ 换完游戏根目录之后刷新派生的那几样（见实现处的清单）。
   *   用户 2026-09-25：「切换游戏数据应该是实时的」—— 后端当场换句柄，
   *   前端紧接着把机器信息 / 实例清单 / Java 重读一遍，**不重启、不刷页面**。
   */
  reloadAfterRootChange: () => Promise<void>;

  /**
   * ★★ 2026-09-25（用户：「换目录后不会自动刷新……点击版本列表就刷新一下，
   *   重新读取当前选择的游戏目录」）。
   *
   *   把实例清单从后端重读一遍。为什么"进版本列表"要重读：账本本身住在
   *   启动器自己的家里（与游戏根目录无关），但**每个实例的目录**是按当前
   *   根目录算出来的 —— 目录一换，这一页显示的东西就该跟着换。
   *
   *   ★ 它与"窗口重获焦点时刷新"是**同一个函数**（2026-09-23 那条需求建的），
   *     不是第二份实现。
   *   ★ 读失败时**保持现状**（不清空、也不弹错）：空清单是一句假话，
   *     而这一页的磁盘事实由它自己的读盘路径负责报错（见 `VersionsPage`）。
   */
  refreshInstances: () => Promise<void>;

  /**
   * ★★ 重拉隔离判定（ADR-005）。
   *
   * 判定由后端算（规则只写一次，ADR-006）——前端改完设置必须**回读**，
   * 不许自己推一个结论出来。读失败时保持上一次的结论。
   */
  refreshIsolation: () => Promise<void>;

  /**
   * ★★ **重新读一次机器信息**（可用内存 / 总内存）。
   *
   * 为什么需要它：`machineInfo` 原来只在**启动那一刻**读一次，而"可用内存"是
   * 一个**一直在变**的数（用户开个浏览器就少 2 GB）。界面上写着"可用 12 GB"
   * 而那是三小时前的读数 —— 用户照它选内存，然后游戏起不来。
   * 启动页显示这个数，所以它在那儿按节奏重读（见 `LaunchPage`）。
   *
   * ★ 读失败时**保持原值**（不写 0、也不清空）：一个旧的数字比一个假的 0 好。
   */
  refreshMachine: () => Promise<void>;


  /**
   * ★★ 2026-09-25（用户：「主页也有同样问题」）：**当前文件夹里的版本** ——
   *   版本列表与启动页共用这一份（PCL 的文件夹逻辑，见 `domain/folder-versions.ts`）。
   *
   *   · `instancesInFolder`：账本里对得上当前文件夹的实例（**能启动的就是这些**）；
   *   · `versionsWithoutInstance`：文件夹里有、还没建过实例的版本；
   *   · `null` = 还没读到（或读失败）⇒ 界面**不筛**（读不到 ≠ 没有）。
   */
  folder: {
    versions: FolderVersion[] | null;
    instancesInFolder: Instance[];
    versionsWithoutInstance: FolderVersion[];
    /**
     * ★★ **这个文件夹里有几个能用的版本** —— 唯一的那一份数（2026-09-30）。
     *
     *   角标、版本列表页头、筛选「全部 N」**全部用它**。
     *   判据 = 有版本 JSON 且不在墓碑里（见上面那个 `useMemo` 的说明）。
     *   `null` = 还没读到（界面显示"读取中"，**不显示 0** —— 0 是一句假话）。
     */
    versionCount: number | null;
    /**
   * 重扫 `versions/`。**返回扫到的清单**（2026-10-08）—— 调用方要如实报出
   * "发现几个版本"，而报结果时**不能**去读 state（setState 是异步的，
   * 那会报出上一次的数字）。失败时抛出，由调用方决定怎么提示。
   */
  reload: () => Promise<FolderVersion[]>;
  };

  /**
   * ★ 偏好写盘失败的原因（null = 正常）。
   *
   * 为什么要有它：偏好存不上时用户看到的是"改完设置、重启就没了"，
   * 而原来的空 catch 让它毫无痕迹。界面据此显示一条提示条。
   */
  prefsSaveFailed: string | null;

  /**
   * ★★ 启动器自身的更新（**热更新**：开机自动查 → 后台下 → 一键换 → 自己回来）。
   *
   * 为什么放在 AppContext 而不是各页面自己 `useLauncherUpdate()`：
   *   顶栏的「新版本」角标与设置页那一行**看的是同一件事**。两个组件各挂一份
   *   hook 就是两份独立状态 —— 一边显示"下载中 40%"、另一边显示"发现新版本"，
   *   而且会**各查一次、各下一次**。状态只有一份，所以挂在全局。
   */
  update: LauncherUpdate;

  /**
   * ★★ **整合包作者的图标**（`版本 id → data:` URI`）。
   *
   *   只含**真的有图标的包** —— 键不存在时界面画自绘的版本图标。
   *   两个消费方共用这一份（启动页大卡片、版本列表行）。
   */
  packIcons: Record<string, string>;

  /**
   * ★★★★ 2026-09-30（用户）：「**切换页面是开始游戏的按钮的正在启动的效果没了**」。
   *
   *   `launching` 原来在 `LaunchPage` 里是**局部状态**：一离开那一页，组件卸载、
   *   `useState` 归零，切回来时按钮就不转圈了（进度也不显示）。
   *   而启动**还在跑** —— Rust 侧那条 `await` 根本不受页面影响。
   *   ⇒ 界面装作没在启动，用户只能靠猜（他前面那句"切换页面会停止启动"就是这么来的）。
   *
   *   放到全局的理由与上面的 `update` 一样：**这件事不随页面存活**。
   *   顺带把刚补的"正在补什么文件"的进度一起搬上来，切走再切回来仍能看到。
   */
  launch: {
    /** 正在准备 / 启动中（含启动前那段阻塞的自愈） */
    starting: boolean;
    setStarting: (v: boolean) => void;
    /**
     * 启动前的准备进度（来自 `launch-progress` 事件）。
     * `null` = 还没收到任何进度 —— 文件齐全时自愈是毫秒级结束的，本来就没有进度。
     */
    progress: {
      stage: string;
      finished: number;
      total: number;
      percent: number;
      current: string;
    } | null;
    setProgress: (
      p: {
        stage: string;
        finished: number;
        total: number;
        percent: number;
        current: string;
      } | null,
    ) => void;
  };

  /**
   * ★★ 视效档位（**液态玻璃的材质**：弱化 / 适中 / 灵动）。
   *
   * 为什么在全局而不是设置页自己存：
   *   玻璃表面**全都在别的组件里**（卡片在 `ui/Card`、模态在 `ui/Modal`、
   *   还有各页的 `.page-head`）。运行时控制器必须**全应用只有一个**：
   *   多一份就是两套透镜滤镜注册表 + 两个 rAF 循环 + 两个 WebGL 上下文
   *   （Chromium 的上下文数量有限，超了会丢掉最早的那个 —— 症状是背景忽然变黑）。
   *
   * `level` 是**已经过能力校正**的档位（读不出来就是适中），`want` 是用户真正选的那个
   * （用来显示"你选的灵动被挡下来了，因为…"）。
   */
  vfx: {
    level: VfxLevel;
    want: VfxLevel;
    clamped: boolean;
    why: string | null;
    capability: VfxCapability;
    choose: (level: VfxLevel) => void;
  };

  /* --- Toast --- */
  toast: (kind: ToastItem['kind'], title: string, desc?: string) => void;
  dismissToast: (id: string) => void;

  /* --- 任务 --- */
  upsertTask: (task: TaskItem) => void;
  patchTask: (id: string, patch: Partial<TaskItem>) => void;

  /* --- Mod --- */
  setMods: (entries: ModEntry[], states: Map<string, ModStateResult['state']>) => void;
  setModFilter: (f: ModFilter) => void;
  setModQuery: (q: string) => void;
  toggleModSelect: (path: string) => void;
  clearModSelect: () => void;
  toggleModEnabled: (path: string) => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const backend = useMemo(() => getBackend(), []);
  const bootedRef = useRef(false);

  /* ====================== 视效档位 + 玻璃运行时 ====================== */
  /**
   * ★★ 为什么"运行时控制器"必须活在 provider 里（而不是各页面各挂一份）：
   *   玻璃表面散落在所有页面（卡片、模态、各页的标题条），而控制器里握着
   *   三样**只能有一份**的东西 —— 透镜滤镜注册表、rAF 循环、WebGL 上下文。
   *   各挂一份的后果不是"重复劳动"，是**互相踩**：两个 GL 上下文里先建的那个
   *   会被 Chromium 丢掉（症状是背景忽然变黑），两个 rAF 循环会各推各的时间轴。
   */
  /**
   * ★ `vfxWant` 存的是**用户选的那个档位**，不是校正后的结果 —— 两者必须分开：
   *   只留校正结果的话，降级就变成"用户的选择被悄悄改掉"（设置页显示"适中"被选中，
   *   而他明明选的是灵动，也没有任何说明）。分开之后界面才能说清
   *   "你选了灵动，这台机器开不了，现在跑的是适中"。
   */
  const [vfxWant, setVfxWant] = useState<VfxLevel>(() => storedVfx());
  const vfxCap = useMemo(() => vfxCapability(), []);
  const glassRef = useRef<ReturnType<typeof createGlassController> | null>(null);

  useEffect(() => {
    const ctl = createGlassController(currentVfx());
    glassRef.current = ctl;
    return () => {
      ctl.dispose();
      glassRef.current = null;
    };
  }, []);

  /**
   * 低性能损耗模式**压过**视效档位。
   *
   * ★ 两个开关说的是同一件事的两面：`low-perf` 是"我这台机器别搞花样"，
   *   视效档位是"我想要多花的材质"。用户同时打开时，**省电那条赢** ——
   *   否则"低性能损耗模式"就变成了一个骗人的开关（开了还在跑 WebGL）。
   *   CSS 那边已经用 `!important` 关掉了模糊，这里补的是 JS 侧：
   *   GL 背景不起、透镜滤镜不装。
   *
   * ★ 为什么盯着 `<html>` 的类而不是读 localStorage：那个开关的**真源就是类**
   *   （`main.tsx` 首屏前挂、设置页切换时改）。盯类 = 只有一份判据；
   *   读 localStorage 就是第二份判据，迟早会出现"开关关了但界面还在跑 GL"。
   */
  const [lowPerf, setLowPerfState] = useState(() =>
    typeof document === 'undefined' ? false : document.documentElement.classList.contains('low-perf'),
  );
  useEffect(() => {
    const mo = new MutationObserver(() =>
      setLowPerfState(document.documentElement.classList.contains('low-perf')),
    );
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const vfxDecision = useMemo(() => decideVfx(vfxWant, vfxCap), [vfxWant, vfxCap]);
  /*
   * ★ 低性能损耗模式把视效**压到「弱化」**（不是「适中」）。
   *
   *   用户 2026-09-22 对那个开关的原话是「一键开启**减少动效和弱化视效**」——
   *   所以派生出来的生效档位就该是 `weak`。原来这里压在 `mid`（只降一档），
   *   而设置页那个被删掉的 `vfx.choose('weak')` 才是压到 `weak` 的 ——
   *   两者不一致：老代码靠"写盘 + 降两档"达到 weak，删掉写盘之后就露出来了。
   */
  const vfxDowngradedByLowPerf = lowPerf && vfxDecision.level !== 'weak';
  /** 实际生效的档位（能力校正 + 低性能模式压制之后的那一个） */
  const vfxLevel: VfxLevel = vfxDowngradedByLowPerf ? 'weak' : vfxDecision.level;
  const vfxClamped = vfxDecision.clamped || vfxDowngradedByLowPerf;
  const vfxWhy = vfxDowngradedByLowPerf
    ? '低性能损耗模式开着，视效被压到「弱化」（关掉它就能回来）'
    : vfxDecision.why;

  /** 换档：写盘 + 立刻改 `data-vfx`（**不等 React 重渲染**，否则会闪一帧旧材质） */
  const chooseVfx = useCallback(
    (level: VfxLevel) => {
      persistVfx(level);
      applyVfx(decideVfx(level, vfxCap).level);
      setVfxWant(level);
    },
    [vfxCap],
  );

  useEffect(() => {
    applyVfx(vfxLevel);
    /*
     * ★ 低性能损耗模式要**同时告诉控制器**：那一档的 CSS 用 !important 关掉了
     *   所有 backdrop-filter（含折射），JS 这边如果还留着透镜，
     *   就是"状态两边不一致 + 白按尺寸重烘法线图"（实测 low-perf 开着时
     *   6 块玻璃仍挂着 data-lens）。
     */
    /*
     * ★★ 2026-09-24 修正（用户那条"档位莫名其妙变了"的根因）：
     *   低性能损耗模式开着时，**动效也降到「减少」——但只施加、不写盘**。
     *   原来这条降档是设置页 `setMotion('lite')` 做的（写盘 → 把用户选的「灵韵」
     *   永久改成「减少」），而"原值"只存在一个内存 ref 里 ⇒ **重启之后再也回不来**。
     *   现在：用户选什么就存在 localStorage 里不动，开关只决定**当下生效哪一档**；
     *   关掉开关时从盘上读回他自己的档位。
     *   （视效那一侧本来就是派生：见上面的 `vfxDowngradedByLowPerf`。）
     */
    applyMotion(lowPerf ? 'lite' : readMotion());
    glassRef.current?.setLowPerf(lowPerf);
    glassRef.current?.setLevel(vfxLevel);
  }, [vfxLevel, lowPerf]);
  /**
   * 当下这一份 state 的引用。
   *
   * ★ 为什么需要：事件监听器是**注册一次、长期活着**的，它闭包里捕获的 state
   *   会停在注册那一刻。监听器里要读 state 时读 `stateRef.current`，
   *   就永远是最新的（也正因如此，那个 effect 的依赖数组可以是空的）。
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 是否已经读过磁盘上的偏好（读过之后才允许写回，否则会用默认值覆盖用户设置） */
  const prefsLoadedRef = useRef(false);
  /**
   * ★★ **实例列表有没有真的从磁盘读出来过？**
   *
   *   这条阈值很重要，它挡的是一个**会丢用户数据的真 bug**（实测踩到）：
   *
   *   老代码：`Promise.all([machineInfo, loadInstances, scanJava, loadPrefs])`
   *   里**任何一条失败**（网络、读盘、扫描 Java 出异常）就整体进 catch →
   *   `boot/fail` → `state.instances` 留在 `[]`。
   *   而"实例变更时落盘"那个 effect 只看 `state.ready`（fail 也把 ready 置真），
   *   于是 250ms 后把**空列表写回了 instances.json**。
   *
   *   实测后果：`instances.json` 变成 `{"instances":[],"active_id":null}` ——
   *   用户建的三个版本从界面上消失了（游戏文件还在，但记录没了）。
   *   现场留下的证据是文件修改时间：启动器刚起 1 秒，它就被写空了。
   *
   *   所以：**没成功读到过，就绝不允许写。** 读一次成功之后才放开。
   */
  const instancesLoadedRef = useRef(false);
  /**
   * 偏好写盘失败的原因（null = 一切正常）。
   *
   * ★ 为什么要暴露出来：偏好存不上时用户的体验是"改完设置、重启就没了"，
   *   而原来的空 catch 让它**完全没有痕迹**。这类"静默失败"是 ADR-041
   *   点名的缺陷类型，所以至少要能被界面读到。
   */
  const [prefsSaveFailed, setPrefsSaveFailed] = useState<string | null>(null);

  /* ====================== 启动 ====================== */
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      /*
       * ★★ 四条启动请求**各自独立**，任何一条失败都不能连累其它三条。
       *
       *   老代码是 `Promise.all([...])`：一条失败 → 整体 catch →
       *   `boot/fail` → 实例、Java、偏好**全部落回默认值**，
       *   然后被落盘 effect 写成空 —— 用户的版本列表就没了（见
       *   `instancesLoadedRef` 的说明）。
       *
       *   现在：每条给一个安全的兜底值，只有"机器信息"失败才算真的启动失败
       *   （没有它就渲染不出任何东西）。
       */
      /*
       * ★★ 每一批的耗时**要看得见**（2026-10-09，用户：「进入启动器的速度有点慢」）。
       *
       *   `Promise.allSettled` 只告诉我们"都落定了"，不告诉我们**哪一条最慢** ——
       *   而首屏可交互的时刻正是由最慢那条决定的（整批挡在 `boot/ok` 前面，
       *   在那之前内容区是 `AppShell` 里那句「正在准备…」）。
       *
       *   ⇒ `timed()` 给每条记一笔落定时刻（**不改它的值、也不改它的错误**），
       *     记在 `window.__boot.invokes` 上；真机探针
       *     （`live-startup-timing.mjs`，在本地开发记录里）直接读。
       *     成本是每条两次 `performance.now()`。
       */
      const tBoot = performance.now();
      const marks: Record<string, number> = {};
      const timed = <T,>(name: string, p: Promise<T>): Promise<T> =>
        p.then(
          (v) => {
            marks[name] = Math.round(performance.now() - tBoot);
            if (window.__boot) window.__boot.invokes = { ...marks };
            return v;
          },
          (e: unknown) => {
            marks[name] = Math.round(performance.now() - tBoot);
            if (window.__boot) window.__boot.invokes = { ...marks };
            throw e;
          },
        );

      const [machineR, instR, prefsR, infoR, runningR, isolationR] = await Promise.allSettled([
        timed('machine_info', backend.machineInfo()),
        timed('list_instances', backend.loadInstances()),
        timed('load_prefs', backend.loadPrefs()),
        /*
         * ★ 后端版本号（`app_info`）。拿不到不影响启动 —— 它只用于「关于」显示。
         *   单独一条 promise 是为了不让它拖垮整次 boot（与上面同一条纪律：
         *   每条给一个安全的兜底值）。
         */
        timed('app_info', backend.info()),
        /*
         * ★★ 多开实例：把"现在有哪些在跑"从**后端**捡回来。
         *
         *   为什么必须问后端、而不是信任本地状态：界面的状态是攒出来的，
         *   而它可能被重新加载（WebView 刷新、以后的"重开界面"）——
         *   那一刻本地表是空的、而后端的进程还活着。不问的话界面会说
         *   "没有游戏在运行"，用户再点启动，游戏又开一份（同一个存档被两个进程写）。
         *   后端那张表是**唯一**知道真相的地方（它手里有子进程句柄）。
         */
        timed('running_games', backend.runningGames()),
        /*
         * ★★ 隔离判定（ADR-005）：**由后端算**，界面只显示。
         *   拿不到时保持空表 —— 界面据此显示"读取中"，绝不自己猜一个结论出来
         *   （猜错的代价是用户以为存档丢了）。
         */
        timed('list_isolation', backend.listIsolation()),
      ]);

      /*
       * ★★★★ Java 扫描**不挡首屏**（2026-10-09，用户：「进入启动器的速度有点慢」）。
       *
       *   真机量出来的形状（`window.__boot.invokes`，探针读它）：
       *
       *     machine_info 199ms · list_instances 199 · load_prefs 200 · app_info 200
       *     running_games 200 · list_isolation 201 · **scan_java 343**
       *
       *   六条几乎同时落定（连什么都不干的 `app_info` 也是 200ms）⇒ 那 200ms 是
       *   "主线程上排队 + 一次性的 IPC 冷启动"，**不是某一条自己的活**；
       *   而 `scan_java` 独自又往后拖了 **140ms** —— 它才是唯一真正更长的那条，
       *   因为它要向 8 类来源收候选、并把每个 `java -version` 真的跑一遍。
       *
       *   Java 结果**首屏并不需要**：启动页的 Java 那一格在拿到之前显示
       *   `java.scanning`（store 里本来就有这个语义，设置页自己也会重扫）。
       *   所以把它从闸门里摘出去，`java/set` 到了再落 —— 首屏因此提前
       *   100~300ms（机器上 Java 候选越多差得越多）。
       *
       *   ★ 顺序很要紧：`scan_java` 在 await 之前就**已经发出去了**，
       *     所以"摘出去"不会让它晚开始，只是不再等它。
       *   ★ `java/scanning` 必须在 `boot/ok` **之前**置上，否则中间那一小段
       *     界面会显示"没有检测到 Java"—— 那是句假话。
       */
      dispatch({ type: 'java/scanning', scanning: true });
      const javaPromise = backend.scanJava();
      const timedJava = timed('scan_java', javaPromise);
      if (window.__boot) window.__boot.invokes = marks;

      if (machineR.status === 'rejected') {
        dispatch({
          type: 'boot/fail',
          error:
            machineR.reason instanceof Error
              ? machineR.reason.message
              : String(machineR.reason),
        });
        return;
      }

      const machine = machineR.value;
      const inst =
        instR.status === 'fulfilled' ? instR.value : { instances: [], activeId: null };
      const prefs = prefsR.status === 'fulfilled' ? prefsR.value : {};

      /*
       * 只有**真的读到了**才放开写权限。
       * 读失败时如实说出来（不能假装"一个版本都没有"——
       * 那正是丢数据的那个 bug 的外观）。
       */
      if (instR.status === 'fulfilled') {
        instancesLoadedRef.current = true;
      } else {
        const why =
          instR.reason instanceof Error ? instR.reason.message : String(instR.reason);
        console.error('[IEML] 读取实例列表失败，本次不会写回 instances.json：', why);
        window.dispatchEvent(
          new CustomEvent('ieml:toast', {
            detail: {
              kind: 'err',
              title: '读不到版本列表',
              /*
               * ★★ 2026-09-24（C-22 修复）：这里原来写的是 `message:` ——
               *   而监听方（本文件 `onToast`）读的是 `d.desc`：
               *   ```ts
               *   const d = (e as CustomEvent<{ kind; title; desc? }>).detail;
               *   ... desc: d.desc
               *   ```
               *   于是这句「磁盘上的记录没有被清掉」**从来没有显示过** ——
               *   用户只看到一句光秃秃的「读不到版本列表」，最容易的反应就是
               *   "我的版本没了"（而那正是这条提示要防的误解）。
               */
              desc: `${why} —— 这一页现在是空的，但磁盘上的记录没有被清掉。修好后重启即可。`,
            },
          }),
        );
      }
      if (prefsR.status === 'rejected') {
        console.error('[IEML] 读取偏好失败：', prefsR.reason);
      }

      /*
       * ★★ 老字段迁移：`prefs.json` 里的 `reducedMotion`（布尔）→ 三档动效
       *   （用户 2026-09-20 要求"减少 / 适中 / 灵韵"）。
       *
       *   补记一件旧事：那个布尔值**启动时从来没被应用过** —— 设置页里改它
       *   只当次生效（`classList.toggle`），重启就回到有动画的样子，
       *   而开关本身还是"关着"的。所以这里不只是迁移，也把那条老账还上：
       *   老用户升级上来，第一次启动就会按他当年选的"减少动效"跑。
       *
       *   ★ 只在"本机还没选过档位"时才采纳它（localStorage 里没有 `ieml.motion`）：
       *     用户在新版本里选过之后，以新值为准。
       */
      if (!localStorage.getItem(MOTION_KEY) && prefs.reducedMotion === true) {
        setMotion('lite');
      }

      const installedIds = new Set(inst.instances.map((i) => i.mcVersion));
      const versions = Object.entries(MC_PROFILES).map(([id, p]) => ({
        id,
        releaseType: /^\d{2}w/.test(id) ? ('snapshot' as const) : ('release' as const),
        releasedAt: p.releasedAt,
        javaMajor: p.javaMajor,
        bytes: p.vanillaBytes,
        installed: installedIds.has(id),
        instanceCount: inst.instances.filter((i) => i.mcVersion === id).length,
      }));

      // 把存下来的偏好合并进初始状态（只认认识的键，脏数据不影响启动）
      const restored = sanitizePrefs(prefs);
      const savedTheme = (prefs as Record<string, unknown>).theme;

      dispatch({
        type: 'boot/ok',
        machine,
        backendVersion: infoR.status === 'fulfilled' ? infoR.value.version : '',
        versions,
        instances: inst.instances,
        /* Java 还没扫完 —— 给空表，紧接着由 `java/set` 补上（`java/scanning` 已在上面置上） */
        java: [],
        lastInstanceId: inst.activeId ?? null,
        prefs: restored,
        ...(isThemeId(savedTheme) ? { theme: savedTheme } : {}),
      });

      /*
       * ★★★★ Java 扫描结果到了就落（2026-10-09）。
       *
       *   首屏**不等它**（理由与量出来的数字写在上面那段说明里）。
       *   这里用 `.then` 而不是 `await`：`await` 会把这个 async 块挂在这里，
       *   `boot/ok` 之后那几条（运行表、隔离判定）就要一起等 Java —— 白等。
       *
       *   ★ 失败时：`java/scanning` 置回 false（界面据此说"没找到 Java"而不是
       *     一直转圈），并留下一行痕迹 —— 原来这里只有一句 console.error，
       *     而那正是"设置页说没有 Java、用户以为机器上没装"的观感来源。
       */
      void timedJava.then(
        (runtimes) => {
          dispatch({ type: 'java/set', runtimes });
          dispatch({ type: 'java/scanning', scanning: false });
        },
        (e: unknown) => {
          console.error('[IEML] Java 扫描失败：', e);
          dispatch({ type: 'java/scanning', scanning: false });
        },
      );

      /*
       * ★★ 多开实例：boot 之后**用后端的事实覆盖**本地的运行表。
       *
       *   顺序很重要：必须在 `boot/ok` 之后（那时实例列表才在 state 里，
       *   而 `game/sync` 只填 running，不碰 instances），
       *   而且读失败时**什么都不做**（保持空表，下一轮收到 `game-exit` 或
       *   用户点启动时后端会再次拒绝重复启动 —— 后端才是判据所在）。
       */
      if (runningR.status === 'fulfilled' && runningR.value.length > 0) {
        dispatch({ type: 'game/sync', list: runningR.value });
        console.info(`[IEML] 桌面版报回来 ${runningR.value.length} 个正在运行的游戏`);
      }

      /*
       * ★★ 隔离判定（ADR-005）：后端算完的结论搬进 state。
       *   读失败时**什么都不做**（保持空表）—— 界面显示"读取中"，
       *   而不是拿一个前端猜的结论冒充后端判定。
       */
      if (isolationR.status === 'fulfilled') {
        dispatch({ type: 'isolation/set', list: isolationR.value });
      } else {
        console.error('[IEML] 读取隔离判定失败（界面会显示"读取中"）：', isolationR.reason);
      }
    })();
  }, [backend]);

  /* ====================== 偏好落盘 ====================== */
  /**
   * 偏好一变就写盘（去抖 400ms，避免拖动滑块时狂写）。
   *
   * ★ 只在 boot 完成之后写：否则会把"默认值"覆盖掉刚读出来的用户设置。
   *
   * ★★ 但**第一次也要写**（这条是补的，审计发现了一个真 bug）：
   *   原来的逻辑是"boot 后的第一次 effect 直接 return，什么都不写"，
   *   意图是"别用默认值覆盖磁盘"。可它同时导致：
   *   **用户只是打开启动器、什么都没改、然后关掉 —— `prefs.json` 根本不会被创建。**
   *   实测证据：`%APPDATA%\IEML` 下 `instances.json` 与 cache 都有，
   *   唯独没有 `prefs.json` —— 也就是说"偏好会持久化"这件事
   *   **在"不改任何设置"的路径上从来没被验证过**。
   *
   *   现在改成：boot 之后**立即写一次**（此时 `state.prefs` 已经是磁盘上的值
   *   合并后的结果，写回去是幂等的），这样整条读→写链路每次启动都真的跑一遍。
   */
  useEffect(() => {
    if (!state.ready) return;
    const first = !prefsLoadedRef.current;
    prefsLoadedRef.current = true;
    const t = setTimeout(() => {
      /*
       * ★ 主题 / 视效档位与偏好一起存 —— payload 由 `prefsWriteRef` 提供
       *   （**只拼一处**：`createInstance` 撤墓碑时也要写整份偏好，
       *    两边各拼一份必然会漏字段，那一漏就把主题抹回默认值）。
       *
       * ★★ 视效档位也要落到 `prefs.json`（2026-09-22）。
       *
       *   为什么不能只留 localStorage：**Rust 侧要在创建 WebView2 之前读它** ——
       *   "灵动档用独显渲染"这件事（`--force_high_performance_gpu`）是启动期的
       *   一次性决定（GPU 适配器在 WebView2 起来时就选定了，跑起来改不了）。
       *   而 localStorage 在 WebView2 的 profile 里，Rust 启动时读不到。
       *   所以这里多写一份到 prefs.json，给 `lib.rs::request_high_performance_gpu` 看。
       */
      const payload = prefsWriteRef.current;
      void backend.savePrefs(payload).then(
        () => {
          if (first) {
            // 只记一次，用来确认"启动时那份偏好确实落盘了"
            console.info('[IEML] 偏好已写入 prefs.json（启动基线）');
          }
        },
        (e) => {
          /*
           * ★ 存不上要**留下痕迹**（原来这里是空 catch）：
           *   用户的体验是"设置改完重启就没了"，而日志里一个字都没有。
           *   现在至少 console 里有，设置页也会显示一条提示（见 saveFailed）。
           */
          setPrefsSaveFailed(e instanceof Error ? e.message : String(e));
          console.warn('[IEML] 偏好写入失败：', e);
        },
      );
    }, 400);
    return () => clearTimeout(t);
  }, [state.prefs, state.theme, state.ready, backend, vfxWant]);

  /* ====================== 主题 ====================== */
  useEffect(() => {
    applyTheme(state.theme);
    /*
     * ★★★★ 2026-09-30（用户）：「**载入加载器时的加载，先全白一下然后再进 logo**」。
     *
     *   主题的真身在 `prefs.json`（**异步**读盘），而启动画面必须在
     *   **第一帧之前**就知道底色 —— 那时候 prefs 还没读回来呢。
     *
     *   ⇒ 所以在这里把主题**镜像一份到 localStorage**（渲染进程里同步可读）。
     *     `index.html` 里那段内联脚本读的就是这个镜像，于是：
     *       · 用户换主题之后，下一次启动的画面就已经是他的色；
     *       · 读不到（第一次运行 / 清过缓存）就用默认深色，**绝不会变白**。
     *
     *   ★ 镜像只是"快"，**真值仍然是 `prefs.json`** —— 两者不一致时以 prefs 为准，
     *     而每次启动这一行都会把它重新对齐。所以它不可能长期漂移。
     */
    try {
      localStorage.setItem('ieml.theme', state.theme);
    } catch {
      /* 隐私模式 / 磁盘满：写不进去就算了，最多下次启动用默认深色 */
    }
  }, [state.theme]);

  /*
   * ★★ **"游戏关了，界面还说在运行"的兜底**（2026-09-16，用户报了两次）。
   *
   *   正常路径是后端推 `game-exit` 事件 → 前端清掉那一个实例。但用户实测
   *   出现过"游戏已经关了、启动器仍显示在运行"，而我把三处都查过：
   *   退出标记写了、事件带了 `instanceId`、前端桥接原样传了 payload ——
   *   每一段单独看都对，所以**没有复现**，也就没法证明是哪一段丢的。
   *
   *   与其继续猜，这里加一条**不依赖事件**的兜底：
   *   只要界面认为"有实例在跑"，就每 4 秒问一次后端的 `running_games`
   *   （它手里有子进程句柄，是**唯一**知道真相的地方），拿结果覆盖本地表。
   *
   *   为什么是 4 秒：真关了窗口的用户，4 秒内界面就会自己修正；
   *   而这条轮询只在"有实例在跑"时开，空转成本可以忽略。
   *   ★ 判据没有第二份：`running_games` 内部用的就是 `is_still_running`。
   */
  useEffect(() => {
    if (!state.ready) return;
    if (Object.keys(state.running).length === 0) return; // 没有在跑的就不轮询
    let alive = true;
    const tick = async () => {
      try {
        const list = await backend.runningGames();
        if (alive) dispatch({ type: 'game/sync', list });
      } catch {
        /* 读不到就等下一轮（不影响任何状态） */
      }
    };
    const t = window.setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [state.ready, state.running, backend]);

  /* ====================== 窗口标题 ====================== */
  const open = useMemo(() => selectOpenInstance(state), [state]);
  const target = useMemo(() => selectLaunchTarget(state), [state]);
  useEffect(() => {
    // 二级页面时标题显示正在编辑的版本（和 PCL 的"版本设置"标题一致）
    syncWindowTitle(open ? `版本设置 — ${open.config.name}` : null);
  }, [open?.config.name, open]);

  /* ====================== 实例变更时落盘 ====================== */
  const instancesRef = useRef(state.instances);
  instancesRef.current = state.instances;
  /*
   * 偏好的一份**同步镜像** —— 只给"身份必须稳定"的回调读（目前是
   * `removeInstance` 里的墓碑列表）。理由与 `instancesRef` 一样：
   * 回调不能因为设置变了一下就换一个新身份。
   */
  const prefsRef = useRef(state.prefs);
  prefsRef.current = state.prefs;
  /*
   * ★★ **要写进 `prefs.json` 的那份 payload**（只在这里拼一次）。
   *
   *   为什么要有它（2026-10-08）：`createInstance` 在"撤墓碑"那一步需要
   *   **立刻**把整份偏好落盘（顺序必须是"先撤墓碑、再写账本"，见那里）。
   *   而偏好 effect 里那份 payload 带了两个**不在 `state.prefs` 里**的字段
   *   （`theme` 顶层字段、`vfx` 给 Rust 启动期读的档位）——
   *   少了它们，一次"撤墓碑"的写盘就会把主题与视效档位抹掉。
   *   ⇒ 拼 payload 这件事收成一个 ref：谁要写偏好都从它取（**一处拼、处处一致**）。
   */
  const prefsWriteRef = useRef<Record<string, unknown>>({});
  prefsWriteRef.current = {
    ...state.prefs,
    theme: state.theme,
    vfx: vfxWant,
  } as unknown as Record<string, unknown>;
  useEffect(() => {
    if (!state.ready) return;
    /*
     * ★★ **没成功读到过，就绝不允许写。**（这条是实测丢数据之后补的）
     *
     *   老代码只看 `state.ready` —— 而 `boot/fail` 也把 ready 置真，
     *   于是"读实例列表失败"这条路上，250ms 后会把 `[]` 写回
     *   `instances.json`，用户的版本记录当场消失（游戏文件还在，
     *   但启动器里再也看不到它们）。
     *
     *   现场证据：`instances.json` 的修改时间 = 启动后 1 秒，
     *   内容 `{"instances":[],"active_id":null}`。
     *
     *   这个"读→写"链条上必须有一个前置条件：**先读到，才有资格写**。
     *   这与偏好那边 `prefsLoadedRef` 是同一个道理（那边早就有了，
     *   实例这边一直漏着 —— 而实例里装的是用户的游戏，更贵）。
     */
    if (!instancesLoadedRef.current) return;
    const t = setTimeout(() => {
      void backend.saveInstances(instancesRef.current, state.lastInstanceId);
    }, 250);
    return () => clearTimeout(t);
  }, [state.instances, state.lastInstanceId, state.ready, backend]);

  /* ====================== 跨组件事件桥 ====================== */

  /**
   * 让一条提示**先退场再移除**。
   *
   * ★ 直接 `toast/remove` 是"当场卸载"，没有退场动画 —— 用户报的
   *   「这个提示，消失时没动画」就是它。这里先打 `leaving` 标记（组件据此挂 class），
   *   等动画时长（TOAST_EXIT_MS）走完再真删。
   */
  const exitToast = useCallback((id: string) => {
    dispatch({ type: 'toast/leaving', id });
    window.setTimeout(() => dispatch({ type: 'toast/remove', id }), TOAST_EXIT_MS);
  }, []);

  /** 给一条提示装自动消失的定时器（sticky 的不装）。dispatch 是稳定的，所以空依赖安全。 */
  const armToastDismiss = useCallback(
    (id: string, kind: ToastItem['kind'], sticky: boolean) => {
      if (sticky) return;
      window.setTimeout(() => exitToast(id), toastLifetime(kind));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {    const onStarted = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; pid: number | null }>).detail;
      dispatch({ type: 'game/start', instanceId: d.id, pid: d.pid });
    };
    /*
     * "停止"的请求。
     *
     * ★★ 多开实例（2026-09-15）：这个事件现在**必须带实例 id**。
     *   以前它不带 —— 因为当时只有一个能停。现在同时可能有好几个在跑，
     *   不带 id 的"停一下"就等于"随机停一个"，那是会停错游戏的。
     *   只有明确说"全停"时才允许不带（`detail.instanceId === null`）。
     */
    const onStopRequest = (e: Event) => {
      const id = (e as CustomEvent<{ instanceId?: string | null }>).detail?.instanceId;
      if (id) dispatch({ type: 'game/stop', instanceId: id });
      else if (id === null) dispatch({ type: 'game/stop-all' });
      // 不带 detail 的旧式事件：不动状态（后端会推 game-exit，那时再清）
    };

    /*
     * ★ 后端推来的「游戏退出了」事件（游戏自己关闭、崩溃、或被 taskkill）。
     *
     *   实测（用户报"游戏关闭后启动器依然显示游戏在运行"）：
     *   在这之前**只有点「停止游戏」那条路径**会清 running ——
     *   用户自己关掉游戏窗口后，界面永远停在"运行中"，
     *   再点启动还会被"已经有一个游戏在运行了"挡住。
     *   现在后端退出监测线程会推 `game-exit`，这里收到就清状态。
     */
    const onGameExit = (e: Event) => {
      const d = (
        e as CustomEvent<{
          instanceId: string;
          exitCode: number | null;
          playedSeconds: number;
          crashed: boolean;
          crashReason?: string | null;
        }>
      ).detail;
      /* ★ 多开实例：只清**这一个**（别的还在跑，不许一起清掉） */
      if (d?.instanceId) dispatch({ type: 'game/stop', instanceId: d.instanceId });
      if (!d) return;
      /*
       * ★★ 2026-09-16 用户："'从未启动'相关的记录时间的功能，删掉，这没有用"。
       *
       *   这里原来会把这一局的时长写回实例（`lastPlayedAt` + `totalPlaySeconds`）——
       *   那是上一轮为了治"从未启动是骗人"补上的。用户现在明确不要这个功能了
       *   （理由也说得通：启动器的本职是"把游戏跑起来"，玩多久是游戏自己的事）。
       *
       *   所以**不再写**。字段本身留在类型与 `instances.json` 里不动 ——
       *   删字段会让老文件解析报错，而"留着不写也不显示"没有任何副作用。
       *   界面上那几处显示（概览的"最近游玩/累计时长"、启动页的"上次/从未启动"、
       *   版本列表行的相对时间）也一并删掉了。
       */
      const mins = Math.max(0, Math.round(d.playedSeconds / 60));
      if (d.crashed) {
        /*
         * ★★ **原因由后端给**（P0-6）：判据只有一份
         *   （`domain::crash::judge_crash` —— 退出码 + 游戏自己的崩溃声明 +
         *    离线身份下必然出现的 401 是否该排除）。
         *   前端**不许**在这里自己拼一句原因：那会变成第二套判据，
         *   而两套判据迟早会打架（这正是本轮修掉的东西）。
         */
        window.dispatchEvent(
          new CustomEvent('ieml:toast', {
            detail: {
              kind: 'err',
              title: '游戏异常退出',
              desc: d.crashReason
                ? `${d.crashReason}（${mins} 分钟后退出${
                    d.exitCode != null ? `，退出码 ${d.exitCode}` : ''
                  }）`
                : `${mins} 分钟后退出（退出码 ${d.exitCode ?? '未知'}）。看「日志」页有崩溃分析。`,
            },
          }),
        );
      } else {
        window.dispatchEvent(
          new CustomEvent('ieml:toast', {
            detail: {
              kind: 'info',
              title: '游戏已关闭',
              desc: d.playedSeconds > 0 ? `本次运行 ${mins} 分钟` : '',
            },
          }),
        );
      }
    };

    // Tauri 的事件监听（只有桌面端有；浏览器演示模式直接跳过）
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{
          instanceId: string;
          exitCode: number | null;
          playedSeconds: number;
          crashed: boolean;
          crashReason?: string | null;
        }>('game-exit', (ev) => {
          window.dispatchEvent(new CustomEvent('ieml:game-exit', { detail: ev.payload }));
        });
      } catch {
        /* 浏览器里没有 Tauri —— 正常情况，不用管 */
      }
    })();

    window.addEventListener('ieml:game-exit', onGameExit);
    const onPrefs = (e: Event) => {
      const patch = (e as CustomEvent<Partial<AppState['prefs']>>).detail;
      if (patch) dispatch({ type: 'prefs/patch', patch });
    };
    const onModsSet = (e: Event) => {
      const d = (
        e as CustomEvent<{
          entries: ModEntry[];
          states: Map<string, ModStateResult['state']>;
        }>
      ).detail;
      dispatch({ type: 'mods/set', entries: d.entries, states: d.states });
    };
    const onModsToggle = (e: Event) => {
      dispatch({ type: 'mods/toggle-select', path: (e as CustomEvent<string>).detail });
    };
    const onModsClear = () => dispatch({ type: 'mods/clear-select' });
    const onJavaRefresh = (e: Event) => {
      dispatch({ type: 'java/set', runtimes: (e as CustomEvent<JavaRuntime[]>).detail });
    };
    /* 安装流程（flows/install.ts）通过事件建任务，避免把 store 塞进非组件代码 */
    const onTaskAdd = (e: Event) => {
      const task = (e as CustomEvent<TaskItem>).detail;
      if (task) dispatch({ type: 'task/add', task });
    };
    const onTaskPatch = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; patch: Partial<TaskItem> }>).detail;
      if (d) dispatch({ type: 'task/patch', id: d.id, patch: d.patch });
    };
    const onTaskRemove = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) dispatch({ type: 'task/remove', id });
    };
    /* 非组件代码（flows/install.ts）弹 toast */
    const onToast = (e: Event) => {
      const d = (e as CustomEvent<{ kind: ToastItem['kind']; title: string; desc?: string }>).detail;
      if (!d) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const sticky = toastSticky(d.kind);
      dispatch({ type: 'toast/add', toast: { id, kind: d.kind, title: d.title, desc: d.desc, sticky } });
      armToastDismiss(id, d.kind, sticky);
    };
    /* 非组件代码请求切页（例如从流程里跳回版本列表） */
    const onNav = (e: Event) => {
      const page = (e as CustomEvent<PageId>).detail;
      if (page) dispatch({ type: 'nav', page });
    };

    window.addEventListener('ieml:game-exit', onGameExit);
    window.addEventListener('ieml:started', onStarted);
    window.addEventListener('ieml:stop-request', onStopRequest);
    window.addEventListener('ieml:prefs', onPrefs);
    window.addEventListener('ieml:mods-set', onModsSet);
    window.addEventListener('ieml:mods-toggle-select', onModsToggle);
    window.addEventListener('ieml:mods-clear-select', onModsClear);
    window.addEventListener('ieml:java-refresh', onJavaRefresh);
    window.addEventListener('ieml:task-add', onTaskAdd);
    window.addEventListener('ieml:task-patch', onTaskPatch);
    window.addEventListener('ieml:task-remove', onTaskRemove);
    window.addEventListener('ieml:toast', onToast);
    window.addEventListener('ieml:nav', onNav);
    return () => {
      unlisten?.();
      window.removeEventListener('ieml:game-exit', onGameExit);
      window.removeEventListener('ieml:started', onStarted);
      window.removeEventListener('ieml:stop-request', onStopRequest);
      window.removeEventListener('ieml:prefs', onPrefs);
      window.removeEventListener('ieml:mods-set', onModsSet);
      window.removeEventListener('ieml:mods-toggle-select', onModsToggle);
      window.removeEventListener('ieml:mods-clear-select', onModsClear);
      window.removeEventListener('ieml:java-refresh', onJavaRefresh);
      window.removeEventListener('ieml:task-add', onTaskAdd);
      window.removeEventListener('ieml:task-patch', onTaskPatch);
      window.removeEventListener('ieml:task-remove', onTaskRemove);
      window.removeEventListener('ieml:toast', onToast);
      window.removeEventListener('ieml:nav', onNav);
    };
    /*
     * ★★ 依赖数组从 `[state.running]` 改成 `[]`，并且事件里读的是 `stateRef.current`。
     *
     *   原来这里挂着 `[state.running]`：每次开关游戏都**重新注册一遍全部监听器**，
     *   而这样做的目的只是为了"让监听器里读到的 state 别太旧" —— 治标。
     *   多开之后 `running` 变化得更频繁（每个实例的每次开关），
     *   而且真正的隐患是：**监听器闭包捕获的 state 可能已经过期**
     *   （比如刚改完某个实例名，随后游戏退出要累加时长 —— 用的是旧表）。
     *   改成 ref 之后：监听器只注册一次，读到的永远是**当下**的 state。
     */
  }, []);

  /* ====================== 动作 ====================== */
  const go = useCallback((page: PageId) => dispatch({ type: 'nav', page }), []);
  const openVersion = useCallback((id: string, sub?: SubPageId) => {
    // 进入二级页 = 打开「版本列表」页 + 选中该版本
    dispatch({ type: 'nav', page: 'versions' });
    /*
     * ★ 指定页签时用**一次** dispatch 把"打开哪个版本 + 落在哪个页签"定下来。
     *   `nav/open-instance` 会把 subPage 归零成 overview，所以
     *   "先切页签再打开"会被覆盖 —— 见 store 里 `nav/open-instance-sub` 的说明。
     */
    if (sub) {
      dispatch({ type: 'nav/open-instance-sub', id, sub });
    } else {
      dispatch({ type: 'nav/open-instance', id });
    }
  }, []);
  const closeVersion = useCallback(() => dispatch({ type: 'nav/close-instance' }), []);
  const setSubPage = useCallback((sub: SubPageId) => dispatch({ type: 'nav/sub', sub }), []);
  const setDownloadTab = useCallback(
    (tab: DownloadTab) => dispatch({ type: 'nav/download-tab', tab }),
    [],
  );
  /**
   * ★ 切页 + 指定下载页签（一次派发完成）。
   *
   *   审计发现：调用方以前是这样写的 ——
   *     `go('download'); window.dispatchEvent(new CustomEvent('ieml:download-tab', …))`
   *   而 `DownloadPage` 的监听器是在它**挂载之后**的 effect 里注册的。
   *   调用这两行时 DownloadPage 还没挂载（用户正在启动页/版本列表），
   *   事件当场被丢掉 —— 用户点「浏览整合包」永远落在「安装游戏」页签。
   *
   *   现在合并成一个 action：页面和页签在同一次 dispatch 里定下来，
   *   不依赖任何事件时序。
   */
  const goDownloadTab = useCallback((tab: DownloadTab) => {
    dispatch({ type: 'nav/download-tab', tab });
    dispatch({ type: 'nav', page: 'download' });
  }, []);

  /**
   * ★★ 切到下载页 + 指定页签 + **指定装到哪个实例**，一次派发全部定下来。
   *
   *   为什么不能写成"先 `go('download')`、再发一个 `ieml:download-target` 事件"：
   *   `DownloadPage` 的监听器是在它**挂载之后**的 effect 里注册的。
   *   从「版本列表」或「概览页」点「安装 Mod」时下载页还没挂载，
   *   事件当场被丢掉 —— 玩家指定的那个版本白选了，Mod 会被装到
   *   "最近玩过的那个"上，**而且界面上看不出来**（下载页会安静地显示另一个版本）。
   *
   *   这和上面 `goDownloadTab` 当初解决的问题是**同一个**
   *   （见它上面那段注释："事件在目标页挂载前被丢掉"），所以修法也一样：
   *   放进 state，一次派发定下来，不依赖任何事件时序。
   *
   *   触发场景（用户 2026-09-16）：
   *   「原版不给装mod的选项，**能装mod的版本，跳转mod下载页**」。
   */
  const goDownloadFor = useCallback((tab: DownloadTab, instanceId: string | null) => {
    dispatch({ type: 'nav/download-tab', tab });
    dispatch({ type: 'nav/download-target', id: instanceId });
    dispatch({ type: 'nav', page: 'download' });
  }, []);

  /**
   * 单独设置下载页的目标实例（下载页那个「装到」选择器用）。
   *
   * 与 `goDownloadFor` 写同一个字段 —— **一处真相**。这样
   * "跳过来 → 又手动改选"不会出现两个值打架，也不需要同步 effect。
   */
  const setDownloadTarget = useCallback((instanceId: string | null) => {
    dispatch({ type: 'nav/download-target', id: instanceId });
  }, []);

  const setTheme = useCallback((theme: ThemeId) => dispatch({ type: 'theme', theme }), []);

  /**
   * ★★ 2026-09-23（用户第 3 条：「**资源管理器里删除版本，启动器不会同步删除**」）：
   *
   *   重新对一遍磁盘：后端 `list_instances` 会在读清单时把**目录已经不在了**的条目
   *   剔掉（并且写回清单），所以这里只要重新读一次、替换 state，同步就完成了。
   *
   *   ★ 为什么挂在"重获焦点"而不是定时轮询：用户删目录这个动作发生在**别的窗口**，
   *     他回到启动器那一刻就是最该刷新的时刻；定时轮询既费电，又可能在他正操作时改列表。
   *
   * ★★ 2026-09-25（用户：「换目录后不会自动刷新，我的建议是，点击版本列表就刷新一下，
   *   重新读取当前选择的游戏目录」）：**进「版本列表」页时也调它**（外加当前游戏根目录
   *   一变就再调一次）。实例的**目录**是按当前根目录算出来的 —— 用户换目录是在设置页做的，
   *   回到这一页时数据源已经换了，重读一次比"猜它变没变"便宜得多（读盘是毫秒级的）。
   *   ★ 只有一个"刷新实例"的入口：这里没有第二份实现。
   */
  const refreshInstances = useCallback(async () => {
    try {
      const r = await backend.loadInstances();
      dispatch({ type: 'instances/refresh', instances: r.instances });
    } catch {
      /* 读不到就保持现状 —— 刷新失败不该把列表清空 */
    }
  }, [backend]);

  /**
   * ★★ 重拉一遍**隔离判定**（ADR-005）。
   *
   * 判定的规则在 Rust 侧，所以"改完隔离设置"之后前端唯一正确的动作是**回读**，
   * 而不是自己推一个结论（那正是这次修掉的缺陷：两份规则、谁也不算数）。
   * 读失败时保持上一次的结论并写一行日志 —— 界面上那一条会显示成"读取中"，
   * 比编一个结论安全。
   */
  const refreshIsolation = useCallback(async () => {
    try {
      const list = await backend.listIsolation();
      dispatch({ type: 'isolation/set', list });
    } catch (e) {
      console.error('[IEML] 重新读取隔离判定失败：', e);
    }
  }, [backend]);

  /**
   * ★★ 重读机器信息（可用内存 / 总内存）。
   *
   * 只换 `machine` 这一格（`machine/set` 本来就是这个语义）——
   * 换游戏根目录之后也是它把新路径带回来的（见 `reloadAfterRootChange`）。
   */
  const refreshMachine = useCallback(async () => {
    try {
      const m = await backend.machineInfo();
      dispatch({ type: 'machine/set', machine: m });
    } catch (e) {
      /* 读失败就保持原值 —— 一个旧数字比一个假的 0 好 */
      console.error('[IEML] 重读机器信息失败（保持原值）：', e);
    }
  }, [backend]);

  useEffect(() => {
    const onFocus = () => void refreshInstances();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshInstances]);


  /**
   * ★★ 2026-09-25（用户：「主页也有同样问题」）：**当前文件夹里的版本** ——
   *   版本列表与启动页共用这一份（PCL 的文件夹逻辑，规则在 `domain/folder-versions.ts`）。
   *
   *   为什么放全局：这一份数据现在有**四个**出口（版本列表的行、启动页的"可启动版本"、
   *   侧栏角标、筛选里的"全部 N"）。上一轮就是因为一个出口改了、另外两个没改，
   *   页头显示 0、角标还显示 3 —— 数据只读一次，谁用谁取。
   */
  const [folderVers, setFolderVers] = useState<FolderVersion[] | null>(null);
  /*
   * ★★ 2026-09-29：`folder_versions` 是**异步**读的，而触发点现在有好几个
   *   （开机 / 焦点 / 事件 / 10 秒轮询）—— 两个请求同时在飞时，
   *   **先发的可能后回**，把新结果盖成旧的（列表会"闪回上一次的内容"）。
   *   ⇒ 用序号只认最后一次请求的结果（与下载那边的"只认最新一次"同一个思路）。
   */
  const folderSeqRef = useRef(0);
  /*
   * ★★ 2026-09-30（用户两次截图：「这些数字，完全错误」「这个数字什么时候修一下」）：
   *
   *   **角标、页头、列表行必须是同一个数**，而且它要**同时**满足：
   *     · 只数**能启动的版本**（带版本 JSON 的目录）—— 空壳目录不是版本；
   *     · 排除**墓碑里的**（用户删过的）—— 删掉的不算在册。
   *
   *   原来的两条尺子（真机上量到的）：
   *     · 角标 = 盘上带 JSON 的目录数（3）
   *     · 页头 = 过滤后的账本行数（1）
   *   于是同屏出现 3 与 1，而**两个都对**——错的是"两把尺子"这件事本身。
   */
  const versionCount = useMemo(() => {
    if (folderVers === null) return null;
    /*
     * ★★★★ 2026-09-30（用户）：「**这个检测版本，太抽象了**」+ 列表改学 PCL 之后：
     *
     *   这个数现在 = **盘上版本文件夹的个数**（就是版本列表列出来的行数）。
     *
     *   ★ 以前它只数"有版本 JSON 的目录"，而列表走的是另一套（账本），
     *     于是同屏出现两个都自认为对的数（角标 3 / 页头 1）。
     *     现在列表与这个数**同一个来源**，不可能再打架。
     *   ★ 坏掉的版本**也算在内**：它们**显示在列表里**（PCL 就是这样），
     *     数字当然也要算 —— "数字与列表对不上"正是前两轮被投诉的那件事。
     */
    return folderVers.length;
  }, [folderVers]);

  /**
   * 重扫 `versions/`，把结果放进 state。
   *
   * ★★★★ 2026-10-08（用户：「版本列表的重新探测就跟没反应似的」）：
   *   **改成返回扫到的清单、并且失败时抛出**。原来它 `catch {}` 一吞了事 ——
   *   读盘失败时列表**静默不变**，用户看到的就是"点了没反应"，
   *   连一句"读不到"都没有。
   *
   *   ★ 返回值的用处：调用方（「重新探测」按钮）要**如实报出扫到了几个**。
   *     报结果时必须用这个返回值，**不能**去读 `folderVers` state ——
   *     setState 是异步的，那会报出上一次的数字。
   *   ★ 抛出的用处：让调用方决定怎么提示。**不在这里直接 toast** ——
   *     AppContext 在启动时也会调它，那时候弹一个错误框很吵；
   *     而"用户手点的那一次"才需要说话（见 `VersionsPage`）。
   */
  const reloadFolderVersions = useCallback(async (): Promise<FolderVersion[]> => {
    const seq = (folderSeqRef.current += 1);
    let list: FolderVersion[];
    try {
      list = await backend.folderVersions();
    } catch (e) {
      if (seq === folderSeqRef.current) {
        /* 读不到就不筛（`null`）——读不到 ≠ 没有；界面宁可多显示，也不要凭空藏东西 */
        setFolderVers(null);
      }
      throw e;
    }
    // 有更新的请求了 —— 这次的结果作废（但已经扫到了，照样把它交给调用方）
    if (seq === folderSeqRef.current) {
      setFolderVers(list);
    }
    return list;
  }, [backend]);
  const folderMatch = useMemo(
    () => matchFolderVersions(state.instances, folderVers),
    [state.instances, folderVers],
  );

  /* 启动就读一次：启动页第一屏就要按"当前文件夹"说话（不然会列出一堆不在这个文件夹里的版本） */
  useEffect(() => {
    void reloadFolderVersions();
  }, [reloadFolderVersions]);

  /*
   * ★★ 2026-09-29（用户：「下载完版本，资源管理器里删除完版本等**不会自动刷新版本列表**」）
   *
   *   以前这一份**只在开机与切换游戏目录时**读一次 —— 于是：
   *     · 装完一个版本，列表里还是旧的（要手动点「重新探测」）；
   *     · 在资源管理器里删掉版本目录，列表里那一行**还在**，点它才发现没了。
   *
   *   现在三个触发点，覆盖"谁改了磁盘"这件事的全部可能：
   *     ① `ieml:folder-changed` —— 启动器自己改的（安装完成 / 删除 / 导入 / 换目录）；
   *     ② 窗口重新获得焦点 —— 用户从资源管理器回来（这正是他发现"没刷新"的时刻）；
   *     ③ 一个 10 秒的慢轮询（只在页面可见时）—— 分屏 / 双屏下窗口一直有焦点的情况。
   *
   *   ★ 为什么敢轮询：`folder_versions` 只是一次 `read_dir` + 读每个版本自己的那份
   *     json（几十个小文件，毫秒级）。而"列表和磁盘不一致"这件事的代价大得多。
   */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void reloadFolderVersions();
    };
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('ieml:folder-changed', refresh);
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('ieml:folder-changed', refresh);
      window.clearInterval(timer);
    };
  }, [reloadFolderVersions]);

  /*
   * ★★ 2026-09-29（用户：「当没有版本时，下载第一个版本**不会自动选择那个仅有的版本**」）
   *
   *   账本里**一个实例都没有**、而当前文件夹里**有版本**时，自动认领一个：
   *   这样"装完第一个版本"之后，启动页立刻就有可启动的目标，不用用户再点一次。
   *
   *   三条纪律（都是"不许替用户做决定"的边界）：
   *     · **只在 0 个实例时**跑 —— 有实例就说明账本是好的，绝不改写用户的选择；
   *     · 只认领**能在启动器里启动的**（`ok`）版本；多个时按文件夹顺序取第一个
   *       （与版本列表的显示顺序一致，用户看得见是哪一条）；
   *     · 认领过就不再跑（认领之后 `instances.length === 1`），不会反复建。
   *   ★ 用的是与「建实例」按钮**同一个函数**（`instanceFromFolderVersion`）。
   *
   * ★★★★ 2026-10-08（用户）：「……**甚至模组加载器被识别为了可启动游戏版本**」。
   *
   *   多了一条**闸门**：**有安装任务在跑时，一步都不认领**。
   *
   *   为什么这条必须有（用户报的就是它）：安装是**一边下一边往盘上写**的
   *   （版本描述先落盘，jar 与库随后），所以那一刻盘上的目录**是半成品**。
   *   自动认领看的是同一份盘上事实 —— 于是它会抢先把那个"安装器目录"
   *   认领成"用户唯一的版本"：账本里那条记录落在加载器目录上，
   *   而**用户真正要用的那个版本反而没有记录**（收藏就存在记录上 ⇒
   *   星星是禁用的，他报的"那个正确版本无法被收藏"），
   *   并且"只在 0 个实例时认领"这条边界会让正确的版本**再也没机会**被认领。
   *   ⇒ 判据：**盘上还在变的时候不做决定**（`hasRunningTask`）。
   *     装完（任务变成 done/成功）之后这一支自然会再跑一次 —— 那时认领才是对的。
   */
  const autoAdoptTriedRef = useRef(false);
  useEffect(() => {
    if (!state.ready || !instancesLoadedRef.current) return;
    if (autoAdoptTriedRef.current) return;
    /*
     * ★ 注意顺序：这条闸门**不能**写 `autoAdoptTriedRef.current = true`
     *   —— 那等于"因为正在安装所以永远不认领了"。它只是**这一次不判**，
     *   任务结束后 effect 会因为 `state.tasks` 变化再跑一遍。
     */
    if (hasRunningTask(state.tasks)) return;
    const fv = pickAutoAdopt(folderVers, state.instances, state.prefs.deletedVersions);
    if (!fv) return;
    autoAdoptTriedRef.current = true;
    const inst = instanceFromFolderVersion(fv, {
      /*
       * ★★ 2026-09-30：这里原来写死 `takenSlugs: []` —— 于是自动认领出来的
       *   slug 永远等于**版本目录名**（`fv.dir`），与盘上那个目录**就是同一个**。
       *
       *   在旧布局下这是错的（slug 是另一套命名，撞了会共用目录）；
       *   在新布局下它恰恰是**对的、也是必须的**：版本目录只有一个，
       *   实例记录只是给它补上"你起的名字与设置"。所以这里传空集合是
       *   有意的，注释留在这里免得下一个人"顺手修好它"。
       */
      takenSlugs: [],
      totalMemoryGb: state.machine?.totalMemoryGb ?? 16,
      availableMemoryGb: state.machine?.availableMemoryGb ?? 8,
    });
    void createInstance(inst)
      .then(() => {
        // 用非组件那条 toast 通道（`ieml:toast`）—— 这里比 `say` 的定义更早，
        // 而这条事件本来就是为了"非组件代码弹提示"存在的（见上面的 onToast 监听）
        window.dispatchEvent(
          new CustomEvent('ieml:toast', {
            detail: {
              kind: 'ok',
              title: '已经选中文件夹里的版本',
              desc: `${fv.dir} —— 这是当前唯一可启动的版本，直接点启动就行`,
            },
          }),
        );
      })
      .catch((e) => {
        // 认领失败**不能影响启动器**：说一句实话就好（用户还能在版本列表里手动建实例）
        window.dispatchEvent(
          new CustomEvent('ieml:toast', {
            detail: {
              kind: 'warning',
              title: '没能自动选中版本',
              desc: e instanceof Error ? e.message : String(e),
            },
          }),
        );
      });
    // `createInstance` / `say` 都是稳定的回调；这里只依赖"那一刻的事实"
    // ★ 墓碑也在依赖里：它变了（用户又删了一个版本）就必须重新判一次
    // ★★ 任务表也在依赖里（2026-10-08）：安装**装完那一刻**（任务从 running 变
    //    done）要再判一次 —— 否则"安装中不认领"就变成了"永远不认领"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.ready,
    state.instances.length,
    state.machine,
    folderVers,
    state.prefs.deletedVersions,
    state.tasks,
  ]);

  const setLaunchTarget = useCallback((id: string | null) => {
    dispatch({ type: 'instances/last', id });
  }, []);

  /*
   * ★★ "正在启动"是**全局状态**（2026-09-30，见接口里那段说明）：
   *   原来它在 `LaunchPage` 里，一离开那页就归零 —— 启动还在跑，界面却装作没在跑。
   */
  const [launchStarting, setLaunchStarting] = useState(false);

  /**
   * ★★ **整合包作者的图标**（2026-09-30，用户：「这两处的整合包显示整合包自己的图标」）。
   *
   *   `版本 id → data:` URI`。**只含真的有图标的包** —— 作者没放图标的包不在里面，
   *   界面退回自绘的版本图标。
   *
   *   放在全局的理由：它有**两个消费方**（启动页大卡片、版本列表行），
   *   而它一次能拿全部、又不随页面变化 —— 每个页面各查一次就是重复 IPC。
   *   读失败 / 演示模式 = 空表（界面画自绘图标，**不是空白**）。
   */
  const [packIcons, setPackIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void backend
      .packIcons()
      .then((m) => {
        if (alive && m) setPackIcons(m);
      })
      .catch(() => {
        /* 拿不到就画自绘图标 —— 不编、也不报错 */
      });
    return () => {
      alive = false;
    };
  }, [backend]);
  const [launchProgress, setLaunchProgress] = useState<{
    stage: string;
    finished: number;
    total: number;
    percent: number;
    current: string;
  } | null>(null);

  /**
   * ★★ 2026-09-23（C5）：打开资源的独立安装页。
   *
   *   `hit` 与 `kind` 一起放进 state —— 切页之后列表组件会卸载，
   *   目标必须活在页面之外（与 `setLaunchTarget` 上面那条教训同一个道理）。
   */
  const openResource = useCallback((hit: unknown, kind: string, source?: string) => {
    dispatch({ type: 'resource/open', hit, kind, source });
    dispatch({ type: 'nav', page: 'resource' });
  }, []);

  /** ★ C5：从安装页返回下载页（顺手把目标清掉，免得下次进来还是旧的那个） */
  const closeResource = useCallback(() => {
    dispatch({ type: 'resource/close' });
    dispatch({ type: 'nav', page: 'download' });
  }, []);

  const toast = useCallback((kind: ToastItem['kind'], title: string, desc?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sticky = toastSticky(kind);
    dispatch({ type: 'toast/add', toast: { id, kind, title, desc, sticky } });
    armToastDismiss(id, kind, sticky);
  }, []);

  /*
   * 点 × 关闭也走**退场**（2026-09-22）。
   * ★ 这里原来是 `dispatch({type:'toast/remove'})` —— 当场卸载，
   *   于是"点 × 关闭"这条路上**永远看不到退场动画**（用户报的正是它）。
   */
  const dismissToast = useCallback((id: string) => exitToast(id), [exitToast]);

  /**
   * **写账本之前，先把这些 slug 的墓碑撤掉**（`prefs.deletedVersions`）。
   *
   * ★★★★ 2026-10-08（用户第二次报）：「下载带模组加载器的版本……**模组加载器版本的
   *   mc 还没办法收藏**」。
   *
   *   根因不是安装，而是**墓碑与账本在互相否定**：
   *   用户在更早的轮次删过 `26.3-fabric-0.19.5`，墓碑里留着这个名字；
   *   这一次他**重新装**了同一个版本 —— 文件写回了、记录也建了，可
   *   `list_instances` 每次读账本都按墓碑把这条记录滤掉（还把过滤后的结果写回文件），
   *   于是刚装好的版本在账本里消失 ⇒ 行上没有记录 ⇒ 收藏星禁用（收藏存在记录上），
   *   版本名退回目录名，连身份小抄都拿不到。
   *
   *   ⇒ 规则：**账本里出现某个 slug 的记录 ⇒ 那个名字的墓碑作废**。
   *     "用户删过它"这个前提已经被"用户又把它装回来了"推翻。
   *     判据在 `domain/folder-versions.ts::unburySlug`（与 `burySlug` 成对、有测试）。
   *
   * ★ 顺序在这里是语义：**墓碑必须先落到盘上，再写账本**。反过来的话，
   *   中间那一瞬间是"记录在、墓碑也在"，而 `list_instances` 会把记录滤掉并写回
   *   文件 —— 安装刚完成、界面正好刷新一次，记录就没了（真机实测到的形状：
   *   账本里没有那条记录，却留着它的 `active_id`）。
   * ★ 所以这里**当场落盘**，不靠 400ms 的偏好 effect（那个只是兜底）。
   * ★ 只有"建记录"这条路调它；删除、改名、收藏那些写入**不许**调 ——
   *   删除过程中账本里那一瞬间还留着旧记录，撤墓碑会把它变成"诈尸"。
   */
  const unburyBeforeLedgerWrite = useCallback(
    async (slugs: readonly string[]) => {
      const current = prefsRef.current.deletedVersions;
      const kept = unburySlugs(slugs, current);
      if (kept === current) return;
      dispatch({ type: 'prefs/patch', patch: { deletedVersions: kept } });
      try {
        /*
         * ★ 必须带**整份**偏好：`save_prefs` 是整文件覆盖，只写一个字段
         *   会把主题 / 账号 / 下载源一起抹掉。payload 与偏好 effect 同源
         *   （`prefsWriteRef` —— 那份 payload 只拼一处）。
         */
        await backend.savePrefs({ ...prefsWriteRef.current, deletedVersions: kept });
        console.info(`[IEML] ${slugs.join('、')} 又装回来了 —— 已撤掉它的墓碑`);
      } catch (e) {
        /*
         * 撤不掉也不能拦着建记录：账本照写（用户能看到版本），
         * 只是这一轮读的时候可能还被滤一次 —— 偏好 effect 会把内存里
         * 那份（已撤墓碑）再存一次，下一轮就正常了。
         */
        console.warn('[IEML] 撤销墓碑失败（账本照常写）：', e);
      }
    },
    [backend],
  );

  /**
   * **建一条实例记录**（安装 / 整合包 / 自动认领共用这一个入口）。
   * 复制实例走的是另一条路（它不设 active），那边也会先调
   * `unburyBeforeLedgerWrite` —— 判据只有一份。
   */
  const createInstance = useCallback(
    async (inst: Instance) => {
      await unburyBeforeLedgerWrite([inst.config.slug]);
      dispatch({ type: 'instances/add', instance: inst });
      dispatch({ type: 'instances/last', id: inst.id });
      const next = [...instancesRef.current, inst];
      await backend.saveInstances(next, inst.id);
    },
    [backend, unburyBeforeLedgerWrite],
  );

  const updateConfig = useCallback((id: string, patch: Partial<InstanceConfig>) => {
    dispatch({ type: 'instances/config', id, patch });
  }, []);

  /**
   * 删除一个实例。
   *
   * ★ 审计发现：以前只从内存列表里删掉记录，而三处确认框都写着
   *   「存档与配置会一起删除」—— **磁盘上什么都没删**，用户以为删干净了。
   *   现在真的去删 `instances/{slug}/`（存档 / Mod / 配置 / natives 全在里面），
   *   并把结果如实报告给调用方。
   *
   * ★ 默认进**系统回收站**（`permanent = false`）：实例里有存档，
   *   这是最不该"删错了就没了"的东西。
   *
   * ★★ 2026-09-24（A-3）**顺序改过来了：先删文件、成功之后再删记录**。
   *
   *   原来反过来（先 `dispatch(remove)` 再删磁盘），于是"删文件失败"时
   *   记录已经没了、目录还在，用户看到的是：
   *     · 列表里那条消失了；
   *     · 想再删一次 —— **再没有入口**（记录没了，界面上找不到它）；
   *     · 而重试分支又调了同一个函数，`find` 找不到记录 → `return 0` **什么都没删**，
   *       调用方却无条件弹「已永久删除」。
   *   真机复现过（`tools/live/probe-bug-repro-4.mjs`）：弹「已永久删除」、
   *   记录消失、`instances/<slug>/` 还在磁盘上。
   *
   *   现在：**失败就什么都不动**（记录还在、可以重试），成功才从列表里移除。
   *
   * 返回删掉的字节数（0 = 目录本来就不存在）。
   */
  /**
   * 记墓碑（两条删除路径共用）。见 `AppContextValue['buryVersion']` 的说明。
   * ★ 读的是 `prefsRef`（不是 `state.prefs`）—— 与 `removeInstance` 同一个理由：
   *   回调身份要稳定，否则每次改设置都会换一个新函数。
   */
  const buryVersion = useCallback((slug: string) => {
    if (!slug) return;
    dispatch({
      type: 'prefs/patch',
      patch: { deletedVersions: burySlug(slug, prefsRef.current.deletedVersions) },
    });
  }, []);

  const removeInstance = useCallback(
    async (id: string, permanent = false): Promise<number> => {
      const inst = instancesRef.current.find((i) => i.id === id);
      if (!inst) {
        /*
         * ★ 记录不在了就**别假装删过**：说清楚，也别去碰磁盘 ——
         *   我们连 slug 都不敢确定（列表可能刚被刷新过）。
         */
        throw new Error('这条记录已经不在了（列表可能刚刷新过）—— 重看一遍再删。');
      }
      let bytes = 0;
      try {
        bytes = (await backend.deleteInstanceFiles(inst.config.slug, permanent)) ?? 0;
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}（版本目录：.minecraft/versions/${inst.config.slug}/）`,
        );
      }
      /*
       * ★★ 2026-09-30：**先记墓碑，再删记录**（用户报的「删了的又回来」）。
       *
       *   墓碑写进 `prefs.json` 的 `deletedVersions`，`pickAutoAdopt` 会跳过它。
       *   为什么删了目录还要记：`deleteInstanceFiles` 在目录**本来就不存在**时
       *   返回 0 并当成功（那是刻意的，见 Rust 侧说明），而"目录不在而版本
       *   还在"是可能出现的状态（用户自己在资源管理器里删过、或删到一半失败）。
       *   只删记录的话，下一轮启动的"自动认领"会照着文件夹里的版本把它建回来。
       *
       *   ★ 顺序：墓碑必须**先于** `instances/remove` 落盘 —— 反过来的话，
       *     中间那一瞬间（记录没了、墓碑也还没写）恰好就是自动认领的条件。
       */
      dispatch({
        type: 'prefs/patch',
        patch: { deletedVersions: burySlug(inst.config.slug, prefsRef.current.deletedVersions) },
      });
      // ★ 磁盘处理完了才动记录 —— 顺序反过来就是上面那条缺陷
      dispatch({ type: 'instances/remove', id });
      /*
       * ★ 2026-09-29：删除动过磁盘（`versions/<slug>/`）—— 广播一句"文件夹变了"，
       *   版本列表与启动页立刻重读，不再等用户手动点「重新探测」。
       */
      window.dispatchEvent(new CustomEvent('ieml:folder-changed'));
      return bytes;
    },
    // ★ 依赖里**故意没有** `state.prefs`：墓碑读的是 `prefsRef`（见它的说明），
    //   所以这个回调的身份是稳定的 —— 去掉这一条会让它每次改设置都换一个新身份，
    //   而它被好几个页面的 useCallback 依赖着。
    [backend],
  );

  /**
   * 改实例的**显示名**（只改显示名，不动目录名 —— ADR-007）。
   *
   * ★★ **校验收敛到这一处**（这一轮）。
   *
   *   原来三个页面各写一遍重命名：
   *     `InstanceSetup` / `InstanceOverview` / `VersionsPage`
   *   每一处都是自己 `prompt()` → `next.trim()` → `renameInstance()` →
   *   自己弹一句 toast。三份"判据 + 文案"就是三份将来会分叉的东西
   *   （这个仓库已经因此栽过两次：`forgespi` 的版本号、`26.2` 的 Java 要求）。
   *
   *   现在判据走 `domain/validate.ts::instanceNameRules()`，并且
   *   **顺便挡住重名** —— 重名以前是允许的，于是版本列表里会出现两行
   *   一模一样的名字，用户根本分不清哪个是哪个。
   *
   * 返回：`null` = 成功；否则是给用户看的原因。
   */
  const renameInstance = useCallback(
    (id: string, name: string): string | null => {
      const trimmed = name.trim();
      const why = validate(trimmed, instanceNameRules());
      if (why) return why;

      const clash = instancesRef.current.find(
        (i) => i.id !== id && i.config.name === trimmed,
      );
      if (clash) {
        return `已经有一个版本叫「${trimmed}」了 —— 换一个名字，否则版本列表里两行长得一样`;
      }

      dispatch({ type: 'instances/config', id, patch: { name: trimmed } });
      return null;
    },
    [],
  );

  /**
   * 收藏 / 取消收藏一个版本（列表里那颗星）。
   *
   * ★★★★ 2026-10-07（用户：「给全部的左侧加一个收藏」）。
   *
   *   ## 为什么不是"只 dispatch 就完事"
   *
   *   `renameInstance` 那种只 `dispatch` 是够的 —— 因为别处（启动、切页）
   *   迟早会把账本整体写回去。**收藏不行**：用户点完星标很可能什么都不做就关掉
   *   启动器，那一趟落盘永远不来，收藏就丢了。
   *   ⇒ 这里**当场落盘**（`saveInstances`）。
   *
   *   ## 为什么把"新数组"算出来再发，而不是在 reducer 里改
   *
   *   落盘的必须是**改完之后**的那一份。`instancesRef.current` 是当前值，
   *   在它上面映射出 `next` 再一起做两件事（dispatch + save），
   *   两边的来源就是同一个 `next`，不会出现"界面已改、盘上没改"。
   */
  const setFavorite = useCallback(async (id: string, favorite: boolean) => {
    const next = instancesRef.current.map((i) =>
      i.id === id ? { ...i, config: { ...i.config, favorite } } : i,
    );
    if (!next.some((i) => i.id === id)) return;
    dispatch({ type: 'instances/set', instances: next });
    try {
      await backend.saveInstances(next, state.lastInstanceId);
    } catch (e) {
      /*
       * 落盘失败要**说出来**：否则用户看到星星已亮、重启却没了，
       * 而那正是最难查的一类"改了没生效"。
       */
      toast('err', '收藏没存下来', e instanceof Error ? e.message : String(e));
    }
  }, [backend, state.lastInstanceId, toast]);

  /* ====================== 好友（正版专用，2026-10-12） ======================
   *
   * 名单以**服务端为准**（`GET /friends`，正版令牌）；本机只留备注
   * （`prefs.friendNotes`，解析规则在 `domain/friends.ts`，那边有 10 条用例）。
   *
   * 在线状态靠**心跳**：周期性 `POST /presence` —— 既上报"我在线"、又拿回好友们
   * 的状态（客户端自己就是这么做的：authlib 里那份 `presenceCache` 干的是这件事）。
   *
   * ★ 为什么用心跳而不是"点开好友页才查"：用户在启动器里待着的时候，
   *   好友在游戏里应该能看到他**在线**（用户 2026-10-12 选定的行为）。
   * ★ 关启动器时补一发 `OFFLINE`（尽力而为：窗口卸载不一定来得及发出去，
   *   而服务端有 `lastUpdated`，会自己判过期）。
   */
  const friendsUuid = state.prefs.accountUuid ?? null;

  const refreshFriends = useCallback(async (): Promise<void> => {
    if (!friendsUuid) return;
    dispatch({ type: 'friends/patch', patch: { loading: true, error: null } });
    try {
      const [snapshot, presence] = await Promise.all([
        friendsApi.snapshot(friendsUuid),
        // 状态拿不到不该让整次刷新失败（名单才是主体）
        friendsApi.presence(friendsUuid, 'ONLINE').catch(() => []),
      ]);
      /*
       * ★★ 304 的处理（用户 2026-10-12 给的设计图）：`null` 表示**服务端说没变**，
       *   那就**沿用本地那份**，绝不能把它当成"名单空了"（那会让界面突然空掉，
       *   而用户的好友一个没少）。名单与在场各自判各自的。
       */
      const patch: Partial<typeof state.friends> = {
        loading: false,
        error: null,
        updatedAt: Date.now(),
      };
      if (snapshot) patch.snapshot = snapshot;
      if (presence) {
        const map: Record<string, PresenceStatus | null> = {};
        for (const p of presence) map[p.profileId.toLowerCase()] = p.status ?? null;
        patch.presence = map;
      }
      /* `presenceAt` 每次都记：304 也说明"我们手上的状态是最新的" */
      patch.presenceAt = Date.now();
      dispatch({ type: 'friends/patch', patch });
    } catch (e) {
      /*
       * ★ 失败原因**留在 state 里**（页面显示它），不只弹个 toast 就没了 ——
       *   用户要照着它决定"是不是得重新登录一次"。
       */
      dispatch({
        type: 'friends/patch',
        patch: { loading: false, error: e instanceof Error ? e.message : String(e) },
      });
    }
  }, [friendsUuid]);

  /** 关系动作（加/删/同意/拒绝/撤销）走同一条路：调用 → 成功就刷新名单 */
  const friendAct = useCallback(
    async (what: string, fn: () => Promise<void>, okText: string, okDetail?: string): Promise<boolean> => {
      try {
        await fn();
        toast('ok', okText, okDetail);
        await refreshFriends();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast('err', `${what}失败`, msg);
        dispatch({ type: 'friends/patch', patch: { error: msg } });
        return false;
      }
    },
    [refreshFriends, toast],
  );

  const addFriendByName = useCallback(
    async (name: string): Promise<boolean> => {
      if (!friendsUuid) return false;
      return friendAct(
        '加好友',
        async () => {
          await friendsApi.add(friendsUuid, name.trim());
        },
        '好友请求已发出',
        `${name.trim()} —— 等他同意之后就出现在名单里`,
      );
    },
    [friendAct, friendsUuid],
  );

  const removeFriend = useCallback(
    async (profileId: string, name: string): Promise<boolean> => {
      if (!friendsUuid) return false;
      return friendAct(
        '删好友',
        async () => {
          await friendsApi.remove(friendsUuid, profileId);
        },
        '已从名单里删掉',
        name,
      );
    },
    [friendAct, friendsUuid],
  );

  const acceptFriend = useCallback(
    async (profileId: string, name: string): Promise<boolean> => {
      if (!friendsUuid) return false;
      return friendAct(
        '同意好友',
        async () => {
          await friendsApi.accept(friendsUuid, profileId);
        },
        '已同意',
        `${name} 现在是你的好友了`,
      );
    },
    [friendAct, friendsUuid],
  );

  const declineFriend = useCallback(
    async (profileId: string, name: string): Promise<boolean> => {
      if (!friendsUuid) return false;
      return friendAct(
        '拒绝请求',
        async () => {
          await friendsApi.decline(friendsUuid, profileId);
        },
        '已拒绝',
        `${name} 的请求已处理`,
      );
    },
    [friendAct, friendsUuid],
  );

  const revokeFriendRequest = useCallback(
    async (profileId: string, name: string): Promise<boolean> => {
      if (!friendsUuid) return false;
      return friendAct(
        '撤销请求',
        async () => {
          await friendsApi.decline(friendsUuid, profileId);
        },
        '已撤销',
        `不再等 ${name} 同意`,
      );
    },
    [friendAct, friendsUuid],
  );

  const loadFriendSettings = useCallback(async (): Promise<void> => {
    if (!friendsUuid) return;
    try {
      const s = await friendsApi.settings(friendsUuid);
      dispatch({ type: 'friends/patch', patch: { settings: s } });
    } catch (e) {
      dispatch({
        type: 'friends/patch',
        patch: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }, [friendsUuid]);

  const saveFriendSettings = useCallback(
    async (friendsToggle: Toggle, acceptInvites: Toggle) => {
      if (!friendsUuid) return;
      try {
        await friendsApi.setSettings(friendsUuid, friendsToggle, acceptInvites);
        dispatch({
          type: 'friends/patch',
          patch: { settings: { friends: friendsToggle, acceptInvites } },
        });
        toast('ok', '好友设置已保存');
      } catch (e) {
        toast('err', '好友设置没存下来', e instanceof Error ? e.message : String(e));
      }
    },
    [friendsUuid, toast],
  );

  /** 本机备注（只进 prefs，不碰服务端） */
  const notesRef = useRef(state.prefs.friendNotes);
  notesRef.current = state.prefs.friendNotes;
  const setFriendNote = useCallback((profileId: string, note: string): void => {
    dispatch({ type: 'prefs/patch', patch: { friendNotes: setFriendNoteIn(notesRef.current, profileId, note) } });
  }, []);

  /*
   * ★★ **在线状态心跳**（2026-10-12）。
   *
   *   每 30 秒一次 `POST /presence`：上报"我在线"，同时把好友们的状态收回来。
   *   为什么不是"点开好友页才查"：用户选定的行为是"**开着启动器时好友能看到我在线**"，
   *   所以心跳跟着**账号**走，而不是跟着某个页面走。
   *
   *   ★ 关窗口时补一发 `OFFLINE`（尽力而为）—— 服务端有 `lastUpdated` 会自己判过期，
   *     所以这只是"更干净"，不是唯一依赖。
   *   ★ 心跳失败**不打扰用户**：名单那条路有自己的错误显示，心跳失败多半只是网络抖。
   */
  useEffect(() => {
    if (!state.ready || !friendsUuid) return;
    let alive = true;
    const beat = async () => {
      try {
        const rows = await friendsApi.presence(friendsUuid, 'ONLINE');
        if (!alive) return;
        /*
         * ★ 只有**成功**才更新 presence / presenceAt。失败时保持上一次的结论 ——
         *   否则一次网络抖动就会把"离线"错说成"未知"（反过来也是编）。
         *   ★ `rows === null` 是 304：服务端说没变 ⇒ 沿用本地那份。
         */
        const patch: Partial<typeof state.friends> = { presenceAt: Date.now() };
        if (rows) {
          const map: Record<string, PresenceStatus | null> = {};
          for (const p of rows) map[p.profileId.toLowerCase()] = p.status ?? null;
          patch.presence = map;
        }
        dispatch({ type: 'friends/patch', patch });
      } catch {
        /* 心跳失败不弹东西（见上），也不动上一次的结论 */
      }
    };
    void beat();
    /* ★ 间隔按"好友页开着没有"切：30 秒 / 90 秒（见 domain/friends.ts 那段说明） */
    const timer = window.setInterval(() => void beat(), presenceBeatIntervalMs(state.friends.pageOpen));
    const goodbye = () => {
      void friendsApi.presence(friendsUuid, 'OFFLINE').catch(() => []);
    };
    window.addEventListener('beforeunload', goodbye);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', goodbye);
      goodbye();
    };
  }, [state.ready, friendsUuid, state.friends.pageOpen]);

  /** 拿到账号就把好友设置也读一次（页面显示"谁能加我"要用它） */
  useEffect(() => {
    if (!state.ready || !friendsUuid) return;
    void loadFriendSettings();
  }, [state.ready, friendsUuid, loadFriendSettings]);

  /*
   * ★★ 启动时**取一次名单**（2026-10-12 补）。
   *
   *   原来只在"点刷新"或"做完一个动作之后"才取 —— 于是刚进好友页是
   *   「正在取名单…」，看着像坏了（真机验证时就是这么发现的）。
   *   名单是这一页的主体，账号一就绪就该拿来。
   *
   *   ★ 之后靠心跳维持"状态"那一栏；名单本身不轮询（好友变化很少，
   *     用户也能点刷新）。真要做实时推送就得接那个信令 WS ——
   *     那是另一档功能（见 friends.rs 头部对 wss://signaling-afd… 的说明）。
   */
  useEffect(() => {
    if (!state.ready || !friendsUuid) return;
    void refreshFriends();
  }, [state.ready, friendsUuid, refreshFriends]);

  /*
   * ★★★★ **名单的按需轮询**（2026-10-12，用户给的设计图）。
   *
   *   设计图：好友列表**打开时每分钟**、**没打开时每 5 分钟**检查一次更新 ——
   *   平衡实时性与性能。间隔常量与规则在 `domain/friends.ts`
   *   （`friendsPollIntervalMs`，那边有用例钉着 60s / 300s）。
   *
   *   ★ 真正省流量的是 ETag：每次检查都带 `If-None-Match`，没变就是一次 304
   *     空响应（见 `friends.rs` 的说明）。轮询频率与 ETag 是**配套**的两件事：
   *     只有 ETag 而没有频率控制 = 每分钟白下一次名单；
   *     只有频率控制而没有 ETag = 每次检查都要下整份。
   */
  useEffect(() => {
    if (!state.ready || !friendsUuid) return;
    const ms = friendsPollIntervalMs(state.friends.pageOpen);
    const timer = window.setInterval(() => void refreshFriends(), ms);
    return () => window.clearInterval(timer);
  }, [state.ready, friendsUuid, state.friends.pageOpen, refreshFriends]);

  /** 好友页挂载/卸载时告诉上下文"这一页开着"（轮询频率按它切） */
  const setFriendsPageOpen = useCallback((open: boolean): void => {
    dispatch({ type: 'friends/patch', patch: { pageOpen: open } });
  }, []);

  /**
   * 创建一个副本。
   *
   * ★ 审计发现：以前只克隆实例记录，**目录从来没建过** ——
   *   副本指向 `instances/<slug>-copy/`，而那个目录不存在，
   *   于是它是一个"没有存档、没有 Mod、没有配置"的空壳，
   *   而界面写着"配置照搬一份"。
   *   现在真的复制目录（natives 跳过：启动时按当前架构重新解压）。
   *
   * ★★ 2026-09-30：目录名现在**就是版本目录名**（`.minecraft/versions/<名字>/`），
   *   所以副本的名字也必须过一遍规范（`sanitizeDirName`）——
   *   原 slug 里可能有 Windows 不认的字符（用户自建版本时能写出来），
   *   不过一遍就会建不出目录，而用户看到的只是"复制失败"。
   *
   * 返回复制的字节数；失败时抛出（调用方要如实告诉用户）。
   */
  const duplicateInstance = useCallback(
    async (id: string): Promise<number> => {
      const src = instancesRef.current.find((i) => i.id === id);
      if (!src) throw new Error('找不到要复制的实例');
      // slug 必须全局唯一，否则两个实例会共用同一个目录
      const takenSlugs = instancesRef.current.map((i) => i.config.slug);
      const baseSlug = `${sanitizeDirName(src.config.slug) ?? 'copy'}-copy`;
      const slug = uniqueDirName(baseSlug, takenSlugs);
      // 显示名也要唯一
      const takenNames = new Set(instancesRef.current.map((i) => i.config.name));
      let name = `${src.config.name} 副本`;
      for (let n = 2; takenNames.has(name); n++) name = `${src.config.name} 副本 ${n}`;

      const copy: Instance = {
        ...src,
        id: `${src.id}-copy-${Date.now().toString(36)}`,
        config: { ...src.config, name, slug },
        createdAt: new Date().toISOString(),
        lastPlayedAt: null,
        totalPlaySeconds: 0,
      };

      // 先复制目录再登记：目录建不起来就不该出现一个空壳副本
      const bytes = await backend.copyInstanceFiles(src.config.slug, slug, true);
      // ★ 副本的 slug 也可能撞上一个老墓碑（`<原名>-copy` 删过又再复制一次）
      await unburyBeforeLedgerWrite([slug]);
      dispatch({ type: 'instances/add', instance: copy });
      await backend.saveInstances([...instancesRef.current, copy], copy.id);
      return bytes ?? 0;
    },
    [backend, unburyBeforeLedgerWrite],
  );

  const rescanJava = useCallback(async () => {
    dispatch({ type: 'java/scanning', scanning: true });
    try {
      const list = await backend.scanJava();
      dispatch({ type: 'java/set', runtimes: list });
    } catch (e) {
      /*
       * ★ 审计发现：这里没有 catch/finally —— 一旦 scanJava 抛异常，
       *   `scanning` 会**永远是 true**，设置页那个"重新扫描"按钮
       *   从此一直转圈、点不动，只能重启应用。
       *   现在无论成败都收尾，并把失败说出来。
       */
      dispatch({ type: 'java/scanning', scanning: false });
      window.dispatchEvent(
        new CustomEvent('ieml:toast', {
          detail: {
            kind: 'err',
            title: '扫描 Java 失败',
            desc: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
  }, [backend]);

  const refreshJava = useCallback((list: JavaRuntime[]) => {
    dispatch({ type: 'java/set', runtimes: list });
  }, []);

  const upsertTask = useCallback((task: TaskItem) => {
    dispatch({ type: 'task/add', task });
  }, []);

  const patchTask = useCallback((id: string, patch: Partial<TaskItem>) => {
    dispatch({ type: 'task/patch', id, patch });
  }, []);

  const setMods = useCallback(
    (entries: ModEntry[], states: Map<string, ModStateResult['state']>) => {
      dispatch({ type: 'mods/set', entries, states });
    },
    [],
  );
  const setModFilter = useCallback(
    (f: ModFilter) => dispatch({ type: 'mods/filter', filter: f }),
    [],
  );
  const setModQuery = useCallback((q: string) => dispatch({ type: 'mods/query', query: q }), []);
  const toggleModSelect = useCallback(
    (path: string) => dispatch({ type: 'mods/toggle-select', path }),
    [],
  );
  const clearModSelect = useCallback(() => dispatch({ type: 'mods/clear-select' }), []);
  const toggleModEnabled = useCallback(
    (path: string) => dispatch({ type: 'mods/toggle-enabled', path }),
    [],
  );

  /* ★★ 启动器自身的更新：**只挂这一次**（顶栏角标与设置页共用这一份状态） */
  const update = useLauncherUpdate();

  /**
   * ★★ 2026-09-25（用户：「我不想要重启才生效，切换游戏数据应该是实时的」）：
   *   换完游戏根目录之后**当场刷新所有从它派生的东西**。
   *
   *   为什么要一个专门的函数、而不是让调用方各自去刷：**"哪些东西是从根目录派生的"
   *   只能有一个答案**（漏一样，就会留下"界面还显示旧根目录"的角落）。这里是那份清单：
   *     · 机器信息（`machine.dataDir` —— 设置页 / 关于页 / 启动页显示的就是它）
   *     · 实例清单（`instances.json` 住在启动器自己的家里，但实例**目录**在新根下，
   *       所以条目要重新按新根算一遍）
   *     · 「用过的游戏文件夹」列表（刚换过去的那一条要出现在里面）
   *     · Java 列表（`rescanJava` 顺手把"这个版本要哪个 Java"重算一遍，很便宜）
   *
   *   ★ 不做的事：**不重启、也不刷新页面** —— 刷页面会把用户的界面状态
   *     （当前页、滚动位置、弹窗）全丢掉，而这次切换只是一次数据源替换。
   */
  const reloadAfterRootChange = useCallback(async () => {
    const say = (kind: 'ok' | 'warning' | 'err', title: string, desc?: string) =>
      window.dispatchEvent(new CustomEvent('ieml:toast', { detail: { kind, title, desc } }));
    try {
      const [machine, instances] = await Promise.all([
        backend.machineInfo(),
        backend.loadInstances(),
      ]);
      dispatch({ type: 'machine/set', machine });
      dispatch({ type: 'instances/refresh', instances: instances.instances });
      /*
       * ★★ 2026-09-25（用户截图：换目录之后弹了两条提示）：
       *   「下面的文字只保留『已切换游戏根目录』，文字改成『游戏根目录已切换』」
       *   ⇒ 标题改成一句干净的陈述，副标题去掉（"版本列表、启动、装 Mod 都按新目录走"
       *     这件事，进那一页就看得见，不必在提示里再说一遍）。
       */
      say('ok', '游戏根目录已切换');
    } catch (e) {
      say('warning', '切换后刷新失败', e instanceof Error ? e.message : String(e));
      return;
    }
    /* ★ 「当前文件夹里有哪些版本」也要重读 —— 版本列表与启动页都看这一份（2026-09-25） */
    void reloadFolderVersions();
    void rescanJava();
  }, [backend, rescanJava, reloadFolderVersions]);

  const value: AppContextValue = {
    state,
    backend,
    go,
    openVersion,
    closeVersion,
    setSubPage,
    setDownloadTab,
    goDownloadTab,
    goDownloadFor,
    setDownloadTarget,
    setTheme,
    target,
    open,
    setLaunchTarget,
    // ★★ C5：资源独立安装页的两个开关
    openResource,
    closeResource,
    createInstance,
    updateConfig,
    removeInstance,
    buryVersion,
    renameInstance,
    setFavorite,
    refreshFriends,
    addFriendByName,
    removeFriend,
    acceptFriend,
    declineFriend,
    revokeFriendRequest,
    loadFriendSettings,
    saveFriendSettings,
    setFriendNote,
    setFriendsPageOpen,
    duplicateInstance,
    rescanJava,
    refreshJava,
    reloadAfterRootChange,
    refreshInstances,
    refreshIsolation,
    refreshMachine,
    folder: {
      versions: folderVers,
      instancesInFolder: folderMatch.instances,
      versionsWithoutInstance: folderMatch.withoutInstance,
      versionCount,
      reload: reloadFolderVersions,
    },
    prefsSaveFailed,
    update,
    packIcons,
    launch: {
      starting: launchStarting,
      setStarting: setLaunchStarting,
      progress: launchProgress,
      setProgress: setLaunchProgress,
    },
    vfx: {
      level: vfxLevel,
      want: vfxWant,
      clamped: vfxClamped,
      why: vfxWhy,
      capability: vfxCap,
      choose: chooseVfx,
    },
    toast,
    dismissToast,
    upsertTask,
    patchTask,
    setMods,
    setModFilter,
    setModQuery,
    toggleModSelect,
    clearModSelect,
    toggleModEnabled,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp 必须在 AppProvider 内使用');
  return v;
}

export function useIsForgeLike(): boolean {
  const { target } = useApp();
  return isForgeLike(target);
}
