/**
 * 一条探针确认 4 条中级缺陷（都在 %TEMP% 沙盒里，游戏文件用目录联接只读借用）：
 *   C-3 「也可以把 .jar 文件直接拖进窗口」—— 应用里到底有没有拖放处理器
 *   C-7 侧栏「最近玩过」—— 有实例时它出不出现
 *   C-6 Quilt 实例 + 一个 `fabric-api-…jar` → 会不会被误报「缺 Quilted Fabric API」
 *       （`modrinth.rs` 认为这算"有 API"，而 `commands_real.rs` 的 quilt 名单里没有 fabric-api）
 *   C-4 实例是 26.3（磁盘上**真有** versions/26.3）→ 版本列表底部还会不会挂
 *       「这些版本还没有游戏文件」（判据来自只含 10 个版本的内置表）
 * 用法：node tools/live/probe-bug-repro-9.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9975;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-mid-root');
const OWN = path.join(T, 'ieml-mid-own');
const PROFILE = path.join(T, 'ieml-mid-prof');
const SLUG = 'probe-quilt';
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
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
const MC = path.join(ROOT, '.minecraft');
mkdirSync(MC, { recursive: true });
for (const sub of ['versions', 'libraries', 'assets']) {
  await ps(`cmd /c mklink /J "${path.join(MC, sub)}" "${path.join('D:\\IEML\\.minecraft', sub)}"`);
}
const MODS = path.join(OWN, 'instances', SLUG, 'game', 'mods');
mkdirSync(MODS, { recursive: true });
/* Quilt 实例 + 一个"叫 fabric-api"的 API jar（Quilt 用户很常见的放法） */
writeFileSync(path.join(MODS, 'fabric-api-0.92.2+1.20.1.jar'), 'not a real jar');
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-probe-quilt',
          mcVersion: '26.3',
          loader: { kind: 'quilt', version: '0.23.0', mcVersion: '26.3' },
          addons: [],
          config: { name: '探针·Quilt 实例', slug: SLUG, isolation: 'auto', memoryMb: 4096, memorySource: 'auto', javaMode: 'auto' },
          createdAt: new Date().toISOString(),
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      active_id: null,
    },
    null,
    2,
  ),
);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(800);
spawn(EXE, [], {
  env: {
    ...process.env,
    IEML_DATA_DIR: ROOT,
    IEML_OWN_DIR: OWN,
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
  await sleep(400);
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3500);

/* ---------- C-3：有没有拖放处理器 ---------- */
const drag = await ev(`(() => {
  try {
    const all = getEventListeners(window);
    const names = Object.keys(all);
    const dragish = names.filter((n) => /^(drop|dragover|dragenter|dragleave|drag)$/i.test(n));
    const counts = {};
    for (const n of dragish) counts[n] = all[n].length;
    /* 也看看 document 与 body */
    const doc = getEventListeners(document);
    const docDrag = Object.keys(doc).filter((n) => /^drag/i.test(n));
    const body = getEventListeners(document.body);
    const bodyDrag = Object.keys(body).filter((n) => /^drag/i.test(n));
    return { 'window 上的拖放事件': counts, 'document 上的': docDrag, 'body 上的': bodyDrag, 'window 上事件总数': names.length };
  } catch (e) { return 'ERR:' + e.message; }
})()`);
console.log('=== C-3 拖放 ===\n  ' + JSON.stringify(drag));

/* ---------- C-7：侧栏「最近玩过」 ---------- */
const recent = await ev(`(() => ({
  '有实例行': document.querySelectorAll('.ver-item, .side-inst').length,
  '最近玩过块': document.querySelectorAll('.side-recent').length,
  /* ★ C-7 修复后的判据：这个块**整块删掉**了（它依赖一个永远为 null 的字段）——
     所以不但不该有元素，连标题文字都不该出现 */
  '侧栏含"最近玩过"': /最近玩过/.test(document.querySelector('.sidebar')?.innerText || ''),
  '侧栏文本': (document.querySelector('.sidebar')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
}))()`);
console.log('\n=== C-7 最近玩过 ===\n  ' + JSON.stringify(recent));

/* ---------- C-4：版本列表底部的「还没有游戏文件」 ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('版本列表'))?.click()`);
await sleep(2500);
const c4 = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return {
    '行数': document.querySelectorAll('.ver-item').length,
    '含"还没有游戏文件"': /还没有游戏文件/.test(text),
    '含"起不来"': /起不来/.test(text),
    '文本尾': text.slice(-160),
  };
})()`);
console.log('\n=== C-4 还没有游戏文件 ===\n  ' + JSON.stringify(c4));
console.log('  磁盘上 D:\\IEML\\.minecraft\\versions\\26.3 存在=' + existsSync('D:\\IEML\\.minecraft\\versions\\26.3'));

/* ---------- C-6：Quilt 实例 + fabric-api jar → 会不会报「缺 Quilted Fabric API」 ---------- */
const entered = await ev(`(() => { const r = document.querySelector('.ver-item'); r?.click(); return !!r; })()`);
await sleep(2500);
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('Mod 管理'))?.click()`);
await sleep(4000);
const c6 = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return {
    '进了二级页': /Mod 管理|Mod 列表|已装/.test(text),
    '含"缺 Quilted Fabric API"': /缺 Quilted Fabric API/.test(text),
    '含"缺 Fabric API"': /缺 Fabric API/.test(text),
    '含"一键补装"': /一键补装/.test(text),
    '扫到的 Mod': (text.match(/fabric-api-0\\.92\\.2[^\\s]*/g) || []).slice(0, 3),
    '文本前 300': text.slice(0, 300),
  };
})()`);
console.log('\n=== C-6 Quilt 的前置包判定 ===\n  ' + JSON.stringify(c6, null, 2).slice(0, 1200));

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const sub of ['versions', 'libraries', 'assets']) await ps(`cmd /c rmdir "${path.join(MC, sub)}"`);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒与联接已清理');
process.exit(0);
