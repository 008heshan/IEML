/**
 * 真机验证：**切换游戏根目录是「即时生效」**（用户：「我不想要重启才生效，
 * 切换游戏数据应该是实时的」）。
 * ------------------------------------------------------------------
 * 判据（五条）：
 *   ① 换之前：`machine_info.data_dir` = 老根目录（D:\IEML）
 *   ② 换到新目录之后**同一个进程里立刻**读到新根目录（不重启、不刷页面）
 *   ③ 新根目录**真的被用起来了**：它里面没有 `.minecraft/versions`，
 *      于是 `instance_health` 立刻把所有实例标成「版本缺失」（老根下是好的）——
 *      这条是"句柄真换了"的硬证据，不是只看一个显示字段
 *   ④ 记账文件 `datadir.txt` 也写成了新根目录
 *   ⑤ 换回来 → 一切复原（data_dir 与实例健康都回到老根的状态）
 *
 * ★ 修之前必红：那条命令只写记录、返回 `restart_required: true`，
 *   所以 ②③ 都要等重启才对 —— 探针在同一进程里立刻读，必然读到旧值。
 *
 * ★ 记账文件（`%APPDATA%\IEML\datadir.txt`）是全局状态：开跑前摆正、跑完擦干净
 *   （见 `forceOldRecord`），否则一次红证就能把这台机器的默认根目录带偏。
 *
 * 用法：node tools/live/probe-live-root-switch.mjs "<exe>"
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const APPDATA = process.env.APPDATA ?? '';
const RECORD = path.join(APPDATA, 'IEML', 'datadir.txt');
const OLD_ROOT = 'D:\\IEML';
const NEW_ROOT = path.join(process.env.TEMP ?? '.', 'ieml-live-root');

const readRecord = () => {
  try {
    return readFileSync(RECORD, 'utf8').trim();
  } catch (e) {
    return '(读不到) ' + e.message;
  }
};

/** 把记账文件直接写成老根目录（格式与后端 `write_location` 一致：一行 + \n）。
 *
 *  ★ 为什么要探针自己写：**老构建**（没有实时切换的那份）会把「换回来」当成
 *    「这就是当前的数据目录，没有变化」而拒绝落盘 —— 它以为当前根还是 D:\IEML，
 *    其实记账文件已经被上一步写成新目录了。跑完不擦，下一次启动就会真的
 *    按新目录起来（2026-09-25 第一次红证就踩了：记录被留在临时目录）。 */
const forceOldRecord = (why) => {
  const now = readRecord();
  if (now.toLowerCase() === OLD_ROOT.toLowerCase()) return '';
  writeFileSync(RECORD, OLD_ROOT + '\n');
  return `（探针擦屁股：${why}；记账文件从 ${now} 写回 ${OLD_ROOT}）`;
};

/* ★ 开跑之前先把记账文件摆正：否则整个探针会站在一个"错的起点"上量，
 *   ① 会红得莫名其妙、②③ 更是白量（2026-09-25 第一次红证就撞上过）。 */
const preseed = forceOldRecord('开跑前记账文件不是老根目录');
if (preseed) console.log('⚠ ' + preseed + '\n');

const dataDirOf = async (ev) => (await invokeOn(ev, 'machine_info', {}))?.ok?.data_dir ?? '(取不到)';
const healthOf = async (ev) => {
  const r = await invokeOn(ev, 'instance_health', {});
  const list = r?.ok ?? [];
  return { n: list.length, missing: list.filter((x) => x.version_missing).length, raw: r?.err ?? null };
};

/* 造一个干净的目标根目录（只有空壳，没有任何版本） */
rmSync(NEW_ROOT, { recursive: true, force: true });
mkdirSync(path.join(NEW_ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(NEW_ROOT, 'instances'), { recursive: true });

await killIeml();
const app = await launch({ exe: EXE, tag: 'liveroot', settleMs: 3500 });
const pid0 = app.pid;

const before = { dataDir: await dataDirOf(app.ev), health: await healthOf(app.ev), record: readRecord() };
console.log('① 换之前：data_dir=' + before.dataDir + '　实例健康=' + JSON.stringify(before.health) + '　记录=' + before.record);

/* ---------- 切到新根目录 ---------- */
console.log('\n换到 ' + NEW_ROOT + ' …');
const switched = await invokeOn(app.ev, 'set_data_root', { path: NEW_ROOT });
console.log('   后端返回：' + JSON.stringify(switched?.ok ?? switched?.err));
await sleep(800);

const after = { dataDir: await dataDirOf(app.ev), health: await healthOf(app.ev), record: readRecord() };
const pidNow = (await app.ev(`1`), pid0); // 进程还在同一个（CDP 连接没断就是同一个进程）
console.log('② 换之后：data_dir=' + after.dataDir + '　实例健康=' + JSON.stringify(after.health) + '　记录=' + after.record);

/* ---------- 换回来 ---------- */
console.log('\n换回 ' + OLD_ROOT + ' …');
const back = await invokeOn(app.ev, 'set_data_root', { path: OLD_ROOT });
console.log('   后端返回：' + JSON.stringify(back?.ok ?? back?.err));
await sleep(800);
const restored = { dataDir: await dataDirOf(app.ev), health: await healthOf(app.ev), record: readRecord() };
console.log('⑤ 换回来：data_dir=' + restored.dataDir + '　实例健康=' + JSON.stringify(restored.health) + '　记录=' + restored.record);

await app.close();
rmSync(NEW_ROOT, { recursive: true, force: true });
const cleanup = forceOldRecord('应用自己没能换回来');

/* ---------- 判据 ---------- */
const c1 = before.dataDir.toLowerCase() === OLD_ROOT.toLowerCase();
const c2 = after.dataDir.toLowerCase() === NEW_ROOT.toLowerCase();
const c3 = after.health.n > 0 && after.health.missing === after.health.n;
const c4 = after.record.toLowerCase() === NEW_ROOT.toLowerCase();
const c5 = restored.dataDir.toLowerCase() === OLD_ROOT.toLowerCase() && restored.health.missing === 0;

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 换之前用的是老根目录（${before.dataDir}）`);
console.log(`${c2 ? '✓' : '✗'} ② 换完**同一个进程里立刻**读到新根目录（${after.dataDir}）`);
console.log(`${c3 ? '✓' : '✗'} ③ 新根目录真的被用起来了：${after.health.missing}/${after.health.n} 个实例立刻变成「版本缺失」（老根下是 ${before.health.missing}/${before.health.n}）`);
console.log(`${c4 ? '✓' : '✗'} ④ 记账文件也写成新根目录（${after.record}）`);
console.log(`${c5 ? '✓' : '✗'} ⑤ 换回来一切复原（${restored.dataDir}，缺失 ${restored.health.missing}/${restored.health.n}）`);
if (!c2) {
  console.log('   ※ ⑤ 在老构建上是**空绿**：它压根没换过去（②③红），所以"复原"是白得的。');
}
if (cleanup) console.log('⚠ ' + cleanup);
console.log(`记账文件收尾：${readRecord()}`);
process.exit(c1 && c2 && c3 && c4 && c5 ? 0 : 1);
