/**
 * 真机探针：**WebView2 到底能不能做"真折射"**。
 * ------------------------------------------------------------------
 * 为什么先写它（而不是直接开始写玻璃）：
 *
 *   用户要的"液态玻璃"里，只有第 1 条（边缘折射）和部分第 3 条（色散）**必须**依赖
 *   一个能力：`backdrop-filter` 里引用 **SVG 滤镜**（`url(#f)`），并且该滤镜里能用
 *   `feDisplacementMap` + `feImage` 把**背后的内容**扭曲掉。
 *
 *   这是整个方案的**承重墙**：
 *     · 不行 → 折射只能退化成"叠一层自己画的假边缘"，那是**另一套设计**，
 *              不先问清楚就会写完 800 行 CSS 才发现方向错了；
 *     · 行   → 才值得往上盖三档、色散、厚度。
 *
 *   `CSS.supports()` 说不清这件事的两层：① 它只回答"语法认不认"，
 *   不回答"渲染时真的扭了没有"；② Chromium 对 `backdrop-filter: url()` 的**实现**
 *   与**解析**历史上并不同步。所以判据必须落在**像素**上。
 *
 * 判据（三条）：
 *   ① 能力：WebGL2 有没有、渲染器是谁（软渲染 = 不算）、UA 里的 Windows 版本；
 *   ② 解析：`getComputedStyle(el).backdropFilter` 是不是 `url("#…")`；
 *   ③ ★ **渲染**：同一块背景，滤镜开/关截两张图 —— **图不一样**才算真的扭了。
 *      截图一并落盘，人眼可复核（像素相等只能证明"没变化"，不能证明"扭得对不对"）。
 *
 * 用法：
 *   node tools/live/probe-webview-glass.mjs ["<exe>"]
 *   默认用桌面那份（`%USERPROFILE%\Desktop\IEML.exe`）；截图落在 `%TEMP%\ieml-glass-probe\`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9377;
const EXE = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass-probe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-probe-profile');

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 只收掉**同一个 exe**的残留实例（别碰用户开着的另一份） ---------- */
const ps = (script) =>
  new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('close', () => resolve(out.trim()));
  });
const killSame = () =>
  ps(
    `Get-Process ieml -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/'/g, "''")}' } | Stop-Process -Force`,
  );

/* ---------- 探针场景：条纹背景上盖一块玻璃，三种滤镜各截一张 ---------- */
const SCENE = String.raw`
(() => {
  /* 96×96 的「法线图」：圆角矩形的镜头剖面，R/G 存 x/y 位移（128 = 不动）。
     ★ 现场用 canvas 画再 toDataURL —— 顺带验了 feImage 吃不吃 data: URI。 */
  const N = 96, BAND = 20;
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const hx = N / 2, hy = N / 2, r = 22;
  const sdf = (px, py) => {
    const qx = Math.abs(px) - (hx - r), qy = Math.abs(py) - (hy - r);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5 - hx, py = y + 0.5 - hy;
      const d = -sdf(px, py);                       // >0 = 在形状内部，越大越靠里
      let nx = 0, ny = 0;
      if (d > 0 && d < BAND) {
        const h = 0.5;                              // 数值梯度 = 指向最近边缘的法线
        const gx = sdf(px + h, py) - sdf(px - h, py);
        const gy = sdf(px, py + h) - sdf(px, py - h);
        const len = Math.hypot(gx, gy) || 1;
        const t = Math.pow(1 - d / BAND, 1.4);      // 越靠边越强
        nx = (-gx / len) * t;                       // 负号 = 采样点往**里**拉（放大镜）
        ny = (-gy / len) * t;
      }
      const i = (y * N + x) * 4;
      img.data[i] = 128 + nx * 127;
      img.data[i + 1] = 128 + ny * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const mapURI = cv.toDataURL('image/png');

  /* 内联一份 SVG 滤镜：feImage 取法线图 → feDisplacementMap 扭 SourceGraphic。
     ★ 在 backdrop-filter 里，SourceGraphic 就是**背后的内容**。 */
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('id', 'ieml-probe-svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0';
  const f = document.createElementNS(NS, 'filter');
  f.setAttribute('id', 'ieml-lens-probe');
  f.setAttribute('x', '0'); f.setAttribute('y', '0');
  f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.innerHTML =
    '<feImage href="' + mapURI + '" result="map" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="map" scale="28" xChannelSelector="R" yChannelSelector="G"/>';
  svg.appendChild(f);
  document.body.appendChild(svg);

  /* 背景：条纹 + 文字（扭曲看不看得出来，条纹最直观） */
  const X = 300, Y = 180, W = 420, H = 260;
  const bg = document.createElement('div');
  bg.id = 'probe-bg';
  bg.style.cssText =
    'position:fixed;left:' + X + 'px;top:' + Y + 'px;width:' + W + 'px;height:' + H + 'px;z-index:9998;' +
    'background:repeating-linear-gradient(90deg,#f00 0 10px,#00f 10px 20px,#0f0 20px 30px,#ff0 30px 40px);' +
    'font:700 34px/1.3 system-ui;color:#000;padding:10px;box-sizing:border-box';
  bg.textContent = 'IEML 折射探针 IEML';
  document.body.appendChild(bg);

  const glass = document.createElement('div');
  glass.id = 'probe-glass';
  glass.style.cssText =
    'position:fixed;left:' + (X + 60) + 'px;top:' + (Y + 40) + 'px;width:' + (W - 120) + 'px;height:' + (H - 80) + 'px;' +
    'z-index:9999;border-radius:26px;background:rgba(255,255,255,0.06);pointer-events:none';
  document.body.appendChild(glass);
  window.__probe = glass;
  return {
    ua: navigator.userAgent,
    supportsBlur: CSS.supports('backdrop-filter', 'blur(6px)'),
    supportsUrl: CSS.supports('backdrop-filter', 'url(#ieml-lens-probe)'),
    supportsMaskComposite: CSS.supports('mask-composite', 'exclude'),
    supportsWebkitMaskComposite: CSS.supports('-webkit-mask-composite', 'source-out'),
    mapURIlen: mapURI.length,
  };
})()
`;

const SET_FILTER = (css) => `(() => {
  const g = document.getElementById('probe-glass');
  g.style.backdropFilter = ${JSON.stringify(css)};
  g.style.webkitBackdropFilter = ${JSON.stringify(css)};
  return getComputedStyle(g).backdropFilter || getComputedStyle(g).webkitBackdropFilter;
})()`;

const CAPABILITY = `(() => {
  const out = { webgl2: false, renderer: null, vendor: null, maxTex: null, webgl1: false };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      out.webgl2 = true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      out.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();          // 别给 App 留一个多余的 GL 上下文
    }
    out.webgl1 = !!document.createElement('canvas').getContext('webgl');
  } catch (e) {
    out.error = String(e);
  }
  return out;
})()`;

/* ---------- 起 app + 连 CDP ---------- */
await killSame();
await sleep(800);
const app = spawn(EXE, [], {
  env: {
    ...process.env,
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
  await sleep(500);
}
if (!page) {
  console.error(`连不上 CDP（端口 ${PORT}）—— app 起没起来？`);
  await killSame();
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text, detail: r.result.exceptionDetails };
  return r.result?.result?.value;
};

/* 等界面起来 */
let ready = false;
for (let i = 0; i < 90; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) {
    ready = true;
    break;
  }
  await sleep(500);
}
if (!ready) {
  console.error('界面没起来（等不到 .nav-item）');
  await killSame();
  process.exit(2);
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/* ---------- ① 能力 ---------- */
console.log('① 能力');
const cap = await ev(CAPABILITY);
console.log(`   UA            : ${cap?.webgl2 === undefined ? JSON.stringify(cap) : ''}`);
const uaInfo = await ev('navigator.userAgent');
console.log(`   UA            : ${uaInfo}`);
console.log(`   WebGL1 / 2    : ${cap.webgl1} / ${cap.webgl2}`);
console.log(`   渲染器        : ${cap.renderer ?? '(无)'}  · ${cap.vendor ?? ''}`);
console.log(`   MAX_TEXTURE   : ${cap.maxTex ?? '-'}`);
const soft = /swiftshader|basic render|software|llvmpipe/i.test(String(cap.renderer ?? ''));
check('WebGL2 可用', cap.webgl2 === true, cap.webgl2 ? (soft ? `但看起来是软渲染：${cap.renderer}` : '') : '不可用');

/* ---------- ② 场景 + 解析 ---------- */
console.log('② 解析（CSS 认不认）');
const scene = await ev(SCENE);
if (scene?.__err) {
  console.error(`注入探针场景失败：${scene.__err}`);
  await killSame();
  process.exit(2);
}
console.log(`   法线图 data:URI 长度 ${scene.mapURIlen} 字节`);
check('backdrop-filter: blur() 认', scene.supportsBlur === true);
check('backdrop-filter: url(#f) 认', scene.supportsUrl === true);
console.log(`   mask-composite / -webkit- : ${scene.supportsMaskComposite} / ${scene.supportsWebkitMaskComposite}`);

const clip = { x: 280, y: 160, width: 460, height: 300, scale: 1 };
const shot = async (tag) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  const b64 = r.result?.data ?? '';
  if (b64) writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(b64, 'base64'));
  return b64;
};

const appliedNone = await ev(SET_FILTER('none'));
const none = await shot('1-无滤镜');
const appliedBlur = await ev(SET_FILTER('blur(6px)'));
const blur = await shot('2-只有模糊');
const appliedUrl = await ev(SET_FILTER('blur(6px) url(#ieml-lens-probe)'));
const url = await shot('3-模糊加折射');
const appliedUrlOnly = await ev(SET_FILTER('url(#ieml-lens-probe)'));
const urlOnly = await shot('4-只有折射');
const appliedBad = await ev(SET_FILTER('blur(6px) url(#不存在的滤镜)'));
const bad = await shot('5-坏引用');

console.log(`   none → ${appliedNone}`);
console.log(`   blur → ${appliedBlur}`);
console.log(`   url  → ${appliedUrl}`);
console.log(`   url only → ${appliedUrlOnly}`);
console.log(`   坏引用 → ${appliedBad}`);

/* ---------- ③ 渲染（像素说了算） ---------- */
console.log('③ 渲染（像素）');
check('模糊真的改变了画面', blur !== none && blur.length > 0);
check('★ 折射滤镜真的改变了画面（不是只被解析）', url !== blur && url.length > 0, url === blur ? '与"只有模糊"逐字节相同 = 没渲染' : `${url.length} vs ${blur.length} 字节`);
check('折射单独（不带模糊）也改变画面', urlOnly !== none && urlOnly.length > 0);
check('坏引用不改变画面（反面：说明差异确实来自那个滤镜）', bad === blur || bad === none, bad === blur ? '与模糊相同' : bad === none ? '与无滤镜相同' : '两者都不同 —— 可疑');

console.log(`\n截图目录：${OUT}`);
console.log(`（人眼复核这五张：1 无滤镜 / 2 只有模糊 / 3 模糊+折射 / 4 只有折射 / 5 坏引用）`);

await killSame();
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
