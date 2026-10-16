/**
 * 整合包卡片上"加载器"那一格读的**唯一**判据。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户截图：「curseforge 的整合包，不显示整合包的模组
 *   加载器类型」）。
 *
 * ## 那一格的数据从哪来
 *
 *   卡片渲染在 `pages/DownloadPage.tsx` 里（`<Chip tone="neutral">{p.loader}</Chip>`），
 *   读的是 `PackCard.loader`，而它由**命中的 `categories`** 推出来。
 *   这条判据原来**内联在 `load()` 的 map 里**（一行 `.find(...)`），
 *   于是它有两个看不见的问题：
 *
 *     · 值缺失时兜底成字符串 `'—'` —— 卡片上就出现一个**假的破折号格子**，
 *       它读起来是"这个整合包的加载器是空的"，而事实是
 *       **"我们没拿到这个信息"**（仓库一贯的纪律：不许编，也不许把
 *       "不知道"说成"没有"）；
 *     · 它埋在 effect 里，没有任何测试能碰到它。
 *
 *   ⇒ 提取成纯函数（本仓库的 `src/domain/*.ts` 那一套：不 import React，
 *     `node --test tests/*.test.mjs` 能真跑）：
 *     值 → 规范串 | `null`，**由调用方决定"没有值就不渲染那一格"**。
 *
 * ## 取值（两个源同一套）
 *
 *   · Modrinth：`categories` **本来就是混装的**，加载器在里面
 *     （实测 `sodium` → `[fabric, neoforge, optimization, quilt]`）；
 *   · CurseForge：CF 自己的 `categories` 只有内容分类（`Exploration` /
 *     `Tech` / `Quests`…），加载器在 `latestFiles[].gameVersions` 里
 *     （`["1.21.1", "NeoForge"]`）—— 后端把那一半**并进了同名的
 *     `categories` 字段**（`net/curseforge.rs::categories_with_loaders`），
 *     所以这里**一份判据管两个源**。
 */

/** 整合包真的会用的那几个加载器（与 `DownloadPage.tsx` 的筛选下拉同一套取值）。 */
export const PACK_LOADER_IDS = ['fabric', 'forge', 'neoforge', 'quilt'] as const;

export type PackLoaderId = (typeof PACK_LOADER_IDS)[number];

/**
 * 从命中的 `categories` 里挑出加载器；**挑不到就是 `null`**（不是 `'—'`）。
 *
 * ★ 判据是"**在不在那四个规范串里**"，取的是**在上游数组里最先出现的**那个
 *   （与改动前那行 `.find()` 完全一致 —— 顺序由上游给，我们不改排序）：
 *   一个包同时支持多个加载器时（实测 `Immersed With Shaders` =
 *   `Fabric` + `Forge` + `NeoForge`），卡片上显示哪一个都不算错，
 *   但"**同一个输入永远得到同一个输出**"是必须的。
 *
 * ★ 比较时统一小写：CF 那边的大小写由上游决定，而**显示出去的仍是规范串**
 *   （`NeoForge` → `neoforge`）—— 界面那一格直接显示这个值，
 *   与 Modrinth 那条路**逐字节同形状**（`fabric` / `neoforge`…），
 *   不在前端另造一套措辞。
 */
export function packLoaderOf(
  categories: readonly string[] | null | undefined,
): PackLoaderId | null {
  if (!categories) return null;
  for (const raw of categories) {
    const v = String(raw).trim().toLowerCase();
    const hit = PACK_LOADER_IDS.find((id) => id === v);
    if (hit) return hit;
  }
  return null;
}
