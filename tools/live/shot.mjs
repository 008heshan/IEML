/**
 * 用 Chrome DevTools Protocol 驱动浏览器，给 IEML 的浏览器演示模式拍截图。
 * ------------------------------------------------------------------
 * 为什么需要它：新的导航是「一级侧栏 → 双击版本进入二级页」，静态截图
 * 只能看到一级页，二级页（概览/设置/Mod/日志）必须真的点进去才看得到。
 *
 * 用法：
 *   node tools/live/shot.mjs <url> <outDir> <plan.json>
 *
 * plan.json: [{ "eval": "..." } | { "wait": 600 } | { "shot": "name.png" }]
 * 依赖：Node 22+ 内置 WebSocket。脚本自己拉起 Chrome，结束时收掉。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/?demo=1';
const outDir = process.argv[3] ?? 'tmp/shots';
const planPath = process.argv[4];
const port = Number(process.env.CDP_PORT ?? 9222);

const plan = planPath
  ? JSON.parse(readFileSync(planPath, 'utf8'))
  : [{ wait: 2500 }, { shot: 'page.png' }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 找一个 Chrome ---------- */
const candidates = [
  process.env.CHROME_PATH,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) throw new Error('找不到 Chrome / Edge');

/* ---------- 2. 拉起来（stdio ignore —— 不需要读它的输出） ---------- */
const profile = join(process.env.TEMP ?? '/tmp', `ieml-cdp-${port}`);
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

/* ---------- 3. 连上去 ---------- */
async function findPage() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`连不上 CDP ${port}`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }
    }, 30000);
  });
}

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

mkdirSync(outDir, { recursive: true });
const bust = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
await send('Page.navigate', { url: bust });

/* ---------- 4. 按剧本走 ---------- */
for (const step of plan) {
  if (step.wait) await sleep(step.wait);
  if (step.eval) {
    const r = await send('Runtime.evaluate', {
      expression: step.eval,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      console.log(`  ✗ 求值出错：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    } else {
      const v = JSON.stringify(r.result?.value ?? null);
      console.log(`  · ${String(r.result?.value ?? '').slice(0, 400) || (v ?? '')}`);
    }
  }
  if (step.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(outDir, step.shot);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ▣ ${file}`);
  }
}

ws.close();
await sleep(150);
try {
  child.kill();
} catch {
  /* 已经退了 */
}
process.exit(0);
