/**
 * 真机验证 C4：资源版本列表**按 MC 版本分组 + 折叠 + 顶部 chips 筛选**
 * （用户：「整合包，mod，资源包，数据包，光影，给版本分类，就像游戏版本安装那样」，
 *   粒度：「按大版本分组」）。
 *
 * 判据：
 *   · 打开某个资源的版本列表后，出现 `.res-vgroup` 分组（不是一条条平铺）；
 *   · 组标题是 MC 版本、按从新到旧排；
 *   · **第一组默认展开**（全折叠的话第一眼像"什么都没有"）；
 *   · 点组标题能折叠/展开（aria-expanded 跟着变）；
 *   · 顶部 chips 点某个版本后，只剩那一组（筛选生效）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9921;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-b11');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-b11-prof');
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

/** 上游不通就明确跳过（这些数据来自 Modrinth） */
const upstreamOk = await (async () => {
  try {
    const r = await fetch('https://api.modrinth.com/v2/search?limit=1', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
})();
if (!upstreamOk) {
  console.log('★ 上游 Modrinth 此刻不可达 —— 这条检查依赖它的实时数据，跳过（不是失败）。');
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

/* ---------- 进 Mod 页签（版本最多，最能看出分组效果） ---------- */
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('下载'))?.click()`);
await sleep(1400);
await ev(`(() => {
  const t = [...document.querySelectorAll('.tabs button, .tabs [role=tab]')].find((x) => (x.textContent || '').trim() === 'Mod');
  t?.click();
  return !!t;
})()`);
await sleep(4500);

const cards = await ev(`document.querySelectorAll('.res-card:not(.res-card-sk)').length`);
console.log('  Mod 卡片：' + cards);
check('  有资源卡片', cards > 0, `${cards} 张`);

/* 点第一张卡片的按钮展开版本列表 */
await ev(`(() => {
  const c = document.querySelector('.res-card:not(.res-card-sk)');
  const b = c?.querySelector('button');
  b?.click();
  return !!b;
})()`);
await sleep(4200);

/* ---------- 分组结构 ---------- */
const groups = await ev(`(() => {
  const hs = [...document.querySelectorAll('.res-vgroup-head')];
  return {
    'count': hs.length,
    'keys': hs.map((h) => (h.querySelector('.res-vgroup-name')?.textContent || '').trim()),
    'counts': hs.map((h) => (h.querySelector('.dim')?.textContent || '').trim()),
    'expanded': hs.map((h) => h.getAttribute('aria-expanded')),
    'chips': [...document.querySelectorAll('.res-vchips .chip')].map((c) => (c.textContent || '').trim()),
    'rowsTotal': document.querySelectorAll('.res-version').length,
  };
})()`);
console.log('  分组：' + JSON.stringify(groups, null, 1));
/*
 * ★★ 分组数是这一条的核心：第一版按完整 MC 版本分，一个热门 Mod 出了 **362 组**
 *   （快照/预览各成一组）—— 比平铺还难用。按"大版本"归一化之后应当在十几组以内。
 */
check(
  '★ 按**大版本**分组（组数应当很少，不是每个快照一组）',
  (groups?.count ?? 0) >= 2 && (groups?.count ?? 0) <= 40,
  `${groups?.count} 组：${JSON.stringify(groups?.keys?.slice(0, 12))}`,
);
check(
  '  组名里不再出现 pre / rc / snapshot / 周快照（已归一化）',
  !(groups?.keys ?? []).some((k) => /-pre|-rc|-snapshot|^\d{2}w/i.test(k)),
  JSON.stringify(groups?.keys?.slice(0, 12)),
);
check('★ 第一组**默认展开**（不是全折叠）', groups?.expanded?.[0] === 'true', JSON.stringify(groups?.expanded));
check('  组标题带条数', (groups?.counts ?? []).every((c) => /\d+ 个版本/.test(c)), JSON.stringify(groups?.counts));
check('★ 组按版本从新到旧（第一组比第二组新；「快照」「通用」排最后）', (() => {
  const k = groups?.keys ?? [];
  if (k.length < 2) return false;
  const num = (s) => s.split('.').map(Number);
  const a = num(k[0]); const b = num(k[1]);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
})(), JSON.stringify(groups?.keys));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(path.join(OUT, '分组.png'), Buffer.from(shot.result.data, 'base64'));

/* ---------- 折叠 / 展开 ---------- */
/*
 * ★ 要点：**点完要等一帧再读**。第一版在同一个 tick 里 click() 之后立刻读
 *   aria-expanded —— React 还没重渲染，读到的当然是旧值（假红）。
 *   这与"探针量错属性"是同一类毛病：先确认判据本身没问题，再怀疑应用。
 */
const foldBefore = await ev(`document.querySelectorAll('.res-vgroup-head')[0]?.getAttribute('aria-expanded')`);
await ev(`document.querySelectorAll('.res-vgroup-head')[0]?.click()`);
await sleep(400);
const foldAfter = await ev(`document.querySelectorAll('.res-vgroup-head')[0]?.getAttribute('aria-expanded')`);
console.log(`  折叠切换：${foldBefore} → ${foldAfter}`);
check('★ 点组标题能折叠（aria-expanded 翻转）', foldBefore !== foldAfter, `${foldBefore} → ${foldAfter}`);
/* 折起来之后组内版本行应当消失 —— 这才是"折叠"的实证 */
const rowsClosed = await ev(`document.querySelectorAll('.res-version').length`);
check('  折起来之后组内版本行消失', rowsClosed === 0, `${rowsClosed} 行`);
await ev(`document.querySelectorAll('.res-vgroup-head')[0]?.click()`);
await sleep(400);
const rowsBack = await ev(`document.querySelectorAll('.res-version').length`);
check('  再点开又回来了', rowsBack > 0, `${rowsBack} 行`);

/* ---------- chips 筛选 ---------- */
const filtered = await ev(`(() => {
  const chips = [...document.querySelectorAll('.res-vchips .chip')];
  const target = chips[1]; // 「全部」之后的第一组
  if (!target) return null;
  const label = (target.textContent || '').trim();
  target.click();
  return label;
})()`);
await sleep(500);
const after = await ev(`(() => ({
  'groups': document.querySelectorAll('.res-vgroup-head').length,
  'keys': [...document.querySelectorAll('.res-vgroup-name')].map((x) => (x.textContent || '').trim()),
}))()`);
console.log(`  点 chips「${filtered}」之后：` + JSON.stringify(after));
check('★ chips 筛选生效（只剩那一组）', (after?.groups ?? 0) === 1, JSON.stringify(after));
check('  筛出来的那一组就是点的那一个', (after?.keys?.[0] ?? '') === String(filtered).split(' ')[0], `${after?.keys?.[0]} vs ${filtered}`);

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
