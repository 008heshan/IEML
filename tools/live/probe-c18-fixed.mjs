/**
 * 真机验证 C-18 的修复：资源安装页的「来自 …」**跟着来源走**
 * ------------------------------------------------------------------
 * 缺陷原状：`ResourceInstallPage.tsx` 里写死 `来自 Modrinth` ——
 * 从 CurseForge 那一栏点进来的包也这么写（报告第 2 轮真机截图为证）。
 *
 * 判据：
 *   ① 来源切到 CurseForge 之后，点开一张卡的安装页，来源那行必须写 **CurseForge**
 *   ② 切回 Modrinth 时写 **Modrinth**（两边都要对，不能只是"反过来了"）
 *   ③ 如果 CF 这一侧因为网络/Key 拿不到数据 → **如实报告**（不当成修复失败，
 *      也不假装验过）
 * 用法：node tools/live/probe-c18-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9993;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-c18-root');
const OWN = path.join(T, 'ieml-c18-own');
const PROFILE = path.join(T, 'ieml-c18-prof');
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
  console.error('清理失败（继续）：' + d);
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

/** 走一遍：下载页 → 来源按钮 → 等卡片 → 点第一张卡的安装按钮 → 读来源那行 */
async function checkSource(label) {
  await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
  await sleep(1500);
  /* 资源那一栏（Mod）；如果当前在整合包页签就切过去 */
  await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='Mod')?.click()`);
  await sleep(1200);
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    b?.click();
    return !!b;
  })()`);
  if (!clicked) return { ok: false, why: '没找到来源按钮 ' + label };
  /* 等结果（最多 25 秒） */
  let cards = 0;
  for (let i = 0; i < 25; i += 1) {
    cards = (await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`)) ?? 0;
    if (cards > 0) break;
    await sleep(1000);
  }
  if (cards === 0) return { ok: false, why: '这一侧没拿到结果（网络 / Key）', cards: 0 };
  /* 卡片脚上的按钮才是入口（卡片本身没有 onClick） */
  const opened = await ev(`(() => {
    const card = document.querySelector('.res-card:not(.res-card-sk)');
    const b = card?.querySelector('.res-card-foot button') ?? null;
    b?.click();
    return { '卡片': (card?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), '点了按钮': (b?.textContent || '').trim() };
  })()`);
  for (let i = 0; i < 20; i += 1) {
    if ((await ev(`!!document.querySelector('.res-detail-meta')`)) === true) break;
    await sleep(500);
  }
  await sleep(1200);
  const meta = await ev(`(document.querySelector('.res-detail-meta')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  return { ok: true, cards, opened, meta };
}

const cf = await checkSource('CurseForge');
console.log('=== CurseForge 一侧 ===\n  ' + JSON.stringify(cf, null, 2).slice(0, 700));
const mr = await checkSource('Modrinth');
console.log('\n=== Modrinth 一侧 ===\n  ' + JSON.stringify(mr, null, 2).slice(0, 700));

console.log('\n===== 判据 =====');
const cfOk = cf.ok && /来自 CurseForge/.test(cf.meta || '');
const mrOk = mr.ok && /来自 Modrinth/.test(mr.meta || '');
console.log(`${cfOk ? '✓' : (cf.ok ? '✗' : '—')} ① CF 侧的安装页写「来自 CurseForge」：${JSON.stringify(cf.meta ?? cf.why)}`);
console.log(`${mrOk ? '✓' : (mr.ok ? '✗' : '—')} ② Modrinth 侧写「来自 Modrinth」：${JSON.stringify(mr.meta ?? mr.why)}`);
console.log(`   （两侧都写同一句才是这个缺陷；写死的那版无论哪侧都只会出现 Modrinth）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(600);
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
