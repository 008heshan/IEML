/**
 * 真机验证：这一批的四条（2026-09-22）
 *   E 换主题时**灵动档背景要跟着变色**（用户报的 bug：以前不变）
 *   H toast 在**右下角** + 消失时**有退场动画**
 *   D 主题色板**没有描述文字、没有悬浮提示**
 *   F MC 版本命名（"Minecraft 1.12.2 ：原版" / "Minecraft 26.2 + Fabric 26.2：模组加载器"）
 *
 * 用法：node tools/live/live-batch1-check.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9761;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b1');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b1-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
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
await ev(`localStorage.setItem('ieml.vfx','aura')`);
await send('Page.reload', {});
await sleep(2800);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

/* ============ D 主题色板：没有描述、没有悬浮提示 ============ */
console.log('=== D 主题色板 ===');
const swatch = await ev(`(() => {
  const b = document.querySelector('.theme-swatch');
  if (!b) return null;
  const row = b.closest('.field-row');
  return {
    提示数: [...document.querySelectorAll('.theme-swatch')].filter((x) => x.hasAttribute('title')).length,
    按钮数: document.querySelectorAll('.theme-swatch').length,
    行内还有描述文字: row ? /安静、自然|冷静、专业|神秘、高级|沉稳、有力量|温暖、复古|清爽、冷静|柔和、温柔|朴素、安静|默认。/.test(row.textContent) : null,
  };
})()`);
console.log('  ' + JSON.stringify(swatch));
check('★ 色板没有悬浮提示（title 全删）', swatch && swatch.提示数 === 0, String(swatch?.提示数));
check('★ 主题那一行没有描述文字了', swatch && swatch.行内还有描述文字 === false);

/* ============ E 换主题时背景要变色（灵动档） ============ */
console.log('\n=== E 换主题 → 背景要跟着变色 ===');
const bg = async (tag) => {
  const f = await shoot(tag, { x: 700, y: 560, width: 300, height: 180, scale: 1 });
  return f;
};
const pick = async (label) => {
  await ev(`(() => {
    const b = [...document.querySelectorAll('.theme-swatch')].find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1400);
};
await pick('玄夜');
await sleep(1200);
const darkShot = await bg('背景-玄夜');
await pick('墨绿');
await sleep(1200);
const greenShot = await bg('背景-墨绿');
const themeBgDiff = diff(darkShot, greenShot);
console.log(`  玄夜 → 墨绿：背景平均差 ${themeBgDiff.mean.toFixed(3)}`);
check(
  '★ 换主题时**背景跟着变了**（用户报的 bug：以前在灵动档下不变）',
  themeBgDiff.mean > 2,
  `平均差 ${themeBgDiff.mean.toFixed(2)}`,
);
/* 反过来再换一次，避免"只是动画碰巧在变" */
await pick('琥珀');
await sleep(1200);
const amberShot = await bg('背景-琥珀');
const backDiff = diff(greenShot, amberShot);
console.log(`  墨绿 → 琥珀：背景平均差 ${backDiff.mean.toFixed(3)}`);
check('★ 再换一次也变（不是碰巧）', backDiff.mean > 2, `平均差 ${backDiff.mean.toFixed(2)}`);

/* ============ H toast：右下角 + 退场动画 ============ */
console.log('\n=== H toast ===');
/*
 * 用一个**必然出提示**的动作：点主题色板（每次都会 toast「主题已换成…」）。
 * 第一版去点「检查启动器更新」—— 那个按钮要看网络，没弹提示还抛了个未捕获的 rejection。
 */
await ev(`(() => {
  const b = document.querySelector('.theme-swatch');
  b?.click();
  return !!b;
})()`);
await sleep(800);
const t1 = await ev(`(() => {
  const c = document.querySelector('.toasts');
  const t = document.querySelector('.toast');
  if (!c || !t) return null;
  const r = t.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  return {
    数: document.querySelectorAll('.toast').length,
    右边距: Math.round(window.innerWidth - r.right),
    底边距: Math.round(window.innerHeight - r.bottom),
    容器靠右下: Math.round(cr.right) >= window.innerWidth - 40 && Math.round(cr.bottom) >= window.innerHeight - 40,
  };
})()`);
console.log('  ' + JSON.stringify(t1));
check('  能弹出提示', t1 !== null && t1.数 > 0, JSON.stringify(t1));
check('★ 提示在**右下角**', t1 && t1.右边距 < 60 && t1.底边距 < 120, `右 ${t1?.右边距} / 下 ${t1?.底边距}`);

/* 点 × 之后：应当先出现 .leaving（有退场动画），200ms 后才真消失 */
const lifecycle = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = document.querySelector('.toast');
  if (!t) return { err: '没有提示可关' };
  const x = t.querySelector('.toast-x');
  if (!x) return { err: '没有关闭按钮' };
  x.click();
  await sleep(60);                       // 动画刚开始
  const during = {
    leaving: !!document.querySelector('.toast.leaving'),
    stillThere: !!document.querySelector('.toast'),
    anim: (() => { const el = document.querySelector('.toast.leaving'); return el ? getComputedStyle(el).animationName : null; })(),
  };
  await sleep(400);                      // 动画该走完了
  const after = { stillThere: !!document.querySelector('.toast.leaving') };
  return { during, after };
})()`);
console.log('  ' + JSON.stringify(lifecycle));
check(
  '★ 点关闭后**先进入退场状态**（挂 .leaving 且真的在跑动画）',
  lifecycle?.during?.leaving === true && lifecycle?.during?.anim === 'toastOut',
  JSON.stringify(lifecycle?.during),
);
check('  退场动画走完才真的移除', lifecycle?.after?.stillThere === false);

/* ============ F 版本命名 ============ */
console.log('\n=== F 版本命名 ===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('版本列表'))?.click()`);
await sleep(1600);
const names = await ev(`[...document.querySelectorAll('.ver-title-name')].map((x) => (x.textContent || '').trim()).slice(0, 6)`);
console.log('  ' + JSON.stringify(names));
/*
 * ★★ 2026-09-23 用户改了口径：「**版本列表的版本名称，后面的"：原版"和"：模组加载器"不要**」
 *   —— 所以这里断言的是**新格式**：`Minecraft 1.12.2` / `Minecraft 26.2 + Fabric 0.19.5`。
 *   ★ 判据要跟着需求走：需求变了而判据不变，红的就是判据自己（这一条刚红过一次）。
 */
check(
  '★ 原版显示成「Minecraft x」',
  Array.isArray(names) && names.some((n) => /^Minecraft [\d.]+$/.test(n)),
  JSON.stringify(names),
);
check(
  '★ 带加载器显示成「Minecraft x + Loader y」',
  Array.isArray(names) && names.some((n) => /^Minecraft [\d.]+ \+ [A-Za-z]+ [\d.]+$/.test(n)),
  JSON.stringify(names),
);
check(
  '★ 版本名里不再出现「：原版 / ：模组加载器」（2026-09-23 新要求）',
  Array.isArray(names) && !names.some((n) => /：原版|：模组加载器/.test(n)),
  JSON.stringify(names),
);

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
