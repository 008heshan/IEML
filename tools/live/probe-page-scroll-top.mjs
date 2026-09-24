/**
 * 真机验证：**切换页面时内容区滚回顶部**（用户报：「点击左侧栏切换页面时，
 * 不会回到最顶端，而是从上一页面继承当时的位置」）。
 * ------------------------------------------------------------------
 * 判据（五条）：
 *   ① 在「设置」页把内容区滚下去，点侧栏「版本列表」→ 内容区 scrollTop = 0
 *   ② 反向再来一次：在「下载」页滚下去，点侧栏「启动」→ scrollTop = 0
 *   ③ 二级页面也算换屏：版本列表进某个版本 → 点「设置」二级页 → scrollTop = 0
 *   ④ ★ 反面：**同一屏内**的操作不该把人拽回顶部（下载页滚下去后往搜索框打字）
 *   ⑤ 顺带确认内容区确实滚得动（不然 ①②③ 会是"永远为 0"的假绿）
 *
 * 用法：node tools/live/probe-page-scroll-top.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9975;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const PROFILE = path.join(T, 'ieml-scroll-prof');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

if (!existsSync(EXE)) {
  console.error('找不到 exe：' + EXE);
  process.exit(2);
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1000);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const env = { ...process.env };
delete env.IEML_DATA_DIR;
delete env.IEML_OWN_DIR;
const child = spawn(EXE, [], {
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 75; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(400);
}
if (!page) {
  console.error('连不上 CDP（pid ' + child.pid + '）—— 本次测量无效');
  process.exit(3);
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 75; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

const goSide = (label) =>
  ev(`[...document.querySelectorAll('.nav-item, .side-link')].find((x)=>(x.textContent||'').includes(${JSON.stringify(label)}))?.click()`);
/** 把内容区滚到底，返回滚完之后的 scrollTop（用来确认"确实滚动了"） */
const scrollDown = () =>
  ev(`(() => { const c = document.querySelector('.content'); if (!c) return -1;
    c.scrollTop = c.scrollHeight; return Math.round(c.scrollTop); })()`);
const scrollTop = () => ev(`Math.round(document.querySelector('.content')?.scrollTop ?? -1)`);
const contentHeight = () => ev(`(() => { const c = document.querySelector('.content'); return c ? [Math.round(c.scrollHeight), Math.round(c.clientHeight)] : null; })()`);

console.log('内容区（当前页）：' + JSON.stringify(await contentHeight()));

/*
 * ★ 为什么 ①② 都挑"长页 → 长页"：如果目标页比源页短，浏览器会自己把 scrollTop
 *   夹到新页的最大值（常常正好是 0）—— 那样这条判据**在坏构建上也会绿**，
 *   证明不了任何事（第一版就踩了：设置 906 → 版本列表 直接是 0）。
 *   换成"设置 ↔ 更新日志"这种两边都滚得动的组合，继承来的位置夹不掉，才分得出红绿。
 */

/* ① 设置页滚下去 → 点侧栏「更新日志」（两边都是长页） */
await goSide('设置');
await sleep(1400);
const sc1 = await scrollDown();
await sleep(250);
const before1 = await scrollTop();
await goSide('更新日志');
await sleep(1300);
const after1 = await scrollTop();
const tall1 = await contentHeight();
console.log(`① 设置页滚到 ${sc1}（当前 ${before1}）→ 点「更新日志」：scrollTop = ${after1}（该页内容 ${JSON.stringify(tall1)}）`);

/* ② 更新日志滚下去 → 点侧栏「设置」（两边都是长页） */
const sc2 = await scrollDown();
await sleep(250);
const before2 = await scrollTop();
await goSide('设置');
await sleep(1300);
const after2 = await scrollTop();
const tall2 = await contentHeight();
console.log(`② 更新日志滚到 ${sc2}（当前 ${before2}）→ 点「设置」：scrollTop = ${after2}（该页内容 ${JSON.stringify(tall2)}）`);

/* ③ 二级页面：版本列表 → 进一个版本 → 实例「设置」页（长）滚下去 → 点「概览」 */
await goSide('版本列表');
await sleep(1200);
const entered = await ev(`(() => { const r = document.querySelector('.ver-item'); if (!r) return '没有行'; r.click(); return 'clicked'; })()`);
await sleep(1500);
const subClicked = await ev(
  `(() => { const b = [...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('设置')); if (!b) return '没有二级项'; b.click(); return 'clicked'; })()`,
);
await sleep(1500);
const sc3 = await scrollDown();
await sleep(250);
const before3 = await scrollTop();
const backToOverview = await ev(
  `(() => { const b = [...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('概览')); if (!b) return '没有概览项'; b.click(); return 'clicked'; })()`,
);
await sleep(1300);
const after3 = await scrollTop();
console.log(`③ 进版本（${entered}）→ 二级「设置」（${subClicked}）滚到 ${sc3}（当前 ${before3}）→ 点「概览」（${backToOverview}）：scrollTop = ${after3}`);

/* ④ 反面：同一屏内的操作不该重置（主「设置」页滚下去 → 拨一个开关） */
// 先退出实例（否则侧栏上是实例的二级导航，没有开关控件）
await ev(`document.querySelector('.back-btn')?.click()`);
await sleep(1400);
await goSide('设置');
await sleep(1600);
const sc4 = await scrollDown();
await sleep(250);
const toggled = await ev(
  `(() => { const s = document.querySelector('[role="switch"]'); if (!s) return '没有开关'; s.click(); return 'toggled'; })()`,
);
await sleep(1200);
const after4 = await scrollTop();
console.log(`④ 设置页滚到 ${sc4} → 拨一个开关（${toggled}）：scrollTop = ${after4}（应当**不变**）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(700);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const scrollable = sc1 > 0 && sc2 > 0 && sc3 > 0;
const c1 = sc1 > 0 && after1 === 0;
const c2 = sc2 > 0 && after2 === 0;
const c3 = sc3 > 0 && after3 === 0;
/*
 * ④ 判据不是"一个像素都不许动"：点一个靠边缘的控件时，浏览器会把它**滚进视野**
 *   （控件自身的 scroll-into-view，实测 16px）——那是浏览器行为，不是"换页归零"。
 *   要钉住的是"没有被拽回顶部"，所以判据是"还停在原来的量级上"。
 */
const c4 = sc4 > 0 && after4 > sc4 / 2 && toggled === 'toggled';

console.log('\n===== 判据 =====');
console.log(`${scrollable ? '✓' : '✗'} ⑤ 三个页面都确实滚得动（设置 ${sc1} / 更新日志 ${sc2} / 实例设置 ${sc3}）`);
console.log(`${c1 ? '✓' : '✗'} ① 设置(${sc1}) → 更新日志：0（实际 ${after1}）`);
console.log(`${c2 ? '✓' : '✗'} ② 更新日志(${sc2}) → 设置：0（实际 ${after2}）`);
console.log(`${c3 ? '✓' : '✗'} ③ 实例「设置」→「概览」：0（实际 ${after3}；这条是烟雾判据 —— 概览页短，浏览器自己会夹到 0）`);
console.log(`${c4 ? '✓' : '✗'} ④ 同一屏内拨开关**没有被拽回顶部**（${sc4} → ${after4}；点边缘控件会被浏览器滚进视野几像素，不算）`);
process.exit(scrollable && c1 && c2 && c3 && c4 ? 0 : 1);
