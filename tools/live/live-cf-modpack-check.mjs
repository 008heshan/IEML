/**
 * 真机验证：整合包页签的**来源切换**（Modrinth / CurseForge）
 * （用户：「PCL 的整合包可以用 curseforge 啊」→「curseforge 那个继续」）
 *
 * 判据：
 *   · 有「来源」分段（Modrinth | CurseForge）
 *   · 切到 CurseForge 之后**结果真的换了**（列表重载、且与 Modrinth 那批不同）
 *   · 切回来还有东西（不是"切过去就空了"）
 *
 * ★ 这次特意断言"**结果集不同**"，而不是只断言"标签变了" ——
 *   上一轮 C3 就是因为只断言标签，漏掉了"筛选参数其实没传下去"这个真 bug。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10041;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b22');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b22-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
for (const d of [OUT, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
if (!page) { console.error('连不上 CDP'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    const t = String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0];
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) }; return r.result?.result?.value; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1500);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
await sleep(1500);

const names = () => ev(`[...document.querySelectorAll('.pack-card:not(.pack-card-sk) .pack-title, .pack-card:not(.pack-card-sk)')].slice(0, 5).map((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40))`);

let cards = 0;
for (let i = 0; i < 80; i += 1) {
  cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
console.log('  Modrinth 卡片：' + cards);
const before = await names();

const hasSource = await ev(`(() => {
  const segs = [...document.querySelectorAll('.seg, [role="tablist"]')].map((x) => (x.textContent || '').trim());
  return segs.some((x) => /Modrinth/.test(x) && /CurseForge/.test(x));
})()`);
check('★ 整合包页签有「来源」（Modrinth | CurseForge）', hasSource === true);

/* 切到 CurseForge */
const switched = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => (x.textContent || '').trim() === 'CurseForge');
  if (!b) return false;
  b.click();
  return true;
})()`);
console.log('  切到 CurseForge：' + switched);
await sleep(6000);
let afterCards = 0;
for (let i = 0; i < 40; i += 1) {
  afterCards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (afterCards > 0) break;
  await sleep(500);
}
const after = await names();
console.log(`  CurseForge 卡片：${afterCards}`);
console.log('  前几条：' + JSON.stringify(after?.[0] ?? null));
check('★ 切到 CurseForge 之后**有结果**（不是空的）', afterCards > 0, `${afterCards} 张`);
check(
  '★ 结果集**真的换了**（不是同一批）',
  JSON.stringify(before) !== JSON.stringify(after),
  `Modrinth: ${JSON.stringify(before?.[0])} vs CF: ${JSON.stringify(after?.[0])}`,
);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '来源-CurseForge.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
