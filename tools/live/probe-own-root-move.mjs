/**
 * 真机验证 C：**启动器自己的家搬到用户挑的那块盘**（本机 `D:\IEML-launcher`）。
 * ------------------------------------------------------------------
 * 用户的诉求（ABC 全做里的 C）：「把账本 + Java/缓存/日志也搬到 D 盘，让 C 盘彻底不留东西」。
 *
 * 判据（六条）：
 *   ① `%APPDATA%\IEML\ownroot.txt` 写下了新位置（记录本身必须留在固定的老位置）
 *   ② `D:\IEML-launcher` 里账本 + `java/cache/logs` 都在（搬迁真的发生了）
 *   ③ 新家的账本与界面**对得上**（实例条数 = 列表行数、主题 = 界面上那个）
 *   ④ 界面照常：版本列表读得到、`data_dir` 还是游戏根目录
 *   ⑤ ★ 决定性一条：把当前偏好**原样存回一次** → 写进新家；C 盘那份**根本不存在**
 *   ⑥ 老位置只剩"必须留在固定位置"的记录文件（`datadir.txt` / `ownroot.txt`）
 *
 * ★ ⑤ 换过一次判据（教训留在 ADR 七十二）：原来用"取版本清单会写 cache"当写入证据，
 *   而清单还在 TTL 内时应用**什么都不写** —— 红的是"没写到 D 盘"，读起来却像"C 盘还在被写"。
 *   换成与网络/TTL 无关的"存回偏好"才稳定。
 *
 * 用法：node tools/live/probe-own-root-move.mjs "<新构建 exe>"
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { countIn, invokeOn, jsonOr, killIeml, launch, mtimeOf, newestIn, readOr, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';
const APPDATA = process.env.APPDATA ?? '';
const C_HOME = path.join(APPDATA, 'IEML');
const D_HOME = 'D:\\IEML-launcher';
const LEDGER = ['instances.json', 'prefs.json', 'ms_client_id.txt', 'cf_api_key.txt'];

if (!existsSync(EXE)) {
  console.error('找不到 exe：' + EXE);
  process.exit(2);
}

/* ---------- 搬迁前的样子 ---------- */
const before = {
  记录文件: readOr(path.join(C_HOME, 'ownroot.txt')).trim(),
  老账本: LEDGER.filter((n) => existsSync(path.join(C_HOME, n))).join(' '),
  老实例条数: (jsonOr(path.join(C_HOME, 'instances.json'))?.instances ?? []).length,
  C盘cache文件数: countIn(path.join(C_HOME, 'cache')),
  C盘cache最新mtime: newestIn(path.join(C_HOME, 'cache')),
  新家已存在: existsSync(D_HOME),
};
console.log('=== 搬迁前 ===');
console.log(JSON.stringify(before, null, 2));

console.log('\n=== 用新构建启动（真实数据、真实环境）===');
await killIeml();
const app = await launch({ exe: EXE, tag: 'ownroot', settleMs: 3500 });
const { ev } = app;

/* 界面照常吗 */
await ev(`[...document.querySelectorAll('.nav-item')].find((x)=>(x.textContent||'').includes('版本列表'))?.click()`);
await sleep(2000);
const rows = await ev(`[...document.querySelectorAll('.ver-item')].map((x)=>(x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40))`);
const theme = await ev(`document.documentElement.getAttribute('data-theme')`);
const info = await invokeOn(ev, 'app_info', {});
console.log('界面：版本列表 ' + (rows ?? []).length + ' 行；主题=' + JSON.stringify(theme));
console.log('app_info：' + JSON.stringify(info?.ok ?? info?.err));

/*
 * ★ 逼一次"真的往启动器自己的目录写"。
 *   第一版想用"取版本清单会写 cache"来证明，结果它**时灵时不灵**：
 *   清单还在 TTL 内时应用直接从内存/缓存给答案，磁盘上什么都不写 ——
 *   于是判据红的是"没写到 D 盘"，而不是"C 盘还被写"，读起来会误导。
 *   改成**确定性**的一招：把当前偏好原样存回去（`load_prefs` → `save_prefs`）。
 */
const prefsPathD = path.join(D_HOME, 'prefs.json');
const prefsPathC = path.join(C_HOME, 'prefs.json');
const dPrefsBefore = mtimeOf(prefsPathD);
const loaded = await invokeOn(ev, 'load_prefs', {});
const saved = loaded?.ok ? await invokeOn(ev, 'save_prefs', { prefs: loaded.ok }) : { err: '取不到偏好，跳过' };
console.log('\n原样存回一次偏好（证明写入落在新家）：' + (loaded?.ok ? (saved?.err ? '失败 ' + saved.err : '成功') : '跳过'));
await sleep(1200);
const cacheAfter = { C盘prefs: mtimeOf(prefsPathC), D盘prefs: mtimeOf(prefsPathD) };
console.log(`  偏好文件 mtime：新家 ${dPrefsBefore} → ${cacheAfter.D盘prefs}；C 盘那份 mtime=${cacheAfter.C盘prefs}（0 = 不存在，这才是对的）`);

await app.close();

/* ---------- 搬迁后的样子 ---------- */
const afterC = {
  记录文件: readOr(path.join(C_HOME, 'ownroot.txt')).trim(),
  C盘cache文件数: countIn(path.join(C_HOME, 'cache')),
  剩余文件: readdirSync(C_HOME).sort(),
};
const afterD = existsSync(D_HOME)
  ? {
      顶层: readdirSync(D_HOME).sort(),
      账本: LEDGER.filter((n) => existsSync(path.join(D_HOME, n))).join(' '),
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
const needInNew = ledgerInOld.length ? ledgerInOld : ['instances.json', 'prefs.json'];
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
const recordsOnly = ['datadir.txt', 'ownroot.txt'];
const c6 =
  (recordsOnly.every((n) => afterC.剩余文件.includes(n)) && !afterC.剩余文件.includes('cache') && !afterC.剩余文件.includes('instances')) ||
  (existsSync(path.join(C_HOME, 'instances.json')) && existsSync(path.join(C_HOME, 'cache')));

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 记录 ownroot.txt = ${JSON.stringify(afterC.记录文件)}`);
console.log(`${c2 ? '✓' : '✗'} ② 账本（${needInNew.join('/')}）+ java/cache/logs 都在 ${D_HOME}`);
console.log(`${c3 ? '✓' : '✗'} ③ 新家账本与界面对得上（实例 ${afterD?.实例条数} 条 = 列表 ${(rows ?? []).length} 行；主题 ${JSON.stringify(afterD?.主题)} = 界面 ${JSON.stringify(theme)}）`);
console.log(`${c4 ? '✓' : '✗'} ④ 界面照常（data_dir=${JSON.stringify(info?.ok?.data_dir)}）`);
console.log(`${c5 ? '✓' : '✗'} ⑤ 账本写入落在 D 盘新家、C 盘连文件都没有（新家 ${dPrefsBefore} → ${cacheAfter.D盘prefs}；C 盘 ${cacheAfter.C盘prefs}）`);
console.log(`${c6 ? '✓' : '✗'} ⑥ 老位置只剩记录文件：${JSON.stringify(afterC.剩余文件)}`);
process.exit(c1 && c2 && c3 && c4 && c5 && c6 ? 0 : 1);
