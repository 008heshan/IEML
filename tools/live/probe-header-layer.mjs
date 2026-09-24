/**
 * 真机验证：下载页页头**不再被玻璃糊住**（层叠关系修好）
 * ------------------------------------------------------------------
 * 缺陷原状（用户截图 +「只有下载页的标题栏会被糊住，应该是图层问题」）：
 *   全仓只有下载页渲染 `.page-fill`，而它带 `animation: … both` ——
 *   一带动画它就成了**层叠上下文**，把页头的 `z-index: 20` 关在里面；
 *   固定玻璃层 `.top-glass`（z-index: 5）在它外面 ⇒ 玻璃压到页头之上，
 *   滚动时封面从页头下过，标题连同页头一起被糊掉。
 *
 * 判据（三条，前两条是程序化的，不靠肉眼）：
 *   ① `.page-fill` 不再带动画（外壳不再是层叠上下文）
 *   ② `document.elementsFromPoint(标题中心)`：页头那几层要排在 `.top-glass` **前面**
 *      （列表顺序 = 绘制顺序，越靠前 = 画得越靠上）
 *   ③ 入场动画没丢：下载页的页头/页签、以及别的页面（版本列表）的页头**仍然带动画**
 * 另存一张截图供人眼复核（tmp/verify-header-layer.png）。
 * 用法：node tools/live/probe-header-layer.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9980;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-hl-root');
const OWN = path.join(T, 'ieml-hl-own');
const PROFILE = path.join(T, 'ieml-hl-prof');
const FAKE = path.join(T, 'ieml-hl-appdata');
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

/* ① 别的页面（版本列表）：页头仍然带动画（视觉没被这次改动弄丢） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(1800);
const otherPage = await ev(`(() => {
  const h = document.querySelector('.page-head');
  const s = h ? getComputedStyle(h) : null;
  return { 有页头: !!h, 动画: s ? s.animationName : null, 时长: s ? s.animationDuration : null };
})()`);
console.log('③ 版本列表页头动画：' + JSON.stringify(otherPage));

/* 进下载页 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(1500);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
for (let i = 0; i < 30; i += 1) {
  const n = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (n > 0) break;
  await sleep(1000);
}
await ev(`(async () => {
  const imgs = [...document.querySelectorAll('.pack-card img')];
  await Promise.all(imgs.slice(0, 8).map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
})()`);
await sleep(1000);

/* 滚到"封面正好压在页头下"，并确保玻璃是可见的（这正是出问题的状态） */
await ev(`(() => { const c = document.querySelector('.content'); c.scrollTop = 230; })()`);
await sleep(600);
await ev(`document.documentElement.classList.add('is-scrolled')`);
await sleep(700);

const facts = await ev(`(() => {
  const fill = document.querySelector('.page-fill');
  const head = document.querySelector('.page-head');
  const title = document.querySelector('.page-title');
  const glass = document.querySelector('.top-glass');
  const t = title.getBoundingClientRect();
  /*
   * ★★ 怎么用代码判"谁画在上面"（这条判据的设计说明）：
   *   document.elementFromPoint **会跳过 pointer-events: none 的元素**，
   *   而玻璃层正是 none（它不许挡点击）—— 所以直接测根本看不到它，
   *   我第一版就因此得到一条"碰巧通过"的判据。
   *   这里**临时**把玻璃的 pointer-events 打开，让它参与命中测试：
   *   此时 elementsFromPoint 的顺序就是**绘制顺序**（越靠前 = 画得越靠上）。
   *   测完立刻恢复 —— 只影响这一次量测。
   *   ★ 这段注释在**模板字符串内部**：一律用「」，不许出现反引号（栽过多次）。
   */
  glass.style.pointerEvents = 'auto';
  const order = document.elementsFromPoint(Math.round(t.x + 12), Math.round(t.y + t.height / 2)).map((el) =>
    (el.className || el.tagName).toString().split(' ')[0].slice(0, 24),
  );
  glass.style.pointerEvents = '';
  const idx = (name) => order.findIndex((c) => c === name);
  return {
    'page-fill 动画': fill ? getComputedStyle(fill).animationName : '(没有 .page-fill)',
    '页头 动画': head ? getComputedStyle(head).animationName : null,
    '页签 动画': (() => { const t2 = document.querySelector('.tabs'); return t2 ? getComputedStyle(t2).animationName : null; })(),
    '玻璃 opacity': glass ? getComputedStyle(glass).opacity : null,
    '该点上的绘制顺序（越靠前=越上面）': order,
    '玻璃出现在命中列表里': idx('top-glass') >= 0,
    '页头在玻璃之上': idx('page-head') >= 0 && idx('top-glass') >= 0 && idx('page-head') < idx('top-glass'),
  };
})()`);
console.log('=== 现场事实 ===');
console.log(JSON.stringify(facts, null, 2));

const shotB64 = async () => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 180, y: 0, width: 1050, height: 200, scale: 1 } });
  return r?.result?.data ?? null;
};

const a64 = await shotB64();
if (a64) {
  mkdirSync('tmp', { recursive: true });
  writeFileSync(path.join('tmp', 'verify-header-layer.png'), Buffer.from(a64, 'base64'));
  console.log('截图：tmp/verify-header-layer.png');
}
/* 隐藏玻璃再拍一张 —— 用它做**像素差分**：
   玻璃若真的在页头**之上**，藏掉它页头像素就变了；若页头画在它上面，页头像素几乎不变。 */
await ev(`document.querySelector('.top-glass').style.display = 'none'`);
await sleep(400);
const b64 = await shotB64();
await ev(`document.querySelector('.top-glass').style.display = ''`);
await sleep(300);

let pixel = null;
if (a64 && b64) {
  pixel = await ev(`(async () => {
    /* ★ 不能用 fetch('data:…')：应用 CSP 拦掉了它（Failed to fetch）。
       直接 atob → Blob → createImageBitmap，全程不联网。 */
    const load = async (s) => {
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };
    const [A, B] = await Promise.all([load(${JSON.stringify(a64)}), load(${JSON.stringify(b64)})]);
    const cv = document.createElement('canvas');
    cv.width = A.width;
    cv.height = A.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const scale = A.width / 1050;               // 截图被设备像素比放大过
    const grab = (img, r) => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(Math.round(r.x * scale), Math.round(r.y * scale), Math.max(1, Math.round(r.w * scale)), Math.max(1, Math.round(r.h * scale))).data;
    };
    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x - 180, y: r.y, w: r.width, h: r.height };
    };
    const mad = (r) => {
      if (!r) return null;
      const pa = grab(A, r);
      const pb = grab(B, r);
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      return +(sum / (pa.length / 4) / 3).toFixed(2);
    };
    /* 页头那一条（标题/说明所在的带）与**玻璃带内、页头之外**的一小块（对照：
       那一块的像素完全来自"玻璃 + 它背后被糊的内容"，藏掉玻璃必然大变）。 */
    const headRect = rectOf('.page-head');
    const bandRect = { x: 700 - 180, y: 56, w: 260, h: 70 };
    return {
      '页头区差分': mad(headRect),
      '玻璃带内对照区差分': mad(bandRect),
      '页头 rect': headRect,
      '对照 rect': bandRect,
    };
  })()`);
}
console.log('\n=== 像素差分（隐藏玻璃前后；越小=那一块不受玻璃影响）===');
console.log(JSON.stringify(pixel, null, 2));

console.log('\n===== 判据 =====');
console.log(
  `${facts['page-fill 动画'] === 'none' ? '✓' : '✗'} ① 外壳 .page-fill 不再带动画（不再造层叠上下文）：${JSON.stringify(facts['page-fill 动画'])}`,
);
console.log(
  `${facts['页头在玻璃之上'] ? '✓' : '✗'} ② 页头画在玻璃之上（临时打开玻璃的 pointer-events 量的绘制顺序）：\n     ${JSON.stringify(facts['该点上的绘制顺序（越靠前=越上面）'])}`,
);
const animKept =
  (facts['页头 动画'] ?? 'none') !== 'none' && (otherPage.动画 ?? 'none') !== 'none';
console.log(
  `${animKept ? '✓' : '✗'} ③ 入场动画没丢：下载页页头=${JSON.stringify(facts['页头 动画'])} 页签=${JSON.stringify(facts['页签 动画'])} 版本列表页头=${JSON.stringify(otherPage.动画)}`,
);
if (pixel && !pixel.__err) {
  console.log(
    `\n（参考值，不作判据：页头区像素差分 ${pixel['页头区差分']}、玻璃带内对照区 ${pixel['玻璃带内对照区差分']}）`,
  );
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
