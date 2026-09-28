/*
 * 真机判据：**整合包有没有新版本，以及"原地升级"到底动了哪些文件**
 * （ADR-025 第 4 条 —— 0.15.0 里那句"作者没有提供新版清单"缺的另一半）。
 *
 * ## 为什么必须是真机
 *
 *   单测能钉住"版本号谁新"与"文件对齐计划"（`domain::pack_update`，13 条），
 *   但这一件的价值全在**盘上真的发生了什么**：
 *     · 作者删掉的那个 Mod，是留在 `mods/` 里把游戏搞崩，还是被收进了回收区？
 *     · 用户自己放进去的 Mod、存档，会不会被"升级"顺手清掉？
 *     · 记录里的包身份还在不在（丢了就再也查不了下一次更新）？
 *
 * ## 判据
 *
 *   A. 原地升级（**离线**，包体与文件都由探针自己起 HTTP 服务供）：
 *     ① 新版新增的文件真的下了
 *     ② 内容变了的文件被换成新版
 *     ③ ★ 作者删掉的文件**从 mods/ 消失**，并出现在回收区（字节一致 ⇒ 可恢复）
 *     ④ ★ 用户自己放的 Mod 与存档**一个字节都没动**
 *     ⑤ 记录换成新版本号，且**包身份还在**（project_id 没丢）
 *     ⑥ 返回的 update 计数与事实一致（新增 1 / 更新 1 / 移除 1 / 不动 1）
 *     ⑦ 总结里说得出回收区在哪
 *   B. 问平台有没有新版：
 *     ⑧ ★ 没有身份的实例（拖进来的包）⇒ 如实说"查不了"，**不是**"已是最新"
 *     ⑨ 真项目 + 一个很旧的版本号 ⇒ 判"有新版"（联网）
 *     ⑩ 真项目 + 就是最新那版 ⇒ 判"已是最新"（对照组，联网）
 *     ⑪ 没有身份时点"升级" ⇒ 明确报错（不许静默什么都不做）
 *
 * ## 沙盒
 *
 *   `IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 三个都指到 `%TEMP%`。
 *   ★ `APPDATA` 必须指走：启动时的数据根补齐会把**真实**的 `%APPDATA%\IEML`
 *     复制进来（0.15.0 在这一条上踩过两次）。
 *   原版 1.12.2 由探针**自己摆**（一份最小版本描述 + 一个假 jar）——
 *   安装路径那一步于是无事可做，整个判据不依赖任何游戏文件下载。
 *
 * 用法：
 *   node tools/live/live-pack-update-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 有判据这次没测到（联网那几条）
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-upd-root');
const OWN = path.join(T, 'ieml-upd-own');
const FAKE_APPDATA = path.join(T, 'ieml-upd-appdata');
const SLUG = 'upd-probe';
const MC = '1.12.2';

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

/** 造一个 stored（不压缩）的 zip —— 与别的探针同一套 */
function makeZip(entries) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nb = enc(name);
    const data = Buffer.isBuffer(content) ? content : enc(content ?? 'x');
    let c = ~0;
    for (const b of data) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = ~c >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nb.length, 26);
    parts.push(local, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nb]));
    offset += local.length + nb.length + data.length;
  }
  const cdb = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdb.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdb, eocd]);
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const readBytes = (p) => (existsSync(p) ? readFileSync(p) : null);
const same = (a, b) => a !== null && b !== null && a.equals(b);

/* ---------- 沙盒 ---------- */
for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
const SHARED = path.join(ROOT, '.minecraft');
const GAME = path.join(ROOT, 'instances', SLUG, 'game');
mkdirSync(path.join(GAME, 'mods'), { recursive: true });

/* 最小原版版本描述 + 假 jar：安装路径那一步于是无事可做（不碰网络） */
const VER = path.join(SHARED, 'versions', MC);
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, `${MC}.json`),
  JSON.stringify({ id: MC, mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);
writeFileSync(path.join(VER, `${MC}.jar`), Buffer.from('FAKE-VANILLA-JAR'));

writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-upd',
          mcVersion: MC,
          loader: null,
          addons: [],
          config: {
            name: '升级探针',
            slug: SLUG,
            isolation: 'on',
            memoryMb: 2048,
            memorySource: 'global',
            javaMode: 'auto',
          },
          createdAt: null,
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      activeId: 'i-upd',
    },
    null,
    2,
  ),
);

/* ---------- 本地 HTTP 服务：整合包里的文件从这里下 ---------- */
const BODIES = {
  'keep.jar': 'KEEP-BYTES',
  'shared-v1.jar': 'OLD-ONE',
  'shared-v2.jar': 'OLD-TWO-AND-LONGER',
  'new.jar': 'BRAND-NEW',
  'dropped.jar': 'GONE-IN-V2',
};
let port = 0;
const served = [];
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
  const body = BODIES[name];
  if (!body) {
    res.writeHead(404).end('no');
    return;
  }
  served.push(name);
  res.writeHead(200, { 'content-type': 'application/java-archive' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;
const url = (n) => `http://127.0.0.1:${port}/${n}`;

/* ---------- 两个版本的整合包（都是本地文件） ---------- */
const packFile = (v, files) => {
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: v,
    name: '升级探针包',
    summary: '判据用：v1 → v2 会新增 1 个、改 1 个、删 1 个',
    files,
    dependencies: { minecraft: MC },
  };
  const p = path.join(T, `ieml-upd-pack-${v}.mrpack`);
  writeFileSync(p, makeZip([['modrinth.index.json', JSON.stringify(index, null, 2)]]));
  return p;
};
const entry = (rel, bodyName) => ({
  path: rel,
  hashes: { sha1: sha1(BODIES[bodyName]) },
  downloads: [url(bodyName)],
  fileSize: BODIES[bodyName].length,
});
const PACK_V1 = packFile('1.0.0', [
  entry('mods/keep.jar', 'keep.jar'),
  entry('mods/shared.jar', 'shared-v1.jar'),
  entry('mods/dropped.jar', 'dropped.jar'),
]);
const PACK_V2 = packFile('2.0.0', [
  entry('mods/keep.jar', 'keep.jar'),
  entry('mods/shared.jar', 'shared-v2.jar'),
  entry('mods/new.jar', 'new.jar'),
]);

/* ---------- 起启动器 ---------- */
const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'updlive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};
const recordPath = path.join(ROOT, 'instances', SLUG, 'pack-record.json');
const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'));

try {
  /* ==================== A. 先装 v1 ==================== */
  console.log('装 v1（本地包 + 本地 HTTP 源，6 个文件都自己供）…');
  const r1 = await inv('pack_install_local', {
    path: PACK_V1,
    name: '升级探针包',
    slug: SLUG,
    taskId: `upd1-${Date.now()}`,
    instanceName: '升级探针',
    source: 'bmclapi',
    packVersion: '1.0.0',
    projectId: 'probe-pack',
    versionId: 'v1',
    concurrency: 2,
  });
  if (r1?.__err) {
    giveUp('v1 装不上，本次测量无效：', String(r1.__err).slice(0, 400));
    throw new Error('__invalid__');
  }
  const v1ok = same(readBytes(path.join(GAME, 'mods', 'shared.jar')), Buffer.from(BODIES['shared-v1.jar']));
  check(v1ok, '① 前置：v1 装好了（mods/shared.jar 是 v1 的内容）', `供出 ${served.length} 个文件`);

  /* ---------- 用户自己的东西（升级**绝对不许碰**） ---------- */
  mkdirSync(path.join(GAME, 'saves', 'world'), { recursive: true });
  const USER_MOD = '用户自己放的.jar';
  const userModBytes = Buffer.from('MY-OWN-MOD');
  const saveBytes = Buffer.from('MY-WORLD');
  writeFileSync(path.join(GAME, 'mods', USER_MOD), userModBytes);
  writeFileSync(path.join(GAME, 'saves', 'world', 'level.dat'), saveBytes);

  const before = {
    keep: readBytes(path.join(GAME, 'mods', 'keep.jar')),
    user: readBytes(path.join(GAME, 'mods', USER_MOD)),
    save: readBytes(path.join(GAME, 'saves', 'world', 'level.dat')),
  };

  /* ==================== 装 v2（同一个 slug ⇒ 这是一次升级） ==================== */
  console.log('装 v2（同一个实例 ⇒ 升级）…');
  const r2 = await inv('pack_install_local', {
    path: PACK_V2,
    name: '升级探针包',
    slug: SLUG,
    taskId: `upd2-${Date.now()}`,
    instanceName: '升级探针',
    source: 'bmclapi',
    packVersion: '2.0.0',
    projectId: 'probe-pack',
    versionId: 'v2',
    concurrency: 2,
  });
  if (r2?.__err) {
    giveUp('v2 装不上，本次测量无效：', String(r2.__err).slice(0, 400));
    throw new Error('__invalid__');
  }

  check(
    same(readBytes(path.join(GAME, 'mods', 'new.jar')), Buffer.from(BODIES['new.jar'])),
    '① 新版新增的文件真的下了（mods/new.jar）',
  );
  check(
    same(readBytes(path.join(GAME, 'mods', 'shared.jar')), Buffer.from(BODIES['shared-v2.jar'])),
    '② 内容变了的文件被换成新版（mods/shared.jar）',
  );
  check(
    same(readBytes(path.join(GAME, 'mods', 'keep.jar')), before.keep),
    '② 没变的文件不动（mods/keep.jar 字节一致）',
  );

  /* ---------- ③ 作者删掉的文件：从 mods/ 消失 + 进回收区 ---------- */
  const droppedGone = !existsSync(path.join(GAME, 'mods', 'dropped.jar'));
  const trashRoot = path.join(ROOT, 'instances', SLUG, 'pack-removed');
  let trashed = null;
  if (existsSync(trashRoot)) {
    for (const stamp of readdirSync(trashRoot)) {
      const cand = path.join(trashRoot, stamp, 'mods', 'dropped.jar');
      if (existsSync(cand)) trashed = cand;
    }
  }
  check(droppedGone, '③ ★ 作者删掉的文件从 mods/ 里消失了（否则它会留着把游戏搞崩）');
  check(
    trashed !== null && same(readBytes(trashed), Buffer.from(BODIES['dropped.jar'])),
    '③ ★ 但它进了回收区、字节一致（可恢复 —— ADR-014 的后悔药）',
    trashed ?? trashRoot,
  );

  /* ---------- ④ 用户自己的东西没被动 ---------- */
  check(
    same(readBytes(path.join(GAME, 'mods', USER_MOD)), before.user),
    '④ ★ 用户自己放的 Mod 没被动（它不在记录里 ⇒ 永远不该被清）',
  );
  check(
    same(readBytes(path.join(GAME, 'saves', 'world', 'level.dat')), before.save),
    '④ ★ 存档一个字节都没动',
  );

  /* ---------- ⑤ 记录 ---------- */
  const rec = readRecord();
  const paths = rec.files.map((f) => f.path).sort();
  check(
    rec.version === '2.0.0',
    '⑤ 记录换成了新版本号',
    `version=${rec.version}`,
  );
  check(
    JSON.stringify(paths) ===
      JSON.stringify(['mods/keep.jar', 'mods/new.jar', 'mods/shared.jar']),
    '⑤ 记录里的文件清单 = 新清单（旧文件不再挂在记录上）',
    paths.join('、'),
  );
  check(
    rec.project_id === 'probe-pack' && rec.version_id === 'v2',
    '⑤ ★ 包身份还在（丢了就再也查不了下一次更新）',
    `${rec.project_id} / ${rec.version_id}`,
  );

  /* ---------- ⑥⑦ 升级汇报 ---------- */
  const up = r2.update;
  check(
    up && up.add === 1 && up.replace === 1 && up.remove === 1 && up.keep === 1,
    '⑥ update 计数与事实一致（新增 1 / 更新 1 / 移除 1 / 不动 1）',
    JSON.stringify(up ?? null),
  );
  check(
    Boolean(up?.trash_dir) && String(up?.summary ?? '').includes(String(up.trash_dir)),
    '⑦ 总结里说得出被移除的文件放在哪（而且写的就是那个真实路径）',
    String(up?.summary ?? '').slice(0, 220),
  );
  check(
    (up?.removed_failed ?? []).length === 0,
    '⑦ 没有"移不动"的（不为 0 说明清单与盘对不上）',
    JSON.stringify(up?.removed_failed ?? []),
  );

  /* ==================== B. 问平台有没有新版 ==================== */
  console.log('\nB 段：问平台（这几条要联网）…');

  /* ⑧ 没有身份的实例：另一份**手写**记录（模拟拖进来的包） */
  const PLAIN = 'upd-plain';
  mkdirSync(path.join(ROOT, 'instances', PLAIN), { recursive: true });
  writeFileSync(
    path.join(ROOT, 'instances', PLAIN, 'pack-record.json'),
    JSON.stringify({
      schema: 1,
      name: '拖进来的包',
      version: '1.0.0',
      source: 'local',
      mc_version: MC,
      installed_at: 0,
      skipped: [],
      files: [],
    }),
  );
  const plain = await inv('pack_check_update', { slug: PLAIN });
  check(
    plain?.state === 'unknown' && String(plain?.summary ?? '').includes('来源信息'),
    '⑧ ★ 没有身份的实例 ⇒ 如实说"查不了"，**不是**"已是最新"',
    String(plain?.summary ?? JSON.stringify(plain)).slice(0, 200),
  );
  const plainApply = await inv('pack_apply_update', {
    slug: PLAIN,
    versionId: 'whatever',
    taskId: `upd-plain-${Date.now()}`,
  });
  check(
    Boolean(plainApply?.__err) && String(plainApply.__err).includes('升级'),
    '⑪ 没有身份时点"升级" ⇒ 明确报错（不静默什么都不做）',
    String(plainApply?.__err ?? JSON.stringify(plainApply)).slice(0, 160),
  );

  /* ⑨⑩ 真项目：拿它的版本清单来构造"旧版本 / 就是最新"两种情形 */
  const PROJECT = 'fabulously-optimized';
  let list = null;
  try {
    const r = await fetch(`https://api.modrinth.com/v2/project/${PROJECT}/version`, {
      headers: { 'User-Agent': 'IEML-probe/1.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    list = await r.json();
  } catch (e) {
    giveUp(`拉不到 ${PROJECT} 的版本清单（网络），B 段后两条没测到：${e.message}`);
  }
  if (Array.isArray(list) && list.length > 0) {
    const newest = list[0];
    const newestMc = newest.game_versions?.[0] ?? MC;
    const writeProbe = (slug, version) => {
      mkdirSync(path.join(ROOT, 'instances', slug), { recursive: true });
      writeFileSync(
        path.join(ROOT, 'instances', slug, 'pack-record.json'),
        JSON.stringify({
          schema: 1,
          name: 'Fabulously Optimized',
          version,
          source: 'modrinth',
          mc_version: newestMc,
          installed_at: 0,
          skipped: [],
          project_id: PROJECT,
          version_id: 'old',
          files: [],
        }),
      );
    };

    writeProbe('upd-old', '0.0.1');
    const old = await inv('pack_check_update', { slug: 'upd-old' });
    check(
      old?.state === 'newer' && Boolean(old?.version_id) && Boolean(old?.url),
      '⑨ 真项目 + 一个很旧的版本号 ⇒ 判"有新版"，并给得出可下载的版本',
      `state=${old?.state} version=${old?.version} ${String(old?.summary ?? '').slice(0, 120)}`,
    );

    writeProbe('upd-new', newest.version_number);
    const fresh = await inv('pack_check_update', { slug: 'upd-new' });
    check(
      fresh?.state === 'up-to-date',
      '⑩ ★ 对照组：就是最新那版 ⇒ 判"已是最新"（这条判据不会永远说"有新版"）',
      `state=${fresh?.state} ${String(fresh?.summary ?? '').slice(0, 120)}`,
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
    server.close();
  } catch {}
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(invalid > 0 ? 2 : fail === 0 ? 0 : 1);
}
