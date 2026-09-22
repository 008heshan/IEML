/**
 * 真机验证：A/B/N 三个新页面与改动
 *   A 侧栏「更新日志」→ 是页面，内容说人话
 *   B 侧栏「关于」→ 独立页面，有声明与法律信息
 *   N 关于页没有附属描述、主文字居中
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9821;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b3');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b3-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
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
const shoot = async (tag) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

const sidebar = await ev(`[...document.querySelectorAll('.side-link')].map((b) => (b.textContent || '').trim())`);
console.log('侧栏底部两项：' + JSON.stringify(sidebar));
check('★ 侧栏有「更新日志」', Array.isArray(sidebar) && sidebar.some((x) => x.includes('更新日志')), JSON.stringify(sidebar));
check('★ 侧栏有「关于」（不再是"关于与设置"）', Array.isArray(sidebar) && sidebar.some((x) => x.trim() === '关于'), JSON.stringify(sidebar));

/* ---------- A 更新日志页 ---------- */
await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').includes('更新日志'))?.click()`);
await sleep(1600);
const cl = await ev(`(() => {
  const t = document.querySelector('.page-title');
  const text = document.body.innerText || '';
  const groups = [...document.querySelectorAll('.rel-group-t')].map((x) => x.textContent.trim());
  const items = [...document.querySelectorAll('.rel-list li')].map((x) => x.textContent.trim());
  return {
    标题: t ? t.textContent : null,
    条目数: items.length,
    分组: [...new Set(groups)].slice(0, 5),
    头三条: items.slice(0, 3),
    有工程黑话: /真机断言|ADR-\\d|★★|视口|根因|回归判据/.test(text),
  };
})()`);
console.log('  ' + JSON.stringify(cl, null, 1));
check('★ 点「更新日志」进的是独立页面', cl.标题 === '更新日志', String(cl.标题));
check('  页面有条目', cl.条目数 >= 8, `${cl.条目数} 条`);
check('★ 说人话：没有工程黑话（真机断言/ADR/★★/视口/根因）', cl.有工程黑话 === false, String(cl.有工程黑话));
await shoot('更新日志页');

/* ---------- B/N 关于页 ---------- */
await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').trim() === '关于')?.click()`);
await sleep(1600);
const ab = await ev(`(() => {
  const t = document.querySelector('.page-title');
  const text = document.body.innerText || '';
  const hero = document.querySelector('.about-hero');
  const heroCs = hero ? getComputedStyle(hero) : null;
  const sections = [...document.querySelectorAll('.card .card-title')].map((x) => x.textContent.trim());
  const hints = document.querySelectorAll('.about-list .field-hint, .about-hero .field-hint').length;
  return {
    标题: t ? t.textContent : null,
    分节: sections,
    有声明关键词: /无(任何)?(关联|关系)|商标|GPL-3\\.0|著作权|不含|没有埋点|隐私/.test(text),
    有工程黑话: /真机断言|ADR-\\d|★★|视口|根因/.test(text),
    hero居中: heroCs ? heroCs.alignItems === 'center' && heroCs.textAlign === 'center' : null,
    附属描述数: hints,
  };
})()`);
console.log('  ' + JSON.stringify(ab, null, 1));
check('★ 点「关于」进的是独立页面', ab.标题 === '关于', String(ab.标题));
check('★ 有声明与法律信息（关联/商标/GPL/著作权/隐私）', ab.有声明关键词 === true);
check('★ 主文字居中', ab.hero居中 === true, String(ab.hero居中));
check('★ 没有附属描述（N 那条）', ab.附属描述数 === 0, `${ab.附属描述数} 处`);
check('  关于页也没有工程黑话', ab.有工程黑话 === false, String(ab.有工程黑话));
await shoot('关于页');

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
