import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './state/AppContext';
import { App } from './app/AppShell';
import { ConfirmProvider } from './ui/confirm';
import { applyMotion, readMotion } from './ui/motion';
import { applyVfx, readVfx } from './ui/vfx';
import { installAmbientCss } from './ui/ambient';
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

/*
 * ★★ 动效档位（用户 2026-09-20 要求三档：减少 / 适中 / 灵韵）。
 *
 *   与 lowPerf 一样**必须在首屏之前**挂上，而且理由更硬：
 *   灵韵那一档有入场动画 —— 等 React 挂载后再切档，用户会先看一遍"满血动效"
 *   再被降级（甚至看到两次入场）。
 *
 *   判据与合法性**只有一份**（`ui/motion.ts`）：这里只负责"启动时先执行一次"。
 */
applyMotion(readMotion());

/*
 * ★★ 视效档位（用户 2026-09-21：液态玻璃 + 「弱化 / 适中 / 灵动」三档）。
 *
 *   同一条理由：**首屏之前**就得定下来。灵动档的玻璃会装 SVG 折射滤镜、
 *   起 WebGL2 背景 —— 等 React 挂载后再切，用户会先看到一版"没有折射的玻璃"
 *   再跳成有折射的，比一直用适中更难受。
 *
 *   `readVfx()` 返回的是**已经过能力校正**的档位：机器不支持 WebGL2 / 是老系统时，
 *   即便用户存的是灵动，这里读出来也是适中（判据在 `ui/vfx.ts`，用的是真机探针
 *   验过的那套逻辑）。
 *
 *   背景光斑的几何也从这里注入（`--ambient-image`）：它是"一份数据三处消费"里的
 *   那一份，见 `ui/ambient.ts` 的头注释。
 */
installAmbientCss();
applyVfx(readVfx().level);

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
      {/*
        ★★ 确认弹窗的宿主（见 `ui/confirm.tsx` 的头注释）：
          `window.confirm` 在这个壳里是坏的（Tauri 把它换成了 async 包装，
          而权限又没授），所以删除类确认全部走应用自己的弹窗。
      */}
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </AppProvider>
  </StrictMode>,
);

// 移除启动画面
const splash = document.getElementById('splash');
splash?.remove();
