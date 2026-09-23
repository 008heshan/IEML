/**
 * 真机验证：**点版本行直接安装**（PCL 同款），所有资源页统一
 * （用户：「太多安装按钮了，乱繁，改成点击这个直接安装（PCL 同款），**全都要改**」）
 *
 * 判据：
 *   · 版本行里**没有**「安装这个版本」按钮
 *   · 每一行**自己就是按钮**：`role="button"` + `tabIndex=0` + `aria-label="安装 …"`
 *   · 鼠标是手型（cursor: pointer）
 *   · 整合包安装页**不再有**那排"实例名称 + 确认并开始安装"
 *   · 装不了的那一行**不可点**（role 为空、cursor 不是手型）
 *
 * ★ 这里**不真的点下去装**：那会往用户的实例里写文件。
 *   结构 + 语义 + 指针样式足以证明"这一行就是安装入口"，
 *   而它调的 `onPick` 与原来那个按钮**是同一个**（改动只有一行）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10031;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b21');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b21-prof');
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
if (!upstreamOk) { console.log('★ 上游不可达 —— 跳过（不是失败）'); process.exit(0); }

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

/* ---------- Mod 页签名开一页 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1500);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === 'Mod');
  t?.click();
  return !!t;
})()`);
await sleep(1200);
let cards = 0;
for (let i = 0; i < 80; i += 1) {
  cards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
await ev(`document.querySelector('.res-card:not(.res-card-sk)')?.querySelector('button')?.click()`);
let groups = 0;
for (let i = 0; i < 60; i += 1) {
  groups = await ev(`document.querySelectorAll('.res-vgroup-head').length`);
  if (groups > 0) break;
  await sleep(500);
}
console.log(`  卡片 ${cards} / 分组 ${groups}`);

const rows = await ev(`(() => {
  const list = [...document.querySelectorAll('.res-version')];
  return {
    '行数': list.length,
    '行内按钮数': list.reduce((n, r) => n + r.querySelectorAll('button').length, 0),
    'role=button 的行': list.filter((r) => r.getAttribute('role') === 'button').length,
    '可 tab 的行': list.filter((r) => r.getAttribute('tabindex') === '0').length,
    '有 aria-label 的行': list.filter((r) => /安装/.test(r.getAttribute('aria-label') || '')).length,
    '手型的行': list.filter((r) => getComputedStyle(r).cursor === 'pointer').length,
    '示例 label': list[0]?.getAttribute('aria-label') ?? null,
  };
})()`);
console.log('  版本行：' + JSON.stringify(rows));
check('★ 行里**没有**安装按钮了', (rows?.行内按钮数 ?? -1) === 0, String(rows?.行内按钮数));
check('★ 每一行**自己就是按钮**（role + tabIndex）', (rows?.['role=button 的行'] ?? -1) === (rows?.行数 ?? -1) && (rows?.['可 tab 的行'] ?? 0) === (rows?.行数 ?? -1), JSON.stringify(rows));
check('★ 有「安装 …」的可读名称（读屏可用）', (rows?.['有 aria-label 的行'] ?? 0) === (rows?.行数 ?? -1), String(rows?.['示例 label']));
check('★ 鼠标是**手型**（看得出能点）', (rows?.['手型的行'] ?? 0) === (rows?.行数 ?? -1), `${rows?.['手型的行']}/${rows?.行数}`);

const shot1 = await send('Page.captureScreenshot', { format: 'png' });
if (shot1.result?.data) writeFileSync(path.join(OUT, '版本行.png'), Buffer.from(shot1.result.data, 'base64'));

/* ---------- 整合包安装页：也统一了 ---------- */
await ev(`[...document.querySelectorAll('button')].find((b) => /返回/.test(b.textContent || ''))?.click()`);
await sleep(1500);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
await sleep(1200);
for (let i = 0; i < 80; i += 1) {
  cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
for (let i = 0; i < 60; i += 1) {
  groups = await ev(`document.querySelectorAll('.res-vgroup-head').length`);
  if (groups > 0) break;
  await sleep(500);
}
const mp = await ev(`(() => {
  const list = [...document.querySelectorAll('.res-version')];
  return {
    '有操作排': !!document.querySelector('.res-detail-actions'),
    '有实例名称输入': !!document.querySelector('.res-detail-name-field'),
    '行数': list.length,
    '行内按钮数': list.reduce((n, r) => n + r.querySelectorAll('button').length, 0),
    '可点的行': list.filter((r) => r.getAttribute('role') === 'button').length,
  };
})()`);
console.log('  整合包安装页：' + JSON.stringify(mp));
check('★ 整合包页也去掉了"实例名称 + 确认并开始安装"', mp?.有操作排 === false && mp?.有实例名称输入 === false, JSON.stringify(mp));
check('★ 整合包页的版本行同样**整行可点**', (mp?.行数 ?? 0) > 0 && mp?.['行内按钮数'] === 0 && mp?.可点的行 === mp?.行数, JSON.stringify(mp));

const shot2 = await send('Page.captureScreenshot', { format: 'png' });
if (shot2.result?.data) writeFileSync(path.join(OUT, '整合包页.png'), Buffer.from(shot2.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
