/**
 * 真机复现 ③：整合包切到 **CurseForge** 之后，点一张卡到底能不能装（C-1）。
 * 上一版探针漏了"先退出整屏加载器页"这一步，所以页签点不到 —— 这次按真实路径走。
 * 用法：node tools/live/probe-bug-repro-2.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9955;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-repro2-prof');
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
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3000);

/* 下载 → 确保**不在**整屏的子页面里 → 整合包页签 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(2500);
const state0 = await ev(`(() => ({
  '在整屏子页': !!document.querySelector('.gw-full'),
  '页签数': document.querySelectorAll('.tabs .tab').length,
}))()`);
console.log('刚进下载页：' + JSON.stringify(state0));
if (state0?.在整屏子页) {
  await ev(`[...document.querySelectorAll('.gw-full .page-head button')].find((b)=>/返回/.test(b.textContent||''))?.click()`);
  await sleep(1500);
}
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
await sleep(2500);

const segs = await ev(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find((s) => /CurseForge/.test(s.textContent || ''));
  return { '找到来源分段控件': !!seg, '选项': seg ? [...seg.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [] };
})()`);
console.log('来源分段控件：' + JSON.stringify(segs));

const toCf = await ev(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find((s) => /CurseForge/.test(s.textContent || ''));
  const b = seg ? [...seg.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'CurseForge') : null;
  b?.click();
  return !!b;
})()`);
console.log('切到 CurseForge=' + JSON.stringify(toCf));

let cards = 0;
for (let i = 0; i < 90; i += 1) {
  cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (typeof cards === 'number' && cards > 0) break;
  await sleep(1000);
}
await sleep(1200);
const list = await ev(`(() => ({
  '卡片数': document.querySelectorAll('.pack-card:not(.pack-card-sk)').length,
  '第一张': (document.querySelector('.pack-card:not(.pack-card-sk)')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
  '数据来自': (document.querySelector('.dim')?.textContent || '').trim().slice(0, 40),
  '错误': [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)),
}))()`);
console.log('CF 列表：' + JSON.stringify(list, null, 2));

const clicked = await ev(`(() => {
  const card = document.querySelector('.pack-card:not(.pack-card-sk)');
  card?.click();
  return (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 60);
})()`);
console.log('点开的那张卡：' + JSON.stringify(clicked));
await sleep(8000);
const view = await ev(`(() => {
  const content = document.querySelector('.content');
  const text = (content?.innerText || '').replace(/\\s+/g, ' ');
  const notes = [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160));
  const rows = document.querySelectorAll('.res-version, .wz-item, .res-vgroup, [role="button"]').length;
  return {
    '安装页标题': /安装整合包/.test(text),
    '文本前 400': text.slice(0, 400),
    'Note': notes,
    '含取版本列表失败': /取版本列表失败/.test(text),
    '含没有可下载的版本': /没有可下载的版本/.test(text),
    '含选择版本并安装': /选择版本并安装/.test(text),
    '可点元素数': rows,
  };
})()`);
console.log('点开之后：' + JSON.stringify(view, null, 2).slice(0, 1800));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
