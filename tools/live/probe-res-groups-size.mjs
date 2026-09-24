/**
 * 真机验证：资源下载页的「时代分类」字号放大了
 * ------------------------------------------------------------------
 * 用户：「资源下载里的时代分类都大一点，目前有点小有点费眼」。
 * 这里量的就是那三处的**计算字号**（不是读 CSS 源码，是真机上算出来的）：
 *   · 版本 chips（「全部 42 / 26.3 12 / 1.21 30 …」）
 *   · 分组标题（「26.3」+ 右侧「N 个版本」）
 *   · 组头上方那行「X 的全部版本（N 个）」
 *
 * 判据（对照改前的值，改前从 HEAD 的 CSS 读出来的）：
 *   ① chips       12px → **13px**
 *   ② 分组标题     13px → **14px**（等宽那一段也一样）
 *   ③ 「N 个版本」 12px → **13px**
 *   ④ 顶部那行     12px → **13px**
 * 另存一张截图供人眼复核。
 * 用法：node tools/live/probe-res-groups-size.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9979;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-fs-root');
const OWN = path.join(T, 'ieml-fs-own');
const PROFILE = path.join(T, 'ieml-fs-prof');
const FAKE = path.join(T, 'ieml-fs-appdata');
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
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify({
    instances: [
      {
        id: 'fs-1',
        mcVersion: '26.2',
        loader: null,
        addons: [],
        config: { name: '探针·字号', slug: 'fs-probe', isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
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

/* 进整合包安装页（那里有 chips + 分组，且不依赖"装过什么"） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(1500);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
/*
 * ★ 等**真正的卡片**（不是骨架屏）—— 这台机器上 Modrinth 有时要几十秒。
 *   前两版探针都是"看到 6 个骨架就当加载完了"，点了个空。
 */
let realCards = 0;
for (let i = 0; i < 90; i += 1) {
  realCards = (await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`)) ?? 0;
  if (realCards > 0) break;
  await sleep(1000);
}
console.log('真卡片数：' + realCards);
if (realCards === 0) {
  console.log('列表一直没加载出来（网络）—— 这次不作结论');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
await sleep(3000);
/* 等版本区（分组标题也会在这一刻出现） */
let rows = 0;
for (let i = 0; i < 90; i += 1) {
  rows = (await ev(`document.querySelectorAll('.res-vgroup-head').length`)) ?? 0;
  if (rows > 0) break;
  await sleep(1000);
}
await sleep(800);
if (rows === 0) {
  const diag = await ev(`(() => ({
    '页头': (document.querySelector('.page-title')?.textContent || '').trim(),
    '版本区文字': (document.querySelector('.res-versions')?.innerText || '(没有 .res-versions)').replace(/\\s+/g, ' ').slice(0, 120),
  }))()`);
  console.log('版本区没出来：' + JSON.stringify(diag));
}

const measured = await ev(`(() => {
  const fs = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { px: parseFloat(s.fontSize), family: s.fontFamily.split(',')[0], 高: Math.round(r.height), 文本: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26) };
  };
  return {
    'chips（版本筛选那排）': fs('.res-vchips .chip'),
    '分组标题（整行）': fs('.res-vgroup-head'),
    '分组标题里的版本号': fs('.res-vgroup-name'),
    '分组右侧「N 个版本」': fs('.res-vgroup-head .dim'),
    '顶部「全部版本（N 个）」': fs('.res-versions-head'),
    '版本行里的版本号（对照，不该变）': fs('.res-version-name'),
  };
})()`);
console.log('=== 真机量到的字号 ===');
console.log(JSON.stringify(measured, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 196, y: 120, width: 990, height: 420, scale: 1 } });
if (shot?.result?.data) {
  mkdirSync('tmp', { recursive: true });
  writeFileSync(path.join('tmp', 'verify-res-groups-size.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('截图：tmp/verify-res-groups-size.png');
}

const before = { chips: 12, head: 13, dim: 12, top: 12 };
const px = (k) => measured?.[k]?.px ?? null;
const ok = (got, want) => got === want;
console.log('\n===== 判据（改前 → 改后）=====');
console.log(`${ok(px('chips（版本筛选那排）'), 13) ? '✓' : '✗'} ① chips：${before.chips}px → ${px('chips（版本筛选那排）')}px（期望 13）`);
console.log(`${ok(px('分组标题（整行）'), 14) ? '✓' : '✗'} ② 分组标题：${before.head}px → ${px('分组标题（整行）')}px（期望 14）`);
console.log(
  `${ok(px('分组标题里的版本号'), 14) ? '✓' : '✗'} ②b 分组标题里的版本号（等宽）：${px('分组标题里的版本号')}px（期望 14）`,
);
console.log(`${ok(px('分组右侧「N 个版本」'), 13) ? '✓' : '✗'} ③ 「N 个版本」：${before.dim}px → ${px('分组右侧「N 个版本」')}px（期望 13）`);
console.log(`${ok(px('顶部「全部版本（N 个）」'), 13) ? '✓' : '✗'} ④ 顶部那行：${before.top}px → ${px('顶部「全部版本（N 个）」')}px（期望 13）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
