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

/**
 * 同一条判据，两种用法（2026-10-16）：
 *
 *   · **横向**（默认）：下载页/资源页那排页签 —— `[role=tab][aria-selected=true]`，
 *     指示条是一条下划线（`translateX` + `width`）。
 *   · **纵向**：左侧图标轨的导航 —— 用 `[aria-current="page"]` 找人，
 *     指示条是左边缘一根小竖条（`translateY` + `height`）。
 *
 * ★ 为什么做成一个 hook 的两个方向，而不是各写一份：这套"量出选中项的位置、
 *   交给一个绝对定位的元素滑过去"的机制只该有一份 —— 两份必然会在
 *   "什么时候重量"（首帧、切换、ResizeObserver）上漂移。
 */
export interface TabIndicatorOptions {
  /** 谁是"选中项"。默认页签那套 */
  selector?: string;
  /** 指示条的方向：`x` = 下划线，`y` = 左侧竖条 */
  axis?: 'x' | 'y';
}

export function useTabIndicator(
  activeKey: string,
  opts: TabIndicatorOptions = {},
): TabIndicator {
  const selector = opts.selector ?? '[role="tab"][aria-selected="true"]';
  const axis = opts.axis ?? 'x';
  const listRef = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<TabIndicator['style']>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(selector);
    if (!active) {
      /*
       * ★ 这一条容器里没有选中项 ⇒ **不渲染指示条**（`null`）。
       *   左侧轨就是这么用的：主导航与"新闻/更新日志/关于"是两条容器，
       *   谁的里面没有当前页，谁就不画 —— 不需要外面再判一次。
       */
      setStyle(null);
      return;
    }
    setStyle(
      axis === 'y'
        ? { transform: `translateY(${active.offsetTop}px)`, width: active.offsetHeight }
        : { transform: `translateX(${active.offsetLeft}px)`, width: active.offsetWidth },
    );
  }, [selector, axis]);

  /* ① 换页签（以及首次挂载）时量一次 */
  useLayoutEffect(measure, [measure, activeKey]);

  /* ② 尺寸变了也要量：整条栏 + 每个页签都盯着 */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const tab of list.querySelectorAll(selector)) ro.observe(tab);
    return () => ro.disconnect();
  }, [measure, selector, activeKey]);

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
