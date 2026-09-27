/*
 * 真机判据：**导入别的启动器的数据**（官方 / PCL2 / HMCL / Prism-MultiMC）。
 *
 * ## 为什么这条必须有
 *
 *   老玩家换启动器时手上是一整个 `.minecraft`：存档、Mod、配置全在里面，
 *   而"自己在文件管理器里拷"是最容易出错的一步 —— 拷错层、拷漏、
 *   或者把新启动器里已有的存档覆盖掉。这件事只有真机答得了：
 *
 *   * 认得对不对（认成"PCL 的目录"还是"一个普通文件夹"）？
 *   * 搬的是**哪一层**（Prism 实例的游戏目录在它里面的 `minecraft/`）？
 *   * 目标里已有的同名文件**有没有被顶掉**？
 *   * 游戏本体（`versions/` `libraries/` `assets`）有没有被白搬过来几个 GB？
 *   * 源目录（用户原来那套）有没有被动过一个字节？
 *
 * ## 判据（八段）
 *
 *   ① 五种形状各认对：官方 / PCL2（含版本隔离那一层）/ HMCL / Prism / 认不出
 *   ② 游戏目录是**哪一层**（Prism 认到 `minecraft/`、官方认到 `.minecraft/`）
 *   ③ PCL 的"版本隔离"那一层被列出来（`versions/<版本>` 里的存档）
 *   ④ 导入：能搬的都搬过去，**同名不覆盖**，源目录一个文件都没少
 *   ⑤ 从"版本隔离"那一层导入：只搬那一层的东西
 *   ⑥ 导入前那份备份真的做了（ADR-014）
 *   ⑦ 游戏本体**没有**被搬过来（那是同一份官方文件，搬了白占几个 GB）
 *   ⑧ 界面：把一个游戏目录**拖进窗口**会弹出导入窗（说清来源与依据），点导入真的会复制
 *
 * 用法：
 *   node tools/live/live-import-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-imp-root');
const OWN = path.join(T, 'ieml-imp-own');
const EXT = path.join(T, 'ieml-imp-ext');
const MC = path.join(ROOT, '.minecraft');
const SLUG = 'imp-target';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ====================== 沙盒 ====================== */

for (const d of [ROOT, OWN, EXT]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
const game = (slug) => path.join(ROOT, 'instances', slug, 'game');

/* 目标实例：自己的 game/ 里已经有一个**同名** Mod（验"不覆盖"） */
mkdirSync(path.join(game(SLUG), 'mods'), { recursive: true });
mkdirSync(path.join(game(SLUG), 'saves'), { recursive: true });
writeFileSync(path.join(game(SLUG), 'mods', 'shared-name.jar'), 'MINE-ALREADY');
writeFileSync(path.join(game(SLUG), 'saves', 'kept.txt'), 'KEEP');

/* 版本目录（版本列表只列认领得到的版本） */
const VER = path.join(MC, 'versions', '1.12.2');
mkdirSync(VER, { recursive: true });
writeFileSync(
  path.join(VER, '1.12.2.json'),
  JSON.stringify({ id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);

writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-imp',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '导入探针·目标',
            slug: SLUG,
            // ★ 强制隔离：这样"搬到哪儿"是确定的（instance 自己的 game/）
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
      activeId: 'i-imp',
    },
    null,
    2,
  ),
);
writeFileSync(path.join(OWN, 'prefs.json'), JSON.stringify({ globalIsolation: 'isolated', autoBackup: true }));

/* ---------- 五种外部目录 ---------- */

/* ① 官方启动器：`<选中的目录>/.minecraft` 才是游戏目录 */
const OFFICIAL = path.join(EXT, '官方启动器');
mkdirSync(path.join(OFFICIAL, '.minecraft', 'saves', 'WorldA'), { recursive: true });
mkdirSync(path.join(OFFICIAL, '.minecraft', 'mods'), { recursive: true });
mkdirSync(path.join(OFFICIAL, '.minecraft', 'versions', '1.20.1'), { recursive: true });
mkdirSync(path.join(OFFICIAL, '.minecraft', 'libraries'), { recursive: true });
writeFileSync(path.join(OFFICIAL, '.minecraft', 'launcher_profiles.json'), '{}');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'saves', 'WorldA', 'level.dat'), 'SAVE-OFFICIAL');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'mods', 'official.jar'), 'MOD-OFFICIAL');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'mods', 'shared-name.jar'), 'FROM-OFFICIAL');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'options.txt'), 'lang:en_us\n');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'versions', '1.20.1', '1.20.1.json'), '{}');
writeFileSync(path.join(OFFICIAL, '.minecraft', 'libraries', 'big.jar'), 'X'.repeat(1024));

/* ② PCL2：`PCL/` 目录是身份证；另外有一个"版本隔离"后的版本目录 */
const PCL = path.join(EXT, 'PCL2');
mkdirSync(path.join(PCL, 'PCL'), { recursive: true });
mkdirSync(path.join(PCL, 'saves'), { recursive: true });
mkdirSync(path.join(PCL, 'versions', '1.20.1-Forge', 'saves', 'ForgeWorld'), { recursive: true });
mkdirSync(path.join(PCL, 'versions', '1.20.1-Forge', 'mods'), { recursive: true });
writeFileSync(path.join(PCL, 'saves', 'RootWorld.dat'), 'SAVE-PCL-ROOT');
writeFileSync(path.join(PCL, 'versions', '1.20.1-Forge', 'saves', 'ForgeWorld', 'level.dat'), 'SAVE-PCL-FORGE');
writeFileSync(path.join(PCL, 'versions', '1.20.1-Forge', 'mods', 'forge.jar'), 'MOD-PCL-FORGE');

/* ③ HMCL：`.hmcl.json` 是身份证 */
const HMCL = path.join(EXT, 'HMCL');
mkdirSync(path.join(HMCL, 'mods'), { recursive: true });
writeFileSync(path.join(HMCL, '.hmcl.json'), '{}');
writeFileSync(path.join(HMCL, 'mods', 'hmcl.jar'), 'MOD-HMCL');

/* ④ Prism 实例：游戏目录在它里面的 `minecraft/` */
const PRISM = path.join(EXT, 'Prism实例');
mkdirSync(path.join(PRISM, 'minecraft', 'saves', 'PrismWorld'), { recursive: true });
writeFileSync(path.join(PRISM, 'instance.cfg'), 'name=Prism\n');
writeFileSync(path.join(PRISM, 'mmc-pack.json'), '{}');
writeFileSync(path.join(PRISM, 'minecraft', 'saves', 'PrismWorld', 'level.dat'), 'SAVE-PRISM');

/* ⑤ 只有游戏本体、没有数据：认不出来（不许假装能导入） */
const EMPTY = path.join(EXT, '只有游戏本体');
mkdirSync(path.join(EMPTY, 'versions', '1.20.1'), { recursive: true });
mkdirSync(path.join(EMPTY, 'libraries'), { recursive: true });
mkdirSync(path.join(EMPTY, 'assets'), { recursive: true });

/* ⑥ 一个普普通通的游戏目录（没有任何启动器标记） */
const GENERIC = path.join(EXT, '别人给的.minecraft');
mkdirSync(path.join(GENERIC, 'saves', 'GenericWorld'), { recursive: true });
writeFileSync(path.join(GENERIC, 'saves', 'GenericWorld', 'level.dat'), 'SAVE-GENERIC');

/* ====================== 开跑 ====================== */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'implive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

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
const namesOf = (items) => (items ?? []).map((i) => i.name).sort();

try {
  /* ---------- ① 五种形状各认对 ---------- */
  const scanOfficial = await inv('scan_external_launcher', { path: OFFICIAL });
  const scanPcl = await inv('scan_external_launcher', { path: PCL });
  const scanHmcl = await inv('scan_external_launcher', { path: HMCL });
  const scanPrism = await inv('scan_external_launcher', { path: PRISM });
  const scanEmpty = await inv('scan_external_launcher', { path: EMPTY });
  const scanGeneric = await inv('scan_external_launcher', { path: GENERIC });

  check(scanOfficial?.launcher === 'official', '① 官方启动器认出来了', String(scanOfficial?.launcher ?? scanOfficial?.__err));
  check(scanPcl?.launcher === 'pcl', '① PCL2 认出来了', String(scanPcl?.launcher));
  check(scanHmcl?.launcher === 'hmcl', '① HMCL 认出来了', String(scanHmcl?.launcher));
  check(scanPrism?.launcher === 'prism', '① Prism / MultiMC 实例认出来了', String(scanPrism?.launcher));
  check(
    scanGeneric?.launcher === 'generic',
    '① 没有任何标记、但有游戏数据的目录也认（"别人给的 .minecraft"）',
    String(scanGeneric?.launcher),
  );
  check(
    scanOfficial?.evidence?.length > 0 && String(scanOfficial.evidence[0]).includes('launcher_profiles.json'),
    '① 判定要给得出依据（盘上看见了什么）',
    JSON.stringify(scanOfficial?.evidence),
  );

  /* ---------- ② 游戏目录是哪一层 ---------- */
  check(
    scanOfficial?.game_dir === path.join(OFFICIAL, '.minecraft'),
    '② 官方：游戏目录在选中的目录里面的 .minecraft',
    String(scanOfficial?.game_dir),
  );
  check(
    scanPrism?.game_dir === path.join(PRISM, 'minecraft'),
    '② Prism：游戏目录在实例目录里面的 minecraft/',
    String(scanPrism?.game_dir),
  );
  check(scanPcl?.game_dir === PCL, '② PCL：选中的就是游戏目录本身', String(scanPcl?.game_dir));

  /* ---------- ③ 版本隔离那一层 ---------- */
  check(
    Array.isArray(scanPcl?.version_layers) && scanPcl.version_layers.length === 1,
    '③ PCL 的"版本隔离"目录被单独列出来',
    JSON.stringify(scanPcl?.version_layers?.map((l) => l.key)),
  );
  check(
    namesOf(scanPcl?.version_layers?.[0]?.items).join(',') === 'mods,saves',
    '③ 那一层里能搬什么也列清楚了',
    JSON.stringify(scanPcl?.version_layers?.[0]?.items),
  );

  /* ---------- 认不出来的：如实说，且**没有**可搬的东西 ---------- */
  check(scanEmpty?.launcher === 'unknown', '① 只有游戏本体的目录：认不出来（不假装能导入）', String(scanEmpty?.launcher));
  check(
    Array.isArray(scanEmpty?.items) && scanEmpty.items.length === 0,
    '① 并且一项都不列（搬 0 个文件还说成功，是最坏的假话）',
  );

  /* ---------- ④ 导入根那一层 ---------- */
  const officialSource = filesIn(path.join(OFFICIAL, '.minecraft'));
  const imported = await inv('import_external_data', {
    path: OFFICIAL,
    slug: SLUG,
    layer: '',
    backupFirst: true,
  });
  check(
    namesOf(imported?.copied).join(',') === 'mods,options.txt,saves',
    '④ 存档 / Mod / 配置都复制过来了',
    JSON.stringify(imported?.copied ?? imported?.__err),
  );
  check(
    existsSync(path.join(game(SLUG), 'saves', 'WorldA', 'level.dat')) &&
      existsSync(path.join(game(SLUG), 'mods', 'official.jar')),
    '④ 它们真的落在目标的游戏目录里',
    JSON.stringify(filesIn(game(SLUG))),
  );
  check(
    imported?.skipped_existing?.some((s) => s.includes('shared-name.jar')),
    '④ 目标里已有的同名文件被**跳过**（没有覆盖）',
    JSON.stringify(imported?.skipped_existing),
  );
  check(
    readFileSync(path.join(game(SLUG), 'mods', 'shared-name.jar'), 'utf8') === 'MINE-ALREADY',
    '④ 那个同名文件的内容**原样没动**',
  );
  check(readFileSync(path.join(game(SLUG), 'saves', 'kept.txt'), 'utf8') === 'KEEP', '④ 目标里别的东西也没被动');
  check(
    filesIn(path.join(OFFICIAL, '.minecraft')).length === officialSource.length,
    '④ 源目录（用户原来那套）**一个文件都没少**',
    `${officialSource.length} → ${filesIn(path.join(OFFICIAL, '.minecraft')).length}`,
  );

  /* ---------- ⑤ 从"版本隔离"那一层导入 ---------- */
  const beforeForge = filesIn(game(SLUG)).length;
  const layerImport = await inv('import_external_data', {
    path: PCL,
    slug: SLUG,
    layer: '1.20.1-Forge',
    backupFirst: false,
  });
  check(
    namesOf(layerImport?.copied).join(',') === 'mods,saves',
    '⑤ 从版本目录那一层导入（只搬那一层的东西）',
    JSON.stringify(layerImport?.copied ?? layerImport?.__err),
  );
  check(
    existsSync(path.join(game(SLUG), 'mods', 'forge.jar')) &&
      !existsSync(path.join(game(SLUG), 'RootWorld.dat')),
    '⑤ 那一层的 Mod 进来了，根目录那份**没有**被顺手带进来',
    `${beforeForge} → ${filesIn(game(SLUG)).length}`,
  );

  /* ---------- ⑥ 备份 ---------- */
  check(
    typeof imported?.backup_id === 'string' && imported.backup_id.length > 0,
    '⑥ 导入前那份备份真的做了（ADR-014 的后悔药）',
    String(imported?.backup_id),
  );
  check(
    existsSync(path.join(OWN, 'backups', SLUG, String(imported?.backup_id), 'backup.json')),
    '⑥ 备份清单落在盘上',
  );

  /* ---------- ⑦ 游戏本体没有被搬过来 ---------- */
  const target = filesIn(game(SLUG));
  check(
    !target.some((f) => f.startsWith('versions/') || f.startsWith('libraries/') || f.startsWith('assets/')),
    '⑦ 游戏本体（versions / libraries / assets）**没有**被搬过来（那是同一份官方文件）',
    JSON.stringify(target.slice(0, 8)),
  );
  check(
    !(imported?.copied ?? []).some((c) => ['versions', 'libraries', 'assets'].includes(c.name)),
    '⑦ 导入报告里也不会把它们算成"已导入"',
    JSON.stringify(namesOf(imported?.copied)),
  );

  /* ---------- ⑧ 界面：拖一个游戏目录进来 → 弹出导入窗 ---------- */
  await ev(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
      event: 'tauri://drag-drop',
      payload: { type: 'drop', paths: [HMCL], position: { x: 400, y: 300 } },
    })}).then(()=>true).catch((e)=>String(e))`,
  );
  // 等弹窗出现（提示是异步来的：要先扫一遍目录）
  let modalTitle = '';
  let modalText = '';
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    modalTitle = String(await ev(`(document.querySelector('.modal .modal-title')?.textContent || '')`));
    if (modalTitle.includes('导入')) break;
  }
  modalText = String(await ev(`(document.querySelector('.modal')?.innerText || '')`));
  check(
    modalTitle.includes('导入别的启动器'),
    '⑧ 把一个游戏目录拖进窗口 → 弹出导入窗（而不是说"没有能装的文件"）',
    modalTitle,
  );
  check(
    modalText.includes('HMCL') && modalText.includes('.hmcl.json'),
    '⑧ 弹窗里说清了"这是谁的目录"以及依据',
    modalText.slice(0, 180),
  );
  /*
   * ★ 列表的粒度是**条目**（`mods` / `saves` / `options.txt`），不是每一个文件 ——
   *   一个几百个 Mod 的目录列成几百行没法看。所以判据看的是条目名与文件数。
   */
  check(
    modalText.includes('mods') && /\d+ 个文件/.test(modalText),
    '⑧ 也列出了能搬什么（条目 + 文件数）',
    modalText.slice(0, 240),
  );

  // 点导入：真的会复制，并且**源目录不动**
  const hmclBefore = filesIn(HMCL);
  await ev(`(() => {
    const b = [...document.querySelectorAll('.modal .modal-foot button')].find(
      (x) => (x.textContent || '').includes('导入到'),
    );
    b?.click();
    return !!b;
  })()`);
  await sleep(3000);
  check(existsSync(path.join(game(SLUG), 'mods', 'hmcl.jar')), '⑧ 点「导入」之后文件真的复制过来了');
  check(
    filesIn(HMCL).length === hmclBefore.length,
    '⑧ 而且源目录（HMCL 那套）一个文件都没少',
    `${hmclBefore.length} → ${filesIn(HMCL).length}`,
  );
  const toastText = String(
    await ev(`[...document.querySelectorAll('.toast')].map((t) => (t.innerText || '')).join(' | ')`),
  );
  check(
    toastText.includes('已导入') && toastText.includes('没有删'),
    '⑧ 提示里如实说了"导入了几个文件"与"原目录没有删"',
    toastText.slice(0, 200),
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
