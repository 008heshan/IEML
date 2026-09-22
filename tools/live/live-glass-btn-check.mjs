/**
 * 真机验证：启动按钮是**真玻璃**（用户：「等等，我的玻璃呢？」）
 *
 * 判据（三样缺一不可，"看着像"不算）：
 *   ① 底色**半透明** —— computed backgroundImage 里必须出现 rgba(..., <1) 而不是纯色；
 *   ② **磨砂** —— backdropFilter 不是 none；
 *   ③ **顶部高光** —— ::before 有亮线（用 getComputedStyle 取伪元素）；
 *   另外：换主题后底色与光晕都要跟着变（这是上一轮修好的，别退化）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9931;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b12');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b12-prof');
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

const probe = () => ev(`(() => {
  const b = document.querySelector('.launch-btn');
  if (!b) return null;
  const cs = getComputedStyle(b);
  const before = getComputedStyle(b, '::before');
  return {
    'bg': cs.backgroundImage,
    'bgColor': cs.backgroundColor,
    'blur': cs.backdropFilter || cs.webkitBackdropFilter,
    'shadow': cs.boxShadow,
    'veil': cs.getPropertyValue('--accent-veil').trim(),
    'edgeBefore': before.backgroundImage,
    'beforeH': before.height,
  };
})()`);

const g = await probe();
console.log('  玻璃三件套：' + JSON.stringify({
  bg: g?.bg?.slice(0, 90),
  blur: g?.blur,
  veil: g?.veil,
  hasHighlight: g?.edgeBefore !== 'none',
}, null, 1));

/* ① 半透明 */
check(
  '★ 底色**半透明**（不是实心渐变）',
  typeof g?.bg === 'string' && /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.\d+/.test(g.bg),
  g?.bg?.slice(0, 80),
);
/* ② 磨砂 */
check('★ 有**磨砂**（backdrop-filter 不是 none）', !!g?.blur && g.blur !== 'none', String(g?.blur));
/* ③ 顶部高光 */
check('  有顶部高光层（玻璃厚度感）', !!g?.edgeBefore && g.edgeBefore !== 'none', String(g?.edgeBefore).slice(0, 60));
/* 自发光还在（用户既要玻璃也要发光） */
check('  自发光仍在（box-shadow 光晕）', (g?.shadow ?? '').length > 20, String(g?.shadow).slice(0, 60));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '玻璃按钮.png'), Buffer.from(shot.result.data, 'base64'));

/* 换主题仍然跟着变 */
const themeColor = async (t) => {
  await ev(`document.documentElement.setAttribute('data-theme', '${t}')`);
  await sleep(400);
  return probe();
};
const dark = await themeColor('dark');
const jiu = await themeColor('jiuhong');
check('★ 换主题玻璃底色跟着变', dark?.veil !== jiu?.veil, `${dark?.veil} vs ${jiu?.veil}`);
check('  换主题光晕也跟着变', (dark?.shadow ?? '') !== (jiu?.shadow ?? ''));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
