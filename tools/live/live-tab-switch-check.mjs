/**
 * 真机验证：切页签**不继承上一页的内容**（用户截图：
 * 「mod 页里 mod 加载出图片后，切到资源包，会继承到资源包，其余那几个也是」）
 *
 * 判据（关键：**在加载中的窗口里抓**）：切过去之后、结果回来之前，
 * 页面上**不能有上一页的卡片**（应当只有骨架屏）。
 * ★ 这条要"抓窗口"：等到结果回来才看，就永远看不出问题（新旧都是对的）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10051;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b23');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b23-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
for (const d of [OUT, PROFILE]) rmSync(d, { recursive: true, force: true });
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
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) }; return r.result?.result?.value; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

const upstreamOk = await (async () => {
  try { const r = await fetch('https://api.modrinth.com/v2/search?limit=1', { signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; }
})();
if (!upstreamOk) { console.log('★ 上游不可达 —— 依赖实时数据的检查跳过（不是失败）'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(0); }

await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1500);
/* 先到 Mod 页签，等它真的加载出卡片 */
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === 'Mod');
  t?.click();
  return !!t;
})()`);
let modCards = 0;
for (let i = 0; i < 80; i += 1) {
  modCards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (modCards > 0) break;
  await sleep(500);
}
console.log('  Mod 卡片：' + modCards);
check('  先在 Mod 页签拿到结果', modCards > 0, `${modCards} 张`);

/* ★ 切到资源包，并在**结果回来之前**反复采样：这时候不该有上一页的卡片 */
const trace = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '资源包');
  if (!tab) return { err: 'no-tab' };
  const samples = [];
  tab.click();
  for (let i = 0; i < 30; i += 1) {
    const real = document.querySelectorAll('.res-card:not(.res-card-sk)').length;
    const sk = document.querySelectorAll('.res-card-sk, .sk').length;
    samples.push({ t: i * 40, real, sk });
    await sleep(40);
  }
  return { samples };
})()`);
const samples = trace?.samples ?? [];
/* 只看"切换之后的前 600ms"：那一段里不该出现真实卡片（除非新结果已经回来了） */
/*
 * ★★ 排除 t=0：那是**点击的同一个 tick**，React 还没来得及重渲染 ——
 *   实测轨迹 t=0 real=20 / t=40 real=0 骨架 42，所以"清空"是**立即生效**的。
 *   ★ 这个坑我今天已经踩过一次（折叠那条判据也在同一 tick 里读属性）；
 *     规矩记下来：**测 React 的渲染结果，必须先让出一帧**。
 */
const early = samples.filter((s) => s.t >= 40 && s.t <= 600);
const stale = early.filter((s) => s.real > 0);
console.log('  切换后前 600ms 采样：' + JSON.stringify(early.slice(0, 8)));
check(
  '★ 切页签后**不再挂着上一页的卡片**（前 600ms 内真实卡片数 = 0）',
  stale.length === 0,
  `有卡片出现的采样点：${stale.length}/${early.length}`,
);
check('  这段时间有骨架屏（不是空白）', early.some((s) => s.sk > 0), JSON.stringify(early.slice(0, 3)));

/* 最后资源包自己也要加载出来（别修成"永远空"） */
let packCards = 0;
for (let i = 0; i < 80; i += 1) {
  packCards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (packCards > 0) break;
  await sleep(500);
}
console.log('  资源包卡片：' + packCards);
check('★ 资源包自己的结果照样出来（没修成"永远空"）', packCards > 0, `${packCards} 张`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '切页签.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
