/**
 * 真机复现 ③-b：CurseForge 的整合包版本列表到底从哪来。
 * 判据：
 *   · 选一个**只在 CurseForge 上**的包（RLCraft）→ 若版本列表失败 = 走的是 Modrinth 的接口；
 *   · 再选一个**两边都有**的包（Fabulously Optimized）→ 列表能出来，但页面自己写着「来自 Modrinth」。
 * 用法：node tools/live/probe-bug-repro-3.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9957;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-repro3-prof');
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
  await sleep(400);
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
const search = async (q) => {
  await ev(`(() => {
    const input = document.querySelector('input[placeholder*="整合包"]') || [...document.querySelectorAll('input')].find((i) => /搜索/.test(i.placeholder || ''));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await ev(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '搜索')?.click()`);
  for (let i = 0; i < 60; i += 1) {
    const n = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
    if (typeof n === 'number' && n > 0) return n;
    await sleep(1000);
  }
  return 0;
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3000);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(2200);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
await sleep(2500);
await ev(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find((s) => /CurseForge/.test(s.textContent || ''));
  seg?.querySelectorAll('button')?.forEach((b) => { if ((b.textContent || '').trim() === 'CurseForge') b.click(); });
})()`);
await sleep(2500);

for (const [q, label] of [['RLCraft', 'CF 独有：RLCraft'], ['Fabulously Optimized', '两边都有：Fabulously Optimized']]) {
  console.log(`\n=== ${label}（来源=CurseForge）===`);
  const n = await search(q);
  const list = await ev(`(() => ({
    '卡片数': document.querySelectorAll('.pack-card:not(.pack-card-sk)').length,
    '第一张': (document.querySelector('.pack-card:not(.pack-card-sk)')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
    '来源标注': [...document.querySelectorAll('.dim')].map((d) => (d.textContent || '').trim()).find((t) => /数据来自/.test(t)) || '',
  }))()`);
  console.log('  搜索结果：' + JSON.stringify(list) + `（搜索函数数到 ${n}）`);
  const clicked = await ev(`(() => {
    const card = document.querySelector('.pack-card:not(.pack-card-sk)');
    card?.click();
    return (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 50);
  })()`);
  console.log('  点开：' + JSON.stringify(clicked));
  await sleep(9000);
  const view = await ev(`(() => {
    const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
    const notes = [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 170));
    return {
      '安装页': /安装整合包/.test(text),
      '版本块': (text.match(/的全部版本（\\d+ 个）/) || [])[0] || '（没有版本列表）',
      '来自哪': (text.match(/来自 (Modrinth|CurseForge)/) || [])[0] || '（没说）',
      '失败的提示': notes,
      '文本前 260': text.slice(0, 260),
    };
  })()`);
  console.log('  结果：' + JSON.stringify(view, null, 2));
  /* 回列表（安装页有「返回整合包列表」） */
  await ev(`[...document.querySelectorAll('button')].find((b) => /返回整合包列表/.test(b.textContent || ''))?.click()`);
  await sleep(1500);
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
