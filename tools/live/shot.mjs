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
  /*
   * ★ 限速（2026-09-15 加）：用来拍**加载中的那一帧**。
   *
   *   背景：用户报"加载动画是连成一片的"，而资源中心在本地演示数据下
   *   120ms 就加载完了 —— 骨架屏那 100 多毫秒根本截不到，
   *   于是"改没改好"只能靠读代码猜。给网络加 2 秒延迟就能把它钉住。
   *
   *   用法：{ "throttle": { "latency": 2000, "download": 200000 } }
   *         { "throttle": null }   ← 解除
   */
  if ('throttle' in step) {
    const t = step.throttle;
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: t ? (t.latency ?? 0) : 0,
      downloadThroughput: t ? (t.download ?? -1) : -1,
      uploadThroughput: t ? (t.upload ?? -1) : -1,
    });
    console.log(`  ⇄ 限速：${t ? `${t.latency ?? 0}ms / ${t.download ?? -1} Bps` : '已解除'}`);
  }
  if (step.await) {
    // 等某个选择器出现（限速时比固定 sleep 可靠）
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(step.await)})`,
        returnByValue: true,
      });
      if (r.result?.value) break;
      await sleep(200);
    }
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
