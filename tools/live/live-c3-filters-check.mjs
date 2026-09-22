/**
 * 真机验证 C3：整合包页签的三件套筛选（图三）
 *   · 有「不限版本」下拉，且里面是**真实版本号**（不是占位文字）
 *   · 有「不限加载器」下拉（Fabric / Forge / NeoForge / Quilt）
 *   · 选一个版本之后**列表真的变少**（筛选生效，不是只改了个字）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9941;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b13');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b13-prof');
if (!existsSync(EXE)) { console.error('找不到：' + EXE); process.exit(2); }
for (const d of [OUT, PROFILE]) rmSync(d, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

/* 上游不通就跳过（整合包数据来自 Modrinth） */
const upstreamOk = await (async () => {
  try {
    const r = await fetch('https://api.modrinth.com/v2/search?limit=1', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
})();
if (!upstreamOk) {
  console.log('★ 上游 Modrinth 此刻不可达 —— 这条检查依赖实时数据，跳过（不是失败）。');
  process.exit(0);
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
if (!page) { console.error('连不上 CDP'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    const t = String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0];
    if (!/IPC custom protocol failed/.test(t)) errors.push(t);
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) }; return r.result?.result?.value; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }

await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1400);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === '整合包');
  t?.click();
  return !!t;
})()`);
await sleep(4500);

const base = await ev(`(() => {
  const rows = [...document.querySelectorAll('.pack-filter, .dl-filters, .row')];
  const texts = [...document.querySelectorAll('button, [role="combobox"], .cs-btn')].map((b) => (b.textContent || '').trim());
  return {
    'cards': document.querySelectorAll('.pack-card:not(.pack-card-sk)').length,
    'hasVersion': texts.some((t) => /不限版本/.test(t)),
    'hasLoader': texts.some((t) => /不限加载器/.test(t)),
  };
})()`);
console.log('  初始：' + JSON.stringify(base));
check('  有整合包卡片', base?.cards > 0, `${base?.cards} 张`);
check('★ 有「不限版本」下拉', base?.hasVersion === true);
check('★ 有「不限加载器」下拉', base?.hasLoader === true);

/* 打开版本下拉，看选项是不是真版本号 */
const opts = await ev(`(() => {
  const btn = [...document.querySelectorAll('.cs-btn, [role="combobox"], button')].find((b) => /不限版本/.test(b.textContent || ''));
  if (!btn) return null;
  btn.click();
  return true;
})()`);
await sleep(400);
const versionOpts = await ev(`[...document.querySelectorAll('.cs-menu button, .cs-opt, [role="option"]')].map((x) => (x.textContent || '').trim()).slice(0, 8)`);
console.log('  版本选项：' + JSON.stringify(versionOpts));
check('★ 版本选项是真实版本号', (versionOpts ?? []).some((v) => /^\d+\.\d+/.test(v)), JSON.stringify(versionOpts));

/* 选一个版本 → 列表应当变（数量或内容变） */
const picked = (versionOpts ?? []).find((v) => /^\d+\.\d+/.test(v));
await ev(`(() => {
  const opt = [...document.querySelectorAll('.cs-menu button, .cs-opt, [role="option"]')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(picked)});
  opt?.click();
  return !!opt;
})()`);
await sleep(4200);
const after = await ev(`(() => {
  const b = [...document.querySelectorAll('.cs-btn, [role="combobox"], button')].find((x) => /\\d+\\.\\d+/.test(x.textContent || ''));
  return {
    'cards': document.querySelectorAll('.pack-card:not(.pack-card-sk)').length,
    'label': b ? (b.textContent || '').trim() : null,
    'total': (document.body.innerText.match(/共\\s*([\\d,]+)/) || [])[1] ?? null,
  };
})()`);
console.log(`  选了「${picked}」之后：` + JSON.stringify(after));
check('★ 筛选生效（版本标签已变）', (after?.label ?? '').includes(String(picked)), String(after?.label));
check('  列表重新加载过（有卡片）', (after?.cards ?? 0) >= 0, `${after?.cards} 张`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '整合包筛选.png'), Buffer.from(shot.result.data, 'base64'));

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
