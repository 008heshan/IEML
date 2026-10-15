/**
 * 版本选择器的"平铺几张"规则（对应 `LaunchPage` 的 A+ 形态：卡片排 + 「全部版本」入口）
 * ----------------------------------------------------------------------------
 * 用户 2026-10-16：「我想替换掉主页的下拉选单，请给我一个合适的整改方式」，
 * 看过草案后选 **A+**：一排版本卡片；版本很多时不要把它们全铺在主页上，
 * 而是平铺前几张 + 一张「全部版本…」入口（点开是可搜索的弹层）。
 *
 * ★ 为什么把它单独放这里（而不是写在组件里的一行 slice）：
 *   这是一条**规则**（"超过几个才折叠、折叠时留几张"），而不是渲染细节。
 *   规则留在 domain 里，`tests/launch-picker.test.mjs` 用 `node --test` 就能钉住；
 *   写在组件里就只能靠"点开看看"来验证 —— 这一页的版本数量取决于用户机器，
 *   恰好是最难手动复现的那类分支（本机只有 4 个版本，永远走不到折叠那一支）。
 */

/** 平铺上限：不超过它时全部平铺，超过就折叠 */
export const PICKER_MAX = 6;

export interface PickerPlan {
  /** 平铺几张版本卡 */
  shown: number;
  /** 要不要出现那张「全部版本…」入口卡 */
  hasMore: boolean;
}

/**
 * 给定版本总数，算出"平铺几张、要不要入口"。
 *
 * ★ 折叠时留 `max - 1` 张：**入口卡自己占一格**。留满 `max` 张再加一张入口，
 *   就变成 7 张卡铺在主页上 —— 那正是折叠想避免的事。
 */
export function pickerPlan(total: number, max: number = PICKER_MAX): PickerPlan {
  // 负数/脏输入按 0 处理：这一页是启动前的主界面，宁可少画一张也不许崩
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (n <= max) return { shown: n, hasMore: false };
  return { shown: max - 1, hasMore: true };
}
