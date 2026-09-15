/**
 * 真机验证：**这一轮两个"界面说错话"的修复**。
 * ------------------------------------------------------------------
 *
 * ① `26.2` 的「需要 Java N」必须是 25，**不是 8**。
 *
 *    用户原话：「我的 26.2 给我显示要 java8，虽然游戏能打开，但这毕竟不对」。
 *
 *    根因是判据被抄了三份（InstanceOverview / LaunchPage / bridge/tauri），
 *    三份都只取 `mcVersion.split('.')[0]` 当 major → `26.2` 的 major 是 26
 *    而不是 1 → 所有 `major === 1 && …` 分支不成立 → `return 8`。
 *
 *    这条测试**读真实 DOM 上那个数字**，不去看代码。
 *
 * ② 下载页**不许**再出现「已装 xxx」的加载器提示。
 *
 *    用户原话：「下载页的版本的模组加载器已装xxx那个提示不要了」。
 *
 * 用法：node tools/live/live-java-display-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9336;
const EXE = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML 启动器.exe');

const dataDir = (() => {
  const legacy = path.join(process.env.APPDATA ?? '', 'IEML');
  try {
    const v = readFileSync(path.join(legacy, 'datadir.txt'), 'utf8').trim();
    if (v) return v;
  } catch {
    /* 默认布局 */
  }
  return legacy;
})();

if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

/*
 * 从 instances.json 里挑一个**两位数主版本号**的实例来验 ——
 * `26.2` / `26.1.1` 这种正是老逻辑算错的那一类。
 * 没有的话退回任意一个实例（并打印说明，不假装验到了）。
 */
const store = JSON.parse(readFileSync(path.join(dataDir, 'instances.json'), 'utf8'));
const instances = store.instances ?? [];
const twoDigit = instances.filter((i) => /^\d{2}\./.test(i.mcVersion));
const target = twoDigit[0] ?? instances[0] ?? null;

console.log('=== 本机实例 ===');
for (const i of instances) {
  console.log(`  ${i.mcVersion.padEnd(10)} ${i.config?.name ?? ''}`);
}
if (!target) {
  console.error('一个实例都没有，验不了');
  process.exit(2);
}
console.log(
  `\n被试实例：${target.mcVersion}（${target.config?.name}）` +
    (twoDigit.length === 0 ? '  ⚠ 这不是两位数主版本号，验不到那个 bug' : ''),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});

async function getPage() {
  for (let i = 0; i < 50; i += 1) {
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
  console.error('✗ WebView2 的 CDP 没起来');
  proc.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const evaluate = (expression) => {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, (msg) => {
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      if (msg.result?.exceptionDetails) {
        return reject(new Error(msg.result.exceptionDetails.text ?? 'eval 抛错'));
      }
      resolve(msg.result?.result?.value);
    });
    ws.send(
      JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
};

await evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const t = document.body.innerText || '';
    if (t.length > 50 && !t.includes('正在准备')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
})()`);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/* ---------- ① 概览页的「需要 Java N」 ---------- */
const javaShown = await evaluate(`(async () => {
  const nav = [...document.querySelectorAll('button')].find(b => /版本列表/.test(b.textContent||''));
  nav?.click();
  await new Promise(r => setTimeout(r, 1200));
  // 点开被试实例那一行
  const rows = [...document.querySelectorAll('.ver-item')];
  const want = ${JSON.stringify(target.mcVersion)};
  const row = rows.find(r => (r.textContent||'').includes(want)) ?? rows[0];
  if (!row) return { ok: false, why: '版本列表里没有可点的行' };
  row.click();

  /*
   * ★★ 必须**等**「Mojang 声明的 Java」那一次后端调用回来。
   *
   *   界面是两段式的：先用版本号基线算一个（立刻显示），
   *   再去后端取版本 JSON 里声明的那个数（fetch_version_json），
   *   拿到之后重算。第一版测试只等了 1.5 秒就断言，读到的还是基线值 ——
   *   于是报了一个**假失败**（"显示 21，期望 25"）。
   *   实测那次调用的耗时：约 1.6 秒（含拉清单）。
   *
   *   所以这里轮询到**缓存里有这个版本**为止（最多 20 秒），
   *   再去读页面文字 —— 那才是最终状态。
   *
   *   ⚠️ 注释里不要写反引号：这一段整个是 JS 模板字符串。
   */
  const readCache = () => {
    try { return JSON.parse(localStorage.getItem('ieml.mojangJava.v1') || '{}'); }
    catch { return {}; }
  };
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (Object.prototype.hasOwnProperty.call(readCache(), want)) { ready = true; break; }
  }
  // 再多给一帧让它渲染完
  await new Promise(r => setTimeout(r, 600));

  const text = document.body.innerText || '';
  const m = text.match(/\\u9700\\u8981\\s*Java\\s*(\\d+)/);   // 需要 Java N
  return {
    ok: true,
    java: m ? Number(m[1]) : null,
    declaredFetched: ready,
    cache: readCache(),
    textHead: text.slice(0, 300),
  };
})()`);
console.log('\n=== 概览页 ===');
console.log('  ', JSON.stringify(javaShown, null, 2));
check(
  '后端把「Mojang 声明的 Java」取回来了（缓存里有这个版本）',
  javaShown.ok && javaShown.declaredFetched === true,
  JSON.stringify(javaShown.cache ?? {}),
);

/*
 * ★ 判据不写死 25：从**版本 JSON** 里读出 Mojang 声明的那个数来对照。
 *   写死的话，换个实例这条测试就没意义了。
 */
const vjson = path.join(dataDir, 'shared', 'versions', target.mcVersion, `${target.mcVersion}.json`);
let declared = null;
if (existsSync(vjson)) {
  try {
    const j = JSON.parse(readFileSync(vjson, 'utf8'));
    declared = j?.javaVersion?.majorVersion ?? null;
  } catch {
    /* 读不出来就只做"不许是 8"这条 */
  }
}
console.log(`  版本描述里 Mojang 声明的 Java：${declared ?? '（没写）'}`);

if (javaShown.ok && javaShown.java !== null) {
  check(
    `★ ${target.mcVersion} 显示的 Java 不是 8（读到 ${javaShown.java}）`,
    javaShown.java !== 8,
    javaShown.java === 8 ? '★★ 就是用户报的那个 bug：两位数主版本号掉进了 return 8' : '',
  );
  if (declared !== null) {
    check(
      `★ 显示的就是版本描述里声明的那个数（${declared}）`,
      javaShown.java === declared,
    );
  }
} else {
  check('能在概览页读到「需要 Java N」', false, javaShown.why ?? '没读到');
}

/* ---------- ② 下载页不许再出现「已装 xxx」 ---------- */
const dl = await evaluate(`(async () => {
  // 先退回一级导航
  const back = [...document.querySelectorAll('button')].find(b => /返回版本列表/.test(b.textContent||''));
  back?.click();
  await new Promise(r => setTimeout(r, 600));  const d = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '下载');
  if (!d) return { ok: false, why: '找不到「下载」入口' };
  d.click();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (document.querySelectorAll('.wz-item').length > 0) break;
  }
  await new Promise(r => setTimeout(r, 1500));

  // 右栏（模组加载器）里的文字
  const right = document.querySelector('.cw-right')?.innerText || '';
  // 「已装」角标（.b-name 里的 Chip / .a-name 里的 Chip）
  const badges = [...document.querySelectorAll('.base-opt .b-name .chip, .addon-opt .a-name .chip')]
    .map(c => (c.textContent||'').trim());
  return {
    ok: true,
    rightHead: right.slice(0, 300),
    hasInstalledWord: /\\u5df2\\u88c5/.test(right),        // 已装
    badges,
  };
})()`);
console.log('\n=== 下载页右栏（模组加载器）===');
console.log('  ', JSON.stringify(dl, null, 2));

check(
  '★ 右栏里不再出现「已装」（用户要求去掉那个提示）',
  dl.ok && dl.hasInstalledWord === false,
  dl.ok ? '' : (dl.why ?? ''),
);
check(
  '★ 加载器选项上没有「已装 xxx」角标',
  dl.ok && !dl.badges.some((b) => b.includes('已装')),
  (dl.badges ?? []).join(' | '),
);

console.log('');
ws.close();
proc.kill();
await sleep(500);

if (failed === 0) {
  console.log('✓ 两处界面文案都与事实一致');
  process.exit(0);
}
console.log(`✗ ${failed} 条不通过`);
process.exit(1);
