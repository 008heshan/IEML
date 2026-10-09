/**
 * 分页条（整合包列表 + 资源中心那四个页签**共用同一份**）
 * ------------------------------------------------------------------
 * ★★ 2026-10-08 晚（用户给了一张分页条的截图：「优化一下这里的排版，并加一个可以让
 *   玩家自己输入的地方来看玩家想要看的页」）。
 *
 * ## 为什么现在才抽成组件
 *
 *   这两处的分页条原来是**两份一模一样的 JSX**（`DownloadPage` 的整合包页签、
 *   `ResourceBrowser` 的资源列表）。用户这一轮要"加一个能输入页码的地方"，
 *   等于同一件事要改两处 —— 正是把**消费者与原语一起加**的时候
 *   （仓库的规矩：没有第二个消费者就不抽抽象）。
 *
 * ## 「排版」改了什么（对着那张截图）
 *
 *   · 原来一行三样东西同色同重（`第 1 / 935 页 · 共 18690 个`），
 *     一眼看不出"我现在在哪一页"。现在**当前页码是输入框**（最亮、可改），
 *     两侧的小字（`第` / `/ 935 页`）与总数用次要色 —— 层级出来了。
 *   · 数字统一 `tabular-nums`：翻页时那行字**不会左右抖**。
 *   · 输入框与两个按钮同高（26px）且一行居中 —— 原来那行文字与按钮的基线
 *     对不齐（按钮 26px、文字行高 19px，居中靠的是 flex 而不是基线）。
 *
 * ## 输入的三条行为（都是"玩家真会这么干"）
 *
 *   · **回车 / 失焦**生效，`Esc` 撤回当前页码（输错了不用删干净重来）；
 *   · 越界**钳到合法范围**：输 9999 就是最后一页、输 0 就是第一页 ——
 *     不弹错、也不"按了没反应"；
 *   · 只收数字。
 *   ★ 翻页期间两个按钮由调用方置灰（`canPrev` / `canNext`）—— 这里不再自己
 *     判断"在飞"，因为两处的取数路径不同（一处整屏换、一处本来也是整屏换）。
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui';

export interface PagerProps {
  /** 当前页 —— **从 1 起**，显示给玩家的就是它 */
  page: number;
  /** 一共几页（≥1） */
  pageCount: number;
  /** 一共多少个（末尾那句「共 N 个」） */
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** 跳到第 n 页（**1 起**，已经钳在合法范围内） */
  onGo: (n: number) => void;
}

export function Pager({ page, pageCount, total, canPrev, canNext, onPrev, onNext, onGo }: PagerProps) {
  const pages = Math.max(1, pageCount);
  /*
   * 输入框里的草稿：**外部**翻页（上一页/下一页、换条件把页码重置成 1）之后
   * 要跟着走，所以它由 `page` 单向同步 —— 否则玩家翻到第 3 页，
   * 框里还写着上一次手输的 7。
   */
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);

  const commit = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(page));
      return;
    }
    const want = Math.min(Math.max(n, 1), pages);
    setDraft(String(want));
    if (want !== page) onGo(want);
  };

  return (
    <div className="pager">
      <Button size="sm" variant="secondary" disabled={!canPrev} onClick={onPrev}>
        上一页
      </Button>

      {/* 「第 [1] / 935 页」：当前页码可改，两侧是次要小字 */}
      <span className="pager-go">
        <span className="pager-word">第</span>
        <input
          className="input pager-input"
          type="text"
          inputMode="numeric"
          aria-label="跳到第几页"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setDraft(String(page));
              e.currentTarget.blur();
            }
          }}
          onBlur={commit}
        />
        <span className="pager-word">/ {pages} 页</span>
      </span>

      <span className="pager-info">共 {total} 个</span>

      <Button size="sm" variant="secondary" disabled={!canNext} onClick={onNext}>
        下一页
      </Button>
    </div>
  );
}
