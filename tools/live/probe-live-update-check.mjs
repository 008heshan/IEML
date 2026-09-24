/**
 * 最后一道真机确认：**装到桌面的那份 rc.2** 认得线上最新版本、版本号也自报正确。
 * ------------------------------------------------------------------
 * 判据：
 *   ① 关于页显示的版本号 = 0.1.0-rc.2（与刚发布的线上版本一致）
 *   ② 点一次「检查更新」→ 落定文案必须是「已是最新版本」
 *      （它确实就是线上最新；如果端点/验签/解析任一环坏了，这里会变成「检查更新失败：…」）
 * 用法：node tools/live/probe-live-update-check.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9986;
const EXE = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '.', 'Desktop', 'IEML.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-live-root');
const OWN = path.join(T, 'ieml-live-own');
const PROFILE = path.join(T, 'ieml-live-prof');
const FAKE = path.join(T, 'ieml-live-appdata');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
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
await sleep(900);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE, 'IEML'), { recursive: true });

console.log('被测产物：' + EXE);
spawn(EXE, [], {
  env: {
    ...process.env,
    APPDATA: FAKE,
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
if (!page) {
  console.error('连不上 CDP');
  process.exit(2);
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

/* 关于页：版本号 + 更新状态 */
await ev(`[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()`);
await sleep(1200);
const shown = await ev(`(document.querySelector('.about-ver')?.textContent || '').trim()`);
console.log('① 关于页显示的版本号：' + JSON.stringify(shown));

await ev(`[...document.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('检查更新'))?.click()`);
let line = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(1500);
  const t = (await ev(`(document.querySelector('.about-line')?.textContent || '').trim()`)) ?? '';
  if (!/正在检查/.test(t)) line = t;
  if (/已是最新版本|检查更新失败|有新版本/.test(t)) break;
}
console.log('② 点过「检查更新」之后：' + JSON.stringify(line));

console.log('\n===== 判据 =====');
console.log(`${shown === '0.1.0-rc.2' ? '✓' : '✗'} ① 自报版本号是 0.1.0-rc.2：${JSON.stringify(shown)}`);
console.log(
  `${line.includes('已是最新版本') ? '✓' : '✗'} ② 端点可达且验签通过（否则这里会是「检查更新失败：…」）：${JSON.stringify(line)}`,
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
