/**
 * 真机复现（三合一）：把上一轮报告里还只是【代码】级的几条，尽量升级成【真机】。
 * ------------------------------------------------------------------
 * ① A-2「纯原版实例根本不使用磁盘上的 OptiFine 产物」——
 *    用启动页的**预览命令**（`preview_launch` 与 `launch_minecraft` 走同一个
 *    `prepare_spec`）看真实会执行哪一份版本 JSON：磁盘上明明有
 *    `versions/1.12.2-OptiFine_HD_U_G8`，而命令行里应当是原版那一份。
 * ② B-3「Quilt 会自动装 QFAPI」—— 在安装页选 Quilt，看「将自动安装」那块。
 * ③ C-1「CurseForge 那一半装不了」—— 整合包切到 CF，点一张卡，看版本区。
 *
 * 全程不启动游戏、不写任何数据。用法：
 *   node tools/live/probe-bug-repro-1.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9953;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-repro1-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
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

console.log('磁盘上 1.12.2 相关的版本目录：');
for (const d of readdirSync('D:\\IEML\\.minecraft\\versions')) {
  if (/1\.12\.2/.test(d)) console.log('  ' + d);
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
spawn(EXE, [], {
  env: {
    ...process.env,
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
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
const clickNav = (label) =>
  ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('${label}'))?.click()`);
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3000);

/* ============ ① 启动页：预览命令里用的是哪一份版本 JSON ============ */
console.log('\n=== ① 启动页：预览命令 ===');
await clickNav('启动');
await sleep(2500);
const picked = await ev(`(() => {
  const t = document.querySelector('.launch-inst-name, .inst-name, .page-title');
  const sel = [...document.querySelectorAll('button, .cs-btn')].map((b) => (b.textContent || '').trim()).filter(Boolean);
  return { 'title': (document.querySelector('.page-title')?.textContent || '').trim(), 'buttons': sel.slice(0, 12) };
})()`);
console.log('  启动页：' + JSON.stringify(picked));
const opened = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /预览命令/.test(x.textContent || ''));
  b?.click();
  return !!b;
})()`);
console.log('  点了「预览命令」=' + JSON.stringify(opened));
await sleep(3000);
const preview = await ev(`(() => {
  const modal = document.querySelector('.modal');
  const text = (modal?.innerText || '').replace(/\\r/g, '');
  const versions = [...text.matchAll(/versions[\\\\/][^\\s"']+/g)].map((m) => m[0]);
  return {
    '有模态': !!modal,
    '命令行片段': text.split('\\n').filter((l) => /java|versions|--|natives|classpath|-cp/i.test(l)).slice(0, 14),
    '出现过的 versions 路径': [...new Set(versions)].slice(0, 8),
    '含 OptiFine': /OptiFine/i.test(text),
    '含 --server': /--server/.test(text),
    '含 --port': /--port/.test(text),
  };
})()`);
console.log('  预览内容：' + JSON.stringify(preview, null, 2).slice(0, 1600));
await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => /关闭|✕/.test(x.textContent || x.getAttribute('aria-label') || '')); b?.click(); return !!b; })()`);
await sleep(800);

/* ============ ② 安装游戏：选 Quilt，看「将自动安装」 ============ */
console.log('\n=== ② 安装游戏 → Quilt → 「将自动安装」 ===');
await clickNav('下载');
await sleep(2000);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='安装游戏')?.click()`);
for (let i = 0; i < 40; i += 1) {
  if ((await ev(`document.querySelectorAll('.gw-col .wz-item').length > 0 || document.querySelectorAll('.gw-col .ver-group').length > 0`)) === true) break;
  await sleep(300);
}
/* 搜一个 Quilt 一定有的版本 */
await ev(`(() => {
  const input = document.querySelector('.gw-col .cw-left-tools input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '1.20.1');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(1200);
const rowText = await ev(`(() => {
  const row = [...document.querySelectorAll('.gw-col .wz-item')].find((r) => (r.querySelector('.wz-item-name')?.textContent || '').trim() === '1.20.1');
  const name = row ? (row.querySelector('.wz-item-name')?.textContent || '').trim() : null;
  row?.click();
  return name;
})()`);
console.log('  点了版本行：' + JSON.stringify(rowText));
for (let i = 0; i < 40; i += 1) {
  if ((await ev(`!!document.querySelector('.gw-full .base-opt')`)) === true) break;
  await sleep(300);
}
await sleep(2500);
const quilt = await ev(`(() => {
  const opt = [...document.querySelectorAll('.base-opt')].find((b) => /Quilt/.test(b.querySelector('.b-name')?.textContent || ''));
  const disabled = opt?.disabled ?? null;
  opt?.click();
  return { 'found': !!opt, 'disabled': disabled };
})()`);
console.log('  点了 Quilt：' + JSON.stringify(quilt));
await sleep(2500);
const auto = await ev(`(() => {
  const body = document.querySelector('.gw-full-body');
  const blocks = [...(body?.querySelectorAll('.wz-block') ?? [])].map((s) => ({
    'title': (s.querySelector('.wz-block-title')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    'items': [...s.querySelectorAll('.api-item')].map((i) => (i.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)),
  }));
  const foot = (document.querySelector('.gw-full .cw-foot')?.innerText || '').replace(/\\s+/g, ' ').trim();
  const install = [...document.querySelectorAll('.gw-full button')].find((b) => /^安装/.test((b.textContent || '').trim()));
  return { 'blocks': blocks, '底栏': foot.slice(0, 160), '安装按钮': (install?.textContent || '').trim(), '安装可点': install ? !install.disabled : null };
})()`);
console.log('  Quilt 选中后：' + JSON.stringify(auto, null, 2).slice(0, 1200));

/* ============ ③ 整合包：CurseForge 那一半 ============ */
console.log('\n=== ③ 整合包 → 来源 CurseForge → 点一张卡 ===');
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
await sleep(1200);
const cf = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'CurseForge');
  b?.click();
  return !!b;
})()`);
console.log('  切到 CurseForge=' + JSON.stringify(cf));
for (let i = 0; i < 60; i += 1) {
  const cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (typeof cards === 'number' && cards > 0) break;
  await sleep(1000);
}
await sleep(1000);
const cfList = await ev(`(() => ({
  '卡片数': document.querySelectorAll('.pack-card:not(.pack-card-sk)').length,
  '第一张': (document.querySelector('.pack-card:not(.pack-card-sk)')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
  '错误Note': (document.querySelector('.note-danger')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
}))()`);
console.log('  CF 列表：' + JSON.stringify(cfList));
const clicked = await ev(`(() => {
  const card = document.querySelector('.pack-card:not(.pack-card-sk)');
  card?.click();
  return !!card;
})()`);
console.log('  点了一张卡=' + JSON.stringify(clicked));
await sleep(6000);
const installView = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  const notes = [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140));
  return {
    '有安装页': /安装整合包/.test(text),
    '页头': text.slice(0, 80),
    '版本区文本': text.slice(0, 600),
    'Note': notes,
    '含"取版本列表失败"': /取版本列表失败/.test(text),
    '含"没有可下载的版本"': /没有可下载的版本/.test(text),
  };
})()`);
console.log('  点开之后：' + JSON.stringify(installView, null, 2).slice(0, 1600));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
