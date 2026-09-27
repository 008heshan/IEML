/*
 * 真机判据：**实例备份与回滚**（ADR-014）。
 *
 * ## 为什么这条必须有（而不是只留单测）
 *
 *   备份这个功能的"骗人方式"很特别：**它每次都会成功**。
 *   拷了 0 个文件也叫成功、把一堆 jar 一起拷进去也叫成功、
 *   回滚时把用户的存档删了更叫成功 —— 单测能钉住规则，
 *   但"界面上那个按钮点下去，盘上到底多了什么、少了什么"只有真机能答。
 *
 * ## 判据（四段）
 *
 *   ① **面板真的在实例设置页里**，并且默认写着「启动游戏前自动备份：开」（ADR-014 的默认值）
 *   ② 点界面上的「立即备份」→ 盘上出现 `<own>/backups/<slug>/<id>/backup.json`，
 *      而且**一个 jar 都没有**（ADR-014 的黑线：Mod 只记清单）
 *   ③ 把存档改坏 → 点「回滚」→ 存档**回到备份时的内容**，
 *      同时**多出一份 pre-rollback 快照**（里面有那份坏掉的存档，后悔了能回去）
 *   ④ 备份之后新装的 Mod：回滚时**被移进 mods-extra/ 而不是删掉**，
 *      且清单里有、盘上没有的那个 Mod 会被如实报出来（不假装补齐）
 *
 * ## 沙盒
 *
 *   与其它探针一样：`IEML_DATA_DIR` / `IEML_OWN_DIR` 指到 `%TEMP%` 下的空目录，
 *   并在启动前**手写一份 instances.json + 一个实例目录**（含存档、配置与两个假 jar）——
 *   这样不必真的装一份游戏就能验备份这一层。
 *
 * 用法：
 *   node tools/live/live-backup-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-bak-root');
const OWN = path.join(T, 'ieml-bak-own');
const SLUG = 'bak-probe';
const NAME = '备份探针';
const GAME_DIR = '.minecraft';

const GAME = path.join(ROOT, 'instances', SLUG, 'game');
const BACKUPS = path.join(OWN, 'backups', SLUG);

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 沙盒：一份能让界面列出、能备份的实例 ---------- */
for (const d of [ROOT, OWN]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(GAME, 'saves', 'World1'), { recursive: true });
mkdirSync(path.join(GAME, 'config'), { recursive: true });
mkdirSync(path.join(GAME, 'mods'), { recursive: true });
mkdirSync(OWN, { recursive: true });
/*
 * ★ 还要**在共享目录里放一份版本**：版本列表列的是"**这个文件夹里有什么**"
 *   （PCL 同款口径），实例只有认领到盘上的版本才会出现在列表里
 *   （认领规则见 `src/domain/folder-versions.ts`：mcVersion 相同 + "是不是加载器版本"相同）。
 *   第一版探针只写了 instances.json，于是列表显示"这个文件夹里没有可用的版本" ——
 *   备份面板也就没机会出现。★ 这同样属于"量法错了"。
 */
const VER_DIR = path.join(ROOT, GAME_DIR, 'versions', '1.20.1');
mkdirSync(VER_DIR, { recursive: true });
writeFileSync(
  path.join(VER_DIR, '1.20.1.json'),
  JSON.stringify({ id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [] }),
);
writeFileSync(path.join(VER_DIR, '1.20.1.jar'), Buffer.alloc(1024, 3));
writeFileSync(path.join(GAME, 'saves', 'World1', 'level.dat'), 'LEVEL-V1');
writeFileSync(path.join(GAME, 'config', 'jei.toml'), 'config-v1');
writeFileSync(path.join(GAME, 'options.txt'), 'lang:zh_cn\n');
writeFileSync(path.join(GAME, 'mods', 'jei.jar'), Buffer.alloc(4096, 7));
writeFileSync(path.join(GAME, 'mods', 'sodium.jar'), Buffer.alloc(8192, 9));
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-bak',
          mcVersion: '1.20.1',
          loader: null,
          addons: [],
          config: {
            name: NAME,
            slug: SLUG,
            /*
             * ★ 这里是 `auto`（不是 `isolated`）：实例隔离是三档 `auto / on / off`
             *   （Rust 侧 `IsolationMode`，serde 原样读字符串）。第一版探针随手写了
             *   `isolated`，启动器当场如实报「实例列表损坏：unknown variant」并把这一页
             *   显示成空的 —— **量法错了，量出来的红跟功能无关**。
             *   （那条错误信息本身是对的，见 AppContext 的列表损坏处理。）
             */
            isolation: 'auto',
            memoryMb: 2048,
            memorySource: 'global',
            javaMode: 'auto',
          },
          createdAt: null,
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      activeId: 'i-bak',
    },
    null,
    2,
  ),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'baklive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

/** 盘上这一层的真话：所有备份目录（新的在前） */
const onDisk = () => {
  if (!existsSync(BACKUPS)) return [];
  return readdirSync(BACKUPS)
    .filter((d) => existsSync(path.join(BACKUPS, d, 'backup.json')))
    .map((id) => {
      const dir = path.join(BACKUPS, id);
      const man = JSON.parse(readFileSync(path.join(dir, 'backup.json'), 'utf8'));
      const jars = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.toLowerCase().endsWith('.jar')) jars.push(p);
        }
      };
      walk(dir);
      return { id, man, dir, jars };
    })
    .sort((a, b) => Number(b.id.split('-')[0]) - Number(a.id.split('-')[0]));
};

/** 按文字点一个按钮（默认只找可见的） */
const clickByText = (text, { nth = 0, scope = 'body' } = {}) =>
  ev(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
    const all = [...root.querySelectorAll('button')].filter(
      (b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}) && b.offsetParent !== null,
    );
    const b = all[${nth}];
    if (!b) return { clicked: false, found: all.length };
    b.click();
    return { clicked: true, found: all.length, text: (b.textContent || '').trim() };
  })()`);

/** 页面上有没有这句话（用来判"卡片/开关真的渲染了"） */
const hasText = (t) => ev(`(document.body.innerText || '').includes(${JSON.stringify(t)})`);

try {
  console.log('【① 实例设置页里真的有「备份与回滚」，且默认是开】');
  await clickNav(ev, '版本列表');
  await sleep(2000);
  // 这一行是用户最常操作的地方：先点它的「更多操作」，再进「打开设置」
  const openedMenu = await ev(`(() => {
    const b = document.querySelector('button[aria-label^=${JSON.stringify(NAME)}]');
    if (!b) return { ok: false, labels: [...document.querySelectorAll('button[aria-label]')].map((x) => x.getAttribute('aria-label')).slice(0, 12) };
    b.click();
    return { ok: true };
  })()`);
  await sleep(800);
  const menuClick = await clickByText('打开设置');
  console.log(`  点更多操作：${JSON.stringify(openedMenu)}  点「打开设置」：${JSON.stringify(menuClick)}`);
  await sleep(2500);
  /*
   * ★ 「打开设置」落在实例的**概览**页，页面里还有 概览 / 设置 / 日志 三个页签 ——
   *   备份卡在「设置」那一页里。这一步不能省：第一版探针直接找卡片，
   *   于是在概览页上什么都没找到，报了一个跟功能无关的红。
   */
  const tabClick = await ev(`(() => {
    const all = [...document.querySelectorAll('button')];
    /*
     * ★ 用「概览」当锚点找页签栏，而不是按类名猜：
     *   侧栏里也有一个「设置」，按文字找会点错；而「概览」只有这一个地方有。
     */
    const overview = all.find((b) => (b.textContent || '').trim() === '概览');
    if (!overview) return { clicked: false, reason: '没有「概览」页签' };
    const bar = overview.parentElement;
    const settings = [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '设置');
    settings?.click();
    return {
      clicked: !!settings,
      bar: bar.className,
      tabs: [...bar.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
    };
  })()`);
  console.log('  点「设置」页签：' + JSON.stringify(tabClick));
  await sleep(2500);

  const panelThere = await hasText('备份与回滚');
  const rangeThere = await hasText('备份范围');
  const autoOn = await ev(`(() => {
    const seg = [...document.querySelectorAll('.seg[aria-label="启动前自动备份"] button')];
    return seg.map((b) => ({ t: (b.textContent || '').trim(), on: b.getAttribute('aria-pressed') === 'true' }));
  })()`);
  console.log(`  面板：「备份与回滚」=${panelThere} 「备份范围」=${rangeThere}  开关=${JSON.stringify(autoOn)}`);
  check(panelThere && rangeThere, '★ 备份与回滚卡片出现在实例设置页', `备份与回滚=${panelThere} 备份范围=${rangeThere}`);
  check(
    Array.isArray(autoOn) && autoOn.some((x) => x.t === '开' && x.on),
    '★ 默认是「启动游戏前自动备份：开」（ADR-014 的默认值）',
    JSON.stringify(autoOn),
  );

  console.log('\n【② 点「立即备份」→ 盘上真的多了一份，且没有 jar】');
  const before = onDisk();
  const createClick = await clickByText('立即备份');
  await sleep(6000);
  const after = onDisk();
  console.log(`  点「立即备份」：${JSON.stringify(createClick)}  备份份数 ${before.length} → ${after.length}`);
  check(after.length === before.length + 1, '★ 备份真的做了（盘上多一份）', `${after.length} 份`);
  const first = after[0];
  check(!!first, '★ 备份里有 backup.json 清单');
  if (first) {
    console.log(`  这份备份：id=${first.id} 理由=${first.man.reason} 体积=${first.man.total_bytes} B Mod=${first.man.mods.length} 个`);
    check(first.man.reason === '手动', '★ 手动备份的理由如实写成「手动」', first.man.reason);
    check(first.jars.length === 0, '★★ 备份里一个 jar 都没有（ADR-014 的黑线：Mod 只记清单）', `${first.jars.length} 个 jar`);
    check(first.man.mods.length === 2, '★ 两个 Mod 只登记了清单（名字 + SHA1）', `${first.man.mods.length} 条`);
    const savedLevel = readFileSync(path.join(first.dir, 'saves', 'World1', 'level.dat'), 'utf8');
    check(savedLevel === 'LEVEL-V1', '★ 存档本身进了备份', savedLevel);
  }
  const timelineRow = await ev(`(document.body.innerText || '').match(/手动 ·[^\\n]*/)?.[0] ?? null`);
  console.log('  界面上那条时间线：' + JSON.stringify(timelineRow));

  console.log('\n【③ 把存档改坏 → 点「回滚」→ 存档回到备份时的内容】');
  writeFileSync(path.join(GAME, 'saves', 'World1', 'level.dat'), 'LEVEL-BROKEN');
  const restoreClick = await clickByText('回滚');
  await sleep(1200);
  // 应用自己的确认弹窗（不是 window.confirm）：在弹窗里点那个「回滚」
  const confirmClick = await ev(`(() => {
    const modals = [...document.querySelectorAll('[role="dialog"]')];
    const last = modals[modals.length - 1];
    if (!last) return { ok: false, reason: '没有确认弹窗' };
    const btn = [...last.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '回滚');
    if (!btn) return { ok: false, reason: '弹窗里没有「回滚」按钮', text: (last.innerText || '').slice(0, 160) };
    btn.click();
    return { ok: true, text: (last.innerText || '').slice(0, 200) };
  })()`);
  console.log(`  点「回滚」：${JSON.stringify(restoreClick)}  确认弹窗：${JSON.stringify(confirmClick)}`);
  await sleep(6000);
  const levelNow = readFileSync(path.join(GAME, 'saves', 'World1', 'level.dat'), 'utf8');
  check(levelNow === 'LEVEL-V1', '★★ 回滚之后存档回到备份时的内容', levelNow);

  const list3 = onDisk();
  const pre = list3.find((b) => b.man.reason === '回滚前自动');
  console.log(`  现在的备份：${JSON.stringify(list3.map((b) => [b.id, b.man.reason]))}`);
  check(!!pre, '★★ 回滚前自动存了一份（pre-rollback 快照）', pre ? pre.id : '没有');
  if (pre) {
    const preLevel = readFileSync(path.join(pre.dir, 'saves', 'World1', 'level.dat'), 'utf8');
    check(preLevel === 'LEVEL-BROKEN', '★★ 那份快照里是**回滚之前**的状态（还能回去）', preLevel);
  }

  console.log('\n【④ 多的 Mod 移走不删；缺的 Mod 如实报出来】');
  // 备份之后：新装一个 Mod、删掉一个老 Mod
  writeFileSync(path.join(GAME, 'mods', 'create.jar'), Buffer.alloc(2048, 1));
  rmSync(path.join(GAME, 'mods', 'sodium.jar'));
  const target = list3.find((b) => b.man.reason === '手动');
  if (target) {
    /*
     * ★ 回滚**那一行**（不是"页面上第一个回滚按钮"）：时间线是新的在前，
     *   而这时候最新的一份是上一段留下的 pre-rollback 快照 ——
     *   点错那一行，验的就不是"手动备份"这一份了。
     */
    const clickedRow = await ev(`(() => {
      /*
       * ★ 认「时间线那一行」的判据是 \`手动 ·\`（带分隔点）：
       *   上一版只查"含手动"两个字，结果命中了**自动备份开关那一行** ——
       *   它的说明文字里恰好有"只有手动备份了"。行选错 → 按钮点不到 → 假红。
       */
      const row = [...document.querySelectorAll('.field-row')].find((r) =>
        (r.innerText || '').includes('手动 ·'));
      const btn = row ? [...row.querySelectorAll('button')].find((b) => (b.textContent || '').includes('回滚')) : null;
      btn?.click();
      return { row: (row?.innerText || '').slice(0, 60), clicked: !!btn };
    })()`);
    console.log('  点「手动」那一行的回滚：' + JSON.stringify(clickedRow));
    await sleep(1000);
    await ev(`(() => {
      const modals = [...document.querySelectorAll('[role="dialog"]')];
      const last = modals[modals.length - 1];
      const btn = [...(last?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === '回滚');
      btn?.click();
      return !!btn;
    })()`);
    await sleep(6000);
    const moved = existsSync(path.join(target.dir, 'mods-extra', 'create.jar'));
    const stillThere = existsSync(path.join(GAME, 'mods', 'create.jar'));
    console.log(`  create.jar：在 mods-extra/=${moved}  还在 mods/=${stillThere}`);
    check(moved && !stillThere, '★★ 多出来的 Mod 被移进 mods-extra/（没删、也不在 mods/ 里了）');
    const report = await ev(`(document.body.innerText || '').includes('需要你自己重新获取')`);
    console.log('  界面上的回滚报告提到了缺的 Mod：' + JSON.stringify(report));
    check(report === true, '★ 缺的 Mod 被如实报出来（不假装补齐）', String(report));
  } else {
    check(false, '找得到那份「手动」备份（第 ④ 段要用它）');
  }
} finally {
  /*
   * ★★ 只收自己那棵进程树：`lib/cdp.mjs` 的 `close()` 内部按进程名全杀，
   *   会把用户那份启动器一起收掉（本探针要能与它并存）。
   */
  try {
    ws.close();
  } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
}

console.log(`\n${fail === 0 ? `✓ 备份与回滚判据全过（${pass} 条）` : `✗ ${fail} / ${pass + fail} 条不成立`}`);
console.log(`（沙盒留在 ${ROOT} 与 ${OWN}，可手动删）`);
process.exit(fail === 0 ? 0 : 1);
