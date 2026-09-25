/**
 * 真机验证：**版本列表读的是"当前文件夹"，不是账本**（PCL 的文件夹逻辑）
 * ------------------------------------------------------------------
 * 用户（给了两张 PCL 截图）：「你看 PCL，就是像换了个文件夹去读游戏版本，可以无缝切换」。
 *
 * ★ 这支探针**自带数据**，不依赖这台机器上恰好有几个版本：
 *   自己造三个文件夹 ——「老根目录」(3 个版本，正好对上账本里那三个实例)、
 *   「PCL 文件夹」(3 个版本，其中 `1.21.4` 账本里没有)、「空文件夹」。
 *
 * ★ 切根目录**全程走界面**（点弹窗里的「用这个」）：直接调 `set_data_root` 的话
 *   前端不会刷新，量到的是旧数据 —— 这一轮就因此红过一次（是探针的错，不是代码的错）。
 *
 * ★ 记账文件（`%APPDATA%\IEML\datadir.txt`）是全局状态：**开跑前记下原值、跑完写回原值**。
 *
 * 判据（九条）：
 *   ① 换到"PCL 文件夹"后，列表 = 那个文件夹里的三份版本（含账本里没有的 1.21.4）
 *   ② 不在这个文件夹里的条目**不显示**（账本原样保留）
 *   ③ 计数三处一致（页头 / 侧栏角标 / 筛选"全部 N"）
 *   ④ 空文件夹时三处都归零，且空状态在位、一行都不列
 *   ⑤ 直接指 `.minecraft` 会被提到上一级，并在返回里说明（`normalized_from`）
 *   ⑥ 从界面换回老根目录后，列表当场变成那个文件夹的版本
 *   ⑦ 记账文件最后回到**原值**
 *   ⑧ 启动页也按文件夹（空文件夹时它也说"还没有可启动的版本"、不列任何版本）
 *   ⑨ 版本列表上有按钮「新建/切换游戏目录」，且旧的那段描述已删掉
 *
 * 用法：node tools/live/probe-versions-read-folder.mjs "<exe>"
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, invokeOn, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const APPDATA = process.env.APPDATA ?? '';
const RECORD = path.join(APPDATA, 'IEML', 'datadir.txt');
const KNOWN = path.join(APPDATA, 'IEML', 'known-roots.json');

const TMP = process.env.TEMP ?? '.';
const OLD_ROOT = path.join(TMP, 'ieml-old-root');
const SANDBOX = path.join(TMP, 'ieml-pcl-folder');
const MC = path.join(SANDBOX, '.minecraft');
const EMPTY = path.join(TMP, 'ieml-empty-folder');

/* ---------- 全局状态：记下原值，跑完写回 ---------- */
const knownBackup = existsSync(KNOWN) ? readFileSync(KNOWN, 'utf8') : null;
const recordBackup = existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : null;
writeFileSync(RECORD, OLD_ROOT + '\n'); // 让应用从"老根目录"起来
const restoreRecord = () => {
  if (recordBackup !== null) writeFileSync(RECORD, recordBackup);
  else rmSync(RECORD, { force: true });
};

const mkVersion = (root, dirName, json) => {
  const d = path.join(root, '.minecraft', 'versions', dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `${dirName}.json`), JSON.stringify(json));
};
const seedRoot = (root, dirs) => {
  rmSync(root, { recursive: true, force: true });
  /* ★ 先把这个根目录本身建出来 —— 一个版本都没有时也要存在，
     否则弹窗里那一行会显示「找不到这个目录」，只有一个「移除」按钮（探针第一版就踩了这个） */
  mkdirSync(path.join(root, '.minecraft', 'versions'), { recursive: true });
  for (const d of dirs) {
    if (d.inherits) {
      mkVersion(root, d.dir, {
        id: d.dir,
        inheritsFrom: d.inherits,
        mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      });
    } else {
      mkVersion(root, d.dir, { id: d.dir, mainClass: 'net.minecraft.client.main.Main' });
    }
  }
};

/* 老根目录：三个版本，正好对上账本里那三个实例 */
seedRoot(OLD_ROOT, [
  { dir: '26.2' },
  { dir: 'fabric-loader-0.19.5-26.2', inherits: '26.2' },
  { dir: '1.12.2' },
]);
/* "PCL 文件夹"：两个能对上 + 一个账本里没有的（1.21.4） */
seedRoot(SANDBOX, [
  { dir: '26.2' },
  { dir: 'fabric-loader-0.19.5-26.2', inherits: '26.2' },
  { dir: '1.21.4' },
]);
/* 空文件夹 */
seedRoot(EMPTY, []);

writeFileSync(KNOWN, JSON.stringify({ roots: [OLD_ROOT, SANDBOX, EMPTY] }, null, 2));

/* ---------- 页面小工具 ---------- */
const bodyText = (ev) => ev('document.body.innerText');
const header = (ev) =>
  ev(`(() => { const el = document.querySelector('.page-desc'); return el ? el.innerText : ''; })()`);
const visibleRows = (ev) =>
  ev(
    `[...document.querySelectorAll('.ver-item')].map((r) => (r.querySelector('.ver-title-name')||{}).textContent || '')`,
  );
const counts = (ev) =>
  ev(
    `(() => {
       const head = (document.querySelector('.page-desc') || {}).innerText || '';
       const badge = (document.querySelector('.nav-item .nav-badge') || {}).textContent || '';
       const seg = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
         .find((t) => t.startsWith('全部')) || '';
       return { head: head.trim(), badge: badge.trim(), seg };
     })()`,
  );
const clickByText = (ev, sel, text) =>
  ev(
    `(() => {
       const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
         .find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
       if (!el) return false;
       el.click();
       return true;
     })()`,
  );
const clickRowUse = (ev, needle) =>
  ev(
    `(() => {
       const row = [...document.querySelectorAll('.droot-row')]
         .find((r) => (r.textContent || '').includes(${JSON.stringify(needle)}));
       if (!row) return false;
       const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').includes('用这个'));
       if (!btn) return false;
       btn.click();
       return true;
     })()`,
  );
/** 弹窗里的行（给"找不到那一行"时打印用） */
const pickerRows = (ev) =>
  ev(
    `[...document.querySelectorAll('.droot-row')].map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80))`,
  );
/** 走界面换根目录（先回版本列表 → 点右上角那个按钮 → 弹窗里点「用这个」） */
async function switchRootViaUi(ev, needle) {
  /* ★ 那个按钮在**版本列表**页上：先切回去（否则在启动页上点不到它 —— 探针踩过） */
  await clickNav(ev, '版本列表');
  await sleep(800);
  await clickByText(ev, 'button', '新建/切换游戏目录');
  /* 等弹窗与被列出来（列表是异步拉的，固定 sleep 会偶发"还没出来"） */
  let ok = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    ok = await clickRowUse(ev, needle);
    if (ok) break;
  }
  if (!ok) {
    console.log('   ⚠ 弹窗里没找到含「' + needle + '」的行，弹窗现在列的是：');
    console.log('     ' + JSON.stringify(await pickerRows(ev)));
  }
  await sleep(2600); // 等 set_data_root + reloadAfterRootChange（含重扫文件夹）
  return ok;
}

await killIeml();
const app = await launch({ exe: EXE, tag: 'pclfolder', settleMs: 3800 });
const ev = app.ev;

/* ---------- ① ② ③ 换到"PCL 文件夹"（走界面） ---------- */
await clickNav(ev, '版本列表');
await sleep(1200);
const opened = await switchRootViaUi(ev, 'ieml-pcl-folder');
await clickNav(ev, '版本列表');
await sleep(1400);
const rows = await visibleRows(ev);
const txt = await bodyText(ev);
const cnt3 = await counts(ev);
const has1214 = rows.some((r) => r.includes('1.21.4'));
const hasFabricClaimed = rows.some((r) => /Fabric/i.test(r));
const ghostShown = rows.some((r) => r.includes('1.12.2'));
const groupShown = txt.includes('错误的版本');
console.log('①②③ 换到 PCL 文件夹（弹窗点中=' + opened + '）');
console.log('   页头：' + cnt3.head + '　角标：' + (cnt3.badge || '(无)') + '　筛选：' + cnt3.seg);
console.log('   列出的行：' + JSON.stringify(rows));

/* ---------- ④ ⑧ ⑨ 空文件夹 ---------- */
await switchRootViaUi(ev, 'ieml-empty-folder');
await clickNav(ev, '版本列表');
await sleep(1400);
const cnt0 = await counts(ev);
const emptyTxt = await bodyText(ev);
const emptyRows = await visibleRows(ev);
const hasPickerBtn = emptyTxt.includes('新建/切换游戏目录');
const oldDescGone = !emptyTxt.includes('里面找不到任何版本文件');
await clickNav(ev, '启动');
await sleep(1300);
const launchTxt = await bodyText(ev);
const launchEmpty = launchTxt.includes('还没有可启动的版本');
const launchGhosts = /Minecraft\s*\d/.test(launchTxt);
console.log(
  '④⑧⑨ 空文件夹：' +
    JSON.stringify(cnt0) +
    '　空状态=' +
    emptyTxt.includes('这个文件夹里没有可用的版本') +
    '　列出的行=' +
    JSON.stringify(emptyRows),
);
console.log(
  '   启动页空状态=' + launchEmpty + '　还列着版本吗=' + launchGhosts + '　按钮在=' + hasPickerBtn + '　旧描述已删=' + oldDescGone,
);

/* ---------- ⑤ 直接指 `.minecraft`（后端契约；放最后，免得打断界面的刷新链） ---------- */
const dotMc = await invokeOn(ev, 'set_data_root', { path: MC });
console.log('⑤ 指向 .minecraft 本身 → ' + JSON.stringify(dotMc?.ok ?? dotMc?.err));

/* ---------- ⑥ 从界面换回老根目录 ---------- */
const back = await switchRootViaUi(ev, 'ieml-old-root');
await clickNav(ev, '版本列表');
await sleep(1400);
const rows2 = await visibleRows(ev);
const head2 = await header(ev);
const txt2 = await bodyText(ev);
console.log('⑥ 换回老根目录（点中=' + back + '）：页头=' + head2 + '　行数=' + rows2.length + '　' + JSON.stringify(rows2));

const shot = await app.send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  writeFileSync('tmp/versions-read-folder.png', Buffer.from(shot.result.data, 'base64'));
  console.log('   截图已写：tmp/versions-read-folder.png');
}

/* ---------- 收尾：临时文件夹、用过的文件夹列表、记账文件 ---------- */
await app.close();
for (const d of [OLD_ROOT, SANDBOX, EMPTY]) rmSync(d, { recursive: true, force: true });
if (knownBackup !== null) writeFileSync(KNOWN, knownBackup);
restoreRecord();

/* ---------- 判据 ---------- */
const headCount = (s) => Number((/(\d+)\s*个版本/.exec(s) ?? [])[1] ?? NaN);
const c1 = has1214 && hasFabricClaimed && rows.length === 3;
const c2 = ghostShown === false && groupShown === false;
const c3 = headCount(cnt3.head) === 3 && cnt3.badge === '3' && cnt3.seg === '全部 3';
const c4 =
  headCount(cnt0.head) === 0 &&
  cnt0.badge === '' &&
  cnt0.seg === '全部 0' &&
  emptyRows.length === 0 &&
  emptyTxt.includes('这个文件夹里没有可用的版本');
const nf = (dotMc?.ok?.normalized_from ?? '').toLowerCase();
const p = (dotMc?.ok?.path ?? '').toLowerCase();
const c5 = nf.endsWith('\\.minecraft') && p.length > 3 && nf.startsWith(p);
const c6 = rows2.length === 3 && head2.includes('ieml-old-root') && !txt2.includes('错误的版本');
const c7 =
  recordBackup === null
    ? !existsSync(RECORD)
    : existsSync(RECORD) && readFileSync(RECORD, 'utf8') === recordBackup;
const c8 = launchEmpty === true && launchGhosts === false;
const c9 = hasPickerBtn === true && oldDescGone === true;

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 换到那个文件夹后，列表 = 文件夹里的三份版本（含账本里没有的 1.21.4）`);
console.log(`${c2 ? '✓' : '✗'} ② 不在这个文件夹里的条目**不显示**（账本原样保留）`);
console.log(`${c3 ? '✓' : '✗'} ③ 计数三处一致：页头=${cnt3.head}　角标=${cnt3.badge || '(无)'}　筛选=${cnt3.seg}`);
console.log(`${c4 ? '✓' : '✗'} ④ 空文件夹时三处归零：页头=${cnt0.head}　角标=${cnt0.badge || '(无)'}　筛选=${cnt0.seg}`);
console.log(`${c5 ? '✓' : '✗'} ⑤ 直接指「.minecraft」会被提到上一级，并且返回里说明了（normalized_from）`);
console.log(`${c6 ? '✓' : '✗'} ⑥ 从界面换回老根目录后，列表当场变成那个文件夹的版本（${rows2.length} 行）`);
console.log(`${c7 ? '✓' : '✗'} ⑦ 记账文件最后回到**原值**（探针不把你的机器留在临时目录）`);
console.log(`${c8 ? '✓' : '✗'} ⑧ 启动页也按文件夹：空文件夹时它也说"还没有可启动的版本"、不列任何版本`);
console.log(`${c9 ? '✓' : '✗'} ⑨ 版本列表上有按钮「新建/切换游戏目录」，且旧的那段描述已删掉`);
process.exit(c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8 && c9 ? 0 : 1);
