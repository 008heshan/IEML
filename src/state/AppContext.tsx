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
import { MC_PROFILES } from '../domain/loader-caps.ts';
import type { ModEntry, ModFilter, ModStateResult } from '../domain/mods.ts';
// ★ 输入校验只有一份规则（与 Rust 侧逐条一致，见 domain/validate.rs）
import { instanceNameRules, validate } from '../domain/validate.ts';
import { getBackend } from '../bridge';
import type { Backend } from '../bridge';
import { MOTION_KEY, setMotion } from '../ui/motion';
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
}
import {
  initialState,
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
const TOAST_EXIT_MS = 200;

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
  str('downloadSource', ['bmclapi', 'mojang']);
  str('modSource', ['modrinth', 'both']);
  num('globalMemoryMb', 512, 262144);
  num('concurrentDownloads', 1, 512);
  num('windowWidth', 320, 7680);
  num('windowHeight', 240, 4320);
  bool('particleEffects');
  bool('reducedMotion');
  if (typeof r.offlineUsername === 'string' && r.offlineUsername.trim()) {
    out.offlineUsername = r.offlineUsername.trim().slice(0, 32);
  }
  // 账号 uuid：只有形态合法才认（挡住手改出来的垃圾值）
  if (typeof r.accountUuid === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(r.accountUuid)) {
    out.accountUuid = r.accountUuid;
  }
  if (typeof r.globalJvmArgs === 'string') out.globalJvmArgs = r.globalJvmArgs;
  if (typeof r.globalGameArgs === 'string') out.globalGameArgs = r.globalGameArgs;
  return out;
}

interface AppContextValue {  state: AppState;
  backend: Backend;

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
  /** ★★ C5：进资源的**独立安装页**（`kind` 决定装到哪个目录） */
  openResource: (hit: unknown, kind: string) => void;
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
  duplicateInstance: (id: string) => Promise<number>;

  /* --- Java --- */
  rescanJava: () => Promise<void>;
  refreshJava: (list: JavaRuntime[]) => void;

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
  const vfxDowngradedByLowPerf = lowPerf && vfxDecision.level === 'aura';
  /** 实际生效的档位（能力校正 + 低性能模式压制之后的那一个） */
  const vfxLevel: VfxLevel = vfxDowngradedByLowPerf ? 'mid' : vfxDecision.level;
  const vfxClamped = vfxDecision.clamped || vfxDowngradedByLowPerf;
  const vfxWhy = vfxDowngradedByLowPerf
    ? '低性能损耗模式开着，灵动视效被压到「适中」（关掉它就能回来）'
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
      const [machineR, instR, javaR, prefsR, infoR, runningR] = await Promise.allSettled([
        backend.machineInfo(),
        backend.loadInstances(),
        backend.scanJava(),
        backend.loadPrefs(),
        /*
         * ★ 后端版本号（`app_info`）。拿不到不影响启动 —— 它只用于「关于」显示。
         *   单独一条 promise 是为了不让它拖垮整次 boot（与上面同一条纪律：
         *   每条给一个安全的兜底值）。
         */
        backend.info(),
        /*
         * ★★ 多开实例：把"现在有哪些在跑"从**后端**捡回来。
         *
         *   为什么必须问后端、而不是信任本地状态：界面的状态是攒出来的，
         *   而它可能被重新加载（WebView 刷新、以后的"重开界面"）——
         *   那一刻本地表是空的、而后端的进程还活着。不问的话界面会说
         *   "没有游戏在运行"，用户再点启动，游戏又开一份（同一个存档被两个进程写）。
         *   后端那张表是**唯一**知道真相的地方（它手里有子进程句柄）。
         */
        backend.runningGames(),
      ]);

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
      const java = javaR.status === 'fulfilled' ? javaR.value : [];
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
              message: `${why} —— 这一页现在是空的，但**磁盘上的记录没有被清掉**。修好后重启即可。`,
              sticky: true,
            },
          }),
        );
      }
      if (javaR.status === 'rejected') {
        console.error('[IEML] Java 扫描失败：', javaR.reason);
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
        java,
        lastInstanceId: inst.activeId ?? null,
        prefs: restored,
        ...(isThemeId(savedTheme) ? { theme: savedTheme } : {}),
      });

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
      // 主题和偏好一起存（主题是顶层字段，但用户当然希望它记住）
      const payload = { ...state.prefs, theme: state.theme } as unknown as Record<string, unknown>;
      /*
       * ★★ 视效档位也要落到 `prefs.json`（2026-09-22）。
       *
       *   为什么不能只留 localStorage：**Rust 侧要在创建 WebView2 之前读它** ——
       *   "灵动档用独显渲染"这件事（`--force_high_performance_gpu`）是启动期的
       *   一次性决定（GPU 适配器在 WebView2 起来时就选定了，跑起来改不了）。
       *   而 localStorage 在 WebView2 的 profile 里，Rust 启动时读不到。
       *   所以这里多写一份到 prefs.json，给 `lib.rs::request_high_performance_gpu` 看。
       */
      payload.vfx = vfxWant;
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

  const setLaunchTarget = useCallback((id: string | null) => {
    dispatch({ type: 'instances/last', id });
  }, []);

  /**
   * ★★ 2026-09-23（C5）：打开资源的独立安装页。
   *
   *   `hit` 与 `kind` 一起放进 state —— 切页之后列表组件会卸载，
   *   目标必须活在页面之外（与 `setLaunchTarget` 上面那条教训同一个道理）。
   */
  const openResource = useCallback((hit: unknown, kind: string) => {
    dispatch({ type: 'resource/open', hit, kind });
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

  const createInstance = useCallback(
    async (inst: Instance) => {
      dispatch({ type: 'instances/add', instance: inst });
      dispatch({ type: 'instances/last', id: inst.id });
      const next = [...instancesRef.current, inst];
      await backend.saveInstances(next, inst.id);
    },
    [backend],
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
   * 返回删掉的字节数（0 = 目录本来就不存在）。
   */
  const removeInstance = useCallback(
    async (id: string, permanent = false): Promise<number> => {
      const inst = instancesRef.current.find((i) => i.id === id);
      dispatch({ type: 'instances/remove', id });
      if (!inst) return 0;
      try {
        const bytes = await backend.deleteInstanceFiles(inst.config.slug, permanent);
        return bytes ?? 0;
      } catch (e) {
        // 记录已经删了（内存里），但磁盘没删干净 —— 必须说出来
        throw new Error(
          `实例记录已从列表移除，但磁盘目录没删掉：${
            e instanceof Error ? e.message : String(e)
          }（目录：instances/${inst.config.slug}/）`,
        );
      }
    },
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
   * 创建一个副本。
   *
   * ★ 审计发现：以前只克隆实例记录，**目录从来没建过** ——
   *   副本指向 `instances/<slug>-copy/`，而那个目录不存在，
   *   于是它是一个"没有存档、没有 Mod、没有配置"的空壳，
   *   而界面写着"配置照搬一份"。
   *   现在真的复制目录（natives 跳过：启动时按当前架构重新解压）。
   *
   * 返回复制的字节数；失败时抛出（调用方要如实告诉用户）。
   */
  const duplicateInstance = useCallback(
    async (id: string): Promise<number> => {
      const src = instancesRef.current.find((i) => i.id === id);
      if (!src) throw new Error('找不到要复制的实例');
      // slug 必须全局唯一，否则两个实例会共用同一个目录
      const takenSlugs = new Set(instancesRef.current.map((i) => i.config.slug));
      const baseSlug = `${src.config.slug}-copy`;
      let slug = baseSlug;
      for (let n = 2; takenSlugs.has(slug); n++) slug = `${baseSlug}-${n}`;
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
      dispatch({ type: 'instances/add', instance: copy });
      await backend.saveInstances([...instancesRef.current, copy], copy.id);
      return bytes ?? 0;
    },
    [backend],
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
    renameInstance,
    duplicateInstance,
    rescanJava,
    refreshJava,
    prefsSaveFailed,
    update,
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
