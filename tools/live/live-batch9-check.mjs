/**
 * 真机验证：这一轮的小改动（A1 / B1 / B2 / C1 / C2 / D1 / E1 / F1-F3）
 *
 *   A1 账号菜单里**没有** CDKEY 兑换
 *   B1 设置页里**没有**「关于」卡片
 *   B2 设置页「下载源」是**选择器**、且**有「自动」项**
 *   C1 下载页**没有**源选择器
 *   C2 下载页**没有**推荐版本 chips
 *   D1 侧栏「更新日志 / 关于」有选中提示（aria-current=page + .on）
 *   E1 版本名**不带**「：原版 / ：模组加载器」，且**命名统一**（都从 Minecraft 开头）
 *   F2 loading 时**只剩转圈**，图标被藏掉
 *   F1/F3 启动按钮有发光、且颜色随主题变（量两套主题下的实际色值）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9901;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b9');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b9-prof');
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

/* ---------- A1：CDKEY ---------- */
await ev(`document.querySelector('.acct-btn')?.click()`);
await sleep(500);
const menu = await ev(`[...document.querySelectorAll('.acct-menu > button')].map((x) => (x.textContent || '').trim())`);
check('★ A1 账号菜单里没有 CDKEY 兑换', !(menu ?? []).some((x) => /CDKEY/i.test(x)), JSON.stringify(menu));
check('  菜单里仍有切换账号/离线', (menu ?? []).some((x) => /切换账号|登录正版/.test(x)) && (menu ?? []).some((x) => /离线|切回正版/.test(x)));
await ev(`document.querySelector('.acct-btn')?.click()`);
await sleep(300);

/* ---------- E1：版本命名 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('版本列表'))?.click()`);
await sleep(1700);
const ver = await ev(`(() => {
  const names = [...document.querySelectorAll('.ver-title-name, .ver-name, .ver-item .truncate')].map((x) => (x.textContent || '').trim()).filter(Boolean);
  const all = document.body.innerText || '';
  return {
    'names': names.slice(0, 6),
    'hasSuffix': /：原版|：模组加载器/.test(all),
  };
})()`);
console.log('  版本名：' + JSON.stringify(ver));
check('★ E1 版本名不再带「：原版 / ：模组加载器」', ver?.hasSuffix === false, String(ver?.hasSuffix));
check('★ 命名统一（都以 Minecraft 开头）', (ver?.names ?? []).every((n) => n.startsWith('Minecraft')), JSON.stringify(ver?.names));

/* ---------- D1：侧栏选中提示 ---------- */
for (const [label, pageId] of [['更新日志', 'changelog'], ['关于', 'about']]) {
  await ev(`[...document.querySelectorAll('.side-link')].find((b) => (b.textContent || '').includes('${label}'))?.click()`);
  await sleep(900);
  const st = await ev(`(() => {
    const b = [...document.querySelectorAll('.side-link')].find((x) => (x.textContent || '').includes('${label}'));
    if (!b) return null;
    return { 'on': b.classList.contains('on'), 'current': b.getAttribute('aria-current') };
  })()`);
  check(`★ D1 「${label}」有选中提示`, st?.on === true && st?.current === 'page', JSON.stringify(st));
}

/* ---------- B1/B2：设置页 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1600);
const set = await ev(`(() => {
  const text = document.body.innerText || '';
  const rows = [...document.querySelectorAll('.field-row, .field')];
  const srcRow = rows.find((r) => /下载源/.test(r.textContent || ''));
  const controls = srcRow ? srcRow.querySelectorAll('button, select, [role="combobox"], .cs-btn').length : 0;
  const hasAuto = srcRow ? /自动/.test(srcRow.textContent || '') : false;
  return {
    'hasAboutCard': /IEML 启动器\\s*极简 Minecraft 启动器/.test(text) || /第三方组件/.test(text),
    'sourceControls': controls,
    'sourceHasAuto': hasAuto,
  };
})()`);
console.log('  设置页：' + JSON.stringify(set));
check('★ B1 设置页没有「关于」卡片', set?.hasAboutCard === false, String(set?.hasAboutCard));
check('★ B2 下载源是选择器（有控件）', (set?.sourceControls ?? 0) >= 1, String(set?.sourceControls));
if (set?.sourceControls >= 1) {
  // 打开下拉，看有没有「自动」项
  await ev(`(() => { const r = [...document.querySelectorAll('.field-row, .field')].find((x) => /下载源/.test(x.textContent || '')); r?.querySelector('.cs-btn, button')?.click(); return true; })()`);
  await sleep(500);
  const opts = await ev(`[...document.querySelectorAll('.cs-menu button, .cs-opt, [role="option"]')].map((x) => (x.textContent || '').trim())`);
  check('★ B2 下拉里有「自动」项', (opts ?? []).some((x) => /自动/.test(x)), JSON.stringify(opts));
  await ev(`document.body.click()`);
  await sleep(300);
}

/* ---------- F2：loading 时只剩转圈 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('启动'))?.click()`);
await sleep(1600);
const btn = await ev(`(() => {
  const b = document.querySelector('#ieml-launch-btn') || document.querySelector('.launch-btn');
  if (!b) return null;
  const cs = getComputedStyle(b);
  return {
    'hasGlow': cs.boxShadow !== 'none' && cs.boxShadow.length > 8,
    'bg': cs.backgroundImage.slice(0, 60),
    'color': cs.color,
    'hasIcon': !!b.querySelector('svg'),
  };
})()`);
console.log('  启动按钮：' + JSON.stringify(btn));
check('★ F1 启动按钮有发光（box-shadow）', btn?.hasGlow === true, btn?.boxShadow);
check('  F3 背景走渐变（或兜底纯色）', typeof btn?.bg === 'string' && btn.bg !== 'none', String(btn?.bg));

/* 量两套主题下的按钮底色，验证"随主题变" */
const themeColor = async (theme) => {
  await ev(`document.documentElement.setAttribute('data-theme', '${theme}')`);
  await sleep(400);
  /*
   * ★ 量的是 backgroundImage 而不是 backgroundColor：
   *   按钮用的是 `linear-gradient(...)`（背景图），
   *   `backgroundColor` 本来就是 rgba(0,0,0,0) —— 第一版量错属性，报了个假红。
   */
  return ev(`(() => {
    const b = document.querySelector('.launch-btn');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { img: cs.backgroundImage, shadow: cs.boxShadow.slice(0, 80), accent: cs.getPropertyValue('--accent').trim() };
  })()`);
};
const c1 = await themeColor('dark');
const c2 = await themeColor('jiuhong');
console.log(`  玄夜 ${JSON.stringify(c1)}\n  酒红 ${JSON.stringify(c2)}`);
check(
  '★ F3 换主题按钮底色/发光跟着变',
  c1 && c2 && c1.img !== c2.img && c1.shadow !== c2.shadow,
  `${c1?.accent} vs ${c2?.accent}`,
);

/* ---------- C1/C2：下载页 ---------- */
await ev(`document.documentElement.removeAttribute('data-theme')`);
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(3000);
const dl = await ev(`(() => {
  const text = document.body.innerText || '';
  const segs = [...document.querySelectorAll('.seg, [role="tablist"]')].map((x) => (x.textContent || '').trim());
  const quick = document.querySelectorAll('.cw-quick').length;
  return {
    'segments': segs,
    'hasSourceSeg': segs.some((x) => /BMCLAPI/.test(x) && /Mojang/.test(x)),
    'quickChips': quick,
  };
})()`);
console.log('  下载页：' + JSON.stringify(dl));
check('★ C1 下载页没有源选择器', dl?.hasSourceSeg === false, JSON.stringify(dl?.segments));
check('★ C2 下载页没有推荐版本 chips', dl?.quickChips === 0, String(dl?.quickChips));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '这一轮.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
