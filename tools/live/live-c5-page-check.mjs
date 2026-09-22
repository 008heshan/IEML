/**
 * 真机验证 C5：点「安装」进**独立页面**（用户：「给这些资源点击安装时单独建页面，看 PCL 做法」）
 *
 * 判据：
 *   · 点卡片上的按钮之后，**整页换掉**（出现资源信息卡 `.res-detail` + 版本列表）
 *   · 版本列表**带着分组**（C4 那套还在，说明复用的是同一份实现）
 *   · 页面上**不再有**原来的卡片内联展开（`.res-card.open` 不该出现）
 *   · 有「返回」能回到下载页
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9951;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b14');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b14-prof');
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

const upstreamOk = await (async () => {
  try {
    const r = await fetch('https://api.modrinth.com/v2/search?limit=1', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
})();
if (!upstreamOk) {
  console.log('★ 上游 Modrinth 不可达 —— 依赖实时数据的检查跳过（不是失败）。');
  process.exit(0);
}

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

/* 进 Mod 页签 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1400);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === 'Mod');
  t?.click();
  return !!t;
})()`);
await sleep(4500);

/* 等卡片真的出来（4.5 秒不够时第一版点了空 —— 判据要等而不是猜） */
let cards = 0;
for (let i = 0; i < 40; i += 1) {
  cards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
console.log('  Mod 卡片：' + cards);
check('  有资源卡片（点之前先确认）', cards > 0, `${cards} 张`);

/* 点第一张卡片里那个按钮（按文字找，别假设它是第几个） */
const clicked = await ev(`(() => {
  const c = document.querySelector('.res-card:not(.res-card-sk)');
  if (!c) return 'no-card';
  const bs = [...c.querySelectorAll('button')];
  const b = bs.find((x) => /安装|版本|打开/.test(x.textContent || '')) ?? bs[0];
  if (!b) return 'no-button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`);
console.log('点安装：' + clicked);
await sleep(4500);

const pageState = await ev(`(() => {
  const d = document.querySelector('.res-detail');
  const rows = [...document.querySelectorAll('.res-detail-meta .dim, .res-detail-desc')].map((x) => (x.textContent || '').trim());
  return {
    '有信息卡': !!d,
    '标题': document.querySelector('.page-title')?.textContent?.trim() ?? null,
    '名称': document.querySelector('.res-detail-name')?.textContent?.trim() ?? null,
    '图标': !!document.querySelector('.res-detail-icon'),
    '动作数': document.querySelectorAll('.res-detail-actions button').length,
    '分组数': document.querySelectorAll('.res-vgroup-head').length,
    '版本行数': document.querySelectorAll('.res-version').length,
    '遗留内联展开': document.querySelectorAll('.res-card.open').length,
    'hasBack': [...document.querySelectorAll('button')].some((b) => /返回/.test(b.textContent || '')),
  };
})()`);
console.log('  安装页：' + JSON.stringify(pageState, null, 1));
check('★ 进了**独立页面**（有资源信息卡）', pageState?.有信息卡 === true);
check('★ 页面标题是「安装资源」', pageState?.标题 === '安装资源', String(pageState?.标题));
check('  信息卡有名称与图标', !!pageState?.名称 && pageState?.图标 === true, String(pageState?.名称));
check('  三个动作都在（Modrinth / MC 百科 / 复制名称）', (pageState?.动作数 ?? 0) >= 3, String(pageState?.动作数));
check('★ 版本列表**带着分组**（复用同一份实现）', (pageState?.分组数 ?? 0) >= 2, `${pageState?.分组数} 组`);
check('  版本行有内容', (pageState?.版本行数 ?? 0) > 0, `${pageState?.版本行数} 行`);
check('★ 不再有卡片内联展开（那正是要换掉的）', pageState?.遗留内联展开 === 0, String(pageState?.遗留内联展开));
check('  有「返回」', pageState?.hasBack === true);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '安装页.png'), Buffer.from(shot.result.data, 'base64'));

/* 返回 */
await ev(`[...document.querySelectorAll('button')].find((b) => /返回/.test(b.textContent || ''))?.click()`);
await sleep(1600);
const back = await ev(`(() => ({
  '有信息卡': !!document.querySelector('.res-detail'),
  '有卡片列表': document.querySelectorAll('.res-card').length > 0,
}))()`);
console.log('  返回后：' + JSON.stringify(back));
check('★ 返回回到下载页（信息卡消失、列表回来）', back?.有信息卡 === false && back?.有卡片列表 === true, JSON.stringify(back));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
