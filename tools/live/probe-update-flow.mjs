/**
 * 真机验证：关于页的更新按钮 + 「有更新」标记 + 更新弹窗
 * ------------------------------------------------------------------
 * 用户报的 bug：「在检查到更新并下载完新版本后，转变安装按钮时，点击依旧是检查更新，
 *   而且还会再给我下一份」；以及要求：「每次进启动器先静默检查，有更新就弹窗，
 *   并在「关于」两字右边写「有更新」，没有就静默」。
 *
 * ## 怎么"可控地"造出一个更新
 * 线上是 rc.3。所以这里跑的是**临时把版本号降到 rc.2 构建出来的那个 debug exe** ——
 * 对它来说 rc.3 就是个真更新（走的是真实的端点、真实的签名校验、真实的下载）。
 * ★ 探针不点「现在重启并更新」除非先**把下好的安装包挪走**（挪走之后 install() 必然失败，
 *   于是既能证明"点击走的是安装路径"，又不会真的把安装程序跑起来）。
 *
 * 判据：
 *   ① 侧栏「关于」右边出现「有更新」
 *   ② 查到就自动弹窗（标题含「发现新版本」）
 *   ③ 下好之后弹窗主按钮可用、文字是「现在重启并更新」
 *   ④ 关于页那个按钮文字是「重启并更新」（不是「检查更新」）
 *   ⑤ 点它 → 走的是**安装**路径（把包挪走后报错，而不是重新下一份）
 * 用法：node tools/live/probe-update-flow.mjs "<低版本 debug exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const PORT = 9976;
const EXE = process.argv[2];
if (!EXE || !existsSync(EXE)) {
  console.error('用法：node tools/live/probe-update-flow.mjs "<低版本 debug exe>"');
  process.exit(2);
}
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-uf-root');
const OWN = path.join(T, 'ieml-uf-own');
const PROFILE = path.join(T, 'ieml-uf-prof');
const FAKE = path.join(T, 'ieml-uf-appdata');
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
for (const d of [ROOT, OWN, PROFILE, FAKE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE, 'IEML'), { recursive: true });

console.log('被测产物：' + EXE);
spawn(EXE, [], {
  env: {
    ...process.env,
    APPDATA: FAKE,
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
if (!page) {
  console.error('连不上 CDP');
  process.exit(2);
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
console.log('界面已就绪，等开机那次静默检查（8 秒后触发）…');

/* ① 等侧栏「关于」右边那个「有更新」 */
let badge = null;
for (let i = 0; i < 90; i += 1) {
  badge = await ev(`(document.querySelector('[data-testid="about-update-badge"]')?.textContent || '').trim()`);
  if (badge) break;
  await sleep(1000);
}
console.log('① 侧栏「关于」右边：' + JSON.stringify(badge));

/* ② 弹窗（查到就该自己弹出来） */
let modalTitle = '';
let modalBody = '';
for (let i = 0; i < 30; i += 1) {
  modalTitle = (await ev(`(document.querySelector('.modal .modal-title, .modal [id^="modal-title"]')?.textContent || '').trim()`)) ?? '';
  modalBody = (await ev(`(document.querySelector('.modal')?.innerText || '').replace(/\\s+/g, ' ').trim()`)) ?? '';
  if (/发现新版本/.test(modalTitle + modalBody)) break;
  await sleep(1000);
}
console.log('② 弹窗标题：' + JSON.stringify(modalTitle));
console.log('   弹窗正文：' + JSON.stringify(modalBody.slice(0, 220)));

/* ③ 等下好（弹窗主按钮变可用） */
let readyText = '';
for (let i = 0; i < 90; i += 1) {
  const st = await ev(`(() => {
    const btns = [...document.querySelectorAll('.modal button')];
    const b = btns.find((x) => /重启并更新|正在下载|正在准备/.test(x.textContent || ''));
    return b ? { text: (b.textContent || '').trim(), disabled: b.disabled } : null;
  })()`);
  if (st) {
    readyText = st.text + (st.disabled ? '（不可点）' : '（可点）');
    if (!st.disabled) break;
  }
  await sleep(1000);
}
console.log('③ 弹窗主按钮：' + JSON.stringify(readyText));

/* ④ 关于页那个按钮 */
await ev(`[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()`);
await sleep(1200);
const about = await ev(`(() => {
  const line = (document.querySelector('.about-line')?.textContent || '').trim();
  const btn = [...document.querySelectorAll('.about-center button')].map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled }));
  return { 状态行: line, 按钮: btn, 标红: !!document.querySelector('.about-line-err') };
})()`);
console.log('④ 关于页：' + JSON.stringify(about));

/* ⑤ 点击走的是不是**安装**路径（默认不点 —— 点了会真的把更新装上） */
/*
 * ★★ 实测（2026-09-24）两件事：
 *   ① Tauri 在下完之后**并不落盘**（包留在内存里），只有点安装那一刻才写到
 *      `%LOCALAPPDATA%\Temp\IEML-<版本>-updater-<随机>\IEML-<版本>-installer.exe` 并运行它。
 *      所以"先把包挪走再点"这条思路不成立 —— 我第一版探针按这个写，结果什么都没挪到，
 *      点击真的把 NSIS 跑起来了（rc.3 被静默装到 `%LOCALAPPDATA%\IEML`）。
 *   ② 那一次也顺带把这条链路**端到端**验掉了：更新包 → 静默安装 → 装好、建快捷方式。
 *      （已装的版本资源 = 0.1.0-rc.3，与发布的一致。）
 *
 * 所以这一步改成**显式开关**：默认不点（探针不该每次都动用户机器）；
 * 设 `IEML_PROBE_ALLOW_INSTALL=1` 才会点，并在点完立刻把安装程序与启动器都收掉。
 */
const allowInstall = process.env.IEML_PROBE_ALLOW_INSTALL === '1';
let afterClick = null;
if (!allowInstall) {
  console.log('⑤ 未验证：默认**不点**「重启并更新」（点了会真的把更新装上）');
  console.log('   要验这一步：IEML_PROBE_ALLOW_INSTALL=1 node tools/live/probe-update-flow.mjs "<低版本 debug exe>"');
} else {
  await ev(`(() => {
    const b = [...document.querySelectorAll('.about-center button')].find((x) => /重启并更新/.test(x.textContent || ''));
    b?.click();
    return !!b;
  })()`);
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    afterClick = await ev(`(() => {
      const line = (document.querySelector('.about-line')?.textContent || '').trim();
      const btns = [...document.querySelectorAll('.about-center button')].map((b) => (b.textContent || '').trim());
      return { 状态行: line, 按钮: btns };
    })()`);
    if (afterClick && /正在交给安装程序/.test(afterClick.状态行)) break;
  }
  console.log('   点击之后（不到 1 秒就读）：' + JSON.stringify(afterClick));
  /* 立刻收掉安装程序与启动器 —— 别真装（已经装过的同版本除外） */
  await ps(`Get-CimInstance Win32_Process -Filter "Name='IEML-0.1.0-rc.3-installer.exe' OR Name LIKE '%installer%'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '*updater*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
}
const stillAlive = (await ev(`1 + 1`)) === 2;

console.log('\n===== 判据 =====');
console.log(`${badge === '有更新' ? '✓' : '✗'} ① 侧栏「关于」右边写着「有更新」：${JSON.stringify(badge)}`);
console.log(`${/发现新版本/.test(modalTitle + modalBody) ? '✓' : '✗'} ② 查到就自动弹窗：${JSON.stringify(modalTitle)}`);
console.log(`${/重启并更新/.test(readyText) && /可点/.test(readyText) ? '✓' : '✗'} ③ 下好后弹窗主按钮可点且写着「重启并更新」：${JSON.stringify(readyText)}`);
const aboutBtn = (about?.按钮 ?? []).map((b) => b.text).join('|');
console.log(`${/重启并更新/.test(aboutBtn) ? '✓' : '✗'} ④ 关于页按钮是「重启并更新」（不是「检查更新」）：${JSON.stringify(about?.按钮)}`);
if (allowInstall) {
  const line = afterClick?.状态行 ?? '';
  /*
   * ★ 判据：点击后那一行必须变成「正在交给安装程序…」。
   *   坏行为（点击又去检查）会是「正在检查…」→ 然后重新下一份。
   */
  console.log(
    `${/正在交给安装程序/.test(line) ? '✓' : '✗'} ⑤ 点击走的是**安装**路径（不是再检查一次）：${JSON.stringify(line)}`,
  );
} else {
  console.log('— ⑤ 未验证（默认不点；用 IEML_PROBE_ALLOW_INSTALL=1 才验这一步）');
}

/* 收尾：清沙盒（WebView 的 profile 目录刚被杀掉时可能还锁着 —— 重试几次） */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);
/* ★ WebView 的 profile 目录刚被杀掉时可能还锁着（EBUSY）—— 重试几次，别让探针在这里崩 */
const clean = (d) => {
  for (let i = 0; i < 8; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      return;
    } catch {
      /* 等一会儿再试 */
    }
  }
  console.warn('清理失败（不影响结论）：' + d);
};
for (const d of [ROOT, OWN, PROFILE, FAKE]) clean(d);
console.log('沙盒已清理');
process.exit(0);
