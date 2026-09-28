/*
 * 真机判据：**「先返回缓存、后台刷新、增量更新」真的生效**（ADR-008）。
 *
 * ## 为什么这条值得真机验
 *
 *   ADR 写这条的理由是：冷启动时等 Mojang 元数据返回，国内网络要 3–10 秒，
 *   与「≤500ms 可交互」冲突。而 0.17.0 之前的行为是：**TTL 一过就干等网络** ——
 *   也就是那条理由只在"30 分钟内"成立，过了就照旧等。
 *
 *   现在：过期但有缓存 ⇒ **立刻把旧的给界面**，同时后台拉一份新的；
 *   拉到了写盘 + 发 `meta-refreshed`，界面自己重新取一次。
 *
 * ## 判据（五条，前四条离线、第五条要联网）
 *
 *   ① ★ 缓存**过期**时，读清单**立刻**返回（量的是耗时，不是感觉）
 *   ② ★ 而且返回的是**那份旧缓存**的内容（不是空、也不是干等网络）
 *   ③ ★ 后台刷新把**新数据写进了磁盘缓存**（读文件看标记换了）
 *   ④ ★ 对照组：**没有缓存**时必须同步等网络（不许凭空返回一个空清单）
 *   ⑤ ★ 对照组：缓存**还新鲜**时不许发网络请求（TTL 之内就该直接用）
 *
 * ## 沙盒
 *
 *   `IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 全指到 `%TEMP%`
 *   （`lib/cdp.mjs` 现在会自动补第三个 —— 2026-09-28 的事故教训：
 *     不指走 `APPDATA` 时探针会读写**真实的** `datadir.txt`，把用户的数据根改掉）。
 *   版本清单的缓存文件按源命名（`version_manifest_bmclapi.json`），探针自己写一份
 *   带标记的**过期**缓存进去 —— "过期"靠把 mtime 改成两小时前。
 *
 * 用法：
 *   node tools/live/live-cache-fresh-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 有判据这次没测到（联网那两条）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-cache-root');
const OWN = path.join(T, 'ieml-cache-own');
const FAKE_APPDATA = path.join(T, 'ieml-cache-appdata');
/* ★ 缓存在**启动器自己的家**里（`<own>/cache`），不是游戏根目录 —— 第一版写错了地方，
   于是 ② 量到的是上一段刚下的真清单（含标记=false），③ 也没测到。 */
const CACHE = path.join(OWN, 'cache');

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
mkdirSync(CACHE, { recursive: true });
mkdirSync(path.join(ROOT, '.minecraft', 'versions', '1.12.2'), { recursive: true });
writeFileSync(
  path.join(ROOT, '.minecraft', 'versions', '1.12.2', '1.12.2.json'),
  JSON.stringify({ id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [], activeId: null }, null, 2),
);

/** 一份"旧"版本清单：只带一个一眼能认出来的假版本（标记） */
const STALE_MANIFEST = {
  latest: { release: '0.0.0-stale-probe', snapshot: '0.0.0-stale-probe' },
  versions: [
    { id: '0.0.0-stale-probe', type: 'release', url: 'https://example.invalid/stale.json', time: '2020-01-01T00:00:00Z', releaseTime: '2020-01-01T00:00:00Z' },
  ],
};
const MANIFEST_KEY = 'version_manifest_bmclapi.json';
const manifestPath = path.join(CACHE, MANIFEST_KEY);

/** 把缓存文件的时间改成 N 秒前（伪造"过期"） */
const ageFile = (p, seconds) => {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(p, t, t);
};

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'cachelive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

/** 读版本清单（走的正是界面用的那条命令） */
const readManifest = () => inv('fetch_version_manifest', { source: 'bmclapi' });

try {
  /* ==================== ④ 对照组：没有缓存 ==================== */
  console.log('④ 对照组：没有缓存时读清单（这一条要联网，会等）…');
  rmSync(manifestPath, { force: true });
  const t0 = Date.now();
  const cold = await readManifest();
  const coldMs = Date.now() - t0;
  const coldRows = Array.isArray(cold?.versions) ? cold.versions.length : 0;
  if (coldRows === 0) {
    giveUp(`没有缓存时也拿不到清单（网络不通？${coldMs} ms，${JSON.stringify(cold).slice(0, 160)}）`);
  } else {
    check(
      coldRows > 10 && existsSync(manifestPath),
      '④ ★ 对照组：没有缓存时**同步**取回真清单，并写下缓存（不许凭空返回空的）',
      `${coldRows} 个版本，${coldMs} ms`,
    );
  }

  /* ==================== ⑤ 对照组：缓存新鲜 ==================== */
  if (existsSync(manifestPath)) {
    const t1 = Date.now();
    const fresh = await readManifest();
    const freshMs = Date.now() - t1;
    check(
      (fresh?.versions?.length ?? 0) > 10 && freshMs < Math.max(200, coldMs / 2),
      '⑤ ★ 对照组：缓存还新鲜时直接用缓存（比冷取快得多，说明没等网络）',
      `${freshMs} ms vs 冷取 ${coldMs} ms`,
    );
  }

  /* ==================== ①②③ 过期缓存 ⇒ 先给旧的 + 后台刷新 ==================== */
  console.log('\n①②③ 把缓存改成两小时前（过期）再读一次…');
  writeFileSync(manifestPath, JSON.stringify(STALE_MANIFEST));
  ageFile(manifestPath, 2 * 60 * 60);

  const t2 = Date.now();
  const stale = await readManifest();
  const staleMs = Date.now() - t2;
  const gotStaleMarker = JSON.stringify(stale?.versions ?? []).includes('0.0.0-stale-probe');
  check(
    staleMs < 1500,
    '① ★ 缓存过期时读清单**立刻**返回（不再干等网络）',
    `${staleMs} ms`,
  );
  check(
    gotStaleMarker,
    '② ★ 而且给的是**那份旧缓存**（不是空、也不是等网络回来的新数据）',
    `返回 ${stale?.versions?.length ?? 0} 条，含标记=${gotStaleMarker}`,
  );

  /*
   * ③ 后台刷新：等缓存文件被换成真清单（标记消失）。
   *    这一步要联网；拉不到就如实说"没测到"，不算功能红。
   */
  let refreshed = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      const now = readFileSync(manifestPath, 'utf8');
      if (!now.includes('0.0.0-stale-probe') && now.length > 1000) {
        refreshed = true;
        break;
      }
    } catch {
      /* 文件正在被替换 */
    }
  }
  if (!refreshed) {
    giveUp('后台刷新这一步没测到（网络不通或太慢），判据 ③ 本次无效');
  } else {
    const size = statSync(manifestPath).size;
    check(refreshed, '③ ★ 后台把**新数据**写进了磁盘缓存（旧标记消失了）', `缓存 ${size} 字节`);
    const after = await readManifest();
    check(
      !JSON.stringify(after?.versions ?? []).includes('0.0.0-stale-probe') &&
        (after?.versions?.length ?? 0) > 10,
      '③ ★ 下一次读拿到的是**新清单**（增量更新闭环）',
      `${after?.versions?.length ?? 0} 个版本`,
    );
  }
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
