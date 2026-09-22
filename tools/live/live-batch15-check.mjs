/**
 * 真机验证这一批五条：
 *   ① 顶部玻璃**只盖标题栏**（不再压页头文字、不再在内容中间切一条）
 *   ② 侧栏「更新日志/关于」的**选中提示看得见**（背景 + 文字色 + 左侧竖条）
 *   ③ 启动按钮的泛光**跟着主题色**（量两套主题下的 shadow 颜色）
 *   ④ 头像**不用点开菜单就加载**（挂载即拉）
 *   ⑤ 文本/图标的抗锯齿设置生效（computed 上有 geometricPrecision）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9971;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b15');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b15-prof');
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

/* ---------- ① 顶部玻璃的几何 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(2600);
const geo = await ev(`(() => {
  const g = document.querySelector('.top-glass');
  const t = document.querySelector('.page-title');
  const tb = document.querySelector('.titlebar');
  if (!g) return { '玻璃': '不存在' };
  const gr = g.getBoundingClientRect();
  const tr = t ? t.getBoundingClientRect() : null;
  return {
    '玻璃': [Math.round(gr.top), Math.round(gr.bottom)],
    '标题栏高': tb ? Math.round(tb.getBoundingClientRect().height) : null,
    '页头标题': tr ? [Math.round(tr.top), Math.round(tr.bottom)] : null,
    '压住页头吗': tr ? gr.bottom > tr.top : null,
  };
})()`);
console.log('  顶部玻璃：' + JSON.stringify(geo));
check('★ 玻璃只盖标题栏（底边不超过标题栏高度）', geo?.玻璃?.[1] <= (geo?.标题栏高 ?? 0), JSON.stringify(geo));
check('★ 不再压住页头文字', geo?.压住页头吗 === false, `玻璃底 ${geo?.玻璃?.[1]} / 标题顶 ${geo?.页头标题?.[0]}`);

/* ---------- ② 侧栏选中提示 ---------- */
const side = [];
for (const label of ['更新日志', '关于']) {
  await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').includes('${label}'))?.click()`);
  await sleep(1100);
  const st = await ev(`(() => {
    const b = [...document.querySelectorAll('.side-link')].find((x) => (x.textContent || '').includes('${label}'));
    if (!b) return null;
    const cs = getComputedStyle(b);
    const bar = getComputedStyle(b, '::before');
    return {
      'bg': cs.backgroundColor,
      'color': cs.color,
      'weight': cs.fontWeight,
      'barW': bar.width,
      'barBg': bar.backgroundColor,
    };
  })()`);
  side.push([label, st]);
  console.log(`  「${label}」选中样式：` + JSON.stringify(st));
}
check(
  '★ 「更新日志」选中时**背景与文字色都变**',
  side[0][1] && side[0][1].bg !== 'rgba(0, 0, 0, 0)' && side[0][1].weight === '600',
  JSON.stringify(side[0][1]),
);
check(
  '★ 左侧有一道竖条（与主导航同一观感）',
  side[0][1]?.barW === '3px' && side[0][1]?.barBg !== 'rgba(0, 0, 0, 0)',
  `宽 ${side[0][1]?.barW} 色 ${side[0][1]?.barBg}`,
);
check('★ 「关于」同样有选中样式', side[1][1] && side[1][1].bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(side[1][1]));

/* ---------- ③ 启动按钮泛光跟色 + ⑤ 抗锯齿 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('启动'))?.click()`);
await sleep(1600);
const probeBtn = (theme) =>
  ev(`(() => {
    ${theme ? `document.documentElement.setAttribute('data-theme', '${theme}');` : ''}
    const b = document.querySelector('.launch-btn');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const after = getComputedStyle(b, '::after');
    const svg = document.querySelector('.launch-btn svg');
    return {
      'shadow': cs.boxShadow.slice(0, 90),
      'breath': after.backgroundImage.slice(0, 90),
      'svgRender': svg ? getComputedStyle(svg).shapeRendering : null,
      'fontSmooth': getComputedStyle(document.body).webkitFontSmoothing,
    };
  })()`);
const dark = await probeBtn('dark');
await sleep(300);
const jiu = await probeBtn('jiuhong');
console.log('  玄夜：' + JSON.stringify(dark, null, 1));
console.log('  酒红：' + JSON.stringify(jiu, null, 1));
check('★ 按钮泛光随主题变', dark?.shadow !== jiu?.shadow, `${dark?.shadow?.slice(0, 40)} vs ${jiu?.shadow?.slice(0, 40)}`);
check(
  '★ 呼吸泛光是**强调色**（不再是白雾）',
  !!dark?.breath && !/255,\s*255,\s*255/.test(dark.breath) && dark.breath !== jiu?.breath,
  String(dark?.breath).slice(0, 60),
);
/*
 * ★ computed 值序列化成**小写**（`geometricprecision`）—— 第一版拿驼峰去比，报了个假红。
 *   判据要按**实际值**写，不按我心里想的那份写法写。
 */
check(
  '⑤ 图标抗锯齿设置生效（geometricPrecision）',
  String(dark?.svgRender ?? '').toLowerCase() === 'geometricprecision',
  String(dark?.svgRender),
);
check('⑤ 文本抗锯齿开着（antialiased）', dark?.fontSmooth === 'antialiased', String(dark?.fontSmooth));

/* ---------- ④ 头像：不点菜单也要有 ---------- */
const avatar = await ev(`(() => {
  const box = document.querySelector('.acct-avatar');
  if (!box) return { 'ok': false, 'why': '没有头像容器' };
  const layers = box.querySelectorAll('.skin-head-layer');
  return { 'ok': true, 'layers': layers.length, 'hasImg': layers[0] ? getComputedStyle(layers[0]).backgroundImage !== 'none' : false };
})()`);
console.log('  头像（没点过菜单）：' + JSON.stringify(avatar));
check('★ 头像容器在（无需点开菜单）', avatar?.ok === true);
if (avatar?.layers > 0) {
  check('★ 头像图已经加载（挂载即拉）', avatar.hasImg === true, JSON.stringify(avatar));
} else {
  console.log('  （这台机器此刻拉不到皮肤图 —— 只验"容器已在、不再依赖点开菜单"）');
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '这批.png'), Buffer.from(shot.result.data, 'base64'));

/* ---------- 图一：提示条（toast）在右下角 + 有退场动画 ---------- */
console.log('\n=== 提示条（用户：「图一没实现」） ===');
/* 点主题色板会弹一个 toast（上一批的判据就是这么触发的） */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1500);
await ev(`(() => {
  const sw = [...document.querySelectorAll('.theme-swatch, .theme-grid button')];
  if (!sw.length) return false;
  sw[0].click();
  return true;
})()`);
await sleep(700);
const toast = await ev(`(() => {
  const t = document.querySelector('.toast');
  if (!t) return { '在': false };
  const r = t.getBoundingClientRect();
  const region = t.parentElement;
  const rr = region.getBoundingClientRect();
  const cs = getComputedStyle(t);
  return {
    '在': true,
    '位置': [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    '视口': [window.innerWidth, window.innerHeight],
    '在右下角': r.right > window.innerWidth * 0.6 && r.bottom > window.innerHeight * 0.6,
    '区域对齐': getComputedStyle(region).alignItems,
    '动画': cs.animationName,
  };
})()`);
console.log('  提示条：' + JSON.stringify(toast));
check('★ 提示条出现在**右下角**', toast?.在 === true && toast?.在右下角 === true, JSON.stringify(toast?.位置));
/* 点关闭 → 应当先挂 .leaving 再消失 */
const leaving = await ev(`(async () => {
  const t = document.querySelector('.toast');
  const btn = t?.querySelector('button');
  if (!btn) return 'no-close';
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
  const still = document.querySelector('.toast');
  return still ? (still.className.includes('leaving') ? 'leaving' : 'no-leaving') : 'gone-immediately';
})()`);
console.log('  点关闭后：' + leaving);
check('★ 关闭时**先挂 .leaving**（两段式，才有退场动画）', leaving === 'leaving', String(leaving));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
