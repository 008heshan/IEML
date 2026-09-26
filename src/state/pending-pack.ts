/**
 * 「刚拖进来的那个整合包」——**跨页面交接**用的一格内存。
 * ------------------------------------------------------------------
 * 为什么需要它：拖放事件在 `AppShell`（常驻）收到，而真正干活的安装逻辑在
 * `DownloadPage`。两个页面之间只隔一次 `go('download')`，但那一下**要等 React
 * 把下载页挂上去**——`DownloadPage` 的监听器是在它挂载之后才注册的。
 *
 * 三条路都试过，只有这一条是确定的：
 *   · 立刻派发自定义事件 ⇒ 页面还没挂载，事件**丢了**（表现为"拖进去没反应"）；
 *   · 延时派发（`setTimeout` 120ms 那种）⇒ 靠猜时间，机器慢一点就丢；
 *   · 反复派发 ⇒ 更糟：安装逻辑**不是幂等的**，会装两遍。
 * 所以：AppShell 把路径**存下来**，DownloadPage 挂载时**取走**（取走即清空）。
 *
 * ★ 取走即清空（`take` 而不是 `get`）：同一个包不该被装第二次，
 *   而"页面重挂载时又装一遍"正是这种交接最容易出的 bug。
 */
let pending: { path: string; name?: string } | null = null;

export function setPendingPack(path: string, name?: string): void {
  pending = { path, name };
}

/** 取走并清空（没有则返回 null） */
export function takePendingPack(): { path: string; name?: string } | null {
  const p = pending;
  pending = null;
  return p;
}
