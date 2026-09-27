/*
 * 真机判据：**导出整合包与文件黑名单**（ADR-024）。
 *
 * ## 为什么这条必须有（而不是只留单测）
 *
 *   单测钉住的是"名单怎么匹配"，而这件事的**后果全在盘上**：
 *   导出的那个 `.zip` 里到底有没有 `launcher_msa_credentials.bin`。
 *   判据必须是"打开产出的包，一个条目一个条目地看" —— 那是唯一能证明
 *   "登录凭据没被带出去"的方式。这条 ADR 自己把这件事写成**安全红线**。
 *
 * ## 判据（七段）
 *
 *   ① 计划把该带的列出来（Mod / 配置 / 资源包），把不该带的挡掉并给出理由
 *   ② **登录凭据**：计划里如实报出来，但**不在**"会带上"那一栏
 *   ③ 存档 / 设置这类走"建议"（默认不带，勾了才带）—— 勾上之后真的带上
 *   ④ 导出产出一个能读的 `.mrpack`：清单对（mc 版本 + 加载器）、内容在 `overrides/`
 *   ⑤ ★★ **包里没有任何黑名单文件**（逐条比对产出的 zip 条目）
 *   ⑥ 同一份产出能被**我们自己的**"拖进来判定"认成整合包（ADR-015 的闭环）
 *   ⑦ 界面上：概览页有「导出为整合包」，点开能看到"会带上什么 / 绝不带什么"
 *
 * 用法：
 *   node tools/live/live-export-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

/** `zipRead` 里要解 deflate（探针是 ESM，`require` 得自己造） */
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-exp-root');
const OWN = path.join(T, 'ieml-exp-own');
const OUT = path.join(T, 'ieml-exp-out');
const MC = path.join(ROOT, '.minecraft');
const SLUG = 'exp-src';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ====================== 沙盒 ====================== */

for (const d of [ROOT, OWN, OUT]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
const game = path.join(ROOT, 'instances', SLUG, 'game');
const w = (rel, content = 'x') => {
  const p = path.join(game, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

/* 该带上的 */
w('mods/jei.jar', 'MOD-JEI');
w('mods/sodium.jar', 'MOD-SODIUM');
w('config/jei.toml', 'config');
w('resourcepacks/材质.zip', 'RP');
w('shaderpacks/光影.zip', 'SHADER');
/* 硬黑名单：日志 / 游戏本体 / 运行期缓存 / 别的启动器的私有文件 */
w('logs/latest.log', 'LOG');
w('crash-reports/crash-1.txt', 'CRASH');
w('hs_err_pid1234.log', 'HSERR');
w('.fabric/remappedJars/x.jar', 'FABRIC');
w('PCL.ini', 'PCL');
w('.hmcl.json', 'HMCL');
w('versions/1.20.1/1.20.1.json', 'VERSION');
w('libraries/big.jar', 'LIB');
w('saves/World/level.dat', 'SAVE');
w('options.txt', 'lang:zh_cn');
/* ★ 红线：登录凭据（真实文件名） */
w('launcher_msa_credentials.bin', 'MSA-TOKEN-SECRET');
w('launcher_accounts.json', '{"accounts":[]}');

mkdirSync(path.join(MC, 'versions', 'fabric-loader-0.15.0-1.20.1'), { recursive: true });
writeFileSync(
  path.join(MC, 'versions', 'fabric-loader-0.15.0-1.20.1', 'fabric-loader-0.15.0-1.20.1.json'),
  JSON.stringify({
    id: 'fabric-loader-0.15.0-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [],
  }),
);
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-exp',
          mcVersion: '1.20.1',
          loader: { kind: 'fabric', version: '0.15.0', mcVersion: '1.20.1' },
          addons: [],
          config: {
            name: '导出探针',
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
      activeId: 'i-exp',
    },
    null,
    2,
  ),
);

/** 读一个 .zip 的**条目名**（stored/deflate 都能读：只解析中央目录） */
function zipEntries(buf) {
  // 找 EOCD（0x06054b50），从尾部往前扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return names;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * 从 zip 里读一个文件的原文。
 *
 * ★ 走**中央目录**而不是本地头：本地头在"流式写入"时可能把长度写成 0
 *   （真正的长度放在数据描述符里），而中央目录**永远**有压后长度与偏移。
 *   第一版按本地头读，于是 deflate 的清单读不出来 —— 判据红了一条与功能无关的。
 */
function zipRead(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === want) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw.toString('utf8');
      const { inflateRawSync } = require('node:zlib');
      return inflateRawSync(raw).toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ====================== 开跑 ====================== */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'explive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};
const rels = (list) => (list ?? []).map((i) => i.rel).sort();

try {
  /* ---------- ①②③ 计划 ---------- */
  const plan = await inv('scan_modpack_export', { slug: SLUG, includeSuggested: [] });
  check(!plan?.__err, '① 能算出导出计划', String(plan?.__err ?? ''));
  const inc = rels(plan?.include);
  /*
   * ★ 计划里进 `include` 的是**文件**（不是目录）——因为那正是写进 zip 的东西。
   *   第一版把目录和它下面的文件都放进去，导出时同一个文件被写两遍、
   *   zip 直接报 `Duplicate filename`（探针抓到的）。
   */
  check(
    inc.includes('mods/jei.jar') && inc.includes('config/jei.toml') && inc.includes('resourcepacks/材质.zip'),
    '① 该带上的都在"会带上"里（逐文件：Mod / 配置 / 资源包）',
    JSON.stringify(inc),
  );
  const exc = rels(plan?.excluded);
  check(
    exc.includes('logs/') && exc.includes('.fabric/') && exc.includes('PCL.ini') && exc.includes('versions/'),
    '① 日志 / 运行期缓存 / 别的启动器的私有文件 / 游戏本体都被挡掉（目录整棵剪掉）',
    JSON.stringify(exc.slice(0, 10)),
  );
  check(
    exc.includes('.hmcl.json'),
    '① HMCL 的真文件名 .hmcl.json 也挡住了（ADR 表里只写了 .hmcl）',
    JSON.stringify(exc.filter((x) => x.includes('hmcl'))),
  );
  const anyReason = (plan?.excluded ?? []).every((i) => (i.reason ?? '').length > 0);
  check(anyReason, '① 每一条被挡掉的都带理由（用户要知道为什么）');

  check(
    (plan?.red_line_found ?? []).includes('launcher_msa_credentials.bin') &&
      (plan?.red_line_found ?? []).includes('launcher_accounts.json'),
    '② ★ 登录凭据被如实报出来（盘上有它们）',
    JSON.stringify(plan?.red_line_found),
  );
  check(
    !inc.includes('launcher_msa_credentials.bin') && !inc.includes('launcher_accounts.json'),
    '② ★★ 它们**不在**"会带上"那一栏（安全红线）',
    JSON.stringify(inc),
  );
  const redItem = (plan?.excluded ?? []).find((i) => i.rel === 'launcher_msa_credentials.bin');
  check(
    redItem?.red_line === true && String(redItem?.reason).includes('登录凭据'),
    '② 理由里点名"登录凭据"（不混在"日志/私有文件"那一类）',
    JSON.stringify(redItem),
  );

  check(
    rels(plan?.suggested).includes('saves/') && rels(plan?.suggested).includes('options.txt'),
    '③ 存档与设置走"建议"（默认不带）',
    JSON.stringify(rels(plan?.suggested)),
  );
  const plan2 = await inv('scan_modpack_export', { slug: SLUG, includeSuggested: ['saves/'] });
  check(
    rels(plan2?.include).includes('saves/World/level.dat') &&
      !rels(plan2?.suggested).includes('saves/'),
    '③ 勾上之后存档真的进了"会带上"（整棵：连里面的文件）',
    JSON.stringify(rels(plan2?.include)),
  );

  /* ---------- ④⑤⑥ 真的导出 ---------- */
  const outFile = path.join(OUT, 'probe.mrpack');
  const res = await inv('export_modpack', {
    slug: SLUG,
    versionId: '1.0.0',
    includeSuggested: [],
    outPath: outFile,
  });
  check(!res?.__err && existsSync(outFile), '④ 导出产出了文件', String(res?.__err ?? res?.path));
  const buf = readFileSync(outFile);
  const names = zipEntries(buf) ?? [];
  check(names.includes('modrinth.index.json'), '④ 包里有清单 modrinth.index.json', JSON.stringify(names.slice(0, 4)));
  check(
    names.includes('overrides/mods/jei.jar') && names.includes('overrides/config/jei.toml'),
    '④ 内容放在 overrides/ 下（装的时候原样落回游戏目录）',
    JSON.stringify(names.filter((n) => n.startsWith('overrides/')).slice(0, 6)),
  );

  const index = zipRead(buf, 'modrinth.index.json');
  let manifest = null;
  try {
    manifest = index ? JSON.parse(index) : null;
  } catch {
    manifest = null;
  }
  check(
    manifest?.game === 'minecraft' &&
      manifest?.dependencies?.minecraft === '1.20.1' &&
      manifest?.dependencies?.['fabric-loader'] === '0.15.0',
    '④ 清单写对了 mc 版本与加载器',
    JSON.stringify(manifest?.dependencies ?? index?.slice(0, 60)),
  );

  /* ---------- ⑤ ★★ 包里绝不能有黑名单文件 ---------- */
  const banned = [
    'launcher_msa_credentials.bin',
    'launcher_accounts.json',
    'logs/',
    '.fabric/',
    'PCL.ini',
    '.hmcl.json',
    'versions/',
    'libraries/',
    'crash-reports/',
    'hs_err_pid1234.log',
    'saves/',
    'options.txt',
  ];
  const leaked = names.filter((n) =>
    banned.some((b) =>
      b.endsWith('/')
        ? n === `overrides/${b.slice(0, -1)}` || n.startsWith(`overrides/${b}`)
        : n === `overrides/${b}`,
    ),
  );
  check(
    leaked.length === 0,
    '⑤ ★★ 导出的包里**一条黑名单内容都没有**（包括登录凭据）',
    leaked.length ? JSON.stringify(leaked) : `共 ${names.length} 个条目，逐条比对过`,
  );
  // 反向确认：包确实有内容（不然"没有泄露"是假的 —— 空包当然没有）
  check(
    names.filter((n) => n.startsWith('overrides/')).length >= 4,
    '⑤ （对照）包里确实有内容，所以上一条不是"空包"造成的假绿',
    `${names.filter((n) => n.startsWith('overrides/')).length} 个内容条目`,
  );

  /* ---------- ⑥ 导出物能被自己认成整合包（ADR-015 闭环） ---------- */
  const cls = await inv('classify_dropped_file', { path: outFile });
  check(
    cls?.kind === 'modpack',
    '⑥ 同一个文件拖回来会被认成整合包（判据与 ADR-015 的判定顺序闭环）',
    String(cls?.kind ?? cls?.__err),
  );

  /* ---------- ⑦ 界面 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').includes('版本列表'));
    b?.click();
    return !!b;
  })()`);
  await sleep(1500);
  await ev(`(() => {
    const b = document.querySelector('button[aria-label^="导出探针"]');
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
  await sleep(2000);
  const hasButton = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim().includes('导出为整合包'),
    );
    b?.click();
    return !!b;
  })()`);
  let modalText = '';
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    modalText = String(await ev(`(document.querySelector('.modal')?.innerText || '')`));
    if (modalText.includes('导出')) break;
  }
  check(hasButton === true && modalText.includes('导出为整合包'), '⑦ 概览页有「导出为整合包」并能打开', modalText.slice(0, 80));
  check(
    modalText.includes('登录凭据') && modalText.includes('绝不会'),
    '⑦ 弹窗里醒目地说清"登录凭据绝不会进包"',
    modalText.slice(0, 200),
  );
  check(
    modalText.includes('mods/') && /不会.*进包|不会带上/.test(modalText),
    '⑦ 也说清了会带上什么、什么不会进包',
    modalText.slice(0, 240),
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
