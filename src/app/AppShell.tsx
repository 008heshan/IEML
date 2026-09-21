/**
 * 应用外壳
 * ------------------------------------------------------------------
 * 导航层级参照 PCL2 的「正副级页面」：
 *
 *   一级（侧边栏 4 项，永远是这 4 项）
 *     启动 │ 版本列表 │ 下载 │ 设置
 *
 *   二级（进入某个版本后，侧边栏整体替换）
 *     ← 返回 │ 概览 │ 设置 │ Mod 管理 │ 日志
 *
 * 为什么二级**替换**一级而不是并排：
 *   并排会变成"左侧两栏导航"，220px 的侧边栏塞不下，而且用户分不清哪一栏
 *   是全局、哪一栏属于当前版本。替换后"我现在在哪一层"一目了然。
 */
import brandIcon from '../assets/brand-icon.png'
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import type { PageId, SubPageId } from '../state/store';
import { Button, Chip, Modal, ToastRegion } from '../ui';
import {
  IconChevronRight,
  IconDownload,
  IconDrive,
  IconGear,
  IconGrid,
  IconHome,
  IconLayers,
  IconPlay,
  IconPuzzle,
  IconStop,
  IconTerminal,
} from '../ui/Icons';
import { VersionIcon } from '../components/VersionIcon';
import { UpdateChip } from '../components/UpdateChip';
import { LaunchPage } from '../pages/LaunchPage';
import { VersionsPage } from '../pages/VersionsPage';
import { DownloadPage } from '../pages/DownloadPage';
import { SettingsPage } from '../pages/SettingsPage';
import { InstanceOverview } from '../pages/InstanceOverview';
import { InstanceSetup } from '../pages/InstanceSetup';
import { ModsPanel } from '../pages/ModsPanel';
import { LogsPanel } from '../pages/LogsPanel';
import { CreateInstanceModal } from '../pages/CreateInstanceModal';
import { CrashModal } from '../pages/CrashModal';
import { TaskCenter } from '../components/TaskCenter';
import { AccountPanel } from '../components/AccountPanel';
import { WindowControls } from '../components/WindowControls';
import { isInstanceRunning, runningInstances } from '../state/store';
import { getRealApi } from '../bridge';

interface NavEntry {
  id: PageId;
  label: string;
  icon: typeof IconHome;
}

const PRIMARY_NAV: NavEntry[] = [
  { id: 'launch', label: '启动', icon: IconPlay },
  { id: 'versions', label: '版本列表', icon: IconLayers },
  { id: 'download', label: '下载', icon: IconDownload },
  { id: 'settings', label: '设置', icon: IconGear },
];

const SUB_NAV: Array<{ id: SubPageId; label: string; icon: typeof IconHome }> = [
  { id: 'overview', label: '概览', icon: IconHome },
  { id: 'setup', label: '设置', icon: IconGrid },
  { id: 'mods', label: 'Mod 管理', icon: IconPuzzle },
  { id: 'logs', label: '日志', icon: IconTerminal },
];

/** 提示文案超过这个长度就折叠（大概两三行的量） */
const TOAST_LONG = 90;
function isLong(text: string): boolean {
  return text.length > TOAST_LONG || text.includes('\n');
}

export function App() {
  const { state, go, dismissToast, closeVersion, setSubPage, open, openVersion } = useApp();
  const [stopping, setStopping] = useState(false);
  /** 顶栏的账号弹窗（正版登录入口） */
  const [accountOpen, setAccountOpen] = useState(false);

  /**
   * 把一条提示交给顶层的 toast 区域。
   *
   * ★ 为什么要这一层：`AccountPanel` 是**通用组件**，它不该直接引用 AppContext 的
   *   toast 实现（那样它就没法在别的壳里复用）。这里做一个最小的适配器。
   */
  function dispatchToast(
    kind: 'ok' | 'warning' | 'err' | 'info',
    title: string,
    desc?: string,
  ) {
    window.dispatchEvent(new CustomEvent('ieml:toast', { detail: { kind, title, desc } }));
  }

  /** 最近玩过的两个版本（侧栏"最近玩过"用，真的按时间排） */
  const recent = useMemo(
    () =>
      state.instances
        .filter((i) => i.lastPlayedAt)
        .sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''))
        .slice(0, 2),
    [state.instances],
  );

  /** 打开数据目录（走 Rust 命令，不经 opener 插件的 scope，见设置页那段注释） */
  async function openDataDir() {
    const api = await getRealApi();
    if (!api) {
      window.dispatchEvent(
        new CustomEvent('ieml:toast', {
          detail: { kind: 'info', title: '数据目录', desc: state.machine?.dataDir ?? '未知' },
        }),
      );
      return;
    }
    try {
      const dir = await api.launcher.openDir('data');
      window.dispatchEvent(
        new CustomEvent('ieml:toast', { detail: { kind: 'ok', title: '已打开数据目录', desc: dir } }),
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('ieml:toast', {
          detail: {
            kind: 'err',
            title: '打不开数据目录',
            desc: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
  }
  /** 哪条提示被展开了（长文本默认折叠，点开看全） */
  const [expanded, setExpanded] = useState<string | null>(null);

  /*
   * ★★ 多开实例（2026-09-15）：顶栏原来只认**一个**"当前在跑的版本"。
   *   现在同时可能有好几个，所以这里拿的是**一张表**：
   *     · `runningList` 用来在侧栏/底栏列出"哪几个在跑"，每个都能单独停；
   *     · 判据只有一份（`runningInstances` 在 store 里，按启动时间排序）。
   */
  const runningList = useMemo(() => runningInstances(state), [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === ',') {
        e.preventDefault();
        go('settings');
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        go('versions');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  /** 停某一个实例（多开时每个都要能单独停） */
  async function handleStopOne(instanceId: string) {
    setStopping(true);
    try {
      /*
       * ★ 审计发现：这里先派发 `stop-request`（前端据此立刻清掉"运行中"状态）、
       *   再等后端停 —— 于是**后端停失败时界面已经显示停好了**，
       *   而且失败被完全吞掉（只有 try/finally，没有 catch）。
       *   顺序反过来：先让后端真的停，成功了再改界面状态。
       *   （LaunchPage 的停止按钮本来就是对的顺序，两处终于一致了。）
       *
       * ★★ 多开实例：必须**点名停哪个**。以前不带参数（只有一个能停），
       *   现在不带就等于"随机停一个" —— 那是最难查的一类错。
       */
      const api = await getRealApi();
      if (api) {
        await api.launcher.stop(instanceId);
      }
      window.dispatchEvent(new CustomEvent('ieml:stop-request', { detail: { instanceId } }));
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('ieml:toast', {
          detail: {
            kind: 'err',
            title: '停止失败',
            desc: `游戏进程可能还在运行：${e instanceof Error ? e.message : String(e)}`,
          },
        }),
      );
    } finally {
      setStopping(false);
    }
  }

  if (!state.ready) {
    return (
      <div className="boot">
        <div className="boot-inner">
          {/*
            ★ 2026-09-17 用户（截图：启动页中间一个粉紫色方块 + "正在准备…"）：
              「**加载页的图标没改，用现在的 icon**」。

            这里原来画的是一个**内联的通用方块 SVG**（lucide 的 box 图标）——
            那是设计初期的占位符，后来换了正式品牌图标却漏了这一处。
            现在改成与 `index.html` 的 splash、以及下面标题栏（22×22）**同一个**
            `brandIcon`，三处视觉统一。

            ★ 用 `<img>` 而不是把 PNG 转成 SVG：图标本身是位图资产，
              这里只需要"显示它"，不需要矢量能力。
          */}
          <div className="boot-mark">
            <img src={brandIcon} alt="" />
          </div>
          <div>正在准备…</div>
        </div>
      </div>
    );
  }

  if (state.bootError) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <Chip tone="danger">启动失败</Chip>
          <div>{state.bootError}</div>
          <Button variant="primary" onClick={() => location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  const inInstance = state.page === 'versions' && open !== null;

  return (
    <div className="app">
      {/* ==================== 顶栏（只有品牌、面包屑、任务、主题） ==================== */}
      {/*
        ★★ 顶栏现在**就是**窗口标题栏（2026-09-15）。

        背景：`tauri.conf.json` 里把 `decorations` 关掉了 —— 原来那条 Windows
        原生标题栏是白色的，压在深色界面顶上非常突兀，而且和系统主题各走各的
        （用户："这个白色的条，并进软件里，这个额外的在外面，很丑"）。

        于是这条顶栏要自己承担原生标题栏的两件事：
          ① **拖动**：`data-tauri-drag-region`。Windows 上 Tauri 走的是
             `WM_NCLBUTTONDOWN + HTCAPTION`，所以双击最大化、拖到屏幕边缘吸附
             这些**原生行为都是白送的** —— 不用自己实现，自己实现反而会打架。
          ② **窗口按钮**：最小化 / 最大化-还原 / 关闭，见 `WindowControls`。

        ★ 浏览器演示模式没有窗口可管，那三个按钮**不渲染**（不能摆着骗人）。
      */}
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">
            <img src={brandIcon} alt="" style={{ width: 22, height: 22 }} />
          </span>
          <span data-tauri-drag-region>IEML</span>
        </div>

        {inInstance && open ? (
          <nav className="crumbs" aria-label="位置">
            <button type="button" className="crumb-link" onClick={() => closeVersion()}>
              版本列表
            </button>
            <IconChevronRight />
            <span className="crumb-cur truncate">{open.config.name}</span>
          </nav>
        ) : null}

        <div className="titlebar-spacer" />

        {/*
          ★★ 账号入口放在**顶栏**（用户："正版登录界面应该放在显眼位置，而不是藏起来"）。
          理由：账号不是"设置"，是**状态** —— "我现在是谁、能不能进正版服务器"
          应该一直看得见。点开就是完整的登录面板（`AccountPanel`，与设置页同一份实现）。
        */}
        {/*
          ★★ 「新版本」角标（用户 2026-09-21：「我想要热更新和静默安装」）。

          放在顶栏，紧挨账号 —— 理由是**它必须随时看得见**：
          更新是"你该做的一件事"，藏在设置页最下面那张卡里等于没做。
          开机自动查一次（延迟 8 秒、静默失败）、查到就后台下载，
          所以用户看到它时通常已经能"一键换"了。

          ★ 三种可点/不可点状态各有各的话：
            · 下载中 → **不可点**（title 给理由："正在后台下载，下完就能一键更新"）
            · 已下好 → 「重启并更新」→ install()（静默安装 + 装完自己回来）
            · 下失败 → 「重试」→ download()
        */}
        <UpdateChip />

        <button
          type="button"
          className={`acct-chip${state.prefs.accountUuid ? ' on' : ''}`}
          aria-haspopup="dialog"
          title={
            state.prefs.accountUuid
              ? `已登录正版：${state.prefs.offlineUsername} —— 点开看账号信息`
              : '还没登录正版账号（当前是离线模式）—— 点这里登录'
          }
          onClick={() => setAccountOpen(true)}
        >
          <span className="acct-chip-dot" aria-hidden="true" />
          <span className="acct-chip-text truncate">
            {state.prefs.accountUuid ? state.prefs.offlineUsername : '离线模式'}
          </span>
          <span className="acct-chip-tag">
            {state.prefs.accountUuid ? '正版' : '登录'}
          </span>
        </button>

        <TaskCenter />

        {/* ★★ 2026-09-16 用户要求"删除白色模式"：那个太阳/月亮按钮已经删掉。
           只保留深色 —— 一个主题就没有"两套值必须同步"的负担，
           也不会再出现"浅色下某个 rgba 变成污渍"这类只在一半用户那里出现的问题。 */}
        {/* 窗口按钮（最小化 / 最大化-还原 / 关闭）——见上面那段说明 */}
        <WindowControls />
      </header>

      <div className="main">
        {/* ==================== 侧边栏：一级 or 二级 ==================== */}
        <aside className="sidebar">
          {inInstance && open ? (
            <>
              <button type="button" className="back-btn" onClick={() => closeVersion()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                返回版本列表
              </button>

              <div className="side-inst">
                <div className="side-inst-name truncate" title={open.config.name}>
                  {open.config.name}
                </div>
                <div className="side-inst-meta">
                  <span className="mono">{open.mcVersion}</span>
                  {open.loader ? (
                    <Chip tone="accent">{loaderName(open.loader.kind)}</Chip>
                  ) : (
                    <Chip tone="neutral">原版</Chip>
                  )}
                </div>
              </div>

              <nav aria-label="版本内导航">
                {/*
                  ★★ 原版实例**不开放 Mod 列表**（用户 2026-09-15：
                  "我觉得原版不应开放 mod 列表功能"）。

                  理由：纯原版（没有加载器）根本不会加载 `mods/` 里的任何东西 ——
                  把「Mod 管理」摆在那儿，用户放进去的 jar 会**无声无息地不生效**，
                  而他以为装上了。与其给一个必然无效的入口，不如不给。
                  「概览」页那句"纯原版不能加载 Mod，要装请先在设置里加加载器"
                  仍然在 —— 那才是该看到这句话的地方。
                */}
                {SUB_NAV.filter((item) => item.id !== 'mods' || open?.loader != null).map((item) => {
                  const Icon = item.icon;
                  const current = state.subPage === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="nav-item"
                      aria-current={current ? 'page' : undefined}
                      onClick={() => setSubPage(item.id)}
                    >
                      <Icon />
                      <span className="nav-text">{item.label}</span>
                      {item.id === 'mods' && state.mods.entries.length > 0 ? (
                        <em className="nav-badge">{state.mods.entries.length}</em>
                      ) : null}
                    </button>
                  );
                })}
              </nav>

              <div className="side-foot">
                <Button
                  variant="primary"
                  className="side-launch"
                  loading={stopping}
                  onClick={async () => {
                    if (isInstanceRunning(state, open.id)) {
                      await handleStopOne(open.id);
                    } else {
                      window.dispatchEvent(
                        new CustomEvent('ieml:launch-request', { detail: open.id }),
                      );
                    }
                  }}
                >
                  {isInstanceRunning(state, open.id) ? (
                    <>
                      <IconStop /> 停止游戏
                    </>
                  ) : (
                    <>
                      <IconPlay /> 启动这个版本
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <nav aria-label="主导航">
              {PRIMARY_NAV.map((item) => {
                const Icon = item.icon;
                const current = state.page === item.id;
                const badge =
                  item.id === 'versions'
                    ? state.instances.length
                    : item.id === 'download'
                      ? state.tasks.filter(
                          (t) => t.status === 'running' || t.status === 'pending',
                        ).length
                      : undefined;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="nav-item"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => go(item.id)}
                  >
                    <Icon />
                    <span className="nav-text">{item.label}</span>
                    {badge !== undefined && badge > 0 ? (
                      <em className="nav-badge">{badge}</em>
                    ) : null}
                  </button>
                );
              })}

              {/*
                ★★ 侧栏下半部分别再空着（用户："左侧栏设置以下空缺太多，
                  可以想想加什么"）。

                这里放的都是**真东西**，不是装饰：
                  · 「最近玩过」—— 最近两个版本，点一下直接进它（省掉
                    "版本列表 → 找 → 双击"三步）
                  · 三个直达动作 —— 打开数据目录 / 全部版本 / 关于
                一个版本都没有时整块不渲染（不留空标题）。
              */}
              {recent.length > 0 ? (
                <div className="side-recent">
                  <div className="side-recent-title">最近玩过</div>
                  {recent.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      className="side-recent-item"
                      title={`打开「${i.config.name}」`}
                      onClick={() => openVersion(i.id)}
                    >
                      <VersionIcon version={i.mcVersion} size={24} />
                      <span className="sri-main">
                        <span className="sri-name truncate">{i.config.name}</span>
                        <span className="sri-sub mono">
                          {i.mcVersion}
                          {i.loader ? ` · ${i.loader.kind}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="side-links">
                <button type="button" className="side-link" onClick={() => void openDataDir()}>
                  <IconDrive /> 数据目录
                </button>
                <button type="button" className="side-link" onClick={() => go('settings')}>
                  <IconGear /> 关于与设置
                </button>
              </div>

              <div className="side-foot">
                {/*
                  ★★ 多开实例（2026-09-15）：底栏列**每一个**在跑的版本，
                  每个都能单独停。
                  以前这里只显示"那一个"（`runningInstance`）—— 多开之后
                  那个写法会让另外几个"隐身"：用户既看不到它们，
                  也没法从界面上停掉它们，只能去任务管理器。
                */}
                {runningList.length > 0 ? (
                  <div className="running-list" role="group" aria-label="正在运行的游戏">
                    {runningList.length > 1 ? (
                      <div className="running-head">
                        <span className="pulse" aria-hidden="true" />
                        <span>{runningList.length} 个在运行</span>
                      </div>
                    ) : null}
                    {runningList.map(({ inst, startedAt }) => (
                      <div className="running-chip" key={inst.id}>
                        {runningList.length === 1 ? (
                          <span className="pulse" aria-hidden="true" />
                        ) : null}
                        <div className="txt" style={{ flex: 1, minWidth: 0 }}>
                          <div className="t truncate" title={inst.config.name}>
                            {inst.config.name}
                          </div>
                          <div className="s">
                            已运行 {formatElapsed(Date.now() - startedAt)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`停止 ${inst.config.name}`}
                          title={`停止 ${inst.config.name}`}
                          loading={stopping}
                          onClick={() => void handleStopOne(inst.id)}
                        >
                          <IconStop />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </nav>
          )}
        </aside>

        {/* ==================== 内容区 ==================== */}
        <main className="content">
          {state.page === 'launch' && <LaunchPage />}
          {state.page === 'versions' &&
            (open ? (
              <>
                {state.subPage === 'overview' && <InstanceOverview />}
                {state.subPage === 'setup' && <InstanceSetup />}
                {state.subPage === 'mods' && <ModsPanel />}
                {state.subPage === 'logs' && <LogsPanel />}
              </>
            ) : (
              <VersionsPage />
            ))}
          {state.page === 'download' && <DownloadPage />}
          {state.page === 'settings' && <SettingsPage />}
        </main>
      </div>

      <CreateInstanceModal />
      <CrashModal />

      {/*
        ★ 账号弹窗：顶栏那个按钮打开它（内容与设置页的账号卡是同一个组件）。
        ★★ 用户报："正版登录有两个关闭键" —— 一个是模态框右上角那个 ✕，
          另一个是这里 footer 里的「关闭」按钮。**同一个动作不该有两个入口**，
          去掉 footer 那个（✕ 和点遮罩都能关，键盘还有 Esc）。
      */}
      <Modal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title="账号"
        subtitle="正版登录后可以进正版验证的服务器；离线模式不影响单机与局域网"
      >
        <AccountPanel
          compact
          toast={(kind, title, desc) =>
            dispatchToast(kind, title, desc)
          }
          onLoggedIn={() => setAccountOpen(false)}
        />
      </Modal>

      <ToastRegion>
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-ic" aria-hidden="true">
              {t.kind === 'ok' ? (
                <svg viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : t.kind === 'err' ? (
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M15 9l-6 6M9 9l6 6" />
                </svg>
              ) : t.kind === 'warning' ? (
                <svg viewBox="0 0 24 24">
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              )}
            </span>
            <div className="toast-body">
              <div className="toast-t">{t.title}</div>
              {t.desc ? (
                /*
                 * 长文本**默认折叠**，需要时点开看全。
                 *
                 * 为什么不是"长文本就一直挂着"（以前的做法）：
                 * 一次启动失败的报错有七八行，永久占着右下角，
                 * 用户报"提示不会自动消失"。折叠 + 定时消失
                 * 既保住了"能看到全部内容"，又不留常驻垃圾。
                 */
                <div
                  className={`toast-d${isLong(t.desc ?? '') && expanded !== t.id ? ' clamped' : ''}`}
                  onClick={() =>
                    isLong(t.desc ?? '') && setExpanded(expanded === t.id ? null : t.id)
                  }
                  title={isLong(t.desc ?? '') ? '点击展开 / 收起' : undefined}
                >
                  {t.desc}
                  {isLong(t.desc ?? '') ? (
                    <span className="toast-more">{expanded === t.id ? '收起' : '展开'}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="toast-x"
              aria-label="关闭提示"
              onClick={() => dismissToast(t.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </ToastRegion>
    </div>
  );
}

function loaderName(kind: string): string {
  const map: Record<string, string> = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
  };
  return map[kind] ?? kind;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${total} 秒`;
}
