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

/* ============ ② 高光：固定光斑元素 + transform ============ */
console.log('\n=== ② 指针高光 ===');
// ★ 先把滚动位置调好：上一段把内容滚到了 420，卡片会跑到视口上方去 ——
//   那样算出来的指针坐标是负数，鼠标事件根本落不到卡片上（测出来"不跟手"是假的）。
await ev(`(() => {
  const c = document.querySelector('.content');
  const card = [...document.querySelectorAll('.glass-refract')].find((x) => x.getBoundingClientRect().width > 240);
  if (c && card) {
    const r = card.getBoundingClientRect();
    c.scrollTop += Math.round(r.top) - 220;   // 把这块卡片挪到视口里偏上的位置
  }
  return c ? c.scrollTop : -1;
})()`);
await sleep(900);

const glowState = () =>
  ev(`(() => {
    const card = [...document.querySelectorAll('.glass-refract')].find((c) => {
      const r = c.getBoundingClientRect();
      // 必须**整块都在视口里**，否则算出来的指针坐标会落到窗口外
      return r.width > 240 && r.top > 120 && r.bottom < (window.innerHeight || 800) - 20;
    });
    if (!card) return { err: '没有卡片' };
    const g = card.querySelector('.glass-glow');
    const spot = card.querySelector('.glass-glow-spot');
    const edge = card.querySelector('.glass-edge');
    const r = card.getBoundingClientRect();
    return {
      hasGlow: !!g,
      hasSpot: !!spot,
      hasEdge: !!edge,
      spotTransform: spot ? spot.style.transform : null,
      spotOpacity: spot ? spot.style.opacity : null,
      edgeOpacity: edge ? edge.style.opacity : null,
      hasDataHover: card.hasAttribute('data-hover'),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      cssVarGone: getComputedStyle(card).getPropertyValue('--glass-gx').trim() === '',
    };
  })()`);

const g0 = await glowState();
console.log('  初始：' + JSON.stringify(g0));
check('★ 卡片里真的有光斑元素（不是靠 CSS 变量了）', g0.hasGlow === true && g0.hasSpot === true && g0.hasEdge === true);
check('★ 旧的 `--glass-gx` 变量已经不在了（换写法了）', g0.cssVarGone === true);
check('  没指针时是灭的', g0.spotOpacity === '0' || g0.spotOpacity === '', `opacity=${g0.spotOpacity}`);

const [bx, by, bw, bh] = g0.box;
const movePointer = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' });
  await sleep(350);
};

await movePointer(bx + bw * 0.3, by + bh * 0.4);
const g1 = await glowState();
await movePointer(bx + bw * 0.75, by + bh * 0.7);
const g2 = await glowState();
console.log('  指针左上：' + JSON.stringify({ t: g1.spotTransform, o: g1.spotOpacity }));
console.log('  指针右下：' + JSON.stringify({ t: g2.spotTransform, o: g2.spotOpacity }));
check('★ 光斑跟手（两次 transform 不同且都亮着）', g1.spotTransform !== g2.spotTransform && Number(g2.spotOpacity) > 0, `${g1.spotTransform} → ${g2.spotTransform}`);
check('  边缘环与光斑同步点亮', Number(g2.edgeOpacity) > 0, String(g2.edgeOpacity));

// 指针移到卡片外但靠近：应当**仍然亮**，且光心压在最近的那条边上
await movePointer(bx + bw * 0.5, by - 30);
const g3 = await glowState();
console.log('  指针在卡片外 30px：' + JSON.stringify({ t: g3.spotTransform, o: g3.spotOpacity }));
check('★ 指针在元素外但靠近时仍然泛光（钳投影那一条）', Number(g3.spotOpacity) > 0, `opacity=${g3.spotOpacity}`);

// 移到很远：应当熄灭
await movePointer(bx - 600, by + 400);
await sleep(300);
const g4 = await glowState();
check('★ 指针远离后熄灭', Number(g4.spotOpacity) === 0, `opacity=${g4.spotOpacity}`);

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
