/**
 * 诊断：点那条「删除」时，**到底有没有弹 confirm**
 * ------------------------------------------------------------------
 * A-3 的复现里删除流程走完了、还弹了「已永久删除」，但 CDP 一个对话框事件都没收到；
 * 而单独调 `confirm()` 会阻塞。这两件事必须对上账，否则说明我对删除路径的理解是错的。
 *
 * 做法：把 CDP 收到的**每个**事件连时间戳打出来；不自动应答对话框，
 *   等 6 秒看看有没有挂着；最后无论有没有都收尾。
 * 用法：node tools/live/probe-bug-repro-5.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9963;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-sbx2-root');
const OWN = path.join(T, 'ieml-sbx2-own');
const PROFILE = path.join(T, 'ieml-sbx2-prof');
const SLUG = 'probe-bug';
const LOCKED = path.join(OWN, 'instances', SLUG, 'game', 'mods', 'locked.jar');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.dirname(LOCKED), { recursive: true });
writeFileSync(LOCKED, 'x'.repeat(64));
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-probe-1',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: { name: 'IEML 探针实例', slug: SLUG, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
          createdAt: new Date().toISOString(),
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      active_id: null,
    },
    null,
    2,
  ),
);
const locker = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$f=[System.IO.File]::Open('${LOCKED}','Open','Read','None'); Start-Sleep -Seconds 90; $f.Close()`],
  { stdio: 'ignore' },
);
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
const t0 = Date.now();
const events = [];
let pendingDialogId = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (!m.method) return;
  if (m.method === 'Page.javascriptDialogOpening') {
    pendingDialogId = m.params?.message ?? '';
    events.push(`+${Date.now() - t0}ms  对话框(${m.params?.type})：${String(m.params?.message ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    events.push(`+${Date.now() - t0}ms  console.${m.params?.type}：${String(m.params?.args?.[0]?.value ?? '').slice(0, 80)}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    events.push(`+${Date.now() - t0}ms  异常：${String(m.params?.exceptionDetails?.text ?? '').slice(0, 90)}`);
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
await send('Page.enable', {});
await send('Runtime.enable', {});
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
console.log('事件流（从点 ⋯ 开始）:');
await ev(`document.querySelector('.ver-item .ver-actions button')?.click()`);
await sleep(600);
await ev(`(() => {
  const b = [...document.querySelectorAll('.menu button, [role="menu"] button')].find((x) => (x.textContent || '').trim() === '删除');
  b?.click();
  return !!b;
})()`);
/* 等 6 秒：如果 confirm 弹了就会挂在这里 */
await sleep(6000);
console.log(events.map((l) => '  ' + l).join('\n') || '  （没有任何事件）');
console.log('  挂着未应答的对话框：' + JSON.stringify(pendingDialogId));
const mid = await ev(`(() => ({ '行数': document.querySelectorAll('.ver-item').length, '提示条': [...document.querySelectorAll('.toast')].map((t) => (t.textContent||'').trim().slice(0,40)) }))()`);
console.log('  6 秒时页面状态：' + JSON.stringify(mid));
if (pendingDialogId !== null) {
  console.log('  → 手动应答第一个对话框（确认）');
  await send('Page.handleJavaScriptDialog', { accept: true });
  await sleep(2500);
  console.log('  应答后事件流：');
  console.log(events.map((l) => '    ' + l).join('\n'));
  console.log('  挂着未应答的对话框：' + JSON.stringify(pendingDialogId));
  if (pendingDialogId !== null) {
    console.log('  → 再应答第二个（回收站不可用 → 永久删除？）');
    await send('Page.handleJavaScriptDialog', { accept: true });
    await sleep(2500);
  }
}
const end = await ev(`(() => ({ '行数': document.querySelectorAll('.ver-item').length, '提示条': [...document.querySelectorAll('.toast')].map((t) => (t.textContent||'').trim().slice(0,50)) }))()`);
console.log('  最终：' + JSON.stringify(end));
console.log('  磁盘上目录还在：' + existsSync(path.join(OWN, 'instances', SLUG)));
locker.kill();
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
process.exit(0);
