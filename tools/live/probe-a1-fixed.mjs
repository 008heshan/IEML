/**
 * 真机验证 A-1 的修复：三处「启动」按钮**真的接上了**
 * ------------------------------------------------------------------
 * 判据（四条）：
 *   ① 版本列表页上 `ieml:launch-request` 的监听器 **≥ 1**（修之前是 0）
 *   ② 点行菜单里的「启动」→ 应用**切到启动页**、而且选中的就是那一行
 *   ③ 启动流程真的跑起来了 —— 三类证据任一即可：
 *      沙盒启动日志（OWN/logs/probe-a1-*.log 出现）、提示条、本沙盒 java 进程
 *      （★ 实测：沙盒里没有游戏文件时，启动流程会先下载再真的把游戏跑起来，
 *        所以这里不能拿"必然失败提示"当判据）
 *   ④ 安全：没有任何 java 指向**真实游戏根** D:\IEML（点这个按钮不该漏到真机上）
 * 用法：node tools/live/probe-a1-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9987;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a1f-root');
const OWN = path.join(T, 'ieml-a1f-own');
const PROFILE = path.join(T, 'ieml-a1f-prof');
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
/* ★ 先杀掉上一轮可能还活着的实例：它会占着沙盒里的文件，清理就会 EBUSY
   （之前就是在这里栽的：先删沙盒、后杀进程） */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
/* 上一轮万一真的把游戏拉起来了（java 会锁住 natives/*.dll 与版本 jar），一并收掉；
   只收命令行里带本沙盒路径的，绝不动别人自己的游戏进程 */
const killSandboxJava = () =>
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ieml-a1f*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
await killSandboxJava();
await sleep(700);
/* 安全网：沙盒里万一下次被建成联接（junction），先拆联接本身，绝不让删除穿过它 */
const dropLinks = async (root) => {
  const out = await ps(
    `Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | ForEach-Object { cmd /c rmdir "$($_.FullName)" }`,
  );
  if (out) console.log('拆掉联接：' + out);
};
/* 清理可能被句柄/杀软扫描挡住，重试几次；仍然失败就明说，不装作清干净了 */
const clean = async (d) => {
  for (let i = 0; i < 6; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (i === 5) {
        console.error('清理失败（继续跑，但沙盒可能不干净）：' + d + ' → ' + e.message);
        return false;
      }
      console.log('清理重试 ' + (i + 1) + '：' + e.code);
      await sleep(800);
    }
  }
};
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
/* ★ 故意**不**放游戏文件：让启动必然失败，于是"失败提示"就是流程跑通的证据 */
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-a1',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: { name: '探针·启动按钮', slug: 'probe-a1', isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3500);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);

/* ① 监听器在不在 */
const listeners = await ev(`(() => {
  try { const l = getEventListeners(window)['ieml:launch-request']; return l ? l.length : 0; } catch (e) { return 'ERR:' + e.message; }
})()`);
console.log('① 版本列表页上 ieml:launch-request 监听器 = ' + JSON.stringify(listeners));

/* ② 点行菜单里的「启动」 */
await ev(`document.querySelector('.ver-item .ver-actions button')?.click()`);
await sleep(500);
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('.menu button, [role="menu"] button')].find((x) => (x.textContent || '').trim() === '启动');
  b?.click();
  return !!b;
})()`);
console.log('② 点了行菜单的「启动」=' + JSON.stringify(clicked));
await sleep(7000);
const after = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return {
    '当前页': (document.querySelector('.page-title')?.textContent || '').trim(),
    '选中的版本': (document.querySelector('.launch-inst-name, .side-inst-name')?.textContent || '').trim(),
    '提示条': [...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90)),
    '文本头': text.slice(0, 160),
  };
})()`);
console.log('   之后：' + JSON.stringify(after, null, 2));
/* ③ 启动流程真的动起来了没有 —— 看三类证据。
   ★ 不能假设"沙盒里没游戏文件 ⇒ 必然失败"：上一轮的残留证明，
     缺文件时启动流程会**下载并真的把游戏跑起来**（沙盒里留下了 208 MB 资源和 java 进程）。 */
const logDir = path.join(OWN, 'logs');
const logFiles = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith('probe-a1')) : [];
console.log('③ 沙盒启动日志：' + JSON.stringify(logFiles));
/* ④ 只看**本沙盒**拉起来的 java：别人自己的游戏进程不该算进来 */
const javaCount = await ps(
  `(Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ieml-a1f*' } | Measure-Object).Count`,
);
const javaAll = await ps(`(Get-Process java,javaw -ErrorAction SilentlyContinue | Measure-Object).Count`);
/* ④b 安全判据：绝不能有 java 指向**真实游戏根** D:\IEML（点了按钮不该漏到真机上） */
const javaReal = await ps(
  `(Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*D:\\IEML*' } | Measure-Object).Count`,
);
console.log('④ 本沙盒 java 进程数 = ' + JSON.stringify(javaCount) + '（全机 java 共 ' + javaAll + ' 个；指向真实根的 ' + javaReal + ' 个）');

console.log('\n===== 判据 =====');
console.log(`${typeof listeners === 'number' && listeners >= 1 ? '✓' : '✗'} ① 监听器 ≥ 1（修之前是 0）：${JSON.stringify(listeners)}`);
/* ② 两件事都要成立：切到启动页 **且** 选中的就是那一行（用页面文本里出现实例名来判） */
const selectedOk = after?.当前页 === '启动' && (after?.文本头 || '').includes('探针·启动按钮');
console.log(`${selectedOk ? '✓' : '✗'} ② 切到启动页、选中的就是那一行：页=${JSON.stringify(after?.当前页)} 文本里含实例名=${(after?.文本头 || '').includes('探针·启动按钮')}`);
const started = logFiles.length > 0 || (after?.提示条 ?? []).length > 0 || Number(javaCount) > 0;
console.log(
  `${started ? '✓' : '✗'} ③ 启动流程真的跑起来了：日志 ${logFiles.length} 个、提示条 ${(after?.提示条 ?? []).length} 条、沙盒 java ${javaCount} 个`,
);
console.log(`${javaReal === '0' ? '✓' : '✗'} ④ 没有把**真实游戏根**的东西拉起来（指向 D:\\IEML 的 java = ${javaReal}）`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(600);
await killSandboxJava();
await sleep(400);
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
