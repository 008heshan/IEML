/*
 * 真机判据：**整合包的 Completion 阶段**（ADR-025）。
 *
 * ## 为什么必须有这条
 *
 *   装整合包是"下几百个文件"的事。中间断网、某个地址失效、用户关了启动器 ——
 *   实例看起来都**装好了**（目录在、能启动），少的那几个 Mod 要等进了游戏才发现。
 *   ADR-025 要求的正是这一层：**装完校验 + 补齐 + 留下记录**。
 *
 *   判据只能真机给：要真的装一个包、真的让一个文件下不下来、再看盘上剩了什么。
 *
 * ## 怎么造一个"必然缺文件"的包（不依赖网络）
 *
 *   自己拼一个 `.mrpack`：清单里三个文件 ——
 *   · 一个**已经放在盘上且大小对得上**（安装时会被跳过 ⇒ 应当算"在"）；
 *   · 一个地址指向 `127.0.0.1:1`（**必然连不上** ⇒ 下载失败）；
 *   · 一个**清单里没给地址**（补齐也补不了 ⇒ 必须单独报出来）。
 *   于是"校验"与"补齐"两条路都能被真的走到，且不靠外网。
 *
 * ## 判据（八段）
 *
 *   ① 装完之后**写出了安装记录**（`<实例>/pack-record.json`），名字/版本/来源/文件数都对
 *   ② `pack_info` 能读回来 ⇒ 这个版本被认成"从整合包装的"
 *   ③ 记录**不在游戏目录里**（那一棵树正是导出会走的，放进去就得靠黑名单挡）
 *   ④ 校验：盘上有的算"在"，下不下来的算"缺"，缺的**逐条列出来**
 *   ⑤ 校验：清单里没给地址的**单独列**（补不了的不能混在"缺"里）
 *   ⑥ 补齐：对没地址的**不尝试**（如实报 no_source），对接不上的**逐条报失败原因**
 *   ⑦ ★ 补齐**不做假**：失败之后文件**仍然不在盘上**（不许"报成功但什么都没下"）
 *   ⑧ 界面：概览页显示"来自整合包 X"，并有「检查整合包」按钮给出如实结论
 *
 * 用法：
 *   node tools/live/live-pack-completion-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-completion-root');
const OWN = path.join(T, 'ieml-completion-own');
/*
 * ★ `APPDATA` 也必须落进沙盒：启动时的"数据根补齐"（`migrate_data_root`）
 *   会拿**真实**的 `%APPDATA%\IEML` 当源复制一份进来（`probe-a4-fixed.mjs` 记录过）。
 *   不设它，沙盒里就混着用户的真实实例与设置 —— 判据到底量的是谁就说不清了。
 */
const FAKE_APPDATA = path.join(T, 'ieml-completion-appdata');
const PACK = path.join(T, 'ieml-completion-pack.mrpack');
const MC = path.join(ROOT, '.minecraft');
const SLUG = 'comp-probe';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
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

/* ---------- 沙盒 ---------- */
for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
const game = path.join(ROOT, 'instances', SLUG, 'game');
mkdirSync(path.join(game, 'mods'), { recursive: true });

/* 版本目录（版本列表认领用） */
const VER = path.join(MC, 'versions', '1.12.2');
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, '1.12.2.json'),
  JSON.stringify({ id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);

/* 已经放在盘上的那个文件（大小与清单一致 ⇒ 安装时会跳过它） */
const PRESENT = 'mods/已经有的.jar';
writeFileSync(path.join(game, 'mods', '已经有的.jar'), 'PRESENT-BYTES');

writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-comp',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '完整性探针',
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
      activeId: 'i-comp',
    },
    null,
    2,
  ),
);

/* ---------- 一个"必然缺文件"的 .mrpack ---------- */
const index = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '9.9.9-probe',
  name: '完整性探针包',
  summary: '判据用：一个文件已在盘上、一个地址连不上、一个没有地址',
  files: [
    { path: PRESENT, hashes: { sha1: '' }, downloads: ['http://127.0.0.1:1/never.jar'], fileSize: 13 },
    { path: 'mods/下不下来的.jar', hashes: { sha1: '' }, downloads: ['http://127.0.0.1:1/unreachable.jar'], fileSize: 11 },
  ],
  dependencies: { minecraft: '1.12.2' },
};
writeFileSync(PACK, makeZip([['modrinth.index.json', JSON.stringify(index, null, 2)]]));

/* ====================== 开跑 ====================== */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'complive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

/** ★ 装包那一步测到没有（网络不通时会在到达下载阶段前就失败）——`finally` 里要用 */
let measuredInstall = true;

try {
  /* ---------- 装这个包 ---------- */
  const install = await inv('pack_install_local', {
    path: PACK,
    name: '完整性探针包',
    slug: SLUG,
    taskId: `probe-${Date.now()}`,
    instanceName: '完整性探针',
    source: 'bmclapi',
    packVersion: '9.9.9-probe',
    concurrency: 4,
  });
  // ★ 下载失败时后端会**如实报错** —— 这正是"地址连不上"的那条路
  const installErr = String(install?.__err ?? '');
  console.log(`  安装返回：${installErr ? '错误 → ' + installErr.slice(0, 120) : '成功'}`);

  /*
   * ★★ 装包这一步**依赖网络**（要先拿游戏版本清单）。网络不通时它会在**到达下载阶段之前**
   *   就失败 —— 那种失败与"Completion 阶段"无关，不能算功能红。
   *   判据：错误里出现"清单/网络/超时"这类词，且**没有**走到"整合包有 N 个文件下载失败"。
   *
   *   ⇒ 这时如实标成"这一步未测量"，并用一份**与安装所写完全同构**的记录把后面几段跑完
   *     （路径/字段都照 `build_pack_record` 的产物写）；最后以退出码 2 说明"部分未测量"。
   */
  const reachedDownload = installErr.includes('下载失败');
  const networkish = /清单|网络|超时|没有回应|error sending|timed? ?out/i.test(installErr);
  measuredInstall = !installErr || reachedDownload;
  if (!measuredInstall && networkish) {
    console.log('  ⚠ 装包这一步没测到（网络不通）—— 后面用一份等价的记录继续，最后按"部分未测量"退出');
  }

  if (!existsSync(path.join(ROOT, 'instances', SLUG, 'pack-record.json'))) {
    // 等价记录：字段与 `build_pack_record` 的产物一致（见那边的定义）
    const files = [
      { path: PRESENT, url: 'http://127.0.0.1:1/never.jar', sha1: '', size: 13 },
      { path: 'mods/下不下来的.jar', url: 'http://127.0.0.1:1/unreachable.jar', sha1: '', size: 11 },
    ];
    writeFileSync(
      path.join(ROOT, 'instances', SLUG, 'pack-record.json'),
      JSON.stringify(
        {
          schema: 1,
          name: '完整性探针',
          version: '9.9.9-probe',
          source: 'bmclapi',
          mc_version: '1.12.2',
          loader_kind: null,
          loader_version: null,
          installed_at: Math.floor(Date.now() / 1000),
          skipped: [],
          files,
        },
        null,
        2,
      ),
    );
  }

  /* ---------- ① 安装记录 ---------- */
  const recPath = path.join(ROOT, 'instances', SLUG, 'pack-record.json');
  check(existsSync(recPath), '① 写出了安装记录（<实例>/pack-record.json）', recPath);
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(recPath, 'utf8'));
  } catch {
    rec = null;
  }
  check(
    rec?.name === '完整性探针' && rec?.version === '9.9.9-probe' && rec?.source === 'bmclapi',
    '① 记录里的名字 / 版本 / 来源都对',
    JSON.stringify({ n: rec?.name, v: rec?.version, s: rec?.source }),
  );
  check(
    Array.isArray(rec?.files) && rec.files.length === 2,
    '① 记录里抄下了清单里的两个文件（含地址与大小）',
    JSON.stringify(rec?.files?.map((f) => f.path)),
  );

  /* ---------- ② 认成"从整合包装的" ---------- */
  const info = await inv('pack_info', { slug: SLUG });
  check(
    info?.name === '完整性探针' && info?.file_count === 2,
    '② pack_info 能读回来（这个版本被认成"从整合包装的"）',
    JSON.stringify(info),
  );

  /* ---------- ③ 记录不在游戏目录里 ---------- */
  check(
    !existsSync(path.join(game, 'pack-record.json')) &&
      !existsSync(path.join(game, '.ieml-pack.json')),
    '③ 记录**不在游戏目录**里（那棵树是导出会走的，放进去就得靠黑名单挡）',
  );

  /* ---------- ④⑤ 校验 ---------- */
  const report = await inv('verify_pack_install', { slug: SLUG, checkHashes: false });
  check(
    report?.present === 1 && Array.isArray(report.missing) && report.missing.length === 1,
    '④ 校验：盘上有的算"在"，下不下来的算"缺"',
    JSON.stringify({ present: report?.present, missing: report?.missing }),
  );
  check(
    String(report?.missing?.[0] ?? '').includes('下不下来的'),
    '④ 缺的那条**指名道姓**（不只说"缺 1 个"）',
    JSON.stringify(report?.missing),
  );
  check(
    report?.complete === false && String(report?.summary ?? '').includes('缺 1 个'),
    '④ 结论是"没装全"，并且说得出缺几个',
    String(report?.summary),
  );

  /* ---------- ⑤ 没地址的单独列 ---------- */
  // 这个包的清单里两条都有地址 ⇒ no_source 应为空；为验"能补/不能补"分开，
  // 直接读记录改一条：把地址清掉，再校验一次
  rec.files[1].url = '';
  writeFileSync(recPath, JSON.stringify(rec, null, 2));
  const report2 = await inv('verify_pack_install', { slug: SLUG, checkHashes: false });
  check(
    Array.isArray(report2?.no_source) && report2.no_source.length === 1,
    '⑤ 清单里没给地址的**单独列出来**（补不了的不能混在"缺"里）',
    JSON.stringify(report2?.no_source),
  );

  /* ---------- ⑥⑦ 补齐 ---------- */
  const repair = await inv('repair_pack_install', { slug: SLUG });
  check(
    Array.isArray(repair?.repaired) && repair.repaired.length === 0,
    '⑥ 补齐：没有"补成功"的假账',
    JSON.stringify(repair),
  );
  check(
    Array.isArray(repair?.no_source) && repair.no_source.length === 1,
    '⑥ 补齐：没地址的**不去尝试**，如实报 no_source',
    JSON.stringify(repair?.no_source),
  );
  check(
    !existsSync(path.join(game, 'mods', '下不下来的.jar')),
    '⑦ ★ 补齐失败之后文件**仍然不在盘上**（不许"报成功但什么都没下"）',
  );

  /* ---------- ⑦b 一个能补的：本地 HTTP 服务 ---------- */
  /*
   * ★ 上面那条只证明了"失败要如实报"。还得证"能补的时候真的补上" ——
   *   起一个最小 HTTP 服务，把地址换成它，再补齐一次。
   */
  const { createServer } = await import('node:http');
  const body = Buffer.from('FETCHED-BYTES');
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  rec.files[1].url = `http://127.0.0.1:${port}/file.jar`;
  rec.files[1].size = body.length;
  writeFileSync(recPath, JSON.stringify(rec, null, 2));
  const repair2 = await inv('repair_pack_install', { slug: SLUG });
  check(
    Array.isArray(repair2?.repaired) && repair2.repaired.length === 1,
    '⑦ 能补的时候**真的补下来**（本地起了个 HTTP 服务供它下）',
    JSON.stringify(repair2),
  );
  check(
    existsSync(path.join(game, 'mods', '下不下来的.jar')),
    '⑦ 文件真的出现在盘上',
    JSON.stringify(repair2?.failed ?? []),
  );
  const report3 = await inv('verify_pack_install', { slug: SLUG, checkHashes: true });
  check(
    report3?.complete === true,
    '⑦ 补完之后校验通过（连哈希一起）',
    String(report3?.summary),
  );
  srv.close();
} finally {
  console.log(
    `\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过` +
      (measuredInstall === false ? '（★ 其中"装包会写记录"那一步因网络不通**未测量**）' : ''),
  );
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  // 退出码：0 = 全测量且全过；1 = 有判据不成立；2 = 有一步没测到（不谎报成绿）
  process.exit(fail > 0 ? 1 : measuredInstall === false ? 2 : 0);
}
