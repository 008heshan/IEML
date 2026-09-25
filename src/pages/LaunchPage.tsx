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
import { Button, Chip, CustomSelect, EmptyState, Modal, Note } from '../ui';
import { instanceTitle } from '../state/instance-name';
import {
  IconAlert,
  IconBox,
  IconCpu,
  IconDrive,
  IconFolder,
  IconGear,
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
  const { state, target, go, goDownloadTab, backend, toast, setLaunchTarget, openVersion, folder } = useApp();
  const { api, isDesktop } = useRealApi();

  const [launching, setLaunching] = useState(false);
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
              <span className="lf-v mono" title={state.machine.dataDir}>
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

      {/* ==================== 核心：一个大按钮 + 一颗下拉 ==================== */}
      <div className="launch-panel">
        {/*
          ★★ 0.1.0-beta.1：给选中的版本一块"身份卡"（用户："主页面太简单，
            简单到感觉像我们不会做软件，留着大片空区不要，简直浪费"）。

          卡片里全是**真数据**：版本图标（自绘方块，按世代配色）、名字、
          MC 版本与加载器、磁盘占用、游玩时长。以前这一页只有一颗下拉 +
          一个按钮，下面大片空白。
        */}
        {target ? (
          <div className="launch-hero">
            <VersionIcon version={target.mcVersion} size={72} />
            <div className="lh-main">
              <div className="lh-name">{target.config.name}</div>
              <div className="lh-meta">
                <Chip tone="accent">{target.mcVersion}</Chip>
                <span className="dim">
                  {target.loader ? loaderName(target.loader.kind) : '原版'}
                  {target.loader?.version ? ' ' : ''}
                  {target.loader?.version ? <span className="mono">{target.loader.version}</span> : null}
                  {target.addons.length > 0 ? ' · ' : ''}
                  {target.addons.map((a) => (a.kind === 'optifine' ? 'OptiFine' : 'LiteLoader')).join(' · ')}
                  {target.config.isolation !== 'off' ? ' · 已隔离' : ''}
                </span>
              </div>
              <div className="lh-sub">
                <span>
                  <IconRam /> {Math.round(target.config.memoryMb / 1024)} GB 内存
                </span>
                <span>
                  <IconJava /> {javaLabel(target.config.javaMode)}
                </span>
                {/* ★ 2026-09-16 用户："记录时间的功能删掉，这没有用" ——
                    「累计 xx / 还没玩过」这一格已删（那是"从未启动"的另一个说法）。 */}
              </div>
            </div>
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
              <Button variant="ghost" size="sm" onClick={() => openVersion(target.id, 'setup')}>
                <IconGear /> 版本设置
              </Button>
            </div>
          </div>
        ) : null}

        {/* 版本下拉 */}
        <div className="launch-version">
          <label className="launch-version-label">
            要启动的版本
          </label>
          <CustomSelect
            value={target?.id ?? ''}
            onChange={setLaunchTarget}
            disabled={isRunning}
            ariaLabel="要启动的版本"
            options={launchable.map((i) => ({
              value: i.id,
              /* ★ 2026-09-22：统一格式（"Minecraft 26.2 + Fabric 26.2：模组加载器"） */
              label: instanceTitle(i.config.name, i.mcVersion, i.loader),
            }))}
          />
        </div>

        {/* 启动按钮 */}
        <div className="launch-btn-wrap">
          {isRunning ? (
            <Button
              id="ieml-launch-btn"
              variant="danger"
              className="launch-btn"
              onClick={() => void stop()}
            >
              <IconStop /> 停止游戏
            </Button>
          ) : (
            <Button
              id="ieml-launch-btn"
              variant="primary"
              className="launch-btn"
              loading={launching}
              onClick={() => void launch()}
            >
              <IconPlay /> 启动游戏
            </Button>
          )}
        </div>

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

        {/* 一行状态 */}
        {target ? (
          <div className="launch-status">
            <span>
              <IconRam /> {Math.round(target.config.memoryMb / 1024)} GB
            </span>
            <span className="dot" />
            <span>
              <IconJava /> {javaLabel(target.config.javaMode)}
            </span>
            <span className="dot" />
            {/*
              ★ 2026-09-16 用户："记录时间的功能删掉，这没有用"。
                原来这里在没跑的时候显示「上次 3 天前 / 从未启动」——
                现在只在**真的在跑**时显示已运行时长（那是当下的状态，不是历史记录），
                其余情况什么都不显示。
            */}
            {isRunning ? (
              <span>已运行 {formatElapsed(Date.now() - (runInfo?.startedAt ?? 0))}</span>
            ) : null}
            {isRunning ? <span className="dot" /> : null}
            {/*
              ★ 2026-09-17 用户（截图）："主页的管理这个版本改成『**管理此版本**』，
                然后**直接转到这个版本的设置页**，而不是版本列表"。

              原来它 `go('versions')` —— 把人送去**版本列表**，然后还得再找到
              这一行、再点进设置。而用户此刻看的就是这个版本的卡片，
              点"管理"当然是"管理**这一个**"，不该让他去列表里再找一遍
              （卡片上已经有版本名和图标，再让他去列表里对号入座是多余的一步）。

              现在直接 `openVersion(target.id, 'setup')` —— 与右边那颗
              「版本设置」按钮**同一个落点**，两条路通向同一个地方。
              ★ 文案也从「管理这个版本」改成「管理此版本」：
                "这个/那个"在中文里带指代距离，而卡片上就有版本名，
                "此"才是"我正看着的这一个"。
            */}
            <button
              type="button"
              className="link-btn"
              onClick={() => openVersion(target.id, 'setup')}
            >
              管理此版本
            </button>
          </div>
        ) : null}
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

      {/* ==================== 其它版本：一眼换、一眼进 ====================
          ★ 用户说主页面"留着大片空区"。这里填的是**真东西**：本机其它版本，
            点一下切启动目标，点右边的小箭头直接进它的设置。
            只有一个版本时整块不渲染（不留空标题）。 */}
      {others.length > 0 ? (
        <>
          <div className="section-head">
            <h2 className="section-title">其它版本</h2>
            {/*
              ★ 2026-09-17 用户（截图 图七）：这里的「全部版本」按钮删掉 ——
                「这个全部版本的按钮是没必要的」。

              为什么它是多余的：下面那排卡片已经能点一下切启动目标、
              点右边箭头直接进它的设置，"其它版本"这块本身就是**快捷入口**；
              再去跳一个"版本列表"页，是把用户从主页推走，与这块的意图相反。
              （`go` 这个函数本身不会变成未使用变量 —— 本页还有
                `go('launch')` / `go('download')` / `go('settings')` 三处。
                ★ 注：`go('versions')` 到第五十轮已经**一处都不剩**了，
                  最后两处分别是这里和下面那颗「管理这个版本」，
                  两处都改成直达目标而不是绕去列表。）
            */}
          </div>
          <div className="launch-others">
            {others.map((i) => (
              <button
                key={i.id}
                type="button"
                className="lo-card"
                onClick={() => setLaunchTarget(i.id)}
                title={`切到「${i.config.name}」`}
              >
                <VersionIcon version={i.mcVersion} size={38} />
                <span className="lo-main">
                  {/*
                    ★★ 2026-09-23 用户（截图）：「**怎么没统一主页版本的命名**」——
                      这一排原来直接显示 `config.name`，而实例名是历代不同规则生成的，
                      于是同一屏里同时出现 `1.8.9`、`Minecraft 1.12.2`、`Fabric 26.2`、
                      `26.3 (2)` 四种写法。
                      现在走 `instanceTitle()`（与版本列表同一个函数）：
                      自动生成的名字统一成 `Minecraft <MC> [+ <加载器> <版本>]`，
                      **用户自己改过名的仍然显示他改的**。
                  */}
                  <span className="lo-name">{instanceTitle(i.config.name, i.mcVersion, i.loader)}</span>
                  <span className="lo-sub">
                    {i.mcVersion}
                    {i.loader ? ` · ${loaderName(i.loader.kind)}` : ' · 原版'}
                  </span>
                  {/* ★ 2026-09-16：卡片右下角那行"从未启动 / 3 天前"已删（用户要求） */}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {/* ==================== 本机状态（真数据，不是装饰） ==================== */}
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
            <span className="lf-v mono" title={state.machine.dataDir}>
              {state.machine.dataDir}
            </span>
          </div>
        </div>
      ) : null}

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
                <span className="pl-v mono truncate" title={preview.java}>
                  {preview.java.split(/[\\/]/).slice(-3).join('/')}
                </span>
              </div>
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
                <span className="pl-v mono truncate" title={preview.natives_dir}>
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

