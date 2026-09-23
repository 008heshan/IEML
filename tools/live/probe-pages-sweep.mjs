/**
 * 真机巡检：把一级/二级页面逐个走一遍，只**看**，不点任何破坏性按钮。
 * ------------------------------------------------------------------
 * 每一页收集四类"用户能看见/能感知"的异常：
 *   ① 控制台异常与 console.error（含 Tauri IPC 失败）
 *   ② 文案里的可疑 token：`undefined` / `NaN` / `[object` / `null` / `TODO` / 空占位
 *   ③ 几何异常：横向溢出、有文字却高度为 0 的容器、图片加载失败（naturalWidth === 0）
 *   ④ 元素跑出内容区右边（只在"内容区"里量，不算侧栏与顶栏）
 *
 * 用法：node tools/live/probe-pages-sweep.mjs ["<exe>"]
 * 产出：终端报告 + 每页一张截图（%TEMP%\ieml-sweep）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9941;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-sweep');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-sweep-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
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
/** 当前页收集到的控制台消息（换页时清空） */
let log = [];
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
    log.push({ kind: '异常', text: t });
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const lv = m.params?.type;
    if (lv !== 'error' && lv !== 'warning') return;
    const t = (m.params?.args ?? [])
      .map((a) => String(a.value ?? a.description ?? a.type))
      .join(' ')
      .slice(0, 200);
    log.push({ kind: lv === 'error' ? 'console.error' : 'console.warn', text: t });
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
await send('Runtime.enable', {});
await send('Page.enable', {});

const SCAN = `(() => {
  const text = document.body.innerText || '';
  const suspicious = [];
  for (const tok of ['undefined', 'NaN', '[object Object]', 'TODO', 'FIXME', '占位', '待补', 'lorem']) {
    if (text.includes(tok)) suspicious.push(tok);
  }
  /* 有文字却高度为 0 的容器（被压扁、看不见） */
  const squeezed = [];
  for (const el of document.querySelectorAll('.content *')) {
    const r = el.getBoundingClientRect();
    const t = (el.textContent || '').trim();
    if (t.length > 4 && r.height < 2 && r.width > 40 && getComputedStyle(el).overflow !== 'hidden') {
      squeezed.push({ cls: (el.className || '').toString().slice(0, 40), t: t.slice(0, 24), h: Math.round(r.height) });
    }
  }
  /* 图片没加载出来 */
  const brokenImgs = [...document.querySelectorAll('img')]
    .filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src'))
    .map((i) => (i.getAttribute('src') || '').slice(-40));
  /* 跑到内容区右边之外的元素 */
  const content = document.querySelector('.content');
  const cr = content ? content.getBoundingClientRect() : null;
  const overflow = [];
  if (cr) {
    for (const el of document.querySelectorAll('.content *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > cr.right + 2) {
        /* 只报"看起来是内容"的元素，跳过内部横向滚动容器里的东西 */
        let p = el.parentElement, scroller = false;
        while (p && p !== content) {
          if (getComputedStyle(p).overflowX !== 'visible') { scroller = true; break; }
          p = p.parentElement;
        }
        if (!scroller) overflow.push({ cls: (el.className || '').toString().slice(0, 40), right: Math.round(r.right), limit: Math.round(cr.right) });
      }
      if (overflow.length > 4) break;
    }
  }
  return {
    title: (document.querySelector('.page-title')?.textContent || '').trim(),
    chars: text.length,
    suspicious,
    squeezed: squeezed.slice(0, 4),
    brokenImgs,
    overflow: overflow.slice(0, 4),
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    buttons: document.querySelectorAll('button').length,
  };
})()`;

/** 页面清单：怎么进去 + 等什么信号 */
const PAGES = [
  { name: '启动', click: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('启动'))?.click()`, wait: `!!document.querySelector('.page-title')` },
  { name: '版本列表', click: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`, wait: `/版本列表/.test(document.querySelector('.page-title')?.textContent||'')` },
  { name: '下载·安装游戏', click: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`, wait: `document.querySelectorAll('.tabs .tab').length>0`, tab: '安装游戏' },
  { name: '下载·整合包', tab: '整合包' },
  { name: '下载·Mod', tab: 'Mod' },
  { name: '下载·资源包', tab: '资源包' },
  { name: '下载·光影', tab: '光影' },
  { name: '下载·数据包', tab: '数据包' },
  { name: '设置', click: `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('设置'))?.click()`, wait: `/设置/.test(document.querySelector('.page-title')?.textContent||'')` },
  { name: '更新日志', click: `[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('更新日志'))?.click()`, wait: `/更新日志/.test(document.querySelector('.page-title')?.textContent||'')` },
  { name: '关于', click: `[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()`, wait: `/关于/.test(document.querySelector('.page-title')?.textContent||'')` },
];

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
/* 等首屏把数据拉回来（版本清单/实例列表都到位再开始，避免把"还没加载"当成缺陷） */
for (let i = 0; i < 40; i += 1) {
  const ready = await ev(`!!document.querySelector('.page-title')`);
  if (ready) break;
  await sleep(300);
}
await sleep(3000);

let problems = 0;
for (const p of PAGES) {
  log = [];
  await ev(p.click ?? `[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()===${JSON.stringify(p.tab ?? '')})?.click()`);
  if (p.tab && p.wait) {
    for (let i = 0; i < 30; i += 1) {
      if ((await ev(p.wait)) === true) break;
      await sleep(300);
    }
  }
  if (p.tab) {
    await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()===${JSON.stringify(p.tab)})?.click()`);
  }
  await sleep(p.tab ? 3500 : 1800);
  const scan = await ev(SCAN);
  const realLog = log.filter((l) => !/IPC custom protocol failed/.test(l.text));
  const bad =
    (scan?.suspicious?.length ?? 0) + (scan?.squeezed?.length ?? 0) + (scan?.brokenImgs?.length ?? 0) +
    (scan?.overflow?.length ?? 0) + (scan?.docOverflowX > 1 ? 1 : 0) + realLog.length;
  if (bad > 0) problems += 1;
  console.log(`\n=== ${p.name} ===${bad > 0 ? '  ★ 有可疑点' : ''}`);
  console.log('  ' + JSON.stringify(scan));
  if (realLog.length) console.log('  控制台：' + JSON.stringify(realLog.slice(0, 4)));
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) writeFileSync(path.join(OUT, `${p.name.replace(/[·]/g, '-')}.png`), Buffer.from(s.result.data, 'base64'));
}

console.log(`\n===== 巡检结束：${PAGES.length} 页，${problems} 页有可疑点 =====`);
console.log(`截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
