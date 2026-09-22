/**
 * 真机验证：**显卡不支持 WebGL 2.0 时的降级**（用户点名要的那条规则）。
 * ------------------------------------------------------------------
 * 用户原话：「当用户电脑是 win7 或者显卡不支持 WebGL 2.0 时，默认适中，
 * 并且**不开放灵动视效**」。
 *
 * 这条以前**只有单元测试**（`tests/vfx-rules.test.mjs` 喂假的能力对象）——
 * 那验的是"判据函数算得对"，**没验过"应用真的会降级"**。这里补上后者：
 *
 *   用 Chromium 自己的开关 `--disable-webgl` 把 WebGL 真的关掉（不是造假数据），
 *   然后断言：
 *     ① 就算用户存的是 `aura`，实际生效的是 **mid**（默认适中）；
 *     ② 设置页那个「灵动视效」是**禁用**的，并且**写明原因**（"不开放"不是"藏起来"）；
 *     ③ 一块玻璃都不挂折射滤镜（折射需要 WebGL2 撑着的那条路径）；
 *     ④ 但**材质还在**：模糊 + 色散 + 厚度 + 调色 —— 降级不是"变回没做"；
 *     ⑤ GL 背景不起、页面无异常、帧时间更省。
 *
 * 用法：
 *   node tools/live/live-glass-degrade-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`；截图落在 `%TEMP%\ieml-glass-degrade\`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9511;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass-degrade');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-degrade-prof');

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

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
/* ★★ 关键就这一行：`--disable-webgl` 让 `getContext('webgl2')` 真的返回 null ——
   模拟"显卡不支持 WebGL 2.0"，而不是往代码里塞假数据。 */
const app = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--disable-webgl --disable-3d-apis --remote-debugging-port=${PORT}`,
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
if (!(await waitApp())) {
  console.error('界面没起来');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
}

console.log('=== 先把 WebGL 关掉这件事本身验了 ===');
const gl = await ev(`(() => {
  const c = document.createElement('canvas');
  return { webgl2: !!c.getContext('webgl2'), webgl1: !!c.getContext('webgl') };
})()`);
check('★ 这台"假机器"确实没有 WebGL2（否则后面的降级断言都不算数）', gl.webgl2 === false, JSON.stringify(gl));

console.log('\n=== 用户存的是 aura，看应用怎么处理 ===');
await ev(`localStorage.setItem('ieml.vfx','aura')`);
await send('Page.reload', {});
await sleep(2500);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
errors.length = 0;

const state = await ev(`(() => {
  const cards = [...document.querySelectorAll('.glass-refract')];
  const card = cards.find((c) => c.getBoundingClientRect().width > 200) || cards[0];
  const cs = card ? getComputedStyle(card) : null;
  const seg = document.querySelector('.seg[aria-label="视效档位"]');
  const auraBtn = seg ? [...seg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('灵动')) : null;
  return {
    stored: localStorage.getItem('ieml.vfx'),
    attr: document.documentElement.dataset.vfx,
    glAttr: document.documentElement.dataset.vfxGl ?? null,
    glCanvas: !!document.querySelector('canvas.glass-ambient-gl'),
    lensAttr: document.documentElement.dataset.vfxLens,
    lensed: cards.filter((c) => c.dataset.lens).length,
    cards: cards.length,
    backdrop: cs ? (cs.backdropFilter || 'none').slice(0, 60) : null,
    boxShadow: cs ? cs.boxShadow : null,
    bgHasTint: cs ? cs.backgroundImage.includes('rgba(') : false,
    auraDisabled: auraBtn ? auraBtn.disabled : null,
    auraTitle: auraBtn ? auraBtn.getAttribute('title') : null,
    auraHint: seg && seg.parentElement ? seg.parentElement.parentElement.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null,
  };
})()`);
console.log('   ' + JSON.stringify(state, null, 1).replace(/\n/g, '\n   '));

check('★ 存的还是 aura（不覆盖用户的选择）', state.stored === 'aura', String(state.stored));
check('★ 实际生效的是**适中**（默认档）', state.attr === 'mid', String(state.attr));
check('★ 不开放灵动：设置页那个按钮是**禁用**的', state.auraDisabled === true, String(state.auraDisabled));
check(
  '★ 而且**写明了原因**（不是默默藏起来）',
  typeof state.auraTitle === 'string' && /WebGL 2\.0/.test(state.auraTitle),
  String(state.auraTitle).slice(0, 70),
);
check('  不起 GL 背景', state.glCanvas === false && state.glAttr === null);
check('  一块玻璃都不挂折射（没有 WebGL2 就不走那条路）', state.lensed === 0, `${state.lensed}/${state.cards}`);
check('  但**材质还在**：模糊没丢', String(state.backdrop).includes('blur'), String(state.backdrop));
/*
 * ★ 2026-09-22（第五轮）：色散（红/蓝错位内阴影）与**柔光内辉**都已按用户要求删除
 *   （"卡片自身为什么带左红右蓝的颜色" + "我不希望卡片会自发光"）——
 *   厚度改成**一条清晰的内边**（`inset 0 0 0 1px`），所以这条验它。
 */
check(
  '  但**材质还在**：厚度内边还在（1px 内阴影）',
  /0px 0px 0px 1px/.test(String(state.boxShadow)),
  String(state.boxShadow).slice(-70),
);
check('  但**材质还在**：调色层还在', state.bgHasTint === true);
check('  设置页那一行的说明里提到了"已自动降到适中"', /已自动降到|被挡|开不了|不支持/.test(String(state.auraHint)), String(state.auraHint).slice(0, 90));

const perf = (await ev(`(async () => {
  const box = document.querySelector('.content') || document.scrollingElement;
  const pass = (f) => new Promise((res) => {
    const t = []; let last = performance.now(); let n = 0;
    const step = () => {
      const now = performance.now(); t.push(now - last); last = now;
      box.scrollTop += 26;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) box.scrollTop = 0;
      n += 1;
      if (n < f) requestAnimationFrame(step); else res(t);
    };
    requestAnimationFrame(step);
  });
  await pass(40); await pass(40);
  return await pass(80);
})()`)).slice(2);
const p95 = [...perf].sort((a, b) => a - b)[Math.floor(perf.length * 0.95)];
check('  降级后帧时间更省（p95 < 33ms）', p95 < 33, `p95 ${p95.toFixed(1)}ms`);
check('  全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '降级-设置页.png'), Buffer.from(shot.result.data, 'base64'));
console.log(`\n截图：${OUT}`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
