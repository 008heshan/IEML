/**
 * 真机验证「实例目录跟着游戏盘走」（用户：「我在用 D 盘的目录，为什么版本列表的
 * 版本给我定位到 `C:\Users\…\AppData\Roaming\IEML\instances` 了」）。
 * ------------------------------------------------------------------
 * ★ 这份探针**故意用真实数据**（不设 IEML_DATA_DIR / IEML_OWN_DIR / APPDATA）——
 *   用户报的就是"真机上我的版本被定位到 C 盘"，只有在真机上跑才算验到。
 *   跑之前已经量过：两个方向的迁移/收养在真机上都是 **0 字节**
 *   （C 的 instances ⊂ D 的、D 的 cache/logs 与 C 的逐文件相同、`shared` 在
 *   `.minecraft` 里也有），所以这次启动不会往任何一边搬东西。
 *
 * 判据（四条，①②③ 是"同一份数据、两个版本"的对照）：
 *   ① 旧发布版（rc.3，桌面那份）在同一份真机数据上：实例路径落在
 *      `%APPDATA%\IEML\instances` —— **复现用户的报告**（判据能红）
 *   ② 新构建：同一批实例落在用户挑的游戏盘 `D:\IEML\instances`
 *   ③ 老版本给出的路径里，只在 D 盘存在的两个实例（vanilla-262 / vanilla-1122）
 *      **磁盘上并不存在** —— 这就是"定位错了"的实际后果（存档/Mod 都不在那边）；
 *      新版本给出的三个路径**都存在**
 *   ④ 新版本这次启动**没有往游戏根目录里塞启动器文件**：`D:\IEML\cache` 与
 *      `D:\IEML\logs` 在这次运行期间没有任何新文件（旧代码会把 C 盘的 cache
 *      复制进去）
 *   ⑤ 那两天写在老位置的**实例设置**被带到了新家：`fabric-262/game/options.txt`
 *      现在是自己最后玩过的那份（`lang:zh_cn`），被盖掉的那份留在
 *      `options.txt.ieml-bak` 里（判据是 mtime，不是"目标优先"）
 *
 * 用法：node tools/live/probe-instance-root.mjs "<新构建 exe>" "<旧发布版 exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PORT = 9971;
const NEW_EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OLD_EXE = process.argv[3] ?? path.join(process.env.USERPROFILE ?? 'C:\\Users\\Administrator', 'Desktop', 'IEML.exe');
const T = process.env.TEMP ?? '.';
const PROFILE = path.join(T, 'ieml-instroot-prof');
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

const APPDATA = process.env.APPDATA ?? '';
const C_INST = path.join(APPDATA, 'IEML', 'instances');
const D_ROOT = 'D:\\IEML';
const D_INST = path.join(D_ROOT, 'instances');

/* ---------- 起一个实例（真实数据、真实环境）并接上 CDP ---------- */
const startApp = async (exe) => {
  const env = { ...process.env };
  /* ★ 必须显式清掉：否则会读到开发机上的沙盒变量（本探针要的正是真实数据） */
  delete env.IEML_DATA_DIR;
  delete env.IEML_OWN_DIR;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${PORT}`;
  env.WEBVIEW2_USER_DATA_FOLDER = PROFILE;
  const child = spawn(exe, [], { env, stdio: 'ignore' });
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
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
    return r.result?.result?.value;
  };
  for (let i = 0; i < 75; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
    await sleep(400);
  }
  await sleep(2500); // 等界面把实例列表拉起来
  return { child, ev, ws };
};

/* ---------- 通过 Tauri 内部 invoke 调后端的路径类命令 ---------- */
const invoke = (ev, cmd, args) =>
  ev(
    `(async () => {
       try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)} ) }; }
       catch (e) { return { err: String(e && e.message ? e.message : e) }; }
     })()`,
  );

/** 每个实例：预览启动命令（不启动），取出 --gameDir 与 natives_dir */
const probePaths = async (ev, label) => {
  const listed = await invoke(ev, 'list_instances', {});
  const insts = listed?.ok?.instances ?? [];
  const out = { label, count: insts.length, rows: [] };
  for (const i of insts) {
    const req = {
      mc_version: i.mcVersion,
      loader_kind: i.loader ? i.loader.kind : null,
      loader_version: i.loader ? i.loader.version : null,
      username: 'PathProbe',
      account_uuid: null,
      memory_mb: i.config?.memoryMb ?? 2048,
      width: 854,
      height: 480,
      instance_slug: i.config?.slug ?? '',
      instance_id: i.id,
      extra_jvm_args: [],
      extra_game_args: [],
      window_title: null,
      join_server: null,
    };
    const r = await invoke(ev, 'preview_launch', { req });
    const p = r?.ok ?? {};
    const m = /--gameDir\s+"?([^"\s]+)"?/.exec(p.command ?? '');
    const natives = p.natives_dir ?? '';
    const gameDir = m ? m[1] : '';
    out.rows.push({
      实例: i.config?.name ?? i.id,
      slug: req.instance_slug,
      游戏目录: gameDir,
      资源目录: natives,
      游戏目录存在: gameDir ? existsSync(gameDir) : null,
      出错: r?.err ?? null,
    });
  }
  return out;
};

/* ---------- 游戏根目录里的"启动器文件"有没有被写 ---------- */
const newest = (dir) => {
  try {
    let best = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const full = path.join(e.parentPath ?? dir, e.name);
      try {
        const t = statSync(full).mtimeMs;
        if (t > best) best = t;
      } catch {}
    }
    return best;
  } catch {
    return 0;
  }
};
const snapGameRoot = () => ({
  'D:\\IEML\\cache 最新 mtime': newest(path.join(D_ROOT, 'cache')),
  'D:\\IEML\\logs 最新 mtime': newest(path.join(D_ROOT, 'logs')),
  'D:\\IEML 顶层': readdirSync(D_ROOT).join(' '),
  '%APPDATA%\\IEML\\instances 最新 mtime': newest(C_INST),
});

console.log('新构建：' + NEW_EXE);
console.log('旧发布版：' + OLD_EXE);
console.log('datadir.txt：' + (() => {
  try {
    return readFileSync(path.join(APPDATA, 'IEML', 'datadir.txt'), 'utf8').trim();
  } catch (e) {
    return '(读不到) ' + e.message;
  }
})());
console.log('C 盘实例目录：' + C_INST + ' → ' + (existsSync(C_INST) ? readdirSync(C_INST).join(' ') : '(不存在)'));
console.log('D 盘实例目录：' + D_INST + ' → ' + (existsSync(D_INST) ? readdirSync(D_INST).join(' ') : '(不存在)'));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);

const before = snapGameRoot();
console.log('\n=== 运行前 ===');
console.log(JSON.stringify(before, null, 2));

/* ---------- ① 旧发布版：应当复现用户的报告 ---------- */
console.log('\n=== 旧发布版（rc.3）：同一份真机数据 ===');
const oldRun = await startApp(OLD_EXE);
const oldPaths = await probePaths(oldRun.ev, '旧发布版');
console.log(JSON.stringify(oldPaths, null, 2));
const oldHealth = await invoke(oldRun.ev, 'instance_health', {});
console.log('instance_health：' + JSON.stringify(oldHealth?.ok ?? oldHealth?.err));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);

/* ---------- ② 新构建：应当落在 D 盘 ---------- */
console.log('\n=== 新构建：同一份真机数据 ===');
const newRun = await startApp(NEW_EXE);
const newPaths = await probePaths(newRun.ev, '新构建');
console.log(JSON.stringify(newPaths, null, 2));
const newHealth = await invoke(newRun.ev, 'instance_health', {});
console.log('instance_health：' + JSON.stringify(newHealth?.ok ?? newHealth?.err));
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);

const after = snapGameRoot();
console.log('\n=== 运行后 ===');
console.log(JSON.stringify(after, null, 2));

/* ---------- 判据 ---------- */
const lower = (s) => String(s ?? '').toLowerCase();
const rowsOf = (o) => o.rows ?? [];
const oldAllC = rowsOf(oldPaths).length > 0 && rowsOf(oldPaths).every((r) => lower(r.游戏目录).startsWith(lower(C_INST)));
const newAllD = rowsOf(newPaths).length > 0 && rowsOf(newPaths).every((r) => lower(r.游戏目录).startsWith(lower(D_INST)));
const newAllDExist = rowsOf(newPaths).every((r) => r.游戏目录存在 === true);
const oldMissing = rowsOf(oldPaths).filter((r) => r.游戏目录存在 !== true).map((r) => r.slug);
const gameRootUntouched =
  after['D:\\IEML\\cache 最新 mtime'] <= before['D:\\IEML\\cache 最新 mtime'] &&
  after['D:\\IEML\\logs 最新 mtime'] <= before['D:\\IEML\\logs 最新 mtime'];

/* ---------- ⑤ 实例设置：老位置那份（最后玩过的）应当赢 ---------- */
const readOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return '(读不到) ' + e.message;
  }
};
const optsNew = path.join(D_INST, 'fabric-262', 'game', 'options.txt');
const bakNew = optsNew + '.ieml-bak';
const langOf = (t) => (/^lang:(\S+)/m.exec(t) ?? [])[1] ?? '(没有 lang:)';
const optNew = readOr(optsNew);
const optBak = existsSync(bakNew) ? readOr(bakNew) : '(没有备份)';
const settingsKept = langOf(optNew) === 'zh_cn';

console.log('\n===== 判据 =====');
console.log(`${oldAllC ? '✓' : '✗'} ① 旧发布版把实例定位到 %APPDATA%\\IEML\\instances（复现用户的报告，判据能红）`);
console.log(`${newAllD ? '✓' : '✗'} ② 新构建把同一批实例定位到 ${D_INST}（用户挑的游戏盘）`);
console.log(`${newAllDExist ? '✓' : '✗'} ③ 新构建给出的游戏目录**都存在**；旧版给出的缺失实例：${JSON.stringify(oldMissing)}`);
console.log(`${gameRootUntouched ? '✓' : '✗'} ④ 新构建这次启动没往游戏根目录写启动器文件（cache/logs 无新文件）`);
console.log(
  `${settingsKept ? '✓' : '✗'} ⑤ 实例设置跟着走：新家 options.txt 的 lang=${langOf(optNew)}，备份那份 lang=${langOf(optBak)}`,
);
console.log(`   instance_health：旧 ${JSON.stringify(oldHealth?.ok?.length ?? oldHealth?.err)} 条 → 新 ${JSON.stringify(newHealth?.ok?.length ?? newHealth?.err)} 条`);
process.exit(0);
