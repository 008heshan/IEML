/**
 * 探针：**主题到底有没有按 prefs.json 恢复**（一次只问这一个问题）
 * ------------------------------------------------------------------
 * 采样点：冷启动后 0.5s / 2s / 5s / 9s 各读一次
 *   · `<html data-theme>`（真正生效的那套）
 *   · 设置页里被选中的主题卡（界面**声称**选中的那套）
 *   · prefs.json 的全文（落盘的那份）
 * 三者必须一致；不一致就是缺陷，而且要能说清"哪一步丢了"。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9947;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-th-prof');
const PREFS = path.join(process.env.APPDATA ?? '.', 'IEML', 'prefs.json');
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
const prefs = () => {
  try {
    return JSON.parse(readFileSync(PREFS, 'utf8'));
  } catch (e) {
    return { __err: String(e) };
  }
};

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1500);
console.log('冷启动前 prefs.theme = ' + JSON.stringify(prefs().theme));

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
    const pages = (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    page = pages[0];
    if (pages.length > 1) console.log(`（有 ${pages.length} 个 page target：${pages.map((p) => p.url).join(' | ')}）`);
    if (page) break;
  } catch {}
  await sleep(300);
}
if (!page) {
  console.error('连不上 CDP');
  process.exit(2);
}
console.log('连上的 target url = ' + page.url);
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

for (const t of [500, 2000, 5000, 9000]) {
  await sleep(t === 500 ? 500 : t - (t === 2000 ? 500 : t === 5000 ? 2000 : 5000));
  const dom = await ev(`document.documentElement.getAttribute('data-theme')`);
  const st = await ev(`(() => {
    const cards = [...document.querySelectorAll('.theme-card, .theme-item, [data-theme-id]')];
    return { 'cards': cards.length, 'on': cards.filter((c) => /(^|\\s)(on|sel|active)(\\s|$)/.test(c.className)).map((c) => (c.textContent || '').slice(0, 12)) };
  })()`);
  console.log(`t≈${t}ms  data-theme=${JSON.stringify(dom)}  主题卡=${JSON.stringify(st)}  prefs.theme=${JSON.stringify(prefs().theme)}`);
}

/* 打开设置页，读"界面声称选中的那套" */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()`);
await sleep(2000);
const settings = await ev(`(() => {
  const cards = [...document.querySelectorAll('.theme-card, .theme-item, [data-theme-id]')];
  return {
    'count': cards.length,
    'picked': cards.filter((c) => /(^|\\s)(on|sel|active)(\\s|$)/.test(c.className)).map((c) => (c.textContent || '').replace(/\\s+/g, ' ').slice(0, 16)),
    'ariaChecked': cards.filter((c) => c.getAttribute('aria-checked') === 'true').map((c) => (c.textContent || '').slice(0, 12)),
  };
})()`);
console.log('设置页里的主题卡：' + JSON.stringify(settings));
console.log('prefs 全文键值：' + JSON.stringify(prefs()));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
