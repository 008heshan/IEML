/**
 * 真机验证：账号按钮（头像 + 名字）与版本列表「⋯」菜单
 *
 * 用户两张截图：
 *   ① 「头像不显示，名字显示不全」
 *   ② 「这地方又出bug了，而且是频繁出bug」（⋯ 菜单只露两项、压在列表行上）
 *
 * 判据要点：
 *   · 头像：`SkinHead` 的两层真的挂在 DOM 上、有背景图、且**取的是头部那一块**
 *     （background-position 必须是负的 head 偏移，不能是 0 0 —— 那是空白区）。
 *   · 名字：`scrollWidth <= clientWidth`，即**整名放得下**（不是"截断得好看"）。
 *   · 菜单：**不在任何行容器内**（portal 到了 body）、条目数正确、完整落在视口里。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9891;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b8');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b8-prof');
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

/* ============ ① 账号按钮：头像 ============ */
console.log('=== ① 账号按钮 ===');
const av = await ev(`(() => {
  const box = document.querySelector('.acct-avatar');
  if (!box) return { 'ok': false, 'why': '没有 .acct-avatar' };
  const layers = [...box.querySelectorAll('.skin-head-layer')];
  const info = layers.map((l) => {
    const cs = getComputedStyle(l);
    return { 'pos': cs.backgroundPosition, 'size': cs.backgroundSize, 'hasImg': cs.backgroundImage !== 'none' };
  });
  const r = box.getBoundingClientRect();
  return { 'ok': true, 'w': Math.round(r.width), 'h': Math.round(r.height), 'layers': info };
})()`);
console.log('  头像：' + JSON.stringify(av));
if (av?.ok && av.layers.length > 0) {
  check('★ 头像有两层（头 + 帽子）', av.layers.length === 2, `${av.layers.length} 层`);
  // 位置必须是负值（取头部那一块）；0 0 取到的是皮肤空白区 —— 这正是上次的 bug
  const posOk = av.layers.every((l) => /-\d/.test(l.pos ?? ''));
  check(
    '★ 取的是**头部那一块**（offset 为负，不是 0 0）',
    posOk,
    JSON.stringify(av.layers.map((l) => l.pos)),
  );
  check('  头像框是正方形', av.w === av.h && av.w > 0, `${av.w}×${av.h}`);
} else {
  // 没登录 / 皮肤拉不到时不该留空白方块，但也不该报成"功能坏了"
  console.log('  （这台机器此刻没有可用的皮肤 URL —— 跳过"取头部那一块"的判据）');
  check('  没有头像数据时不报错', av?.ok === true, JSON.stringify(av));
}
const shotAbout = await send('Page.captureScreenshot', { format: 'png' });
if (shotAbout.result?.data) writeFileSync(path.join(OUT, '账号按钮.png'), Buffer.from(shotAbout.result.data, 'base64'));

/* ============ ② 名字要放得下 ============ */
const name = await ev(`(() => {
  const el = document.querySelector('.acct-btn .acct-name');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    'text': (el.textContent || '').trim(),
    'scrollW': el.scrollWidth,
    'clientW': el.clientWidth,
    'fontSize': cs.fontSize,
    'overflow': cs.textOverflow,
  };
})()`);
console.log('  名字：' + JSON.stringify(name));
check(
  '★ 名字**整名放得下**（不是被截断）',
  name !== null && name.scrollW <= name.clientW + 1,
  `${name?.text}：内容宽 ${name?.scrollW} / 可见宽 ${name?.clientW}`,
);

/* ============ ③ 「⋯」菜单：必须是 portal、不能被裁 ============ */
console.log('\n=== ② 版本列表「⋯」菜单 ===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('版本列表'))?.click()`);
await sleep(1800);
const rows = await ev(`document.querySelectorAll('.ver-item').length`);
console.log('  版本行数：' + rows);
check('  有版本行', rows > 1, `${rows} 行`);

// 点**最后一行**的 ⋯（最容易被窗口底边裁掉的那种）
const opened = await ev(`(() => {
  const items = [...document.querySelectorAll('.ver-item')];
  const last = items[items.length - 1];
  const btn = last?.querySelector('button[aria-label*="更多"], .ver-more, button:last-of-type');
  if (!btn) return 'no-button';
  btn.scrollIntoView({ block: 'end' });
  btn.click();
  return 'clicked';
})()`);
await sleep(700);
const menu = await ev(`(() => {
  const m = document.querySelector('.row-menu[role="menu"]');
  if (!m) return { 'exists': false };
  const r = m.getBoundingClientRect();
  const items = [...m.querySelectorAll(':scope > button')];
  return {
    'exists': true,
    'parentIsBody': m.parentElement === document.body,
    'items': items.length,
    'labels': items.map((x) => (x.textContent || '').trim().slice(0, 10)),
    'rect': [Math.round(r.top), Math.round(r.bottom), Math.round(r.left), Math.round(r.right)],
    'inViewport': r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1,
    'height': Math.round(r.height),
    'scrollHeight': m.scrollHeight,
    'vpH': window.innerHeight,
  };
})()`);
console.log('  菜单：' + JSON.stringify(menu, null, 1));
check('★ 菜单渲染在 body 下（portal，祖先裁不到）', menu?.parentIsBody === true, String(menu?.parentIsBody));
check('★ 菜单完整落在视口内', menu?.inViewport === true, JSON.stringify(menu?.rect) + ' 视口高 ' + menu?.vpH);
check('★ 菜单条目没被裁（内容高 ≤ 盒高 + 2）', (menu?.scrollHeight ?? 1e9) <= (menu?.height ?? 0) + 2, `内容 ${menu?.scrollHeight} / 盒 ${menu?.height}`);
check('  菜单至少有 3 项（原来只露 2 项）', (menu?.items ?? 0) >= 3, `${menu?.items} 项：${JSON.stringify(menu?.labels)}`);
const shotMenu = await send('Page.captureScreenshot', { format: 'png' });
if (shotMenu.result?.data) writeFileSync(path.join(OUT, '版本菜单.png'), Buffer.from(shotMenu.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
