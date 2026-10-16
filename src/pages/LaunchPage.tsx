/**
 * 启动页（一级）
 * ------------------------------------------------------------------
 * 参照 PCL2 主界面：**一屏只有一个启动按钮 + 一颗版本下拉 + 一行状态**。
 *
 * 但保留了原设计稿的一个优点：**点启动前要知道会发生什么**。
 * 所以按钮旁边有「预览命令」，点开能看到真实会执行的命令行（已脱敏）。
 *
 * ★★ 0.1.0-beta.1：用户对这一页的评价是「主页面太简单，简单到感觉像我们不会
 *   做软件，留着大片空区不要，简直浪费」。所以补了三块**真数据**：
 *
 *     ① 选中版本的**身份卡**（图标 / MC 版本 / 加载器 / 内存 / Java / 累计时长）
 *        + 四个直达动作（打开目录 · 日志 · Mod 管理 · 版本设置）
 *     ② **其它版本**一格：点一下换启动目标（不用去翻下拉）
 *     ③ **本机状态**一行：可用内存 / CPU / 探测到的 Java / 数据目录
 *
 *   三条仍然是"不做"的（并说明为什么）：
 *     * 不做新闻/公告栏 —— 没有真实内容可放，编一条就是假信息
 *     * 不做游戏封面大图 —— Mojang 的美术资源不能随启动器分发（README 许可）
 *     * 不做"我的实例"大网格 —— 版本列表页已经在做这件事，这里只放一屏够用的
 */
import { useEffect, useMemo, useState, useRef } from 'react';
import { useApp } from '../state/AppContext';
import { isInstanceRunning, runningInfo, runningCount } from '../state/store';
import { Button, EmptyState, Modal, Note, SearchBox, Spinner } from '../ui';
import { instanceTitle } from '../state/instance-name';
import { pickerPlan } from '../domain/launch-picker';
import { PackIcon } from '../components/PackIcon';
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconCpu,
  IconDrive,
  IconFolder,
  IconGear,
  IconGrid,
  IconJava,
  IconPlay,
  IconPuzzle,
  IconRam,
  IconStop,
  IconTerminal,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { VersionIcon } from '../components/VersionIcon';
import { launchFailureOf, type LaunchPreview, type LaunchRequest } from '../bridge/tauri';

export function LaunchPage() {
  const {
    state,
    /* ★ 2026-09-30：全局那个 `target` 只当"记忆值"用，真正生效的是下面算出来的 `target` */
    target: rememberedTarget,
    go,
    goDownloadTab,
    backend,
    toast,
    setLaunchTarget,
    openVersion,
    folder,
    refreshMachine,
    launch: launchState,
    packIcons,
  } = useApp();
  const { api, isDesktop } = useRealApi();

  /**
   * ★★★★ 2026-09-30（用户）：「**每次重启都得重新选，而不是记住玩家的选择**」。
   *
   *   根因是**两把尺子**（和前面那个"版本数"是同一种毛病）：
   *     · 下拉列的 `launchable` = **当前文件夹里对得上的实例**；
   *     · 而 `target` 来自全局 `selectLaunchTarget(state)` = **账本里最后一个实例**。
   *
   *   真机上的形状（用户截图）：当前文件夹是 `D:\IEML`（根目录），
   *   里面只有 `26.3-fabric-0.19.5` 那两个；而记忆值指向 `Sodium Plus`
   *   （它在 `26.2` 那个文件夹里，换个目录才看得见）。
   *   ⇒ 下拉的 `value` 在选项里找不到 → 显示回「请选择」。
   *   **玩家的选择没丢，只是当前文件夹里没有它** —— 而界面看起来就像"忘了"。
   *
   *   ⇒ 判据收成一条：**记忆值必须在当前可启动列表里**，否则退回列表第一个。
   *     并且**把纠正后的结果写回去**（`setLaunchTarget`）—— 不写回去的话，
   *     下一次重启还会拿那个不在本文件夹的记忆值重演一遍。
   *
   *   ★ 为什么"退回第一个"是对的（而不是留着空）：这一页的用途就是"启动一个版本"，
   *     留空 = 玩家必须先做一次选择才能用。而列表第一个是**盘上真实存在**的版本，
   *     选它永远不会启动失败。玩过的版本仍会排在前面（`others` 的排序用的就是它）。
   */
  const target = useMemo(() => {
    const list = folder.instancesInFolder;
    if (list.length === 0) return rememberedTarget;
    const inFolder = rememberedTarget
      ? list.find((i) => i.id === rememberedTarget.id)
      : undefined;
    return inFolder ?? list[0] ?? null;
  }, [folder.instancesInFolder, rememberedTarget]);

  /*
   * 把纠正后的选择**写回**（记忆值不在本文件夹时）。只在真需要改的时候 dispatch，
   * 所以不会因为 `target` 每次渲染都是新对象而反复写盘。
   */
  useEffect(() => {
    if (!target) return;
    if (rememberedTarget?.id === target.id) return;
    setLaunchTarget(target.id);
  }, [target, rememberedTarget, setLaunchTarget]);

  /** 要启动的那个实例的隔离判定（后端算的结论，ADR-005；读不到时 null） */
  const launchIsolation = target ? state.isolation[target.config.slug] ?? null : null;

  /**
   * ★★ **可用内存是活的**（2026-09-28）。
   *
   *   这一页写着"可用 12 GB"，而那是**启动那一刻**的读数 —— 用户开个浏览器、
   *   开个视频，半小时后回来照这个数选内存，游戏就起不来（或者被系统换页拖死）。
   *
   *   所以只要这一页**挂在屏幕上**，就按节奏重读：
   *     · 进页面立刻读一次（可能在别处待了很久才回来）；
   *     · 之后每 15 秒一次；
   *     · 离开这一页（组件卸载）就停 —— 别的页面不显示这个数，白读。
   *
   *   ★ 15 秒是**权衡**：sysinfo 那次读盘本身很便宜，但"每秒一次"对一个
   *     只是显示数字的界面来说是浪费；而人做决定的时间尺度是"十几秒"。
   */
  useEffect(() => {
    void refreshMachine();
    const t = window.setInterval(() => void refreshMachine(), 15000);
    return () => window.clearInterval(t);
  }, [refreshMachine]);

  const [launching, setLaunching] = [launchState.starting, launchState.setStarting] as const;
  /**
   * ★★ 启动前的准备进度：**从全局取**（不是本页状态）。
   *
   *   理由与 `launching` 一样（见 AppContext 里那段说明）：切走页面时这一页会卸载，
   *   本页状态归零 —— 而"正在补齐什么文件"这件事**不随页面存活**。
   */
  const launchProgress = launchState.progress;
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 命令还在拼（窗口已经开了，先显示"正在拼装…"） */
  const [previewLoading, setPreviewLoading] = useState(false);
  /**
   * 按请求缓存拼装结果 —— 同一个版本 / 内存 / Java 再点一次应当**瞬开**。
   * 键就是请求本身的 JSON（纯数据，没有函数或循环引用）。
   */
  const previewCache = useRef(new Map<string, LaunchPreview>());
  /**
   * ★★ 缺 Java 的引导（P0-7）：**由后端给的结构化字段驱动**。
   *
   *   `range` 是后端算出来的要求区间原文（如 `[25, )`）——
   *   界面不再自己写一句"1.20.5 及以上需要 Java 21…"（那是第二套规则，
   *   而且 26.2 这种两位数版本号它一定会说错）。
   */
  const [javaMissing, setJavaMissing] = useState<{ major: number; range: string | null } | null>(
    null,
  );
  const [downloadingJava, setDownloadingJava] = useState(false);
  const [, tick] = useState(0);

  /*
   * ★★ 多开实例（2026-09-15）：运行态是**按实例**查的。
   *   以前这里写 `running?.instanceId === target.id` —— 一个槽，非此即彼。
   *   现在判据只有一份（`isInstanceRunning`），全界面都从它取结论。
   */
  const isRunning = isInstanceRunning(state, target?.id);
  const runInfo = runningInfo(state, target?.id);

  /* 运行时长每秒刷新 */
  useEffect(() => {
    if (!isRunning) return; // 在跑的时候才需要每秒重画
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  /*
   * 监听启动前的自愈进度（见上面 `launchProgress` 的说明）。
   *
   * ★ 只认**当前这个版本**的事件（`taskId` 就是 instance_id）：
   *   多开时两个版本可能同时在准备，混着显示会让人以为进度倒退了。
   * ★ 监听**一直挂着**（不只在 `launching` 为真时）：
   *   预览那条路也会跑准备流程，而且事件可能比 `setLaunching(true)` 先到。
   */
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{
        taskId: string;
        stage: string;
        finishedFiles: number;
        totalFiles: number;
        percent: number;
        currentFile: string;
      }>('launch-progress', (ev) => {
        const p = ev.payload;
        if (target && p.taskId && p.taskId !== target.id) return;
        launchState.setProgress({
          stage: p.stage,
          finished: p.finishedFiles,
          total: p.totalFiles,
          percent: p.percent,
          current: p.currentFile,
        });
      });
    })();
    return () => unlisten?.();
  }, [target, launchState]);

  /*
   * ★★ 2026-09-24（A-1 修复）：这里的 `ieml:launch-request` 监听器**搬走了** ——
   *   搬到 `AppShell`（常驻层）。原因：它原先只在本页挂载时注册，
   *   而版本列表行 / 概览页 / 实例侧栏那三个「启动」按钮都在 `versions` 页里
   *   dispatch 这个事件 —— 于是**点了什么都不发生**（真机判据：
   *   那一页 `getEventListeners(window)['ieml:launch-request'].length === 0`）。
   *   ★ 这里**不要再加回来**：两处都监听会启动两次。
   */

  const req = useMemo<LaunchRequest | null>(() => {
    if (!target) return null;
    return {
      mc_version: target.mcVersion,
      loader_kind: target.loader?.kind ?? null,
      loader_version: target.loader?.version ?? null,
      username: state.prefs.offlineUsername || 'Player',
      account_uuid: state.prefs.accountUuid ?? null,
      memory_mb: target.config.memoryMb,
      width: state.prefs.windowWidth,
      height: state.prefs.windowHeight,
      instance_slug: target.config.slug,
      // ★ 多开实例：后端按 **id** 认"谁在跑"（slug 是可改的目录名）
      instance_id: target.id,
      extra_jvm_args: target.config.jvmArgs
        ? target.config.jvmArgs.split(/\s+/).filter(Boolean)
        : [],
      extra_game_args: target.config.gameArgs
        ? target.config.gameArgs.split(/\s+/).filter(Boolean)
        : [],
      // ★ 自定义窗口标题：以前前端不传、后端也不读，功能等于不存在
      window_title: target.config.windowTitle ?? null,
      /*
       * ★ 启动后自动进服（PCL2 的实例设置里有这一项）。
       *
       *   这里传的是**用户输入的原样**，清洗（全角→半角等）由 Rust 侧
       *   统一做 —— 规则只有一份（ADR-001），前端不维护第二套解析。
       */
      join_server: target.config.joinServer ?? null,
      /*
       * ★★ 2026-09-26（A-2）：**附加组件也要传给启动侧**。
       *
       *   "纯原版 + OptiFine"是合法用法（ADR-003），它的产物在
       *   `versions/<mc>-OptiFine_<版本>/`；不传这个字段的话，后端只会去找
       *   `versions/<mc>/`（原版 JSON），于是 OptiFine 装了却完全没生效。
       *
       *   ★ 只传 kind：具体哪一份由后端按**盘上的痕迹**定
       *     （`resolve_addon_version_id`），前端不维护第二套"怎么找版本"的规则。
       */
      addons: target.addons.map((a) => a.kind),
      /*
       * ★ 这里原来还有一个 `java_major` 字段，**已经删掉了**。
       *
       *   他调的是本地的 `neededJavaMajor()`，只取 `split('.')[0]` 当 major，
       *   于是 `26.2` 的 major 是 26 而不是 1 → 落到 `return 8`，
       *   传下去一个**错的兜底值**（用户看到「26.2 需要 Java 8」）。
       *
       *   启动之所以没坏，是因为 Rust 侧以版本 JSON 的 `javaVersion` 为准 ——
       *   但错的兜底值不该存在于接口上。规则只有一处：
       *   Rust 的 `domain::java::resolve_java_requirement`。
       */
    };
  }, [target, state.prefs]);

  /** 预览缓存的键：请求本身的 JSON（见 `previewCache`） */
  const previewKey = useMemo(() => (req ? JSON.stringify(req) : ''), [req]);

  async function launch() {
    if (!target || !req) return;
    if (!api) {
      toast('warning', '当前是演示模式', '浏览器里无法真实启动。请用桌面版（pnpm desktop:dev）。');
      return;
    }
    setLaunching(true);
    // ★ 上一次启动留下的进度不能带进这一次（否则会先显示一个过期的阶段名）
    launchState.setProgress(null);
    setJavaMissing(null);
    try {
      /*
       * ★★ 2026-09-17 用户：「在启动游戏时提前自检Java」。
       *
       *   以前是**先启动、失败了再解释** —— 用户看到的是"点了启动、转一会儿、
       *   报一句缺 Java"。而 `preview_launch` 早就能在**不启动游戏**的前提下
       *   把同一条准备路径（解析 Java、拼 classpath、查文件）跑一遍，
       *   失败时给出同样的结构化错误（`code` / `required_major`）。
       *   这个命令本来就是为"点之前就知道会发生什么"写的，只是从没被接上。
       *
       *   所以现在**先自检、再启动**：Java 不对就原地告诉他该装哪个版本，
       *   连那次必然失败的启动都不发生。
       *
       * ★ 为什么自检失败就**不继续启动**（而不是"失败了也照样试一次"）：
       *   `preview_launch` 与 `launch_minecraft` 调的是**同一个** `prepare_spec`
       *   （见 Rust 侧那两个命令）。自检过不去的，启动一定也过不去 ——
       *   再试一次只会把同一句话晚几秒再说一遍。
       */
      try {
        await api.launcher.preview(req);
      } catch (e) {
        const pre = launchFailureOf(e);
        if (pre?.code === 'java-missing' && pre.requiredMajor !== null) {
          setJavaMissing({ major: pre.requiredMajor, range: pre.requiredRange });
          toast('warning', `这个版本要求 Java ${pre.requiredMajor}`, pre.message);
        } else {
          toast('err', '启动前自检没通过', pre?.message ?? (e instanceof Error ? e.message : String(e)));
        }
        return;
      }

      const r = await api.launcher.launch(req);
      window.dispatchEvent(
        new CustomEvent('ieml:started', { detail: { id: target.id, pid: r.pid } }),
      );
      toast('ok', '游戏已启动', `${r.summary} · PID ${r.pid}`);
      /*
       * ★★ 账号告警必须**弹出来**，不能只写日志。
       *
       *   Rust 侧在"正版令牌过期、refresh_token 续期又失败"时会退回离线身份
       *   启动（单机不受影响）。但用户拿着离线身份去连正版服务器只会被拒 ——
       *   必须现在告诉他，而不是等他在服务器上看到一句看不懂的验证失败。
       *
       *   `sticky`：这条信息重要，不该几秒后自己消失。
       */
      if (r.notice) {
        toast('warning', '这次用的是离线身份', r.notice);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /*
       * ★★ **结构化字段驱动引导**（P0-7）。
       *
       *   以前这里是从报错文案里抠数字：
       *   ```ts
       *   const need = /Java (\d+)/.exec(msg);
       *   if (need) setJavaMissing(Number(need[1]));
       *   ```
       *   抠散文的代价：后端文案一改，按钮就消失；文案里多一个数字
       *   （比如示例中的 `Java 24`），抠出来的就是**另一个** Java 版本，
       *   于是界面会张罗着给用户装一个装错的运行环境。
       *
       *   现在只认后端给的 `code` 与 `required_major` ——
       *   拿不到就不显示引导（比显示一个错的数字好）。
       */
      const failure = launchFailureOf(e);
      if (failure?.code === 'java-missing' && failure.requiredMajor !== null) {
        setJavaMissing({ major: failure.requiredMajor, range: failure.requiredRange });
      }
      toast('err', '启动失败', msg);
    } finally {
      setLaunching(false);
    }
  }

  async function stop() {
    /*
     * ★★ 多开实例：**停的是当前选中的那个**。
     *   以前这里不带参数（只有一个能停）；现在必须点名 ——
     *   否则用户在"启动页"选了 B、却把在跑的 A 停掉。
     */
    const stopId = target?.id;
    if (!stopId) return;
    if (!api) {
      window.dispatchEvent(new CustomEvent('ieml:stop-request', { detail: { instanceId: stopId } }));
      return;
    }
    try {
      const info = await api.launcher.stop(stopId);
      window.dispatchEvent(new CustomEvent('ieml:stop-request', { detail: { instanceId: stopId } }));
      if (info) {
        const mins = Math.max(1, Math.round(info.played_seconds / 60));
        if (info.crashed && info.crash_reason) {
          toast('err', '游戏异常退出', info.crash_reason);
        } else {
          toast('info', '游戏已停止', `本次运行 ${mins} 分钟`);
        }
      }
    } catch (e) {
      toast('err', '停止失败', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * ★★ 2026-09-25（用户：「主页也有同样问题」）：
   *
   *   **启动页也按当前文件夹说话** —— 能启动的只有"版本确实在这个文件夹里"的那些
   *   （名单来自 `AppContext` 的 `folder.instancesInFolder`，与版本列表同一份规则）。
   *   以前这里列的是**账本里的全部实例**，所以换到空文件夹之后，
   *   主页仍然摆着三个"能启动"的版本 —— 点下去只会报"找不到版本文件"。
   *
   *   ★ 读不到文件夹时 `instancesInFolder` **不筛**（读不到 ≠ 没有），
   *     与版本列表的兜底完全一致。
   */
  const launchable = folder.instancesInFolder;

  /**
   * 其它版本（除了当前选中的）—— "一眼换目标"用。
   * 排序：最近玩过的在前；没玩过的按建立时间倒序。
   */
  const others = useMemo(
    () =>
      launchable
        .filter((i) => i.id !== target?.id)
        .sort((a, b) => {
          const at = a.lastPlayedAt ?? '';
          const bt = b.lastPlayedAt ?? '';
          if (at && bt) return bt.localeCompare(at);
          if (at) return -1;
          if (bt) return 1;
          return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
        }),
    [launchable, target?.id],
  );

  /* ====================== 版本选择器（2026-10-16 用户选 A+） ======================
   *
   * 用户：「我想替换掉主页的下拉选单，请给我一个合适的整改方式」→ 看过草案后选了
   * **A+：卡片排 + 「全部版本」入口**。
   *
   * ## 为什么要换掉下拉（不只是"换个样子"）
   *
   *   ① **同一个决定本来就有两套入口**：下拉列 `launchable`，下面「其它版本」列
   *      `others`（＝ `launchable` 去掉当前项）—— 一屏里把同一批版本列了两遍。
   *   ② **信息更全的反而是卡片**（图标 + 名字 + MC版本·加载器），而下拉只有一行文字。
   *   ③ 下拉还有一个**说不出话的状态**：记忆里的目标在**别的目录**里时，
   *      `value` 不在 `options` 里 → 显示成「请选择」（真机案例记在文件头）。
   *      卡片排没有这个隐藏态：**选中的那张永远在列表里**。
   *
   * ## 规则
   *
   *   · 当前目标**固定第一张**，其余按"最近玩过在前"（沿用 `others` 的排序）；
   *   · 总数 ≤ 6 全部平铺；> 6 就只平铺前 5 张 + 一张「全部版本…」卡
   *     （点开弹层，可搜索）—— 这是"版本多的人主页不被撑长"的唯一机制；
   *   · 运行中禁用（与原来的下拉一致：跑着的时候换目标没有意义）。
   */
  const pickerList = useMemo(
    () => (target ? [target, ...others.filter((i) => i.id !== target.id)] : others),
    [target, others],
  );
  /*
   * "平铺几张 / 要不要「全部版本…」入口"是一条**规则**，放在 domain 里
   * （`pickerPlan`），由 `tests/launch-picker.test.mjs` 钉住 ——
   * 本机只有 4 个版本，永远走不到折叠那一支，靠手点验不出来。
   */
  const picker = pickerPlan(pickerList.length);
  const pickerShown = picker.hasMore ? pickerList.slice(0, picker.shown) : pickerList;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const pickerFiltered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return pickerList;
    return pickerList.filter((i) =>
      `${instanceTitle(i.config.name, i.mcVersion, i.loader)} ${i.mcVersion} ${i.loader?.kind ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [pickerList, pickerQuery]);

  /* ---------- 空状态：这个文件夹里没有可启动的版本 ---------- */
  if (launchable.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">启动</h1>
          </div>
        </div>
        <EmptyState
          icon={<IconBox />}
          title="还没有可启动的版本"
          desc="先去装一份游戏，装好后它会出现在「版本列表」里。也可以用整合包一键装好一整套。"
          actions={
            <>
              {/* ★ 2026-09-23 晚：安装游戏并回下载页第一格 → 一次派发到位（跳页 + 选页签） */}
              <Button variant="primary" onClick={() => goDownloadTab('game')}>
                <IconBox /> 去安装游戏
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // ★ 一次派发到位（以前 go + 事件两步走，事件在页面挂载前就被丢掉）
                  goDownloadTab('modpack');
                }}
              >
                浏览整合包
              </Button>
            </>
          }
        />
        {/* 即使一个版本都没有，也把本机状态显示出来 —— 用户第一眼就该知道
            这台机器有没有 Java、数据会落在哪 */}
        {state.machine ? (
          <div className="launch-facts">
            <div className="lf-item">
              <IconRam />
              <span className="lf-k">可用内存</span>
              <span className="lf-v mono">
                {state.machine.availableMemoryGb} / {state.machine.totalMemoryGb} GB
              </span>
            </div>
            <div className="lf-item">
              <IconJava />
              <span className="lf-k">Java</span>
              <span className="lf-v mono">
                {state.java.runtimes.length > 0
                  ? state.java.runtimes.map((r) => r.major).join(' / ')
                  : '一个都没探测到'}
              </span>
            </div>
            <div className="lf-item">
              <IconDrive />
              <span className="lf-k">数据目录</span>
              <span className="lf-v mono">
                {state.machine.dataDir}
              </span>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">启动</h1>
        </div>
        <div className="page-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (!api || !req) {
                toast('info', '演示模式', '桌面版才能预览真实命令行');
                return;
              }
              /*
               * ★★ 2026-09-22 修（用户："**图八预览命令这个打开的太慢了**"）。
               *
               *   原来的写法是：
               *     `setPreview(await api.launcher.preview(req)); setPreviewOpen(true);`
               *   —— **先等命令拼完，才打开窗口**。而拼装要解析 Java、读版本 JSON、
               *   组装 classpath，在真机上是**秒级**的，于是"点了一下，半天没反应"。
               *
               *   现在改成**先开窗、再填内容**：窗口立刻出现并显示"正在拼装…"，
               *   命令到了再填进去。慢的还是那一步，但用户**立刻**得到了反馈 ——
               *   这是这一页所有"慢操作"的统一做法。
               *
               *   ★ 顺带**按请求缓存**：同一个版本 / 内存 / Java 再点一次是瞬开
               *     （拼装结果是纯函数性的，没有理由每次重算）。
               */
              setPreviewOpen(true);
              const hit = previewCache.current.get(previewKey);
              if (hit) {
                setPreview(hit);
                setPreviewLoading(false);
                return;
              }
              setPreviewLoading(true);
              try {
                const p = await api.launcher.preview(req);
                previewCache.current.set(previewKey, p);
                setPreview(p);
              } catch (e) {
                setPreviewOpen(false);
                toast('err', '无法拼装启动命令', e instanceof Error ? e.message : String(e));
              } finally {
                setPreviewLoading(false);
              }
            }}
          >
            <IconTerminal /> 预览命令
          </Button>
        </div>
      </div>

      {/* 缺 Java 的引导 —— 给可行动的下一步，不是一句"启动失败" */}
      {javaMissing !== null ? (
        <Note
          tone="warning"
          icon={<IconAlert />}
          title={`这个版本需要 Java ${javaMissing.major}`}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                loading={downloadingJava}
                onClick={async () => {
                  if (!api) return;
                  const major = javaMissing.major;
                  setDownloadingJava(true);
                  try {
                    const path = await api.java.install(major, `java-${major}`);
                    toast('ok', `Java ${major} 已就绪`, path);
                    setJavaMissing(null);
                    const list = await backend.scanJava();
                    window.dispatchEvent(new CustomEvent('ieml:java-refresh', { detail: list }));
                  } catch (e) {
                    toast('err', 'Java 下载失败', e instanceof Error ? e.message : String(e));
                  } finally {
                    setDownloadingJava(false);
                  }
                }}
              >
                <IconJava /> 自动下载
              </Button>
              <Button size="sm" variant="secondary" onClick={() => go('settings')}>
                去设置页指定
              </Button>
            </>
          }
        >
          {/*
            ★ 这句说明**由后端算出的区间**，不是前端写死的表。
              以前这里是「1.20.5 及以上需要 Java 21，1.18 ~ 1.20.4 需要 Java 17，
              1.16.5 及更早需要 Java 8」—— 那是第二套规则，而且对 26.2 这类
              两位数版本号必然说错（真实要求是 Java 25）。
          */}
          {javaMissing.range
            ? `这个版本允许的 Java 区间是 ${javaMissing.range}。`
            : '这个版本对 Java 有明确要求。'}
          本机现有 Java：
          {state.java.runtimes.length > 0
            ? state.java.runtimes.map((r) => r.major).join('、')
            : '（一个都没有）'}
          。
        </Note>
      ) : null}

      {/* ==================== 核心：出击简报板（2026-10-16 重排） ====================
          ★★ 起因：用户「**感觉主页的设计还是不好看**」。量出来的病根不是配色或圆角，
            是**结构**（真机实测）：
              · 主卡 / 面板 / 事实行宽 1036 且左对齐（x=220），
                而选择器 640、启动按钮 268 却**居中** —— 一页两套对齐系统；
              · 间距不成体系（`面板 → 提示条` 那一处是 **0**）；
              · 最重的一块是宽 1036 的卡，真正的主行动只是中间一颗 268 的按钮 ⇒ **没有焦点**；
              · x≈880–1240 与 y≈610 以下长期空着。

          ★★ 按 design-taste-frontend + frontend-design 两遍法得出的计划（写在 CSS 里那节）：
              左栏＝**卡带标签**（大图标 + 名字 + 标签/值规格行 + 安静的动作行）；
              右栏＝**启动轨**（换一个版本 → 大按钮收尾），一条从上到下的动作路径。
            两栏同一个栅格、全部左对齐；材质分权（左卡有浮起，右栏**不套卡**）。

          ★★ 同时删掉三处"一眼 AI"的模板痕迹（frontend-design 点名的）：
              ① 中缀圆点拼的 meta 串（`1.20.4 · Fabric 0.15.7 · OptiFine`）；
              ② 卡片第二行的 `1.21.1 · 原版` 圆点串 ⇒ 改成"名字 + 右对齐标签"；
              ③ `6 GB · Java 自动 · 管理此版本` 整条删掉 —— 内存/Java 归进规格行，
                 而「管理此版本」与「版本设置」是**同一个落点**，
                 按"一个意图只留一个名字"的规矩只保留「版本设置」。
      */}
      <div className="launch-board">
        {/* 左栏：身份卡 + 本机状态。★ 必须包一层 —— 直接并列的话，`
            .launch-facts` 会被栅格自动放进**第二列**（真机踩过：右栏被挤到第二行）。 */}
        <div className="lb-main">
        {/*
          ★★ 0.1.0-beta.1：给选中的版本一块"身份卡"（用户："主页面太简单，
            简单到感觉像我们不会做软件，留着大片空区不要，简直浪费"）。

          卡片里全是**真数据**：版本图标（自绘方块，按世代配色）、名字、
          MC 版本与加载器、磁盘占用、游玩时长。以前这一页只有一颗下拉 +
          一个按钮，下面大片空白。
        */}
        {target ? (
          /* ★ 2026-10-16：挂上 glass —— 这一块原来是平色卡，与全站材质不统一
             （设置页/下载页的卡都是玻璃，主页面最大的一张反而是平色板）。
             ★ 再加 `glass-2`：它是**版面级的大面**（整页的主卡），比普通卡厚一档 ——
               材质分档见 app.css 的「材质分档」一节（新闻卡走同一档）。 */
          <section className="launch-hero glass glass-2" aria-labelledby="lb-name">
            {/*
              ★★ 2026-09-30（用户）：「这两个地方的整合包显示**整合包自己的图标**，
                而且要**直接在卡片上，不整那个跟槽一样的东西**」。

              `packIcons[slug]` 是装包时从包体里抽出来的作者图标（Rust 侧
              `install_pack_plan` 留的）。没有就退回自绘的版本图标 ——
              那本来就是"这个版本没有真图标"时的样子。

              ★ 2026-10-16：尺寸 72 → **96**。这一块现在是整页唯一的"用力点"
                （frontend-design：「把胆子花在一个地方，周围保持安静」），
                大图标 + 大字名字是它的身份，其余信息一律降级成规格行。
            */}
            <PackIcon icon={packIcons[target.config.slug]} version={target.mcVersion} size={96} />
            <div className="lh-main">
              <h2 className="lh-name" id="lb-name">
                {target.config.name}
              </h2>
              {/*
                ★ 2026-10-16：这里原来是**中缀圆点串**（`1.20.4 · Fabric 0.15.7 · OptiFine`
                  外加一颗 Chip）—— frontend-design 把它列成"无论什么主题都会出现的
                  模板痕迹"之一。现在改成**标签/值规格行**：同一批数据从
                  "一句话"变成"一张能扫的表"，也是这块卡该有的样子（它就是一份规格）。
              */}
              <dl className="lb-specs">
                <div className="lb-spec">
                  <dt>MC 版本</dt>
                  <dd className="mono">{target.mcVersion}</dd>
                </div>
                <div className="lb-spec">
                  <dt>加载器</dt>
                  <dd>
                    {target.loader ? (
                      <>
                        {loaderName(target.loader.kind)}
                        {target.loader.version ? ` ${target.loader.version}` : ''}
                      </>
                    ) : (
                      '原版'
                    )}
                  </dd>
                </div>
                {target.addons.length > 0 ? (
                  <div className="lb-spec">
                    <dt>附加</dt>
                    <dd>
                      {target.addons
                        .map((a) => (a.kind === 'optifine' ? 'OptiFine' : 'LiteLoader'))
                        .join('、')}
                    </dd>
                  </div>
                ) : null}
                <div className="lb-spec">
                  <dt>内存</dt>
                  <dd className="mono">{Math.round(target.config.memoryMb / 1024)} GB</dd>
                </div>
                <div className="lb-spec">
                  <dt>Java</dt>
                  {/* ★ 去掉值里那个多余的「Java」——标签已经写着 Java 了（原来显示成 "Java Java 自动"） */}
                  <dd>{javaLabel(target.config.javaMode).replace(/^Java\s*/, '') || '自动'}</dd>
                </div>
                {/*
                  ★★ 2026-09-27（0.7.0）：这一格以前写的是 `isolation !== 'off' ? '已隔离' : ''`——
                    它按**用户选的那个模式**说话，而不是按**最终结论**：
                    选「自动」而全局默认是共享时，启动页会说"已隔离"，游戏其实读共享目录。
                    现在只在**后端判定为隔离**时才说这句（结论来自 `state.isolation`）。
                */}
                {launchIsolation?.isolated ? (
                  <div className="lb-spec">
                    <dt>隔离</dt>
                    <dd>已开启</dd>
                  </div>
                ) : null}
              </dl>
              {/*
                ★★ 2026-10-16：动作从"卡片右侧那一列"挪到**卡片内部左下**。
                  原来它们单独占一列，于是卡片中段（x≈880–1240）长期空着 ——
                  那是"看着空"的一半来源。挪下来之后卡片是一块**完整的简报**：
                  身份在上、规格在中、动作在下，右边不再有空洞。
              */}
              <div className="lh-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const p = await api?.launcher.openFolder(target.config.slug);
                    if (!p) {
                      toast('info', '演示模式', '桌面版才能打开目录');
                      return;
                    }
                    toast('info', '版本目录', p);
                  }}
                >
                  <IconFolder /> 打开目录
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openVersion(target.id, 'logs')}>
                  <IconTerminal /> 日志
                </Button>
                {/*
                  ★ 2026-09-17 用户（截图 图六）：「主页这里，也不给原版 mod 管理的键」。

                    判据用 `target.loader`（真值判断）—— 与同文件 402 行的
                    `target.loader ? loaderName(...) : '原版'` 一致，
                    也与 `ModsPanel.tsx:720/886/891` 那三处「纯原版不能加载 Mod」
                    用的是同一个概念。**不另写一套判据**（ADR-020 的教训：
                    同一件事两处判定，早晚会不一致）。

                    为什么该藏而不是置灰：原版实例**根本没有 mods 能加载**
                    （`ModsPanel` 里那句"纯原版实例不能加载 Mod"就是这个意思）。
                    置灰会让人以为"差一点就能用"，藏起来才是实话。
                */}
                {target.loader ? (
                  <Button variant="ghost" size="sm" onClick={() => openVersion(target.id, 'mods')}>
                    <IconPuzzle /> Mod 管理
                  </Button>
                ) : null}
                {/*
                  ★ 2026-09-17 用户（截图）："主页的管理这个版本改成『管理此版本』，
                    然后直接转到这个版本的设置页，而不是版本列表"。

                  原来它 `go('versions')` —— 把人送去**版本列表**，还得再找到这一行、
                  再点进设置。而用户此刻看的就是这个版本的卡片，点"管理"当然是
                  "管理**这一个**"，不该让他去列表里再找一遍。

                  ★ 2026-10-16：下面那条「管理此版本」的**文字链已经删掉** ——
                    它和这颗按钮是**同一个落点**（都是 `openVersion(id,'setup')`），
                    frontend-design 的规矩是"一个意图只留一个名字"。留按钮、去文字链：
                    按钮有图标、有位置、能键盘走到，是两者里更好的那个。
                */}
                <Button variant="ghost" size="sm" onClick={() => openVersion(target.id, 'setup')}>
                  <IconGear /> 版本设置
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {/* ---------- 左栏第二块：本机状态（真数据，不是装饰） ----------
            ★ 2026-10-16：从"页脚一条横带"挪到这里 —— 见上面那段说明。
              它**不是卡片**（只有一条上分割线）：卡片在这一页只留一张（身份卡），
              块与块之间靠留白和细线分层，这样"浮起"才代表层级。 */}
        {state.machine ? (
          <div className="launch-facts">
            <div className="lf-item">
              <IconRam />
              <span className="lf-k">可用内存</span>
              <span className="lf-v mono">
                {state.machine.availableMemoryGb} / {state.machine.totalMemoryGb} GB
              </span>
            </div>
            <div className="lf-item">
              <IconCpu />
              <span className="lf-k">CPU</span>
              <span className="lf-v mono">
                {state.machine.cpuCount} 核 · {state.machine.arch}
              </span>
            </div>
            <div className="lf-item">
              <IconJava />
              <span className="lf-k">Java</span>
              <span className="lf-v mono">
                {state.java.runtimes.length > 0
                  ? state.java.runtimes.map((r) => r.major).join(' / ')
                  : '一个都没探测到'}
              </span>
            </div>
            <div className="lf-item">
              <IconDrive />
              <span className="lf-k">数据目录</span>
              <span className="lf-v mono">{state.machine.dataDir}</span>
            </div>
          </div>
        ) : null}
        </div>
        {/* /左栏 */}

        {/* ---------- 右栏：启动轨（换一个版本 → 启动） ---------- */}
        <section className="lb-rail">
          <div className="lb-rail-head">
            <h2 className="lb-rail-title" id="launch-picker-label">
              换一个版本
            </h2>
            <span className="lp-count">{launchable.length} 个</span>
          </div>

          <div className="lp-row" role="listbox" aria-labelledby="launch-picker-label">
            {pickerShown.map((i) => {
              const on = i.id === target?.id;
              return (
                <button
                  key={i.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={isRunning}
                  className={`lp-card glass${on ? ' on' : ''}`}
                  onClick={() => setLaunchTarget(i.id)}
                >
                  <VersionIcon version={i.mcVersion} size={30} />
                  <span className="lp-main">
                    <span className="lp-name">{instanceTitle(i.config.name, i.mcVersion, i.loader)}</span>
                    {/* ★ 版本号单独一行、等宽字体（数字对齐）；不再用圆点把它和加载器串起来 */}
                    <span className="lp-ver mono">{i.mcVersion}</span>
                  </span>
                  {/* ★ 加载器右对齐、安静 —— 顶替原来 ` · 原版` 那半句 */}
                  <span className="lp-tag">{i.loader ? loaderName(i.loader.kind) : '原版'}</span>
                  {on ? (
                    <span className="lp-check" aria-hidden="true">
                      <IconCheck />
                    </span>
                  ) : null}
                </button>
              );
            })}
            {picker.hasMore ? (
              <button
                type="button"
                disabled={isRunning}
                className="lp-card lp-more glass"
                onClick={() => setPickerOpen(true)}
              >
                <span className="lp-more-ic" aria-hidden="true">
                  <IconGrid />
                </span>
                <span className="lp-main">
                  <span className="lp-name">全部版本…</span>
                  <span className="lp-ver dim">还有 {launchable.length - pickerShown.length} 个</span>
                </span>
              </button>
            ) : null}
          </div>

        {/* 启动按钮 */}
        {/*
          ★★ 2026-10-16（用户给了一段 Uiverse 的 `.cssbuttons-io-button`：
             「**开始按钮做成这样**」）：按钮不再是"图标 + 文字"并排，而是
             **文字 + 右侧一块方形托盘**（托盘里放那个三角），悬停时托盘铺满整颗按钮。
             ★ 图标从文字**前面**挪到托盘里 —— 这是那份样式的一部分，不是漏了。
             ★ 托盘是 `aria-hidden`：它装的是同一个图标的另一种位置，
               `id="ieml-launch-btn"` 与 `onClick` 都没变（外壳靠这个 id 点它，
               见 AppShell 里那段"启动请求"的处理）。
        */}
        <div className="launch-btn-wrap">
          {isRunning ? (
            <Button
              id="ieml-launch-btn"
              variant="danger"
              className="launch-btn"
              onClick={() => void stop()}
            >
              停止游戏
              <span className="launch-btn-plate" aria-hidden="true">
                <IconStop />
              </span>
            </Button>
          ) : (
            /*
             * ★★ 2026-10-16（用户截图 +「**点击后，就消失了，我觉得这是个错误**」）：
             *   这里**不再用 `Button` 的 `loading` 通道**。
             *
             *   那条通道把转圈渲染在**文字前面**（`{loading ? spinner : null}{children}`），
             *   而这个按钮的"图标位"是右边那块托盘 —— 于是启动中会变成
             *   "文字左边一个转圈 + 托盘整个消失"，也就是用户看到的那个跳变。
             *   改成：**托盘留在原地，把里面的三角换成转圈**
             *   （正是用户 2026-09-23 说的「用右边的转圈把左边的三角替换掉，不要同时显示」）。
             *
             *   ★ `loading` 通道顺手做的两件事在这里自己给：`disabled`（防连点）
             *     与 `aria-busy`（读屏软件要知道它在忙）。
             *   ★ 托盘是 `aria-hidden` 的，所以里面那颗转圈对读屏是隐形的 ——
             *     "在忙"这件事由 `aria-busy` 表达，不靠那颗转圈。
             */
            <Button
              id="ieml-launch-btn"
              variant="primary"
              className={`launch-btn${launching ? ' is-launching' : ''}`}
              disabled={launching}
              aria-busy={launching || undefined}
              onClick={() => void launch()}
            >
              启动游戏
              <span className="launch-btn-plate" aria-hidden="true">
                {launching ? <span className="spinner" /> : <IconPlay />}
              </span>
            </Button>
          )}
        </div>

        {/*
          ★ 2026-10-16：原来那条状态线里的「已运行 12:34」**不能跟着一起删** ——
            它是**当下的状态**（跑着多久了），不是历史记录（用户 2026-09-16 删掉的是
            "上次 3 天前 / 从未启动"那种回忆）。挪到启动按钮下面：
            按钮此刻显示的是「停止游戏」，下面这行正好说明它跑了多久。
        */}
        {isRunning ? (
          <div className="lb-running">
            正在运行 · 已 {formatElapsed(Date.now() - (runInfo?.startedAt ?? 0))}
          </div>
        ) : null}
        {/*
          ★★★★ 2026-09-30（用户）：「**启动整合包很慢**」「**为什么切换别的页面会停止启动**」。

          `launching` 期间把**后端正在做什么**显示出来。整合包首次启动时这一步要
          补齐客户端与库（几十 MB，而且这些文件走的是慢源），**以前是完全静默的** ——
          看起来就是卡死。现在至少能看到"它在动、动到哪了"。

          ★ 只在真的收到事件时显示。没收到（文件齐全，自愈毫秒级结束）时这一行
            不出现 —— **不编一个假进度**。
        */}
        {launching && launchProgress ? (
          <div className="launch-prep">
            <Spinner
              label={`${launchProgress.stage}（${launchProgress.finished}/${launchProgress.total}）`}
            />
            {launchProgress.current ? (
              <span className="launch-prep-file truncate">{launchProgress.current}</span>
            ) : null}
          </div>
        ) : null}

        {/*
          ★★ 多开实例（2026-09-15）：**同时有两个以上在跑**时说一句。

            ★ 判据改过一次，值得记：第一版写的是
              `othersRunning > 0 && !isRunning`（"别的在跑、而当前这个没在跑"）。
              那个判据理论上更精确，但**我三次都没能把"把目标切到另一个版本"
              这个动作自动化验证出来** —— 一个我证不了的提示，比一个朴素但能证的
              提示更糟。现在改成"表里超过一个就提示"：
                · 同样能传达"现在有两份在跑、内存各占各的"这件事；
                · 用两个 `ieml:started` 事件就能稳定复现、稳定验证。
        */}
        {runningCount(state) > 1 ? (
          <div className="launch-multi">
            <IconAlert />
            <span>
              现在有 <b>{runningCount(state)}</b> 个版本同时在跑 —— 内存各占各的
              （这一个按 {Math.round((target?.config.memoryMb ?? 0) / 1024)} GB 算）。
              侧栏底部可以逐个停止。
            </span>
          </div>
        ) : null}

        {/*
          ★★ 2026-10-16：这里原来还有一条「一行状态」——
                `🖫 6 GB · 🍵 Java 自动 · 管理此版本`

             它被删掉，原因有两条，都不是"嫌它多余"这么随意：

                ① 那串信息**已经在左栏的规格行里**（内存、Java 各占一行），
                   同一件事说两遍；而且中缀圆点串本身是模板痕迹。
                ② 「管理此版本」与左栏那颗「版本设置」是**同一个落点**
                   （都是 `openVersion(id,'setup')`）—— 一个意图两个名字，
                   按规矩只留一个（留按钮：有图标、能键盘走到）。

             现在右栏就是一条干净的动作路径：换版本 → 启动。
        */}
        </section>
      </div>

      {/* 内存偏低提示（唯一保留的告警） */}
      {state.machine && state.machine.availableMemoryGb < 2 ? (
        <Note tone="warning" icon={<IconAlert />} title="当前可用内存偏低">
          只有 {state.machine.availableMemoryGb} GB 可用。启动前建议关掉其他占内存的程序。
        </Note>
      ) : null}

      {!isDesktop ? (
        <Note tone="info">
          浏览器演示模式：真实启动要桌面版（<code>pnpm desktop:dev</code>）
        </Note>
      ) : null}

      {/*
        ★★ 2026-10-16：「其它版本」这一整块**并进了上面的版本选择器**（用户选了 A+）。
          它原来和下拉在干同一件事（`others` ＝ `launchable` 去掉当前项），
          一屏里把同一批版本列了两遍 —— 现在只有**一处**在选版本。
          旧注释里那两条历史（"主页留白太多所以填真东西"、"全部版本按钮没必要"）
          依然成立，只是载体从"另一排卡片"变成了选择器里的「全部版本…」入口：
          · 平铺够用时不出现那个入口（≤6 个版本就是几卡片）；
          · 超过 6 个才出现，点开是**可搜索**的弹层 —— 这比原先"推你去版本列表页"
            更贴这块的意图（留在主页就能换）。
      */}

      {/*
        ★ 2026-10-16：本机状态那一块**已经挪进板里**（左栏、身份卡下面）——
          原来它横在页面底部，于是"板"只占上半屏、下半屏空着（用户说的"大片空区"
          就是这个）。挪进左栏之后：左栏＝"这一版 + 这台机器"，右栏＝"换版本 + 启动"，
          两栏高度也接近了。
      */}

      {/* ==================== 全部版本（A+ 的「全部版本…」入口） ====================
          什么时候会出现：这个文件夹里的版本**超过 6 个**时，卡片排只平铺前 5 张，
          第 6 张位置放「全部版本…」—— 主页因此不会被版本数量撑长。

          ★ 用 `Modal`（app 里一致的弹层）而不是浮层：这里要给**搜索框 + 长列表**，
            浮层在小窗口里会把自己挤到屏幕外（`.row-menu` 那套翻转逻辑就是为这个写的）。
          ★ 列表项与卡片排是同一套信息与命名（`instanceTitle` / `VersionIcon`）。
      */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="选择要启动的版本"
        subtitle={`这个文件夹里共 ${launchable.length} 个`}
        size="lg"
      >
        <div className="lp-search">
          <SearchBox
            value={pickerQuery}
            onChange={setPickerQuery}
            label="搜索版本"
            placeholder="搜索名称或版本号…"
          />
        </div>
        <div className="lp-list" role="listbox" aria-label="全部版本">
          {pickerFiltered.map((i) => {
            const on = i.id === target?.id;
            return (
              <button
                key={i.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`lp-item${on ? ' on' : ''}`}
                onClick={() => {
                  setLaunchTarget(i.id);
                  setPickerOpen(false);
                }}
              >
                <VersionIcon version={i.mcVersion} size={30} />
                <span className="lp-main">
                  <span className="lp-name">{instanceTitle(i.config.name, i.mcVersion, i.loader)}</span>
                  {/* 与右栏同一条规矩：版本号与加载器分成两个字段，不拼圆点串 */}
                  <span className="lp-ver mono">{i.mcVersion}</span>
                </span>
                <span className="lp-tag">{i.loader ? loaderName(i.loader.kind) : '原版'}</span>
                {on ? (
                  <span className="lp-check" aria-hidden="true">
                    <IconCheck />
                  </span>
                ) : null}
              </button>
            );
          })}
          {pickerFiltered.length === 0 ? (
            <div className="dim" style={{ padding: '18px 4px' }}>
              没有匹配的版本。换个词试试，或者去「版本列表」看看。
            </div>
          ) : null}
        </div>
      </Modal>

      {/* ==================== 启动命令预览 ====================
          ★ 2026-09-16 用户（截图）：删掉了副标题
            "这是真正会执行的命令行（令牌已隐藏，可以放心贴出来求助）"
          ==================================================== */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="启动命令预览"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
              关闭
            </Button>
            <div className="spacer" />
            <Button variant="primary" loading={launching} onClick={() => void launch()}>
              <IconPlay /> 就这样启动
            </Button>
          </>
        }
      >
        {/* 拼装中：立刻给反馈，别让窗口空着（见按钮里那段说明） */}
        {previewLoading && !preview ? (
          <div className="dim" style={{ padding: '18px 0' }}>
            正在拼装启动命令（解析 Java、读版本 JSON、组装 classpath）…
          </div>
        ) : null}
        {preview ? (
          <>
            <div className="pack-locks">
              <div className="pack-lock">
                <span className="pl-k">Java</span>
                <span className="pl-v mono truncate">
                  {preview.java.split(/[\\/]/).slice(-3).join('/')}
                </span>
              </div>
              {/*
                ★★ 这条 Java 是谁选的（ADR-030 的四模式，2026-09-28）：
                  用户在版本设置里显式选过 Java 时，这里写明"按你选的那一项"，
                  选得与版本要求不一致时后端会给一句警告。
                  ★ 没有它，用户只能从路径去猜这个决定是谁做的 —— 而路径看不出来。
              */}
              {preview.java_note ? (
                <div className="pack-lock">
                  <span className="pl-k">为什么用它</span>
                  <span className="pl-v">{preview.java_note}</span>
                </div>
              ) : null}
              <div className="pack-lock">
                <span className="pl-k">classpath 条目</span>
                <span className="pl-v mono">{preview.classpath_entries}</span>
              </div>
              <div className="pack-lock">
                <span className="pl-k">摘要</span>
                <span className="pl-v">{preview.summary}</span>
              </div>
              <div className="pack-lock">
                <span className="pl-k">本地库目录</span>
                <span className="pl-v mono truncate">
                  {preview.natives_dir.split(/[\\/]/).slice(-2).join('/')}
                </span>
              </div>
            </div>
            <pre className="crash-log" tabIndex={0} aria-label="完整启动命令">
              {preview.command}
            </pre>
          </>
        ) : (
          <div className="dim">正在拼装…</div>
        )}
      </Modal>
    </>
  );
}

/* ====================== 工具 ====================== */

function loaderName(kind: string): string {
  const map: Record<string, string> = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
  };
  return map[kind] ?? kind;
}

function javaLabel(mode: string): string {
  switch (mode) {
    case 'auto':
      return 'Java 自动';
    case 'range':
      return 'Java 按区间';
    case 'instance-folder':
      return 'Java 随实例';
    case 'path':
      return 'Java 已指定';
    default:
      return 'Java 自动';
  }
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  if (m < 1) return `${total} 秒`;
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

