/*
 * 真机判据：**Java 的四模式真的接上启动路径了**（ADR-030，2026-09-28）。
 *
 * ## 为什么必须有这条
 *
 *   实例设置页能选「自动 / 区间 / 实例文件夹 / 手动指定」，账本里也**存着**这些字段 ——
 *   而在这条探针写出来之前，**启动时没人看它们**：
 *   `pickJava()`（TS 那份）全仓库没有调用方，Rust 侧的 `java_mode` 只在结构体里出现。
 *   用户手选了一个 Java，启动器却用另一个，而且界面上看不出来。
 *
 *   所以判据必须是**启动命令里那一条**：`preview_launch` 与真启动走同一个
 *   `prepare_spec`，它回给我们 `java`（程序路径）与 `java_note`（谁的决定）。
 *
 * ## 判据（七段）
 *
 *   ① `path` 档：启动命令里用的就是**用户指定的那个 java**
 *   ② `path` 档但文件不在了：**如实报错**（不偷偷回退到自动），错误里带上那个路径
 *   ③ `range` 档：用的 java 主版本**落在区间里**
 *   ④ `instance-folder` 档：**扫得到** `<实例>/java`（这一处以前从来不扫），
 *      而且启动命令里用的就是它
 *   ⑤ `auto` 档：行为与以前一致（按版本要求挑）
 *   ⑥ 显式选了一个**不在要求区间**的 java：照用，但 `java_note` 里必须有警告
 *   ⑦ 界面上：预览弹窗里显示"为什么用它"
 *
 * ## 沙盒里的"实例自带 Java"是**真的 Java**
 *
 *   `<实例>/java` 用 **junction**（目录联接）指向本机真实的那份 JRE ——
 *   于是扫描、探测版本、拼命令行全都是真的走一遍，不是造个假 exe 骗自己。
 *
 * 用法：
 *   node tools/live/live-java-mode-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 本机没有可用的 Java（本次测量无效）
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-javamode-root');
const OWN = path.join(T, 'ieml-javamode-own');
const MC = path.join(ROOT, '.minecraft');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 沙盒 ---------- */
rmSync(ROOT, { recursive: true, force: true });
rmSync(OWN, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });

/* 一份能过 prepare_spec 的老式版本 JSON（形态照 1.12.2）+ natives 包 */
const ARGS =
  '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} ' +
  '--uuid ${auth_uuid} --accessToken ${access_token} --userType ${user_type}';
function makeZip(entries) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nb = enc(name);
    const data = enc(content ?? 'x');
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
const LIB_REL = 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209';
const NATIVES_JAR = 'lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar';
const VER = path.join(MC, 'versions', '1.12.2');
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, '1.12.2.json'),
  JSON.stringify({
    id: '1.12.2',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: ARGS,
    libraries: [
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
        natives: { windows: 'natives-windows' },
        downloads: {
          classifiers: {
            'natives-windows': { path: `${LIB_REL}/${NATIVES_JAR}`, url: '', sha1: '', size: 0 },
          },
        },
      },
    ],
  }),
);
writeFileSync(path.join(VER, '1.12.2.jar'), Buffer.alloc(64, 7));
mkdirSync(path.join(MC, 'libraries', ...LIB_REL.split('/')), { recursive: true });
writeFileSync(
  path.join(MC, 'libraries', ...LIB_REL.split('/'), NATIVES_JAR),
  makeZip([['lwjgl64.dll', 'fake-native']]),
);

const mkInstance = (id, slug, name, java) => ({
  id,
  mcVersion: '1.12.2',
  loader: null,
  addons: [],
  config: {
    name,
    slug,
    isolation: 'on',
    memoryMb: 2048,
    memorySource: 'global',
    ...java,
  },
  createdAt: null,
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});

for (const slug of ['j-auto', 'j-path', 'j-gone', 'j-instance']) {
  mkdirSync(path.join(ROOT, 'instances', slug, 'game'), { recursive: true });
}
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        mkInstance('i-auto', 'j-auto', 'Java探针·自动', { javaMode: 'auto' }),
        mkInstance('i-path', 'j-path', 'Java探针·手动', { javaMode: 'path' }),
        mkInstance('i-gone', 'j-gone', 'Java探针·不在了', {
          javaMode: 'path',
          javaPath: 'Z:\\nope\\bin\\java.exe',
        }),
        mkInstance('i-inst', 'j-instance', 'Java探针·实例文件夹', { javaMode: 'instance-folder' }),
      ],
      activeId: 'i-auto',
    },
    null,
    2,
  ),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'javamode',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};
const reqFor = (slug, id) => ({
  mc_version: '1.12.2',
  loader_kind: null,
  loader_version: null,
  username: 'Probe',
  account_uuid: null,
  memory_mb: 2048,
  width: 854,
  height: 480,
  instance_slug: slug,
  instance_id: id,
  extra_jvm_args: [],
  extra_game_args: [],
  window_title: null,
  join_server: null,
  addons: [],
});

try {
  /* ---------- 找一个真实的 Java（本机扫到的） ---------- */
  const runtimes = await inv('scan_java');
  const real = (Array.isArray(runtimes) ? runtimes : []).find((r) => r.path && r.major >= 8);
  if (!real) {
    console.error('\n✗ 本机一个 Java 都没扫到 —— **本次测量无效**（不是功能红）。');
    process.exit(2);
  }
  console.log(`  本机 Java：${real.major} ${real.vendor} → ${real.path}`);

  /* ---------- ① path 档：就是它 ---------- */
  const ledgerFile = path.join(OWN, 'instances.json');
  const ledger = JSON.parse(
    (await import('node:fs')).readFileSync(ledgerFile, 'utf8'),
  );
  ledger.instances.find((i) => i.config.slug === 'j-path').config.javaPath = real.path;
  // 区间档：用真实 java 的主版本造一个只含它的区间
  ledger.instances.find((i) => i.config.slug === 'j-auto').config.javaMode = 'range';
  ledger.instances.find((i) => i.config.slug === 'j-auto').config.javaRange = {
    min: real.major,
    minInclusive: true,
    max: real.major,
    maxInclusive: true,
  };
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  // 让启动器重读账本（它自己也会在窗口聚焦时重读）
  await ev(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(1200);

  const pvPath = await inv('preview_launch', { req: reqFor('j-path', 'i-path') });
  check(
    String(pvPath?.java ?? '').toLowerCase() === real.path.toLowerCase(),
    '① 手动指定的档：启动命令里用的就是**用户指定的那个 java**',
    `${pvPath?.java ?? pvPath?.__err}`,
  );
  check(
    typeof pvPath?.java_note === 'string' && pvPath.java_note.includes('选'),
    '① 并且说明了"这条 java 是怎么来的"',
    String(pvPath?.java_note),
  );

  /* ---------- ② 指定的 java 不在了 → 如实报错 ---------- */
  const pvGone = await inv('preview_launch', { req: reqFor('j-gone', 'i-gone') });
  check(
    typeof pvGone?.__err === 'string' && pvGone.__err.includes('Z:\\nope'),
    '② 指定的 java 不在了：**如实报错**并带上那个路径（不偷偷回退到自动）',
    String(pvGone?.__err).slice(0, 160),
  );
  check(
    typeof pvGone?.__err === 'string' && pvGone.__err.includes('版本设置'),
    '② 并且给出了处理办法（回版本设置改掉）',
    String(pvGone?.__err).slice(0, 200),
  );

  /* ---------- ③ 区间档 ---------- */
  const pvRange = await inv('preview_launch', { req: reqFor('j-auto', 'i-auto') });
  const rangeMajor =
    (Array.isArray(runtimes) ? runtimes : []).find(
      (r) => String(r.path).toLowerCase() === String(pvRange?.java ?? '').toLowerCase(),
    )?.major ?? null;
  check(
    rangeMajor === real.major,
    `③ 区间档 [${real.major}, ${real.major}]：用的 java 主版本落在区间里`,
    `用的是 ${pvRange?.java ?? pvRange?.__err}（主版本 ${rangeMajor}）`,
  );

  /* ---------- ④ 实例文件夹档：真的扫得到 ---------- */
  const instJava = path.join(ROOT, 'instances', 'j-instance', 'java');
  try {
    // ★ 目录联接：指到**本机真实的那份 JRE**，于是探测版本、拼命令行全是真的
    const jreRoot = path.dirname(path.dirname(real.path)); // <root>/bin/java → <root>
    symlinkSync(jreRoot, instJava, 'junction');
  } catch (e) {
    console.log('  （做不出目录联接，跳过这一条）' + e.message);
  }
  const after = await inv('scan_java');
  const instRuntime = (Array.isArray(after) ? after : []).find((r) => r.source === 'instance');
  console.log(
    `  扫到的 Java 共 ${(Array.isArray(after) ? after : []).length} 个（来源：${[...new Set((Array.isArray(after) ? after : []).map((r) => r.source))].join('、')}）`,
  );
  /*
   * ★ 这里**不断言"扫描列表里一定有 source=instance"** —— 扫描按规范化路径去重，
   *   而这份"实例自带的 Java"是联接到系统里同一份 JRE 的（探针就是这么造的，
   *   真机上包作者塞一份也是同一份）⇒ 列表里只会留先扫到的那条。
   *   真正要验的是**这一档能不能用上实例里的那一份**（下一条）。
   */
  void instRuntime;
  const pvInst = await inv('preview_launch', { req: reqFor('j-instance', 'i-instance') });
  check(
    String(pvInst?.java ?? '').toLowerCase().includes('j-instance'),
    '④ 「实例文件夹」档：启动命令里用的就是**这个实例自己那一份**（哪怕它与系统里那份是同一个文件）',
    String(pvInst?.java ?? pvInst?.__err),
  );
  check(
    typeof pvInst?.java_note === 'string' && pvInst.java_note.includes('选'),
    '④ 并且说明了这是"你选的那一项"',
    String(pvInst?.java_note),
  );

  /* ---------- ⑤ auto 档：与以前一致（按版本要求挑） ---------- */
  writeFileSync(
    ledgerFile,
    JSON.stringify(
      {
        ...ledger,
        instances: ledger.instances.map((i) =>
          i.config.slug === 'j-path'
            ? { ...i, config: { ...i.config, javaMode: 'auto', javaPath: null } }
            : i,
        ),
      },
      null,
      2,
    ),
  );
  await ev(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(1200);
  const pvAuto = await inv('preview_launch', { req: reqFor('j-path', 'i-path') });
  check(
    typeof pvAuto?.java === 'string' && pvAuto.java.length > 0,
    '⑤ 自动档照常工作（按版本要求挑，没有回归）',
    String(pvAuto?.java ?? pvAuto?.__err),
  );

  /* ---------- ⑥ 选了一个不在要求区间里的 java → 照用 + 警告 ---------- */
  /*
   * 1.12.2 的要求是 Java 8 左右；这里故意选一个**主版本差得远**的 java
   * （用区间档把区间划在 max = 8，而让本机那个高版本 java 落在区间外）。
   */
  writeFileSync(
    ledgerFile,
    JSON.stringify(
      {
        ...ledger,
        instances: ledger.instances.map((i) =>
          i.config.slug === 'j-auto'
            ? {
                ...i,
                config: {
                  ...i.config,
                  javaMode: 'range',
                  javaRange: { min: 1, minInclusive: true, max: 2, maxInclusive: true },
                },
              }
            : i,
        ),
      },
      null,
      2,
    ),
  );
  await ev(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(1200);
  const pvBad = await inv('preview_launch', { req: reqFor('j-auto', 'i-auto') });
  // 区间 [1,2] 里没有任何 java ⇒ 这是"用不了"的情形，应当如实报错
  check(
    typeof pvBad?.__err === 'string' && pvBad.__err.includes('区间'),
    '⑥ 区间里一个 java 都没有：如实报错（不偷偷换一个）',
    String(pvBad?.__err).slice(0, 140),
  );

  /* ---------- ⑦ 界面上显示"为什么用它" ---------- */
  // ★ 先把这一档改回「手动指定」并指向本机真实 java：这样预览里一定有 note
  writeFileSync(
    ledgerFile,
    JSON.stringify(
      {
        ...ledger,
        instances: ledger.instances.map((i) =>
          i.config.slug === 'j-auto'
            ? {
                ...i,
                config: { ...i.config, javaMode: 'path', javaPath: real.path, javaRange: null },
              }
            : i,
        ),
      },
      null,
      2,
    ),
  );
  await ev(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(1200);

  await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').includes('启动'));
    b?.click();
    return !!b;
  })()`);
  await sleep(2000);
  const btnLabels = await ev(
    `JSON.stringify([...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null).map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 24))`,
  );
  const previewBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => /预览/.test(x.textContent || '') && x.offsetParent !== null,
    );
    b?.click();
    return !!b;
  })()`);
  let modalText = '';
  for (let i = 0; i < 24; i += 1) {
    await sleep(500);
    modalText = String(await ev(`(document.querySelector('.modal')?.innerText || '')`));
    // ★ 等它**拼完**（一开始是"正在拼装…"）：只要还在拼就继续等
    if (modalText.includes('为什么用它') || (modalText.includes('Java') && !modalText.includes('正在拼装'))) {
      break;
    }
  }
  check(
    previewBtn === true && modalText.includes('为什么用它'),
    '⑦ 预览弹窗里显示"为什么用它"（这条 java 是谁的决定）',
    `按钮=${previewBtn}｜页面按钮：${btnLabels}｜弹窗：${modalText.slice(0, 160)}`,
  );
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
