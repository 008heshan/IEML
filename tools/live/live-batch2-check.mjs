/**
 * 真机验证：第二批（G 资源包/整合包能不能装 + L 预览命令打开速度）。
 *
 * G 判据：
 *   · 整合包列表有卡片；
 *   · 点一张之后，**安装面板必须出现在视口里**（这是用户"根本装不了"的真因：
 *     面板原来在 top≈1939、视口只有 760，在屏幕外 1200px）；
 *   · 资源中心点卡片展开后，展开的卡片也要在视口里。
 * L 判据：
 *   · 点「预览命令」到**窗口可见**的耗时（原来是"先拼完再开窗"，秒级）；
 *   · 第二次点（命中缓存）应当更快。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9811;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b2');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b2-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
if (!page) { console.error('连不上 CDP'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    const t = String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0];
    // Tauri 的 IPC 回退是环境噪声，不算我们的异常
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) }; return r.result?.result?.value; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

/* ============ G① 整合包：点卡片 → 安装面板要在视口里 ============ */
console.log('=== G① 整合包安装面板 ===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1200);
await ev(`(() => { const t = [...document.querySelectorAll('.tabs [role=tab], .tabs button')].find((x) => (x.textContent || '').trim().includes('整合包')); t?.click(); return !!t; })()`);
await sleep(4200);
const packCount = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
check('  整合包列表有卡片', packCount > 0, `${packCount} 张`);

await ev(`(() => { const c = document.querySelector('.pack-card:not(.pack-card-sk)'); c?.click(); return !!c; })()`);
await sleep(1600);
const panel = await ev(`(() => {
  const p = document.querySelector('.setup-panel');
  if (!p) return { 在: false };
  const r = p.getBoundingClientRect();
  return { 在: true, top: Math.round(r.top), 视口高: window.innerHeight, 在视口内: r.top < window.innerHeight - 40 && r.bottom > 40 };
})()`);
console.log('  ' + JSON.stringify(panel));
check('★ 点卡片后**安装面板出现在视口里**（用户"根本装不了"的真因）', panel.在 === true && panel.在视口内 === true, JSON.stringify(panel));

const installBtn = await ev(`(() => {
  const b = [...document.querySelectorAll('.setup-panel button')].find((x) => /确认并开始安装/.test(x.textContent || ''));
  if (!b) return { 找到: false };
  const r = b.getBoundingClientRect();
  return { 找到: true, 在视口内: r.top > 0 && r.bottom < window.innerHeight, disabled: b.disabled };
})()`);
check('★ 「确认并开始安装」按钮也在视口里且可点', installBtn.找到 === true && installBtn.在视口内 === true && installBtn.disabled === false, JSON.stringify(installBtn));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '整合包-安装面板.png'), Buffer.from(shot.result.data, 'base64'));

/* ============ G② 资源中心：展开后卡片要在视口里 ============ */
console.log('\n=== G② 资源包详情 ===');
const tabOk = await ev(`(() => { const t = [...document.querySelectorAll('.tabs [role=tab], .tabs button')].find((x) => (x.textContent || '').trim().includes('资源包')); t?.click(); return !!t; })()`);
await sleep(4200);
const resCount = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
check('  资源包列表有卡片', resCount > 0, `${resCount} 张`);
// 专门点**最后一张**卡片（它最可能在视口底部 —— 那才是"详情看不到"的现场）
const opened = await ev(`(() => {
  const cards = [...document.querySelectorAll('.res-card:not(.res-card-sk)')];
  const c = cards[cards.length - 1];
  if (!c) return false;
  c.scrollIntoView({ block: 'end' });
  /* ★ 点**卡片里面的按钮**：.res-card 是 div，onClick 挂在它内部的按钮上
     （第一版直接点 div，于是"没展开"是我的测试错了，不是应用坏了）。 */
  const btn = c.querySelector('button');
  (btn || c).click();
  return true;
})()`);
await sleep(3000);
const detail = await ev(`(() => {
  const c = document.querySelector('.res-card.open');
  if (!c) return { 展开: false };
  const r = c.getBoundingClientRect();
  const text = (c.innerText || '').length;
  return { 展开: true, top: Math.round(r.top), bottom: Math.round(r.bottom), 视口高: window.innerHeight, 可见: r.top < window.innerHeight && r.bottom > 0, 内容字数: text };
})()`);
console.log('  ' + JSON.stringify(detail));
check('★ 点最后一张卡片，展开的详情**在视口里**', detail.展开 === true && detail.可见 === true, JSON.stringify(detail));

/* ============ L 预览命令 ============ */
console.log('\n=== L 预览命令 ===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('启动'))?.click()`);
await sleep(2200);
const timing = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find((x) => /预览命令/.test(x.textContent || ''));
  if (!btn) return { err: '找不到按钮' };
  const t0 = performance.now();
  btn.click();
  // 等窗口出现
  let openAt = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(50);
    if (document.querySelector('.modal')) { openAt = performance.now() - t0; break; }
  }
  /* 等内容填好：给足 25 秒 —— 这一条是**量真实耗时**，不是"必须多快" */
  let readyAt = null;
  for (let i = 0; i < 500; i += 1) {
    await sleep(50);
    const m = document.querySelector('.modal');
    if (m && !/正在拼装/.test(m.innerText || '')) { readyAt = performance.now() - t0; break; }
  }
  const toast = [...document.querySelectorAll('.toast')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join(' | ');
  return {
    开窗ms: openAt === null ? null : Math.round(openAt),
    内容就绪ms: readyAt === null ? null : Math.round(readyAt),
    提示: toast || null,
    弹窗还在: !!document.querySelector('.modal'),
    弹窗开头: (document.querySelector('.modal')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
  };
})()`);
console.log('  ' + JSON.stringify(timing));
check(
  '★ 点「预览命令」后**窗口立刻打开**（< 300ms，不再是"先拼完才开窗"）',
  typeof timing?.开窗ms === 'number' && timing.开窗ms < 300,
  `开窗 ${timing?.开窗ms}ms · 内容就绪 ${timing?.内容就绪ms}ms`,
);

// 关掉再来一次：应当命中缓存，接近瞬时
const second = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const close = [...document.querySelectorAll('.modal button')].find((x) => /关闭/.test(x.textContent || ''));
  close?.click();
  await sleep(500);
  const btn = [...document.querySelectorAll('button')].find((x) => /预览命令/.test(x.textContent || ''));
  const t0 = performance.now();
  btn?.click();
  let openAt = null, readyAt = null;
  for (let i = 0; i < 320; i += 1) {
    await sleep(25);
    const m = document.querySelector('.modal');
    if (m && openAt === null) openAt = performance.now() - t0;
    if (m && !/正在拼装/.test(m.innerText || '')) { readyAt = performance.now() - t0; break; }
  }
  return { 开窗ms: openAt === null ? null : Math.round(openAt), 内容就绪ms: readyAt === null ? null : Math.round(readyAt) };
})()`);
console.log('  第二次：' + JSON.stringify(second));
check('★ 第二次点（命中缓存）内容**立刻就在**', typeof second?.内容就绪ms === 'number' && second.内容就绪ms < 300, `内容就绪 ${second?.内容就绪ms}ms`);

check('全程没有异常（IPC 回退噪声不计）', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
