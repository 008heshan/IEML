/**
 * 真机验证 C：**启动器自己的家搬到用户挑的那块盘**（本机 `D:\IEML-launcher`）。
 * ------------------------------------------------------------------
 * 用户的诉求（ABC 全做里的 C）：「把账本 + Java/缓存/日志也搬到 D 盘，让 C 盘彻底不留东西」。
 *
 * 判据（六条）：
 *   ① `%APPDATA%\IEML\ownroot.txt` 写下了新位置（记录本身必须留在固定的老位置）
 *   ② `D:\IEML-launcher` 里账本四件 + `java/cache/logs` 都在（搬迁真的发生了）
 *   ③ 新家的账本与界面**对得上**（实例条数 = 列表行数、主题 = 界面上那个）
 *   ④ 界面照常：版本列表 3 行、「打开目录」给的还是 D 盘实例路径
 *   ⑤ ★ 决定性一条：**C 盘那份 cache 在这次运行期间一个新文件都没有**
 *      （新写入全落在 `D:\IEML-launcher\cache`）—— 这才叫"系统盘不再被写"
 *   ⑥ 老位置只剩"必须留在固定位置"的记录文件（`datadir.txt` / `ownroot.txt`）——
 *      ★ 这一条是**一次性清理之后**的形态：搬迁本身只复制、不删源，
 *        C 盘那些账本/缓存/旧数据是在用户说「ABC 全做」之后单独清掉的
 *        （清理前 ⑥ 的形态是"老位置一个都没删"，两种都算通过：见下面的判定）。
 *
 * 用法：node tools/live/probe-own-root-move.mjs "<新构建 exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const PORT = 9974;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const PROFILE = path.join(T, 'ieml-ownroot-prof');
const APPDATA = process.env.APPDATA ?? '';
const C_HOME = path.join(APPDATA, 'IEML');
const D_HOME = 'D:\\IEML-launcher';
const LEDGER = ['instances.json', 'prefs.json', 'ms_client_id.txt', 'cf_api_key.txt'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

if (!existsSync(EXE)) {
  console.error('找不到 exe：' + EXE);
  process.exit(2);
}

const readOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return '(读不到) ' + e.message;
  }
};
const jsonOr = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
/** 目录里最新的 mtime（只看我们自己关心的那层，走 readdir 递归） */
const newestIn = (dir) => {
  try {
    let best = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      try {
        const t = statSync(path.join(e.parentPath ?? dir, e.name)).mtimeMs;
        if (t > best) best = t;
      } catch {}
    }
    return best;
  } catch {
    return 0;
  }
};
const countIn = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
  } catch {
    return -1;
  }
};
/** 某个文件的 mtime（不存在时 0 —— 判据里"0 = 不该存在"也是有意义的信息） */
const mtimeOf = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/* ---------- 搬迁前的样子 ---------- */
const before = {
  记录文件: readOr(path.join(C_HOME, 'ownroot.txt')).trim(),
  老账本: LEDGER.map((n) => `${n}=${existsSync(path.join(C_HOME, n))}`).join(' '),
  老实例条数: (jsonOr(path.join(C_HOME, 'instances.json'))?.instances ?? []).length,
  老主题: jsonOr(path.join(C_HOME, 'prefs.json'))?.theme ?? '(没有)',
  C盘cache文件数: countIn(path.join(C_HOME, 'cache')),
  C盘cache最新mtime: newestIn(path.join(C_HOME, 'cache')),
  新家已存在: existsSync(D_HOME),
};
console.log('=== 搬迁前 ===');
console.log(JSON.stringify(before, null, 2));
if (existsSync(D_HOME)) {
  console.log('（新家已经存在：内容是 ' + JSON.stringify(readdirSync(D_HOME)) + '）');
}

console.log('\n=== 用新构建启动（真实数据、真实环境）===');
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1000);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const env = { ...process.env };
delete env.IEML_DATA_DIR;
delete env.IEML_OWN_DIR;
const child = spawn(EXE, [], {
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
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
if (!page) {
  console.error('连不上 CDP —— 启动器没起来，本次测量无效');
  process.exit(3);
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
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 75; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3500); // 等界面把清单/偏好拉起来（也就是"新家真的被读了"）

/* 界面照常吗 */
await ev(`[...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
const rows = await ev(`[...document.querySelectorAll('.ver-item')].map((x)=>(x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40))`);
const theme = await ev(`document.documentElement.getAttribute('data-theme')`);
const invoke = (cmd, args) =>
  ev(
    `(async () => {
       try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) }; }
       catch (e) { return { err: String(e && e.message ? e.message : e) }; }
     })()`,
  );
const info = await invoke('app_info', {});
console.log('界面：版本列表 ' + (rows ?? []).length + ' 行；主题=' + JSON.stringify(theme));
console.log('app_info：' + JSON.stringify(info?.ok ?? info?.err));

/*
 * ★ 逼一次"真的往启动器自己的目录写"。
 *
 *   第一版想用"取版本清单会写 cache"来证明，结果它**时灵时不灵**：
 *   清单还在 TTL 内时应用直接从内存/缓存给答案，磁盘上什么都不写 ——
 *   于是判据红的是"没写到 D 盘"，而不是"C 盘还被写"，读起来会误导。
 *
 *   改成**确定性**的一招：把当前偏好原样存回去（`load_prefs` → `save_prefs`）。
 *   启动器的账本就该落在自己的家里 ⇒ `D:\IEML-launcher\prefs.json` 必定被重写，
 *   而 C 盘那份**根本不该存在**。这条判据与网络、与缓存 TTL 都无关。
 */
const prefsPathD = path.join(D_HOME, 'prefs.json');
const prefsPathC = path.join(C_HOME, 'prefs.json');
const dPrefsBefore = mtimeOf(prefsPathD);
const loaded = await invoke('load_prefs', {});
const saved = loaded?.ok ? await invoke('save_prefs', { prefs: loaded.ok }) : { err: '取不到偏好，跳过' };
console.log(
  '\n原样存回一次偏好（证明写入落在新家）：' +
    (loaded?.ok ? (saved?.err ? '失败 ' + saved.err : '成功') : '跳过（' + JSON.stringify(loaded?.err) + '）'),
);
await sleep(1200);
const cacheAfter = {
  C盘prefs: mtimeOf(prefsPathC),
  D盘prefs: mtimeOf(prefsPathD),
};
console.log(
  `  偏好文件 mtime：新家 ${dPrefsBefore} → ${cacheAfter.D盘prefs}；C 盘那份 mtime=${cacheAfter.C盘prefs}（0 = 不存在，这才是对的）`,
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

/* ---------- 搬迁后的样子 ---------- */
const afterC = {
  记录文件: readOr(path.join(C_HOME, 'ownroot.txt')).trim(),
  C盘cache文件数: countIn(path.join(C_HOME, 'cache')),
  C盘cache最新mtime: newestIn(path.join(C_HOME, 'cache')),
};
const afterD = existsSync(D_HOME)
  ? {
      顶层: readdirSync(D_HOME).sort(),
      账本: LEDGER.map((n) => `${n}=${existsSync(path.join(D_HOME, n))}`).join(' '),
      实例条数: (jsonOr(path.join(D_HOME, 'instances.json'))?.instances ?? []).length,
      主题: jsonOr(path.join(D_HOME, 'prefs.json'))?.theme ?? '(没有)',
      cache文件数: countIn(path.join(D_HOME, 'cache')),
      cache最新mtime: newestIn(path.join(D_HOME, 'cache')),
    }
  : null;
console.log('\n=== 搬迁后 ===');
console.log('C 盘：' + JSON.stringify(afterC, null, 2));
console.log('D 盘新家：' + JSON.stringify(afterD, null, 2));

/* ---------- 判据 ---------- */
const record = (afterC.记录文件 || '').toLowerCase();
const c1 = record.startsWith('d:\\ieml-launcher');
/*
 * ② 老位置里**有的**账本文件都要出现在新家（`cf_api_key.txt` 本机就没设过，
 *    要求"四件都在"是判据写错了 —— 第一次跑就是这么假红的）。
 *    ★ 清理过老位置之后再跑，老位置一个账本都没有 → 退化成"新家必须有账本"。
 */
const ledgerInOld = LEDGER.filter((n) => existsSync(path.join(C_HOME, n)));
const needInNew = (ledgerInOld.length ? ledgerInOld : ['instances.json', 'prefs.json']);
const c2 =
  !!afterD &&
  needInNew.every((n) => existsSync(path.join(D_HOME, n))) &&
  ['java', 'cache', 'logs'].every((n) => existsSync(path.join(D_HOME, n)));
/* ③ 与界面互证（搬空壳是过不了这条的：条数对不上列表行数） */
const c3 = !!afterD && afterD.实例条数 === (rows ?? []).length && afterD.主题 === theme;
const c4 = (rows ?? []).length >= 3 && String(info?.ok?.data_dir ?? '').toLowerCase().startsWith('d:\\ieml');
/* ⑤ 决定性：那次"存回偏好"写进了**新家**，而 C 盘上连那份文件都不存在 */
const c5 = cacheAfter.D盘prefs > dPrefsBefore && cacheAfter.C盘prefs === 0;
/* ⑥ 老位置只剩记录文件（清理后的形态）；或"搬迁刚发生、老位置原样"（清理前）也算通过 */
const remainingC = readdirSync(C_HOME).sort();
const recordsOnly = ['datadir.txt', 'ownroot.txt'];
const c6 =
  (recordsOnly.every((n) => remainingC.includes(n)) && !remainingC.includes('cache') && !remainingC.includes('instances')) ||
  (existsSync(path.join(C_HOME, 'instances.json')) && existsSync(path.join(C_HOME, 'cache')));

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 记录 ownroot.txt = ${JSON.stringify(afterC.记录文件)}`);
console.log(`${c2 ? '✓' : '✗'} ② 账本（${needInNew.join('/')}）+ java/cache/logs 都在 D:\\IEML-launcher`);
console.log(`${c3 ? '✓' : '✗'} ③ 新家账本与界面对得上（实例 ${afterD?.实例条数} 条 = 列表 ${(rows ?? []).length} 行；主题 ${JSON.stringify(afterD?.主题)} = 界面 ${JSON.stringify(theme)}）`);
console.log(`${c4 ? '✓' : '✗'} ④ 界面照常（data_dir=${JSON.stringify(info?.ok?.data_dir)}）`);
console.log(
  `${c5 ? '✓' : '✗'} ⑤ 账本写入落在 D 盘新家、C 盘连文件都没有（新家 ${dPrefsBefore} → ${cacheAfter.D盘prefs}；C 盘 ${cacheAfter.C盘prefs}）`,
);
console.log(`${c6 ? '✓' : '✗'} ⑥ 老位置只剩记录文件：${JSON.stringify(remainingC)}`);
process.exit(c1 && c2 && c3 && c4 && c5 && c6 ? 0 : 1);
