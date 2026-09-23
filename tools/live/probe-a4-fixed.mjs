/**
 * 真机验证 A-4 的修复：`instances.json` / `prefs.json` / `ms_client_id.txt` / `cf_api_key.txt`
 * **搬进启动器自己的家**（`IEML_OWN_DIR`），游戏根目录里不再读写它们。
 * ------------------------------------------------------------------
 * 判据（四条）：
 *   ① 老用户的文件还在**游戏根目录**里 → 启动后它们被**复制**到 `own_root`，
 *      内容一致（三个实例 + 主题 daiqing）—— 这是"升级无感"
 *   ② 启动器**不再往游戏根目录写**：那次启动照例有的自动回写，
 *      落到了 `own_root` 那份（mtime 变新），而游戏根那份 mtime **一个字节没动**
 *   ③ ★ 用户视角的决定性一条：**把整个游戏根目录删掉**（模拟"在候选盘那页删掉这个根"），
 *      重启启动器后**实例清单与设置都还在**（以前会一起没）
 *   ④ 全程没有碰到真实的 `%APPDATA%\IEML` 与 `D:\IEML`（沙盒靠 IEML_DATA_DIR/IEML_OWN_DIR 隔离）
 * 用法：node tools/live/probe-a4-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9988;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a4-root');
const OWN = path.join(T, 'ieml-a4-own');
const PROFILE = path.join(T, 'ieml-a4-prof');
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

/* ---------- 清理（先杀进程，再拆联接，再删 —— 顺序不能反，踩过 EBUSY） ---------- */
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const killSandboxJava = () =>
  ps(
    `Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ieml-a4*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
await killSandboxJava();
await sleep(500);
const dropLinks = async (root) => {
  const out = await ps(
    `Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | ForEach-Object { cmd /c rmdir "$($_.FullName)" }`,
  );
  if (out) console.log('拆掉联接：' + out);
};
const clean = async (d) => {
  for (let i = 0; i < 6; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (i === 5) {
        console.error('清理失败（继续跑）：' + d + ' → ' + e.message);
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

/* ---------- 造一个"老用户"的沙盒：数据全在**游戏根目录**里（0.1.0-rc.1 的布局） ---------- */
const inst = (id, name, slug) => ({
  id,
  mcVersion: '1.12.2',
  loader: null,
  addons: [],
  config: { name, slug, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
  createdAt: '2026-09-01T00:00:00.000Z',
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});
const ROOT_INSTANCES = { instances: [inst('a4-1', '探针A4·甲', 'probe-a4-a'), inst('a4-2', '探针A4·乙', 'probe-a4-b')], active_id: 'a4-1' };
const ROOT_PREFS = { theme: 'daiqing', downloadSource: 'bmclapi', concurrency: 32 };
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
writeFileSync(path.join(ROOT, 'instances.json'), JSON.stringify(ROOT_INSTANCES, null, 2));
writeFileSync(path.join(ROOT, 'prefs.json'), JSON.stringify(ROOT_PREFS, null, 2));
writeFileSync(path.join(ROOT, 'ms_client_id.txt'), '11111111-2222-3333-4444-555555555555\n');
writeFileSync(path.join(ROOT, 'cf_api_key.txt'), '$2a$10$probeA4fakekey\n');
const mtime = (p) => {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return '(不在)';
  }
};
const rootMtimesBefore = {
  'instances.json': mtime(path.join(ROOT, 'instances.json')),
  'prefs.json': mtime(path.join(ROOT, 'prefs.json')),
};
console.log('=== 沙盒（模拟老用户：文件都在游戏根目录里）===');
console.log('ROOT = ' + ROOT + '   OWN = ' + OWN);
console.log('游戏根里的文件：' + JSON.stringify(readdirSync(ROOT)));
console.log('种子 mtime：' + JSON.stringify(rootMtimesBefore));

/* ---------- CDP 起一个实例，跑一段，读结果 ---------- */
const startApp = async () => {
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
  if (!page) throw new Error('连不上 CDP');
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
  await sleep(4000); // 等那次"读到列表后自动回写"
  return { ev, ws };
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { __err: String(e.message) };
  }
};
const names = (v) => (v?.instances ?? []).map((i) => i?.config?.name).filter(Boolean);

/* ---------- 第一次启动：老文件应当被"收养"到 own_root ---------- */
console.log('\n=== 第一次启动（老用户升级）===');
const a = await startApp();
const ownInstances = readJson(path.join(OWN, 'instances.json'));
const ownPrefs = readJson(path.join(OWN, 'prefs.json'));
const theme1 = await a.ev(`document.documentElement.getAttribute('data-theme')`);
console.log('own_root 里的文件：' + JSON.stringify(existsSync(OWN) ? readdirSync(OWN) : '(own_root 不存在)'));
console.log('own/instances.json 的实例名：' + JSON.stringify(names(ownInstances)));
console.log('own/prefs.json：' + JSON.stringify(ownPrefs));
console.log('界面 data-theme：' + JSON.stringify(theme1));
const rootMtimesAfter = {
  'instances.json': mtime(path.join(ROOT, 'instances.json')),
  'prefs.json': mtime(path.join(ROOT, 'prefs.json')),
};
const ownMtimes = { 'instances.json': mtime(path.join(OWN, 'instances.json')), 'prefs.json': mtime(path.join(OWN, 'prefs.json')) };
console.log('游戏根里那份的 mtime（现在）：' + JSON.stringify(rootMtimesAfter));
console.log('own_root 里那份的 mtime：' + JSON.stringify(ownMtimes));
console.log('own_root 里的小文件：' + JSON.stringify(['ms_client_id.txt', 'cf_api_key.txt'].map((f) => f + '=' + existsSync(path.join(OWN, f)))));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);

/* ---------- ★ 把整个游戏根目录删掉（模拟"在候选盘那页删掉这个根"） ---------- */
console.log('\n=== 删掉整个游戏根目录 ' + ROOT + ' ===');
const del = await ps(`cmd /c rmdir /s /q "${ROOT}"`);
console.log('删除输出：' + JSON.stringify(del) + '  还在？' + existsSync(ROOT));

/* ---------- 第二次启动：数据必须还在 ---------- */
console.log('\n=== 第二次启动（游戏根已经没了）===');
const b = await startApp();
/*
 * ★ 必须先切到「版本列表」页再数行 —— 启动后默认停在「启动」页，
 *   那一页上根本没有 `.ver-item`（这条探针第一版就是这么误判成红的）。
 */
await b.ev(`[...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);
const rows = await b.ev(`(() => {
  const items = [...document.querySelectorAll('.ver-item')];
  return { 行数: items.length, 文本: items.map((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)) };
})()`);
console.log('版本列表页：' + JSON.stringify(rows, null, 2));
const launchPage = await b.ev(`(() => {
  const t = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return ['探针A4·甲', '探针A4·乙'].filter((n) => t.includes(n));
})()`);
console.log('启动页文本里出现的实例名：' + JSON.stringify(launchPage));
const theme2 = await b.ev(`document.documentElement.getAttribute('data-theme')`);
console.log('界面 data-theme：' + JSON.stringify(theme2));
const ownInstances2 = readJson(path.join(OWN, 'instances.json'));
console.log('own/instances.json 的实例名（重启后）：' + JSON.stringify(names(ownInstances2)));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);

/* ---------- 判据 ---------- */
const sameNames = JSON.stringify(names(ownInstances)) === JSON.stringify(['探针A4·甲', '探针A4·乙']);
const rootUntouched =
  rootMtimesAfter['instances.json'] === rootMtimesBefore['instances.json'] &&
  rootMtimesAfter['prefs.json'] === rootMtimesBefore['prefs.json'];
console.log('\n===== 判据 =====');
console.log(`${sameNames ? '✓' : '✗'} ① 老文件被收养进 own_root（实例名 ${JSON.stringify(names(ownInstances))}）`);
console.log(`${ownPrefs?.theme === 'daiqing' && theme1 === 'daiqing' ? '✓' : '✗'} ② 偏好也搬过去了：own/prefs.theme=${JSON.stringify(ownPrefs?.theme)} 界面=${JSON.stringify(theme1)}`);
console.log(`${rootUntouched ? '✓' : '✗'} ③ 启动器不再往游戏根目录写：根里 mtime 未变=${rootUntouched}`);
const survived = (rows?.行数 ?? 0) >= 2 && (rows?.文本 ?? []).some((t) => t.includes('探针A4'));
console.log(`${survived ? '✓' : '✗'} ④ 删掉游戏根之后重启：实例清单还在（行数=${rows?.行数}）`);
console.log(`${theme2 === 'daiqing' ? '✓' : '✗'} ④b 设置也还在：data-theme=${JSON.stringify(theme2)}`);

await killSandboxJava();
await sleep(400);
for (const d of [ROOT, OWN, PROFILE]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
