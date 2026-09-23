/**
 * 版本图标（MC 版本 + 加载器）
 * ------------------------------------------------------------------
 * ## 为什么需要它（用户的要求）
 *
 * 原话：「mc 版本也可以要 icon 的，只是需要好的显示方式，或许得让 mc 版本有
 * 更好的显示方式，而不是展开后看到版本们一堆堆在一起」。
 *
 * 所以这里解决两件事：
 *   ① **一眼能分辨**：一条纯文字 `1.20.1` 和一串 `1.20.1 / 1.20.2 / 1.20.4`
 *      在列表里长得一模一样。按"版本世代"给一个**方块图标**（等距立方体，
 *      不同世代不同色）之后，扫一眼就知道哪个是新的、哪个是老版本。
 *   ② **分组显示**：列表按 `1.21` / `1.20` 这样的世代分组，每组一个标题 ——
 *      900 个版本平铺就是"一堆堆在一起"，分组之后是"一节一节的"。
 *
 * ## ★ 为什么不是"真正的游戏图标"
 *
 * Minecraft 的草方块等贴图是 Mojang 的美术资源，**不能随启动器分发**
 * （README「许可」一节写着：本项目不含任何游戏资源文件）。
 * 所以这里画的是一个**自绘的等距方块**：形状是通用的几何，颜色由版本世代决定，
 * 不复制任何官方美术。PCL 用的是本地游戏文件里的贴图 —— 我们没有那份文件，
 * 也不该去下它。
 *
 * ## 世代判据只有一份
 *
 * 哪个版本算哪一代，只在这个文件的 `versionFamily()` 里判一次。
 * 界面别处（版本列表、下载页、概览）都调它 —— 否则同一条规则会出现第二份。
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
 */

import versionIcon from '../assets/version-icon.png';
import { isAprilFoolsVersion } from '../domain';

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
   *   `1.RV-Pre1` 还会被下面的 `-(pre|rc)\d*$` 命中 —— 先问白名单，
   *   这两类就不会被误判成「快照」（判据只有 `isAprilFoolsVersion()` 一处）。
   */
  if (isAprilFoolsVersion(v)) {
    return { key: 'april', label: '愚人节', tone: 'april', rank: 8999 };
  }
  // 快照：`25w14a` / `1.21.2-pre1` / `24w03a`
  if (/^\d{2}w\d{2}[a-z]$/i.test(v) || /-(pre|rc)\d*$/i.test(v)) {
    return { key: 'snap', label: '快照', tone: 'snapshot', rank: 9000 };
  }
  const m = v.match(/^(\d+)\.(\d+)/);
  if (!m) return { key: 'other', label: '其他', tone: 'classic', rank: 0 };
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
 * 自绘的等距方块图标。
 *
 * 三个面用同一个色相的三档明度：顶面最亮、右侧中间、左侧最暗 ——
 * 就有了"立体块"的感觉，而且**任何纯色主题下都成立**（不依赖图片资源）。
 */
export function VersionIcon({
  version,
  size = 34,
  title,
}: {
  version: string;
  size?: number;
  /** 悬停提示（默认就是版本号） */
  title?: string;
}) {
  const fam = versionFamily(version);
  return (
    <span
      className={`vi vi-${fam.tone}`}
      style={{ width: size, height: size }}
      title={title ?? version}
      aria-hidden="true"
    >
      <img src={versionIcon} width={size} height={size} alt="" style={{ borderRadius: 4 }} />
    </span>
  );
}

/**
 * 把版本号列表按世代分组（**顺序保持原样**：上游清单本来就是新→旧）。
 *
 * 为什么保持原顺序而不是自己排：清单顺序是上游给的"什么是最新"，
 * 我们重排就等于自己造了一份顺序；分组只负责"切开"，不负责"排序"。
 */
export function groupByFamily<T>(
  rows: T[],
  versionOf: (row: T) => string,
): Array<{ fam: VersionFamily; rows: T[] }> {
  const out: Array<{ fam: VersionFamily; rows: T[] }> = [];
  for (const r of rows) {
    const fam = versionFamily(versionOf(r));
    const last = out[out.length - 1];
    if (last && last.fam.key === fam.key) last.rows.push(r);
    else out.push({ fam, rows: [r] });
  }
  return out;
}
