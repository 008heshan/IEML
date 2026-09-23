/**
 * 真机验证：「安装游戏」= 下载页第一格 + **点一行就进「模组加载器」整屏页**
 * ------------------------------------------------------------------
 * 这条需求当天变过两次向，脚本按**最终**那一版断言：
 *   · 上午（用户第 4 条）：「安装游戏我也要单开一页，以解放视觉繁乱……
 *     单开一页选择模组加载器，UI 排版你来设计，要好看实用」
 *   · 晚上（用户）：「把安装版本合并到下载里；1.转到下载页；2.写"无"」
 *   · 再晚（用户）：「**像 mod 一样点击那行比较不错，然后给模组加载器像 mod 页那样单开一页**」
 *
 * 最终形态：
 *   ① 版本清单（下载页第一格，**整宽一列**）—— **点一行就进下一页**；
 *   ② 模组加载器 —— **自己的一页**（自带页头 + `← 返回` + 底部动作条），
 *      这一屏下载页的页头与页签收起来（与整合包安装页同一套做法）。
 *
 * 断言的都是用户能看到的东西：
 *   A 侧栏**没有**「安装游戏」这一格（合并的信号），「下载」还在
 *   B 下载页第一格就是「安装游戏」，**默认就落在它上面**，一共六格
 *   C 清单页：页头是「下载」/ 有搜索框与渠道筛选 / 有「点一行就进下一页」这句提示 /
 *     清单真的列出 / **整宽**（右栏没了：清单宽度 > 600）
 *   D 点一行 → **整屏**的模组加载器页：标题是「模组加载器」、有「← 返回」、
 *     下载页的页头与页签**都收起来了**、底部动作条有版本 + 安装按钮
 *   E 那一页里有加载器选项、附加组件（短状态「无」、没有"不兼容"角标）、版本名称
 *   F 「返回」回到清单页，而且那一行**仍是选中态**
 *   G 窄窗口 900px：加载器那一行退回竖排（版本下拉在名字下面）
 *   H 别处的入口「新装一个」→ 下载页 + 安装游戏格 + 清单
 *   I 弹窗形态（派发 `ieml:create`）仍然是一屏两栏，没被这些改动牵连
 *
 * ★ 每一步都**等界面真的到了**再读（`waitFor`），不靠 sleep 猜。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9931;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-gw');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-gw-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
for (const d of [OUT, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});

let page = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(500);
}
if (!page) {
  console.error('连不上 CDP');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    const t = String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0];
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};
async function waitFor(expr, note) {
  for (let i = 0; i < 60; i += 1) {
    const v = await ev(expr);
    if (v === true) return true;
    await sleep(200);
  }
  console.log(`  （等不到：${note}）`);
  return false;
}
const clickNav = (label) =>
  ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('${label}'))?.click()`);
const shot = async (file) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) writeFileSync(path.join(OUT, file), Buffer.from(s.result.data, 'base64'));
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}

/* ---------- A：侧栏里**没有**「安装游戏」（合并的信号） ---------- */
const nav = await ev(`[...document.querySelectorAll('.nav-item')].map((b) => (b.textContent || '').trim())`);
console.log('  侧栏：' + JSON.stringify(nav));
check('★ A1 侧栏不再有「安装游戏」这一格', !(nav ?? []).some((x) => x.includes('安装游戏')), JSON.stringify(nav));
check('★ A2 侧栏仍有「下载」', (nav ?? []).some((x) => x.includes('下载')), JSON.stringify(nav));

/* ---------- B：下载页第一格就是安装游戏，默认落在它上面 ---------- */
await clickNav('下载');
check('★ B1 打开了下载页', (await waitFor(`!!document.querySelector('.tabs .tab')`, '下载页页签')) === true);
const tabs = await ev(`[...document.querySelectorAll('.tabs .tab')].map((t) => ({
  'label': (t.textContent || '').trim(),
  'on': t.classList.contains('on'),
  'selected': t.getAttribute('aria-selected'),
}))`);
console.log('  下载页页签：' + JSON.stringify(tabs));
check('★ B2 第一格是「安装游戏」', (tabs?.[0]?.label ?? '') === '安装游戏', JSON.stringify((tabs ?? []).map((t) => t.label)));
check('★ B3 默认就选中「安装游戏」', tabs?.[0]?.on === true && tabs?.[0]?.selected === 'true', JSON.stringify(tabs?.[0]));
check('★ B4 一共六格', (tabs ?? []).length === 6, String((tabs ?? []).length));

/* 万一默认不在那一格，显式点一下再继续 */
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t) => (t.textContent || '').trim() === '安装游戏')?.click()`);
check('★ C0 渲染的是版本清单（.gw）', (await waitFor(`!!document.querySelector('.gw')`, '版本清单')) === true);

/* ---------- C：清单页（整宽一列 + 一句提示） ---------- */
const gotList = await waitFor(
  `document.querySelectorAll('.gw-col .wz-item').length > 0 || document.querySelectorAll('.gw-col .ver-group').length > 0`,
  '版本清单',
);
check('★ C1 清单真的列出了版本', gotList === true);
await sleep(500);

const list = await ev(`(() => {
  const col = document.querySelector('.gw-col');
  const box = document.querySelector('.gw-col .cw-list');
  const r = box?.getBoundingClientRect();
  return {
    'title': (document.querySelector('.page-title')?.textContent || '').trim(),
    'side': !!document.querySelector('.gw-side'),
    'steps': document.querySelectorAll('.gw-step').length,
    'rows': document.querySelectorAll('.gw-col .wz-item').length,
    'groups': document.querySelectorAll('.gw-col .ver-group').length,
    'hasSearch': !!document.querySelector('.gw-col .cw-left-tools input'),
    'seg': (document.querySelector('.gw-col .cw-left-tools .seg')?.textContent || '').trim(),
    'tip': (document.querySelector('.gw-tip')?.textContent || '').trim(),
    'listW': r ? Math.round(r.width) : 0,
    'listH': r ? Math.round(r.height) : 0,
    'colW': col ? Math.round(col.getBoundingClientRect().width) : 0,
  };
})()`);
console.log('  清单页：' + JSON.stringify(list));
check('★ C2 页头仍是「下载」（它是下载页的一格）', list?.title === '下载', String(list?.title));
check('★ C3 有搜索框 + 渠道筛选（正式版/快照/愚人节/全部）', list?.hasSearch === true && /愚人节/.test(list?.seg ?? ''), JSON.stringify(list?.seg));
check('★ C4 有一句「点一行就进下一页」的提示', /点一行/.test(list?.tip ?? ''), String(list?.tip));
check('★ C5 清单是**整宽**的（右栏没了）', (list?.listW ?? 0) > 600 && list?.side === false, `w=${list?.listW} 有右栏=${list?.side}`);
check('★ C6 步骤条也没了（"在第几步"现在由页面本身回答）', list?.steps === 0, String(list?.steps));
check('★ C7 清单有真实高度', (list?.listH ?? 0) > 150, `高度=${list?.listH}`);
await shot('清单页-下载第一格.png');

/* ---------- K：「愚人节」那一档的分类（用户：「这个分类就有点莫名其妙了」） ----------
 *
 * 用户给的截图里，愚人节档被切成了「其他 / 愚人节 / 快照」三组 —— 那是
 * **同一件事有两份白名单**造成的：`domain/loader-caps.ts` 里 9 个，
 * `VersionIcon.tsx` 里另抄了 4 个、还排在快照规则后面，于是
 * `15w14a`/`1.RV-Pre1` 被 `-(pre|rc)` 判成「快照」、`24w14potato`/`25w14craftmine` 落进「其他」。
 * 现在：白名单只留一份 + 愚人节先判 + 这一档**平铺不分组**。
 */
const clickChannel = (label) =>
  ev(`[...document.querySelectorAll('.gw-col .cw-left-tools .seg button')].find((b) => (b.textContent || '').trim() === '${label}')?.click()`);
const readList = () =>
  ev(`(() => ({
    'groups': [...document.querySelectorAll('.gw-col .ver-group')].map((g) => (g.textContent || '').replace(/\\s+/g, ' ').trim()),
    'rows': [...document.querySelectorAll('.gw-col .wz-item')].map((r) => ({
      'id': (r.querySelector('.wz-item-name')?.textContent || '').trim(),
      'tone': (r.querySelector('.vi')?.className || '').replace('vi ', '').trim(),
    })),
  }))()`);

await clickChannel('愚人节');
await sleep(900);
const fools = await readList();
console.log('  愚人节档：' + JSON.stringify(fools));
check('★ K1 愚人节档**一个组标题都没有**（平铺）', (fools?.groups ?? ['x']).length === 0, JSON.stringify(fools?.groups));
check('★ K2 愚人节档列出了版本', (fools?.rows ?? []).length >= 6, `${(fools?.rows ?? []).length} 行`);
check(
  '★ K3 每一行的图标都是「愚人节」配色（vi-april）',
  (fools?.rows ?? []).every((r) => r.tone === 'vi-april'),
  JSON.stringify((fools?.rows ?? []).map((r) => [r.id, r.tone])),
);
{
  /* 这四个正是原来被错标成「快照」/「其他」的 */
  const ids = (fools?.rows ?? []).map((r) => r.id);
  const must = ['15w14a', '1.RV-Pre1', '24w14potato', '25w14craftmine'];
  check('★ K4 原来被错标的四个都在这一档里', must.every((m) => ids.includes(m)), JSON.stringify(ids));
}
await shot('愚人节档-平铺.png');

await clickChannel('快照');
await sleep(900);
const snaps = await readList();
check(
  '★ K5 快照档里没有愚人节版本混进来（图标配色判）',
  (snaps?.rows ?? []).every((r) => r.tone !== 'vi-april'),
  JSON.stringify((snaps?.rows ?? []).filter((r) => r.tone === 'vi-april').map((r) => r.id)),
);
check('★ K6 快照档仍然分组显示（世代分组是有用的）', (snaps?.groups ?? []).length > 0, JSON.stringify(snaps?.groups?.slice(0, 3)));

/* 全部档里搜一个愚人节版本：它的组标题应当是「愚人节」而不是「快照」 */
await clickChannel('全部');
await sleep(700);
await ev(`(() => {
  const input = document.querySelector('.gw-col .cw-left-tools input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '15w14a');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(900);
const searched = await readList();
console.log('  搜 15w14a：' + JSON.stringify(searched));
check('★ K7 搜到的 15w14a 图标是愚人节配色（不再被当成快照）', searched?.rows?.[0]?.tone === 'vi-april', JSON.stringify(searched?.rows));
check('★ K8 它的组标题写「愚人节」', (searched?.groups ?? []).some((g) => g.includes('愚人节')), JSON.stringify(searched?.groups));

/* 回到正式版，后面的步骤（点一行进下一页）按原来的路走 */
await ev(`(() => {
  const input = document.querySelector('.gw-col .cw-left-tools input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await clickChannel('正式版');
await sleep(900);

/* ---------- D：点一行 → 整屏的「模组加载器」页 ---------- */
const picked = await ev(`(() => {
  const row = document.querySelector('.gw-col .wz-item');
  const id = (row?.querySelector('.wz-item-name')?.textContent || '').trim();
  row?.click();
  return id;
})()`);
console.log('  点了版本行：' + JSON.stringify(picked));
check('★ D1 点一行直接进了「模组加载器」页', (await waitFor(`!!document.querySelector('.gw-full')`, '模组加载器页')) === true);
await sleep(1400);

const loaderPage = await ev(`(() => {
  const full = document.querySelector('.gw-full');
  const r = full?.getBoundingClientRect();
  const head = full?.querySelector('.page-head');
  const foot = full?.querySelector('.cw-foot');
  const install = foot ? [...foot.querySelectorAll('button')].find((b) => /^安装/.test((b.textContent || '').trim())) : null;
  const back = head ? [...head.querySelectorAll('button')].find((b) => /返回/.test(b.textContent || '')) : null;
  /*
   * ★★ 用户 2026-09-23 夜看着这一页问：「**两个返回按键？**」——
   *   页头一个「← 返回」、底部动作条一个「← 换一个版本」，作用完全一样。
   *   判据：整页里"回退类"按钮**只能有一个**（同一个动作不该有两个入口）。
   */
  const backTexts = [...document.querySelectorAll('.gw-full button')]
    .map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => /返回|换一个版本|回退|上一步/.test(t));
  const opts = [...document.querySelectorAll('.base-opt')].map((b) => (b.querySelector('.b-name')?.textContent || '').trim());
  const nameInput = document.querySelector('.gw-full input.input');
  return {
    'title': (head?.querySelector('.page-title')?.textContent || '').trim(),
    'desc': (head?.querySelector('.page-desc')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    'hasBack': !!back,
    'backCount': backTexts.length,
    'backTexts': backTexts,
    'downloadHeadGone': !document.querySelector('.page-head .page-title') || (document.querySelector('.page-title')?.textContent || '').trim() === '模组加载器',
    'tabsGone': document.querySelectorAll('.tabs .tab').length === 0,
    'loaders': opts,
    'addons': [...document.querySelectorAll('.addon-opt')].map((b) => ({
      'name': (b.querySelector('.a-name')?.textContent || '').trim(),
      'note': (b.querySelector('.a-note')?.textContent || '').trim(),
      'chips': [...b.querySelectorAll('.a-name .chip')].map((c) => (c.textContent || '').trim()),
      'title': (b.getAttribute('title') || '').slice(0, 50),
    })),
    'nameValue': nameInput?.value ?? '',
    /*
     * ★★ **必须在视口里**，不能只"在 DOM 里"。
     *   第一版就是这样漏掉一个真问题的：名字那块被挤到折线以下
     *   （正文可视 507px、内容 589px），我从 DOM 读到 value 就判过了，
     *   而截图里那块是一片空白。判据改成几何：整个输入框要落在窗口内。
     */
    'nameBox': (() => {
      const box = nameInput?.getBoundingClientRect();
      if (!box) return null;
      return {
        'top': Math.round(box.top),
        'bottom': Math.round(box.bottom),
        'w': Math.round(box.width),
        'inViewport': box.top >= 0 && box.bottom <= window.innerHeight && box.width > 80,
      };
    })(),
    'foot': (foot?.innerText || '').replace(/\\s+/g, ' ').trim(),
    'install': (install?.textContent || '').trim(),
    'installEnabled': install ? !install.disabled : null,
    'w': r ? Math.round(r.width) : 0,
    'h': r ? Math.round(r.height) : 0,
  };
})()`);
console.log('  模组加载器页：' + JSON.stringify(loaderPage));
check('★ D2 自己的页头：标题「模组加载器」', loaderPage?.title === '模组加载器', String(loaderPage?.title));
check('★ D3 页头写着"装到哪个版本"', (loaderPage?.desc ?? '').includes(picked), String(loaderPage?.desc));
check('★ D4 有「← 返回」', loaderPage?.hasBack === true);
check(
  '★ D4b 整页**只有一个**回退入口（用户：「两个返回按键？」）',
  loaderPage?.backCount === 1,
  `回退类按钮 ${loaderPage?.backCount} 个：${JSON.stringify(loaderPage?.backTexts)}`,
);
check('★ D5 下载页的页头与页签**都收起来了**（整屏）', loaderPage?.tabsGone === true && loaderPage?.downloadHeadGone === true, `页签数=${loaderPage?.tabsGone}`);
check('★ D6 有加载器选项（含"无 · 纯原版"）', (loaderPage?.loaders ?? []).length >= 2 && (loaderPage?.loaders ?? []).some((x) => /纯原版/.test(x)), JSON.stringify(loaderPage?.loaders));
check('★ D7 有版本名称输入框且已填好', (loaderPage?.nameValue ?? '').length > 0, String(loaderPage?.nameValue));
check(
  '★ D7b 版本名称**在视口里**（不是被挤到折线以下）',
  loaderPage?.nameBox?.inViewport === true,
  JSON.stringify(loaderPage?.nameBox),
);
check('★ D8 底部动作条：写清装什么 + 安装按钮可点', /约下载/.test(loaderPage?.foot ?? '') && /^安装/.test(loaderPage?.install ?? '') && loaderPage?.installEnabled === true, String(loaderPage?.install));
check('★ D9 整屏铺满内容区（不是缩在角落）', (loaderPage?.w ?? 0) > 600 && (loaderPage?.h ?? 0) > 400, `w=${loaderPage?.w} h=${loaderPage?.h}`);

/* ---------- E：附加组件的短状态写「无」（用户第 2 条） ---------- */
{
  const addons = loaderPage?.addons ?? [];
  const dis = addons.filter((a) => a.note);
  check('★ E1 选不了的附加组件：短状态写「无」/「查不到」', dis.length > 0 && dis.every((a) => /无|查不到/.test(a.note)), JSON.stringify(dis.map((a) => [a.name, a.note])));
  check('★ E2 没有任何「不兼容」角标', addons.every((a) => !a.chips.some((c) => /不兼容/.test(c))), JSON.stringify(addons.map((a) => a.chips)));
  check('★ E3 理由仍在悬停提示里', dis.length === 0 || dis.some((a) => a.title.length > 4), JSON.stringify(dis.map((a) => a.title)));
}
await shot('模组加载器页.png');

/* ---------- G：窄窗口（900px）→ 加载器行退回竖排 ---------- */
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const narrow = await ev(`(() => {
  const item = document.querySelector('.gw-full .base-item');
  const opt = item?.querySelector('.base-opt');
  const detail = item?.querySelector('.loader-detail');
  const or = opt?.getBoundingClientRect();
  const dr = detail?.getBoundingClientRect();
  return {
    'isColumn': item ? getComputedStyle(item).flexDirection === 'column' : null,
    'optBottom': or ? Math.round(or.bottom) : 0,
    'detailTop': dr ? Math.round(dr.top) : 0,
    'overflowX': document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`);
console.log('  900px 宽：' + JSON.stringify(narrow));
check('★ G1 窄窗口时加载器那一行退回竖排', narrow?.isColumn === true, JSON.stringify(narrow));
check('★ G2 窄窗口没有横向溢出', (narrow?.overflowX ?? 99) <= 1, String(narrow?.overflowX));
await send('Emulation.clearDeviceMetricsOverride', {});
await sleep(500);

/* ---------- F：返回 → 回到清单页，选择还在 ---------- */
await ev(`[...document.querySelectorAll('.gw-full .page-head button')].find((b) => /返回/.test(b.textContent || ''))?.click()`);
await sleep(1200);
const back = await ev(`(() => ({
  'hasList': !!document.querySelector('.gw'),
  'picked': (document.querySelector('.gw-col .wz-item.on .wz-item-name')?.textContent || '').trim(),
  'tabs': document.querySelectorAll('.tabs .tab').length,
  'title': (document.querySelector('.page-title')?.textContent || '').trim(),
}))()`);
console.log('  返回后：' + JSON.stringify(back));
check('★ F1 「返回」回到清单页', back?.hasList === true && back?.title === '下载', String(back?.title));
check('★ F2 下载页的页签回来了', back?.tabs === 6, String(back?.tabs));
check('★ F3 刚才点的那一行仍是选中态', back?.picked === picked, `${back?.picked} vs ${picked}`);

/* ---------- H：别处的入口「转到下载页」并落在安装游戏那一格 ---------- */
await clickNav('版本列表');
await sleep(1800);
const entry = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /新装一个/.test(x.textContent || ''));
  b?.click();
  return (b?.textContent || '').trim();
})()`);
await sleep(1800);
const landed = await ev(`(() => {
  const tabs = [...document.querySelectorAll('.tabs .tab')].map((t) => ({ 'label': (t.textContent || '').trim(), 'on': t.classList.contains('on') }));
  return {
    'page': (document.querySelector('.page-title')?.textContent || '').trim(),
    'onTab': (tabs.find((t) => t.on)?.label ?? ''),
    'hasList': !!document.querySelector('.gw'),
  };
})()`);
console.log(`  版本列表「${entry}」→ ` + JSON.stringify(landed));
check('★ H1 「新装一个」把人送到**下载页**', landed?.page === '下载', String(landed?.page));
check('★ H2 而且落在「安装游戏」那一格', landed?.onTab === '安装游戏', String(landed?.onTab));
check('★ H3 落地的就是版本清单', landed?.hasList === true);

/* ---------- I：弹窗形态没被牵连 ----------
 *
 * ★★ 这里**不是**点按钮进去的：`CreateInstanceModal` 唯一的派发点在
 *   `InstanceSetup` 的"一个实例都没有"空状态里，而那要先进一个实例才看得到 ——
 *   也就是说**应用里没有任何一条能走到它的路**（已在报告里如实说明）。
 *   但它仍然是 AppShell 里挂载着的组件，而 `InstallComposer` 的 modal 分支
 *   正是靠它才存在，所以这里直接派发它监听的那个事件，把弹窗打开来验。
 */
await ev(`window.dispatchEvent(new CustomEvent('ieml:create'))`);
check('★ I1 弹窗能打开（派发 ieml:create）', (await waitFor(`!!document.querySelector('.cw-shell-modal')`, '创建版本弹窗')) === true);
await sleep(800);
const modal = await ev(`(() => {
  const shell = document.querySelector('.cw-shell-modal');
  if (!shell) return { 'open': false };
  const left = shell.querySelector('.cw-left');
  const right = shell.querySelector('.cw-right');
  const foot = shell.querySelector('.cw-foot');
  const lr = left?.getBoundingClientRect();
  const rr = right?.getBoundingClientRect();
  return {
    'open': true,
    'hasFull': !!shell.querySelector('.gw-full'),
    'leftX': lr ? Math.round(lr.x) : 0,
    'rightX': rr ? Math.round(rr.x) : 0,
    'hasFoot': !!foot,
    'footText': (foot?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
    'loaders': [...shell.querySelectorAll('.base-opt .b-name')].map((b) => (b.textContent || '').trim()),
  };
})()`);
console.log('  弹窗：' + JSON.stringify(modal));
check('★ I2 弹窗仍是左右两栏（没被整页形态改掉）', (modal?.rightX ?? 0) > (modal?.leftX ?? 0), `left=${modal?.leftX} right=${modal?.rightX}`);
check('★ I3 弹窗里**没有**整屏页容器', modal?.hasFull === false);
check('★ I4 弹窗底部仍有常驻摘要 + 唯一的按钮', modal?.hasFoot === true && /约下载/.test(modal?.footText ?? ''), String(modal?.footText));
check('★ I5 弹窗里加载器选项在（一份实现两处用）', (modal?.loaders ?? []).length >= 2, JSON.stringify(modal?.loaders));
await shot('弹窗形态.png');

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
