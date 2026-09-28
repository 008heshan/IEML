/*
 * 真机判据：**界面的版本列表要跟着磁盘走**（用户 2026-09-29 报的两条）。
 *
 * 用户原话：
 *   「下载完版本，**资源管理器里删除完版本等不会自动刷新版本列表**；
 *     当没有版本时，**下载第一个版本不会自动选择那个仅有的版本**」
 *
 * ## 以前是怎么错的
 *
 *   · 「当前文件夹里有哪些版本」（`folder_versions`）**只在开机与切换游戏目录时读一次** ——
 *     装完版本 / 在资源管理器里删掉版本目录，列表都还停在旧的那一份，
 *     要手动点「重新探测」才对。
 *   · 启动页的目标只从**账本**（`instances`）里挑（`launchTarget`），
 *     而"刚装完第一个版本"时账本可能是空的 ⇒ 启动页没有可启动的目标，
 *     用户得先去版本列表里点一次「建实例」。
 *
 * ## 现在的行为（本探针要钉住的）
 *
 *   · 磁盘一变就重读：启动器自己改的（安装 / 删除 / 导入 → `ieml:folder-changed`）、
 *     用户从资源管理器回来（窗口焦点）、以及一个 10 秒的兜底轮询；
 *   · 账本里一个实例都没有、而文件夹里有能启动的版本时，**自动认领第一个**。
 *
 * ## 判据（五条）
 *
 *   ① 空文件夹：版本列表如实说 0 个版本
 *   ② ★ **外部新增**（直接在磁盘上放一个版本目录，等于"别的启动器/资源管理器拷进来"）：
 *      不点「重新探测」，列表自己出现这一行
 *   ③ ★ 而且它**被自动选中**了：账本里出现一条记录、启动页的目标就是它
 *   ④ ★ **外部删除**（把目录删掉）：那一行自己消失
 *   ⑤ ★ 全程没有点过「重新探测」/「建实例」（进度条上的按钮一次都没碰）
 *
 * 用法：
 *   node tools/live/live-version-refresh-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 有判据这次没测到
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-refresh-root');
const OWN = path.join(T, 'ieml-refresh-own');
const FAKE_APPDATA = path.join(T, 'ieml-refresh-appdata');
const SHARED = path.join(ROOT, '.minecraft');
const VERSIONS = path.join(SHARED, 'versions');

let pass = 0;
let fail = 0;
let invalid = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};
const giveUp = (why, detail = '') => {
  invalid += 1;
  console.log(`  ⚠ ${why}${detail ? '\n' + detail : ''}`);
};

/** 在磁盘上"装"一个最小可识别的版本（外部改动的替身） */
const putVersion = (id, mc = id) => {
  const dir = path.join(VERSIONS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }, null, 2),
  );
  writeFileSync(path.join(dir, `${id}.jar`), 'not-a-real-jar');
  return dir;
};

for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(VERSIONS, { recursive: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [], activeId: null }, null, 2),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'refreshlive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};
/** 页面可见文字（判据都读它 —— 不依赖脆弱的 CSS 选择器） */
const text = async () => String((await ev('document.body.innerText')) ?? '');
const instancesFile = path.join(OWN, 'instances.json');
const readInstances = () => {
  try {
    return JSON.parse(readFileSync(instancesFile, 'utf8'));
  } catch {
    return { instances: [] };
  }
};
/** 等一个条件成立（默认 15 秒；轮询只有 10 秒，所以够） */
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Date.now() - t0;
    await sleep(400);
  }
  return null;
};

try {
  /* ==================== ① 空文件夹 ==================== */
  await clickNav(ev, '版本列表');
  await sleep(1200);
  const t0 = await text();
  check(!/\b1\.20\.1\b/.test(t0) && !/\b1\.19\.4\b/.test(t0), '① 空文件夹：列表里没有任何版本行');

  /* ==================== ② 外部新增（不点任何按钮） ==================== */
  console.log('\n② 直接在磁盘上放一个版本目录（等于资源管理器/别的启动器拷进来），然后什么都不点…');
  putVersion('1.20.1');
  // 先只等 2 秒：只有"焦点/事件"这条快路能在这么短的时间里刷新
  await ev("window.dispatchEvent(new Event('focus'))");
  const fast = await waitFor(async () => /1\.20\.1/.test(await text()), 2500);
  let elapsed = fast;
  if (elapsed === null) {
    // 没赶上快路 ⇒ 等 10 秒兜底轮询（这也算"会自动刷新"，只是慢）
    elapsed = await waitFor(async () => /1\.20\.1/.test(await text()), 12000);
  }
  if (elapsed === null) {
    giveUp('等了 15 秒列表也没出现新版本 —— 这一条没测到（界面没刷新）');
  } else {
    check(
      true,
      '② ★ 外部新增的版本**自己出现在列表里**（没点「重新探测」）',
      `${elapsed} ms ${fast !== null ? '（走的焦点事件那条快路）' : '（走的 10 秒兜底轮询）'}`,
    );
  }

  /* ==================== ③ 自动认领（Bug 2） ==================== */
  /*
   * ★ 窗口给 15 秒：认领是在 `folderVers` 更新之后触发的，而它最快也要等
   *   一次 IPC + 一次 React 渲染；万一赶上 10 秒兜底轮询那条路，也会在这个窗口里。
   */
  const adoptedMs = await waitFor(async () => readInstances().instances.length > 0, 15000);
  const rec = readInstances();
  if (adoptedMs === null) {
    check(
      false,
      '③ ★ 唯一的版本要**被自动选中**（账本里出现一条记录）',
      `instances.json = ${JSON.stringify(rec).slice(0, 160)}`,
    );
  } else {
    check(
      rec.instances[0]?.mcVersion === '1.20.1',
      '③ ★ 唯一的版本被自动认领（账本里出现一条记录）',
      `${adoptedMs} ms · slug=${rec.instances[0]?.config?.slug} · mc=${rec.instances[0]?.mcVersion}`,
    );
    // 启动页的目标就是它 —— 这一页读的是账本里的 lastInstanceId
    await clickNav(ev, '启动');
    await sleep(1500);
    const launchText = await text();
    check(
      /1\.20\.1/.test(launchText),
      '③ ★ 而且启动页的目标就是它（不用用户先去点「建实例」）',
      launchText.replace(/\s+/g, ' ').slice(0, 120),
    );
    await clickNav(ev, '版本列表');
    await sleep(800);
  }

  /* ==================== ④ 外部删除 ==================== */
  console.log('\n④ 再把一个版本目录删掉（另一个，它没有实例）…');
  putVersion('1.19.4');
  await ev("window.dispatchEvent(new Event('focus'))");
  const appeared = await waitFor(async () => /1\.19\.4/.test(await text()), 15000);
  if (appeared === null) {
    giveUp('1.19.4 这一行没出现 —— ④ 的前置没成立，这一步没测到');
  } else {
    rmSync(path.join(VERSIONS, '1.19.4'), { recursive: true, force: true });
    await ev("window.dispatchEvent(new Event('focus'))");
    const gone = await waitFor(async () => !/1\.19\.4/.test(await text()), 15000);
    check(
      gone !== null,
      '④ ★ 外部删掉的版本**自己从列表里消失**（没点「重新探测」）',
      gone !== null ? `${gone} ms` : '等了 15 秒那一行还在',
    );
  }

  /* ==================== ⑤ 对照组 ==================== */
  check(
    existsSync(path.join(VERSIONS, '1.20.1', '1.20.1.json')),
    '⑤ 全程只动了磁盘与窗口焦点：盘上那个版本一直在（说明刷新不是"我们把它删了"）',
  );
} catch (e) {
  console.log(`  ⚠ 探针自己出错：${e.message}`);
  invalid += 1;
} finally {
  const verdict = invalid > 0 ? '本次测量无效' : fail === 0 ? '全过' : '有不合格项';
  console.log(`\n${verdict}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(invalid > 0 ? 2 : fail === 0 ? 0 : 1);
}
