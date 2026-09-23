/**
 * 真机验证：① 标题栏底部那条模糊（细带 + 向下淡出）② 工具栏与搜索行的间距
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10011;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b19');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b19-prof');
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

/* 进下载页（那条模糊带在内容滚动时才可见 —— 先滚一下） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(2500);
await ev(`document.querySelector('.content')?.scrollTo(0, 200)`);
await sleep(800);

const glass = await ev(`(() => {
  const g = document.querySelector('.top-glass');
  const t = document.querySelector('.page-title');
  if (!g) return { '存在': false };
  const cs = getComputedStyle(g);
  const r = g.getBoundingClientRect();
  const tr = t ? t.getBoundingClientRect() : null;
  return {
    '存在': true,
    '范围': [Math.round(r.top), Math.round(r.bottom)],
    '高': Math.round(r.height),
    '透明度': cs.opacity,
    '模糊': cs.backdropFilter,
    '有遮罩(淡出)': cs.maskImage !== 'none' && cs.maskImage !== '',
    '页头标题顶': tr ? Math.round(tr.top) : null,
    '压住页头吗': tr ? r.bottom > tr.top : null,
  };
})()`);
console.log('  顶部模糊带：' + JSON.stringify(glass));
check('★ 模糊带还在（用户："标题栏底部模糊没了"）', glass?.存在 === true && glass?.模糊 !== 'none', JSON.stringify(glass?.模糊));
check('★ 只 14px 的细带', glass?.高 === 14, `${glass?.高}px`);
check('★ 下边缘是**淡出**（有 mask），不是硬边', glass?.['有遮罩(淡出)'] === true, String(glass?.['有遮罩(淡出)']));
check('★ 不压住页头文字', glass?.压住页头吗 === false, `带底 ${glass?.范围?.[1]} / 标题顶 ${glass?.页头标题顶}`);

/* 整合包页签：工具栏与搜索行的间距 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1200);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
await sleep(2000);
const gap = await ev(`(() => {
  const bar = document.querySelector('.res-bar');
  const search = document.querySelector('.res-search');
  if (!bar || !search) return { '找到': false };
  const br = bar.getBoundingClientRect();
  const sr = search.getBoundingClientRect();
  const cs = getComputedStyle(search);
  return { '找到': true, '间距': Math.round(sr.top - br.bottom), 'marginTop': cs.marginTop };
})()`);
console.log('  工具栏→搜索行：' + JSON.stringify(gap));
check('★ 工具栏与搜索行**拉开了**（不再贴着）', (gap?.间距 ?? 0) >= 8, `实测 ${gap?.间距}px（margin ${gap?.marginTop}）`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '工具栏.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
