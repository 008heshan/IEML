/*
 * 真机判据：**版本列表这一页只回答"这个文件夹里有什么"**（2026-09-28）。
 *
 * ## 这条判据是给谁立的
 *
 *   用户（截图）原话：「这个界面有一堆重复按键，删除中间的和右上角全部的
 *   新建/下载实例，删除中间的切换文件夹按键；同时把那几个按钮的底层代码也要废除，
 *   也就是**永远不再加回来了**」。
 *
 *   被删掉的四个（都在版本列表页）：
 *     · 右上角「新建版本」  —— 派发 `ieml:create` 打开创建实例弹窗
 *     · 右上角「新装一个」  —— 跳下载页第一格
 *     · 中间空状态「去下载页装一份」     —— 与上面那个是同一件事
 *     · 中间空状态「新建/切换游戏目录」  —— 与右上角那个是同一个动作
 *
 *   ★ "永远不再加回来"这句话**得有人守**：删按钮是很容易被下一次改动加回去的
 *     （这个仓库里"删了又回来"的事发生过）。所以立这条判据：
 *     页面上**不该有**这四个，同时**该有的三个必须还在**（对照组）。
 *
 * ## 判据（五条）
 *
 *   ① ★ 这一页没有「新建版本」「新装一个」「去下载页装一份」三个按钮
 *   ② ★ 中间空状态（"这个文件夹里没有可用的版本"）里**一个按钮都没有**
 *   ③ ★ 对照组：右上角那三个**必须还在**（新建/切换游戏目录、导入其他启动器、重新探测）
 *      —— 没有这条，"整页没按钮"也能让判据全绿
 *   ④ 页头仍然写着当前文件夹（那句"文件夹在哪"是这一页最要紧的事实，不能跟着按钮一起没）
 *   ⑤ ★ 对照组：创建实例这条路**没有被我们弄断** ——
 *      `ieml:create` 事件仍然能打开创建弹窗（另一个入口在实例设置页）
 *
 * ## 沙盒
 *
 *   一个实例 + **盘上一个能用的版本都没有** ⇒ 正好复刻用户截图那一屏
 *   （"0 个版本 · 文件夹 …" + 中间那个空状态）。
 *
 * 用法：
 *   node tools/live/live-version-page-actions-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-vpa-root');
const OWN = path.join(T, 'ieml-vpa-own');
const FAKE_APPDATA = path.join(T, 'ieml-vpa-appdata');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 沙盒：一个实例，但盘上没有任何版本 ⇒ 中间那个空状态 ---------- */
for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
mkdirSync(path.join(ROOT, '.minecraft', 'versions'), { recursive: true });
mkdirSync(path.join(ROOT, 'instances', 'vpa-probe', 'game'), { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-vpa',
          mcVersion: '1.20.1',
          loader: null,
          addons: [],
          config: {
            name: '按钮探针',
            slug: 'vpa-probe',
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
      activeId: 'i-vpa',
    },
    null,
    2,
  ),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'vpalive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

try {
  await clickNav(ev, '版本列表');
  await sleep(2000);

  /** 页面上所有可见按钮的文字 */
  const buttons = await ev(`JSON.stringify(
    [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.textContent || '').trim())
      .filter(Boolean)
  )`);
  const btns = JSON.parse(String(buttons));
  const has = (t) => btns.some((x) => x.includes(t));
  const where = btns.join(' | ');

  /* ---------- ① 被删掉的三个（跨全页） ---------- */
  const banned = ['新建版本', '新装一个', '去下载页装一份'];
  const found = banned.filter((t) => has(t));
  check(
    found.length === 0,
    '① ★ 这一页没有「新建版本」「新装一个」「去下载页装一份」',
    found.length ? `还在：${found.join('、')}｜全部按钮：${where}` : where,
  );

  /* ---------- ② 中间空状态里一个按钮都没有 ---------- */
  const emptyHtml = await ev(
    `(() => { const e = document.querySelector('.ver-empty'); return e ? e.innerText : '__no_empty_state__'; })()`,
  );
  const emptyBtns = await ev(
    `(() => {
       const e = document.querySelector('.ver-empty');
       if (!e) return -1;
       return [...e.querySelectorAll('button')].filter((b) => b.offsetParent !== null).length;
     })()`,
  );
  check(
    emptyBtns === 0,
    '② ★ 中间空状态（"这个文件夹里没有可用的版本"）里没有按钮了',
    `按钮数=${emptyBtns}｜那一格现在写着：${String(emptyHtml).replace(/\n/g, ' / ').slice(0, 80)}`,
  );

  /* ---------- ③ 对照组：该在的三个还在 ---------- */
  const kept = ['新建/切换游戏目录', '导入其他启动器', '重新探测'];
  const missing = kept.filter((t) => !has(t));
  check(
    missing.length === 0,
    '③ ★ 对照组：右上角该在的三个都还在（没有这条，"整页没按钮"也能全绿）',
    missing.length ? `少了：${missing.join('、')}` : where,
  );

  /* ---------- ④ 页头仍然写着当前文件夹 ---------- */
  const head = String(await ev(`(document.querySelector('.page-desc')?.innerText || '')`));
  check(
    head.includes('文件夹') && head.includes('个版本'),
    '④ 页头仍然写着"几个版本 · 文件夹 在哪"（这一页最要紧的事实没跟着按钮一起没）',
    head.replace(/\n/g, ' ').slice(0, 120),
  );

  /* ---------- ⑤ 对照组：创建实例这条路没被弄断 ---------- */
  await ev(`(() => { window.dispatchEvent(new CustomEvent('ieml:create')); return true; })()`);
  let modal = '';
  for (let i = 0; i < 15; i += 1) {
    await sleep(400);
    modal = String(await ev(`(document.querySelector('.modal .modal-title')?.textContent || '')`));
    if (modal) break;
  }
  check(
    modal.includes('创建版本'),
    '⑤ ★ 对照组：`ieml:create` 仍然能打开创建版本弹窗（另一个入口在实例设置页 —— 删的是按钮，不是能力）',
    `弹窗标题=${modal || '（没有弹窗）'}`,
  );
} catch (e) {
  console.log(`  ⚠ 探针自己出错：${e.message}`);
  fail += 1;
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
