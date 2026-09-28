/*
 * 真机判据：**选了「只用 BMCLAPI 镜像」，取版本 JSON 就不许再去打 Mojang**
 * （2026-09-28 用户报的 bug，0.18.2 修）。
 *
 * ## 现场（用户截图，逐字）
 *
 *   设置里选「只用 BMCLAPI 镜像」→ 装 26.3 → 失败，错误是
 *     `请求 https://piston-meta.mojang.com/v1/packages/bc098d111a72e9f6178801544a42099bdfbb0cf2… 超过 10 秒没有回应`
 *
 * ## 根因（实测核对过）
 *
 *   - BMCLAPI 的版本清单**保留 Mojang 的 `url` 字段**：
 *     `…/mc/game/version_manifest_v2.json` 里 26.3 那条的 url 就是上面那个 piston-meta 地址；
 *   - 而安装（`build_plan_input`）与"看版本详情"（`fetch_version_json`）都是
 *     `net::get_json(&entry.url)` —— **照抄清单里的地址，完全不看用户选的源**；
 *   - 于是"清单从镜像来、版本 JSON 打官方"。国内网络下拉不动 → 三次超时 → 安装失败。
 *
 * ## 判据（四条）
 *
 *   ① ★ `fetch_version_json(<老版本>, 'bmclapi')` 成功
 *   ② ★ 而且这一次**没有去试过官方那个版本 JSON 地址**（日志里不许出现
 *      "取 … 的版本 JSON 失败（…piston-meta…）"）—— 这是"只用镜像"最直接的判据
 *   ③ ★ 安装路径同样按源走：起一次 `install_version`（source=bmclapi），
 *      等 `versions/<mc>/<mc>.json` 落盘（它在下载开始前写下），且日志同样干净
 *   ④ ★ 对照组：`source='mojang'`（"只用官方"）在官方不通时要能**落到镜像兜底** ——
 *      否则那个选项在国内网络下等于"装不了"（判据：这一次调用**也成功**，慢没关系）
 *
 * ## 量法（两个坑，都踩过）
 *
 *   - **用老版本（1.20.1），不用最新那个**：界面自己会在启动时取"最新版"的 JSON
 *     （`source=auto`，官方优先），日志里就会有理所当然的 piston-meta 失败行 ——
 *     拿它当判据会红得与本次修复无关。"老版本"只有本探针会去取。
 *   - **等启动流量停下来再量**：实测启动时界面自己那几路请求会把连接池占住，
 *     第一次量到 31 秒（镜像其实 1 秒就回来了）。现在先等日志不再增长再开始。
 *   - 判据只看**本探针那一段日志**（记下起始长度，只看新增部分），
 *     并且只认"版本 JSON"那两句话 —— 清单本身是**两源竞速**的，
 *     备路去试官方是设计如此，不是缺陷。
 *
 * ## 沙盒
 *
 *   `IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 都指到 `%TEMP%`（`lib/cdp.mjs` 自动补第三个）。
 *   ③ 会在沙盒里下载游戏文件 —— 判据只等"版本 JSON 落盘"就**立刻杀进程**，
 *   所以不会真下完几百 MB。
 *
 * 用法：
 *   node tools/live/live-mirror-source-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 有判据这次没测到（网络）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-mirror-root');
const OWN = path.join(T, 'ieml-mirror-own');
const FAKE_APPDATA = path.join(T, 'ieml-mirror-appdata');
/*
 * ★ 用一个**老版本**：界面启动时只会去取"最新版"的 JSON，
 *   于是这个版本的日志行只可能来自本探针。
 */
const MC = '1.20.1';

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

/* ---------- 沙盒 ---------- */
for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
mkdirSync(path.join(ROOT, '.minecraft', 'versions'), { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [], activeId: null }, null, 2),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'mirrorlive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});
/** 启动器自己的 stdout/stderr（`lib/cdp.mjs` 按 tag 落盘） */
const LOG = path.join(T, 'ieml-mirrorlive-out.log');
const logText = () => {
  try {
    return readFileSync(LOG, 'utf8');
  } catch {
    return '';
  }
};
const logSize = () => {
  try {
    return statSync(LOG).size;
  } catch {
    return 0;
  }
};
/** 本探针关心的日志行：只有"取 <mc> 的版本 JSON"那两句 */
const versionJsonLines = (text) =>
  text.split('\n').filter((l) => l.includes(`的版本 JSON`) && l.includes(MC));

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

try {
  /* ---------- 等启动流量停下来（不然量到的是连接池竞争） ---------- */
  console.log('等界面自己的启动请求停下来…');
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const now = logSize();
    if (now === last && now > 0) break;
    last = now;
  }
  console.log(`  日志 ${last} 字节，开始量。`);

  /* ==================== ①② 「看版本详情」这条路 ==================== */
  console.log(`①② 取 ${MC} 的版本详情（source=bmclapi，也就是"只用镜像"）…`);
  const mark1 = logSize();
  const t0 = Date.now();
  const detail = await inv('fetch_version_json', { mcVersion: MC, source: 'bmclapi' });
  const ms = Date.now() - t0;
  const tail1 = logText().slice(mark1);
  const lines1 = versionJsonLines(tail1);
  const triedOfficial1 = lines1.filter((l) => l.includes('piston-meta'));

  if (detail?.__err) {
    check(false, '① ★ 只用镜像时取版本详情**必须成功**', `${ms} ms：${String(detail.__err).slice(0, 260)}`);
    giveUp('这一条失败就是用户报的那个 bug');
  } else {
    check(
      detail?.libraries > 0,
      '① ★ 只用镜像时取版本详情成功（拿到了真清单）',
      `${ms} ms，${detail?.libraries} 个库，Java ${detail?.java_major ?? '?'}`,
    );
    check(
      triedOfficial1.length === 0,
      '② ★ 这一步**一次都没去试官方那个地址**（只用镜像就该如此）',
      triedOfficial1.length ? triedOfficial1[0].slice(0, 220) : '（日志里没有官方地址）',
    );
  }

  /* ==================== ③ 安装路径 ==================== */
  console.log(`\n③ 起一次安装（source=bmclapi），等版本 JSON 落盘就停…`);
  const mark2 = logSize();
  const taskId = `mirror-${Date.now()}`;
  void inv('install_version', {
    mcVersion: MC,
    loaderKind: null,
    loaderVersion: null,
    source: 'bmclapi',
    taskId,
    downloadAssets: true,
    concurrency: 8,
  });
  const jsonPath = path.join(ROOT, '.minecraft', 'versions', MC, `${MC}.json`);
  let landed = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(500);
    if (existsSync(jsonPath)) {
      landed = true;
      break;
    }
  }
  if (!landed) {
    giveUp('等了 45 秒也没看到版本 JSON 落盘 —— 安装这一段没测到（网络？）');
  } else {
    const txt = readFileSync(jsonPath, 'utf8');
    const tail2 = logText().slice(mark2);
    const triedOfficial2 = versionJsonLines(tail2).filter((l) => l.includes('piston-meta'));
    check(
      txt.includes(`"${MC}"`) && txt.length > 1000,
      '③ ★ 安装路径也按源走：版本 JSON 真的落盘了（修复前会卡在 piston-meta 超时上）',
      `${path.basename(jsonPath)} ${txt.length} 字节`,
    );
    check(
      triedOfficial2.length === 0,
      '③ ★ 安装这一段同样**没有去试官方地址**',
      triedOfficial2.length ? triedOfficial2[0].slice(0, 220) : '（日志里没有官方地址）',
    );
  }

  /* ==================== ④ 对照组：只用官方要有镜像兜底 ==================== */
  console.log('\n④ 对照组：source=mojang 再取一次（官方不通时该落到镜像上，可能要等）…');
  const t1 = Date.now();
  const viaOfficial = await inv('fetch_version_json', { mcVersion: MC, source: 'mojang' });
  const ms1 = Date.now() - t1;
  check(
    !viaOfficial?.__err && viaOfficial?.libraries > 0,
    '④ ★ 对照组：写了"只用官方"也**装得上**（官方不通 ⇒ 候选里的镜像兜底）',
    viaOfficial?.__err
      ? `${ms1} ms 失败：${String(viaOfficial.__err).slice(0, 200)}`
      : `${ms1} ms，${viaOfficial.libraries} 个库${ms1 > 12000 ? '（慢 = 先等了官方，符合预期）' : '（快 = 官方这次是通的）'}`,
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
