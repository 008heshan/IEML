/**
 * 真机验证：头像**不用点也能出来**（用户第二遍：「左下角头像还是我不点就不加载」）
 *
 * 判据（关键：**全程不碰账号按钮**）：
 *   ① 启动后不点任何东西，等到皮肤被拉回来 —— `.skin-head-layer` 要出现且有背景图；
 *   ② 在拉回来之前，占位人形在（不能是个空方框，"看着像坏了"）；
 *   ③ 记录**拉回来花了多久**（拉皮肤走 sessionserver，这台机器上时通时不通，
 *      所以"多久"是重要信息 —— 退避重试就是为了覆盖这个窗口）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9991;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b17');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b17-prof');
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
const t0 = Date.now();
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
console.log(`界面就绪：${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ① 先看占位在不在（此刻皮肤多半还没拉回来） */
const early = await ev(`(() => {
  const box = document.querySelector('.acct-avatar');
  return {
    '容器': !!box,
    '层数': box ? box.querySelectorAll('.skin-head-layer').length : -1,
    '占位': !!document.querySelector('.acct-avatar-ph'),
  };
})()`);
console.log('  早期状态：' + JSON.stringify(early));
check('★ 皮肤没到时**有占位人形**（不是空方框）', early?.容器 === true && (early?.层数 > 0 || early?.占位 === true), JSON.stringify(early));

/* ② 全程不点账号按钮，等皮肤自己回来（最多等 30 秒 —— 退避重试覆盖这个窗口） */
let got = null;
for (let i = 0; i < 60; i += 1) {
  const st = await ev(`(() => {
    const box = document.querySelector('.acct-avatar');
    const layers = box ? [...box.querySelectorAll('.skin-head-layer')] : [];
    const withImg = layers.filter((l) => getComputedStyle(l).backgroundImage !== 'none');
    return { 'layers': layers.length, 'withImg': withImg.length, 'img': withImg[0] ? getComputedStyle(withImg[0]).backgroundImage.slice(0, 60) : null };
  })()`);
  if (st?.withImg > 0) { got = { at: ((Date.now() - t0) / 1000).toFixed(1), st }; break; }
  await sleep(500);
}
console.log('  头像到位：' + JSON.stringify(got));
check('★ **不点任何按钮**，头像自己加载出来了', got !== null, got ? `${got.at}s：${got.st.img}` : '30 秒内没等到');

/* ③ 全程没碰过账号按钮（复核：菜单从未打开过） */
const menuOpened = await ev(`!!document.querySelector('.acct-menu')`);
check('  复核：账号菜单确实没被打开过', menuOpened === false, String(menuOpened));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '头像.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
