/*
 * 真机判据：**整合包实例不许逐个更新 Mod**（ADR-018 第 ⑥ 条）。
 *
 * ## 为什么必须有这条
 *
 *   ADR 的原话是"作者已经验证过这套组合"，所以单个 Mod 的更新**默认不允许**
 *   （要更新就走整包更新）。这条规矩的价值全在**用户点不到那个按钮**上 ——
 *   判错的代价是"把作者配好的一套 Mod 升坏，而且极难查"。
 *   单测能钉住规则（`tests/domain.test.js`），但"界面上那个按钮到底禁没禁"只有真机能答。
 *
 * ## 判据（八段）
 *
 *   ① 后端：有安装记录的实例读得出包名 + 版本
 *   ② 后端：★ 对照组 —— 没有记录的实例如实返回 null
 *   ③ Mod 管理页显示"这个实例由整合包管理"，并点了包名
 *   ④ 理由里说得出出路（"作者没提供新版清单" ⇒ 该走整包更新）
 *   ⑤ ★「检查更新」按钮**被禁用**（这就是"用户点不到"）
 *   ⑥ ★ 对照组：**不是**整合包的实例，按钮**可用**（否则这条判据是"永远绿"）
 *   ⑦ 换成没有记录的实例后，刚才那句理由消失（状态跟着实例走，不是全局开关）
 *   ⑧ 概览页也显示"来自整合包 X 版本"（与 Mod 页同一个事实来源）
 *
 * ## 沙盒
 *
 *   两个实例：一个手写一份**与安装所写同构**的 `pack-record.json`
 *   （格式见 `domain::pack_record`），另一个什么都不写。
 *   记录由探针直接落盘是**有意**的：这里验的是"有记录时界面怎么表现"，
 *   而"安装会写记录"那条已经在 `live-pack-completion-check.mjs` 里验过了。
 *
 *   ★★ `APPDATA` **也必须**指到沙盒里（见 `probe-a4-fixed.mjs` 的那段说明）：
 *     启动时的"数据根补齐"（`migrate_data_root`）会拿真实的 `%APPDATA%\IEML`
 *     当源复制一份进来。第一版没设它，于是沙盒里混进了用户真实那三个实例 ——
 *     列表里 1.12.2 原版的几条挤在一起，界面"全部 1"，
 *     「锁定探针·普通」那一行**根本不存在**，③⑤ 两条红得莫名其妙。
 *
 * ## 量法（踩过的坑，别再犯）
 *
 *   第一版用 `button[aria-label^="<名字>"]` 点版本行 —— **选择器根本不存在**，
 *   于是"两次切换"都没发生，两次量的都是**同一个（第一个）实例**：
 *   ③⑤ 两条红得完全与功能无关。
 *   现在：①先进版本列表并**确认列表在**，②点 `[aria-label="打开 <名字> 的设置"]`
 *   （真的那个节点，`VersionsPage.tsx:704`），③**确认落地页头写的是这个实例**
 *   ——没落地就判"本次测量无效"（退出码 2），绝不把量法错误记成功能缺陷。
 *
 * 用法：
 *   node tools/live/live-pack-lock-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 本次测量无效（探针自己的问题）
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-lock-root');
const OWN = path.join(T, 'ieml-lock-own');
/* ★ 让"老位置"（`%APPDATA%\IEML`）也落在沙盒里，否则启动补齐会把真实数据复制进来 */
const FAKE_APPDATA = path.join(T, 'ieml-lock-appdata');

let pass = 0;
let fail = 0;
let invalid = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 沙盒：两个实例（一个带整合包记录，一个没有） ---------- */
rmSync(ROOT, { recursive: true, force: true });
rmSync(OWN, { recursive: true, force: true });
rmSync(FAKE_APPDATA, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
const MC = path.join(ROOT, '.minecraft');
/*
 * ★ 两个实例必须**各自认领一个盘上版本**：版本列表只列"对得上当前文件夹的实例"
 *   （`domain/folder-versions.ts` 的 `matchFolderVersions`，一对一认领）。
 *   第一版两个实例都是 1.12.2 原版、盘上只有一个 1.12.2 ——
 *   第二个实例被**有意**藏掉（"认领不到的既不删、也不显示"），
 *   于是「锁定探针·普通」那一行不存在，③⑤ 两条红得与锁定逻辑无关。
 */
for (const [mcVersion, id] of [
  ['1.12.2', '1.12.2'],
  ['1.13.2', '1.13.2'],
]) {
  const dir = path.join(MC, 'versions', mcVersion);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
  );
}

const mk = (id, slug, name, mcVersion) => ({
  id,
  mcVersion,
  loader: null,
  addons: [],
  config: {
    name,
    slug,
    isolation: 'on',
    memoryMb: 2048,
    memorySource: 'global',
    javaMode: 'auto',
  },
  createdAt: null,
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});

for (const slug of ['lock-pack', 'lock-plain']) {
  mkdirSync(path.join(ROOT, 'instances', slug, 'game', 'mods'), { recursive: true });
}
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        mk('i-pack', 'lock-pack', '锁定探针·整合包', '1.12.2'),
        mk('i-plain', 'lock-plain', '锁定探针·普通', '1.13.2'),
      ],
      activeId: 'i-pack',
    },
    null,
    2,
  ),
);

/* 只在 lock-pack 里放一份安装记录（格式与后端写的同构） */
writeFileSync(
  path.join(ROOT, 'instances', 'lock-pack', 'pack-record.json'),
  JSON.stringify(
    {
      schema: 1,
      name: '锁定探针包',
      version: '3.2.1',
      source: 'curseforge',
      mc_version: '1.12.2',
      loader_kind: null,
      loader_version: null,
      installed_at: Math.floor(Date.now() / 1000),
      skipped: [],
      files: [{ path: 'mods/作者的.jar', url: 'https://example.invalid/a.jar', sha1: '', size: 3 }],
    },
    null,
    2,
  ),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'locklive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

const pageText = () => ev(`(document.querySelector('main')?.innerText || '')`);

/** 现场快照：只用来解释**为什么**没落地，不参与判据 */
const snapshot = () =>
  ev(`JSON.stringify({
    page: (document.querySelector('main')?.innerText || '').slice(0, 160),
    buttons: [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null).map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 14),
    rows: [...document.querySelectorAll('.ver-item')].map((x) => x.getAttribute('aria-label')).slice(0, 8),
  })`);

/** 回到版本列表（并确认列表真的在：`.ver-item` 出现） */
async function gotoVersionList() {
  for (let i = 0; i < 4; i += 1) {
    if (await ev(`document.querySelectorAll('.ver-item').length > 0`)) return true;
    await ev(`(() => {
      const b =
        [...document.querySelectorAll('button')].find(
          (x) => (x.textContent || '').trim() === '返回版本列表' && x.offsetParent !== null,
        ) ||
        [...document.querySelectorAll('.nav-item')].find((x) => (x.textContent || '').includes('版本列表'));
      b?.click();
      return !!b;
    })()`);
    await sleep(1200);
  }
  return await ev(`document.querySelectorAll('.ver-item').length > 0`);
}

/**
 * 打开某个实例的二级页，并点那一页上的某个按钮（`管理` = Mod 管理，`概览` = 页签）。
 * 返回 `{ landed, text }`：`landed` 才说明**这个实例**的页面真的在前台。
 */
async function openInstanceTab(name, label) {
  if (!(await gotoVersionList())) {
    invalid += 1;
    console.log(`  ⚠ 进不了版本列表。现场：${await snapshot()}`);
    return { landed: false, text: '' };
  }
  /*
   * ★ 版本行是 `div[role=button][aria-label="打开 <名字> 的设置"]`
   *   （`VersionsPage.tsx:704`）—— 不是 `<button>`，也没有"打开设置"这个可见文字
   *   可供兜底（那句在行内菜单里，菜单没展开时不在 DOM 里）。
   */
  const clicked = await ev(`(() => {
    const r = document.querySelector('[aria-label=${JSON.stringify('打开 ' + name + ' 的设置')}]');
    r?.click();
    return !!r;
  })()`);
  if (!clicked) {
    invalid += 1;
    console.log(`  ⚠ 版本列表里找不到「${name}」这一行。现场：${await snapshot()}`);
    return { landed: false, text: '' };
  }
  // 二级页的页头会写"当前实例 <名字>"，等它出现才算落地
  let text = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    text = String(await pageText());
    if (text.includes(name) && text.length > 60) break;
    await sleep(300);
  }
  if (!(text.includes(name) && text.length > 60)) {
    invalid += 1;
    console.log(`  ⚠ 点了「${name}」却没进到它的页面。现场：${await snapshot()}`);
    return { landed: false, text };
  }
  /*
   * ★ 二级页的页签只有 概览 / 设置 / 日志 —— **Mod 管理不在页签里**，
   *   它是概览页「Mod」那一行上的「管理」按钮。
   *   第一版按页签文字找，找不到就什么都没点，于是拿到的红与功能无关。
   */
  await ev(`(() => {
    const t = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === ${JSON.stringify(label)} && x.offsetParent !== null,
    );
    t?.click();
    return !!t;
  })()`);
  /*
   * ★ 也不能"睡固定毫秒"：Mod 列表要重读盘。
   *   Mod 页（`ModsPanel`）的页头写的是"当前实例 <名字> · <mc> · <loader>"，
   *   概览页（`InstanceOverview`）只写名字 —— 所以等的**字符串按页签不同**，
   *   不然概览那一段永远等不到（又变成量法造成的红）。
   */
  const needle = label === '管理' ? `当前实例 ${name}` : name;
  const deadline2 = Date.now() + 15000;
  while (Date.now() < deadline2) {
    text = String(await pageText());
    if (text.includes(needle) && text.length > 60) return { landed: true, text };
    await sleep(300);
  }
  invalid += 1;
  console.log(`  ⚠「${name}」的「${label}」页没渲染完。现场：${await snapshot()}`);
  return { landed: false, text };
}

/** 页面上那个「检查更新」按钮的状态 */
const checkButton = () =>
  ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').includes('检查更新') && x.offsetParent !== null,
    );
    if (!b) return null;
    return { disabled: b.disabled === true, title: (b.getAttribute('aria-disabled') || '') };
  })()`);

/**
 * 等到页面**不再变化**再看判据（连续两次读到同一份文本，且够长）。
 *
 * ★ 这条是必需的：Mod 管理页的页头先画出来，"是不是整合包"那句话要等一次
 *   IPC（`pack.info`）回来才有。判据若在中间态上判，红绿都取决于时序 ——
 *   第二版就是这么红了两条（读到的是没有理由的半页），
 *   而那时 ⑤ 之所以绿，纯属"按钮禁用"恰好在更早的渲染里就已经成立。
 *   稳住之后再看，才等于**用户会看到的样子**。
 */
async function settled(ms = 12000) {
  let prev = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = String(await pageText());
    if (text.length > 120 && text === prev) return text;
    prev = text;
    await sleep(400);
  }
  console.log(`  ⚠ 页面在 ${ms} ms 内没稳定下来（最后读到 ${prev.length} 字）`);
  return prev;
}

try {
  /* ---------- 后端事实先对一遍（免得界面红了却不知道是哪一层） ---------- */
  const packInfo = await inv('pack_info', { slug: 'lock-pack' });
  check(
    packInfo?.name === '锁定探针包' && packInfo?.version === '3.2.1',
    '① 后端读到了安装记录（包名 + 版本）',
    JSON.stringify(packInfo),
  );
  const plainInfo = await inv('pack_info', { slug: 'lock-plain' });
  check(plainInfo === null, '② 对照组：没有记录的实例，后端如实返回 null', JSON.stringify(plainInfo));

  /* ---------- ③④⑤ 有记录的实例：锁住 + 说得出理由 ---------- */
  const pack = await openInstanceTab('锁定探针·整合包', '管理');
  if (pack.landed) {
    const text = await settled();
    check(
      text.includes('由整合包') && text.includes('锁定探针包'),
      '③ Mod 管理页显示"这个实例由整合包管理"，并点了包名',
      text.slice(0, 200),
    );
    check(
      text.includes('3.2.1') && text.includes('新版清单'),
      '④ 理由里带版本号，并说得出出路（作者没提供新版清单）',
      text.slice(0, 260),
    );
    const btn = await checkButton();
    check(
      btn?.disabled === true,
      '⑤ ★「检查更新」按钮**被禁用**（用户点不到 —— 这条才是 ADR-018 ⑥ 的实质）',
      JSON.stringify(btn),
    );
  }

  /* ---------- ⑥⑦ 对照组：普通实例按钮可用、且没有那句理由 ---------- */
  const plain = await openInstanceTab('锁定探针·普通', '管理');
  if (plain.landed) {
    const text2 = await settled();
    const btn2 = await checkButton();
    check(
      btn2 !== null && btn2.disabled === false,
      '⑥ ★ 对照组：不是整合包的实例，按钮**可用**（这条判据不会永远绿）',
      JSON.stringify(btn2),
    );
    check(
      !text2.includes('由整合包'),
      '⑦ 那句"由整合包管理"在普通实例上**不出现**（状态跟着实例走）',
      text2.slice(0, 160),
    );
  }

  /* ---------- ⑧ 概览页也显示来自哪个整合包 ---------- */
  const back = await openInstanceTab('锁定探针·整合包', '概览');
  if (back.landed) {
    const text3 = await settled();
    check(
      text3.includes('锁定探针包') && text3.includes('3.2.1'),
      '⑧ 概览页也显示"来自整合包 锁定探针包 3.2.1"（同一个事实来源）',
      text3.slice(0, 200),
    );
  }
} finally {
  const verdict = invalid > 0 ? '本次测量无效' : fail === 0 ? '全过' : '有不合格项';
  console.log(`\n${verdict}：${pass} 过 / ${fail} 不过${invalid ? ` / ${invalid} 处没落地` : ''}`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(invalid > 0 ? 2 : fail === 0 ? 0 : 1);
}
