/**
 * 取版本：一个源给不出能用的版本时，**回退去问另一个源**。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部……这样即使有资源里不允许
 *   第三方下载，也可以得到互补了」。
 *
 * ## 这是「全部」留下的最后一个缺口
 *
 *   合并层（`resource-merge.ts`）把两个源的结果合成了一张表，并且
 *   **优先用能下载的那一份**（`preferred`）。但"取版本"这一步原来只问
 *   `preferred` 一份：
 *
 *     · 那一份**没有能装到当前实例的版本** ⇒ 界面显示「无」；
 *     · 那一份**问不到**（镜像不通 / id 不对）⇒ 界面还是「无」；
 *     · 而另一个来源明明有。
 *
 *   这就是"把拿不到说成没有"的老毛病，也正是「全部」要解决的互补问题。
 *
 * ## 三条纪律
 *
 *   ① **换源必须换身份**：Modrinth 的 id 是 base62、CurseForge 的是数字。
 *      拿一份的 id 去问另一个源，只会得到"上游没有"（C-1 修过一次：
 *      当时是拿 CF 的 slug 去问 CF 的文件接口）。
 *      ⇒ 目标表里每个源都带**它自己那一份**的 `project_id`
 *      （由合并层在 `availability` 里记下）。
 *   ② **回退是"换一批"，不是"两个列表拼起来"**：两源的版本号体系不一样，
 *      混在一张表里冒充同一个项目只会误导。所以这里返回**一批 + 它来自哪个源**，
 *      详情页据此说清（`versionSourceNote`），并**先问 preferred、拿不到才换**。
 *   ③ **不许凭空说"无"**：两个源都问了、都没有，才叫真的没有；
 *      只要有一份**非空**（哪怕按当前实例筛完不剩），也宁可多列几条让人自己判断
 *      （`components/version-filter.ts` 里"筛完不剩就退回全量"是同一条规矩）。
 *
 * ## 为什么判据能真跑
 *
 *   网络那一层由调用方注入（`fetch`），所以"问哪几个源、按什么顺序、哪一批算数、
 *   详情页怎么说"全都是可测的纯逻辑 —— 本机没有 DOM 测试环境，
 *   这是唯一能真跑的回路（`tests/version-sources.test.mjs`）。
 */
import { SOURCE_LABEL, SOURCE_ORDER } from './resource-merge.ts';
import type { ResourceProvenance, ResourceSourceName } from './resource-merge.ts';

/** 要去问的那一个源 + **它自己那一份**的项目 id */
export interface VersionSourceTarget {
  source: ResourceSourceName;
  projectId: string;
}

/** 一次尝试：问了谁、拿到几条、为什么不算数 */
export interface VersionAttempt {
  source: ResourceSourceName;
  /** 拿回来几条（报错时是 0） */
  count: number;
  /** 报错原因（`null` = 这次请求本身是成的） */
  error: string | null;
  /** 这一批**能不能用**（默认口径 = 非空；调用方可以要求"有能装到当前实例的"） */
  usable: boolean;
}

/** 一次"取版本"的结论 */
export interface VersionLookup<T> {
  /** 要显示的那一批（**只来自一个源**） */
  versions: T[];
  /** 这一批来自哪个源；`null` = 一个都没给出来（这才叫真的没有） */
  source: ResourceSourceName | null;
  /** ★ 是不是**回退**来的（前面那份不算数，换了另一个源） */
  fellBack: boolean;
  /** 试过哪几个（按顺序）—— 详情页与排查都要用它 */
  tried: VersionAttempt[];
}

/**
 * 该按什么顺序问哪几个源。
 *
 *   · `preferred` 永远排第一（它是"能下载的那一份"）；
 *   · 其余来源按固定顺序（`SOURCE_ORDER`，不靠对象键的遍历顺序 —— 否则同一份
 *     输入可能给出不同次序，界面会随刷新换一批数据）；
 *   · **只列 `provenance` 里记着的源**：没记着它收录了这个项目的源，问也白问
 *     （更糟：会拿错身份去问，得到"上游没有"）。
 *   · 没有 `provenance`（老路径）⇒ 用调用方给的那一个源与 id。
 */
export function versionSourcesToTry(
  prov: ResourceProvenance | null | undefined,
  fallback: VersionSourceTarget,
): VersionSourceTarget[] {
  /*
   * ★ 形状不对（没合并过 / 数据是旧的）也不许抛：退回调用方给的那一个源 ——
   *   那等于"没有合并信息"，与老路径同一条路（老路径就是这么走的）。
   */
  if (!prov || !Array.isArray(prov.availability) || prov.availability.length === 0) {
    return [fallback];
  }
  const ordered: ResourceSourceName[] = [
    prov.preferred,
    ...SOURCE_ORDER.filter((s) => s !== prov.preferred),
  ];
  const out: VersionSourceTarget[] = [];
  for (const source of ordered) {
    const row = prov.availability.find((a) => a.source === source);
    const id = (row?.project_id ?? '').trim();
    /*
     * ★ 没有身份的源**跳过**：拿别人的 id 去问 = 把"我们拿错了标识"说成"上游没有"
     *   （C-1 事故的形状）。少问一个源，好过问出一个假结论。
     */
    if (id.length === 0) continue;
    out.push({ source, projectId: id });
  }
  // 一个身份都没有（脏数据）时退回调用方给的：至少还有一条路
  return out.length > 0 ? out : [fallback];
}

/**
 * 按顺序问，**第一个给出"可用"版本的源就是答案**。
 *
 * 全都不"可用"时（判据由调用方给）：把**第一份非空的**拿出来显示 ——
 * 界面不许因为"筛完不剩"就凭空说「无」（那是"读不到 ≠ 没有"的同一条规矩）。
 *
 * ★ 纯逻辑 + 注入的 `fetch` ⇒ 可以用假 fetch 真跑（见 `tests/version-sources.test.mjs`）。
 */
export async function lookupVersionsFrom<T>(opts: {
  targets: VersionSourceTarget[];
  /** 真实现是 `api.modrinth.resourceVersions`（外部只传这一个回调） */
  fetch: (t: VersionSourceTarget) => Promise<T[]>;
  /** 这一批算不算"可用"；缺省 = 非空 */
  usable?: (list: T[]) => boolean;
}): Promise<VersionLookup<T>> {
  const usable = opts.usable ?? ((list: T[]) => list.length > 0);
  const tried: VersionAttempt[] = [];
  const got: Array<{ target: VersionSourceTarget; list: T[] }> = [];

  for (const target of opts.targets) {
    try {
      const list = await opts.fetch(target);
      const ok = list.length > 0 && usable(list);
      tried.push({ source: target.source, count: list.length, error: null, usable: ok });
      got.push({ target, list });
      if (ok) {
        return { versions: list, source: target.source, fellBack: tried.length > 1, tried };
      }
    } catch (e) {
      /*
       * ★ 一个源问不到**不是结束**：另一个源可能真的有（这正是"全部"的意义）。
       *   原因记下来 —— 两个源都没成时，详情页要说得清是"都没问到"还是"都没有"。
       */
      tried.push({
        source: target.source,
        count: 0,
        error: e instanceof Error ? e.message : String(e),
        usable: false,
      });
    }
  }

  const firstNonEmpty = got.find((g) => g.list.length > 0);
  if (!firstNonEmpty) {
    return { versions: [], source: null, fellBack: false, tried };
  }
  return {
    versions: firstNonEmpty.list,
    source: firstNonEmpty.target.source,
    /*
     * ★ 这一条不是"回退"：它是 preferred 那一份（或最先有东西的那一份）**原样列出**，
     *   只是没有"能用"的版本 —— 渲染层会把不兼容的也列出来让人自己判断。
     *   标成回退会让详情页多一句不成立的解释。
     */
    fellBack:
      firstNonEmpty.target.source !== (tried[0]?.source ?? firstNonEmpty.target.source) &&
      tried[0]?.count === 0,
    tried,
  };
}

/**
 * 详情页那一句：**这一批版本来自哪一份、为什么换了源**（`null` = 不用多说）。
 *
 * 用户定的口径：来源信息放**详情页**（卡片上不放徽章）。所以"回退"必须在
 * 这里说清 —— 否则用户会以为屏幕上还是他点进来的那一个来源的版本。
 *
 * 三种情形分开说：
 *   ① 有结果、且回退了 ⇒ 说清来自哪一份 + 另一份为什么不算数；
 *   ② 有结果、没回退、但两个来源都收录了它 ⇒ 也要说清列表来自哪一份
 *      （"两个来源都有"不等于"两份的版本都在这一屏"）；
 *   ③ 一个都没给出来 ⇒ 说清"都问了、都没有"（**这才叫真的没有**），
 *      并把问不到的原因带上（不许把"问不到"说成"没有"）。
 */
export function versionSourceNote(
  prov: ResourceProvenance | null | undefined,
  looked: Pick<VersionLookup<unknown>, 'source' | 'fellBack' | 'tried'>,
): string | null {
  const tried = looked.tried ?? [];
  /** 这一份为什么不算数（人话） */
  const why = (a: VersionAttempt): string => {
    if (a.error) return `问不到（${a.error}）`;
    if (a.count > 0) return '没有能装到当前实例的版本';
    return '没有可用的版本';
  };

  const preferred = prov?.preferred ?? null;

  if (!looked.source) {
    const first = tried[0];
    if (!first) return null;
    if (tried.length === 1) {
      return `${SOURCE_LABEL[first.source]} 没给出可用的版本（${why(first)}）。`;
    }
    const list = tried.map((a) => `${SOURCE_LABEL[a.source]}：${why(a)}`).join('；');
    return `两个来源都没给出可用的版本（${list}）。`;
  }

  if (looked.fellBack && preferred && preferred !== looked.source) {
    const bad = tried.find((a) => a.source === preferred);
    return `下面的版本来自 ${SOURCE_LABEL[looked.source]} —— ${SOURCE_LABEL[preferred]} 那一份${
      bad ? why(bad) : '没给出可用的版本'
    }。`;
  }

  if ((prov?.sources.length ?? 0) > 1) {
    return `下面的版本来自 ${SOURCE_LABEL[looked.source]}（两个来源的版本不混在一张表里）。`;
  }

  // 单源、没回退：上面那行「来自 X」已经说过了，不多说一个字
  return null;
}
