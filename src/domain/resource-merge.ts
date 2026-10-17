/**
 * 「全部」来源下，两个源的结果怎么**合到一张表**里。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部，并且默认为全部，
 *   这样即使有资源里不允许第三方下载，也可以得到互补了」。
 *
 * ## 为什么这一层是**纯函数**（而不是写在组件 / 后端里）
 *
 *   合并、去重、优先级这三件事一旦写错，症状都是**界面看起来完全正常**：
 *     · 少一条（硬合并掉了两个不同项目）—— 用户只会觉得"这个资源没有"；
 *     · 装错源（优先级反了）—— 点安装就报"下不了"，而他明明看到过它；
 *     · 把"下不了"说成"能下"—— 一路点到底才失败。
 *   三者都不报错、也不抛异常。所以判据必须能被 `node --test` 真跑
 *   （本机没有 DOM 测试环境，纯逻辑是唯一能红的回路），
 *   见 `tests/resource-merge.test.mjs`。
 *
 * ## 四条口径（用户已定）
 *
 *   ① **不按名字硬合并**：同名不同作者 = 两个不同的项目，两条都要在；
 *   ② **名字与作者都相同**才合成一条 → `provenance.sources` 两个都在，
 *      详情页据此说「两个来源都有」；
 *   ③ 合成那一条**优先用能下载的那一份** —— CurseForge 的作者可以关掉
 *      「允许第三方分发」，那种项目的文件 `downloadUrl` 是 null
 *      （判据在 `net/curseforge.rs` 文件头：热门 50 个里就有 1 个）；
 *   ④ 两源都不能下载时**如实说**，不许假装有（`describeSource` 的 warning）。
 *
 * ## 合并发生在哪一层（以及为什么是这个分法）
 *
 *   拉取在后端（`resource_search_both`：一条命令并发查两源，各自记下
 *   自己的错误与 `total_hits`）；**判断在**这里。理由是上面那段：
 *   判断要能真跑，而后端单测在这台机器上跑不了（`cargo test --lib`
 *   在加载阶段就退出，一个测试都跑不到）。后端因此只做"取回来"，
 *   不参与合并 —— 也就不会出现同一套判据在 Rust 与 TS 里各一份（ADR-051）。
 */
import type {
  BothSearch,
  ModrinthHit,
  ModrinthSearch,
  ResourceProvenance,
  ResourceSourceName,
  SourceAvailability,
} from '../bridge/tauri';

/*
 * 这三个类型住在 `bridge/tauri.ts`（`ResourceSourceName` 也在那里）——
 * 这里转出来，是为了让"用来源判据的地方"只 import 这一个文件
 * （`version-sources.ts` 就是靠它取 `ResourceSourceName` 的）。
 */
export type { ResourceProvenance, SourceAvailability, ResourceSourceName };

/** 排序（沿用现有的三种，见 `DownloadPage` 整合包那排） */
export type ResourceSort = 'hot' | 'new' | 'downloads';

/**
 * 两个源的显示名 —— **唯一一份**。
 * 切换器、详情页、警告句都从这里取，不许各处再抄一遍字面量
 * （本仓库栽过"同一措辞写两份然后分叉"）。
 */
export const SOURCE_LABEL: Record<ResourceSourceName, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
};

/**
 * 源的**固定顺序**：决定合并后同一条资源保留哪一份数据、以及交错排列的先后。
 * ★ 顺序写死（不靠对象键的遍历顺序）：否则同一份输入可能给出不同的
 *   `preferred`，卡片上的下载量会随刷新跳动。
 */
export const SOURCE_ORDER: readonly ResourceSourceName[] = ['modrinth', 'curseforge'];

/** 一个源这一页的结果（`null` / 缺 = 这个源这次没查成或没查） */
export interface SearchPages {
  modrinth?: ModrinthHit[] | null;
  curseforge?: ModrinthHit[] | null;
}

/**
 * ★★ 来源切换器上的取值：`all` = 两个源一起查（**默认**）。
 *
 * 用户 2026-10-17：「在 modr 的左边加一个全部，并且默认为全部」。
 * ★ 这个值**只决定"要查哪几个源"**，不许当成来源传给任何接口 ——
 *   版本列表 / 安装只认 `provenance.preferred`（那是数据算出来的）。
 */
export type SourceChoice = 'all' | ResourceSourceName;

/** 切换器的顺序：**全部在最左**（用户指定），其余沿用固定顺序 */
export const SOURCE_CHOICES: readonly SourceChoice[] = ['all', ...SOURCE_ORDER];

/**
 * 「全部」这一页拿回来之后，怎么读它 —— **唯一一份**（资源中心与整合包页共用）。
 *
 * ★ 三件事都容易写错，所以放在这里被 `node --test` 钉住：
 *   ① 一边没查成时**要说出来**（`sideError`）—— 一个源超时/镜像不通
 *      ≠ 那个源没有这个资源（ADR-050）；
 *   ② 翻页基数取两源总数的**较大者**，**不是相加** ——
 *      同一条资源可能两边都在，相加出来的是一个编的数；
 *   ③ `lead`（"这页结果是从哪个词来的"那句话从哪一份取）：Modrinth 优先，
 *      它没查成才退到 CurseForge —— 不能因为 CF 挂了就没有别名提示。
 */
export interface PagesFromBoth {
  /** 两个源各自那一页（缺 / 没查成的那个是空数组） */
  pages: SearchPages;
  /** 一边没查成时的原因（`null` = 两边都成）；两边都挂时后端直接报错 */
  sideError: string | null;
  /** 翻页基数 */
  totalHits: number;
  /** 「这页结果是从哪个词来的」那一份（两边都没查成时 `null`） */
  lead: ModrinthSearch | null;
}

export function pagesFromBoth(both: BothSearch): PagesFromBoth {
  const failed: string[] = [];
  if (both.modrinth_error) failed.push(`${SOURCE_LABEL.modrinth}：${both.modrinth_error}`);
  if (both.curseforge_error) failed.push(`${SOURCE_LABEL.curseforge}：${both.curseforge_error}`);
  return {
    pages: {
      modrinth: both.modrinth?.hits ?? [],
      curseforge: both.curseforge?.hits ?? [],
    },
    sideError: failed.length > 0 ? failed.join('；') : null,
    totalHits: Math.max(both.modrinth?.total_hits ?? 0, both.curseforge?.total_hits ?? 0),
    lead: both.modrinth ?? both.curseforge ?? null,
  };
}

/** 合并后的一条：本身就是合法的 `ModrinthHit`，额外带来源 */
export type MergedHit = ModrinthHit & { provenance: ResourceProvenance };

/**
 * 这一条**能不能直接下载**。
 *
 * ★ 判据只看数据，**不按"哪个源"分两套**：`distribution_allowed === false`
 *   才是"作者禁止第三方分发"。Modrinth 没有这个概念（永远是 `null`）⇒ 能下；
 *   `undefined` 只是"没这个字段"，也不是"禁止"。
 * ★ 这是**项目级**判据；真正的真相在文件级（`file.url` 为空 = 下不了），
 *   安装那一步仍然会查（`flows/resource-install.ts`）—— 两层各管一段。
 */
export function isDirectlyDownloadable(_source: ResourceSourceName, hit: ModrinthHit): boolean {
  return hit.distribution_allowed !== false;
}

/** 身份归一：全角半角 / 大小写 / 前后空白 / 连续空白都不算差异 */
function norm(s: string): string {
  return (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 这条命中的**身份**（`名字 + 作者`）；给不出身份时返回 `null`。
 *
 * ★ 为什么不是 slug / project_id：两个平台的 id 体系完全不同，同一个项目
 *   在两边是**两个不同的 id** —— 用 id 当身份等于永不合并。
 * ★ 为什么不是"只按名字"：两个平台上**同名不同作者**的项目是常态
 *   （附属、搬运、重名），硬合并会吃掉一条真实结果。
 * ★ 标题为空时返回 `null`（不参与合并）—— 否则所有没标题的条目会糊成一条。
 */
export function mergeIdentity(hit: ModrinthHit): string | null {
  const title = norm(hit.title ?? '');
  if (!title) return null;
  return `${title}\u0000${norm(hit.author ?? '')}`;
}

/** 造一条"单源"结果（身份不成立 / 第一次见到它） */
function single(source: ResourceSourceName, hit: ModrinthHit): MergedHit {
  const downloadable = isDirectlyDownloadable(source, hit);
  return {
    ...hit,
    provenance: {
      sources: [source],
      preferred: source,
      downloadable,
      availability: [{ source, downloadable, project_id: hit.project_id }],
    },
  };
}

/**
 * 把**同一条**结果并进已有的那一条（只有名字 + 作者相同才会走到这里）。
 *
 * ★ 优先用能下载的那一份：现有那份下不了、新来的这份能下 ⇒ **整条**换成新的
 *   （`preferred` 跟着换）。两份都能下 ⇒ 保留先出现的那个
 *   （`SOURCE_ORDER` 里靠前的）—— 顺序固定，界面不会因为刷新换一份数据。
 * ★ 为什么"整条换"而不是只换 `preferred`：只换 preferred 会让详情页出现
 *   "来自 Modrinth"却写着 CurseForge 的下载量/图标。
 *
 * ★★ 2026-10-17：**每一份的 `project_id` 也记下来**（`availability` 里逐源带）——
 *   两个平台的 id 体系完全不同，而"取版本"这一步要在 preferred 给不出可用版本时
 *   **回退去问另一个源**，那时必须用**那一个源自己的 id**。
 *   这件事只能在这里做：两个源的原始命中都在手上（`hit.project_id`），
 *   一旦合并完（`absorb` 的整条替换）另一份的 id 就再也拿不回来了。
 */
function absorb(entry: MergedHit, source: ResourceSourceName, hit: ModrinthHit): void {
  const downloadable = isDirectlyDownloadable(source, hit);
  const kept = entry.provenance;
  kept.availability.push({ source, downloadable, project_id: hit.project_id });
  kept.sources = SOURCE_ORDER.filter((s) => kept.availability.some((a) => a.source === s));
  if (downloadable && !kept.downloadable) {
    const data: Record<string, unknown> = { ...hit };
    delete data.provenance;
    Object.assign(entry, data);
    kept.preferred = source;
  }
  entry.provenance = kept;
  kept.downloadable = kept.availability.some((a) => a.downloadable);
}

/**
 * 合并两个源**同一页**的结果。
 *
 * ## 排列方式：交错（round-robin）
 *
 *   `m0, c0, m1, c1, …` —— 而不是"一段 Modrinth 再接一段 CurseForge"。
 *   用户要的是**互补**：CF 那半要在 Modrinth 没有命中时顶上来；
 *   而"先列完 A 再列 B"会让第一屏全是同一个源，看不出互补。
 *
 * ## 去重只在**名字 + 作者都相同**时发生
 *
 *   其余一律原样保留（见 `mergeIdentity`）。
 *
 * ★ 纯函数：不改 `pages` 里的数组，也不改里面的命中对象。
 */
export function mergeHits(pages: SearchPages): MergedHit[] {
  const queues: Array<{ source: ResourceSourceName; hits: ModrinthHit[] }> = [];
  for (const source of SOURCE_ORDER) {
    const hits = pages[source];
    if (hits && hits.length > 0) queues.push({ source, hits });
  }
  const out: MergedHit[] = [];
  const seen = new Map<string, MergedHit>();
  const deepest = queues.reduce((n, q) => Math.max(n, q.hits.length), 0);
  for (let i = 0; i < deepest; i += 1) {
    for (const q of queues) {
      const hit = q.hits[i];
      if (!hit) continue;
      const key = mergeIdentity(hit);
      if (key === null) {
        // 给不出身份 ⇒ 不参与合并，但**这一条要保留**（不许静默丢结果）
        out.push(single(q.source, hit));
        continue;
      }
      const prev = seen.get(key);
      if (prev) {
        absorb(prev, q.source, hit);
        continue;
      }
      const made = single(q.source, hit);
      seen.set(key, made);
      out.push(made);
    }
  }
  return out;
}

/**
 * 按当前排序重排（**稳定**：同值保持合并后的原顺序）。
 *
 *   · `hot`       —— 原顺序（上游按相关度/热度给的，合并只是交错了一下）；
 *   · `downloads` —— 下载量降序；
 *   · `new`       —— 上游次序反过来。
 *     ★ 为什么"最新"是倒序：搜索命中里**没有发布时间字段**（两个源都没有），
 *       现有实现一直是 `list.reverse()`（`DownloadPage` 里那句）。这是现状口径，
 *       不是新发明的规则 —— 编一个时间出来才是欺骗。
 *
 * `keyOf` 是泛型的：资源中心直接传 `(h) => h`，整合包页传 `(p) => p.hit`
 * —— 两个列表共用同一份排序判据，不写两套。
 */
export function sortHits<T>(list: T[], sort: ResourceSort, keyOf: (item: T) => ModrinthHit): T[] {
  const out = [...list];
  if (sort === 'downloads') {
    return out.sort((a, b) => keyOf(b).downloads - keyOf(a).downloads);
  }
  if (sort === 'new') return out.reverse();
  return out;
}

/** 详情页要说的话（判据在这里，界面只负责渲染） */
export interface SourceSummary {
  /** 一行来源说明，如 `来自 Modrinth + CurseForge（两个来源都有）` */
  text: string;
  /** 需要额外说清的事（不能下载 / 换用了哪一份）；`null` = 不用多说 */
  warning: string | null;
}

/**
 * 详情页的来源说明。
 *
 * `prov` 为空时（老路径 / 没经过合并层）退回 `fallback` 那个源 ——
 * 界面原来就是这么说的（"来自 Modrinth"），不夸大也不隐瞒。
 */
export function describeSource(
  prov: ResourceProvenance | null | undefined,
  fallback?: ResourceSourceName,
): SourceSummary {
  if (!prov || prov.sources.length === 0) {
    return { text: `来自 ${SOURCE_LABEL[fallback ?? 'modrinth']}`, warning: null };
  }
  const names = prov.sources.map((s) => SOURCE_LABEL[s]).join(' + ');
  const both = prov.sources.length > 1;
  const text = both ? `来自 ${names}（两个来源都有）` : `来自 ${names}`;

  const blocked = prov.availability
    .filter((a) => !a.downloadable)
    .map((a) => SOURCE_LABEL[a.source]);
  if (!prov.downloadable) {
    /*
     * ★ 两源都不能下载时**如实说**（用户点名的一种情形）。
     *   单源那一句刻意不提"两个来源"，否则会把只有 CF 一条的结果说成两个都在。
     */
    const subject = both ? '两个来源都不能直接下载' : '这个来源不能直接下载';
    return {
      text,
      warning: `${subject}（作者关掉了「允许第三方分发」）—— 去项目页自己下，再放进目录。`,
    };
  }
  if (blocked.length > 0) {
    // 一份能下、一份不能：说清用的是哪一份（用户点安装时才知道为什么换了源）
    return {
      text,
      warning: `${blocked.join('、')} 的作者不许第三方下载，所以用的是 ${
        SOURCE_LABEL[prov.preferred]
      } 那一份。`,
    };
  }
  return { text, warning: null };
}
