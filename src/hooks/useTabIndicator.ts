/**
 * 页签下面那条**会滑动的指示条**
 * ------------------------------------------------------------------
 * 用户 2026-10-16：「做一个滑动 tab 的效果，切换 tab 的时候下面的指示条同步滑动，
 * 明确栏目的变化」。
 *
 * ## 为什么必须真的量一次（纯 CSS 做不到）
 *
 *   那一排页签**宽度不一样**：「安装游戏」比「Mod」宽一倍多，所以"划过去"不是
 *   等距平移 —— 指示条既要知道**移到哪**，也要知道**变多宽**。
 *   CSS 里没有任何办法表达"选中谁就移到谁那儿再变成谁那么宽"
 *   （`:has()` 只能选到元素，不能跨兄弟做动画）。所以：
 *
 *     ① `useLayoutEffect` 里量当前选中页签的 `offsetLeft` / `offsetWidth` ——
 *        **画之前**量，否则会看到它先出现在旧位置、下一帧才跳过去；
 *     ② 指示条是页签栏里**唯一**那个绝对定位元素，靠 `transform` + `width` 滑过去；
 *     ③ `ResizeObserver` 同时盯**整条栏**与**每个页签** —— 窗口变窄、字号变化、
 *        页签文字变了（`.cnt` 计数从 3 变 12）都得重新量，否则指示条会短一截。
 *
 * ## 三个刻意的取舍
 *
 *   ★ 量到之前**返回 `null`**（调用方据此不渲染指示条）：新挂上去的元素没有"上一个
 *     计算样式"，于是不会从最左边滑过来 —— 页面刚打开时它已经在正确位置上。
 *   ★ 指示条画在**页签栏内部**（不 portal 到 body）：窄窗口里这条栏会横向滚动，
 *     写在里面它就跟内容一起滚，不必自己监听 scroll。
 *   ★ 只认 `[role="tab"][aria-selected="true"]`：选中状态在 DOM 里只有一份
 *     （`aria-selected`），不去猜类名，也不在 React 里再存一份"当前是第几个"。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface TabIndicator {
  /** 挂到那条 `role="tablist"` 的容器上（`ref` 回调，挂上就量一次） */
  ref: (node: HTMLElement | null) => void;
  /** 挂到 `<span className="tab-ind">` 上；**null = 还没量到**（此时别渲染它） */
  style: { transform: string; width: number } | null;
}

export function useTabIndicator(activeKey: string): TabIndicator {
  const listRef = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<TabIndicator['style']>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!active) {
      setStyle(null);
      return;
    }
    setStyle({
      transform: `translateX(${active.offsetLeft}px)`,
      width: active.offsetWidth,
    });
  }, []);

  /* ① 换页签（以及首次挂载）时量一次 */
  useLayoutEffect(measure, [measure, activeKey]);

  /* ② 尺寸变了也要量：整条栏 + 每个页签都盯着 */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const tab of list.querySelectorAll('[role="tab"]')) ro.observe(tab);
    return () => ro.disconnect();
  }, [measure, activeKey]);

  /* ③ 回调 ref：节点挂上来的那一刻（还在 commit 阶段）就量 */
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      listRef.current = node;
      if (node) measure();
    },
    [measure],
  );

  return { ref: setRef, style };
}
