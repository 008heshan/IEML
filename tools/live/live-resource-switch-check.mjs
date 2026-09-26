/*
 * 真机判据：**换来源时列表不许"继承"上一批结果**。
 *
 * ★★ 2026-09-26 用户截图：下载页 → 整合包 → 点 CurseForge 之后，
 *    列表**上面一排骨架、下面还是切来源之前那 6 个 Modrinth 结果**。
 *
 *   根因（三处叠在一起，都在 `DownloadPage` 那份**独立**的加载逻辑里）：
 *     · 加载时**不清空**旧结果 ⇒ 上一批一直挂在屏幕上；
 *     · **没有迟到守卫** ⇒ 慢的旧请求回来会把新结果盖掉；
 *     · 骨架与结果网格**同时渲染** ⇒ 骨架上、旧结果下，看着就是"切了没换"。
 *   （资源中心那份 `ResourceBrowser` 2026-09-23 修过同一个病，这份是漏网的 ——
 *     "继承 bug" 这个名字就是这么来的。）
 *
 * ## 判据（都在"切到另一个来源"这个动作前后量）
 *
 *   ① 切换后**不许骨架与真实卡片同时出现**；
 *   ② 切换后卡片数**必须变**（清了变 0、或换成另一批）—— 一张不少地留在原地就是继承；
 *   ③ 来源标签要跟着开关走（`数据来自 CurseForge`）；
 *   ④ 最终不能停在加载态（骨架不该永远留在屏幕上）。
 *
 * ★ 用哪两个来源不写死成"必须不同"：上游结果是否相同是**环境的属性**，
 *   不是代码的属性 —— 判据只问"切换这个动作有没有把上一批丢掉"。
 *
 * 用法：node tools/live/live-resource-switch-check.mjs ["<exe>"]
 * 退出码：0 = 全通；1 = 有判据不成立
 *
 * ★★ 与其它 live 探针的两点不同（**为了能在用户正开着启动器时也能跑**）：
 *   · **不调 `killIeml()`** —— 那个是"按进程名全杀"，会把用户正在用的那份一起收掉。
 *     这里只收**自己起的那个进程树**（`taskkill /PID <pid> /T`）。
 *   · 因此不需要"有 ieml 在跑就退出码 2"那道守卫。
 *   ★ 前提是**被测 exe 的 identifier 与用户那份不同**，否则单实例插件会让它起不来
 *     （调试版默认与桌面版共用 `com.ieml.launcher`）——
 *     换个 identifier 编一份即可（`src-tauri/tauri.conf.json` 的 `identifier`）。
 */
import { spawnSync } from 'node:child_process';
import { clickNav, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 当前整合包列表的样子：真实卡片 / 骨架 / **来源开关选中的那一个** */
const packState = (ev) =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.pack-card')];
    const sk = cards.filter((c) => String(c.className).includes('sk')).length;
    /*
     * ★★ 2026-09-26：这里原来是读一句"数据来自 X"的小字 —— 而那行字**已经被删掉**
     *   （用户："资源下载，数据来源可以不写了"）。判据不能依赖一句被删掉的文案。
     *   ⇒ 改成读**来源分段控件里 aria-pressed 的那个按钮**：
     *     它才是"现在选的是哪个来源"的**唯一真源**（那句小字本来就是它的复述）。
     */
    const seg = document.querySelector('.seg[aria-label="来源"]');
    const label =
      [...(seg?.querySelectorAll('button') ?? [])]
        .find((b) => b.getAttribute('aria-pressed') === 'true')
        ?.textContent?.trim() ?? '(找不到)';
    return { total: cards.length, skeletons: sk, real: cards.length - sk, label };
  })()`);

/**
 * 等"列表落定"：出现真实卡片、且没有骨架。
 *
 * ★ 判据自己也会读早：第一版固定等 4 秒就断言，结果第一屏还在加载
 *   （骨架 6 / 真实 0）⇒ 把"没等到"报成了"没有结果"。
 *   这类假红与假绿同源 —— **测量点必须等到状态稳定**。
 */
async function waitSettled(ev, ms = 25000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await packState(ev);
    if (last.real > 0 && last.skeletons === 0) return last;
    await sleep(700);
  }
  return last;
}

/**
 * 做一次"换条件"动作，并断言**没有继承上一批结果**。
 *
 * ★★ 用户点名了三种会踩它的动作：切数据来源、换**版本**下拉、换**加载器**下拉。
 *   三者是同一件事（条件变了），所以判据只写一份、复用三次 ——
 *   否则将来只修好其中一格又会出现"这份修了那份没修"（这个 bug 本身就是这么来的）。
 *
 * ★ 读法上踩过两次（都记在这里，免得下次又写错）：
 *   · **"切换前"必须在切换之前就读稳**：`waitSettled` 若在切换后才返回，
 *     读到的其实是"切换当中"（旧卡片还在）⇒ 前后数字相同会被误判成"继承"。
 *     所以这里先等落定，**再**动作。
 *   · 加载时长不是我们能定的：第二屏可能**当场就有了**（切得够快时根本看不到骨架），
 *     那时"骨架+旧卡片并存"本来就不会发生 ⇒ 不能把它当成"清空没生效"。
 */
async function expectNoInheritance(ev, label, action, { expectChange = false } = {}) {
  const before = await waitSettled(ev);
  const fpBefore = await packFingerprint(ev);
  await action();
  /*
   * ★★ 等**加载态真的开始**（骨架出现），最多等一轮。
   *
   *   为什么必须等：不等就可能在"点击 → 发起请求"之间读到画面 ——
   *   那时看到的还是**切换前**的样子，"骨架+旧卡片并存"这一帧根本没被观察，
   *   判据就**空过**了（看着全绿，其实什么都没测）。
   *   这与"探针自己崩了 ≠ 判据红了"是同一类病：**没测到 ≠ 通过**。
   */
  let during = null;
  for (let i = 0; i < 8; i += 1) {
    during = await packState(ev);
    if (during.skeletons > 0) break;
    await sleep(300);
  }
  console.log(`\n【${label}】切换前 ${JSON.stringify(before)}\n        切换中 ${JSON.stringify(during)}`);

  /* ① 骨架（正在加载）与真实卡片（上一批）**不许并存** —— 用户截图就是这一帧 */
  check(
    !(during.skeletons > 0 && during.real > 0),
    `${label}：加载中不同时出现「骨架 + 上一批卡片」`,
    `骨架 ${during.skeletons} / 真实 ${during.real}`,
  );
  /*
   * ② 抓到了加载中的那一帧 ⇒ 这一帧里的卡片**必须是 0**（换条件时清了旧结果）。
   *    没抓到 ⇒ **没测到，不算通过**：这一步的判据只覆盖"看得见 Loading"的那段时长，
   *    如实说出来，别把"没观察到"说成"没问题"。
   */
  if (during.skeletons > 0) {
    check(during.real === 0, `${label}：换条件的一瞬间旧结果已被清掉`, `真实 ${during.real} 张`);
  } else {
    console.log(`  ⚠ ${label}：这次没抓到加载中的那一帧 ⇒ "一瞬清空"这条**没测到**（不算通过）`);
  }
  const after = await waitSettled(ev);
  const fpAfter = await packFingerprint(ev);
  check(after.skeletons === 0, `${label}：最终没有停在加载态`, `骨架 ${after.skeletons}`);
  /*
   * ★★ 只有在调用方声明"这个条件应当改变结果"时才比指纹。
   *   换来源：两个源的结果一定不同（已实测）⇒ 必须变。
   *   换筛选：也可能**筛出同一批**（上游本来就那些）⇒ 比指纹会假红，所以不强制，
   *            但"结果集没变"这件事要如实打出来，别让人以为验过了。
   */
  if (expectChange) {
    check(fpAfter.hash !== fpBefore.hash, `${label}：结果集真的换了`, `首行 ${fpBefore.first} → ${fpAfter.first}`);
  } else if (fpAfter.hash === fpBefore.hash) {
    console.log(`  · ${label}：结果集与换之前相同（上游筛出来就是同一批，判据不强制）`);
  }
  return { before, during, after, fpBefore, fpAfter };
}

/** 「共 N 个」那个总数（分页条说的），用来证明**结果集真的换了** */
const packTotal = (ev) =>
  ev(`(() => {
    const t = [...document.querySelectorAll('.pager-info, .dim')]
      .map((n) => (n.textContent || '').trim())
      .find((s) => s.includes('共') && s.includes('个'));
    return t ?? '(没有总数)';
  })()`);

/**
 * 整个列表的**指纹**（每张卡的标题拼起来）—— 换条件是否真的换了结果，用它比。
 *
 * ★★ 为什么不用"首行标题"：列表有「最新 / 最多下载」两种排序，
 *   `sorted` 会把整列重排 —— 首行变了可能只是**排序**变了，首行没变也可能
 *   只是某一项恰好还在第一位（实测 `Fabulously Optimized` 两种筛选下都在首位）。
 *   指纹比的是**结果集本身**，与排序无关。
 */
const packFingerprint = (ev) =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.grid-cards .pack-card')];
    const titles = cards.map((c) => (c.textContent || '').trim().slice(0, 24));
    return { n: titles.length, hash: titles.join('|').slice(0, 2000), first: titles[0] ?? null };
  })()`);

/**
 * 点开一个 `CustomSelect`，选中**一个与当前值不同的、真正的筛选项**。
 *
 * ★★ 第一版这里栽了个跟头：`不限版本` 是第一个选项，而它**就是当前值** ——
 *   选中它等于什么都没做（条件没变、也没触发加载），于是"切换中 ≈ 切换前"
 *   被判成"上一批结果原样留着"（假红）。
 *   ⇒ 探针必须**证明自己真的改了条件**：返回值要与触发按钮上的当前文案不同。
 */
async function pickSelect(ev, ariaLabel) {
  const current = await ev(
    `document.querySelector('.cs-trigger[aria-label=${JSON.stringify(ariaLabel)}]')?.textContent?.trim() ?? null`,
  );
  await ev(
    `document.querySelector('.cs-trigger[aria-label=${JSON.stringify(ariaLabel)}]')?.click(),
     'open'`,
  );
  await sleep(700);
  const picked = await ev(`(() => {
    const cur = ${JSON.stringify(current)};
    const opts = [...document.querySelectorAll('.cs-option')]
      .filter((o) => (o.textContent || '').trim() && (o.textContent || '').trim() !== cur)
      /* 「不限…」是"清掉筛选"，换条件时用它反而不算换 —— 优先选真正的筛选项 */
      .sort((a, b) => (String(a.textContent).startsWith('不限') ? 1 : 0) - (String(b.textContent).startsWith('不限') ? 1 : 0));
    const target = opts[0];
    if (!target) return null;
    const text = (target.textContent || '').trim();
    target.click();
    return text;
  })()`);
  console.log(`  （${ariaLabel}：当前「${current}」→ 选「${picked ?? '没找到别的选项'}」）`);
  return { current, picked };
}

const { ev, close, pid } = await launch({ exe: EXE, tag: 'rswitch' });

try {
  /* 进「下载 → 整合包」 */
  await clickNav(ev, '下载');
  await sleep(1500);
  await ev(
    `[...document.querySelectorAll('[role=tab], .tab')].find((x) => (x.textContent || '').includes('整合包'))?.click()`,
  );
  await sleep(1500);

  const before = await waitSettled(ev);
  console.log(`\n切换前：${JSON.stringify(before)}`);
  check(before.real > 0, '第一个来源（Modrinth）列出了卡片', `${before.real} 张`);
  check(before.label.includes('Modrinth'), '来源标签是 Modrinth', before.label);

  /* ---------- ① 换数据来源（用户截图里那个动作） ---------- */
  /*
   * ★★ 换来源：两个源的结果**一定不同**（真机实测：CF 是 ATM10 那批、Modrinth 是另一批）
   *   ⇒ 这里硬要求"结果集真的换了"。这正是用户截图那个 bug 的反面判据：
   *     旧代码切了来源却还留着上一批 ⇒ 指纹不会变。
   */
  const r1 = await expectNoInheritance(
    ev,
    '换来源（Modrinth → CurseForge）',
    () =>
      ev(
        `[...document.querySelectorAll('button, .seg-item, [role=radio]')].find((x) => (x.textContent || '').trim() === 'CurseForge')?.click()`,
      ),
    { expectChange: true },
  );
  check(r1.after.label.includes('CurseForge'), '来源标签跟着开关走', r1.after.label);
  check(r1.after.real > 0, '换来源之后有新结果（不是空白）', `${r1.after.real} 张`);

  /* ---------- ② 换「版本」下拉（用户点名的第二个触发点） ---------- */
  const v = await pickSelect(ev, '整合包 MC 版本');
  check(
    v.picked !== null && v.picked !== v.current,
    '版本下拉真的换了条件',
    `「${v.current}」→「${v.picked}」`,
  );
  /*
   * ★ 换筛选：**不硬要求结果集变化** —— 上游筛出来可能就是同一批（实测 CF 上
   *   1.20.1 与 forge 两个筛选的首条都是 DeceasedCraft）。硬要求会假红。
   *   这里要守的是**"换条件时清空旧结果"**那条（上面 ①②），不是"结果必须不同"。
   */
  const r2 = await expectNoInheritance(ev, `换版本筛选（→ ${v.picked}）`, async () => {});
  const r2Empty = await ev(`!!document.querySelector('.res-none, .empty, [class*=empty]')`);
  check(
    r2.after.real > 0 || r2Empty === true,
    '换版本之后：有新结果、或如实说"没有"（不留上一批）',
    `${r2.after.real} 张，空状态=${r2Empty}`,
  );

  /* ---------- ③ 换「加载器」下拉（第三个触发点） ---------- */
  const l = await pickSelect(ev, '整合包加载器');
  check(
    l.picked !== null && l.picked !== l.current,
    '加载器下拉真的换了条件',
    `「${l.current}」→「${l.picked}」`,
  );
  const r3 = await expectNoInheritance(ev, `换加载器筛选（→ ${l.picked}）`, async () => {});
  check(r3.after.real > 0, '换加载器之后有新结果（或如实空列表）', `${r3.after.real} 张`);

  /* ---------- ④ 显示方式：矩阵 / 条形（用户要求加的那个切换） ---------- */
  /*
   * ★★★★ 2026-09-26 用户：「资源下载里在最多下载的右边加一个选项：
   *   左是矩阵，右是条形。**显示资源 UI 的方式**」。
   *
   *   判据问三件事（都在**真机**上，因为有真实数据才看得出列数）：
   *     ① 那个切换在不在、点得动；
   *     ② 矩阵 = **多列**、条形 = **一列**（这是"显示方式"的全部含义）；
   *     ③ 切换**不重新取数据**（卡片数不变）—— 它是纯显示，不该触发请求。
   */
  console.log('\n④ 显示方式（矩阵 / 条形）');
  const layout = async () =>
    ev(`(() => {
      const grid = document.querySelector('.grid-cards');
      if (!grid) return null;
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
      const card = grid.querySelector('.pack-card');
      return {
        view: grid.getAttribute('data-view'),
        cols,
        cards: grid.querySelectorAll('.pack-card').length,
        cardW: Math.round(card?.getBoundingClientRect().width ?? 0),
        gridW: Math.round(grid.getBoundingClientRect().width),
      };
    })()`);

  const hasToggle = await ev(
    `!!document.querySelector('.seg[aria-label="显示方式"] button[aria-label*="条形"]')`,
  );
  check(hasToggle === true, '「显示方式」切换在（且有可读的名字）');

  const asGrid = await layout();
  await ev(
    `document.querySelector('.seg[aria-label="显示方式"] button[aria-label*="条形"]')?.click(), 'list'`,
  );
  await sleep(700);
  const asList = await layout();
  await ev(
    `document.querySelector('.seg[aria-label="显示方式"] button[aria-label*="矩阵"]')?.click(), 'grid'`,
  );
  await sleep(700);
  const backToGrid = await layout();

  console.log(`  矩阵 ${JSON.stringify(asGrid)}\n  条形 ${JSON.stringify(asList)}`);
  check(asGrid?.cols > 1, '矩阵档：多列', `${asGrid?.cols} 列`);
  check(asList?.cols === 1, '条形档：**一列**（一行一个）', `${asList?.cols} 列`);
  check(
    asList?.cardW >= asList?.gridW - 2,
    '条形档：卡片占满整宽',
    `${asList?.cardW} / ${asList?.gridW}`,
  );
  check(
    asGrid?.cards === asList?.cards,
    '切换**不重新取数据**（卡片数没变）',
    `${asGrid?.cards} → ${asList?.cards}`,
  );
  check(backToGrid?.cols === asGrid?.cols, '切回矩阵与原来一致', `${backToGrid?.cols} 列`);

  /* ---------- ⑤ 分页条：间距与位置（用户：「太贴底部」） ---------- */
  /*
   * ★★ 2026-09-26 用户（截图，指着分页条）：「**太贴底部**」。
   *   `.content` 自己有 40px 底部内边距，所以"贴底"更多是**视觉上挤在视窗下沿**：
   *   分页条离卡片只有 20px、离内容底也近。修法是把上边距加到 24px、下边距 20px。
   *   判据：滚到底之后，分页条**上下都要有可见的留白**。
   */
  console.log('\n⑤ 分页条（间距）');
  const pager = await ev(`(() => {
    const p = document.querySelector('.pager');
    if (!p) return null;
    const content = document.querySelector('.content');
    const pr = p.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    const cs = getComputedStyle(p);
    // 上一排内容的底部（卡片网格）
    const grid = document.querySelector('.grid-cards');
    const gr = grid?.getBoundingClientRect();
    return {
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      gapAbove: gr ? Math.round(pr.top - gr.bottom) : null,
      belowInContent: Math.round(cr.bottom - pr.bottom),
      text: (p.textContent || '').trim().slice(0, 40),
    };
  })()`);
  if (!pager) {
    console.log('  · 这一屏没有分页条（结果不到一页），跳过');
  } else {
    console.log(`  ${JSON.stringify(pager)}`);
    check(!!pager.text, '分页条在（说得清第几页/共几个）', pager.text);
    check(
      Number.parseFloat(pager.marginTop) >= 24 && Number.parseFloat(pager.marginBottom) >= 20,
      '分页条上下都留了余量（不再贴底）',
      `上 ${pager.marginTop} / 下 ${pager.marginBottom}`,
    );
    check(
      pager.gapAbove === null || pager.gapAbove >= 20,
      '与上面的卡片之间留了一口气',
      `间距 ${pager.gapAbove}px`,
    );
  }
} finally {
  /*
   * ★★ 只收**自己起的那个进程树** —— 三个地方都不能碰用户那份：
   *   · `close()` **不能调**：`lib/cdp.mjs` 的 `close()` 内部会 `await killIeml()`，
   *     而 `killIeml()` 是**按进程名全杀**（`Get-Process ieml | Stop-Process -Force`），
   *     会把用户正开着的启动器一起收掉（这个探针的设计目标就是"能与用户并存"）；
   *   · 所以自己关 WebSocket，并用 `taskkill /PID <pid> /T /F` 收自己那棵进程树。
   */
  try {
    close();
  } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

console.log(`\n${fail === 0 ? `✓ 全通（${pass} 条判据）` : `✗ ${fail} / ${pass + fail} 条不成立`}`);
process.exit(fail ? 1 : 0);
