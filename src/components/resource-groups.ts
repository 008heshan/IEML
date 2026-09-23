/**
 * C4：资源版本列表**按 MC 版本分组**（用户：「整合包，mod，资源包，数据包，光影，
 * 给版本分类，**就像游戏版本安装那样**」，并确认「分类的粒度：**按大版本分组**」）。
 *
 * 参照物是图二（PCL 的 Sodium 详情页）：
 *   · 上面一排 **MC 版本 chips**（`全部 26.3 26.2 26.1 1.21 …`）—— 点一下只看那个版本；
 *   · 下面一列**可折叠的分组**（`NeoForge 26.3` / `Fabric 26.3` …），每组一行、点开看具体版本。
 *
 * 这里落地成：**按 MC 版本分组**（组标题 = MC 版本 + 组内条数），组内仍是原来那一行一条
 * （版本号 + 加载器 + 日期 + 大小 + 安装按钮），第一组默认展开。
 *
 * ★ 为什么"按 MC 版本"而不是"按加载器"：用户的问法是"给版本分类"，
 *   而他真正要解决的问题是"一条条平铺、看不出版本谱系" ——
 *   MC 版本是那个谱系的主轴（同一版本的 Fabric/NeoForge 是同一档）。
 */
import { useMemo, useState } from 'react';

/** 一个资源版本里，我们分组要用的那点信息 */
export interface VersionLike {
  id: string;
  /** MC 版本列表（Modrinth 给的是数组，可能多个） */
  game_versions: string[];
}

/**
 * 分组键：**归到"大版本"那一档**。
 *
 * ★★ 2026-09-23 真机打脸第一版：我原来直接拿"支持的最新 MC 版本"当键，
 *   结果一个热门 Mod 分出了 **362 组**（`26.3-snapshot-10`、`1.21.11-pre3`、
 *   `23w51b` 各成一组）—— **比平铺还难用**。
 *   用户要的是"按**大版本**分组"（他给的图二里那排 chips 是
 *   `26.3 26.2 26.1 1.21 1.20 …`），所以这里要**归一化**：
 *
 *   · `26.3-pre-3` / `26.3-rc-1` / `26.3-snapshot-10` → **`26.3`**（新版版本号，主版本就是它）
 *   · `1.21.11` / `1.21.11-pre3` / `1.21.9-rc1`     → **`1.21`**（经典版本号，取前两段）
 *   · `1.8.9` / `1.8`                                → **`1.8`**
 *   · `23w51b` / `24w14a`（周快照，不属于任何正式版）→ **`快照`**（单列一组）
 *   · `26.1.2`                                       → **`26.1`**？不 —— 见下面那条判断
 */
export function groupKeyOf(v: VersionLike, compare: (a: string, b: string) => number): string {
  const list = (v.game_versions ?? []).filter(Boolean);
  if (list.length === 0) return '通用';
  /*
   * ★ 兜底 `?? '通用'`：TS 的 noUncheckedIndexedAccess 下 `[0]` 是 `string | undefined`。
   *   虽然上面刚判过非空，但"靠人记住这层不变量"不如让类型系统满意。
   */
  const newest = [...list].sort(compare).reverse()[0] ?? '通用';
  return majorLine(newest);
}

/**
 * 一个 MC 版本号 → 它的"大版本"档位。
 *
 * ★ 为什么两条规则不一样（26.x 取两段、1.x 取两段却含义不同）：
 *   Mojang 从 2026 起换成了「年份.第几次发布」的版本号（`26.1`、`26.3`），
 *   而经典版本号是「1.大版本.小版本」（`1.21.11`）。
 *   两者**都取前两段**就正好是各自的"线"：
 *     `26.3-snapshot-10` → `26.3` ✓（同一条线）
 *     `1.21.11-pre3`     → `1.21` ✓（同一条线）
 *   所以这里只做"去后缀 + 取前两段"，不需要一张映射表。
 */
export function majorLine(version: string): string {
  const v = version.trim();
  if (!v) return '通用';
  /*
   * 周快照（`23w51b`、`24w14a`、`25w14craftmine`）：它们**不属于任何正式版**，
   * 单独归一组 —— 混进 `1.20` 是错的（它们比 1.20 早或晚都可能）。
   */
  if (/^\d{2}w\d{2}/i.test(v)) return '快照';
  // 去掉 `-pre` / `-rc` / `-snapshot` 这些后缀
  const base = v.split('-')[0] ?? v;
  const parts = base.split('.');
  if (parts.length <= 2) return base;
  return `${parts[0]}.${parts[1]}`;
}

/** 把版本按 MC 版本分组，组之间按版本从新到旧 */
export function groupVersions<T extends VersionLike>(
  versions: T[],
  compare: (a: string, b: string) => number,
): Array<{ key: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const v of versions) {
    const k = groupKeyOf(v, compare);
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => {
      if (a.key === '通用') return 1;
      if (b.key === '通用') return -1;
      return compare(b.key, a.key);
    });
}

/**
 * 分组标题 + 折叠状态。
 *
 * ★ 默认展开**第一组**：全折叠的话用户第一眼看到的是"什么都没有"，
 *   那和他抱怨的"看不出版本"是同一个毛病。
 */
export function useVersionGroups<T extends VersionLike>(
  versions: T[],
  compare: (a: string, b: string) => number,
  /**
   * ★★ 2026-09-23：要**强制展开**的那个分组（推荐版本所在的组）。
   *
   *   为什么需要它：列表默认只展开第一组，其余折叠 —— 而"推荐"那一个
   *   很可能不在第一组里，于是**用户根本看不到推荐标记**
   *   （真机实测就是这样：分类对了、推荐数 0）。
   *   ★ 推荐的东西必须**看得见**，否则等于没推。
   */
  forceOpenKey?: string | null,
) {
  const groups = useMemo(() => groupVersions(versions, compare), [versions, compare]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [only, setOnly] = useState<string | null>(null);

  const firstKey = groups[0]?.key;
  const isOpen = (key: string) => {
    /*
     * ★★ 2026-09-23 用户（截图）：「**有推荐版本的那一栏没办法收起**」——
     *   这里原来写的是 `collapsed[key] !== false`：用户点一下收起会写进 `true`，
     *   而 `true !== false` 仍然成立 → **照样展开**，于是"点了没反应"。
     *   正确语义与下面第一组那条**完全一样**：**只有明确收起过（=== true）才收起**；
     *   没点过（undefined）时靠强制展开把推荐露出来。
     */
    if (forceOpenKey && key === forceOpenKey) return collapsed[key] !== true;
    if (key === firstKey) return collapsed[key] !== true;
    return collapsed[key] === false;
  };
  /*
   * ★★ 2026-09-23 真机打脸第二版：原来写的是 `!isOpen(key)` —— **反了**。
   *   第一组默认是"开"（`collapsed[key] !== true`），要收起它必须写 `collapsed[key] = true`，
   *   而 `!isOpen` 恰好给的是 `false`，于是**第一组永远折不起来**
   *   （真机断言 `aria-expanded` 前后都是 true，就是这么发现的）。
   *   正确语义：**存的这个标志就是"收起"**，所以直接写 `isOpen(key)`。
   */
  const toggle = (key: string) => setCollapsed((p) => ({ ...p, [key]: isOpen(key) }));
  const shown = only ? groups.filter((g) => g.key === only) : groups;

  return { groups, shown, only, setOnly, isOpen, toggle };
}
