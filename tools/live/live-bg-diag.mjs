/**
 * 一次性诊断：背景像素对照为什么会量出 0.00 ——
 * 是"画布没画"还是"窗口被遮挡 → 合成器不出帧"？
 * 打印 document.hidden / visibilityState / 画布是否可见 + 两张截图的差。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9671;
const EXE = process.argv[2] ?? 'E:\\IEML\\src-tauri\\target\\release\\ieml.exe';
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-bgdiag');
rmSync(OUT, { recursive: true, force: true });
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
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: `${process.env.TEMP}\\ieml-bgdiag-prof` },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result?.result?.value; };
const shoot = async (tag, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', clip }); const f = path.join(OUT, `${tag}.png`); if (r.result?.data) writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };

for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }
await ev(`localStorage.setItem('ieml.vfx','aura')`);
await send('Page.reload', {});
await sleep(2600);
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1600);

const info = await ev(`(() => {
  const c = document.querySelector('canvas.glass-ambient-gl');
  const cs = c ? getComputedStyle(c) : null;
  return {
    hidden: document.hidden, vis: document.visibilityState,
    canvas: !!c, canvasVis: cs ? cs.visibility : null, canvasOpacity: cs ? cs.opacity : null,
    canvasBox: c ? [c.getBoundingClientRect().width | 0, c.getBoundingClientRect().height | 0] : null,
    backing: c ? [c.width, c.height] : null,
    renderer: (() => { const t = document.createElement('canvas').getContext('webgl2'); if (!t) return null; const d = t.getExtension('WEBGL_debug_renderer_info'); return d ? t.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })(),
  };
})()`);
console.log('状态：' + JSON.stringify(info));

const clip = { x: 8, y: 500, width: 170, height: 120, scale: 1 };
const a = await shoot('bg-a', clip);
await sleep(1500);
const b = await shoot('bg-b', clip);
console.log('同一区域 1.5 秒后：' + JSON.stringify(diff(a, b)));

const full1 = await shoot('full-a');
await sleep(1500);
const full2 = await shoot('full-b');
console.log('整窗 1.5 秒后：    ' + JSON.stringify(diff(full1, full2)));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
