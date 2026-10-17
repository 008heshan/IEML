/**
 * 下载页（一级页）
 * ------------------------------------------------------------------
 * 六个页签（0.1.0-rc.1）：
 *   安装游戏 · 整合包 · Mod · 资源包 · 光影 · 数据包
 *
 * ★★ 2026-09-23 晚（用户）：「**把安装版本合并到下载里**」——
 *   「安装游戏」从独立页搬回本页的**第一个页签**（侧栏不再有那一格）。
 *   搬回来的是**两步向导**（第 1 步选版本 / 第 2 步选加载器，见 `InstallComposer`），
 *   不是原来那个一屏两层导航的安装器 —— 所以"合回来"没把"繁乱"一起带回来。
 *
 * ★★ 后四格（Mod / 资源包 / 光影 / 数据包）都是**同一个资源中心**
 *   （`ResourceCenterBody`），只是换了个种类。用户的原话是"下载页里的
 *   mod 列表应该是显示 mod，不要显示版本"—— 旧的第三格列的是每个版本
 *   各装了什么，那是"已有"，而这一页要回答的是"能装什么"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useBackTarget } from '../state/back-nav';
import { Button, Chip, CustomSelect, EmptyState, Note, Segmented, Spinner } from '../ui';
import { IconAlert, IconChevronUp, IconDownload, IconFolder, IconLayers, IconPuzzle, IconRefresh, IconImage, IconGrid, IconRows, IconPackage, IconSearch } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { useTabIndicator } from '../hooks/useTabIndicator';
import type { DownloadTab } from '../state/store';
import { takePendingPack } from '../state/pending-pack';
import { InstallComposer } from '../components/InstallComposer';
import { Pager } from '../components/Pager';
import { ResourceCenterBody, VersionPicker } from '../components/ResourceBrowser';
import { autoMemory, compareVersion, isSnapshotVersion, knownVersions } from '../domain';
/*
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部，并且默认为全部，
 *   这样即使有资源里不允许第三方下载，也可以得到互补了」。
 *
 *   整合包这一页与资源中心**共用同一份判据**（`domain/resource-merge.ts`）：
 *   合并、去重、优先级、排序都在那里，这里只负责"查哪些源、把结果画出来"。
 */
import { mergeHits, pagesFromBoth, sortHits } from '../domain/resource-merge';
import type { MergedHit, SourceChoice } from '../domain/resource-merge';
/*
 * ★★★★ 2026-10-17（取版本互补 —— `resource-merge` 留下的那个缺口）：
 *   合并后取版本原来只走 `preferred`（能下载的那一份）；那一份没有能装到当前
 *   实例的版本（或问不到）时界面显示「无」，而另一个来源明明有。
 *   判据在 `domain/version-sources.ts`（纯函数，可注入假 fetch 真跑）。
 */
import { lookupVersionsFrom, versionSourcesToTry, versionSourceNote } from '../domain/version-sources';
/*
 * ★「这一份有没有能装到当前实例的版本」= 版本列表筛选的**同一段实现**
 *   （`hasCompatibleVersion` → `strictlyCompatibleVersions`），不另写一套口径。
 */
import { hasCompatibleVersion } from '../components/version-filter';
// ★ C-26：取消不是故障 —— 判据只有一处（见 `domain/cancel.ts` 的说明）
import { isCancellation } from '../domain/cancel';
/*
 * ★★ 2026-10-16 事故（"漏下 mod 却报安装完成"）用到的两条纯规则：
 *   · `missingSummary` —— 后端 `missing_summary` 的同一套措辞（这里只在
 *     后端没给（老版本 / 演示模式）时兜底）；
 *   · `repairEntry`    —— "要不要给「重新下载」按钮、怎么说"，
 *     全是只能人工下的那种**不许给按钮**（点了必然失败）。
 *   两者都有 `tests/pack-missing.test.mjs` 钉着。
 */
import { missingSummary, repairEntry } from '../domain/pack-missing';
/*
 * ★★★★ 2026-10-17（用户：「装完了但缺 N 个文件」）：收尾那三句话的**唯一判据**。
 *
 *   后端现在给档位结论（`tier` = `complete` / `partial` / `null`），
 *   而 `partial` **也算成功**（实例照建）—— 于是"任务卡片标题 / toast /
 *   页面提示"三处都必须说"装好了，但缺 N 个"，**不许**说"安装完成"。
 *   三处各写各的必然分叉，所以算一次、三处取同一个值。
 */
import { installSummary } from '../domain/install-summary';
import type { InstallSummary } from '../domain/install-summary';
/*
 * ★★ 2026-10-17（用户：「curseforge 的整合包，不显示整合包的模组加载器类型」）：
 *   整合包卡片上"加载器"那一格的判据（值 → 规范串 | **null**）。
 *   提出来是为了：① 取不到时**不渲染那一格**（而不是显示一个假的 `—`）；
 *   ② 它能被 `tests/pack-loader.test.mjs` 真跑着钉住。
 */
import { packLoaderOf } from '../domain/pack-loader';
import type { Instance } from '../domain';
import type {
  ModrinthVersion,
  ModpackInstallResult,
  PackMissingFile,
  ResourceKindName,
} from '../bridge/tauri';
import { registerTaskReplay } from '../flows/install';

/**
 * 由**字节数**算剩余秒数（拿不到就返回 0 = 界面不显示这一项）。
 *
 * ★★★★ 2026-10-07（用户截图：「这个下载显示，有bug啊，信息不全」）：
 *   加它是因为界面上那一行原来**根本不显示**，而另有一处（`bridge/tauri.ts`）
 *   用文件数算剩余时间 —— 那个式子写的是
 *   `(totalFiles - finishedFiles) * 0 + 30`，**恒等于 30 秒**：
 *   不是估算，是写死的。
 *
 *   ★ 为什么必须按字节算：一个 66 MB 的整合包体几乎全花在**单个文件**上，
 *     文件数在那几分钟里不动 —— 拿它算出来的"剩余时间"没有任何意义。
 *   ★ 拿不到总字节数（老后端 / 还没上报）⇒ 返回 0，**界面宁可不显示**，
 *     也不显示一个假数字。
 */
function etaOfBytes(
  bytesPerSecond: number | undefined,
  finishedBytes: number | undefined,
  totalBytes: number | undefined,
): number {
  const bps = bytesPerSecond ?? 0;
  const done = finishedBytes ?? 0;
  const total = totalBytes ?? 0;
  if (bps <= 0 || total <= done) return 0;
  return Math.round((total - done) / bps);
}

/** 后四格页签 ↔ 资源种类（**一一对应**，界面不自己编种类） */
const RESOURCE_TABS: Array<{ tab: DownloadTab; kind: ResourceKindName; label: string }> = [
  { tab: 'mod', kind: 'mod', label: 'Mod' },
  { tab: 'resourcepack', kind: 'resourcepack', label: '资源包' },
  { tab: 'shader', kind: 'shader', label: '光影' },
  { tab: 'datapack', kind: 'datapack', label: '数据包' },
];

/** 整合包每页几个（写死的 20 个 = "没有翻页"，见 `load`） */
const PAGE_SIZE = 20;

/**
 * 整合包筛选用的加载器列表。
 *
 * ★ 只列**整合包真的会用**的那几个：整合包本质是"一整套 Mod + 配置"，
 *   光影/资源包那类加载器（OptiFine / LiteLoader）不是它的载体。
 */
const PACK_LOADERS: Array<{ value: string; label: string }> = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'quilt', label: 'Quilt' },
];

/**
 * 每种资源装进哪个目录 —— 与 Rust 侧 `ResourceKind::install_dir` **逐条对齐**。
 * 这里只用于界面**显示**（"装到哪个目录"），安装本身仍然由后端决定路径。
 */
const RESOURCE_DIR: Record<ResourceKindName, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
  /*
   * ★★ 2026-09-23：整合包**不装进目录**（它的安装是"建一个实例"）——
   *   这里给空串，与后端 `ResourceKind::install_dir()` **同口径**。
   *   两边不一致的话，界面会显示一个根本不存在的目录。
   */
  modpack: '',
};

/**
 * 回到顶部（右下角那个圆钮）。
 * ------------------------------------------------------------------
 * ★★ 2026-10-08 晚（用户：「给下载页除了版本下载之外的页面，在启动器右下角加一个
 *   一键回到顶部的按键，就像 dsh 的这个一样」）。
 *
 * ## 三个决定，都是量出来的
 *
 *   ① **滚的是 `.content`，不是 `window`**：这个启动器全仓只有一个滚动容器
 *      （`<main className="content">`，见 AppShell）。窗口本身不滚 ——
 *      所以 `window.scrollTo` 在这里什么都不会发生。
 *   ② **只在滚下去之后才出现**：停在顶部时它按下去没有任何效果，
 *      那种"永远挂在那里、点了不动"的按钮不如不挂。
 *      阈值取 320px（比页头那 74px 大一截，第一屏之内不会冒出来）。
 *   ③ **低动效档不做平滑滚动**：`lite` 承诺"不动"（见 ui/motion.ts），
 *      给它一段 scroll 动画等于当场违背那一档的承诺。
 *
 * ★ 为什么 `position: fixed` 在这里是安全的：它是 `.page-fill` 的**直接子元素**，
 *   而 `.page-fill` 自己不带 `transform` / `filter` / `will-change`
 *   （2026-09-24 起它被**有意**排除在入场动画之外，见 app.css 那段注释），
 *   所以 fixed 的包含块仍然是视口 —— 不会被内容区裁掉、也不会跟着滚动跑。
 */
function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = document.querySelector('.content');
    if (!el) return;
    const sync = () => setShow(el.scrollTop > 320);
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      className="to-top"
      aria-label="回到顶部"
      onClick={() => {
        const el = document.querySelector('.content');
        if (!el) return;
        const lite = document.documentElement.dataset.motion === 'lite';
        el.scrollTo({ top: 0, behavior: lite ? 'auto' : 'smooth' });
      }}
    >
      <IconChevronUp />
    </button>
  );
}

export function DownloadPage() {
  /* ★ 2026-09-23：「装到」选择器已删 → setDownloadTarget 没有调用方了（不留未用变量） */
  const { state, go, toast, setDownloadTab } = useApp();
  const { isDesktop } = useRealApi();
  const tab = state.downloadTab;
  /* ★ 页签下面那条会滑的指示条（量的是 `aria-selected` 那一个，见 hook 的说明） */
  const tabInd = useTabIndicator(tab);

  /* 其他页面可以通过事件切换页签 */
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent<DownloadTab>).detail;
      if (t) setDownloadTab(t);
    };
    window.addEventListener('ieml:download-tab', onTab);
    return () => window.removeEventListener('ieml:download-tab', onTab);
  }, [setDownloadTab]);

  /*
   * 资源要装进**某个**实例里（mods/ resourcepacks/ shaderpacks/ datapacks/
   * 都是实例目录下的子目录）。下载页没有"当前版本"这个上下文，所以给一个
   * 显式选择器：默认挑最近玩过的那个（最可能就是玩家现在要装的），
   * 玩家随时能换 —— **不替他决定**，但也不让他每次重选。
   */
  /*
   * ★★ **记住玩家上次选的版本**（用户 2026-09-16："要记得玩家最后一次选的是哪个版本，
   *   而不是每次都得重新选"）。
   *   初值从 localStorage 读 —— 重启启动器不用再选一次。
   *   ★ 选中的那个实例可能已经被删了：下面 `target` 的 useMemo 里会用
   *     `state.instances.find(...)` 找不到就回退到"最近玩过的"，所以不会指向空气。
   *
   * ★ 2026-09-17：**不再是 state**（原来是 `useState` + `setTargetId`）。
   *   唯一会改它的两处都已经搬走：
   *     · 上面那个「装到」选择器 → 改写全局的 `downloadTargetId`；
   *     · `ieml:download-target` 事件监听器 → 已删除（全仓库无派发方）。
   *   所以它现在只是"上次留下的值"，读一次就够，不需要 setter。
   *   （这正是原来那个 setter 会变成 TS6133 的原因。）
   */
  const rememberedTargetId = useRef<string | null>(
    localStorage.getItem('ieml.downloadTarget'),
  ).current;
  /*
   * ★★ 别的页面可以把"装到哪个版本"带过来（用户 2026-09-15：
   *   "添加 mod 的按钮应该直接跳转下载页的 mod 页，并默认选择该跳转版本"）。
   *
   *   从「Mod 管理 → 添加 Mod」进来时，用户心里想的是**手上这个版本**，
   *   而下载页默认挑的是"最近玩过的那个" —— 很可能不是它，
   *   于是他会把 Mod 装到另一个版本上（而且一眼看不出来）。
   *
   * ★ 2026-09-17：这件事**不再走 `ieml:download-target` 事件**。
   *   原来的实现是一个挂在挂载后 effect 里的监听器 —— 而调用方
   *   （版本列表 / 概览页 / Mod 管理）跳过来时**本页还没挂载**，
   *   事件当场被丢掉，于是"默认选中该版本"一直是坏的，装错版本且看不出来。
   *   现在改为读 `state.downloadTargetId`（见下面 `target` 的说明与 `store.ts`），
   *   三个调用方也一并换成了 `goDownloadFor`。那个监听器因此已删除 ——
   *   全仓库已无任何地方派发该事件。
   */

  const target = useMemo(() => {
    if (state.instances.length === 0) return null;
    /*
     * ★★ 优先级：**别的页面明确指定的** > 玩家在下载页选过的 > 最近玩过的。
     *
     *   第一项刻意走 `state.downloadTargetId` 而**不是** `ieml:download-target` 事件：
     *   事件在本页挂载前就发了会被丢掉（从版本列表点「安装 Mod」时正是这种情形），
     *   于是玩家选的版本白选、Mod 装到别的版本上，且界面看不出来。
     *   详见 `store.ts` 里 `downloadTargetId` 的说明。
     *
     *   ★ 跳转与手动改选写的是**同一个字段**，所以这里不需要额外的同步 effect，
     *     也不会出现两个值打架。
     */
    const forced = state.downloadTargetId
      ? state.instances.find((i) => i.id === state.downloadTargetId)
      : null;
    if (forced) return forced;

    /*
     * ★★ 2026-09-23 用户（第 2 条）：「我想要下载资源时，**直接放入主页选中的版本**，
     *   不需要在下载页再选」。
     *
     *   所以这里排在"下载页记住的那个"**之前**：主页选中的那个版本就是"我现在要玩的"，
     *   资源当然装给它。★ 上面那个 `downloadTargetId` 仍然优先 —— 那是**别的页面明确指定**的
     *   （比如从版本列表点「安装 Mod」），比"主页当前选中"更具体。
     */
    const homePicked = state.lastInstanceId
      ? state.instances.find((i) => i.id === state.lastInstanceId)
      : null;
    if (homePicked) return homePicked;

    const picked = rememberedTargetId
      ? state.instances.find((i) => i.id === rememberedTargetId)
      : null;
    if (picked) return picked;
    const byTime = [...state.instances].sort((a, b) =>
      (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''),
    );
    return byTime[0] ?? null;
  }, [state.instances, state.downloadTargetId, state.lastInstanceId, rememberedTargetId]);

  /*
   * ★ 记住玩家选的版本（下次打开还是它，不用再选一次）—— 见上面 targetId 的说明。
   *   ★ 存的是**实际生效的那个**（`target`），不是"手动选过的那个"（`targetId`）：
   *     从 Mod 管理页跳过来时目标是被事件设的，那种也要记住。
   *   ★ 位置必须在 `target` 之后声明 —— 否则 `target` 还没初始化就被读了（TDZ）。
   */
  useEffect(() => {
    if (target) localStorage.setItem('ieml.downloadTarget', target.id);
  }, [target]);

  const tabs: Array<{ key: DownloadTab; label: string; icon: React.ReactNode }> = [
    /*
     * ★★ 2026-09-23 晚（用户）：「把安装版本合并到下载里」——
     *   「安装游戏」回到**第一格**（当天早些时候它被搬去独立页，现在合并回来）。
     *   ★ 合并回来的是**两步向导**，所以这一格自己只有"选版本 / 选加载器"两屏，
     *     不再是一屏里塞下版本清单 + 加载器 + 附加组件 + 名称的那种"繁乱"。
     */
    { key: 'game', label: '安装游戏', icon: <IconDownload /> },
    { key: 'modpack', label: '整合包', icon: <IconPackage /> },
    { key: 'mod', label: 'Mod', icon: <IconPuzzle /> },
    { key: 'resourcepack', label: '资源包', icon: <IconImage /> },
    { key: 'shader', label: '光影', icon: <IconLayers /> },
    { key: 'datapack', label: '数据包', icon: <IconGrid /> },
  ];

  const resourceTab = RESOURCE_TABS.find((r) => r.tab === tab) ?? null;

  /*
   * ★★ 2026-09-23 用户（两张截图对比）：「**mod 页面会进入自己的专属页，是一个全屏页，
   *   为什么整合包的还会显示**（下载页的头和页签）？」
   *
   *   原因：Mod / 资源包 / 光影 / 数据包走的是**独立路由**（`state.page === 'resource'`），
   *   整屏替换内容区；而整合包的安装页是"下载页内的切换视图" ——
   *   所以下载页的**页头与页签还留在上面**。
   *
   *   用户要的是**看起来一样**：进入整合包安装页时，把页头与页签一起收起来。
   *   ★ 这里只改"显示什么"，不动安装流程（那一份实现仍然只有一处）。
   */
  const [inModpackInstall, setInModpackInstall] = useState(false);

  /*
   * ★★ 2026-09-23 晚（用户）：「给模组加载器**像 mod 页那样单开一页**」——
   *   「模组加载器」那一屏也是整屏的一页（自带页头 + `← 返回` + 底部动作条），
   *   所以下载页这边同样要把页头与页签收起来（**与整合包同一套做法**）。
   *   ★ 组件里只通知"现在在哪一屏"，收不收由本页决定 —— 显示与流程分开。
   */
  const [inLoaderPage, setInLoaderPage] = useState(false);

  /* 切到别的页签时要把"正在安装页"重置，否则回来会只剩一个安装视图 */
  useEffect(() => {
    if (tab !== 'modpack') setInModpackInstall(false);
    if (tab !== 'game') setInLoaderPage(false);
  }, [tab]);

  /*
   * ★★★★ 2026-10-08 晚（用户两张截图：「**上下页太靠底边**」+
   *   「**下载文本会被拉上去，只剩下大模糊底**」）。
   *
   *   ## 这两个现象是**同一个根因**：`.page-fill` 的高度被卡死在 100%
   *
   *   它的盒子恒等于内容区可视高度（真机 1180×760 上实测 **652px** = 712 − 20 − 40），
   *   于是：
   *     · 吸顶的 `.page-head` 只能在这个盒子里待着 ⇒ 往下滚超过一屏，
   *       页头（连着「下载」两个字）被盒子推出去，顶上只剩那条毛玻璃 —— 第二条；
   *     · 列表页签里 `.res-center` 是 flex 子项且 `min-height: 0` ⇒ 被挤扁，
   *       分页条的下边距**整个掉到可滚动区之外** ⇒ 分页条到窗口下沿 **0px** —— 第一条。
   *   整包页签的容器不是 flex 子项、挤不扁 ⇒ 它的 8px 还在
   *   —— 用户说"整包的留白不错"，他看到的对照组就是这 8px。
   *
   *   ★ 所以**除了「安装游戏」那两屏**，下载页其余每一屏都解开（`data-fill="auto"`，
   *     见 app.css 那段）：列表页（整合包 / Mod / 资源包 / 光影 / 数据包）与
   *     整合包的安装页都是**正常滚动的页**，它们都该看得见「下载」这两个字。
   *   ★★ 但「安装游戏」那一屏（选版本 / 选加载器）**不能解**：它的版本清单靠
   *      `.page-fill(100%) → .cw-shell-page(flex:1) → .cw-body` 这条弹性链
   *      被约束在视口内、自己滚。真机量过解开之后的样子：
   *      清单容器 385px → **697px**（长成内容那么高）、整页从"不滚"变成滚 1023px。
   *      （它里面的版本清单另有 `max-height: 46vh` 自己滚的，如整合包安装页那张表 ——
   *       那种不依赖这条链，所以不受影响。）
   */
  const listFill = tab !== 'game';

  return (
    <div className="page-fill" data-fill={listFill ? 'auto' : undefined}>
      {/*
        ★★★★ 2026-10-08（用户：「**既然做了底部模糊，文字就不改收上去**」）。

          ⇒ 页头（「下载」+ 副标题）**一直显示**，不再跟着整合包流程收起来。

        ## 这一格反复过三次，把结论钉在这里

          ① 最初：`{inModpackInstall || inLoaderPage ? null : (页头 + 页签)}`
             —— 进整合包流程时**连页头一起收掉**；
          ② 0.19.10：按用户字面「让下载这个文字常驻」改成**常驻**；
          ③ 0.19.12：用户说「下载文本收上去的问题还是没解决」，
             我理解成"要和别的页签一致"，于是**又收起来**（判据与页签相同）；
          ④ **现在**：用户明确说「**既然做了底部模糊，文字就不改收上去**」
             —— 也就是**要常驻**。

        ## 为什么"常驻"才是对的（这次的理由和②不同）

          底部做了模糊（毛玻璃）之后，页面顶上那一行**不再需要靠"收起来"
          来省空间** —— 视觉重心已经在底部，页头留着反而给用户一个
          "我在下载页"的锚点。所以"与别的页签一致"这条理由让位于
          "用户要看得见自己在哪一页"。

          ★ 页签（Mod / 资源包 / …）**仍然收起**：整合包安装页有它自己的
            「返回整合包列表」导航，再挂一排一级页签会变成两条互相竞争的导航。
            收页签、留页头 —— 这两件事从此分开判断，不再捆在一个条件里。

        ★★★★ 2026-10-08 晚：③ 那次（以及用户说的"文字会被拉上去"）**根本不是
          这一格在不在 DOM 里** —— 真凶是 `.page-fill` 的高度卡死把吸顶的页头
          推出了视野（见上面 `listFill` 那段：实测滚到底时标题上沿 −523 / −918px）。
          也就是说：**只要不改那个高度，把它留在 DOM 里多少次都没用**；
          而改对之后，这一格留在这里正好（用户要的那个锚点真的能看见了）。
          上面"反复过三次"的结论仍然成立，只是它当时**解释错了原因**。
      */}
      <div className="page-head">
        <div>
          <h1 className="page-title">下载</h1>
          <p className="page-desc">游戏版本 · 整合包 · Mod · 资源包 · 光影 · 数据包</p>
        </div>
        {!isDesktop ? <Chip tone="warning">浏览器演示模式 —— 真实下载要桌面版</Chip> : null}
      </div>

      {inModpackInstall || inLoaderPage ? null : (
        /*
         * ★★ 2026-10-16（用户：「做一个滑动 tab 的效果，切换 tab 的时候下面的指示条
         *   同步滑动，明确栏目的变化」）：
         *   选中态不再由每个页签自己画一条下划线，而是这条栏里**唯一**的那个
         *   `.tab-ind` —— 它的位置与宽度由 `useTabIndicator` 量出来（六个页签宽度
         *   不一样，纯 CSS 做不到"移到谁那儿、变成谁那么宽"）。
         */
        <div className="tabs" role="tablist" aria-label="下载内容" ref={tabInd.ref}>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tab${tab === t.key ? ' on' : ''}`}
              onClick={() => setDownloadTab(t.key)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
          {/* 还没量到（首帧）时不渲染：新挂上去的元素不会从最左边滑过来 */}
          {tabInd.style ? (
            <span className="tab-ind" aria-hidden="true" style={tabInd.style} />
          ) : null}
        </div>
      )}

      {/*
        ★★ 第一格：安装游戏。
        ★ 它自己**不带页头**（下面那一屏「模组加载器」才带自己的页头）——
          本页的页头与页签就是它在版本清单那一屏的外壳。
        ★ 点一行版本 → 进「模组加载器」整屏页 → `onStepChange(true)` 让本页
          把页头与页签收起来（与整合包安装页同一套）。
      */}
      {tab === 'game' ? (
        <InstallComposer
          variant="page"
          onStepChange={setInLoaderPage}
          onInstalled={() => {
            toast('info', '已加入版本列表', '去「版本列表」双击它就能进设置或启动。');
            go('versions');
          }}
        />
      ) : tab === 'modpack' ? (
        <ModpackTab
          go={go}
          toast={toast}
          onInstallViewChange={setInModpackInstall}
          target={target}
        />
      ) : resourceTab ? (
        <>
          {/*
            装到哪个版本：下载页没有"当前版本"，所以这里显式选一个。
            ★ 没有版本时**不让装**，也不假装能装 —— 直接说清先做什么。
          */}
          {state.instances.length === 0 ? (
            <EmptyState
              title="还没有任何版本"
              desc="资源要装进某个版本的目录里，所以先在「安装游戏」里装一个版本。"
              actions={
                /* ★ 2026-09-23 晚：安装游戏就是本页第一格 → 切页签即可，不用跳页 */
                <Button variant="primary" onClick={() => setDownloadTab('game')}>
                  去安装游戏
                </Button>
              }
            />
          ) : (
            <>
              {/*
                ★ 「装到哪个版本」这一行（用户要求："选择游戏版本的那个栏可以再大一点，
                尤其是版本那里，很费眼，太小了"）。

                ★★ 同时去掉两样东西（用户："下载页上下重复，还有这里的『管理这个版本的资源』
                也去掉，这是无意义的"）：
                  · 「管理这个版本的资源」—— 它只把人送回版本列表，而**上面那排页签
                    已经能做同一件事**（选版本就在这一行），是个绕路按钮；
                  · 内层的 Mod / 资源包 / 光影 / 数据包 四个页签 —— 与最外层那排**完全重复**。
                    所以给 ResourceCenterBody 传 `hideKindTabs`，只留来源切换（Modrinth/CurseForge）。

                ★★ 2026-09-17 起这一行的职责**只剩"装到哪去"**：搜什么由下面那排的
                  「版本 / 加载器」两个筛选器回答（玩家的选择，默认「不限」）。
                  以前这两件事是同一件事 —— 于是"我想看看 1.20.1 的 Forge 有什么 Mod"
                  这个再正常不过的念头，在这一页根本表达不出来。
              */}
              <div className="res-target">
                {/*
                  ★★ 2026-09-23 用户（截图 + 「**这个就不需要了**」）：
                    把「装到」这个**选择器**去掉了 —— 下载资源时**直接用主页选中的那个版本**，
                    不需要在下载页再选一次（`target` 的优先级链里已加 `lastInstanceId`）。
                  ★ 下面那句"装到「X」的 mods 目录"**留着**：它不是控件，
                    而是回答"文件到底落到哪个目录"（用户 2026-09-16 提过"不知道下到哪里去了"）。
                */}
                {/*
                  ★★ **说清"装到哪去"**（用户 2026-09-16：
                    "下载页下载资源，没选版本也能下载，但不知道下到哪里去了"）。
                  这一行把**实例 + 目录**都写出来；没有可用实例时直接说清"装不了"，
                  而不是让他点完才发现不知道去哪了。
                */}
                {target ? (
                  <span className="res-target-where">
                    装到「{target.config.name}」的{' '}
                    <b className="mono">{RESOURCE_DIR[resourceTab.kind]}</b> 目录
                  </span>
                ) : (
                  <span className="res-target-where warn">
                    还没有可以装入的版本 —— 先去「版本列表」新建一个
                  </span>
                )}
              </div>
              <ResourceCenterBody
                kind={resourceTab.kind}
                onKindChange={(k) => {
                  const next = RESOURCE_TABS.find((r) => r.kind === k);
                  if (next) setDownloadTab(next.tab);
                }}
                instance={target}
                toast={toast}
                hideKindTabs
                /*
                 * ★★ 给「游戏版本 + 模组加载器」两个筛选器（用户 2026-09-17：
                 *   "下载页下载资源我想要可以选择版本（不给推荐版本）同时能选择
                 *    模组加载器，这俩可以叠加，做到『选择资源来源』的左边吧"）。
                 *
                 *   给了之后，"搜什么"由玩家自己那两个下拉决定，**不再**由
                 *   上面「装到」的那个实例决定 —— 上面那行只回答"装到哪去"。
                 *   两边对不上时，筛选器旁边会出现一枚警告（见 ResourceCenterBody
                 *   的 `mismatch`）：装错版本的那种事故不能只靠"一眼看不出来"。
                 */
                gameFilters
              />
            </>
          )}
        </>
      ) : null}

      {/*
        ★★ 回到顶部（用户 2026-10-08 晚：「给下载页除了版本下载之外的页面，
          在启动器右下角加一个一键回到顶部的按键」）。
        ★ 判据与上面的 `listFill` **同一条**（`tab !== 'game'`）：
          「安装游戏」那两屏是"页面不滚、清单自己滚"的形态，给它们挂这个键
          等于给一个按下去没有反应的按钮 —— 用户说的"除了版本下载之外"正是这个。
      */}
      {listFill ? <BackToTop /> : null}
    </div>
  );
}

/* ====================== 页签二：整合包 ====================== */

interface PackCard {
  id: string;
  name: string;
  author: string;
  summary: string;
  mc: string;
  /**
   * **这个整合包的模组加载器**（规范串：`fabric`/`forge`/`neoforge`/`quilt`）。
   *
   * ★★★★ 2026-10-17（用户：「curseforge 的整合包，不显示整合包的模组加载器
   *   类型」）：类型从 `string` 改成 `string | null` —— 原来"没有值"被兜底成
   *   字符串 `'—'`，卡片上就出现一个**假的破折号格子**，读起来像
   *   "这个包的加载器是空的"，而不是"我们没这个信息"。
   *
   *   ⇒ `null` = **我们没拿到这个信息** ⇒ **那一格不渲染**（见下面
   *     `.pack-tags` 那一段）。判据（值 → 规范串 | null）在
   *     `domain/pack-loader.ts::packLoaderOf`，有 `node --test` 的断言钉着。
   */
  loader: string | null;
  downloads: string;
  weight: 'light' | 'medium' | 'heavy';
  /**
   * ★ 封面图 URL（2026-09-15 补）。
   *
   *   用户报："整合包还没有封面"。实测：Modrinth 的搜索结果里**本来就有**
   *   `icon_url`，而这里只画了一个按 `weight` 变色的方块（`pack-cover`）——
   *   数据一直是有的，是这一页没接。现在有图用图、没图退回那个色块。
   */
  icon: string | null;
  /**
   * ★★ 合并后的那条命中（**来源信息在里面**：来自哪个源 / 两个都有 /
   *   安装该走哪一条）。卡片上不显示来源（用户要求保持干净）——
   *   它服务于"点开之后取哪一份的版本列表"。
   */
  hit: MergedHit;
}

function ModpackTab({
  go,
  toast,
  onInstallViewChange,
  target,
}: {
  go: (p: 'launch' | 'versions' | 'download' | 'settings') => void;
  toast: (k: 'ok' | 'err' | 'info' | 'warning', t: string, d?: string) => void;
  /**
   * ★★ 2026-09-23（用户：「mod 页面会进入自己的专属页，是一个全屏页，**为什么整合包的还会显示**」）：
   *   进了整合包安装页要通知外层把**下载页的页头与页签**收起来 —— 这样它和
   *   Mod 那条路（独立路由整屏替换）**看起来完全一样**。
   */
  onInstallViewChange?: (inInstall: boolean) => void;
  /** ★ 装到哪个实例 —— 用来把「这个包有哪些版本」筛成**兼容当前实例**的那些 */
  target?: { mcVersion: string; loader?: { kind: string } | null } | null;
}) {
  const { api } = useRealApi();
  // ★ 整合包安装完要真的建实例 —— 以前这里没有 createInstance，装上也没人登记
  // ★ C3：版本下拉要用「玩家装着的版本」，所以这里也需要 state
  const { createInstance, state } = useApp();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'hot' | 'new' | 'downloads'>('hot');
  /**
   * ★★ 显示方式（用户：「在最多下载的右边加一个选项：左是矩阵，右是条形」）。
   *   默认**矩阵**（原来的样子）；条形 = 一行一个、占满整宽。
   *   ★ 只影响 CSS 的列宽（`data-view`），**不重排 DOM、不重取数据** ——
   *     切换是纯显示，不该触发任何请求。
   */
  const [view, setView] = useState<'grid' | 'list'>('grid');
  /*
   * ★★ 2026-09-23（C3）：整合包也要图三那排筛选。
   *   空串 = **不限**（后端只有收到 null 才真的不筛，见 ResourceBrowser 里那段说明）。
   */
  const [mcFilter, setMcFilter] = useState('');
  const [loaderFilter, setLoaderFilter] = useState('');
  /**
   * ★★ 2026-10-16（用户报的"漏下 mod 却报安装完成"）：**这一次装完之后还缺哪几个**。
   *
   *   事故里这条信息根本不存在 —— 界面报"整合包装好了"，游戏里才弹
   *   「Missing Mods」（Balm / FallingTree / FTB Teams / Fabrication /
   *   Paintings ++）。根因是 CurseForge 的解析地址阶段把失败的条目丢了。
   *   ★ 缺失时**不跳走**：留在这一屏把"缺哪几个、为什么、怎么补"说完，
   *     否则用户只看到一句 toast 一闪而过，接着就是游戏里的弹窗。
   */
  const [packMissing, setPackMissing] = useState<PackMissingFile[]>([]);
  /**
   * ★★★★ 2026-10-17：这一次收尾的**档位结论 + 三处文案**（`install-summary.ts` 算好的）。
   *
   *   页面提示那一块（`missingPanel`）的小标题与小标题下方那句都取它 ——
   *   与任务卡片、toast 用的是**同一个值**，所以三处不可能各说各的。
   *   补全之后（`redownloadMissing` 里）跟着 `packMissing` 一起清掉。
   */
  const [packOutcome, setPackOutcome] = useState<InstallSummary | null>(null);
  /** 正在"重新下载缺失的"（复用补齐命令，它现在会重新去要地址） */
  const [repairingMissing, setRepairingMissing] = useState(false);
  /**
   * 这一次安装用的 slug（`finishPackInstall` 收到它时记下来）。
   *   ★ "重新下载缺失的"要一个**已经建好的实例**才能补 —— 缺文件时我们
   *     照样把实例建出来（文件都在盘上，补上的就是缺的那几个）。
   */
  const selectedSlugRef = useRef<string | null>(null);
  /*
   * ★★ 2026-09-23：整合包的**来源**（Modrinth / CurseForge）。
   *   用户：「PCL 的整合包可以用 curseforge 啊」—— 它本来就是一个来源选项，
   *   资源搜索那条路（`resourceSearch`）早就支持两个源。
   *
   * ★★★★ 2026-10-17：**默认改成「全部」**（两个源一起查）——
   *   用户：「在 modr 的左边加一个全部，并且默认为全部，这样即使有资源里
   *   不允许第三方下载，也可以得到互补了」。五个资源页签同一套。
   */
  const [packSource, setPackSource] = useState<SourceChoice>('all');
  /**
   * ★★ 「全部」下只有一个源没查成时的原因（说清缺了哪一边，
   *   不许把"这次没查成"说成"那个源没有"）。
   */
  const [packSideError, setPackSideError] = useState<string | null>(null);
  /*
   * 版本选项：**玩家自己装着的版本 + 内置正式版表**（新到旧）。
   * ★ 为什么不去拉线上清单：那个下拉只是"筛整合包"，为它等一次网络往返不值；
   *   而整合包绝大多数集中在正式版上。玩家装了什么，就一定在选项里。
   */
  const packVersionOptions = useMemo(() => {
    const mine = state.instances.map((i) => i.mcVersion).filter(Boolean);
    const all = [...new Set([...mine, ...knownVersions().filter((v) => !isSnapshotVersion(v))])];
    return all.sort((a, b) => compareVersion(b, a)).slice(0, 40);
  }, [state.instances]);
  const [packs, setPacks] = useState<PackCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackCard | null>(null);
  const [name, setName] = useState('');
  const [installing, setInstalling] = useState(false);
  /*
   * ★ 2026-10-08：`installPanelRef` / `installNameRef` 随底部那块**内联配置面板**
   *   一起删掉了（用户：「最下面这是什么啊，不要这个」）——
   *   它们唯一的作用就是把那块面板滚进视野、并聚焦它的输入框。
   *   ★ 留着两个永远指向 `null` 的 ref 比删掉更坏：下一个人会去满仓库找"哪块面板"。
   */

  /** 页码与总数（0 基）—— 翻页靠它俩，不再写死前 20 个 */
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);

  /**
   * 上一批结果属于哪一组条件（"来源 + 关键词 + 筛选 + 实例"）。
   *
   * ★★ 2026-09-26（用户截图：切到 CurseForge 之后，列表上面一排骨架、下面还是
   *   **Modrinth 那 6 个结果**）：这个函数原来只是 `setLoading(true)` 就发请求，
   *   于是**旧结果整段时间还挂在屏幕上**，而骨架同时渲染在它上面 ——
   *   看起来就是"切了来源但内容没换"。
   *
   *   资源中心那份（`ResourceBrowser`）2026-09-23 就修过同一个病
   *   （"切到资源包会继承到 Mod 的封面"），**这份是漏网的**：
   *     · 没有"换条件先清空" ⇒ 旧结果留在屏幕上；
   *     · 没有迟到守卫 ⇒ 慢的旧请求回来会把新结果盖掉；
   *     · 骨架与结果网格同时渲染（那边有 `!loading` 守卫，这里没有）。
   *   ⇒ 三处一起补齐。判据见 `tools/live/live-resource-switch-check.mjs`。
   */
  const lastCriteria = useRef<string | null>(null);
  /** 上一次请求的是第几页（翻页时保留已有结果，换条件时清空） */
  const lastPage = useRef<number | null>(null);
  /** 只认最后一次请求的结果（慢的旧请求回来时丢掉） */
  const seq = useRef(0);

  /** 从 Modrinth 拉真实整合包（project_type=modpack） */
  const load = useCallback(async () => {
    if (!api) return;
    const mine = ++seq.current;
    /*
     * ★ 条件变了就**立刻清空**（"换条件"= 来源 / 关键词 / 筛选 任一变了）；
     *   只有"翻页"（同一组条件、只换 offset）才保留已有结果 —— 那是翻页的语义。
     *   ★ 这里没有"实例"这一项：整合包列表与实例无关（那是资源中心那边的概念）。
     */
    const criteria = `${packSource}|${query}|${mcFilter}|${loaderFilter}`;
    const sameSet = lastCriteria.current === criteria;
    lastCriteria.current = criteria;
    const samePage = lastPage.current === page;
    lastPage.current = page;
    if (!sameSet || !samePage) setPacks([]);
    setLoading(true);
    setError(null);
    try {
      /*
       * ★ 翻页（2026-09-15）：用户报"整合包还没有翻页"。
       *   实测确认：这里写死 `limit: 20` 且**没有 offset** ——
       *   于是整合包永远只有前 20 个，翻不动。现在按页取，总数用上游的
       *   `total_hits`（自己数出来的总数没有意义，也不是"全部"）。
       */
      /*
       * ★★ 2026-09-23（用户：「PCL 的整合包可以用 curseforge 啊」→「curseforge 那个继续」）：
       *   改走**资源搜索**那条路（`resourceSearch`）—— 它本来就有 Modrinth / CurseForge
       *   两个源，后端这一轮也给 `ResourceKind` 补上了 `modpack`。
       *   ★ 不再用 `modrinth.search`：那条路只认 Modrinth，正是"来源只有一个"的根源。
       *
       * ★★ 同时发现并修了一个**真的 bug**：C3 那轮我以为给这里加了
       *   `mcVersion` / `loader` 两个参数，**实际上没加成** ——
       *   所以"选 26.2"只改了标签、**查询没带筛选**。
       *   （当时的判据只断言了"标签变了 + 列表重新加载"，没断言"结果真的变了"，
       *     所以它没有抓住。这次断言补硬：筛完的**结果集必须不同**。）
       *
       * ★★★★ 2026-10-17：**「全部」（默认）走两源并发那条命令**，
       *   合并/去重/优先级交给 `domain/resource-merge.ts`。
       *   ★ 分页仍然是"各源的第 N 页"：两边同一个 offset，合并后再排序。
       */
      const common = {
        kind: 'modpack' as const,
        query: query || '',
        mcVersion: mcFilter || undefined,
        loader: loaderFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      let merged: MergedHit[];
      let totalHits: number;
      if (packSource === 'all') {
        /*
         * ★ 回包怎么读（哪边挂了 / 总数 / 别名提示来自哪一份）**只有一处判据**：
         *   `domain/resource-merge.ts::pagesFromBoth`（纯函数、有测试）。
         *   总数取两源**较大的那个**：第 N 页在"任一源还有第 N 页"时就得能翻；
         *   相加是编的（同一条资源可能两边都在）。
         */
        const read = pagesFromBoth(await api.modrinth.resourceSearchBoth(common));
        merged = mergeHits(read.pages);
        totalHits = read.totalHits;
        if (mine === seq.current) setPackSideError(read.sideError);
      } else {
        // ★ 来源由用户选（Modrinth / CurseForge）—— 见上面那段说明
        const r = await api.modrinth.resourceSearch({ ...common, source: packSource });
        merged = mergeHits(
          packSource === 'curseforge' ? { curseforge: r.hits } : { modrinth: r.hits },
        );
        totalHits = r.total_hits ?? 0;
        if (mine === seq.current) setPackSideError(null);
      }
      if (mine !== seq.current) return; // ★ 迟到的结果丢掉（否则旧来源的结果会盖掉新的）
      setTotal(totalHits);
      setPacks(
        merged.map((h) => ({
          /*
           * ★★ 2026-09-24（C-1 修复）：这里原来写的是 `h.slug || h.project_id` ——
           *   而 **CurseForge 命中的 `slug` 是字符串**（`all-the-mods-10` 这种），
           *   CF 的文件接口只认**数字 project id**（`925200`）。
           *   于是安装页拿着 slug 去问版本列表 ⇒ 空列表 ⇒ 界面说
           *   「这个整合包没有可下载的版本」（把"我们拿错了标识"说成"上游没有"）。
           *
           *   `project_id` 对两个源都是**正确的那个标识**：
           *     · Modrinth：project id 与 slug 都接受（`/v2/project/{id}/version`）；
           *     · CurseForge：只有数字 id 能用。
           *   ★ 这不是"界面按来源分支"，而是**只带正确的那一个标识** ——
           *     来源怎么走仍然由后端决定（见 `resource_versions`）。
           */
          id: h.project_id,
          name: h.title,
          author: h.author || '未知作者',
          summary: h.description,
          mc: h.versions.slice(-1)[0] ?? '—',
          /*
           * ★★★★ 2026-10-17（用户：「curseforge 的整合包，不显示整合包的
           *   模组加载器类型」）：
           *
           *   这一格原来写的是
           *     `h.categories.find(c => ['fabric','forge','neoforge','quilt'].includes(c)) ?? '—'`
           *   两个毛病：
           *     ① 值缺失时兜底成 `'—'` ⇒ 卡片上出现一个**假的破折号格子**，
           *        读起来是"这个包的加载器是空的"，而事实是"**我们没这个信息**"
           *        （仓库一贯的纪律：不许把"不知道"说成"没有"）；
           *     ② 判据埋在 effect 里，没有测试碰得到它。
           *
           *   ⇒ 判据搬到 `domain/pack-loader.ts::packLoaderOf`（纯函数、
           *     `node --test` 能真跑），**取不到就是 `null`**，
           *     由下面渲染那一段决定"**不渲染那一格**"（见 `PackCard.loader`）。
           *
           *   ★ CurseForge 那边为什么原来是空的：CF 自己的 `categories` 是
           *     **内容分类**（`Exploration`/`Tech`/`Quests`…），里面永远没有加载器；
           *     加载器在 `latestFiles[].gameVersions` 里（`["1.21.1","NeoForge"]`），
           *     后端现在把那一半并进了同名的 `categories` 字段
           *     （`net/curseforge.rs::categories_with_loaders`）。
           */
          loader: packLoaderOf(h.categories),
          downloads: h.downloads > 1000 ? `${Math.round(h.downloads / 1000)}k` : String(h.downloads),
          weight: 'medium' as const,
          icon: h.icon_url ?? null,
          /*
           * ★ 合并后的那条命中（来源在里面）—— 点开之后取哪一份的版本列表
           *   由它决定（`provenance.preferred`），**不是**切换器上的那一格
           *   （「全部」那一格叫 `all`，问不动任何接口）。
           */
          hit: h,
        })),
      );
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      /* ★ 只有"最后一次请求"才允许关掉加载态 —— 否则慢的旧请求会把新的骨架提前收掉 */
      if (mine === seq.current) setLoading(false);
    }
  }, [api, query, page, mcFilter, loaderFilter, packSource]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * ★★ 2026-09-22 修（用户："**资源包详情页打不开，根本安装不了整合包**"）。
   *
   *   真机实测：点一张整合包卡片之后，安装面板出现在 `top: 1939`，
   *   而视口只有 760 高 —— **在屏幕外约 1200 像素**。
   *   面板本身一直在 DOM 里（点也确实生效了），只是用户看不见，
   *   于是体验就是"点了没反应、根本装不了"。
   *
   *   当时在这里加了一段"选中就把它滚进视野并聚焦输入框"。
   *
   * ★★★★ 2026-10-08（用户截图：「**最下面这是什么啊，不要这个**」）：
   *   **那段滚动的 `useEffect` 删掉了 —— 连同它服务的那个面板一起。**
   *
   *   因为点卡片后来改成了"整页切到安装页"（`installTarget` 那条提前 return），
   *   而 `selected` 在点卡片时也一起被设上 ⇒ 这个 effect **照样触发**，
   *   把页面滚到列表最底部、露出一个**谁也用不到**的旧面板。
   *   用户看到的就是"下面冒出一块东西"，而且它的文字穿过 sticky 页头的
   *   毛玻璃，糊成一片。
   *
   *   ⇒ 面板没了，滚过去看它的理由也就没了。**留着空转的滚动是更坏的选择**：
   *     它会继续把用户从"刚点的那张卡"上拽走。
   */

  /*
   * ★ 搜索词变了要回到第 1 页（不然会停在一个"搜出来只有 3 个"的第 7 页上）。
   *
   * ★★ 2026-09-26：**两个筛选器也算"换条件"** —— 原来这里只跟着 `query`，
   *   于是在第 2 页时改「版本」或「加载器」会**停在旧页码上**：结果集换了、
   *   页码没回零，看到的是一段对不上的结果（用户点名这两个下拉会触发问题）。
   *   ⇒ 依赖里补上 `mcFilter` / `loaderFilter`（与"换条件清空旧结果"是同一件事的两半）。
   */
  useEffect(() => {
    setPage(0);
  }, [query, mcFilter, loaderFilter]);

  /*
   * ★★★★ 2026-10-17：排序**改用资源中心那份判据**（`domain/resource-merge.ts`
   *   的 `sortHits`），不再在这里手写。
   *
   *   原来这里是 `parseFloat(b.downloads.replace('k',''))` ——
   *   拿**显示用的字符串**（`12k`）当数值比：`1.5M` 那种会被算成 1.5，
   *   而两个源合并之后同值更多，"稳定"这件事更要紧（同值保持合并后的原顺序）。
   *   现在直接比 `hit.downloads`（真数值），且三种排序**两个页签同一套**。
   */
  const sorted = useMemo(() => sortHits(packs, sort, (p) => p.hit), [packs, sort]);

  /*
   * ★★ 2026-09-23 用户：「**整合包安装为什么没做单开一页的设计**」——
   *   确实是我漏了：C5 只把资源浏览器那四个页签改成了独立安装页，整合包还在内联展开。
   *
   *   ★ 实现方式说明（为什么不是"另一个路由页"）：
   *     整合包的安装流程有 120 行，且依赖本组件里的 `registerTaskReplay` /
   *     `autoMemory` / `createInstance` / 任务中心事件。把它抽到别处是**大改**，
   *     而"抽一半"正是这一轮我已经踩过的坑（脚本改写把文件弄坏过一次）。
   *     所以这里用**整页切换视图**：选中一个整合包之后，下载页的内容区**整个换成**
   *     安装页（列表消失、占满整屏、带返回），与其它资源那四条是同一个观感；
   *     安装实现**一行都不用动**，仍然只有一份。
   */
  const [installTarget, setInstallTarget] = useState<PackCard | null>(null);
  /*
   * ★ 2026-10-17 判过（与 `Modal` 那处焦点 bug 同形的候选）：**不用改**。
   *   `onInstallViewChange` 的身份变化会让它重跑，但唯一的调用方
   *   （本文件 442 行 `onInstallViewChange={setInModpackInstall}`）传的是
   *   **useState 的 setter**（身份稳定）；而且重跑只是"把同一个布尔值再 set 一遍"
   *   （React 同值 bail out）—— 幂等，不搬家焦点、不重置草稿、不重发请求。
   */
  useEffect(() => {
    onInstallViewChange?.(installTarget !== null);
  }, [installTarget, onInstallViewChange]);
  /*
   * ★★★★ 2026-10-09（用户）：「所有页面的返回按钮做一个固定位置，不然很麻烦」。
   *
   *   整合包安装页原来在自己的内容区里画了一个「← 返回整合包列表」——
   *   而它头顶上还压着下载页的页头（那个页头用户明确要求常驻），
   *   于是这个返回按钮比别的页面**低一个页头**（真机量过差 60px）。
   *   ⇒ 现在只**登记**"我能回整合包列表"，按钮由外壳画在顶栏的固定位置。
   */
  useBackTarget(
    installTarget ? { to: '整合包列表', onClick: () => setInstallTarget(null) } : null,
  );
  const [targetVersions, setTargetVersions] = useState<ModrinthVersion[] | null>(null);
  /**
   * ★★★★ 2026-10-17（取版本互补）：「这一批版本来自哪一份」那一句
   *   （`versionSourceNote` 算好的；`null` = 不用多说）。
   */
  const [targetVersionsNote, setTargetVersionsNote] = useState<string | null>(null);
  /** 页面里点了「安装这个版本」时选中的那一个（null = 用最新那个） */
  const [pickedVersion, setPickedVersion] = useState<ModrinthVersion | null>(null);

  useEffect(() => {
    if (!installTarget || !api) return;
    setTargetVersions(null);
    setTargetVersionsNote(null);
    /*
     * ★★ 2026-09-24（C-1 修复）：这里原来调 `api.modrinth.versions(installTarget.id)` ——
     *   于是**来源选了 CurseForge 也照样去问 Modrinth**：CF 的数字 project id
     *   在 Modrinth 上查出的是别的项目（或者 404），真机表现就是报告里那句
     *   「来自 Modrinth」+「这个整合包没有可下载的版本」。
     *   现在走 source-aware 的 `resource_versions`（CF → `curseforge::files`）。
     *
     * ★★★★ 2026-10-17：**再往前一步 —— 一份问不出来就换另一份**。
     *
     *   「全部」下这个包可能被两个源同时收录，而合并层只把 `preferred`
     *   （能下载的那一份）交给安装页。那一份**没有能装到这个实例的版本**、
     *   或干脆问不到时，旧行为是显示「无」—— 而另一个来源明明有。
     *   这正是「全部」要解决的互补问题，所以按 `versionSourcesToTry` 的顺序问下去。
     *
     *   ★ 三条不许含糊的（判据在 `domain/version-sources.ts`，有测试）：
     *     ① **换源要换身份**：每个目标带它**自己那一份**的 `project_id`
     *        （拿 Modrinth 的 id 去问 CF = 把"拿错了标识"说成"上游没有"）；
     *     ② **两源的版本不混在一张表里**：换源是"换一批"，所以换成功了
     *        必须在这一页说清这一批来自哪个来源；
     *     ③ **两个源都问了才叫真的没有**。
     */
    const loader = target?.loader?.kind;
    void lookupVersionsFrom<ModrinthVersion>({
      targets: versionSourcesToTry(installTarget.hit.provenance, {
        source: installTarget.hit.provenance.preferred,
        projectId: installTarget.id,
      }),
      fetch: (t) =>
        api.modrinth.resourceVersions({
          kind: 'modpack',
          projectId: t.projectId,
          source: t.source,
          /*
           * ★★★★ 2026-09-30（用户）：「**整合包下载……一点反应也没有**」。
           *
           *   这一格（"这个包有哪些版本可以装"）原来**不带实例信息**去问，
           *   于是 Modrinth 把项目的**全部**版本都返回：真机实测 Sodium 有
           *   **256 个版本 / 107 KB（gzip 后）**，镜像要 **3.2 秒**才传完。
           *
           *   而带上"装到哪个实例"的 MC 版本与加载器之后：
           *     256 条 → **11 条，5.7 KB，0.22 秒**（快 14 倍）。
           *
           *   ★ 这不是"少显示几个"：**不兼容当前实例的版本本来就不该出现在这里**
           *     —— 选了也装不上，而列出来只会让人点错。
           *   ★ 没选实例时（`target` 为空）照旧不带过滤：那时"有哪些版本"
           *     本身就是要给用户看的信息。
           */
          /*
           * ★★★★ 2026-10-08（用户：「**少世代分组的大版本**」）。
           *
           *   这里原来带 `mcVersion: target.mcVersion` 去问接口 —— 那是
           *   2026-09-30 为 Mod 做的性能优化（真机实测 256 条 → 11 条）。
           *
           *   但对**整合包**它是错的：整合包的"版本"本来就是跨世代的一条谱系
           *   （同一个包在 1.16 / 1.18 / 1.20 / 1.21 上各有一串），
           *   按当前实例的 MC 版本一过滤，**整个谱系只剩一组**
           *   —— 用户看到的就是「37 个版本」却只有一个 `1.20` 分组。
           *
           *   ⇒ 这里只按**加载器**过滤（整合包必须匹配加载器，那是硬约束），
           *     **不按 MC 版本**；而"装到当前实例的那一条要不要高亮/过滤"
           *     交给 `VersionPicker`（它有 `project_type` 与 `target`，
           *     能按种类分别处理，见那边的 `filterByTarget`）。
           */
          ...(loader ? { loader } : {}),
        }),
      /*
       * ★ "这一份算不算数" = 有没有能装到这个实例的版本（与列表筛选同一份判据）。
       *   整合包在 `version-filter` 里**不按 MC 版本筛**，所以这里实际等于
       *   "这个源有没有给出兼容加载器的版本"。
       */
      usable: (list) => hasCompatibleVersion(list, { projectType: 'modpack', target }),
    })
      .then((got) => {
        setTargetVersions(got.versions);
        setTargetVersionsNote(versionSourceNote(installTarget.hit.provenance, got));
      })
      .catch(() => {
        setTargetVersions([]);
        setTargetVersionsNote(null);
      });
  }, [installTarget, api, target]);

  /**
   * 装一个整合包。
   *
   * ★★ 2026-09-24（C-5 修复）：加了 `version` 参数 —— 由**点击那一刻**直接传进来。
   *
   *   原来的写法是 `onPick` 里 `setPickedVersion(v)` 然后
   *   `window.setTimeout(() => void install(), 0)`：那个 `install` 是**本次渲染的闭包**，
   *   它读到的 `pickedVersion` 还是 `null`（`setState` 要下一次渲染才生效），
   *   于是回退到 `versions(selected.id)[0]` —— **点哪一行都装最新那个版本**。
   *   界面看起来正常（点了就装），错的是"装的是哪一个"。
   *
   *   现在：点行 → `install(v)` 把版本**当参数**传进来，根本不再经过 state 的时序；
   *   state 里的 `pickedVersion` 仍然保留，给底栏那个「确认并开始安装」按钮用
   *   （那条路径是"先选版本、再点确认"，时序上不存在这个问题）。
   */
  async function install(version?: ModrinthVersion) {
    /*
     * ★ 要装的是**这个安装页认定的那个包**（`installTarget`）——
     *   不再依赖 `selected` 的时序：`install(v)` 是从 onPick 里同步调的，
     *   闭包里的 state 都还是上一次渲染的值，靠它会让"点哪行装哪行"又变成空话。
     */
    const pack = installTarget ?? selected;
    if (!pack) return;
    if (!api) {
      toast('warning', '演示模式', '浏览器里无法真实安装整合包');
      return;
    }
    /*
     * ★★ 两种包的清单格式不同，但**安装流程是同一段**：
     *     · Modrinth 的 `.mrpack`  → `modrinth.index.json` 里**直接给下载地址**；
     *     · CurseForge 的 `.zip`   → `manifest.json` 里**只有 id**，
     *       后端会逐个问接口拿地址（并发 12 路），进度同样报在 `modpack-progress` 上。
     *
     *   ★ 作者禁止第三方分发时（CF 的 `downloadUrl` 是 null）**不假装能装**：
     *     后端会再问一次接口，真的拿不到就返回具体原因（"这个包有 N 个文件下不了"），
     *     这里原样显示。
     *
     * ★ 2026-09-27（清理）：这上面原来还留着 2026-09-24 那一段**现在时**的
     *   「CurseForge 的整合包**还不能自动安装**……后者**没有实现**」。
     *   它早被下面这段推翻了（0.2.0 实装），但整段留在原地 ——
     *   读代码的人先读到的是假话，然后才读到更正。
     *   ⇒ 删掉旧段，只保留今天成立的说法。
     */
    const isCf = packSource === 'curseforge';
    /*
     * ★ 任务 id 在 **try 之前**生成：任务会在读清单**之前**就建出来
     *   （见下面那段"先建任务、再读清单"），而 catch 里要用同一个 id
     *   把任务标成失败 —— 声明在 try 里面 catch 就看不见它。
     */
    const taskId = `modpack-${Date.now().toString(36)}`;
    setInstalling(true);
    try {
      /*
       * ★★ 2026-09-23：**页面里挑了版本就用它**；没挑才退回"最新那个"。
       *   内联面板时代只能装最新那个版本 —— 用户在安装页里选了半天，
       *   装的却还是最新，那就成了假控件。
       *
       * ★ 2026-10-01：这个 `first` 就是**当前版本的元数据**，后面用它
       *   把"要装什么"说清楚（不必去下 113 MB 的包体，见下面那段）。
       *   所以它不只是"挑一个文件"，还是这一整段里**最有信息量的那个变量**。
       */
      const first = version ?? pickedVersion ?? (await api.modrinth.versions(pack.id))[0];
      const file = first?.files.find((f) => f.primary) ?? first?.files[0];
      if (!file || !first) throw new Error('这个整合包没有可下载的文件');

      /*
       * CF 那份清单在后端读（我们这边只有"文件 id + 文件名 + 可能为空的地址"）。
       * ⇒ 用户看到的"要装什么"来自后端回填的 `result`；这里先把**已知的**说清楚。
       */
      let info: { mc_version: string | null; loader_kind: string | null; loader_version: string | null; client_file_count: number; name: string };
      let cfIds: { projectId: number; fileId: number; fileName: string; downloadUrl: string | null } | null = null;
      /*
       * ★★★★ 2026-10-01（用户）：「**任务根本不出现**」—— 根因就在这里。
       *
       *   原来的顺序是**先读清单、再建任务**：
       *     `info = await api.modpack.inspect(file.url)`  ← 要**把整个包下下来**
       *     ……然后才 `dispatchEvent('ieml:task-add', …)`
       *
       *   而 `inspect`（后端 `fetch_mrpack_index`）是按 URL 把整个 `.mrpack`
       *   读进内存再解压找清单的 —— 用户给的 **Better MC 包体 113 MB**，
       *   实测单连接下 **48 秒**。那 48 秒里**任务中心什么都没有**，
       *   界面上就是"点了下载，什么也没发生"。
       *
       *   ⇒ **先建任务、再读清单**：任务中心立刻出现一条「正在读取整合包清单」，
       *     读完再把"要装什么"补进去（`patch`）。这样"没有任何反馈"这段时间
       *     在界面上就是**可见的**，而不是一片空白。
       *
       *   ★ 这也是这一整轮反复出现的那条纪律：**别让用户等一个没有反馈的过程**。
       *     48 秒不是问题，"48 秒里看不出来在干什么"才是问题。
       */
      const taskId = `modpack-${Date.now().toString(36)}`;
      window.dispatchEvent(
        new CustomEvent('ieml:task-add', {
          detail: {
            id: taskId,
            kind: 'install',
            title: `整合包 ${name.trim() || pack.name}`,
            detail: isCf ? 'CurseForge · 正在读清单' : '正在读取整合包清单',
            status: 'running',
            percent: 0,
            finishedFiles: 0,
            finishedBytes: 0,
            totalBytes: 0,
            bytesPerSecond: 0,
            currentFile: '',
            etaSeconds: 0,
          },
        }),
      );
      const patchEarly = (p: Record<string, unknown>) =>
        window.dispatchEvent(
          new CustomEvent('ieml:task-patch', { detail: { id: taskId, patch: p } }),
        );

      if (isCf) {
        const projectId = Number(pack.id);
        const fileId = Number(first?.id ?? 0);
        if (!Number.isFinite(projectId) || !Number.isFinite(fileId) || fileId <= 0) {
          throw new Error('这个整合包的版本信息不完整（拿不到文件 id），换个版本再试');
        }
        cfIds = {
          projectId,
          fileId,
          fileName: file.filename,
          downloadUrl: file.url && file.url.trim() ? file.url : null,
        };
        info = {
          mc_version: '',
          loader_kind: null,
          loader_version: null,
          client_file_count: 0,
          name: pack.name,
        };
      } else if (first) {
        /*
         * ★★★★ 2026-10-01：**能不下整包就不下整包**。
         *
         *   整段调查的落点就在这里。原来的做法是
         *   `api.modpack.inspect(file.url)` —— 后端把整个 `.mrpack`
         *   **读进内存再解压**去找 `modrinth.index.json`：
         *   用户给的 Better MC 包体 **113 MB，实测单连接 48 秒**。
         *   而那 48 秒里界面能拿到的信息，**其实早就在手上**：
         *
         *     从列表点进来的这条正常路径，`version` 就是一个完整的
         *     `ModrinthVersion` —— `game_versions`（= MC 版本）、
         *     `loaders`（= 加载器）、`files`（= 文件数与总体积）
         *     **全都是接口已经返回过的字段**。
         *
         *   ⇒ 有 `version` 时不读包体，直接用这些字段把"要装什么"说清楚。
         *     `inspect` 只留给**拿不到 version** 的那条降级路。
         *
         *   ## 为什么这不是"猜"
         *
         *   `.mrpack` 里的 `modrinth.index.json` 与 `/version` 接口返回的
         *   是**同一份元数据**（Modrinth 自己就是这么生成包的）：前者是
         *   打包时的快照，后者是权威来源。所以这里没有"根据文件名猜版本"
         *   那种事 —— 用的是同一个接口的同一个字段。
         *
         *   ★ 一处**刻意的不精确**要说清楚：这里数的"文件数"是**包内条目数**，
         *     而界面原来显示的是"客户端相关文件数"（后端会滤掉只给服务端的
         *     那几条）。所以这个数会**略大**，安装开始后 `modpack-progress`
         *     会用真实计数覆盖它。宁可先说个略大的数、马上被纠正，
         *     也不要为了精确先等 48 秒 —— 那 48 秒正是用户报的"什么也没发生"。
         */
        const mc = first.game_versions[0] ?? '';
        if (!mc) {
          throw new Error('这个整合包的版本信息里没有游戏版本，换个版本再试');
        }
        /* 加载器：Modrinth 的 `loaders` 里除了加载器还有 `minecraft` 这类条目 */
        const loader = first.loaders.find((l) => l !== 'minecraft') ?? null;
        info = {
          mc_version: mc,
          loader_kind: loader,
          /* 版本号在清单里是 `dependencies`，这里不强求 —— 说得出的才说 */
          loader_version: null,
          client_file_count: first.files.length,
          name: first.name || pack.name,
        };
      } else {
        /*
         * 降级路：**拿不到 `version`** 时（比如从别处直接给一个下载地址）
         * 只能读包体。这条路依然要下整个包 —— 所以它能不走就不走。
         */
        info = await api.modpack.inspect(file.url);
        if (!info.mc_version) {
          throw new Error('这个整合包的清单里没写游戏版本，无法安装');
        }
      }
      const packName = name.trim() || info.name || pack.name;
      const slug = `pack-${Date.now().toString(36).slice(-6)}`;

      /*
       * ★ 清单读到了 —— 把"要装什么"补进那条已经存在的任务里。
       *   （任务在上面就已经建好了，所以这一步不会再让界面空着。）
       */
      patchEarly({
        title: `整合包 ${packName}`,
        detail: isCf
          ? 'CurseForge · 清单已读到'
          : `${info.mc_version}${
              info.loader_kind ? ` + ${info.loader_kind} ${info.loader_version ?? ''}` : ''
            } · ${info.client_file_count} 个文件`,
      });
      const patch = (p: Record<string, unknown>) =>
        window.dispatchEvent(
          new CustomEvent('ieml:task-patch', { detail: { id: taskId, patch: p } }),
        );

      /*
       * ★ 注册重放函数：整合包安装不在 `flows/install` 的 pendingJobs 里，
       *   于是任务中心的「继续」「重试」对它静默失效（审计发现）。
       *   注册之后这两个按钮对整合包也真的能用（断点续传靠 .part）。
       */
      /*
       * ★ 2026-09-28（0.18.2）：整合包这三条安装也**跟着设置里的「下载源」走**
       *   （以前写死 `'bmclapi'`）—— 用户在设置里选的那一档，装的每一步都该照做。
       */
      const src = state.prefs.downloadSource;
      const doInstall = () =>
        isCf && cfIds
          ? api.modpack.cfInstall(
              {
                ...cfIds,
                name: packName,
                slug,
                taskId,
                instanceName: packName,
                source: src,
                /*
                 * ★★ 2026-10-17（用户：「启动器，整合包版本图标应该显示整合包
                 *   自己的封面」）：**把平台封面一起交下去**。
                 *   CF 的包体里**从来没有**图标文件 ⇒ 不传这张，
                 *   装完之后界面上永远只有自绘的方块。
                 */
                iconUrl: pack.icon ?? undefined,
              },
              (e) => {
                patch({
                  detail: e.stage,
                  percent: e.percent,
                  finishedFiles: e.finishedFiles,
                  /*
                   * ★★★★ 2026-10-07（用户截图：「这个下载显示，有bug啊，
                   *   信息不全」）：**速度、字节数、剩余时间都要接过来**。
                   *
                   *   这里原来只接 `percent` / `finishedFiles` / `currentFile`
                   *   —— 于是任务卡片上**永远没有速度和剩余时间**，
                   *   而一个 66 MB 的包体几乎全花在**单个文件**上
                   *   （"第 N/M 个文件"在那几分钟里根本不动）。
                   */
                  bytesPerSecond: e.bytesPerSecond ?? 0,
                  finishedBytes: e.bytes ?? 0,
                  totalBytes: e.totalBytes ?? 0,
                  etaSeconds: etaOfBytes(e.bytesPerSecond, e.bytes, e.totalBytes),
                  currentFile: e.currentFile,
                });
              },
            )
          : api.modpack.install(
              {
                url: file.url,
                name: info.name,
                slug,
                taskId,
                instanceName: packName,
                source: src,
                /*
                 * ★ 把包体大小交给后端：包体是一个大文件，**没有体积就没有百分比**
                 *   （那一段会如实停在 0%，看起来像卡住）。Modrinth 的文件信息里有 size。
                 */
                size: file.size,
                /*
                 * ★★ 把**包的身份**一起交给后端（ADR-025 第 4 条）：
                 *   `pack.id`（项目）+ `first.id`（版本）—— 写进安装记录之后，
                 *   以后才问得出"作者有没有发新版"。
                 *   `.mrpack` 文件里**没有** project id，不在这里传就永远丢了。
                 */
                projectId: pack.id,
                versionId: first.id,
                /*
                 * ★★ 2026-10-17（用户：「启动器，整合包版本图标应该显示整合包
                 *   自己的封面」）：**把平台封面一起交下去**。
                 *
                 *   `.mrpack` 的规范里**没有图标**（根下只有 `modrinth.index.json`
                 *   与 `overrides/`）—— 作者没往包里放图时，这一张是唯一来源。
                 *   而这个 URL **早就在手上**（搜索结果里的 `h.icon_url`，
                 *   卡片上那张图用的就是它）。
                 *
                 *   ★ 后端只在"包里抽不到作者图标"时才会去抓它（连请求都不发），
                 *     所以传下去不会多一次网络往返。
                 */
                iconUrl: pack.icon ?? undefined,
                /*
                 * ★★★★ 2026-10-01：**把包体的 sha1 传下去**。
                 *
                 *   原来包体完全不校验，于是"下下来了但内容坏了"只会在解压时
                 *   暴露成 `invalid Zip archive: Could not find EOCD` ——
                 *   一句与"下载"无关的话，用户看了也不知道怎么办。
                 *
                 *   而这个 sha1 **早就在手上**（`files[].hashes.sha1`，
                 *   接口返回过、我们一直在用它显示文件信息）。
                 *   有了它，坏包在**下载阶段**就被发现并换源重下。
                 */
                packSha1: file.hashes.sha1,
              },
              (e) => {
                patch({
                  detail: e.stage,
                  percent: e.percent,
                  finishedFiles: e.finishedFiles,
                  /*
                   * ★★★★ 2026-10-07（用户截图：「这个下载显示，有bug啊，
                   *   信息不全」）：**速度、字节数、剩余时间都要接过来**。
                   *
                   *   这里原来只接 `percent` / `finishedFiles` / `currentFile`
                   *   —— 于是任务卡片上**永远没有速度和剩余时间**，
                   *   而一个 66 MB 的包体几乎全花在**单个文件**上
                   *   （"第 N/M 个文件"在那几分钟里根本不动）。
                   */
                  bytesPerSecond: e.bytesPerSecond ?? 0,
                  finishedBytes: e.bytes ?? 0,
                  totalBytes: e.totalBytes ?? 0,
                  etaSeconds: etaOfBytes(e.bytesPerSecond, e.bytes, e.totalBytes),
                  currentFile: e.currentFile,
                });
              },
            );
      registerTaskReplay(taskId, () => {
        void doInstall().catch((err) => {
          patch({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
        });
      });

      const result = await doInstall();

      /*
       * ★ 装完才建实例（失败不会在列表里留下一个起不来的空壳）。
       *
       * ★★ 2026-10-17：**暂停 / 缺件 / 装全了这三件事的文案只在
       *   `finishPackInstall` 里算一次**（`domain/install-summary.ts`）。
       *   这里原来还有一份一模一样的 `result.paused` 分支（同一个判断、
       *   同一句 toast 写两遍）—— 两份文案迟早会分叉，删掉它。
       */
      await finishPackInstall(result, patch, packName, slug);
    } catch (e) {
      /*
       * ★★ 2026-09-24（C-26 修复）：用户自己点「取消」时抛出来的是
       *   「任务被取消」（Rust）/「已取消」（浏览器桥）—— 以前一律弹**红色「安装失败」**，
       *   等于把用户自己的操作说成故障。取消 = 正常结果，说清"停下了、文件保留"。
       */
      const why = e instanceof Error ? e.message : String(e);
      /*
       * ★ 2026-10-01：失败时**必须把那条任务标掉** —— 任务现在是**开工之前**
       *   就建好的（见上面那段"先建任务、再读清单"），所以"读清单失败"
       *   这种早期错误也会留下一条永远停在"运行中"的任务。
       *   ★ 这里按 **id** 直接派发，不用下面那个 `patch` 闭包：
       *     它在这一步可能还**没被赋值**（读清单就失败了的话），
       *     用它会是暂时性死区（TDZ）报错 —— 把"错误处理"变成第二个错误。
       */
      window.dispatchEvent(
        new CustomEvent('ieml:task-patch', {
          detail: { id: taskId, patch: { status: 'failed', error: why } },
        }),
      );
      if (isCancellation(why)) {
        toast('info', '已取消安装', '已经下载的文件保留着，下次会从断点继续。');
      } else {
        toast('err', '安装失败', why);
      }
    } finally {
      setInstalling(false);
    }
  }

  /**
   * **三条安装路径共用的收尾**：在线 `.mrpack`、CurseForge 的 zip、拖进来的本地包。
   *
   * ★ 抽出来的理由：这三条的前半段（怎么拿到清单、从哪拿文件地址）完全不同，
   *   但**后半段一模一样** —— 暂停如实标记、装完才建实例、提示、跳去版本列表。
   *   复制三份的话，以后改"暂停算不算装完"这种规矩必然漏掉一两条。
   */
  async function finishPackInstall(
    result: ModpackInstallResult,
    patch: (p: Record<string, unknown>) => void,
    packName: string,
    slug: string,
  ) {
    // ★ 记住这一次的 slug：「重新下载缺失的」要用它（见上面的说明）
    selectedSlugRef.current = slug;
    /*
     * ★★★★ 2026-10-17：**三处文案只算一次**（判据在 `domain/install-summary.ts`，
     *   纯函数、有测试）。它先看 `paused`（暂停不属于三档），再看 `tier`，
     *   最后看缺件数据 —— 于是"任务卡片 / toast / 页面提示"不可能各说各的。
     */
    const missing = result.missing_files ?? [];
    const summary = installSummary({
      tier: result.tier ?? null,
      paused: result.paused,
      remainingFiles: result.remaining_files,
      pausedStage: result.paused_stage,
      missingCount: result.missing_count ?? missing.length,
      failedCount: result.failed_count ?? (result.failed_files?.length ?? 0),
      missing,
    });
    const entry = repairEntry(missing);
    /** 任务卡片角标上的那个数（0 = 不显示角标） */
    const shortfall = summary.kind === 'partial' ? (result.missing_count ?? missing.length) : 0;

    /*
     * ★★ **被暂停就不算装完**（P0-3）：不许建实例、不许说"安装完成"。
     *
     *   老行为是：暂停之后照样往下跑、照样建实例、提示"整合包装好了"，
     *   而 `instances.json` 里多出一个**起不来**的空壳。
     *   现在如实标记「已暂停」，任务中心的「继续」用同一套参数接着下。
     *   ★ 文案同样是 summary 给的：暂停时它说"已暂停 · 还剩 N 个文件"
     *     （或点名"哪一步还没做完"），**不会**说成缺件。
     */
    if (summary.kind === 'paused') {
      patch({ status: 'paused', phase: summary.detail, detail: summary.detail, missingCount: 0 });
      toast('info', summary.title, `${packName} ${summary.detail}`);
      return;
    }

    const inst: Instance = {
      id: `inst-${Date.now().toString(36)}`,
      mcVersion: result.mc_version,
      loader: result.loader_kind
        ? {
            kind: result.loader_kind as 'forge' | 'neoforge' | 'fabric' | 'quilt',
            version: result.loader_version ?? '',
            mcVersion: result.mc_version,
          }
        : null,
      addons: [],
      config: {
        name: packName,
        slug,
        // ★ 整合包必须隔离：作者的 config 不能被别的实例污染
        isolation: 'on',
        memoryMb: Math.round(
          autoMemory(
            0,
            result.loader_kind === 'forge' || result.loader_kind === 'neoforge'
              ? 'modded'
              : 'vanilla',
            16,
            8,
          ).gb * 1024,
        ),
        memorySource: 'auto',
        javaMode: 'auto',
      },
      createdAt: new Date().toISOString(),
      lastPlayedAt: null,
      totalPlaySeconds: 0,
    };
    await createInstance(inst);

    /*
     * ★★★★ 2026-10-17（用户：「装完了但缺 N 个文件」）：**"装完了"与"装全了"
     *   是两件事**，而后端现在把这件事说清楚了（`tier`）。
     *
     *   事故：清单里 338 项，其中 5 个（Balm / FallingTree / FTB Teams /
     *   Fabrication / Paintings ++）的下载地址没解析出来 ⇒ 下载 333 个全成功
     *   ⇒ 旧代码报"安装完成"，而游戏里弹出包自带的「Missing Mods」。
     *
     *   现在：
     *     · `partial`（骨架齐全、有文件没到手）⇒ **任务卡片标题、角标、
     *       toast、页面提示四处一起说"装好了，但缺 N 个文件"**，
     *       并**留在这一屏**给出名单与「重新下载缺失的」入口；
     *     · `paused` 走上面那条（说"已暂停"，不说缺件）；
     *     · 只有 `complete`（后端核对过"清单里的文件全到手"）才敢说装好了。
     *   ★ 一句"安装完成"都不许再出现在 partial 上 —— 由
     *     `tests/install-summary.test.mjs` 直接钉着。
     */
    patch({
      status: 'done',
      percent: 100,
      /* ★ 标题里保留包名（卡片上就这一处能看见它是哪个包），后面接 summary 那一句 */
      title: summary.kind === 'partial' ? `整合包 ${packName} · ${summary.title}` : `整合包 ${packName}`,
      phase: summary.detail,
      detail: summary.detail,
      /* ★ 状态角标：partial 时写"缺 N 个"，而不是一个笼统的"完成" */
      missingCount: shortfall,
    });
    toast(
      summary.warn ? 'warning' : 'ok',
      summary.title,
      summary.kind === 'partial'
        ? /*
           * 缺的那几个**必须点名**：优先用**后端算好的那一句**
           * （`missing_summary`，与 `missingSummary` 是同一套措辞），
           * 后端没给（老版本 / 演示模式）时才用前端那份镜像。
           * 后面接 `entry.detail`：它把"能再试的"与"只能自己去下的"分开说。
           */
          `${(result.missing_summary ?? '').trim() || missingSummary(missing)}${
            entry.detail ? ` ${entry.detail}` : ''
          }`
        : `${packName} · ${result.mc_version}${
            result.loader_kind ? ` + ${result.loader_kind}` : ''
          } · ${result.mod_files} 个文件 + ${result.override_files} 个配置`,
    );
    setPackMissing(missing);
    setPackOutcome(summary);
    /*
     * ★ 缺文件时**不跳走**（也不收掉安装页）：跳走等于把"还缺哪几个"
     *   从屏幕上抹掉，用户下一次看到它就只能在游戏里 —— 那正是这次事故的样子。
     *   ★ 实例照样建（`createInstance` 已经在上面跑过了）：文件都在盘上，
     *     「重新下载缺失的」需要一个**已登记的实例**才能补。
     */
    if (summary.stay) {
      return;
    }
    setSelected(null);
    go('versions');
  }

  /**
   * **重新下载缺失的那几个**（2026-10-16 事故修复的界面入口）。
   *
   *   ★ 走的是后端 `repair_pack_install` —— 它现在会先把"当初连地址都没解析出来"
   *     的条目**重新去要一次地址**再下（与安装时同一份实现、同一套重试）。
   *   ★ 逐条回报：补好的、没补上的（带原因）都如实说，不静默。
   */
  async function redownloadMissing(slug: string) {
    if (!api) {
      toast('warning', '演示模式', '浏览器里无法真实下载');
      return;
    }
    setRepairingMissing(true);
    try {
      const r = await api.pack.repair(slug, state.prefs.downloadSource);
      toast(r.failed.length === 0 ? 'ok' : 'warning', '重新下载完成', r.summary);
      // ★ 补完重读一次状态：还缺哪些要**以盘上为准**，不能用刚才那张旧表
      const s = await api.pack.scan(slug).catch(() => null);
      if (s && s.missing_count === 0) {
        setPackMissing([]);
        // ★ 缺的都补上了 ⇒ 那块提示（连同它的小标题）一起收掉
        setPackOutcome(null);
      }
    } catch (e) {
      toast('err', '重新下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setRepairingMissing(false);
    }
  }

  /*
   * ★★ 2026-09-26：**把整合包 zip 拖进窗口就能装**（用户第 2 优先级的功能）。
   *
   *   为什么必须有它：CF 上有**作者不允许第三方下载**的包（实测 8 个热门包里 1 个），
   *   那种包谁也自动装不了 —— 唯一诚实的出路就是"你自己去 CF 页面下 zip，拖进来"。
   *   所以它不是锦上添花，是那条降级路径的落点。
   *
   *   ★ 拖放事件由 **Tauri 原生**接（`tauri.conf.json` 是 `dragDropEnabled: true`，
   *     所以 HTML 的 `onDrop` 永远收不到东西）——AppShell 收到原生事件后
   *     派发 `ieml:install-local-pack`，这里接住并真正装。
   *   ★ 也正因为是**自定义事件**，探针可以派发同一个事件来验这条逻辑
   *     （原生拖放没法在无头环境里合成）。
   */
  useEffect(() => {
    const onLocalPack = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; name?: string }>).detail;
      if (!detail?.path) return;
      void installLocalPack(detail.path, detail.name);
    };
    window.addEventListener('ieml:install-local-pack', onLocalPack);
    /*
     * ★ 还有"跨页交接"那一格：拖放发生在别的页面时，AppShell 把路径存在
     *   `pending-pack` 里再切过来。这里挂载时取一次（取走即清空，不会装两遍）。
     */
    const pending = takePendingPack();
    if (pending) void installLocalPack(pending.path, pending.name);
    return () => window.removeEventListener('ieml:install-local-pack', onLocalPack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 装一个**已经在盘上**的整合包（拖进来的那份） */
  async function installLocalPack(path: string, nameHint?: string) {
    if (!api) {
      toast('warning', '演示模式', '浏览器里无法真实安装整合包');
      return;
    }
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const packName = (nameHint ?? fileName).replace(/\.(zip|mrpack)$/i, '');
    const slug = `pack-${Date.now().toString(36).slice(-6)}`;
    const taskId = `modpack-${Date.now().toString(36)}`;
    window.dispatchEvent(
      new CustomEvent('ieml:task-add', {
        detail: {
          id: taskId,
          kind: 'install',
          title: `整合包 ${packName}`,
          detail: '本地文件 · 正在读清单',
          status: 'running',
          percent: 0,
          finishedFiles: 0,
          finishedBytes: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
          currentFile: '',
          etaSeconds: 0,
        },
      }),
    );
    const patch = (p: Record<string, unknown>) =>
      window.dispatchEvent(new CustomEvent('ieml:task-patch', { detail: { id: taskId, patch: p } }));
    const doInstall = () =>
      api.modpack.installLocal(
        {
          path,
          name: packName,
          slug,
          taskId,
          instanceName: packName,
          source: state.prefs.downloadSource,
        },
        (e) => {
          patch({
            detail: e.stage,
            percent: e.percent,
            finishedFiles: e.finishedFiles,
            currentFile: e.currentFile,
          });
        },
      );
    registerTaskReplay(taskId, () => {
      void doInstall().catch((err) => {
        patch({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      });
    });
    setInstalling(true);
    try {
      const result = await doInstall();
      await finishPackInstall(result, patch, packName, slug);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (isCancellation(why)) {
        toast('info', '已取消安装', '已经下载的文件保留着，下次会从断点继续。');
      } else {
        toast('err', '安装失败', why);
      }
    } finally {
      setInstalling(false);
    }
  }

  /*
   * ★★ 2026-10-16（用户报的"漏下 mod 却报安装完成"）：**装完之后缺的那几个**。
   *
   *   事故形状：界面报"整合包装好了"，游戏里弹包自带的「Missing Mods」
   *   （Balm / FallingTree / FTB Teams / Fabrication / Paintings ++）。
   *   根因是 CurseForge 解析下载地址那一段把失败的条目丢了 ——
   *   这一块就是"丢的那几个"被摆到台面上的地方：
   *     · 名字、原因（逐条）；
   *     · 「重新下载缺失的」入口（后端会重新去要地址再下）；
   *     · 全都要人工下时**不给按钮**，只解释为什么（`repairEntry` 判）。
   *
   *   ★ 抽成一份是因为它要在**两个视图**里出现：装完还没离开的那一屏
   *     （`installTarget`）与整合包列表那一屏（用户返回列表后仍然看得见）。
   */
  /*
   * ★ 入口给不给的那个判据（点了必然失败的不给按钮）只有一份：`repairEntry`。
   *   文案（`label`）与 `install-summary` 带出来的那份是**同一个常量**，所以
   *   两处取哪个都行 —— 这里优先取 summary 的（它就是三处共用的那一句的来源）。
   */
  const missingEntry = repairEntry(packMissing);
  const missingPanel =
    packMissing.length > 0 ? (
      /*
       * ★★ 小标题取 `install-summary` 那一句（与任务卡片 / toast **同一句话**）——
       *   它说的是"装好了，但缺 N 个文件"，而不是含糊的"有东西没下下来"。
       *   下面那句仍然用后端算好的措辞（`missingSummary`：点名 3 个 + 总数）。
       */
      <Note tone="warning" icon={<IconAlert />} title={packOutcome?.title ?? undefined}>
        <div>{missingSummary(packMissing)}</div>
        {missingEntry.show ? (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <Button
              size="sm"
              loading={repairingMissing}
              onClick={() => {
                const slug = selectedSlugRef.current;
                if (!slug) return;
                void redownloadMissing(slug);
              }}
            >
              {/* ★ 文案只有一份（`REPAIR_ENTRY_LABEL`，由 `install-summary` 带出来） */}
              {packOutcome?.action ?? missingEntry.label}
            </Button>
          </div>
        ) : null}
        <ul className="pack-missing-list">
          {packMissing.slice(0, 8).map((m) => (
            <li key={m.path}>
              <span className="pack-missing-name">{m.name}</span>
              <span className="pack-missing-why">{m.reason}</span>
            </li>
          ))}
        </ul>
        {packMissing.length > 8 ? (
          <div className="pack-missing-more">还有 {packMissing.length - 8} 个没列出来</div>
        ) : null}
      </Note>
    ) : null;

  /*
   * ★★ 2026-09-23（用户：「整合包安装为什么没做单开一页的设计」）：
   *   选中一个整合包之后，**整页切成安装页**（列表与筛选都让位），带返回。
   *   与资源那四条同一个观感；安装实现仍是下面这一份，没有第二套。
   */
  if (installTarget) {
    return (
      <div style={{ marginTop: 'var(--space-4)' }}>
        {/* ★ 2026-10-09：返回按钮不在这里画了（全站只有顶栏那一个，见上面 `useBackTarget`）。 */}
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <h2 className="section-title">安装整合包</h2>
        </div>
        {/* 装完之后如果要"留在这一屏"（缺文件时就是这样），这一块必须在这里 */}
        {missingPanel}

        <div className="res-detail">
          <div className="res-detail-head">
            {installTarget.icon ? (
              <img className="res-detail-icon" src={installTarget.icon} alt="" />
            ) : (
              <span className="res-detail-icon res-detail-icon-ph" aria-hidden="true" />
            )}
            <div className="res-detail-main">
              <div className="res-detail-title">
                <span className="res-detail-name">{installTarget.name}</span>
              </div>
              <div className="res-detail-desc">{installTarget.summary}</div>
              <div className="res-detail-meta">
                <span className="dim">{installTarget.author}</span>
                <span className="dim">{installTarget.downloads} 次下载</span>
                {/* ★ C-18：来源跟着上面那个来源开关走，不写死「来自 Modrinth」 */}
                <span className="dim">来自 {packSource === 'curseforge' ? 'CurseForge' : 'Modrinth'}</span>
              </div>
            </div>
          </div>

          {/*
            ★★ 2026-09-23 用户（两张截图对比）：「**为啥这俩设计的不一样啊，我喜欢 mod 这样的**」——
              整合包这一页原来在信息卡里塞了一排「实例名称 + 确认并开始安装」，
              而资源安装页（Mod / 资源包 / 光影 / 数据包）是**干净的卡片 + 每一行一个
              「安装这个版本」**。用户要的是后者。
              所以这里**去掉那排**：点某个版本的「安装这个版本」就直接装，
              实例名默认用整合包名（点卡片时已经写进 name，装完还能在版本列表里改名）。
            ★ 两个页面从此**同一个设计**：卡片只负责"这是什么"，动作都在版本行上。
          */}
        </div>

        <div className="dim" style={{ margin: 'var(--space-3) 0' }}>
          {packSource === 'curseforge' ? (
            /*
             * ★★ 2026-09-26：CF 的整合包**能自动装了**（`cf_modpack_install`）。
             *   所以要改的不是"能不能"，而是**提前说清它多一步什么**：
             *   CF 的清单里只有文件编号，装的时候要逐个问接口拿地址 ——
             *   作者禁止第三方下载的那种包会明确报出是哪几个文件。
             */
            <>
              下面列的是它在 CurseForge 上发布的版本。装法与 Modrinth 一样是一键，
              区别只在包里的清单：CurseForge 用 <span className="mono">manifest.json</span>，
              里面只有文件编号，安装时要逐个去问下载地址（进度看顶栏任务中心）。
              <b>作者不允许第三方下载的包装不了</b>，那种会明确告诉你是哪几个文件。
            </>
          ) : null}
        </div>

        {targetVersions === null ? <Spinner label="正在取版本列表…" /> : null}
        {targetVersions && targetVersions.length === 0 ? (
          <Note tone="warning" title="这个整合包没有可下载的版本">
            {/*
              ★ C-1：这句话原来是「上游没有给它发布任何文件 —— 去 Modrinth 项目页看看」——
              而真实原因常常是"我们拿错了接口"（CF 的包去问 Modrinth）。
              现在来源已经走对了，所以空列表的两种原因要分开说。
            */}
            {packSource === 'curseforge'
              ? 'CurseForge 上没有给它发布可下载的文件（或者作者关掉了第三方分发）。'
              : '上游没有给它发布任何文件 —— 去 Modrinth 项目页看看作者的说明。'}
          </Note>
        ) : null}
        {targetVersions && targetVersions.length > 0 ? (
          /*
           * ★★ 2026-09-23 用户：「整合包资源单开的一页也要**版本分类**和**版本推荐**」——
           *   交给 `VersionPicker`（与资源安装页**同一份实现**）：
           *     版本分类 = 顶部 MC 版本 chips + 按大版本折叠分组；
           *     版本推荐 = 最新那个**正式版**挂一个「推荐」标记。
           *   ★ 为什么推荐"最新正式版"而不是"最新"：整合包的 beta/alpha 常常是
           *     作者试水用的，把测试版推给玩家是帮倒忙。
           */
          <VersionPicker
            hit={{
              project_id: installTarget.id,
              slug: installTarget.id,
              title: installTarget.name,
              description: installTarget.summary ?? '',
              author: installTarget.author ?? '',
              downloads: 0,
              icon_url: installTarget.icon ?? null,
              categories: [],
              /*
               * ★ ModrinthHit 还要求这两个字段；整合包卡片上没有它们，给空值即可
               *   （VersionPicker 只用 title / project_id / icon_url —— 见它的 props 说明）。
               */
              project_type: 'modpack',
              versions: [],
            }}
            versions={targetVersions}
            loading={false}
            error={null}
            installing={installing ? installTarget.id : null}
            /*
             * ★ 2026-10-08：「推荐」= **最新的正式版**。
             *   排序已经在 `VersionPicker` 里按发布时间做过了（新的在前），
             *   所以这里取第一个 `release` 就是最新的那个 —— 不再需要自己排序。
             *   ★ 找不到 release 才退到第一条（全是抢先版的情形）。
             */
            recommend={
              (targetVersions.find((v) => v.version_type === 'release') ?? targetVersions[0])?.id
            }
            /* ★ 传给它，好让"整合包不筛 MC 版本、其余筛"这条判据有依据（见那边的对照表） */
            target={target}
            /*
             * ★★ 这一批版本**来自哪一份**（回退时尤其要说 —— 见 `version-sources.ts`）。
             *   措辞由 `versionSourceNote` 算好，这里一个字的措辞都不拼。
             */
            sourceNote={targetVersionsNote}
            onPick={(v) => {
              /*
               * ★★ 2026-09-24（C-5 修复）：**把版本当参数传进去**，不再
               *   `setPickedVersion(v)` + `setTimeout(install, 0)` ——
               *   那样 install 读到的还是上一次渲染的 pickedVersion（null），
               *   结果"点哪一行都装最新那个"。见 install() 的说明。
               */
              setSelected(installTarget);
              setPickedVersion(v);
              setName(name || installTarget.name);
              void install(v);
            }}
            onRetry={() => setTargetVersions(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      {/* ★ 缺的那几个在两个视图里都要看得见（见上面 `missingPanel` 的说明） */}
      {missingPanel}
      {/*
        ★★ 2026-09-23 用户（截图）：「**整合包页做成这样的排版**」——
          照资源页那套：
            第一行：右边一排筛选（`不限版本` + `不限加载器`）+ 排序（整合包没有第二个源，
                    所以那个位置放排序，而不是摆一个点不动的 CurseForge）
            第二行：搜索框 + 「搜索」按钮
      */}
      <div className="res-bar">
        <div className="spacer" />
        <div className="res-filters">
          <div className="res-filter">
            <CustomSelect
              className={mcFilter ? '' : 'is-unset'}
              value={mcFilter}
              onChange={setMcFilter}
              ariaLabel="整合包 MC 版本"
              options={[
                { value: '', label: '不限版本' },
                ...packVersionOptions.map((v) => ({ value: v, label: v })),
              ]}
            />
          </div>
          <div className="res-filter">
            <CustomSelect
              className={loaderFilter ? '' : 'is-unset'}
              value={loaderFilter}
              onChange={setLoaderFilter}
              ariaLabel="整合包加载器"
              options={[
                { value: '', label: '不限加载器' },
                ...PACK_LOADERS.map((l) => ({ value: l.value, label: l.label })),
              ]}
            />
          </div>
        </div>
        {/*
          ★★ 2026-09-23（用户：「**PCL 的整合包可以用 curseforge 啊**」）：
            来源是**用户可选的** —— 与资源页一样放一排分段控件，
            位置也照资源页（筛选右边、排序前面）。
            ★ 后端这一轮给 `ResourceKind` 补了 `modpack`，CurseForge 的 classId=4471，
              所以这一排**不是摆设**：切过去真的查 CF 的整合包。

          ★★★★ 2026-10-17：**最左边加「全部」并设为默认**（用户原话见 ModpackTab
            里 `packSource` 那段）—— 与资源中心那排**同一个顺序、同一个默认**，
            两个页签看起来必须一致（两处不同款正是上一次那个 bug 的成因）。
        */}
        <Segmented
          label="来源"
          size="sm"
          value={packSource}
          onChange={setPackSource}
          options={[
            { value: 'all', label: '全部' },
            { value: 'modrinth', label: 'Modrinth' },
            { value: 'curseforge', label: 'CurseForge' },
          ]}
        />
        <Segmented
          label="排序"
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'hot', label: '热门' },
            { value: 'new', label: '最新' },
            { value: 'downloads', label: '最多下载' },
          ]}
        />
        {/*
          ★★★★ 2026-09-26 用户：「**资源下载里在最多下载的右边加一个选项：
            左是矩阵，右是条形。显示资源 UI 的方式**」。
            ⇒ 就是这一排：左格矩阵（默认）、右格条形。
            ★ 与排序那一排**同一套 `Segmented`**（同一个控件、同一套样式），
              不新写一个"图标开关"——两套控件会漂移。
            ★ 选项只有图标，所以每个都带 `title` 字段 —— 它只进 `aria-label`
              （读屏听到"这是矩阵还是条形"）。**不做悬停提示**（用户 2026-09-26：
              "去掉所有悬停显示描述"）。
        */}
        <Segmented
          label="显示方式"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'grid', label: <IconGrid />, title: '矩阵：一行多个' },
            { value: 'list', label: <IconRows />, title: '条形：一行一个' },
          ]}
        />
      </div>

      {/*
        ★★ 2026-09-26 用户（截图）：「**贴的太近**」——
          搜索框和下面那排卡片之间原来一点间距都没有（`.res-search` 只有内部 gap，
          没有下边距），而上面那排靠的是容器自己的行间距。
          ⇒ 给它补一行下边距，与"筛选 / 搜索 / 结果"三段之间的节奏一致。
      */}
      <div className="res-search">
        <label className="res-search-box">
          <IconSearch />
          <input
            className="input"
            type="search"
            aria-label="搜索整合包"
            placeholder="搜索整合包名称 / 作者 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
        </label>
        <Button variant="primary" size="sm" onClick={() => void load()}>
          搜索
        </Button>
        {/*
          ★★★★ 2026-10-01（用户：「你这根本不下」+ 选了「加一个真正可用的源」）。

          量了一整轮之后的结论：**在 20~40 KB/s 的链路上，任何源都救不了
          118 MB 的包**（官方与镜像此刻都在这个量级，PCL 走的是另一条主机）。
          继续换源是在解一个不存在的问题。

          ⇒ 真正能解决的是**让用户用一个下得动的东西把包下好，再导进来**。
            这条路**代码里早就有**（`installLocalPack`：建任务 → 读清单 →
            按清单装 → 解压 overrides），后端 `modpack.installLocal` 也在，
            但**唯一入口是拖放** —— 没有按钮，很多人不知道可以这样。

          ★ 所以这里只加一个入口，**不新增任何安装逻辑**：
            选文件 → 派发与拖放**同一个事件**（`ieml:install-local-pack`）。
            拖放那条路已经验证过，共用它就等于共用它的验证。
        */}
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            try {
              const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
              const picked = await openDialog({
                directory: false,
                multiple: false,
                title: '选一个已经下好的整合包（.mrpack 或 .zip）',
                filters: [
                  { name: '整合包', extensions: ['mrpack', 'zip'] },
                  { name: '全部文件', extensions: ['*'] },
                ],
              });
              if (typeof picked === 'string') {
                window.dispatchEvent(
                  new CustomEvent('ieml:install-local-pack', { detail: { path: picked } }),
                );
              }
            } catch (e) {
              toast('err', '打不开文件选择器', e instanceof Error ? e.message : String(e));
            }
          }}
        >
          <IconFolder /> 安装本地整合包
        </Button>
      </div>

      {/*
        ★★ 2026-09-26 用户：「**资源下载，数据来源可以不写了**」——
          这一行「数据来自 Modrinth / CurseForge」删掉：
          来源是**玩家自己点的那个开关**，再写一行字复述一遍没有新信息。
      */}

      {error ? (
        <Note
          tone="danger"
          icon={<IconAlert />}
          title="拉取整合包列表失败"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              <IconRefresh /> 重试
            </Button>
          }
        >
          {error}
        </Note>
      ) : null}

      {/*
        ★★ 「全部」下**只有一个源没查成**：结果照常显示（另一边那一份），
          但要说清缺的是哪一边 —— 一个源超时/镜像不通 ≠ 那个源没有这个包
          （ADR-050 的教训）。不说的话，用户会把"这次没查成"读成"CF 上真的没有"。
      */}
      {packSideError && !error ? (
        <Note tone="warning" title="有一个来源这次没查成（不等于它没有）">
          {packSideError}
        </Note>
      ) : null}

      {/*
        ★★ 2026-09-26：**加载中不渲染结果网格** —— 否则骨架会与上一批结果**同时**
          出现在屏幕上（用户截图：上面一排骨架、下面还是切来源之前那 6 个）。
          ★ 用条件渲染而不是 `hidden` 属性：`.grid-cards { display: grid }` 会盖掉
            浏览器默认的 `[hidden] { display: none }`，那样写等于没写（这类"看起来
            生效了其实没有"的写法，本仓库栽过不止一次）。
          ★ 这与 `ResourceBrowser` 那边同一条规矩；两边不同款正是这个 bug 的来源。
          ★ 骨架那一排也带上 `data-view`：条形档下骨架也跟着变成整宽的一条，
            否则"等待"和"结果"又是两种形状（这条规矩当初就是为骨架立的）。
      */}
      {loading ? (
        <div className="grid-cards" data-view={view} aria-busy="true" aria-label="正在加载">
          {Array.from({ length: 6 }, (_, i) => (
            /*
             * ★★ 骨架要**长成结果的样子** —— 2026-09-26 卡片改成"小图标 + 标题"之后
             *   这里也跟着改（骨架与结果不同形状，内容到位时界面会整块跳一下，
             *   这条规矩当初就是为它立的）。
             */
            <div key={i} className="pack-card pack-card-sk">
              <div className="pack-head">
                <span className="sk sk-cover" />
                <div className="pack-body">
                  <span className="sk sk-line w70" />
                  <span className="sk sk-line w45" />
                </div>
              </div>
              <span className="sk sk-line w95" />
              <span className="sk sk-line w35" />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && sorted.length === 0 && !error ? (
        <EmptyState
          title={api ? '没有找到整合包' : '桌面版才能浏览真实整合包'}
          desc={api ? '换个关键词试试。' : '浏览器演示模式下没有在线数据。'}
        />
      ) : null}

      {/*
        ★★ 2026-09-26：**加载中不渲染结果网格** —— 否则骨架会与上一批结果**同时**
          出现在屏幕上（用户截图：上面一排骨架、下面还是切来源之前那 6 个）。
          ★ 用条件渲染而不是 `hidden` 属性：`.grid-cards { display: grid }` 会盖掉
            浏览器默认的 `[hidden] { display: none }`，那样写等于没写（这类"看起来
            生效了其实没有"的写法，本仓库栽过不止一次）。
          ★ 这与 `ResourceBrowser` 那边同一条规矩；两边不同款正是这个 bug 的来源。
      */}
      {loading ? null : (
      /* ★ `data-view` 驱动列宽（矩阵 / 条形）—— 见 `app.css` 里 `.grid-cards` 那段 */
      <div className="grid-cards" data-view={view}>
        {sorted.map((p) => (
          <button
            key={p.id}
            type="button"
            className="pack-card"
            onClick={() => {
              /*
               * ★★ 2026-09-23：点卡片 → 进**独立安装页**（内容区整页切换），
               *   不再把安装面板内联展开在 20 张卡片下面。
               *   `selected` 仍然一起设上：安装那一步用的还是同一份实现。
               */
              setInstallTarget(p);
              setSelected(p);
              setName(p.name);
            }}
          >
            {/*
              ★★★★ 2026-09-26 用户（两张截图，指着 Mod / 资源卡那种样式）：
                「**资源包的图片要不然改成这样的？**」「**整合包的图片要不然改成这样的？**」
                —— 也就是说：封面不做"置顶大图"，改成**小图标在标题左边**
                （与 `res-card` 同一套：44px 圆角图标 + 右边标题/作者）。

              ★ 所以把 `.pack-cover` 那层**收进 `.pack-head`**：
                结构与资源卡对齐，两种卡片从此同一个形状。
              ★ 图挂了仍然退回"分量色条"（`data-has-img='0'`）——
                但现在是**图标尺寸的色块**，不再是一个 96px 的空灰条。
            */}
            <div className="pack-head">
              <div
                className="pack-cover"
                data-weight={p.weight}
                /* ★ 高度判据给在 DOM 属性上，而不是让 CSS 用 `:has(img)` 去猜
                   （理由见 pages.css 里 `.pack-cover[data-has-img]` 的注释） */
                data-has-img={p.icon ? '1' : '0'}
              >
                {p.icon ? (
                  <img
                    src={p.icon}
                    alt=""
                    loading="lazy"
                    /* ★ 关掉原生拖拽：否则按住封面一拖就能把图拖到桌面去 */
                    draggable={false}
                    onError={(e) => {
                      const img = e.currentTarget as HTMLImageElement;
                      img.style.display = 'none';
                      /*
                       * ★ 图挂了就**退回"分量色块"**，别留一个空灰块 ——
                       *   尺寸由 `data-has-img` 决定，所以这里必须一起撤掉。
                       */
                      img.parentElement?.setAttribute('data-has-img', '0');
                    }}
                  />
                ) : null}
              </div>
              <div className="pack-body">
                <div className="pack-name truncate">{p.name}</div>
                <div className="pack-author">by {p.author}</div>
              </div>
            </div>
            <div className="pack-tags">
              <Chip tone="accent">{p.mc}</Chip>
              {/*
                ★★★★ 2026-10-17（用户截图：「curseforge 的整合包，不显示整合包的
                  模组加载器类型」—— 那一格是一个只有「—」的小方块）：

                  **拿不到加载器时，这一格整个不渲染。**

                  原来它渲染 `<Chip>{p.loader}</Chip>`，而 `p.loader` 拿不到时是
                  字符串 `'—'` ⇒ 屏幕上出现一个**像模像样的空格子**。它传达的是
                  "加载器的值是空的"，而正确的事实是"**我们没拿到这个信息**"——
                  与仓库一贯的"不许编"冲突（同类判据见 `friends.ts`：拿不到名单
                  只能显示「未知」，不许写成「离线」）。

                  ★ 取值本身**两个源同一套**（小写规范串，与 Modrinth 逐字节同形状），
                    不在这里为来源分两套渲染。
              */}
              {p.loader !== null ? <Chip tone="neutral">{p.loader}</Chip> : null}
            </div>
            <div className="pack-meta">{p.downloads} 次下载</div>
          </button>
        ))}
      </div>
      )}

      {/* ★ 翻页（原来写死前 20 个，翻不动）—— 抽到 `Pager` 之后与资源列表同一份实现 */}
      {!loading && total > PAGE_SIZE ? (
        <Pager
          page={page + 1}
          pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          total={total}
          canPrev={page > 0}
          canNext={(page + 1) * PAGE_SIZE < total}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => p + 1)}
          onGo={(n) => setPage(n - 1)}
        />
      ) : null}

      {/*
        ★★★★ 2026-10-08（用户两张截图：「**最下面这是什么啊，不要这个**」、
          「到下面后，下载文本会画上去，只剩下一片模糊」）：
          **底部这块内联配置面板删掉了。**

        ## 它为什么会冒出来

          它是"点卡片 → 在列表底部展开配置面板"那套**旧流程**留下的。
          2026-09-23 之后点卡片改成**整页切到安装页**（`installTarget` 那条提前
          return），于是它成了一段**谁也用不到、却仍然会渲染**的东西：

            · `selected` 在点卡片时就一起被设上了（见 `.pack-card` 的 onClick）；
            · 而下面那个 `useEffect` 监听的是 `selected` —— 它**照样
              `scrollIntoView` 并把输入框聚焦**，于是页面被滚到最底下，
              露出这个面板。用户看到的就是"最下面这是什么啊"。
            · 而"一片模糊"是第二个后果：面板的文字滚到 `position: sticky`
              的**页头**（`backdrop-filter` 毛玻璃）底下穿过，被糊成一片。

        ## 为什么可以直接删（而不是挪个位置）

          它的**唯一**用途是那个"实例名称"输入框，而单开安装页**有意没有**它 ——
          见上面那段注释：「点某个版本的『安装这个版本』就直接装，
          实例名默认用整合包名（点卡片时已经写进 name，装完还能在版本列表里改名）」。
          ⇒ 它已经是**死代码**：留着只会自己滚出来吓人。
          ★ 实例名仍然可改（版本列表里改名），没有任何能力因此丢失。
      */}
    </div>
  );
}

