/**
 * 探针：**哪些控件被别的东西盖住了**（真人点不到，而 JS `click()` 照样成功）
 * ------------------------------------------------------------------
 * 为什么需要它：这个仓库里所有真机检查都用 `element.click()`（JS 触发），
 *   而 JS 点击**不做命中测试** —— 一个盖在上面的装饰层（玻璃、渐变、遮罩）
 *   会让真人点不动，而检查全绿。这类缺陷只能靠"问浏览器这一点上是谁"来抓：
 *   `document.elementFromPoint(x, y)`。
 *
 * 判据：对每一个可点控件取中心点，`elementFromPoint` 的结果必须是它自己、
 *   它的祖先或它的后代（`<label>` 包 `<input>` 这种也算）。否则就是**被挡住**。
 *   ★ 只在控件**真的落在视口里**时判（滚出视野、被滚动容器裁掉的不算缺陷）。
 *
 * 用法：node tools/live/probe-click-blockers.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9943;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-cb-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
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
await sleep(900);
spawn(EXE, [], {
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
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};

const PROBE = `(() => {
  const sel = 'button, [role="tab"], [role="option"], input, select, textarea, a[href], .nav-item, .side-link, .ver-item, .pack-card, .res-card, .wz-item, .base-opt, .addon-opt, .acct-btn';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    /* 必须在视口里（滚出去的不算缺陷） */
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    /* 中心点可能落在子元素上（图标/文字），所以用"包含中心点"的候选来比 */
    const stack = document.elementsFromPoint(x, y);
    if (stack.length === 0) continue;
    const top = stack[0];
    const related = (a, b) => !!(a && b) && (a === b || a.contains(b) || b.contains(a));
    if (related(el, top)) continue;
    /* 再看栈里有没有它自己（可能只是被一个装饰层压着，但装饰层不代表点不到） */
    const idx = stack.findIndex((s) => related(el, s));
    const blocker = idx > 0 ? stack[idx - 1] : top;
    const cs = getComputedStyle(blocker);
    out.push({
      '控件': (el.className || el.tagName).toString().slice(0, 34),
      '文字': (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 22),
      '在': [Math.round(x), Math.round(y)],
      '盖住它的': (blocker.className || blocker.tagName).toString().slice(0, 40),
      'blockerPos': cs.position + ' z=' + cs.zIndex + ' pe=' + cs.pointerEvents,
      'blockerSize': Math.round(blocker.getBoundingClientRect().width) + 'x' + Math.round(blocker.getBoundingClientRect().height),
    });
    if (out.length > 12) break;
  }
  return out;
})()`;

const PAGES = [
  { name: '启动', go: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('启动'))?.click()` },
  { name: '版本列表', go: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()` },
  { name: '下载', go: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()` },
  { name: '设置', go: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()` },
  { name: '更新日志', go: `[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('更新日志'))?.click()` },
  { name: '关于', go: `[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()` },
];

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3000);

let total = 0;
for (const p of PAGES) {
  await ev(p.go);
  await sleep(2200);
  const hits = await ev(PROBE);
  console.log(`\n=== ${p.name} ===  ${Array.isArray(hits) ? hits.length : '?'} 个被挡的控件`);
  if (Array.isArray(hits)) {
    total += hits.length;
    for (const h of hits) console.log('  ' + JSON.stringify(h));
    if (hits.__err) console.log('  ' + JSON.stringify(hits));
  } else {
    console.log('  ' + JSON.stringify(hits));
  }
}

/* 二级页（进一个版本之后）：概览 / 设置 / Mod 管理 / 日志 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
const entered = await ev(`(() => {
  const row = document.querySelector('.ver-item'); row?.click(); return !!row;
})()`);
if (entered) {
  await sleep(2200);
  for (const sub of ['概览', '设置', 'Mod 管理', '日志']) {
    await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('${sub}'))?.click()`);
    await sleep(2200);
    const hits = await ev(PROBE);
    console.log(`\n=== 版本·${sub} ===  ${Array.isArray(hits) ? hits.length : '?'} 个被挡的控件`);
    if (Array.isArray(hits)) {
      total += hits.length;
      for (const h of hits) console.log('  ' + JSON.stringify(h));
    } else {
      console.log('  ' + JSON.stringify(hits));
    }
  }
} else {
  console.log('\n（没能进入版本二级页 —— 没有版本行）');
}

console.log(`\n===== 合计：${total} 个控件被别的东西盖住 =====`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
