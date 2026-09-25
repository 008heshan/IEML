/**
 * 真机验证：**在界面上换游戏根目录 = 立刻生效**（不用重启，也不用刷页面）。
 * ------------------------------------------------------------------
 * 用户 2026-09-25：「我不想要重启才生效，切换游戏数据应该是实时的」。
 *
 * 这条是**界面级**的证据（后端那条见 `probe-live-root-switch.mjs`）——
 * 后端句柄换了不代表界面刷新了，而用户看到的是界面。
 *
 * 判据（五条）：
 *   ① 起手：设置页「数据目录」那行是老根目录，启动页有实例（没有空状态）
 *   ② 弹窗里**没有**任何"重启…才生效"的字样，写的是"立刻生效"（老构建上必红）
 *   ③ 点「用这个」之后：toast 说"即时生效"、弹窗自己关掉、
 *      **设置页那行当场变成新目录**（同一个文档 —— 页面没被刷过）
 *   ④ 不刷页面切到**版本列表**：这一页当场按新目录说话 ——
 *      空状态写着「这个文件夹里没有可用的版本」+ 新路径，
 *      而账本里那 3 条（对不上这个空文件夹）**一条都不显示**
 *      （2026-09-25 用户：先是「换目录后不会自动刷新……点击版本列表就刷新一下」，
 *       再是「既然不在这个文件夹就不用显示了」；见 ADR-八十一）
 *      ★ 判据**不是**"实例没了"：账本住在启动器自己的家里（ADR-七十二），
 *        换根目录不动它；那 3 个条目还在，只是目录换成新根下的，磁盘上找不到
 *   ⑤ 再从界面上换回来 → 警告与那条提示都消失、版本数 > 0、
 *      machine_info 与记账文件 = 老根目录
 *
 * ★ "没刷页面"怎么证：换目录前后往 `window` 上钉一个标记，事后还在就是同一个文档。
 * ★ 记账文件与"用过的文件夹"列表都是全局状态：开跑前摆正、跑完擦干净。
 *
 * 用法：node tools/live/probe-live-root-switch-ui.mjs "<exe>"
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, invokeOn, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const APPDATA = process.env.APPDATA ?? '';
const RECORD = path.join(APPDATA, 'IEML', 'datadir.txt');
const KNOWN = path.join(APPDATA, 'IEML', 'known-roots.json');
const OLD_ROOT = 'D:\\IEML';
const NEW_ROOT = path.join(process.env.TEMP ?? '.', 'ieml-live-root-ui');
const EMPTY_TEXT = '还没有可启动的版本';

/* ---------- 全局状态：开跑前摆正 ---------- */
const knownBackup = existsSync(KNOWN) ? readFileSync(KNOWN, 'utf8') : null;
const preseed = () => {
  const was = existsSync(RECORD) ? readFileSync(RECORD, 'utf8').trim() : '(没有)';
  writeFileSync(RECORD, OLD_ROOT + '\n');
  // 让弹窗里能列出新目录这一行（弹窗列的是"用过的游戏文件夹"）
  writeFileSync(KNOWN, JSON.stringify({ roots: [OLD_ROOT, NEW_ROOT] }, null, 2));
  return was;
};
const restoreKnown = () => {
  if (knownBackup === null) rmSync(KNOWN, { force: true });
  else writeFileSync(KNOWN, knownBackup);
};
/** 记账文件是**全局状态**：跑完要是它没回到老根目录，探针自己擦干净并说出来。
 *
 *  ★ 老构建上必然发生：它的"当前根"还在内存里，点「换回来」会被后端当成
 *    「这就是当前的数据目录，没有变化」而拒绝落盘 —— 记录就留在新目录了，
 *    下次启动会真的按新目录起来。 */
const forceOldRecord = (why) => {
  const now = existsSync(RECORD) ? readFileSync(RECORD, 'utf8').trim() : '';
  if (now.toLowerCase() === OLD_ROOT.toLowerCase()) return '';
  writeFileSync(RECORD, OLD_ROOT + '\n');
  return `（探针擦屁股：${why}；记账文件从 ${now} 写回 ${OLD_ROOT}）`;
};

const was = preseed();
if (was.toLowerCase() !== OLD_ROOT.toLowerCase()) {
  console.log(`⚠ 开跑前记账文件是 ${was}，已摆正为 ${OLD_ROOT}\n`);
}

/* 新根目录：只有空壳（没有 .minecraft/versions，也没有账本） */
rmSync(NEW_ROOT, { recursive: true, force: true });
mkdirSync(path.join(NEW_ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(NEW_ROOT, 'instances'), { recursive: true });

/* ---------- 页面小工具 ---------- */
const bodyText = (ev) => ev('document.body.innerText');
const modalText = (ev) => ev('(document.querySelector(".modal")||{}).innerText || ""');
const toastText = (ev) => ev('(document.querySelector(".toasts")||{}).innerText || ""');
const modalOpen = (ev) => ev('!!document.querySelector(".modal")');
/** 列表里可见的版本行标题（`.ver-item`）—— 用来断言"该显示的显示了、不该显示的一条都没有" */
const visibleRows = (ev) =>
  ev(
    `[...document.querySelectorAll('.ver-item')].map((r) => (r.querySelector('.ver-title-name')||{}).textContent || '')`,
  );

/** 「这个文件夹里没有可用的版本」那块空状态（rc.8 起，替代了 rc.7 那条横幅提示） */
const noVersionNote = (ev) =>
  ev(
    `(() => {
       const n = [...document.querySelectorAll('.ver-empty')]
         .find((x) => (x.textContent || '').includes('这个文件夹里没有可用的版本'));
       return n ? (n.textContent || '') : '';
     })()`,
  );
const clickByText = (ev, sel, text) =>
  ev(
    `(() => {
       const list = [...document.querySelectorAll(${JSON.stringify(sel)})];
       const el = list.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
       if (!el) return { ok: false, n: list.length };
       el.click();
       return { ok: true, n: list.length };
     })()`,
  );
/** 在弹窗里点"某一行的用这个" */
const clickRowUse = (ev, needle) =>
  ev(
    `(() => {
       const rows = [...document.querySelectorAll('.droot-row')];
       const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(needle)}));
       if (!row) return { ok: false, rows: rows.map((r) => (r.textContent || '').slice(0, 60)) };
       const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').includes('用这个'));
       if (!btn) return { ok: false, why: '没有"用这个"按钮', row: row.textContent };
       btn.click();
       return { ok: true };
     })()`,
  );

await killIeml();
const app = await launch({ exe: EXE, tag: 'liverootui', settleMs: 3500 });
const ev = app.ev;
const send = app.send;

/* ---------- ① 起手 ---------- */
await clickNav(ev, '设置');
await sleep(600);
const setTxt0 = await bodyText(ev);
const dirRow0 = await ev(
  '(() => { const h = [...document.querySelectorAll(".field-hint")].find((x) => (x.getAttribute("title")||"").includes("IEML")); return h ? (h.getAttribute("title")||"") : "(没找到那一行)"; })()',
);
await clickNav(ev, '启动');
await sleep(600);
const launch0 = await bodyText(ev);
const before = {
  dir: dirRow0,
  empty: launch0.includes(EMPTY_TEXT),
  dataDir: (await invokeOn(ev, 'machine_info', {}))?.ok?.data_dir ?? '(取不到)',
};
console.log(
  '① 起手：设置页数据目录=' +
    before.dir +
    '　machine_info=' +
    before.dataDir +
    '　启动页空状态=' +
    before.empty,
);

/* ---------- ② 弹窗里的文案 ---------- */
await clickNav(ev, '设置');
await sleep(600);
const opened = await clickByText(ev, 'button', '新建/切换');
await sleep(700);
const mt = await modalText(ev);
const saysRestart = /重启[^。\n]{0,6}生效|重启才|重启后生效/.test(mt);
const saysLive = mt.includes('立刻生效');
console.log('② 弹窗打开=' + opened.ok + '　说"立刻生效"=' + saysLive + '　说"重启才生效"=' + saysRestart);

/* 钉一个标记：换完如果页面被刷过，这个标记就没了 */
await ev('(window.__probeSameDoc = 1)');
await ev('(window.__probeMark = "live-root-ui")');

/* ---------- ③ 在界面上换到新根目录 ---------- */
const clicked = await clickRowUse(ev, 'ieml-live-root-ui');
console.log('   点新目录那行的「用这个」：' + JSON.stringify(clicked));
await sleep(2500);
const mid = {
  toast: await toastText(ev),
  modal: await modalOpen(ev),
  sameDoc: await ev('window.__probeSameDoc === 1 && window.__probeMark === "live-root-ui"'),
  dataDir: (await invokeOn(ev, 'machine_info', {}))?.ok?.data_dir ?? '(取不到)',
  hint: await ev(
    '(() => { const h = [...document.querySelectorAll(".field-hint")].find((x) => (x.getAttribute("title")||"").length > 3); return h ? (h.getAttribute("title")||"") : "(没找到)"; })()',
  ),
};
console.log(
  '③ 换完：toast=' +
    JSON.stringify(mid.toast.replace(/\n/g, ' | ')) +
    '　弹窗还开着=' +
    mid.modal +
    '　同一个文档=' +
    mid.sameDoc +
    '　machine_info=' +
    mid.dataDir +
    '　设置页那行=' +
    mid.hint,
);

/* ---------- ④ 不刷页面切到版本列表 ---------- */
/*
 * ★ 判据不是"实例没了"：账本（`instances.json`）住在**启动器自己的家**里
 *   （ADR-七十二），换游戏根目录不动它 —— 所以那 3 个条目还在，只是它们的
 *   目录换成新根下的，磁盘上当然找不到。界面该如实说这件事。
 */
await clickNav(ev, '版本列表');
await sleep(1200);
const verTxt = await bodyText(ev);
const note = await noVersionNote(ev);
const after = {
  /* rc.8 起：这件事由列表自己的空状态说（不再是顶部那条横幅） */
  empty: verTxt.includes('这个文件夹里没有可用的版本'),
  emptyPath: note.includes(NEW_ROOT),
  /*
   * 账本里那 3 条对不上这个空文件夹 ⇒ **一条都不显示**（2026-09-25 晚用户：
   * 「既然不在这个文件夹就不用显示了」）。列表里连一个 `.ver-item` 都不该有。
   */
  ghostRows: await visibleRows(ev),
  sameDoc: await ev('window.__probeSameDoc === 1'),
};
console.log(
  '④ 版本列表页：空状态=' +
    after.empty +
    '（里面写着新目录 ' +
    after.emptyPath +
    '）　列出的行=' +
    JSON.stringify(after.ghostRows) +
    '　同一个文档=' +
    after.sameDoc,
);

/* 顺手留一张人眼可核对的图：换到空目录之后这一页长什么样 */
const SHOT = 'tmp/versions-empty-root.png';
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot?.result?.data) throw new Error('截图没有数据：' + JSON.stringify(shot).slice(0, 120));
  writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('   截图已写：' + SHOT);
} catch (e) {
  console.log('   （截图失败：' + String(e) + '）');
}

/* ---------- ⑤ 从界面上换回来 ---------- */
await clickNav(ev, '设置');
await sleep(600);
await clickByText(ev, 'button', '新建/切换');
await sleep(700);
const backClick = await clickRowUse(ev, 'D:\\IEML');
console.log('   点老目录那行的「用这个」：' + JSON.stringify(backClick));
await sleep(2500);
await clickNav(ev, '版本列表');
await sleep(1200);
const verTxt2 = await bodyText(ev);
const note2 = await noVersionNote(ev);
const record = existsSync(RECORD) ? readFileSync(RECORD, 'utf8').trim() : '(读不到)';
const restored = {
  empty: verTxt2.includes('这个文件夹里没有可用的版本'),
  /* 换回来之后，那条被藏起来的实例（1.12.2）应该又出现了 —— 证明"不显示 ≠ 删掉" */
  hiddenBack: verTxt2.includes('1.12.2'),
  noteStillSaysNew: note2.includes(NEW_ROOT),
  dataDir: (await invokeOn(ev, 'machine_info', {}))?.ok?.data_dir ?? '(取不到)',
  versionCount: (await invokeOn(ev, 'machine_info', {}))?.ok?.version_count ?? '(取不到)',
  record,
};
console.log(
  '⑤ 换回来：还挂空状态=' +
    restored.empty +
    '　被藏起来的条目回来了=' +
    restored.hiddenBack +
    '（里面还写着新目录=' +
    restored.noteStillSaysNew +
    '）　machine_info=' +
    restored.dataDir +
    '　版本数=' +
    restored.versionCount +
    '　记账文件=' +
    restored.record,
);

await app.close();
rmSync(NEW_ROOT, { recursive: true, force: true });
restoreKnown();
const cleanup = forceOldRecord('应用自己没能把记账文件换回来');

/* ---------- 判据 ---------- */
const c1 =
  before.dataDir.toLowerCase() === OLD_ROOT.toLowerCase() &&
  before.dir.toLowerCase() === OLD_ROOT.toLowerCase() &&
  before.empty === false;
const c2 = opened.ok === true && saysLive === true && saysRestart === false;
const c3 =
  mid.toast.includes('即时生效') &&
  mid.modal === false &&
  mid.sameDoc === true &&
  mid.dataDir.toLowerCase() === NEW_ROOT.toLowerCase() &&
  mid.hint.toLowerCase() === NEW_ROOT.toLowerCase();
const c4 =
  after.empty === true &&
  after.emptyPath === true &&
  after.ghostRows.length === 0 &&
  after.sameDoc === true;
const c5 =
  restored.empty === false &&
  restored.hiddenBack === true &&
  restored.noteStillSaysNew === false &&
  restored.versionCount > 0 &&
  restored.dataDir.toLowerCase() === OLD_ROOT.toLowerCase() &&
  restored.record.toLowerCase() === OLD_ROOT.toLowerCase();

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 起手是老根目录 ${OLD_ROOT}（设置页那行 + machine_info），启动页有实例`);
console.log(`${c2 ? '✓' : '✗'} ② 弹窗写着「立刻生效」，没有「重启才生效」（老构建在这里红）`);
console.log(`${c3 ? '✓' : '✗'} ③ 界面上点一下就换了：toast 说即时生效、弹窗自动关、设置页那行当场变新目录（页面没刷）`);
console.log(`${c4 ? '✓' : '✗'} ④ 版本列表当场按**新目录**说话：空状态写着新路径，账本那 3 条一条都不显示`);
console.log(`${c5 ? '✓' : '✗'} ⑤ 从界面换回来：空状态消失、条目回来、版本数 > 0、machine_info 与记账文件都回到 ${OLD_ROOT}`);
if (cleanup) console.log('⚠ ' + cleanup);
console.log('记账文件收尾：' + (existsSync(RECORD) ? readFileSync(RECORD, 'utf8').trim() : '(读不到)'));
process.exit(c1 && c2 && c3 && c4 && c5 ? 0 : 1);
