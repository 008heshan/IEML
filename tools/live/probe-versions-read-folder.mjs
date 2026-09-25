/**
 * 真机验证：**版本列表读的是"当前文件夹"，不是账本**
 * ------------------------------------------------------------------
 * 用户（给了两张 PCL 截图）：「你看 PCL，就是像换了个文件夹去读游戏版本，可以无缝切换」。
 *
 * 判据（五条）：
 *   ① 造一个 PCL 那样的文件夹（`<沙盒>\.minecraft\versions\` 里放三份版本，
 *      其中 `1.21.4` **账本里没有**），换过去之后列表里要出现这三份：
 *      · 26.2 / fabric-loader-0.19.5-26.2 被账本里对应实例"认领"（显示实例名）
 *      · 1.21.4 显示成「还没建实例」
 *   ② 账本里对不上的那条（1.12.2）落进「错误的版本（1）」折叠组 —— 一条都不丢
 *   ③ 把根目录指向 `.minecraft` **本身**（PCL 的「添加已有文件夹」就是这么选的）：
 *      后端要往上提一级，并在返回里说明（`normalizedFrom`）
 *   ④ **从界面**换回 D:\IEML（走真实入口，会触发前端刷新）：
 *      列表立刻变成那个文件夹里的版本（≥20 行）、折叠组消失
 *   ⑤ 全程记账文件最后回到 D:\IEML（探针两头擦）
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
const OLD_ROOT = 'D:\\IEML';
const SANDBOX = path.join(process.env.TEMP ?? '.', 'ieml-pcl-folder');
const MC = path.join(SANDBOX, '.minecraft');

const knownBackup = existsSync(KNOWN) ? readFileSync(KNOWN, 'utf8') : null;
const forceOldRecord = (why) => {
  const now = existsSync(RECORD) ? readFileSync(RECORD, 'utf8').trim() : '';
  if (now.toLowerCase() === OLD_ROOT.toLowerCase()) return '';
  writeFileSync(RECORD, OLD_ROOT + '\n');
  return `（探针擦屁股：${why}；记账文件从 ${now} 写回 ${OLD_ROOT}）`;
};

/* ---------- 造一个"PCL 文件夹" ============ */
rmSync(SANDBOX, { recursive: true, force: true });
const mkVersion = (dirName, json) => {
  const d = path.join(MC, 'versions', dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `${dirName}.json`), JSON.stringify(json));
};
mkVersion('26.2', { id: '26.2', mainClass: 'net.minecraft.client.main.Main' });
mkVersion('fabric-loader-0.19.5-26.2', {
  id: 'fabric-loader-0.19.5-26.2',
  inheritsFrom: '26.2',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
});
// ★ 账本里没有的版本 —— 它出现在列表里，就证明"列表来自文件夹，不是账本"
mkVersion('1.21.4', { id: '1.21.4', mainClass: 'net.minecraft.client.main.Main' });

/* 记账文件摆正 + 把两个文件夹都放进"用过的文件夹"（好在界面上点它们） */
const was = forceOldRecord('开跑前记账文件不是老根目录');
if (was) console.log('⚠ ' + was + '\n');
writeFileSync(KNOWN, JSON.stringify({ roots: [OLD_ROOT, SANDBOX] }, null, 2));

const bodyText = (ev) => ev('document.body.innerText');
const header = (ev) =>
  ev(`(() => { const el = document.querySelector('.page-desc'); return el ? el.innerText : ''; })()`);
const visibleRows = (ev) =>
  ev(
    `[...document.querySelectorAll('.ver-item')].map((r) => (r.querySelector('.ver-title-name')||{}).textContent || '')`,
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

await killIeml();
const app = await launch({ exe: EXE, tag: 'pclfolder', settleMs: 3800 });
const ev = app.ev;

/* ---------- ③ 先做"直接指 .minecraft"这条（此刻当前根还是 D:\IEML，才测得出"提级"） ---------- */
const dotMc = await invokeOn(ev, 'set_data_root', { path: MC });
console.log('③ 指向 .minecraft 本身 → ' + JSON.stringify(dotMc?.ok ?? dotMc?.err));

/* ---------- ① 换过去之后，列表里应该是这个文件夹里的版本 ---------- */
await sleep(2500);
await clickNav(ev, '版本列表');
await sleep(1800);
const rows = await visibleRows(ev);
const txt = await bodyText(ev);
const head = await header(ev);
console.log('   页头：' + head);
console.log('① 列表里的行：' + JSON.stringify(rows));
const has1214 = rows.some((r) => r.includes('1.21.4'));
const hasFabricClaimed = rows.some((r) => /Fabric/i.test(r));
/* 账本里对不上这个文件夹的那条（1.12.2）**不该出现**（用户 2026-09-25 晚：「既然不在这个文件夹就不用显示了」） */
const ghostShown = rows.some((r) => r.includes('1.12.2'));
const groupShown = txt.includes('错误的版本');
console.log('   有账本里没有的 1.21.4=' + has1214 + '　fabric 那份被实例认领=' + hasFabricClaimed);
console.log(
  '② 不在这个文件夹里的那条（1.12.2）显示了吗=' + ghostShown + '　「错误的版本」分组还在吗=' + groupShown,
);

/* ---------- ④ 从界面换回 D:\IEML（真实入口 → 会触发前端刷新） ---------- */
await clickNav(ev, '设置');
await sleep(800);
await clickByText(ev, 'button', '新建/切换');
await sleep(900);
const clicked = await clickRowUse(ev, OLD_ROOT);
console.log('④ 界面上点回 D:\\IEML：' + clicked);
await sleep(2800);
await clickNav(ev, '版本列表');
await sleep(1800);
const rows2 = await visibleRows(ev);
const txt2 = await bodyText(ev);
const head2 = await header(ev);
console.log('   页头：' + head2);
console.log('   行数=' + rows2.length + '　折叠组=' + (txt2.includes('错误的版本') ? '还在' : '消失'));

const shot = await app.send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  writeFileSync('tmp/versions-read-folder.png', Buffer.from(shot.result.data, 'base64'));
  console.log('   截图已写：tmp/versions-read-folder.png');
}

await app.close();
rmSync(SANDBOX, { recursive: true, force: true });
if (knownBackup !== null) writeFileSync(KNOWN, knownBackup);
const cleanup = forceOldRecord('换回来之后记账文件不对');

/* ---------- 判据 ---------- */
const c1 = has1214 && hasFabricClaimed && rows.length === 3;
/* 不在这个文件夹里的**不显示**（账本里那条 1.12.2 既不在行里，也没有"错误的版本"分组） */
const c2 = ghostShown === false && groupShown === false;
/*
 * ③ 的判据要注意：Windows 会返回 **8.3 短路径**（`C:\Users\ADMINI~1\…`），
 *    所以不能拿长路径做字符串相等 —— 判"提级"这件事本身：
 *    `normalized_from` 必须是 `.minecraft`，而且它的上级就是返回的 `path`。
 */
const nf = (dotMc?.ok?.normalized_from ?? '').toLowerCase();
const p = (dotMc?.ok?.path ?? '').toLowerCase();
const c3 = nf.endsWith('\\.minecraft') && p.length > 3 && nf.startsWith(p);
const c4 = rows2.length >= 20 && !txt2.includes('错误的版本') && head2.includes(OLD_ROOT);
const c5 = existsSync(RECORD) && readFileSync(RECORD, 'utf8').trim().toLowerCase() === OLD_ROOT.toLowerCase();

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 换到那个文件夹后，列表 = 文件夹里的三份版本（含账本里没有的 1.21.4）`);
console.log(`${c2 ? '✓' : '✗'} ② 不在这个文件夹里的条目**不显示**（账本原样保留，换回去就回来）`);
console.log(`${c3 ? '✓' : '✗'} ③ 直接指「.minecraft」会被提到上一级，并且返回里说明了（normalizedFrom）`);
console.log(`${c4 ? '✓' : '✗'} ④ 从界面换回 D:\\IEML 后，列表当场变成那个文件夹的版本（${rows2.length} 行）、折叠组消失`);
console.log(`${c5 ? '✓' : '✗'} ⑤ 记账文件最后回到 ${OLD_ROOT}`);
if (cleanup) console.log('⚠ ' + cleanup);
process.exit(c1 && c2 && c3 && c4 && c5 ? 0 : 1);
