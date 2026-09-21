/**
 * 动效档位（三档）—— **唯一的判据、唯一的施加处**。
 * ------------------------------------------------------------------
 * 用户 2026-09-20：「我想要更好的更高级的动效，把动效选项设为三档：
 * 减少动效、适中动效、灵韵动效」。
 *
 * ## 三档各自是什么
 *
 * | 档位 | 值 | 含义 |
 * |---|---|---|
 * | 减少动效 | `lite` | **一个动画都不放**（无障碍那一档，和系统"减少动态效果"同一个意思） |
 * | 适中动效 | `mid` | 默认。页面入场 + 模态/提示条入场 + 状态过渡 —— 快、轻、不抢戏 |
 * | 灵韵动效 | `aura` | 在适中之上再加：背景光晕缓慢漂移、卡片错峰入场、悬停辉光、启动按钮呼吸 |
 *
 * ## 三条硬规矩
 *
 * ① **只在这里定义合法值**。前端任何地方要读写档位都走这个模块 ——
 *    `main.tsx`（首屏之前）、设置页（改档）、以及将来别的地方。
 *    值写成别的东西（老版本、手改 localStorage、坏数据）一律落回 `mid`：
 *    **不猜、也不崩**。
 *
 * ② **系统优先**。`prefers-reduced-motion: reduce` 是用户在操作系统里
 *    明确表达的"我晕动效"，它**盖过**我们这三档（[`systemWantsReduced`]）。
 *    设置页据此把控件禁掉并说明原因 —— 而不是让用户改了没反应。
 *
 * ③ **本机偏好，存 localStorage**（不是 `prefs.json`）。理由与
 *    `ieml.lowPerf` 相同：同一份配置在弱机上想要"减少"、在台机上想要"灵韵"。
 *    （历史：这一档原来是 `prefs.json` 里的布尔 `reducedMotion`，
 *    而且**启动时从来没被应用过** —— 见 `AppContext` 里的迁移代码。）
 */

/** 三档（顺序就是界面上从左到右的顺序：越来越"多"） */
export type MotionLevel = 'lite' | 'mid' | 'aura';

export const MOTION_LEVELS: readonly MotionLevel[] = ['lite', 'mid', 'aura'] as const;

/** localStorage 的键 */
export const MOTION_KEY = 'ieml.motion';

/** 界面上的名字（用户给的三个词，原样用） */
export const MOTION_LABEL: Record<MotionLevel, string> = {
  lite: '减少动效',
  mid: '适中动效',
  aura: '灵韵动效',
};

/** 每个档位**具体多了什么** —— 写在设置页那一行下面，别让用户猜 */
export const MOTION_HINT: Record<MotionLevel, string> = {
  lite: '不放任何动画：状态直接切换，不做过渡',
  mid: '页面进出、弹窗、提示条有轻过渡；快、不抢戏',
  aura: '在「适中」之上再加：背景光晕缓慢漂移、卡片错峰入场、悬停辉光、启动按钮呼吸',
};

function isLevel(v: string | null): v is MotionLevel {
  return v === 'lite' || v === 'mid' || v === 'aura';
}

/** 读本机选择的档位（没选过 / 值不合法 → `mid`） */
export function readMotion(): MotionLevel {
  const v = localStorage.getItem(MOTION_KEY);
  return isLevel(v) ? v : 'mid';
}

/**
 * 把档位挂到 `<html data-motion="…">` —— CSS 全靠这个属性分档。
 *
 * ★ 必须在**首屏之前**调一次（见 `main.tsx`）：灵韵那一档有入场动画，
 *   等 React 挂载后再切会让用户先看一遍满血动效再被降级。
 */
export function applyMotion(level: MotionLevel): void {
  document.documentElement.dataset.motion = level;
}

/** 写入 + 立即生效 */
export function setMotion(level: MotionLevel): void {
  localStorage.setItem(MOTION_KEY, level);
  applyMotion(level);
}

/**
 * 系统是不是要求"减少动态效果"。
 *
 * ★ 这个值**不缓存**：用户在 Windows 设置里改完，我们要能读到新的
 *   （设置页每次渲染读一次 + 监听变化）。
 */
export function systemWantsReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
