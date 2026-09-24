/**
 * 真机（沙盒）验证：**清单读的是哪一个 `instances.json`**。
 * ------------------------------------------------------------------
 * 背景：A-4 把清单搬进了启动器自己的家（`own_root`），但有两处命令**还在读老位置**
 * （`state.paths.root.join("instances.json")`）：`instance_health`（"版本失联"提示）
 * 与 `instance_usage`（下载页"有没有版本在用"）。真机上老位置那份从 2026-09-24 01:25
 * 起就没再写过 —— 于是这两处拿的是**陈旧清单**，读不到时还会静默返回空。
 *
 * 判据（三条，同一份沙盒、两个版本对照）：
 *   ① 旧发布版：清单只认**游戏根目录**那份（1 条 = `root-only`）—— 复现问题
 *   ② 新构建：清单认**启动器自己的家**那份（2 条 = `own-1` / `own-2`）
 *   ③ 新构建没有把老位置那份混进来（id 集合逐字相等）
 *
 * ★ 沙盒：`IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 三个都指到临时目录
 *   （只设前两个的话，启动时的"补齐"会把真实的 `%APPDATA%\IEML` 数据复制进来）。
 *
 * 用法：node tools/live/probe-manifest-location.mjs "<新构建 exe>" "<旧发布版 exe>"
 */
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { invokeOn, killIeml, launch } from './lib/cdp.mjs';

const NEW_EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';
const OLD_EXE = process.argv[3] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-mloc-root');
const OWN = path.join(T, 'ieml-mloc-own');
const FAKE_APPDATA = path.join(T, 'ieml-mloc-appdata');

for (const exe of [NEW_EXE, OLD_EXE]) {
  if (!existsSync(exe)) {
    console.error('找不到 exe：' + exe);
    process.exit(2);
  }
}

await killIeml();
for (const d of [ROOT, OWN, FAKE_APPDATA]) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
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
/*
 * ★ 种子的 mtime 必须**显式拨开**（这一步是判据能不能分辨的关键）：
 *   启动时的 `adopt_records` 会在"游戏根目录那份更新"或"目标是个空壳"时把
 *   根目录那份**复制到**启动器自己的家里 —— 于是第一阶段跑完，
 *   自己家里那份就被换成了 root-only，第二阶段（新构建）读到的自然是 root-only，
 *   判据 ② 假红。实测撞过一次（同一次运行里连写两个文件，mtime 只差几毫秒，
 *   谁更新全看运气）。所以：让 root 那份**更旧**，`adopt_records` 就不会动目标。
 */
const hourAgo = new Date(Date.now() - 3600 * 1000);
utimesSync(path.join(ROOT, 'instances.json'), hourAgo, hourAgo);
console.log('沙盒：ROOT=' + ROOT + '  OWN=' + OWN);
console.log('own/instances.json → own-1, own-2 ；root/instances.json → root-only（且更旧）');

/** 沙盒环境：三个变量都指到临时目录（见文件头） */
const sandbox = { APPDATA: FAKE_APPDATA, IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN };

/*
 * ★★ 2026-09-24：每个阶段**各起一个进程**。
 *
 *   实测（花了不少时间才定位到）：同一个 Node 进程里"起一个 → 杀掉 → 再起一个"
 *   时，第二次启动会**直接退出**（`exitCode=0`，日志里只剩一行 glass 设置）——
 *   启动器自己以为已经有实例在跑。而把第二阶段单独跑一遍**完全正常**
 *   （`node probe-manifest-location.mjs --phase=new`），换成全新端口、等更久、
 *   连残留的 msedgewebview2 一起收掉，都救不了"同进程连跑"这一种。
 *   所以判据不变，只是把两个阶段放进两个进程里跑 —— 这也是证据指向的修法。
 */
const phase = (process.argv.find((a) => a.startsWith('--phase=')) ?? '').split('=')[1] ?? '';

const idsOf = async (exe, tag) => {
  const app = await launch({ exe, tag, env: sandbox, keepDataDir: true });
  const health = await invokeOn(app.ev, 'instance_health', {});
  await app.close();
  return (health?.ok ?? []).map((x) => x.id).sort();
};

/* ---------- 单阶段模式：跑一个阶段，把结果写进 json 文件，然后退出 ---------- */
if (phase === 'old' || phase === 'new') {
  const exe = phase === 'old' ? OLD_EXE : NEW_EXE;
  const ids = await idsOf(exe, 'mloc-' + phase);
  console.log(`[${phase}] instance_health 的 id：` + JSON.stringify(ids));
  writeFileSync(path.join(T, `ieml-mloc-${phase}.json`), JSON.stringify({ phase, ids }));
  process.exit(0);
}

/* ---------- 两阶段模式：把两个阶段各起一个进程，再比对 ---------- */
const { spawnSync } = await import('node:child_process');
for (const p of ['old', 'new']) {
  console.log(`\n=== ${p === 'old' ? '旧发布版' : '新构建'}（单独一个进程跑）===`);
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), NEW_EXE, OLD_EXE, `--phase=${p}`], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`阶段 ${p} 跑失败（退出码 ${r.status}）—— 本次测量无效`);
    process.exit(4);
  }
}
const read = (p) => {
  try {
    return JSON.parse(readFileSync(path.join(T, `ieml-mloc-${p}.json`), 'utf8')).ids;
  } catch {
    return null;
  }
};
const oldIds = read('old');
const newIds = read('new');
console.log('\n两个阶段的结果：旧 ' + JSON.stringify(oldIds) + ' / 新 ' + JSON.stringify(newIds));

const oldReadsRoot = JSON.stringify(oldIds) === JSON.stringify(['root-only']);
const newReadsOwn = JSON.stringify(newIds) === JSON.stringify(['own-1', 'own-2']);
console.log('\n===== 判据 =====');
console.log(`${oldReadsRoot ? '✓' : '✗'} ① 旧发布版读的是**游戏根目录**那份（${JSON.stringify(oldIds)}）—— 判据能红`);
console.log(`${newReadsOwn ? '✓' : '✗'} ② 新构建读的是**启动器自己的家**那份（${JSON.stringify(newIds)}）`);
console.log(`${newReadsOwn ? '✓' : '✗'} ③ 新构建没有把老位置那份混进来（id 集合逐字相等）`);
process.exit(oldReadsRoot && newReadsOwn ? 0 : 1);
