/**
 * 真机验证：C（侧栏最底部账号按钮 + 向上展开菜单）
 *   · 按钮在侧栏最底部、菜单**向上展开**（几何：菜单底边在按钮上方）
 *   · 图二那六项都在
 *   · 切换账号 / 离线模式 可来回（离线 → 切回正版）
 *   · 顶栏那个账号胶囊**已经撤掉**（账号入口只有一处）
 *   · 附属文字少：菜单里没有解释性小字（只有名字 + 短状态）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9831;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b4');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b4-prof');
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
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

/* ---------- ① 位置与方向 ---------- */
const before = await ev(`(() => {
  const b = document.querySelector('.acct-btn');
  const side = document.querySelector('.sidebar');
  if (!b || !side) return null;
  const br = b.getBoundingClientRect();
  const sr = side.getBoundingClientRect();
  return {
    按钮底边距侧栏底: Math.round(sr.bottom - br.bottom),
    顶栏还有账号胶囊: !!document.querySelector('.acct-chip'),
    菜单已开: !!document.querySelector('.acct-menu'),
  };
})()`);
console.log('按钮几何：' + JSON.stringify(before));
check('★ 账号按钮在侧栏底部（距底 < 120px）', before && before.按钮底边距侧栏底 < 120, String(before?.按钮底边距侧栏底));
check('★ 顶栏那个账号胶囊已撤掉（入口只有一处）', before && before.顶栏还有账号胶囊 === false);

/* ---------- ② 向上展开 ---------- */
await ev(`document.querySelector('.acct-btn')?.click()`);
await sleep(500);
const geo = await ev(`(() => {
  const m = document.querySelector('.acct-menu');
  const b = document.querySelector('.acct-btn');
  if (!m || !b) return null;
  const mr = m.getBoundingClientRect();
  const br = b.getBoundingClientRect();
  const items = [...m.querySelectorAll(':scope > button')].map((x) => (x.textContent || '').trim());
  return {
    菜单: [Math.round(mr.top), Math.round(mr.bottom)],
    按钮: [Math.round(br.top), Math.round(br.bottom)],
    在按钮上方: mr.bottom <= br.top + 2,
    视口高: window.innerHeight,
    在视口内: mr.top >= 0 && mr.bottom <= window.innerHeight,
    项: items,
  };
})()`);
console.log('菜单几何：' + JSON.stringify(geo, null, 1));
check('★ 菜单**向上展开**（底边在按钮上沿之上）', geo && geo.在按钮上方 === true, JSON.stringify(geo?.菜单) + ' vs ' + JSON.stringify(geo?.按钮));
check('  菜单完整落在视口内（不会顶出屏幕）', geo && geo.在视口内 === true);

/* ★ 2026-09-23 用户把这排里的一项删了（"这个不要"）—— 判据跟着反向 */
const want = ['修改皮肤', '刷新皮肤', '保存皮肤文件', '修改披风', '刷新披风列表'];
for (const w of want) {
  check(`  图二那项在：${w}`, Array.isArray(geo?.项) && geo.项.some((x) => x.includes(w)), JSON.stringify(geo?.项));
}
check(
  '  有「切换账号」',
  Array.isArray(geo?.项) && geo.项.some((x) => /切换账号|登录正版账号/.test(x)),
  JSON.stringify(geo?.项),
);
check('  有离线/正版切换', Array.isArray(geo?.项) && geo.项.some((x) => /离线模式|切回正版/.test(x)));
/* ★★ 用户（截图）：「使用 CDKEY 兑换奖励 —— 这个不要」→ 断言它**不在** */
check(
  '★ 「使用 CDKEY 兑换奖励」已删除（用户要求）',
  Array.isArray(geo?.项) && !geo.项.some((x) => /CDKEY/i.test(x)),
  JSON.stringify(geo?.项),
);

/* ---------- ③ 附属文字要少 ---------- */
const texty = await ev(`(() => {
  const m = document.querySelector('.acct-menu');
  if (!m) return null;
  const rows = [...m.querySelectorAll(':scope > button')];
  /* 每行只该有：图标 + 名字（+ 少数短状态）。判据：文字长度都很短 */
  const lens = rows.map((r) => (r.textContent || '').trim().length);
  return { 行数: rows.length, 最长行字数: Math.max(...lens), 行字数: lens };
})()`);
console.log('  菜单文字量：' + JSON.stringify(texty));
check('★ 每行都是短标签（最长 < 16 字，没有解释性小字）', texty && texty.最长行字数 < 16, String(texty?.最长行字数));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '账号菜单.png'), Buffer.from(shot.result.data, 'base64'));

/* ---------- ④ 切到离线再切回来 ---------- */
const mode = async () => ev(`(() => {
  const b = document.querySelector('.acct-btn');
  return b ? (b.textContent || '').replace(/\\s+/g, ' ').trim() : null;
})()`);
console.log('切换前按钮文字：' + JSON.stringify(await mode()));
const offClicked = await ev(`(() => {
  const b = [...document.querySelectorAll('.acct-menu > button')].find((x) => /切到离线模式/.test(x.textContent || ''));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
await sleep(1500);
const afterOff = await mode();
console.log('切到离线后：' + JSON.stringify(afterOff) + '（点了=' + offClicked + '）');
if (offClicked) {
  check('★ 能切到离线模式', /离线/.test(String(afterOff)), String(afterOff));
  /*
   * ★ 再打开菜单前先看它是不是**已经开着** —— 第一版无条件点一下，
   *   结果把还开着的菜单**关掉**了，于是"切回正版"那条永远找不到按钮（假红）。
   */
  await ev(`(() => {
    if (!document.querySelector('.acct-menu')) document.querySelector('.acct-btn')?.click();
    return !!document.querySelector('.acct-menu');
  })()`);
  await sleep(400);
  const backClicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.acct-menu > button')].find((x) => /切回正版/.test(x.textContent || ''));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  await sleep(1500);
  const afterBack = await mode();
  console.log('切回正版后：' + JSON.stringify(afterBack) + '（点了=' + backClicked + '）');
  check('★ 还能**直接切回**（不用重新登录）', /正版/.test(String(afterBack)), String(afterBack));
} else {
  console.log('  （这台机器没有正版账号可切，跳过"切到离线"这一步）');
}

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
