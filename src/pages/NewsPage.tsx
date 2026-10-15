/**
 * MC 新闻页（游戏版本动态）
 * ==================================================================
 * 用户：「我在我的网站添加了一个 mc 新闻页，我想往 IEML 里塞一个新闻页，
 *       从我的网站里调取版本更新内容」。
 * 之后又更新了两次口径：
 *   · 「网站更新了版本大图功能，启动器同步一下」；
 *   · 「其实这些东西应该保存在启动器的数据文件夹里的」。
 *
 * ## 这一页是什么
 *
 *   **游戏本体**的版本动态，和「更新日志」（启动器自己改了什么）是两件事：
 *   两张卡 —— 最新正式版 / 最新快照 —— 各自带**版本大图**、一段中文首段，
 *   点「展开完整更新内容」看整篇「新内容 / 更改」。
 *
 * ## 数据从哪来（现在是"下载到数据目录"，不再是打进安装包）
 *
 *   ```
 *   打开这一页 → 读 <数据目录>/news/            （只读盘，不联网）
 *                本地没有 → 自动同步一次          （这时才发请求）
 *                点「同步」→ 再拉一次              （用户主动）
 *   ```
 *
 *   ★ 下载与落盘在 Rust 侧（`src-tauri/src/news.rs`），解析与校验在
 *     `domain/mc-news.ts`（唯一一份实现，有单测）。这一页只负责画。
 *   ★ 大图是 `data:` URI（后端读数据目录里的文件再编码）—— 图**确实存在
 *     数据目录里**，用户能在资源管理器里看见，也能自己删。
 *
 * ## 署名不是可选项（这份正文与图都不是我们的）
 *
 *   中文更新内容来自**中文 Minecraft Wiki**（CC BY-NC-SA 4.0）：
 *   卡片上给出条目链接与修订号（rev），展开的正文下面给出协议链接。
 *   版本号、发布日期与英文摘要来自 Mojang 的补丁说明接口；
 *   版本大图同样来自 Mojang 的公开启动器内容接口（由用户的站点烘好再搬下来）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardTitle, Chip, EmptyState, Note, Spinner } from '../ui';
import { IconChevronDown, IconFolder, IconInfo, IconNews, IconRefresh } from '../ui/Icons';
import { getBackend } from '../bridge';
import type { NewsCachePayload } from '../bridge/types';
import { useApp } from '../state/AppContext';
import {
  NEWS_CHUNK,
  NEWS_STALE_DAYS,
  bakedAgeDays,
  docRowCount,
  flattenText,
  formatNewsDate,
  formatSyncTime,
  moreRowsLabel,
  newsKindLabel,
  nextVisible,
  parseNewsDoc,
  parseNewsManifest,
  visibleSections,
  type NewsDoc,
  type NewsEntry,
} from '../domain/mc-news';

/** 用户网站（「去网站看最新」用） */
const SITE = 'https://hexshane.top/mcnews/';

/**
 * 打开外部链接（中文 Wiki / 用户网站）。
 *
 * ★ 桌面版走 `@tauri-apps/plugin-opener` 的 `openUrl` —— 与 `AccountPanel`
 *   同一处做法（WebView 里的 `<a target="_blank">` 在 Tauri 下不会开系统浏览器，
 *   点了没反应）。浏览器演示模式才走 `window.open`。
 * ★ 返回"开没开成"：调用方据此把地址交给提示条（打不开时手动复制也能到）。
 */
async function openExternal(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const { isTauri } = await import('../bridge');
    if (isTauri()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
    return true;
  } catch {
    return false;
  }
}

/* ====================== 一张版本卡 ====================== */

function NewsCard({ entry, cache }: { entry: NewsEntry; cache: NewsCachePayload }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  /** 正文已经显示到第几行（1400 行的那一版靠它分块，见 `visibleSections`） */
  const [shown, setShown] = useState(0);

  const date = formatNewsDate(entry.date);
  /*
   * 中文首段优先；没有中文条目时退回 Mojang 的英文摘要，并且**说清它是英文摘要**
   * —— 不声不响地给一段英文，用户会以为正文坏了。
   */
  const lead = flattenText(entry.wiki.introLead);
  const fallback = flattenText(entry.shortText);
  const text = lead || fallback;

  const image = cache.images[entry.version] ?? '';
  const docText = cache.docs[entry.version] ?? '';
  /* ★ 正文的解析放在领域层（那里有判据）：这里只拿"能不能用"这个结论 */
  const doc: NewsDoc | null = useMemo(
    () => (docText ? parseNewsDoc(docText) : null),
    [docText],
  );
  const total = doc ? docRowCount(doc) : 0;
  const sections = useMemo(() => (doc ? visibleSections(doc, shown) : []), [doc, shown]);

  /*
   * 正文一到位就先露头一批。
   * ★ 不做这件事的话 `shown` 一直是 0 ⇒ "展开"点开是一张**空白卡**
   *   （行数明明算得出来，却一行都不渲染）—— 这正是门禁要拦的那种"不报错的错"。
   */
  useEffect(() => {
    if (doc && shown === 0) setShown(Math.min(NEWS_CHUNK, docRowCount(doc)));
  }, [doc, shown]);

  /** 打开外部链接；失败时提示条里带上地址，手动也能到 */
  const go = useCallback(
    (url: string) => {
      void openExternal(url).then((ok) => {
        if (!ok) toast('warning', '打不开浏览器', url);
      });
    },
    [toast],
  );

  return (
    <Card>
      <CardTitle
        icon={<IconNews />}
        actions={
          <>
            <Chip tone={entry.kind === 'release' ? 'success' : 'info'}>
              {newsKindLabel(entry.kind)}
            </Chip>
            <span className="dim mono">{date}</span>
          </>
        }
      >
        {entry.version}
      </CardTitle>

      {/*
        版本大图（用户网站上那一版带的宣传图）。
        ★ 图是**从数据目录读出来**的 data URI —— 断网也在，因为它已经在盘上了。
        ★ 没有图（或还没同步到）时整块不渲染：留一个灰框比没有更难看。
      */}
      {image ? <img className="news-hero" src={image} alt={`${entry.title || entry.version} 的封面图`} /> : null}

      {text ? (
        <p className="news-lead">{text}</p>
      ) : (
        <p className="news-lead dim">这一版还没有可显示的中文说明。</p>
      )}
      {!lead && fallback ? (
        <p className="news-note">
          上面这句来自 Mojang 官方说明的英文摘要 —— 中文 Wiki 的条目还没建好 / 还没翻译。
        </p>
      ) : null}

      {/* 署名与出处：中文正文是别人的东西，这一行不能省 */}
      <div className="news-meta">
        正文整理自{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => go(entry.wiki.page || entry.links.zh)}
        >
          中文 Minecraft Wiki
        </button>
        {entry.wiki.fetchedAt ? ` · 抓取于 ${entry.wiki.fetchedAt}` : ''}
        {entry.wiki.revid ? ` · rev ${entry.wiki.revid}` : ''}
      </div>

      <div className="news-actions">
        {entry.hasDoc && doc ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>
            {open ? '收起' : '展开完整更新内容'}
          </Button>
        ) : entry.hasDoc ? (
          /* 清单说有中文条目，但本地没同步到 —— 如实说，并给出去处 */
          <Chip tone="neutral">正文还没同步下来</Chip>
        ) : (
          <Chip tone="neutral">这一版没有中文全文</Chip>
        )}
        <Button size="sm" variant="ghost" onClick={() => go(entry.links.zh)}>
          中文 Wiki
        </Button>
        <Button size="sm" variant="ghost" onClick={() => go(entry.links.en)}>
          MC Wiki（英文）
        </Button>
      </div>

      {/* ---------- 展开的正文 ---------- */}
      {open && doc ? (
        <div className="news-body">
          {doc.intro ? <p className="news-intro">{doc.intro}</p> : null}

          {sections.map(({ title, rows }, si) => (
            <section className="news-sec" key={`${title}-${si}`}>
              {title ? <h3 className="news-sec-h">{title}</h3> : null}
              <ul className="news-rows">
                {rows.map((r, i) => (
                  <li
                    key={`${r.text}-${i}`}
                    className={
                      r.kind === 'group'
                        ? 'news-row news-row-group'
                        : r.depth === 0
                          ? 'news-row news-row-lead'
                          : 'news-row news-row-detail'
                    }
                    /* 缩进走内联样式：层级是数据里的（最深见过 3 层），
                       写成 CSS 规则就得给每一层各写一条，值一次也说不出理由 */
                    style={{ paddingInlineStart: `${r.depth * 14}px` }}
                  >
                    {r.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {shown < total ? (
            <div className="news-more">
              <Button size="sm" variant="secondary" onClick={() => setShown(nextVisible(shown, total))}>
                <IconChevronDown /> {moreRowsLabel(total - shown)}
              </Button>
            </div>
          ) : null}

          <p className="news-credit">
            正文整理自{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => go(doc.page || entry.wiki.page)}
            >
              中文 Minecraft Wiki
            </button>
            {doc.revid ? `（rev ${doc.revid}）` : ''}，以{' '}
            <button type="button" className="link-btn" onClick={() => go(doc.licenseUrl)}>
              {doc.license}
            </button>{' '}
            提供。
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/* ====================== 页面 ====================== */

type Phase = 'loading' | 'syncing' | 'ready' | 'failed';

export function NewsPage() {
  const { toast } = useApp();
  const [cache, setCache] = useState<NewsCachePayload | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');

  /** 从网站同步一次（用户点按钮，或本地还没有数据时自动来一次） */
  const sync = useCallback(async () => {
    setPhase('syncing');
    setError('');
    try {
      const fresh = await getBackend().newsSync();
      setCache(fresh);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }, []);

  /*
   * 进页面：**先读盘**（快、不联网），本地没有才自动同步一次。
   *
   * ★ 为什么不无条件同步：打开一个页面就发网络请求，用户在飞机上/断网时
   *   只会看到一句失败；而"先看盘上有没有"既快又稳，同步留给"没有"和
   *   "用户自己点"这两件事。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const local = await getBackend().newsLoad();
        if (!alive) return;
        if (local) {
          setCache(local);
          setPhase('ready');
          return;
        }
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('failed');
        return;
      }
      if (!alive) return;
      await sync();
    })();
    return () => {
      alive = false;
    };
  }, [sync]);

  const manifest = useMemo(() => (cache ? parseNewsManifest(cache.manifest) : null), [cache]);
  const syncedAt = cache ? formatSyncTime(cache.syncedAtMs) : '';
  const age = manifest ? bakedAgeDays(manifest.baked, new Date()) : null;
  const stale = age !== null && age > NEWS_STALE_DAYS;

  /** 「去网站看最新」——与卡片上那些链接同一条路（Tauri 下必须走 openUrl） */
  const goSite = useCallback(() => {
    void openExternal(SITE).then((ok) => {
      if (!ok) toast('warning', '打不开浏览器', SITE);
    });
  }, [toast]);

  const openDir = useCallback(() => {
    if (!cache) return;
    void getBackend()
      .openFolder(cache.dir)
      .catch((e: unknown) =>
        toast('warning', '打不开文件夹', e instanceof Error ? e.message : String(e)),
      );
  }, [cache, toast]);

  /* ---------- 还没有数据（第一次打开 / 同步失败 / 本地那份读不出来） ---------- */
  if (!cache || !manifest) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">MC 新闻</h1>
            <div className="page-desc">
              游戏本体的版本动态：最新正式版与最新快照，带中文更新内容与版本大图。
              数据从你的网站同步到本地数据目录，同步一次之后断网也能看。
            </div>
          </div>
          <div className="page-actions">
            <Button
              size="sm"
              variant="secondary"
              loading={phase === 'syncing' || phase === 'loading'}
              onClick={() => void sync()}
            >
              <IconRefresh /> 同步
            </Button>
          </div>
        </div>
        <div className="stack">
          {phase === 'loading' || phase === 'syncing' ? (
            <Spinner label="正在从网站取版本数据…" />
          ) : (
            <EmptyState
              icon={<IconNews />}
              title="还没有同步过"
              /*
               * ★ 这里**不放第二个「同步」按钮**：顶上那个位置固定、一直都在，
               *   同一个动作摆两个入口，用户会以为是两件事（这个仓库为"两个返回键"
               *   栽过一次）。
               */
              desc={
                error
                  ? `这次没能取到：${error} —— 点上面的「同步」可以再来一次。`
                  : '点上面的「同步」就会把版本清单、中文正文与版本大图下载到数据目录；同步一次之后断网也能看。'
              }
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">MC 新闻</h1>
          <div className="page-desc">
            游戏本体的版本动态：只看两个版本 —— 最新正式版与最新快照。中文更新内容整理自中文
            Minecraft Wiki，版本大图与摘要来自 Mojang，同步后存在本地，断网也能看。
          </div>
        </div>
        <div className="page-actions">
          <Button
            size="sm"
            variant="secondary"
            loading={phase === 'syncing'}
            onClick={() => void sync()}
          >
            <IconRefresh /> 同步
          </Button>
        </div>
      </div>

      <div className="stack">
        {phase === 'failed' ? (
          <Note tone="warning" icon={<IconInfo />} title="这次没能同步">
            {error}　下面显示的是本地那份（
            {syncedAt ? `上次同步 ${syncedAt}` : '同步时间不清楚'}）。
          </Note>
        ) : null}

        {stale ? (
          <Note
            tone="warning"
            icon={<IconInfo />}
            title="这份数据有点旧了"
            actions={
              <Button size="sm" variant="secondary" onClick={() => void sync()}>
                同步最新的
              </Button>
            }
          >
            网站那份是 {manifest.baked} 烘出来的，到今天已经 {age} 天 —— 这中间 Mojang
            可能又发了新版本。
          </Note>
        ) : null}

        <NewsCard entry={manifest.release} cache={cache} />
        {manifest.snapshot ? <NewsCard entry={manifest.snapshot} cache={cache} /> : null}

        <Note tone="info" icon={<IconInfo />} title="这些内容存在哪、是谁写的">
          版本号、发布日期与英文摘要来自 <b>Mojang 官方启动器</b>的补丁说明接口，版本大图同样来自
          Mojang 的公开内容接口；中文更新内容整理自 <b>中文 Minecraft Wiki</b>，以 CC BY-NC-SA 4.0
          提供，著作权归 Wiki 的编者。启动器只是把你网站上烘好的那一份同步到了本地
          {syncedAt ? `（上次同步 ${syncedAt}）` : ''}。
          <div className="news-actions">
            <Button size="sm" variant="ghost" onClick={openDir}>
              <IconFolder /> 打开数据目录
            </Button>
            <span className="dim mono truncate">{cache.dir}</span>
          </div>
        </Note>

        <div className="news-actions">
          <Button size="sm" variant="ghost" onClick={goSite}>
            去网站看最新
          </Button>
        </div>
      </div>
    </>
  );
}
