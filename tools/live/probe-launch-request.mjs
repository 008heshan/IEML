/**
 * 真机确认：「启动」按钮到底有没有人接住它派发的事件
 * ------------------------------------------------------------------
 * 三个入口（实例侧栏「启动这个版本」/ 版本列表行的「启动」/ 概览的「启动」）
 * 都是 `window.dispatchEvent(new CustomEvent('ieml:launch-request'))`，
 * 而**监听方只有一个**：LaunchPage 的 effect —— 它只在 `state.page === 'launch'` 时挂载。
 *
 * 判据（零副作用，不会真的启动游戏）：
 *   · 先问浏览器"当前页面上 `ieml:launch-request` 的监听器有几个"（CDP 的
 *     `getEventListeners`，需要 includeCommandLineAPI）；
 *   · 再**手动派发**一次这个事件，等 3 秒，看有没有任何反应（跳页 / 提示 / 进程）。
 *   · 对照：切到「启动」页，同一个问题应该是"有监听器"。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9951;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-launch-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(400);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    includeCommandLineAPI: true,
  });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

const listeners = () => ev(`(() => {
  try {
    const all = getEventListeners(window);
    const l = all['ieml:launch-request'];
    return l ? l.length : 0;
  } catch (e) { return 'ERR:' + e.message; }
})()`);
const snapshot = () => ev(`(() => ({
  'page': (document.querySelector('.page-title')?.textContent || '').trim(),
  'toasts': [...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 50)),
  'running': /停止游戏|正在运行/.test(document.body.innerText || ''),
}))()`);

for (const nav of ['版本列表', '启动']) {
  await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('${nav}'))?.click()`);
  await sleep(2200);
  console.log(`\n=== 在「${nav}」页 ===`);
  console.log('  ieml:launch-request 的监听器数量 = ' + JSON.stringify(await listeners()));
  console.log('  当前快照 = ' + JSON.stringify(await snapshot()));
}

/* 回到版本列表，手动派发那个事件 —— 看有没有任何反应 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
const before = await snapshot();
await ev(`window.dispatchEvent(new CustomEvent('ieml:launch-request', { detail: (window.__IEML_LAST__ && '') || document.querySelector('.ver-item') ? undefined : undefined }))`);
await sleep(3000);
const after = await snapshot();
console.log('\n=== 在版本列表页手动派发 ieml:launch-request 之后 ===');
console.log('  之前：' + JSON.stringify(before));
console.log('  之后：' + JSON.stringify(after));
console.log('  有没有任何反应：' + (JSON.stringify(before) !== JSON.stringify(after) ? '有' : '★ 完全没有'));

/* 行菜单里到底有没有「启动」那一项（用户在版本列表上看到的那条路） */
const menu = await ev(`(() => {
  const btn = document.querySelector('.ver-item .ver-actions button');
  btn?.click();
  return !!btn;
})()`);
await sleep(800);
const items = await ev(`[...document.querySelectorAll('.menu button, .ver-menu button, [role="menu"] button')].map((b) => (b.textContent || '').trim())`);
console.log('\n=== 版本列表行的 ⋯ 菜单项 ===');
console.log('  打开成功=' + JSON.stringify(menu) + '  菜单项=' + JSON.stringify(items));

/* 进程侧：确认没有 java 被拉起来（这一步只是兜底，事件没人接就不会有进程） */
const procs = await ps(`Get-Process java,javaw -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`);
console.log('  当前 java 进程数 = ' + JSON.stringify(procs));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
