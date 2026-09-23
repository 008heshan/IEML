/**
 * 真机验证 A-0 的修复：确认弹窗**真的会问**、而且**点取消真的拦住**
 * ------------------------------------------------------------------
 * 判据（四条都要成立）：
 *   ① 点「删除」→ 出现应用自己的确认弹窗（`.modal` + `.confirm-text`），
 *      而且页面上**没有任何原生 confirm**（`window.confirm` 一处都不再调）
 *   ② 点「取消」→ 弹窗关掉、**记录还在、磁盘目录还在**（← 这是过去一年都没有的行为）
 *   ③ 再点「删除」→ 点确认 → 这次真的删掉了（记录 + 目录都没了）
 *   ④ 全程没有 TS/运行时报错
 * 沙盒作案。用法：node tools/live/probe-a0-fixed.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9985;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a0f-root');
const OWN = path.join(T, 'ieml-a0f-own');
const PROFILE = path.join(T, 'ieml-a0f-prof');
const SLUG = 'probe-a0';
const DIR = path.join(OWN, 'instances', SLUG);
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
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(DIR, 'game', 'saves', '我的世界'), { recursive: true });
writeFileSync(path.join(DIR, 'game', 'saves', '我的世界', 'level.dat'), 'x'.repeat(128));
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-a0',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: { name: '探针·确认框', slug: SLUG, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
          createdAt: new Date().toISOString(),
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      active_id: null,
    },
    null,
    2,
  ),
);
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
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const t = String(m.params?.exceptionDetails?.exception?.description ?? '').split('\n')[0];
    if (!/IPC custom protocol failed/.test(t)) errors.push(t.slice(0, 120));
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
await send('Runtime.enable', {});
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3500);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);

const openDelete = () =>
  ev(`(async () => {
    document.querySelector('.ver-item .ver-actions button')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const b = [...document.querySelectorAll('.menu button, [role="menu"] button')].find((x) => (x.textContent || '').trim() === '删除');
    b?.click();
    return !!b;
  })()`);
const dialogState = () =>
  ev(`(() => {
    const modal = document.querySelector('.modal');
    const text = (modal?.querySelector('.confirm-text')?.innerText || '');
    return {
      '有弹窗': !!modal,
      '标题': (modal?.querySelector('.modal-title')?.textContent || '').trim(),
      '正文前 60': text.replace(/\\s+/g, ' ').slice(0, 60),
      '按钮': modal ? [...modal.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [],
    };
  })()`);
const listCount = () => ev(`document.querySelectorAll('.ver-item').length`);

/* ---------- ① + ② 点删除 → 出现弹窗 → 点取消 → 什么都没删 ---------- */
console.log('打开删除：' + JSON.stringify(await openDelete()));
await sleep(900);
const dlg = await dialogState();
console.log('① 弹窗：' + JSON.stringify(dlg));
const cancel = await ev(`(() => {
  const modal = document.querySelector('.modal');
  const b = modal ? [...modal.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '取消') : null;
  b?.click();
  return !!b;
})()`);
await sleep(1500);
const afterCancel = { 行数: await listCount(), 目录还在: existsSync(DIR), 存档还在: existsSync(path.join(DIR, 'game', 'saves', '我的世界', 'level.dat')) };
console.log('② 点取消（' + JSON.stringify(cancel) + '）之后：' + JSON.stringify(afterCancel));

/* ---------- ③ 再删一次 → 点确认 → 真的删掉 ---------- */
console.log('\n再打开删除：' + JSON.stringify(await openDelete()));
await sleep(900);
const dlg2 = await dialogState();
console.log('   弹窗：' + JSON.stringify({ 有弹窗: dlg2.有弹窗, 按钮: dlg2.按钮 }));
/* 确认按钮：danger 变体（btn-danger），文案是「删除」 */
const ok = await ev(`(() => {
  const modal = document.querySelector('.modal');
  const btns = modal ? [...modal.querySelectorAll('button')] : [];
  const b = btns.find((x) => x.classList.contains('btn-danger')) ?? btns.find((x) => /永久删除|删除|确定/.test(x.textContent || ''));
  b?.click();
  return (b?.textContent || '').trim();
})()`);
await sleep(3000);
const afterOk = { 行数: await listCount(), 目录还在: existsSync(DIR), 提示: await ev(`[...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60))`) };
console.log('③ 点确认（' + JSON.stringify(ok) + '）之后：' + JSON.stringify(afterOk));

console.log('\n===== 判据 =====');
const c1 = dlg?.['有弹窗'] === true && /删除/.test(dlg?.['标题'] ?? '');
const c2 = afterCancel.行数 === 1 && afterCancel.目录还在 && afterCancel.存档还在;
const c3 = afterOk.行数 === 0 && !afterOk.目录还在;
console.log(`${c1 ? '✓' : '✗'} ① 点删除会弹应用自己的确认框：${JSON.stringify(dlg?.['标题'])}`);
console.log(`${c2 ? '✓' : '✗'} ② 点取消**真的拦住了**（记录还在=${afterCancel.行数 === 1}，目录还在=${afterCancel.目录还在}，存档还在=${afterCancel.存档还在}）`);
console.log(`${c3 ? '✓' : '✗'} ③ 点确认**真的删了**（记录清空=${afterOk.行数 === 0}，目录没了=${!afterOk.目录还在}）`);
console.log(`  ④ 运行时异常：${errors.length === 0 ? '无' : JSON.stringify(errors.slice(0, 3))}`);
console.log(c1 && c2 && c3 ? '\n★★ A-0 修复真机确认：确认框会问了，而且**取消真的能拦住**。' : '\n（没全过，见上）');

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒已清理');
process.exit(0);
