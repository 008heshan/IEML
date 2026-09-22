/**
 * 主题（9 套）。
 *
 * ## 为什么又有了主题选择器
 *
 * 2026-09-16 用户要求"删除白色模式"，当时的理由写得很清楚：
 * **「只有深色，没有可选项 —— 摆一个只有一个选项的选择器是假控件」**。
 * 那是对的。到了 2026-09-22 用户要了 8 套新配色（+ 原来的深色 = 9 套），
 * 可选项真的有了，选择器才有存在的意义。
 *
 * ## 分工
 *
 * * **颜色全部在 CSS**（`styles/tokens.css` 里每套一个 `:root[data-theme='…']` 块）；
 * * 这里只放**界面要用的元数据**：名字、用户给的那句话、以及色板预览的两个色。
 * * 预览色**必须与 CSS 一致** —— 由 `tests/theme-tokens.test.mjs` 逐套比对，
 *   改了 CSS 忘了改这里会红（否则选择器上显示的色和换完的样子对不上）。
 *
 * ★ 每套主题只改语义令牌，不动选择器 —— 于是玻璃、光斑、卡片、按钮全自动跟着走。
 */

export type ThemeId =
  | 'dark'
  | 'molv'
  | 'zanglan'
  | 'jiangzi'
  | 'jiuhong'
  | 'hupo'
  | 'daiqing'
  | 'ouhe'
  | 'kahe';

export interface ThemeInfo {
  id: ThemeId;
  /** 界面上的名字 */
  label: string;
  /**
   * 用户自己给的那句话，**原样留着**。
   * ★ 别改写成"沉稳大气、彰显品味"这类营销词 —— 用户写的是**用途**
   *   （"长时间看最舒服"）、**场景**（"夜间氛围强"）、**感觉**（"像旧书桌"），
   *   那才是选主题时真正要看的。
   */
  hint: string;
  /** 色板预览：底色（与 CSS 的 `--bg-base` 一致） */
  bg: string;
  /** 色板预览：主色（与 CSS 的 `--accent` 一致） */
  accent: string;
}

/**
 * 深色那套（原来就有的那一个）单独拎出来：`themeInfo()` 的兜底要用它，
 * 而 `THEMES` 是 `readonly` 数组，直接取下标在 `noUncheckedIndexedAccess` 下是 `T | undefined`。
 */
const DARK_THEME: ThemeInfo = {
  id: 'dark',
  label: '玄夜',
  hint: '默认。2026-09-15 定的"高级深色专业版"，原来的样子',
  bg: '#12151a',
  accent: '#5b8def',
};

export const THEMES: readonly ThemeInfo[] = [
  DARK_THEME,
  { id: 'molv', label: '墨绿', hint: '安静、自然、长时间看最舒服', bg: '#0e1512', accent: '#4fb08a' },
  { id: 'zanglan', label: '藏蓝', hint: '冷静、专业、默认备选', bg: '#0d1420', accent: '#4f83e8' },
  { id: 'jiangzi', label: '绛紫', hint: '神秘、高级、夜间氛围强', bg: '#140f1c', accent: '#a06be0' },
  { id: 'jiuhong', label: '酒红', hint: '沉稳、有力量、不刺眼', bg: '#170f11', accent: '#c9685f' },
  { id: 'hupo', label: '琥珀', hint: '温暖、复古、像黄昏', bg: '#171208', accent: '#d09040' },
  { id: 'daiqing', label: '黛青', hint: '清爽、冷静、像深海水', bg: '#0a1518', accent: '#3fa8b0' },
  { id: 'ouhe', label: '藕荷', hint: '柔和、温柔、不娘炮但有质感', bg: '#17121a', accent: '#b98aa8' },
  { id: 'kahe', label: '咖褐', hint: '朴素、安静、像旧书桌', bg: '#15110d', accent: '#b08050' },
] as const;

/** 主题存哪儿：**`prefs.json`**（跟其它偏好一起，由 AppContext 统一读写） */
export const DEFAULT_THEME: ThemeId = 'dark';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

export function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? DARK_THEME;
}

/**
 * 施加主题：写在 `<html data-theme>` 上。
 * ★ 只做这一件事 —— 颜色全在 CSS 里，JS 不碰任何具体色值。
 *   （这样"主题"永远不会出现"JS 里改了一半、CSS 里没跟上"的分裂。）
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', id);
}
