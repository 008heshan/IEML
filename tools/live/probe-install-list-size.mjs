/**
 * 真机验证：「安装游戏」页版本清单的字号也放大了一档
 * ------------------------------------------------------------------
 * 用户：「资源下载里的时代分类都大一点」→ 接着（截图 = 安装游戏页）「**这个也要放大**」。
 * 量的都是**真机算出来的字号**：
 *   ① 渠道分段控件（正式版 / 快照 / 愚人节 / 全部）  11px → **13px**
 *   ② 世代标题（26.3 / 26.2 …）                     12px → **13px**
 *   ③ 标题右侧的「N 个」                            12px → **13px**
 *   ④ 版本行里的版本号（26.3）                       13px → **14px**
 *   ⑤ 版本号下面那行小字（日期 · 盘上有什么）         11px → **12px**
 *   ⑥ 「点一行就进下一页…」那句提示                  11px → **12px**
 * 对照：侧栏导航项字号**不该**变（这次改动只落在 `.gw-col` 里）。
 * 用法：node tools/live/probe-install-list-size.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9977;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-il-root');
const OWN = path.join(T, 'ieml-il-own');
const PROFILE = path.join(T, 'ieml-il-prof');
const FAKE = path.join(T, 'ieml-il-appdata');
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
await sleep(800);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE, 'IEML'), { recursive: true });
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

/* 下载页默认就是「安装游戏」那一档 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(2000);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='安装游戏')?.click()`);
/* 等世代分组真的出来（清单是联网拉的，可能慢） */
let groups = 0;
for (let i = 0; i < 90; i += 1) {
  groups = (await ev(`document.querySelectorAll('.gw-col .ver-group').length`)) ?? 0;
  if (groups > 0) break;
  await sleep(1000);
}
console.log('世代分组数：' + groups);
await sleep(800);

const measured = await ev(`(() => {
  const fs = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { px: parseFloat(s.fontSize), 高: Math.round(r.height), 文本: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24) };
  };
  return {
    '① 渠道分段控件': fs('.gw-col .seg button'),
    '② 世代标题': fs('.gw-col .ver-group'),
    '③ 标题右侧「N 个」': fs('.gw-col .ver-group .dim'),
    '④ 版本行版本号': fs('.gw-col .wz-item-name'),
    '⑤ 版本行小字': fs('.gw-col .wz-item-sub'),
    '⑥ 那句提示': fs('.gw-col .gw-tip'),
    '对照·侧栏导航项': fs('.sidebar .nav-item'),
  };
})()`);
console.log('=== 真机量到的字号 ===');
console.log(JSON.stringify(measured, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 196, y: 150, width: 990, height: 430, scale: 1 } });
if (shot?.result?.data) {
  mkdirSync('tmp', { recursive: true });
  writeFileSync(path.join('tmp', 'verify-install-list-size.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('截图：tmp/verify-install-list-size.png');
}

const px = (k) => measured?.[k]?.px ?? null;
const want = [
  ['① 渠道分段控件', '① 渠道分段控件', 11, 13],
  ['② 世代标题', '② 世代标题', 12, 13],
  ['③ 标题右侧「N 个」', '③ 标题右侧「N 个」', 12, 13],
  ['④ 版本行版本号', '④ 版本行版本号', 13, 14],
  ['⑤ 版本行小字', '⑤ 版本行小字', 11, 12],
  ['⑥ 那句提示', '⑥ 那句提示', 11, 12],
];
console.log('\n===== 判据（改前 → 改后）=====');
for (const [label, key, before, after] of want) {
  console.log(`${px(key) === after ? '✓' : '✗'} ${label}：${before}px → ${px(key)}px（期望 ${after}）`);
}
console.log(`ℹ 对照·侧栏导航项：${px('对照·侧栏导航项')}px（这次改动只落在 .gw-col 里，它不该变）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
