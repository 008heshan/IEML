/**
 * MC 新闻（游戏版本动态）的判据
 * ==================================================================
 * 这一页的内容**不是**启动器自己的更新日志（那是 `ChangelogPage` +
 * `data/release-notes.ts`），而是**游戏本体**的版本动态：最新正式版 + 最新快照，
 * 以及每一版的中文更新内容与版本大图。
 *
 * ## 数据从哪来、存在哪
 *
 *   用户的网站（hexshane.top/mcnews）烘好了三样东西：
 *
 *   ```
 *   latest.json            清单：最新正式版 + 最新快照（版本号 / 日期 / 摘要 / 文件名）
 *   wiki/<版本>.json       中文正文（首段 +「新内容 / 更改」）
 *   img/<版本>.jpg         版本大图
 *   ```
 *
 *   启动器**把它们下载到玩家自己的数据目录**里（`<数据目录>/news/`）——
 *   用户的原话：「其实这些东西应该保存在启动器的数据文件夹里的」。
 *   下载与落盘在 Rust 侧（`src-tauri/src/news.rs`），这一层只负责**解析与判据**。
 *
 * ## 为什么解析与校验全在这里
 *
 *   这一页出错的样子是"**内容不对，但不报错**"：
 *     · 正文树读漏一层 ⇒ 用户看到的更新内容比 Wiki 少一截，界面一切正常；
 *     · 空文档当成有内容 ⇒ 点开是一张空卡；
 *     · 清单形状变了（字段改名）⇒ 整页空白，而控制台一个字都不说；
 *     · 日期按时区算 ⇒ 同一份数据在两台机器上差一天。
 *   四种都不会红、不会崩，只会悄悄给错东西。所以判据（解析 / 扁平化 / 日期 /
 *   分块）全部集中在这个 `.ts` 里，由 `tests/mc-news.test.mjs` **拿真实形状的数据**
 *   钉住（`.tsx` 跑不进 `node --test`，这是它不写在页面里的原因）。
 */

/* ====================== 形状（站点给的原文，解析后） ====================== */

export type NewsKind = 'release' | 'snapshot';

export interface NewsWikiMeta {
  /** 归档时的 Wiki 修订号（署名用：让读者能回到那一刻的版本） */
  revid: number | null;
  /** 抓取日期（`2026-10-15`） */
  fetchedAt: string;
  /** 首段（中文），卡片上那段话就是它 */
  introLead: string;
  /** 中文条目地址 */
  page: string;
  /** 许可协议地址 */
  licenseUrl: string;
}

export interface NewsEntry {
  version: string;
  kind: NewsKind;
  /** 上游的原始类型（release / snapshot / …），以后多几种时不必改数据格式 */
  type: string;
  /** 发布时刻（ISO） */
  date: string;
  title: string;
  /** Mojang 官方说明的英文摘要（中文条目缺失时的兜底） */
  shortText: string;
  /** 站点上有中文条目 ⇒ 同步下来之后可以展开全文 */
  hasDoc: boolean;
  wiki: NewsWikiMeta;
  links: { zh: string; en: string };
}

export interface NewsManifest {
  /** 站点烘焙日期（`2026-10-15`）—— 界面据此说"数据有点旧了" */
  baked: string;
  bakedAt: string;
  patchNotesSource: string;
  wikiSource: string;
  release: NewsEntry;
  snapshot: NewsEntry | null;
}

/** 正文树的一个节点（`group` 只在顶层条目上出现：它决定这一行画成小标题） */
export interface NewsNode {
  text: string;
  children?: NewsNode[];
  group?: boolean;
}

export interface NewsSection {
  title: string;
  items: NewsNode[];
}

export interface NewsDoc {
  version: string;
  title: string;
  revid: number | null;
  fetchedAt: string;
  page: string;
  license: string;
  licenseUrl: string;
  intro: string;
  sections: NewsSection[];
}

/** 拍平之后的一行（渲染与"还剩多少条"都用它） */
export interface NewsRow {
  kind: 'group' | 'entry';
  text: string;
  /** 缩进层级：0 = 顶层条目，1 = 它下面那一层，依此类推 */
  depth: number;
}

/* ====================== 小工具 ====================== */

/** 拍平空白：上游正文里链接两边带空格，换行也不能原样带进 DOM */
export function flattenText(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 一段远端 JSON 文本 → 对象。
 *
 * ★ 一律吃**文本**而不是已经 parse 好的对象：清单与正文都是从数据目录里读回来的
 *   文件，坏在半路（下到一半断网、用户手改过）时必须是"这一份读不出来"，
 *   而不是一个异常把整页炸掉。`JSON.parse` 的抛错在这里就地收掉。
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/* ====================== 清单 ====================== */

function parseEntry(raw: unknown, kind: NewsKind): NewsEntry | null {
  if (!isObject(raw)) return null;
  const version = flattenText(raw.version);
  if (!version) return null;
  const wiki = isObject(raw.wiki) ? raw.wiki : {};
  const links = isObject(raw.links) ? raw.links : {};
  return {
    version,
    kind,
    type: flattenText(raw.type) || kind,
    date: asString(raw.date),
    title: flattenText(raw.title),
    shortText: flattenText(raw.shortText),
    /*
     * ★ 判据是 `wiki.has` **且**真的给了文件名：站点可能留着文件名而中文条目
     *   还没建好（它自己就是这么写的 —— `has: false` 旁边还挂着一个 file 字段）。
     *   照着那个名字去点「展开」会得到一次注定失败的请求。
     */
    hasDoc: wiki.has === true && flattenText(wiki.file) !== '',
    wiki: {
      revid: typeof wiki.revid === 'number' ? wiki.revid : null,
      fetchedAt: flattenText(wiki.fetchedAt),
      introLead: flattenText(wiki.introLead),
      page: asString(wiki.page),
      licenseUrl: asString(wiki.licenseUrl),
    },
    links: { zh: asString(links.zh), en: asString(links.en) },
  };
}

/**
 * 站点清单原文 → 我们能用的那份。
 *
 * 清单必须能回答"最新正式版是哪一版"——`release` 读不出来就算这一份不能用
 * （页面据此走空状态，而不是画一张没版本号的卡）。
 */
export function parseNewsManifest(text: string): NewsManifest | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const release = parseEntry(raw.latest, 'release');
  if (!release) return null;
  return {
    baked: flattenText(raw.baked),
    bakedAt: asString(raw.bakedAt),
    patchNotesSource: asString(raw.source),
    wikiSource: asString(raw.wikiSource),
    release,
    snapshot: parseEntry(raw.snapshot, 'snapshot'),
  };
}

/* ====================== 正文 ====================== */

/**
 * 站点正文树的一个节点 → 我们的形状（**只有 `text` + `children`**）。
 *
 * 站点那份里每个节点带 `lead` / `group` / `sub` / `children` 四种字段，
 * 而"更细的一层"有两种写法（`sub` 与 `children`）。这里全部收敛成一种：
 * **要显示的字在 `text`，下一层在 `children`**；只有顶层条目保留 `group`。
 *
 * ★ 返回 `null` = "这个节点没有可显示的字"（上游偶尔给空壳）——
 *   宁可不显示，也不要在界面上留一行空白。
 */
function parseNode(raw: unknown): NewsNode | null {
  if (!isObject(raw)) return null;
  const text = flattenText(raw.text);
  const children: NewsNode[] = [];
  for (const c of Array.isArray(raw.children) ? raw.children : []) {
    const n = parseNode(c);
    if (n) children.push(n);
  }
  /* `sub` 是同一层的另一种写法（数组里是纯字符串行，或者带 text 的对象）*/
  for (const s of Array.isArray(raw.sub) ? raw.sub : []) {
    const t = flattenText(isObject(s) ? s.text : s);
    if (t) children.push({ text: t, children: [] });
  }
  if (!text && children.length === 0) return null;
  const node: NewsNode = { text };
  if (children.length > 0) node.children = children;
  if (raw.group === true) node.group = true;
  return node;
}

function parseSection(raw: unknown): NewsSection | null {
  if (!isObject(raw)) return null;
  const items: NewsNode[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const n = parseNode(it);
    if (n) items.push(n);
  }
  if (items.length === 0) return null;
  return { title: flattenText(raw.title), items };
}

/**
 * 站点正文原文 → 能用的一份。**要么完整可用、要么 `null`**。
 *
 * ★ 这里不返回"空文档"这种半成品：`null` 会让页面如实说"这一版的中文正文读不出来，
 *   点上面的中文 Wiki 看"，而空文档会让用户点开一张什么都没有的卡 ——
 *   后者看起来像"这一版真的没更新"。
 */
export function parseNewsDoc(text: string): NewsDoc | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const version = flattenText(raw.version);
  if (!version) return null;
  const sections: NewsSection[] = [];
  for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
    const sec = parseSection(s);
    if (sec) sections.push(sec);
  }
  if (sections.length === 0) return null;
  return {
    version,
    title: flattenText(raw.title) || version,
    revid: typeof raw.revid === 'number' ? raw.revid : null,
    fetchedAt: flattenText(raw.fetchedAt),
    page: asString(raw.page),
    license: flattenText(raw.license) || 'CC BY-NC-SA 4.0',
    licenseUrl: asString(raw.licenseUrl),
    intro: flattenText(raw.intro),
    sections,
  };
}

/* ====================== 渲染要用到的加工 ====================== */

/** 这一行画成什么（卡片标题右边那个标签） */
export function newsKindLabel(kind: NewsKind): string {
  return kind === 'release' ? '最新正式版' : '最新快照';
}

/**
 * 版本日期 → `2026-09-15`。
 *
 * ★ 一律按 **UTC** 取那一段，不用本地时区：清单里的 `date` 是 ISO（带 `Z`），
 *   而"发布日期"这种东西在 UTC+8 的机器上算成前一天/后一天纯属自找的
 *   —— 同一份数据在两台机器上显示两个日期，排查时最难受。
 *   解析不出来时**原样显示前 10 个字符**（宁可显示成这样，也不要显示 `Invalid Date`）。
 */
export function formatNewsDate(iso: unknown): string {
  const s = asString(iso).trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * "上一次同步是什么时候" → `2026-10-15 19:52`（**本地时间**，人看的时间）。
 *
 * ★ 与版本日期相反，这里要的就是本地时间：用户看的是"我上次点同步是几点"。
 *   算不出来时给空串，由调用方决定显示什么（绝不显示 `Invalid Date`）。
 */
export function formatSyncTime(ms: unknown): string {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  if (n <= 0) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一棵树 → 一串行（**深度优先**，父在子前面）。
 *
 * ★ 为什么要拍平再渲染：26.3 那一版有 **1400 多行**，一口气全塞进 DOM
 *   会让"展开"这一下明显卡顿。拍平成数组之后按块显示，`shown` 加一块就再渲染一块
 *   （每行都有 `depth`，缩进照样在，也就是说"看起来是树、渲染是列表"）。
 */
export function sectionRows(section: NewsSection): NewsRow[] {
  const rows: NewsRow[] = [];
  const push = (node: NewsNode, depth: number, asGroup: boolean) => {
    if (node.text) rows.push({ kind: asGroup ? 'group' : 'entry', text: node.text, depth });
    for (const c of node.children ?? []) push(c, depth + 1, false);
  };
  for (const item of section.items) push(item, 0, item.group === true);
  return rows;
}

/** 整份正文有多少行（分块显示与「还有 N 行」那个数都用它） */
export function docRowCount(doc: NewsDoc): number {
  return doc.sections.reduce((n, s) => n + sectionRows(s).length, 0);
}

/**
 * 只取前 `shown` 行，并**按原来的节分组**返回（给"分块显示"用）。
 *
 * ★ 为什么切在"行"上、而不是"节"或"条目"上：
 *   26.3 的「新内容」一节里就有一个条目挂了 40 多个子行（方块那一条），
 *   按节切等于一次渲染 1400 行（卡），按条目切会让某一次点击突然冒出几百行。
 *   行是最小的可数单位，切出来每次都是 `NEWS_CHUNK` 那么大一坨。
 * ★ 返回的每一节里只剩要看的那几行，节标题跟着第一行走 ——
 *   所以"露出来的部分"看起来仍然是一篇有标题的文档，而不是一截断掉的列表。
 */
export function visibleSections(
  doc: NewsDoc,
  shown: number,
): Array<{ title: string; rows: NewsRow[] }> {
  let left = Number.isFinite(shown) ? Math.max(0, Math.floor(shown)) : 0;
  const out: Array<{ title: string; rows: NewsRow[] }> = [];
  for (const section of doc.sections) {
    if (left <= 0) break;
    const rows = sectionRows(section);
    const take = Math.min(left, rows.length);
    out.push({ title: section.title, rows: rows.slice(0, take) });
    left -= take;
  }
  return out;
}

/** 一次显示多少行（与用户网站上那份工具的 150 是一个量级） */
export const NEWS_CHUNK = 150;

/** 点了"继续显示"之后显示到第几行 */
export function nextVisible(shown: number, total: number, chunk = NEWS_CHUNK): number {
  const step = Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : NEWS_CHUNK;
  return Math.min(total, Math.max(0, Math.floor(shown)) + step);
}

/** 「继续显示」按钮上的字（还剩几条要写在字面上，不让用户猜还有多少） */
export function moreRowsLabel(remaining: number): string {
  const n = Math.max(0, Math.floor(remaining));
  return n > 0 ? `继续显示（还有 ${n} 行）` : '';
}

/**
 * 这份数据"烘焙"了多久（天）。`null` = 日期读不出来。
 *
 * ★ 为什么要算它：清单是**站点上某一天烘出来的**一份，也就是说
 *   "从那天到今天，Mojang 可能又发了新版本"。界面上必须能说出这一点
 *   （超过了 `NEWS_STALE_DAYS` 就挂一句"这份数据有点旧了"），
 *   而不是让用户以为这就是此刻的最新版本。
 */
export function bakedAgeDays(baked: unknown, today: Date): number | null {
  const s = asString(baked).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** 超过这么多天没同步，界面上就要说一句"数据旧了" */
export const NEWS_STALE_DAYS = 7;
