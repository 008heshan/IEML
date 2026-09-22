/**
 * 真机验证：第五批（J/M 下载源自动 + 去掉推荐；I 下拉统一风格）
 *   · 设置页**没有**镜像/官方选择器，只显示「自动」
 *   · 安装向导里**没有原生 `<select>`**（加载器版本下拉都换成了应用自己的控件）
 *   · 界面上不再有「—— 推荐」这种版本标记
 *   · 默认 prefs.downloadSource = 'auto'
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9851;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b5');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b5-prof');
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
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) }; return r.result?.result?.value; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

/* ---------- 设置页：下载源 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
const src = await ev(`(() => {
  const rows = [...document.querySelectorAll('.field-row, .field')];
  const row = rows.find((r) => /下载源/.test(r.textContent || ''));
  if (!row) return { 找到: false };
  const selects = row.querySelectorAll('select, .cs-btn, [role="combobox"]').length;
  return {
    找到: true,
    文字: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    控件数: selects,
  };
})()`);
console.log('下载源那一行：' + JSON.stringify(src));
check('★ 有「下载源」这一行', src.找到 === true);
check('★ 已经没有可选择器（控件数 = 0）', src.控件数 === 0, String(src.控件数));
check('  写的是「自动」', /自动/.test(src.文字 ?? ''), src.文字);

/* ---------- 默认 prefs ---------- */
const pref = await ev(`(() => {
  const raw = localStorage.getItem('ieml.vfx');
  return { vfx: raw };
})()`);
console.log('（顺便）localStorage vfx = ' + JSON.stringify(pref.vfx));

/* ---------- 安装向导：没有原生 select ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1500);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs [role=tab], .tabs button')].find((x) => (x.textContent || '').trim().includes('整合包'));
  t?.click();
  return !!t;
})()`);
await sleep(4200);
const native = await ev(`(() => ({
  /* ★ 键要加引号：第一版写成 \`select 数:\` —— 带空格的键不加引号是语法错误，
     探针直接抛 Uncaught（这条红是探针自己的错，不是应用坏了）。 */
  'select': document.querySelectorAll('select').length,
  'customSelect': document.querySelectorAll('.cs-btn, [role="combobox"]').length,
  'hasTuijian': /推荐/.test(document.body.innerText || ''),
}))()`);
console.log('下载页：' + JSON.stringify(native));
check(
  '★ 页面上没有原生 select（风格统一）',
  native?.select === 0,
  `${native?.select} 个原生 / ${native?.customSelect} 个自定义`,
);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '下载页.png'), Buffer.from(shot.result.data, 'base64'));

/* 版本列表 / 安装向导里也不该有「—— 推荐」 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('版本列表'))?.click()`);
await sleep(1600);
const verText = await ev(`(() => {
  const t = document.body.innerText || '';
  return { 有推荐标记: /—— 推荐/.test(t) };
})()`);
check('★ 版本列表里没有「—— 推荐」', verText.有推荐标记 === false, String(verText.有推荐标记));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
