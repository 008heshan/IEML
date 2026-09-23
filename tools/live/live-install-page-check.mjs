/**
 * 真机验证：「安装游戏」= 下载页第一格 + 两步向导
 * ------------------------------------------------------------------
 * 这条需求当天变过一次向，脚本按**最终**的那一版断言：
 *   · 上午（用户第 4 条）：「安装游戏我也要单开一页，以解放视觉繁乱……
 *     单开一页选择模组加载器，UI 排版你来设计，要好看实用」
 *   · 晚上（用户）：「**把安装版本合并到下载里**；1.转到下载页；2.写"无"」
 *
 * 于是最终形态是：**并回下载页的第一个页签**，但**留下两步向导** ——
 * 合并治的是"侧栏多一个大类"，向导治的是"一屏两层导航 + 十几个控件"。
 *
 * 这一份检查**只断言用户能看到的东西**：
 *   A 侧栏**没有**「安装游戏」这一格了（合并的信号）
 *   B 下载页第一格就是「安装游戏」，而且**默认就落在它上面**
 *   C 进来默认在"选择游戏版本"这一步：有搜索框、有渠道筛选、有版本行
 *   D 步骤条上写着两步，第 1 步选中，第 2 步在没选版本之前是灰的
 *   E 右栏是"选中的版本"结论卡 + 唯一的「下一步」（几何：真的在右栏）
 *   F 点「下一步」→ 第 2 步：加载器 / 版本名称 / 「这次会装什么」/ 安装按钮
 *   G 「上一步」能回来，选中的版本还在；附加组件的短状态写「无」
 *   H 别处的入口（版本列表「新装一个」）**转到下载页**并落在「安装游戏」那一格
 *   I 弹窗形态（派发 `ieml:create`）仍然是一屏两栏，没被向导影响
 *   J 窄窗口（900px）右栏降级到下面去
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
/** 等一个条件成立（最多 ~12 秒），**不猜时间** */
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

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}

/* ---------- A：侧栏里**没有**「安装游戏」（合并的信号） ---------- */
const nav = await ev(`[...document.querySelectorAll('.nav-item')].map((b) => (b.textContent || '').trim())`);
console.log('  侧栏：' + JSON.stringify(nav));
check('★ A1 侧栏不再有「安装游戏」这一格', !(nav ?? []).some((x) => x.includes('安装游戏')), JSON.stringify(nav));
check('★ A2 侧栏仍有「下载」', (nav ?? []).some((x) => x.includes('下载')), JSON.stringify(nav));

/* ---------- B/C/D：下载页第一格就是安装游戏，默认落在它上面 ---------- */
await clickNav('下载');
const gotTabs = await waitFor(`!!document.querySelector('.tabs .tab')`, '下载页页签');
check('★ B1 打开了下载页', gotTabs === true);
const firstTab = await ev(`(() => {
  const tabs = [...document.querySelectorAll('.tabs .tab')].map((t) => ({
    'label': (t.textContent || '').trim(),
    'on': t.classList.contains('on'),
    'selected': t.getAttribute('aria-selected'),
  }));
  return { 'tabs': tabs };
})()`);
console.log('  下载页页签：' + JSON.stringify(firstTab));
check('★ B2 第一格是「安装游戏」', (firstTab?.tabs?.[0]?.label ?? '') === '安装游戏', JSON.stringify((firstTab?.tabs ?? []).map((t) => t.label)));
check('★ B3 默认就选中「安装游戏」', firstTab?.tabs?.[0]?.on === true && firstTab?.tabs?.[0]?.selected === 'true', JSON.stringify(firstTab?.tabs?.[0]));
check('★ B4 一共六格（安装游戏 + 整合包 + Mod + 资源包 + 光影 + 数据包）', (firstTab?.tabs ?? []).length === 6, String((firstTab?.tabs ?? []).length));

/* 万一默认不在那一格（比如上次留在别的页签），显式点一下再继续 */
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t) => (t.textContent || '').trim() === '安装游戏')?.click()`);
const gotPage = await waitFor(`!!document.querySelector('.gw')`, '安装游戏向导');
check('★ C0 安装游戏那一格渲染的是两步向导（.gw）', gotPage === true);

/*
 * ★ 先看**清单还没到**的那几秒（真机冷启动实测要几秒）。
 *   这时右栏绝不能装作"已经选好了"：空版本号会算出 Java 8 / 220 MB 这种**编出来的**数字。
 *   两种情况都算通过：要么已经选好了版本，要么明说"正在拉取"。
 */
const early = await ev(`(() => {
  const side = document.querySelector('.gw-side');
  const id = (side?.querySelector('.gw-pick-id')?.textContent || '').trim();
  return {
    'id': id,
    'saidLoading': /正在拉取|没拿到版本清单/.test(id),
    'fabricatedFacts': !/^[0-9]/.test(id) && !!side?.querySelector('.gw-facts'),
    'picked': (document.querySelector('.gw-step-value')?.textContent || '').trim(),
  };
})()`);
console.log('  清单未到时的右栏：' + JSON.stringify(early));
check(
  '★ B1b 清单还没到时不说假话（要么已选好，要么明说正在拉取）',
  early?.saidLoading === true || early?.fabricatedFacts === false,
  JSON.stringify(early),
);

/* 等清单真的到了（版本行的出现 = 清单到手），不再靠 sleep 猜 */
const gotList = await waitFor(
  `document.querySelectorAll('.gw-col .wz-item').length > 0 || document.querySelectorAll('.gw-col .ver-group').length > 0`,
  '版本清单',
);
check('★ B5 版本清单真的列出了版本', gotList === true);
await sleep(600);

const step1 = await ev(`(() => {
  const steps = [...document.querySelectorAll('.gw-step')].map((b) => ({
    'label': (b.querySelector('.gw-step-label')?.textContent || '').trim(),
    'value': (b.querySelector('.gw-step-value')?.textContent || '').trim(),
    'on': b.classList.contains('on'),
    'done': b.classList.contains('done'),
    'disabled': b.disabled,
  }));
  const list = document.querySelector('.gw-col .cw-list');
  return {
    'title': (document.querySelector('.page-title')?.textContent || '').trim(),
    'steps': steps,
    'searchBox': !!document.querySelector('.gw-col .cw-left-tools input'),
    'channelSeg': (document.querySelector('.gw-col .cw-left-tools .seg')?.textContent || '').trim(),
    'rows': document.querySelectorAll('.gw-col .wz-item').length,
    'groups': document.querySelectorAll('.gw-col .ver-group').length,
    'listH': list ? Math.round(list.getBoundingClientRect().height) : 0,
  };
})()`);
console.log('  第 1 步：' + JSON.stringify(step1));
check('★ C1 页头仍是「下载」（它是下载页的一格，不是独立页）', step1?.title === '下载', String(step1?.title));
check('★ C2 默认在"选择游戏版本"这一步', step1?.steps?.[0]?.on === true, JSON.stringify(step1?.steps?.[0]));
check(
  '★ C3 有搜索框 + 渠道筛选（正式版/快照/愚人节/全部）',
  step1?.searchBox === true && /正式版/.test(step1?.channelSeg ?? '') && /愚人节/.test(step1?.channelSeg ?? ''),
  JSON.stringify(step1?.channelSeg),
);
check('★ C4 清单到手后自动选中了最新正式版', /^[0-9]/.test(step1?.steps?.[0]?.value ?? ''), String(step1?.steps?.[0]?.value));
check('★ C5 步骤条上写着两步', (step1?.steps ?? []).length === 2, JSON.stringify((step1?.steps ?? []).map((s) => s.label)));
check('★ C6 第 2 步在选好版本之前是灰的', step1?.steps?.[1]?.disabled === true || step1?.steps?.[1]?.on === false, JSON.stringify(step1?.steps?.[1]));

const side1 = await ev(`(() => {
  const side = document.querySelector('.gw-side');
  const col = document.querySelector('.gw-col');
  const list = document.querySelector('.gw-col .cw-list');
  const btn = side ? [...side.querySelectorAll('button')].find((b) => /下一步/.test(b.textContent || '')) : null;
  const sr = side?.getBoundingClientRect();
  const cr = col?.getBoundingClientRect();
  return {
    'hasSide': !!side,
    'sideTitle': (side?.querySelector('.wz-block-title')?.textContent || '').trim(),
    'picked': (side?.querySelector('.gw-pick-id')?.textContent || '').trim(),
    'facts': [...(side?.querySelectorAll('.gw-facts > div') ?? [])].map((d) => (d.textContent || '').trim()),
    'btn': (btn?.textContent || '').trim(),
    'btnEnabled': btn ? !btn.disabled : null,
    'sideX': sr ? Math.round(sr.x) : 0,
    'colRight': cr ? Math.round(cr.right) : 0,
    'listH': list ? Math.round(list.getBoundingClientRect().height) : 0,
    'sideBg': side ? getComputedStyle(side).backgroundColor : '',
    'colBg': col ? getComputedStyle(col.parentElement).backgroundColor : '',
  };
})()`);
console.log('  第 1 步右栏：' + JSON.stringify(side1));
check('★ D1 右栏是"选中的版本"结论卡', /选中的版本/.test(side1?.sideTitle ?? ''), String(side1?.sideTitle));
check('★ D2 右栏写出了选中的版本号', /^[0-9]/.test(side1?.picked ?? ''), String(side1?.picked));
check(
  '★ D3 右栏给了盘上 / Java / 体积三条事实',
  (side1?.facts ?? []).length >= 3 && /Java/.test(JSON.stringify(side1?.facts)),
  JSON.stringify(side1?.facts),
);
check('★ D4 右栏真的有「下一步」，而且可点', /下一步/.test(side1?.btn ?? '') && side1?.btnEnabled === true, String(side1?.btn));
check('★ D5 右栏在版本清单**右边**（不是被挤到下面）', (side1?.sideX ?? 0) >= (side1?.colRight ?? 0) - 2, `side.x=${side1?.sideX} col.right=${side1?.colRight}`);
check('★ D6 右栏底色与左栏不同（结论区有分层）', side1?.sideBg !== side1?.colBg, `${side1?.sideBg} vs ${side1?.colBg}`);
check('★ D7 版本清单有真实高度（没被压扁）', (side1?.listH ?? 0) > 200, `高度=${side1?.listH}`);

/* ★ 留一张第 1 步的图（排版要**看**，不是只量数字） */
{
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) writeFileSync(path.join(OUT, '第1步-选择游戏版本.png'), Buffer.from(s.result.data, 'base64'));
}

/* ---------- I：窗口窄下来时的降级（右栏收到下面去，清单不许被挤成一条缝） ---------- */
await send('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(700);
const narrow = await ev(`(() => {
  const side = document.querySelector('.gw-side');
  const col = document.querySelector('.gw-col');
  const sr = side?.getBoundingClientRect();
  const cr = col?.getBoundingClientRect();
  const list = document.querySelector('.gw-col .cw-list');
  return {
    'sideY': sr ? Math.round(sr.y) : 0,
    'colBottom': cr ? Math.round(cr.bottom) : 0,
    'sideW': sr ? Math.round(sr.width) : 0,
    'listW': list ? Math.round(list.getBoundingClientRect().width) : 0,
    'listH': list ? Math.round(list.getBoundingClientRect().height) : 0,
  };
})()`);
console.log('  900px 宽：' + JSON.stringify(narrow));
check('★ I1 窄窗口时右栏收到清单**下面**（不并排）', (narrow?.sideY ?? 0) >= (narrow?.colBottom ?? 0) - 4, JSON.stringify(narrow));
check('★ I2 窄窗口时清单仍然有宽度与高度', (narrow?.listW ?? 0) > 400 && (narrow?.listH ?? 0) > 80, `w=${narrow?.listW} h=${narrow?.listH}`);
await send('Emulation.clearDeviceMetricsOverride', {});
await sleep(500);

/* ---------- E：第 2 步 ---------- */
const before = side1?.picked;
await ev(`[...document.querySelectorAll('.gw-side button')].find((b) => /下一步/.test(b.textContent || ''))?.click()`);
const gotStep2 = await waitFor(`!!document.querySelector('.gw-side .gw-facts') && /这次会装什么/.test(document.querySelector('.gw-side')?.innerText || '')`, '第 2 步');
check('★ E1 点「下一步」真的到了第 2 步', gotStep2 === true);
await sleep(1200);

const step2 = await ev(`(() => {
  const side = document.querySelector('.gw-side');
  const steps = [...document.querySelectorAll('.gw-step')].map((b) => ({
    'label': (b.querySelector('.gw-step-label')?.textContent || '').trim(),
    'value': (b.querySelector('.gw-step-value')?.textContent || '').trim(),
    'on': b.classList.contains('on'),
    'done': b.classList.contains('done'),
  }));
  const opts = [...document.querySelectorAll('.base-opt')].map((b) => (b.querySelector('.b-name')?.textContent || '').trim());
  const install = [...side.querySelectorAll('button')].find((b) => /^安装/.test((b.textContent || '').trim()));
  return {
    'steps': steps,
    'loaders': opts,
    'hasNameInput': !!document.querySelector('.gw-side input.input'),
    'nameValue': document.querySelector('.gw-side input.input')?.value ?? '',
    'hasAddons': document.querySelectorAll('.addon-opt').length,
    'confirm': (side.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
    'install': (install?.textContent || '').trim(),
    'installEnabled': install ? !install.disabled : null,
    'hasBack': [...side.querySelectorAll('button')].some((b) => /上一步/.test(b.textContent || '')),
    'leftIsLoader': /模组加载器/.test(document.querySelector('.gw-col')?.innerText || ''),
    /*
     * ★ 用户第二条：「写「无」」—— 附加组件选不了时，短状态就是「无」；
     *   那个说错话的红角标（「与当前加载器不兼容」）必须**不存在**了。
     *   理由仍在 title 里（禁用必须给具体理由，这一条是项目的铁律）。
     */
    'addonShort': [...document.querySelectorAll('.addon-opt')].map((b) => ({
      'name': (b.querySelector('.a-name')?.textContent || '').trim(),
      'disabled': b.disabled,
      'note': (b.querySelector('.a-note')?.textContent || '').trim(),
      'title': (b.getAttribute('title') || '').slice(0, 60),
      'chips': [...b.querySelectorAll('.a-name .chip')].map((c) => (c.textContent || '').trim()),
    })),
  };
})()`);
console.log('  第 2 步：' + JSON.stringify(step2));
check('★ E2 第 2 步是"选择模组加载器"（步骤条高亮在第 2 步）', step2?.steps?.[1]?.on === true && step2?.steps?.[0]?.done === true, JSON.stringify(step2?.steps));
check('★ E3 左边确实是加载器选择（不是又一份版本清单）', step2?.leftIsLoader === true && (step2?.loaders ?? []).length >= 2, JSON.stringify(step2?.loaders));
check('★ E4 有「版本名称」输入框，且默认名已填好', step2?.hasNameInput === true && (step2?.nameValue ?? '').length > 0, String(step2?.nameValue));
check('★ E5 有「这次会装什么」的确认清单', /这次会装什么/.test(step2?.confirm ?? ''), (step2?.confirm ?? '').slice(0, 80));
check('★ E6 只有一个安装按钮、且可点', /^安装/.test(step2?.install ?? '') && step2?.installEnabled === true, String(step2?.install));
check('★ E7 第 2 步能回上一步', step2?.hasBack === true);
check('★ E8 步骤条第 1 步写着选中的版本（翻页后不丢）', (step2?.steps?.[0]?.value ?? '') === before, `步骤条=${step2?.steps?.[0]?.value} 之前=${before}`);

/* ---------- 用户第二条：附加组件的短状态写「无」 ---------- */
console.log('  附加组件：' + JSON.stringify(step2?.addonShort));
{
  const addons = step2?.addonShort ?? [];
  const disabledOnes = addons.filter((a) => a.disabled);
  check(
    '★ G1 选不了的附加组件：短状态写「无」',
    disabledOnes.length > 0 && disabledOnes.every((a) => a.note.includes('无') || a.note.includes('查不到')),
    JSON.stringify(disabledOnes.map((a) => [a.name, a.note])),
  );
  check(
    '★ G2 那个说错话的红角标「与当前加载器不兼容」没有了',
    addons.every((a) => !a.chips.some((c) => /不兼容/.test(c))),
    JSON.stringify(addons.map((a) => a.chips)),
  );
  check(
    '★ G3 理由没丢（仍在悬停提示里）',
    disabledOnes.length === 0 || disabledOnes.some((a) => a.title.length > 4),
    JSON.stringify(disabledOnes.map((a) => a.title)),
  );
}
{
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) writeFileSync(path.join(OUT, '第2步-选择模组加载器.png'), Buffer.from(s.result.data, 'base64'));
}

/* ---------- F：回上一步，选择还在 ---------- */
await ev(`[...document.querySelectorAll('.gw-side button')].find((b) => /上一步/.test(b.textContent || ''))?.click()`);
await sleep(1200);
const back = await ev(`(() => ({
  'picked': (document.querySelector('.gw-pick-id')?.textContent || '').trim(),
  'rows': document.querySelectorAll('.gw-col .wz-item').length,
  'selected': document.querySelectorAll('.gw-col .wz-item.on').length,
}))()`);
console.log('  回到第 1 步：' + JSON.stringify(back));
check('★ F1 回到第 1 步，选中的版本还在', back?.picked === before, `${back?.picked} vs ${before}`);
check('★ F2 清单里那一行仍然是选中态', back?.selected === 1, `选中 ${back?.selected} 行`);

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
  const tabs = [...document.querySelectorAll('.tabs .tab')].map((t) => ({
    'label': (t.textContent || '').trim(),
    'on': t.classList.contains('on'),
  }));
  return {
    'page': (document.querySelector('.page-title')?.textContent || '').trim(),
    'tabs': tabs,
    'onTab': (tabs.find((t) => t.on)?.label ?? ''),
    'hasWizard': !!document.querySelector('.gw'),
  };
})()`);
console.log(`  版本列表「${entry}」→ ` + JSON.stringify(landed));
check('★ H1 「新装一个」把人送到**下载页**', landed?.page === '下载', String(landed?.page));
check('★ H2 而且落在「安装游戏」那一格（不用再自己找）', landed?.onTab === '安装游戏', String(landed?.onTab));
check('★ H3 落地的就是两步向导', landed?.hasWizard === true);

/* ---------- I：弹窗形态没被牵连 ----------
 *
 * ★★ 这里**不是**点按钮进去的：`CreateInstanceModal` 唯一的派发点在
 *   `InstanceSetup` 的"一个实例都没有"空状态里，而那要先进一个实例才看得到 ——
 *   也就是说**应用里没有任何一条能走到它的路**（这一条已在报告里如实说明）。
 *   但它仍然是 AppShell 里挂载着的组件，而 `InstallComposer` 的 modal 分支
 *   正是靠它才存在，所以这里直接派发它监听的那个事件，把弹窗打开来验。
 */
await ev(`window.dispatchEvent(new CustomEvent('ieml:create'))`);
const modalOpen = await waitFor(`!!document.querySelector('.cw-shell-modal')`, '创建版本弹窗');
check('★ I1 弹窗能打开（派发 ieml:create）', modalOpen === true);
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
    'hasSteps': !!shell.querySelector('.gw-steps'),
    'hasGwClass': !!shell.querySelector('.gw-side, .gw-body'),
    'leftX': lr ? Math.round(lr.x) : 0,
    'rightX': rr ? Math.round(rr.x) : 0,
    'hasFoot': !!foot,
    'footText': (foot?.innerText || '').replace(/\\s+/g, ' ').slice(0, 90),
    'hasName': !!shell.querySelector('input.input'),
    'loaders': [...shell.querySelectorAll('.base-opt .b-name')].map((b) => (b.textContent || '').trim()),
  };
})()`);
console.log('  弹窗：' + JSON.stringify(modal));
check('★ I2 弹窗仍然是左右两栏（没被向导改掉）', (modal?.rightX ?? 0) > (modal?.leftX ?? 0), `left=${modal?.leftX} right=${modal?.rightX}`);
check('★ I3 弹窗里**没有**步骤条 / 向导容器', modal?.hasSteps === false && modal?.hasGwClass === false);
check('★ I4 弹窗底部仍有常驻摘要 + 唯一的按钮', modal?.hasFoot === true && /约下载/.test(modal?.footText ?? ''), String(modal?.footText));
check('★ I5 弹窗里版本清单与加载器都在（一份实现两处用）', (modal?.loaders ?? []).length >= 2 && modal?.hasName === true, JSON.stringify(modal?.loaders));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '弹窗形态.png'), Buffer.from(shot.result.data, 'base64'));
check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
