/**
 * 真机验证：实例概览页上那**两个启动键**已经拿掉，而启动能力还在别处
 * ------------------------------------------------------------------
 * 用户截图 + 「这两个启动键都不要」→ 删掉的两处：
 *   · 实例概览页头（`InstanceOverview` 的 `.page-actions` 里那个「启动 / 停止游戏」）
 *   · 实例二级页侧栏底部（`AppShell` 那个「启动这个版本 / 停止游戏」）
 *
 * 判据：
 *   ① 概览页头的按钮里**没有**「启动」「停止游戏」
 *   ② 实例侧栏的按钮里**没有**「启动这个版本」
 *   ③ （对照组）版本列表那一行的 ⋯ 菜单里**仍然有**「启动」—— 只是把重复的入口去掉了，
 *      不是把功能删了
 * 用法：node tools/live/probe-no-launch-buttons.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9985;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-nl-root');
const OWN = path.join(T, 'ieml-nl-own');
const PROFILE = path.join(T, 'ieml-nl-prof');
const FAKE = path.join(T, 'ieml-nl-appdata');
if (!EXE || !existsSync(EXE)) {
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
const dropLinks = async (root) => {
  const out = await ps(
    `Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | ForEach-Object { cmd /c rmdir "$($_.FullName)" }`,
  );
  if (out) console.log('拆掉联接：' + out);
};
for (const d of [ROOT, OWN, PROFILE, FAKE]) {
  await dropLinks(d);
  rmSync(d, { recursive: true, force: true });
}
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE, 'IEML'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify({
    instances: [
      {
        id: 'nl-1',
        mcVersion: '1.20.1',
        loader: { kind: 'fabric', version: '0.16.9', mcVersion: '1.20.1' },
        addons: [],
        config: { name: '探针·按钮', slug: 'nl-probe', isolation: 'auto', memoryMb: 4096, memorySource: 'auto', javaMode: 'auto' },
        createdAt: new Date().toISOString(),
        lastPlayedAt: null,
        totalPlaySeconds: 0,
      },
    ],
    active_id: null,
  }),
);

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

/* ---------- 对照组：版本列表那一行的 ⋯ 菜单里还有「启动」 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
await ev(`document.querySelector('.ver-item .ver-actions button')?.click()`);
await sleep(600);
const menu = await ev(`[...document.querySelectorAll('.menu button, [role="menu"] button')].map((b)=>(b.textContent||'').trim())`);
console.log('③ 版本列表行菜单：' + JSON.stringify(menu));
await ev(`document.body.click()`);
await sleep(400);

/* ---------- 进实例：概览页 + 二级侧栏 ---------- */
await ev(`document.querySelector('.ver-item')?.click()`);
await sleep(2500);
const headButtons = await ev(`[...document.querySelectorAll('.page-head .page-actions button')].map((b)=>(b.textContent||'').replace(/\\s+/g,' ').trim())`);
const sideButtons = await ev(`[...document.querySelectorAll('.sidebar button')].map((b)=>(b.textContent||'').replace(/\\s+/g,' ').trim())`);
const headText = await ev(`(document.querySelector('.page-head')?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 120)`);
console.log('① 概览页头按钮：' + JSON.stringify(headButtons));
console.log('② 实例侧栏按钮：' + JSON.stringify(sideButtons));
console.log('   页头文字：' + JSON.stringify(headText));

const bad = (list, words) => (list ?? []).filter((t) => words.some((w) => t.includes(w)));
const headBad = bad(headButtons, ['启动', '停止游戏']);
const sideBad = bad(sideButtons, ['启动这个版本', '停止游戏']);

console.log('\n===== 判据 =====');
console.log(`${headBad.length === 0 ? '✓' : '✗'} ① 概览页头没有启动/停止按钮${headBad.length ? '：' + JSON.stringify(headBad) : ''}`);
console.log(`${sideBad.length === 0 ? '✓' : '✗'} ② 实例侧栏没有「启动这个版本」${sideBad.length ? '：' + JSON.stringify(sideBad) : ''}`);
console.log(`${(menu ?? []).includes('启动') ? '✓' : '✗'} ③ 版本列表行菜单里**仍然有**「启动」（功能没删，只是去掉重复入口）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) {
  await dropLinks(d);
  rmSync(d, { recursive: true, force: true });
}
console.log('沙盒已清理');
process.exit(0);
