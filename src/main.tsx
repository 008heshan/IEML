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
 * ★★ 2026-10-09（用户：「**进入启动器的速度有点慢**」）：首屏之前那几件同步的活
 *   要**看得见**，否则"慢"只能靠感觉猜。
 *
 *   这里只做一件事：给三个时刻打上记号，挂在 `window.__boot` 上。
 *   · `ambient`  —— 环境光几何注入完
 *   · `vfx`      —— 视效档位与玻璃背景起来（这一件最可疑：它要探 WebGL2、编译着色器）
 *   · `commit`   —— React 第一次真正提交（下一帧量）
 *   · `shell`    —— 侧栏渲染出来（由 `AppShell` 在首屏 effect 里回填）
 *
 *   ★ 为什么不用 `console.log`：WebView2 里的 console **不进 stderr** ——
 *     启动器的 stderr 只有 Rust 那边的 `say!`。挂在 window 上，
 *     真机探针（`live-startup-timing.mjs`，在本地开发记录里）能直接读。
 *   ★ 成本是三次 `performance.now()`，一直开着也没关系。
 */
declare global {
  interface Window {
    __boot?: {
      ambient: number;
      vfx: number;
      commit: number | null;
      shell: number | null;
      dcl: number;
      /** 启动那批 invoke 各自**落定**的时刻（相对批次开始，毫秒） */
      invokes: Record<string, number>;
    };
  }
}
const bootAt = performance.now();
const bootMs = () => Math.round(performance.now() - bootAt);

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
const tAmbient = bootMs();
applyVfx(readVfx().level);
const tVfx = bootMs();
window.__boot = {
  ambient: tAmbient,
  vfx: tVfx,
  commit: null,
  shell: null,
  dcl: Math.round(performance.now()),
  invokes: {},
};

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

/* 首屏"提交"这一笔要在**下一帧**量：`render()` 只是排上队，这一帧还没画出来 */
requestAnimationFrame(() => {
  if (window.__boot) window.__boot.commit = bootMs();
});

/*
 * 移除启动画面。
 *
 * ★★ 2026-09-30（用户）：「**载入加载器时的加载，先全白一下然后再进 logo**」。
 *
 *   白色那一下的根因在窗口层（`tauri.conf.json` 没设 `backgroundColor`，
 *   原生窗口先按系统默认白画出来）+ `index.html` 里主题色定得太晚 —— 两处都已修。
 *
 *   这里修的是**最后一下**：原来是 `splash.remove()`，画面**当场消失** ——
 *   在"深色启动画面"与"应用界面"之间仍是一跳。现在让它**淡出**再移除，
 *   与 `index.html` 里那条 `transition: opacity` 配合。
 *
 *   ★ 淡出期间 `pointer-events: none`：那一层盖在整屏上，
 *     180 毫秒里如果还吃鼠标事件，用户点到的会是启动画面而不是应用。
 */
const splash = document.getElementById('splash');
if (splash) {
  splash.style.pointerEvents = 'none';
  splash.style.opacity = '0';
  window.setTimeout(() => splash.remove(), 180);
}
