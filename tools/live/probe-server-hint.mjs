/**
 * 真机确认：实例设置页里，**服务器地址写坏端口**时那句提示到底怎么说的。
 * 做法：进一个实例 → 设置 → 在「服务器地址」里输入 `1.2.3.4:abc` → 读输入框下方那句提示。
 * ★ 只输入、**不保存**（这一页是 Draft 事务：离开即丢弃），点也不点任何保存/启动按钮。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9949;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-hint-prof');
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
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(1800);
await ev(`document.querySelector('.ver-item')?.click()`);
await sleep(1800);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()`);
await sleep(2000);

const found = await ev(`(() => {
  const inputs = [...document.querySelectorAll('input')];
  const hit = inputs.find((i) => /服务器|地址|server/i.test((i.getAttribute('aria-label') || '') + (i.placeholder || '') + (i.closest('.field-row')?.textContent || '')));
  if (!hit) return { 'ok': false, 'inputs': inputs.map((i) => (i.getAttribute('aria-label') || i.placeholder || i.type)).slice(0, 14) };
  window.__srv = hit;
  return { 'ok': true, 'label': (hit.getAttribute('aria-label') || ''), 'ph': hit.placeholder, 'value': hit.value };
})()`);
console.log('服务器地址输入框：' + JSON.stringify(found));

if (found?.ok) {
  const hint = await ev(`(() => {
    const el = window.__srv;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '1.2.3.4:abc');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  const after = await ev(`(() => {
    const el = window.__srv;
    const row = el.closest('.field-row') || el.parentElement;
    return {
      '输入的值': el.value,
      '这一行里的提示': (row?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      '全页含"原样传给游戏"': /原样传给游戏/.test(document.body.innerText || ''),
      '全页含"默认端口"': /默认端口/.test(document.body.innerText || ''),
    };
  })()`);
  console.log('输入 `1.2.3.4:abc` 之后：' + JSON.stringify(after));
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
