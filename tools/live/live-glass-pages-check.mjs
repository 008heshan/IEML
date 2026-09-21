/**
 * 真机验证：**液态玻璃在所有页面上都成立**（不只是设置页）。
 * ------------------------------------------------------------------
 * 为什么要有这条：前几轮的真机断言全都在**设置页**上做（那一页卡片最多、
 * 最好找目标）。但玻璃是**全应用**的东西：启动页、版本列表、下载页、资源中心、
 * 数据目录、关于页 —— 每页的卡片数量、背后的内容（有没有封面图）、
 * 滚动长度都不一样。只在设置页验过，等于只验了六分之一。
 *
 * 它查四件事（每页各一遍）：
 *   ① 玻璃表面确实挂上了折射滤镜（`.glass-refract` → `data-lens`）；
 *   ② 页面**没有抛出任何异常 / console.error**（玻璃运行时会遍历 DOM，
 *      某一页结构不同就可能踩空 —— 这类错误在开发机上不一定复现）；
 *   ③ 帧时间在预算内（卡片多、有封面图的页面是最重的）；
 *   ④ 截图存档，供人眼复核。
 *
 * 用法：
 *   node tools/live/live-glass-pages-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`；截图落在 `%TEMP%\ieml-glass-pages\`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9491;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass-pages');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-pages-prof');
const TIER = process.argv[3] ?? 'aura';

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
/** 页面报出来的错（异常 + console.error）——它们是"这一页有没有踩空"的证据 */
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    pageErrors.push('异常：' + (d?.exception?.description ?? d?.text ?? '?').split('\n')[0]);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    pageErrors.push('console.error：' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 140));
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
const shoot = async (tag) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`localStorage.setItem('ieml.vfx', ${JSON.stringify(TIER)})`);
await send('Page.reload', {});
await sleep(2500);
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
pageErrors.length = 0;

const measure = () =>
  ev(`(async () => {
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
  })()`);

const navItems = await ev(`[...document.querySelectorAll('.nav-item')].map((b) => (b.textContent || '').trim()).filter(Boolean)`);
console.log(`档位 ${TIER} · 共 ${Array.isArray(navItems) ? navItems.length : 0} 个页面：${Array.isArray(navItems) ? navItems.join(' / ') : '?'}\n`);

for (const label of Array.isArray(navItems) ? navItems : []) {
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1800);
  pageErrors.length = 0; // 只看这一页产生的

  const info = await ev(`(() => {
    const cards = [...document.querySelectorAll('.glass-refract')];
    const lensed = cards.filter((c) => c.dataset.lens);
    const glasses = [...document.querySelectorAll('.glass')];
    const withBg = glasses.filter((g) => (getComputedStyle(g).backgroundImage || '').includes('rgba('));
    return {
      cards: cards.length,
      lensed: lensed.length,
      glasses: glasses.length,
      tinted: withBg.length,
      imgs: document.querySelectorAll('.content img').length,
      gl: !!document.querySelector('canvas.glass-ambient-gl'),
      lensMaps: document.querySelectorAll('#ieml-lens-defs filter').length,
    };
  })()`);
  const perf = (await measure()).slice(2);
  const avg = perf.reduce((a, b) => a + b, 0) / perf.length;
  const p95 = [...perf].sort((a, b) => a - b)[Math.floor(perf.length * 0.95)];
  await sleep(200);

  console.log(
    `${label}：玻璃 ${info.glasses} · 参与折射 ${info.lensed}/${info.cards} · 有调色 ${info.tinted} · 图片 ${info.imgs} · 法线图 ${info.lensMaps}` +
      ` · 帧 p95 ${p95.toFixed(1)}ms`,
  );
  await shoot(`页面-${label}`);

  check(`  ${label}｜点得开`, clicked === true);
  check(`  ${label}｜这一页没有报错`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check(
    `  ${label}｜有玻璃的表面都挂上了折射`,
    info.cards === 0 || info.lensed === info.cards,
    `${info.lensed}/${info.cards}`,
  );
  check(`  ${label}｜帧时间在预算内（p95 < 45ms）`, p95 < 45, `${p95.toFixed(1)}ms（平均 ${avg.toFixed(1)}ms）`);
}

console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
