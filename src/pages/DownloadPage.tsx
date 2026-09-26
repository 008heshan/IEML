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
import { Button, Chip, CustomSelect, EmptyState, Note, Segmented, Spinner } from '../ui';
import { IconAlert, IconBox, IconChevronRight, IconDownload, IconLayers, IconPuzzle, IconRefresh, IconImage, IconGrid, IconRows, IconPackage, IconSearch } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import type { DownloadTab } from '../state/store';
import { InstallComposer } from '../components/InstallComposer';
import { ResourceCenterBody, VersionPicker } from '../components/ResourceBrowser';
import { autoMemory, compareVersion, isSnapshotVersion, knownVersions } from '../domain';
// ★ C-26：取消不是故障 —— 判据只有一处（见 `domain/cancel.ts` 的说明）
import { isCancellation } from '../domain/cancel';
import type { Instance } from '../domain';
import type { ModrinthVersion, ResourceKindName } from '../bridge/tauri';
import { registerTaskReplay } from '../flows/install';

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

export function DownloadPage() {
  /* ★ 2026-09-23：「装到」选择器已删 → setDownloadTarget 没有调用方了（不留未用变量） */
  const { state, go, toast, setDownloadTab } = useApp();
  const { isDesktop } = useRealApi();
  const tab = state.downloadTab;

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

  return (
    <div className="page-fill">
      {inModpackInstall || inLoaderPage ? null : (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">下载</h1>
              <p className="page-desc">游戏版本 · 整合包 · Mod · 资源包 · 光影 · 数据包</p>
            </div>
            {!isDesktop ? <Chip tone="warning">浏览器演示模式 —— 真实下载要桌面版</Chip> : null}
          </div>

          <div className="tabs" role="tablist" aria-label="下载内容">
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
          </div>
        </>
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
          isDesktop={isDesktop}
          onInstallViewChange={setInModpackInstall}
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
                compactHead
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
  loader: string;
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
}

function ModpackTab({
  go,
  toast,
  isDesktop,
  onInstallViewChange,
}: {
  go: (p: 'launch' | 'versions' | 'download' | 'settings') => void;
  toast: (k: 'ok' | 'err' | 'info' | 'warning', t: string, d?: string) => void;
  isDesktop: boolean;
  /**
   * ★★ 2026-09-23（用户：「mod 页面会进入自己的专属页，是一个全屏页，**为什么整合包的还会显示**」）：
   *   进了整合包安装页要通知外层把**下载页的页头与页签**收起来 —— 这样它和
   *   Mod 那条路（独立路由整屏替换）**看起来完全一样**。
   */
  onInstallViewChange?: (inInstall: boolean) => void;
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
  /*
   * ★★ 2026-09-23：整合包的**来源**（Modrinth / CurseForge）。
   *   用户：「PCL 的整合包可以用 curseforge 啊」—— 它本来就是一个来源选项，
   *   资源搜索那条路（`resourceSearch`）早就支持两个源。
   */
  const [packSource, setPackSource] = useState<'modrinth' | 'curseforge'>('modrinth');
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
  /** 安装面板（在 20 张卡片之后 —— 不滚过去用户会以为"点了没反应"） */
  const installPanelRef = useRef<HTMLDivElement | null>(null);
  const installNameRef = useRef<HTMLInputElement | null>(null);
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
       */
      const r = await api.modrinth.resourceSearch({
        kind: 'modpack',
        query: query || '',
        mcVersion: mcFilter || undefined,
        loader: loaderFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        // ★ 来源由用户选（Modrinth / CurseForge）—— 见上面那段说明
        source: packSource,
      });
      if (mine !== seq.current) return; // ★ 迟到的结果丢掉（否则旧来源的结果会盖掉新的）
      setTotal(r.total_hits ?? 0);
      setPacks(
        r.hits.map((h) => ({
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
          loader: h.categories.find((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)) ?? '—',
          downloads: h.downloads > 1000 ? `${Math.round(h.downloads / 1000)}k` : String(h.downloads),
          weight: 'medium' as const,
          icon: h.icon_url ?? null,
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
   *   现在选中就把它**滚进视野**并聚焦输入框：点完立刻看到"可以装"。
   */
  useEffect(() => {
    if (!selected) return;
    installPanelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 聚焦要等滚动起步之后再给，否则浏览器会把页面拉回去
    const t = window.setTimeout(() => installNameRef.current?.focus({ preventScroll: true }), 320);
    return () => window.clearTimeout(t);
  }, [selected]);

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

  const sorted = useMemo(() => {
    const list = [...packs];
    if (sort === 'downloads') {
      return list.sort(
        (a, b) => parseFloat(b.downloads.replace('k', '')) - parseFloat(a.downloads.replace('k', '')),
      );
    }
    if (sort === 'new') return list.reverse();
    return list;
  }, [packs, sort]);

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
  useEffect(() => {
    onInstallViewChange?.(installTarget !== null);
  }, [installTarget, onInstallViewChange]);
  const [targetVersions, setTargetVersions] = useState<ModrinthVersion[] | null>(null);
  /** 页面里点了「安装这个版本」时选中的那一个（null = 用最新那个） */
  const [pickedVersion, setPickedVersion] = useState<ModrinthVersion | null>(null);

  useEffect(() => {
    if (!installTarget || !api) return;
    setTargetVersions(null);
    /*
     * ★★ 2026-09-24（C-1 修复）：这里原来调 `api.modrinth.versions(installTarget.id)` ——
     *   于是**来源选了 CurseForge 也照样去问 Modrinth**：CF 的数字 project id
     *   在 Modrinth 上查出的是别的项目（或者 404），真机表现就是报告里那句
     *   「来自 Modrinth」+「这个整合包没有可下载的版本」。
     *   现在走 source-aware 的 `resource_versions`（CF → `curseforge::files`）。
     */
    void api.modrinth
      .resourceVersions({ kind: 'modpack', projectId: installTarget.id, source: packSource })
      .then(setTargetVersions)
      .catch(() => setTargetVersions([]));
  }, [installTarget, api, packSource]);

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
     * ★★ 2026-09-24（C-1）：**CurseForge 的整合包还不能自动安装** —— 必须在这里如实拦住。
     *
     *   两种包的清单格式不同：
     *     · Modrinth 的 `.mrpack`  → 里面有 `modrinth.index.json`（`mrpack_inspect` 会读它）；
     *     · CurseForge 的 `.zip`   → 里面是 `manifest.json` + `files[{projectID,fileID}]`，
     *       每个文件都要再去问一次 CF 的文件接口才拿得到下载地址。
     *
     *   后者**没有实现**（不是网络问题、也不是"上游没发布文件"）。
     *   以前这一页在 CF 来源下会拿 CF 的数字 id 去问 Modrinth，报出
     *   「这个整合包没有可下载的版本」—— 一句把"我们没做"说成"上游没有"的假话
     *   （这个仓库为这类话栽过不止一次）。
     */
    if (packSource === 'curseforge') {
      toast(
        'warning',
        'CurseForge 的整合包还不能自动安装',
        `${pack.name} 在 CurseForge 上。CF 用的是 manifest.json 清单格式，` +
          `IEML 现在只会装 Modrinth 的 .mrpack —— **这一步没有做**（不是网络问题）。\n` +
          `想看能装的版本，把上面的来源切回 Modrinth（同一个整合包通常两边都有）。`,
      );
      return;
    }
    setInstalling(true);
    try {
      /*
       * ★★ 2026-09-23：**页面里挑了版本就用它**；没挑才退回"最新那个"。
       *   内联面板时代只能装最新那个版本 —— 用户在安装页里选了半天，
       *   装的却还是最新，那就成了假控件。
       */
      const first = version ?? pickedVersion ?? (await api.modrinth.versions(pack.id))[0];
      const file = first?.files.find((f) => f.primary) ?? first?.files[0];
      if (!file) throw new Error('这个整合包没有可下载的文件');

      // 先读清单，把"要装什么"如实告诉用户，再动手
      const info = await api.modpack.inspect(file.url);
      if (!info.mc_version) {
        throw new Error('这个整合包的清单里没写游戏版本，无法安装');
      }
      const packName = name.trim() || info.name || pack.name;
      const slug = `pack-${Date.now().toString(36).slice(-6)}`;

      // ★ 建任务：任务中心里能看到真实阶段与文件计数（不是假的进度条）
      const taskId = `modpack-${Date.now().toString(36)}`;
      window.dispatchEvent(
        new CustomEvent('ieml:task-add', {
          detail: {
            id: taskId,
            kind: 'install',
            title: `整合包 ${packName}`,
            detail: `${info.mc_version}${
              info.loader_kind ? ` + ${info.loader_kind} ${info.loader_version ?? ''}` : ''
            } · ${info.client_file_count} 个文件`,
            status: 'running',
            percent: 0,
            finishedFiles: 0,
            bytesPerSecond: 0,
            currentFile: '',
            etaSeconds: 0,
          },
        }),
      );
      const patch = (p: Record<string, unknown>) =>
        window.dispatchEvent(
          new CustomEvent('ieml:task-patch', { detail: { id: taskId, patch: p } }),
        );

      /*
       * ★ 注册重放函数：整合包安装不在 `flows/install` 的 pendingJobs 里，
       *   于是任务中心的「继续」「重试」对它静默失效（审计发现）。
       *   注册之后这两个按钮对整合包也真的能用（断点续传靠 .part）。
       */
      const doInstall = () =>
        api.modpack.install(
          {
            url: file.url,
            name: info.name,
            slug,
            taskId,
            instanceName: packName,
            source: 'bmclapi',
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

      const result = await doInstall();

      /*
       * ★★ **被暂停就不算装完**（P0-3）：不许建实例、不许说"安装完成"。
       *
       *   老行为是：暂停之后照样往下跑、照样建实例、提示"整合包装好了"，
       *   而 `instances.json` 里多出一个**起不来**的空壳。
       *   现在如实标记「已暂停」，任务中心的「继续」用同一套参数接着下。
       */
      if (result.paused) {
        patch({
          status: 'paused',
          detail:
            result.remaining_files > 0
              ? `已暂停 · 还剩 ${result.remaining_files} 个文件`
              : '已暂停',
        });
        toast(
          'info',
          '已暂停',
          `${packName} 还剩 ${result.remaining_files} 个文件没下，点「继续」接着装`,
        );
        return; // `finally` 会把 installing 放回 false
      }

      // ★ 装完才建实例（失败不会在列表里留下一个起不来的空壳）
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

      patch({ status: 'done', percent: 100, detail: '安装完成' });
      toast(
        'ok',
        '整合包装好了',
        `${packName} · ${result.mc_version}${
          result.loader_kind ? ` + ${result.loader_kind}` : ''
        } · ${result.mod_files} 个文件 + ${result.override_files} 个配置`,
      );
      setSelected(null);
      go('versions');
    } catch (e) {
      /*
       * ★★ 2026-09-24（C-26 修复）：用户自己点「取消」时抛出来的是
       *   「任务被取消」（Rust）/「已取消」（浏览器桥）—— 以前一律弹**红色「安装失败」**，
       *   等于把用户自己的操作说成故障。取消 = 正常结果，说清"停下了、文件保留"。
       */
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
   * ★★ 2026-09-23（用户：「整合包安装为什么没做单开一页的设计」）：
   *   选中一个整合包之后，**整页切成安装页**（列表与筛选都让位），带返回。
   *   与资源那四条同一个观感；安装实现仍是下面这一份，没有第二套。
   */
  if (installTarget) {
    return (
      <div style={{ marginTop: 'var(--space-4)' }}>
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <Button size="sm" variant="ghost" onClick={() => setInstallTarget(null)}>
            <IconChevronRight style={{ transform: 'rotate(180deg)' }} /> 返回整合包列表
          </Button>
          <h2 className="section-title">安装整合包</h2>
        </div>

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
            /* ★ C-1：CF 的清单格式不一样，这里**提前说清**，别让用户点下去才知道 */
            <>
              下面列的是它在 CurseForge 上发布的版本。★ <b>CF 的整合包 IEML 还不能自动安装</b> ——
              它用的是 <span className="mono">manifest.json</span>，而自动安装目前只支持 Modrinth 的{' '}
              <span className="mono">.mrpack</span>（这一步没有做，不是网络问题）。
              想看能装的版本，把上面的来源切回 Modrinth。
            </>
          ) : (
            <>
              版本、加载器、Mod 清单都由包里的 <span className="mono">modrinth.index.json</span> 定死 ——
              下面按**游戏版本**分类列出它发布的版本。
            </>
          )}
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
            recommend={
              (targetVersions.find((v) => v.version_type === 'release') ?? targetVersions[0])?.id
            }
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
        */}
        <Segmented
          label="来源"
          size="sm"
          value={packSource}
          onChange={setPackSource}
          options={[
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
            ★ 选项只有图标，所以每个都带 `title`：它同时进 `aria-label`
              与 `title`（读屏与悬停都能听到"这是矩阵还是条形"）。
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
              <Chip tone="neutral">{p.loader}</Chip>
            </div>
            <div className="pack-meta">{p.downloads} 次下载</div>
          </button>
        ))}
      </div>
      )}

      {/* ★ 翻页（原来写死前 20 个，翻不动） */}
      {!loading && total > PAGE_SIZE ? (
        <div className="pager">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            上一页
          </Button>
          <span className="pager-info">
            第 {page + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页 · 共 {total} 个
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      ) : null}

      {/* 配置面板（内联展开，不用弹窗 —— 弹窗会遮住刚选的包） */}
      {selected ? (
        <div className="setup-panel" ref={installPanelRef}>
          <div className="setup-head">
            <span className="si">
              <IconBox />
            </span>
            <div>
              <div className="setup-t">安装「{selected.name}」</div>
              <div className="setup-s">{selected.summary}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              取消
            </Button>
          </div>

          <div className="setup-body">
            <div className="setup-block">
              <div className="setup-label">实例名称</div>
              <div className="setup-field">
                <input
                  ref={installNameRef}
                  className="input"
                  value={name}
                  aria-label="实例名称"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            <div className="setup-foot">
              <span className="dim">版本、加载器、Mod 清单都由包里的 modrinth.index.json 定死</span>
              <div className="spacer" />
              <Button variant="ghost" onClick={() => setSelected(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                loading={installing}
                disabled={!isDesktop}
                onClick={() => void install()}
              >
                确认并开始安装
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

