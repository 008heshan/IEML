/**
 * 真机确认 C-2：「mods 目录」按钮打开的到底是哪个目录
 * ------------------------------------------------------------------
 * 界面上写着「打开这个实例的 mods 目录（game\mods）」，而实参是
 * `openDir('instance', slug)` —— 于是打开的其实是**实例根目录**。
 * 判据两条一起看：
 *   ① toast 里 Rust 返回的那个路径（Rust 返回的就是它打开的那个）
 *   ② 用 Shell.Application 读**表达式资源管理器窗口**自己的 LocationURL
 * 沙盒里做，跑完把那个窗口关掉。
 * 用法：node tools/live/probe-bug-repro-10.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9977;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-c2-root');
const OWN = path.join(T, 'ieml-c2-own');
const PROFILE = path.join(T, 'ieml-c2-prof');
const SLUG = 'probe-c2';
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
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(OWN, 'instances', SLUG, 'game', 'mods'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-c2',
          mcVersion: '1.20.1',
          /* ★ 必须是**带加载器**的实例：原版实例不开放「Mod 管理」（侧栏就不给这一项），
             上一版用了原版实例，于是页面上根本没有那个按钮 */
          loader: { kind: 'fabric', version: '0.15.11', mcVersion: '1.20.1' },
          addons: [],
          config: { name: '探针·C2 实例', slug: SLUG, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
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
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3000);

/* 版本列表 → 进实例 → Mod 管理 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2200);
await ev(`document.querySelector('.ver-item')?.click()`);
await sleep(2200);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('Mod 管理'))?.click()`);
await sleep(3500);
const landed = await ev(`(() => ({
  '二级页签': [...document.querySelectorAll('.nav-item')].map((b) => (b.textContent || '').trim()),
  '页面文本头': (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
}))()`);
console.log('到没到 Mod 管理：' + JSON.stringify(landed));

const before = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /mods 目录/.test(x.textContent || ''));
  return { '按钮文字': (b?.textContent || '').trim(), 'title': b?.getAttribute('title') || '', '找到': !!b };
})()`);
console.log('按钮：' + JSON.stringify(before));

const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /mods 目录/.test(x.textContent || ''));
  b?.click();
  return !!b;
})()`);
console.log('点了=' + JSON.stringify(clicked));
await sleep(3500);
const toast = await ev(`[...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160))`);
console.log('toast：' + JSON.stringify(toast));

/* 资源管理器窗口自己说它在哪 */
const win = await ps(
  `$sh = New-Object -ComObject Shell.Application; $sh.Windows() | ForEach-Object { try { $_.LocationURL } catch {} } | Where-Object { $_ -match 'probe-c2|ieml-c2' }`,
);
console.log('资源管理器窗口里的路径：' + JSON.stringify(win));

const expectedMods = path.join(OWN, 'instances', SLUG, 'game', 'mods');
const expectedRoot = path.join(OWN, 'instances', SLUG);
console.log('\n===== 判据 =====');
console.log('  界面承诺打开的（mods）：' + expectedMods);
console.log('  实际打开的：            ' + (win || '（没读到窗口）'));
const openedRoot = win.includes(SLUG) && !/\\game\\mods/i.test(win);
console.log(
  openedRoot
    ? '★★ C-2 真机确认：打开的确实是**实例根目录**，不是它承诺的 game\\mods。'
    : win
      ? '（窗口路径里带 game\\mods —— 这次没复现出"打开父目录"）'
      : '（没能读到窗口路径，但 toast 里 Rust 返回的是：见上）',
);

/* 关掉那个窗口，别留在用户桌面上 */
const closed = await ps(
  `$sh = New-Object -ComObject Shell.Application; $n = 0; $sh.Windows() | ForEach-Object { try { if ($_.LocationURL -match 'ieml-c2') { $_.Quit(); $n++ } } catch {} }; $n`,
);
console.log('关掉的资源管理器窗口数：' + JSON.stringify(closed));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
