/**
 * 真机验证：**低性能损耗模式 × 视效档位**（两个开关互相压制的那条路）。
 * ------------------------------------------------------------------
 * 这条逻辑是我自己写的、而且**从来没验过**：
 *   `AppContext` 里盯着 `<html>` 的 `low-perf` 类（那个开关的**真源就是类**），
 *   一旦开着，就把灵动档压到适中、并且让控制器把 GL 背景与折射都收掉 ——
 *   理由是"两个开关说的是同一件事的两面：low-perf 是'我这台机器别搞花样'，
 *   视效档位是'我想要多花的材质'；同时打开时**省电那条赢**"。
 *
 * 但"写了对"和"真的对"是两件事，这条路径有几个容易写错的地方：
 *   · 类的监听是不是真的活着（设置页切开关 → 玻璃运行时有没有反应）；
 *   · 关掉 low-perf 之后**能不能回来**（只关不恢复是最常见的半成品）；
 *   · 用户选的档位**不许被改写**（关了 low-perf 应该回到他选的灵动，
 *     而不是悄悄停在适中）。
 *
 * 用法：
 *   node tools/live/live-glass-lowperf-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`；截图落在 `%TEMP%\ieml-glass-lowperf\`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9531;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass-lowperf');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-lowperf-prof');

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
// 起手：用户选的是灵动
await ev(`localStorage.setItem('ieml.vfx','aura')`);
await ev(`localStorage.setItem('ieml.lowPerf','0')`);
await send('Page.reload', {});
await sleep(2500);
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

const state = () =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.glass-refract')];
    const card = cards.find((c) => c.getBoundingClientRect().width > 200) || cards[0];
    const seg = document.querySelector('.seg[aria-label="视效档位"]');
    const auraBtn = seg ? [...seg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('灵动')) : null;
    const hint = seg && seg.parentElement && seg.parentElement.parentElement
      ? seg.parentElement.parentElement.textContent.replace(/\\s+/g, ' ')
      : '';
    return {
      lowPerfClass: document.documentElement.classList.contains('low-perf'),
      attr: document.documentElement.dataset.vfx,
      stored: localStorage.getItem('ieml.vfx'),
      glCanvas: document.querySelectorAll('canvas.glass-ambient-gl').length,
      lensed: cards.filter((c) => c.dataset.lens).length,
      cards: cards.length,
      backdrop: card ? (getComputedStyle(card).backdropFilter || 'none') : null,
      auraSelected: auraBtn ? auraBtn.getAttribute('aria-pressed') === 'true' : null,
      segHint: hint.slice(0, 220),
    };
  })()`);

/** 点设置页那个"低性能损耗模式"开关（role=switch + aria-label） */
const toggleLowPerf = async () => {
  const hit = await ev(`(() => {
    const sw = document.querySelector('button[role="switch"][aria-label="低性能损耗模式"]');
    if (!sw) return 'not-found';
    sw.click();
    return 'clicked';
  })()`);
  await sleep(1200);
  return hit;
};

const before = await state();
console.log(`· 起手：low-perf=${before.lowPerfClass} · 档位=${before.attr} · 存的=${before.stored} · GL ${before.glCanvas} · 折射 ${before.lensed}/${before.cards} · 卡片 backdrop=${String(before.backdrop).slice(0, 34)}`);
check('起手是灵动档（GL 在、折射在）', before.attr === 'aura' && before.glCanvas === 1 && before.lensed === before.cards, `${before.attr} · GL ${before.glCanvas} · ${before.lensed}/${before.cards}`);

console.log('\n=== 打开「低性能损耗模式」，看它压不压得住灵动档 ===');
const on = await toggleLowPerf();
const during = await state();
console.log(`· 打开后：low-perf=${during.lowPerfClass} · 档位=${during.attr} · 存的=${during.stored} · GL ${during.glCanvas} · 折射 ${during.lensed}/${during.cards} · 卡片 backdrop=${String(during.backdrop).slice(0, 34)}`);
check('  开关点得到', on === 'clicked', String(on));
check('★ low-perf 类真的挂上了（它是这个开关的唯一真源）', during.lowPerfClass === true);
check('★ 灵动档被压到**适中**', during.attr === 'mid', String(during.attr));
check('★ GL 背景收掉了', during.glCanvas === 0, `${during.glCanvas} 个`);
check('★ 折射也收掉了（low-perf 的规则用 !important 关掉全部 backdrop-filter）', during.lensed === 0 && String(during.backdrop) === 'none', `折射 ${during.lensed} · backdrop=${String(during.backdrop).slice(0, 24)}`);
check('★ **不覆盖用户的选择**（存的还是 aura）', during.stored === 'aura', String(during.stored));
check('★ 那一行**写明了被谁压住**', /低性能损耗模式开着|它会压住灵动视效/.test(during.segHint), during.segHint.slice(0, 90));
check('  三档控件仍然显示用户选的是「灵动」', during.auraSelected === true, String(during.auraSelected));

const perfLow = (await ev(`(async () => {
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
const p95Low = [...perfLow].sort((a, b) => a - b)[Math.floor(perfLow.length * 0.95)];
check('  低性能模式下帧时间很省（p95 < 20ms）', p95Low < 20, `p95 ${p95Low.toFixed(1)}ms`);

console.log('\n=== 关掉它，看能不能**回来**（只关不恢复是最常见的半成品）===');
const off = await toggleLowPerf();
const after = await state();
console.log(`· 关掉后：low-perf=${after.lowPerfClass} · 档位=${after.attr} · GL ${after.glCanvas} · 折射 ${after.lensed}/${after.cards} · 卡片 backdrop=${String(after.backdrop).slice(0, 34)}`);
check('  开关点得到', off === 'clicked', String(off));
check('★ 档位回到用户选的**灵动**（不是停在适中）', after.attr === 'aura', String(after.attr));
check('★ GL 背景回来了', after.glCanvas === 1, `${after.glCanvas} 个`);
check('★ 折射回来了', after.lensed === after.cards && String(after.backdrop).includes('url("#ieml-lens-'), `${after.lensed}/${after.cards}`);
check('  全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '关掉低性能模式后.png'), Buffer.from(shot.result.data, 'base64'));
console.log(`\n截图：${OUT}`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
