/**
 * 真机复现 A-2：**实例记录里的附加组件（OptiFine）对启动没有任何影响**
 * ------------------------------------------------------------------
 * 思路（不用真的装游戏、不用真的启动）：
 *   在 `%TEMP%` 沙盒里建**两条只差 `addons` 的实例记录**（同 mc、同 slug 规则、
 *   一个 `addons: []`、一个 `addons: [optifine]`），然后用启动页的**预览命令**
 *   分别看两条记录的命令行。
 *
 * 判据：命令行**逐字相同**（除实例目录/日志路径这类必然不同的部分以外，
 *   版本 JSON、主类、tweaker、classpath 都不能因为 addons 而变）。
 *   —— `preview_launch` 与 `launch_minecraft` 走**同一个** `prepare_spec`，
 *   所以"预览一样"就等于"启动一样"。
 *   ★ 游戏文件用**目录联接（junction）**指到真实那份，只读使用，不写。
 *
 * 用法：node tools/live/probe-bug-repro-6.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9969;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a2-root');
const OWN = path.join(T, 'ieml-a2-own');
const PROFILE = path.join(T, 'ieml-a2-prof');
const REAL_MC = 'D:\\IEML\\.minecraft';
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
/* 游戏文件只读借用：junction 三个目录过去 */
for (const sub of ['versions', 'libraries', 'assets']) {
  const out = await ps(`cmd /c mklink /J "${path.join(MC, sub)}" "${path.join(REAL_MC, sub)}"`);
  console.log(`  联接 ${sub}: ${out.includes('Junction') || out.includes('创建') ? 'OK' : out}`);
}
const mk = (id, slug, name, addons) => ({
  id,
  mcVersion: '1.12.2',
  loader: null,
  addons,
  config: { name, slug, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
  createdAt: new Date().toISOString(),
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});
writeFileSync(
  path.join(ROOT, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        mk('inst-plain', 'probe-plain', '探针·无附加组件', []),
        mk('inst-opti', 'probe-opti', '探针·带OptiFine', [{ kind: 'optifine', version: 'HD_U_G8' }]),
      ],
      active_id: null,
    },
    null,
    2,
  ),
);
console.log('  沙盒就绪：' + ROOT);

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

const previewOf = async (instanceName) => {
  await ev(`[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('启动'))?.click()`);
  await sleep(1800);
  /*
   * ★ 切实例：不碰那个下拉（上一版就是没点中它，导致两次预览其实是同一个实例）。
   *   启动页给「其它版本」每张卡片都挂了 `setLaunchTarget(i.id)`，点它最直接。
   */
  const clicked = await ev(`(() => {
    const hit = [...document.querySelectorAll('button, .mini-inst, .inst-mini, [role="button"]')]
      .filter((x) => (x.textContent || '').includes(${JSON.stringify(instanceName)}))
      .filter((x) => !/⋯|更多/.test(x.getAttribute('aria-label') || ''));
    if (hit.length === 0) return null;
    hit[hit.length - 1].click();
    return (hit[hit.length - 1].textContent || '').replace(/\\s+/g, ' ').slice(0, 40);
  })()`);
  await sleep(2000);
  /* 读"现在选中的是谁"—— 这是这一版必须确认的东西 */
  const current = await ev(`(() => {
    const text = (document.querySelector('.content')?.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    return { '页头几行': text.slice(0, 4), '含探针·无': text.some((t) => t.includes('探针·无附加组件')), '含探针·带': text.some((t) => t.includes('探针·带OptiFine')) };
  })()`);
  await ev(`[...document.querySelectorAll('button')].find((b) => /预览命令/.test(b.textContent || ''))?.click()`);
  await sleep(3500);
  const text = await ev(`(() => {
    const modal = document.querySelector('.modal');
    return modal ? (modal.innerText || '') : '（没有模态）';
  })()`);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => /关闭/.test(x.textContent || '')); b?.click(); return !!b; })()`);
  await sleep(800);
  return { clicked, current, text: String(text ?? '') };
};

const A = await previewOf('探针·无附加组件');
const B = await previewOf('探针·带OptiFine');

/* 只比较"启动规格"相关的那几行：java / classpath / 主类 / 参数 */
const specLines = (t) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /java|classpath|versions|--|Main|tweak|OptiFine|natives/i.test(l))
    /* 实例目录里必然带 slug，统一抹掉再比 */
    .map((l) => l.replace(/probe-(plain|opti)/g, 'PROBE').replace(/探针[·]?\S*/g, 'PROBE'));
const sa = specLines(A.text);
const sb = specLines(B.text);
console.log('\n=== A：addons = [] ===');
console.log(sa.map((l) => '  ' + l.slice(0, 150)).join('\n') || '  （没抓到命令行）');
console.log('\n=== B：addons = [optifine] ===');
console.log(sb.map((l) => '  ' + l.slice(0, 150)).join('\n') || '  （没抓到命令行）');

const same = JSON.stringify(sa) === JSON.stringify(sb);
const mentionsOptifine = /OptiFine|tweakClass/i.test(A.text + B.text);
/* ★ 判"两次真的选了不同的实例"要用**页头第 3 行**（当前选中的实例名）——
   "其它版本"列表里两个名字都在，拿子串判断会恒真（上一版就是栽在这） */
const headA = (A.current?.['页头几行'] ?? [])[2] ?? '';
const headB = (B.current?.['页头几行'] ?? [])[2] ?? '';
const switched = headA !== headB && /探针/.test(headA) && /探针/.test(headB);
console.log('\n===== 判据 =====');
console.log('  A 点到的元素：' + JSON.stringify(A.clicked) + '   页面头部：' + JSON.stringify(A.current?.['页头几行']));
console.log('  B 点到的元素：' + JSON.stringify(B.clicked) + '   页面头部：' + JSON.stringify(B.current?.['页头几行']));
console.log('  两次选中的实例（页头）：A=' + JSON.stringify(headA) + '  B=' + JSON.stringify(headB));
console.log('  两次确实选中了不同实例：' + (switched ? '是' : '★ 否（这次对比不算数）'));
console.log('  两条记录的命令行（抹掉实例名后）逐字相同：' + (same ? '是' : '否'));
console.log('  命令行里出现 OptiFine / tweakClass：' + (mentionsOptifine ? '是' : '否'));
console.log(
  switched && same && !mentionsOptifine
    ? '\n★★ A-2 真机复现成功：实例记录里的 OptiFine **对启动规格没有任何影响** —— 勾了也白勾。'
    : '\n（这次没复现出预期结果，见上面两段原文）',
);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(500);
/* 先拆联接再删（否则会把真目录一起带走） */
for (const sub of ['versions', 'libraries', 'assets']) await ps(`cmd /c rmdir "${path.join(MC, sub)}"`);
for (const d of [ROOT, OWN, PROFILE]) rmSync(d, { recursive: true, force: true });
console.log('\n沙盒与联接已清理');
process.exit(0);
