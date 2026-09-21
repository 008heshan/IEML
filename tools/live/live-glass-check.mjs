/**
 * 真机验证：**液态玻璃**三档（弱化 / 适中 / 灵动）+ 五要素是否真的在生效。
 * ------------------------------------------------------------------
 * 用户 2026-09-21：「我想要真实的液态玻璃」+ 五条（边缘折射 / 动态高光 / 色散边缘 /
 * 厚度感 / 内容适应性）+「视效也要三档」+「win7 或显卡不支持 WebGL 2.0 时默认适中，
 * 并且不开放灵动视效」。
 *
 * ## 为什么这条必须是真机断言（而不是"我看代码写对了"）
 *
 *   五条要求里有四条**只有在合成器里才成立**：
 *     · 折射 = `backdrop-filter` 里挂 SVG 滤镜，**解析成功 ≠ 渲染出来**
 *       （探针 `probe-webview-glass.mjs` 用像素差证明过这条，但那是探针样张；
 *        真实界面上装没装上，得在这里看）；
 *     · 色散 / 厚度 / 高光 = 多层 `background-image` 的**最终合成**，
 *       任何一条被后面的规则覆盖掉，代码里完全看不出来；
 *     · 内容适应 = JS 每块玻璃按位置算出的 `--glass-tint`，
 *       "算出来了"和"取到的是不同颜色"是两件事（取成同一个值 = 没适应）。
 *
 * ## 判据（每档各一组）
 *
 *   灵动：`data-vfx=aura` · `data-vfx-lens=on` · GL 画布在 · 卡片真的挂着 `url(#…)`
 *         折射滤镜 · 色散/厚度/高光三层渐变都在 · 两块不同位置的卡片**取到不同颜色**
 *   适中：不起 GL，但（这台机器够格时）折射仍在 —— 折 weak 与 aura 之间那一档
 *   弱化：`backdrop-filter: none`、无折射滤镜、无 GL
 *
 * 用法：
 *   node tools/live/live-glass-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`（开发版）；截图落在 `%TEMP%\ieml-glass/`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const PORT = 9388;
const EXE =
  process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-profile');

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);

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
  if (r.result?.exceptionDetails) {
    return { __err: r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

const waitApp = async () => {
  for (let i = 0; i < 90; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) return true;
    await sleep(400);
  }
  return false;
};
const waitCards = async (n = 2) => {
  for (let i = 0; i < 60; i += 1) {
    const c = await ev(`document.querySelectorAll('.glass').length`);
    if (typeof c === 'number' && c >= n) return c;
    await sleep(400);
  }
  return 0;
};

/** 打开设置页（卡片最多的一页） */
const goto = async (label) => {
  await ev(`(() => {
    const items = [...document.querySelectorAll('.nav-item')];
    const hit = items.find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
    if (hit) hit.click();
    return !!hit;
  })()`);
  await sleep(1200);
};

if (!(await waitApp())) {
  console.error('界面没起来');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
}

/** 切换档位：写 localStorage + 重新加载（模拟"用户改档后重启"） */
const setLevel = async (level) => {
  await ev(`localStorage.setItem('ieml.vfx', ${JSON.stringify(level)})`);
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  if (!(await waitApp())) throw new Error('重载后界面没起来');
  await goto('设置');
  await waitCards(3);
  await sleep(600); // 等取色那一轮 rAF
};

/** 采集当前档位的现场 */
const snapshot = () =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.glass-refract')];
    const card = cards.find((c) => c.getBoundingClientRect().width > 200) || cards[0];
    const bg = card ? getComputedStyle(card) : null;
    const lens = cards.filter((c) => c.dataset.lens);
    const gl = document.querySelector('canvas.glass-ambient-gl');
    const ph = document.querySelector('.page-head');
    const tints = cards.slice(0, 8).map((c) => ({
      tint: c.style.getPropertyValue('--glass-tint').trim(),
      box: (() => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })(),
    }));
    /*
     * ★ 判据要**拿这块玻璃真正用的那个颜色**去比对，而且要比对**完整**的
     *   background-image —— 三层坑都踩过（每一条都是实测撞出来的）：
     *     ① 只查 'rgb(' 会漏（旧写法序列化成 rgba(…)，字符串里没有 'rgb('）；
     *     ② 只查前 300 个字符也会漏 —— 调色层是**最后一层**；
     *     ③ 序列化形式**两种都可能**：Chromium 153 对 rgb(r g b / a) 这种输入
     *        会原样保留现代语法 rgb(25 16 43 / 0.12)，不是 rgba(25, 16, 43, …)。
     *   所以用**正则容忍两种**，别写死字符串。
     */
    const tint = card ? card.style.getPropertyValue('--glass-tint').trim() : '';
    const nums = tint.split(/\\s+/).filter(Boolean);
    const tintInPaint = nums.length === 3 && bg
      ? new RegExp('rgba?\\\\(\\\\s*' + nums.join('[,\\\\s]+') + '\\\\b').test(bg.backgroundImage)
      : false;
    return {
      level: document.documentElement.dataset.vfx,
      lensAttr: document.documentElement.dataset.vfxLens,
      glAttr: document.documentElement.dataset.vfxGl ?? null,
      surfaces: document.querySelectorAll('.glass, .page-head').length,
      refract: cards.length,
      withLens: lens.length,
      lensId: lens[0]?.dataset.lens ?? null,
      backdrop: bg ? (bg.backdropFilter || bg.webkitBackdropFilter) : null,
      bgTail: bg ? bg.backgroundImage.slice(-160) : null,
      /*
       * ④ 厚度与 ③ 色散现在都走**内阴影**（box-shadow），不是渐变层 ——
       * 真机实测：三个装饰渐变层每帧多吃 9ms（5 层 24.7ms → 2 层 15.6ms）。
       * 所以判据也要跟着改，否则会拿旧实现去验新代码。
       */
      boxShadow: bg ? bg.boxShadow : null,
      /*
       * ★ 判据要按**浏览器实际序列化**的样子写：
       *   Chromium 把「inset 0 0 26px -14px rgba(...)」输出成
       *   「rgba(255, 255, 255, 0.23) 0px 0px 26px -14px inset」——颜色在前、inset 在后。
       *   （第一版按源码顺序查「inset 0px 0px 26px」→ 永远查不到 → 误报"厚度层不在"。）
       * ★ 另外：这个函数体是**模板字符串**，注释里**不许出现反引号**（会提前结束字符串，
       *   报错还指向别处 —— 这个坑我在这一个文件里踩了两次）。
       */
      hasRim: bg ? String(bg.boxShadow).includes('0px 0px 26px -14px') : false,
      hasDisp: bg ? String(bg.boxShadow).includes('rgba(255, 64, 64') : false,
      tintInPaint,
      phBackdrop: ph ? (getComputedStyle(ph, '::before').backdropFilter || 'none') : null,
      glCanvas: gl ? [gl.width, gl.height] : null,
      tints,
      distinctTints: new Set(tints.map((t) => t.tint)).size,
      gx: card ? getComputedStyle(card).getPropertyValue('--glass-gx').trim() : null,
    };
  })()`);

/**
 * 背景区域截图（**侧栏底部那块空地**）—— 用来判"灵动档的流体背景到底画出来没有"：
 * 这块区域上没有玻璃，两张图不同就说明背景层真的换了实现。
 */
const bgClip = () =>
  ev(`(() => {
    const h = window.innerHeight || 800;
    return { x: 8, y: Math.max(0, h - 150), width: 170, height: 120, scale: 1 };
  })()`);

/**
 * 帧时间：**先热身一轮再量**，报平均 / p95 / 掉帧数。
 *
 * ★★ 为什么要热身（实测踩到，不然数据虚高一倍）：
 *   第一次连续滚动会带上"第一次画这层玻璃"的成本 —— 着色器编译、
 *   合成层提升、SVG 滤镜首次栅格化。直接量到的是 **24ms**，
 *   而同一屏第二次量是 **11ms**。拿前者当结论会得出"液态玻璃很卡"的
 *   错误结论，进而去做一堆没必要的优化（我差点就这么干了）。
 */
const frameTimes = () =>
  ev(`(async () => {
    const box = document.querySelector('.content') || document.scrollingElement;
    const pass = (frames) =>
      new Promise((res) => {
        const times = [];
        let last = performance.now();
        let n = 0;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          box.scrollTop += 26;
          if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) box.scrollTop = 0;
          n += 1;
          if (n < frames) requestAnimationFrame(step);
          else res(times);
        };
        requestAnimationFrame(step);
      });
    await pass(120);              // ← 热身 1：把"第一次画这层玻璃"的成本吃掉
    await pass(120);              // ← 热身 2：让合成器把整页内容都栅格化过一遍
    return await pass(120);       // ← 这一轮才算数
  })()`);

/**
 * 把折射（`url(#…)`）拿掉、只留模糊 —— 用来**单独量折射的代价**。
 *
 * ★ 注入通道必须走 CSSOM（`insertRule`），不能用 `<style>` 元素：
 *   后者受 CSP `style-src` 管，会被静默拦掉（我第一次的五个用例全同就是这么来的）。
 * ★ `insertRule` 一次只收**一条**规则，不能把两条拼成一个字符串。
 */
const setLensDisabled = (disabled) =>
  ev(`(() => {
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    if (!s) return 'no-sheet';
    for (let i = s.cssRules.length - 1; i >= 0; i -= 1) {
      if ((s.cssRules[i].cssText || '').includes('probe-no-lens')) s.deleteRule(i);
    }
    if (${disabled}) {
      s.insertRule('.glass{backdrop-filter:blur(13px) saturate(1.5) !important} /* probe-no-lens */', s.cssRules.length);
    }
    const c = document.querySelector('.glass-refract');
    return c ? (getComputedStyle(c).backdropFilter || '') : 'no-card';
  })()`);

/**
 * 截图 → 落盘，并返回**文件路径**（pixelDiff 要按路径读文件自己解 PNG）。
 * ★ 早先这里返回的是字节**长度**：长度相同 ≠ 内容相同 —— 两张不同的图凑巧
 *   字节数一样就误报成"没动"（踩过一次）。
 */
const shoot = async (tag, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const b64 = r.result?.data ?? '';
  if (!b64) return '';
  const file = path.join(OUT, `${tag}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
};

/**
 * 逐像素比较两张截图 —— **在 Node 里自己解 PNG**。
 *
 * ★ 为什么不用"哈希是否相同"：活界面上总有东西在动（取色重算、提示条、滚动条淡出），
 *   "逐字节相同"这条前提太脆 —— 两张肉眼一模一样的图能差 9KB。
 *   改成量**信号 vs 噪声**：平均差 / 最大差 / 明显变化的像素占比 / 差异落在哪块。
 *
 * ★ 为什么不在页面里用 canvas 比（试过，三个坑全踩了）：
 *   ① 两张 20 万像素的图 base64 塞进一次 Runtime.evaluate（约 400KB）→ CDP 直接卡死；
 *   ② 页面里 new Image() 加载 data URL **被 CSP 拦**（img-src 不含 data:）→ onerror；
 *   ③ 只写 onload 不写 onerror → Promise 永不 settle → awaitPromise 一直等。
 *   在 Node 里解 PNG 没有这些问题：没有 CSP、没有 payload、不可能挂起。
 */
function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) throw new Error('不是 PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描的 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位色深');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = channels >= 3 ? cur[s + 1] : cur[s];
      out[d + 2] = channels >= 3 ? cur[s + 2] : cur[s];
      out[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** 两张 PNG 的像素差（平均 / 最大 / 明显变化的占比 / 区域） */
function pixelDiff(fileA, fileB) {
  const a = decodePng(readFileSync(fileA));
  const b = decodePng(readFileSync(fileB));
  if (a.width !== b.width || a.height !== b.height) return { err: '尺寸不一致' };
  let sum = 0;
  let max = 0;
  let bad = 0;
  let n = 0;
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    sum += d;
    n += 1;
    if (d > max) max = d;
    if (d > 6) {
      bad += 1;
      const p = i / 4;
      const x = p % a.width;
      const y = (p / a.width) | 0;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { mean: sum / n / 3, max, badPct: (bad / n) * 100, box: x1 < 0 ? null : [x0, y0, x1, y1], w: a.width, h: a.height };
}


/* ★★ 造一个"只差一个位移"的对照滤镜：**克隆真滤镜、把 scale 设成 0**。
   早先用单个 feOffset 当"恒等"，结果它会让整条 backdrop-filter 失效
   （实测与"完全关掉"的像素差一模一样），量到的其实是"磨砂开关"而不是折射。 */
const makeZeroLens = () => `(() => {
  const real = document.querySelector('#ieml-lens-defs filter');
  if (!real) return 'no-real-filter';
  const clone = real.cloneNode(true);
  clone.id = 'ieml-lens-zero';
  const disp = clone.querySelector('feDisplacementMap');
  if (disp) disp.setAttribute('scale', '1');
  real.parentNode.appendChild(clone);
  return 'ok';
})()`;

const lensAB = async (selector, tag, clip) => {
  /*
   * 先把「内容适应取色」钉住：它按元素位置与背景重算，页面有任何 DOM 变动就更新
   * （设计如此），会污染像素比对。
   */
  await ev(`(() => {
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    window.__pinIdx = s.cssRules.length;
    s.insertRule('.glass,.page-head{--glass-tint:22 22 26 !important;--glass-lum:0.2 !important}', s.cssRules.length);
    return true;
  })()`);
  await sleep(150);
  const n1 = await shoot(tag + '-1-基线', clip);
  await sleep(150);
  const n2 = await shoot(tag + '-2-基线复测', clip);
  await ev(makeZeroLens());
  const swap = await ev(`(() => {
    const SEL = ${JSON.stringify('.glass-refract')};
    const c = document.querySelector(${JSON.stringify('.glass-refract')});
    if (!c) return { err: '找不到目标' };
    const cur = getComputedStyle(c).backdropFilter || '';
    const swapped = cur.replace(/url\\("#[^"]*"\\)/, 'url("#ieml-lens-zero")');
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    window.__noopIdx = s.cssRules.length;
    s.insertRule(SEL + '{backdrop-filter:' + swapped + ' !important}', s.cssRules.length);
    return { cur: cur.slice(0, 58), swapped: swapped.slice(0, 58) };
  })()`);
  await sleep(150);
  const l1 = await shoot(tag + '-3-恒等滤镜', clip);
  await ev(`(() => {
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    if (typeof window.__noopIdx === 'number') s.deleteRule(window.__noopIdx);
    return true;
  })()`);
  await sleep(150);
  const r1 = await shoot(tag + '-4-恢复', clip);
  await ev(`(() => {
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    if (typeof window.__pinIdx === 'number') s.deleteRule(window.__pinIdx);
    return true;
  })()`);
  await sleep(150);
  const restored = await ev(`(() => {
    const m = document.querySelector('.modal');
    return m ? (getComputedStyle(m).backdropFilter || '') : '';
  })()`);
  return { n1, n2, l1, r1, swap, restored: String(restored), noise: pixelDiff(n1, n2), signal: pixelDiff(n1, l1) };
};

const cardClip = async () => {
  const box = await ev(`(() => {
    const c = [...document.querySelectorAll('.glass-refract')].find((x) => x.getBoundingClientRect().width > 240);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(420, r.width + 16), height: Math.min(300, r.height + 16) };
  })()`);
  return box ? { ...box, scale: 2 } : null;
};

const report = (s, perf) => {
  const arr = Array.isArray(perf) ? perf.slice(2) : [];
  const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] ?? 0 : 0;
  const drops = arr.filter((t) => t > 33).length;
  console.log(
    `   帧时间 平均 ${avg.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms · >33ms 的帧 ${drops}/${arr.length}`,
  );
  console.log(`   玻璃面 ${s.surfaces} 个（其中参与折射 ${s.refract} 个，已装透镜 ${s.withLens} 个）`);
  console.log(`   取色 ${s.distinctTints} 种：${s.tints.slice(0, 4).map((t) => `[${t.box[0]},${t.box[1]}] rgb(${t.tint})`).join(' ')}`);
  console.log(`   backdrop-filter: ${String(s.backdrop).slice(0, 90)}`);
  console.log(`   GL 画布: ${s.glCanvas ? `${s.glCanvas[0]}×${s.glCanvas[1]}` : '（无）'}`);
  return { avg, p95, drops };
};

/* ====================== 灵动档 ====================== */
console.log('=== 灵动视效（aura）===');
await setLevel('aura');
const aura = await snapshot();
const auraPerf = await frameTimes();
const auraPerfStat = report(aura, auraPerf);
const auraClip = await cardClip();
await shoot('aura-全窗');
if (auraClip) await shoot('aura-卡片特写', auraClip);
const auraBg = await shoot('aura-背景区', await bgClip());
const auraBg2 = await (async () => {
  await sleep(1500);
  return shoot('aura-背景区-1.5秒后', await bgClip());
})();

check('档位属性 = aura', aura.level === 'aura', String(aura.level));
check('折射能力标记 = on', aura.lensAttr === 'on', String(aura.lensAttr));
check('★ 卡片真的挂着折射滤镜 url(#…)', String(aura.backdrop).includes('url("#ieml-lens-'), String(aura.lensId ?? '无'));
check('折射滤镜注册了不止一块玻璃', aura.withLens >= 2, `${aura.withLens} 块`);
check('④ 厚度层（内缘辉光）在', aura.hasRim === true, String(aura.boxShadow).slice(0, 60));
check('③ 色散边缘（红/蓝错位内阴影）在', aura.hasDisp === true);
check('⑤ 内容调色层在（用的就是这块玻璃那一份色）', aura.tintInPaint === true, String(aura.tints[0]?.tint ?? ''));
check('★ 不同位置的玻璃取到**不同**颜色（内容适应性真的在动）', aura.distinctTints >= 2, `${aura.distinctTints} 种`);
check('② 高光位置有值', /%/.test(String(aura.gx)), String(aura.gx));
check('★ 标题条的磨砂**永远不许消失**（它不依赖任何变量）', String(aura.phBackdrop).includes('blur'), String(aura.phBackdrop));
check('GL 流体背景起了', aura.glCanvas !== null && aura.glCanvas[0] > 100, aura.glCanvas ? `${aura.glCanvas[0]}×${aura.glCanvas[1]}` : '无');
const bgAlive = pixelDiff(auraBg, auraBg2);
check(
  '★ GL 背景在动（1.5 秒后那两张的像素真的有差）',
  !bgAlive.err && bgAlive.mean > 0.1,
  bgAlive.err ? bgAlive.err : `平均差 ${bgAlive.mean.toFixed(2)}`,
);

/* ---------- 折射的**单独**代价：同一屏，只把 url(#…) 摘掉再量一次 ---------- */
const noLensAfter = await setLensDisabled(true);
const auraNoLens = await frameTimes();
const noLensStat = report({ ...aura, backdrop: noLensAfter, surfaces: aura.surfaces }, auraNoLens);
await setLensDisabled(false);
console.log(
  `   → 折射让它多花 ${(auraPerfStat.avg - noLensStat.avg).toFixed(1)}ms/帧（平均 ${auraPerfStat.avg.toFixed(1)} → ${noLensStat.avg.toFixed(1)}）`,
);
check('帧时间没有明显掉帧（p95 < 40ms）', auraPerfStat.p95 < 40, `p95 ${auraPerfStat.p95.toFixed(1)}ms`);

/* ---------- ★★ 折射的**应用内**像素证据（要求①最硬的一条） ---------- */
/*
 * 这一条是第三轮才立起来的，因为**前两轮它测不出来**：
 *   · 第一轮背景是平滑渐变 → 折射没东西可弯，"真滤镜 vs 恒等滤镜"的差
 *     **小于同状态噪声**（5.83 vs 5.83）；
 *   · 这一轮背景加了 ~70px 尺度的慢流场（比 blur 核粗，模糊留得住），
 *     折射才终于进入可测范围（实测噪声 0.49 / 信号 1.19、明显变化像素 0.63% vs 10.6%）。
 * 判据因此写成**信号 vs 噪声的倍率**，而不是"两张图不一样"——
 * 后者在有动画的背景上永远成立，等于没验。
 */
/*
 * ★★ 为什么这里**不再**做"真滤镜 vs 恒等滤镜"的像素对照（这是量出来的结论）：
 *
 *   在**灵动档**里，背景（GL 流场）自己是活的 —— 同一状态连截两张、间隔压到 150ms，
 *   平均差仍有 **6.8**、56% 的像素在变，与"真滤镜/恒等滤镜"的差**完全相等**。
 *   而单独在静止时刻量（脚本 `%TEMP%\ieml-refraction-vis.mjs` 那次）：
 *     噪声 0.49 · 信号 1.19（明显变化像素 0.63% → 10.6%）—— 折射清楚可见。
 *   也就是说：**折射确实有像素效果，但灵动档的背景让应用内对照拿不到可信信噪比**。
 *   硬留一条这样的判据，只会得到"永远红"或"永远绿"的假判据。
 *
 *   所以分工定死：
 *     · **机制**：`probe-webview-glass.mjs`（高对比条纹 + 坏引用正对照）；
 *     · **可见性**：一次性对照（上面那组数，已记入 ADR-059）；
 *     · **状态**：这里 —— 滤镜挂着、法线图烘出来了、三档与降级都对、指针高光真的跟手。
 */
const refrState = await ev(`(() => {
  const cards = [...document.querySelectorAll('.glass-refract')];
  const lights = cards.filter((c) => c.dataset.lens);
  const gl = document.querySelector('canvas.glass-ambient-gl');
  return {
    lensMaps: document.querySelectorAll('#ieml-lens-defs filter').length,
    withLens: lights.length,
    cards: cards.length,
    gl: gl ? [gl.width, gl.height] : null,
    flowOn: document.documentElement.dataset.vfxGl === 'on',
  };
})()`);
check(
  '★ ① 折射状态到位（滤镜挂着 + 法线图烘出来了 + 背景在跑流场）',
  refrState.withLens >= 2 && refrState.lensMaps > 0 && refrState.flowOn === true,
  `参与折射 ${refrState.withLens}/${refrState.cards} 块 · 已烘法线图 ${refrState.lensMaps} 张 · GL ${refrState.gl ? refrState.gl.join('x') : '无'}`,
);

/* ====================== 适中档 ====================== */
console.log('\n=== 适中视效（mid）===');
await setLevel('mid');
const mid = await snapshot();
const midPerf = await frameTimes();
const midPerfStat = report(mid, midPerf);
const midClip = await cardClip();
await shoot('mid-全窗');
if (midClip) await shoot('mid-卡片特写', midClip);
const midBg = await shoot('mid-背景区', await bgClip());

check('档位属性 = mid', mid.level === 'mid', String(mid.level));
check('不起 GL 背景（只有灵动档才起）', mid.glCanvas === null, mid.glCanvas ? '竟然起了' : '');
check(
  '够格的机器上适中档**仍有折射**（材质是连续的，不是断层）',
  aura.lensAttr === 'on' ? String(mid.backdrop).includes('url("#ieml-lens-') : true,
  String(mid.lensId ?? '无'),
);
check('⑤ 适中档也调色', mid.tintInPaint === true, String(mid.tints[0]?.tint ?? ''));
check('  适中档标题条的磨砂也还在', String(mid.phBackdrop).includes('blur'), String(mid.phBackdrop));
const midBgFile = midBg;
const bgDiff = pixelDiff(auraBg, midBgFile);
check(
  '★ 灵动档的背景与适中档**不一样**（换了实现，不是同一张图）',
  !bgDiff.err && bgDiff.mean > 0.15,
  bgDiff.err ? bgDiff.err : `平均差 ${bgDiff.mean.toFixed(2)}`,
);
check('帧时间不差于灵动档太多（p95 < 33ms）', midPerfStat.p95 < 33, `p95 ${midPerfStat.p95.toFixed(1)}ms`);

/* ====================== 弱化档 ====================== */
console.log('\n=== 弱化视效（weak）===');
await setLevel('weak');
const weak = await snapshot();
const weakPerf = await frameTimes();
const weakPerfStat = report(weak, weakPerf);
await shoot('weak-全窗');

check('档位属性 = weak', weak.level === 'weak', String(weak.level));
check('★ 平玻璃：卡片 backdrop-filter 是 none', String(weak.backdrop) === 'none', String(weak.backdrop));
check('★ 弱化档连**标题条**的磨砂也关掉（不然会留一条糊的带子）', String(weak.phBackdrop) === 'none', String(weak.phBackdrop));
check('没有折射滤镜', weak.withLens === 0, `${weak.withLens} 块`);
check('没有 GL 背景', weak.glCanvas === null);
check('帧时间最省（p95 < 33ms）', weakPerfStat.p95 < 33, `p95 ${weakPerfStat.p95.toFixed(1)}ms`);

/* ====================== 交互与弹层（三条最容易"验了个假的"的地方） ====================== */
console.log('\n=== 交互与弹层 ===');

/*
 * ★★ ② 动态高光：**真的跟着指针动吗**。
 *
 *   之前那条断言只检查 `--glass-gx` "有没有值" —— 而它**永远有值**（CSS 里
 *   给了初始值 26%）。那种判据等于没验。这里改成：把指针移到卡片的左上、
 *   再移到右下，**看这两个数有没有跟着变**。
 *   CDP 的 Input.dispatchMouseEvent 会派生出 pointermove（我们的监听器听的是它）。
 */
await setLevel('aura');
const cardBox = await ev(`(() => {
  const c = [...document.querySelectorAll('.glass-refract')].find((x) => {
    const r = x.getBoundingClientRect();
    return r.width > 240 && r.top > 120 && r.bottom < (window.innerHeight || 800) - 20;
  });
  if (!c) return null;
  const r = c.getBoundingClientRect();
  c.id = 'probe-card';
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
})()`);

if (!cardBox) {
  check('找得到一块可测的玻璃卡片', false, '页面布局里没有合适的目标');
} else {
  const readHi = () =>
    ev(`(() => {
      const c = document.getElementById('probe-card');
      const cs = getComputedStyle(c);
      return {
        gx: cs.getPropertyValue('--glass-gx').trim(),
        gy: cs.getPropertyValue('--glass-gy').trim(),
        hover: c.hasAttribute('data-hover'),
      };
    })()`);
  const moveTo = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' });
    await sleep(320);
  };

  await moveTo(cardBox.left + cardBox.width * 0.15, cardBox.top + cardBox.height * 0.2);
  const hiA = await readHi();
  await moveTo(cardBox.left + cardBox.width * 0.85, cardBox.top + cardBox.height * 0.75);
  const hiB = await readHi();

  const num = (s) => parseFloat(String(s)) || 0;
  check(
    '★ ② 高光跟着指针走（左右两次位置明显不同）',
    num(hiB.gx) - num(hiA.gx) > 25 && num(hiB.gy) - num(hiA.gy) > 20,
    `左上 (${hiA.gx}, ${hiA.gy}) → 右下 (${hiB.gx}, ${hiB.gy})`,
  );
  check('指针在玻璃上时会挂 data-hover（高光抬一档）', hiB.hover === true);
}

/*
 * ★★ 应用内改档：**不重载**直接切。
 *
 *   前面所有档位验证都是"写 localStorage + 重载"—— 那是**启动路径**，
 *   而用户实际是按设置页那个三档控件。两条路的代码完全不同
 *   （`readVfx()` 对 `choose()`），只验一条等于漏一半。
 */
const clickTier = async (label) => {
  const hit = await ev(`(() => {
    const seg = document.querySelector('.seg[aria-label="视效档位"]');
    if (!seg) return 'no-seg';
    const btn = [...seg.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
    if (!btn) return 'no-btn';
    if (btn.disabled) return 'disabled';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(900);
  return hit;
};

const liveState = () =>
  ev(`(() => {
    const card = [...document.querySelectorAll('.glass-refract')][0];
    return {
      attr: document.documentElement.dataset.vfx,
      backdrop: card ? (getComputedStyle(card).backdropFilter || 'none') : null,
      gl: !!document.querySelector('canvas.glass-ambient-gl'),
      lenses: [...document.querySelectorAll('.glass-refract')].filter((c) => c.dataset.lens).length,
    };
  })()`);

check('设置页有「视效档位」这个三档控件', (await ev(`!!document.querySelector('.seg[aria-label="视效档位"]')`)) === true);

const toWeak = await clickTier('弱化');
const weakLive = await liveState();
check('★ 点「弱化视效」当场生效（不重载）', toWeak === 'clicked' && weakLive.attr === 'weak' && weakLive.backdrop === 'none', `${toWeak} · attr=${weakLive.attr} · backdrop=${weakLive.backdrop}`);
check('  弱化档同时把 GL 背景收掉', weakLive.gl === false && weakLive.lenses === 0);

const toAura = await clickTier('灵动');
const auraLive = await liveState();
check(
  '★ 点「灵动视效」当场生效（折射滤镜与 GL 都回来）',
  toAura === 'clicked' && auraLive.attr === 'aura' && String(auraLive.backdrop).includes('url("#ieml-lens-') && auraLive.gl === true,
  `${toAura} · attr=${auraLive.attr} · 透镜 ${auraLive.lenses} 块 · GL ${auraLive.gl}`,
);

/*
 * ★★ 弹层（模态）的玻璃：**它才是最看得出折射的地方**。
 *
 *   卡片背后是平滑的氛围背景 —— 把一团渐变扭一下，人眼基本看不出；
 *   而模态背后是**列表内容**（文字、边框、封面），那里才有结构可弯折。
 *   所以"折射到底有没有用"要看模态，不能只看卡片。
 */
const opened = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const hit = btns.find((b) => /新建\\/切换|切换/.test(b.textContent || ''));
  if (!hit) return 'no-btn';
  hit.click();
  return 'clicked';
})()`);
await sleep(1200);
const modalInfo = await ev(`(() => {
  const m = document.querySelector('.modal');
  if (!m) return { err: '没有 .modal' };
  const cs = getComputedStyle(m);
  const r = m.getBoundingClientRect();
  return {
    classes: m.className,
    lens: m.dataset.lens ?? null,
    backdrop: cs.backdropFilter || 'none',
    sheen: m.classList.contains('glass-sheen'),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    hasTint: m.style.getPropertyValue('--glass-tint').trim(),
  };
})()`);

if (modalInfo?.err) {
  check('打得开一个模态（数据目录选择器）', false, `${opened} · ${modalInfo.err}`);
} else {
  check('★ 模态也是玻璃表面（带折射滤镜）', String(modalInfo.backdrop).includes('url("#ieml-lens-'), String(modalInfo.lens ?? '无'));
  check('模态挂了 .glass-sheen（灵动档高光会在它上面自己流动）', modalInfo.sheen === true);
  check('模态也按位置取色', modalInfo.hasTint.length > 0, modalInfo.hasTint);
  if (modalInfo.box) {
    await shoot('modal-全窗');
    await shoot('modal-边缘特写', {
      x: Math.max(0, modalInfo.box[0] - 30),
      y: Math.max(0, modalInfo.box[1] - 30),
      width: Math.min(420, modalInfo.box[2] + 60),
      height: Math.min(260, modalInfo.box[3] + 60),
      scale: 2,
    });
  }
  /*
   * ★ 关闭动作必须留到**折射像素对照之后** —— 第一次写反了次序：
   *   先关了模态、再做 A/B，于是 `document.querySelector('.modal')` 是 null，
   *   读回来的是空串，判据报红。**测的东西已经不在了**，而报错信息长得像"折射没恢复"。
   */
}

/*
 * ★★ 折射的**像素证据**：在真实界面上，用**恒等滤镜**做对照。
 *
 *   只证明"它挂在 backdrop-filter 里"是不够的 —— "挂在样式里"与"真的改了画面"
 *   是两件事。做法：把同一块玻璃的 url(#真滤镜) 换成 url(#恒等滤镜)（feOffset 0,0），
 *   其余一个字不动，两张图比像素差。
 *
 *   ★ 为什么不用"把 url() 摘掉"：摘掉之后整条声明是非法值 → 连磨砂一起没了，
 *     测出来的是"磨砂开关"而不是"折射"。
 *   ★ 为什么比对放在**模态**上：折射只把**有结构的东西**弯出来。
 *     卡片背后是平滑的氛围背景，扭一片纯色还是那片纯色（实测差 0.000）；
 *     模态背后是**列表内容**（文字、边框），才有东西可弯。
 *   ★ 判据是**信号 vs 噪声**（不是"逐字节相同"）：活界面上取色会重算、
 *     提示条会进出，两张"完全相同"的图很难拿到。噪声用"基线连截两张"量出来，
 *     信号必须明显大于它。
 */

/**
 * 等提示条自己走完。
 *
 * ★ 为什么要等：点档位会弹一条 toast（"视效已设为…"），它就挂在顶部中间 ——
 *   而我的取景框正好压到它的边。**提示条在基线那一张还在、在恢复那一张已经没了**，
 *   于是"恢复后与基线不同"这条判据会误报。
 *   （教训同一条：像素比对里，任何**会自己动的东西**都必须先排除干净。）
 */
const waitNoToast = async () => {
  for (let i = 0; i < 40; i += 1) {
    if ((await ev(`document.querySelectorAll('.toast').length`)) === 0) return true;
    await sleep(250);
  }
  return false;
};

const toMid = await clickTier('适中');
/*
 * ★ 对照要在**模态还开着**的时候做（它背后是列表内容，才有东西可弯），
 *   做完再关 —— 次序踩过一次：先关模态再做对照 → 测的东西已经不在了。
 */
const modalClip2 = {
  x: Math.max(0, modalInfo.box[0] - 26),
  y: Math.max(0, modalInfo.box[1] - 26),
  width: Math.min(520, modalInfo.box[2] + 52),
  height: Math.min(320, modalInfo.box[3] + 52),
  scale: 1,
};
/*
 * ★★ 折射的**像素级证据不在这里做** —— 这是量出来的结论，不是偷懒：
 *
 *   在真实界面上做"真滤镜 vs 恒等滤镜"的对照时，**噪声（同一状态连截两张的差）
 *   就有 5.83 平均差、54% 的像素在变**，而折射本身的贡献测不出来 ——
 *   也就是说：在这个界面上，折射的**像素效果小于它自己的抖动**。
 *   原因有两层，都写进 ADR-059 了：
 *     ① 玻璃背后大多是**平滑的背景层**，把一片渐变扭一下还是那片渐变；
 *     ② 这个界面一直在动（取色重算、列表重渲染），静态对照的前提不成立。
 *
 *   所以分工是：
 *     · **机制**由 `probe-webview-glass.mjs` 证明（那里有高对比条纹，像素差一眼可见）；
 *     · **状态**在这里验（滤镜挂上了、烘了图、三档切换与降级都对）。
 *   硬把像素对照塞进这里，只会得到一条"永远红"或者"永远绿"的假判据。
 */
const modalRefr = await ev(`(() => {
  const m = document.querySelector('.modal');
  const cards = [...document.querySelectorAll('.glass-refract')];
  return {
    modalLens: m ? (m.dataset.lens ?? null) : null,
    modalBackdrop: m ? (getComputedStyle(m).backdropFilter || '') : '',
    lensMaps: document.querySelectorAll('#ieml-lens-defs filter').length,
    withLens: cards.filter((c) => c.dataset.lens).length,
  };
})()`);
check(
  '★ ① 折射状态到位（滤镜挂着 + 法线图烘出来了）',
  modalRefr.modalBackdrop.includes('url("#ieml-lens-') && modalRefr.lensMaps > 0,
  `模态 ${modalRefr.modalLens} · 已烘法线图 ${modalRefr.lensMaps} 张 · 参与折射 ${modalRefr.withLens} 块`,
);
/* ====================== 标题条：磨砂与折射（第三轮才测得出） ====================== */
/*
 * ★★ 这两条判据**前两轮测不出来**，原因不是它们没发生，而是：
 *   ① 「.page-head」 上有 「isolation: isolate」 → 它成了 backdrop root →
 *      伪元素的磨砂**背后是空的**（磨空气）。那时"磨砂开/关"的像素差是 **0.000**；
 *   ② 折射也一样，没东西可弯。
 *   删掉 「isolation」 之后（见 app.css 的说明），这两条才成立：
 *      磨砂开关差 7.18 / 折射开关差也进入可测范围，而噪声只有约 0.01。
 * ★ 取景框**要排除右边缘**：滚动条会淡出，属于"会自己动的东西"。
 */
await ev(`(() => { const b = document.querySelector('.content') || document.scrollingElement; b.scrollTop = 470; return b.scrollTop; })()`);
await sleep(1200);
const headClip = await ev(`(() => {
  const r = document.querySelector('.page-head').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(160, Math.round(r.width) - 60), height: Math.round(r.height), scale: 1 };
})()`);

const headLensNow = await ev(`(() => {
  const ph = document.querySelector('.page-head');
  return {
    lensVar: ph.style.getPropertyValue('--glass-lens-url').trim(),
    backdrop: getComputedStyle(ph, '::before').backdropFilter || 'none',
  };
})()`);
/*
 * ★★ 这里断言的是**不许挂 url() 滤镜** —— 一个真机量出来的硬约束：
 *   给 `.page-head::before` 的 backdrop-filter 加上 url(...) 之后，
 *   **整条 backdrop-filter 失效**（连 blur 一起）。实测「真滤镜 / 同结构但位移 1px
 *   的克隆滤镜 / 完全关掉」三者像素**完全一样**。
 *   所以标题条上"遮挡"与"折射"是二选一，我们选了遮挡（用户当年点名要的）。
 *   遮挡本身由 `tools/live/live-pagehead-frost-check.mjs` 逐像素验
 *   （开关差 16+ / 噪声 0.000）。
 */
check(
  '★ 标题条的 backdrop-filter 里没有 url() 滤镜（挂了会让遮挡整条失效）',
  !String(headLensNow.backdrop).includes('url('),
  String(headLensNow.backdrop).slice(0, 52),
);

/*
 * ★★ 注入一律走**独立样式表**（adoptedStyleSheets），不再用 insertRule + 猜索引：
 *   这一晚我在"删不掉自己注入的规则"上栽了三次，每次都产出**假数据** ——
 *   最典型的一次：后面每一张图其实都还是"磨砂关着"的状态，于是"折射开关差"
 *   与"磨砂开关差"一模一样（8.126），我差点把它当结论写进 ADR。
 *   整表清空是原子的：没有索引、没有标记匹配、也没有"CSSRule.cssText 丢注释"。
 */
await ev(`(() => {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.__probeSheet = sheet;
  return document.adoptedStyleSheets.length;
})()`);
const setProbe = (css) =>
  ev(
    '(() => { const s = window.__probeSheet; while (s.cssRules.length) s.deleteRule(0); ' +
      (css ? 's.insertRule(' + JSON.stringify(css) + ', 0); ' : '') +
      'return getComputedStyle(document.querySelector(".page-head"), "::before").backdropFilter; })()',
  );

/*
 * ★★ 标题条的**像素对照挪到了专门的脚本**：`tools/live/live-pagehead-frost-check.mjs`。
 *
 *   为什么不在这个大检查里做：这里前后跑了几十个操作（切档、开模态、滚动、截图），
 *   注入一条规则之后**我无法确认它什么时候真的生效** —— 实测同一段代码在大流程里
 *   量出 8.046（与"关掉磨砂"一模一样），在干净会话里量出 0.548（噪声 0.082）。
 *   大流程里那个 8.046 是**假数**（注入没生效/状态没恢复都会造成它）。
 *   教训：**像素对照必须在一个你能完全控制、并且每一步都能回读状态的会话里做。**
 *   这里只留"状态"类断言（磨砂在不在、滤镜挂没挂、弱化档关没关）。
 */

/* ====================== 收尾 ====================== */
console.log(`\n截图：${OUT}`);
console.log('（人眼复核：aura-卡片特写 与 mid-卡片特写 的边缘应有弯折与红蓝色边；weak-全窗 应是平面）');

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
