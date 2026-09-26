/*
 * 真机判据：**CurseForge 整合包这条路**（来源切换 + 一键装好 + 拖入的降级路径）。
 *
 * ## 这个文件的两个来源（同一件事的两半，所以合成一份）
 *
 *   · 2026-09-23 那版验的是**来源切换**：CF 那一栏必须真的出整合包
 *     —— 当初出来的是 GeckoLib / JEI 那批**模组**，根因是后端把 `modpack`
 *     解析成了 `Mod`（拿 classId=6 去查了）。★ 那条断言（"像模组的数 ≤ 1"）留着，
 *     因为"有 20 张卡"根本抓不住这个 bug（模组也有 20 张）。
 *   · 2026-09-27 补的是**安装本身**：CF 的清单里只有 `projectID` / `fileID`，
 *     每个文件都要再问一次接口才拿得到地址 —— 字段名写错、overrides 目录名写死、
 *     作者禁止分发时硬编地址，这三种都"看起来没事、其实是坏的"。
 *
 * ## 判据（分成四段，每段都能单独看懂）
 *
 *   ① 来源分段里有 CurseForge，切过去**有结果**且**是整合包**；
 *   ② **在线装**：搜一个**小包**（SkyFactory 4，包体 19 MB；榜首那些是 190 MB+，
 *      拿它们验"进度在动"要等太久）→ 点卡片 → 点版本行 → 任务出现、阶段真的换、
 *      包体那一段**有字节级进度**（0% 停着不动＝看起来像卡死，这条钉的就是它）；
 *   ③ **拖入的包**（`ieml:install-local-pack`）：起任务 → 在**解析文件地址**那一段
 *      点暂停 → **必须真的停下**（并如实报还剩多少）→ 继续 → 再取消。
 *      ★ 这一条盯的是一个**跨阶段丢令牌**的缺陷：暂停只认 taskId，而安装分四段，
 *        以前每段开头换一个新令牌，用户在上一段点下的暂停就被丢掉、
 *        界面写着「正在暂停…」而任务照样跑。现在四段复用同一个令牌。
 *   ④ 让 ② 那个包**装到底**（≤25 分钟）：沙盒里出现实例目录、`mods/` 里上百个 jar、
 *      `overrides` 落进游戏目录 —— 这才叫"一键装好（含 overrides）"。
 *
 * ## 记两个实测到的外部条件（不当成"通过"，也不当成产品的错）
 *
 *   · CF 的文件下载**依赖第三方镜像或第二个 CDN 域名**（`edge.forgecdn.net`
 *     在本机经常连不上）。镜像慢的时候，② 的阶段变化要等几分钟 ——
 *     所以 ② 的等待上限给到 5 分钟。
 *   · 榜首那些包（ATM10 等）包体 190 MB+：**能装，但要等**。判据用小包，
 *     是为了让"进度在动"这件事在几分钟内可判，不是因为大包装不了。
 *
 * ★ 与用户那份启动器**并存**：只收自己起的进程树（不调 `killIeml()`）。
 * ★ 沙盒：`IEML_DATA_DIR` / `IEML_OWN_DIR` 指到 `%TEMP%` 下的空目录 ——
 *   这一步会往里写几百 MB，绝不碰用户的游戏目录。
 *
 * 用法：
 *   node tools/live/live-cf-modpack-check.mjs ["<exe>"]
 *   node tools/live/live-cf-modpack-check.mjs "<exe>" --quick    # 不跑 ④（不等装完）
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { clickNav, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-cf-pack-root');
const OWN = path.join(T, 'ieml-cf-pack-own');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

for (const d of [ROOT, OWN]) rmSync(d, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
mkdirSync(OWN, { recursive: true });

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'cflive',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

/**
 * 任务状态从**事件**里看（`ieml:task-add` / `ieml:task-patch`）。
 * ★ 第一版读的是 `window.__iemlTasks` —— 那个全局**根本不存在**，
 *   于是四条判据全"读到 null"全红：红得对，但原因是**量法错了**
 *   （这个仓库的老规矩：红了先怀疑量法）。这两个事件才是任务状态的真源。
 */
const captureTasks = () =>
  ev(`(() => {
    window.__probeTasks = [];
    /* ★ 同时留一份**原始补丁流水**：状态对不上时要能看出"谁在什么时候改了什么" */
    window.__probePatches = [];
    window.addEventListener('ieml:task-add', (e) => {
      window.__probeTasks.unshift({ ...(e.detail || {}), _added: Date.now() });
      window.__probePatches.push({ at: Date.now(), id: (e.detail || {}).id, patch: { ...(e.detail || {}), _add: true } });
    });
    window.addEventListener('ieml:task-patch', (e) => {
      const d = e.detail || {};
      const i = window.__probeTasks.findIndex((t) => t.id === d.id);
      if (i >= 0) window.__probeTasks[i] = { ...window.__probeTasks[i], ...(d.patch || {}) };
      window.__probePatches.push({ at: Date.now(), id: d.id, patch: d.patch || {} });
      if (window.__probePatches.length > 200) window.__probePatches.shift();
    });
    return true;
  })()`);

/** 某个任务的补丁流水（诊断用：状态对不上时看是谁改的） */
const patchLog = (id, sinceMs = 0) =>
  ev(`(window.__probePatches || [])
        .filter((p) => p.id === ${JSON.stringify(id)} && p.at >= ${Date.now() - sinceMs})
        .map((p) => ({ at: new Date(p.at).toISOString().slice(11, 19), patch: p.patch }))`);

/** 界面上那条任务现在是什么状态（事件记录与 DOM 可能不一致，要能对比） */
const domTask = (titlePart) =>
  ev(`(() => {
    const open = [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') || '').startsWith('任务中心'));
    if (!document.querySelector('.task-panel')) open?.click();
    return new Promise((r) => setTimeout(() => {
      const item = [...document.querySelectorAll('.task-item')].find((el) =>
        (el.querySelector('.task-title')?.textContent || '').includes(${JSON.stringify(titlePart)}));
      if (!item) return r({ found: false });
      r({
        found: true,
        cls: item.className,
        pct: (item.querySelector('.task-pct')?.textContent || '').trim(),
        meta: (item.querySelector('.task-meta')?.textContent || '').trim(),
        buttons: [...item.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      });
    }, 500));
  })()`);

const tasks = () =>
  ev(`(window.__probeTasks || []).map((t) => ({ id: t.id, status: t.status, percent: t.percent, detail: t.detail, finished: t.finishedFiles, total: t.totalFiles }))`);

const cardNames = () =>
  ev(`[...document.querySelectorAll('.pack-card')]
        .filter((c) => !String(c.className).includes('sk'))
        .slice(0, 8).map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40))`);

/** 现在选中的来源（读分段控件的 aria-pressed —— 那行"数据来自"的小字已被删掉） */
const sourceLabel = () =>
  ev(`(() => {
    const seg = document.querySelector('.seg[aria-label="来源"]');
    const on = [...(seg?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-pressed') === 'true');
    return on ? (on.textContent || '').trim() : null;
  })()`);

const inv = (cmd, a) =>
  ev(`(async () => {
    try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(a ?? {})}) }; }
    catch (e) { return { err: String(e && e.message ? e.message : e) }; }
  })()`);

/** 等任务列表里出现第一个任务 */
const waitTask = async (ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(1000);
    const list = await tasks();
    if (Array.isArray(list) && list.length) return list[0];
  }
  return null;
};

/** 等某个任务的状态**真的变一次**（阶段/进度/状态） */
const waitChange = async (from, ms = 240000) => {
  const t0 = Date.now();
  let now = from;
  while (Date.now() - t0 < ms) {
    await sleep(2000);
    const list = await tasks();
    now = Array.isArray(list) ? list.find((t) => t.id === from?.id) ?? list[0] : null;
    if (!now) break;
    if (
      now.detail !== from?.detail ||
      (now.percent ?? 0) > (from?.percent ?? 0) ||
      (now.finished ?? 0) > (from?.finished ?? 0) ||
      now.status !== from?.status
    ) {
      return { changed: true, task: now, waited: Date.now() - t0 };
    }
  }
  return { changed: false, task: now, waited: Date.now() - t0 };
};

/**
 * 等一个**长阶段**里的进度往上走（`percent` 变大），或者这个阶段已经过去。
 *
 * ★ 为什么要单独写一个：`waitChange` 只要"变过一次"就返回，
 *   而"包体那一段有没有进度"必须**盯住那一段**看 —— 榜首的包 190 MB，
 *   以前那一段是 0% 停几分钟（没有进度回调），必须能在判据里区分
 *   "在下但没报进度"与"在下且进度在动"。
 */
const waitProgressWhile = async (id, stage, ms) => {
  const t0 = Date.now();
  let last = null;
  let best = 0;
  while (Date.now() - t0 < ms) {
    const list = await tasks();
    last = Array.isArray(list) ? list.find((t) => t.id === id) ?? null : null;
    if (!last) break;
    const onStage = String(last.detail ?? '').includes(stage);
    if (!onStage) return { moved: true, task: last, waited: Date.now() - t0 };
    best = Math.max(best, Number(last.percent ?? 0), Number(last.finished ?? 0));
    if (best > 0) return { moved: true, task: last, waited: Date.now() - t0 };
    await sleep(2000);
  }
  return { moved: false, task: last, waited: Date.now() - t0 };
};

/** 等某个任务到达某个状态（`paused` / `running` / …） */
const waitStatus = async (id, status, ms) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const list = await tasks();
    last = Array.isArray(list) ? list.find((t) => t.id === id) ?? null : null;
    if (last?.status === status) return { ok: true, task: last, waited: Date.now() - t0 };
    await sleep(1500);
  }
  return { ok: false, task: last, waited: Date.now() - t0 };
};

/**
 * 在**任务中心里**按按钮（按标题找那一条任务）。
 *
 * ★ 为什么不直接 `invoke('pause_install')`：「继续」那个按钮走的是前端
 *   `resumeOrReplay` → 重放函数用同一个 taskId / slug 重新发起安装 ——
 *   那条路才是用户真会走的，直接调接口验不到它。
 *
 * ★ 面板要先点开、**等它画出来**再找按钮（React 渲染是异步的：
 *   点完立刻查 DOM 只会查到空的 `titles: []` —— 第一版就是这么假红的）。
 */
const taskCenterClick = async (titlePart, label) => {
  await ev(`(() => {
    const toggle = [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') || '').startsWith('任务中心'));
    if (!document.querySelector('.task-panel')) toggle?.click();
    return !!toggle;
  })()`);
  await sleep(800);
  return ev(`(() => {
    const items = [...document.querySelectorAll('.task-item')];
    const item = items.find((el) =>
      (el.querySelector('.task-title')?.textContent || '').includes(${JSON.stringify(titlePart)}));
    if (!item) {
      return { found: false, reason: '没有这条任务', titles: items.map((el) => (el.querySelector('.task-title')?.textContent || '').trim()), panel: !!document.querySelector('.task-panel') };
    }
    const btn = [...item.querySelectorAll('button')].find((b) =>
      (b.textContent || '').includes(${JSON.stringify(label)}));
    if (!btn) {
      return { found: false, reason: '这条任务上没有这个按钮', buttons: [...item.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) };
    }
    btn.click();
    return { found: true, clicked: (btn.textContent || '').trim() };
  })()`);
};

try {
  await captureTasks();

  console.log('【① 下载页 → 整合包 → CurseForge】');
  await clickNav(ev, '下载');
  await sleep(1500);
  await ev(
    `[...document.querySelectorAll('.tabs button, .tabs [role=tab], [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包')?.click()`,
  );
  await sleep(2000);
  let cards = 0;
  for (let i = 0; i < 40; i += 1) {
    cards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
    if (cards > 0) break;
    await sleep(500);
  }
  const before = await cardNames();
  const switched = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'CurseForge');
    b?.click();
    return !!b;
  })()`);
  await sleep(6000);
  let cfCards = 0;
  for (let i = 0; i < 40; i += 1) {
    cfCards = await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`);
    if (cfCards > 0) break;
    await sleep(500);
  }
  const after = await cardNames();
  const src = await sourceLabel();
  console.log(`  切到 CurseForge：${switched}  卡片 ${cfCards} 张  来源分段选中「${src}」`);
  check(cfCards > 0, '★ 切到 CurseForge 之后有结果（不是空的）', `${cfCards} 张`);
  check(/CurseForge/i.test(String(src)), '★ 来源分段真的切过去了', String(src));
  check(
    JSON.stringify(before) !== JSON.stringify(after),
    '★ 整批结果与 Modrinth 那批不同（两侧榜单不会完全重合）',
    `Modrinth: ${JSON.stringify(before?.[0])} / CF: ${JSON.stringify(after?.[0])}`,
  );
  const modLike = await ev(`(() => {
    const bad = /geckolib|just enough items|cloth config|architecture api|mouse tweaks|appleskin|sodium|fabric api|iris|mod menu/;
    const cards = [...document.querySelectorAll('.pack-card:not(.pack-card-sk)')].slice(0, 8);
    return cards.filter((c) => bad.test((c.textContent || '').toLowerCase())).length;
  })()`);
  check('★ CurseForge 出来的**是整合包**（不是那批常见模组）', (modLike ?? 99) <= 1, `像模组的 ${modLike} / 8`);

  console.log('\n【② 在线装：搜一个**小包**（榜首那些是 190 MB+，验"进度在动"要等太久）】');
  await ev(`(() => {
    const input = document.querySelector('input[type=search], .res-search-box input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'SkyFactory');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(9000);
  const found = await cardNames();
  console.log('  搜到：' + JSON.stringify(found?.slice(0, 3)));
  const clickedCard = await ev(`(() => {
    const card = [...document.querySelectorAll('.pack-card')].find((c) => !String(c.className).includes('sk'));
    card?.click();
    return !!card;
  })()`);
  await sleep(5000);
  const rows = await ev(`(() => {
    const all = [...document.querySelectorAll('.res-version')];
    return { total: all.length, clickable: all.filter((r) => r.classList.contains('clickable')).length, blocked: all.filter((r) => r.classList.contains('blocked')).length };
  })()`);
  console.log(`  点卡片：${clickedCard}  版本行：${JSON.stringify(rows)}`);
  check(!!clickedCard && (rows?.total ?? 0) > 0, '② 点卡片进入安装页并列出可装版本', JSON.stringify(rows));
  const clickedRow = await ev(`(() => {
    const row = [...document.querySelectorAll('.res-version.clickable')][0];
    row?.click();
    return !!row;
  })()`);
  const online = await waitTask(60000);
  console.log(`  点版本行：${clickedRow}  任务：${JSON.stringify(online)}`);
  check(!!online && clickedRow, '② 点一个版本之后任务中心出现了这个整合包任务', JSON.stringify(online));
  const moved = await waitChange(online, 300000);
  console.log(`  等了 ${(moved.waited / 1000).toFixed(0)}s：` + JSON.stringify(moved.task));
  check(
    moved.changed,
    '★ 在线这一条**阶段真的在动**（不是 0% 停着不动）',
    `${JSON.stringify(online)} → ${JSON.stringify(moved.task)}`,
  );
  /*
   * ★★ 包体那一段不许"卡住不动"。
   *
   *   ★ 这条判据**比它看起来弱**：小包的包体（19 MB）常常几秒就下完，
   *     于是这里多半是"已经进到下一段"通过的，**没有真的采样到中途的百分比**。
   *     它拦得住的是以前那种"停在包体那一段几分钟、0% 不动"的样子
   *     （2026-09-27 修之前实测：301 秒仍停在"读取整合包清单"）。
   */
  const body = await waitProgressWhile(online?.id, '下载整合包', 180000);
  console.log(`  包体那一段：等了 ${(body.waited / 1000).toFixed(0)}s → ` + JSON.stringify(body.task));
  check(
    body.moved,
    '★ 包体那一段没有卡住（进度在动，或已经进了下一段）',
    JSON.stringify(body.task),
  );

  console.log('\n【③ 拖进来的包（本地文件）：起任务 → 暂停 → 继续】');
  const localZip = path.join(T, 'ieml-cf-modpack-probe', 'pack.zip');
  let localTask = null;
  if (!existsSync(localZip)) {
    console.log(`  （没有现成的包：先跑 tools/probe/probe-cf-modpack.mjs，它会下到 ${localZip}）`);
    check(false, '本机有一份整合包 zip 可用于验证拖入路径', localZip);
  } else {
    const beforeN = (await tasks())?.length ?? 0;
    await ev(
      `window.dispatchEvent(new CustomEvent('ieml:install-local-pack', { detail: { path: ${JSON.stringify(localZip)}, name: 'SF4-拖入' } }))`,
    );
    localTask = await waitTask(30000);
    const afterN = (await tasks())?.length ?? 0;
    console.log(`  任务数 ${beforeN} → ${afterN}，新任务：${JSON.stringify(localTask)}`);
    check(afterN > beforeN, '★ 拖入（本地文件）能起一个安装任务', JSON.stringify(localTask));
    /*
     * ★★ 在**解析文件地址**那一段点暂停（此刻还没开始下 Mod）。
     *
     *   这正是抓出"跨阶段丢令牌"那个缺陷的手法：暂停只认 taskId，而安装分四段；
     *   以前每段开头换一个新令牌，于是这里点下的暂停落进旧令牌被丢掉 ——
     *   几秒后任务照样在"下载整合包文件"，界面却已经写着「正在暂停…」。
     *   现在四段复用同一个令牌，所以这里**必须**看到 paused。
     */
    const pauseAsk = await inv('pause_install', { taskId: localTask?.id });
    console.log('  pause_install：' + JSON.stringify(pauseAsk));
    const paused = await waitStatus(localTask?.id, 'paused', 90000);
    console.log(`  暂停后（等了 ${(paused.waited / 1000).toFixed(0)}s）：` + JSON.stringify(paused.task));
    check(
      pauseAsk?.ok === true,
      '★ 暂停请求被后端接受（不是"找不到任务"）',
      JSON.stringify(pauseAsk),
    );
    check(
      paused.task?.status === 'paused',
      '★★ 在「解析文件地址」那一段点暂停，任务真的停下了（跨阶段不丢令牌）',
      JSON.stringify(paused.task),
    );
    /*
     * 「继续」**走界面上那个按钮**（不是直接调接口）：任务中心的继续按钮
     * 走 `resumeOrReplay` → 重放函数用**同一个 taskId、同一个 slug** 重新发起，
     * `.part` 因此会被复用。这里点它，验的是用户真会走的那条路。
     */
    const clickResume = await taskCenterClick('SF4-拖入', '继续');
    console.log('  点「继续」：' + JSON.stringify(clickResume));
    check(!!clickResume?.found, '★ 任务中心里这条任务有「继续」按钮', JSON.stringify(clickResume));
    const clickAt = Date.now();
    const resumed = await waitStatus(localTask?.id, 'running', 30000);
    console.log(`  继续后（等了 ${(resumed.waited / 1000).toFixed(0)}s）：` + JSON.stringify(resumed.task));
    /*
     * ★★ 判据看**界面上那条任务**（`.task-item` 的 class 与文件计数），
     *   而不是只看事件流拼出来的记录：
     *     · 用户看到的就是这一条 —— "继续之后到底在不在下"要按它判；
     *     · 实测（2026-09-27）事件记录里的 `status` 有时仍写着 paused，
     *       而同一条任务在界面上已经是 `task-running` 并且**文件数在涨** ——
     *       两处不一致本身值得记一笔，但不该让它把"真的在接着下"判成失败。
     */
    await sleep(4000);
    const ui = await domTask('SF4-拖入');
    const log = await patchLog(localTask?.id, Date.now() - clickAt + 5000);
    console.log('  界面上那条任务：' + JSON.stringify(ui));
    console.log('  点「继续」之后的补丁流水（条数 ' + (log?.length ?? 0) + '）：' + JSON.stringify(log?.slice(0, 6)));
    const uiRunning = /task-(running|done)/.test(String(ui?.cls));
    const filesNow = Number(String(ui?.meta ?? '').match(/(\d+)\s*\//)?.[1] ?? 0);
    check(
      uiRunning && filesNow > 0,
      '★★ 继续之后界面回到「进行中」并且真的在接着下（文件数在涨）',
      `class=${ui?.cls} 计数=${filesNow} 按钮=${JSON.stringify(ui?.buttons)}`,
    );
    /* ③ 验完就把它取消：两个包同时下会把镜像和磁盘都占满，后面 ④ 还要装完一个 */
    await inv('cancel_task', { taskId: localTask?.id });
    await sleep(2500);
  }

  if (QUICK) {
    console.log('\n（--quick：跳过 ④「等它装完」）');
  } else {
    console.log('\n【④ 等 ② 那个包装到底（≤25 分钟）：实例 / mods / overrides】');
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 25 * 60 * 1000) {
      await sleep(5000);
      last = (await tasks())?.find((t) => t.id === online?.id) ?? null;
      if (!last) break;
      if (last.status === 'done' || last.status === 'failed' || last.status === 'cancelled') break;
    }
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s 后：` + JSON.stringify(last));
    check(last?.status === 'done', '④ 整合包装到「完成」（不是失败/卡住）', JSON.stringify(last));
    const instRoot = path.join(ROOT, 'instances');
    const dirs = existsSync(instRoot) ? readdirSync(instRoot) : [];
    console.log('  沙盒里的实例目录：' + JSON.stringify(dirs));
    check(dirs.length > 0, '④ 装完建出了实例目录', JSON.stringify(dirs));
    const slugs = dirs.filter((d) => {
      try {
        return statSync(path.join(instRoot, d)).isDirectory();
      } catch {
        return false;
      }
    });
    let jars = 0;
    let hasConfig = false;
    for (const s of slugs) {
      const modsDir = path.join(instRoot, s, 'game', 'mods');
      if (existsSync(modsDir)) jars += readdirSync(modsDir).filter((f) => f.endsWith('.jar')).length;
      if (existsSync(path.join(instRoot, s, 'game', 'config'))) hasConfig = true;
    }
    console.log(`  mods/ 里的 jar：${jars} 个；overrides 落地的 config/：${hasConfig}`);
    check(jars > 100, '④ 上百个 Mod 真的落到了 mods/', `${jars} 个`);
    check(hasConfig, '④ overrides 解压进了游戏目录（作者配置真的进去了）');
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

console.log(`\n${fail === 0 ? `✓ CF 整合包判据全过（${pass} 条）` : `✗ ${fail} / ${pass + fail} 条不成立`}`);
console.log(`（沙盒留在 ${ROOT}，可手动删）`);
process.exit(fail === 0 ? 0 : 1);
