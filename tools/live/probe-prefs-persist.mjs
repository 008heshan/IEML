/**
 * 探针：**设置到底存没存住**（ADR-046 那条"偏好会持久化从没被验证过"）
 * ------------------------------------------------------------------
 * 做法（两趟）：
 *   ① 记下当前 prefs.json 的关键字段 → 在界面上改一个**安全**的设置
 *      （主题，或"降低动画效果"这类纯观感开关）→ 再读 prefs.json 看有没有落盘；
 *   ② 重启应用 → 读界面上的实际状态，看它是不是还是刚才设的那个值。
 *
 * ★ 只碰**纯观感/纯偏好**项：不动数据目录、不动任何会删东西的开关。
 * 用法：node tools/live/probe-prefs-persist.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9945;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-prefs-prof');
const PREFS = path.join(process.env.APPDATA ?? '.', 'IEML', 'prefs.json');
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
const readPrefs = () => {
  try {
    return JSON.parse(readFileSync(PREFS, 'utf8'));
  } catch (e) {
    return { __err: String(e) };
  }
};

async function connect() {
  let page = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(500);
  }
  if (!page) return null;
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
  await sleep(2500);
  return { ev, close: () => ws.close() };
}

/* ---------- 第一趟：改一个设置，看落盘 ---------- */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const before = readPrefs();
console.log('改之前 prefs：' + JSON.stringify({ theme: before.theme, reducedMotion: before.reducedMotion, particleEffects: before.particleEffects, windowWidth: before.windowWidth }));

spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});
const a = await connect();
if (!a) {
  console.error('连不上 CDP');
  process.exit(2);
}
await a.ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()`);
await sleep(2000);

/* 找到"降低动画效果"或"主题"这类开关，记下它的当前状态 */
const probe = await a.ev(`(() => {
  const rows = [...document.querySelectorAll('.field-row, .field, .switch-row')];
  const pick = (re) => rows.find((r) => re.test(r.textContent || ''));
  const rm = pick(/降低动画|动画效果|动效/);
  const pe = pick(/粒子|特效/);
  const sw = (row) => row?.querySelector('.switch');
  return {
    'hasReducedMotion': !!rm,
    'rmOn': sw(rm)?.classList.contains('on') ?? null,
    'rmText': (rm?.textContent || '').replace(/\\s+/g, ' ').slice(0, 40),
    'hasParticle': !!pe,
    'peOn': sw(pe)?.classList.contains('on') ?? null,
    'themeBtns': [...document.querySelectorAll('[data-theme], .theme-card, .theme-item')].length,
  };
})()`);
console.log('设置页探测：' + JSON.stringify(probe));

/* 切一个纯观感开关（降低动画效果 / 粒子特效），再读 prefs.json */
const toggled = await a.ev(`(() => {
  const rows = [...document.querySelectorAll('.field-row, .field, .switch-row')];
  const row = rows.find((r) => /降低动画|动画效果|动效/.test(r.textContent || ''))
           ?? rows.find((r) => /粒子|特效/.test(r.textContent || ''));
  const label = (row?.textContent || '').replace(/\\s+/g, ' ').slice(0, 30);
  row?.querySelector('.switch')?.click();
  return label;
})()`);
await sleep(1500);
const after = readPrefs();
console.log(`点了「${toggled}」之后的 prefs：` + JSON.stringify({ theme: after.theme, reducedMotion: after.reducedMotion, particleEffects: after.particleEffects }));
const changedKeys = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
console.log('落盘发生变化的键：' + JSON.stringify(changedKeys));
a.close();

/* ---------- 第二趟：重启，看界面上的状态是不是还保持 ---------- */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);
spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});
const b = await connect();
if (!b) {
  console.error('重启后连不上 CDP');
  process.exit(2);
}
await b.ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()`);
await sleep(2000);
const after2 = await b.ev(`(() => {
  const rows = [...document.querySelectorAll('.field-row, .field, .switch-row')];
  const pick = (re) => rows.find((r) => re.test(r.textContent || ''));
  const sw = (row) => row?.querySelector('.switch');
  const rm = pick(/降低动画|动画效果|动效/);
  const pe = pick(/粒子|特效/);
  return {
    'rmOn': sw(rm)?.classList.contains('on') ?? null,
    'peOn': sw(pe)?.classList.contains('on') ?? null,
    'theme': document.documentElement.getAttribute('data-theme'),
  };
})()`);
console.log('重启后界面状态：' + JSON.stringify(after2));
console.log('重启后 prefs：' + JSON.stringify(pickPrefs()));
function pickPrefs() {
  const p = readPrefs();
  return { theme: p.theme, reducedMotion: p.reducedMotion, particleEffects: p.particleEffects };
}
b.close();
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
