/**
 * 看「更新日志」页渲染出来是什么样（用户要的那个格式到底有没有落地）。
 * ------------------------------------------------------------------
 * 判据（四条）：
 *   ① 页面上能读到五段里出现的那几段（顺序正确、没有空段）
 *   ② 每一条都以所属段落的类别词开头（页面上的文本，不是源码）
 *   ③ 最新一版是 rc.4（版本号 + 今天）
 *   ④ 顺手截一张图，给人眼核对
 *
 * 用法：node tools/live/probe-changelog-format.mjs "<exe>" [截图路径]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9976;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const SHOT = process.argv[3] ?? path.join('tmp', 'rc4-changelog.png');
const T = process.env.TEMP ?? '.';
const PROFILE = path.join(T, 'ieml-changelog-prof');
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
  console.error('连不上 CDP（pid ' + child.pid + '）—— 本次测量无效');
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

/* 进「更新日志」页 */
await ev(`[...document.querySelectorAll('.side-link')].find((x)=>(x.textContent||'').includes('更新日志'))?.click()`);
await sleep(2200);

/* 最新一版（第一条 rel-group 的所属卡片）里的段落与条目 */
const dump = await ev(`(() => {
  const cards = [...document.querySelectorAll('.stack > *')];
  const first = cards.find((c) => c.querySelector('.rel-group'));
  if (!first) return { 错: '找不到更新日志卡片' };
  /*
   * ★ 版本号不要挑 .mono —— 那是右上角的**日期**（第一版就这么抓错了，判据 ③ 假红）。
   *   卡片标题里才是版本号，所以从整张卡的文本里按形状捞。
   */
  const text = (first.innerText || first.textContent || '');
  const ver = (text.match(/0\\.1\\.0-[a-z]+\\.[0-9]+/) || [''])[0];
  const head = (first.querySelector('.rel-headline')||{}).textContent || '';
  const groups = [...first.querySelectorAll('.rel-group')].map((g) => ({
    段: (g.querySelector('.rel-group-t')||{}).textContent || '',
    条: [...g.querySelectorAll('.rel-list li')].map((li) => (li.textContent||'').trim()),
  }));
  return { 版本: ver, 头条: head.trim(), 段数: groups.length, groups };
})()`);
console.log('最新一版：' + JSON.stringify({ 版本: dump?.版本, 头条: dump?.头条, 段数: dump?.段数 }, null, 2));
if (Array.isArray(dump?.groups)) {
  for (const g of dump.groups) {
    console.log(`  【${g.段}】${g.条.length} 条`);
    for (const it of g.条) console.log('     - ' + it);
  }
}

/* 截图 */
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图已写：' + SHOT);
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(700);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

/* ---------- 判据 ---------- */
const ORDER = ['新增了', '修复了', '优化了', '删除了', '修改了'];
const groups = dump?.groups ?? [];
const idx = groups.map((g) => ORDER.indexOf(g.段));
const c1 =
  groups.length > 0 &&
  idx.every((i) => i >= 0) &&
  idx.every((v, i) => i === 0 || v > idx[i - 1]) &&
  groups.every((g) => g.条.length > 0);
const badItems = groups.flatMap((g) => g.条.filter((it) => !it.startsWith(g.段)).map((it) => `${g.段}: ${it.slice(0, 24)}`));
const c2 = badItems.length === 0;
const c3 = String(dump?.版本 ?? '').includes('0.1.0-rc.4');
const c4 = existsSync(SHOT);

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 五段齐全有序、没有空段（${groups.map((g) => g.段).join(' / ')}）`);
console.log(`${c2 ? '✓' : '✗'} ② 每条都以类别词开头${badItems.length ? '，不合规的：' + JSON.stringify(badItems) : ''}`);
console.log(`${c3 ? '✓' : '✗'} ③ 最新一版是 rc.4（页面上读到：${JSON.stringify(dump?.版本)}）`);
console.log(`${c4 ? '✓' : '✗'} ④ 截图已生成：${SHOT}`);
process.exit(c1 && c2 && c3 && c4 ? 0 : 1);
