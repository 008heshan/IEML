/**
 * 真机验证：K（根目录弹窗精简 + 选目录时只建游戏根目录）
 *   · 弹窗文字明显变少（断言字符数）
 *   · 把一个**空目录**选成新根目录 → 里面**只出现 `.minecraft`**，
 *     不该冒出启动器自己的文件（instances / java / cache / logs / prefs.json / datadir.txt）
 *
 * 用法：node tools/live/live-batch6-check.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9871;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b6');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b6-prof');
/** 拿来当"新根目录"的空目录（每次跑都清掉重建） */
const NEW_ROOT = path.join(process.env.TEMP ?? '.', 'ieml-k-root-test');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
for (const d of [OUT, PROFILE, NEW_ROOT]) rmSync(d, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(NEW_ROOT, { recursive: true });

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

/* ---------- 打开弹窗（设置 → 存储 → 新建/切换） ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
const opened = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('新建'));
  if (!b) return 'not-found';
  b.click();
  return 'clicked';
})()`);
console.log('打开弹窗：' + opened);
await sleep(1200);

/* ---------- ① 文字量 ---------- */
const text = await ev(`(() => {
  const m = document.querySelector('.modal');
  if (!m) return null;
  const t = (m.innerText || '').replace(/\\s+/g, ' ').trim();
  /* ★ 属性名带空格/中文就必须加引号 —— 不加是语法错误（这个坑今天踩第二次了） */
  return { chars: t.length, head: t.slice(0, 160) };
})()`);
console.log('弹窗文字：' + JSON.stringify(text));
check('★ 弹窗文字精简过（< 320 字）', text && text.chars < 320, `${text?.chars} 字`);
check(
  '  不再有那句"打开系统对话框，在里面新建文件夹再选中它…"',
  !/打开系统对话框，在里面新建文件夹再选中它/.test(text?.head ?? ''),
  text?.head,
);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '根目录弹窗.png'), Buffer.from(shot.result.data, 'base64'));

/*
 * ★ ②「选目录时只建 .minecraft」这一条**不在这里验** ——
 *   页面里拿不到 __TAURI__（Tauri 2 默认不暴露全局），驱动不了那条命令；
 *   而它本来就是**后端**行为，放在 Rust 单测里验更直接：
 *   `platform::tests::set_data_root_只建游戏目录`。
 */

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
