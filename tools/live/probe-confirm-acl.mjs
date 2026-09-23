/**
 * 复核：在**真实配置**（不设任何沙盒环境变量）下，`confirm()` 的行为
 * ------------------------------------------------------------------
 * 只做一件事：在页面里调一次 `confirm('…')`，把它的**返回值**打出来。
 * 判据：
 *   · 返回 Promise / 报错字符串 → 这个"确认框"既没弹、又永远是真值
 *     （`if (!confirm(...)) return;` 这种写法就永远放行）
 *   · 返回 boolean false/true 且耗时可观 → 它是真的在问人
 * 不写任何数据、不点任何按钮。
 * 用法：node tools/live/probe-confirm-acl.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9967;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-acl-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
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
/* ★ 故意**不设** IEML_DATA_DIR / IEML_OWN_DIR —— 用用户真实的数据目录 */
spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
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
const ev = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

console.log('=== 真实配置下的 confirm() ===');
const raw = await ev(
  `(() => {
     const t0 = performance.now();
     const r = confirm('IEML 探针：这个框你看到了吗？');
     return {
       '返回值的类型': Object.prototype.toString.call(r),
       '是不是 Promise': !!(r && typeof r.then === 'function'),
       'typeof': typeof r,
       '耗时ms': Math.round(performance.now() - t0),
     };
   })()`,
  false,
);
console.log('  同步看：' + JSON.stringify(raw));

const awaited = await ev(
  `(async () => {
     const r = await confirm('IEML 探针：这个框你看到了吗？');
     return { 'await 之后的值': String(r), 'await 之后是真值吗': !!r };
   })()`,
  true,
);
console.log('  await 之后：' + JSON.stringify(awaited));

const guard = await ev(
  `(async () => {
     /* 复刻代码里的写法：if (!confirm(msg)) return; —— 会不会被"放行"？ */
     const proceed = !confirm('IEML 探针：守卫测试');
     return { '守卫是否放行（!confirm 为真）': proceed };
   })()`,
  false,
);
console.log('  守卫写法 `!confirm(...)`：' + JSON.stringify(guard));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(400);
rmSync(PROFILE, { recursive: true, force: true });
process.exit(0);
