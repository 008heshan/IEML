/**
 * 真机验证「实例目录跟着游戏盘走」（用户：「我在用 D 盘的目录，为什么版本列表的
 * 版本给我定位到 `C:\Users\…\AppData\Roaming\IEML\instances` 了」）。
 * ------------------------------------------------------------------
 * ★ 这份探针**故意用真实数据**（不设 IEML_DATA_DIR / IEML_OWN_DIR / APPDATA）——
 *   用户报的就是"真机上我的版本被定位到 C 盘"，只有在真机上跑才算验到。
 *   跑之前先量过：两个方向的迁移/收养在真机上都是 **0 字节**，所以这次启动不会乱搬东西。
 *
 * 判据（五条，①②③ 是"同一份数据、两个版本"的对照）：
 *   ① 旧发布版在同一份真机数据上：实例路径落在 `%APPDATA%\IEML\instances` ——
 *      **复现用户的报告**（判据能红）
 *   ② 新构建：同一批实例落在用户挑的游戏盘 `D:\IEML\instances`
 *   ③ 老版本给出的路径里，只在 D 盘存在的两个实例（vanilla-262 / vanilla-1122）
 *      **磁盘上并不存在**；新版本给出的三个**都存在**
 *   ④ 新版本这次启动**没有往游戏根目录里塞启动器文件**（`D:\IEML\cache` 与 `logs`
 *      在这次运行期间没有任何新文件）
 *   ⑤ 那两天写在老位置的**实例设置**被带到了新家（`options.txt` 的 lang=zh_cn）
 *
 * ★★ 两个阶段**各用一个端口**：启动器是单实例的，旧进程没清干净时新进程会被挡掉、
 *    悄悄退出，而探针会连上旧进程的端口 —— 那就把旧构建的答案当成了新构建的
 *    （第一版就这么假红过一次；公共库 `launch()` 的注释里记着这件事）。
 *
 * 用法：node tools/live/probe-instance-root.mjs "<新构建 exe>" "<旧发布版 exe>"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { invokeOn, killIeml, launch, newestIn, readOr, waitNoIeml } from './lib/cdp.mjs';

const NEW_EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';
const OLD_EXE = process.argv[3] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
const APPDATA = process.env.APPDATA ?? '';
const C_INST = path.join(APPDATA, 'IEML', 'instances');
const D_ROOT = 'D:\\IEML';
const D_INST = path.join(D_ROOT, 'instances');

for (const exe of [NEW_EXE, OLD_EXE]) {
  if (!existsSync(exe)) {
    console.error('找不到 exe：' + exe);
    process.exit(2);
  }
}

/** 每个实例：预览启动命令（不启动），取出 --gameDir 与 natives_dir */
const probePaths = async (ev, label) => {
  const listed = await invokeOn(ev, 'list_instances', {});
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
    const r = await invokeOn(ev, 'preview_launch', { req });
    const p = r?.ok ?? {};
    const m = /--gameDir\s+"?([^"\s]+)"?/.exec(p.command ?? '');
    const gameDir = m ? m[1] : '';
    out.rows.push({
      实例: i.config?.name ?? i.id,
      slug: req.instance_slug,
      游戏目录: gameDir,
      资源目录: p.natives_dir ?? '',
      游戏目录存在: gameDir ? existsSync(gameDir) : null,
      出错: r?.err ?? null,
    });
  }
  return out;
};

const snapGameRoot = () => ({
  'D:\\IEML\\cache 最新 mtime': newestIn(path.join(D_ROOT, 'cache')),
  'D:\\IEML\\logs 最新 mtime': newestIn(path.join(D_ROOT, 'logs')),
  '%APPDATA%\\IEML\\instances 最新 mtime': newestIn(C_INST),
});

console.log('新构建：' + NEW_EXE);
console.log('旧发布版：' + OLD_EXE);
console.log('datadir.txt：' + readOr(path.join(APPDATA, 'IEML', 'datadir.txt')).trim());
console.log('C 盘实例目录：' + C_INST + ' → ' + (existsSync(C_INST) ? '有' : '(不存在)'));
console.log('D 盘实例目录：' + D_INST + ' → ' + (existsSync(D_INST) ? '有' : '(不存在)'));

await killIeml();
if (!(await waitNoIeml())) {
  console.error('等不到 ieml 退出 —— 本次测量无效（不要让旧进程冒充新进程）');
  process.exit(4);
}

const before = snapGameRoot();
console.log('\n=== 运行前 ===');
console.log(JSON.stringify(before, null, 2));

/*
 * ★★ 2026-09-24：每个阶段**各起一个进程**（与 probe-manifest-location 同因同治）。
 *   实测：同一个 Node 进程里"起一个 → 杀掉 → 再起一个"，第二次启动会直接退出
 *   （`exitCode=0`，日志里只剩一行 glass 设置）；而把该阶段单独跑一遍完全正常。
 *   判据一个字不改，只把两个阶段放进两个进程里。
 */
const phase = (process.argv.find((a) => a.startsWith('--phase=')) ?? '').split('=')[1] ?? '';

if (phase === 'old' || phase === 'new') {
  const exe = phase === 'old' ? OLD_EXE : NEW_EXE;
  console.log(`\n=== ${phase === 'old' ? '旧发布版（改之前那份）' : '新构建（部署到桌面那份）'}：同一份真机数据 ===`);
  const app = await launch({ exe, tag: 'instroot-' + phase });
  const paths = await probePaths(app.ev, phase);
  console.log(JSON.stringify(paths, null, 2));
  const health = await invokeOn(app.ev, 'instance_health', {});
  console.log('instance_health：' + JSON.stringify(health?.ok ?? health?.err));
  await app.close();
  writeFileSync(path.join(process.env.TEMP ?? '.', `ieml-instroot-${phase}.json`), JSON.stringify({ rows: paths.rows }));
  process.exit(0);
}

const { spawnSync } = await import('node:child_process');
for (const p of ['old', 'new']) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), NEW_EXE, OLD_EXE, `--phase=${p}`], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`阶段 ${p} 跑失败（退出码 ${r.status}）—— 本次测量无效`);
    process.exit(4);
  }
}
const rowsOfPhase = (p) => {
  try {
    return JSON.parse(readFileSync(path.join(process.env.TEMP ?? '.', `ieml-instroot-${p}.json`), 'utf8')).rows ?? [];
  } catch {
    return [];
  }
};
const oldPaths = { rows: rowsOfPhase('old') };
const newPaths = { rows: rowsOfPhase('new') };

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

/* ⑤ 实例设置：老位置那份（最后玩过的）应当赢 */
const optsNew = path.join(D_INST, 'fabric-262', 'game', 'options.txt');
const langOf = (t) => (/^lang:(\S+)/m.exec(t) ?? [])[1] ?? '(没有 lang:)';
const optBak = readOr(optsNew + '.ieml-bak');
const settingsKept = langOf(readOr(optsNew)) === 'zh_cn';

console.log('\n===== 判据 =====');
console.log(`${oldAllC ? '✓' : '✗'} ① 旧发布版把实例定位到 %APPDATA%\\IEML\\instances（复现用户的报告，判据能红）`);
console.log(`${newAllD ? '✓' : '✗'} ② 新构建把同一批实例定位到 ${D_INST}（用户挑的游戏盘）`);
console.log(`${newAllDExist ? '✓' : '✗'} ③ 新构建给出的游戏目录**都存在**；旧版给出的缺失实例：${JSON.stringify(oldMissing)}`);
console.log(`${gameRootUntouched ? '✓' : '✗'} ④ 新构建这次启动没往游戏根目录写启动器文件（cache/logs 无新文件）`);
console.log(`${settingsKept ? '✓' : '✗'} ⑤ 实例设置跟着走：新家 options.txt 的 lang=${langOf(readOr(optsNew))}，备份那份 lang=${langOf(optBak)}`);
process.exit(oldAllC && newAllD && newAllDExist && gameRootUntouched && settingsKept ? 0 : 1);
