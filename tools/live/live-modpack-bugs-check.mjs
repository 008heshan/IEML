/**
 * 真机验证：整合包安装页的两个 bug（用户截图）
 *   ① 有推荐版本的那一组**能收起来**（点一下 aria-expanded 翻转、组内行消失）
 *   ② 「确认并开始安装」按钮与**实例名称输入框底边齐平**
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10021;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b20');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b20-prof');
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

await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1500);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
await sleep(1200);

/* 等卡片 → 点第一张 → 等版本列表 */
let cards = 0;
for (let i = 0; i < 80; i += 1) {
  cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
let groups = 0;
for (let i = 0; i < 60; i += 1) {
  groups = await ev(`document.querySelectorAll('.res-vgroup-head').length`);
  if (groups > 0) break;
  await sleep(500);
}
console.log(`  卡片 ${cards} / 分组 ${groups}`);

/* ---------- ② 按钮与输入框底边齐平 ---------- */
const align = await ev(`(() => {
  const input = document.querySelector('.res-detail-name-field input');
  const btn = [...document.querySelectorAll('.res-detail-actions button')].find((b) => /确认并开始安装/.test(b.textContent || ''));
  if (!input || !btn) return { '找到': false, '有输入': !!input, '有按钮': !!btn };
  const ir = input.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  return {
    '找到': true,
    '输入底': Math.round(ir.bottom),
    '按钮底': Math.round(br.bottom),
    '差': Math.round(Math.abs(ir.bottom - br.bottom)),
  };
})()`);
console.log('  对齐：' + JSON.stringify(align));
check('★ 「确认并开始安装」与输入框**底边齐平**（差 ≤ 6px）', (align?.差 ?? 999) <= 6, JSON.stringify(align));

/* ---------- ① 带推荐的那一组能收起 ---------- */
const canCollapse = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const heads = [...document.querySelectorAll('.res-vgroup-head')];
  /* 找"有推荐标记的那一组"：先看哪一组里有 .chip 文本是"推荐" */
  let target = null;
  for (const h of heads) {
    const group = h.parentElement;
    if ([...group.querySelectorAll('.res-version-name .chip')].some((c) => /推荐/.test(c.textContent || ''))) {
      target = h;
      break;
    }
  }
  if (!target) return { '找到推荐组': false, '组数': heads.length };
  const before = target.getAttribute('aria-expanded');
  const rowsBefore = target.parentElement.querySelectorAll('.res-version').length;
  target.click();
  await sleep(450);
  const after = target.getAttribute('aria-expanded');
  const rowsAfter = target.parentElement.querySelectorAll('.res-version').length;
  return { '找到推荐组': true, 'before': before, 'after': after, 'rowsBefore': rowsBefore, 'rowsAfter': rowsAfter };
})()`);
console.log('  推荐组折叠：' + JSON.stringify(canCollapse));
check('  找得到"带推荐的那一组"', canCollapse?.找到推荐组 === true, JSON.stringify(canCollapse));
check(
  '★ 带推荐的那一组**能收起来**（aria-expanded 翻转、组内行消失）',
  canCollapse?.before === 'true' && canCollapse?.after === 'false' && canCollapse?.rowsAfter === 0,
  JSON.stringify(canCollapse),
);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '整合包安装页.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
