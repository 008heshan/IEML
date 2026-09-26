/**
 * 「版本世代」与「按世代分组」—— **纯逻辑，与界面无关**。
 * ------------------------------------------------------------------
 * ## 世代判据只有一份
 *
 * 哪个版本算哪一代，**只在这里判一次**（`versionFamily()`）。
 * 界面别处（版本列表、下载页、概览、安装页）都调它 —— 否则同一条规则会出现第二份。
 *
 * ★★ 2026-09-23 晚（用户看着「愚人节」那一档说「**这个分类就有点莫名其妙了**」）：
 *   "愚人节是哪些版本"这件事，`domain/loader-caps.ts` 里**已经有一份白名单**
 *   （`APRIL_FOOLS`，9 个，还写着"宁可漏一个，不可错一个"的理由）。
 *   而这里**又抄了一份**（只有 4 个），并且**排在快照规则后面**。两处后果：
 *     · `15w14a` / `1.RV-Pre1` 被快照规则 `-(pre|rc)\d*$` 吞掉 → 标成「快照」；
 *     · `24w14potato` / `25w14craftmine` 谁都不认 → 标成「其他」。
 *   于是"愚人节"档里出现了「其他 / 愚人节 / 快照」三个分组 —— 那正是用户看到的莫名其妙。
 *   现在**只留一份**：下面直接调 `isAprilFoolsVersion()`，而且**排在快照之前**判。
 *   （这就是 ADR-051 那条"同一个判据写两遍"的老毛病，第 N 次。）
 *
 * ★★ 2026-09-26 **为什么从 `VersionIcon.tsx` 搬到这里**：
 *   这两个函数是纯逻辑，而 `.tsx` 里的东西**跑不进 `node --test`**
 *   （Node 只剥离 `.ts`，遇到 `.tsx` 直接 `ERR_UNKNOWN_FILE_EXTENSION`）。
 *   判据写不进测试，就只能靠人眼 —— 而"同一世代出现两次"这种毛病
 *   **不报错、只是显示乱**，正是必须有机器守的那一类。
 *   搬出来之后 `tests/version-groups.test.mjs` 能直接调它们。
 */

/*
 * ★ 为什么指向具体文件而不是 `'../domain'`（目录导入）：
 *   **Node 的 ESM 不支持目录导入**（`ERR_UNSUPPORTED_DIR_IMPORT`），
 *   而下面那两个函数要靠 `node --test` 跑 —— 目录导入会让判据直接跑不起来。
 *   （Vite 两种都认；指具体文件两边都行，而且依赖关系更明确。）
 */
import { isAprilFoolsVersion } from '../domain/loader-caps.ts';

/** 一个版本世代：谁属于它、叫什么、用什么色 */
export interface VersionFamily {
  key: string;
  /** 列表分组标题（`1.21` / `1.7 ~ 1.12` / `快照`） */
  label: string;
  /** 图标配色档位（CSS 里一一对应） */
  tone: 'modern' | 'mid' | 'classic' | 'legacy' | 'snapshot' | 'april';
  /** 分组排序用：越大越新 */
  rank: number;
}

/**
 * 从版本号推出世代。
 *
 * ★ 规则刻意简单：只看 `主.次`，特殊形态（快照 / 愚人节版本）单独判。
 *   Minecraft 的世代边界就是"哪一年发的那条线"：
 *     1.21+     = 现代（绿）
 *     1.16~1.20 = 中期（蓝）
 *     1.13~1.15 = 海洋/村庄更新（靛）
 *     1.7~1.12  = 老 Mod 黄金期（琥珀）
 *     ≤1.6      = 更早（石）
 *   颜色不是装饰：1.12.2 与 1.20.1 的 Mod 生态完全不同，用户需要一眼分开。
 */
export function versionFamily(version: string): VersionFamily {
  const v = (version || '').trim();
  /*
   * ★★ 愚人节必须**排在快照之前**判：`15w14a` 长得就像普通快照，
   *   `1.RV-Pre1` 还会被 `-(pre|rc)\d*$` 命中 —— 先问白名单，
   *   这两类就不会被误判成「快照」（判据只有 `isAprilFoolsVersion()` 一处）。
   */
  if (isAprilFoolsVersion(v)) {
    return { key: 'april', label: '愚人节', tone: 'april', rank: 8999 };
  }
  /*
   * ★★★★ 2026-09-26 改：**版本线（`主.次`）优先于"周快照"**。
   *
   *   老顺序是"周快照 / 预发布"先判，于是 `1.21.2-pre1` 掉进「快照」那一档 ——
   *   同一代的东西被拆到两个地方（`26.2-rc-2` 归 `26.2`，`1.21.2-pre1` 归「快照」），
   *   看着就是"这个快照的显示非常混乱"（用户原话）。
   *   ⇒ 现在的口径**一条**：
   *     · 带 `主.次` 的版本（含它的 `-pre` / `-rc` / `-snapshot` 预发布）→ **归它那条线**；
   *     · 形如 `25w14a` 的**周快照**（不属于任何线）→ 单独一档「快照」；
   *     · 愚人节 → 单独一档（上面已判）。
   */
  const m = v.match(/^(\d+)\.(\d+)/);
  if (!m) {
    // 形如 `25w14a` / `24w03a`：周快照，不属于任何正式版线
    if (/^\d{2}w\d{2}/i.test(v)) {
      return { key: 'snap', label: '快照', tone: 'snapshot', rank: 9000 };
    }
    return { key: 'other', label: '其他', tone: 'classic', rank: 0 };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  /*
   * ★★ 2026-09-16（用户："比如 26.2 和 26.1，在 26.2 就显示 26.2，在 26.1 就显示 26.1"）：
   *   这一支以前写的是 `label: v`（**整串版本号**），而 `key` 是世代。
   *   于是分组的标题会取到组里第一行的完整 id —— `26.2-rc-2`、`26.2-pre-6`
   *   这种当标题，看着像"这一组是 rc"，其实它和 `26.2` 是同一组。
   *   现在**标签就用世代号**，与其它分支一致（`1.21` / `1.7` 本来就是这样）。
   */
  if (major >= 2) return { key: `${major}.${minor}`, label: `${major}.${minor}`, tone: 'modern', rank: 10000 + minor };
  if (minor >= 21) return { key: `${major}.${minor}`, label: `${major}.${minor}`, tone: 'modern', rank: 10000 + minor };
  if (minor >= 16) return { key: `${major}.${minor}`, label: `${major}.${minor}`, tone: 'mid', rank: 5000 + minor };
  if (minor >= 13) return { key: `${major}.${minor}`, label: `${major}.${minor}`, tone: 'classic', rank: 3000 + minor };
  if (minor >= 7) return { key: `${major}.${minor}`, label: `${major}.${minor}`, tone: 'legacy', rank: 1000 + minor };
  return { key: 'ancient', label: '1.6 及更早', tone: 'classic', rank: 500 + minor };
}

/**
 * 把一串行按**世代**分组。
 *
 * ★ 分组只负责"切开"，**不负责排序**：清单顺序保持上游给的（新→旧），
 *   我们重排就等于自己造了一份顺序。
 *
 * ★★★★ 2026-09-26 修（用户截图：那一列里「快照」出现了**两次**，`26.1`/`26.2`
 *   也各出现了两次，"这个快照的显示非常混乱"）：
 *
 *   老实现只把**相邻**的同键行并成一组（`last.fam.key === fam.key`）——
 *   而上游清单里它们**不是相邻的**：`26.2` 后面跟着 `26.2-rc-2`（快照键），
 *   再往后又是别的 `26.2`；周快照 `25w14a` 与预发布 `1.21.2-pre1`
 *   共用 `snap` 键但中间隔着正式版。
 *   ⇒ 同一个键被切成好几段，用户看到的就是"同一档出现好几次"。
 *
 *   现在**按 key 合并**：首次出现的位置决定这一组排在哪，
 *   组内顺序 = 上游顺序（新→旧）。这样每个世代只有一行，条数也对得上。
 */
export function groupByFamily<T>(
  rows: T[],
  versionOf: (row: T) => string,
): Array<{ fam: VersionFamily; rows: T[] }> {
  const out: Array<{ fam: VersionFamily; rows: T[] }> = [];
  const byKey = new Map<string, { fam: VersionFamily; rows: T[] }>();
  for (const r of rows) {
    const fam = versionFamily(versionOf(r));
    const hit = byKey.get(fam.key);
    if (hit) {
      hit.rows.push(r);
    } else {
      const group = { fam, rows: [r] };
      byKey.set(fam.key, group);
      out.push(group);
    }
  }
  return out;
}
