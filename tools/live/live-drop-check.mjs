/*
 * 真机判据：**拖进来的东西**（ADR-015 的判定顺序 + 装到哪儿 + 装完说什么）。
 *
 * ## 为什么这条必须有（而不是只留单测）
 *
 *   `domain::dropped` 的 15 条单测钉住了"**判定**"（整合包不能认成 Mod、
 *   光影要先于资源包…），但拖拽真正会骗人的地方在**判定之后**：
 *
 *   * 判对了却**装错目录** —— `mods/` 与 `resourcepacks/` 混一次，用户就再也找不到它；
 *   * 装完**把原文件移走**了（拖的是下载目录里那份，用户手上就没了）；
 *   * 该提醒的没提醒（纯原版装 Mod、没 Iris 装光影）—— 用户对着一个不生效的文件发呆；
 *   * 目录拖进来时**静静漏掉**几个（20 个里装了 3 个，只说"装了 3 个"）。
 *
 *   这四件事单测都答不了：它们要的是"命令真的跑起来之后，盘上多了什么"。
 *
 * ## 判据（九段）
 *
 *   ① 六个样本各自判对：Mod / 资源包 / 光影 / 数据包 / 整合包 / 认不出来
 *   ② 装单个文件：**落到对的目录**，而且**原文件还在**（拷贝不是移动）
 *   ③ 提示语：纯原版实例装 Mod **必须**提醒；有加载器的实例装 Mod **不许**提醒；
 *      没 Iris/OptiFine 的实例装光影必须提醒
 *   ④ 拖一个**目录**：这一层能装的都装、不能装的**逐条带理由**回来
 *   ⑤ 解压出来的整合包目录：如实说"压成 zip 再拖"，不往 mods/ 里塞
 *   ⑥ 整合包文件走 `classify` 是 `modpack`（前端据此改走"建实例"那条路）
 *   ⑦ 没有"当前版本"时如实拒绝（不随便挑一个实例塞进去）
 *   ⑧ 拖的是**上一级**目录（资源都在 mods/ 里）：要点名该拖哪一层
 *   ⑨ 别的启动器留下的**整个游戏目录**：如实说"还不能整个导入"
 *
 *   ★ 界面那一半（提示语、路由、ADR-015 那个"要不要现在装"的弹窗）
 *     在 `tools/live/live-drop-ui-check.mjs` 里 —— 命令全对、用户全错，
 *     是拖拽最容易坏的地方。
 *
 * ## 沙盒
 *
 *   `IEML_DATA_DIR` / `IEML_OWN_DIR` 指到 `%TEMP%`，启动前手写 instances.json
 *   （**两个**实例：一个有 Fabric、一个纯原版）+ 各自的 `game/` 目录；
 *   样本 zip 由本探针**现场造**（不依赖任何下载，也不往仓库里放二进制）。
 *
 * 用法：
 *   node tools/live/live-drop-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-drop-root');
const OWN = path.join(T, 'ieml-drop-own');
const SRC = path.join(T, 'ieml-drop-src');
const FABRIC = 'drop-fabric';
const VANILLA = 'drop-vanilla';

const gameOf = (slug) => path.join(ROOT, 'instances', slug, 'game');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ================= 造样本（真 zip，stored 方式，不压缩） ================= */

/**
 * 手写一个最小 zip（本地头 + 中央目录 + EOCD）。
 *
 * ★ 为什么不调 `Compress-Archive`：探针要能**在一台什么都没有的机器上跑**，
 *   而且这样造出来的条目名是可控的（判定只看名字，见 `domain::dropped`）。
 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (s) => Buffer.from(s, 'utf8');
  for (const name of entries) {
    const nameBuf = enc(name);
    const data = enc('ieml');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（随便一个合法值）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** 标准 CRC-32（zip 要求） */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/* ================= 沙盒 ================= */

for (const d of [ROOT, OWN, SRC]) rmSync(d, { recursive: true, force: true });
mkdirSync(SRC, { recursive: true });
mkdirSync(path.join(OWN), { recursive: true });
for (const slug of [FABRIC, VANILLA]) {
  mkdirSync(path.join(gameOf(slug), 'mods'), { recursive: true });
  mkdirSync(path.join(gameOf(slug), 'resourcepacks'), { recursive: true });
  mkdirSync(path.join(gameOf(slug), 'shaderpacks'), { recursive: true });
}
// ★ 版本目录也要有一份：实例列表只列"盘上认领得到的版本"
const VER = path.join(ROOT, '.minecraft', 'versions', '1.20.1');
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, '1.20.1.json'),
  JSON.stringify({ id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);

const inst = (id, slug, name, loader) => ({
  id,
  mcVersion: '1.20.1',
  loader,
  addons: [],
  config: {
    name,
    slug,
    isolation: 'auto',
    memoryMb: 2048,
    memorySource: 'global',
    javaMode: 'auto',
  },
  createdAt: null,
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});

writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        inst('i-drop-f', FABRIC, '拖拽探针·Fabric', { kind: 'fabric', version: '0.15.0' }),
        inst('i-drop-v', VANILLA, '拖拽探针·原版', null),
      ],
      activeId: 'i-drop-f',
    },
    null,
    2,
  ),
);

/* ---------- 样本文件 ---------- */
const f = (n) => path.join(SRC, n);
writeFileSync(f('sodium.jar'), makeZip(['fabric.mod.json', 'net/caffeinemc/Sodium.class']));
writeFileSync(f('材质包.zip'), makeZip(['pack.mcmeta', 'assets/minecraft/lang/zh_cn.json']));
writeFileSync(f('光影.zip'), makeZip(['pack.mcmeta', 'shaders/shadow.fsh']));
writeFileSync(f('数据包.zip'), makeZip(['pack.mcmeta', 'data/example/recipe/x.json']));
writeFileSync(f('整合包.zip'), makeZip(['manifest.json', 'mods/jei.jar', 'overrides/config/x.toml']));
writeFileSync(f('说明.zip'), makeZip(['readme.txt', 'image.png']));
writeFileSync(f('不是压缩包.txt'), '这只是一个文本文件');

const DIR = path.join(SRC, '一包东西');
mkdirSync(path.join(DIR, '旧版本'), { recursive: true });
writeFileSync(path.join(DIR, 'sodium.jar'), makeZip(['fabric.mod.json']));
writeFileSync(path.join(DIR, '材质包.zip'), makeZip(['pack.mcmeta', 'assets/x/y.json']));
writeFileSync(path.join(DIR, 'readme.txt'), '看看就好');
const UNZIPPED = path.join(SRC, '解压出来的整合包');
mkdirSync(path.join(UNZIPPED, 'mods'), { recursive: true });
writeFileSync(path.join(UNZIPPED, 'manifest.json'), '{"minecraft":{"version":"1.20.1"}}');
writeFileSync(path.join(UNZIPPED, 'mods', 'jei.jar'), makeZip(['META-INF/mods.toml']));
// 拖的是"上一级"：这一层一个文件都没有，资源都在 mods/ 里
const UPPER = path.join(SRC, '我的整合包');
mkdirSync(path.join(UPPER, 'mods'), { recursive: true });
writeFileSync(path.join(UPPER, 'mods', 'a.jar'), makeZip(['fabric.mod.json']));
// 别的启动器 / 官方启动器留下的整个游戏目录（真实的那种：versions/ + mods/ + 一堆文件）
const MCROOT = path.join(SRC, '别的启动器的.minecraft');
mkdirSync(path.join(MCROOT, 'versions', '1.20.1'), { recursive: true });
mkdirSync(path.join(MCROOT, 'mods'), { recursive: true });
writeFileSync(path.join(MCROOT, 'launcher_profiles.json'), '{}');
writeFileSync(path.join(MCROOT, 'options.txt'), 'lang:zh_cn');

/* ================= 开跑 ================= */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'droplive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

const classify = async (p) => {
  const r = await invokeOn(ev, 'classify_dropped_file', { path: p });
  return r.ok ?? { __err: r.err };
};
const install = async (p, slug) => {
  const r = await invokeOn(ev, 'install_dropped_file', { path: p, slug });
  return r.ok ?? { __err: r.err };
};
const installDir = async (p, slug) => {
  const r = await invokeOn(ev, 'install_dropped_dir', { path: p, slug });
  return r.ok ?? { __err: r.err };
};

const onDisk = (slug, dir, name) => existsSync(path.join(gameOf(slug), dir, name));

try {
  /* ---------- ① 六个样本各判对 ---------- */
  const kinds = {
    'sodium.jar': 'mod',
    '材质包.zip': 'resourcepack',
    '光影.zip': 'shader',
    '数据包.zip': 'datapack',
    '整合包.zip': 'modpack',
    '说明.zip': 'unknown',
  };
  for (const [name, want] of Object.entries(kinds)) {
    const got = await classify(f(name));
    check(got.kind === want, `① ${name} 判成 ${want}`, `实际 ${got.kind ?? JSON.stringify(got)}`);
  }
  const junk = await classify(f('说明.zip'));
  check(
    typeof junk.reason === 'string' && junk.reason.includes('说明.zip'),
    '① 认不出来时理由里带文件名（一次拖多个才知道该处理哪个）',
    junk.reason,
  );
  check((await classify(f('不是压缩包.txt'))).kind === 'unknown', '① 不是压缩包的文件如实说"读不了"');
  check(
    String((await classify(f('不是压缩包.txt'))).reason ?? '').includes('不是有效的压缩包'),
    '① 说清是"读不了"而不是"认不出类别"',
  );

  /* ---------- ② 装单个文件：目录对 + 原文件还在 ---------- */
  const mod = await install(f('sodium.jar'), FABRIC);
  check(mod.kind === 'mod', '② 装 Mod 成功', mod.__err ?? mod.kind);
  check(onDisk(FABRIC, 'mods', 'sodium.jar'), '② Mod 落在 mods/ 里');
  check(existsSync(f('sodium.jar')), '② 原文件还在（是拷贝，不是移走）');

  const rp = await install(f('材质包.zip'), FABRIC);
  check(onDisk(FABRIC, 'resourcepacks', '材质包.zip'), '② 资源包落在 resourcepacks/ 里', rp.__err ?? '');
  check(!onDisk(FABRIC, 'mods', '材质包.zip'), '② 资源包**没有**被塞进 mods/');

  const dp = await install(f('数据包.zip'), FABRIC);
  check(onDisk(FABRIC, 'datapacks', '数据包.zip'), '② 数据包落在 datapacks/ 里', dp.__err ?? '');

  /* ---------- ③ 提示语：该说的说、不该说的不说 ---------- */
  check(!mod.note, '③ 有加载器的实例装 Mod：**不**提醒', String(mod.note));
  const modVanilla = await install(f('sodium.jar'), VANILLA);
  check(
    typeof modVanilla.note === 'string' && modVanilla.note.includes('加载器'),
    '③ 纯原版实例装 Mod：必须提醒"放进去也不会被读取"',
    String(modVanilla.note),
  );

  const shader = await install(f('光影.zip'), FABRIC);
  check(onDisk(FABRIC, 'shaderpacks', '光影.zip'), '② 光影落在 shaderpacks/ 里', shader.__err ?? '');
  check(
    typeof shader.note === 'string' && /OptiFine|Iris/.test(shader.note),
    '③ 没有 OptiFine/Iris 装光影：必须提醒"不会生效"',
    String(shader.note),
  );
  check(!rp.note, '③ 资源包从来不提醒（原版就能用）', String(rp.note));

  /* ---------- ④ 目录：能装的都装、不能装的逐条带理由 ---------- */
  const dirReport = await installDir(DIR, FABRIC);
  check(
    Array.isArray(dirReport.installed) && dirReport.installed.length === 2,
    '④ 目录里 2 个能装的都装了',
    JSON.stringify(dirReport.installed?.map((x) => x.file_name)),
  );
  check(onDisk(FABRIC, 'mods', 'sodium.jar') && onDisk(FABRIC, 'resourcepacks', '材质包.zip'),
    '④ 两个文件各自进了对的目录');
  check(
    Array.isArray(dirReport.skipped) && dirReport.skipped.length === 2,
    '④ 跳过的 2 条**都带理由**回来（不静默丢掉）',
    JSON.stringify(dirReport.skipped),
  );
  check(
    (dirReport.skipped ?? []).some((s) => s.includes('readme.txt')) &&
      (dirReport.skipped ?? []).some((s) => s.includes('旧版本')),
    '④ 理由里分别说了"这是什么文件"与"子目录没装"',
    JSON.stringify(dirReport.skipped),
  );

  /* ---------- ⑤ 解压出来的整合包目录 ---------- */
  const unzipped = await classify(UNZIPPED);
  check(unzipped.kind === 'unknown', '⑤ 解压出来的整合包目录不当作"能装的一包文件"', unzipped.kind);
  check(
    String(unzipped.reason ?? '').includes('压成 zip'),
    '⑤ 如实说"压成 zip 再拖"（并给第二条路）',
    unzipped.reason,
  );
  check(!onDisk(FABRIC, 'mods', 'jei.jar'), '⑤ 没有偷偷把里面那个 jei.jar 装进去');

  /* ---------- ⑥ 整合包走的是另一条路 ---------- */
  const pack = await classify(f('整合包.zip'));
  check(pack.kind === 'modpack', '⑥ 整合包判成 modpack（前端据此改走"建实例"那条路）');
  const wrongWay = await install(f('整合包.zip'), FABRIC);
  check(
    typeof wrongWay.__err === 'string' && wrongWay.__err.includes('整合包'),
    '⑥ 万一被当成普通文件装：明确拒绝并说清该走哪条路',
    String(wrongWay.__err),
  );

  /* ---------- 兜底：没有当前版本时不许假装装上 ---------- */
  const noSlug = await install(f('sodium.jar'), '');
  check(
    typeof noSlug.__err === 'string' && noSlug.__err.includes('先打开一个版本'),
    '⑦ 没有当前版本：如实拒绝（而不是随便挑一个实例塞进去）',
    String(noSlug.__err),
  );

  /* ---------- ⑧ 拖的是**上一级**目录：要点名该拖哪一层 ---------- */
  const upper = await classify(UPPER);
  check(upper.kind === 'unknown', '⑧ 只装子目录的目录不会被当成"能装的一包"', upper.kind);
  check(
    String(upper.reason ?? '').includes('mods/') && String(upper.reason ?? '').includes('整个拖进来'),
    '⑧ 点名里面的 mods/ 并说"整个拖进来"（用户看得见那些 jar，不能只说"没有能装的"）',
    upper.reason,
  );

  /* ---------- ⑨ 别的启动器留下的整个游戏目录：如实说不支持整个导入 ---------- */
  const mcroot = await classify(MCROOT);
  check(
    String(mcroot.reason ?? '').includes('游戏目录') &&
      String(mcroot.reason ?? '').includes('还不能整个导入'),
    '⑨ 整个游戏目录：如实说"还不能整个导入"，不假装导入了',
    mcroot.reason,
  );
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  /*
   * ★ 不调 `close()`：那会把机器上**所有** ieml 一起杀掉（见 lib/cdp.mjs 的说明）。
   *   这里只断开 CDP，再按 pid 精准结束本次启动的那个进程。
   */
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
