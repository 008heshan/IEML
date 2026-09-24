/**
 * 真机验证 C-1 的修复：**来源换了，版本列表也要跟着换**
 * ------------------------------------------------------------------
 * 缺陷原状：安装页（资源 & 整合包）都写死 `api.modrinth.versions(project_id)` ——
 *   而 CurseForge 命中的 `project_id` 是**数字 id**，拿去问 Modrinth 只会得到
 *   404 / 空列表。真机上的表现就是那句
 *   「这个整合包没有可下载的版本 / 上游没有给它发布任何文件」——
 *   把"我们问错了接口"说成了"上游没有"。
 *
 * 判据（两条，各对应一处调用点）：
 *   ① 资源（Mod）：来源切 CurseForge → 点开一张卡 → **版本行必须 > 0**
 *   ② 整合包：来源切 CurseForge → 点开一个包 → 版本行 > 0，
 *      并且页面上要有那条**如实说明**「CF 的整合包还不能自动安装」（C-1 的另一半）
 * 用法：node tools/live/probe-c1-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9998;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-c1-root');
const OWN = path.join(T, 'ieml-c1-own');
const PROFILE = path.join(T, 'ieml-c1-prof');
const FAKE_APPDATA = path.join(T, 'ieml-c1-appdata');
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
const dropLinks = async (root) => {
  const out = await ps(
    `Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | ForEach-Object { cmd /c rmdir "$($_.FullName)" }`,
  );
  if (out) console.log('拆掉联接：' + out);
};
const clean = async (d) => {
  for (let i = 0; i < 6; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      return;
    } catch {
      await sleep(700);
    }
  }
};
for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  await dropLinks(d);
  await clean(d);
}
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE_APPDATA, 'IEML'), { recursive: true });
/*
 * ★ 资源页要求**先有一个实例**（"资源要装进某个版本的目录里"）——
 *   第一版探针的沙盒里没有实例，于是 Mod 页签根本不渲染来源控件，
 *   我还差点把它当成缺陷。这里放一个探针实例。
 */
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify({
    instances: [
      {
        id: 'c1-probe',
        mcVersion: '26.2',
        loader: null,
        addons: [],
        config: { name: '探针·C1', slug: 'c1-probe', isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
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
    APPDATA: FAKE_APPDATA,
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

const waitFor = async (expr, tries, ms) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(ms);
  }
  return null;
};

/* ---------- ① 资源（Mod）：CF 来源的安装页要有版本行 ---------- */
console.log('=== ① 资源安装页（来源 = CurseForge）===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(1500);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='Mod')?.click()`);
await sleep(1200);
/* ★ 来源分段控件可能要等页签内容渲染出来 —— 轮询几次再点（第一版只试了一次就放弃了） */
let cfClicked = false;
for (let i = 0; i < 15 && !cfClicked; i += 1) {
  cfClicked = (await ev(`(() => {
    const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').trim() === 'CurseForge');
    if (!b) return false;
    b.click();
    return true;
  })()`)) === true;
  if (!cfClicked) await sleep(1000);
}
console.log('  切到 CurseForge：' + cfClicked);
if (!cfClicked) {
  const diag = await ev(`(() => ({
    '页签': [...document.querySelectorAll('.tabs .tab')].map((t) => (t.textContent || '').trim()),
    '分段按钮': [...document.querySelectorAll('.seg button')].map((b) => (b.textContent || '').trim()).slice(0, 8),
    '分段控件的 aria-label': [...document.querySelectorAll('.seg')].map((s) => s.getAttribute('aria-label')),
    '页头文字': (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 140),
  }))()`);
  console.log('  诊断：' + JSON.stringify(diag, null, 2));
  globalThis.__resRows = 0;
}const cards = await waitFor(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`, 30, 1000);
console.log('  卡片数：' + cards);
if (cards) {
  await ev(`(() => {
    const card = document.querySelector('.res-card:not(.res-card-sk)');
    (card?.querySelector('.res-card-foot button') ?? null)?.click();
  })()`);
  await waitFor(`!!document.querySelector('.res-detail-meta')`, 20, 500);
  const rows = await waitFor(`document.querySelectorAll('.res-version').length`, 40, 1000);
  const first = await ev(`[...document.querySelectorAll('.res-version')].slice(0,2).map((r)=>(r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60))`);
  const err = await ev(`(document.querySelector('.note')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,120)`);
  console.log('  版本行数：' + rows);
  console.log('  前两行：' + JSON.stringify(first));
  if (err) console.log('  页面上的提示：' + JSON.stringify(err));
  globalThis.__resRows = rows ?? 0;
} else {
  globalThis.__resRows = 0;
}

/* ---------- ② 整合包：CF 来源要有版本行 + 如实说明 ---------- */
console.log('\n=== ② 整合包安装页（来源 = CurseForge）===');
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(1200);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
await sleep(1500);
const packCf = await ev(`(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').trim() === 'CurseForge');
  b?.click();
  return !!b;
})()`);
console.log('  切到 CurseForge：' + packCf);
const packCards = await waitFor(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`, 40, 1200);
console.log('  整合包卡片数：' + packCards);
let packRows = 0;
let note = '';
if (packCards) {
  await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
  await sleep(4000);
  /* ★ CF 的文件接口有时慢（50 条要几次请求）—— 多等一会儿；还在加载就如实说，不判红 */
  packRows = (await waitFor(`document.querySelectorAll('.res-version').length`, 60, 1000)) ?? 0;
  const stillLoading = await ev(`/正在取版本列表/.test(document.querySelector('.content')?.innerText || '')`);
  if (packRows === 0 && stillLoading) console.log('  （60 秒后仍在"正在取版本列表…" —— 这条**不作结论**）');
  note = (await ev(`(() => {
    const t = document.querySelector('.content')?.innerText || '';
    const i = t.indexOf('CurseForge 上发布的版本');
    return i >= 0 ? t.slice(Math.max(0, i - 40), i + 220).replace(/\\s+/g, ' ').trim() : '';
  })()`)) ?? '';
  console.log('  版本行数：' + packRows);
  if (note) console.log('  页面上那段说明：' + JSON.stringify(note.slice(0, 200)));
}

console.log('\n===== 判据 =====');
console.log(`${(globalThis.__resRows ?? 0) > 0 ? '✓' : '✗'} ① CF 来源的资源安装页列出了**它自己的**版本（行数 ${globalThis.__resRows ?? 0}）`);
console.log(
  `${packRows > 0 ? '✓' : '✗'} ② CF 来源的整合包安装页列出了版本（行数 ${packRows}）` +
    '（修前这里拿 CF 的数字 id 去问 Modrinth，只会是 0 / 报错）',
);
console.log(
  `${/还不能自动安装/.test(note) ? '✓' : '✗'} ③ 并且**如实说明** CF 整合包还不能自动安装（不是"上游没有文件"）`,
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(600);
for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
