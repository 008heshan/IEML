/**
 * 最后两条真机确认（都在 %TEMP% 沙盒里）：
 *   B-4 服务器地址端口写坏 → **启动时到底传不传 --port**（界面说"原样传给游戏"）
 *       做法：沙盒实例的 `config.joinServer = "1.2.3.4:abc"` → 启动页「预览命令」看参数
 *   B-2 检查更新失败 → 关于页写什么
 *       做法：给应用进程设一个**死代理**（HTTPS_PROXY 指向 127.0.0.1:1），
 *             手动检查更新必然失败 → 读页面上的那句话
 * 用法：node tools/live/probe-bug-repro-11.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9979;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-last-root');
const OWN = path.join(T, 'ieml-last-own');
const PROFILE = path.join(T, 'ieml-last-prof');
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
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-last',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '探针·自动进服',
            slug: 'probe-join',
            isolation: 'auto',
            memoryMb: 2048,
            memorySource: 'auto',
            javaMode: 'auto',
            joinServer: '1.2.3.4:abc',
          },
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
    /* ★ 死代理：让"检查更新"必然失败（B-2 要的就是失败态） */
    HTTPS_PROXY: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(3500);

/* ---------- B-4：预览命令里的 --server / --port ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('启动'))?.click()`);
await sleep(2500);
await ev(`[...document.querySelectorAll('button')].find((b) => /预览命令/.test(b.textContent || ''))?.click()`);
await sleep(4000);
const preview = await ev(`(() => {
  const modal = document.querySelector('.modal');
  const text = modal ? (modal.innerText || '') : '';
  return {
    '整段里含 --server': /--server/.test(text),
    '含 --port': /--port/.test(text),
    'server/port 那一段': (text.match(/--server[^\\n]*/g) || []).join(' || ').slice(0, 200),
    '原文片段': text.split('\\n').filter((l) => /server|port|join/i.test(l)).map((l) => l.trim().slice(0, 160)),
  };
})()`);
console.log('=== B-4 端口写坏的预览命令 ===\n  ' + JSON.stringify(preview, null, 2));
await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => /关闭/.test(x.textContent || '')); b?.click(); return !!b; })()`);
await sleep(800);

/* ---------- B-2：检查更新（死代理下必然失败）→ 关于页写什么 ---------- */
await ev(`[...document.querySelectorAll('.side-link')].find((b)=>(b.textContent||'').includes('关于'))?.click()`);
await sleep(2500);
const before = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return { '关于页文本头': text.slice(0, 200), '含"已是最新版本"': /已是最新版本/.test(text) };
})()`);
console.log('\n=== B-2 点之前 ===\n  ' + JSON.stringify(before));
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /检查更新/.test(x.textContent || ''));
  b?.click();
  return !!b;
})()`);
console.log('  点了「检查更新」=' + JSON.stringify(clicked));
await sleep(9000);
const after = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return {
    '含"已是最新版本"': /已是最新版本/.test(text),
    '含"检查"': /正在检查/.test(text),
    '含错误字样': /失败|错误|连不上|超时|网络/.test(text),
    '更新那一行': (text.match(/启动器更新[^]{0,120}/) || [])[0] || text.slice(0, 160),
  };
})()`);
console.log('\n=== B-2 点之后（死代理，检查必然失败）===\n  ' + JSON.stringify(after, null, 2));
console.log(
  after?.['含"已是最新版本"'] && !after?.['含错误字样']
    ? '\n★★ B-2 真机确认：检查更新失败时，关于页写的是「已是最新版本」，真正的原因一个字都没露。'
    : '\n（这次没复现出预期结果，见上面）',
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const sub of ['versions', 'libraries', 'assets']) await ps(`cmd /c rmdir "${path.join(MC, sub)}"`);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒与联接已清理');
process.exit(0);
