/**
 * 真机验证：行内加粗（用户截图：「**markdown 没生效哦**」）
 *   · 关于页 + 更新日志页的可见文字里**不允许出现字面的 `**`**；
 *   · 该加粗的地方要真的渲染成 `<b>`（不只是把星号删掉）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9881;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b7');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b7-prof');
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

/* ---------- 关于页 ---------- */
await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').trim() === '关于')?.click()`);
await sleep(1600);
const about = await ev(`(() => {
  const text = document.body.innerText || '';
  const bolds = [...document.querySelectorAll('.about-list b, .about-center b')].map((x) => (x.textContent || '').trim());
  return {
    'hasLiteralStars': /\\*\\*/.test(text),
    'boldCount': bolds.length,
    'bolds': bolds.slice(0, 8),
  };
})()`);
console.log('关于页：' + JSON.stringify(about, null, 1));
check('★ 关于页**没有**字面的 ** 记号', about?.hasLiteralStars === false, String(about?.hasLiteralStars));
check('★ 该加粗的地方真的渲染成了 <b>', (about?.boldCount ?? 0) >= 3, `${about?.boldCount} 处：${JSON.stringify(about?.bolds)}`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '关于页-加粗.png'), Buffer.from(shot.result.data, 'base64'));

/* ---------- 更新日志页 ---------- */
await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').includes('更新日志'))?.click()`);
await sleep(1500);
const cl = await ev(`(() => {
  const text = document.body.innerText || '';
  return { 'hasLiteralStars': /\\*\\*/.test(text), 'items': document.querySelectorAll('.rel-list li').length };
})()`);
console.log('更新日志页：' + JSON.stringify(cl));
check('★ 更新日志页也没有字面的 **', cl?.hasLiteralStars === false, String(cl?.hasLiteralStars));
check('  更新日志条目还在', (cl?.items ?? 0) >= 8, `${cl?.items} 条`);

/* ---------- 全局再扫一遍（别的页面也不该漏星号） ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1500);
const settings = await ev(`(() => ({ 'hasLiteralStars': /\\*\\*/.test(document.body.innerText || '') }))()`);
check('  设置页同样干净', settings?.hasLiteralStars === false, String(settings?.hasLiteralStars));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
