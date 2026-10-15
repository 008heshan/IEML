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
import { Button, Chip, CustomSelect, Modal, Note, Segmented, Spinner } from '../ui';
import { IconChevronRight, IconDownload, IconGrid, IconRefresh, IconRows, IconSearch } from '../ui/Icons';
import { groupKeyOf, useVersionGroups } from './resource-groups';
import { Pager } from './Pager';
import { filterVersionsForInstance } from './version-filter';
import { useRealApi } from '../hooks/useRealApi';
import { useTabIndicator } from '../hooks/useTabIndicator';
import { useApp } from '../state/AppContext';
import { BASE_LOADER_NAME, compareVersion, isSnapshotVersion, knownVersions } from '../domain';
import type { BaseLoaderKind, Instance } from '../domain';
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
export function VersionPicker({
  hit,
  versions,
  loading,
  error,
  installing,
  onPick,
  onRetry,
  recommend,
  target,
}: {
  hit: ModrinthHit;
  versions: ModrinthVersion[] | null;
  loading: boolean;
  error: string | null;
  installing: string | null;
  onPick: (v: ModrinthVersion) => void;
  onRetry: () => void;
  /**
   * ★★ 2026-09-23（用户：「整合包资源单开的一页也要版本分类和**版本推荐**」）：
   *   传一个版本 id 进来，那一行会多一个「推荐」标记。
   *
   *   ★ 为什么是"传 id"而不是"页面自己挑一个"：**挑哪个算推荐是页面的事**
   *     （整合包页按"最新正式版"推；别的页面不传就是不推）。
   *     `VersionPicker` 只负责画 —— 这样它仍然是同一份实现，不是两套规则。
   *   ★ 为什么默认不推：用户之前明确说过"推荐版本也不要了"（那是游戏版本安装页）——
   *     所以这里**只有明确要求的地方才显示**，不是全局加回来。
   */
  recommend?: string;
  /**
   * ★★★★ 2026-10-08（用户：「**少世代分组的大版本**」）。
   *
   *   "装到哪个实例" —— 有它才能把版本列表**筛成兼容这个实例的那些**。
   *
   *   ## 为什么要按**种类**分开处理（这是这次的关键）
   *
   *   | 种类 | 该不该按当前实例的 MC 版本筛？ |
   *   |---|---|
   *   | 整合包 | **不该**。整合包的"版本"本来就是**跨世代的一条谱系** —— |
   *   |        | 同一个包在 1.16 / 1.18 / 1.20 / 1.21 上各有一串， |
   *   |        | 而且装上 1.21 那版就是一个新实例、不是"升级"当前这个。 |
   *   | Mod / 其余 | **该**。用户就是要把东西装进这个实例里， |
   *   |            | 不兼容的版本列出来只会让人点错（2026-09-30 那条性能优化同理）。 |
   *
   *   ## 为什么过滤放在这里、而不是接口请求里
   *
   *   请求层过滤有个副作用：**谱系被砍掉之后就再也拿不回来了** ——
   *   用户在这里看到的是"只有一个分组"，而不是"能选的分组只有一个"。
   *   放在渲染层，接口给全量、这一层按种类决定显示什么：
   *   整合包保留全部（分组才有意义），其余照旧筛掉。
   *
   *   ★ 加载器**不在这里筛**：那是硬约束（整合包必须匹配加载器），
   *     已经由调用方在请求里传了 `loader` —— 两处都筛会让人以为有两套规则。
   */
  target?: { mcVersion: string; loader?: { kind: string } | null } | null;
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
  /*
   * ★★★★ 2026-10-08（用户：「**modrinth 的版本是倒叙，反正就是推荐的是老版本，
   *   而且不是从新到旧**」）。
   *
   *   ## 两个问题，一起修
   *
   *   ① **顺序反了**：`useVersionGroups(versions, compareVersion, …)` 把这批
   *      版本原样交给分组，而分组内部并不排序 —— 于是顺序完全取决于**上游接口
   *      返回的次序**。Modrinth 返回的就是**从旧到新**，屏幕上因此是
   *      `5.4.1 / 5.4.0 / 5.3.3 …`（用户截图里那六行）。
   *      `.sort((a,b) => compareVersion(b,a))` 那种写法也别扭：
   *      `compareVersion` 的约定是 `a<b ⇒ -1`，所以要让"新"在前必须写
   *      `compareVersion(b, a)`；可读性差，而且很容易被下一个人"顺手改正"
   *      成正序（这就是它一直错着的原因）。
   *
   *   ② **不能按版本号字符串排**：`5.10.0` 与 `5.9.0` 比字符串会排错，
   *      而整合包的版本号五花八门（`v1.2`、`1.20.1-3.2.0`、带 hotfix 后缀）。
   *      **发布时间才是"新/旧"的真正判据**，所以主判据用 `date_published`。
   *
   *   ⇒ 排序：**新的在前**；时间取不到（CurseForge 那条路可能不给）时
   *     退回版本号比较（同样新的在前）。两次都是**稳定的显式排序**，
   *     不再依赖接口给的次序。
   *
   *   ★ 排序放在**渲染这一层**：与"接口怎么给"解耦，资源中心四个种类
   *     （Mod / 资源包 / 光影 / 数据包）走的是同一个 `VersionPicker`，
   *     所以它们一起被修正。
   */
  const sortedVersions = useMemo(() => {
    const t = (v: { date_published?: string }) => {
      const ms = Date.parse(v.date_published ?? '');
      return Number.isFinite(ms) ? ms : null;
    };
    return [...versions].sort((a, b) => {
      const ta = t(a);
      const tb = t(b);
      if (ta !== null && tb !== null && ta !== tb) return tb - ta; // 新的在前
      if (ta === null && tb === null) return compareVersion(b.version_number, a.version_number);
      if (ta === null) return 1; // 没时间的排后面（不假装知道它新）
      if (tb === null) return -1;
      return tb - ta;
    });
  }, [versions]);

  /**
   * 按当前实例**筛掉不兼容的版本** —— 判据在 `version-filter.ts`（纯函数，有测试）。
   *
   * ★ 为什么不在这段里内联判断：这条判据"**整合包不筛、其余筛**"很容易被
   *   下一个人"顺手统一"成一种规则。写成一个具名函数 + 测试它才活得下来
   *   （那个文件头有张对照表，解释为什么两种规则不一样）。
   */
  const compatibleVersions = useMemo(
    () =>
      filterVersionsForInstance(sortedVersions, {
        projectType: hit.project_type,
        target,
      }),
    [sortedVersions, target, hit.project_type],
  );

  /*
   * ★★ 2026-09-23（C4）：按 MC 版本分组 + 折叠 + 顶部 chips 筛选。
   *   分组逻辑在 `resource-groups.ts`（纯函数，好测）。
   */
  /*
   * ★ 推荐版本所在的组要**自动展开** —— 否则推荐落在折叠组里，用户看不到它
   *   （真机实测：分类对、推荐数 0，就是这个原因）。
   */
  const recommendGroupKey = recommend ? groupKeyOf({ id: recommend, game_versions: compatibleVersions.find((x) => x.id === recommend)?.game_versions ?? [] }, compareVersion) : null;
  const { groups, shown, only, setOnly, isOpen, toggle } = useVersionGroups(compatibleVersions, compareVersion, recommendGroupKey);

  return (
    <div className="res-versions">
      <div className="res-versions-head">
        {/*
          ★ 2026-09-16 用户（截图）：删掉"—— 自己挑一个装"和右边那句
            "第一个是上游最新发布的，不代表'最适合你'"。
        */}
        <span>
          <b>{hit.title}</b> 的全部版本（{compatibleVersions.length} 个）
        </span>
      </div>

      {/*
        ★★ 2026-09-23（用户：「整合包，mod，资源包，数据包，光影，**给版本分类**，
          就像游戏版本安装那样」，粒度确认为**按大版本分组**）：
          原来是**一条条平铺**（几十条挤在一起，看不出版本谱系）。
          现在按 **MC 版本**分组，组可折叠，并在上面给一排版本 chips 直接跳到某一组
          —— 与图二（PCL 的 Sodium 详情页）同一个结构。
      */}
      {groups.length > 1 ? (
        <div className="res-vchips" role="group" aria-label="按 MC 版本筛选">
          <button
            type="button"
            className={'chip chip-btn' + (only === null ? ' chip-accent' : '')}
            aria-pressed={only === null}
            onClick={() => setOnly(null)}
          >
            全部 {compatibleVersions.length}
          </button>
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              className={'chip chip-btn' + (only === g.key ? ' chip-accent' : '')}
              aria-pressed={only === g.key}
              onClick={() => setOnly(g.key)}
            >
              {g.key} {g.items.length}
            </button>
          ))}
        </div>
      ) : null}

      {shown.map((g) => (
        <div className="res-vgroup" key={g.key}>
          <button
            type="button"
            className={'res-vgroup-head' + (isOpen(g.key) ? ' open' : '')}
            aria-expanded={isOpen(g.key)}
            onClick={() => toggle(g.key)}
          >
            <IconChevronRight />
            <span className="res-vgroup-name">{g.key}</span>
            <span className="dim">{g.items.length} 个版本</span>
          </button>

          {isOpen(g.key) ? (
            <div className="res-version-list">
              {g.items.map((v) => {
                const file = v.files.find((f) => f.primary) ?? v.files[0];
                const blocked = !!file && !file.url;
                const busy = installing === v.id;
                return (
                  /*
                   * ★★ 2026-09-23 用户（PCL 截图 + 「**太多安装按钮了，乱繁，改成点击这个直接安装
                   *   （PCL 同款），全都要改**」）：
                   *
                   *   原来每一行右边都挂一个「安装这个版本」按钮 —— 几十行就是几十个按钮，
                   *   视觉上很吵。PCL 的做法是**整行可点**：点哪一行就装哪一行。
                   *
                   *   所以这里把行本身变成"按钮"：
                   *     · role="button" + tabIndex + 回车/空格都能触发（键盘用户同样可用）；
                   *     · aria-label 说清"安装哪个版本"（读屏需要）；
                   *     · 装不了的那一行（作者禁止第三方分发）**不可点**，并保留原因文字。
                   */
                  <div
                    key={v.id}
                    className={
                      'res-version' +
                      (blocked ? ' blocked' : ' clickable') +
                      (busy ? ' busy' : '')
                    }
                    role={blocked ? undefined : 'button'}
                    tabIndex={blocked ? undefined : 0}
                    aria-label={blocked ? undefined : `安装 ${v.version_number || v.name}`}
                    aria-disabled={blocked || undefined}
                    onClick={() => {
                      if (blocked || busy) return;
                      onPick(v);
                    }}
                    onKeyDown={(e) => {
                      if (blocked || busy) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPick(v);
                      }
                    }}
                  >
                    <div className="res-version-main">
                      <div className="res-version-name">
                        <span className="mono">{v.version_number || v.name}</span>
                        {/* ★ 推荐标记：只有调用方明确给了 recommend 才出现（见 props 的说明） */}
                        {recommend === v.id ? <Chip tone="success">推荐</Chip> : null}
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
                    {/*
                      右边不再放按钮 —— 只留"状态"：
                        · 装不了：说明原因（不可点）
                        · 正在装：转圈
                        · 其它：一个淡淡的下载图标（提示"这行能点"）
                    */}
                    {blocked ? (
                      <Chip tone="warning">作者不允许第三方下载</Chip>
                    ) : busy ? (
                      <Spinner />
                    ) : (
                      <span className="res-version-go" aria-hidden="true">
                        <IconDownload />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
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
  /*
   * ★ 2026-10-08：原来的 `compactHead?: boolean` 删掉了 ——
   *   它唯一的用途是"页面形态下要不要画那块页脚小字"，
   *   而那块小字已经按用户要求整块删除（见渲染处那段说明）。
   *   ★ 一个只为控制"不存在的东西"而存在的开关，留着比删掉更容易误导人：
   *     下一个人会去找"compactHead 到底控制什么"。
   */
  /**
   * 隐藏种类页签（下载页用）。
   *
   * ★ 下载页**最外层**已经有「Mod / 资源包 / 光影 / 数据包」四个页签了，
   *   再在里面长一排一模一样的四格，就是用户说的"下载页上下重复"。
   *   这里只留需要的东西：来源切换 + 搜索 + 结果。
   */
  hideKindTabs?: boolean;
  /**
   * 给「游戏版本 + 模组加载器」两个筛选器（**只有下载页给**）。
   *
   * ★★ 用户 2026-09-17：「下载页下载资源我想要可以选择版本（**不给推荐版本**）
   *   同时能选择模组加载器，**这俩可以叠加**，做到『选择资源来源』的左边吧」。
   *
   *   给了之后：这一页搜什么**由这两个下拉决定**，不再由「装到」的那个实例决定
   *   （在那之前，玩家想看点别的版本的东西都做不到 —— 界面替他选好了）。
   *
   *   ★ 弹窗形态（版本设置页的「社区资源」）**不给**：那个弹窗的前提就是
   *     "装到这一个实例上"，再让玩家筛成别的版本，只会装出一个不生效的文件。
   */
  gameFilters?: boolean;
}

export function ResourceCenterBody({
  kind,
  onKindChange,
  instance,
  onInstalled,
  toast,
  hideKindTabs = false,
  gameFilters = false,
}: ResourceCenterBodyProps) {
  const { api } = useRealApi();
  const { state, openResource } = useApp();
  /* ★ 资源种类那排页签下面会滑的指示条（与下载页共用同一个 hook） */
  const kindTabs = useTabIndicator(kind);

  /** 后端给的五种资源描述（**唯一一份**） */
  const [kinds, setKinds] = useState<ResourceKindInfo[]>([]);
  const [kindsError, setKindsError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * ★★ 中文别名（ADR-016）：命中词表时后端会给一句话（"按 jei 搜的"），
   *   以及这次**实际**用的搜索词。两者都只在"这次搜索真的发生了"之后才有意义，
   *   所以和 hits 同一条生命周期（每次重搜都会被覆盖）。
   */
  const [aliasNote, setAliasNote] = useState<string | null>(null);
  const [searchedTerm, setSearchedTerm] = useState('');
  /** ★ 搜哪个库（ADR-052）：两个源的结果形状一样，但内容不是同一批 */
  const [source, setSource] = useState<ResourceSourceName>('modrinth');
  /**
   * ★★ 显示方式（用户：「左是矩阵，右是条形」）—— 只影响 CSS 的列宽（`data-view`），
   *   不重排 DOM、不重取数据（切换是纯显示，不该触发请求）。
   */
  const [view, setView] = useState<'grid' | 'list'>('grid');
  /*
   * ★ 2026-09-26：这里原来还有一个 `resultSource`（"这批结果从哪来"）——
   *   它只服务于界面上那句"数据来自 …"。用户说「资源下载，数据来源可以不写了」，
   *   那句话与分页条上的来源后缀都删了 ⇒ 这个状态没有读者，一起删掉（不留死状态）。
   *   ★ 后端返回里的 `source` 字段还在（那是契约），只是界面不再显示它。
   */

  /** 展开了哪个项目的版本列表（项目 id） */
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[] | null>(null);
  const [verLoading, setVerLoading] = useState(false);
  const [verError, setVerError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  /* 竞争保护：快速切种类/来源时，先发的那次请求后回来会写错列表 */
  const seq = useRef(0);

  /** 当前种类的描述（后端那张表）—— 下面"这类资源筛不筛加载器"要看它 */
  const current = useMemo(() => kinds.find((k) => k.key === kind) ?? null, [kinds, kind]);

  /* ==================================================================
     「游戏版本 / 模组加载器」两个筛选器（下载页，见 `gameFilters` 的说明）
     ------------------------------------------------------------------
     ★ 这一段必须排在 `current` **之后**：`loaderForQuery` 要读它
       （`current?.needs_loader_filter`）。先读后声明就是 TDZ ——
       tsc 的 TS2448 拦得住（beta.26 在 DownloadPage 踩过一次）。
     ================================================================== */

  /**
   * ★★ 两个都是**空串 = 不限**，而且**默认就是空**。
   *
   *   这正是用户说的"不给推荐版本"：我们不替他挑一个版本。
   *   （在这之前，这里搜什么完全由「装到」的那个实例决定 ——
   *     玩家想看一眼别的版本有什么东西，都做不到。）
   *
   *   ★ 空串表示"**不加这个条件**"，不要把它变成一个叫「不限」的值传下去：
   *     后端只有收到 `null` 才真的不筛。传一个 "不限" 过去会搜出空列表，
   *     而界面只会说"没有结果" —— 把"查不到"说成"没有"是这个仓库的老毛病。
   */
  const [filterVersion, setFilterVersion] = useState('');
  const [filterLoader, setFilterLoader] = useState('');

  /**
   * 版本下拉的备选：**真实清单**（Mojang / BMCLAPI manifest），不是我们挑的几个。
   *
   * ★ 判"正式版"用的是与安装页**同一条**判据 —— 上游 `release_type === 'release'`
   *   **且**版本号长得像最终版（`x.y` / `x.y.z`）。少任何一条，`26.2-rc-2`
   *   这种预发布版就会混进来（那个坑在版本列表页栽过两次，见 `InstallComposer`
   *   的 `FINAL_RELEASE_RE` 说明）。
   * ★ 快照**不做成选项**：900+ 个版本的下拉没法用，而且它真正的入口是
   *   「安装游戏」那一页（那里有正式版/快照/全部三档）。
   */
  const [allVersions, setAllVersions] = useState<string[]>([]);
  const downloadSource = state.prefs.downloadSource;

  useEffect(() => {
    if (!gameFilters) return;
    if (!api) {
      /*
       * 浏览器演示模式：没有清单接口，退回内置那张表里的**正式版**（新到旧）。
       * ★ 这里也要过 `isSnapshotVersion`：内置表里有一个快照（`24w45a`），
       *   放了它，演示模式和真机就是两张口径不同的表。
       */
      setAllVersions(
        knownVersions()
          .filter((v) => !isSnapshotVersion(v))
          .sort((a, b) => compareVersion(b, a)),
      );
      return;
    }
    let alive = true;
    void api.metadata
      .manifest('auto')
      .then((m) => {
        if (!alive) return;
        setAllVersions(
          m.versions
            .filter((v) => v.release_type === 'release' && !isSnapshotVersion(v.id))
            .map((v) => v.id),
        );
      })
      .catch(() => {
        /* ★ 清单拉不到**不是**"没有版本"：清空即可 —— 下面会把玩家自己
           装着的版本补进去，至少让他能筛。不编一份假的版本表。 */
        if (alive) setAllVersions([]);
      });
    return () => {
      alive = false;
    };
  }, [api, gameFilters, downloadSource]);

  /**
   * 版本选项 = 清单里的正式版（新到旧）+ **玩家自己装着的版本**（快照也在内）。
   *
   * ★ 后一半不能省：清单里没有快照，网络不通时清单更是空的 ——
   *   而"我手上这个版本"永远该能选。
   */
  const versionOptions = useMemo(() => {
    const extra = [
      ...new Set(
        state.instances
          .map((i) => i.mcVersion)
          .filter((v) => v && !allVersions.includes(v)),
      ),
    ].sort((a, b) => compareVersion(b, a));
    return [
      { value: '', label: '不限版本' },
      ...[...allVersions, ...extra].map((v) => ({ value: v, label: v })),
    ];
  }, [allVersions, state.instances]);

  /** 加载器选项：名字取自 `BASE_LOADER_NAME`（**唯一一份**），不在界面上再抄一遍 */
  const loaderOptions = useMemo(
    () => [
      { value: '', label: '不限加载器' },
      ...(Object.keys(BASE_LOADER_NAME) as BaseLoaderKind[]).map((k) => ({
        value: k,
        label: BASE_LOADER_NAME[k],
      })),
    ],
    [],
  );

  const loaderLabel =
    loaderOptions.find((o) => o.value === filterLoader)?.label ?? filterLoader;

  /**
   * 真正交给后端的那两个条件。
   *
   * ★ 没开筛选器（弹窗形态）时**还是老行为**：跟着「装到」的那个实例走。
   * ★ 加载器只有 Mod 这一类才筛（后端也会再兜一层，这里是"别白传"）。
   */
  const searchVersion = gameFilters ? filterVersion : (instance?.mcVersion ?? '');
  const searchLoader = gameFilters ? filterLoader : (instance?.loader?.kind ?? '');
  const loaderForQuery = current?.needs_loader_filter ? searchLoader : '';

  /**
   * ★★ 「筛的」和「装到」不是一回事时要说出来。
   *
   *   这是这一页最容易出的一种错：搜的是 1.20.1 + Forge，资源却装进
   *   1.21.4 + Fabric 的实例目录 —— 提示说"已装好"，而游戏根本不加载它。
   *   **只在真的不一致时才出现**（一致时一个字的噪音都不加）。
   */
  const mismatch = useMemo(() => {
    if (!gameFilters || !instance) return null;
    const versionBad = Boolean(filterVersion) && filterVersion !== instance.mcVersion;
    const loaderBad =
      Boolean(filterLoader) && filterLoader !== (instance.loader?.kind ?? '');
    if (!versionBad && !loaderBad) return null;
    const scope = `${filterVersion || '不限版本'} · ${
      filterLoader ? loaderLabel : '不限加载器'
    }`;
    const target = `${instance.mcVersion}${
      instance.loader ? ` + ${instance.loader.kind}` : ' · 原版'
    }`;
    return (
      `上面筛的是 ${scope}，而资源会装到「${instance.config.name}」（${target}）——` +
      '版本或加载器对不上的资源装进去不会生效。'
    );
  }, [gameFilters, instance, filterVersion, filterLoader, loaderLabel]);

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
   * 取**某一页**。
   *
   * ★★★★ 2026-10-08 晚：这里原来分两条路（`append=false` 换条件重搜 /
   *   `append=true` 接着堆）—— 现在只剩一条：**每次都是"换一页"**。
   *   理由见 `gotTo` 那段：分页条上写着"第 N 页"、玩家还能自己输入页码，
   *   接着堆就会让那个数字变成假话（输入 5 得到的是"第 1 页 + 第 5 页"）。
   *   ★ 顺带与**整合包那一页**统一：它一直就是整屏换掉。
   */
  const load = useCallback(
    async (opts: { k: ResourceKindName; q: string; src: ResourceSourceName; offset: number }) => {
      if (!api) return;
      const mine = ++seq.current;
      setLoading(true);
      /*
       * ★★ 2026-09-23 用户（截图）：「在比如 mod 页里，mod 加载出图片后，**切到资源包，
       *   会继承到资源包**，其余那几个也是」——
       *
       *   原来的写法是"先把 loading 打开、等新结果回来再替换"，
       *   于是**旧结果整段时间还挂在屏幕上**（连着上一页的封面图），
       *   看起来就是"资源包页里显示的是 Mod"。
       *
       *   改成：**立刻清空**，让骨架屏接上 —— 用户看到的永远是"正在加载"，
       *   不是"上一页的内容"。翻页同理：翻到第 5 页时屏幕上不该还留着第 1 页那 20 张。
       */
      setHits([]);
      setError(null);
      try {
        const r = await api.modrinth.resourceSearch({
          kind: opts.k,
          query: opts.q,
          /*
           * ★ 版本与加载器**叠加**（用户："这俩可以叠加"）——
           *   两个都不选时传 undefined，让后端只按种类查（那是真的"不限"）。
           */
          mcVersion: searchVersion || undefined,
          loader: loaderForQuery || undefined,
          limit: PAGE,
          offset: opts.offset,
          source: opts.src,
        });
        if (mine !== seq.current) return; // 迟到的结果丢掉
        setHits(r.hits);
        setTotal(r.total_hits ?? r.hits.length);
        /*
         * ★★ 中文别名（ADR-016）：把"我拿什么去搜的"如实记下来，下面渲染成一句提示。
         *   命中时是 `「物品管理器」是中文叫法，按 jei 搜的`；没命中就是 null。
         */
        setAliasNote(r.query_alias ?? null);
        setSearchedTerm(r.term_used ?? opts.q);
      } catch (e) {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
        setTotal(0);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [api, searchVersion, loaderForQuery],
  );

  /*
   * 切种类 / 切来源 / 换实例 / **改版本或加载器筛选** → 回到第一页并重搜
   * （**打开就列出来**，不用先点搜索）。
   *
   * ★ `instance?.id` 留着：没开筛选器时它确实是判据之一（版本/加载器都从它推），
   *   开了之后它不影响结果，多搜一次而已 —— 但删掉它会让"换实例"这条路径
   *   在将来某次改动里静默失效，不值当。
   */
  useEffect(() => {
    setPage(1);
    setOpenProject(null);
    setVersions(null);
    void load({ k: kind, q: query, src: source, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, source, instance?.id, current?.key, searchVersion, loaderForQuery]);

  /** 一共几页（分页条与 `gotTo` 都用它，所以只算一处） */
  const pageCount = Math.max(1, Math.ceil((total > 0 ? total : hits.length) / PAGE));


  /**
   * 跳到第 n 页（分页条的「上一页 / 下一页 / 自己输入页码」都走这里）。
   *
   * ★★★★ 2026-10-08 晚（用户：「加一个可以让玩家自己输入的地方来看玩家想要看的页」）：
   *   **两个方向现在都是"换一页"**，不再是"往后接着堆"。
   *
   *   原来是 beta.30 写的"往后 `append:true`、往回 `append:false`"——
   *   那时它还是个「加载更多」按钮，堆着看是它的语义。但现在分页条上写着
   *   **"第 N 页"**、玩家还能**自己输入页码**，那个数字就成了一个承诺：
   *   真机实测（这一轮的探针）：输入 5 之后列表从 20 张变成 **40 张**、
   *   首行还是第 1 页那条 —— 也就是"第 5 页"下面挂着第 1 页的内容。
   *   ⇒ 一次只显示一页：与**整合包那一页**（一直是整屏换掉）统一，
   *     也让"输入 5 就是第 5 页"这句话真的成立。
   *
   *   ★ `canNext` 同样改成按**页码**算（原来是 `hits.length < total`，
   *     接着堆时它几乎永远为真：最后一页也点得动，点下去是一片空白）。
   */
  async function gotTo(n: number) {
    if (n < 1 || n > pageCount || loading) return;
    setPage(n);
    await load({ k: kind, q: query, src: source, offset: (n - 1) * PAGE });
  }

  async function runSearch() {
    setPage(1);
    setOpenProject(null);
    setVersions(null);
    await load({ k: kind, q: query, src: source, offset: 0 });
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
          /* ★ 展开某个项目时用的是**同一套**筛选（版本 × 加载器）——
             否则会出现"列表是 1.20.1 的，点开却是别的版本"。 */
          mcVersion: searchVersion || undefined,
          loader: loaderForQuery || undefined,
          source,
        });
        setVersions(list);
      } catch (e) {
        setVerError(e instanceof Error ? e.message : String(e));
      } finally {
        setVerLoading(false);
      }
    },
    [api, kind, searchVersion, loaderForQuery, source],
  );

  /*
   * ★★ 2026-09-23（C5）：`toggleVersions` 已删 —— 它的**唯一**入口就是卡片上那个按钮，
   *   而那个按钮现在改成"进独立安装页"（`openResource`）。
   *   版本列表连同分组折叠一起搬到了 `pages/ResourceInstallPage.tsx`，
   *   用的还是本文件导出的 `VersionPicker`（同一份实现）。
   */

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
          <div className="tabs res-tabs" role="tablist" aria-label="资源种类" ref={kindTabs.ref}>
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
            {/* 与下载页同一条规则：没量到之前不渲染，免得它从最左边滑过来 */}
            {kindTabs.style ? (
              <span className="tab-ind" aria-hidden="true" style={kindTabs.style} />
            ) : null}
          </div>
        )}
        <div className="spacer" />
        {/*
          ★★ 「游戏版本 + 模组加载器」两个筛选器（下载页，2026-09-17 用户：
            "下载页下载资源我想要可以选择版本（不给推荐版本）同时能选择模组加载器，
             这俩可以叠加，做到『选择资源来源』的左边吧"）。

            · 位置就在「内容来源」**左边**（用户指定）；
            · 两个都能选、**叠加生效**（版本 × 加载器，AND）；
            · 默认都是「不限」—— 这就是"不给推荐版本"：不替玩家挑，也不预选。
            · 未选时值用次要色（`.is-unset`），一眼能看出"现在没筛"。
        */}
        {gameFilters ? (
          <div className="res-filters">
            <div className="res-filter">
              <CustomSelect
                className={filterVersion ? '' : 'is-unset'}
                value={filterVersion}
                onChange={setFilterVersion}
                options={versionOptions}
                ariaLabel="筛选游戏版本"
              />
            </div>
            <div
              className="res-filter"
              /*
               * ★ 资源包 / 光影 / 数据包这类**与加载器无关**（后端那张表里
               *   `needs_loader_filter = false`），所以这里**不让选**。
               *
               * ★★ 2026-09-26 用户：「去掉所有悬停显示描述」——
               *   这句理由原来挂在外层的 `title` 上（禁用控件自己不弹提示），
               *   现在改成同一排下面的**看得见的小字**（`.res-hint`）。
               *   "禁用必须给具体理由"这条铁律没变，只是理由从悬停挪到了明面上。
               */
            >
              <CustomSelect
                className={filterLoader ? '' : 'is-unset'}
                value={filterLoader}
                onChange={setFilterLoader}
                disabled={current ? !current.needs_loader_filter : false}
                options={loaderOptions}
                ariaLabel="筛选模组加载器"
              />
            </div>
            {mismatch ? (
              <Chip tone="warning">与「装到」不一致</Chip>
            ) : null}
          </div>
        ) : null}
        {/* ★ 来源用现成的 Segmented —— 别再造一套"看起来像分段控件"的东西 */}
        <Segmented
          label="内容来源"
          size="sm"
          value={source}
          onChange={setSource}
          options={SOURCES.map((s) => ({ value: s.key, label: s.label }))}
        />
        {/*
          ★★★★ 2026-09-26 用户：「资源下载里在最多下载的右边加一个选项：
            左是矩阵，右是条形。**显示资源 UI 的方式**」。
            ⇒ 资源中心与整合包页**同一套**（都是"资源列表"，
              两个地方不同款正是上一次那个 bug 的成因 —— 这次一起加）。
            ★ 图标按钮必须带名字（`SegmentOption.title` → `aria-label`，
              读屏能听到"这是矩阵还是条形"）。**不挂悬停提示**（用户要求）。
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
        ★★★★ 2026-10-08（用户给的截图：「**这些文本都不要**」）：
          这一行小字（"资源包与加载器无关，游戏不按加载器读它 —— 所以这里
          不按加载器过滤"）被点名删掉了 —— **连外面那层 `gameFilters` 判据
          一起删**，而不是只把文字留空：一个"永远渲染不出东西"的条件留着，
          下一个人会以为这里本来就该有东西。

        ★ 那条规矩（"禁用一个控件必须给得出理由"）**没有失效**：
          加载器筛选在这几种资源里**根本不显示**（见上面那段 `needs_loader_filter`
          的说明），所以不存在"禁用了却不说为什么"的情况。
      */}

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
        <div className="res-grid" data-view={view} aria-busy="true" aria-label="正在加载">
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

      {/*
        ★★ 中文别名的两句话（ADR-016）：
          · 命中了 → 如实说"我拿哪个英文词去搜的"（不说的话，用户会以为
            搜索框里那串中文被原样提交了，结果是另一个词搜出来的）；
          · 没命中且一条都没有 → 第 ③ 步："试试英文名"。
            这两句都只在**这次搜索真的发生过**（有输入）时出现。
      */}
      {query ? (
        aliasNote ? (
          <div className="res-alias" role="status">
            {aliasNote}
            {searchedTerm && searchedTerm !== query ? (
              <span className="dim">（这一页的结果来自「{searchedTerm}」）</span>
            ) : null}
          </div>
        ) : hits.length === 0 && !loading && !error ? (
          <div className="res-alias" role="status">
            没搜到「{query}」—— 中文名不一定和平台上的项目名一致，换**英文名**再试一次
            （比如「钠」试 <span className="mono">sodium</span>）。
          </div>
        ) : null
      ) : null}

      {!loading && hits.length === 0 && !error ? (
        <div className="res-none">
          无{query ? `（没搜到「${query}」）` : ''}
        </div>
      ) : null}

      <div className="res-grid" data-view={view}>
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
                variant="primary"
                /*
                 * ★★ 2026-09-23（C5，用户：「给这些资源点击安装时单独建页面，具体看 PCL 做法」，
                 *   并确认「内容区整页切换，不是弹窗也不是卡片内展开」）：
                 *   这里原来是**内联展开**版本列表。现在改成**进独立安装页** ——
                 *   资源信息与几十个版本各占一块，挑版本时能专心（PCL 就是这么分的）。
                 */
                onClick={() => openResource(hit, kind, source)}
                disabled={!instance}
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
         * ★★ 与「整合包」那处**共用同一个 `Pager`**（用户 2026-09-16："整合包的翻页不错，
         *   给 mod / 资源包 / 光影 / 数据包 做同款"；2026-10-08 晚又要求"优化排版 +
         *   能自己输入页码" —— 那就是同一件事要改两处，于是这一轮把它抽成了组件）。
         *
         *   ★ 两个方向现在都由 `gotTo` 处理，语义是"换一页"（见那边的说明）。
         */
        <Pager
          page={page}
          pageCount={pageCount}
          total={total > 0 ? total : hits.length}
          canPrev={page > 1 && !loading}
          canNext={page < pageCount && !loading}
          onPrev={() => void gotTo(page - 1)}
          onNext={() => void gotTo(page + 1)}
          onGo={(n) => void gotTo(n)}
        />
      ) : null}

      {/*
        ★★★★ 2026-10-08（用户给的截图，指着一行小字：「**光影包需要 Iris 或
          OptiFine 才能生效 —— 原版游戏里看不到它。**」+「光影包和数据包的
          页脚的文本去掉**」）。

          这一整块 `res-fineprint` 删掉了，不再渲染 `current.install_note`。

        ## 为什么是"整块删"而不是"只对光影/数据包不显示"

          · 这块**只剩这一个内容**了：2026-09-26 那句"装到 mods/，认 .jar。
            没限定版本、没限定加载器"已经按用户要求删掉，注释还留在这里；
          · 它是**表单下方的最后一行**，用户点名的正是它；
          · `install_note` 想表达的"装之前要知道的事"，现在有更好的地方说 ——
            安装流程自己会报（`flows/resource-install.ts` 里那句 `note`
            跟着**安装结果**一起出现），而不是提前堆在列表页脚下。

          ★ 一并去掉的还有"分页条下面还挂一句小字"这个版式本身 ——
            它正是分页条看起来"贴着底"的原因之一（见 `.pager` 那段注释）。
      */}
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
