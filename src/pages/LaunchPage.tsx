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
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { isInstanceRunning, runningInfo, runningCount } from '../state/store';
import { Button, Chip, CustomSelect, EmptyState, Modal, Note } from '../ui';
import {
  IconAlert,
  IconBox,
  IconCpu,
  IconDownload,
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
  const { state, target, go, goDownloadTab, backend, toast, setLaunchTarget, openVersion } = useApp();
  const { api, isDesktop } = useRealApi();

  const [launching, setLaunching] = useState(false);
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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

  /* 二级页按「启动这个版本」时，回到启动页 */
  useEffect(() => {
    const onLaunchRequest = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setLaunchTarget(id);
      go('launch');
      // 下一帧触发启动（等 state 更新）
      setTimeout(() => {
        const btn = document.getElementById('ieml-launch-btn');
        btn?.click();
      }, 120);
    };
    window.addEventListener('ieml:launch-request', onLaunchRequest);
    return () => window.removeEventListener('ieml:launch-request', onLaunchRequest);
  }, [go, setLaunchTarget]);

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

  async function launch() {
    if (!target || !req) return;
    if (!api) {
      toast('warning', '当前是演示模式', '浏览器里无法真实启动。请用桌面版（pnpm desktop:dev）。');
      return;
    }
    setLaunching(true);
    setJavaMissing(null);
    try {
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
   * 其它版本（除了当前选中的）—— "一眼换目标"用。
   * 排序：最近玩过的在前；没玩过的按建立时间倒序。
   */
  const others = useMemo(
    () =>
      state.instances
        .filter((i) => i.id !== target?.id)
        .sort((a, b) => {
          const at = a.lastPlayedAt ?? '';
          const bt = b.lastPlayedAt ?? '';
          if (at && bt) return bt.localeCompare(at);
          if (at) return -1;
          if (bt) return 1;
          return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
        }),
    [state.instances, target?.id],
  );

  /* ---------- 空状态：没有实例 ---------- */
  if (state.instances.length === 0) {
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
          desc="先去下载一份游戏，装好后它会出现在「版本列表」里。也可以用整合包一键装好一整套。"
          actions={
            <>
              <Button variant="primary" onClick={() => go('download')}>
                <IconDownload /> 去下载游戏
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
              try {
                setPreview(await api.launcher.preview(req));
                setPreviewOpen(true);
              } catch (e) {
                toast('err', '无法拼装启动命令', e instanceof Error ? e.message : String(e));
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
              <Button variant="ghost" size="sm" onClick={() => openVersion(target.id, 'mods')}>
                <IconPuzzle /> Mod 管理
              </Button>
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
            options={state.instances.map((i) => ({
              value: i.id,
              label: `${i.config.name} — ${i.mcVersion}${i.loader ? ` + ${loaderName(i.loader.kind)}` : ' 原版'}`,
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
            <button type="button" className="link-btn" onClick={() => go('versions')}>
              管理这个版本
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
            <button type="button" className="link-btn" onClick={() => go('versions')}>
              全部版本
            </button>
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
                  <span className="lo-name">{i.config.name}</span>
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

      {/* ==================== 启动命令预览 ==================== */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="启动命令预览"
        subtitle="这是真正会执行的命令行（令牌已隐藏，可以放心贴出来求助）"
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

