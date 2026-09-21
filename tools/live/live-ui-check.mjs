/**
 * 真机 UI 验证：启动桌面版，用 WebView2 的 CDP 把界面读出来。
 * ------------------------------------------------------------------
 * 为什么需要它：单元测试证明不了"用户点得到那个按钮"。
 * 用户这轮报的几条（"根本没这个功能键"、"显示有但点了不让选"）
 * 全都是**界面层**的问题 —— 只有在真的把界面渲染出来之后才验得了。
 *
 * 做法：
 *   ① 用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
 *      启动桌面版（WebView2 自带 CDP，不用装任何东西）
 *   ② 从 `/json/list` 拿到 page 的 ws 地址
 *   ③ 用 `Runtime.evaluate` 在页面里跑断言
 *
 * 用法：node tools/live/live-ui-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9333;
/*
 * ★ 可以指定 exe：`node tools/live/live-ui-check.mjs [<exe>]`。
 *   默认仍是桌面那份（"用户双击到的那一份"才是它要验的对象），
 *   但开发时可以拿 `src-tauri/target/debug/ieml.exe` 跑 ——
 *   2026-09-22 有过一次教训：反复跑真机脚本触发了 Defender 的行为式 ML，
 *   把桌面交付物与 release 产物一起隔离了。**验证不一定要拿交付物去冒险。**
 */
const EXE = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');

/**
 * 期望的版本号 —— 从 `package.json` 读，**不写死**。
 *
 * ★ 写死的话，每次升版本这条断言都要跟着改；忘了改就会出现
 *   "测试说版本不对，其实代码是对的"这种最浪费时间的红。
 *   （要在 `set-version.mjs` 与这里的期望值之间保持同步的，是**同一份数据**，
 *   那就直接从那一份数据读。）
 */
const expectedVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    );
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
})();

if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

/* ---------- ① 启动（带 CDP 开关） ---------- */
const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  detached: false,
  stdio: 'ignore',
});
console.log(`启动桌面版 PID ${child.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return null;
}

const page = await getPage();
if (!page) {
  console.error('✗ WebView2 的 CDP 没起来（界面可能没渲染出来）');
  child.kill();
  process.exit(1);
}
console.log(`✓ 界面已渲染：${page.title}  ${page.url}`);

/* ---------- ② 在页面里跑断言 ---------- */
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

function evaluate(expression) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, (msg) => {
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result?.result;
      if (msg.result?.exceptionDetails) {
        return reject(new Error(msg.result.exceptionDetails.text ?? 'eval 抛错'));
      }
      resolve(r?.value);
    });
    ws.send(
      JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

/* ---------- ③ 等启动完成（首屏是「正在准备…」，要等 boot 完成） ---------- */
let report = null;
for (let i = 0; i < 40; i += 1) {
  report = await evaluate(`(() => {
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    return {
      ready: !!document.querySelector('#root')?.children.length,
      bodyChars: text.length,
      title: document.title,
      booting: text.includes('正在准备'),
      buttonCount: buttons.length,
      buttons: buttons.slice(0, 60),
      textHead: text.slice(0, 600),
    };
  })()`);
  if (report.ready && !report.booting && report.bodyChars > 50) break;
  await sleep(500);
}

console.log('\n=== 界面读取结果 ===');
console.log(`DOM 已挂载：${report.ready}`);
console.log(`可见文字：${report.bodyChars} 字符`);
console.log(`按钮数：${report.buttonCount}`);
console.log(`按钮：${report.buttons.filter(Boolean).join(' | ')}`);
console.log('\n--- 首屏文字 ---');
console.log(report.textHead);

/* ---------- ④ 点进一个版本，检查二级页真的有「安装 Mod」入口 ---------- */
/*
 * ★★ 2026-09-22 修（这一条以前是**假红**，而且红了很久没人发现）：
 *   原脚本只点**版本列表的第一行** —— 而第一行往往是**原版**，原版按设计
 *   **不给「Mod 管理」**（用户当年就说过"主页这里也不给原版 mod 管理的键"）。
 *   于是"没有 Mod 管理 / 没有安装 Mod"这几条永远是红的，看着像功能丢了。
 *   现在改成**逐行点进去找**：第一个真的有「Mod 管理」页签的行才算数。
 *   ★ 另外：进了实例页之后主菜单的「版本列表」点不动 —— 得先按页内那个「返回版本列表」。
 */
const sub = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const goList = async () => {
    for (let i = 0; i < 10; i += 1) {
      const back = [...document.querySelectorAll('button')].find((b) => /返回版本列表/.test(b.textContent || ''));
      if (back) { back.click(); await sleep(700); }
      const nav = [...document.querySelectorAll('button')].find((b) => /版本列表/.test(b.textContent || ''));
      nav?.click();
      await sleep(700);
      if (document.querySelectorAll('.ver-item').length) return true;
    }
    return false;
  };
  if (!(await goList())) return { ok: false, why: '没有版本行（可能一个版本都没建）' };
  const total = document.querySelectorAll('.ver-item').length;
  const tried = [];
  for (let idx = 0; idx < Math.min(total, 8); idx += 1) {
    if (idx > 0 && !(await goList())) break;
    const row = [...document.querySelectorAll('.ver-item')][idx];
    if (!row) continue;
    const label = (row.textContent || '').replace(/\\s+/g, ' ').slice(0, 40);
    row.click();
    await sleep(1300);
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
    const hasModTab = buttons.some((b) => b.includes('Mod 管理'));
    tried.push({ idx, label, hasModTab });
    if (hasModTab) {
      return {
        ok: true,
        第几行: idx,
        行: label,
        试过: tried,
        hasInstallMod: text.includes('安装 Mod') || buttons.some((b) => b.includes('安装 Mod')),
        hasModTab,
        buttons: buttons.slice(0, 40),
        textHead: text.slice(0, 500),
      };
    }
  }
  return { ok: false, why: '点了 ' + tried.length + ' 行，没有一行有「Mod 管理」', 试过: tried };
})()`);

/* ---------- ⑤ 点「安装 Mod」，确认真的弹出搜索框（不是点了没反应） ---------- */
const browse = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('安装 Mod'));
  if (!btn) return { clicked: false, why: '找不到按钮' };
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  const text = document.body.innerText || '';
  const dialogs = document.querySelectorAll('[role="dialog"], .modal').length;
  return {
    clicked: true,
    dialogs,
    hasSearch: text.includes('搜索 Mod') || text.includes('添加 Mod'),
    hasModrinth: text.includes('Modrinth'),
    textTail: text.slice(-500),
  };
})()`);

console.log('\n=== 点「安装 Mod」的结果 ===');
console.log(JSON.stringify(browse, null, 2));

/* ---------- ⑥ 下载页：OptiFine 开关的状态必须**一致地**诚实 ---------- */
const of206 = await evaluate(`(async () => {
  /*
   * ★ 注意：进入某个版本的二级页之后，侧栏会**整条换成该版本的二级页签**
   *   （「概览 / 设置 / Mod 管理 / 日志」），主导航的「下载」入口在这一状态下
   *   根本不存在 —— 第一版脚本就是在这里骗了自己（报"找不到下载入口"）。
   *   所以要先「返回版本列表」退出一级->二级，再找主导航。
   */
  const back = [...document.querySelectorAll('button')]
    .find(b => /返回版本列表/.test(b.textContent||'') || /返回/.test(b.getAttribute('aria-label')||''));
  back?.click();
  await new Promise(r => setTimeout(r, 600));

  const dl = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '下载');
  if (!dl) {
    return { ok: false, why: '返回后仍找不到「下载」入口', buttons: [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).slice(0, 20) };
  }
  dl.click();
  await new Promise(r => setTimeout(r, 3000));

  const snap = () => {
    const btn = [...document.querySelectorAll('.addon-opt')]
      .find(b => (b.textContent||'').includes('OptiFine'));
    if (!btn) return { found: false };
    return {
      found: true,
      disabled: btn.disabled === true,
      ariaPressed: btn.getAttribute('aria-pressed'),
      disabledClass: btn.classList.contains('dis'),
      text: (btn.textContent||'').trim().slice(0, 260),
    };
  };
  return { ok: true, first: snap(), bodyHead: (document.body.innerText||'').slice(0, 400) };
})()`);

console.log('\n=== 下载页 OptiFine 开关 ===');
console.log(JSON.stringify(of206, null, 2));

/* ---------- ⑧ 设置页「关于」：版本号必须真的显示出来 ---------- */
const about = await evaluate(`(async () => {
  /*
   * ★ 这条守的是一个"维护得很认真却没人用"的值：
   *   版本号由 tools/set-version.mjs 同步在四个文件里，pnpm verify 里还有
   *   一条"四处必须一致"的检查 —— 但前端**从来没有 import 过**
   *   domain/version-info.ts，界面上一个地方都不显示。
   *   用户报 bug 时第一个会问的就是"我这是哪个版本"。
   */
  const back = [...document.querySelectorAll('button')]
    .find(b => /返回版本列表/.test(b.textContent||''));
  back?.click();
  await new Promise(r => setTimeout(r, 500));

  const set = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '设置');
  if (!set) return { ok: false, why: '找不到「设置」入口' };
  set.click();
  await new Promise(r => setTimeout(r, 1200));

  const text = document.body.innerText || '';

  /*
   * ★ 必须**精确落到「关于」卡片里**再去读版本号。
   *
   *   踩了两次（都是"检查方法错了"）：
   *     ① 在整页文字里捞 /\\d+\\.\\d+\\.\\d+/ → 抓到 Java 那一栏的 25.0.3
   *        （Temurin 25.0.3）。断言"版本号显示出来了"**通过了**，
   *        读的却不是版本号。
   *     ② 改成"找一个包含『报 bug 时请带上』的元素" → 用
   *        querySelectorAll('div') 会从**最外层**开始匹配，
   *        命中的是整个设置页容器，照样捞到 Java 版本号。
   *
   *   所以：先只取 .card（Card 组件的类名，见 src/ui/index.tsx），
   *   再在里面按**卡片标题**精确定位，最后**只从那一张卡片**里读。
   *
   *   ★ 注释里**不要写反引号** —— 这段代码整个是一个 JS 模板字符串，
   *     一个反引号就把字符串提前结束了（这一版就这么坏了两次）。
   */
  const aboutCard = [...document.querySelectorAll('.card')].find(c =>
    /报 bug 时请带上/.test(c.querySelector('.card-hint')?.textContent || ''),
  );
  const aboutText = aboutCard ? aboutCard.innerText : '';
  const m = aboutText.match(/\\b\\d+\\.\\d+\\.\\d+(?:-[a-z]+\\.\\d+)?\\b/);
  return {
    ok: true,
    foundCard: !!aboutCard,
    hasAbout: text.includes('关于'),
    version: m ? m[0] : null,
    hasFrontend: /前端版本/.test(aboutText),
    aboutText: aboutText.slice(0, 300),
  };
})()`);

console.log('\n=== 设置页「关于」 ===');
console.log(JSON.stringify(about, null, 2));

/* ---------- ⑦ 断言 ---------- */
const checks = [];
checks.push(['界面真的渲染了（不是白屏）', report.ready && report.bodyChars > 50 && !report.booting]);
if (sub.ok) {
  checks.push(['版本列表里能点进一个版本', true]);
  checks.push(['★ 概览页有「安装 Mod」这个功能键（用户报"根本没这个键"）', sub.hasInstallMod]);
  checks.push(['侧栏有「Mod 管理」二级页签', sub.hasModTab]);
  /*
   * ★★ 2026-09-22 修（**第三处过期假设**）：原来要求"点下去弹出**模态**"
   *   （`browse.dialogs > 0`）。但「安装 Mod」早就改成
   *   `goDownloadFor('mod', inst.id)` —— **跳下载页并切到 Mod 标签**，
   *   不再开模态（改动记在 `VersionsPage.tsx` / `InstanceOverview.tsx` 的注释里）。
   *   于是这条一直假红，而它旁边那条"按 Modrinth 过滤"反而一直是绿的 ——
   *   **两条断言互相矛盾**本身就说明其中一条错了，可惜没人看。
   *   现在按真实行为验：**跳过去了、并且在 Mod 那一档**（页面上出现 Modrinth 源说明）。
   */
  checks.push([
    '★ 点下去真的到了 Mod 搜索（跳下载页的 Mod 标签，不是"点了没反应"）',
    browse.clicked && (browse.hasSearch || browse.hasModrinth),
    browse.why ? String(browse.why) : '',
  ]);
  checks.push(['搜索框说明是按 Modrinth 过滤的', browse.hasModrinth]);
} else {
  console.log(`（跳过二级页断言：${sub.why}）`);
}
if (of206.ok && of206.first.found) {
  /*
   * ★★ 用户报的："有些版本没有 optifine，可是在切换到有高清修复的版本，
   *   再切回去，就显示有了，实际上点击后是不让选的。"
   *
   *   这条断言改过两轮，两轮都是**跟着代码的真实状态**走：
   *     · dev.3：OptiFine 没有安装实现 → 断言"理由必须说清是我们没做"；
   *     · dev.4：安装**已实装**（net::optifine + 真机测试）→
   *       不能再断言"没做"，而应该断言"理由必须说清是**哪一种**挡住的"。
   *
   *   dev.4 的真实语义（三件事的与）：
   *     上游有 + 我们做了 + **版本清单拿到了** → 才能勾。
   *   这台机器上默认选中的是 26.2，而 OptiFine 在 26.2 上**确实还没有**
   *   （实测 BMCLAPI 清单：26.2 → 0 条），所以开关应该置灰，
   *   理由必须是"确实没有发布"，**不能**是"我们没做"。
   *
   *   判据用**码点**而不是中文正则 —— 中文在管道里按 GBK 传，
   *   正则字面量会变成不匹配任何东西的模式（这轮踩过两次）。
   */
  const NOT_DONE = ['\u8FD8\u6CA1\u6709\u505A', '\u6CA1\u505A']; // 还没有做 / 没做
  const NO_RELEASE = ['\u786E\u5B9E\u6CA1\u6709', '\u6CA1\u6709\u53D1\u5E03']; // 确实没有 / 没有发布
  const CONFLICT = ['\u4E0D\u517C\u5BB9']; // 不兼容
  const NOT_FOUND = ['\u6CA1\u67E5\u5230']; // 没查到

  checks.push([
    '★ OptiFine 开关置灰（不能出现"显示有却点不动"的幽灵状态）',
    of206.first.disabled === true || of206.first.disabledClass === true,
  ]);
  checks.push([
    'OptiFine 的理由**不再**说"我们还没做"（dev.4 已实装）',
    !NOT_DONE.some((s) => of206.first.text.includes(s)),
  ]);
  checks.push([
    'OptiFine 的理由说清是三种真实原因之一：确实没有 / 没查到 / 不兼容',
    NO_RELEASE.some((s) => of206.first.text.includes(s)) ||
      NOT_FOUND.some((s) => of206.first.text.includes(s)) ||
      CONFLICT.some((s) => of206.first.text.includes(s)),
  ]);
} else {
  console.log('（下载页没找到 OptiFine 开关，跳过这几条断言）');
}

if (about.ok) {
  /*
   * ★ 断言必须盯住**版本号本身**，不能只说"页面上有个 x.y.z"。
   *   版本号由 `tools/set-version.mjs` 维护在四处，这里读的是**桌面版后端**
   *   编译进去的那个（`env!("CARGO_PKG_VERSION")`）。
   */
  const EXPECTED = process.env.IEML_EXPECT_VERSION ?? expectedVersion;
  checks.push(['★ 设置页有「关于」卡片（按卡片标题精确定位到）', about.foundCard]);
  checks.push([
    `★ 版本号真的显示出来了（读到 "${about.version ?? '（读不到）'}"）`,
    typeof about.version === 'string' && /^\d+\.\d+\.\d+/.test(about.version),
  ]);
  if (EXPECTED) {
    checks.push([
      `★ 显示的就是当前版本（期望 ${EXPECTED}）—— 否则说明改了版本号没重新构建`,
      about.version === EXPECTED,
    ]);
  }
  checks.push(['关于卡片里有「前端版本」对照（能看出改了版本号没重新构建）', about.hasFrontend]);
} else {
  console.log(`（跳过「关于」断言：${about.why}）`);
  checks.push(['★ 设置页能打开并读到「关于」', false]);
}

console.log('\n=== 断言 ===');
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
}

ws.close();
child.kill();
await sleep(500);
process.exit(failed === 0 ? 0 : 1);
