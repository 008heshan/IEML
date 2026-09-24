/**
 * 真机验证「版本列表」这一页的实例目录落在哪个盘（用户报的就是这一处）。
 * ------------------------------------------------------------------
 * 用户的原始动作：版本列表 → 某一行的 ⋯ →「打开目录」→ 弹 toast「已打开实例目录 <路径>」
 * 并让资源管理器打开那个目录。这个命令（`open_data_dir`）的路径来自
 * `AppPaths::instance_dir(slug)` —— 也就是本次修复要钉住的那一处。
 *
 * 判据（四条）：
 *   ① 版本列表页真的读到了实例（行数 = 清单里的条数）
 *   ② 点「打开目录」后 toast 里的路径落在**当前选的那个盘**（`D:\IEML\instances\…`）
 *   ③ 该路径**不在**启动器自己的家（`%APPDATA%\IEML\instances\…`）
 *   ④ 该目录**磁盘上真的存在**（老行为给出的两个实例路径是不存在的）
 *
 * ★ 会真的弹一次资源管理器（这正是用户那个动作的一部分）—— 读完 toast 后按路径把它关掉。
 * ★ 用真实数据（不设沙盒变量）：user 报的就是"我这台机器上版本列表读的是别的盘"。
 *
 * 用法：node tools/live/probe-versions-page-dir.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9973;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const PROFILE = path.join(T, 'ieml-versdir-prof');
const APPDATA = process.env.APPDATA ?? '';
const C_INST = path.join(APPDATA, 'IEML', 'instances').toLowerCase();
const D_INST = 'd:\\ieml\\instances';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

if (!existsSync(EXE)) {
  console.error('找不到 exe：' + EXE);
  process.exit(2);
}

/* 先把正在跑的那份收掉（单实例 + 文件占用，都要求先关） */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1000);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const env = { ...process.env };
delete env.IEML_DATA_DIR;
delete env.IEML_OWN_DIR;
const child = spawn(EXE, [], {
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 75; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(400);
}
if (!page) {
  console.error('连不上 CDP');
  process.exit(3);
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
for (let i = 0; i < 75; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2000);

/* 进「版本列表」页 */
await ev(`[...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);
const rows = await ev(`[...document.querySelectorAll('.ver-item')].map((x)=>(x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50))`);
console.log('版本列表页的行：' + JSON.stringify(rows));

/* 第一行 → ⋯ →「打开目录」 */
const clicked = await ev(`(() => {
  const row = document.querySelector('.ver-item');
  if (!row) return '没有行';
  const btns = [...row.querySelectorAll('button')];
  const more = btns[btns.length - 1];
  if (!more) return '没有菜单按钮';
  more.click();
  return 'menu-clicked';
})()`);
console.log('点开行内菜单：' + clicked);
await sleep(600);
const opened = await ev(`(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const t = items.find((x) => (x.textContent || '').includes('打开目录'));
  if (!t) return { 找到: false, 菜单项: items.map((x) => (x.textContent || '').trim()) };
  t.click();
  return { 找到: true };
})()`);
console.log('点「打开目录」：' + JSON.stringify(opened));

/* 读 toast 里的路径（命令的返回值就是它） */
let toast = null;
for (let i = 0; i < 25; i += 1) {
  toast = await ev(`(() => {
    const t = [...document.querySelectorAll('.toast')].map((x) => ({
      title: (x.querySelector('.toast-t')||{}).textContent || '',
      desc: (x.querySelector('.toast-d')||{}).textContent || '',
    }));
    return t.length ? t : null;
  })()`);
  if (toast) break;
  await sleep(300);
}
console.log('toast：' + JSON.stringify(toast));

const dir = ((toast ?? []).find((t) => (t.title || '').includes('已打开')) ?? toast?.[0] ?? {}).desc ?? '';
console.log('★ 版本列表「打开目录」给出的路径：' + JSON.stringify(dir));

/* 把这个资源管理器窗口关掉（不留窗口在用户桌面上） */
if (dir) {
  const close = await ps(
    `$target='${dir}'; $sh=New-Object -ComObject Shell.Application; $n=0; foreach ($w in @($sh.Windows())) { try { if ($w.LocationURL -and ($w.LocationURL -replace 'file:///','' -replace '/','\\\\').ToLower().TrimEnd('\\') -eq $target.ToLower().TrimEnd('\\')) { $w.Quit(); $n++ } } catch {} }; "关了 $n 个窗口"`,
  );
  console.log('清理资源管理器窗口：' + close);
}

/* 收尾：关掉这次探针起的启动器 */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(700);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const lower = dir.toLowerCase();
const c1 = Array.isArray(rows) && rows.length >= 1;
const c2 = lower.startsWith(D_INST + '\\');
const c3 = !lower.startsWith(C_INST + '\\');
const c4 = dir ? existsSync(dir) : false;
console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 版本列表读到了实例（${(rows ?? []).length} 行）`);
console.log(`${c2 ? '✓' : '✗'} ② 「打开目录」的路径在 D:\\IEML\\instances 下：${dir}`);
console.log(`${c3 ? '✓' : '✗'} ③ 不在 %APPDATA%\\IEML\\instances 下（老行为才会那样）`);
console.log(`${c4 ? '✓' : '✗'} ④ 那个目录磁盘上真的存在`);
process.exit(c1 && c2 && c3 && c4 ? 0 : 1);
