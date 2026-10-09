/**
 * 「返回」这件事的**唯一登记处**（2026-10-09）。
 * ------------------------------------------------------------------
 * ★★★★ 用户原话：「进行 UI 优化，**所有页面的返回按钮做一个固定位置**，
 *   不然很麻烦」。
 *
 * ## 为什么要一个登记处
 *
 *   "有地方可回"是**页面自己的状态**，而按钮必须待在**同一个地方**（顶栏）。
 *   在这之前，两件事是绑在一起的：
 *     页面自己在自己的页头里画一个返回按钮 ⇒ 位置随页面走
 *     （侧栏 / 页头左上 / 内容区 / 页头里再一个，四处四个高度）。
 *
 *   ⇒ 拆开：**页面只登记"我能回哪儿"**，按钮由 `AppShell` 统一渲染在顶栏。
 *     位置这件事从此只有一份实现，页面想画也画不出第二个来。
 *
 * ## 用法（页面侧）
 *
 * ```tsx
 *   useBackTarget(step === 'loader' ? { to: '版本清单', onClick: () => setStep('version') } : null);
 * ```
 *   · 传 `null` 表示"这一屏没有可回的地方" ⇒ 顶栏那个按钮收起来；
 *   · 卸载时**自动撤销**（effect 的 cleanup）—— 切走之后不会留一个
 *     点了会去别的页面的幽灵按钮。
 *
 * ★ 为什么不用 `useState`/Context 装它：这里要装的是**一个函数 + 一句话**，
 *   放进 reducer 的 state 就没法序列化、也没法在 store 的测试里比对
 *   （这个仓库的 store 是纯数据）。用模块级的登记 + `useSyncExternalStore`
 *   订阅，读写都是显式的，而且**任何组件都能挂**。
 * ★ 只留**一个**目标：同一时刻屏幕上只有一个"上一页"（第二个登记会覆盖第一个，
 *   见 `claim()`）。要的是"固定位置"，那就不能有第二个来源。
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface BackTarget {
  /** 回到哪儿（读屏用；界面上只有一个箭头） */
  to: string;
  onClick: () => void;
}

let current: BackTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 登记一个返回目标（页面用 `useBackTarget`，一般不必直接调）。 */
export function setBackTarget(target: BackTarget | null): void {
  current = target;
  emit();
}

/**
 * 读当前登记的返回目标（顶栏用）。
 *
 * ★ `getSnapshot` 必须返回**同一个引用**直到真的变了，否则 React 会
 *   "getSnapshot should be cached" 死循环 —— 所以这里存的是 `current`
 *   这个变量本身，而不是每次现造一个对象。
 */
export function useBackTargetValue(): BackTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/**
 * 页面侧：**这一屏能不能返回**。
 *
 * ★ 依赖里只有 `active` 与 `to`：`onClick` 每次渲染都是新函数，写进依赖就会
 *   "每次渲染都重新登记一遍"（effect 抖动，顶栏跟着重渲染）。所以动作放进 ref，
 *   登记的那一份是个稳定的壳子。
 */
export function useBackTarget(target: BackTarget | null): void {
  const active = target !== null;
  const to = target?.to ?? '';
  const fnRef = useRef<(() => void) | null>(null);
  fnRef.current = target?.onClick ?? null;

  useEffect(() => {
    if (!active) return;
    setBackTarget({
      to,
      onClick: () => fnRef.current?.(),
    });
    return () => setBackTarget(null);
  }, [active, to]);
}
