/**
 * 诊断：下载页顶部那条被封面糊掉 —— 到底是谁盖谁？
 * ------------------------------------------------------------------
 * 用户截图 +「只有下载页的标题栏会被糊住，应该是图层问题」。
 *
 * 这个探针做三件事：
 *   ① 进下载页、滚动一点，让卡片封面**滚到页头下面**（复现现场）
 *   ② 量各层的包围盒、z-index、backdrop-filter（谁在谁上面）
 *   ③ **截图**顶部那一条存到 tmp/，人眼再看一遍（图比数字可靠）
 * 用法：node tools/live/diag-download-header.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9984;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-dh-root');
const OWN = path.join(T, 'ieml-dh-own');
const PROFILE = path.join(T, 'ieml-dh-prof');
const FAKE = path.join(T, 'ieml-dh-appdata');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
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
await sleep(800);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE, 'IEML'), { recursive: true });

spawn(EXE, [], {
  env: {
    ...process.env,
    APPDATA: FAKE,
    IEML_DATA_DIR: ROOT,
    IEML_OWN_DIR: OWN,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(400);
}
if (!page) {
  console.error('连不上 CDP');
  process.exit(2);
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

/* 进下载页 → 切到整合包（卡片带封面图） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(1500);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
for (let i = 0; i < 30; i += 1) {
  const n = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (n > 0) break;
  await sleep(1000);
}
await sleep(1500);
/* 等封面图真的加载出来（截图要拍到它们） */
await ev(`(async () => {
  const imgs = [...document.querySelectorAll('.pack-card img')];
  await Promise.all(imgs.slice(0, 8).map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
})()`);
await sleep(1200);

/* 滚动：让封面滚到页头下面（复现"被糊住"） */
await ev(`(() => { const c = document.querySelector('.content'); c.scrollTop = 150; return c.scrollTop; })()`);
await sleep(900);

const geo = await ev(`(() => {
  const one = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      'z-index': s.zIndex,
      position: s.position,
      backdrop: s.backdropFilter || s.webkitBackdropFilter || '(无)',
      background: s.backgroundColor,
      opacity: s.opacity,
    };
  };
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.className || el.tagName).toString().slice(0, 60) : null;
  };
  return {
    '视口': { w: innerWidth, h: innerHeight },
    '--sidebar-w': getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
    '--titlebar-h': getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim(),
    '--z-sticky': getComputedStyle(document.documentElement).getPropertyValue('--z-sticky').trim(),
    '.titlebar': one('.titlebar'),
    '.top-glass': one('.top-glass'),
    '.content': one('.content'),
    '.page-head': one('.page-head'),
    '第一张卡的封面图': one('.pack-card img'),
    '滚动位置': document.querySelector('.content')?.scrollTop,
    /* 从标题栏往下每 20px 取一次"那个点上最顶的元素" */
    '命中测试': [60, 80, 100, 120, 140, 160, 180, 200].map((y) => y + 'px→' + at(700, y)),
  };
})()`);
console.log('=== 各层几何 ===');
console.log(JSON.stringify(geo, null, 2));

/* 截图：顶部那条（含标题栏与页头） */
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width: 1225, height: 260, scale: 1 },
});
if (shot?.result?.data) {
  mkdirSync('tmp', { recursive: true });
  const out = path.join('tmp', 'diag-download-header.png');
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图已存：' + out);
} else {
  console.log('\n截图失败：' + JSON.stringify(shot).slice(0, 200));
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
