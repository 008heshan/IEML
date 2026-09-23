/**
 * 真机复现 A-3：**「已永久删除」而磁盘上一个字节都没删**
 * ------------------------------------------------------------------
 * ## 怎么做到"不碰用户数据"
 * 启动器支持两个环境变量（`platform.rs`）：
 *   · `IEML_DATA_DIR` —— 游戏根目录（`instances.json` / `prefs.json` 就住在这里）
 *   · `IEML_OWN_DIR`  —— 启动器自己的目录（`instances/` 在这里）
 * 两个都指到 `%TEMP%` 下的沙盒 → **完全隔离**，随便删。
 *
 * ## 怎么让它走到那条出 bug 的重试分支
 * `VersionsPage` 的删除流程是：先删回收站 → 失败才问用户"永久删除吗" → 再删一次。
 * 用**独占句柄锁住实例目录里的一个文件**，回收站那次必然失败（Windows 不允许移动
 * 有打开的句柄的文件）→ 就走到了那条分支。
 *
 * 判据（三条都要成立才算复现）：
 *   ① 界面上弹出「已永久删除」
 *   ② 版本列表里那条记录已经没了
 *   ③ `instances/<slug>/` **还在磁盘上**（而且从此没有任何入口能删它）
 *
 * 用法：node tools/live/probe-bug-repro-4.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9959;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-sbx-root');
const OWN = path.join(T, 'ieml-sbx-own');
const PROFILE = path.join(T, 'ieml-sbx-prof');
const SLUG = 'probe-bug';
const LOCKED = path.join(OWN, 'instances', SLUG, 'game', 'mods', 'locked.jar');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}

/* ---------- 沙盒：一份"有一个实例"的 instances.json + 实例目录 + 被占住的文件 ---------- */
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.dirname(LOCKED), { recursive: true });
writeFileSync(LOCKED, 'x'.repeat(64));
const store = {
  instances: [
    {
      id: 'inst-probe-1',
      mcVersion: '1.12.2',
      loader: null,
      addons: [],
      config: {
        name: 'IEML 探针实例',
        slug: SLUG,
        isolation: 'auto',
        memoryMb: 2048,
        memorySource: 'auto',
        javaMode: 'auto',
      },
      createdAt: new Date().toISOString(),
      lastPlayedAt: null,
      totalPlaySeconds: 0,
    },
  ],
  active_id: null,
};
writeFileSync(path.join(ROOT, 'instances.json'), JSON.stringify(store, null, 2));
console.log('沙盒：' + ROOT + '\n       ' + OWN);
console.log('  实例目录已建，并在里面放了一个**被独占打开**的文件：' + LOCKED);

/* ---------- 独占句柄（撑住 120 秒，够我们点完） ---------- */
const locker = spawn(
  'powershell',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$f=[System.IO.File]::Open('${LOCKED}','Open','Read','None'); Write-Output 'locked'; Start-Sleep -Seconds 120; $f.Close()`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let lockerSaid = '';
locker.stdout.on('data', (d) => (lockerSaid += d));
await new Promise((r) => setTimeout(r, 2500));
console.log('  锁文件进程：' + JSON.stringify(lockerSaid.trim()));

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
if (!page) {
  console.error('连不上 CDP');
  locker.kill();
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
/** 收到的原生对话框（confirm）—— 记下来 + 自动确认 */
const dialogs = [];
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(String(m.params?.message ?? '').replace(/\s+/g, ' ').slice(0, 160));
    await send('Page.handleJavaScriptDialog', { accept: true });
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
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(2500);

/* ---------- 走真实路径：版本列表 → 行 ⋯ → 删除 → 两个确认框 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
const before = await ev(`(() => ({
  '行数': document.querySelectorAll('.ver-item').length,
  '第一行': (document.querySelector('.ver-item')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
}))()`);
console.log('\n删除前：' + JSON.stringify(before));

await ev(`document.querySelector('.ver-item .ver-actions button')?.click()`);
await sleep(700);
const menu = await ev(`[...document.querySelectorAll('.menu button, [role="menu"] button')].map((b) => (b.textContent || '').trim())`);
console.log('  ⋯ 菜单：' + JSON.stringify(menu));
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('.menu button, [role="menu"] button')].find((x) => (x.textContent || '').trim() === '删除');
  b?.click();
  return !!b;
})()`);
console.log('  点了「删除」=' + JSON.stringify(clicked));
await sleep(3000);
console.log('  弹出的原生确认框：' + JSON.stringify(dialogs));

const after = await ev(`(() => ({
  '行数': document.querySelectorAll('.ver-item').length,
  '提示条': [...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90)),
  '空状态': (document.querySelector('.empty-state, .empty-note')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 60),
}))()`);
const dirStill = existsSync(path.join(OWN, 'instances', SLUG));
const fileStill = existsSync(LOCKED);
console.log('\n删除后：' + JSON.stringify(after));
console.log('  磁盘上 instances/' + SLUG + '/ 还在吗：' + dirStill);
console.log('  被锁的那个文件还在吗：' + fileStill);

console.log('\n===== 判据 =====');
const saidDeleted = (after?.提示条 ?? []).some((t) => /已永久删除/.test(t));
console.log(`${saidDeleted ? '✓' : '✗'} ① 界面弹出「已永久删除」：${JSON.stringify(after?.提示条)}`);
console.log(`${(after?.行数 ?? 9) === 0 ? '✓' : '✗'} ② 记录没了（行数=${after?.行数}）`);
console.log(`${dirStill ? '✓' : '✗'} ③ 磁盘目录**还在**（instances/${SLUG}/）`);
console.log(
  saidDeleted && (after?.行数 ?? 9) === 0 && dirStill
    ? '\n★★ A-3 真机复现成功：界面说"已永久删除"，磁盘一个字节都没删。'
    : '\n（这次没复现出预期的三条，见上面）',
);

/* ---------- 收尾：杀进程、删沙盒 ---------- */
locker.kill();
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(600);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒已清理：' + [ROOT, OWN, PROFILE].join(' / '));
process.exit(0);
