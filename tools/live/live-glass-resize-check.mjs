/**
 * 真机验证：**窗口缩放时折射会不会重烘**（以及 GL 上下文有没有泄漏）。
 * ------------------------------------------------------------------
 * 为什么这条必须有：透镜法线图是按**元素当时的尺寸**烘出来的
 * （`ui/glass.ts` 的 `LensRegistry`，按 `宽×高×圆角` 量化成 key 缓存）。
 * 窗口一改尺寸，元素的框就变了 —— 如果没重烘，那张图会被**拉伸**到新尺寸，
 * 边缘的弯折就变形了（而这件事在静止不动时**完全看不出来**）。
 *
 * 同时验两件"只在特定条件下才暴露"的事：
 *   ① 改尺寸必须产生**新的**滤镜 key（而不是继续用旧图）；
 *   ② 反复改尺寸不能让滤镜无限增长（量化到 8px 是有意的 —— 拖窗口会疯狂触发
 *      ResizeObserver，逐像素重建会把主线程吃满；但"量化"不等于"不会涨"，
 *      所以要看它涨到多少、有没有回收）；
 *   ③ `main.tsx` 用了 `StrictMode`（开发期 effect 跑两遍）→
 *      GL 画布必须**只有一个**（多一个就是泄漏了上下文）；
 *      档位来回切（aura → mid → aura）之后也必须只有一个。
 *
 * 用法：
 *   node tools/live/live-glass-resize-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`；截图落在 `%TEMP%\ieml-glass-resize\`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9521;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass-resize');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-resize-prof');

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
await sleep(2500);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);

/** 采样：核心元素各自的 lens key + 已烘的滤镜总数 + GL 画布数 */
const sample = () =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.glass-refract')];
    return {
      viewport: [window.innerWidth, window.innerHeight],
      lensIds: cards.map((c) => c.dataset.lens || null),
      lensed: cards.filter((c) => c.dataset.lens).length,
      cards: cards.length,
      filters: document.querySelectorAll('#ieml-lens-defs filter').length,
      glCanvases: document.querySelectorAll('canvas.glass-ambient-gl').length,
      firstBackdrop: cards[0] ? (getComputedStyle(cards[0]).backdropFilter || '').slice(0, 52) : null,
    };
  })()`);

/** 改窗口尺寸（走浏览器自己的窗口 API，不是改 CSS） */
const win = (await send('Browser.getWindowForTarget', {})).result?.windowId;
const setSize = async (w, h) => {
  await send('Browser.setWindowBounds', { windowId: win, bounds: { width: w, height: h } });
  await sleep(900);
};

const base = await sample();
console.log(`· 初始视口 ${base.viewport.join('×')} · 玻璃 ${base.lensed}/${base.cards} · 滤镜 ${base.filters} 张 · GL 画布 ${base.glCanvases} 个`);
console.log(`· 卡片 lens key：${base.lensIds.filter(Boolean).slice(0, 3).join(', ')}`);

check('★ 页面只有一个 GL 画布（StrictMode 下 effect 跑两遍也不许泄漏）', base.glCanvases === 1, `${base.glCanvases} 个`);
check('  缩放前每块玻璃都挂着折射', base.lensed === base.cards, `${base.lensed}/${base.cards}`);

console.log('\n=== 改窗口尺寸，看折射有没有重烘 ===');
const sizes = [
  [1180, 760],
  [1020, 700],
  [1180, 760],
];
let prev = base;
for (const [w, h] of sizes) {
  await setSize(w, h);
  const s = await sample();
  const keyChanged = JSON.stringify(s.lensIds) !== JSON.stringify(prev.lensIds);
  const sizeChanged = JSON.stringify(s.viewport) !== JSON.stringify(prev.viewport);
  const zoomedOut = s.viewport[0] < 1000 || s.viewport[1] < 600;
  console.log(
    `  ${w}×${h} → 视口 ${s.viewport.join('×')} · 玻璃 ${s.lensed}/${s.cards} · 滤镜 ${s.filters} 张 · key ${s.lensIds.filter(Boolean)[0] ?? '无'}` +
      (zoomedOut ? '（视口太小，跳过断言）' : ''),
  );
  if (!zoomedOut) {
    /*
     * ★ 判据要分两种情况（第一版我把它们混成一条，于是"没改尺寸"被报成"没重烘"）：
     *   · 尺寸**真的变了** → key 必须跟着变（否则就是在用旧图拉伸）；
     *   · 尺寸**没变**（比如改回原来的大小）→ key 必须原样复用（缓存命中）。
     */
    check(
      sizeChanged
        ? `  ${w}×${h}：折射**重烘了**（key 随尺寸变）`
        : `  ${w}×${h}：尺寸没变时**复用缓存**（key 原样）`,
      sizeChanged ? keyChanged : !keyChanged,
      `key ${keyChanged ? '已变' : '未变'}`,
    );
    check(`  ${w}×${h}：重烘之后每块玻璃仍然挂着折射`, s.lensed === s.cards, `${s.lensed}/${s.cards}`);
    check(`  ${w}×${h}：GL 画布仍然只有一个`, s.glCanvases === 1, `${s.glCanvases} 个`);
  }
  prev = s;
}

const growth = prev.filters - base.filters;
console.log(`\n· 三次改尺寸之后，滤镜从 ${base.filters} 张涨到 ${prev.filters} 张（+${growth}）`);
/*
 * ★ 判据从"增长有限"收紧成"**只留在用的那些**"：
 *   没被任何元素引用的法线图会被回收（`LensRegistry.prune`）——
 *   加回收之前，三次改尺寸会从 4 张涨到 9 张（开着几小时就是几百张，
 *   每张 = 一个 SVG filter 节点 + 约 3KB 的 PNG dataURI）。
 */
check(
  '★ 滤镜数量**只留在用的那些**（无引用的已回收）',
  prev.filters <= prev.lensed + 4,
  '`' + prev.filters + ' 张 vs 在用 ' + prev.lensed + ' 块（改尺寸前 ' + base.filters + ' 张，' + (growth >= 0 ? '+' : '') + growth + '）' + '`',
);

console.log('\n=== 档位来回切，看 GL 上下文有没有泄漏 ===');
const clickTier = async (label) => {
  await ev(`(() => {
    const seg = document.querySelector('.seg[aria-label="视效档位"]');
    const b = seg ? [...seg.querySelectorAll('button')].find((x) => (x.textContent || '').includes(${JSON.stringify(label)})) : null;
    if (b && !b.disabled) b.click();
    return !!b;
  })()`);
  await sleep(900);
};
for (let i = 0; i < 3; i += 1) {
  await clickTier('适中');
  await clickTier('灵动');
}
const after = await sample();
console.log(`· 切了 3 个来回：GL 画布 ${after.glCanvases} 个 · 玻璃 ${after.lensed}/${after.cards} · 滤镜 ${after.filters} 张`);
check('★ 来回切档不泄漏 GL 画布（仍然只有一个）', after.glCanvases === 1, `${after.glCanvases} 个`);
check('  来回切档之后折射仍然完好', after.lensed === after.cards, `${after.lensed}/${after.cards}`);
check('  全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '缩放后.png'), Buffer.from(shot.result.data, 'base64'));
console.log(`\n截图：${OUT}`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
