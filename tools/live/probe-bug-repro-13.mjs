/**
 * 决定性实验：`joinServer` 到底在哪一步丢的（或者根本没丢）
 * ------------------------------------------------------------------
 * 上一版（probe-12）结论与假设相反：**文件里 13 个键一个没少**。
 * 所以要么"回写"根本没发生，要么写盘这条路不丢字段。这次把三件事一起测：
 *   ① 文件 mtime 变了吗（判断那次自动回写到底有没有发生）
 *   ② 启动前后 config 的键有没有变
 *   ③ **界面上**这条实例能不能看到、启动预览里有没有 `--server`
 *      （这才是用户看得见的那一半）
 * 带 versions/libraries/assets 联接，保证实例是可用的、启动规格能拼出来。
 * 用法：node tools/live/probe-bug-repro-13.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9983;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a5b-root');
const OWN = path.join(T, 'ieml-a5b-own');
const PROFILE = path.join(T, 'ieml-a5b-prof');
const FILE = path.join(ROOT, 'instances.json');
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
mkdirSync(path.join(OWN, 'instances'), { recursive: true });
for (const sub of ['versions', 'libraries', 'assets']) {
  await ps(`cmd /c mklink /J "${path.join(MC, sub)}" "${path.join('D:\\IEML\\.minecraft', sub)}"`);
}
writeFileSync(
  FILE,
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-a5',
          mcVersion: '1.12.2',
          loader: null,
          addons: [],
          config: {
            name: '探针·七字段',
            slug: 'probe-a5',
            isolation: 'auto',
            memoryMb: 2048,
            memorySource: 'auto',
            javaMode: 'auto',
            joinServer: '1.2.3.4:abc',
            javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
            javaRange: { min: 17, max: 21 },
            jvmArgs: '-XX:+UseG1GC',
            gameArgs: '--demo',
            windowTitle: '我的窗口标题',
            customInfo: '自定义信息',
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
const keysOf = () => {
  const j = JSON.parse(readFileSync(FILE, 'utf8'));
  return Object.keys(j.instances?.[0]?.config ?? {});
};
const mtime = () => statSync(FILE).mtime.toISOString().slice(11, 19);
console.log('启动前：键 ' + keysOf().length + ' 个，mtime=' + mtime());

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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await sleep(6000);

console.log('启动后：键 ' + keysOf().length + ' 个，mtime=' + mtime() + '（变了就说明发生了自动回写）');

/* 界面上看得到这条实例吗 + 预览里有没有 --server */
const ui = await ev(`(() => {
  const text = (document.querySelector('.content')?.innerText || '').replace(/\\s+/g, ' ');
  return { '界面文本头': text.slice(0, 120), '含实例名': /探针·七字段/.test(text) };
})()`);
console.log('界面：' + JSON.stringify(ui));
await ev(`[...document.querySelectorAll('button')].find((b) => /预览命令/.test(b.textContent || ''))?.click()`);
await sleep(4000);
const preview = await ev(`(() => {
  const t = document.querySelector('.modal')?.innerText || '';
  return { '含 --server': /--server/.test(t), '含 --port': /--port/.test(t), '含 --demo': /--demo/.test(t), '含 UseG1GC': /UseG1GC/.test(t), 'server 段': (t.match(/--server[^\\n]*/g) || []).join(' || ') };
})()`);
console.log('预览：' + JSON.stringify(preview));
console.log('\n===== 结论 =====');
console.log('  文件里的字段：' + (keysOf().length > 6 ? '**还在**（说明写盘不丢字段）' : '**被丢掉了**（写盘丢字段 → A-5 成立）'));
console.log('  启动参数里的 --server：' + (preview?.['含 --server'] ? '有' : '**没有**'));
console.log(
  keysOf().length > 6 && !preview?.['含 --server']
    ? '→ 字段在文件里、却没进启动参数 ⇒ 丢失发生在**读进来那一刻**（Rust 反序列化丢弃未知字段，前端拿不到）'
    : keysOf().length > 6 && preview?.['含 --server']
      ? '→ 一切正常（那 B-4 上次没看到 --server 是我自己那次的其它原因）'
      : '→ 见上两行',
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const sub of ['versions', 'libraries', 'assets']) await ps(`cmd /c rmdir "${path.join(MC, sub)}"`);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('沙盒与联接已清理');
process.exit(0);
