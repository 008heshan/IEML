/**
 * 真机验证：2026-09-22 那四条改造（用户看完截图提的）。
 * ------------------------------------------------------------------
 *  ① 灵动档背景：回到"原来的三团光斑"观感 + 烟雾缭绕
 *  ② 高光：固定光斑元素 + transform（不再用 CSS 变量移动渐变中心）
 *  ③ 顶部液态玻璃：**fixed 层 + 滚动后淡入**，不再是一条大黑底
 *  ④ 前台 GPU / 后台不渲染高级效果
 *
 * 判据都落在"像素 / 计算样式 / 元素几何"上，不靠"我看着对"：
 *  · 顶部玻璃在**顶部时必须看不见**（否则还是那条黑带），滚动后才出现；
 *  · 它的 `backdrop-filter` **真的在糊内容**（摘掉后像素明显不同 ——
 *    这正是 sticky 版本做不到的那件事）；
 *  · 高光：指针靠近 → 光斑元素的 `transform` 与 `opacity` 变；移开 → 归零；
 *    且光斑中心落在"指针到元素矩形的**最近投影点**"上；
 *  · 后台（把窗口最小化，`document.hidden` 真的变 true）：`html.tab-hidden` 挂上、
 *    背景画布不可见、GL 循环停；回到前台全部恢复。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9591;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-r4');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-r4-prof');

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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

/* ---------- Node 侧解 PNG（不依赖页面里的 canvas，也不受 CSP 管） ---------- */
function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * ch;
      const d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = ch >= 3 ? cur[s + 1] : cur[s];
      out[d + 2] = ch >= 3 ? cur[s + 2] : cur[s];
      out[d + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}
function diff(fa, fb) {
  const a = decodePng(readFileSync(fa));
  const b = decodePng(readFileSync(fb));
  let sum = 0;
  let max = 0;
  let bad = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    sum += d;
    n += 1;
    if (d > max) max = d;
    if (d > 6) bad += 1;
  }
  return { mean: sum / n / 3, max, badPct: (bad / n) * 100 };
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
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
  console.error('连不上 CDP');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    errors.push('异常：' + String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0]);
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pend.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const shoot = async (tag, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const f = path.join(OUT, `${tag}.png`);
  if (r.result?.data) writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  return f;
};
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};
const waitApp = async () => {
  for (let i = 0; i < 60; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) return true;
    await sleep(400);
  }
  return false;
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`localStorage.setItem('ieml.vfx','aura')`);
await send('Page.reload', {});
await sleep(2600);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

/* ============ ③ 顶部液态玻璃 ============ */
console.log('=== ③ 顶部液态玻璃 ===');
const topState = () =>
  ev(`(() => {
    const tg = document.querySelector('.top-glass');
    if (!tg) return { err: '没有 .top-glass' };
    const cs = getComputedStyle(tg);
    const r = tg.getBoundingClientRect();
    return {
      isScrolled: document.documentElement.classList.contains('is-scrolled'),
      opacity: cs.opacity,
      backdrop: (cs.backdropFilter || 'none').slice(0, 40),
      pointerEvents: cs.pointerEvents,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      sentinel: !!document.querySelector('.top-glass-sentinel'),
      darkSlab: !!document.querySelector('.page-head') && getComputedStyle(document.querySelector('.page-head'), '::before').content !== 'none',
    };
  })()`);

await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 0; return true; })()`);
await sleep(900);
const atTop = await topState();
console.log('顶部时：' + JSON.stringify(atTop));
check('  存在顶部玻璃层，且不挡点击', atTop.pointerEvents === 'none', String(atTop.pointerEvents));
check('  哨兵已挂（IntersectionObserver 的触发点）', atTop.sentinel === true);
check('★ 页面在**顶部**时玻璃完全透明（不再是那条大黑底）', atTop.opacity === '0' && atTop.isScrolled === false, `opacity=${atTop.opacity} is-scrolled=${atTop.isScrolled}`);
check('★ 页头那层黑底伪元素**已经不存在**', atTop.darkSlab === false);

const topShotAtTop = await shoot('顶部-未滚动', { x: atTop.box[0], y: 0, width: Math.min(900, atTop.box[2]), height: 104, scale: 1 });

await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 420; return c ? c.scrollTop : -1; })()`);
await sleep(1100);
const scrolled = await topState();
console.log('滚动后：' + JSON.stringify(scrolled));
check('★ 滚动之后玻璃**淡入**（opacity 1 + is-scrolled）', scrolled.opacity === '1' && scrolled.isScrolled === true, `opacity=${scrolled.opacity}`);
check('  它挂着真实的 backdrop-filter', String(scrolled.backdrop).includes('blur'), String(scrolled.backdrop));

/* ★★ 2026-09-22 修的真 bug：这块玻璃原来从 y=0 开始铺，压在**标题栏上面**，
   把最小化 / 最大化 / **关闭**按钮与账号胶囊一起糊了。
   用户：「主要是会让关闭键那一行都模糊，这是不可的」。以下三条是它的反向守卫。 */
const titlebarH = await ev(`(() => {
  const tb = document.querySelector('.titlebar');
  return tb ? Math.round(tb.getBoundingClientRect().height) : 48;
})()`);
check(
  '★ 顶部玻璃**不碰标题栏**（几何：它的上边界在标题栏之下）',
  scrolled.box[1] >= titlebarH - 1,
  `玻璃 top=${scrolled.box[1]} · 标题栏高 ${titlebarH}`,
);

/*
 * 像素证据：标题栏那一行，玻璃开 / 关两张必须**几乎一样**。
 * 这是最硬的一条 —— 几何对了但层序错了（玻璃压在上面）时，
 * 只有它会红。
 */
const titleClip = { x: Math.round(scrolled.box[0]), y: 0, width: 900, height: titlebarH, scale: 1 };
await shoot('标题栏-玻璃开', titleClip);
await sleep(600);
await shoot('标题栏-玻璃开-复测', titleClip); // 用来量"背景自己在动"造成的噪声
/*
 * ★ 这里**自带一张独立样式表**做探针，而不是复用后面的 setProbe ——
 *   那个函数在这段代码之后才定义（第一版就是因此报
 *   "Cannot access 'setProbe' before initialization"）。
 */
await ev(`(() => {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.__titleProbe = sheet;
  return true;
})()`);
const setTitleProbe = async (css) => {
  await ev(
    '(() => { const s = window.__titleProbe; while (s.cssRules.length) s.deleteRule(0); ' +
      (css ? 's.insertRule(' + JSON.stringify(css) + ', 0); ' : '') +
      'return s.cssRules.length; })()',
  );
  await sleep(520);
};
await setTitleProbe('.top-glass{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;background-image:none !important}');
await shoot('标题栏-玻璃关', titleClip);
await setTitleProbe('');
const titleNoise = diff(path.join(OUT, '标题栏-玻璃开.png'), path.join(OUT, '标题栏-玻璃开-复测.png'));
const titleSignal = diff(path.join(OUT, '标题栏-玻璃开.png'), path.join(OUT, '标题栏-玻璃关.png'));
console.log(
  `  标题栏那一行：噪声(同状态相隔 600ms) ${titleNoise.mean.toFixed(3)} · 信号(玻璃开/关) ${titleSignal.mean.toFixed(3)}`,
);
/*
 * ★ 判据用**信号 vs 噪声**，不是写死一个绝对值 ——
 *   这块区域背后是**自己在动的烟雾**（灵动档），相隔几百毫秒的两次截图本来就不一样。
 *   第一版写 `< 0.5` 于是被噪声顶红（实测 0.516 全是噪声）。
 *   真正要证的是："关掉玻璃"带来的变化**不比噪声更大** ——
 *   也就是说这块区域**没有**被玻璃糊过。
 */
check(
  '★ 标题栏那一行**不受顶部玻璃影响**（信号不超过噪声 3 倍）',
  titleSignal.mean <= Math.max(0.6, titleNoise.mean * 3),
  `信号 ${titleSignal.mean.toFixed(3)} vs 噪声 ${titleNoise.mean.toFixed(3)}`,
);

const topShotScrolled = await shoot('顶部-滚动后', { x: scrolled.box[0], y: 0, width: Math.min(900, scrolled.box[2]), height: 104, scale: 1 });

/* 关键：证明这块 fixed 层**真的在糊内容**（这是 sticky 版本做不到的） */
await ev(`(() => {
  const s = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  window.__probe = s;
  return true;
})()`);
const setProbe = async (css) => {
  await ev(
    '(() => { const s = window.__probe; while (s.cssRules.length) s.deleteRule(0); ' +
      (css ? 's.insertRule(' + JSON.stringify(css) + ', 0); ' : '') +
      'return s.cssRules.length; })()',
  );
  await sleep(450);
};
await shoot('顶部-玻璃开', { x: scrolled.box[0], y: 0, width: 900, height: 104, scale: 1 });
await setProbe('.top-glass{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}');
const offState = await ev(`getComputedStyle(document.querySelector('.top-glass')).backdropFilter`);
await shoot('顶部-玻璃关', { x: scrolled.box[0], y: 0, width: 900, height: 104, scale: 1 });
await setProbe('');
const topFrost = diff(path.join(OUT, '顶部-玻璃开.png'), path.join(OUT, '顶部-玻璃关.png'));
console.log(`  摘掉模糊后：平均差 ${topFrost.mean.toFixed(3)} · 最大 ${topFrost.max} · 明显变化 ${topFrost.badPct.toFixed(2)}%`);
check('  注入生效（回读到 none）', String(offState) === 'none', String(offState));
check('★ 顶部玻璃的模糊**真的在糊滚动内容**（摘掉后像素明显不同）', topFrost.mean > 1, `平均差 ${topFrost.mean.toFixed(2)}`);

/* ============ ② 指针高光：2026-09-22（第五轮）已按用户要求整体删除 ============
 *
 * 这一节原来验的是"光斑元素跟手 / 钳投影 / 远离熄灭"。
 * 用户看完实机说「还有去除指针高光」——实现删了，判据也跟着换成**反向守卫**：
 *   · DOM 里不许再有任何光斑/边缘环元素（连令牌都不许剩）；
 *   · 鼠标从角落移到卡片上，**画面必须基本不动**（行为层的证据：
 *     万一以后谁又用别的方式把它加回来，这条会红）。
 */
console.log('\n=== ② 指针高光应当整体消失 ===');
const glowGone = await ev(`(() => ({
  glow: document.querySelectorAll('.glass-glow').length,
  spot: document.querySelectorAll('.glass-glow-spot').length,
  edge: document.querySelectorAll('.glass-edge').length,
  hover: document.querySelectorAll('[data-hover]').length,
  cssGlowVar: getComputedStyle(document.documentElement).getPropertyValue('--glow-rx').trim(),
}))()`);
console.log('  ' + JSON.stringify(glowGone));
check('★ 没有光斑元素（DOM 里一个都不剩）', glowGone.glow === 0 && glowGone.spot === 0 && glowGone.edge === 0);
check('  没有 data-hover 残留', glowGone.hover === 0, String(glowGone.hover));
check('  高光的 CSS 令牌也删了', glowGone.cssGlowVar === '', `--glow-rx="${glowGone.cssGlowVar}"`);

await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 300; return true; })()`);
await sleep(900);
await ev(`(() => {
  const box = document.querySelector('.content') || document.scrollingElement;
  const fits = (x) => {
    const r = x.getBoundingClientRect();
    return r.width > 240 && r.height < (window.innerHeight || 800) - 200;
  };
  const target = [...document.querySelectorAll('.glass-refract')].find(fits);
  if (!target) return null;
  // ★ 先把目标滚进视口（新增的主题九宫格把卡片撑高了，不能假设它已经在视野里）
  const before = target.getBoundingClientRect();
  box.scrollTop += Math.round(before.top) - 170;
  return true;
})()`);
await sleep(900);
const hiClip = await ev(`(() => {
  const c = [...document.querySelectorAll('.glass-refract')].find((x) => {
    const r = x.getBoundingClientRect();
    return r.width > 240 && r.top > 120 && r.bottom < (window.innerHeight || 800) - 20;
  });
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };
})()`);
if (hiClip) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' });
  await sleep(600);
  const hiA = await shoot('高光-指针在角落', hiClip);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: hiClip.x + Math.round(hiClip.width / 2),
    y: hiClip.y + Math.round(hiClip.height / 2),
    button: 'none',
  });
  await sleep(600);
  const hiB = await shoot('高光-指针在卡片上', hiClip);
  const hiMoved = diff(hiA, hiB);
  console.log(`  指针从角落移到卡片上：画面平均差 ${hiMoved.mean.toFixed(3)}`);
  check('★ 移动指针不再改变画面（高光确实没了）', hiMoved.mean < 1.5, `平均差 ${hiMoved.mean.toFixed(3)}`);
} else {
  check('找得到一块可测的卡片', false, '没有合适目标');
}

/* ============ ④ 后台不渲染高级效果 ============ */
console.log('\n=== ④ 前台 GPU / 后台停渲染 ===');
const bgState = () =>
  ev(`(() => {
    const gl = document.querySelector('canvas.glass-ambient-gl');
    return {
      hidden: document.hidden,
      tabHidden: document.documentElement.classList.contains('tab-hidden'),
      glExists: !!gl,
      glVisibility: gl ? getComputedStyle(gl).visibility : null,
      glPausedAnim: gl ? getComputedStyle(gl).animationPlayState : null,
    };
  })()`);
const before = await bgState();
console.log('  前台：' + JSON.stringify(before));
check('  前台：没有 tab-hidden、背景画布可见', before.tabHidden === false && before.glVisibility !== 'hidden', JSON.stringify(before));

const win = (await send('Browser.getWindowForTarget', {})).result?.windowId;
await send('Browser.setWindowBounds', { windowId: win, bounds: { windowState: 'minimized' } });
await sleep(1600);
const hiddenState = await bgState();
console.log('  最小化后：' + JSON.stringify(hiddenState));
check('★ 后台时 `document.hidden` 真的为真（这一条不是模拟的）', hiddenState.hidden === true, String(hiddenState.hidden));
check('★ 后台：挂了 tab-hidden（CSS 动画全暂停）', hiddenState.tabHidden === true);
check('★ 后台：背景画布不可见（不再全屏合成）', hiddenState.glVisibility === 'hidden', String(hiddenState.glVisibility));

await send('Browser.setWindowBounds', { windowId: win, bounds: { windowState: 'normal' } });
await sleep(1600);
const backState = await bgState();
console.log('  恢复后：' + JSON.stringify(backState));
check('★ 回前台：tab-hidden 摘掉、画布回来', backState.tabHidden === false && backState.glVisibility !== 'hidden', JSON.stringify(backState));
check('  全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));

/* ============ ① 灵动档背景（截图给人看 + 至少证明 GL 在跑） ============ */
console.log('\n=== ① 灵动档背景 ===');
await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 0; return true; })()`);
await sleep(900);
const bg1 = await shoot('背景-1');
await sleep(1200);
const bg2 = await shoot('背景-2');
/*
 * ★★ 先验"画布铺满视口" —— 2026-09-22 的真 regression 就出在这里：
 *   为了省显存把 backing store 降到 0.6 倍，结果 canvas 作为**替换元素**
 *   布局尺寸退回了 width 属性值，只在窗口左上角铺了一块（右下角没有背景）。
 *   "画布变小"和"画的东西变小"是两件事，必须分开断言。
 */
const canvasBox = await ev(`(() => {
  const c = document.querySelector('canvas.glass-ambient-gl');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { box: [Math.round(r.width), Math.round(r.height)], backing: [c.width, c.height], view: [window.innerWidth, window.innerHeight] };
})()`);
console.log('  背景画布：盒子 ' + JSON.stringify(canvasBox?.box) + ' · backing ' + JSON.stringify(canvasBox?.backing) + ' · 视口 ' + JSON.stringify(canvasBox?.view));
check(
  '★ 背景画布**铺满视口**（backing 可以小，盒子不能小）',
  canvasBox !== null &&
    canvasBox.box[0] >= canvasBox.view[0] - 2 &&
    canvasBox.box[1] >= canvasBox.view[1] - 2,
  JSON.stringify(canvasBox),
);
check(
  '  backing store 确实比视口小（省显存的初衷）',
  canvasBox !== null && canvasBox.backing[0] < canvasBox.view[0],
  JSON.stringify(canvasBox?.backing),
);

const bgAlive = diff(bg1, bg2);
console.log(`  1.2 秒后两张背景的差：平均 ${bgAlive.mean.toFixed(3)}`);
check('  背景在动（烟雾+光斑是活的）', bgAlive.mean > 0.05, `平均差 ${bgAlive.mean.toFixed(3)}`);

console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
