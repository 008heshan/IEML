/**
 * 真机验证：**整合包也是单开一页**（用户：「整合包安装为什么没做单开一页的设计」）
 *
 * 判据：
 *   · 点整合包卡片之后，**列表让位**（卡片数变 0）、出现整合包信息卡与版本列表
 *   · 有「返回整合包列表」，点了能回去
 *   · 版本列表是**这个整合包的真实版本**（条数 > 1，不是只有最新那个）
 *   · 有实例名称输入
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 10001;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b18');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b18-prof');
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

const upstreamOk = await (async () => {
  try {
    const r = await fetch('https://api.modrinth.com/v2/search?limit=1', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
})();
if (!upstreamOk) { console.log('★ 上游不可达 —— 依赖实时数据的检查跳过（不是失败）。'); process.exit(0); }

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
/* ★ 下载页默认在「游戏」页签 —— 必须先切到「整合包」，否则一张卡片都不会有
   （第一版漏了这一步，7 条全是假红）。 */
const tabbed = await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
console.log('  切到整合包页签：' + tabbed);
await sleep(1200);

/* 等整合包卡片 */
let cards = 0;
for (let i = 0; i < 40; i += 1) {
  cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
  if (cards > 0) break;
  await sleep(500);
}
console.log('  整合包卡片：' + cards);
check('  有整合包卡片', cards > 0, `${cards} 张`);

await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
await sleep(3500);

const view = await ev(`(() => ({
  '列表卡片数': document.querySelectorAll('.pack-card').length,
  '有信息卡': !!document.querySelector('.res-detail'),
  '标题': document.querySelector('.res-detail-name')?.textContent?.trim() ?? null,
  '版本条数': document.querySelectorAll('.res-version').length,
  '有名称输入': !!document.querySelector('.res-detail-name-field input'),
  '有返回': [...document.querySelectorAll('button')].some((b) => /返回整合包列表/.test(b.textContent || '')),
  '安装按钮数': [...document.querySelectorAll('button')].filter((b) => /安装这个版本|确认并开始安装/.test(b.textContent || '')).length,
}))()`);
console.log('  安装页：' + JSON.stringify(view, null, 1));
check('★ 点卡片后**列表让位**（卡片数为 0）', view?.列表卡片数 === 0, String(view?.列表卡片数));
check('★ 出现整合包**信息卡**', view?.有信息卡 === true, String(view?.标题));
check('★ 有**版本列表**（不是只有最新那个）', (view?.版本条数 ?? 0) > 1, `${view?.版本条数} 条`);
check('  有实例名称输入', view?.有名称输入 === true);
check('  有安装按钮', (view?.安装按钮数 ?? 0) >= 1, String(view?.安装按钮数));
check('★ 有「返回整合包列表」', view?.有返回 === true);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '整合包安装页.png'), Buffer.from(shot.result.data, 'base64'));

/* 返回 */
await ev(`[...document.querySelectorAll('button')].find((b) => /返回整合包列表/.test(b.textContent || ''))?.click()`);
await sleep(1500);
const back = await ev(`(() => ({
  '列表卡片数': document.querySelectorAll('.pack-card').length,
  '有信息卡': !!document.querySelector('.res-detail'),
}))()`);
console.log('  返回后：' + JSON.stringify(back));
check('★ 返回回到列表（卡片回来、信息卡消失）', (back?.列表卡片数 ?? 0) > 0 && back?.有信息卡 === false, JSON.stringify(back));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
