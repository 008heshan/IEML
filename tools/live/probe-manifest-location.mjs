/**
 * 真机（沙盒）验证：**清单读的是哪一个 `instances.json`**。
 * ------------------------------------------------------------------
 * 背景：A-4 把清单搬进了启动器自己的家（`own_root`），但有两处命令**还在读老位置**
 * （`state.paths.root.join("instances.json")`）：`instance_health`（"版本失联"提示）
 * 与 `instance_usage`（下载页"有没有版本在用"）。真机上老位置那份从 2026-09-24 01:25
 * 起就没再写过 —— 于是这两处拿的是**陈旧清单**，读不到时还会静默返回空。
 *
 * 判据（同一份沙盒、两个版本对照）：
 *   ① 旧发布版：清单只认**游戏根目录**那份（1 条 = `root-only`）—— 复现问题
 *   ② 新构建：清单认**启动器自己的家**那份（2 条 = `own-1` / `own-2`）
 *   ③ 新构建没有把老位置那份当成"更新的"来用：id 集合与 own 那份逐字相等
 *
 * ★ 沙盒：`IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 三个都指到临时目录
 *   （只设前两个的话，启动时的"补齐"会把真实的 `%APPDATA%\IEML` 数据复制进来）。
 *
 * 用法：node tools/live/probe-manifest-location.mjs "<新构建 exe>" "<旧发布版 exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9972;
const NEW_EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OLD_EXE = process.argv[3] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-mloc-root');
const OWN = path.join(T, 'ieml-mloc-own');
const PROFILE = path.join(T, 'ieml-mloc-prof');
const FAKE_APPDATA = path.join(T, 'ieml-mloc-appdata');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

for (const exe of [NEW_EXE, OLD_EXE]) {
  if (!existsSync(exe)) {
    console.error('找不到 exe：' + exe);
    process.exit(2);
  }
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      break;
    } catch {
      await sleep(700);
    }
  }
}
mkdirSync(path.join(OWN, 'instances'), { recursive: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE_APPDATA, 'IEML'), { recursive: true });

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
/* 启动器自己的家（新位置）：两条 */
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [inst('own-1', '探针·自家甲', 'mloc-own-a'), inst('own-2', '探针·自家乙', 'mloc-own-b')], active_id: 'own-1' }, null, 2),
);
/* 游戏根目录（A-4 之前的老位置）：一条，而且是**不同**的一条 */
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify({ instances: [inst('root-only', '探针·老位置', 'mloc-root')], active_id: 'root-only' }, null, 2),
);
console.log('沙盒：ROOT=' + ROOT + '  OWN=' + OWN);
console.log('own/instances.json → own-1, own-2 ；root/instances.json → root-only');

const startApp = async (exe) => {
  spawn(exe, [], {
    env: {
      ...process.env,
      APPDATA: FAKE_APPDATA,
      IEML_DATA_DIR: ROOT,
      IEML_OWN_DIR: OWN,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: PROFILE,
    },
    stdio: 'ignore',
  });
  let page = null;
  for (let i = 0; i < 75; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('连不上 CDP（' + exe + '）');
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
  for (let i = 0; i < 75; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
    await sleep(400);
  }
  await sleep(2500);
  const health = await ev(
    `(async () => { try { return { ok: await window.__TAURI_INTERNALS__.invoke('instance_health', {}) }; } catch (e) { return { err: String(e) }; } })()`,
  );
  return { health };
};

const ids = (h) => (h?.ok ?? []).map((x) => x.id).sort();

console.log('\n=== 旧发布版 ===');
const oldRun = await startApp(OLD_EXE);
const oldIds = ids(oldRun.health);
console.log('instance_health 的 id：' + JSON.stringify(oldIds) + (oldRun.health?.err ? '（出错：' + oldRun.health.err + '）' : ''));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);

console.log('\n=== 新构建 ===');
const newRun = await startApp(NEW_EXE);
const newIds = ids(newRun.health);
console.log('instance_health 的 id：' + JSON.stringify(newIds) + (newRun.health?.err ? '（出错：' + newRun.health.err + '）' : ''));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);

const oldReadsRoot = JSON.stringify(oldIds) === JSON.stringify(['root-only']);
const newReadsOwn = JSON.stringify(newIds) === JSON.stringify(['own-1', 'own-2']);
console.log('\n===== 判据 =====');
console.log(`${oldReadsRoot ? '✓' : '✗'} ① 旧发布版读的是**游戏根目录**那份（${JSON.stringify(oldIds)}）—— 判据能红`);
console.log(`${newReadsOwn ? '✓' : '✗'} ② 新构建读的是**启动器自己的家**那份（${JSON.stringify(newIds)}）`);
console.log(`${newReadsOwn ? '✓' : '✗'} ③ 新构建没有把老位置那份混进来（id 集合逐字相等）`);

for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      break;
    } catch {
      await sleep(600);
    }
  }
}
console.log('沙盒已清理');
process.exit(0);
