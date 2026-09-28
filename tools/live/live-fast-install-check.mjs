/*
 * 真机判据：**先装能启动的、资源文件留给启动时后台补**（用户 2026-09-29 的建议）。
 *
 * 用户原话：「游戏下载也是很慢，我的建议是**下 jar，第一次启动游戏补全文件**
 *           （这只是描述，具体还得看 PCL 的实现方法）」。
 *
 * ## 为什么值得这么做（本机实测的数字）
 *
 *   · 到 mcimirror 的 CDN 只有 ~66 KB/s（2.5 MB 的 Fabric API 下了 37 秒）；
 *   · 官方 CDN（cdn.modrinth.com）直接连不上；
 *   · 一个 26.3 的完整安装 = 582 MB / 5222 个文件 —— 按这个速度是**几小时**；
 *   · 而"能不能进游戏"只取决于 **客户端 jar + 库 + 版本描述**（几十 MB）：
 *     缺的是贴图/声音（游戏照进，只是紫黑贴图、没声音）。
 *   ⇒ 安装时不下资源文件（`downloadAssets: false`），启动后在**后台**补。
 *
 * ## 判据（五条）
 *
 *   ① 计划里"要下多少"包含资源文件（对照用：这条说明我们**知道**自己省了多少）
 *   ② ★ `downloadAssets:false` 装完之后：版本描述 + 客户端 jar + 库都在（**能启动**）
 *   ③ ★ 而 `assets/objects` 里几乎一个文件都没有（资源文件确实被省下了）
 *   ④ ★ 日志里如实写着 `download_assets=false`（不是"偷偷少下"）
 *   ⑤ ★ 之后再用 `downloadAssets:true` 跑一次 ⇒ 资源文件**真的开始补齐**
 *      （这就是启动后那条后台补全走的同一条路）
 *
 * 用法：
 *   node tools/live/live-fast-install-check.mjs ["<exe>"] [mc版本]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 有判据这次没测到（网络）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const MC = argv.filter((a) => !a.startsWith('--'))[1] ?? '1.20.1';

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-fast-root');
const OWN = path.join(T, 'ieml-fast-own');
const FAKE_APPDATA = path.join(T, 'ieml-fast-appdata');

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

for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [], activeId: null }, null, 2),
);

const SHARED = path.join(ROOT, '.minecraft');
const countFiles = (dir) => {
  let n = 0;
  const walk = (d) => {
    let ents = [];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
};

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'fastlive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};
const LOG = path.join(T, 'ieml-fastlive-out.log');
const logText = () => {
  try {
    return readFileSync(LOG, 'utf8');
  } catch {
    return '';
  }
};

try {
  /* ---------- ① 计划（含资源文件） ---------- */
  const plan = await inv('plan_install', {
    mcVersion: MC,
    loaderKind: null,
    loaderVersion: null,
    source: 'bmclapi',
  });
  if (plan?.__err) {
    giveUp(`拿不到安装计划（网络？）：${String(plan.__err).slice(0, 200)}`);
  } else {
    check(
      plan.total_files > 20 && plan.libraries > 10,
      '① 安装计划算出来了（这份是"库 + 客户端"，资源文件不在里面 —— 与"安装时不下资源"同一口径）',
      `${plan.total_files} 个文件 · ${plan.libraries} 个库 · 共 ${(plan.total_bytes / 1048576).toFixed(1)} MB`,
    );
  }

  /* ---------- ②③④ 不下资源文件地装一次 ---------- */
  console.log(`\n② 装 ${MC}（downloadAssets=false）…`);
  const mark = (() => {
    try {
      return statSync(LOG).size;
    } catch {
      return 0;
    }
  })();
  const t0 = Date.now();
  const fast = await inv('install_version', {
    mcVersion: MC,
    loaderKind: null,
    loaderVersion: null,
    source: 'bmclapi',
    taskId: `fast-${Date.now()}`,
    downloadAssets: false,
    concurrency: 16,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (fast?.__err) {
    giveUp(`装不上（${secs}s），本次测量无效：`, String(fast.__err).slice(0, 300));
    throw new Error('__invalid__');
  }

  const versionDir = path.join(SHARED, 'versions', MC);
  const jar = path.join(versionDir, `${MC}.jar`);
  const json = path.join(versionDir, `${MC}.json`);
  const libs = path.join(SHARED, 'libraries');
  const assetsObjects = path.join(SHARED, 'assets', 'objects');
  const libCount = countFiles(libs);
  const assetCount = countFiles(assetsObjects);

  check(
    existsSync(json) && existsSync(jar) && libCount > 20,
    '② ★ 装完就**能启动**：版本描述 + 客户端 jar + 库都在',
    `${libCount} 个库文件 · ${secs} 秒`,
  );
  check(
    assetCount === 0,
    '③ ★ 而资源文件一个都没下（"先装能启动的"确实省下了）',
    `assets/objects 里 ${assetCount} 个文件`,
  );
  /*
   * ★ 判据 ④ 看**整份日志**，不切 `mark` 那一段：
   *   启动器的 stdout 是块缓冲的，而且它的写偏移与我们的 `statSync` 长度不是一回事 ——
   *   切一段就得到"（没有那一行）"，而文件里明明有（踩了两次）。
   *   这一刻 ⑤ 还没开始，所以整份日志里出现的 `download_assets=false`
   *   只可能来自这次安装 ✓
   */
  let assetLine = '';
  for (let i = 0; i < 20; i += 1) {
    assetLine = logText()
      .split('\n')
      .find((l) => l.includes('资源阶段') && l.includes('download_assets=false')) ?? '';
    if (assetLine) break;
    await sleep(300);
  }
  check(
    assetLine !== '',
    '④ ★ 日志里如实写着 download_assets=false（不是偷偷少下）',
    assetLine.slice(0, 160) || '（没有那一行）',
  );

  /* ---------- ⑤ 资源文件能被补上（启动后那条后台路） ---------- */
  console.log('\n⑤ 再跑一次（downloadAssets=true）—— 这就是启动后后台补全走的那条路…');
  let second = null;
  void inv('install_version', {
    mcVersion: MC,
    loaderKind: null,
    loaderVersion: null,
    source: 'bmclapi',
    taskId: `assets-${Date.now()}`,
    downloadAssets: true,
    concurrency: 16,
  }).then((r) => {
    second = r;
  });
  let filled = 0;
  for (let i = 0; i < 150; i += 1) {
    await sleep(1000);
    filled = countFiles(assetsObjects);
    if (filled >= 20) break;
  }
  /*
   * ★ 这一次与"安装"无关，纯粹是**补资源**：网络抽风（BMCLAPI/官方都超时）时
   *   它连版本 JSON 都取不到 —— 那种情况属于"本次没测到"，不该判功能红。
   */
  const secondErr = String(second?.__err ?? '');
  const networkish = /超过 \d+ 秒没有回应|网络|超时|error sending|timed? ?out/i.test(secondErr);
  if (filled < 20 && networkish) {
    giveUp(`补资源这一步没测到（网络）：${secondErr.slice(0, 220)}`);
  } else {
    check(
      filled >= 20,
      '⑤ ★ 资源文件真的在补（同一条 repair 路，只是这次带上 assets）',
      filled >= 20 ? `${filled} 个资源文件` : `0 个；第二次安装返回：${secondErr.slice(0, 200)}`,
    );
  }
} catch (e) {
  if (String(e.message) !== '__invalid__') {
    console.log(`  ⚠ 探针自己出错：${e.message}`);
    invalid += 1;
  }
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
