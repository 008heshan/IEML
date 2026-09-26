/*
 * 真机判据：**界面上真的没有悬停提示**（用户 2026-09-26：「去掉所有悬停显示描述」）。
 *
 * ## 为什么要真机量一遍
 *
 *   静态那条门禁（`tools/gates/check-tooltips.mjs`）只证明**源码里**没有把 `title`
 *   写到 DOM 元素 / 透传组件上。它能漏掉的是"我读错了源码"这一类：
 *   · 某个组件把 `...rest` 摊到真元素上，而我没把它列进透传名单；
 *   · 某个 `title` 由**变量**拼出来（在组件的另一层展开）；
 *   · 运行时才挂上去的属性（第三方控件、SVG 的 `<title>` 子元素之类）。
 *   所以交付前再量一遍**跑起来的界面**：`document.querySelectorAll('[title]')`。
 *
 * ## 判据
 *
 *   ① 四个主页面（启动 / 版本列表 / 下载 / 设置）与「关于」页：带 `title` 的元素数 = 0；
 *   ② 下载页的资源页签：**「资源包」这一档的加载器筛选器是禁用的**，
 *      而它的理由现在写在一行看得见的小字里（`.res-hint`）—— 这一条同时守住
 *      "禁用必须给具体理由"：用户要的是"不要悬停提示"，不是"不要理由"；
 *   ③ 切到「Mod」档：`.res-hint` 必须消失（模组是**要**按加载器筛的），
 *      加载器筛选器同时变成可用 —— 否则那行字会变成一句永远挂着的废话。
 *
 * ★ 与用户那份启动器**并存**：不调 `lib/cdp.mjs` 的 `close()`（它内部按进程名全杀），
 *   只收自己起的进程树。⚠️ 前提仍是"被测 exe 的 identifier 与用户那份不同"，
 *   否则单实例插件会让它起不来，探针会连上用户的进程、量到一份**看起来合理
 *   其实测错对象**的结果（这个坑这个仓库踩过一次）。
 *   · 用桌面版那份 exe 量时，请先确认用户没开着它；
 *   · 或者用 `--debug --no-bundle` 编一份临时 identifier 的 exe 再量。
 *
 * 用法：node tools/live/live-tooltip-check.mjs ["<exe>"]
 *   默认被测 exe：`src-tauri/target/debug/ieml.exe`
 * 退出码：0 = 全通；1 = 有判据不成立
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { clickNav, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 当前页面上所有带 `title` 的元素 —— 悬停提示的**真身**（不看源码，看 DOM） */
const titled = (ev) =>
  ev(`[...document.querySelectorAll('[title]')].map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 48),
        t: String(el.getAttribute('title') || '').slice(0, 48),
      })).concat(
        /* ★ SVG 里的 <title> 子元素**也是**悬停提示（静态门禁单独有一条管它） */
        [...document.querySelectorAll('svg title')].map((el) => ({
          tag: 'svg>title', cls: '', t: String(el.textContent || '').slice(0, 48),
        })),
      )`);

/** 加载器筛选器 + 那行理由（都按可见的 DOM 读，不靠内部变量） */
const loaderFilter = (ev) =>
  ev(`(() => {
    const trigger = document.querySelector('.cs-trigger[aria-label="筛选模组加载器"]');
    const hint = document.querySelector('.res-hint');
    return {
      hasFilter: !!trigger,
      disabled: trigger ? trigger.disabled === true : null,
      hint: hint ? (hint.textContent || '').trim() : null,
    };
  })()`);

/** 点一个页签（`role="tab"`，按文字找） */
const clickTab = (ev, label) =>
  ev(`[...document.querySelectorAll('[role="tab"]')]
        .find((b) => (b.textContent || '').trim().includes(${JSON.stringify(label)}))?.click()`);

const show = (list) =>
  Array.isArray(list) && list.length
    ? list.map((x) => `<${x.tag} class="${x.cls}"> title="${x.t}"`).join(' ； ')
    : '';

const { ev, pid, ws } = await launch({ exe: EXE, tag: 'tipcheck', settleMs: 3500 });

try {
  console.log('【① 各主页面：带 title 的元素数必须是 0】');
  for (const label of ['启动', '版本列表', '下载', '设置']) {
    await clickNav(ev, label);
    await sleep(1600);
    const found = await titled(ev);
    const list = Array.isArray(found) ? found : [];
    check(list.length === 0, `${label} 页没有悬停提示`, show(list));
  }

  /* 「关于」不是主侧栏项，是侧栏底部那颗按钮 */
  await ev(
    `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('关于'))?.click()`,
  );
  await sleep(1800);
  const aboutFound = await titled(ev);
  const aboutList = Array.isArray(aboutFound) ? aboutFound : [];
  check(aboutList.length === 0, '关于 页没有悬停提示', show(aboutList));

  console.log('\n【② 下载页「资源包」：禁用理由写在看得见的小字里】');
  await clickNav(ev, '下载');
  await sleep(1500);
  await clickTab(ev, '资源包');
  await sleep(2600);
  const rp = await loaderFilter(ev);
  console.log('        ' + JSON.stringify(rp));
  check(rp?.hasFilter === true, '资源包档有加载器筛选器');
  check(rp?.disabled === true, '资源包档的加载器筛选器是禁用的（与加载器无关）');
  check(
    typeof rp?.hint === 'string' && rp.hint.includes('与加载器无关'),
    '禁用理由以可见小字给出（.res-hint）',
    rp?.hint ?? '(没有这行字)',
  );

  console.log('\n【③ 切到「Mod」：理由消失、筛选器可用】');
  await clickTab(ev, 'Mod');
  await sleep(2600);
  const mod = await loaderFilter(ev);
  console.log('        ' + JSON.stringify(mod));
  check(mod?.hasFilter === true, 'Mod 档有加载器筛选器');
  check(mod?.disabled === false, 'Mod 档的加载器筛选器可用（模组要按加载器筛）');
  check(mod?.hint === null, 'Mod 档不显示那行理由（它不是废话，是状态说明）');

  console.log('\n【④ 切完页签再全量扫一遍】');
  const after = await titled(ev);
  const afterList = Array.isArray(after) ? after : [];
  check(afterList.length === 0, '下载页（Mod 档）没有悬停提示', show(afterList));
} finally {
  /*
   * ★★ 只收**自己起的那个进程树**：
   *   · `lib/cdp.mjs` 的 `close()` **不能调** —— 它内部 `await killIeml()`，
   *     而 `killIeml()` 是**按进程名全杀**（`Get-Process ieml | Stop-Process -Force`），
   *     会把用户正开着的启动器一起收掉（本探针就是为了"能与用户并存"）；
   *   · 所以自己关 WebSocket，再用 `taskkill /PID <pid> /T /F` 收自己那棵树。
   */
  try {
    ws.close();
  } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  try {
    rmSync(path.join(process.env.TEMP ?? '.', 'ieml-tipcheck-prof'), { recursive: true, force: true });
  } catch {}
}

console.log(`\n结果：${pass} 项通过 / ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
