/**
 * 真机复现 B-1：**装第二个版本时，第一个版本的 jar 不会被删**
 * ------------------------------------------------------------------
 * 判据（机制级）：在 `%TEMP%` 沙盒里给一个 Fabric 实例装**同一个 Mod 的两个不同版本**，
 *   然后数 `instances/<slug>/game/mods/` 里的 jar：
 *     1 个 → 说明"替换"真的发生了；
 *     2 个 → 说明只是"又下了一份"，旧的那份还在。
 *   ★ 更新流程（`ModsPanel.applyUpdates`）调的就是同一个 `install_mod`
 *     （只有 `create_dir_all` + `download_one`，没有任何 remove/rename），
 *     所以"更新已替换为新版本"那句话与磁盘事实不符。
 *
 * 只写沙盒；Modrinth 不可达就跳过（按仓库约定：跳过要打印理由，不算失败）。
 * 用法：node tools/live/probe-bug-repro-7.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9971;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-b1-root');
const OWN = path.join(T, 'ieml-b1-own');
const PROFILE = path.join(T, 'ieml-b1-prof');
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
const toasts = [];
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

/* 下载 → Mod 页签 */
await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('下载'))?.click()`);
await sleep(2200);
await ev(`[...document.querySelectorAll('.tabs .tab')].find((t)=>(t.textContent||'').trim()==='Mod')?.click()`);
let cards = 0;
for (let i = 0; i < 90; i += 1) {
  /* ★ 判据必须用**确切的**卡片类名（`.res-card`）：上一版用了一串松选择器，
     把版本 chips 也数成了"卡片"，于是"上游没数据"这种情况没被识别出来 */
  cards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
  if (typeof cards === 'number' && cards > 0) break;
  await sleep(1000);
}
const listState = await ev(`(() => ({
  '卡片数': document.querySelectorAll('.res-card:not(.res-card-sk)').length,
  '加载骨架': document.querySelectorAll('.res-card-sk').length,
  '空状态': (document.querySelector('.res-none')?.textContent || '').trim().slice(0, 60),
  '错误': [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)),
}))()`);
console.log('Mod 列表：' + JSON.stringify(listState));
if (!listState?.['卡片数']) {
  console.log(
    '\n★ 这次没拿到资源列表（上游不稳 / 还在加载）—— 按仓库约定跳过，不算失败。' +
      '\n  现场：' + JSON.stringify(listState),
  );
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
  process.exit(0);
}

/* 点第一张卡里的「选择版本并安装」（卡片的 div 本身没有 onClick —— 上一版就是点错了元素） */
const firstCard = await ev(`(() => {
  const card = document.querySelector('.res-card');
  const name = (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
  const btn = card ? [...card.querySelectorAll('button')].find((b) => /选择版本并安装|收起版本/.test(b.textContent || '')) : null;
  btn?.click();
  return { '卡片': name, '按钮': (btn?.textContent || '').trim(), '按钮可用': btn ? !btn.disabled : null };
})()`);
console.log('点开第一张卡：' + JSON.stringify(firstCard));
/* 资源安装页（独立路由） */
for (let i = 0; i < 60; i += 1) {
  const ok = await ev(`/安装资源/.test(document.querySelector('.page-title')?.textContent || '') || !!document.querySelector('.res-detail')`);
  if (ok === true) break;
  await sleep(500);
}
await sleep(3000);

/** 数一下可选版本行，并点第 idx 行安装 */
const pickVersion = async (idx) => {
  const info = await ev(`(() => {
    const rows = [...document.querySelectorAll('.res-version, [role="button"].res-version, .res-vgroup .res-version, .res-version.clickable')];
    const list = rows.length ? rows : [...document.querySelectorAll('[role="button"]')].filter((b) => /^\\d/.test((b.textContent || '').trim()));
    const row = list[${idx}];
    const label = (row?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    row?.click();
    return { '总行数': list.length, '点的那行': label };
  })()`);
  return info;
};
const before = jars();
console.log('安装前 mods/：' + JSON.stringify(before));

const v1 = await pickVersion(0);
console.log('第 1 次点版本行：' + JSON.stringify(v1));
await sleep(12000);
const after1 = jars();
const t1 = await ev(`[...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90))`);
console.log('第 1 次结果：mods/=' + JSON.stringify(after1) + '  提示=' + JSON.stringify(t1));

/* 回列表再点第二张卡？—— 不用：同一页的版本列表还能再点另一个版本 */
const v2 = await pickVersion(Math.min(2, (v1?.总行数 ?? 1) - 1));
console.log('第 2 次点版本行：' + JSON.stringify(v2));
await sleep(12000);
const after2 = jars();
const t2 = await ev(`[...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90))`);
console.log('第 2 次结果：mods/=' + JSON.stringify(after2) + '  提示=' + JSON.stringify(t2));

console.log('\n===== 判据 =====');
console.log('  装了两次之后的 jar 数：' + after2.length + '  ' + JSON.stringify(after2));
console.log(
  after2.length >= 2
    ? '★★ B-1 机制级真机复现成功：装第二个版本**不会**删掉第一个 —— 「已替换为新版本」与磁盘事实不符。'
    : after2.length === 1
      ? '（这次 mods 里只有 1 个 jar：可能两次点的是同一个版本，或第二次没装成 —— 见上面两次的"点的那行"）'
      : '（没装上：Modrinth 或下载失败，见提示）',
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒已清理');
process.exit(0);
