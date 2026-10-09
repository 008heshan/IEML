/**
 * 「指针底下是哪一行」——**滚动时也跟得住**（2026-10-09）。
 * ------------------------------------------------------------------
 * ★★★★ 用户原话（第一遍）：「鼠标指针悬浮发光提示，**滑动列表时，不会刷新**，
 *   得等停了之后才会刷新」。
 * ★★★★ 用户原话（第二遍，看到 0.19.25 之后）：「这个悬浮发光，滚动时，
 *   **不是鼠标到哪哪就发光**。而是**滑动停止后**，鼠标在哪哪里才发光」。
 *
 * ## 为什么会这样
 *
 *   行的悬浮提示一开始是用 CSS `:hover` 做的 —— 而 `:hover` 是浏览器自己维护的：
 *   滚动过程中它不重算，于是亮着的那一行停在滚动前的位置。
 *
 * ## 第一版修法（0.19.25）以及它为什么不够
 *
 *   改成"**滚动事件** + `elementFromPoint`"：滚动时自己算一次。
 *   真机量出来的形状（`tools/live/diag-hover-lag.mjs`）：
 *     · 一小步一小步地滚，24 帧里 21 帧对、3 帧慢**一帧**（可以接受）；
 *     · **但真正的滚轮/触控板不是这样工作的** —— 滚动是合成器（compositor）
 *       那边直接做的，主线程的 `scroll` 事件可能**攒着**到手势结束才发。
 *       于是"滚动中"这段我们**根本没收到通知** ⇒ 发光一路不动，停下来的那一
 *       刻才跳到正确位置 —— 用户看到的就是"滑动停止后才发光"。
 *
 * ## 现在：**用帧循环，不用事件**
 *
 *   只要有可能在滚（`wheel` / `scroll` / `touchmove` 任一出现），就起一个
 *   `requestAnimationFrame` 循环，**每帧**重新问一次"指针底下是哪一行"；
 *   循环自己盯着指针所在那个可滚动容器的 `scrollTop`，连续 8 帧（约 130ms）
 *   没变就停 —— 所以惯性滚动那一尾巴也能覆盖，而停下来之后不会空转。
 *
 *   ★ 这样就不依赖"滚动事件什么时候送到"了：合成器滚它的，我们每帧量我们的。
 *   ★ 一行亮着的判据从此只有一处（这个 `apply`），
 *     所以那些行的 CSS 里**不能再留 `:hover` 高亮**（否则滚动时两行同时亮）。
 *
 * ## 为什么挂在文档上（而不是每个列表各挂一遍）
 *
 *   滚动事件不冒泡，所以用**捕获**阶段在 `document` 上收：
 *   `.content`、列表框、任何自己滚的容器，一个监听器全覆盖。
 *   判定点在 `apply` 里用 `closest(ROW_SELECTOR)` 收口 ——
 *   所以"哪些算是行"只有这一处清单（CSS 里那份必须与它一致，见 `pages.css`）。
 */

import { useEffect } from 'react';

/**
 * 哪算"一行"。
 * ★ **必须与 `pages.css` 里那组 `[data-hover]` 选择器一致** ——
 *   那边决定"亮成什么样"，这边决定"谁能亮"。
 */
const ROW_SELECTOR = '.ver-item, .wz-item';

/** 打在行上的标记属性（CSS 用它画发光；不用 class 是为了不和状态类混在一起） */
export const HOVER_ATTR = 'data-hover';

/** 连续多少帧没在滚就停掉帧循环（8 帧 ≈ 130ms @60Hz） */
const IDLE_FRAMES = 8;
/** 一次帧循环的硬上限（≈2 秒 @60Hz）—— 防止某个容器的 scrollTop 一直在抖，循环永不退出 */
const MAX_FRAMES = 120;

export function useHoverRows(): void {
  useEffect(() => {
    /** 指针最后一次被看到的位置（视口坐标）—— 滚动时指针不动，靠它算 */
    let pointer: { x: number; y: number } | null = null;
    let marked: Element | null = null;
    let frame = 0;
    let idle = 0;
    let frames = 0;
    let lastTop: number | null = null;

    const unmark = () => {
      if (marked) {
        marked.removeAttribute(HOVER_ATTR);
        marked = null;
      }
    };

    /** 指针所在的那个"能滚的祖先"（没有就是 null）—— 用它判断还在不在滚 */
    const scrollerAt = (x: number, y: number): Element | null => {
      let el: Element | null = document.elementFromPoint(x, y);
      while (el) {
        if (el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      return null;
    };

    const apply = () => {
      if (!pointer) return;
      /*
       * ★ `elementFromPoint` 问的是"屏幕上这一点现在最上层是谁" ——
       *   所以滚动之后它自然给出**新的**那一行（每帧问一次，就每帧都对）。
       * ★ 取不到（指针在窗口外、或那一点没有元素）⇒ 什么都不亮。
       * ★ 这里只打一个属性、**不写任何坐标**：亮成什么样（行首那条 2px 竖条 +
       *   底色抬亮）全在 CSS 里。用户 2026-10-09 晚否掉了"跟着指针跑的柔光斑"
       *   （「不要光斑，做成 1 吧」），所以 `--hx` 那一整套已经删掉。
       */
      const hit = document.elementFromPoint(pointer.x, pointer.y);
      const row = hit?.closest(ROW_SELECTOR) ?? null;
      if (row === marked) return;
      unmark();
      if (row) {
        row.setAttribute(HOVER_ATTR, '');
        marked = row;
      }
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastTop = null;
    };

    const tick = () => {
      frames += 1;
      apply();
      /*
       * 还在滚吗？—— 看指针所在那个容器的 `scrollTop` 有没有变。
       * ★ 不看"有没有收到 scroll 事件"：那正是这一版要摆脱的东西。
       */
      const sc = pointer ? scrollerAt(pointer.x, pointer.y) : null;
      const top = sc ? Math.round(sc.scrollTop) : 0;
      if (top === lastTop) idle += 1;
      else {
        idle = 0;
        lastTop = top;
      }
      if (idle >= IDLE_FRAMES || frames >= MAX_FRAMES) {
        stop();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    /** 有可能在滚了 ⇒ 把帧循环叫起来（已经在跑就什么都不做） */
    const wake = () => {
      if (frame) return;
      idle = 0;
      frames = 0;
      lastTop = null;
      frame = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      /* 指针动了：当场算一次（这时没有滚动，算一次就够，不必起循环） */
      if (!frame) apply();
    };

    /*
     * 指针离开窗口（`relatedTarget === null` 的 `pointerout`）⇒ 熄灭。
     * ★ 用 `pointerout` 而不是 `pointerleave`：后者不冒泡，而且会在每次跨元素时
     *   触发；这里只关心"出窗口"这一种。
     */
    const onOut = (e: PointerEvent) => {
      if (e.relatedTarget === null) {
        pointer = null;
        stop();
        unmark();
      }
    };

    document.addEventListener('pointermove', onMove, { passive: true, capture: true });
    document.addEventListener('pointerout', onOut, { passive: true, capture: true });
    /* 三个都可能意味着"要开始滚了"：滚轮的 wheel、容器的 scroll、触摸的 touchmove */
    document.addEventListener('wheel', wake, { passive: true, capture: true });
    document.addEventListener('scroll', wake, { passive: true, capture: true });
    document.addEventListener('touchmove', wake, { passive: true, capture: true });

    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('pointerout', onOut, { capture: true });
      document.removeEventListener('wheel', wake, { capture: true });
      document.removeEventListener('scroll', wake, { capture: true });
      document.removeEventListener('touchmove', wake, { capture: true });
      stop();
      unmark();
    };
  }, []);
}
