/**
 * 真机复现 B-1（第二次尝试）：**装第二个版本不会删掉第一个**
 * ------------------------------------------------------------------
 * 上一版失败的原因（探针问题，不是产品问题）：
 *   · 资源卡片 div 本身没有 onClick —— 入口是卡片脚上的「选择版本并安装」按钮；
 *   · 打开的那个 Mod 的版本与探针实例（1.20.1 + Fabric）对不上，点到的是 `blocked` 行。
 * 这一版：**先搜一个确定有 1.20.1 + Fabric 版本的 Mod**（sodium / lithium），
 *   并且只点 `res-version clickable`（不是 `blocked`）的行，优先挑 meta 里有 1.20.1 的。
 *
 * 判据：连装两个不同版本之后，`instances/<slug>/game/mods/` 里的 jar 数
 *   = 2 ⇒ "已替换为新版本"与磁盘事实不符（`install_mod` 只写新文件、不删旧的）。
 * 沙盒作案、Modrinth 不可达则干净跳过。
 * 用法：node tools/live/probe-bug-repro-8.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9973;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-b1b-root');
const OWN = path.join(T, 'ieml-b1b-own');
const PROFILE = path.join(T, 'ieml-b1b-prof');
const SLUG = 'probe-mod';
const MODS = path.join(OWN, 'instances', SLUG, 'game', 'mods');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(ROOT, '.minecraft'), { recursive: true });
mkdirSync(MODS, { recursive: true });
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'inst-probe-mod',
          mcVersion: '1.20.1',
          loader: { kind: 'fabric', version: '0.15.11', mcVersion: '1.20.1' },
          addons: [],
          config: { name: '探针·Mod 实例', slug: SLUG, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
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
await sleep(3000);
const jars = () => {
  try {
    return readdirSync(MODS).filter((f) => f.endsWith('.jar'));
  } catch {
    return [];
  }
};
const toasts = () =>
  ev(`[...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80))`);

/* 下载 → Mod → 搜索 sodium */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(2200);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='Mod')?.click()`);
await sleep(2500);
await ev(`(() => {
  const input = [...document.querySelectorAll('input')].find((i) => /搜索/.test(i.placeholder || ''));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'sodium');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ev(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '搜索')?.click()`);
let cards = 0;
for (let i = 0; i < 90; i += 1) {
  cards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (typeof cards === 'number' && cards > 0) break;
  await sleep(1000);
}
const list = await ev(`(() => ({
  '卡片数': document.querySelectorAll('.res-card:not(.res-card-sk)').length,
  '第一张': (document.querySelector('.res-card')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
}))()`);
console.log('搜索 sodium：' + JSON.stringify(list));
if (!list?.['卡片数']) {
  console.log('\n★ 资源列表没数据（上游不稳）—— 按约定跳过。现场：' + JSON.stringify(list));
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
  process.exit(0);
}

/* 打开第一张卡的安装页 */
const opened = await ev(`(() => {
  const card = document.querySelector('.res-card');
  const btn = card ? [...card.querySelectorAll('button')].find((b) => /选择版本并安装/.test(b.textContent || '')) : null;
  btn?.click();
  return { '卡片': (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 40), '按钮可用': btn ? !btn.disabled : null };
})()`);
console.log('打开安装页：' + JSON.stringify(opened));
for (let i = 0; i < 80; i += 1) {
  const n = await ev(`document.querySelectorAll('.res-version.clickable').length`);
  if (typeof n === 'number' && n > 0) break;
  await sleep(700);
}
await sleep(1500);

/** 只点 clickable 的行；优先挑 meta 里有 1.20.1 的 */
const pickRow = async (ordinal) => {
  const info = await ev(`(() => {
    const rows = [...document.querySelectorAll('.res-version.clickable')];
    const prefer = rows.filter((r) => /1\\.20\\.1/.test(r.textContent || ''));
    const list = prefer.length >= 2 ? prefer : rows;
    const row = list[${ordinal}] ?? list[0];
    const label = (row?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
    row?.click();
    return { '可点行数': rows.length, '其中含1.20.1': prefer.length, '点的那行': label };
  })()`);
  return info;
};

const before = jars();
const r1 = await pickRow(0);
console.log('第 1 次点：' + JSON.stringify(r1));
for (let i = 0; i < 40; i += 1) {
  if (jars().length >= 1) break;
  await sleep(1000);
}
const after1 = jars();
console.log('  装后 mods/=' + JSON.stringify(after1) + '  提示=' + JSON.stringify(await toasts()));

const r2 = await pickRow(1);
console.log('第 2 次点：' + JSON.stringify(r2));
for (let i = 0; i < 40; i += 1) {
  if (jars().length >= 2) break;
  await sleep(1000);
}
const after2 = jars();
console.log('  装后 mods/=' + JSON.stringify(after2) + '  提示=' + JSON.stringify(await toasts()));

console.log('\n===== 判据 =====');
console.log('  安装前：' + JSON.stringify(before));
console.log('  装两次之后：' + after2.length + ' 个 jar  ' + JSON.stringify(after2));
console.log(
  after2.length >= 2
    ? '★★ B-1 真机复现成功：装第二个版本**没有**删掉第一个 —— 与「已替换为新版本」那句话不符。'
    : after2.length === 1
      ? '（只有 1 个 jar：两次点的可能是同一个版本，见上面两次"点的那行"）'
      : '（没装上：见提示）',
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒已清理');
process.exit(0);
