/*
 * 真机判据：**版本隔离真的生效了**（ADR-005 三段判定 + 切换时的迁移提示）。
 *
 * ## 为什么这条必须有
 *
 *   「不隔离（共享）」在这个启动器里曾经是**一句做了半个月的空话**：
 *   界面上有那个选项、后端有一条判定命令（前端从没调过），而真正决定游戏目录的
 *   `prepare_spec` **两份都不看** —— 永远用 `instances/<slug>/game`。
 *   用户看到的后果是：选了「不隔离」，界面说会共用，实际什么都没共用；
 *   后来界面改成如实说"还没生效"，功能还是缺着。
 *
 *   ⇒ 这条探针要回答的是**盘上与命令行的实话**，而不是"判断函数返回了什么"：
 *     · 共享实例的 `--gameDir` 是不是共享的 `.minecraft`？
 *     · 拖进去的 Mod 是不是落在共享 `mods/`（游戏读得到的那一个）？
 *     · 切模式时，内容真的被复制过去了吗？同名文件有没有被顶掉？
 *     · 迁移前那份备份存在吗？源目录有没有被动过？
 *
 * ## 判据（九段）
 *
 *   ① 三段判定各自的来源对得上：user / content / global（+ 读不到账本时保守隔离）
 *   ② 共享实例的 `game_dir` = 共享 `.minecraft`；隔离实例 = 自己的 `game/`
 *   ③ `preview_launch` 的命令行里 `--gameDir` 真的换了（**与真启动同一条代码路径**）
 *   ④ 原生库仍然跟着实例走（隔离只换游戏目录，不换 natives）
 *   ⑤ 往共享实例拖一个 Mod → 落在**共享** `mods/`（不是实例自己那个）
 *   ⑥ 迁移计划说得清"从哪到哪、搬什么、多大"
 *   ⑦ 迁移真的复制过去，**源目录一个文件都没少**
 *   ⑧ 目标里的同名文件**不被覆盖**（用户自己的东西不许被顶掉）
 *   ⑨ 界面上：设置页显示的是**后端的结论**，切换时**弹出问一句**（迁移提示）
 *
 * 用法：
 *   node tools/live/live-isolation-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-iso-root');
const OWN = path.join(T, 'ieml-iso-own');
const MC = path.join(ROOT, '.minecraft');
const SLUG_SHARED = 'iso-shared';
const SLUG_ON = 'iso-on';
const SLUG_AUTO_CONTENT = 'iso-auto-content';
const SLUG_AUTO_EMPTY = 'iso-auto-empty';
/** 专门给"命令层迁移语义"用的那个（界面那一半用 iso-shared，别互相踩） */
const SLUG_MIGRATE = 'iso-migrate';

const gameOf = (slug) => path.join(ROOT, 'instances', slug, 'game');
const instanceJson = (slug) => path.join(OWN, 'instances.json');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ====================== 沙盒 ====================== */

for (const d of [ROOT, OWN]) rmSync(d, { recursive: true, force: true });
for (const sub of ['versions', 'libraries', 'assets', 'saves/SharedWorld', 'mods']) {
  mkdirSync(path.join(MC, sub), { recursive: true });
}
mkdirSync(OWN, { recursive: true });

/*
 * 一份**能过 `prepare_spec` 的老式版本 JSON**（形态照 1.12.2：`minecraftArguments`）。
 *
 * ★ 三件东西缺一不可（第一版探针漏了第三件，拿到的红与隔离毫无关系）：
 *   ① `minecraftArguments` 里有 `${game_directory}` —— 那正是要验的占位符；
 *   ② 一个 natives 库的**真 jar**（里面装着 `lwjgl64.dll`）—— 启动前有一道硬闸门：
 *      "natives 目录里必须真的有 dll"，否则预览直接被拦下（那是**对的**行为，
 *      但会让这条探针测不到东西）；
 *   ③ 版本目录里的 `<id>.jar`（客户端 jar）。
 */
const ARGS =
  '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} ' +
  '--uuid ${auth_uuid} --accessToken ${access_token} --userType ${user_type}`';

/** 造一个 stored（不压缩）的 zip —— natives jar 与"一个 Mod"都用它 */
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
const writeVersion = (dir, body) => {
  const d = path.join(MC, 'versions', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `${dir}.json`), JSON.stringify(body, null, 2));
  writeFileSync(path.join(d, `${dir}.jar`), Buffer.alloc(64, 7));
};
writeVersion('1.12.2', {
  id: '1.12.2',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: ARGS,
  libraries: [
    {
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
      natives: { windows: 'natives-windows' },
      downloads: {
        classifiers: { 'natives-windows': { path: `${LIB_REL}/${NATIVES_JAR}`, url: '', sha1: '', size: 0 } },
      },
    },
  ],
});
mkdirSync(path.join(MC, 'libraries', ...LIB_REL.split('/')), { recursive: true });
writeFileSync(
  path.join(MC, 'libraries', ...LIB_REL.split('/'), NATIVES_JAR),
  makeZip([['lwjgl64.dll', 'fake-native']]),
);

const mkInstance = (id, slug, name, isolation) => ({
  id,
  mcVersion: '1.12.2',
  loader: null,
  addons: [],
  config: {
    name,
    slug,
    isolation,
    memoryMb: 2048,
    memorySource: 'global',
    javaMode: 'auto',
  },
  createdAt: null,
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});

/*
 * 四个实例，正好覆盖三段判定的每一条来源：
 *   iso-shared        显式 off        → 共享（user）
 *   iso-on            显式 on         → 隔离（user）
 *   iso-auto-content  auto + 有内容   → 隔离（content）
 *   iso-auto-empty    auto + 空的     → 跟全局（global；全局设成 shared）
 */
const writeLedger = (sharedMode, onMode) => {
  writeFileSync(
    instanceJson(),
    JSON.stringify(
      {
        instances: [
          mkInstance('i-iso-shared', SLUG_SHARED, '隔离探针·共享', sharedMode),
          mkInstance('i-iso-on', SLUG_ON, '隔离探针·强制隔离', onMode),
          mkInstance('i-iso-ac', SLUG_AUTO_CONTENT, '隔离探针·自动有内容', 'auto'),
          mkInstance('i-iso-ae', SLUG_AUTO_EMPTY, '隔离探针·自动空', 'auto'),
          mkInstance('i-iso-mig', SLUG_MIGRATE, '隔离探针·迁移', 'off'),
        ],
        activeId: 'i-iso-shared',
      },
      null,
      2,
    ),
  );
};
writeLedger('off', 'on');

/* 全局默认 = shared：这样"auto + 空目录"那一条才会落到 global 上 */
writeFileSync(path.join(OWN, 'prefs.json'), JSON.stringify({ globalIsolation: 'shared', autoBackup: true }));

/* 各实例自己的目录（natives 由启动器自己从 natives 包里解出来，不预置） */
for (const slug of [SLUG_SHARED, SLUG_ON, SLUG_AUTO_CONTENT, SLUG_AUTO_EMPTY, SLUG_MIGRATE]) {
  mkdirSync(gameOf(slug), { recursive: true });
}
/* 「迁移」那个实例：自己目录里有内容，且模式是 off（→ 迁移方向 = 搬进共享目录） */
mkdirSync(path.join(gameOf(SLUG_MIGRATE), 'saves', 'MigWorld'), { recursive: true });
writeFileSync(path.join(gameOf(SLUG_MIGRATE), 'saves', 'MigWorld', 'level.dat'), 'SAVE-MIGRATE');
mkdirSync(path.join(gameOf(SLUG_MIGRATE), 'mods'), { recursive: true });
writeFileSync(path.join(gameOf(SLUG_MIGRATE), 'mods', 'mig.jar'), 'MOD-MIGRATE');
// 隔离实例里有内容（这是"auto 按内容判定"的证据，也是迁移的源）
mkdirSync(path.join(gameOf(SLUG_ON), 'saves', 'MyWorld'), { recursive: true });
writeFileSync(path.join(gameOf(SLUG_ON), 'saves', 'MyWorld', 'level.dat'), 'SAVE-ISO-ON');
mkdirSync(path.join(gameOf(SLUG_ON), 'mods'), { recursive: true });
writeFileSync(path.join(gameOf(SLUG_ON), 'mods', 'jei.jar'), 'MOD-ISO-ON');
writeFileSync(path.join(gameOf(SLUG_ON), 'options.txt'), 'lang:zh_cn\n');
// 「auto + 有内容」那一条：只要目录里有东西就算有内容
mkdirSync(path.join(gameOf(SLUG_AUTO_CONTENT), 'mods'), { recursive: true });
writeFileSync(path.join(gameOf(SLUG_AUTO_CONTENT), 'mods', 'sodium.jar'), 'MOD-AUTO-CONTENT');
// 共享目录里也放点东西：迁移的**目标**
writeFileSync(path.join(MC, 'saves', 'SharedWorld', 'level.dat'), 'SAVE-SHARED');

/* ====================== 开跑 ====================== */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'isolive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

/** 盘上这一层的实话：某个目录里有几个文件、叫什么 */
const filesIn = (dir) => {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, '');
  return out.sort();
};

try {
  /* ---------- ① 三段判定各自的来源 ---------- */
  const verdicts = await inv('isolation_verdicts');
  const byslug = Object.fromEntries((Array.isArray(verdicts) ? verdicts : []).map((v) => [v.slug, v]));
  check(Object.keys(byslug).length === 5, '① 五个实例都拿到了判定', JSON.stringify(Object.keys(byslug)));

  check(byslug[SLUG_SHARED]?.isolated === false, '① 显式「不隔离」→ 共享', JSON.stringify(byslug[SLUG_SHARED]));
  check(byslug[SLUG_SHARED]?.source === 'user', '① 来源标成 user（是用户选的）', String(byslug[SLUG_SHARED]?.source));
  check(
    typeof byslug[SLUG_SHARED]?.warning === 'string' && byslug[SLUG_SHARED].warning.includes('mods'),
    '① 共享必须带"多版本共用 mods"的警告',
    String(byslug[SLUG_SHARED]?.warning).slice(0, 60),
  );
  check(byslug[SLUG_ON]?.isolated === true && byslug[SLUG_ON]?.source === 'user', '① 显式「强制隔离」→ 独立（user）');
  check(
    byslug[SLUG_AUTO_CONTENT]?.isolated === true && byslug[SLUG_AUTO_CONTENT]?.source === 'content',
    '① auto + 目录里有 mods → 隔离，来源标成 content',
    JSON.stringify(byslug[SLUG_AUTO_CONTENT]),
  );
  check(
    byslug[SLUG_AUTO_EMPTY]?.isolated === false && byslug[SLUG_AUTO_EMPTY]?.source === 'global',
    '① auto + 空目录 → 跟随全局默认（这里设的是 shared）',
    JSON.stringify(byslug[SLUG_AUTO_EMPTY]),
  );

  /* ---------- ② game_dir 是哪个 ---------- */
  check(
    byslug[SLUG_SHARED]?.game_dir === MC,
    '② 共享实例的游戏目录 = 共享 .minecraft',
    String(byslug[SLUG_SHARED]?.game_dir),
  );
  check(
    byslug[SLUG_ON]?.game_dir === gameOf(SLUG_ON),
    '② 隔离实例的游戏目录 = 自己的 instances/<slug>/game',
    String(byslug[SLUG_ON]?.game_dir),
  );

  /* ---------- ③ 命令行里的 --gameDir（与真启动同一条路径） ---------- */
  const req = (slug, id) => ({
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
  const pvShared = await inv('preview_launch', { req: req(SLUG_SHARED, 'i-iso-shared') });
  const pvOn = await inv('preview_launch', { req: req(SLUG_ON, 'i-iso-on') });
  const cmdShared = String(pvShared?.command ?? pvShared?.__err ?? '');
  const cmdOn = String(pvOn?.command ?? pvOn?.__err ?? '');
  check(
    cmdShared.includes(MC),
    '③ 共享实例的启动命令里 `--gameDir` 指向共享 .minecraft',
    cmdShared.slice(0, 160),
  );
  check(
    cmdOn.includes(gameOf(SLUG_ON)) && !cmdOn.includes(`"${MC}"`),
    '③ 隔离实例的启动命令里 `--gameDir` 指向自己的 game/',
    cmdOn.slice(0, 160),
  );

  /* ---------- ④ natives 仍然跟着实例走 ---------- */
  const natShared = String(pvShared?.natives_dir ?? '');
  check(
    natShared.includes(path.join('instances', SLUG_SHARED, 'natives')),
    '④ 原生库仍然放在实例自己的目录里（隔离只换游戏目录）',
    natShared,
  );

  /* ---------- ⑤ 往共享实例装东西 → 落在共享目录 ---------- */
  const srcDir = path.join(T, 'ieml-iso-src');
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  const modPath = path.join(srcDir, 'probe-mod.jar');
  writeFileSync(modPath, makeZip([['fabric.mod.json', '{"id":"probe-mod"}']]));
  const installed = await inv('install_dropped_file', { path: modPath, slug: SLUG_SHARED });
  check(
    String(installed?.target_path ?? installed?.__err ?? '').startsWith(MC),
    '⑤ 拖进共享实例的 Mod 落在**共享** mods/（游戏读得到的那一个）',
    String(installed?.target_path ?? installed?.__err),
  );
  check(
    existsSync(path.join(MC, 'mods', 'probe-mod.jar')) &&
      !existsSync(path.join(gameOf(SLUG_SHARED), 'mods', 'probe-mod.jar')),
    '⑤ 它**没有**跑进实例自己那个（游戏不读的）目录',
  );

  /* ---------- ⑥⑦⑧ 迁移语义（命令层；用专门那个实例，不碰界面那一半的沙盒） ---------- */
  /*
   * ★★ 顺序必须与**界面**一致：改设置是"先写账本、再问要不要搬"。
   *   所以这里也先把模式写进账本，再算计划 —— 计划**只看目标方向**，
   *   不看"现在是不是已经这个模式了"（详见 `migration_plan` 里那段说明：
   *   拿账本比会永远成立，迁移功能等于没有；第一版就是这么错的）。
   *
   *   方向：这个实例原来是 off（共享），现在切成 on（隔离）——
   *   源是**它自己的** game/，目标是共享 `.minecraft`。
   */
  /*
   * ★★ 方向的定义（第一版探针这里想反了，拿到的红与功能无关）：
   *   `to_mode = "on"` ⇒ 这个实例**要改成隔离**，它现在读的是共享目录，
   *   所以要把**共享目录**里的东西搬进它自己的 game/。
   *   一句话：**从"它此刻在用的"搬到"它马上要用的"**。
   */
  writeLedger('on', 'on');
  const plan = await inv('plan_isolation_migration', { slug: SLUG_MIGRATE, toMode: 'on' });
  check(
    plan?.from === MC && plan?.to === gameOf(SLUG_MIGRATE),
    '⑥ 计划里写清了从哪到哪（共享目录 → 它自己的目录）',
    JSON.stringify({ from: plan?.from, to: plan?.to }),
  );
  check(
    Array.isArray(plan?.items) && plan.items.some((i) => i.name === 'mods' && i.files >= 1),
    '⑥ 计划列出了要搬的东西（mods 里那几个文件）',
    JSON.stringify(plan?.items),
  );
  check(plan?.overwrite === false, '⑥ 明确写着**不会覆盖**同名文件');

  // 目标（实例自己的目录）里先放一个**与源同名**的文件：验"不覆盖"
  mkdirSync(path.join(gameOf(SLUG_MIGRATE), 'mods'), { recursive: true });
  writeFileSync(path.join(gameOf(SLUG_MIGRATE), 'mods', 'probe-mod.jar'), 'MINE-ALREADY');
  const before = { source: filesIn(MC) };

  const moved = await inv('apply_isolation_migration', {
    slug: SLUG_MIGRATE,
    toMode: 'on',
    backupFirst: true,
  });
  check(
    Array.isArray(moved?.copied) && moved.copied.some((c) => c.name === 'saves' && c.files >= 1),
    '⑦ 存档被复制到这个实例自己的目录',
    JSON.stringify(moved?.copied ?? moved?.__err),
  );
  check(
    moved?.skipped_existing?.some((s) => s.includes('probe-mod.jar')),
    '⑧ 目标里已有的同名文件被**跳过**（没有覆盖）',
    JSON.stringify(moved?.skipped_existing),
  );
  check(
    readFileSync(path.join(gameOf(SLUG_MIGRATE), 'mods', 'probe-mod.jar'), 'utf8') ===
      'MINE-ALREADY',
    '⑧ 那个同名文件的内容**原样没动**',
  );
  check(
    filesIn(MC).length === before.source.length,
    '⑦ 源目录（共享）里的文件**一个都没少**（只复制，不删）',
    `${before.source.length} → ${filesIn(MC).length}`,
  );
  check(
    typeof moved?.backup_id === 'string' && moved.backup_id.length > 0,
    '⑦ 迁移前那份备份真的做了（ADR-014 的后悔药）',
    String(moved?.backup_id),
  );
  check(
    existsSync(path.join(OWN, 'backups', SLUG_MIGRATE, String(moved?.backup_id), 'backup.json')),
    '⑦ 备份清单落在盘上（不是只回了一个 id）',
  );

  /*
   * 再跑一次迁移：源目录里**还有**那些内容（我们只复制、不删），
   * 但目标里已经有了 ⇒ 应当**一个都不再复制**，全部报成"已存在、跳过"。
   * ★ 这才是"不会重复搬"的判据；第一版写成"再算一次计划应当是空的"——
   *   那是错的（源目录当然还有东西，我们从不删源）。
   */
  const again = await inv('apply_isolation_migration', {
    slug: SLUG_MIGRATE,
    toMode: 'on',
    backupFirst: false,
  });
  check(
    Array.isArray(again?.copied) && again.copied.length === 0 && again.skipped_existing.length > 0,
    '⑦ 再迁移一次：一个都不重复复制（全部报"已存在"）',
    JSON.stringify({ copied: again?.copied, skipped: again?.skipped_existing?.length }),
  );

  /* ---------- ⑨ 界面：显示后端的结论，切换时问一句 ---------- */
  await clickNav(ev, '版本列表');
  await sleep(1500);
  const labels = await ev(
    `JSON.stringify([...document.querySelectorAll('button[aria-label]')].map((x)=>x.getAttribute('aria-label')))`,
  );
  console.log('  版本列表里的按钮 aria-label：' + labels);
  await ev(`(() => {
    const b = document.querySelector('button[aria-label^="隔离探针·共享"]');
    b?.click();
    return !!b;
  })()`);
  await sleep(700);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim().includes('打开设置') && x.offsetParent !== null,
    );
    b?.click();
    return !!b;
  })()`);
  /*
   * 页面落在**概览**页。要进「设置」那一页得点页签 ——
   * ★ 用「概览」当锚点找页签栏（侧栏里也有一个「设置」，按文字找会点错）。
   */
  await ev(`(() => {
    const all = [...document.querySelectorAll('button')];
    const overview = all.find((b) => (b.textContent || '').trim() === '概览');
    const bar = overview?.parentElement;
    const settings = bar ? [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '设置') : null;
    settings?.click();
    return !!settings;
  })()`);
  await sleep(1500);

  const verdictText = await ev(
    `(document.querySelector('.iso-verdict')?.innerText || '')`,
  );
  check(
    typeof verdictText === 'string' && verdictText.includes('不隔离'),
    '⑨ 设置页显示的是**判定结论**（这个实例当前是共享）',
    String(verdictText).slice(0, 120),
  );
  check(
    typeof verdictText === 'string' && verdictText.includes('.minecraft'),
    '⑨ 并且把"游戏目录"的具体路径写出来（共享目录那一条）',
    String(verdictText).slice(0, 170),
  );

  /*
   * 把隔离拨到「强制隔离」：结论会翻面（共享 → 独立）—— 必须弹一句问话。
   * ★ 这时源目录是**共享目录**（这个实例本来在读它），里面确实有存档与 Mod。
   * ★ 下拉是自绘的（`CustomSelect`）：`.cs-trigger` 打开、`.cs-option` 选一项。
   *   第一版按文字找按钮，点到了一个包着好几段文字的容器 —— 值根本没变，
   *   于是"没弹窗"这条红是量法造成的。
   */
  const triggerBefore = await ev(
    `(() => { const t = document.querySelector('#row-isolation .cs-trigger'); return (t?.textContent || '').trim(); })()`,
  );
  await ev(`(() => { document.querySelector('#row-isolation .cs-trigger')?.click(); return true; })()`);
  await sleep(400);
  const picked = await ev(`(() => {
    const o = [...document.querySelectorAll('.cs-option')].find(
      (x) => (x.textContent || '').includes('强制隔离'),
    );
    o?.click();
    return (o?.textContent || '').trim();
  })()`);
  console.log(`  下拉：改之前「${triggerBefore}」→ 点「${picked}」`);
  await sleep(2500);
  const modalTitle = await ev(`(document.querySelector('.modal .modal-title')?.textContent || '')`);
  check(
    typeof modalTitle === 'string' && modalTitle.includes('复制'),
    '⑨ 切换隔离时弹出"要不要复制过去"（ADR-005 的迁移提示）',
    `${String(picked)} → ${String(modalTitle)}`,
  );
  const modalText = await ev(`(document.querySelector('.modal')?.innerText || '')`);
  check(
    typeof modalText === 'string' && modalText.includes('原目录不会删'),
    '⑨ 弹窗里写明"原目录不会删"（不然用户不敢点）',
    String(modalText).slice(0, 160),
  );
  check(
    typeof modalText === 'string' && /saves|mods/.test(modalText),
    '⑨ 弹窗里列出了会搬哪些东西',
    String(modalText).slice(0, 200),
  );

  /*
   * 点「切换并复制」：**界面这条路真的会把内容搬过去**。
   * 判据落在盘上（副本出现在这个实例自己的 game/ 里），而不是"弹窗关掉了"。
   */
  await ev(`(() => {
    const b = [...document.querySelectorAll('.modal button')].find(
      (x) => (x.textContent || '').includes('切换并复制'),
    );
    b?.click();
    return !!b;
  })()`);
  await sleep(2500);
  check(
    existsSync(path.join(gameOf(SLUG_SHARED), 'saves', 'SharedWorld', 'level.dat')),
    '⑨ 界面上点「切换并复制」之后，共享目录里的存档**真的复制到实例目录**了',
    JSON.stringify(filesIn(gameOf(SLUG_SHARED)).slice(0, 6)),
  );
  const toastText = await ev(
    `[...document.querySelectorAll('.toast')].map((t) => (t.innerText || '')).join(' | ')`,
  );
  check(
    typeof toastText === 'string' && toastText.includes('没有删'),
    '⑨ 并且如实告诉用户"原目录里的东西没有删"',
    String(toastText).slice(0, 200),
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
