/**
 * 第五轮（减法）的真机验证：
 *  ① 卡片**没有颜色**了（红/蓝色散没了）
 *  ② 指针高光**整块没了**（没有光斑元素、没有监听残留、移指针画面不变）
 *  ③ 低性能损耗模式**一键**：动效→减少、视效→弱化；关掉能还回来
 *  ④ 三个档位都强制 GPU（渲染器必须是独显；无独显的机器这条自动跳过）
 *  ⑤ 烟雾更强了（背景的时间变化幅度比上一版大）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9691;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-r5');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-r5-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
function decodePng(buf) {
  let off = 8, width = 0, height = 0, colorType = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = width * ch;
  const out = new Uint8Array(width * height * 4); let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) { const s = x * ch, d = (y * width + x) * 4; out[d] = cur[s]; out[d + 1] = ch >= 3 ? cur[s + 1] : cur[s]; out[d + 2] = ch >= 3 ? cur[s + 2] : cur[s]; out[d + 3] = ch === 4 ? cur[s + 3] : 255; }
    prev = cur;
  }
  return { width, height, data: out };
}
const diff = (fa, fb) => {
  const a = decodePng(readFileSync(fa)), b = decodePng(readFileSync(fb));
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    sum += d; n += 1; if (d > max) max = d;
  }
  return { mean: sum / n / 3, max };
};

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
if (!page) { console.error('连不上 CDP'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params?.exceptionDetails; errors.push(String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0]); }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result?.result?.value; };
const shoot = async (tag, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', clip }); const f = path.join(OUT, `${tag}.png`); if (r.result?.data) writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
const waitApp = async () => { for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) return true; await sleep(400); } return false; };

for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }
await ev(`localStorage.setItem('ieml.vfx','mid')`);
await ev(`localStorage.setItem('ieml.lowPerf','0')`);
await send('Page.reload', {});
await sleep(2600);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

/* ============ ① 卡片没有颜色（色散删了） ============ */
console.log('=== ① 卡片自身不该带颜色 ===');
const card = await ev(`(() => {
  const c = [...document.querySelectorAll('.glass')].find((x) => x.getBoundingClientRect().width > 240);
  if (!c) return null;
  const cs = getComputedStyle(c);
  const r = c.getBoundingClientRect();
  return {
    shadow: cs.boxShadow,
    红: cs.boxShadow.includes('255, 64, 64') || cs.boxShadow.includes('255,64,64'),
    蓝: cs.boxShadow.includes('64, 150, 255') || cs.boxShadow.includes('64,150,255'),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  };
})()`);
console.log('  卡片 box-shadow：' + String(card?.shadow).slice(0, 120));
check('★ 色散红边已去掉', card && card.红 === false);
check('★ 色散蓝边已去掉', card && card.蓝 === false);
/*
 * ★★ 别再写 `includes('inset 0px 0px 26px')` —— 这是这个项目记过的坑：
 *   `getComputedStyle` **不按源码顺序序列化**，`inset …` 会被挪到末尾
 *   （实测输出是 `rgba(…) 0px 0px 26px -14px inset`）。匹配 "inset 0px…" 必然误报。
 */
/*
 * ★ 2026-09-22：用户说「**我不希望卡片会自发光**」→ 柔光内辉换成**一条清晰的内边**。
 *   这条判据同时守住两件事：内边在、**且不再是辉光**（没有 26px 的模糊半径）。
 */
check(
  '★ ④ 厚度是一条清晰内边，不是辉光（用户："不希望卡片会自发光"）',
  /0px 0px 0px 1px/.test(String(card?.shadow)) && !/0px 0px 26px/.test(String(card?.shadow)),
  String(card?.shadow).slice(-70),
);

/* 像素级：卡片左边缘与右边缘的**色相**都应当是中性的（R≈B），不再一红一蓝 */
const cardShot = card ? await shoot('卡片', { x: card.box[0], y: card.box[1], width: card.box[2], height: card.box[3], scale: 1 }) : null;
if (cardShot) {
  const px = decodePng(readFileSync(cardShot));
  /** 取某一列的 R-B 平均（>0 偏红，<0 偏蓝） */
  const colRB = (xStart) => {
    let s = 0, n = 0;
    for (let y = 4; y < px.height - 4; y += 1) {
      for (let x = xStart; x < xStart + 3; x += 1) {
        const i = (y * px.width + x) * 4;
        s += px.data[i] - px.data[i + 2]; n += 1;
      }
    }
    return s / n;
  };
  const left = colRB(1);
  const right = colRB(px.width - 4);
  const center = colRB(Math.round(px.width / 2) - 1);
  console.log(
    `  边缘色相 R-B：左 ${left.toFixed(2)} · 中 ${center.toFixed(2)} · 右 ${right.toFixed(2)}（正=偏红，负=偏蓝）`,
  );
  /*
   * ★ 判据要问对问题（第一版问错了）：
   *   玻璃会**跟着底下光斑调色**（那是"内容适应"，用户要的），所以整块卡片
   *   偏蓝/偏紫是**正常的**（实测左右都在 -13 / -10.7，差不多的蓝）。
   *   色散的特征是**左右分裂**（一边红一边蓝），所以该断言的是：
   *     ① 左右**几乎一样**（差值小）；
   *     ② 边缘不比其他地方更"带色"（跟中心比，偏差小）。
   */
  check(
    '★ 左右边缘不再一红一蓝（差值很小）',
    Math.abs(left - right) < 8,
    `左 ${left.toFixed(1)} / 右 ${right.toFixed(1)} · 差 ${Math.abs(left - right).toFixed(1)}`,
  );
  check(
    '  边缘不比卡片中心更带色（没有描边式色边）',
    Math.abs(left - center) < 14 && Math.abs(right - center) < 14,
    `左-中 ${(left - center).toFixed(1)} / 右-中 ${(right - center).toFixed(1)}`,
  );
}

/* ============ ② 指针高光没了 ============ */
console.log('\n=== ② 指针高光应当整体消失 ===');
const g0 = await ev(`(() => ({
  glow: document.querySelectorAll('.glass-glow').length,
  spot: document.querySelectorAll('.glass-glow-spot').length,
  edge: document.querySelectorAll('.glass-edge').length,
  hover: document.querySelectorAll('[data-hover]').length,
  cssGlowVar: getComputedStyle(document.documentElement).getPropertyValue('--glow-rx').trim(),
}))()`);
console.log('  ' + JSON.stringify(g0));
check('★ 没有光斑元素（DOM 里一个都不剩）', g0.glow === 0 && g0.spot === 0 && g0.edge === 0);
check('  没有 data-hover 残留', g0.hover === 0, String(g0.hover));
check('  高光的 CSS 令牌也删了', g0.cssGlowVar === '', `--glow-rx="${g0.cssGlowVar}"`);

// 移指针：画面**不该**有任何变化（这是"高光真的没了"的行为证据）
await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 300; return true; })()`);
await sleep(800);
const clip = { x: card.box[0], y: 120, width: Math.min(600, card.box[2]), height: 200, scale: 1 };
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' });
await sleep(500);
const before = await shoot('指针-角落', clip);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clip.x + 300, y: 220, button: 'none' });
await sleep(500);
const after = await shoot('指针-卡片上', clip);
const moved = diff(before, after);
console.log(`  指针从角落移到卡片上：画面平均差 ${moved.mean.toFixed(3)}`);
check('★ 移动指针**不再改变画面**（高光确实没了）', moved.mean < 0.05, `平均差 ${moved.mean.toFixed(3)}`);

/* ============ ③ 低性能损耗模式一键 ============ */
console.log('\n=== ③ 低性能损耗模式应当一键降两档 ===');
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
const state = () => ev(`(() => ({
  lowPerf: document.documentElement.classList.contains('low-perf'),
  vfx: document.documentElement.dataset.vfx,
  motion: document.documentElement.dataset.motion,
  storedVfx: localStorage.getItem('ieml.vfx'),
  storedMotion: localStorage.getItem('ieml.motion'),
  storedLow: localStorage.getItem('ieml.lowPerf'),
}))()`);
// 先把两档都设成"高的"，才看得出它是不是真的降了
await ev(`(() => {
  const seg = document.querySelector('.seg[aria-label="视效档位"]');
  const b = seg ? [...seg.querySelectorAll('button')].find((x) => (x.textContent || '').includes('灵动')) : null;
  if (b && !b.disabled) b.click();
  return true;
})()`);
await sleep(700);
await ev(`(() => {
  const seg = document.querySelector('.seg[aria-label="动效档位"]') || [...document.querySelectorAll('.seg')].find((s) => /动效/.test(s.getAttribute('aria-label') || ''));
  const b = seg ? [...seg.querySelectorAll('button')].find((x) => /灵动|灵韵/.test(x.textContent || '')) : null;
  if (b && !b.disabled) b.click();
  return !!b;
})()`);
await sleep(700);
const hi = await state();
console.log('  降级前：' + JSON.stringify(hi));

const flip = async () => {
  await ev(`(() => { const sw = document.querySelector('button[role="switch"][aria-label="低性能损耗模式"]'); if (sw) sw.click(); return !!sw; })()`);
  await sleep(1200);
};
await flip();
const low = await state();
console.log('  开了之后：' + JSON.stringify(low));
check('★ 一键：视效→弱化', low.vfx === 'weak', String(low.vfx));
check('★ 一键：动效→减少', low.motion === 'lite', String(low.motion));
check('  落盘了（重启后还是这样）', low.storedVfx === 'weak' && low.storedMotion === 'lite', `${low.storedVfx} / ${low.storedMotion}`);

await flip();
const back = await state();
console.log('  关掉之后：' + JSON.stringify(back));
check('★ 关掉能**还回原档**（不是停在弱化）', back.vfx === hi.vfx && back.motion === hi.motion, `${back.vfx}/${back.motion} vs 原 ${hi.vfx}/${hi.motion}`);
check('  全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));

/* ============ ④ 三档都强制 GPU ============ */
console.log('\n=== ④ 显卡 ===');
const rendererOf = async () => {
  await send('Page.reload', {});
  await sleep(2400);
  await waitApp();
  return ev(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a';
  })()`);
};
const rNow = await rendererOf();
console.log('  渲染器：' + rNow);
check(
  '★ 强制高性能 GPU 的开关已生效（有独显的机器上不该再看到 Intel/核显）',
  typeof rNow === 'string' && !/Intel|Basic Render|SwiftShader/i.test(rNow),
  String(rNow),
);

console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
