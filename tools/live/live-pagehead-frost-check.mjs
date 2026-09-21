/**
 * 真机验证：**粘性标题条的磨砂与折射**（用户要的"能作遮挡"到底成不成立）。
 * ------------------------------------------------------------------
 * ## 为什么单独一个脚本，而不是并进 live-glass-check.mjs
 *
 *   因为这条判据要**逐像素对比**，而像素对比的前提是"我能完全控制这个会话，
 *   并且每一步都确认状态真的切过去了"。在大流程里做不到 —— 实测同一段代码
 *   在大流程里量出 **8.046**（与"关掉磨砂"数字一模一样 = 假数），
 *   在干净会话里量出 **0.548**（噪声 0.082）。差 15 倍，全是状态没控住的锅。
 *
 * ## 它守的是什么（一个真 bug）
 *
 *   `.page-head` 上原本有 `isolation: isolate`。**它会让元素成为 backdrop root**，
 *   于是 `::before` 的 `backdrop-filter` **背后是空的** —— 磨砂一直在磨空气，
 *   用户当初要的"没有割裂感**还能作遮挡**"里，"遮挡"那一半是假的。
 *   删掉 `isolation` 之后（`z-index: 20` 本来就够形成层叠上下文），遮挡才成立。
 *   这个脚本就是那条修复的**回归判据**：谁把 `isolation` 加回来，这里会红。
 *
 * 用法：
 *   node tools/live/live-pagehead-frost-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`；截图落在 `%TEMP%\ieml-headfrost\`。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9481;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-headfrost');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-headfrost-prof');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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

/* ---------- Node 侧解 PNG（不往页面里塞图、也不受 CSP 管） ---------- */
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

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
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
  const r = await send('Page.captureScreenshot', { format: 'png', clip });
  const f = path.join(OUT, `${tag}.png`);
  writeFileSync(f, Buffer.from(r.result?.data ?? '', 'base64'));
  return f;
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
// 适中档：背景是静的（灵动档的流场会自己动，那是噪声源）
await ev(`localStorage.setItem('ieml.vfx','mid')`);
await send('Page.reload', {});
await sleep(2200);
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('设置'))?.click()`);
await sleep(1500);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
// 滚到"卡片里的文字正好在标题条下面"
await ev(`(() => { const b = document.querySelector('.content'); b.scrollTop = 470; return b.scrollTop; })()`);
await sleep(1200);

const clip = await ev(`(() => {
  const r = document.querySelector('.page-head').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(160, Math.round(r.width) - 60), height: Math.round(r.height), scale: 1 };
})()`);

/* 注入一律走**独立样式表**：整表清空是原子的，没有索引/标记匹配这回事 */
await ev(`(() => {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.__probeSheet = sheet;
  return true;
})()`);
/** 设置探针规则并**等一拍之后另起一次调用回读**（同步回读拿到的是旧值 —— 踩过） */
const setProbe = async (css) => {
  await ev(
    '(() => { const s = window.__probeSheet; while (s.cssRules.length) s.deleteRule(0); ' +
      (css ? 's.insertRule(' + JSON.stringify(css) + ', 0); ' : '') +
      'return s.cssRules.length; })()',
  );
  await sleep(500);
  return ev('(getComputedStyle(document.querySelector(".page-head"), "::before").backgroundImage || "none").slice(0, 46)');
};

const baseState = await ev('getComputedStyle(document.querySelector(".page-head"), "::before").backgroundImage || "none"');
const pageIsolation = await ev('getComputedStyle(document.querySelector(".page-head")).isolation');
console.log(`· 标题条 ::before 的背景层 = ${String(baseState).slice(0, 60)}`);
console.log(`· .page-head 的 isolation = ${pageIsolation}（必须是 auto —— isolate 会让它成为 backdrop root，磨砂就磨空气）`);
check('标题条的 isolation 不是 isolate（这个 bug 的回归判据）', pageIsolation !== 'isolate', String(pageIsolation));
check('标题条的 ::before 带着遮挡层（底色渐变的 rgba(18, 21, 26)）', String(baseState).includes('rgba(18, 21, 26'), String(baseState).slice(0, 52));

const A = await shoot('A-基线', clip);
await sleep(300);
const A2 = await shoot('A2-基线复测', clip);
const noise = diff(A, A2);

/*
 * ★ "关掉遮挡"= 把那条"底色 → 透明"的软渐变去掉（它是**遮挡的唯一来源**：
 *   backdrop-filter 在本机的粘性页头上没有作用，见 app.css 的说明）。
 */
const offState = await setProbe('.page-head::before{background-image:var(--glass-layers) !important}');
const B = await shoot('B-关遮挡', clip);
const occl = diff(A, B);
console.log('   关掉遮挡后的 background-image 前缀：' + String(offState).slice(0, 46));

const onState = await setProbe('');
const C = await shoot('C-恢复', clip);
const restore = diff(A, C);


console.log('');
console.log(`噪声（基线两张）    ：平均差 ${noise.mean.toFixed(3)} · 最大 ${noise.max} · 明显变化的像素 ${noise.badPct.toFixed(2)}%`);
console.log(`遮挡开/关           ：平均差 ${occl.mean.toFixed(3)} · 最大 ${occl.max} · 明显变化的像素 ${occl.badPct.toFixed(2)}%`);
console.log(`恢复后与基线的差    ：平均差 ${restore.mean.toFixed(3)}（应当回到噪声水平）`);
console.log('');

check(' 噪声足够小（< 0.15/通道）', noise.mean < 0.15, noise.mean.toFixed(3));
check(
  '★ 标题条**真的在遮挡内容**（开关差 ≥ 噪声的 4 倍）',
  occl.mean > Math.max(0.5, noise.mean * 4),
  `${occl.mean.toFixed(3)} vs ${noise.mean.toFixed(3)}`,
);
check(
  '★ 注入可撤销（恢复后回到基线 —— 这条挡住"假数据"）',
  restore.mean <= Math.max(0.05, noise.mean * 1.5),
  restore.mean.toFixed(3),
);
/*
 * ★★ 反向守卫：标题条的 backdrop-filter 里**不许出现 url()**。
 *   一旦挂上（哪怕是指向"零位移"的克隆滤镜），整条 backdrop-filter 会失效 ——
 *   连模糊都没了，实测三种情况像素完全一样。所以这里直接盯住"有没有 url("。
 */
const bd = await ev('getComputedStyle(document.querySelector(".page-head"), "::before").backdropFilter || "none"');
check(
  '★ 标题条的 backdrop-filter 里没有 url() 滤镜（挂了会让它整条失效）',
  !String(bd).includes('url('),
  String(bd).slice(0, 56),
);

console.log(`\n图：${OUT}\\A-基线.png / B-关遮挡.png / C-恢复.png`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
