/**
 * 探针：把「模组加载器」那一页每一块的**几何**打出来（正文可视高度 vs 内容高度）。
 * ------------------------------------------------------------------
 * 为什么留着它：ADR-058.4 那个缺陷就是它抓到的 ——
 *   版本名称那一块被挤到折线以下（正文可视 507px、内容 589px），
 *   而当时的检查只从 DOM 读了 `value`，**照样判过**。
 *   判据选错层的时候，只有"量几何"能看出来。
 *
 * 用法：`node tools/live/probe-loader-page-boxes.mjs ["<exe>"]`
 * 输出：正文的可视/内容高度、每一块的 y 与高度、版本名称输入框的坐标。
 * 只量、不判断（判断留给跑它的人）。
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9933;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-probe-prof');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(500);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(2500);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t) => (t.textContent || '').trim() === '安装游戏')?.click()`);
for (let i = 0; i < 40; i += 1) {
  if ((await ev(`document.querySelectorAll('.gw-col .wz-item').length > 0`)) === true) break;
  await sleep(300);
}
await ev(`document.querySelector('.gw-col .wz-item')?.click()`);
await sleep(2200);

const r = await ev(`(() => {
  const body = document.querySelector('.gw-full-body');
  const kids = [...(body?.children ?? [])].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      'cls': el.className,
      'text': (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 24),
      'y': Math.round(r.y),
      'h': Math.round(r.height),
      'vis': r.height > 0,
    };
  });
  const input = document.querySelector('.gw-full input.input');
  const ir = input?.getBoundingClientRect();
  const bw = body?.getBoundingClientRect();
  return {
    'bodyY': bw ? Math.round(bw.y) : 0,
    'bodyH': bw ? Math.round(bw.height) : 0,
    'scrollH': body?.scrollHeight ?? 0,
    'clientH': body?.clientHeight ?? 0,
    'scrollTop': body?.scrollTop ?? 0,
    'kids': kids,
    'inputY': ir ? Math.round(ir.y) : null,
    'inputH': ir ? Math.round(ir.height) : null,
    'inputName': input?.getAttribute('aria-label') ?? null,
  };
})()`);
console.log(JSON.stringify(r, null, 2));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
