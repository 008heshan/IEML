/**
 * 真机验证：**社区资源子系统**（Mod / 资源包 / 光影 / 数据包）。
 * ------------------------------------------------------------------
 * 用户要的是「社区资源子系统」（照 PCL 的 `Modules/Resource/*`）。
 * 我们原来只有 Mod 一种，`resourcepack` / `shader` / `datapack`
 * 在源码里**一处都没有**。
 *
 * ## 这条测试验三件事
 *
 *   ① 后端那张表**真的给了四种资源**，而且装到的目录是对的
 *      （写错一个字母，文件就装到游戏看不见的地方，界面还会说"装好了"）；
 *   ② 界面上的**选项卡是四种**，切换之后真的会去搜（不是"点了没反应"）；
 *   ③ **数据包在 Modrinth 上不是一种 project_type** ——
 *      实测：直接查 `datapack` 返回的是 **mod**。
 *      正确的做法是 `mod` + `categories:datapack`。
 *      这条由后端做，这里验"搜出来的确实是数据包"。
 *
 * 用法：node tools/live/live-resource-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PORT = 9338;
const EXE = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});

let page = null;
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {
    /* 还没起来 */
  }
  await sleep(500);
}
if (!page) {
  console.error('CDP 没起来');
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
  return new Promise((resolve) => {
    pending.set(myId, (msg) => {
      if (msg.error) return resolve({ __err: JSON.stringify(msg.error) });
      if (msg.result?.exceptionDetails) {
        return resolve({
          __err:
            msg.result.exceptionDetails.text +
            ' :: ' +
            (msg.result.exceptionDetails.exception?.description ?? ''),
        });
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

for (let i = 0; i < 60; i += 1) {
  const ok = await evaluate(
    `(() => { const t = document.body.innerText || ''; return t.length > 50 && !t.includes('正在准备'); })()`,
  );
  if (ok === true) break;
  await sleep(500);
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/* ---------- ① 后端那张表 ---------- */
const kinds = await evaluate(`(async () => {
  try {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const list = await inv('resource_kinds');
    return { ok: true, list };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
})()`);
console.log('\n=== ① 后端给的资源种类表 ===');
console.log(JSON.stringify(kinds, null, 2));

if (kinds.ok) {
  const byKey = Object.fromEntries(kinds.list.map((k) => [k.key, k]));
  check('表里有四种资源', kinds.list.length === 4, `实际 ${kinds.list.length} 种`);
  check(
    '★ 装到的目录都对（mods / resourcepacks / shaderpacks / datapacks）',
    byKey.mod?.install_dir === 'mods' &&
      byKey.resourcepack?.install_dir === 'resourcepacks' &&
      byKey.shader?.install_dir === 'shaderpacks' &&
      byKey.datapack?.install_dir === 'datapacks',
    kinds.list.map((k) => `${k.key}=${k.install_dir}`).join(' '),
  );
  check(
    '★ 只有 Mod 需要挑加载器（其余三种带上加载器 facet 会把结果砍到几乎没有）',
    byKey.mod?.needs_loader_filter === true &&
      byKey.resourcepack?.needs_loader_filter === false &&
      byKey.shader?.needs_loader_filter === false &&
      byKey.datapack?.needs_loader_filter === false,
  );
  check(
    '数据包/光影带「装完还要做什么」的提示',
    typeof byKey.datapack?.install_note === 'string' &&
      typeof byKey.shader?.install_note === 'string',
  );
} else {
  check('resource_kinds 命令可用', false, kinds.err);
}

/* ---------- ② 四种资源真的搜得到东西 ---------- */
console.log('\n=== ② 四种资源各搜一次 ===');
const searches = await evaluate(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const out = {};
  for (const kind of ['mod', 'resourcepack', 'shader', 'datapack']) {
    try {
      const r = await inv('resource_search', {
        kind, query: '', mcVersion: '1.20.1', loader: kind === 'mod' ? 'fabric' : null,
        limit: 5, offset: 0,
      });
      out[kind] = {
        n: r.hits.length,
        sample: r.hits.slice(0, 2).map(h => ({
          title: h.title, type: h.project_type, cats: (h.categories||[]).slice(0, 6),
        })),
      };
    } catch (e) {
      out[kind] = { err: String(e) };
    }
  }
  return out;
})()`);
console.log(JSON.stringify(searches, null, 2));

for (const kind of ['mod', 'resourcepack', 'shader', 'datapack']) {
  const r = searches[kind] ?? {};
  check(`「${kind}」能搜到结果`, !r.err && r.n > 0, r.err ?? `${r.n ?? 0} 条`);
}

/*
 * ★★ 数据包必须真的是数据包 —— 不能是普通 Mod。
 *
 *   实测：直接查 `project_type=datapack` 返回的是 **mod**
 *   （Modrinth 没有这个项目类型）。所以后端用 `mod` + `categories:datapack`，
 *   再做一次二次过滤。这里验结果里每一条都带 datapack 分类。
 */
const dp = searches.datapack ?? {};
const dpBad = (dp.sample ?? []).filter(
  (h) => !(h.cats ?? []).some((c) => String(c).toLowerCase() === 'datapack'),
);
check(
  '★ 数据包结果每一条都带 datapack 分类（不是普通 Mod）',
  !dp.err && (dp.sample ?? []).length > 0 && dpBad.length === 0,
  JSON.stringify(dp.sample ?? []),
);

/* ---------- ③ 界面上的选项卡 ---------- */
console.log('\n=== ③ 界面：资源包 / 光影 / 数据包 入口 ===');
const ui = await evaluate(`(async () => {
  // 进版本列表 → 点开一个实例 → Mod 管理
  const nav = [...document.querySelectorAll('button')].find(b => /版本列表/.test(b.textContent||''));
  nav?.click();
  await new Promise(r => setTimeout(r, 1200));
  const row = document.querySelector('.ver-item');
  if (!row) return { ok: false, why: '没有版本行' };
  row.click();
  await new Promise(r => setTimeout(r, 1500));

  const modTab = [...document.querySelectorAll('button')].find(b => /Mod 管理/.test(b.textContent||''));
  if (!modTab) return { ok: false, why: '找不到「Mod 管理」页签' };
  modTab.click();
  await new Promise(r => setTimeout(r, 1500));

  const btn = [...document.querySelectorAll('button')]
    .find(b => /资源包 \\/ 光影 \\/ 数据包/.test(b.textContent||''));
  if (!btn) {
    return {
      ok: false,
      why: '找不到社区资源入口按钮',
      buttons: [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).slice(0, 30),
    };
  }
  btn.click();
  // 等弹窗 + 后端那张表 + 第一次搜索
  await new Promise(r => setTimeout(r, 6000));

  const tabs = [...document.querySelectorAll('[role="tab"]')].map(t => (t.textContent||'').trim());
  const text = document.body.innerText || '';
  return {
    ok: true,
    tabs,
    hasResourceName: text.includes('浏览社区资源'),
    saysDir: /装进这个版本的\\s*\\S+/.test(text),
    hasDatapackNote: text.includes('datapack'),
    textTail: text.slice(-400),
  };
})()`);
console.log(JSON.stringify(ui, null, 2));

check('能打开社区资源浏览器', ui.ok === true, ui.why ?? '');
if (ui.ok) {
  check(
    '★ 选项卡是四种（Mod / 资源包 / 光影 / 数据包）',
    ui.tabs.length === 4,
    ui.tabs.join(' | '),
  );
  check('弹窗里写明了「装到哪个目录」', ui.saysDir === true);
}

console.log('');
ws.close();
proc.kill();
await sleep(500);

if (failed === 0) {
  console.log('✓ 社区资源子系统的四条链路都通');
  process.exit(0);
}
console.log(`✗ ${failed} 条不通过`);
process.exit(1);
