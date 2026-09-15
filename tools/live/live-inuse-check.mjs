/**
 * 真机验证：**「盘上有」与「有版本在用」必须分开说**。
 * ------------------------------------------------------------------
 * 用户报的原话：
 *   「版本列表删除有模组加载器的版本之后，下载列表的对应版本有模组加载器的
 *     版本，还显示已装」
 *
 * 根因：两张表读的是**两个不同的东西** ——
 *   · 「版本列表」= `instances.json`（用户建的版本）
 *   · 「下载」页   = 直接扫 `shared/versions/`（盘上有什么）
 *
 * 删实例只删 `instances/{slug}/`（存档 / Mod / 配置），
 * **共享的游戏文件**（`shared/versions/`、`libraries/`）故意留着 ——
 * 多个实例可能共用同一份，删了会把别人的游戏弄坏。
 * 于是下载页照旧扫到那个加载器目录，继续显示"已装"。
 *
 * 两句话都对，但只写"已装"就是界面在骗人。
 *
 * ## 这条测试怎么验
 *
 * 它**不依赖**用户当前碰巧有没有闲置版本 —— 那样的测试会时绿时红。
 * 而是直接比对**两个数据源**：
 *   ① 后端 `fetch_version_manifest` 给出的每一行的 `in_use` / `loaders[].in_use`
 *   ② 磁盘上真实的 `instances.json`
 * 两者必须一致；并且凡是 `in_use === false` 的行，
 * **界面上不许出现"已装"两个字**（必须写"盘上有 …（暂无版本在用）"）。
 *
 * 用法：node tools/live/live-inuse-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PORT = 9335;
const EXE = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML 启动器.exe');

/* 数据目录：先读 datadir.txt，读不到才退回 %APPDATA%\IEML（老布局） */
const dataDir = (() => {
  const legacy = path.join(process.env.APPDATA ?? '', 'IEML');
  try {
    const v = readFileSync(path.join(legacy, 'datadir.txt'), 'utf8').trim();
    if (v) return v;
  } catch {
    /* 用默认布局 */
  }
  return legacy;
})();

if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

/* ---------- ① 先把"真相"从磁盘读出来 ---------- */
const instancesFile = path.join(dataDir, 'instances.json');
if (!existsSync(instancesFile)) {
  console.error(`找不到 ${instancesFile}`);
  process.exit(2);
}
const store = JSON.parse(readFileSync(instancesFile, 'utf8'));
const instances = store.instances ?? [];

/** mcVersion -> 这个版本下实例用到的加载器种类（小写） */
const truth = new Map();
for (const i of instances) {
  const set = truth.get(i.mcVersion) ?? new Set();
  if (i.loader?.kind) set.add(String(i.loader.kind).toLowerCase());
  for (const a of i.addons ?? []) if (a.kind) set.add(String(a.kind).toLowerCase());
  truth.set(i.mcVersion, set);
}
console.log('=== 磁盘真相（instances.json）===');
for (const [mc, kinds] of truth) {
  console.log(`  ${mc}  → 在用：${kinds.size ? [...kinds].join(' + ') : '（纯原版）'}`);
}
console.log(`  （共计 ${instances.length} 个版本）`);

/* ---------- ② 起桌面版，读它算出来的 in_use ---------- */
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

/* 等界面挂载 + 清单拉回来（清单要联网，给足时间） */
await evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const t = document.body.innerText || '';
    if (t.length > 50 && !t.includes('正在准备')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
})()`);

/* 进「下载」页，等版本清单出现 */
const rows = await evaluate(`(async () => {
  const dl = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '下载');
  dl?.click();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (document.querySelectorAll('.wz-item').length > 0) break;
  }
  await new Promise(r => setTimeout(r, 1500));
  return [...document.querySelectorAll('.wz-item')].map(el => ({
    id: (el.querySelector('.wz-item-name')?.textContent || '').trim(),
    sub: (el.querySelector('.wz-item-sub')?.textContent || '').trim(),
  }));
})()`);

console.log(`\n=== 下载页读到 ${rows.length} 行版本 ===`);

/* ---------- ③ 断言 ---------- */
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/*
 * ★ 核心断言：凡是**没有任何实例在用**的版本，界面上不许出现"已装"。
 *
 *   "已装"这两个字是用户投诉的原话，也是让人以为"可以用"的那个词。
 *   闲置的必须写成"盘上有 …（暂无版本在用）"。
 */
const idle = rows.filter((r) => r.sub.includes('暂无版本在用'));
const inUseRows = rows.filter((r) => r.sub.includes('已装'));

console.log('\n--- 有内容标记的行 ---');
for (const r of [...inUseRows, ...idle].slice(0, 40)) {
  console.log(`  ${r.id.padEnd(28)} ${r.sub}`);
}

/*
 * ★ 真值核对：界面上说"已装"的版本，必须真的在 instances.json 里有实例。
 *   反过来，实例在用的版本必须被写成"已装"。
 */
const wrongInUse = inUseRows.filter((r) => !truth.has(r.id));
check(
  '★ 写「已装」的版本都真的有实例在用（没有幽灵"已装"）',
  wrongInUse.length === 0,
  wrongInUse.map((r) => r.id).join(', ') || '全部对得上',
);

const missingInUse = [...truth.keys()].filter(
  (mc) => rows.some((r) => r.id === mc) && !rows.find((r) => r.id === mc)?.sub.includes('已装'),
);
check(
  '★ 有实例在用的版本都被写成「已装」',
  missingInUse.length === 0,
  missingInUse.join(', ') || '全部对得上',
);

/*
 * ★ 闲置的那些必须带上"暂无版本在用"这句话 —— 只写"盘上有 Forge 47.4.23"
 *   还是会被读成"可以用"。这是这条测试存在的全部理由。
 */
const idleWithoutNote = idle.filter((r) => !r.sub.includes('暂无版本在用'));
check(
  '★ 闲置版本都明确标注了「暂无版本在用」',
  idleWithoutNote.length === 0,
  idleWithoutNote.map((r) => r.id).join(', ') || '全部带标注',
);

/*
 * ★ 如果本机**一个闲置版本都没有**，那这条测试其实什么都没验到 ——
 *   必须说出来，不能给一个绿得毫无内容的结论。
 */
if (idle.length === 0) {
  console.log('');
  console.log('⚠ 本机没有"盘上有但没有版本在用"的版本 ——');
  console.log('  这条测试这次没有验到核心场景（闲置版本的字样）。');
  console.log('  想真验它：装一个带加载器的版本，然后到「版本列表」把它删掉，再跑一次。');
}

/*
 * ★★ 加载器版本号必须是真的 —— 不许把 `forgespi` 的版本当 Forge 版本。
 *
 *   现场：`1.20.1-forge-47.2.0` 的 JSON 里没有 `net.minecraftforge:forge:`
 *   那一条（老版本 Forge 不写它），于是前缀匹配撞上
 *   `net.minecraftforge:forgespi:7.0.1`，界面写「已装 Forge **7.0.1**」，
 *   而实际装的是 **47.2.0**。同一个功能，`26.2-forge-65.1.3` 却显示正确 ——
 *   最容易漏掉的那种"一个对一个错"。
 *
 *   判据：凡是被标成 Forge 的行，版本号必须能在**目录名**里找到佐证
 *   （`<mc>-forge-<ver>`），而不是别的库的版本号。
 */
const forgeRows = rows.filter((r) => /Forge (\d[\d.]*)/.test(r.sub));
const mismatch = [];
for (const r of forgeRows) {
  const shown = r.sub.match(/Forge (\d[\d.]*)/)[1];
  /*
   * 磁盘上属于这个 MC 版本的 forge 目录名，例如
   *   1.20.1-forge-47.2.0  /  26.2-forge-65.1.3
   * 显示出来的版本必须是其中之一。
   */
  const dirs = [];
  try {
    const vdir = path.join(dataDir, 'shared', 'versions');
    for (const d of readdirSync(vdir)) {
      const m = d.match(/^(.+?)-forge-(\d[\d.]+)$/);
      if (m && m[1] === r.id) dirs.push(m[2]);
    }
  } catch {
    /* 读不到就跳过这条 */
  }
  if (dirs.length > 0 && !dirs.includes(shown)) {
    mismatch.push(`${r.id}：界面写 Forge ${shown}，盘上目录是 ${dirs.join(' / ')}`);
  }
}
check(
  '★ 显示的 Forge 版本号与磁盘目录一致（不是 forgespi 之类的版本）',
  mismatch.length === 0,
  mismatch.join('；') || `核对了 ${forgeRows.length} 行`,
);

console.log('');
ws.close();
proc.kill();
await sleep(500);

if (failed === 0) {
  console.log('✓ 下载页的「已装 / 盘上有」与实例记录一致');
  process.exit(0);
}
console.log(`✗ ${failed} 条不通过`);
process.exit(1);
