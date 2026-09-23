/**
 * 真机验证 C-5 的修复：整合包安装页「点哪一行就装哪一个版本」
 * ------------------------------------------------------------------
 * 缺陷原状：`onPick` 里 `setPickedVersion(v)` 之后 `setTimeout(install, 0)` ——
 *   `install` 是**本次渲染的闭包**，读到的 `pickedVersion` 还是 null，
 *   于是回退到 `versions(project_id)[0]` = **最新那个版本**。
 *   表现：点哪一行都装最新那个，而界面看起来完全正常。
 *
 * 判据（**差分**，不需要等整合包下完）：
 *   把应用发往 Rust 的 `mrpack_inspect`（它会拿到"要装的那个版本的文件 URL"）
 *   拦下来记一份，然后：
 *     A 组：点版本列表里的**第一行** → 记下 URL_A
 *     B 组：点**最后一行**（与第一行不同） → 记下 URL_B
 *   要求：URL_A ≠ URL_B（有缺陷时两者相同，因为都回退到"最新那个"）。
 *
 * ★ 只在沙盒里跑；记到 URL 就立刻杀进程，不等它把整合包下完。
 * 用法：node tools/live/probe-c5-fixed.mjs "<exe>"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-c5-root');
const OWN = path.join(T, 'ieml-c5-own');
const PROFILE = path.join(T, 'ieml-c5-prof');
const FAKE_APPDATA = path.join(T, 'ieml-c5-appdata');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const dropLinks = async (root) => {
  const out = await ps(
    `Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LinkType } | ForEach-Object { cmd /c rmdir "$($_.FullName)" }`,
  );
  if (out) console.log('拆掉联接：' + out);
};
const clean = async (d) => {
  for (let i = 0; i < 6; i += 1) {
    try {
      rmSync(d, { recursive: true, force: true });
      return;
    } catch {
      await sleep(700);
    }
  }
};
for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  await dropLinks(d);
  await clean(d);
}
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(path.join(FAKE_APPDATA, 'IEML'), { recursive: true });

/** 起一次应用、点第 rowIndex 行、返回被拦下的 mrpack_inspect URL */
async function run(tag, rowIndex, port) {
  console.log(`\n=== ${tag}：点第 ${rowIndex + 1} 行版本 ===`);
  spawn(EXE, [], {
    env: {
      ...process.env,
      APPDATA: FAKE_APPDATA,
      IEML_DATA_DIR: ROOT,
      IEML_OWN_DIR: OWN,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: PROFILE,
    },
    stdio: 'ignore',
  });
  let page = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) {
    console.error('连不上 CDP');
    return null;
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq;
      pend.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
    return r.result?.result?.value;
  };
  for (let i = 0; i < 60; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
    await sleep(400);
  }
  await sleep(2500);

  /*
   * ★ 拦 IPC 必须**在页面脚本之前**打补丁：应用初始化时可能就把
   *   `window.__TAURI_INTERNALS__.invoke` 抓成了自己的引用，加载完再包一层就晚了
   *   （实测：加载后打补丁 → 点击时一条都没拦到）。
   *   所以用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`。
   */
  await send('Page.enable', {});
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__probe = [];
      const patch = () => {
        const T = window.__TAURI_INTERNALS__;
        if (!T || !T.invoke || T.__probePatched) return false;
        const orig = T.invoke.bind(T);
        T.invoke = (cmd, args, ...rest) => {
          try { window.__probe.push({ cmd, url: (args && args.url) || null }); } catch (e) {}
          return orig(cmd, args, ...rest);
        };
        T.__probePatched = true;
        return true;
      };
      patch();
      /* 有的版本是先把 __TAURI_INTERNALS__ 挂上去的 —— 轮询几次兜住 */
      const t = setInterval(() => { if (patch()) clearInterval(t); }, 1);
      setTimeout(() => clearInterval(t), 10000);
    })();`,
  });
  console.log('  已注入 IPC 拦截（pre-init）');
  /* ★ 注入只对"之后加载的文档"生效 → 必须让页面**带着补丁重载一次** */
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  for (let i = 0; i < 60; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
    await sleep(400);
  }
  const probeReady = await ev(`Array.isArray(window.__probe) ? 'ok' : 'missing'`);
  console.log('  重载后拦截器：' + probeReady);
  await sleep(2000);

  await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
  await sleep(1500);
  await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='整合包')?.click()`);
  await sleep(1500);
  /* 等整合包卡片（第一组可能因为网络慢；给足时间） */
  let cards = 0;
  for (let i = 0; i < 40; i += 1) {
    cards = (await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)').length`)) ?? 0;
    if (cards > 0) break;
    await sleep(1200);
  }
  console.log('  整合包卡片数：' + cards);
  if (cards === 0) {
    await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
    return { ok: false, why: '没拿到整合包列表（网络）' };
  }
  await ev(`document.querySelector('.pack-card:not(.pack-card-sk)')?.click()`);
  await sleep(4000);
  /* 等版本列表（整行可点：`.res-version.clickable`，行**本身**就是按钮） */
  let rows = 0;
  for (let i = 0; i < 30; i += 1) {
    rows = (await ev(`document.querySelectorAll('.res-version.clickable').length`)) ?? 0;
    if (rows > 0) break;
    await sleep(1000);
  }
  if (rows === 0) {
    /* 换几张卡片试试：有的整合包版本一个可装的都没有（行点下去会抛"没有可下载的文件"） */
    for (let cardIndex = 1; cardIndex < 4 && rows === 0; cardIndex += 1) {
      console.log('  第 1 张卡没有可点版本行，换第 ' + (cardIndex + 1) + ' 张');
      await ev(`(() => {
        const back = [...document.querySelectorAll('button')].find((b) => /返回|取消/.test(b.textContent || ''));
        back?.click();
      })()`);
      await sleep(2500);
      await ev(`document.querySelectorAll('.pack-card:not(.pack-card-sk)')[${cardIndex}]?.click()`);
      await sleep(4000);
      for (let i = 0; i < 20; i += 1) {
        rows = (await ev(`document.querySelectorAll('.res-version.clickable').length`)) ?? 0;
        if (rows > 0) break;
        await sleep(1000);
      }
    }
  }
  const rowTexts = await ev(`[...document.querySelectorAll('.res-version.clickable')].map((r)=>(r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40))`);
  console.log('  可点版本行数：' + rows + '  前两行：' + JSON.stringify((rowTexts ?? []).slice(0, 2)));
  if (rows === 0) {
    /* ★ 诊断：把版本区那块的实际文字打出来（"没有可下载的版本" / 骨架 / 报错 一看就知道） */
    const diag = await ev(`(() => {
      const box = document.querySelector('.res-versions');
      return {
        '版本区文字': (box?.innerText || '(没有 .res-versions)').replace(/\\s+/g, ' ').trim().slice(0, 200),
        '各类行数': {
          'res-version': document.querySelectorAll('.res-version').length,
          'blocked': document.querySelectorAll('.res-version.blocked').length,
          'res-vgroup': document.querySelectorAll('.res-vgroup').length,
          'Note': document.querySelectorAll('.note, .note-warning, .note-err').length,
        },
        '页面提示条': [...document.querySelectorAll('.note, .toast')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)).slice(0, 3),
      };
    })()`);
    console.log('  诊断：' + JSON.stringify(diag, null, 2));
    await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
    return { ok: false, why: '版本列表没出来' };
  }
  /* 点指定那一行 */
  const clicked = await ev(`(() => {
    const rows = [...document.querySelectorAll('.res-version.clickable')];
    const row = rows[${rowIndex}];
    if (!row) return null;
    row.click();
    return { '行文本': (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
  })()`);
  console.log('  点了：' + JSON.stringify(clicked));
  /* 等 IPC 被拦到（最多 20 秒）—— 一到就返回，不等下载 */
  let urls = [];
  for (let i = 0; i < 20; i += 1) {
    urls = (await ev(`window.__probe ?? []`)) ?? [];
    if (urls.some((u) => u.cmd === 'mrpack_inspect')) break;
    await sleep(1000);
  }
  const inspect = urls.find((u) => u.cmd === 'mrpack_inspect') ?? null;
  /*
   * ★ 拦截没生效也没关系：应用会把**失败的 CDN URL 原样打在提示里**，
   *   而那个 URL 里带版本 id（`/data/<project>/versions/<version_id>/<file>`）——
   *   它同样能证明"要装的是哪一个版本"，而且完全不需要instrumentation。
   */
  let toastText = '';
  for (let i = 0; i < 20; i += 1) {
    const toasts = await ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent || '')`);
    toastText = (toasts ?? []).join(' | ').replace(/\s+/g, ' ').trim();
    if (/versions\//.test(toastText) || /整合包/.test(toastText)) break;
    await sleep(1000);
  }
  const versionId = (toastText.match(/versions\/([A-Za-z0-9]+)/) ?? [])[1] ?? null;
  console.log('  界面提示（全文）：' + JSON.stringify(toastText.slice(0, 200)));
  console.log('  从提示里抽出的版本 id：' + JSON.stringify(versionId));
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  await sleep(800);
  return { ok: Boolean(inspect || versionId), url: inspect?.url ?? null, versionId, clicked };
}

const a = await run('A 组', 0, 9996);
const b = await run('B 组', 1, 9997);

console.log('\n===== 判据 =====');
console.log('A（第一行）点下去要装的版本 id：' + JSON.stringify(a?.versionId ?? a?.url ?? a?.why));
console.log('B（第二行）点下去要装的版本 id：' + JSON.stringify(b?.versionId ?? b?.url ?? b?.why));
const both = a?.versionId && b?.versionId;
console.log(
  `${both && a.versionId !== b.versionId ? '✓' : both ? '✗' : '—'} 点不同行 → 装的是**不同**的版本` +
    (both ? '' : '（有一侧没拿到证据，见上）'),
);
console.log('   ★ 缺陷版本下这两个 id 会是**同一个**（都回退到"最新那个"）');
console.log('   （A/B 两组点的行文本见上：两行的版本号不同，所以"装的东西"也必须不同）');

for (const d of [ROOT, OWN, PROFILE, FAKE_APPDATA]) {
  await dropLinks(d);
  await clean(d);
}
console.log('沙盒已清理');
process.exit(0);
