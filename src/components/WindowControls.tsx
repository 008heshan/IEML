/**
 * 窗口按钮（最小化 / 最大化-还原 / 关闭）
 * ------------------------------------------------------------------
 * ## 为什么需要它
 *
 * `tauri.conf.json` 里 `decorations: false` —— 把 Windows 那条原生标题栏关掉了
 * （用户："这个白色的条，并进软件里，这个额外的在外面，很丑"）。
 * 关掉之后，最小化 / 最大化 / 关闭这三个按钮就**没有人画了**，得我们自己画。
 *
 * ## 三条纪律
 *
 *   ① **不在浏览器里渲染**：演示模式没有窗口可管。摆三个点了没反应的按钮
 *      比不摆更糟（这正是这个项目反复删掉的那类假东西）。
 *   ② **图标随状态变**：最大化之后显示"还原"，否则用户不知道该点哪个。
 *      状态来源是窗口自己的 `isMaximized()` + `onResized` 事件，**不猜**。
 *   ③ **不做双击最大化**：那件事交给 `data-tauri-drag-region`（Windows 上
 *      Tauri 发的是 `WM_NCLBUTTONDOWN + HTCAPTION`，原生行为白送）。
 *      自己再实现一遍 = 双击触发两次 = 最大化后立刻还原。
 */
import { useEffect, useState } from 'react';
import { getRealApi } from '../bridge';

/** 窗口按钮的图标：1px 线条，和系统那三个的观感对齐（不是我们的通用图标集） */
const IconMin = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6h8" />
  </svg>
);
const IconMax = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
  </svg>
);
const IconRestore = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="4" width="5.5" height="5.5" rx="1" />
    <path d="M4.5 4V3a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H8.5" />
  </svg>
);
const IconClose = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="m3 3 6 6M9 3l-6 6" />
  </svg>
);

export function WindowControls() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = await getRealApi();
      if (!alive) return;
      setIsDesktop(!!api);
      if (!api) return; // 浏览器演示：没有窗口，也就不渲染这三个按钮
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        setMaximized(await w.isMaximized());
        const un = await w.onResized(async () => {
          try {
            setMaximized(await w.isMaximized());
          } catch {
            /* 窗口正在关闭时会拿不到，忽略 */
          }
        });
        return () => void un();
      } catch {
        /* 拿不到窗口对象就不显示按钮 —— 不摆一个点了没反应的控件 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!isDesktop) return null;

  /**
   * 调窗口 API，**失败要说话**。
   *
   * ★★ 这一条是用户报上来的 bug 换来的（"右上角的放大、缩小功能没做，
   *   最小化和关闭是正常的"）：`toggleMaximize()` 实际调的是
   *   `plugin:window|toggle_maximize`，而 capabilities 里当时没有
   *   `core:window:allow-toggle-maximize` —— 权限拒绝，**而我把 Promise
   *   `void` 掉了**，于是按钮点下去什么都不发生，也没人知道为什么。
   *   这是这个项目里最不该出现的一类：**静默失败**。
   */
  async function withWindow(
    fn: (w: Awaited<ReturnType<typeof import('@tauri-apps/api/window')['getCurrentWindow']>>) => Promise<void>,
  ) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await fn(getCurrentWindow());
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('ieml:toast', {
          detail: {
            kind: 'err',
            title: '窗口操作失败',
            desc: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
  }

  return (
    <div className="winctl" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="winctl-btn"
        aria-label="最小化"
        title="最小化"
        onClick={() => void withWindow((w) => w.minimize())}
      >
        <IconMin />
      </button>
      <button
        type="button"
        className="winctl-btn"
        aria-label={maximized ? '向下还原' : '最大化'}
        title={maximized ? '向下还原' : '最大化'}
        onClick={() =>
          void withWindow(async (w) => {
            await w.toggleMaximize();
            setMaximized(await w.isMaximized());
          })
        }
      >
        {maximized ? <IconRestore /> : <IconMax />}
      </button>
      <button
        type="button"
        className="winctl-btn danger"
        aria-label="关闭"
        title="关闭"
        onClick={() => void withWindow((w) => w.close())}
      >
        <IconClose />
      </button>
    </div>
  );
}
