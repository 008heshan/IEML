/**
 * 真机验证 B-2 的修复：**关于页的更新状态不再说假话**
 * ------------------------------------------------------------------
 * 缺陷原状（`AboutPage.tsx` 那条三元链）：9 种更新状态里只处理 4 种，
 * 其余全落到「已是最新版本」—— 包括 `error`（断网 / 404 / 签名失败）、
 * `idle`（还没查过）、`downloading`、`installing`。
 * 断网点「检查更新」，界面告诉用户一个**假事实**。
 *
 * 判据（三条）：
 *   ① 冷启动**还没查过**时，那一行不许是「已是最新版本」（应当是"还没检查过更新"）
 *   ② 点「检查更新」之后，等到状态落定；落定后的文案必须是这两种之一：
 *        · 「已是最新版本」           （phase = uptodate，真的查成功了）
 *        · 「检查更新失败：<原因>」    （phase = error —— 而且**必须带出原因**）
 *      —— 失败时"有原因"就是这条缺陷修好的直接证据（以前原因根本没人显示）
 *   ③ 全程那一行**不出现**"已是最新版本"与"失败"同时成立的矛盾说法
 *
 * 用法：node tools/live/probe-b2-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9991;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-b2-root');
const OWN = path.join(T, 'ieml-b2-own');
const PROFILE = path.join(T, 'ieml-b2-prof');
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

/* 清理：先杀进程，再拆联接，再删（顺序踩过 EBUSY） */
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
    } catch (e) {
      if (i === 5) {
        console.error('清理失败（继续跑）：' + d + ' → ' + e.message);
        return;
      }
      await sleep(700);
    }
  }
};
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });

spawn(EXE, [], {
  env: {
    ...process.env,
    IEML_DATA_DIR: ROOT,
    IEML_OWN_DIR: OWN,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
    /*
     * ★ 想看**失败**那一支时：把代理指向一个死端口，更新检查必然失败。
     *   （这台机器的网络是通的，正常跑只会得到"已是最新版本"，
     *     那样就验不到"失败时把原因说出来"这条 —— 而那正是 B-2 的重点。）
     */
    ...(process.env.IEML_PROBE_FORCE_FAIL
      ? { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' }
      : {}),
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
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
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

/* ① 冷启动、还没查过时：那一行必须说实话 */
/* ★ 关于页的入口是侧栏的 `.side-link`（不是主导航 `.nav-item`）—— 第一版点错了，读到空串 */
await ev(`[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()`);
await sleep(800);
const line = () => ev(`(document.querySelector('.about-line')?.textContent || '').trim()`);
const first = (await line()) ?? '';
const isErrClass = await ev(`!!document.querySelector('.about-line-err')`);
console.log('① 刚进关于页：' + JSON.stringify(first) + '（标红=' + isErrClass + '）');
const claimWhenIdle = first.includes('已是最新版本');

/* ② 点「检查更新」，等状态落定 */
await ev(`[...document.querySelectorAll('button')].find((b)=>(b.textContent||'').includes('检查更新'))?.click()`);
let settled = '';
let mark = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(1500);
  const t = (await line()) ?? '';
  mark = await ev(`!!document.querySelector('.about-line-err')`);
  if (!/正在检查/.test(t)) settled = t;
  /* 落定判据：出现"已是最新"/"失败"/"有新版本"这类终态，或者 15 秒没变 */
  if (/已是最新版本|检查更新失败|有新版本|已经下好/.test(t)) break;
}
console.log('② 点过「检查更新」之后：' + JSON.stringify(settled) + '（标红=' + mark + '）');

console.log('\n===== 判据 =====');
console.log(`${!claimWhenIdle ? '✓' : '✗'} ① 还没查过时不说「已是最新版本」：${JSON.stringify(first)}`);
const okOk = settled.includes('已是最新版本') && !settled.includes('失败');
const okErr = /检查更新失败：.+/.test(settled);
const note = okErr ? '（失败，而且**带出了原因** —— 这正是修好的地方）' : '';
console.log(
  `${okOk || okErr ? '✓' : '✗'} ② 落定后的文案是真的：${JSON.stringify(settled)}${note}`,
);
const redOk = okErr ? mark === true : mark === false;
console.log(`${redOk ? '✓' : '✗'} ③ 只有失败时才标红：标红=${mark}（失败=${okErr}）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(600);
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
