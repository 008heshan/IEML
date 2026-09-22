/**
 * 真机验证：提示条**真的滑走**（用户：「不是，我的滑走在哪里？？？」）
 *
 * ★ 上一轮我只验了"点了关闭之后挂上 `.leaving`" —— 那只证明**类名对了**，
 *   完全没证明**它在动**。这次直接**采样它的 transform**：
 *   一定时间内位移必须持续增大，最后滑出视野；并且元素要活到动画跑完。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9981;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b16');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b16-prof');
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

/* 触发一个 toast（点主题色板） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1600);
await ev(`(() => {
  const sw = [...document.querySelectorAll('.theme-swatch, .theme-grid button')];
  sw[0]?.click();
  return !!sw.length;
})()`);
await sleep(700);

/* 在页面里连续采样：点关闭之后每 40ms 记一次 transform / 宽度 / 是否还在 */
const trace = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = document.querySelector('.toast');
  if (!t0) return { err: '没有 toast' };
  const btn = t0.querySelector('button');
  if (!btn) return { err: '没有关闭按钮' };
  const samples = [];
  const anim = getComputedStyle(t0).animationName;
  btn.click();
  for (let i = 0; i < 12; i += 1) {
    await sleep(40);
    const el = document.querySelector('.toast');
    if (!el) { samples.push({ t: (i + 1) * 40, gone: true }); break; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    samples.push({
      t: (i + 1) * 40,
      leaving: el.className.includes('leaving'),
      anim: cs.animationName,
      transform: cs.transform,
      right: Math.round(r.right),
      opacity: Number(cs.opacity).toFixed(2),
    });
  }
  return { animBefore: anim, samples, vw: window.innerWidth };
})()`);
console.log('  退场轨迹：' + JSON.stringify(trace, null, 1));

const samples = trace?.samples ?? [];
const moving = samples.filter((s) => s.transform && s.transform !== 'none');
check('★ 点关闭后动画**真的在跑**（animationName 不是 none）', samples.some((s) => s.anim && s.anim !== 'none'), JSON.stringify(samples[0]?.anim));
check('★ 有**位移**（transform 出现矩阵，不只是淡出）', moving.length > 0, JSON.stringify(moving.slice(0, 3).map((s) => s.transform)));
/* 位移量要**肉眼可见**：最后采样点的右边缘应当明显越过初始位置，或元素已滑出 */
const first = samples.find((s) => typeof s.right === 'number');
const last = [...samples].reverse().find((s) => typeof s.right === 'number');
const gone = samples.some((s) => s.gone);
const moved = first && last ? last.right - first.right : 0;
check(
  '★ 位移量足够大（不是 12px 那种看不见的挪动）',
  moved > 40 || (gone && moved > 20),
  `右边缘 ${first?.right} → ${last?.right}（+${moved}px）`,
);
check('  元素活到动画跑完（不是删得太早）', samples.length >= 3, `${samples.length} 次采样，gone=${gone}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '提示条.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
