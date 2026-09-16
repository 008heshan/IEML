import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './state/AppContext';
import { App } from './app/AppShell';
import './styles/tokens.css';
import './styles/app.css';
import './styles/pages.css';

/*
 * ★★ 低性能损耗模式：**在首屏渲染之前**就把类挂上（用户 2026-09-16）。
 *   放到 React 里再挂会有"先磨砂闪一下再变平"的一帧 —— 这个开关就是给弱机用的，
 *   多闪一帧反而更糟。存 localStorage（不是 prefs.json）是有意的：
 *   它是**本机性能偏好**，换机器本来就该重新选（和"主题/语言"那种跟着人走的不同）。
 */
if (localStorage.getItem('ieml.lowPerf') === '1') {
  document.documentElement.classList.add('low-perf');
}
const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

/*
 * ★★ 关掉浏览器的右键菜单（用户 2026-09-15："启动器不应能被右键呼出（图四）的栏"）。
 *
 *   图四那张是 **WebView2 自带的页面右键菜单**（返回 / 刷新 / 另存为 / 打印 /
 *   更多工具）—— 那是"网页"的菜单，出现在一个桌面启动器上非常突兀，
 *   而且"刷新"和"打印"在这个界面里没有任何意义（刷新还会把界面状态清掉）。
 *
 *   ★ 但**输入框里要留着**：系统菜单里的"粘贴/全选"是输入框唯一的鼠标入口，
 *     一刀切会把粘贴功能一起干掉。所以：
 *       · 可编辑元素（input / textarea / contenteditable）→ 放行；
 *       · 选中了文字（日志、崩溃报告那种）→ 放行（有人习惯用它复制）；
 *       · 其余 → 拦掉。
 *   ★ 顺带把 F5 / Ctrl+R 的"刷新"也拦掉：意外刷新会让前端状态全部重建
 *     （运行中的游戏仍然后端在管，但界面会闪一下，用户以为崩了）。
 */
document.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement | null;
  const editable = !!el?.closest('input, textarea, [contenteditable="true"]');
  const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0;
  if (!editable && !hasSelection) e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const reload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && key === 'r');
  if (reload) e.preventDefault();
});

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
