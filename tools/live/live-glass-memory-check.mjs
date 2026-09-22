/**
 * 真机测量：**玻璃这套东西各自占多少内存**（用户看到任务管理器说"好恐怖"）。
 * ------------------------------------------------------------------
 * 为什么不能"看着大就砍"：WebView2 是多进程 Chromium，任务管理器里那个数
 * 包含 GPU 进程（合成器 / 纹理 / 离屏表面）、渲染进程、工具进程，
 * **其中很大一部分跟玻璃无关**。要砍就先量出"哪一块是我加的"。
 *
 * 这个脚本的做法：
 *   · 用**隔离的 user-data 目录**起一份应用，于是能按命令行精确认出它的全部子进程；
 *   · 分区测：基线 → 关掉边缘环 → 关掉全部光斑层 → 关掉 GL 背景画布（CSSOM 注入，可回退）；
 *   · 每个状态量 GPU 进程 / 渲染进程 / 全部的 **工作集**与**私有字节**。
 *
 * 用法：
 *   node tools/live/live-glass-memory-check.mjs ["<exe>"] [tier]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PORT = 9601;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const TIER = process.argv[3] ?? 'aura';
const PROFILE = path.join(process.env.TEMP ?? '.', `ieml-mem-${TIER}-${Date.now()}`);
/** ★ 命令行里给的是**短路径**（C:\\Users\\ADMINI~1\\…），所以只匹配目录名 */
const PROFILE_TAG = PROFILE.split(/[\\/]/).pop();

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}

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

/** 读属于这个 profile 的全部 WebView2 进程 + 应用主进程 */
async function readMemory(label) {
  const script = `
$prof = '${PROFILE_TAG}'
$rows = @()
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='ieml.exe'") {
  $mine = ($p.CommandLine -and $p.CommandLine.Contains($prof)) -or ($p.Name -eq 'ieml.exe')
  if (-not $mine) { continue }
  $pr = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $pr) { continue }
  $t = if ($p.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'app' }
  $rows += [pscustomobject]@{ t = $t; ws = [math]::Round($pr.WorkingSet64/1MB,1); pv = [math]::Round($pr.PrivateMemorySize64/1MB,1) }
}
$g = $rows | Group-Object t
$out = @()
foreach ($x in $g) {
  $out += ('{0}={1}MB/{2}MB' -f $x.Name, [math]::Round(($x.Group | Measure-Object ws -Sum).Sum,1), [math]::Round(($x.Group | Measure-Object pv -Sum).Sum,1))
}
$out += ('TOTAL={0}MB/{1}MB' -f [math]::Round(($rows | Measure-Object ws -Sum).Sum,1), [math]::Round(($rows | Measure-Object pv -Sum).Sum,1))
$out -join '  '
`;
  const raw = await ps(script);
  console.log(`  ${label.padEnd(26)} ${raw}`);
  const total = /TOTAL=([\d.]+)MB/.exec(raw);
  return total ? parseFloat(total[1]) : NaN;
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(1200);
const app = spawn(EXE, [], {
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pend.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`localStorage.setItem('ieml.vfx', ${JSON.stringify(TIER)})`);
await send('Page.reload', {});
await sleep(2800);
for (let i = 0; i < 60; i += 1) {
  if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break;
  await sleep(400);
}
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(2200);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
// 把鼠标放到一块卡片上：让光斑层真的被激活（不然它可能是"还没分配纹理"的状态）
await ev(`(() => {
  const c = [...document.querySelectorAll('.glass-refract')].find((x) => x.getBoundingClientRect().width > 240);
  if (!c) return false;
  const r = c.getBoundingClientRect();
  window.__pt = [Math.round(r.left + r.width * 0.4), Math.round(r.top + r.height * 0.4)];
  return true;
})()`);
const pt = await ev(`window.__pt`);
if (Array.isArray(pt)) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt[0], y: pt[1], button: 'none' });
  await sleep(600);
}
await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 300; return true; })()`);
await sleep(900);
await ev(`(() => { const c = document.querySelector('.content'); if (c) c.scrollTop = 0; return true; })()`);
await sleep(900);

const meta = await ev(`(() => ({
  vfx: document.documentElement.dataset.vfx,
  glasses: document.querySelectorAll('.glass-refract').length,
  gl: !!document.querySelector('canvas.glass-ambient-gl'),
  glSize: (() => { const c = document.querySelector('canvas.glass-ambient-gl'); return c ? [c.width, c.height] : null; })(),
  dpr: window.devicePixelRatio,
  glowLayers: document.querySelectorAll('.glass-glow').length,
  edgeLights: document.querySelectorAll('.glass-edge-light').length,
  lensMaps: document.querySelectorAll('#ieml-lens-defs filter').length,
  heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}))()`);
console.log(`档位 ${TIER}：${JSON.stringify(meta)}\n`);
console.log('  （工作集/私有字节，按进程类型分开；GPU 进程才是玻璃真正花的地方）');

const results = {};
results.baseline = await readMemory('① 基线（全开）');

await ev(`(() => { const s = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; window.__m = s; return true; })()`);
const inject = async (css) => {
  await ev(
    '(() => { const s = window.__m; while (s.cssRules.length) s.deleteRule(0); ' +
      (css ? 's.insertRule(' + JSON.stringify(css) + ', 0); ' : '') +
      'return s.cssRules.length; })()',
  );
  await sleep(2500);
};

await inject('.glass-edge{display:none !important}');
results.noEdge = await readMemory('② 关掉边缘高亮环');

await inject('.glass-edge,.glass-glow{display:none !important}');
results.noGlow = await readMemory('③ 关掉全部光斑层');

await inject('.glass-edge,.glass-glow{display:none !important}.glass-ambient-gl{display:none !important}');
results.noGlowNoGL = await readMemory('④ 再关掉 GL 背景画布');

await inject('.glass-edge,.glass-glow,.glass-ambient-gl{display:none !important}.glass{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}');
results.noGlassAtAll = await readMemory('⑤ 连模糊一起关（≈无玻璃）');

await inject('');
results.restored = await readMemory('⑥ 全部恢复');

console.log('\n=== 增量（相对基线）===');
const fmt = (a, b) => `${b >= a ? '+' : ''}${(b - a).toFixed(1)} MB`;
console.log(`  边缘高亮环       ${fmt(results.baseline, results.noEdge)}`);
console.log(`  全部光斑层       ${fmt(results.baseline, results.noGlow)}`);
console.log(`  GL 背景画布      ${fmt(results.noGlow, results.noGlowNoGL)}`);
console.log(`  backdrop-filter  ${fmt(results.noGlowNoGL, results.noGlassAtAll)}`);

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
process.exit(0);
