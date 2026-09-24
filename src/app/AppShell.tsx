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
import { IconChevronRight, IconDownload, IconGear, IconGrid, IconHome, IconLayers, IconPlay, IconPuzzle, IconStop, IconTerminal, IconInfo } from '../ui/Icons';
/* ★ C-7：`VersionIcon` 的 import 随「最近玩过」一起删（那个块是它唯一的用处） */
import { UpdateChip } from '../components/UpdateChip';
import { LaunchPage } from '../pages/LaunchPage';
import { VersionsPage } from '../pages/VersionsPage';
import { DownloadPage } from '../pages/DownloadPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ChangelogPage } from '../pages/ChangelogPage';
import { AboutPage } from '../pages/AboutPage';
import { ResourceInstallPage } from '../pages/ResourceInstallPage';
import { InstanceOverview } from '../pages/InstanceOverview';
import { InstanceSetup } from '../pages/InstanceSetup';
import { ModsPanel } from '../pages/ModsPanel';
import { LogsPanel } from '../pages/LogsPanel';
import { CreateInstanceModal } from '../pages/CreateInstanceModal';
import { CrashModal } from '../pages/CrashModal';
import { TaskCenter } from '../components/TaskCenter';
import { AccountPanel } from '../components/AccountPanel';
import { AccountMenu } from '../components/AccountMenu';
import { WindowControls } from '../components/WindowControls';
import { runningInstances } from '../state/store';
import { getRealApi } from '../bridge';

interface NavEntry {
  id: PageId;
  label: string;
  icon: typeof IconHome;
}

const PRIMARY_NAV: NavEntry[] = [
  { id: 'launch', label: '启动', icon: IconPlay },
  { id: 'versions', label: '版本列表', icon: IconLayers },
  /*
   * ★★ 2026-09-23 晚（用户）：「**把安装版本合并到下载里**」——
   *   侧栏不再有「安装游戏」这一格，它回到「下载」页的第一个页签。
   *   （当天早些时候是反过来的：那时用户要它单开一页。合并回去时**留下了两步向导**，
   *    见 `store.ts` 里 `DownloadTab` 上那段说明。）
   */
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
  const { state, go, dismissToast, closeVersion, setSubPage, open, setLaunchTarget } =
    useApp();
  const [stopping, setStopping] = useState(false);
  /** 顶栏的账号弹窗（正版登录入口） */
  const [accountOpen, setAccountOpen] = useState(false);

  /*
   * ★★ 2026-09-24（A-1 修复）：**把 `ieml:launch-request` 的监听提到常驻层**。
   *
   *   缺陷原状：三个地方（实例侧栏「启动这个版本」、版本列表行的「启动」、概览页「启动」）
   *   都 `window.dispatchEvent(new CustomEvent('ieml:launch-request'))`，
   *   而**唯一的监听方在 `LaunchPage` 里** —— 它只在 `state.page === 'launch'` 时挂载。
   *   于是在版本列表/概览上点「启动」：菜单关掉、什么都没有。
   *   真机判据：那一页 `getEventListeners(window)['ieml:launch-request'].length === 0`。
   *
   *   现在监听挂在这里（AppShell 一直在），做的事情和以前**一模一样**：
   *   定目标 → 切到启动页 → 等那个按钮出现后点它。
   *   ★ **不在这里复制第二份启动逻辑** —— 真正的启动入口始终只有
   *     `LaunchPage` 里那一个（`#ieml-launch-btn`），否则又是"同一件事两处实现"。
   */
  useEffect(() => {
    const onLaunchRequest = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      setLaunchTarget(id);
      go('launch');
      /* 等启动页挂载（原来写死 120ms；这里改成轮询，最多等 2 秒） */
      let tries = 0;
      const tick = window.setInterval(() => {
        const btn = document.getElementById('ieml-launch-btn') as HTMLButtonElement | null;
        if (btn && !btn.disabled) {
          window.clearInterval(tick);
          btn.click();
          return;
        }
        tries += 1;
        if (tries > 20) window.clearInterval(tick);
      }, 100);
    };
    window.addEventListener('ieml:launch-request', onLaunchRequest);
    return () => window.removeEventListener('ieml:launch-request', onLaunchRequest);
  }, [go, setLaunchTarget]);

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

  /*
   * ★★ 2026-09-24（C-7 修复）：这里原来有个「最近玩过」块 ——
   *   它按 `lastPlayedAt` 排序取最近两个版本，而那个字段**全仓库没有写入方**：
   *   `AppContext` 在 2026-09-16 按用户要求「'从未启动'相关的记录时间的功能，删掉」
   *   **停止写**它（新建/复制/整合包建实例一律写 null），字段只是留在类型里不动。
   *   于是那个块**永远不会渲染**：一段死代码 + 一份假承诺（注释里写着"点一下直接进它"）。
   *
   *   ★ 修法是**删掉它**，而不是"重新开始写 lastPlayedAt" ——
   *     那等于把用户明确删掉的功能又加回来。
   *   ★ 侧栏下半部分那三个直达动作（打开数据目录 / 全部版本 / 关于）是真的，保留。
   */

  /*
   * ★★ 2026-09-22：这里原来有个 `openDataDir()`（侧栏「数据目录」按钮用它打开资源管理器）。
   *   用户要求那一项改成「更新日志」页，于是它没有调用方了。
   *   **能力没丢**：设置页「存储 → 数据目录」那行的「打开」按钮走的是同一条 Rust 命令。
   */
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

  /**
   * 顶部玻璃的"滚动后淡入"开关（`<html>.is-scrolled`）。
   *
   * ★ 抄用户网站 `nav-glass.js` 的两处选择，理由它都写了：
   *   · **不监听 scroll 事件**：在页面顶部放一个 80px 的哨兵元素，用
   *     `IntersectionObserver` 观察它 —— "比监听 scroll 事件更省（不占主线程），
   *     也不受 rAF 节流影响"；
   *   · 只给 `<html>` 加一个类，**玻璃本身的淡入交给 CSS 只过渡 opacity**
   *     （"直接过渡渐变背景是动画不起来的"）。
   */
  useEffect(() => {
    const root = document.documentElement;
    const THRESHOLD = 8; // 页头本身约 52px 高，稍微一滚就该出现玻璃
    const apply = (on: boolean) => root.classList.toggle('is-scrolled', on);

    if (typeof IntersectionObserver === 'function') {
      const sentinel = document.createElement('div');
      sentinel.className = 'top-glass-sentinel';
      sentinel.setAttribute('aria-hidden', 'true');
      /*
       * ★★ 哨兵必须是**在流内**的元素（`height` 撑出一点高度、再用负 margin 抵消），
       *   不能是 `position: absolute` —— 这个是踩出来的：
       *   `.content` 自己**没有定位**，绝对定位的哨兵会相对更外层的祖先定位，
       *   于是它**根本不随内容滚动**，永远停在视口里，
       *   `is-scrolled` 一辈子是 false（顶部玻璃也就永远不淡入）。
       *   在流内 + 负 margin = 跟着内容滚、又一点都不占视觉空间。
       */
      sentinel.style.cssText = `height:${THRESHOLD}px;margin:0 0 -${THRESHOLD}px 0;width:100%;pointer-events:none;opacity:0`;
      // 哨兵要挂在**滚动容器内部**（挂在 body 上永远不滚）
      const content = document.querySelector('.content');
      (content ?? document.body).insertBefore(sentinel, (content ?? document.body).firstChild);
      const io = new IntersectionObserver((entries) => apply(!entries[0]?.isIntersecting), { threshold: 0 });
      io.observe(sentinel);
      // 页面切换（换页签）时哨兵会重建 → 顺手同步一次
      const mo = new MutationObserver(() => {
        const c = document.querySelector('.content');
        if (c && !c.querySelector('.top-glass-sentinel')) {
          c.insertBefore(sentinel, c.firstChild);
          io.observe(sentinel);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return () => {
        io.disconnect();
        mo.disconnect();
        sentinel.remove();
        apply(false);
      };
    }

    // 回退：scroll 监听（rAF 节流）
    const content = document.querySelector('.content');
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        apply((content?.scrollTop ?? window.scrollY) > THRESHOLD);
      });
    };
    (content ?? window).addEventListener('scroll', onScroll, { passive: true });
    return () => (content ?? window).removeEventListener('scroll', onScroll);
  }, []);

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
      {/*
        ★★ 顶部液态玻璃（2026-09-22，用户：「顶栏的大黑底好丑，顶部也要液态玻璃」）。

        它是**独立的一个 fixed 层**，不是页头自己的背景：
          · fixed 在视口坐标系里，`backdrop-filter` 能真的采到背后的滚动内容
            （第三轮实测：粘性定位的页头采不到 —— 同一段 CSS 放 sticky 里
             什么都不做，放 fixed/普通元素里就能糊）；
          · **顶部时完全透明**，滚过阈值才淡入（`.is-scrolled`）——
            照搬用户网站 nav-glass.js 的做法，它注释里写着"页面顶部时导航完全透明"，
            以及"只过渡 opacity，直接过渡渐变背景是动画不起来的"。
        阈值哨兵与 `is-scrolled` 在下面的 effect 里挂（用 IntersectionObserver，
        不占主线程，也不受 rAF 节流影响 —— 同样抄自 nav-glass.js）。
      */}
      <div className="top-glass" aria-hidden="true" />
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

        {/*
          ★★ 2026-09-22 用户：「把账号按钮放到最底部，点击可以向上展开」。
          那个胶囊**已经撤掉** —— 账号入口现在只有一处（侧栏底部 `AccountMenu`）。
          ★ 为什么不是两处都留：同一个动作有两个入口，用户会以为它们是两件事
            （这个仓库在"正版登录有两个关闭键"那件事上已经吃过一次亏）。
          顶栏这一行现在只有：更新角标 → 任务中心 → 窗口按钮。
        */}

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

              {/*
                ★★ 2026-09-24（用户截图 +「**这两个启动键都不要**」）：
                  这里原来有一个「启动这个版本 / 停止游戏」按钮，被删掉了。
                  同一个动作在界面上有三处入口（版本列表行菜单、实例概览页头、这里），
                  用户明确不要这两个 —— 启动请走「版本列表 → 启动」。
                  ★ 停止游戏的能力**没有丢**：启动页上有「停止游戏」，
                    下面主导航侧栏底部那份"正在运行的版本"列表里每个也都能单独停
                    （`handleStopOne` / `stopping` 仍然被那份列表用着）。
              */}
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
                  · 三个直达动作 —— 打开数据目录 / 全部版本 / 关于
                一个版本都没有时整块不渲染（不留空标题）。
                ★★ 2026-09-24（C-7）：原来这里还有个「最近玩过」，
                  它依赖一个**永远为 null** 的字段（见上面那段说明）→ 已删。
              */}

              {/*
                ★★ 2026-09-22 用户：「左侧栏的数据目录改成更新日志…关于与设置，改成关于，
                  给关于单独做一页面」。
                  · 「数据目录」原来是**打开资源管理器**（不是页面）—— 现在换成「更新日志」页；
                    打开目录的能力没丢：设置页那一行的「打开」按钮还在。
                  · 「关于与设置」原先是跳到设置页 → 现在有自己的页面。
              */}
              <div className="side-links">
                {/*
                  ★★ 2026-09-23 用户：「**更新日志、关于没有选中提示**」——
                    这两个入口原来完全没有 active 状态：点进去之后侧栏上看不出自己在哪一页
                    （左边那一列主导航一直有高亮，这两项却没有，对比之下更像"没生效"）。
                  ★ 用 aria-current 而不是只加一个 class：读屏也要能听出"这是当前页"。
                */}
                <button
                  type="button"
                  className={'side-link' + (state.page === 'changelog' ? ' on' : '')}
                  aria-current={state.page === 'changelog' ? 'page' : undefined}
                  onClick={() => go('changelog')}
                >
                  <IconLayers /> 更新日志
                </button>
                <button
                  type="button"
                  className={'side-link' + (state.page === 'about' ? ' on' : '')}
                  aria-current={state.page === 'about' ? 'page' : undefined}
                  onClick={() => go('about')}
                >
                  <IconInfo /> 关于
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
            {/*
              ★★ 2026-09-22 用户：「把账号按钮放到最底部，点击可以向上展开」。
              ★ 位置放在**侧栏最外层**（</nav> 之后、</aside> 之前）——
                因为侧栏里有两套底栏（实例页一套、普通页一套），
                账号入口只该有一处，而且两种状态下都要在。
            */}
            <AccountMenu onOpenAccount={() => setAccountOpen(true)} />
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
          {/*
            ★ 2026-09-23 晚：安装游戏**并回**下载页（第一个页签），
              这里不再有 `state.page === 'install'` 那一行。
          */}
          {state.page === 'settings' && <SettingsPage />}
          {state.page === 'changelog' && <ChangelogPage />}
          {state.page === 'about' && <AboutPage />}
          {/* C5：资源的独立安装页 */}
          {state.page === 'resource' && <ResourceInstallPage />}
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
          /*
           * ★ 2026-09-22（用户：「这个提示，消失时没动画」）：
           *   退场靠 **两段式移除** —— `t.leaving` 为真时挂上 `.leaving`，
           *   CSS 跑淡出动画；动画走完（200ms）AppContext 才真的把这条从数组里删掉。
           *   直接删 = 元素当场卸载 = 没有任何退场动画可看。
           */
          <div key={t.id} className={`toast toast-${t.kind}${t.leaving ? ' leaving' : ''}`}>
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
