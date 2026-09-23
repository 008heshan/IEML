/**
 * 决定性测试：`confirm()` 到底弹不弹、返回什么
 * ------------------------------------------------------------------
 * 前两次互相矛盾：A-3/诊断探针里删除流程走完了却没有任何对话框事件；
 * 而"直接 await confirm()"那次整个探针卡死（不确定卡在哪一步）。
 * 这次**不 await**（fire-and-forget），只问两件事，2 秒内给结论：
 *   ① CDP 有没有收到 `Page.javascriptDialogOpening`
 *   ② 那次 evaluate 的返回值是什么（能返回就说明没阻塞）
 * 再做同一个测试的 `alert()` 对照组。
 * 用法：node tools/live/probe-native-dialogs.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9965;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-dlg2-root');
const OWN = path.join(T, 'ieml-dlg2-own');
const PROFILE = path.join(T, 'ieml-dlg2-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
spawn(EXE, [], {
  env: {
    ...process.env,
    IEML_DATA_DIR: ROOT,
    IEML_OWN_DIR: OWN,
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
const dialogs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ type: m.params?.type, msg: String(m.params?.message ?? '').slice(0, 50) });
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
/** 不等结果的 evaluate（用来观察"会不会阻塞"） */
const evAsync = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
await send('Page.enable', {});
await send('Runtime.enable', {});
/* 等界面就绪 */
for (let i = 0; i < 60; i += 1) {
  const r = await send('Runtime.evaluate', { expression: `!!document.querySelector('.nav-item')`, returnByValue: true });
  if (r.result?.result?.value === true) break;
  await sleep(400);
}
await sleep(2500);

for (const [label, expr] of [
  ['confirm', `window.__probe = { t0: performance.now() }; (() => { const r = confirm('IEML 探针：确认框'); window.__probe.r = r; window.__probe.ms = performance.now() - window.__probe.t0; return r; })()`],
  ['alert', `window.__probe2 = { t0: performance.now() }; (() => { alert('IEML 探针：alert'); window.__probe2.ms = performance.now() - window.__probe2.t0; return true; })()`],
  ['prompt', `window.__probe3 = { t0: performance.now() }; (() => { const r = prompt('IEML 探针：输入', 'def'); window.__probe3.r = r; window.__probe3.ms = performance.now() - window.__probe3.t0; return r; })()`],
]) {
  dialogs.length = 0;
  let settled = false;
  const p = evAsync(expr).then((r) => {
    settled = true;
    return r;
  });
  await sleep(2500);
  console.log(`\n=== ${label}() ===`);
  console.log('  2.5 秒内 evaluate 是否返回：' + settled);
  console.log('  CDP 收到的对话框事件：' + JSON.stringify(dialogs));
  if (!settled) {
    console.log('  → 说明它**阻塞**了（弹了框在等人点）。现在替用户点"确定/取消"，让流程继续');
    await send('Page.handleJavaScriptDialog', { accept: false });
    await sleep(1200);
    console.log('  应答之后 evaluate 是否返回：' + settled);
  }
  const res = await p;
  const v = res?.result?.result?.value;
  const probeVars = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ c: window.__probe, a: window.__probe2, p: window.__probe3 })`,
    returnByValue: true,
  });
  console.log('  返回值：' + JSON.stringify(v) + '   探针变量：' + (probeVars.result?.result?.value ?? ''));
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
process.exit(0);
