/**
 * 社区资源中心：Mod / 整合包 / 资源包 / 光影 / 数据包 —— **同一套界面**。
 * ------------------------------------------------------------------
 * ## 照 PCL 的 `Modules/Resource/*` 做的
 *
 * PCL 那边是六个文件约 2300 行（`ResourceProject` / `ResourceSearcher` /
 * `ResourceVersion` / `LocalResourceLoaders` / `LocalResourceFile`），
 * 配五个页面（Mod / 整合包 / 资源包 / 光影 / 数据包）。
 * **它们不是五个功能，是同一套抽象的五种实例。**
 *
 * ## 这个组件的所有差异都来自后端那张表
 *
 * 五种资源的差别只有四件事：到哪查、装到哪、认哪些扩展名、要不要挑加载器。
 * 那四件事**只有一份描述**（`domain/resources.rs`），界面启动时取一次
 * （`api.modrinth.resourceKinds()`）。所以这里没有 `if (kind === 'shader')`
 * 之类的分支 —— 加一种资源不需要动这个文件。
 *
 * ## 0.1.0-beta.1 的四条重做（用户逐条提的）
 *
 * ① **打开就列出来，不让玩家先搜** —— 以前空关键词虽然会搜一次，但结果列表
 *    是"一行文字 + 一个安装按钮"，玩家记不住 Mod 名就无从下手。现在默认列出
 *    热门/推荐（空关键词查询），并且**卡片带封面、下载量、简介**。
 * ② **能翻页** —— 以前写死 `limit: 20`、没有 offset 入口，热门 Mod 有几千个，
 *    玩家永远只能看到前 20 个。现在有「加载更多」并按 total 显示进度。
 * ③ **版本由玩家选，不由我们替他挑** —— 以前点「安装」直接 `versions[0]`。
 *    玩家一定有"我就要 1.20.1 上的 0.5.8 那个版本"的需求（整合包尤其明显），
 *    所以现在点「安装」先展开**这个项目的版本列表**（版本号 / MC / 加载器 /
 *    发布时间 / 体积），选完再装。列表顶部额外给一句"最新兼容版是哪个"，
 *    但**不替玩家决定**。
 * ④ **封面** —— Modrinth 的 `icon_url`、CurseForge 的 logo 都取回来了，
 *    卡片上就该显示出来；没有封面的项目用一个按标题生成的字母块兜底。
 *
 * ★ 资源包/光影/数据包**不筛加载器**：带上加载器 facet 会把结果集砍到
 *   几乎没有，而用户会以为"没有这个资源"（把"查不到"说成"没有"，
 *   是这个仓库反复栽过的坑）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Modal, Note, Segmented, Spinner } from '../ui';
import { IconDownload, IconRefresh, IconSearch } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import type { Instance } from '../domain';
import type {
  ModrinthHit,
  ModrinthVersion,
  ResourceKindInfo,
  ResourceKindName,
  ResourceSourceName,
} from '../bridge/tauri';

export interface ResourceBrowserProps {
  open: boolean;
  onClose: () => void;
  /** 装到哪个实例里（决定了 MC 版本与加载器） */
  instance: Instance | null;
  /** 打开时默认选中的种类 */
  initialKind?: ResourceKindName;
  /** 装完一个之后（ModsPanel 用它重新读盘） */
  onInstalled?: (kind: ResourceKindName, title: string) => void;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
}

/**
 * 两个来源（ADR-052）。
 *
 * ★ 界面上必须让用户看得见"现在搜的是哪个库"，而且切换之后要说清
 *   **两边的内容不一样**：Modrinth 与 CurseForge 是两批作者、两套审核，
 *   同一个 Mod 可能只在其中一边。查不到 ≠ 不存在（ADR-050 的教训）。
 */
const SOURCES: Array<{ key: ResourceSourceName; label: string; hint: string }> = [
  { key: 'modrinth', label: 'Modrinth', hint: '开源、无需 key' },
  {
    key: 'curseforge',
    label: 'CurseForge',
    hint: '内容更多；作者可以禁止第三方分发，那样的项目下不了',
  },
];

/**
 * 一面的一页有多少个。
 * ★ 20 是 Modrinth 接口允许的上限（再多它会自己截断），所以"翻页"就是
 *   反复取 20 个 —— 界面上按"页"表达，接口上按 offset 表达。
 */
const PAGE = 20;

/** 下载量显示（大数变 k/M，避免一长串数字） */
function humanDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/** 体积显示 */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function humanDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

/**
 * 封面：有 `icon_url` 就用它，没有就画一个"首字母块"。
 *
 * ★ 为什么允许失败：封面图来自第三方 CDN，换了机器/断网就是白框。
 *   `onError` 时换成字母块 —— **不留破图**（破图比没有图更难看，
 *   而且会让人以为界面坏了）。
 */
function Cover({ hit, size = 44 }: { hit: ModrinthHit; size?: number }) {
  const [broken, setBroken] = useState(false);
  const letter = (hit.title || '?').trim().slice(0, 1).toUpperCase();
  const style = { width: size, height: size, borderRadius: 8 } as const;
  if (!hit.icon_url || broken) {
    return (
      <div className="res-cover res-cover-letter" style={style} aria-hidden="true">
        {letter}
      </div>
    );
  }
  return (
    <img
      className="res-cover"
      style={style}
      src={hit.icon_url}
      alt=""
      loading="lazy"
      /* ★ 与整合包封面同一条规矩：关掉原生拖拽，别让图能被拖出窗口 */
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

/** 一个项目的版本列表（玩家在这里挑，不由我们替他挑） */
function VersionPicker({
  hit,
  versions,
  loading,
  error,
  installing,
  onPick,
  onRetry,
}: {
  hit: ModrinthHit;
  versions: ModrinthVersion[] | null;
  loading: boolean;
  error: string | null;
  installing: string | null;
  onPick: (v: ModrinthVersion) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="res-versions">
        <Spinner label="正在取版本列表…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="res-versions">
        <Note
          tone="danger"
          title="版本列表没取到"
          actions={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <IconRefresh /> 重试
            </Button>
          }
        >
          {error}
        </Note>
      </div>
    );
  }
  if (!versions || versions.length === 0) {
    return (
      <div className="res-versions">
        <div className="res-none">无</div>
      </div>
    );
  }
  return (
    <div className="res-versions">
      <div className="res-versions-head">
        {/*
          ★ 2026-09-16 用户（截图）：删掉"—— 自己挑一个装"和右边那句
            "第一个是上游最新发布的，不代表'最适合你'"。
        */}
        <span>
          <b>{hit.title}</b> 的全部版本（{versions.length} 个）
        </span>
      </div>
      <div className="res-version-list">
        {versions.map((v) => {
          const file = v.files.find((f) => f.primary) ?? v.files[0];
          const blocked = !!file && !file.url;
          return (
            <div key={v.id} className="res-version">
              <div className="res-version-main">
                <div className="res-version-name">
                  <span className="mono">{v.version_number || v.name}</span>
                  {v.version_type !== 'release' ? (
                    <Chip tone={v.version_type === 'beta' ? 'info' : 'warning'}>
                      {v.version_type === 'beta' ? '测试版' : '抢先版'}
                    </Chip>
                  ) : null}
                </div>
                <div className="res-version-meta">
                  <span className="dim mono">{humanDate(v.date_published)}</span>
                  {v.game_versions.length > 0 ? (
                    <span className="dim">MC {v.game_versions.slice(0, 6).join(' / ')}</span>
                  ) : null}
                  {v.loaders.length > 0 ? <span className="dim">{v.loaders.join(' / ')}</span> : null}
                  {file ? <span className="dim mono">{humanBytes(file.size)}</span> : null}
                </div>
              </div>
              {blocked ? (
                <Chip tone="warning">作者不允许第三方下载</Chip>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  loading={installing === v.id}
                  onClick={() => onPick(v)}
                >
                  <IconDownload /> 安装这个版本
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ==================================================================
   主体：**能独立放在页面里**（下载页就是这么用的）
   ================================================================== */

export interface ResourceCenterBodyProps {
  kind: ResourceKindName;
  onKindChange: (k: ResourceKindName) => void;
  /** 装到哪个实例（null = 还没有版本，只能看不能装） */
  instance: Instance | null;
  onInstalled?: (kind: ResourceKindName, title: string) => void;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
  /** 页面形态下由外面给标题（弹窗形态下写在 Modal 上） */
  compactHead?: boolean;
  /**
   * 隐藏种类页签（下载页用）。
   *
   * ★ 下载页**最外层**已经有「Mod / 资源包 / 光影 / 数据包」四个页签了，
   *   再在里面长一排一模一样的四格，就是用户说的"下载页上下重复"。
   *   这里只留需要的东西：来源切换 + 搜索 + 结果。
   */
  hideKindTabs?: boolean;
}

export function ResourceCenterBody({
  kind,
  onKindChange,
  instance,
  onInstalled,
  toast,
  compactHead = false,
  hideKindTabs = false,
}: ResourceCenterBodyProps) {
  const { api } = useRealApi();

  /** 后端给的五种资源描述（**唯一一份**） */
  const [kinds, setKinds] = useState<ResourceKindInfo[]>([]);
  const [kindsError, setKindsError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** ★ 搜哪个库（ADR-052）：两个源的结果形状一样，但内容不是同一批 */
  const [source, setSource] = useState<ResourceSourceName>('modrinth');
  /** 后端如实告诉我们的"这批结果从哪来"（不靠前端猜） */
  const [resultSource, setResultSource] = useState<string | null>(null);

  /** 展开了哪个项目的版本列表（项目 id） */
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[] | null>(null);
  const [verLoading, setVerLoading] = useState(false);
  const [verError, setVerError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  /* 竞争保护：快速切种类/来源时，先发的那次请求后回来会写错列表 */
  const seq = useRef(0);

  const current = useMemo(() => kinds.find((k) => k.key === kind) ?? null, [kinds, kind]);

  /* ---------- 取资源描述（挂载时一次） ---------- */
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.modrinth
      .resourceKinds()
      .then((list) => {
        if (!alive) return;
        setKinds(list);
        setKindsError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setKindsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  /**
   * 取一页。
   *
   * ★ `append = false` 是"换条件重搜"（要清空），`append = true` 是「加载更多」。
   */
  const load = useCallback(
    async (opts: { k: ResourceKindName; q: string; src: ResourceSourceName; offset: number; append: boolean }) => {
      if (!api) return;
      const mine = ++seq.current;
      if (opts.append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const r = await api.modrinth.resourceSearch({
          kind: opts.k,
          query: opts.q,
          // ★ 没有实例就没有 MC 版本可筛 —— 传 undefined 让后端只按种类查
          mcVersion: instance?.mcVersion,
          // ★ 只有需要挑加载器的种类才传（后端也会再兜一层，这里是"别白传"）
          loader: current?.needs_loader_filter ? (instance?.loader?.kind ?? undefined) : undefined,
          limit: PAGE,
          offset: opts.offset,
          source: opts.src,
        });
        if (mine !== seq.current) return; // 迟到的结果丢掉
        setHits((prev) => (opts.append ? [...prev, ...r.hits] : r.hits));
        setTotal(r.total_hits ?? r.hits.length);
        setResultSource(r.source ?? opts.src);
      } catch (e) {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        if (!opts.append) {
          setHits([]);
          setTotal(0);
          setResultSource(null);
        }
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, instance?.mcVersion, instance?.loader?.kind, current?.needs_loader_filter],
  );

  /* 切种类 / 切来源 / 换实例 → 回到第一页并重搜（**打开就列出来**，不用先点搜索） */
  useEffect(() => {
    setPage(1);
    setOpenProject(null);
    setVersions(null);
    void load({ k: kind, q: query, src: source, offset: 0, append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, source, instance?.id, current?.key]);

  const hasMore = hits.length < total;


  /**
   * 跳到第 n 页（分页条的"上一页/下一页"都走这里）。
   *
   * ★ 两个方向**语义不同**，所以这里必须分开写（见下面分页条的注释）：
   *   · 往后（n > page）→ `append: true`，接着堆；
   *   · 往回（n < page）→ `append: false`，清空重取第一屏。
   * 用同一个 append 值会让"上一页"变成"把第 1 页接到最后面"。
   */
  async function gotTo(n: number) {
    if (n < 1 || loadingMore) return;
    const forward = n > page;
    setPage(n);
    await load({
      k: kind,
      q: query,
      src: source,
      offset: (n - 1) * PAGE,
      append: forward,
    });
  }

  async function runSearch() {
    setPage(1);
    setOpenProject(null);
    setVersions(null);
    await load({ k: kind, q: query, src: source, offset: 0, append: false });
  }

  /* ---------- 展开某个项目的版本列表 ---------- */
  /** 取版本（**不切开关**，重试按钮也走它） */
  const loadVersions = useCallback(
    async (hit: ModrinthHit) => {
      if (!api) return;
      setVersions(null);
      setVerError(null);
      setVerLoading(true);
      try {
        const list = await api.modrinth.resourceVersions({
          kind,
          projectId: hit.project_id,
          mcVersion: instance?.mcVersion,
          loader: current?.needs_loader_filter ? (instance?.loader?.kind ?? undefined) : undefined,
          source,
        });
        setVersions(list);
      } catch (e) {
        setVerError(e instanceof Error ? e.message : String(e));
      } finally {
        setVerLoading(false);
      }
    },
    [api, kind, instance?.mcVersion, instance?.loader?.kind, current?.needs_loader_filter, source],
  );

  async function toggleVersions(hit: ModrinthHit) {
    if (openProject === hit.project_id) {
      setOpenProject(null);
      return;
    }
    setOpenProject(hit.project_id);
    await loadVersions(hit);
  }

  /* ---------- 装玩家选中的那一个版本 ---------- */
  async function installVersion(hit: ModrinthHit, ver: ModrinthVersion) {
    if (!api || !instance || !current) return;
    /*
     * ★★ 作者禁止第三方分发（CurseForge 专有）→ **提前拦住并说清原因**。
     *   `distribution_allowed === false` 表示作者在 CurseForge 上关掉了
     *   "允许第三方分发"，那种项目的文件 `downloadUrl` 是 null。
     */
    if (hit.distribution_allowed === false) {
      toast(
        'warning',
        '作者不允许第三方下载',
        `${hit.title} 在 CurseForge 上关掉了「允许第三方分发」，任何启动器都下不到它。` +
          (hit.page_url ? ` 去项目页自己下：${hit.page_url}` : ' 到 CurseForge 项目页自己下载。'),
      );
      return;
    }
    const file = ver.files.find((f) => f.primary) ?? ver.files[0];
    if (!file) {
      toast('warning', '没有可下载文件', `${hit.title} ${ver.version_number} 这个版本没有文件`);
      return;
    }
    if (!file.url) {
      toast(
        'warning',
        '这个文件下不了',
        `${hit.title} ${ver.version_number} 在 CurseForge 上没有下载地址 —— ` +
          `多半是作者关掉了「允许第三方分发」。去项目页自己下再放进去。`,
      );
      return;
    }
    setInstalling(ver.id);
    try {
      const path = await api.modrinth.installResource(
        kind,
        file.url,
        file.filename,
        instance.config.slug,
        file.hashes?.sha1,
      );
      toast('ok', `已装好${current.display}`, `${hit.title} ${ver.version_number} → ${path}`);
      if (current.install_note) toast('info', '还有一步', current.install_note);
      onInstalled?.(kind, hit.title);
    } catch (e) {
      toast('err', '下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="res-center">
      {kindsError ? (
        <Note tone="danger" title="拿不到资源种类表">
          {kindsError}
        </Note>
      ) : null}

      {/*
        种类 + 来源做成一排（0.1.0-beta.1）：
        以前是"来源两个大按钮在上、种类页签在下"两行，占了首屏两条。
      */}
      <div className="res-bar">
        {hideKindTabs ? null : (
          <div className="tabs res-tabs" role="tablist" aria-label="资源种类">
            {kinds.map((k) => (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={k.key === kind}
                className={`tab${k.key === kind ? ' on' : ''}`}
                onClick={() => onKindChange(k.key)}
              >
                <span>{k.display}</span>
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {/* ★ 来源用现成的 Segmented —— 别再造一套"看起来像分段控件"的东西 */}
        <Segmented
          label="内容来源"
          size="sm"
          value={source}
          onChange={setSource}
          options={SOURCES.map((s) => ({ value: s.key, label: s.label }))}
        />
      </div>

      <div className="res-search">
        <label className="res-search-box">
          <IconSearch />
          <input
            className="input"
            type="search"
            aria-label={`搜索${current?.display ?? '资源'}`}
            /* ★ 2026-09-16 用户（截图）：占位符里"（留空 = 看热门）"删掉，只留"搜索XX" */
            placeholder={`搜索${current?.display ?? '资源'}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
        </label>
        <Button variant="primary" size="sm" onClick={() => void runSearch()}>
          搜索
        </Button>
        {/*
          ★ 2026-09-16 用户（截图）：这里原来有一行"装到「版本名」· 26.2 + fabric 的 mods/"
            （资源包页签是"的 resourcepacks 目录"）—— 用户要求删掉。
          ★ 来历要说清：这一行是 **beta.26 用户自己要求加的**（"装到哪写清"），
            这次是用户看过之后决定不要了。别再当成"以前的需求"加回来。
        */}
      </div>

      {error ? (
        <Note
          tone="danger"
          title="搜索失败"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void runSearch()}>
              <IconRefresh /> 重试
            </Button>
          }
        >
          {error}
          <div className="dim" style={{ marginTop: 4 }}>
            这不等于"没有这个资源" —— 网络或
            {SOURCES.find((s) => s.key === source)?.label ?? '在线库'} 的问题；
            也可以换个来源看看（两个库收录的内容不一样）。
          </div>
        </Note>
      ) : null}

      {/*
        ★★ 加载骨架要**长成卡片的样子**（用户："这里 mod，资源包，数据包，光影，还有整合包，
        这种都是卡片，为什么加载动画是连成一片的"）。

        原来这里是 `<Skeleton rows={5} height={64}/>` —— 五行等宽长条铺满整行，
        在卡片网格里看就是一整块灰板；而加载完之后是**卡片**，于是"等待"和"结果"
        是两种完全不同的形状，内容到位时界面会整体跳一下。

        现在骨架排成**同一套网格**（同样列宽 + 封面方块 + 三行文字），
        内容到位是"填进去"，不是"换了一种布局"。
      */}
      {loading ? (
        <div className="res-grid" aria-busy="true" aria-label="正在加载">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="res-card res-card-sk">
              <div className="res-card-head">
                <span className="sk sk-cover" />
                <span className="res-card-title">
                  <span className="sk sk-line w70" />
                  <span className="sk sk-line w45" />
                </span>
              </div>
              <span className="sk sk-line w95" />
              <span className="sk sk-line w80" />
              <span className="sk sk-line w35" />
            </div>
          ))}
        </div>
      ) : null}

      {!loading && hits.length === 0 && !error ? (
        <div className="res-none">
          无{query ? `（没搜到「${query}」）` : ''}
        </div>
      ) : null}

      <div className="res-grid">
        {hits.map((hit) => (
          <div key={hit.project_id} className={'res-card' + (openProject === hit.project_id ? ' open' : '')}>
            <div className="res-card-head">
              <Cover hit={hit} />
              <div className="res-card-title">
                <div className="res-name">{hit.title}</div>
                <div className="res-sub">
                  <span className="mono">{humanDownloads(hit.downloads)} 下载</span>
                  {hit.author ? <span>by {hit.author}</span> : null}
                </div>
              </div>
            </div>
            <div className="res-desc">{hit.description}</div>
            <div className="res-tags">
              {hit.categories.slice(0, 3).map((c) => (
                <Chip key={c} tone="neutral">
                  {c}
                </Chip>
              ))}
              {hit.distribution_allowed === false ? (
                <Chip tone="warning">作者不允许第三方下载</Chip>
              ) : null}
            </div>
            <div className="res-card-foot">
              <Button
                size="sm"
                variant={openProject === hit.project_id ? 'secondary' : 'primary'}
                onClick={() => void toggleVersions(hit)}
                disabled={!instance}
                title={instance ? '展开这个项目的全部版本，自己挑' : '先选一个版本'}
              >
                {openProject === hit.project_id ? '收起版本' : '选择版本并安装'}
              </Button>
              {/*
                ★ 2026-09-16 用户："资源卡片右下角是啥，大多都是乱码似的，那端小字不要"。
                  那行字是 `hit.project_id` —— Modrinth 给的是 base62 id（`AANobbMI` 这种）、
                  CurseForge 给的是数字 id，对玩家一点用都没有，看着就像乱码。
                  删掉。`page_url`（项目页地址）没有丢，它只在
                  "作者不允许第三方下载"的提示里出现 —— 那种时候它才真的有用。
              */}
            </div>
            {openProject === hit.project_id ? (
              <VersionPicker
                hit={hit}
                versions={versions}
                loading={verLoading}
                error={verError}
                installing={installing}
                onPick={(v) => void installVersion(hit, v)}
                onRetry={() => void loadVersions(hit)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {hits.length > 0 ? (
        /*
         * ★★ 换成**整合包同款的分页条**（用户 2026-09-16："整合包的翻页不错，
         *   给 mod / 资源包 / 光影 / 数据包 做同款"）。
         *
         *   原来是「加载更多（第 N 页）」一个按钮：只能往后走、**回不去**，
         *   而且"已显示 40 / 18337"要玩家自己做除法。
         *
         *   ★ 接口语义没变（offset + append），但**两个方向必须分开**：
         *     往后跳用 `append: true`（接着堆），
         *     往回跳用 `append: false`（清空重取）——
         *     否则"上一页"会把第 1 页接在最后面。
         */
        <div className="pager">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1 || loadingMore}
            onClick={() => void gotTo(page - 1)}
          >
            上一页
          </Button>
          <span className="pager-info">
            第 {page} / {Math.max(1, Math.ceil((total > 0 ? total : hits.length) / PAGE))} 页 · 共{' '}
            {total > 0 ? total : hits.length} 个
            {resultSource ? ` · ${resultSource === 'curseforge' ? 'CurseForge' : 'Modrinth'}` : ''}
          </span>
          {loadingMore ? (
            <Spinner label="正在加载…" />
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={!hasMore}
              onClick={() => void gotTo(page + 1)}
            >
              下一页
            </Button>
          )}
        </div>
      ) : null}

      {/* 页面形态下把"不筛加载器"这类事实放在最后一行小字里，不占首屏 */}
      {compactHead && current ? (
        <div className="dim res-fineprint">
          装到 <span className="mono">{current.install_dir}/</span>，认{' '}
          {current.extensions.join(' / ')}。
          {current.needs_loader_filter
            ? ' 只列适配当前加载器的版本。'
            : ' 这一类资源与加载器无关，所以不按加载器过滤。'}
          {current.install_note ? ` ${current.install_note}` : ''}
        </div>
      ) : null}
    </div>
  );
}

/* ==================================================================
   弹窗形态（Mod 管理页用：装到"这个"实例）
   ================================================================== */

export function ResourceBrowser({
  open,
  onClose,
  instance,
  initialKind = 'mod',
  onInstalled,
  toast,
}: ResourceBrowserProps) {
  const [kind, setKind] = useState<ResourceKindName>(initialKind);

  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="社区资源"
      subtitle={
        instance
          ? `装到「${instance.config.name}」（${instance.mcVersion}${
              instance.loader ? ` + ${instance.loader.kind}` : ' · 原版'
            }）· 选一个项目，再挑你要的那个版本`
          : '先选一个版本'
      }
      size="xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <ResourceCenterBody
        kind={kind}
        onKindChange={setKind}
        instance={instance}
        onInstalled={onInstalled}
        toast={toast}
      />
    </Modal>
  );
}
